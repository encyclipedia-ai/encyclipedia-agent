# encyclipedia-agent

Cross-platform **local helper** for encyclipedia clip jobs.

YouTube blocks Cloud Run (and often residential proxies) from downloading
video files. This helper runs on the customer's computer — Windows, macOS,
or Linux — so yt-dlp uses **their** ISP IP. Cloud workers still do LLM
detection, autocrop, and publish.

A GUI desktop app is unnecessary for v1: any machine with Node 20+ and
yt-dlp can run the same commands. Wrap this CLI in Electron/Tauri later
if you want a window.

## Requirements

- Node.js 20+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) on `PATH`
- An encyclipedia account (same Firebase login as the web app)

## Setup

```bash
cp .env.example .env   # or export the vars
pnpm install
pnpm build
pnpm start login
```

```bash
export ENCYCLIPEDIA_API_URL=https://api.encyclipedia.ai
export ENCYCLIPEDIA_FIREBASE_API_KEY=...   # same as NEXT_PUBLIC_FIREBASE_API_KEY

encyclipedia-agent login
encyclipedia-agent clip 'https://www.youtube.com/watch?v=VIDEO_ID'
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
| `clip <url>` | Download locally, upload to GCS, enqueue the existing worker |
| `start` | Heartbeat loop (web `awaiting_media` claim comes next) |

`--length medium` is supported on `clip`.

## How it fits

```
helper (this repo)                 cloud
  yt-dlp dump-json + download
  PUT source.mp4 + captions  →  GCS (signed URL from API)
  POST /api/agent/jobs       →  Pub/Sub clip.process.requested
                                    ↓
                               Cloud Run worker
                               (no YouTube media fetch)
                               detect + ffmpeg cut + autocrop
```

The worker still runs on the node cluster. This repo only replaces
**YouTube video download**.

## Web / mobile later

`GET /api/agent/jobs/next` is reserved for jobs the dashboard creates in
`awaiting_media`. Until that status is written by `POST /process`, submit
URLs with `clip` (or paste the URL in this helper).
