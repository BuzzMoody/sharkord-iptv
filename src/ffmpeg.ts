import path from "path";
import fs from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

// a lot of vibes going on this file
// i don't even know if this is efficient or the best way to do this, but it's kinda working

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

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper to determine which FFmpeg to use and whether to allow HW acceleration
const getFFmpegSetup = (log: (...messages: unknown[]) => void): { binaryPath: string; allowHwAccel: boolean } => {
  try {
    // 1. Check if system-wide FFmpeg is installed
    const proc = Bun.spawnSync(["ffmpeg", "-version"]);
    if (proc.success) {
      log("System-wide FFmpeg detected! Hardware acceleration checks enabled.");
      return { binaryPath: "ffmpeg", allowHwAccel: true };
    }
  } catch (err) {
    // Ignore error, it just means it's not in the system PATH
  }

  // 2. Fallback to local binary
  let binaryName = "ffmpeg.exe";
  if (process.platform !== "win32") {
    binaryName = "ffmpeg";
  }

  const localPath = path.join(__dirname, "bin", binaryName);
  log(`System FFmpeg not found. Falling back to local binary at: ${localPath}`);
  log("Hardware acceleration disabled (Forcing CPU encoding for local binary).");

  return { binaryPath: localPath, allowHwAccel: false };
};

// Helper function to detect and return the best hardware acceleration arguments
const getEncoderArgs = (binaryPath: string, allowHwAccel: boolean, log: (...messages: unknown[]) => void): string[] => {
  // 1. The standard CPU fallback arguments
  const cpuArgs = [
    "-vf", "yadif=1:-1:0", // Deinterlace
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-level", "3.1",
    "-pix_fmt", "yuv420p",
  ];

  // If local binary is used, skip all hardware checks
  if (!allowHwAccel) {
    return cpuArgs;
  }

  try {
    // 2. Ask FFmpeg what encoders it supports
    const proc = Bun.spawnSync([binaryPath, "-encoders"]);
    const encoders = proc.stdout.toString();

    const isLinux = process.platform === "linux";
    // Check if the Intel/AMD GPU render node exists on Linux
    const hasDri = isLinux && fs.existsSync("/dev/dri/renderD128");

    // 3. Try VAAPI FIRST on Linux
    if (isLinux && encoders.includes("h264_vaapi") && hasDri) {
      log("Hardware Acceleration: VAAPI detected! (Linux Preferred)");
      return [
        "-init_hw_device", "vaapi=hw:/dev/dri/renderD128", // Explicitly initialize the device
        "-filter_hw_device", "hw",                         // Tell the filter chain to use it
        "-vf", "yadif=1:-1:0,format=nv12,hwupload",        // Deinterlace in CPU, upload to GPU
        "-c:v", "h264_vaapi",
        "-profile:v", "baseline",
        "-level", "3.1"
      ];
    }

    // 4. Try Intel QuickSync (QSV) (Preferred natively on Windows)
    if (encoders.includes("h264_qsv") && (process.platform === "win32" || hasDri)) {
      log("Hardware Acceleration: Intel QuickSync (QSV) detected!");
      const hwInitArgs = isLinux ? ["-init_hw_device", "qsv=hw:/dev/dri/renderD128", "-filter_hw_device", "hw"] : [];
      return [
        ...hwInitArgs,
        "-vf", "yadif=1:-1:0,format=nv12", // Deinterlace in CPU, format for Intel GPU
        "-c:v", "h264_qsv",
        "-preset", "veryfast",
        "-profile:v", "baseline",
        "-level", "3.1"
      ];
    }

  } catch (err) {
    log("Failed to detect hardware acceleration, falling back to CPU.");
  }

  // 5. Fallback if no hardware is found
  log("Hardware Acceleration: None detected. Falling back to CPU (libx264).");
  return cpuArgs;
};

const spawnFFmpeg = async (
  pluginPath: string,
  options: TOptions,
): Promise<TProcessPair> => {
  
  // Dynamically determine which FFmpeg to use
  const { binaryPath, allowHwAccel } = getFFmpegSetup(options.log);

  // Define quality bitrate arguments
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

  const encoderArgs = getEncoderArgs(binaryPath, allowHwAccel, options.log);

  const vaapiEnv = {
    ...process.env,
    LIBVA_DRIVER_NAME: "iHD",
    LIBVA_DRIVERS_PATH: "/usr/lib/x86_64-linux-gnu/dri",
  };

  const commonInputArgs = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "5",
    "-timeout", "10000000",
    "-user_agent", "Mozilla/5.0",
    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",
  ];

  // Video RTP: source -> VAAPI encode -> RTP
  const videoRtpArgs = [
    ...commonInputArgs,

    // HW init args must come before -i
    ...encoderArgs.filter(arg =>
      arg === "-init_hw_device" || arg.startsWith("vaapi") ||
      arg.startsWith("qsv") || arg === "-filter_hw_device" || arg === "hw"
    ),

    "-i", options.sourceUrl,

    "-map", "0:v:0",
    "-an",

    // encoder filter/codec args
    ...encoderArgs.filter(arg =>
      arg !== "-init_hw_device" && !arg.startsWith("vaapi") &&
      !arg.startsWith("qsv") && arg !== "-filter_hw_device" && arg !== "hw"
    ),

    ...qualityArgs,
    "-g", "50",
    "-sc_threshold", "0",

    "-payload_type", options.videoPayloadType.toString(),
    "-ssrc", options.videoSsrc.toString(),
    "-f", "rtp",
    `rtp://${options.rtpHost}:${options.videoRtpPort}?pkt_size=1200`,
  ];

  // Audio RTP: source -> downmix -> opus -> RTP (no HLS involved)
  const audioRtpArgs = [
    ...commonInputArgs,

    "-i", options.sourceUrl,

    "-map", "0:a:0",
    "-vn",

    "-af", "pan=stereo|FL=0.5*FC+0.707*FL+0.707*BL+0.5*LFE|FR=0.5*FC+0.707*FR+0.707*BR+0.5*LFE",
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

        const text = decoder.decode(value, { stream: true });

        options.log("[Video RTP stdout]", text.trim());
      }
    } catch (error) {
      options.error("[Video RTP stdout error]", error);
    }
  })();

  (async () => {
    const reader = videoRtpProcess.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[Video RTP stderr]", text.trim());
      }
    } catch (error) {
      options.error("[Video RTP stderr error]", error);
    }
  })();

  (async () => {
    const reader = audioRtpProcess.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[Audio RTP stdout]", text.trim());
      }
    } catch (error) {
      options.error("[Audio RTP stdout error]", error);
    }
  })();

  (async () => {
    const reader = audioRtpProcess.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[Audio RTP stderr]", text.trim());
      }
    } catch (error) {
      options.error("[Audio RTP stderr error]", error);
    }
  })();

  return {
    videoRtp: videoRtpProcess,
    audioRtp: audioRtpProcess,
  };
};


const killFFmpegProcesses = (processes: TProcessPair): void => {
  if (processes.videoRtp) {
    processes.videoRtp.kill();
  }

  if (processes.audioRtp) {
    processes.audioRtp.kill();
  }
};

export { spawnFFmpeg, killFFmpegProcesses };
export type { TOptions, TProcessPair };