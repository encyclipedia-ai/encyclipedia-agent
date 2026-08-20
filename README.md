# encyclipedia-agent

Cross-platform **local helper** for encyclipedia clip jobs.

YouTube blocks Cloud Run (and often residential proxies) from downloading
video files. This helper runs on the customer's computer — Windows, macOS,
or Linux — so yt-dlp uses **their** ISP IP. Cloud workers still do LLM
detection, autocrop, and publish.

A GUI desktop app is unnecessary for v1: any machine with Node 20+ and
yt-dlp can run the same commands. Wrap this CLI in Electron/Tauri later
if you want a window.

## Setup (like a self-hosted Cursor agent)

1. Install Node 20+ and [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) on PATH.
2. Sign in once on that machine.
3. Leave `start` running. Clip from the web app or phone from anywhere.

```bash
cp .env.example .env   # or export the vars
pnpm install
pnpm build

export ENCYCLIPEDIA_API_URL=https://api.encyclipedia.ai
export ENCYCLIPEDIA_FIREBASE_API_KEY=...   # same as NEXT_PUBLIC_FIREBASE_API_KEY

encyclipedia-agent login
encyclipedia-agent start
```

Dev against emulators:

```bash
export ENCYCLIPEDIA_API_URL=http://localhost:3001
export FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
export ENCYCLIPEDIA_FIREBASE_API_KEY=fake-api-key
```

Config is stored at `~/.encyclipedia/agent.json` (mode 0600).

## Commands

| Command | What it does |
| --- | --- |
| `login` | Firebase email/password; registers this device |
| `logout` | Drop the stored session |
| `whoami` | Print uid / email / device id |
| `start` | Heartbeat + claim loop. Leave this running to accept web/mobile jobs |
| `clip <url>` | Download locally and enqueue immediately (no waiting job) |

`--length medium` is supported on `clip`.

## Remote clip flow

```
phone / web                    this machine                         cloud
  POST /process  ─────────►  job status=awaiting_media
  (from anywhere)                 │
                                  ├ start polls POST /agent/jobs/claim
                                  ├ yt-dlp download + captions
                                  ├ PUT source.mp4 → GCS
                                  └ POST /agent/jobs/:id/complete ─► Pub/Sub
                                                                      │
                                                               Cloud Run worker
                                                               (no YouTube fetch)
                                                               detect + ffmpeg + autocrop
```

`clip <url>` skips the waiting-job step: it uploads first, then
`POST /api/agent/jobs` creates a `queued` job immediately.
