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

  options.log(`Pulling directly from Dispatcharr: ${options.sourceUrl}`);

  // Shared input args - pull directly from Dispatcharr which handles VAAPI transcoding
  const sharedInputArgs = [
    "-fflags", "+discardcorrupt+genpts+igndts",
    "-err_detect", "ignore_err",
    "-analyzeduration", "5000000",
    "-probesize", "5000000",
    "-re",
    "-i", options.sourceUrl,
  ];

  // Stream VIDEO directly to RTP - Dispatcharr already transcoded, just copy
  const videoRtpArgs = [
    ...sharedInputArgs,
    "-map", "0:v:0",
    "-an",
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

  // Stream AUDIO directly to RTP - Dispatcharr already transcoded to Opus, just copy
  const audioRtpArgs = [
    ...sharedInputArgs,
    "-map", "0:a:0",
    "-vn",
    "-c:a", "copy",
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