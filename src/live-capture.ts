import { downloadSection, recordLiveEdge, type YtdlpProgressFn } from "./ytdlp.js";
import { LIVE_CHUNK_SEC, type LiveCapturePlan } from "./live-roll.js";

/** Download one finite mp4 for a live chunk. YouTube seeks a DASH window; other platforms record the edge. */
export async function captureLiveFile(
  plan: LiveCapturePlan,
  workDir: string,
  onProgress?: YtdlpProgressFn,
): Promise<string> {
  if (plan.mode === "dash" && plan.endSec != null && plan.endSec > plan.startSec) {
    try {
      return await downloadSection(
        plan.streamUrl,
        plan.startSec,
        plan.endSec - plan.startSec,
        workDir,
        onProgress,
        "live-window",
        undefined,
        { liveFromStart: true },
      );
    } catch (err) {
      const duration = Math.max(1, Math.min(LIVE_CHUNK_SEC, plan.endSec - plan.startSec));
      onProgress?.({
        percent: null,
        detail: "The DASH window was unavailable. Recording the live edge…",
      });
      console.warn(
        `Live DASH window failed (${err instanceof Error ? err.message : err}). Recording the live edge.`,
      );
      return recordLiveEdge(plan.streamUrl, duration, workDir, onProgress);
    }
  }
  return recordLiveEdge(plan.streamUrl, plan.durationSec ?? LIVE_CHUNK_SEC, workDir, onProgress);
}
