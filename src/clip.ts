import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import * as api from "./api.js";
import { AgentApiError, JobCancelledError, isJobCancelledError } from "./api.js";
import { parseJson3Captions } from "./captions.js";
import type { QueuePatch } from "./job-queue.js";
import { isRecutClaim, isLocalFileIngest, RECUT_NOT_FULL_VOD, RECUT_WINDOW_MISSING } from "./claim.js";
import {
  assertReadableVideo,
  cutMediaSection,
  downloadToFile,
  extractAudioMp3,
  prepareSourceMp4,
  probeMediaFile,
} from "./media-file.js";
import { paddedClipWindow } from "./clip-windows.js";
import { putFile } from "./upload.js";
import {
  downloadAudio,
  downloadCaptions,
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
    say(onLog, "Checking captions…", { phase: "download", percent: null });
    const captionsPath = await downloadCaptions(
      url,
      workDir,
      (update) => {
        onLog?.({
          phase: "download",
          percent: update.percent,
          detail: update.detail,
        });
      },
      opts.signal,
    );
    const segments = captionsPath
      ? await segmentsFromCaptions(captionsPath, onLog)
      : null;
    const transcript =
      segments && segments.length > 0
        ? { segments }
        : await transcribeFromYoutubeAudio(
            cfg,
            url,
            video.id,
            opts.jobId,
            workDir,
            onLog,
            opts.signal,
          );
    const clipPlan = await analyzeSegments(
      cfg,
      transcript.segments,
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

async function segmentsFromCaptions(
  captionsPath: string,
  onLog?: LogFn,
): Promise<api.TranscriptSegment[] | null> {
  try {
    const raw = await fs.readFile(captionsPath, "utf8");
    const segments = parseJson3Captions(raw);
    if (segments.length === 0) {
      say(onLog, "Captions were empty. Librarian will transcribe the audio instead.");
      return null;
    }
    return segments;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    say(onLog, `Captions could not be parsed (${message}). Librarian will transcribe the audio instead.`);
    return null;
  }
}

async function transcribeFromYoutubeAudio(
  cfg: AgentConfig,
  url: string,
  videoId: string,
  jobId: string,
  workDir: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<{ segments: api.TranscriptSegment[] }> {
  say(onLog, "No captions found. Downloading audio to transcribe…", {
    phase: "download",
    percent: 0,
  });
  const audioPath = await downloadAudio(
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
  return uploadAudioAndTranscribe(cfg, videoId, jobId, audioPath, onLog, signal);
}

async function uploadAudioAndTranscribe(
  cfg: AgentConfig,
  videoId: string,
  jobId: string,
  audioPath: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<{ segments: api.TranscriptSegment[] }> {
  say(onLog, "Uploading audio for transcription…", { phase: "upload", percent: 0 });
  const target = await api.requestUploadUrl(cfg, videoId, "audio", "audio/mpeg");
  await putFile(
    target,
    audioPath,
    (percent, sent, total) => {
      onLog?.({
        phase: "upload",
        percent,
        detail: `Uploading audio ${percent}% · ${formatBytes(sent)} of ${formatBytes(total)}`,
      });
    },
    signal,
  );
  say(onLog, "Transcribing speech…", { phase: "analyze", percent: null });
  const result = await api.transcribeJob(
    cfg,
    jobId,
    {
      bucket: target.bucket,
      objectKey: target.objectKey,
    },
    signal,
  );
  if (result.segments.length === 0) {
    throw new Error("Transcription produced no speech. Try another file.");
  }
  return { segments: result.segments };
}

async function analyzeSegments(
  cfg: AgentConfig,
  segments: api.TranscriptSegment[],
  video: api.VideoInfo,
  clipLength: "short" | "medium",
  jobId: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<api.ClipPlan> {
  say(onLog, "Scanning for viral moments…", { phase: "analyze", percent: null });
  const plan = await api.analyzeJob(
    cfg,
    jobId,
    {
      segments,
      clipLength,
      videoTitle: video.title,
    },
    signal,
  );
  if (plan.clips.length === 0) {
    throw new Error("No clip-worthy moments were found in this video.");
  }
  say(
    onLog,
    plan.clips.length === 1
      ? "Found 1 viral moment"
      : `Found ${plan.clips.length} viral moments`,
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
    say(onLog, "Extracting audio…", { phase: "download", percent: null });
    const audioPath = path.join(workDir, "audio.mp3");
    await extractAudioMp3(prepared.videoPath, audioPath);
    const { segments } = await uploadAudioAndTranscribe(
      cfg,
      videoId,
      jobId,
      audioPath,
      onLog,
      watch.signal,
    );
    const clipPlan = await analyzeSegments(
      cfg,
      segments,
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
