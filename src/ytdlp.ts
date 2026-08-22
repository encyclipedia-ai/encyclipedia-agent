import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VideoInfo } from "./api.js";
import {
  AGE_GATE_YT_EXTRACTOR,
  HELPER_EXTRACTOR_FALLBACKS,
  refreshYtdlpIfNeeded,
  toolPaths,
  withDownloaderLock,
  ytdlpCommonArgs,
  ytdlpEnv,
} from "./tools.js";

class YoutubeBlockedError extends Error {
  constructor() {
    super("YouTube refused the download. Wait a moment and try again.");
  }
}

class MergeFailedError extends Error {
  constructor() {
    super("Could not merge video and audio into mp4.");
  }
}

class NoSpaceError extends Error {
  constructor() {
    super("This computer is out of disk space. Free a few gigabytes and try a shorter video.");
  }
}

class FormatUnavailableError extends Error {
  constructor(detail: string) {
    super(detail || "Requested format is not available.");
  }
}

class AgeRestrictedError extends Error {
  constructor() {
    super(
      "This video is age-restricted. Sign into YouTube in Chrome or Safari, then try again.",
    );
  }
}

export type YtdlpProgressFn = (update: {
  percent: number | null;
  detail: string;
}) => void;

type RunOpts = {
  cwd?: string;
  onProgress?: YtdlpProgressFn;
  impersonate?: boolean;
  extractorArgs?: string;
  cookiesFromBrowser?: string;
};

function parseDownloadProgress(text: string): {
  percent: number;
  speed?: string;
  eta?: string;
} | null {
  const percentMatch = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (!percentMatch) return null;
  const speed = text.match(/\s+at\s+(\S+)/)?.[1];
  const eta = text.match(/ETA\s+(\S+)/)?.[1];
  return {
    percent: Number(percentMatch[1]),
    speed: speed && speed !== "Unknown" ? speed : undefined,
    eta: eta && eta !== "Unknown" ? eta : undefined,
  };
}

function cookieBrowsers(): string[] {
  if (process.platform === "darwin") {
    return ["chrome", "safari", "edge", "brave", "firefox"];
  }
  if (process.platform === "win32") {
    return ["chrome", "edge", "brave", "firefox"];
  }
  return ["chrome", "chromium", "firefox", "brave"];
}

function looksLikeCookieFailure(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /cookies|could not copy|unable to load|no such browser|keyring|profile/i.test(
    text,
  );
}

function spawnYtdlp(
  argv: string[],
  opts: RunOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
        const tools = toolPaths();
        const child = spawn(
          tools.ytdlp,
          [
            ...ytdlpCommonArgs({
              impersonate: opts.impersonate,
              extractorArgs: opts.extractorArgs,
              cookiesFromBrowser: opts.cookiesFromBrowser,
            }),
            ...argv,
          ],
          {
          cwd: opts.cwd,
          env: ytdlpEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let lineBuf = "";
        const handleChunk = (chunk: Buffer, fromStdout: boolean) => {
          const text = chunk.toString();
          if (fromStdout) stdout += text;
          else stderr += text;
          lineBuf += text;
          const lines = lineBuf.split(/\r?\n/);
          lineBuf = lines.pop() ?? "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            if (!fromStdout) process.stderr.write(`  ${line}\n`);
            if (!opts.onProgress) continue;
            const parsed = parseDownloadProgress(line);
            if (parsed) {
              const bits = [`Downloading ${Math.round(parsed.percent)}%`];
              if (parsed.speed) bits.push(parsed.speed);
              if (parsed.eta) bits.push(`ETA ${parsed.eta}`);
              opts.onProgress({ percent: parsed.percent, detail: bits.join(" · ") });
              continue;
            }
            if (/\[Merger\]/i.test(line) || /Merging formats/i.test(line)) {
              opts.onProgress({ percent: 100, detail: "Merging video and audio…" });
            } else if (/\[ExtractAudio\]/i.test(line)) {
              opts.onProgress({ percent: 100, detail: "Extracting audio…" });
            } else if (/Deleting original file/i.test(line)) {
              opts.onProgress({ percent: 100, detail: "Finishing the download…" });
            }
          }
        };
        child.stdout.on("data", (chunk: Buffer) => handleChunk(chunk, true));
        child.stderr.on("data", (chunk: Buffer) => handleChunk(chunk, false));
        child.on("error", (err) => {
          reject(
            new Error(`Could not start the video downloader (${err.message}).`),
          );
        });
        child.on("close", (code) => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const lines = stderr.trim().split("\n");
          const errorLine =
            [...lines].reverse().find((line) => /ERROR:/i.test(line)) ??
            lines.slice(-3).join("\n");
          const detail = errorLine.replace(/^ERROR:\s*/i, "").trim();
          const haystack = `${detail}\n${stderr}`;
          if (/No space left on device|ENOSPC|Errno 28/i.test(haystack)) {
            reject(new NoSpaceError());
            return;
          }
          if (/sign in to confirm your age|age-restricted|confirm your age/i.test(haystack)) {
            reject(new AgeRestrictedError());
            return;
          }
          if (/The page needs to be reloaded/i.test(haystack)) {
            reject(new FormatUnavailableError(detail));
            return;
          }
          if (/403|Forbidden/i.test(detail)) {
            reject(new YoutubeBlockedError());
            return;
          }
          if (/Requested format is not available/i.test(haystack)) {
            reject(new FormatUnavailableError(detail));
            return;
          }
          if (/Conversion failed|merg(e|ing).*fail/i.test(haystack)) {
            reject(new MergeFailedError());
            return;
          }
          reject(new Error(detail || `Could not download the video (exit ${code}).`));
        });
  });
}

