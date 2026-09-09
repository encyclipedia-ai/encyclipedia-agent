import assert from "node:assert/strict";
import test from "node:test";
import { CLIP_WINDOW_PAD_SEC, paddedClipWindow } from "../src/clip-windows.js";

test("paddedClipWindow adds pad on both sides and clamps to the file", () => {
  const window = paddedClipWindow(
    { startSec: 40, endSec: 70, durationSec: 30 },
    120,
  );
  assert.equal(window.startSec, 40 - CLIP_WINDOW_PAD_SEC);
  assert.equal(window.durationSec, 30 + CLIP_WINDOW_PAD_SEC * 2);
});

test("paddedClipWindow does not start before zero", () => {
  const window = paddedClipWindow(
    { startSec: 5, endSec: 20, durationSec: 15 },
    60,
  );
  assert.equal(window.startSec, 0);
  assert.equal(window.durationSec, 20 + CLIP_WINDOW_PAD_SEC);
});

test("paddedClipWindow does not extend past the video duration", () => {
  const window = paddedClipWindow(
    { startSec: 90, endSec: 100, durationSec: 10 },
    100,
  );
  assert.equal(window.startSec, 90 - CLIP_WINDOW_PAD_SEC);
  assert.equal(window.durationSec, 100 - window.startSec);
});
