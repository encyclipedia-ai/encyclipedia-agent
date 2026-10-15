/**
 * Rolling live-capture sessions.
 *
 * YouTube DASH can seek a closed window behind the live edge, so chunks
 * overlap by a few seconds and can catch up after other work. Twitch and
 * Kick only expose a short HLS window, so those chunks record forward from
 * the live edge and do not seek back to the start of the broadcast.
 */

export const LIVE_POLL_MS = 60_000;
export const LIVE_CHUNK_SEC = 180;
export const LIVE_OVERLAP_SEC = 20;
export const LIVE_EDGE_LAG_SEC = 30;
export const LIVE_MIN_WINDOW_SEC = 45;

export type LivePlatform = "youtube" | "twitch" | "kick";

export interface RollProfile {
  platform: LivePlatform;
  connection: "connected" | "not_connected";
  platformUserId: string | null;
  handle: string | null;
  displayName: string | null;
  profileUrl: string | null;
  check: "ok" | "failed";
  live: {
    status: "is_live";
    streamUrl: string;
    videoId: string;
    title: string;
    startedAt: number | null;
  } | null;
}

export interface LiveCapturePlan {
  sessionKey: string;
  platform: LivePlatform;
  mode: "dash" | "edge";
  streamUrl: string;
  sessionId: string;
  title: string;
  startSec: number;
  endSec?: number;
  durationSec?: number;
  channelId: string;
  channelName: string;
  channelUrl: string;
  /** Covered-until value to restore if this chunk fails before it is shelved. */
  rewindCoveredUntil: number;
  /** Edge index to restore if this chunk fails. */
  rewindEdgeIndex: number;
}

interface Session {
  sessionKey: string;
  platform: LivePlatform;
  sessionId: string;
  streamUrl: string;
  title: string;
  startedAt: number | null;
  channelId: string;
  channelName: string;
  channelUrl: string;
  coveredUntilSec: number;
  edgeIndex: number;
  mode: "dash" | "edge";
}

export function nextDashWindow(
  coveredUntilSec: number,
  elapsedSec: number,
): { startSec: number; endSec: number } | null {
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return null;
  const available = elapsedSec - LIVE_EDGE_LAG_SEC;
  const start = Math.max(0, coveredUntilSec);
  const end = Math.min(start + LIVE_CHUNK_SEC, available);
  if (end - start < LIVE_MIN_WINDOW_SEC) return null;
  return { startSec: Math.floor(start), endSec: Math.floor(end) };
}

export function advanceCoveredUntil(endSec: number): number {
  return Math.max(0, endSec - LIVE_OVERLAP_SEC);
}

function sessionKey(platform: LivePlatform, videoId: string): string {
  return `${platform}:${videoId}`;
}

export class LiveRoll {
  private sessions = new Map<string, Session>();
  private inFlight: string | null = null;
  private cooldownUntil = new Map<string, number>();

  observe(profiles: RollProfile[]): void {
    const liveKeys = new Set<string>();
    for (const profile of profiles) {
      if (profile.connection !== "connected" || profile.check !== "ok" || !profile.live) {
        continue;
      }
      if (!profile.platformUserId) continue;
      const key = sessionKey(profile.platform, profile.live.videoId);
      liveKeys.add(key);
      const existing = this.sessions.get(key);
      const mode: "dash" | "edge" =
        profile.platform === "youtube" && profile.live.startedAt != null ? "dash" : "edge";
      if (existing) {
        existing.streamUrl = profile.live.streamUrl;
        existing.title = profile.live.title;
        existing.startedAt = profile.live.startedAt;
        existing.channelName = profile.displayName || existing.channelName;
        existing.channelUrl = profile.profileUrl || existing.channelUrl;
        existing.mode = mode;
        continue;
      }
      this.sessions.set(key, {
        sessionKey: key,
        platform: profile.platform,
        sessionId: profile.live.videoId,
        streamUrl: profile.live.streamUrl,
        title: profile.live.title,
        startedAt: profile.live.startedAt,
        channelId: profile.platformUserId,
        channelName: profile.displayName || profile.handle || profile.platform,
        channelUrl: profile.profileUrl || profile.live.streamUrl,
        coveredUntilSec: 0,
        edgeIndex: 0,
        mode,
      });
    }
    for (const key of this.sessions.keys()) {
      if (!liveKeys.has(key)) this.sessions.delete(key);
    }
    if (this.inFlight && !this.sessions.has(this.inFlight)) this.inFlight = null;
  }

  /** One chunk at a time. Null when nothing is far enough behind the live edge. */
  nextChunk(nowMs: number): LiveCapturePlan | null {
    if (this.inFlight) return null;
    const nowSec = Math.floor(nowMs / 1000);
    for (const session of this.sessions.values()) {
      if (nowMs < (this.cooldownUntil.get(session.sessionKey) ?? 0)) continue;
      const plan = this.planFor(session, nowSec);
      if (!plan) continue;
      this.inFlight = session.sessionKey;
      if (plan.mode === "dash" && plan.endSec != null) {
        session.coveredUntilSec = advanceCoveredUntil(plan.endSec);
      } else {
        session.edgeIndex += 1;
      }
      return plan;
    }
    return null;
  }

  /** Download or handoff failed. The same window can be tried again after a cooldown. */
  abandon(plan: LiveCapturePlan, nowMs = Date.now()): void {
    const session = this.sessions.get(plan.sessionKey);
    if (session) {
      session.coveredUntilSec = plan.rewindCoveredUntil;
      session.edgeIndex = plan.rewindEdgeIndex;
    }
    this.cooldownUntil.set(plan.sessionKey, nowMs + LIVE_POLL_MS);
    if (this.inFlight === plan.sessionKey) this.inFlight = null;
  }

  /** Chunk was handed to the renderer. Allow the next window. */
  complete(plan: LiveCapturePlan): void {
    if (this.inFlight === plan.sessionKey) this.inFlight = null;
  }

  private planFor(session: Session, nowSec: number): LiveCapturePlan | null {
    const base = {
      sessionKey: session.sessionKey,
      platform: session.platform,
      streamUrl: session.streamUrl,
      sessionId: session.sessionId,
      title: session.title,
      channelId: session.channelId,
      channelName: session.channelName,
      channelUrl: session.channelUrl,
      rewindCoveredUntil: session.coveredUntilSec,
      rewindEdgeIndex: session.edgeIndex,
    };
    if (session.mode === "dash" && session.startedAt != null) {
      const elapsed = nowSec - session.startedAt;
      const window = nextDashWindow(session.coveredUntilSec, elapsed);
      if (!window) return null;
      return {
        ...base,
        mode: "dash",
        startSec: window.startSec,
        endSec: window.endSec,
      };
    }
    return {
      ...base,
      mode: "edge",
      startSec: session.edgeIndex * LIVE_CHUNK_SEC,
      durationSec: LIVE_CHUNK_SEC,
    };
  }
}
