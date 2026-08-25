import os from "node:os";
import { clearSession, loadConfig, saveConfig, type AgentConfig } from "./config.js";
import { ensureFreshToken, signInWithIdp, signInWithPassword } from "./auth.js";
import * as api from "./api.js";
import { isRecutClaim } from "./claim.js";
import {
  handoffLocalClip,
  handoffRecut,
  handoffRemoteJob,
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
import { sweepDownloadTemps } from "./ytdlp.js";

export type HelperStatus = "signed_out" | "starting" | "running" | "working" | "error";

export interface HelperSnapshot {
  status: HelperStatus;
  email: string | null;
  message: string;
  busy: boolean;
  queue: QueueItem[];
}

export type HelperListener = (snap: HelperSnapshot) => void;

function snapshot(
  status: HelperStatus,
  message: string,
  cfg?: AgentConfig,
  busy = false,
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

export function queueClip(
  url: string,
  clipLength: "short" | "medium",
): QueueItem {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("Paste a YouTube URL first.");
  return enqueueLocal(trimmed, clipLength);
}

export async function clipFromUrl(
  url: string,
  clipLength: "short" | "medium",
  onLog: LogFn,
): Promise<void> {
  await ensureTools();
  const cfg = await ensureFreshToken(loadConfig());
  await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  await withWork(() => runClip(cfg, url.trim(), clipLength, onLog));
}

export function startHelperLoop(onUpdate: HelperListener): () => void {
  sweepDownloadTemps();
  let stopped = false;
  let cfg: AgentConfig | null = null;
  let lastStatus: HelperStatus = "starting";
  let lastMessage = "Opening the stacks…";

  const emit = (
    status: HelperStatus,
    message: string,
    busy = false,
  ): void => {
    lastStatus = status;
    lastMessage = message;
    if (!stopped) onUpdate(snapshot(status, message, cfg ?? undefined, busy));
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
      const claim = {
        jobId: item.remoteJobId,
        youtubeUrl: item.url,
        clipLength: item.clipLength,
        videoId: null,
        kind: item.kind,
        startSec: item.startSec,
        durationSec: item.durationSec,
        title: item.title ?? undefined,
      };
      cloudJobId = isRecutClaim(claim)
        ? await handoffRecut(authed, claim, onLog)
        : await handoffRemoteJob(authed, claim, onLog);
    } else {
      cloudJobId = await handoffLocalClip(authed, item.url, item.clipLength, onLog);
    }
    void waitForWorker(authed, cloudJobId, onLog)
      .then(() => {
        updateQueueItem(item.id, {
          phase: "done",
          percent: 100,
          detail: "Shelved. Clips are in your stacks.",
        });
      })
      .catch((err) => {
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
      if (!hasMachineWork()) {
        let claim: api.ClaimedJob | null = null;
        try {
          claim = await api.claimJob(authed);
        } catch (err) {
          emit("error", `Could not check for jobs (${err instanceof Error ? err.message : err}).`);
        }
        if (claim && !stopped) {
          enqueueRemote(claim);
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
