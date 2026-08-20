import type { AgentConfig } from "./config.js";
import { saveConfig } from "./config.js";

interface SignInResponse {
  idToken?: string;
  refreshToken?: string;
  expiresIn?: string;
  localId?: string;
  email?: string;
  error?: { message?: string };
}

interface RefreshResponse {
  id_token?: string;
  refresh_token?: string;
  expires_in?: string;
  user_id?: string;
  error?: { message?: string };
}

function identityBase(cfg: AgentConfig): string {
  if (cfg.authEmulatorHost) {
    const host = cfg.authEmulatorHost.replace(/\/$/, "");
    const withProto = host.includes("://") ? host : `http://${host}`;
    return `${withProto}/identitytoolkit.googleapis.com/v1`;
  }
  return "https://identitytoolkit.googleapis.com/v1";
}

function tokenBase(cfg: AgentConfig): string {
  if (cfg.authEmulatorHost) {
    const host = cfg.authEmulatorHost.replace(/\/$/, "");
    const withProto = host.includes("://") ? host : `http://${host}`;
    return `${withProto}/securetoken.googleapis.com/v1`;
  }
  return "https://securetoken.googleapis.com/v1";
}

export async function signInWithPassword(
  cfg: AgentConfig,
  email: string,
  password: string,
): Promise<AgentConfig> {
  if (!cfg.firebaseApiKey) {
    throw new Error(
      "Missing Firebase API key. Set ENCYCLIPEDIA_FIREBASE_API_KEY or save it in ~/.encyclipedia/agent.json",
    );
  }
  const res = await fetch(
    `${identityBase(cfg)}/accounts:signInWithPassword?key=${encodeURIComponent(cfg.firebaseApiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = (await res.json()) as SignInResponse;
  if (!res.ok || !body.idToken) {
    throw new Error(body.error?.message ?? `sign-in failed (${res.status})`);
  }
  const next: AgentConfig = {
    ...cfg,
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    idTokenExpiresAt: Date.now() + Number(body.expiresIn ?? "3600") * 1000,
    uid: body.localId,
    email: body.email ?? email,
  };
  saveConfig(next);
  return next;
}

export async function ensureFreshToken(cfg: AgentConfig): Promise<AgentConfig> {
  if (!cfg.idToken) {
    throw new Error("Not signed in. Run `encyclipedia-agent login`.");
  }
  const skewMs = 60_000;
  if (cfg.idTokenExpiresAt && Date.now() + skewMs < cfg.idTokenExpiresAt) {
    return cfg;
  }
  if (!cfg.refreshToken) {
    throw new Error("Session expired. Run `encyclipedia-agent login`.");
  }
  const res = await fetch(
    `${tokenBase(cfg)}/token?key=${encodeURIComponent(cfg.firebaseApiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: cfg.refreshToken,
      }),
    },
  );
  const body = (await res.json()) as RefreshResponse;
  if (!res.ok || !body.id_token) {
    throw new Error(body.error?.message ?? `token refresh failed (${res.status})`);
  }
  const next: AgentConfig = {
    ...cfg,
    idToken: body.id_token,
    refreshToken: body.refresh_token ?? cfg.refreshToken,
    idTokenExpiresAt: Date.now() + Number(body.expires_in ?? "3600") * 1000,
    uid: body.user_id ?? cfg.uid,
  };
  saveConfig(next);
  return next;
}
