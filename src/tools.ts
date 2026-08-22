import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { binDir, ensureHomeDir } from "./paths.js";

const FFMPEG_RELEASE = "b6.1.1";
const YTDLP_LATEST = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const DENO_LATEST = "https://github.com/denoland/deno/releases/latest/download";
const YTDLP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const YTDLP_CHECK_EVERY_MS = 60 * 60 * 1000;
const YTDLP_CHECK_FAIL_MS = 15 * 60 * 1000;
const GITHUB_YTDLP_LATEST =
  "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

export interface ToolPaths {
  ytdlp: string;
  ffmpeg: string | null;
  deno: string | null;
  impersonate: string | null;
}

let cached: ToolPaths | null = null;
let lastYtdlpCheckAt = 0;
let downloaderLock: Promise<void> = Promise.resolve();

function isWindows(): boolean {
  return process.platform === "win32";
}

function findOnPath(name: string): string | null {
  const result = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 8_000 });
  if (result.error || result.status !== 0) return null;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
    timeout: 8_000,
  });
  const resolved = which.stdout.trim().split(/\r?\n/)[0];
  return resolved || name;
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

function denoAsset(): { url: string; filename: string } | null {
  const filename = isWindows() ? "deno.exe" : "deno";
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { url: `${DENO_LATEST}/deno-aarch64-apple-darwin.zip`, filename };
  }
  if (process.platform === "darwin") {
    return { url: `${DENO_LATEST}/deno-x86_64-apple-darwin.zip`, filename };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return { url: `${DENO_LATEST}/deno-aarch64-unknown-linux-gnu.zip`, filename };
  }
  if (process.platform === "linux") {
    return { url: `${DENO_LATEST}/deno-x86_64-unknown-linux-gnu.zip`, filename };
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return { url: `${DENO_LATEST}/deno-aarch64-pc-windows-msvc.zip`, filename };
  }
  if (process.platform === "win32") {
    return { url: `${DENO_LATEST}/deno-x86_64-pc-windows-msvc.zip`, filename };
  }
  return null;
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

function writeAtomic(dest: string, buf: Buffer): void {
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  fs.renameSync(tmp, dest);
}

async function ensureFile(dest: string, url: string, gz: boolean): Promise<void> {
  if (fs.existsSync(dest)) return;
  process.stderr.write(`  downloading ${path.basename(dest)}…\n`);
  let buf = await download(url);
  if (gz) buf = gunzipSync(buf);
  writeAtomic(dest, buf);
}

function ytdlpVersion(bin: string): string | null {
  if (!fs.existsSync(bin)) return null;
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 12_000 });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const match = text.match(/(\d{4}\.\d{2}\.\d{2})/);
  return match?.[1] ?? null;
}

function ytdlpVersionIsStale(version: string | null): boolean {
  if (!version) return true;
  const match = version.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!match) return true;
  const stamped = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Date.now() - stamped > YTDLP_MAX_AGE_MS;
}

function compareYtdlpVersion(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

export async function withDownloaderLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = downloaderLock;
  let release: () => void = () => {};
  downloaderLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function fetchLatestYtdlpVersion(): Promise<string | null> {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Encylipedia-Helper",
  };
  try {
    const res = await fetch(GITHUB_YTDLP_LATEST, {
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: string };
      const tag = body.tag_name?.replace(/^v/, "") ?? "";
      if (/^\d{4}\.\d{2}\.\d{2}/.test(tag)) return tag;
    }
  } catch {
    // Fall through to the asset redirect.
  }
  try {
    const res = await fetch(ytdlpAsset().url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": "Encylipedia-Helper" },
      signal: AbortSignal.timeout(12_000),
    });
    const location = res.headers.get("location") ?? "";
    const match = location.match(/\/download\/(\d{4}\.\d{2}\.\d{2}[^/]*)\//);
    if (match) return match[1];
  } catch {
    return null;
  }
  return null;
}

async function installLatestYtdlp(dest: string): Promise<void> {
  const asset = ytdlpAsset();
  process.stderr.write("  downloading yt-dlp…\n");
  const buf = await download(asset.url);
  writeAtomic(dest, buf);
  spawnSync(dest, ["--rm-cache-dir"], { encoding: "utf8", timeout: 15_000 });
  if (cached) {
    cached.ytdlp = dest;
    cached.impersonate = detectImpersonate(dest);
  }
}

/**
 * Pull the newest GitHub yt-dlp when ours is behind. Safe to call often:
 * checks are throttled to once an hour unless `force` is set (403 retry).
 * Returns true when the binary was replaced.
 */
export async function refreshYtdlpIfNeeded(
  opts: { force?: boolean } = {},
): Promise<boolean> {
  if (process.env.ENCYCLIPEDIA_YTDLP?.trim()) return false;
  const now = Date.now();
  if (!opts.force && now - lastYtdlpCheckAt < YTDLP_CHECK_EVERY_MS) return false;

  const dest = path.join(binDir(), isWindows() ? "yt-dlp.exe" : "yt-dlp");
  let latest: string | null = null;
  try {
    latest = await fetchLatestYtdlpVersion();
    lastYtdlpCheckAt = now;
  } catch {
    lastYtdlpCheckAt = now - YTDLP_CHECK_EVERY_MS + YTDLP_CHECK_FAIL_MS;
    latest = null;
  }

  const current = ytdlpVersion(dest);
  const remoteIsNewer = Boolean(latest && current && compareYtdlpVersion(latest, current) > 0);
  const missing = !current;
  const staleUnknownRemote = !latest && ytdlpVersionIsStale(current);
  if (!missing && !remoteIsNewer && !staleUnknownRemote) return false;

  await withDownloaderLock(async () => {
    const still = ytdlpVersion(dest);
    if (latest && still && compareYtdlpVersion(latest, still) <= 0) return;
    await installLatestYtdlp(dest);
  });
  return ytdlpVersion(dest) !== current;
}

