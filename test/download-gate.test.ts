import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadGate } from "../src/download-gate.js";

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function holdGate(gate: ReturnType<typeof createDownloadGate>) {
  const release: Array<() => void> = [];
  let active = 0;
  let max = 0;
  const start = () =>
    gate.shared(
      () =>
        new Promise<void>((resolve) => {
          active += 1;
          max = Math.max(max, active);
          release.push(() => {
            active -= 1;
            resolve();
          });
        }),
    );
  return { release, start, get active() { return active; }, get max() { return max; } };
}

test("two downloads overlap and the third waits", async () => {
  const gate = createDownloadGate({ slots: 2, gapMs: 0, sleep: async () => {}, now: () => 0 });
  const held = holdGate(gate);
  const first = held.start();
  const second = held.start();
  const third = held.start();
  await flush();
  assert.equal(held.max, 2);
  assert.equal(held.release.length, 2);

  held.release[0]?.();
  await flush();
  assert.equal(held.release.length, 3);

  held.release[1]?.();
  held.release[2]?.();
  await Promise.all([first, second, third]);
});

test("overlapping downloads start a second apart", async () => {
  let clock = 0;
  const slept: number[] = [];
  const gate = createDownloadGate({
    slots: 2,
    gapMs: 1_000,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  const started: number[] = [];
  const release: Array<() => void> = [];
  const start = () =>
    gate.shared(
      () =>
        new Promise<void>((resolve) => {
          started.push(clock);
          release.push(resolve);
        }),
    );
  const first = start();
  const second = start();
  await flush();
  assert.deepEqual(slept, [1_000]);
  assert.deepEqual(started, [0, 1_000]);
  release[0]?.();
  release[1]?.();
  await Promise.all([first, second]);
});

test("a block finishes the current downloads before starting another", async () => {
  const gate = createDownloadGate({ slots: 2, gapMs: 0, sleep: async () => {}, now: () => 0 });
  const held = holdGate(gate);
  const first = held.start();
  const second = held.start();
  await flush();
  gate.noteBlocked();
  const third = held.start();
  await flush();
  assert.equal(held.release.length, 2);

  held.release[0]?.();
  await flush();
  assert.equal(held.release.length, 2);

  held.release[1]?.();
  await flush();
  assert.equal(held.release.length, 3);
  held.release[2]?.();
  await Promise.all([first, second, third]);
  assert.equal(gate.serial, true);
});

test("an exclusive download waits for the slots, then the slots wait for it", async () => {
  const gate = createDownloadGate({ slots: 2, gapMs: 0, sleep: async () => {}, now: () => 0 });
  let exclusiveRan = false;
  let sharedAfter = false;
  let releaseShared: (() => void) | undefined;
  const shared = gate.shared(
    () =>
      new Promise<void>((resolve) => {
        releaseShared = resolve;
      }),
  );
  const exclusive = gate.exclusive(async () => {
    exclusiveRan = true;
  });
  const later = gate.shared(async () => {
    sharedAfter = true;
  });
  await flush();
  assert.equal(exclusiveRan, false);
  assert.equal(sharedAfter, false);

  releaseShared?.();
  await shared;
  await flush();
  assert.equal(exclusiveRan, true);
  await exclusive;
  await later;
  assert.equal(sharedAfter, true);
});

test("exclusive recovery can refresh yt-dlp without deadlocking", async () => {
  const gate = createDownloadGate({ slots: 2, gapMs: 0, sleep: async () => {}, now: () => 0 });
  let inner = false;
  await gate.exclusive(async () => {
    await gate.exclusive(async () => {
      inner = true;
    });
  });
  assert.equal(inner, true);
});

test("opening the gate again lets a waiting download share a slot", async () => {
  const gate = createDownloadGate({ slots: 2, gapMs: 0, sleep: async () => {}, now: () => 0 });
  const held = holdGate(gate);
  const first = held.start();
  await flush();
  gate.noteBlocked();
  const second = held.start();
  await flush();
  assert.equal(held.release.length, 1);

  gate.allowParallel();
  await flush();
  assert.equal(held.release.length, 2);
  assert.equal(gate.serial, false);
  held.release[0]?.();
  held.release[1]?.();
  await Promise.all([first, second]);
});
