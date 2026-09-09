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

Pasting is no longer how Librarian starts a job. Choose a video file on this
computer; Librarian uses the same `POST /api/process` path as the web clipper,
so the job appears on the dashboard immediately as `awaiting_media`. Librarian
then finds clip timestamps and uploads **only those short windows** (plus
cheap audio when captions are missing). The full volume stays on this
computer. Jobs submitted from the web clipper (YouTube, Twitch, Kick) are
still claimed here and downloaded with yt-dlp — again, only the detected
clip windows are uploaded.

For a desktop file job, Librarian:

1. creates the Firestore job (`POST /api/process` with the filename);
2. probes and, if needed, remuxes the file to mp4 on this computer;
3. extracts a small audio file, transcribes it, and scans for viral moments;
4. cuts and uploads only those clip windows to storage (not the full file);
5. completes the job through the API with the clip plan and window keys;
6. waits while the API queues the
   [renderer](https://github.com/encyclipedia-ai/viral-clip-extractor), then
   reports completion in the desktop queue.

For a web-submitted process job, Librarian claims the next `awaiting_media`
job, prefers YouTube captions (no VOD download), transcribes audio only when
captions are missing, then downloads and uploads each clip window with
yt-dlp `--download-sections`.

Recuts use the same claim/handoff contract. Web-origin recuts download a time
window with yt-dlp. Recuts of desktop-uploaded volumes fetch a covering clip
window (windows are padded ~15s) and cut it with ffmpeg. Large timing changes
that fall outside those windows are not stored in the cloud.

## Install and sign in

Download the latest release:

<https://encyclipedia.ai/librarian>

- macOS: `.dmg`
- Windows: NSIS `.exe`
- Linux: `.AppImage`

The desktop app supports email/password and Google sign-in. Session tokens and
the stable device ID are stored with mode `0600` in
`~/.encyclipedia/agent.json`; do not share or commit that file. Firebase ID
tokens are refreshed automatically, and an unauthorized API response forces
one token refresh before failing.

## Automatic updates

Packaged apps check the public
`https://downloads.encyclipedia.ai/librarian/` feed automatically and download
updates in the background. The source repository can remain private because the
feed contains only installers, blockmaps, checksums, and update metadata.
Librarian installs and relaunches only when its queue has no queued, local, or
renderer-waiting jobs and no sign-in window is open. Completed and failed jobs
do not block an update. Development sessions do not contact the release feed.

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
pnpm dev -- clip ./talk.mp4 [--length medium]
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

`.github/workflows/release.yml` packages all three platforms, archives a GitHub
release, and publishes stable tagged builds to the public GCS/CDN feed:

```bash
git tag agent-v1.0.0
git push origin agent-v1.0.0
```

The tag must match `package.json`. Manual workflow dispatch publishes a
prerelease `agent-nightly-<run-id>` and does not replace the stable update feed.
The repository variables `GCP_WIF_PROVIDER`, `GCP_RELEASE_SA`, and
`GCP_DOWNLOADS_BUCKET` authorize tagged workflows through short-lived Workload
Identity Federation credentials; no service-account key is stored in GitHub.
Apple and Windows certificate secrets are optional, so CI still produces
unsigned installers until credentials are configured. Reliable production
macOS auto-updates should be signed and notarized; Windows Authenticode signing
avoids trust warnings.
