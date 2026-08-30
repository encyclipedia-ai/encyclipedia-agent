import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import * as api from "./api.js";
import { AgentApiError } from "./api.js";
import { parseJson3Captions } from "./captions.js";
import type { QueuePatch } from "./job-queue.js";
import { putFile } from "./upload.js";
import { isRecutClaim, RECUT_NOT_FULL_VOD, RECUT_WINDOW_MISSING } from "./claim.js";
import { downloadSection, downloadSource, dumpVideoInfo, sweepDownloadTemps } from "./ytdlp.js";

const TERMINAL = new Set(["done", "error", "cancelled"]);

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
  opts?: { clipLength: "short" | "medium"; jobId?: string },
): Promise<{
  video: api.VideoInfo;
  source: { bucket: string; objectKey: string; subtitleKey?: string };
  clipPlan?: api.ClipPlan;
}> {
  say(onLog, "Looking up the video…", { phase: "lookup", percent: null });
  const video = await dumpVideoInfo(url);
  say(onLog, video.title, { title: video.title, phase: "lookup" });

  sweepDownloadTemps();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-agent-"));
  try {
    say(onLog, "Downloading on this computer…", { phase: "download", percent: 0 });
    const { videoPath, captionsPath } = await downloadSource(url, workDir, (update) => {
      onLog?.({
        phase: "download",
        percent: update.percent,
        detail: update.detail,
      });
    });
    const clipPlan = opts
      ? await analyzeAfterDownload(cfg, captionsPath, video, opts.clipLength, opts.jobId, onLog)
      : undefined;
    say(onLog, "Uploading to encyclipedia…", { phase: "upload", percent: 0 });
    const videoTarget = await api.requestUploadUrl(cfg, video.id, "video", "video/mp4");
    await putFile(videoTarget, videoPath, (percent, sent, total) => {
      onLog?.({
        phase: "upload",
        percent,
        detail: `Uploading ${percent}% · ${formatBytes(sent)} of ${formatBytes(total)}`,
      });
    });

    let subtitleKey: string | undefined;
    if (captionsPath) {
      say(onLog, "Uploading captions…", { phase: "upload", percent: 0 });
      try {
        const capTarget = await api.requestUploadUrl(
          cfg,
          video.id,
          "captions",
          "application/json",
        );
        await putFile(capTarget, captionsPath, (percent) => {
          onLog?.({
            phase: "upload",
            percent,
            detail: `Uploading captions ${percent}%`,
          });
        });
        subtitleKey = capTarget.objectKey;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        say(onLog, `Captions skipped (${message}). Continuing with the video.`);
      }
    }

    return {
      video,
      source: {
        bucket: videoTarget.bucket,
        objectKey: videoTarget.objectKey,
        subtitleKey,
      },
      clipPlan,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function analyzeAfterDownload(
  cfg: AgentConfig,
  captionsPath: string | null,
  video: api.VideoInfo,
  clipLength: "short" | "medium",
  jobId: string | undefined,
  onLog?: LogFn,
): Promise<api.ClipPlan | undefined> {
  if (!captionsPath) {
    say(onLog, "No captions found. Librarian will upload the video for renderer analysis.");
    return undefined;
  }
  let segments;
  try {
    const raw = await fs.readFile(captionsPath, "utf8");
    segments = parseJson3Captions(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    say(
      onLog,
      `Librarian could not parse the captions (${message}). The renderer will analyze after upload.`,
    );
    return undefined;
  }
  if (segments.length === 0) {
    say(onLog, "Captions were empty. The renderer will analyze after upload.");
    return undefined;
  }

  say(onLog, "Scanning for viral moments…", { phase: "analyze", percent: null });
  const plan = jobId
    ? await api.analyzeJob(cfg, jobId, {
        segments,
        clipLength,
        videoTitle: video.title,
      })
    : await api.analyze(cfg, {
        segments,
        clipLength,
        video,
        videoTitle: video.title,
      });
  say(
    onLog,
    plan.clips.length === 1
      ? "Found 1 viral moment"
      : `Found ${plan.clips.length} viral moments`,
    { phase: "analyze" },
  );
  return plan;
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

export async function handoffLocalClip(
  cfg: AgentConfig,
  url: string,
  clipLength: "short" | "medium",
  onLog?: LogFn,
): Promise<string> {
  say(onLog, "Submitting…", { phase: "lookup" });
  const submitted = await api.submitProcess(cfg, { url, clipLength });
  say(
    onLog,
    submitted.deduped
      ? `Reusing in-flight job ${submitted.jobId}`
      : `Job ${submitted.jobId} is on the web. Downloading next…`,
    { cloudJobId: submitted.jobId },
  );
  if (!jobNeedsLibrarianMedia(submitted.status)) {
    return submitted.jobId;
  }
  return handoffRemoteJob(
    cfg,
    {
      jobId: submitted.jobId,
      youtubeUrl: url,
      clipLength,
      videoId: null,
    },
    onLog,
  );
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
  try {
    const { video, source, clipPlan } = await ingestSource(cfg, claim.youtubeUrl, onLog, {
      clipLength: claim.clipLength,
      jobId: claim.jobId,
    });
    say(onLog, "Handing off to the renderer…", { phase: "upload", percent: 100 });
    await api.completeJob(cfg, claim.jobId, { video, source, clipPlan });
    return claim.jobId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof AgentApiError && err.status === 409)) {
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
    sweepDownloadTemps();
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-agent-"));
    try {
      say(onLog, "Downloading the clip window…", { phase: "download", percent: 0 });
      const videoPath = await downloadSection(
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
      );
      say(onLog, "Uploading the clip window…", { phase: "upload", percent: 0 });
      const target = await api.requestUploadUrl(cfg, claim.jobId, "recut", "video/mp4");
      await putFile(target, videoPath, (percent, sent, total) => {
        onLog?.({
          phase: "upload",
          percent,
          detail: `Uploading ${percent}% · ${formatBytes(sent)} of ${formatBytes(total)}`,
        });
      });
      say(onLog, "Handing the edit to the renderer…", { phase: "upload", percent: 100 });
      await api.completeJob(cfg, claim.jobId, {
        source: { bucket: target.bucket, objectKey: target.objectKey },
      });
      return claim.jobId;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof AgentApiError && err.status === 409)) {
      await api.failJob(cfg, claim.jobId, message).catch(() => {});
    }
    throw err;
  }
}

export async function runClip(
  cfg: AgentConfig,
  url: string,
  clipLength: "short" | "medium",
  onLog?: LogFn,
): Promise<void> {
  const jobId = await handoffLocalClip(cfg, url, clipLength, onLog);
  await waitForWorker(cfg, jobId, onLog);
}

export async function fulfillRemoteJob(
  cfg: AgentConfig,
  claim: api.ClaimedJob,
  onLog?: LogFn,
): Promise<void> {
  const jobId = await handoffRemoteJob(cfg, claim, onLog);
  await waitForWorker(cfg, jobId, onLog);
}
