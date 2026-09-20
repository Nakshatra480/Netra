import type { CognitoTokens, IdTokenClaims } from './auth';
import type { Session } from './api';

/**
 * Where the browser keeps the current session.
 *
 * sessionStorage rather than localStorage: a demo session should not outlive
 * the tab, and nothing here is a credential the user chose to remember.
 *
 * The refresh token is also kept here so we can silently renew access tokens.
 * It is never sent to any endpoint other than Cognito's token endpoint.
 */
const KEY = 'netra.session';
const REFRESH_KEY = 'netra.session.refresh';
const CLAIMS_KEY = 'netra.session.claims';

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed.token || !parsed.workspaceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Private browsing can refuse storage; the session still works in-memory.
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(REFRESH_KEY);
    sessionStorage.removeItem(CLAIMS_KEY);
  } catch {
    /* nothing to clean up */
  }
}

// ─── Refresh token (Cognito only) ────────────────────────────────────────────

export function saveRefreshToken(refreshToken: string): void {
  try {
    if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken);
  } catch {
    /* no-op */
  }
}

export function loadRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

// ─── ID token claims (display only, never used as identity proof) ─────────────

export function saveClaims(claims: IdTokenClaims): void {
  try {
    sessionStorage.setItem(CLAIMS_KEY, JSON.stringify(claims));
  } catch {
    /* no-op */
  }
}

export function loadClaims(): IdTokenClaims | null {
  try {
    const raw = sessionStorage.getItem(CLAIMS_KEY);
    return raw ? (JSON.parse(raw) as IdTokenClaims) : null;
  } catch {
    return null;
  }
}

// ─── Build a Netra Session from Cognito tokens ───────────────────────────────

/**
 * Convert raw Cognito tokens into the Session shape the API client expects.
 * workspaceId is populated after the backend /api/workspaces/mine call.
 */
export function tokensToSession(
  tokens: CognitoTokens,
  workspaceId: string,
): Session {
  return {
    token: tokens.accessToken,
    scheme: 'bearer',
    workspaceId,
    // Kept for the approval endpoint alone, whose JWT authorizer matches the
    // app client id against `aud` — a claim only the ID token carries.
    idToken: tokens.idToken,
  };
}
