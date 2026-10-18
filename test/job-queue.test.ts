import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelQueueItem,
  enqueueLocal,
  getQueue,
  queueIsIdle,
  updateQueueItem,
  workSignal,
  type WorkPhase,
} from "../src/job-queue.js";

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

test("cancel aborts the row and later progress cannot revive it", () => {
  const item = enqueueLocal("https://www.youtube.com/watch?v=cancel-me", "short", {
    remoteJobId: "job-cancel-1",
    title: "Cancel me",
  });
  const signal = workSignal(item.id);
  updateQueueItem(item.id, { phase: "download", detail: "Downloading clip window 3/10…" });
  const cancelled = cancelQueueItem(item.id);
  assert.equal(cancelled?.phase, "cancelled");
  assert.equal(signal.aborted, true);
  updateQueueItem(item.id, { phase: "download", detail: "Downloading clip window 4/10…" });
  assert.equal(getQueue().find((row) => row.id === item.id)?.phase, "cancelled");
  assert.equal(cancelQueueItem(item.id), null);
});
