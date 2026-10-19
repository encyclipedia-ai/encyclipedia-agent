import assert from "node:assert/strict";
import test from "node:test";
import {
  HTTPS_FORMAT_SORT,
  failureFromYtdlpOutput,
  sectionYoutubeFormat,
  youtubeSectionArgs,
} from "../src/ytdlp.js";

test("section downloads prefer HTTPS over HLS", () => {
  assert.deepEqual(HTTPS_FORMAT_SORT, ["-S", "proto:https"]);
  const args = youtubeSectionArgs({
    section: "*00:07:00-00:09:00",
    format: "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    output: "/tmp/window_1.%(ext)s",
  });
  const sortAt = args.indexOf("-S");
  assert.equal(args[sortAt + 1], "proto:https");
  assert.ok(args.includes("--download-sections"));
  assert.ok(args.includes("*00:07:00-00:09:00"));
  assert.equal(args.includes("--force-keyframes-at-cuts"), false);
});

test("section downloads prefer H.264 over AV1", () => {
  const format = sectionYoutubeFormat();
  assert.match(format, /vcodec\^=avc1/);
  assert.ok(format.startsWith("bestvideo[height<=1080][vcodec^=avc1]"));
});

test("a ffmpeg 403 is YouTube blocking the section, not a generic ffmpeg failure", () => {
  const err = failureFromYtdlpOutput(
    [
      "https://rr5.googlevideo.com/videoplayback: Server returned 403 Forbidden (access denied)",
      "ERROR: ffmpeg exited with code 1",
    ].join("\n"),
    1,
  );
  assert.match(err.message, /YouTube refused/);
});
