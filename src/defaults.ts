/** Production API. Override with ENCYCLIPEDIA_API_URL for local/dev. */
export const PRODUCTION_API_URL = "https://api.encyclipedia.ai";

/**
 * Firebase Web API key (public client id — same value shipped in the
 * browser bundle as NEXT_PUBLIC_FIREBASE_API_KEY). Not a secret.
 */
export const PRODUCTION_FIREBASE_API_KEY =
  "AIzaSyAOgdF1dWVnIshGNA-Zsf_H_Yb9tl1vBSo";

/** Firebase Auth domain for this project (authorized alongside localhost). */
export const PRODUCTION_FIREBASE_AUTH_DOMAIN =
  "production-496405.firebaseapp.com";

/**
 * Google OAuth redirect_uri must match the Web client Firebase created.
 * That client only allows the Auth handler — NOT http://localhost.
 * Firebase "authorized domains" (where localhost is listed) is a different
 * list and does not fix redirect_uri_mismatch.
 */
export const GOOGLE_CONTINUE_URIS = [
  `https://${PRODUCTION_FIREBASE_AUTH_DOMAIN}/__/auth/handler`,
] as const;
