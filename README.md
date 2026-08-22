# Encylipedia Helper

A small app you install on a computer at home or in the studio.
Leave it open. It shows that it is running, and you can paste a YouTube
URL to clip. Jobs from the web app or your phone also run on this machine.

## Install

Download the app for your computer from the latest release:

**https://github.com/encyclipedia-ai/encyclipedia-agent/releases/latest**

- Mac: `Encylipedia Helper.dmg`
- Windows: `Encylipedia Helper Setup.exe`
- Linux: `.AppImage`

Open it, sign in with the same email you use at
[app.encyclipedia.ai](https://app.encyclipedia.ai), and leave the window open.

That is the whole setup.

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
Config lives at `~/.encyclipedia/agent.json`.