function extractZip(zipPath: string, destDir: string): void {
  const result = spawnSync("tar", ["-xf", zipPath, "-C", destDir], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || result.error?.message || "Could not unpack deno",
    );
  }
}

async function ensureDeno(dest: string): Promise<string | null> {
  const pathDeno = findOnPath("deno");
  if (pathDeno) {
    const ver = spawnSync(pathDeno, ["--version"], { encoding: "utf8", timeout: 8_000 });
    const match = `${ver.stdout ?? ""}`.match(/deno\s+(\d+)\.(\d+)/i);
    if (match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 3))) {
      return pathDeno;
    }
  }
  if (fs.existsSync(dest)) return dest;
  const asset = denoAsset();
  if (!asset) return pathDeno;
  process.stderr.write("  downloading deno…\n");
  const zipPath = path.join(binDir(), "deno.zip");
  try {
    fs.writeFileSync(zipPath, await download(asset.url));
    extractZip(zipPath, binDir());
    const unpacked = path.join(binDir(), asset.filename);
    if (!fs.existsSync(unpacked)) {
      throw new Error("deno archive did not contain the deno binary");
    }
    fs.chmodSync(unpacked, 0o755);
    return unpacked;
  } catch (err) {
    console.warn(
      `Could not download deno (${err instanceof Error ? err.message : err}). YouTube downloads may fail.`,
    );
    return pathDeno;
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}

function detectImpersonate(ytdlp: string): string | null {
  const result = spawnSync(ytdlp, ["--list-impersonate-targets"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const chrome = text.split("\n").find((line) => /^\s*Chrome\b/i.test(line));
  if (chrome && !/unavailable/i.test(chrome)) return "chrome";
  return null;
}

/**
 * Official GitHub yt-dlp + deno, not Homebrew/pip. The PATH copy is
 * often months stale and lacks impersonation, which YouTube now requires.
 */
export async function ensureTools(): Promise<ToolPaths> {
  if (!cached) {
    ensureHomeDir();

    const override = process.env.ENCYCLIPEDIA_YTDLP?.trim();
    const ytdlpName = isWindows() ? "yt-dlp.exe" : "yt-dlp";
    const bundledYtdlp = path.join(binDir(), ytdlpName);

    if (!override && !fs.existsSync(bundledYtdlp)) {
      await installLatestYtdlp(bundledYtdlp);
    }

    const ytdlp = override ?? bundledYtdlp;
    const denoName = isWindows() ? "deno.exe" : "deno";
    const deno = await ensureDeno(path.join(binDir(), denoName));

    const ffmpegName = isWindows() ? "ffmpeg.exe" : "ffmpeg";
    const bundledFfmpeg = path.join(binDir(), ffmpegName);
    let ffmpeg = fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : findOnPath("ffmpeg");
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

    cached = {
      ytdlp,
      ffmpeg,
      deno,
      impersonate: detectImpersonate(ytdlp),
    };
  }

  await refreshYtdlpIfNeeded();
  return cached;
}

export function toolPaths(): ToolPaths {
  if (!cached) {
    throw new Error("Tools are not ready yet");
  }
  return cached;
}

/**
 * Forced player clients. Default is *none* — yt-dlp's own client list
 * returns a real DASH ladder on a residential IP. `--impersonate chrome`
 * plus `web`/`ios` currently yields storyboards only (SABR), which then
 * errors as "Requested format is not available".
 */
export const HELPER_EXTRACTOR_FALLBACKS = [
  "youtube:player_client=tv_embedded,web",
  "youtube:player_client=mweb",
  "youtube:player_client=ios",
];

/** Embedded TV client often serves age-gated videos without a login. */
export const AGE_GATE_YT_EXTRACTOR = "youtube:player_client=tv_embedded,web";

export function ytdlpCommonArgs(
  opts: {
    impersonate?: boolean;
    extractorArgs?: string;
    cookiesFromBrowser?: string;
  } = {},
): string[] {
  const tools = toolPaths();
  const args: string[] = ["--no-update", "--retries", "3"];
  if (tools.ffmpeg) args.push("--ffmpeg-location", tools.ffmpeg);
  if (tools.deno) {
    args.push("--js-runtimes", `deno:${tools.deno}`);
  }
  args.push("--remote-components", "ejs:github");
  if (opts.extractorArgs) {
    args.push("--extractor-args", opts.extractorArgs);
  }
  if (opts.cookiesFromBrowser) {
    args.push("--cookies-from-browser", opts.cookiesFromBrowser);
  }
  // Only when explicitly requested. Chrome impersonation currently makes
  // YouTube return storyboard thumbnails and no video formats.
  if (opts.impersonate === true && tools.impersonate) {
    args.push("--impersonate", tools.impersonate);
  }
  return args;
}

export function ytdlpEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${binDir()}${path.delimiter}${process.env.PATH ?? ""}`,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
  };
}
