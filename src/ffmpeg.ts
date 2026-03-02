import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type TStreamInfo = {
  videoCodec: string;       // e.g. "h264"
  audioCodec: string;       // e.g. "ac3", "aac", "mp2"
  width: number;
  height: number;
  fps: number;
  profileLevelId: string;   // hex string for mediasoup, e.g. "640032"
  isH264: boolean;
  needsVideoTranscode: boolean;
  needsAudioTranscode: boolean; // always true — we always output opus for mediasoup
};

export type TProcessPair = {
  videoRtp?: ReturnType<typeof Bun.spawn> | null;
  audioRtp?: ReturnType<typeof Bun.spawn> | null;
};

export type TSpawnOptions = {
  sourceUrl: string;
  streamInfo: TStreamInfo;
  videoPayloadType: number;
  audioPayloadType: number;
  videoSsrc: number;
  audioSsrc: number;
  rtpHost: string;
  videoRtpPort: number;
  audioRtpPort: number;
  log: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
};

const getFFmpegBin = (): string => {
  try {
    const proc = Bun.spawnSync(["ffmpeg", "-version"]);
    if (proc.success) return "ffmpeg";
  } catch {}

  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(__dirname, "bin", name);
};

const getFFprobeBin = (): string => {
  try {
    const proc = Bun.spawnSync(["ffprobe", "-version"]);
    if (proc.success) return "ffprobe";
  } catch {}

  const name = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return path.join(__dirname, "bin", name);
};

// Convert H264 profile + level integers to the 3-byte hex profile-level-id
// that mediasoup/SDP expects (e.g. "640032" = High 5.0)
const buildProfileLevelId = (profile: number, level: number): string => {
  // constraint_set flags byte — 0x00 for High, 0x40 for Baseline constrained
  const constraints = profile === 66 ? 0xe0 : 0x00;
  return [profile, constraints, level]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// Run ffprobe on the source and return everything mediasoup needs to know
export const probeStream = async (
  sourceUrl: string,
  log: (...messages: unknown[]) => void,
): Promise<TStreamInfo> => {
  const ffprobe = getFFprobeBin();

  log("Probing stream:", sourceUrl);

  const proc = Bun.spawnSync([
    ffprobe,
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    "-user_agent", "Mozilla/5.0",
    "-timeout", "10000000",
    sourceUrl,
  ]);

  const raw = proc.stdout.toString();
  const data = JSON.parse(raw);
  const streams: any[] = data.streams ?? [];

  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  if (!videoStream) throw new Error("No video stream found in source");
  if (!audioStream) throw new Error("No audio stream found in source");

  const videoCodec = videoStream.codec_name ?? "unknown";
  const audioCodec = audioStream.codec_name ?? "unknown";

  // Parse fps from r_frame_rate (e.g. "50/1") or avg_frame_rate
  const fpsStr = videoStream.r_frame_rate ?? videoStream.avg_frame_rate ?? "25/1";
  const [num, den] = fpsStr.split("/").map(Number);
  const fps = den > 0 ? Math.round((num / den) * 100) / 100 : 25;

  const width = videoStream.width ?? 1920;
  const height = videoStream.height ?? 1080;
  const isH264 = videoCodec === "h264";

  // Build profile-level-id from ffprobe data if available, else use sane defaults
  let profileLevelId = "42e01f"; // Baseline 3.1 fallback
  if (isH264) {
    const profileStr = (videoStream.profile ?? "").toLowerCase();
    const level = Math.round((videoStream.level ?? 31));

    let profileByte = 0x42; // Baseline
    if (profileStr.includes("high")) profileByte = 0x64;
    else if (profileStr.includes("main")) profileByte = 0x4d;

    profileLevelId = buildProfileLevelId(profileByte, level);
  }

  // We can copy H264 video directly into RTP — no re-encode needed
  // Any other codec needs transcoding to H264
  const needsVideoTranscode = !isH264;

  // Audio always gets transcoded to Opus for mediasoup
  const needsAudioTranscode = true;

  log(`Probe result: ${videoCodec} ${width}x${height} @ ${fps}fps, audio: ${audioCodec}`);
  log(`Profile-level-id: ${profileLevelId}, needsVideoTranscode: ${needsVideoTranscode}`);

  return {
    videoCodec,
    audioCodec,
    width,
    height,
    fps,
    profileLevelId,
    isH264,
    needsVideoTranscode,
    needsAudioTranscode,
  };
};

// Pipe stderr/stdout of a spawned process to the log functions
const pipeOutput = (
  proc: ReturnType<typeof Bun.spawn>,
  label: string,
  log: (...m: unknown[]) => void,
  error: (...m: unknown[]) => void,
) => {
  (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const t = dec.decode(value, { stream: true }).trim();
        if (t) log(`[${label} stdout]`, t);
      }
    } catch (e) { error(`[${label} stdout error]`, e); }
  })();

  (async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const t = dec.decode(value, { stream: true }).trim();
        if (t) log(`[${label} stderr]`, t);
      }
    } catch (e) { error(`[${label} stderr error]`, e); }
  })();
};

