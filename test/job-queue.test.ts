import assert from "node:assert/strict";
import test from "node:test";
import { enqueueLocal, getQueue, queueIsIdle, type WorkPhase } from "../src/job-queue.js";

test("queue is idle when it is empty or all jobs are terminal", () => {
  assert.equal(queueIsIdle([], false), true);
  assert.equal(queueIsIdle([{ phase: "done" }, { phase: "error" }], false), true);
  assert.equal(queueIsIdle([{ phase: "cancelled" }], false), true);
});

test("every unfinished phase blocks an update restart", () => {
  const unfinished: WorkPhase[] = [
    "queued",
    "lookup",
    "download",
    "analyze",
    "upload",
    "render",
  ];

  for (const phase of unfinished) {
    assert.equal(queueIsIdle([{ phase }], false), false, `${phase} must block`);
  }
});

test("an active drain blocks restart even with no unfinished jobs", () => {
  assert.equal(queueIsIdle([], true), false);
  assert.equal(queueIsIdle([{ phase: "done" }], true), false);
});

test("local jobs keep the filesystem path and display name", () => {
  const item = enqueueLocal("/tmp/lecture.mp4", "short", {
    localPath: "/tmp/lecture.mp4",
    title: "lecture.mp4",
    remoteJobId: "job-local-1",
    videoId: "local_abcdefghijabcdefghij",
    ingestKind: "local_file",
  });
  assert.equal(item.localPath, "/tmp/lecture.mp4");
  assert.equal(item.url, "/tmp/lecture.mp4");
  assert.equal(item.title, "lecture.mp4");
  assert.equal(item.ingestKind, "local_file");
  assert.equal(getQueue().some((row) => row.id === item.id && row.localPath === "/tmp/lecture.mp4"), true);
});
