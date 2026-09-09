import type { AgentConfig } from "./config.js";
import { ensureFreshToken } from "./auth.js";

export class AgentApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export class JobCancelledError extends Error {
  constructor() {
    super("This job was cancelled.");
    this.name = "JobCancelledError";
  }
}

export function isJobCancelledError(err: unknown): boolean {
  if (err instanceof JobCancelledError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof AgentApiError && err.status === 409 && /cancelled/i.test(err.message)) {
    return true;
  }
  return false;
}

export interface VideoInfo {
  id: string;
  title: string;
  duration: number;
  thumbnail: string;
  channelId: string;
  channelName: string;
  channelUrl: string;
  channelAvatar: string | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface ClipPlanItem {
  title: string;
  summary: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  viralScore: number;
  transcript: string;
  publishHashtags?: string;
}

export interface ClipPlan {
  clips: ClipPlanItem[];
  costUsd: number;
}

export interface UploadTarget {
  bucket: string;
  objectKey: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface DownloadTarget {
  bucket: string;
  objectKey: string;
  downloadUrl: string;
  method: "GET";
  headers: Record<string, string>;
  windowStartSec?: number;
  windowDurationSec?: number;
}

export type UploadKind = "video" | "captions" | "recut" | "audio" | "window";

export interface SourceWindow {
  objectKey: string;
  startSec: number;
  durationSec: number;
}

export interface JobSource {
  bucket: string;
  objectKey?: string;
  subtitleKey?: string;
  windows?: SourceWindow[];
}

async function request<T>(
  cfg: AgentConfig,
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<T> {
  let authed = await ensureFreshToken(cfg);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (authed.idToken) headers.Authorization = `Bearer ${authed.idToken}`;
  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`${authed.apiUrl}${path}`, { ...init, headers });
  } catch (err) {
    if (init.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new JobCancelledError();
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (res.status === 401 && !retried) {
    authed = await ensureFreshToken({ ...authed, idTokenExpiresAt: 0 });
    return request(authed, path, init, true);
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `${init.method ?? "GET"} ${path} failed: ${res.status}`;
    if (res.status === 409 && /cancelled/i.test(message)) {
      throw new JobCancelledError();
    }
    throw new AgentApiError(res.status, message);
  }
  return parsed as T;
}

export function register(cfg: AgentConfig, osName: string, name: string) {
  return request(cfg, "/api/agent/register", {
    method: "POST",
    body: JSON.stringify({ deviceId: cfg.deviceId, os: osName, name }),
  });
}

export function heartbeat(cfg: AgentConfig) {
  return request(cfg, "/api/agent/heartbeat", {
    method: "POST",
    body: JSON.stringify({ deviceId: cfg.deviceId }),
  });
}

export function me(cfg: AgentConfig) {
  return request<{ uid: string; email: string | null; name: string | null }>(
    cfg,
    "/api/me",
  );
}

export function requestUploadUrl(
  cfg: AgentConfig,
  videoId: string,
  kind: UploadKind,
  contentType: string,
  index?: number,
) {
  return request<UploadTarget>(cfg, "/api/agent/upload-url", {
    method: "POST",
    body: JSON.stringify({
      videoId,
      kind,
      contentType,
      ...(kind === "window" ? { index } : {}),
    }),
  });
}

export function requestDownloadUrl(
  cfg: AgentConfig,
  videoId: string,
  window?: { startSec: number; durationSec: number },
) {
  return request<DownloadTarget>(cfg, "/api/agent/download-url", {
    method: "POST",
    body: JSON.stringify({
      videoId,
      ...(window
        ? { startSec: window.startSec, durationSec: window.durationSec }
        : {}),
    }),
  });
}

export function analyze(
  cfg: AgentConfig,
  body: {
    segments: TranscriptSegment[];
    clipLength: "short" | "medium";
    video: VideoInfo;
    videoTitle?: string;
  },
) {
  return request<ClipPlan>(cfg, "/api/agent/analyze", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function transcribeJob(
  cfg: AgentConfig,
  jobId: string,
  body: { bucket: string; objectKey: string },
  signal?: AbortSignal,
) {
  return request<{
    segments: TranscriptSegment[];
    durationMinutes: number;
    costUsd: number;
    language: string;
  }>(cfg, `/api/agent/jobs/${encodeURIComponent(jobId)}/transcribe`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

export function analyzeJob(
  cfg: AgentConfig,
  jobId: string,
  body: {
    segments: TranscriptSegment[];
    clipLength: "short" | "medium";
    videoTitle?: string;
  },
  signal?: AbortSignal,
) {
  return request<ClipPlan>(
    cfg,
    `/api/agent/jobs/${encodeURIComponent(jobId)}/analyze`,
    {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    },
  );
}

export function submitProcess(
  cfg: AgentConfig,
  body:
    | { url: string; clipLength: "short" | "medium" }
    | { localFile: { displayName: string }; clipLength: "short" | "medium" },
) {
  return request<{ jobId: string; status: string; deduped?: boolean; videoId?: string }>(
    cfg,
    "/api/process",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export function submitJob(
  cfg: AgentConfig,
  body: {
    url: string;
    clipLength: "short" | "medium";
    video: VideoInfo;
    source: JobSource;
    clipPlan?: ClipPlan;
  },
) {
  return request<{ jobId: string; status: string; deduped?: boolean }>(
    cfg,
    "/api/agent/jobs",
    {
      method: "POST",
      body: JSON.stringify({ ...body, deviceId: cfg.deviceId }),
    },
  );
}

export function getJob(cfg: AgentConfig, jobId: string) {
  return request<{
    id: string;
    status: string;
    progress: string;
    error?: string;
    kind?: "process" | "recut";
    streamSlug?: string;
    recutFilename?: string;
    startSec?: number;
    durationSec?: number;
    videoTitle?: string;
    ingestKind?: "local_file";
    videoId?: string | null;
  }>(cfg, `/api/jobs/${encodeURIComponent(jobId)}`);
}

/** Poll the cloud job until it is cancelled, then abort in-flight work. */
export function watchJobCancellation(
  cfg: AgentConfig,
  jobId: string,
): { signal: AbortSignal; stop: () => void } {
  const ac = new AbortController();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  void (async () => {
    while (!stopped) {
      try {
        const job = await getJob(cfg, jobId);
        if (stopped) return;
        if (job.status === "cancelled") {
          ac.abort();
          return;
        }
      } catch {
        if (stopped) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  })();
  return { signal: ac.signal, stop };
}

export function getStream(cfg: AgentConfig, slug: string) {
  return request<{
    clips: Array<{ filename: string; editVersion?: number }>;
  }>(cfg, `/api/streams/${encodeURIComponent(slug)}`);
}

export interface ClaimedJob {
  jobId: string;
  youtubeUrl: string;
  clipLength: "short" | "medium";
  videoId: string | null;
  kind?: "process" | "recut";
  ingestKind?: "local_file";
  startSec?: number;
  durationSec?: number;
  title?: string;
}

export async function claimJob(cfg: AgentConfig): Promise<ClaimedJob | null> {
  const result = await request<ClaimedJob | undefined>(cfg, "/api/agent/jobs/claim", {
    method: "POST",
    body: JSON.stringify({ deviceId: cfg.deviceId, supportsRecut: true }),
  });
  return result ?? null;
}

export function completeJob(
  cfg: AgentConfig,
  jobId: string,
  body: {
    video?: VideoInfo;
    source: JobSource;
    clipPlan?: ClipPlan;
  },
  signal?: AbortSignal,
) {
  return request<{ jobId: string; status: string }>(
    cfg,
    `/api/agent/jobs/${encodeURIComponent(jobId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({ ...body, deviceId: cfg.deviceId }),
      signal,
    },
  );
}

export function failJob(cfg: AgentConfig, jobId: string, message: string) {
  return request<{ jobId: string; status: string }>(
    cfg,
    `/api/agent/jobs/${encodeURIComponent(jobId)}/fail`,
    {
      method: "POST",
      body: JSON.stringify({ message }),
    },
  );
}
