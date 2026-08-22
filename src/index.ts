#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { configPath } from "./config.js";
import {
  clipFromUrl,
  restoreSession,
  signIn,
  signOut,
  startHelperLoop,
} from "./runtime.js";
import { ensureTools } from "./tools.js";
import {
  installBackgroundService,
  spawnForegroundDetached,
  stopBackgroundService,
  uninstallBackgroundService,
} from "./service.js";

function usage(): never {
  console.log(`Encylipedia Helper

Open the desktop app to clip. This CLI is optional.

  encyclipedia-agent              Sign in and run in the background
  encyclipedia-agent stop         Stop the background helper
  encyclipedia-agent logout       Sign out
  encyclipedia-agent uninstall    Remove the background helper

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
  console.log("Sign in with the same email you use at app.encyclipedia.ai");
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);
  const cfg = await signIn(email, password);
  console.log(`Signed in as ${cfg.email ?? cfg.uid}`);
}

async function cmdStart(): Promise<void> {
  for (;;) {
    const session = await restoreSession();
    if (!session) await cmdLogin();
    await new Promise<void>((resolve) => {
      const stop = startHelperLoop((snap) => {
        console.log(snap.message);
        if (snap.status === "signed_out") {
          stop();
          resolve();
        }
      });
    });
  }
}

async function cmdSetup(): Promise<void> {
  console.log("");
  console.log("Encylipedia Helper");
  console.log("Prefer the desktop app: pnpm app   (or the downloaded Helper.app)");
  console.log("");
  await ensureTools();
  const session = await restoreSession();
  if (!session) await cmdLogin();
  try {
    await installBackgroundService();
    console.log("Helper is running in the background and will start when you log in.");
    console.log("Clip from https://app.encyclipedia.ai/clipper");
  } catch (err) {
    console.warn(
      `Could not install a background service (${err instanceof Error ? err.message : err}).`,
    );
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
    signOut();
    console.log("Signed out.");
    break;
  case "clip": {
    const url = rest.find((a) => !a.startsWith("--"));
    if (!url) usage();
    let length: "short" | "medium" = "short";
    const li = rest.indexOf("--length");
    if (li >= 0 && rest[li + 1] === "medium") length = "medium";
    await clipFromUrl(url, length, (update) =>
      console.log(typeof update === "string" ? update : update.detail ?? ""),
    );
    break;
  }
  case "start":
    await cmdStart();
    break;
  case "stop":
    stopBackgroundService();
    console.log("Helper stopped.");
    break;
  case "uninstall":
    uninstallBackgroundService();
    console.log("Background helper removed.");
    break;
  default:
    usage();
}
