import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearSession, loadConfig, saveConfig, type AgentConfig } from "./config.js";
import { ensureFreshToken, signInWithIdp, signInWithPassword } from "./auth.js";
import * as api from "./api.js";
import { JobCancelledError, isJobCancelledError } from "./api.js";
import { isRecutClaim, isLocalFileIngest } from "./claim.js";
import {
  handoffLocalFile,
  handoffRecut,
  handoffRemoteJob,
  jobNeedsLibrarianMedia,
  runClip,
  waitForWorker,
  type LogFn,
} from "./clip.js";
import {
  activeMachineWork,
  clearUnfinishedQueue,
  enqueueLocal,
  enqueueRemote,
  getQueue,
  hasMachineWork,
  onQueueChange,
  setQueueProcessor,
  updateQueueItem,
  type QueueItem,
} from "./job-queue.js";
import { ensureTools, refreshYtdlpIfNeeded } from "./tools.js";
import { assertReadableVideo } from "./media-file.js";
import { sweepDownloadTemps } from "./ytdlp.js";
import { captureLiveFile } from "./live-capture.js";
import { LIVE_POLL_MS, LiveRoll, type LiveCapturePlan, type RollProfile } from "./live-roll.js";
import type { LiveCapture } from "./job-queue.js";

export type HelperStatus = "signed_out" | "starting" | "running" | "working" | "error";

export interface HelperSnapshot {
  status: HelperStatus;
  email: string | null;
  message: string;
  busy: boolean;
  queue: QueueItem[];
  live: RollProfile[];
}

export type HelperListener = (snap: HelperSnapshot) => void;

function snapshot(
  status: HelperStatus,
  message: string,
  cfg?: AgentConfig,
  busy = false,
  live: RollProfile[] = [],
): HelperSnapshot {
  const queue = getQueue();
  const active = activeMachineWork();
  const waiting = queue.filter((item) => item.phase === "queued").length;
  const rendering = queue.filter((item) => item.phase === "render").length;
  let nextStatus = status;
  let nextMessage = message;
  let nextBusy = busy;
  if (status !== "signed_out") {
    if (active) {
      nextStatus = "working";
      nextBusy = true;
      nextMessage = active.detail || "At work in the stacks…";
    } else if (waiting) {
      nextStatus = "running";
      nextBusy = false;
      nextMessage = waiting === 1 ? "1 volume in line." : `${waiting} volumes in line.`;
    } else if (rendering && (status === "running" || status === "working")) {
      nextStatus = "running";
      nextBusy = false;
      nextMessage =
        rendering === 1
          ? "The bindery is finishing a volume."
          : `${rendering} volumes in the bindery.`;
    }
  }
  return {
    status: nextStatus,
    email: cfg?.email ?? loadConfig().email ?? null,
    message: nextMessage,
    busy: nextBusy,
    queue,
    live: nextStatus === "signed_out" ? [] : live,
  };
}

export async function restoreSession(): Promise<AgentConfig | null> {
  const cfg = loadConfig();
  saveConfig(cfg);
  if (!cfg.idToken) return null;
  try {
    const fresh = await ensureFreshToken(cfg);
    await api.register(fresh, `${os.platform()}-${os.arch()}`, os.hostname());
    return fresh;
  } catch {
    return null;
  }
}

async function finishSignIn(cfg: AgentConfig): Promise<AgentConfig> {
  const fresh = await ensureFreshToken(cfg);
  await api.register(fresh, `${os.platform()}-${os.arch()}`, os.hostname());
  return fresh;
}

export async function signIn(email: string, password: string): Promise<AgentConfig> {
  let cfg = loadConfig();
  saveConfig(cfg);
  cfg = await signInWithPassword(cfg, email.trim(), password);
  return finishSignIn(cfg);
}

export async function completeGoogleSignIn(
  requestUri: string,
  sessionId: string,
): Promise<AgentConfig> {
  let cfg = loadConfig();
  saveConfig(cfg);
  cfg = await signInWithIdp(cfg, requestUri, sessionId);
  return finishSignIn(cfg);
}

