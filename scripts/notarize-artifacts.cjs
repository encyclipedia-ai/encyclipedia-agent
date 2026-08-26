const { notarize } = require("@electron/notarize");

module.exports = async function notarizeArtifacts(buildResult) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) return;

  const paths = (buildResult.artifactPaths ?? []).filter(
    (file) => file.endsWith(".dmg") || file.endsWith(".pkg") || file.endsWith(".zip"),
  );

  for (const appPath of paths) {
    console.log(`Notarizing ${appPath}`);
    await notarize({
      appPath,
      appleId: APPLE_ID,
      appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
      teamId: APPLE_TEAM_ID,
    });
  }
};
