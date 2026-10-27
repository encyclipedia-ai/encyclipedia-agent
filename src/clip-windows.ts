/** Extra video on each side of a detected moment. Gemini watches this file, and the renderer cuts the refined moment out of it. */
export const CLIP_WINDOW_PAD_SEC = 60;

/** Gemini review rejects a window longer than six minutes. */
export const MAX_UPLOAD_WINDOW_SEC = 6 * 60;

/**
 * Story uploads are not sent to Gemini. Keep continuous discussion chunks
 * large enough for a real summary, then stitch them on the worker.
 */
export const MAX_STORY_UPLOAD_SEC = 15 * 60;

/** Same-subject moments this close stay one continuous summary scene. */
export const SUBJECT_BRIDGE_SEC = 3 * 60;

/** Breath kept on each edge of a subject discussion. */
export const STORY_CONTEXT_SEC = 20;

export type TimedClip = {
  startSec: number;
  endSec: number;
  durationSec: number;
  category?: string;
};

export type ClipWindow = {
  startSec: number;
  durationSec: number;
};

export type StoryScene = {
  startSec: number;
  endSec: number;
};

/** Expand a detected clip by one minute on each side for Gemini. */
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
 * Upload enough source for the short Gemini check. Long summary footage is
 * uploaded separately as story windows so a subject cut is not clamped to
 * six minutes around one peak.
 */
export function uploadWindowForClip(
  clip: TimedClip,
  _story: StoryScene[] | undefined,
  videoDurationSec: number,
): ClipWindow {
  const padded = paddedClipWindow(clip, videoDurationSec);
  if (padded.durationSec <= MAX_UPLOAD_WINDOW_SEC) return padded;
  const clipEnd = clip.endSec > clip.startSec ? clip.endSec : clip.startSec + clip.durationSec;
  const mid = (clip.startSec + clipEnd) / 2;
  let startSec = Math.max(0, mid - MAX_UPLOAD_WINDOW_SEC / 2);
  let endSec = startSec + MAX_UPLOAD_WINDOW_SEC;
  if (videoDurationSec > 0 && endSec > videoDurationSec) {
    endSec = videoDurationSec;
    startSec = Math.max(0, endSec - MAX_UPLOAD_WINDOW_SEC);
  }
  return {
    startSec,
    durationSec: Math.max(0.1, endSec - startSec),
  };
}

/**
 * Continuous subject cuts from the finished clip list. Matches the API
 * planner used when Librarian closes the render list.
 */
export function planSubjectStoryScenes(
  clips: TimedClip[],
  videoDurationSec = 0,
): StoryScene[] {
  const bySubject = new Map<string, TimedClip[]>();
  for (const clip of clips) {
    const title = clip.category?.trim().replace(/\s+/g, " ") || "Summary";
    const key = title.toLocaleLowerCase();
    const group = bySubject.get(key);
    if (group) group.push(clip);
    else bySubject.set(key, [clip]);
  }
  const scenes: StoryScene[] = [];
  for (const group of bySubject.values()) {
    const ordered = [...group].sort(
      (a, b) => a.startSec - b.startSec || clipEnd(a) - clipEnd(b),
    );
    let cluster: TimedClip[] = [];
    const flush = () => {
      if (cluster.length === 0) return;
      const startSec = Math.max(0, cluster[0]!.startSec - STORY_CONTEXT_SEC);
      let endSec = clipEnd(cluster[cluster.length - 1]!) + STORY_CONTEXT_SEC;
      if (videoDurationSec > 0) endSec = Math.min(videoDurationSec, endSec);
      scenes.push(...chunkStoryScene({ startSec, endSec }));
      cluster = [];
    };
    for (const clip of ordered) {
      const previous = cluster[cluster.length - 1];
      if (previous && clip.startSec - clipEnd(previous) > SUBJECT_BRIDGE_SEC) flush();
      cluster.push(clip);
    }
    flush();
  }
  return scenes.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

export function chunkStoryScene(scene: StoryScene): StoryScene[] {
  if (!(scene.endSec > scene.startSec)) return [];
  if (scene.endSec - scene.startSec <= MAX_STORY_UPLOAD_SEC) return [scene];
  const chunks: StoryScene[] = [];
  for (let start = scene.startSec; start < scene.endSec; start += MAX_STORY_UPLOAD_SEC) {
    chunks.push({
      startSec: start,
      endSec: Math.min(scene.endSec, start + MAX_STORY_UPLOAD_SEC),
    });
  }
  return chunks;
}

/** @deprecated Prefer {@link planSubjectStoryScenes}. Kept for older call sites. */
export function scenesWithoutClip(
  story: StoryScene[] | undefined,
  clips: TimedClip[],
): StoryScene[] {
  return (story ?? []).filter((scene) => {
    if (!(scene.endSec > scene.startSec)) return false;
    return !clips.some((clip) => {
      const end = clipEnd(clip);
      return scene.endSec > clip.startSec && scene.startSec < end;
    });
  });
}

function clipEnd(clip: TimedClip): number {
  return clip.endSec > clip.startSec ? clip.endSec : clip.startSec + clip.durationSec;
}
