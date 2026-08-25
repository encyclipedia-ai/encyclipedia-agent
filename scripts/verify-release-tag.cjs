const { version } = require("../package.json");

const expected = `agent-v${version}`;
const actual = process.env.RELEASE_TAG;

if (actual !== expected) {
  console.error(`Release tag ${actual || "<missing>"} must match ${expected}.`);
  process.exit(1);
}

console.log(`Release tag ${actual} matches package version ${version}.`);
