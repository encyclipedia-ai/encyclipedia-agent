/** Parsed caption window sent to API analyze. Matches worker TranscriptSegment. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Parse YouTube json3 captions (yt-dlp `--sub-format json3`) into
 * timestamped segments. Same rules as the worker's `transcriptionFromJson3`.
 */
export function parseJson3Captions(raw: string): TranscriptSegment[] {
  const json3 = JSON.parse(raw) as {
    events?: Array<{
      segs?: Array<{ utf8?: string }>;
      tStartMs?: number;
      dDurationMs?: number;
    }>;
  };
  const segments: TranscriptSegment[] = [];
  for (const event of json3.events || []) {
    if (!event.segs) continue;
    const text = event.segs
      .map((s) => s.utf8)
      .join("")
      .trim();
    if (!text || text === "\n") continue;
    const startSec = (event.tStartMs || 0) / 1000;
    const durSec = (event.dDurationMs || 2000) / 1000;
    segments.push({ start: startSec, end: startSec + durSec, text });
  }
  return segments;
}
