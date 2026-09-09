import assert from "node:assert/strict";
import test from "node:test";
import { isLocalFileIngest } from "../src/claim.js";
import { clearUnfinishedQueue, enqueueLocal, getQueue } from "../src/job-queue.js";

test("isLocalFileIngest detects ingestKind and local:// sentinels", () => {
  assert.equal(isLocalFileIngest({ ingestKind: "local_file" }), true);
  assert.equal(isLocalFileIngest({ youtubeUrl: "local://stream.mp4" }), true);
  assert.equal(
    isLocalFileIngest({ youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    false,
  );
});

test("enqueueLocal stores the filesystem path and local ingest metadata", () => {
  clearUnfinishedQueue();
  const item = enqueueLocal("local://talk.mp4", "short", {
    localPath: "/Users/me/Movies/talk.mp4",
    title: "talk.mp4",
    videoId: "local_abc123def456",
    ingestKind: "local_file",
    remoteJobId: "job-1",
  });
  assert.equal(item.localPath, "/Users/me/Movies/talk.mp4");
  assert.equal(item.videoId, "local_abc123def456");
  assert.equal(item.ingestKind, "local_file");
  assert.equal(item.title, "talk.mp4");
  assert.equal(item.source, "local");
  const queued = getQueue().find((row) => row.id === item.id);
  assert.ok(queued);
  assert.equal(queued?.localPath, "/Users/me/Movies/talk.mp4");
});
