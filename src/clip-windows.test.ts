import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_STORY_UPLOAD_SEC,
  MIN_SUMMARY_SEC,
  planSubjectStoryScenes,
  STORY_CONTEXT_SEC,
  SUBJECT_BRIDGE_SEC,
  uploadWindowForClip,
} from "./clip-windows.js";

describe("planSubjectStoryScenes", () => {
  it("keeps the conversation between same-subject moments", () => {
    const scenes = planSubjectStoryScenes([
      { startSec: 10, endSec: 25, durationSec: 15, category: "The office interview" },
      { startSec: 95, endSec: 310, durationSec: 215, category: "The office interview" },
    ]);
    assert.equal(scenes.length, 1);
    assert.equal(scenes[0]?.startSec, Math.max(0, 10 - STORY_CONTEXT_SEC));
    assert.equal(scenes[0]?.endSec, 310 + STORY_CONTEXT_SEC);
    assert.ok(scenes[0]!.endSec - scenes[0]!.startSec >= MIN_SUMMARY_SEC);
  });

  it("splits different subjects that are long enough", () => {
    const scenes = planSubjectStoryScenes([
      { startSec: 10, endSec: 300, durationSec: 290, category: "PhotoJoe lies" },
      { startSec: 400, endSec: 720, durationSec: 320, category: "Turbo reacts" },
    ]);
    assert.equal(scenes.length, 2);
  });

  it("drops a lone short subject", () => {
    const scenes = planSubjectStoryScenes([
      { startSec: 10, endSec: 25, durationSec: 15, category: "PhotoJoe lies" },
      { startSec: 200, endSec: 220, durationSec: 20, category: "Turbo reacts" },
    ]);
    assert.deepEqual(scenes, []);
  });

  it("splits a subject that returns after a long gap", () => {
    const scenes = planSubjectStoryScenes([
      { startSec: 10, endSec: 300, durationSec: 290, category: "Same" },
      {
        startSec: 300 + SUBJECT_BRIDGE_SEC + 10,
        endSec: 300 + SUBJECT_BRIDGE_SEC + 320,
        durationSec: 310,
        category: "Same",
      },
    ]);
    assert.equal(scenes.length, 2);
  });

  it("chunks a very long discussion for upload", () => {
    const scenes = planSubjectStoryScenes([
      {
        startSec: 0,
        endSec: MAX_STORY_UPLOAD_SEC + 80,
        durationSec: MAX_STORY_UPLOAD_SEC + 80,
        category: "Long talk",
      },
    ]);
    assert.ok(scenes.length >= 2);
    assert.ok(scenes.every((scene) => scene.endSec - scene.startSec <= MAX_STORY_UPLOAD_SEC));
  });
});

describe("uploadWindowForClip", () => {
  it("does not grow the Gemini window to cover a long story scene", () => {
    const window = uploadWindowForClip(
      { startSec: 100, endSec: 120, durationSec: 20 },
      [{ startSec: 0, endSec: 900 }],
      1000,
    );
    assert.ok(window.durationSec <= 6 * 60);
    assert.ok(window.startSec >= 40);
    assert.ok(window.startSec + window.durationSec <= 180);
  });
});
