import path from "path";
import fs from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

type TOptions = {
  sourceUrl: string;
  gopSize: number;
  videoPayloadType: number;
  audioPayloadType: number;
  videoSsrc: number;
  audioSsrc: number;
  rtpHost: string;
  videoRtpPort: number;
  audioRtpPort: number;
  packetSize: number;
  quality: "low" | "medium" | "high" | "original";
  log: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
};

type TProcessPair = {
  videoRtp?: ReturnType<typeof Bun.spawn> | null;
  audioRtp?: ReturnType<typeof Bun.spawn> | null;
};

// preInput: args that MUST come before -i (hw device init)
// postInput: args that come after -i (filters, codec, profile)
type TEncoderArgs = {
  preInput: string[];
  postInput: string[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));

const getFFmpegSetup = (log: (...messages: unknown[]) => void): { binaryPath: string; allowHwAccel: boolean } => {
  try {
    const proc = Bun.spawnSync(["ffmpeg", "-version"]);
    if (proc.success) {
      log("System-wide FFmpeg detected! Hardware acceleration checks enabled.");
      return { binaryPath: "ffmpeg", allowHwAccel: true };
    }
  } catch (err) {
    // not in PATH
  }

  let binaryName = "ffmpeg.exe";
  if (process.platform !== "win32") {
    binaryName = "ffmpeg";
  }

  const localPath = path.join(__dirname, "bin", binaryName);
  log(`System FFmpeg not found. Falling back to local binary at: ${localPath}`);
  log("Hardware acceleration disabled (Forcing CPU encoding for local binary).");
  return { binaryPath: localPath, allowHwAccel: false };
};

// Returns cleanly separated pre/post input encoder args
const getEncoderArgs = (binaryPath: string, allowHwAccel: boolean, log: (...messages: unknown[]) => void): TEncoderArgs => {
  const cpuArgs: TEncoderArgs = {
    preInput: [],
    postInput: [
      "-vf", "format=yuv420p",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-level", "3.1",
      "-pix_fmt", "yuv420p",
    ],
  };

  if (!allowHwAccel) return cpuArgs;

  try {
    const proc = Bun.spawnSync([binaryPath, "-encoders"]);
    const encoders = proc.stdout.toString();
    const isLinux = process.platform === "linux";
    const hasDri = isLinux && fs.existsSync("/dev/dri/renderD128");

    if (isLinux && encoders.includes("h264_vaapi") && hasDri) {
      log("Hardware Acceleration: VAAPI detected! (Linux Preferred)");
      return {
        preInput: [
          "-init_hw_device", "vaapi=hw:/dev/dri/renderD128",
          "-filter_hw_device", "hw",
        ],
        postInput: [
          "-vf", "format=nv12,hwupload",
          "-c:v", "h264_vaapi",
          "-profile:v", "constrained_baseline",
          "-level:v", "31",
        ],
      };
    }

    if (encoders.includes("h264_qsv") && (process.platform === "win32" || hasDri)) {
      log("Hardware Acceleration: Intel QuickSync (QSV) detected!");
      return {
        preInput: isLinux
          ? ["-init_hw_device", "qsv=hw:/dev/dri/renderD128", "-filter_hw_device", "hw"]
          : [],
        postInput: [
          "-vf", "format=nv12",
          "-c:v", "h264_qsv",
          "-preset", "veryfast",
          "-profile:v", "constrained_baseline",
          "-level:v", "31",
        ],
      };
    }

  } catch (err) {
    log("Failed to detect hardware acceleration, falling back to CPU.");
  }

  log("Hardware Acceleration: None detected. Falling back to CPU (libx264).");
  return cpuArgs;
};

