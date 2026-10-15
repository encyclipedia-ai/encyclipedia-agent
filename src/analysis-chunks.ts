/** Each Gemini video-understanding request covers this much of the source. */
export const ANALYSIS_CHUNK_SEC = 30 * 60;

/** Overlap so a moment on the cut is fully inside one uploaded file. */
export const ANALYSIS_CHUNK_OVERLAP_SEC = 20;

export interface AnalysisRange {
  startSec: number;
  durationSec: number;
}

/**
 * Split a source into ~30 minute pieces. The last piece is whatever
 * remains. A video shorter than 30 minutes is one chunk.
 */
export function analysisChunkRanges(durationSec: number): AnalysisRange[] {
  const total = durationSec;
  if (!(total > 0)) {
    throw new Error("This video has no duration, so it cannot be split into 30-minute chunks.");
  }
  if (total <= ANALYSIS_CHUNK_SEC) {
    return [{ startSec: 0, durationSec: total }];
  }
  const ranges: AnalysisRange[] = [];
  let start = 0;
  while (start < total - 0.5) {
    const end = Math.min(total, start + ANALYSIS_CHUNK_SEC);
    ranges.push({ startSec: start, durationSec: end - start });
    if (end >= total - 0.5) break;
    const next = end - ANALYSIS_CHUNK_OVERLAP_SEC;
    if (next <= start) break;
    start = next;
  }
  return ranges;
}
