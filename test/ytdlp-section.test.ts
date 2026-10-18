import assert from "node:assert/strict";
import test from "node:test";
import { HTTPS_FORMAT_SORT, youtubeSectionArgs } from "../src/ytdlp.js";

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
});