const spawnFFmpeg = async (
  pluginPath: string,
  options: TOptions,
): Promise<TProcessPair> => {

  const { binaryPath, allowHwAccel } = getFFmpegSetup(options.log);
  const encoderArgs = getEncoderArgs(binaryPath, allowHwAccel, options.log);

  let qualityArgs: string[] = [];
  switch (options.quality) {
    case "low":
      qualityArgs = ["-b:v", "1000k", "-maxrate", "1500k", "-bufsize", "3000k", "-r", "24"];
      break;
    case "high":
      qualityArgs = ["-b:v", "6000k", "-maxrate", "8000k", "-bufsize", "16000k"];
      break;
    case "original":
      qualityArgs = ["-b:v", "12000k", "-maxrate", "12000k", "-bufsize", "24000k"];
      break;
    case "medium":
    default:
      qualityArgs = ["-b:v", "2500k", "-maxrate", "3000k", "-bufsize", "6000k", "-r", "30"];
      break;
  }

  const vaapiEnv = {
    ...process.env,
    LIBVA_DRIVER_NAME: "iHD",
    LIBVA_DRIVERS_PATH: "/usr/lib/x86_64-linux-gnu/dri",
  };

  // Base input args shared by both processes
  const commonInputArgs = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "5",
    "-timeout", "10000000",
    "-user_agent", "Mozilla/5.0",
    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",
    // Avoid excessive buffering on live streams so encoding starts promptly
    "-max_delay", "500000",
    "-avioflags", "direct",
  ];

  // Video: source -> hw encode -> RTP
  // No wallclock timestamp rewriting — that causes massive frame drops on streams
  // with large PCR values (FFmpeg enters catch-up mode trying to sync to wall clock)
  const videoRtpArgs = [
    ...commonInputArgs,
    ...encoderArgs.preInput,
    "-i", options.sourceUrl,
    "-map", "0:v:0",
    "-an",
    ...encoderArgs.postInput,
    ...qualityArgs,
    "-g", "50",
    "-sc_threshold", "0",
    "-payload_type", options.videoPayloadType.toString(),
    "-ssrc", options.videoSsrc.toString(),
    "-f", "rtp",
    `rtp://${options.rtpHost}:${options.videoRtpPort}?pkt_size=1200`,
  ];

  // Audio: source -> downmix -> opus -> RTP (direct, no HLS)
  // use_wallclock_as_timestamps only on audio — safe here because asetpts resets
  // timestamps anyway, and audio is not affected by the frame-drop issue
  const audioRtpArgs = [
    ...commonInputArgs,
    "-use_wallclock_as_timestamps", "1",
    "-i", options.sourceUrl,
    "-map", "0:a:0",
    "-vn",
    "-af", "pan=stereo|FL=0.5*FC+0.707*FL+0.707*BL+0.5*LFE|FR=0.5*FC+0.707*FR+0.707*BR+0.5*LFE,asetpts=N/SR/TB",
    "-c:a", "libopus",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "128k",
    "-application", "audio",
    "-vbr", "on",
    "-frame_duration", "20",
    "-payload_type", options.audioPayloadType.toString(),
    "-ssrc", options.audioSsrc.toString(),
    "-f", "rtp",
    `rtp://${options.rtpHost}:${options.audioRtpPort}?pkt_size=1200`,
  ];

  options.log("Starting video RTP stream (direct from source)...");

  const videoRtpProcess = Bun.spawn({
    cmd: [binaryPath, ...videoRtpArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: vaapiEnv,
  });

  options.log("Starting audio RTP stream (direct from source)...");

  const audioRtpProcess = Bun.spawn({
    cmd: [binaryPath, ...audioRtpArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: vaapiEnv,
  });

  (async () => {
    const reader = videoRtpProcess.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        options.log("[Video RTP stdout]", decoder.decode(value, { stream: true }).trim());
      }
    } catch (error) { options.error("[Video RTP stdout error]", error); }
  })();

  (async () => {
    const reader = videoRtpProcess.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        options.log("[Video RTP stderr]", decoder.decode(value, { stream: true }).trim());
      }
    } catch (error) { options.error("[Video RTP stderr error]", error); }
  })();

  (async () => {
    const reader = audioRtpProcess.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        options.log("[Audio RTP stdout]", decoder.decode(value, { stream: true }).trim());
      }
    } catch (error) { options.error("[Audio RTP stdout error]", error); }
  })();

  (async () => {
    const reader = audioRtpProcess.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        options.log("[Audio RTP stderr]", decoder.decode(value, { stream: true }).trim());
      }
    } catch (error) { options.error("[Audio RTP stderr error]", error); }
  })();

  return {
    videoRtp: videoRtpProcess,
    audioRtp: audioRtpProcess,
  };
};

const killFFmpegProcesses = (processes: TProcessPair): void => {
  if (processes.videoRtp) processes.videoRtp.kill();
  if (processes.audioRtp) processes.audioRtp.kill();
};

export { spawnFFmpeg, killFFmpegProcesses };
export type { TOptions, TProcessPair };