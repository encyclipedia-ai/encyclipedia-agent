export const CLIP_WINDOW_PAD_SEC = 15;

export type TimedClip = {
  startSec: number;
  endSec: number;
  durationSec: number;
};

export type ClipWindow = {
  startSec: number;
  durationSec: number;
};

/** Expand a detected clip by a few seconds so later recuts can nudge in/out. */
export function paddedClipWindow(clip: TimedClip, videoDurationSec: number): ClipWindow {
  const startSec = Math.max(0, clip.startSec - CLIP_WINDOW_PAD_SEC);
  const rawEnd = clip.endSec > clip.startSec ? clip.endSec : clip.startSec + clip.durationSec;
  const paddedEnd = rawEnd + CLIP_WINDOW_PAD_SEC;
  const endSec = videoDurationSec > 0 ? Math.min(videoDurationSec, paddedEnd) : paddedEnd;
  return {
    startSec,
    durationSec: Math.max(0.1, endSec - startSec),
  };
}
