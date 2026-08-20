#!/usr/bin/env node
import os from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { clearSession, loadConfig, saveConfig, configPath } from "./config.js";
import { ensureFreshToken, signInWithPassword } from "./auth.js";
import * as api from "./api.js";
import { runClip } from "./clip.js";

function usage(): never {
  console.log(`encyclipedia-agent — local YouTube ingest helper

Usage:
  encyclipedia-agent login
  encyclipedia-agent logout
  encyclipedia-agent whoami
  encyclipedia-agent clip <youtube-url> [--length short|medium]
  encyclipedia-agent start

Environment:
  ENCYCLIPEDIA_API_URL              default http://localhost:3001
  ENCYCLIPEDIA_FIREBASE_API_KEY     Firebase web API key
  FIREBASE_AUTH_EMULATOR_HOST       optional, e.g. localhost:9099

Requires yt-dlp on PATH. Config: ${configPath()}
`);
  process.exit(1);
}

async function prompt(question: string, hidden = false): Promise<string> {
  if (!hidden) {
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
  output.write(question);
  return await new Promise((resolve) => {
    const stdin = input;
    const wasRaw = stdin.isRaw;
    const chunks: Buffer[] = [];
    stdin.setRawMode?.(true);
    stdin.resume();
    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (s === "\n" || s === "\r") {
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        stdin.off("data", onData);
        output.write("\n");
        resolve(Buffer.concat(chunks).toString("utf8").trim());
        return;
      }
      if (s === "\u0003") process.exit(1);
      if (s === "\u007f") {
        chunks.pop();
        return;
      }
      chunks.push(buf);
    };
    stdin.on("data", onData);
  });
}

async function cmdLogin(): Promise<void> {
  let cfg = loadConfig();
  if (!cfg.firebaseApiKey) {
    cfg.firebaseApiKey = await prompt("Firebase API key: ");
    saveConfig(cfg);
  }
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);
  cfg = await signInWithPassword(cfg, email, password);
  cfg = await ensureFreshToken(cfg);
  await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  const profile = await api.me(cfg);
  console.log(`Signed in as ${profile.email ?? profile.uid}`);
}

async function cmdWhoami(): Promise<void> {
  const cfg = await ensureFreshToken(loadConfig());
  const profile = await api.me(cfg);
  console.log(JSON.stringify({ ...profile, deviceId: cfg.deviceId, apiUrl: cfg.apiUrl }, null, 2));
}

async function cmdClip(args: string[]): Promise<void> {
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) usage();
  let length: "short" | "medium" = "short";
  const li = args.indexOf("--length");
  if (li >= 0 && args[li + 1] === "medium") length = "medium";
  const cfg = await ensureFreshToken(loadConfig());
  await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  await runClip(cfg, url, length);
}

async function cmdStart(): Promise<void> {
  let cfg = await ensureFreshToken(loadConfig());
  await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  console.log(`Helper online as device ${cfg.deviceId}`);
  console.log("Web-submitted awaiting_media jobs are not wired yet; use `clip <url>`.");
  console.log("Ctrl+C to stop.");
  for (;;) {
    cfg = await ensureFreshToken(cfg);
    await api.heartbeat(cfg).catch((err: Error) => {
      console.warn(`heartbeat failed: ${err.message}`);
    });
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "login":
    await cmdLogin();
    break;
  case "logout":
    clearSession(loadConfig());
    console.log("Signed out.");
    break;
  case "whoami":
    await cmdWhoami();
    break;
  case "clip":
    await cmdClip(rest);
    break;
  case "start":
    await cmdStart();
    break;
  default:
    usage();
}