export const spawnFFmpeg = (options: TSpawnOptions): TProcessPair => {
  const ffmpeg = getFFmpegBin();
  const { streamInfo } = options;

  const env = {
    ...process.env,
    LIBVA_DRIVER_NAME: "iHD",
    LIBVA_DRIVERS_PATH: "/usr/lib/x86_64-linux-gnu/dri",
  };

  // Common input args for both processes
  const inputArgs = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "5",
    "-timeout", "10000000",
    "-user_agent", "Mozilla/5.0",
    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",
  ];

  // ── VIDEO ──────────────────────────────────────────────────────────────────
  // If the source is already H264, copy it straight into RTP — zero re-encode.
  // If it's something else (HEVC, MPEG2, etc), transcode to H264 via CPU.
  // We deliberately avoid VAAPI here: the virtual iGPU in Proxmox cannot keep
  // up with 50fps 1080p re-encoding due to DMA upload latency.
  const videoEncodeArgs = streamInfo.needsVideoTranscode
    ? [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-level", "3.1",
        "-pix_fmt", "yuv420p",
        "-b:v", "2500k",
        "-maxrate", "3000k",
        "-bufsize", "6000k",
      ]
    : ["-c:v", "copy"];

  const videoRtpArgs = [
    ...inputArgs,
    "-i", options.sourceUrl,
    "-map", "0:v:0",
    "-an",
    ...videoEncodeArgs,
    "-payload_type", options.videoPayloadType.toString(),
    "-ssrc", options.videoSsrc.toString(),
    "-f", "rtp",
    `rtp://${options.rtpHost}:${options.videoRtpPort}?pkt_size=1200`,
  ];

  // ── AUDIO ──────────────────────────────────────────────────────────────────
  // Always transcode to Opus — mediasoup requires it.
  // Detect channel layout and downmix surround to stereo if needed.
  const channels = 2; // always output stereo
  const audioFilterArgs = streamInfo.audioCodec === "ac3" || streamInfo.audioCodec === "eac3"
    ? ["-af", "pan=stereo|FL=0.5*FC+0.707*FL+0.707*BL+0.5*LFE|FR=0.5*FC+0.707*FR+0.707*BR+0.5*LFE,asetpts=N/SR/TB"]
    : ["-af", "aresample=48000,asetpts=N/SR/TB"];

  const audioRtpArgs = [
    ...inputArgs,
    "-use_wallclock_as_timestamps", "1",
    "-i", options.sourceUrl,
    "-map", "0:a:0",
    "-vn",
    ...audioFilterArgs,
    "-c:a", "libopus",
    "-ar", "48000",
    "-ac", channels.toString(),
    "-b:a", "128k",
    "-application", "audio",
    "-vbr", "on",
    "-frame_duration", "20",
    "-payload_type", options.audioPayloadType.toString(),
    "-ssrc", options.audioSsrc.toString(),
    "-f", "rtp",
    `rtp://${options.rtpHost}:${options.audioRtpPort}?pkt_size=1200`,
  ];

  options.log("Starting video RTP process...");
  options.log("Video args:", [ffmpeg, ...videoRtpArgs].join(" "));

  const videoRtpProcess = Bun.spawn({
    cmd: [ffmpeg, ...videoRtpArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
  });

  options.log("Starting audio RTP process...");

  const audioRtpProcess = Bun.spawn({
    cmd: [ffmpeg, ...audioRtpArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
  });

  pipeOutput(videoRtpProcess, "Video RTP", options.log, options.error);
  pipeOutput(audioRtpProcess, "Audio RTP", options.log, options.error);

  return { videoRtp: videoRtpProcess, audioRtp: audioRtpProcess };
};

export const killFFmpegProcesses = (processes: TProcessPair): void => {
  processes.videoRtp?.kill();
  processes.audioRtp?.kill();
};
