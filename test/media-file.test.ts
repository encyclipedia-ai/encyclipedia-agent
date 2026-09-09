import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedClipPath,
  isAllowedVideoPath,
  isMp4Path,
  parseFfmpegDuration,
} from "../src/media-file.js";

test("parseFfmpegDuration reads hours minutes and fractional seconds", () => {
  const stderr = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'talk.mp4':",
    "  Duration: 01:02:03.50, start: 0.000000, bitrate: 4123 kb/s",
  ].join("\n");
  assert.equal(parseFfmpegDuration(stderr), 3723.5);
});

test("parseFfmpegDuration returns 0 when ffmpeg prints no duration", () => {
  assert.equal(parseFfmpegDuration("ffmpeg version 6.1.1"), 0);
});

test("isAllowedClipPath accepts common desktop containers", () => {
  assert.equal(isAllowedClipPath("/tmp/vod.mp4"), true);
  assert.equal(isAllowedVideoPath("/tmp/vod.MOV"), true);
  assert.equal(isAllowedClipPath("/tmp/vod.mkv"), true);
  assert.equal(isAllowedClipPath("/tmp/vod.webm"), true);
  assert.equal(isAllowedClipPath("/tmp/vod.m4v"), true);
  assert.equal(isAllowedClipPath("/tmp/notes.txt"), false);
});

test("isMp4Path is true only for .mp4", () => {
  assert.equal(isMp4Path("/tmp/a.mp4"), true);
  assert.equal(isMp4Path("/tmp/a.MP4"), true);
  assert.equal(isMp4Path("/tmp/a.mov"), false);
});
