import path from "path";
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
  log: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
};

type TProcessPair = {
  videoRtp?: ReturnType<typeof Bun.spawn> | null;
  audioRtp?: ReturnType<typeof Bun.spawn> | null;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

const getBinaryPath = (): string => {
  // Always use the system-installed ffmpeg
  if (process.platform === "win32") {
    return "ffmpeg.exe";
  }
  return "ffmpeg";
};

const spawnFFmpeg = async (
  pluginPath: string,
  options: TOptions,
): Promise<TProcessPair> => {
  const binaryPath = getBinaryPath();
  options.log(`Binary path: ${binaryPath}`);

  // Safely encode the messy IPTV URL so it doesn't break the RTSP link
  const encodedUrl = encodeURIComponent(options.sourceUrl);

  // Generate a random stream ID to prevent collisions if multiple streams start
  const streamId = Math.random().toString(36).substring(2, 8);

  // --- IMPORTANT: CHANGE THIS TO YOUR MEDIAMTX SERVER'S IP ---
  const base64Url = Buffer.from(options.sourceUrl).toString('base64');

  const MEDIA_MTX_IP = "127.0.0.1"; 
  const middlemanUrl = `rtsp://${MEDIA_MTX_IP}:8554/iptv/${base64Url}`;

  options.log(`Requesting GPU stream from Middleman: ${middlemanUrl}`);

  // Stream VIDEO directly to RTP (Zero CPU, instant load)
  const videoRtpArgs = [
    "-re",
    "-rtsp_transport", "tcp", // Crucial for stable RTSP ingest
    "-i", middlemanUrl,
    "-map", "0:v:0",
    "-an",
    // NEVER transcode here, just copy the GPU's hard work
    "-c:v", "copy",
    "-payload_type", options.videoPayloadType.toString(),
    "-ssrc", options.videoSsrc.toString(),
    "-f", "rtp",
    `rtp://${options.rtpHost}:${options.videoRtpPort}?pkt_size=1200`,
  ];

  options.log("Starting video RTP stream...");
  
  const videoRtpProcess = Bun.spawn({
    cmd: [binaryPath, ...videoRtpArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  // Stream AUDIO directly to RTP
  const audioRtpArgs = [
    "-re",
    "-rtsp_transport", "tcp",
    "-i", middlemanUrl,
    "-map", "0:a:0",
    "-vn",
    // Transcode AAC back to Opus for WebRTC
    "-c:a", "libopus",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "128k",
    "-payload_type", options.audioPayloadType.toString(),
    "-ssrc", options.audioSsrc.toString(),
    "-f", "rtp",
    `rtp://${options.rtpHost}:${options.audioRtpPort}?pkt_size=1200`,
  ];

  options.log("Starting audio RTP stream...");
  
  const audioRtpProcess = Bun.spawn({
    cmd: [binaryPath, ...audioRtpArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  // Helper function to handle logs cleanly
  const handleStream = async (stream: any, prefix: string, isError: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) {
          if (isError) options.log(`[${prefix}]`, text); // Logging all as standard output to prevent spam, can change to options.error if needed
          else options.log(`[${prefix}]`, text);
        }
      }
    } catch (err) {
      options.error(`[${prefix} reader error]`, err);
    }
  };

  handleStream(videoRtpProcess.stdout, "Video RTP stdout", false);
  handleStream(videoRtpProcess.stderr, "Video RTP stderr", true);
  handleStream(audioRtpProcess.stdout, "Audio RTP stdout", false);
  handleStream(audioRtpProcess.stderr, "Audio RTP stderr", true);

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