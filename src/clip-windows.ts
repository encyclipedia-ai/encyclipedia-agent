/** Extra video on each side of a detected moment. Gemini watches this file, and the renderer cuts the refined moment out of it. */
export const CLIP_WINDOW_PAD_SEC = 60;

/** Gemini review rejects a window longer than six minutes. */
export const MAX_UPLOAD_WINDOW_SEC = 6 * 60;

export type TimedClip = {
  startSec: number;
  endSec: number;
  durationSec: number;
};

export type ClipWindow = {
  startSec: number;
  durationSec: number;
};

export type StoryScene = {
  startSec: number;
  endSec: number;
};

/** Expand a detected clip by one minute on each side. */
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

/**
 * Upload enough source for the short and for the transcript scene around it.
 * The short crop still uses the moment's own timestamps. The window only
 * grows so the stream VOD can include the setup and the reaction.
 */
export function uploadWindowForClip(
  clip: TimedClip,
  story: StoryScene[] | undefined,
  videoDurationSec: number,
): ClipWindow {
  const padded = paddedClipWindow(clip, videoDurationSec);
  const clipEnd = clip.endSec > clip.startSec ? clip.endSec : clip.startSec + clip.durationSec;
  let startSec = padded.startSec;
  let endSec = padded.startSec + padded.durationSec;
  for (const scene of story ?? []) {
    if (scene.endSec <= clip.startSec || scene.startSec >= clipEnd) continue;
    startSec = Math.min(startSec, scene.startSec);
    endSec = Math.max(endSec, scene.endSec);
  }
  if (videoDurationSec > 0) {
    startSec = Math.max(0, startSec);
    endSec = Math.min(videoDurationSec, endSec);
  }
  if (endSec - startSec > MAX_UPLOAD_WINDOW_SEC) {
    const mid = (clip.startSec + clipEnd) / 2;
    startSec = Math.max(0, mid - MAX_UPLOAD_WINDOW_SEC / 2);
    endSec = startSec + MAX_UPLOAD_WINDOW_SEC;
    if (videoDurationSec > 0 && endSec > videoDurationSec) {
      endSec = videoDurationSec;
      startSec = Math.max(0, endSec - MAX_UPLOAD_WINDOW_SEC);
    }
    if (startSec > clip.startSec) startSec = Math.max(0, clip.startSec);
    if (endSec < clipEnd) endSec = Math.min(videoDurationSec > 0 ? videoDurationSec : clipEnd, clipEnd);
    if (endSec - startSec > MAX_UPLOAD_WINDOW_SEC) endSec = startSec + MAX_UPLOAD_WINDOW_SEC;
  }
  return {
    startSec,
    durationSec: Math.max(0.1, endSec - startSec),
  };
}

/** Scenes no short lands in. Those still need their own upload for the VOD. */
export function scenesWithoutClip(
  story: StoryScene[] | undefined,
  clips: TimedClip[],
): StoryScene[] {
  return (story ?? []).filter((scene) => {
    if (!(scene.endSec > scene.startSec)) return false;
    return !clips.some((clip) => {
      const clipEnd = clip.endSec > clip.startSec ? clip.endSec : clip.startSec + clip.durationSec;
      return scene.endSec > clip.startSec && scene.startSec < clipEnd;
    });
  });
}
