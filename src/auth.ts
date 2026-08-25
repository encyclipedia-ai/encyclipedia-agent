import type { AgentConfig } from "./config.js";
import { saveConfig } from "./config.js";
import { GOOGLE_CONTINUE_URIS } from "./defaults.js";

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

interface CreateAuthUriResponse {
  authUri?: string;
  sessionId?: string;
  error?: { message?: string };
}

export interface GoogleAuthSession {
  authUri: string;
  sessionId: string;
  continueUri: string;
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

function persistSignIn(
  cfg: AgentConfig,
  body: SignInResponse,
  fallbackEmail?: string,
): AgentConfig {
  if (!body.idToken) {
    throw new Error("Sign-in did not return a session.");
  }
  const next: AgentConfig = {
    ...cfg,
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    idTokenExpiresAt: Date.now() + Number(body.expiresIn ?? "3600") * 1000,
    uid: body.localId,
    email: body.email ?? fallbackEmail,
  };
  saveConfig(next);
  return next;
}

export async function signInWithPassword(
  cfg: AgentConfig,
  email: string,
  password: string,
): Promise<AgentConfig> {
  if (!cfg.firebaseApiKey) {
    throw new Error("Missing sign-in configuration. Reinstall Encyclipedia Librarian.");
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
  return persistSignIn(cfg, body, email);
}

export async function createGoogleAuthSession(
  cfg: AgentConfig,
): Promise<GoogleAuthSession> {
  if (!cfg.firebaseApiKey) {
    throw new Error("Missing sign-in configuration. Reinstall Encyclipedia Librarian.");
  }

  let lastError = "Could not start Google sign-in.";
  for (const continueUri of GOOGLE_CONTINUE_URIS) {
    const res = await fetch(
      `${identityBase(cfg)}/accounts:createAuthUri?key=${encodeURIComponent(cfg.firebaseApiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "google.com",
          continueUri,
          oauthScope: "openid email profile",
          customParameter: { prompt: "select_account" },
        }),
      },
    );
    const body = (await res.json()) as CreateAuthUriResponse;
    if (res.ok && body.authUri && body.sessionId) {
      return { authUri: body.authUri, sessionId: body.sessionId, continueUri };
    }
    lastError =
      body.error?.message ?? `createAuthUri failed (${res.status}) for ${continueUri}`;
  }
  throw new Error(lastError);
}

export async function signInWithIdp(
  cfg: AgentConfig,
  requestUri: string,
  sessionId: string,
): Promise<AgentConfig> {
  if (!cfg.firebaseApiKey) {
    throw new Error("Missing sign-in configuration. Reinstall Encyclipedia Librarian.");
  }
  const res = await fetch(
    `${identityBase(cfg)}/accounts:signInWithIdp?key=${encodeURIComponent(cfg.firebaseApiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestUri,
        sessionId,
        returnSecureToken: true,
        returnIdpCredential: true,
      }),
    },
  );
  const body = (await res.json()) as SignInResponse;
  if (!res.ok || !body.idToken) {
    throw new Error(body.error?.message ?? `Google sign-in failed (${res.status})`);
  }
  return persistSignIn(cfg, body);
}

export function isOAuthReturnUrl(url: string, continueUri: string): boolean {
  try {
    const next = new URL(url);
    const expected = new URL(continueUri);
    if (next.protocol !== expected.protocol || next.host !== expected.host) {
      return false;
    }
    const expectedPath = expected.pathname.replace(/\/$/, "") || "/";
    const nextPath = next.pathname.replace(/\/$/, "") || "/";
    if (expectedPath !== "/" && nextPath !== expectedPath) {
      return false;
    }
    const hashParams = new URLSearchParams(next.hash.replace(/^#/, ""));
    return Boolean(
      next.searchParams.get("code") ||
        next.searchParams.get("error") ||
        next.searchParams.get("id_token") ||
        hashParams.get("code") ||
        hashParams.get("error") ||
        hashParams.get("id_token"),
    );
  } catch {
    return url.startsWith(continueUri);
  }
}

export function oauthReturnError(url: string): string | null {
  try {
    const next = new URL(url);
    const hashParams = new URLSearchParams(next.hash.replace(/^#/, ""));
    const err =
      next.searchParams.get("error") ??
      hashParams.get("error") ??
      next.searchParams.get("error_description");
    if (!err) return null;
    if (err === "access_denied" || err === "user_cancelled") {
      return "Google sign-in was cancelled.";
    }
    return err;
  } catch {
    return null;
  }
}

export async function ensureFreshToken(cfg: AgentConfig): Promise<AgentConfig> {
  if (!cfg.idToken) {
    throw new Error("Not signed in. Open Encyclipedia Librarian again to sign in.");
  }
  const skewMs = 60_000;
  if (cfg.idTokenExpiresAt && Date.now() + skewMs < cfg.idTokenExpiresAt) {
    return cfg;
  }
  if (!cfg.refreshToken) {
    throw new Error("Session expired. Open Encyclipedia Librarian again to sign in.");
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
