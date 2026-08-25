const path = require("node:path");
const { notarize } = require("@electron/notarize");

module.exports = async function notarizeMac(context) {
  if (context.electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("Apple notarization credentials are absent; publishing unsigned macOS artifacts.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  await notarize({
    appPath: path.join(context.appOutDir, `${appName}.app`),
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
};
