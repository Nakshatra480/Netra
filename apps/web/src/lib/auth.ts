/**
 * Cognito PKCE authorization-code flow.
 *
 * The app client has no secret (public SPA client), so we use the PKCE
 * extension. The browser only ever holds the authorization code for the
 * brief token exchange; tokens are kept in sessionStorage via session.ts.
 *
 * Flow:
 *   1. beginGoogleSignIn() → redirect to Cognito Hosted UI
 *   2. Cognito → Google OAuth → callback to /auth/callback?code=...
 *   3. handleCallback() exchanges code+verifier for tokens
 *   4. Token is stored as a Session via saveSession()
 *   5. On app load, refreshSession() restores a live token silently
 *
 * Non-secrets are public config — Cognito pool IDs and client IDs grant
 * nothing on their own. The Google client secret lives only in Cognito.
 * Never put OAuth secrets here.
 */

import { usableImageUrl } from '@/lib/imageUrl';
const COGNITO_DOMAIN =
  import.meta.env.VITE_COGNITO_DOMAIN ??
  'https://netra-prod-auth.auth.eu-north-1.amazoncognito.com';

const CLIENT_ID =
  import.meta.env.VITE_COGNITO_CLIENT_ID ?? '54dbo433sqda4fbl66qoj4ro9f';

const USER_POOL_ID =
  import.meta.env.VITE_COGNITO_USER_POOL_ID ?? 'eu-north-1_iLXYmZSZd';

/** Public: identifies which pool the client belongs to. Not a secret. */
export const cognitoConfigured = Boolean(USER_POOL_ID && CLIENT_ID);

export const COGNITO_POOL_ID = USER_POOL_ID;

// ─── PKCE helpers ───────────────────────────────────────────────────────────

function randomBase64url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256Base64url(plain: string): Promise<string> {
  const data = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ─── Token storage (separate from the Netra session) ────────────────────────

const VERIFIER_KEY = 'netra.pkce.verifier';
const STATE_KEY = 'netra.pkce.state';
const REDIRECT_KEY = 'netra.pkce.redirect';

// ─── Public types ────────────────────────────────────────────────────────────

export interface CognitoTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number; // epoch ms
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// ─── Sign-in: redirect to Cognito Hosted UI ─────────────────────────────────

/**
 * Redirect the browser to Cognito's Managed Login / Hosted UI configured
 * to sign in via Google.
 *
 * @param redirectAfter  React-Router path to restore after login (default: /app).
 */
export async function beginGoogleSignIn(redirectAfter = '/app'): Promise<void> {
  const verifier = randomBase64url(96);
  const challenge = await sha256Base64url(verifier);
  const state = randomBase64url(16);

  // Persist across the redirect.
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(REDIRECT_KEY, redirectAfter);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: callbackUri(),
    scope: 'openid email profile',
    identity_provider: 'Google',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });

  window.location.assign(`${COGNITO_DOMAIN}/oauth2/authorize?${params}`);
}

// ─── Callback: exchange code for tokens ──────────────────────────────────────

/**
 * Called at /auth/callback with the URL search params from Cognito.
 *
 * Returns the raw Cognito tokens; the caller is responsible for converting
 * them into a Netra Session and persisting it.
 *
 * Throws AuthError on any failure.
 */
export async function handleCallback(
  params: URLSearchParams,
): Promise<{ tokens: CognitoTokens; redirectTo: string }> {
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const errorDescription = params.get('error_description');

  if (error) {
    throw new AuthError(errorDescription ?? `Google sign-in failed: ${error}`);
  }
  if (!code) {
    throw new AuthError('No authorization code in the callback URL.');
  }

  // Replay-protection: state must match what we stored.
  const savedState = sessionStorage.getItem(STATE_KEY);
  if (!savedState || savedState !== state) {
    throw new AuthError('Invalid OAuth state. Please try signing in again.');
  }

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) {
    throw new AuthError('PKCE verifier missing. Please try signing in again.');
  }

  const redirectTo = sessionStorage.getItem(REDIRECT_KEY) ?? '/app';

  // Clean up before the token exchange in case it fails partway.
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(REDIRECT_KEY);

  const tokens = await exchangeCode(code, verifier);
  return { tokens, redirectTo };
}

async function exchangeCode(code: string, verifier: string): Promise<CognitoTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: callbackUri(),
    code_verifier: verifier,
  });

  const response = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AuthError(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new AuthError(data.error_description ?? data.error);
  }
  if (!data.access_token || !data.id_token) {
    throw new AuthError('Incomplete token response from Cognito.');
  }

  return {
    accessToken: data.access_token,
    idToken: data.id_token,
    refreshToken: data.refresh_token ?? '',
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

// ─── Silent token refresh ─────────────────────────────────────────────────────

/**
 * Attempt to refresh an expired access token using the stored refresh token.
 *
 * Returns null (rather than throwing) when there is no usable refresh token,
 * because "not signed in" is a normal state, not an error.
 */
export async function refreshSession(refreshToken: string): Promise<CognitoTokens | null> {
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  try {
    const response = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      access_token?: string;
      id_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) return null;

    return {
      accessToken: data.access_token,
      idToken: data.id_token ?? '',
      refreshToken, // Cognito does not rotate the refresh token on each refresh
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  } catch {
    return null;
  }
}

// ─── Sign-out ─────────────────────────────────────────────────────────────────

/**
 * Redirect to Cognito's logout endpoint, which clears the Cognito session
 * and redirects back to the configured sign-out URL.
 */
export function signOut(): void {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    logout_uri: signOutUri(),
  });
  window.location.assign(`${COGNITO_DOMAIN}/logout?${params}`);
}

// ─── ID token claims ─────────────────────────────────────────────────────────

export interface IdTokenClaims {
  readonly sub: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly picture: string | null;
}

/**
 * Decode the ID token claims without verification.
 *
 * Note: the backend verifies the access token's signature using JWKS.
 * The frontend reads the ID token only to display user name / avatar —
 * never as proof of identity.
 */
export function decodeIdToken(idToken: string): IdTokenClaims {
  const empty: IdTokenClaims = { sub: '', email: null, name: null, picture: null };
  try {
    const parts = idToken.split('.');
    const payloadPart = parts[1];
    if (!payloadPart) return empty;

    const json = JSON.parse(decodeJwtSegment(payloadPart)) as Record<string, unknown>;
    return {
      sub: String(json.sub ?? ''),
      email: typeof json.email === 'string' ? json.email : null,
      name: typeof json.name === 'string' ? json.name : null,
      // Not every provider hands back a bare URL here. Validating once, on the
      // way in, keeps an unusable value from reaching an <img src> later and
      // rendering as a broken image.
      picture: usableImageUrl(json.picture),
    };
  } catch {
    return empty;
  }
}

/**
 * Decode one base64url JWT segment as UTF-8.
 *
 * `atob` alone returns a Latin-1 byte string, so any non-ASCII character in a
 * name comes back mangled. Base64url also drops its padding, which `atob`
 * rejects at some lengths.
 */
function decodeJwtSegment(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

function callbackUri(): string {
  const origin = window.location.origin;
  return `${origin}/auth/callback`;
}

function signOutUri(): string {
  return `${window.location.origin}/`;
}
