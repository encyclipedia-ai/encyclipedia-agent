import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_CHUNK_OVERLAP_SEC,
  ANALYSIS_CHUNK_SEC,
  analysisChunkRanges,
} from "../src/analysis-chunks.js";

test("a short video is one chunk", () => {
  assert.deepEqual(analysisChunkRanges(12 * 60), [{ startSec: 0, durationSec: 12 * 60 }]);
});

test("an hour becomes two overlapping 30-minute chunks plus the tail", () => {
  const ranges = analysisChunkRanges(60 * 60);
  assert.equal(ranges[0]?.startSec, 0);
  assert.equal(ranges[0]?.durationSec, ANALYSIS_CHUNK_SEC);
  assert.equal(ranges[1]?.startSec, ANALYSIS_CHUNK_SEC - ANALYSIS_CHUNK_OVERLAP_SEC);
  assert.equal(ranges.at(-1)?.startSec! + ranges.at(-1)!.durationSec, 60 * 60);
  for (const range of ranges) {
    assert.ok(range.durationSec <= ANALYSIS_CHUNK_SEC);
    assert.ok(range.durationSec > 0);
  }
});

test("refuses a video with no duration", () => {
  assert.throws(() => analysisChunkRanges(0), /duration/);
});
