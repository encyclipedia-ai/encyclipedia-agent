import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAudioEvents,
  parseRmsSamples,
  parseSilenceSpans,
  type RmsSample,
} from "../src/audio-events.js";

test("parseRmsSamples reads pts_time and RMS_level pairs", () => {
  const stderr = [
    "frame:0    pts:0       pts_time:0",
    "lavfi.astats.Overall.RMS_level=-40.5",
    "frame:1    pts:8000    pts_time:1",
    "lavfi.astats.Overall.RMS_level=-22.0",
    "frame:2    pts:16000   pts_time:2",
    "lavfi.astats.Overall.RMS_level=-18.25",
  ].join("\n");
  const samples = parseRmsSamples(stderr);
  assert.equal(samples.length, 3);
  assert.deepEqual(samples[0], { atSec: 0, rmsDb: -40.5 });
  assert.deepEqual(samples[1], { atSec: 1, rmsDb: -22 });
  assert.deepEqual(samples[2], { atSec: 2, rmsDb: -18.25 });
});

test("parseSilenceSpans joins silence_start and silence_end", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 1.5",
    "[silencedetect @ 0x1] silence_end: 2.25 | silence_duration: 0.75",
    "[silencedetect @ 0x1] silence_start: 10",
    "[silencedetect @ 0x1] silence_end: 12 | silence_duration: 2",
  ].join("\n");
  const spans = parseSilenceSpans(stderr);
  assert.deepEqual(spans, [
    { start: 1.5, end: 2.25 },
    { start: 10, end: 12 },
  ]);
});

test("buildAudioEvents emits loud peaks, rises, and awkward silences", () => {
  // Quiet baseline, then a sudden yell, then a short pause.
  const samples: RmsSample[] = [
    { atSec: 0, rmsDb: -40 },
    { atSec: 1, rmsDb: -39 },
    { atSec: 2, rmsDb: -38 },
    { atSec: 3, rmsDb: -20 }, // +18 dB rise + loud vs median
    { atSec: 4, rmsDb: -36 },
  ];
  const events = buildAudioEvents(samples, [{ start: 4.2, end: 5.0 }]);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("loud_peak"), `expected loud_peak in ${kinds.join(",")}`);
  assert.ok(kinds.includes("energy_rise"), `expected energy_rise in ${kinds.join(",")}`);
  assert.ok(kinds.includes("silence"), `expected silence in ${kinds.join(",")}`);
  const peak = events.find((e) => e.kind === "loud_peak");
  assert.ok(peak);
  assert.ok((peak!.intensity ?? 0) > 0);
});

test("buildAudioEvents drops dead-air silence and tiny blips", () => {
  const events = buildAudioEvents(
    [{ atSec: 0, rmsDb: -40 }],
    [
      { start: 1, end: 1.1 },
      { start: 2, end: 20 },
    ],
  );
  assert.equal(events.filter((e) => e.kind === "silence").length, 0);
});
