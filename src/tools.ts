import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { binDir, ensureHomeDir } from "./paths.js";

const FFMPEG_RELEASE = "b6.1.1";
const YTDLP_LATEST = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

export interface ToolPaths {
  ytdlp: string;
  ffmpeg: string | null;
}

let cached: ToolPaths | null = null;

function isWindows(): boolean {
  return process.platform === "win32";
}

function findOnPath(name: string): string | null {
  const result = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 8_000 });
  if (result.error || result.status !== 0) return null;
  return name;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function ytdlpAsset(): { url: string; filename: string } {
  if (isWindows()) {
    return { url: `${YTDLP_LATEST}/yt-dlp.exe`, filename: "yt-dlp.exe" };
  }
  if (process.platform === "darwin") {
    return { url: `${YTDLP_LATEST}/yt-dlp_macos`, filename: "yt-dlp" };
  }
  if (process.arch === "arm64") {
    return { url: `${YTDLP_LATEST}/yt-dlp_linux_aarch64`, filename: "yt-dlp" };
  }
  return { url: `${YTDLP_LATEST}/yt-dlp_linux`, filename: "yt-dlp" };
}

function ffmpegAsset(): { url: string; filename: string } | null {
  const filename = isWindows() ? "ffmpeg.exe" : "ffmpeg";
  let slug: string;
  if (process.platform === "darwin" && process.arch === "arm64") slug = "ffmpeg-darwin-arm64.gz";
  else if (process.platform === "darwin") slug = "ffmpeg-darwin-x64.gz";
  else if (process.platform === "linux" && process.arch === "arm64") slug = "ffmpeg-linux-arm64.gz";
  else if (process.platform === "linux") slug = "ffmpeg-linux-x64.gz";
  else if (process.platform === "win32") slug = "ffmpeg-win32-x64.gz";
  else return null;
  return {
    url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/${slug}`,
    filename,
  };
}

async function ensureFile(dest: string, url: string, gz: boolean): Promise<void> {
  if (fs.existsSync(dest)) return;
  process.stderr.write(`  downloading ${path.basename(dest)}…\n`);
  let buf = await download(url);
  if (gz) buf = gunzipSync(buf);
  fs.writeFileSync(dest, buf, { mode: 0o755 });
}

/**
 * Make sure yt-dlp (and ffmpeg when needed) exist. Prefers a system
 * install, otherwise fetches into ~/.encyclipedia/bin so the customer
 * never has to touch Homebrew or PATH.
 */
export async function ensureTools(): Promise<ToolPaths> {
  if (cached) return cached;
  ensureHomeDir();

  const ytdlpName = isWindows() ? "yt-dlp.exe" : "yt-dlp";
  const bundledYtdlp = path.join(binDir(), ytdlpName);
  let ytdlp = findOnPath("yt-dlp") ?? (fs.existsSync(bundledYtdlp) ? bundledYtdlp : null);
  if (!ytdlp) {
    const asset = ytdlpAsset();
    await ensureFile(bundledYtdlp, asset.url, false);
    ytdlp = bundledYtdlp;
  }

  const ffmpegName = isWindows() ? "ffmpeg.exe" : "ffmpeg";
  const bundledFfmpeg = path.join(binDir(), ffmpegName);
  let ffmpeg = findOnPath("ffmpeg") ?? (fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : null);
  if (!ffmpeg) {
    const asset = ffmpegAsset();
    if (asset) {
      try {
        await ensureFile(bundledFfmpeg, asset.url, true);
        ffmpeg = bundledFfmpeg;
      } catch (err) {
        console.warn(
          `Could not download ffmpeg (${err instanceof Error ? err.message : err}). Some videos may fail to merge.`,
        );
      }
    }
  }

  cached = { ytdlp, ffmpeg };
  return cached;
}

export function toolPaths(): ToolPaths {
  if (!cached) {
    throw new Error("Tools are not ready yet");
  }
  return cached;
}
