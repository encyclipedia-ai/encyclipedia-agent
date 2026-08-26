const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("builds a private-repository-independent public release manifest", () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "librarian-release-"));
  const outputPath = path.join(fixtureDir, "latest.json");

  try {
    writeFileSync(
      path.join(fixtureDir, "Encyclipedia-Librarian-1.0.0-mac-universal.dmg"),
      "mac",
    );
    writeFileSync(
      path.join(fixtureDir, "Encyclipedia-Librarian-1.0.0-win-x64.exe"),
      "windows",
    );
    writeFileSync(
      path.join(fixtureDir, "Encyclipedia-Librarian-1.0.0-linux-x86_64.AppImage"),
      "linux",
    );
    writeFileSync(
      path.join(fixtureDir, "Encyclipedia-Librarian-0.4.0-mac-universal.dmg"),
      "stale",
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, "../scripts/build-release-manifest.cjs"),
        fixtureDir,
        outputPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RELEASE_PUBLISHED_AT: "2026-08-25T00:00:00.000Z",
          RELEASE_TAG: "agent-v1.0.0",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.tag, "agent-v1.0.0");
    assert.match(manifest.downloads.macos.url, /1\.0\.0-mac-universal\.dmg$/);
    assert.match(manifest.downloads.windows.url, /1\.0\.0-win-x64\.exe$/);
    assert.match(manifest.downloads.linux.url, /1\.0\.0-linux-x86_64\.AppImage$/);
    assert.equal(manifest.downloads.macos.sha256.length, 64);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
