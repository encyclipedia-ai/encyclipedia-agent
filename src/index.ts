#!/usr/bin/env node
import os from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { clearSession, loadConfig, saveConfig, configPath } from "./config.js";
import { ensureFreshToken, signInWithPassword } from "./auth.js";
import * as api from "./api.js";
import { runClip, fulfillRemoteJob } from "./clip.js";
import { ensureTools } from "./tools.js";
import {
  installBackgroundService,
  spawnForegroundDetached,
  stopBackgroundService,
  uninstallBackgroundService,
} from "./service.js";

function usage(): never {
  console.log(`Encylipedia Helper

Install once on a computer at home or in the studio. Then clip from
the web app or phone — this machine downloads YouTube in the background.

  encyclipedia-agent              Sign in and run in the background
  encyclipedia-agent stop         Stop the background helper
  encyclipedia-agent logout       Sign out
  encyclipedia-agent uninstall    Remove the background helper

Power users: start, login, whoami, clip <url>
Config: ${configPath()}
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
  saveConfig(cfg);
  console.log("Sign in with the same email you use at app.encyclipedia.ai");
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);
  cfg = await signInWithPassword(cfg, email, password);
  cfg = await ensureFreshToken(cfg);
  await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  const profile = await api.me(cfg);
  console.log(`Signed in as ${profile.email ?? profile.uid}`);
}

async function ensureSignedIn(): Promise<void> {
  const cfg = loadConfig();
  saveConfig(cfg);
  if (!cfg.idToken) {
    await cmdLogin();
    return;
  }
  try {
    await ensureFreshToken(cfg);
    await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  } catch {
    console.log("Please sign in again.");
    await cmdLogin();
  }
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
  await ensureTools();
  await ensureSignedIn();
  const cfg = await ensureFreshToken(loadConfig());
  await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  await runClip(cfg, url, length);
}

async function cmdStart(): Promise<void> {
  await ensureTools();
  await ensureSignedIn();
  let cfg = await ensureFreshToken(loadConfig());
  await api.register(cfg, `${os.platform()}-${os.arch()}`, os.hostname());
  console.log(`Helper online as ${cfg.email ?? cfg.deviceId}`);
  console.log("Leave this running. Clip from the web app or phone — this machine downloads YouTube.");
  console.log("Ctrl+C to stop.");
  let lastHeartbeat = 0;
  for (;;) {
    cfg = await ensureFreshToken(cfg);
    const now = Date.now();
    if (now - lastHeartbeat >= 15_000) {
      await api.heartbeat(cfg).catch((err: Error) => {
        console.warn(`heartbeat failed: ${err.message}`);
      });
      lastHeartbeat = now;
    }
    let claim: api.ClaimedJob | null = null;
    try {
      claim = await api.claimJob(cfg);
    } catch (err) {
      console.warn(`claim failed: ${err instanceof Error ? err.message : err}`);
    }
    if (claim) {
      console.log(`\nClaimed ${claim.jobId}`);
      console.log(`  ${claim.youtubeUrl}`);
      try {
        await fulfillRemoteJob(cfg, claim);
      } catch (err) {
        console.error(`Job ${claim.jobId} failed: ${err instanceof Error ? err.message : err}`);
      }
      lastHeartbeat = 0;
      continue;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

async function cmdSetup(): Promise<void> {
  console.log("");
  console.log("Encylipedia Helper");
  console.log("This computer will download YouTube so you can clip from anywhere.");
  console.log("");
  console.log("Setting up…");
  await ensureTools();
  await ensureSignedIn();
  try {
    await installBackgroundService();
    console.log("");
    console.log("Helper is running in the background and will start when you log in.");
    console.log("You can close this window. Clip from https://app.encyclipedia.ai/clipper");
    console.log("");
  } catch (err) {
    console.warn(
      `Could not install a background service (${err instanceof Error ? err.message : err}).`,
    );
    console.log("Starting in this window instead. Leave it open.");
    try {
      spawnForegroundDetached();
      console.log("Helper is running. You can close this window.");
    } catch {
      await cmdStart();
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case undefined:
  case "":
  case "setup":
    await cmdSetup();
    break;
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
  case "stop":
    stopBackgroundService();
    console.log("Helper stopped.");
    break;
  case "uninstall":
    uninstallBackgroundService();
    console.log("Background helper removed. Run encyclipedia-agent to set it up again.");
    break;
  default:
    usage();
}
