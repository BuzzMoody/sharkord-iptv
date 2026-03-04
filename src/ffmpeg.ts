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

  // Single ffmpeg process for both video and audio
  // This prevents Dispatcharr from seeing 2 separate stream connections
  const ffmpegArgs = [
    "-fflags", "+discardcorrupt+genpts+igndts",
    "-err_detect", "ignore_err",
    "-analyzeduration", "5000000",
    "-probesize", "5000000",
    "-re",
    "-i", options.sourceUrl,
    // Video output to RTP
    "-map", "0:v:0",
    "-c:v", "copy",
    "-payload_type", options.videoPayloadType.toString(),
    "-ssrc", options.videoSsrc.toString(),
    "-f", "rtp",
    `rtp://${options.rtpHost}:${options.videoRtpPort}?pkt_size=1200`,
    // Audio output to RTP
    "-map", "0:a:0",
    "-c:a", "copy",
    "-payload_type", options.audioPayloadType.toString(),
    "-ssrc", options.audioSsrc.toString(),
    "-f", "rtp",
    `rtp://${options.rtpHost}:${options.audioRtpPort}?pkt_size=1200`,
  ];

  options.log("Starting combined video+audio RTP stream...");

  const rtpProcess = Bun.spawn({
    cmd: [binaryPath, ...ffmpegArgs],
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
          if (isError) options.log(`[${prefix}]`, text);
          else options.log(`[${prefix}]`, text);
        }
      }
    } catch (err) {
      options.error(`[${prefix} reader error]`, err);
    }
  };

  handleStream(rtpProcess.stdout, "RTP stdout", false);
  handleStream(rtpProcess.stderr, "RTP stderr", true);

  return {
    videoRtp: rtpProcess,
    audioRtp: null,
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