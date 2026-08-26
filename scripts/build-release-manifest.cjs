const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const { version } = require("../package.json");

const releaseDir = path.resolve(process.argv[2] ?? "dist-out");
const outputPath = path.resolve(process.argv[3] ?? path.join(releaseDir, "latest.json"));
const baseUrl = (process.env.LIBRARIAN_DOWNLOAD_BASE_URL ||
  "https://storage.googleapis.com/production-496405-librarian-downloads/librarian/").replace(/\/?$/, "/");

const files = readdirSync(releaseDir);

function selectAsset(platform, predicate) {
  const matches = files.filter(
    (name) => name.includes(`-${version}-`) && predicate(name),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${platform} installer in ${releaseDir}; found ${matches.join(", ") || "none"}.`,
    );
  }

  const name = matches[0];
  const filePath = path.join(releaseDir, name);
  const bytes = readFileSync(filePath);

  return {
    name,
    url: `${baseUrl}${encodeURIComponent(name)}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: statSync(filePath).size,
  };
}

const manifest = {
  schemaVersion: 1,
  channel: "stable",
  version,
  tag: process.env.RELEASE_TAG || `agent-v${version}`,
  publishedAt: process.env.RELEASE_PUBLISHED_AT || new Date().toISOString(),
  releaseNotesUrl: "https://encyclipedia.ai/librarian",
  downloads: {
    macos: selectAsset(
      "macOS",
      (name) => name.endsWith(".dmg") && !name.endsWith(".dmg.blockmap"),
    ),
    windows: selectAsset(
      "Windows",
      (name) => name.endsWith(".exe") && !name.endsWith(".exe.blockmap"),
    ),
    linux: selectAsset("Linux", (name) => name.endsWith(".AppImage")),
  },
};

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote Librarian ${version} manifest to ${outputPath}.`);
