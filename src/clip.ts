import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import * as api from "./api.js";
import { AgentApiError, JobCancelledError, isJobCancelledError } from "./api.js";
import { analysisChunkRanges } from "./analysis-chunks.js";
import type { QueuePatch } from "./job-queue.js";
import { isRecutClaim, isLocalFileIngest, RECUT_NOT_FULL_VOD, RECUT_WINDOW_MISSING } from "./claim.js";
import {
  assertReadableVideo,
  cutMediaSection,
  downloadToFile,
  prepareSourceMp4,
  probeMediaFile,
} from "./media-file.js";
import { paddedClipWindow } from "./clip-windows.js";
import { putFile } from "./upload.js";
import {
  downloadSection,
  downloadSource,
  dumpVideoInfo,
  sweepDownloadTemps,
} from "./ytdlp.js";

const TERMINAL = new Set(["done", "error", "cancelled"]);

function shouldFailRemoteJob(err: unknown): boolean {
  return !isJobCancelledError(err) && !(err instanceof AgentApiError && err.status === 409);
}

export type LogFn = (update: string | QueuePatch) => void;

function say(onLog: LogFn | undefined, line: string, patch?: QueuePatch): void {
  onLog?.(patch ? { ...patch, detail: line } : line);
  console.log(line);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export async function ingestSource(
  cfg: AgentConfig,
  url: string,
  onLog?: LogFn,
  opts?: { clipLength: "short" | "medium"; jobId?: string; signal?: AbortSignal },
): Promise<{
  video: api.VideoInfo;
  source: api.JobSource;
  clipPlan: api.ClipPlan;
}> {
  say(onLog, "Looking up the video…", { phase: "lookup", percent: null });
  const video = await dumpVideoInfo(url, opts?.signal);
  say(onLog, video.title, { title: video.title, phase: "lookup" });
  if (!opts?.jobId) {
    throw new Error("Librarian needs a job id before it can scan for clip windows.");
  }

  sweepDownloadTemps();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-agent-"));
  try {
    const chunks = await uploadYoutubeAnalysisChunks(
      cfg,
      url,
      video,
      workDir,
      onLog,
      opts.signal,
    );
    const clipPlan = await analyzeChunks(
      cfg,
      chunks,
      video,
      opts.clipLength,
      opts.jobId,
      onLog,
      opts.signal,
    );
    const windows = await uploadYoutubeClipWindows(
      cfg,
      url,
      video,
      clipPlan,
      workDir,
      onLog,
      opts.signal,
    );
    return {
      video,
      source: { bucket: windows.bucket, windows: windows.windows },
      clipPlan,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function uploadYoutubeAnalysisChunks(
  cfg: AgentConfig,
  url: string,
  video: api.VideoInfo,
  workDir: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<api.AnalysisChunk[]> {
  const ranges = analysisChunkRanges(video.duration);
  let localSource: string | undefined;
  return uploadAnalysisChunkFiles(cfg, video.id, ranges, async (range, index) => {
    if (localSource) {
      const cutPath = path.join(workDir, `chunk_${index}.mp4`);
      await cutMediaSection(localSource, range.startSec, range.durationSec, cutPath);
      return cutPath;
    }
    try {
      return await downloadSection(
        url,
        range.startSec,
        range.durationSec,
        workDir,
        (update) => {
          onLog?.({
            phase: "download",
            percent: update.percent,
            detail: update.detail,
          });
        },
        `chunk_${index}`,
        signal,
      );
    } catch (err) {
      if (isJobCancelledError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      say(
        onLog,
        `Section download failed (${message}). Downloading locally to cut 30-minute chunks — the full file stays on this computer.`,
      );
      if (!localSource) {
        const downloaded = await downloadSource(
          url,
          workDir,
          (update) => {
            onLog?.({
              phase: "download",
              percent: update.percent,
              detail: update.detail,
            });
          },
          signal,
        );
        localSource = downloaded.videoPath;
      }
      const cutPath = path.join(workDir, `chunk_${index}.mp4`);
      await cutMediaSection(localSource, range.startSec, range.durationSec, cutPath);
      return cutPath;
    }
  }, onLog, signal);
}

async function uploadLocalAnalysisChunks(
  cfg: AgentConfig,
  videoId: string,
  sourcePath: string,
  durationSec: number,
  workDir: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<api.AnalysisChunk[]> {
  const ranges = analysisChunkRanges(durationSec);
  return uploadAnalysisChunkFiles(cfg, videoId, ranges, async (range, index) => {
    const cutPath = path.join(workDir, `chunk_${index}.mp4`);
    await cutMediaSection(sourcePath, range.startSec, range.durationSec, cutPath);
    return cutPath;
  }, onLog, signal);
}

async function uploadAnalysisChunkFiles(
  cfg: AgentConfig,
  videoId: string,
  ranges: Array<{ startSec: number; durationSec: number }>,
  materialize: (
    range: { startSec: number; durationSec: number },
    index: number,
  ) => Promise<string>,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<api.AnalysisChunk[]> {
  const chunks: api.AnalysisChunk[] = [];
  for (const [index, range] of ranges.entries()) {
    const startMin = Math.floor(range.startSec / 60);
    const endMin = Math.ceil((range.startSec + range.durationSec) / 60);
    say(onLog, `Preparing minutes ${startMin}–${endMin}…`, {
      phase: "download",
      percent: 0,
    });
    const videoPath = await materialize(range, index);
    say(onLog, `Uploading minutes ${startMin}–${endMin} for Gemini…`, {
      phase: "upload",
      percent: 0,
    });
    const target = await api.requestUploadUrl(cfg, videoId, "chunk", "video/mp4", index);
    await putFile(
      target,
      videoPath,
      (percent, sent, total) => {
        onLog?.({
          phase: "upload",
          percent,
          detail: `Uploading minutes ${startMin}–${endMin} · ${percent}% · ${formatBytes(sent)} of ${formatBytes(total)}`,
        });
      },
      signal,
    );
    chunks.push({
      bucket: target.bucket,
      objectKey: target.objectKey,
      startSec: range.startSec,
      durationSec: range.durationSec,
    });
  }
  return chunks;
}

async function analyzeChunks(
  cfg: AgentConfig,
  chunks: api.AnalysisChunk[],
  video: api.VideoInfo,
  clipLength: "short" | "medium",
  jobId: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<api.ClipPlan> {
  say(onLog, "Watching the video for viral moments…", { phase: "analyze", percent: null });
  const plan = await api.analyzeJob(
    cfg,
    jobId,
    {
      chunks,
      clipLength,
      videoTitle: video.title,
    },
    signal,
  );
  if (plan.clips.length === 0) {
    throw new Error("No clip-worthy moments were found in this video.");
  }
  const grouped = plan.categories?.length
    ? plan.categories.length
    : new Set(plan.clips.map((clip) => clip.category).filter(Boolean)).size;
  say(
    onLog,
    plan.clips.length === 1
      ? "Found 1 viral moment"
      : `Found ${plan.clips.length} viral moments in ${grouped} highlight${grouped === 1 ? "" : "s"}`,
    { phase: "analyze" },
  );
  return plan;
}

async function uploadYoutubeClipWindows(
  cfg: AgentConfig,
  url: string,
  video: api.VideoInfo,
  clipPlan: api.ClipPlan,
  workDir: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<{ bucket: string; windows: api.SourceWindow[] }> {
  const windows: api.SourceWindow[] = [];
  let bucket = "";
  let localSource: string | undefined;
  for (const [i, clip] of clipPlan.clips.entries()) {
    const padded = paddedClipWindow(clip, video.duration);
    say(
      onLog,
      `Downloading clip window ${i + 1}/${clipPlan.clips.length}…`,
      { phase: "download", percent: 0 },
    );
    let videoPath: string;
    try {
      if (localSource) {
        videoPath = path.join(workDir, `window_${i}.mp4`);
        await cutMediaSection(localSource, padded.startSec, padded.durationSec, videoPath);
      } else {
        videoPath = await downloadSection(
          url,
          padded.startSec,
          padded.durationSec,
          workDir,
          (update) => {
            onLog?.({
              phase: "download",
              percent: update.percent,
              detail: update.detail,
            });
          },
          `window_${i}`,
          signal,
        );
      }
    } catch (err) {
      if (isJobCancelledError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      say(
        onLog,
        `Section download failed (${message}). Downloading locally to cut windows — the full file stays on this computer.`,
      );
      if (!localSource) {
        const downloaded = await downloadSource(
          url,
          workDir,
          (update) => {
            onLog?.({
              phase: "download",
              percent: update.percent,
              detail: update.detail,
            });
          },
          signal,
        );
        localSource = downloaded.videoPath;
      }
      videoPath = path.join(workDir, `window_${i}.mp4`);
      await cutMediaSection(localSource, padded.startSec, padded.durationSec, videoPath);
    }
    say(
      onLog,
      `Uploading clip window ${i + 1}/${clipPlan.clips.length}…`,
      { phase: "upload", percent: 0 },
    );
    const target = await api.requestUploadUrl(cfg, video.id, "window", "video/mp4", i);
    await putFile(
      target,
      videoPath,
      (percent, sent, total) => {
        onLog?.({
          phase: "upload",
          percent,
          detail: `Uploading window ${i + 1} · ${percent}% · ${formatBytes(sent)} of ${formatBytes(total)}`,
        });
      },
      signal,
    );
    bucket = target.bucket;
    windows.push({
      objectKey: target.objectKey,
      startSec: padded.startSec,
      durationSec: padded.durationSec,
    });
  }
  return { bucket, windows };
}

async function uploadLocalClipWindows(
  cfg: AgentConfig,
  videoId: string,
  sourcePath: string,
  videoDuration: number,
  clipPlan: api.ClipPlan,
  workDir: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<{ bucket: string; windows: api.SourceWindow[] }> {
  const windows: api.SourceWindow[] = [];
  let bucket = "";
  for (const [i, clip] of clipPlan.clips.entries()) {
    const padded = paddedClipWindow(clip, videoDuration);
    const cutPath = path.join(workDir, `window_${i}.mp4`);
    say(
      onLog,
      `Cutting clip window ${i + 1}/${clipPlan.clips.length}…`,
      { phase: "download", percent: null },
    );
    await cutMediaSection(sourcePath, padded.startSec, padded.durationSec, cutPath);
    say(
      onLog,
      `Uploading clip window ${i + 1}/${clipPlan.clips.length}…`,
      { phase: "upload", percent: 0 },
    );
    const target = await api.requestUploadUrl(cfg, videoId, "window", "video/mp4", i);
    await putFile(
      target,
      cutPath,
      (percent, sent, total) => {
        onLog?.({
          phase: "upload",
          percent,
          detail: `Uploading window ${i + 1} · ${percent}% · ${formatBytes(sent)} of ${formatBytes(total)}`,
        });
      },
      signal,
    );
    bucket = target.bucket;
    windows.push({
      objectKey: target.objectKey,
      startSec: padded.startSec,
      durationSec: padded.durationSec,
    });
  }
  return { bucket, windows };
}

export async function waitForWorker(
  cfg: AgentConfig,
  jobId: string,
  onLog?: LogFn,
): Promise<void> {
  say(onLog, "Renderer is preparing clips…", { phase: "render", percent: null });
  while (true) {
    const job = await api.getJob(cfg, jobId);
    say(onLog, job.progress || job.status, { phase: "render" });
    if (TERMINAL.has(job.status)) {
      if (job.status === "done") {
        say(onLog, "Done. Clips are in your encyclipedia stacks.", {
          phase: "done",
          percent: 100,
        });
      } else if (job.status === "cancelled") {
        say(onLog, "Cancelled.");
        throw new JobCancelledError();
      } else {
        const message = job.error ? `${job.status}: ${job.error}` : `Job ${job.status}`;
        say(onLog, message);
        throw new Error(message);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export function jobNeedsLibrarianMedia(status: string): boolean {
  return status === "awaiting_media" || status === "agent_downloading";
}

export async function handoffLocalFile(
  cfg: AgentConfig,
  opts: {
    filePath: string;
    jobId: string;
    videoId: string;
    clipLength: "short" | "medium";
  },
  onLog?: LogFn,
): Promise<string> {
  const { filePath, jobId, videoId } = opts;
  await assertReadableVideo(filePath);
  const title = path.basename(filePath);
  say(onLog, `Reading ${title}…`, { title, phase: "lookup", percent: null });
  const probed = await probeMediaFile(filePath);
  const job = await api.getJob(cfg, jobId);
  if (!jobNeedsLibrarianMedia(job.status)) {
    return jobId;
  }

  const watch = api.watchJobCancellation(cfg, jobId);
  sweepDownloadTemps();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-agent-"));
  try {
    say(onLog, "Preparing the video…", { phase: "download", percent: null });
    const prepared = await prepareSourceMp4(filePath, workDir);
    const video: api.VideoInfo = {
      id: videoId,
      title,
      duration: probed.duration,
      thumbnail: "",
      channelId: "local",
      channelName: "Uploaded from Librarian",
      channelUrl: "",
      channelAvatar: null,
    };
    const chunks = await uploadLocalAnalysisChunks(
      cfg,
      videoId,
      prepared.videoPath,
      probed.duration,
      workDir,
      onLog,
      watch.signal,
    );
    const clipPlan = await analyzeChunks(
      cfg,
      chunks,
      video,
      opts.clipLength,
      jobId,
      onLog,
      watch.signal,
    );
    const windows = await uploadLocalClipWindows(
      cfg,
      videoId,
      prepared.videoPath,
      probed.duration,
      clipPlan,
      workDir,
      onLog,
      watch.signal,
    );
    say(onLog, "Handing off to the renderer…", { phase: "upload", percent: 100 });
    await api.completeJob(cfg, jobId, {
      video,
      source: { bucket: windows.bucket, windows: windows.windows },
      clipPlan,
    }, watch.signal);
    return jobId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shouldFailRemoteJob(err)) {
      await api.failJob(cfg, jobId, message).catch(() => {});
    }
    throw err;
  } finally {
    watch.stop();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function handoffRemoteJob(
  cfg: AgentConfig,
  claim: api.ClaimedJob,
  onLog?: LogFn,
): Promise<string> {
  if (isRecutClaim(claim)) {
    await api.failJob(cfg, claim.jobId, RECUT_NOT_FULL_VOD).catch(() => {});
    throw new Error(RECUT_NOT_FULL_VOD);
  }
  if (isLocalFileIngest(claim)) {
    const message =
      "This volume was submitted as a file on this computer. Choose the file in Librarian to continue.";
    await api.failJob(cfg, claim.jobId, message).catch(() => {});
    throw new Error(message);
  }
  try {
    const watch = api.watchJobCancellation(cfg, claim.jobId);
    try {
      const { video, source, clipPlan } = await ingestSource(cfg, claim.youtubeUrl, onLog, {
        clipLength: claim.clipLength,
        jobId: claim.jobId,
        signal: watch.signal,
      });
      say(onLog, "Handing off to the renderer…", { phase: "upload", percent: 100 });
      await api.completeJob(cfg, claim.jobId, { video, source, clipPlan }, watch.signal);
      return claim.jobId;
    } finally {
      watch.stop();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shouldFailRemoteJob(err)) {
      await api.failJob(cfg, claim.jobId, message).catch(() => {});
    }
    throw err;
  }
}

export async function handoffRecut(
  cfg: AgentConfig,
  claim: api.ClaimedJob,
  onLog?: LogFn,
): Promise<string> {
  const startSec = Number(claim.startSec);
  const durationSec = Number(claim.durationSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec <= 0) {
    await api.failJob(cfg, claim.jobId, RECUT_WINDOW_MISSING).catch(() => {});
    throw new Error(RECUT_WINDOW_MISSING);
  }
  try {
    if (claim.title) say(onLog, claim.title, { title: claim.title });
    const watch = api.watchJobCancellation(cfg, claim.jobId);
    sweepDownloadTemps();
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-agent-"));
    try {
      say(onLog, "Downloading the edit window…", { phase: "download", percent: 0 });
      const videoPath = isLocalFileIngest(claim)
        ? await downloadLocalRecutSource(cfg, claim, workDir, onLog)
        : await downloadSection(
            claim.youtubeUrl,
            startSec,
            durationSec,
            workDir,
            (update) => {
              onLog?.({
                phase: "download",
                percent: update.percent,
                detail: update.detail,
              });
            },
            "recut",
            watch.signal,
          );
      say(onLog, "Uploading the clip window…", { phase: "upload", percent: 0 });
      const target = await api.requestUploadUrl(cfg, claim.jobId, "recut", "video/mp4");
      await putFile(
        target,
        videoPath,
        (percent, sent, total) => {
          onLog?.({
            phase: "upload",
            percent,
            detail: `Uploading ${percent}% · ${formatBytes(sent)} of ${formatBytes(total)}`,
          });
        },
        watch.signal,
      );
      say(onLog, "Handing the edit to the renderer…", { phase: "upload", percent: 100 });
      await api.completeJob(
        cfg,
        claim.jobId,
        {
          source: { bucket: target.bucket, objectKey: target.objectKey },
        },
        watch.signal,
      );
      return claim.jobId;
    } finally {
      watch.stop();
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shouldFailRemoteJob(err)) {
      await api.failJob(cfg, claim.jobId, message).catch(() => {});
    }
    throw err;
  }
}

export async function runClip(
  cfg: AgentConfig,
  filePath: string,
  clipLength: "short" | "medium",
  onLog?: LogFn,
): Promise<void> {
  say(onLog, "Submitting…", { phase: "lookup" });
  await assertReadableVideo(filePath);
  const submitted = await api.submitProcess(cfg, {
    localFile: { displayName: path.basename(filePath) },
    clipLength,
  });
  const videoId = submitted.videoId;
  if (!videoId) {
    throw new Error("The API did not return a video id for this file.");
  }
  if (!jobNeedsLibrarianMedia(submitted.status)) {
    await waitForWorker(cfg, submitted.jobId, onLog);
    return;
  }
  const jobId = await handoffLocalFile(
    cfg,
    { filePath, jobId: submitted.jobId, videoId, clipLength },
    onLog,
  );
  await waitForWorker(cfg, jobId, onLog);
}

async function downloadLocalRecutSource(
  cfg: AgentConfig,
  claim: api.ClaimedJob,
  workDir: string,
  onLog?: LogFn,
): Promise<string> {
  const videoId = claim.videoId;
  if (!videoId) {
    throw new Error("This clip edit is missing the original file id.");
  }
  say(onLog, "Fetching an uploaded clip window…", { phase: "download", percent: 0 });
  const target = await api.requestDownloadUrl(cfg, videoId, {
    startSec: Number(claim.startSec),
    durationSec: Number(claim.durationSec),
  });
  const sourcePath = path.join(workDir, "window.mp4");
  await downloadToFile(target.downloadUrl, sourcePath, target.headers);
  const offset =
    typeof target.windowStartSec === "number"
      ? Math.max(0, Number(claim.startSec) - target.windowStartSec)
      : Number(claim.startSec);
  const cutPath = path.join(workDir, "recut.mp4");
  await cutMediaSection(sourcePath, offset, Number(claim.durationSec), cutPath);
  return cutPath;
}

export async function fulfillRemoteJob(
  cfg: AgentConfig,
  claim: api.ClaimedJob,
  onLog?: LogFn,
): Promise<void> {
  const jobId = await handoffRemoteJob(cfg, claim, onLog);
  await waitForWorker(cfg, jobId, onLog);
}
