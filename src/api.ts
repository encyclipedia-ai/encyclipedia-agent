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

export interface UploadTarget {
  bucket: string;
  objectKey: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
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
  const res = await fetch(`${authed.apiUrl}${path}`, { ...init, headers });
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
  kind: "video" | "captions" | "recut",
  contentType: string,
) {
  return request<UploadTarget>(cfg, "/api/agent/upload-url", {
    method: "POST",
    body: JSON.stringify({ videoId, kind, contentType }),
  });
}

export function submitJob(
  cfg: AgentConfig,
  body: {
    url: string;
    clipLength: "short" | "medium";
    video: VideoInfo;
    source: { bucket: string; objectKey: string; subtitleKey?: string };
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
  return request<{ id: string; status: string; progress: string; error?: string }>(
    cfg,
    `/api/jobs/${encodeURIComponent(jobId)}`,
  );
}

export interface ClaimedJob {
  jobId: string;
  youtubeUrl: string;
  clipLength: "short" | "medium";
  videoId: string | null;
  kind?: "process" | "recut";
  startSec?: number;
  durationSec?: number;
  title?: string;
}

export async function claimJob(cfg: AgentConfig): Promise<ClaimedJob | null> {
  const result = await request<ClaimedJob | undefined>(cfg, "/api/agent/jobs/claim", {
    method: "POST",
    body: JSON.stringify({ deviceId: cfg.deviceId }),
  });
  return result ?? null;
}

export function completeJob(
  cfg: AgentConfig,
  jobId: string,
  body: {
    video?: VideoInfo;
    source: { bucket: string; objectKey: string; subtitleKey?: string };
  },
) {
  return request<{ jobId: string; status: string }>(
    cfg,
    `/api/agent/jobs/${encodeURIComponent(jobId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({ ...body, deviceId: cfg.deviceId }),
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
