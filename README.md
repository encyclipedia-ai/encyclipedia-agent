# Encylipedia Helper

Install this **once** on a computer at home or in the studio. Then clip
from the web app or your phone. This machine downloads YouTube; encyclipedia
does the rest in the cloud.

You do **not** need Node, Homebrew, or yt-dlp. The installer sets those up.

## Install

**Mac or Linux** — paste this in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/encyclipedia-ai/encyclipedia-agent/main/install.sh | bash
```

**Windows** — paste this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/encyclipedia-ai/encyclipedia-agent/main/install.ps1 | iex
```

Sign in with the same email you use at [app.encyclipedia.ai](https://app.encyclipedia.ai).
The helper then runs in the background and starts when you log in.

That is the whole setup. Clip from https://app.encyclipedia.ai/clipper

## Commands (optional)

| Command | What it does |
| --- | --- |
| `encyclipedia-agent` | Sign in (if needed) and run in the background |
| `encyclipedia-agent stop` | Stop the background helper |
| `encyclipedia-agent logout` | Sign out |
| `encyclipedia-agent uninstall` | Remove the login-item / startup task |

Power users: `start` (foreground), `clip <url>`.

## Developers

```bash
export ENCYCLIPEDIA_API_URL=http://localhost:3001
export FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
pnpm install
pnpm dev
```

Prebuilt binaries are published from `.github/workflows/release.yml` on
`agent-v*` tags. Config lives at `~/.encyclipedia/agent.json`.
