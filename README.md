# Encyclipedia Librarian

Librarian is the required desktop companion for
[encyclipedia.ai](https://encyclipedia.ai). The
[web product](https://github.com/encyclipedia-ai/encyclipedia-web-app) cannot
download source media in Cloud Run, so submitted jobs wait for a signed-in
Librarian on the user's computer.

## Product role

Sign in with the same Firebase account used at
[app.encyclipedia.ai](https://app.encyclipedia.ai). Librarian registers the
device with the
[standalone API](https://github.com/encyclipedia-ai/encyclipedia-api), then
sends a heartbeat about every 15 seconds. The web app records onboarding
completion only after it confirms that a registered Librarian is online.
Keep the app or background service running whenever submitting or recutting
clips.

For a normal process job, Librarian:

1. claims the next `awaiting_media` job for the signed-in user;
2. looks up and downloads the YouTube source on that computer;
3. downloads captions and asks the API to analyze them for clip candidates
   when captions are available;
4. requests upload targets and uploads source media and captions directly to
   storage;
5. completes the claim through the API, including source metadata and the
   optional clip plan;
6. waits while the API queues the
   [renderer](https://github.com/encyclipedia-ai/viral-clip-extractor), then
   reports completion in the desktop queue.

Recuts use the same claim/handoff contract but download and upload only the
requested time window. If captions are missing or cannot be parsed, Librarian
still uploads the media and leaves analysis to the renderer.

## Install and sign in

Download the latest release:

<https://github.com/encyclipedia-ai/encyclipedia-agent/releases/latest>

- macOS: `.dmg`
- Windows: NSIS `.exe`
- Linux: `.AppImage`

The desktop app supports email/password and Google sign-in. Session tokens and
the stable device ID are stored with mode `0600` in
`~/.encyclipedia/agent.json`; do not share or commit that file. Firebase ID
tokens are refreshed automatically, and an unauthorized API response forces
one token refresh before failing.

## Browser cookies

Downloads first try without browser cookies. If YouTube requires login or
age verification, Librarian discovers supported signed-in browser profiles
and rotates through them:

- Chrome, Edge, Brave, Safari, and Firefox on macOS;
- Chrome, Edge, Brave, and Firefox on Windows;
- Chrome/Chromium, Brave, and Firefox on Linux.

The first profile accepted by YouTube is preferred for later downloads in the
same running process. If reading that profile later fails, Librarian clears
the preference and rotates through available profiles again, then tries an
embedded-player fallback. It does not ask users to export cookies into this
repository. Sign in to YouTube in a supported browser when protected content
requires it.

## Development

Prerequisites are Node 20+ and pnpm. The app downloads/manages its required
media tools at runtime.

```bash
pnpm install
pnpm app        # compile and open the Electron desktop UI
pnpm dev        # run the optional CLI from TypeScript
pnpm build
pnpm typecheck
```

For the local API and Firebase Auth emulator:

```bash
ENCYCLIPEDIA_API_URL=http://localhost:3001 \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
pnpm app
```

Start those services from the API and web repositories first. The API must
share the same Firebase project/emulator as the web app or the accounts and
presence records will not match.

The CLI is optional:

```bash
pnpm dev                 # interactive setup, sign-in, background install
pnpm dev -- start        # stay in the foreground and claim work
pnpm dev -- stop
pnpm dev -- logout
pnpm dev -- uninstall
```

Interactive setup installs a per-user startup service where supported:
LaunchAgent on macOS, `systemd --user` on Linux, or an on-logon Scheduled Task
on Windows. The service starts Librarian's `start` command, restarts when
appropriate, and writes logs under `~/.encyclipedia`. If service installation
fails, setup falls back to a detached foreground process.

## Packaging and releases

Build unsigned local installers into `release/`:

```bash
pnpm dist:mac
pnpm dist:win
pnpm dist:linux
```

`.github/workflows/release.yml` packages all three platforms and publishes a
GitHub release for `agent-v*` tags:

```bash
git tag agent-v0.3.1
git push origin agent-v0.3.1
```

Manual workflow dispatch publishes an `agent-nightly-<run-id>` release. The
current workflow disables automatic macOS signing; signing/notarization must
be added before claiming a trusted production installer.
