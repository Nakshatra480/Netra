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


// ─── HTTP → HTTPS redirect for production ────────────────────────────────────
// crypto.subtle requires a secure context (HTTPS). The S3 website endpoint
// is HTTP-only, but the S3 REST endpoint serves the same files over HTTPS.
// Redirect immediately so the user never gets a broken sign-in page.
if (
  typeof window !== 'undefined' &&
  window.location.protocol === 'http:' &&
  window.location.hostname.includes('s3-website')
) {
  // e.g. http://netra-prod-web-…s3-website.eu-north-1.amazonaws.com
  //   → https://netra-prod-web-…s3.eu-north-1.amazonaws.com
  const httpsUrl = window.location.href
    .replace('http://', 'https://')
    .replace('.s3-website.', '.s3.');
  window.location.replace(httpsUrl);
}

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

  // crypto.subtle is only available in secure contexts (HTTPS / localhost).
  // The HTTP→HTTPS redirect above handles production; this fallback prevents
  // a hard crash in the rare case someone reaches an HTTP origin anyway.
  if (crypto.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  // Pure-JS SHA-256 fallback (RFC 6234 reference implementation).
  // Only reached if crypto.subtle is genuinely unavailable.
  const hash = await pureJsSha256(data);
  return btoa(String.fromCharCode(...hash))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** RFC-compliant SHA-256 implemented in pure JS — no Web Crypto dependency. */
async function pureJsSha256(data: Uint8Array): Promise<Uint8Array> {
  // Initial hash values (first 32 bits of fractional parts of sqrt of first 8 primes)
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  // Round constants (first 32 bits of fractional parts of cbrt of first 64 primes)
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  // Pre-process: padding
  const bitLen = data.length * 8;
  const padLen = ((55 - data.length) & 63) + 1;
  const padded = new Uint8Array(data.length + padLen + 8);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  // Process blocks
  const W = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15]!, 7) ^ rotr(W[t - 15]!, 18) ^ (W[t - 15]! >>> 3);
      const s1 = rotr(W[t - 2]!, 17) ^ rotr(W[t - 2]!, 19) ^ (W[t - 2]! >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + S1 + ch + K[t]! + W[t]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0]! + a!) >>> 0; H[1] = (H[1]! + b!) >>> 0;
    H[2] = (H[2]! + c!) >>> 0; H[3] = (H[3]! + d!) >>> 0;
    H[4] = (H[4]! + e!) >>> 0; H[5] = (H[5]! + f!) >>> 0;
    H[6] = (H[6]! + g!) >>> 0; H[7] = (H[7]! + h!) >>> 0;
  }

  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  H.forEach((val, i) => rv.setUint32(i * 4, val, false));
  return result;
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