async function run(
  argv: string[],
  opts: RunOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  return withDownloaderLock(async () => {
    const tryOnce = (extra: RunOpts = {}) => spawnYtdlp(argv, { ...opts, ...extra });

    const retryAgeGate = async (): Promise<{ stdout: string; stderr: string }> => {
      opts.onProgress?.({
        percent: null,
        detail: "Age-restricted video; using your YouTube browser login…",
      });
      for (const browser of cookieBrowsers()) {
        try {
          process.stderr.write(`  Age-restricted; trying ${browser} cookies…\n`);
          return await tryOnce({ cookiesFromBrowser: browser });
        } catch (retryErr) {
          if (retryErr instanceof AgeRestrictedError || looksLikeCookieFailure(retryErr)) {
            continue;
          }
          throw retryErr;
        }
      }
      opts.onProgress?.({
        percent: null,
        detail: "Retrying with an embedded player…",
      });
      process.stderr.write("  Age-restricted; trying tv_embedded player…\n");
      return tryOnce({ extractorArgs: AGE_GATE_YT_EXTRACTOR });
    };

    try {
      return await tryOnce();
    } catch (err) {
      if (err instanceof AgeRestrictedError) {
        try {
          return await retryAgeGate();
        } catch {
          throw err;
        }
      }

      const clientMismatch =
        err instanceof YoutubeBlockedError || err instanceof FormatUnavailableError;
      if (!clientMismatch || opts.extractorArgs) throw err;

      process.stderr.write("  YouTube refused this player client; trying others…\n");
      opts.onProgress?.({
        percent: null,
        detail: "YouTube refused this player; trying another…",
      });
      await refreshYtdlpIfNeeded({ force: true });

      for (const extractorArgs of HELPER_EXTRACTOR_FALLBACKS) {
        try {
          process.stderr.write(`  Trying ${extractorArgs}…\n`);
          return await tryOnce({ extractorArgs });
        } catch (retryErr) {
          if (
            retryErr instanceof YoutubeBlockedError ||
            retryErr instanceof FormatUnavailableError ||
            retryErr instanceof AgeRestrictedError
          ) {
            if (retryErr instanceof AgeRestrictedError) {
              try {
                return await retryAgeGate();
              } catch {
                continue;
              }
            }
            continue;
          }
          throw retryErr;
        }
      }

      try {
        process.stderr.write("  Retrying with browser impersonation…\n");
        return await tryOnce({ impersonate: true });
      } catch {
        throw err;
      }
    }
  });
}

export async function dumpVideoInfo(url: string): Promise<VideoInfo> {
  const { stdout } = await run(["--dump-json", "--no-download", "--no-warnings", url]);
  const info = JSON.parse(stdout) as {
    id: string;
    title: string;
    duration?: number;
    thumbnail?: string;
    channel_id?: string;
    uploader_id?: string;
    channel?: string;
    uploader?: string;
    channel_url?: string;
    uploader_url?: string;
  };
  return {
    id: info.id,
    title: info.title,
    duration: info.duration ?? 0,
    thumbnail: info.thumbnail ?? "",
    channelId: info.channel_id || info.uploader_id || "",
    channelName: info.channel || info.uploader || "Unknown Channel",
    channelUrl: info.channel_url || info.uploader_url || "",
    channelAvatar: null,
  };
}