export function signOut(): void {
  clearUnfinishedQueue();
  clearSession(loadConfig());
}

let workLock: Promise<void> = Promise.resolve();

async function withWork<T>(fn: () => Promise<T>): Promise<T> {
  const previous = workLock;
  let release: () => void = () => {};
  workLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function queueLocalFile(
  filePath: string,
  clipLength: "short" | "medium",
): Promise<QueueItem> {
  const resolved = path.resolve(filePath.trim());
  await assertReadableVideo(resolved);
  const cfg = await ensureFreshToken(loadConfig());
  await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  const displayName = path.basename(resolved);
  const submitted = await api.submitProcess(cfg, {
    localFile: { displayName },
    clipLength,
  });
  const created = await api.getJob(cfg, submitted.jobId);
  if (created.kind === "recut") {
    throw new Error(
      "An edit is already running for this video. Wait for it to finish before cutting the full stream again.",
    );
  }
  const videoId = submitted.videoId ?? created.videoId ?? undefined;
  if (!videoId) {
    throw new Error("The API did not return a video id for this file.");
  }
  return enqueueLocal(`local://${encodeURIComponent(displayName)}`, clipLength, {
    remoteJobId: submitted.jobId,
    localPath: resolved,
    title: displayName,
    videoId,
    ingestKind: "local_file",
  });
}

export async function clipFromFile(
  filePath: string,
  clipLength: "short" | "medium",
  onLog: LogFn,
): Promise<void> {
  await ensureTools();
  const cfg = await ensureFreshToken(loadConfig());
  await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  await withWork(() => runClip(cfg, path.resolve(filePath.trim()), clipLength, onLog));
}

export function startHelperLoop(onUpdate: HelperListener): () => void {
  sweepDownloadTemps();
  let stopped = false;
  let cfg: AgentConfig | null = null;
  let lastStatus: HelperStatus = "starting";
  let lastMessage = "Opening the stacks…";
  let liveProfiles: RollProfile[] = [];
  const roll = new LiveRoll();

  const emit = (
    status: HelperStatus,
    message: string,
    busy = false,
  ): void => {
    lastStatus = status;
    lastMessage = message;
    if (!stopped) onUpdate(snapshot(status, message, cfg ?? undefined, busy, liveProfiles));
  };

  const unsubscribeQueue = onQueueChange(() => {
    if (!stopped) emit(lastStatus, lastMessage, hasMachineWork());
  });

  setQueueProcessor(async (item, report) => {
    await ensureTools();
    const authed = await ensureFreshToken(loadConfig());
    cfg = authed;
    const onLog: LogFn = (update) => {
      if (typeof update === "string") report({ detail: update });
      else report(update);
    };
    let cloudJobId: string;
    if (item.remoteJobId) {
      const preview = await api.getJob(authed, item.remoteJobId);
      if (preview.status === "cancelled") {
        throw new JobCancelledError();
      }
    }
    if (item.remoteJobId && item.liveCapture) {
      const videoId = item.videoId;
      if (!videoId) throw new Error("The API did not return a video id for this live chunk.");
      const capture = item.liveCapture;
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-live-"));
      try {
        const filePath = await captureLiveFile(capturePlan(capture), workDir, (update) => {
          report({
            phase: "download",
            percent: update.percent,
            detail: update.detail,
          });
        });
        const job = await api.getJob(authed, item.remoteJobId);
        cloudJobId = jobNeedsLibrarianMedia(job.status)
          ? await handoffLocalFile(
              authed,
              {
                filePath,
                jobId: item.remoteJobId,
                videoId,
                clipLength: item.clipLength,
                source: {
                  title: capture.title,
                  channelId: capture.channelId,
                  channelName: capture.channelName,
                  channelUrl: capture.channelUrl,
                },
              },
              onLog,
            )
          : item.remoteJobId;
        if (capture.rollOwned) roll.complete(capturePlan(capture));
      } catch (err) {
        if (capture.rollOwned) roll.abandon(capturePlan(capture));
        const message = err instanceof Error ? err.message : String(err);
        if (!isJobCancelledError(err)) {
          await api.failJob(authed, item.remoteJobId, message).catch(() => {});
        }
        throw err;
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    } else if (item.localPath && item.remoteJobId) {
      const videoId = item.videoId;
      if (!videoId) throw new Error("The API did not return a video id for this file.");
      const job = await api.getJob(authed, item.remoteJobId);
      cloudJobId = jobNeedsLibrarianMedia(job.status)
        ? await handoffLocalFile(
            authed,
            {
              filePath: item.localPath,
              jobId: item.remoteJobId,
              videoId,
              clipLength: item.clipLength,
            },
            onLog,
          )
        : item.remoteJobId;
    } else if (item.remoteJobId) {
      const job = await api.getJob(authed, item.remoteJobId);
      const claim = {
        jobId: item.remoteJobId,
        youtubeUrl: item.url,
        clipLength: item.clipLength,
        videoId: item.videoId ?? job.videoId ?? null,
        kind: job.kind ?? item.kind,
        ingestKind: item.ingestKind ?? job.ingestKind,
        startSec: item.startSec ?? job.startSec,
        durationSec: item.durationSec ?? job.durationSec,
        title: item.title ?? job.videoTitle ?? undefined,
      };
      if (isRecutClaim(claim)) {
        cloudJobId = jobNeedsLibrarianMedia(job.status)
          ? await handoffRecut(authed, claim, onLog)
          : item.remoteJobId;
      } else if (!jobNeedsLibrarianMedia(job.status)) {
        cloudJobId = item.remoteJobId;
      } else if (isLocalFileIngest(claim) && !item.localPath) {
        throw new Error(
          "This volume was submitted as a file on this computer. Choose the file in Librarian to continue.",
        );
      } else {
        cloudJobId = await handoffRemoteJob(authed, claim, onLog);
      }
    } else {
      throw new Error("Choose a video file first.");
    }
    void waitForWorker(authed, cloudJobId, onLog)
      .then(async () => {
        const finished = await api.getJob(authed, cloudJobId).catch(() => null);
        let editVersion: number | undefined;
        if (finished?.kind === "recut" && finished.streamSlug && finished.recutFilename) {
          const stream = await api.getStream(authed, finished.streamSlug).catch(() => null);
          editVersion = stream?.clips.find((clip) => clip.filename === finished.recutFilename)
            ?.editVersion;
        }
        updateQueueItem(item.id, {
          phase: "done",
          percent: 100,
          detail:
            editVersion && editVersion > 1
              ? `Shelved. Clip edit v${editVersion} is in your stacks.`
              : "Shelved. Clips are in your stacks.",
          editVersion,
        });
      })
      .catch((err) => {
        if (isJobCancelledError(err) || /cancelled/i.test(err instanceof Error ? err.message : String(err))) {
          updateQueueItem(item.id, {
            phase: "cancelled",
            percent: null,
            detail: "Cancelled.",
          });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        updateQueueItem(item.id, {
          phase: "error",
          percent: null,
          detail: message,
          error: message,
        });
      });
    return { cloudJobId };
  });

  void (async () => {
    emit("starting", "Opening the stacks…");
    try {
      await ensureTools();
    } catch (err) {
      emit("error", err instanceof Error ? err.message : String(err));
      return;
    }

    const session = await restoreSession();
    if (!session) {
      emit("signed_out", "Sign in to connect Librarian to your account.");
      return;
    }
    let authed = session;
    cfg = authed;

    emit("running", "Librarian is online and connected to your account.");
    let lastHeartbeat = 0;
    let lastLivePoll = 0;
    while (!stopped) {
      try {
        authed = await ensureFreshToken(authed);
        cfg = authed;
      } catch (err) {
        emit("signed_out", err instanceof Error ? err.message : "Please sign in again.");
        return;
      }
      const now = Date.now();
      if (now - lastHeartbeat >= 15_000) {
        await api.heartbeat(authed).catch((err: Error) => {
          emit("error", `Could not reach encyclipedia (${err.message}). Retrying…`);
        });
        lastHeartbeat = now;
        if (!stopped && !activeMachineWork()) {
          emit("running", "Librarian is online. Waiting for the next job…");
        }
      }
      if (now - lastLivePoll >= LIVE_POLL_MS) {
        lastLivePoll = now;
        try {
          const status = await api.liveStatus(authed);
          liveProfiles = status.profiles;
          roll.observe(status.profiles);
          if (!stopped && !activeMachineWork()) emit(lastStatus, lastMessage);
        } catch (err) {
          console.warn(
            `Could not check live status (${err instanceof Error ? err.message : err}).`,
          );
        }
      }
      if (!hasMachineWork()) {
        let claim: api.ClaimedJob | null = null;
        try {
          claim = await api.claimJob(authed);
        } catch (err) {
          emit("error", `Could not check for jobs (${err instanceof Error ? err.message : err}).`);
        }
        if (claim && !stopped) {
          const liveCapture = liveCaptureFromClaim(claim);
          enqueueRemote({ ...claim, liveCapture });
          continue;
        }
      }
      if (!stopped && !hasMachineWork()) {
        const plan = roll.nextChunk(now);
        if (plan) {
          try {
            const submitted = await api.submitProcess(authed, {
              url: plan.streamUrl,
              clipLength: "short",
              liveChunk: {
                sessionId: plan.sessionId,
                startSec: plan.startSec,
                mode: plan.mode,
                title: plan.title,
                ...(plan.endSec != null ? { endSec: plan.endSec } : {}),
                ...(plan.durationSec != null ? { durationSec: plan.durationSec } : {}),
              },
            });
            if (submitted.deduped) {
              roll.complete(plan);
            } else if (!submitted.videoId) {
              roll.abandon(plan);
            } else {
              enqueueLocal(plan.streamUrl, "short", {
                remoteJobId: submitted.jobId,
                videoId: submitted.videoId,
                title: plan.title,
                ingestKind: "live_chunk",
                liveCapture: {
                  ...plan,
                  rollOwned: true,
                },
              });
            }
          } catch (err) {
            roll.abandon(plan);
            console.warn(
              `Could not start a live chunk (${err instanceof Error ? err.message : err}).`,
            );
          }
          continue;
        }
      }
      if (!activeMachineWork()) {
        try {
          const updated = await refreshYtdlpIfNeeded();
          if (updated && !stopped) {
            emit("running", "Updated the downloader. Waiting for the next job…");
          }
        } catch (err) {
          console.warn(
            `Could not update yt-dlp (${err instanceof Error ? err.message : err}).`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  })();

  return () => {
    stopped = true;
    unsubscribeQueue();
  };
}

function capturePlan(capture: LiveCapture): LiveCapturePlan {
  return {
    sessionKey: capture.sessionKey,
    platform: capture.platform,
    mode: capture.mode,
    streamUrl: capture.streamUrl,
    sessionId: capture.sessionId,
    title: capture.title,
    startSec: capture.startSec,
    endSec: capture.endSec,
    durationSec: capture.durationSec,
    channelId: capture.channelId,
    channelName: capture.channelName,
    channelUrl: capture.channelUrl,
    rewindCoveredUntil: capture.rewindCoveredUntil ?? 0,
    rewindEdgeIndex: capture.rewindEdgeIndex ?? 0,
  };
}

function liveCaptureFromClaim(claim: api.ClaimedJob): LiveCapture | undefined {
  if (claim.ingestKind !== "live_chunk" || !claim.platform || !claim.sourceVideoId) {
    return undefined;
  }
  return {
    mode: claim.captureMode ?? (claim.liveChunkEndSec != null ? "dash" : "edge"),
    platform: claim.platform,
    streamUrl: claim.youtubeUrl,
    sessionId: claim.sourceVideoId,
    sessionKey: `${claim.platform}:${claim.sourceVideoId}`,
    startSec: claim.liveChunkStartSec ?? 0,
    endSec: claim.liveChunkEndSec,
    durationSec: claim.liveChunkDurationSec,
    channelId: claim.channelId || "",
    channelName: claim.channelName || claim.platform,
    channelUrl: claim.channelUrl || claim.youtubeUrl,
    title: claim.title || `${claim.platform} live`,
    rollOwned: false,
  };
}
