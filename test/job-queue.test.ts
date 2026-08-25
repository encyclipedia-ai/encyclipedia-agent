import assert from "node:assert/strict";
import test from "node:test";
import { queueIsIdle, type WorkPhase } from "../src/job-queue.js";

test("queue is idle when it is empty or all jobs are terminal", () => {
  assert.equal(queueIsIdle([], false), true);
  assert.equal(queueIsIdle([{ phase: "done" }, { phase: "error" }], false), true);
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
