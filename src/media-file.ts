import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { toolPaths } from "./tools.js";

export const CLIP_FILE_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "m4v"] as const;
export const LOCAL_VIDEO_EXTENSIONS = CLIP_FILE_EXTENSIONS;

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

export function isMp4Path(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".mp4";
}

export function isAllowedClipPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return (CLIP_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Parse `Duration: HH:MM:SS.xx` from ffmpeg `-i` stderr. Returns 0 if missing. */
export function parseFfmpegDuration(stderr: string): number {
  const match = stderr.match(DURATION_RE);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return total;
}

export const isAllowedVideoPath = isAllowedClipPath;

function requireFfmpeg(): string {
  const ffmpeg = toolPaths().ffmpeg;
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg is not available. Restart Librarian so it can download media tools.",
    );
  }
  return ffmpeg;
}

function runFfmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
  const ffmpeg = requireFfmpeg();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out."));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

export async function probeMediaDuration(filePath: string): Promise<number> {
  const { stderr } = await runFfmpeg(["-hide_banner", "-i", filePath]);
  const duration = parseFfmpegDuration(stderr);
  if (duration <= 0) {
    throw new Error("Could not read the duration of this video.");
  }
  return duration;
}

export async function remuxCopyToMp4(inputPath: string, outputPath: string): Promise<void> {
  const { code, stderr } = await runFfmpeg([
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
  if (code !== 0) {
    const hint = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200);
    throw new Error(
      hint
        ? `This file could not be remuxed to mp4 without re-encoding (${hint}). Convert it to mp4 and try again.`
        : "This file could not be remuxed to mp4 without re-encoding. Convert it to mp4 and try again.",
    );
  }
}

export async function cutMp4Copy(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  const { code, stderr } = await runFfmpeg([
    "-hide_banner",
    "-y",
    "-ss",
    String(startSec),
    "-i",
    inputPath,
    "-t",
    String(durationSec),
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
  if (code !== 0) {
    const hint = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200);
    throw new Error(
      hint
        ? `Could not cut this desktop upload without re-encoding (${hint}).`
        : "Could not cut this desktop upload without re-encoding.",
    );
  }
}

export async function assertReadableVideo(filePath: string): Promise<void> {
  const trimmed = filePath.trim();
  if (!trimmed) throw new Error("Choose a video file first.");
  try {
    await fs.promises.access(trimmed, fs.constants.R_OK);
  } catch {
    throw new Error("That file could not be found.");
  }
  if (!isAllowedClipPath(trimmed)) {
    throw new Error("Choose an mp4, mov, mkv, webm, or m4v file.");
  }
}

export async function probeMediaFile(filePath: string): Promise<{ duration: number }> {
  return { duration: await probeMediaDuration(filePath) };
}

export async function prepareSourceMp4(
  filePath: string,
  workDir: string,
): Promise<{ videoPath: string }> {
  if (isMp4Path(filePath)) return { videoPath: filePath };
  const dest = path.join(workDir, "source.mp4");
  await remuxCopyToMp4(filePath, dest);
  return { videoPath: dest };
}

export async function cutMediaSection(
  inputPath: string,
  startSec: number,
  durationSec: number,
  outputPath: string,
): Promise<void> {
  try {
    await cutMp4Copy(inputPath, outputPath, startSec, durationSec);
  } catch {
    await cutMp4Encode(inputPath, outputPath, startSec, durationSec);
  }
}

export async function extractAudioMp3(inputPath: string, outputPath: string): Promise<void> {
  const { code, stderr } = await runFfmpeg([
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    outputPath,
  ]);
  if (code !== 0) {
    const hint = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200);
    throw new Error(
      hint ? `Could not extract audio (${hint}).` : "Could not extract audio from this file.",
    );
  }
}

async function cutMp4Encode(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  const { code, stderr } = await runFfmpeg([
    "-hide_banner",
    "-y",
    "-ss",
    String(startSec),
    "-i",
    inputPath,
    "-t",
    String(durationSec),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
  if (code !== 0) {
    const hint = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200);
    throw new Error(
      hint ? `Could not cut this clip (${hint}).` : "Could not cut this clip.",
    );
  }
}

export async function downloadToFile(
  downloadUrl: string,
  destPath: string,
  headers?: Record<string, string>,
): Promise<void> {
  const res = await fetch(downloadUrl, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`download failed ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("download failed: empty body");
  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      cb(null, chunk);
    },
  });
  await pipeline(nodeStream, meter, fs.createWriteStream(destPath));
}
