/** True when a claimed dashboard job is a clip edit, not a full-VOD ingest. */
export function isRecutClaim(claim: {
  kind?: string | null;
  startSec?: unknown;
  durationSec?: unknown;
}): boolean {
  if (claim.kind === "recut") return true;
  const start = Number(claim.startSec);
  const duration = Number(claim.durationSec);
  return Number.isFinite(start) && Number.isFinite(duration) && duration > 0;
}

export const RECUT_WINDOW_MISSING =
  "This clip edit is missing a valid time window. Restart Encyclipedia Helper from current source (pnpm app) and try again.";

export const RECUT_NOT_FULL_VOD =
  "This job is a clip edit, not a full-video download. Restart Encyclipedia Helper from current source (pnpm app).";
