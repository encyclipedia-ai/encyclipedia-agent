import { isRecutClaim } from "./claim.js";

export type WorkPhase =
  | "queued"
  | "lookup"
  | "download"
  | "analyze"
  | "upload"
  | "render"
  | "done"
  | "error";

export interface QueueItem {
  id: string;
  url: string;
  title: string | null;
  source: "local" | "remote";
  kind?: "process" | "recut";
  clipLength: "short" | "medium";
  remoteJobId?: string;
  cloudJobId?: string;
  startSec?: number;
  durationSec?: number;
  phase: WorkPhase;
  percent: number | null;
  detail: string;
  error?: string;
  addedAt: number;
}

export type QueuePatch = Partial<
  Pick<
    QueueItem,
    "phase" | "percent" | "detail" | "title" | "cloudJobId" | "error"
  >
>;

export type QueueProcessor = (
  item: QueueItem,
  report: (patch: QueuePatch) => void,
) => Promise<{ cloudJobId?: string } | void>;

const KEEP_FINISHED = 15;
const MACHINE_PHASES = new Set<WorkPhase>(["lookup", "download", "analyze", "upload"]);
const TERMINAL_PHASES = new Set<WorkPhase>(["done", "error"]);

let items: QueueItem[] = [];
let processor: QueueProcessor | null = null;
let draining = false;
const listeners = new Set<(items: QueueItem[]) => void>();
const lastNotify = new Map<string, number>();

export function getQueue(): QueueItem[] {
  return items.map((item) => ({ ...item }));
}

export function onQueueChange(fn: (items: QueueItem[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  const snapshot = getQueue();
  for (const fn of listeners) fn(snapshot);
}

function trimFinished(): void {
  const finished = items.filter((item) => item.phase === "done" || item.phase === "error");
  if (finished.length <= KEEP_FINISHED) return;
  const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((item) => item.id));
  items = items.filter((item) => !drop.has(item.id));
}

export function updateQueueItem(id: string, patch: QueuePatch): void {
  const item = items.find((row) => row.id === id);
  if (!item) return;
  const phaseChanged = patch.phase !== undefined && patch.phase !== item.phase;
  Object.assign(item, patch);
  const now = Date.now();
  const prev = lastNotify.get(id) ?? 0;
  if (!phaseChanged && now - prev < 150) return;
  lastNotify.set(id, now);
  if (patch.phase === "done" || patch.phase === "error") trimFinished();
  emit();
}

export function setQueueProcessor(fn: QueueProcessor): void {
  processor = fn;
  void drain();
}

export function hasMachineWork(): boolean {
  return items.some((item) => MACHINE_PHASES.has(item.phase) || item.phase === "queued");
}

export function activeMachineWork(): QueueItem | undefined {
  return items.find((item) => MACHINE_PHASES.has(item.phase));
}

export function queueIsIdle(
  queue: ReadonlyArray<Pick<QueueItem, "phase">>,
  isDraining: boolean,
): boolean {
  return !isDraining && queue.every((item) => TERMINAL_PHASES.has(item.phase));
}

export function isQueueIdle(): boolean {
  return queueIsIdle(items, draining);
}

function makeItem(
  input: Pick<QueueItem, "url" | "clipLength" | "source"> & {
    remoteJobId?: string;
    title?: string | null;
    kind?: "process" | "recut";
    startSec?: number;
    durationSec?: number;
  },
): QueueItem {
  return {
    id: crypto.randomUUID(),
    url: input.url,
    title: input.title ?? null,
    source: input.source,
    kind: input.kind,
    clipLength: input.clipLength,
    remoteJobId: input.remoteJobId,
    startSec: input.startSec,
    durationSec: input.durationSec,
    phase: "queued",
    percent: null,
    detail: "In line",
    addedAt: Date.now(),
  };
}

export function enqueueLocal(
  url: string,
  clipLength: "short" | "medium",
): QueueItem {
  const item = makeItem({ url, clipLength, source: "local" });
  items.push(item);
  emit();
  void drain();
  return item;
}

export function enqueueRemote(claim: {
  jobId: string;
  youtubeUrl: string;
  clipLength: "short" | "medium";
  kind?: "process" | "recut";
  startSec?: number;
  durationSec?: number;
  title?: string;
}): QueueItem | null {
  if (items.some((item) => item.remoteJobId === claim.jobId && item.phase !== "done" && item.phase !== "error")) {
    return null;
  }
  const item = makeItem({
    url: claim.youtubeUrl,
    clipLength: claim.clipLength,
    source: "remote",
    remoteJobId: claim.jobId,
    kind: isRecutClaim(claim) ? "recut" : "process",
    startSec: claim.startSec,
    durationSec: claim.durationSec,
    title: claim.title ?? null,
  });
  items.push(item);
  emit();
  void drain();
  return item;
}

export function clearUnfinishedQueue(): void {
  items = items.filter((item) => item.phase === "done" || item.phase === "error");
  draining = false;
  emit();
}

async function drain(): Promise<void> {
  if (draining || !processor) return;
  draining = true;
  try {
    while (processor) {
      const next = items.find((item) => item.phase === "queued");
      if (!next) break;
      const report = (patch: QueuePatch) => updateQueueItem(next.id, patch);
      report({ phase: "lookup", percent: null, detail: "Looking up the video…" });
      try {
        const result = await processor(next, report);
        const current = items.find((row) => row.id === next.id);
        if (current && (current.phase === "done" || current.phase === "error")) {
          continue;
        }
        if (result?.cloudJobId) {
          updateQueueItem(next.id, {
            cloudJobId: result.cloudJobId,
            phase: "render",
            percent: null,
            detail: "Renderer is preparing clips…",
          });
        } else {
          updateQueueItem(next.id, {
            phase: "done",
            percent: 100,
            detail: "Shelved.",
          });
        }
      } catch (err) {
        updateQueueItem(next.id, {
          phase: "error",
          percent: null,
          detail: err instanceof Error ? err.message : String(err),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    draining = false;
    if (items.some((item) => item.phase === "queued")) void drain();
  }
}
