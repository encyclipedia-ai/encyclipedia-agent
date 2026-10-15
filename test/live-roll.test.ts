import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIVE_CHUNK_SEC,
  LIVE_EDGE_LAG_SEC,
  LIVE_MIN_WINDOW_SEC,
  LiveRoll,
  advanceCoveredUntil,
  nextDashWindow,
  type RollProfile,
} from "../src/live-roll.js";

function profile(partial: Partial<RollProfile> & Pick<RollProfile, "platform">): RollProfile {
  return {
    connection: "connected",
    platformUserId: "channel-1",
    handle: "mau",
    displayName: "Mau",
    profileUrl: "https://example.test/mau",
    check: "ok",
    live: {
      status: "is_live",
      streamUrl: "https://example.test/live",
      videoId: "stream-1",
      title: "Live",
      startedAt: 1_000,
    },
    ...partial,
  };
}

describe("dash windows", () => {
  it("waits until a minimum window is behind the live edge", () => {
    assert.equal(nextDashWindow(0, LIVE_EDGE_LAG_SEC + LIVE_MIN_WINDOW_SEC - 1), null);
    const ready = nextDashWindow(0, LIVE_EDGE_LAG_SEC + LIVE_MIN_WINDOW_SEC);
    assert.deepEqual(ready, { startSec: 0, endSec: LIVE_MIN_WINDOW_SEC });
  });

  it("caps a chunk and overlaps the next one", () => {
    const first = nextDashWindow(0, 10_000);
    assert.deepEqual(first, { startSec: 0, endSec: LIVE_CHUNK_SEC });
    const covered = advanceCoveredUntil(first!.endSec);
    const second = nextDashWindow(covered, 10_000);
    assert.equal(second?.startSec, covered);
    assert.equal((first?.endSec ?? 0) - (second?.startSec ?? 0), 20);
  });
});

describe("LiveRoll", () => {
  it("starts a dash chunk when YouTube goes live and stops when it ends", () => {
    const roll = new LiveRoll();
    const startedAt = 1_000;
    roll.observe([
      profile({
        platform: "youtube",
        live: {
          status: "is_live",
          streamUrl: "https://www.youtube.com/watch?v=abcdefghijk",
          videoId: "abcdefghijk",
          title: "Show",
          startedAt,
        },
      }),
    ]);
    const tooSoon = roll.nextChunk((startedAt + 10) * 1000);
    assert.equal(tooSoon, null);
    const chunk = roll.nextChunk((startedAt + LIVE_EDGE_LAG_SEC + LIVE_CHUNK_SEC) * 1000);
    assert.equal(chunk?.mode, "dash");
    assert.equal(chunk?.startSec, 0);
    assert.equal(chunk?.endSec, LIVE_CHUNK_SEC);
    assert.equal(roll.nextChunk((startedAt + 10_000) * 1000), null);
    roll.complete(chunk!);
    roll.observe([profile({ platform: "youtube", live: null })]);
    assert.equal(roll.nextChunk((startedAt + 10_000) * 1000), null);
  });

  it("records Twitch from the live edge and retries the same chunk after a failure", () => {
    const roll = new LiveRoll();
    roll.observe([
      profile({
        platform: "twitch",
        live: {
          status: "is_live",
          streamUrl: "https://www.twitch.tv/mau",
          videoId: "99",
          title: "Hello",
          startedAt: 1_000,
        },
      }),
    ]);
    const first = roll.nextChunk(Date.now());
    assert.equal(first?.mode, "edge");
    assert.equal(first?.startSec, 0);
    assert.equal(first?.durationSec, LIVE_CHUNK_SEC);
    roll.abandon(first!, 5_000);
    assert.equal(roll.nextChunk(5_000), null);
    const retry = roll.nextChunk(5_000 + 60_000);
    assert.equal(retry?.startSec, 0);
    roll.complete(retry!);
    const second = roll.nextChunk(Date.now());
    assert.equal(second?.startSec, LIVE_CHUNK_SEC);
  });

  it("does not open a session when the check failed", () => {
    const roll = new LiveRoll();
    roll.observe([profile({ platform: "kick", check: "failed", live: null })]);
    assert.equal(roll.nextChunk(Date.now()), null);
  });

  it("records only YouTube when every platform is live", () => {
    const roll = new LiveRoll();
    const startedAt = 1_000;
    const readyAt = (startedAt + LIVE_EDGE_LAG_SEC + LIVE_CHUNK_SEC) * 1000;
    roll.observe([
      profile({ platform: "kick" }),
      profile({ platform: "twitch" }),
      profile({
        platform: "youtube",
        live: {
          status: "is_live",
          streamUrl: "https://www.youtube.com/watch?v=abcdefghijk",
          videoId: "abcdefghijk",
          title: "Show",
          startedAt,
        },
      }),
    ]);
    const first = roll.nextChunk(readyAt);
    assert.equal(first?.platform, "youtube");
    roll.complete(first!);
    assert.equal(roll.nextChunk((startedAt + 10_000) * 1000)?.platform, "youtube");
  });

  it("waits for a YouTube window instead of recording another live platform", () => {
    const roll = new LiveRoll();
    const startedAt = 1_000;
    roll.observe([
      profile({ platform: "twitch" }),
      profile({
        platform: "youtube",
        live: {
          status: "is_live",
          streamUrl: "https://www.youtube.com/watch?v=abcdefghijk",
          videoId: "abcdefghijk",
          title: "Show",
          startedAt,
        },
      }),
    ]);
    assert.equal(roll.nextChunk((startedAt + 10) * 1000), null);
  });

  it("uses Twitch only while YouTube is offline, then switches after the current chunk", () => {
    const roll = new LiveRoll();
    const startedAt = 1_000;
    const readyAt = (startedAt + LIVE_EDGE_LAG_SEC + LIVE_CHUNK_SEC) * 1000;
    roll.observe([profile({ platform: "kick" }), profile({ platform: "twitch" })]);
    const twitch = roll.nextChunk(readyAt);
    assert.equal(twitch?.platform, "twitch");
    roll.observe([
      profile({ platform: "kick" }),
      profile({ platform: "twitch" }),
      profile({
        platform: "youtube",
        live: {
          status: "is_live",
          streamUrl: "https://www.youtube.com/watch?v=abcdefghijk",
          videoId: "abcdefghijk",
          title: "Show",
          startedAt,
        },
      }),
    ]);
    assert.equal(roll.nextChunk(readyAt), null);
    roll.complete(twitch!);
    assert.equal(roll.nextChunk(readyAt)?.platform, "youtube");
  });
});
