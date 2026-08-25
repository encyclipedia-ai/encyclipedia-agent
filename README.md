# Encyclipedia Librarian

Librarian is the required desktop companion for encyclipedia.ai. It securely
downloads source media on your computer, scans captions for viral moments, and
hands media to the renderer. Jobs submitted from the web app wait until a
signed-in Librarian is online.

## Install

Download the app for your computer from the latest release:

**https://github.com/encyclipedia-ai/encyclipedia-agent/releases/latest**

- Mac: `Encyclipedia Librarian.dmg`
- Windows: `Encyclipedia Librarian Setup.exe`
- Linux: `.AppImage`

Open it, sign in with the same email you use at
[app.encyclipedia.ai](https://app.encyclipedia.ai), and leave the window open.

The onboarding page detects the signed-in app automatically. Keep Librarian
open whenever you submit or edit clips.

## Automatic updates

Packaged apps check GitHub Releases automatically and download updates in the
background. Librarian installs and relaunches only when its queue contains no
queued, local, or renderer-waiting jobs and no sign-in window is open. Completed
and failed jobs do not block an update. Development sessions never contact the
release feed.

## Developers

```bash
pnpm install
pnpm app          # desktop window
pnpm dev          # CLI
```

```bash
export ENCYCLIPEDIA_API_URL=http://localhost:3001
export FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
pnpm app
```

Package locally: `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux`.

Releases are built by `.github/workflows/release.yml` on `agent-v*` tags.
The tag must match `package.json`. Apple and Windows certificate secrets are
optional in CI, but production macOS auto-updates should be signed and notarized;
Windows Authenticode signing avoids trust warnings. Manual workflow runs publish
prerelease nightlies and do not replace the stable update feed.
Config lives at `~/.encyclipedia/agent.json`.
