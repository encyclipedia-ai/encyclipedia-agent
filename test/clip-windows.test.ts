import assert from "node:assert/strict";
import test from "node:test";
import { CLIP_WINDOW_PAD_SEC, MAX_UPLOAD_WINDOW_SEC, paddedClipWindow, scenesWithoutClip, uploadWindowForClip } from "../src/clip-windows.js";

test("paddedClipWindow adds one minute on both sides", () => {
  const window = paddedClipWindow(
    { startSec: 200, endSec: 230, durationSec: 30 },
    1000,
  );
  assert.equal(window.startSec, 200 - CLIP_WINDOW_PAD_SEC);
  assert.equal(window.durationSec, 30 + CLIP_WINDOW_PAD_SEC * 2);
});

test("paddedClipWindow does not start before zero", () => {
  const window = paddedClipWindow(
    { startSec: 5, endSec: 20, durationSec: 15 },
    1000,
  );
  assert.equal(window.startSec, 0);
  assert.equal(window.durationSec, 20 + CLIP_WINDOW_PAD_SEC);
});

test("uploadWindowForClip covers the transcript scene around the short", () => {
  const window = uploadWindowForClip(
    { startSec: 200, endSec: 220, durationSec: 20 },
    [{ startSec: 120, endSec: 280 }],
    1000,
  );
  assert.equal(window.startSec, 120);
  assert.equal(window.durationSec, 160);
});

test("uploadWindowForClip stays within the review limit", () => {
  const window = uploadWindowForClip(
    { startSec: 500, endSec: 520, durationSec: 20 },
    [{ startSec: 0, endSec: 900 }],
    2000,
  );
  assert.ok(window.durationSec <= MAX_UPLOAD_WINDOW_SEC);
  assert.ok(window.startSec <= 500);
  assert.ok(window.startSec + window.durationSec >= 520);
});

test("scenesWithoutClip keeps moments that no short lands in", () => {
  const missing = scenesWithoutClip(
    [
      { startSec: 10, endSec: 70 },
      { startSec: 200, endSec: 240 },
    ],
    [{ startSec: 40, endSec: 55, durationSec: 15 }],
  );
  assert.deepEqual(missing, [{ startSec: 200, endSec: 240 }]);
});

test("paddedClipWindow does not extend past the video duration", () => {
  const window = paddedClipWindow(
    { startSec: 90, endSec: 100, durationSec: 10 },
    100,
  );
  assert.equal(window.startSec, 90 - CLIP_WINDOW_PAD_SEC);
  assert.equal(window.durationSec, 100 - window.startSec);
});
