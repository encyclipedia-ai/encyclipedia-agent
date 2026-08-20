import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VideoInfo } from "./api.js";
import { toolPaths } from "./tools.js";

function run(
  argv: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const tools = toolPaths();
  const prefix = tools.ffmpeg ? ["--ffmpeg-location", tools.ffmpeg] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ytdlp, [...prefix, ...argv], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const line = text.trim();
      if (line) process.stderr.write(`  ${line}\n`);
    });
    child.on("error", (err) => {
      reject(
        new Error(`Could not start the video downloader (${err.message}).`),
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.trim().split("\n").slice(-8).join("\n")}`));
    });
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

export async function downloadSource(
  url: string,
  workDir: string,
): Promise<{ videoPath: string; captionsPath: string | null }> {
  fs.mkdirSync(workDir, { recursive: true });
  const output = path.join(workDir, "source.%(ext)s");
  await run([
    "--no-progress",
    "--no-playlist",
    "-f",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    "--merge-output-format",
    "mp4",
    "--write-subs",
    "--write-auto-subs",
    "--sub-format",
    "json3",
    "--sub-langs",
    "en.*,en",
    "--no-part",
    "--output",
    output,
    url,
  ], { cwd: workDir });

  const files = fs.readdirSync(workDir);
  const video =
    files.find((f) => f === "source.mp4") ?? files.find((f) => f.endsWith(".mp4"));
  if (!video) throw new Error("yt-dlp finished but no mp4 was produced");
  const captions = files.find((f) => f.endsWith(".json3")) ?? null;
  return {
    videoPath: path.join(workDir, video),
    captionsPath: captions ? path.join(workDir, captions) : null,
  };
}
