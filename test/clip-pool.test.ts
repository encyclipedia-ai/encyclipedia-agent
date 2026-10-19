import assert from "node:assert/strict";
import test from "node:test";
import { rememberCategory, runOrderedPool } from "../src/clip-pool.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("rememberCategory keeps the first spelling", () => {
  const names: string[] = [];
  rememberCategory(names, " The boss fight ");
  rememberCategory(names, "the boss fight");
  rememberCategory(names, "A second subject");
  assert.deepEqual(names, ["The boss fight", "A second subject"]);
});

test("runOrderedPool checks three windows and hands them off in order", async () => {
  const started: number[] = [];
  const finished: number[] = [];
  const open: Array<(value: number) => void> = [];
  const done = runOrderedPool({
    count: 5,
    limit: 3,
    start(index) {
      started.push(index);
      return new Promise<number>((resolve) => {
        open[index] = resolve;
      });
    },
    async finish(index) {
      finished.push(index);
    },
  });

  await tick();
  assert.deepEqual(started, [0, 1, 2]);

  open[2]?.(2);
  await tick();
  assert.deepEqual(finished, []);
  assert.deepEqual(started, [0, 1, 2]);

  open[0]?.(0);
  await tick();
  await tick();
  assert.deepEqual(finished, [0]);
  assert.deepEqual(started, [0, 1, 2, 3]);

  open[1]?.(1);
  await tick();
  await tick();
  assert.deepEqual(finished, [0, 1, 2]);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);

  open[3]?.(3);
  open[4]?.(4);
  await done;
  assert.deepEqual(finished, [0, 1, 2, 3, 4]);
});

test("runOrderedPool stops handing windows off when a check fails", async () => {
  const finished: number[] = [];
  const open: Array<(value: number) => void> = [];
  let rejectFirst: (error: unknown) => void = () => {};
  const done = runOrderedPool({
    count: 3,
    limit: 3,
    start(index) {
      if (index === 1) return new Promise<number>((_resolve, reject) => {
        rejectFirst = reject;
      });
      return new Promise<number>((resolve) => {
        open[index] = resolve;
      });
    },
    async finish(index) {
      finished.push(index);
    },
  });

  await tick();
  open[0]?.(0);
  await tick();
  await tick();
  assert.deepEqual(finished, [0]);
  rejectFirst(new Error("gemini failed"));
  open[2]?.(2);
  await assert.rejects(done, /gemini failed/);
  assert.deepEqual(finished, [0]);
});
