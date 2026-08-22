import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import * as api from "./api.js";
import { AgentApiError } from "./api.js";
import type { QueuePatch } from "./job-queue.js";
import { putFile } from "./upload.js";
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
): Promise<{
  video: api.VideoInfo;
  source: { bucket: string; objectKey: string; subtitleKey?: string };
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
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function waitForWorker(
  cfg: AgentConfig,
  jobId: string,
  onLog?: LogFn,
): Promise<void> {
  say(onLog, "Cloud is rendering clips…", { phase: "render", percent: null });
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

export async function handoffLocalClip(
  cfg: AgentConfig,
  url: string,
  clipLength: "short" | "medium",
  onLog?: LogFn,
): Promise<string> {
  const { video, source } = await ingestSource(cfg, url, onLog);
  say(onLog, "Submitting…", { phase: "upload", percent: 100 });
  const submitted = await api.submitJob(cfg, {
    url,
    clipLength,
    video,
    source,
  });
  say(
    onLog,
    submitted.deduped
      ? `Reusing in-flight job ${submitted.jobId}`
      : `Job ${submitted.jobId} queued`,
    { phase: "render", cloudJobId: submitted.jobId },
  );
  return submitted.jobId;
}

export async function handoffRemoteJob(
  cfg: AgentConfig,
  claim: api.ClaimedJob,
  onLog?: LogFn,
): Promise<string> {
  try {
    const { video, source } = await ingestSource(cfg, claim.youtubeUrl, onLog);
    say(onLog, "Handing off to cloud render…", { phase: "upload", percent: 100 });
    await api.completeJob(cfg, claim.jobId, { video, source });
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
    throw new Error("Recut job is missing a valid time window.");
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
      say(onLog, "Handing off to cloud recut…", { phase: "upload", percent: 100 });
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
