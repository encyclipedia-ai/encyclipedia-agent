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
  fileHasVideoStream,
  prepareSourceMp4,
  probeMediaFile,
} from "./media-file.js";
import { CLIP_CHECK_POOL, rememberCategory, runOrderedPool } from "./clip-pool.js";
import { planSubjectStoryScenes, uploadWindowForClip } from "./clip-windows.js";
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

function combinedAbort(
  signals: Array<AbortSignal | undefined>,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    stop: () => {
      for (const signal of signals) signal?.removeEventListener("abort", onAbort);
    },
  };
}

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
): Promise<void> {
  say(onLog, "Looking up the video…", { phase: "lookup", percent: null });
  const video = await dumpVideoInfo(url, opts?.signal);
  say(onLog, video.title, { title: video.title, phase: "lookup" });
  if (!opts?.jobId) {
    throw new Error("Librarian needs a job id before it can scan for clip windows.");
  }

  sweepDownloadTemps();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-agent-"));
  try {
    const segments = await transcriptFromYoutube(
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
      segments,
      video,
      opts.clipLength,
      opts.jobId,
      onLog,
      opts.signal,
    );
    await releaseYoutubeClips(
      cfg,
      url,
      video,
      clipPlan,
      opts.clipLength,
      opts.jobId,
      workDir,
      onLog,
      opts.signal,
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcriptFromYoutube(
  cfg: AgentConfig,
  url: string,
  videoId: string,
  jobId: string,
  workDir: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<api.TranscriptSegment[]> {
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
    signal,
  );
  const segments = captionsPath ? await segmentsFromCaptions(captionsPath, onLog) : null;
  if (segments && segments.length > 0) return segments;
  return transcribeFromYoutubeAudio(cfg, url, videoId, jobId, workDir, onLog, signal);
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
): Promise<api.TranscriptSegment[]> {
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
  const transcribed = await uploadAudioAndTranscribe(cfg, videoId, jobId, audioPath, onLog, signal);
  return transcribed.segments;
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
  say(onLog, "Scanning the transcript for viral moments…", { phase: "analyze", percent: null });
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
    plan.clips.length === 1 ? "Found 1 viral moment" : `Found ${plan.clips.length} viral moments`,
    { phase: "analyze" },
  );
  return plan;
}

async function releaseYoutubeClips(
  cfg: AgentConfig,
  url: string,
  video: api.VideoInfo,
  clipPlan: api.ClipPlan,
  clipLength: "short" | "medium",
  jobId: string,
  workDir: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<void> {
  let localSource: string | undefined;
  let localDownload: Promise<string> | undefined;
  const ensureLocalSource = (): Promise<string> => {
    if (localSource) return Promise.resolve(localSource);
    if (!localDownload) {
      localDownload = downloadSource(
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
      )
        .then((downloaded) => {
          localSource = downloaded.videoPath;
          return localSource;
        })
        .catch((err) => {
          localDownload = undefined;
          throw err;
        });
    }
    return localDownload;
  };
  const sectionFile = async (
    startSec: number,
    durationSec: number,
    name: string,
  ): Promise<string> => {
    try {
      if (localSource) {
        const videoPath = path.join(workDir, `${name}.mp4`);
        await cutMediaSection(localSource, startSec, durationSec, videoPath);
        return videoPath;
      }
      const videoPath = await downloadSection(
        url,
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
        name,
        signal,
      );
      if (!(await fileHasVideoStream(videoPath))) {
        throw new Error("The downloaded section has no picture.");
      }
      return videoPath;
    } catch (err) {
      if (isJobCancelledError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      say(
        onLog,
        `Section download failed (${message}). Downloading locally to cut windows — the full file stays on this computer.`,
      );
      const source = await ensureLocalSource();
      const videoPath = path.join(workDir, `${name}.mp4`);
      await cutMediaSection(source, startSec, durationSec, videoPath);
      return videoPath;
    }
  };
  await releaseMoments({
    cfg,
    jobId,
    video,
    clipPlan,
    clipLength,
    onLog,
    signal,
    prepareWindow: async (clip, index) => {
      const padded = uploadWindowForClip(clip, clipPlan.story, video.duration);
      const total = clipPlan.clips.length;
      say(onLog, `Downloading clip window ${index + 1}/${total}…`, {
        phase: "download",
        percent: 0,
      });
      const videoPath = await sectionFile(padded.startSec, padded.durationSec, `window_${index}`);
      return uploadWindow(cfg, video.id, videoPath, padded, index, index, total, "clip window", onLog, signal);
    },
    prepareStoryWindows: (clips) =>
      uploadStoryScenes({
        cfg,
        videoId: video.id,
        scenes: planSubjectStoryScenes(clips, video.duration),
        clipCount: clipPlan.clips.length,
        onLog,
        signal,
        materialize: sectionFile,
      }),
  });
}

async function releaseLocalClips(
  cfg: AgentConfig,
  video: api.VideoInfo,
  sourcePath: string,
  clipPlan: api.ClipPlan,
  clipLength: "short" | "medium",
  jobId: string,
  workDir: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<void> {
  await releaseMoments({
    cfg,
    jobId,
    video,
    clipPlan,
    clipLength,
    onLog,
    signal,
    prepareWindow: async (clip, index) => {
      const padded = uploadWindowForClip(clip, clipPlan.story, video.duration);
      const total = clipPlan.clips.length;
      const cutPath = path.join(workDir, `window_${index}.mp4`);
      say(onLog, `Cutting clip window ${index + 1}/${total}…`, {
        phase: "download",
        percent: null,
      });
      await cutMediaSection(sourcePath, padded.startSec, padded.durationSec, cutPath);
      return uploadWindow(cfg, video.id, cutPath, padded, index, index, total, "clip window", onLog, signal);
    },
    prepareStoryWindows: (clips) =>
      uploadStoryScenes({
        cfg,
        videoId: video.id,
        scenes: planSubjectStoryScenes(clips, video.duration),
        clipCount: clipPlan.clips.length,
        onLog,
        signal,
        materialize: async (startSec, durationSec, name) => {
          const cutPath = path.join(workDir, `${name}.mp4`);
          await cutMediaSection(sourcePath, startSec, durationSec, cutPath);
          return cutPath;
        },
      }),
  });
}

async function uploadStoryScenes(input: {
  cfg: AgentConfig;
  videoId: string;
  scenes: Array<{ startSec: number; endSec: number }>;
  clipCount: number;
  onLog?: LogFn;
  signal?: AbortSignal;
  materialize: (startSec: number, durationSec: number, name: string) => Promise<string>;
}): Promise<api.ReviewWindow[]> {
  const uploaded: api.ReviewWindow[] = [];
  for (const [index, scene] of input.scenes.entries()) {
    const durationSec = scene.endSec - scene.startSec;
    say(input.onLog, `Downloading story window ${index + 1}/${input.scenes.length}…`, {
      phase: "download",
      percent: 0,
    });
    const videoPath = await input.materialize(scene.startSec, durationSec, `story_${index}`);
    uploaded.push(
      await uploadWindow(
        input.cfg,
        input.videoId,
        videoPath,
        { startSec: scene.startSec, durationSec },
        input.clipCount + index,
        index,
        input.scenes.length,
        "story window",
        input.onLog,
        input.signal,
      ),
    );
  }
  return uploaded;
}

async function uploadWindow(
  cfg: AgentConfig,
  videoId: string,
  videoPath: string,
  padded: { startSec: number; durationSec: number },
  objectIndex: number,
  displayIndex: number,
  total: number,
  label: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<api.ReviewWindow> {
  say(onLog, `Uploading ${label} ${displayIndex + 1}/${total}…`, { phase: "upload", percent: 0 });
  const target = await api.requestUploadUrl(cfg, videoId, "window", "video/mp4", objectIndex);
  await putFile(
    target,
    videoPath,
    (percent, sent, size) => {
      onLog?.({
        phase: "upload",
        percent,
        detail: `Uploading ${label} ${displayIndex + 1} · ${percent}% · ${formatBytes(sent)} of ${formatBytes(size)}`,
      });
    },
    signal,
  );
  return {
    bucket: target.bucket,
    objectKey: target.objectKey,
    startSec: padded.startSec,
    durationSec: padded.durationSec,
  };
}

/**
 * Download and check a few moments at once, then hand each one to the
 * worker in order. The worker still crops one at a time.
 */
async function releaseMoments(input: {
  cfg: AgentConfig;
  jobId: string;
  video: api.VideoInfo;
  clipPlan: api.ClipPlan;
  clipLength: "short" | "medium";
  onLog?: LogFn;
  signal?: AbortSignal;
  prepareWindow: (clip: api.ClipPlanItem, index: number) => Promise<api.ReviewWindow>;
  prepareStoryWindows?: (clips: api.ClipPlanItem[]) => Promise<api.ReviewWindow[]>;
}): Promise<void> {
  const { cfg, jobId, video, clipPlan, clipLength, onLog, signal } = input;
  let costUsd = clipPlan.costUsd;
  let usageEvents = clipPlan.usageEvents ?? [];
  const total = clipPlan.clips.length;
  const categories: string[] = [];
  for (const clip of clipPlan.clips) rememberCategory(categories, clip.category);
  const roster = clipPlan.clips.map((item) => ({
    startSec: item.startSec,
    endSec: item.endSec,
    durationSec: item.durationSec,
    ...(item.category ? { category: item.category } : {}),
    title: item.title,
  }));
  const refinedClips: api.ClipPlanItem[] = clipPlan.clips.map((clip) => ({ ...clip }));
  try {
    await runOrderedPool({
      count: total,
      limit: CLIP_CHECK_POOL,
      start: async (index) => {
        const original = clipPlan.clips[index]!;
        const window = await input.prepareWindow(original, index);
        let clip = original;
        let addedCost = 0;
        let addedEvents: api.UsageEvent[] = [];
        say(onLog, `Checking clip ${index + 1}/${total} against the video…`, {
          phase: "analyze",
          percent: null,
        });
        try {
          const refined = await api.refineJob(
            cfg,
            jobId,
            {
              windows: [window],
              clips: [original],
              clipLength,
              videoTitle: video.title,
              knownCategories: [...categories],
              scope: "moment",
            },
            signal,
          );
          clip = refined.clips[0] ?? original;
          rememberCategory(categories, clip.category);
          addedCost = refined.costUsd;
          addedEvents = refined.usageEvents ?? [];
        } catch (err) {
          if (isJobCancelledError(err)) throw err;
          const message = err instanceof Error ? err.message : String(err);
          say(onLog, `Video check failed (${message}). Keeping the transcript cut.`);
        }
        return { window, clip, addedCost, addedEvents };
      },
      finish: async (index, checked) => {
        refinedClips[index] = checked.clip;
        costUsd += checked.addedCost;
        usageEvents = [...usageEvents, ...checked.addedEvents];
        say(
          onLog,
          `Rendering clip ${index + 1}/${total}. Later moments download while it crops.`,
          { phase: "render", percent: null },
        );
        const renderBody = {
          video,
          window: checked.window,
          clip: checked.clip,
          costUsd,
          usageEvents,
          expectedCount: total,
          roster,
        };
        try {
          await api.renderClip(cfg, jobId, renderBody, signal);
        } catch (err) {
          if (isJobCancelledError(err)) throw err;
          await api.renderClip(cfg, jobId, renderBody, signal);
        }
      },
    });
    const storyWindows = input.prepareStoryWindows
      ? await input.prepareStoryWindows(refinedClips)
      : [];
    await api.finishRender(cfg, jobId, signal, storyWindows);
    say(onLog, "Every moment is with the renderer.", { phase: "render", percent: 100 });
  } catch (err) {
    if (!isJobCancelledError(err)) {
      await api.finishRender(cfg, jobId, signal).catch(() => {});
    }
    throw err;
  }
}

export async function waitForWorker(
  cfg: AgentConfig,
  jobId: string,
  onLog?: LogFn,
  signal?: AbortSignal,
): Promise<void> {
  say(onLog, "Renderer is preparing clips…", { phase: "render", percent: null });
  while (true) {
    if (signal?.aborted) throw new JobCancelledError();
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
    await new Promise<void>((resolve, reject) => {
      if (!signal) {
        setTimeout(resolve, 3000);
        return;
      }
      if (signal.aborted) {
        reject(new JobCancelledError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new JobCancelledError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 3000);
      signal.addEventListener("abort", onAbort, { once: true });
    });
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
  signal?: AbortSignal,
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
  const linked = combinedAbort([watch.signal, signal]);
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
      linked.signal,
    );
    const clipPlan = await analyzeSegments(
      cfg,
      segments,
      video,
      opts.clipLength,
      jobId,
      onLog,
      linked.signal,
    );
    await releaseLocalClips(
      cfg,
      video,
      prepared.videoPath,
      clipPlan,
      opts.clipLength,
      jobId,
      workDir,
      onLog,
      linked.signal,
    );
    return jobId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shouldFailRemoteJob(err)) {
      await api.failJob(cfg, jobId, message).catch(() => {});
    }
    throw err;
  } finally {
    linked.stop();
    watch.stop();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function handoffRemoteJob(
  cfg: AgentConfig,
  claim: api.ClaimedJob,
  onLog?: LogFn,
  signal?: AbortSignal,
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
    const linked = combinedAbort([watch.signal, signal]);
    try {
      await ingestSource(cfg, claim.youtubeUrl, onLog, {
        clipLength: claim.clipLength,
        jobId: claim.jobId,
        signal: linked.signal,
      });
      return claim.jobId;
    } finally {
      linked.stop();
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
  signal?: AbortSignal,
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
    const linked = combinedAbort([watch.signal, signal]);
    sweepDownloadTemps();
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-agent-"));
    try {
      say(onLog, "Downloading the edit window…", { phase: "download", percent: 0 });
      let videoPath: string;
      if (isLocalFileIngest(claim)) {
        videoPath = await downloadLocalRecutSource(cfg, claim, workDir, onLog);
      } else {
        videoPath = await downloadSection(
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
          linked.signal,
        );
        if (!(await fileHasVideoStream(videoPath))) {
          throw new Error("The downloaded section has no picture.");
        }
      }
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
        linked.signal,
      );
      say(onLog, "Handing the edit to the renderer…", { phase: "upload", percent: 100 });
      await api.completeJob(
        cfg,
        claim.jobId,
        {
          source: { bucket: target.bucket, objectKey: target.objectKey },
        },
        linked.signal,
      );
      return claim.jobId;
    } finally {
      linked.stop();
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