function commonDownloadArgs(output: string): string[] {
  return [
    "--newline",
    "--no-playlist",
    "--write-subs",
    "--write-auto-subs",
    "--sub-format",
    "json3",
    "--sub-langs",
    "en.*,en",
    "--no-part",
    "--output",
    output,
  ];
}

function remuxToMp4(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const ffmpeg = toolPaths().ffmpeg;
  if (!ffmpeg) {
    throw new Error("yt-dlp finished but no mp4 was produced, and ffmpeg is missing.");
  }
  const copyArgs = [
    "-y",
    "-i",
    inputPath,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  const recodeArgs = [
    "-y",
    "-i",
    inputPath,
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  return new Promise((resolve, reject) => {
    const tryRun = (args: string[], recode: boolean) => {
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        if (!recode) {
          tryRun(recodeArgs, true);
          return;
        }
        reject(new Error(stderr.trim().split("\n").slice(-3).join("\n") || "ffmpeg conversion failed"));
      });
    };
    tryRun(copyArgs, false);
  });
}

function tmpFreeBytes(): number {
  const info = fs.statfsSync(os.tmpdir());
  return Number(info.bavail) * Number(info.bsize);
}

function youtubeFormat(): string {
  const free = tmpFreeBytes();
  if (free < 2 * 1024 * 1024 * 1024) {
    throw new NoSpaceError();
  }
  if (free < 5 * 1024 * 1024 * 1024) {
    return "bestvideo[height<=720]+bestaudio/best[height<=720]";
  }
  return "bestvideo[height<=1080]+bestaudio/best[height<=1080]";
}

/** Remove leftover `encyclipedia-agent-*` dirs from a crashed or ENOSPC run. */
export function sweepDownloadTemps(): void {
  const tmp = os.tmpdir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("encyclipedia-agent-")) continue;
    fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
  }
}

function clearMediaFiles(workDir: string): void {
  for (const name of fs.readdirSync(workDir)) {
    if (name.endsWith(".json3")) continue;
    fs.rmSync(path.join(workDir, name), { force: true });
  }
}

export async function downloadSource(
  url: string,
  workDir: string,
  onProgress?: YtdlpProgressFn,
): Promise<{ videoPath: string; captionsPath: string | null }> {
  fs.mkdirSync(workDir, { recursive: true });
  const output = path.join(workDir, "source.%(ext)s");
  const shared = commonDownloadArgs(output);

  const format = youtubeFormat();
  const formatArgs = [
    "-f",
    format,
    "--merge-output-format",
    "mp4",
  ];
  const withAacRemux = [
    ...shared,
    ...formatArgs,
    "--postprocessor-args",
    "Merger:-c:v copy -c:a aac -movflags +faststart",
  ];
  const workerExact = [...shared, ...formatArgs];

  const attempts: Array<{ argv: string[]; impersonate?: boolean }> = [
    { argv: withAacRemux },
    { argv: workerExact },
  ];
  let lastError: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      await run([...attempt.argv, url], {
        cwd: workDir,
        onProgress,
        impersonate: attempt.impersonate,
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (
        (err instanceof FormatUnavailableError || err instanceof MergeFailedError) &&
        i < attempts.length - 1
      ) {
        process.stderr.write("  Retrying download…\n");
        onProgress?.({
          percent: null,
          detail: "Retrying download…",
        });
        clearMediaFiles(workDir);
        continue;
      }
      throw err;
    }
  }
  if (lastError) throw lastError;

  const files = fs.readdirSync(workDir);
  let video =
    files.find((f) => f === "source.mp4") ?? files.find((f) => f.endsWith(".mp4"));
  if (!video) {
    const other = files.find((f) => /\.(mkv|webm|mov)$/i.test(f));
    if (!other) throw new Error("yt-dlp finished but no video file was produced");
    onProgress?.({ percent: 100, detail: "Converting to mp4…" });
    const dest = path.join(workDir, "source.mp4");
    await remuxToMp4(path.join(workDir, other), dest);
    video = "source.mp4";
  }
  const captions = files.find((f) => f.endsWith(".json3")) ?? null;
  return {
    videoPath: path.join(workDir, video),
    captionsPath: captions ? path.join(workDir, captions) : null,
  };
}
