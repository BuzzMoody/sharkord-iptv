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
  hls?: ReturnType<typeof Bun.spawn>;
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
    "-vf", "format=yuv420p",
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
        "-init_hw_device", "vaapi=hw:/dev/dri/renderD128",
        "-filter_hw_device", "hw",
        "-vf", "format=nv12,hwupload",
        "-c:v", "h264_vaapi",
        "-profile:v", "constrained_baseline",
        "-level:v", "31",
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

  const hlsDir = path.join(pluginPath, "hls");
  const hlsPlaylist = path.join(hlsDir, "stream.m3u8");

  if (fs.existsSync(hlsDir)) {
    const files = fs.readdirSync(hlsDir);

    files.forEach((file) => {
      fs.unlinkSync(path.join(hlsDir, file));
    });
  } else {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  // Define quality arguments dynamically
  let qualityArgs: string[] = [];
  switch (options.quality) {
    case "low":
      qualityArgs = ["-b:v", "1000k", "-maxrate", "1500k", "-bufsize", "3000k", "-r", "24"];
      break;
    case "high":
      qualityArgs = ["-b:v", "6000k", "-maxrate", "8000k", "-bufsize", "16000k"];
      break;
    case "original":
      // Very high ceiling, no frame rate cap (lets source dictate)
      qualityArgs = ["-b:v", "12000k", "-maxrate", "12000k", "-bufsize", "24000k"];
      break;
    case "medium":
    default:
      qualityArgs = ["-b:v", "2500k", "-maxrate", "3000k", "-bufsize", "6000k", "-r", "30"];
      break;
  }

  // Detect and inject hardware acceleration arguments
  const encoderArgs = getEncoderArgs(binaryPath, allowHwAccel, options.log);

  // create HLS buffer from IPTV
  const hlsArgs = [
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_delay_max",
    "5",
    "-timeout",
    "10000000",
    "-user_agent",
    "Mozilla/5.0",

    "-fflags",
    "+genpts+discardcorrupt",
    "-err_detect",
    "ignore_err",

    // This must come BEFORE the input for the new initialization syntax
    ...encoderArgs.filter(arg => arg === "-init_hw_device" || arg.startsWith("vaapi") || arg.startsWith("qsv") || arg === "-filter_hw_device" || arg === "hw"),

    "-i",
    options.sourceUrl,

    // The rest of the encoder args (filters, codecs, etc.)
    ...encoderArgs.filter(arg => arg !== "-init_hw_device" && !arg.startsWith("vaapi") && !arg.startsWith("qsv") && arg !== "-filter_hw_device" && arg !== "hw"),

    // Inject dynamic quality/bitrate arguments
    ...qualityArgs,

    "-g",
    "50",
    "-sc_threshold",
    "0",

    // video only in HLS - audio goes direct from source to RTP to avoid timestamp drift
    "-an",

    // hls output with bigger buffer
    "-f",
    "hls",
    "-hls_time",
    "2", // 2 second segments
    "-hls_list_size",
    "15", // keep 15 segments (30 seconds buffer)
    "-hls_flags",
    "delete_segments+append_list",
    "-hls_segment_type",
    "mpegts",
    "-hls_segment_filename",
    path.join(hlsDir, "segment_%03d.ts"),
    "-start_number",
    "0",

    hlsPlaylist,
  ];

  options.log("Starting HLS buffer creation...");

  const vaapiEnv = {
    ...process.env,
    LIBVA_DRIVER_NAME: "iHD",
    LIBVA_DRIVERS_PATH: "/usr/lib/x86_64-linux-gnu/dri",
  };

  const hlsProcess = Bun.spawn({
    cmd: [binaryPath, ...hlsArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: vaapiEnv,
  });

  (async () => {
    const reader = hlsProcess.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[HLS stdout]", text.trim());
      }
    } catch (error) {
      options.error("[HLS stdout error]", error);
    }
  })();

  // Handle HLS stderr
  (async () => {
    const reader = hlsProcess.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[HLS stderr]", text.trim());
      }
    } catch (error) {
      options.error("[HLS stderr error]", error);
    }
  })();

  options.log("Waiting for HLS playlist...");

  await waitForHLS(hlsPlaylist, 4); // wait for 4 segments (8 seconds)

  options.log("HLS playlist ready with buffer!");

  // stream VIDEO from hls to rtp
  const videoRtpArgs = [
    "-re",
    "-stream_loop",
    "-1",

    "-i",
    hlsPlaylist,

    "-map",
    "0:v:0",
    "-an",

    // just copy video - no transcoding needed
    "-c:v",
    "copy",

    "-payload_type",
    options.videoPayloadType.toString(),
    "-ssrc",
    options.videoSsrc.toString(),
    "-f",
    "rtp",
    `rtp://${options.rtpHost}:${options.videoRtpPort}?pkt_size=1200`,
  ];

  options.log("Starting video RTP stream from HLS...");

  const videoRtpProcess = Bun.spawn({
    cmd: [binaryPath, ...videoRtpArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: vaapiEnv,
  });

  // stream AUDIO direct from source to RTP (bypasses HLS to avoid timestamp drift)
  const audioRtpArgs = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "5",
    "-timeout", "10000000",
    "-user_agent", "Mozilla/5.0",

    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",

    "-i",
    options.sourceUrl,

    "-map", "0:a:0",
    "-vn",

    // downmix to stereo and encode as opus
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

  options.log("Starting audio RTP stream from HLS...");

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
    hls: hlsProcess,
    videoRtp: videoRtpProcess,
    audioRtp: audioRtpProcess,
  };
};

const waitForHLS = async (
  playlistPath: string,
  minSegments: number = 4,
  timeout: number = 30000,
): Promise<void> => {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (fs.existsSync(playlistPath)) {
      const content = fs.readFileSync(playlistPath, "utf8");
      const segmentCount = (content.match(/\.ts/g) || []).length;

      if (segmentCount >= minSegments) {
        await Bun.sleep(2000);

        return;
      }
    }

    await Bun.sleep(500);
  }

  throw new Error("HLS playlist not created within timeout");
};

const killFFmpegProcesses = (processes: TProcessPair): void => {
  if (processes.videoRtp) {
    processes.videoRtp.kill();
  }

  if (processes.audioRtp) {
    processes.audioRtp.kill();
  }

  if (processes.hls) {
    processes.hls.kill();
  }
};

export { spawnFFmpeg, killFFmpegProcesses };
export type { TOptions, TProcessPair };