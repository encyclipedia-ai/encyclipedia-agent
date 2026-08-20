import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function homeDir(): string {
  return path.join(os.homedir(), ".encyclipedia");
}

export function binDir(): string {
  return path.join(homeDir(), "bin");
}

export function logPath(): string {
  return path.join(homeDir(), "helper.log");
}

export function ensureHomeDir(): void {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
}
