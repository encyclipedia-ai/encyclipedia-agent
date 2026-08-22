import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRODUCTION_API_URL, PRODUCTION_FIREBASE_API_KEY } from "./defaults.js";

export interface AgentConfig {
  apiUrl: string;
  firebaseApiKey: string;
  authEmulatorHost?: string;
  idToken?: string;
  refreshToken?: string;
  idTokenExpiresAt?: number;
  uid?: string;
  email?: string;
  deviceId: string;
}

const DIR = path.join(os.homedir(), ".encyclipedia");
const FILE = path.join(DIR, "agent.json");

export function configPath(): string {
  return FILE;
}

export function loadConfig(): AgentConfig {
  let stored: Partial<AgentConfig> = {};
  try {
    stored = JSON.parse(fs.readFileSync(FILE, "utf-8")) as Partial<AgentConfig>;
  } catch {
    stored = {};
  }

  const apiUrl = (
    process.env.ENCYCLIPEDIA_API_URL ??
    stored.apiUrl ??
    PRODUCTION_API_URL
  ).replace(/\/$/, "");
  const firebaseApiKey =
    process.env.ENCYCLIPEDIA_FIREBASE_API_KEY ??
    stored.firebaseApiKey ??
    PRODUCTION_FIREBASE_API_KEY;
  const authEmulatorHost =
    process.env.FIREBASE_AUTH_EMULATOR_HOST ?? stored.authEmulatorHost;

  return {
    apiUrl,
    firebaseApiKey,
    authEmulatorHost: authEmulatorHost || undefined,
    idToken: stored.idToken,
    refreshToken: stored.refreshToken,
    idTokenExpiresAt: stored.idTokenExpiresAt,
    uid: stored.uid,
    email: stored.email,
    deviceId: stored.deviceId ?? randomUUID(),
  };
}

export function saveConfig(cfg: AgentConfig): void {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

export function clearSession(cfg: AgentConfig): AgentConfig {
  const next: AgentConfig = {
    apiUrl: cfg.apiUrl,
    firebaseApiKey: cfg.firebaseApiKey,
    authEmulatorHost: cfg.authEmulatorHost,
    deviceId: cfg.deviceId,
  };
  saveConfig(next);
  return next;
}
