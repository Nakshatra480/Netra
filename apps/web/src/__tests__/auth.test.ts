/**
 * Unit tests for the PKCE authorization-code flow in auth.ts.
 *
 * These tests run in jsdom (vitest) and mock the browser APIs that are
 * not available in Node (crypto.subtle, crypto.getRandomValues,
 * sessionStorage, window.location).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Browser API mocks ────────────────────────────────────────────────────────

// Minimal crypto.subtle.digest (SHA-256 over an empty-ish buffer is enough
// for the round-trip test — we care about the base64url encoding logic, not
// cryptographic correctness of the digest itself).
const mockDigest = vi.fn(async (_algo: string, data: ArrayBuffer) => {
  // Return the first 32 bytes of the input as the "hash" (deterministic for tests)
  const input = new Uint8Array(data);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (input[i % input.length] ?? 0) ^ i;
  return out.buffer;
});

const mockGetRandomValues = vi.fn(<T extends ArrayBufferView>(arr: T): T => {
  const typed = arr as unknown as Uint8Array;
  for (let i = 0; i < typed.length; i++) typed[i] = i % 256;
  return arr;
});

Object.defineProperty(globalThis, 'crypto', {
  value: {
    getRandomValues: mockGetRandomValues,
    subtle: { digest: mockDigest },
  },
  writable: true,
});

// sessionStorage backed by a plain Map
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  },
  writable: true,
});

// window.location.assign — prevent real navigation
const assignMock = vi.fn();
Object.defineProperty(globalThis, 'window', {
  value: {
    location: {
      assign: assignMock,
      origin: 'http://localhost:5173',
    },
  },
  writable: true,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(padded);
  return new Uint8Array(Array.from(bin, (c) => c.charCodeAt(0)));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PKCE helpers (via beginGoogleSignIn)', () => {
  beforeEach(() => {
    store.clear();
    assignMock.mockClear();
    mockDigest.mockClear();
  });

  it('stores a PKCE verifier and state in sessionStorage before redirect', async () => {
    const { beginGoogleSignIn } = await import('@/lib/auth');
    await beginGoogleSignIn('/app');

    const verifier = store.get('netra.pkce.verifier');
    const state = store.get('netra.pkce.state');
    const redirect = store.get('netra.pkce.redirect');

    expect(verifier).toBeTruthy();
    expect(state).toBeTruthy();
    expect(redirect).toBe('/app');
  });

  it('redirects to the Cognito authorize endpoint', async () => {
    const { beginGoogleSignIn } = await import('@/lib/auth');
    await beginGoogleSignIn('/app');

    expect(assignMock).toHaveBeenCalledOnce();
    const rawUrl = (assignMock.mock.calls[0] as unknown[])[0] as string;
    const url = new URL(rawUrl);

    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('identity_provider')).toBe('Google');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/callback');
  });

  it('includes a non-empty code_challenge in the redirect', async () => {
    const { beginGoogleSignIn } = await import('@/lib/auth');
    await beginGoogleSignIn();

    const rawUrl2 = (assignMock.mock.calls[0] as unknown[])[0] as string;
    const url = new URL(rawUrl2);
    const challenge = url.searchParams.get('code_challenge') ?? '';

    // base64url chars only, no padding
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge.length).toBeGreaterThan(10);
  });
});

describe('handleCallback', () => {
  beforeEach(() => {
    store.clear();
    mockDigest.mockClear();
  });

  it('throws AuthError when error param is present', async () => {
    const { handleCallback } = await import('@/lib/auth');
    const params = new URLSearchParams({ error: 'access_denied', error_description: 'User denied' });
    await expect(handleCallback(params)).rejects.toMatchObject({
      name: 'AuthError',
      message: 'User denied',
    });
  });

  it('throws AuthError when code is missing', async () => {
    const { handleCallback } = await import('@/lib/auth');
    const params = new URLSearchParams({ state: 'abc' });
    await expect(handleCallback(params)).rejects.toMatchObject({
      name: 'AuthError',
      message: expect.stringContaining('No authorization code'),
    });
  });

  it('throws AuthError on state mismatch', async () => {
    const { handleCallback } = await import('@/lib/auth');
    // Set a different saved state
    store.set('netra.pkce.state', 'saved-state');
    store.set('netra.pkce.verifier', 'verifier');

    const params = new URLSearchParams({ code: 'mycode', state: 'wrong-state' });
    await expect(handleCallback(params)).rejects.toMatchObject({
      name: 'AuthError',
      message: expect.stringContaining('Invalid OAuth state'),
    });
  });

  it('throws AuthError when verifier is missing', async () => {
    const { handleCallback } = await import('@/lib/auth');
    store.set('netra.pkce.state', 'matching-state');
    // No verifier stored

    const params = new URLSearchParams({ code: 'mycode', state: 'matching-state' });
    await expect(handleCallback(params)).rejects.toMatchObject({
      name: 'AuthError',
      message: expect.stringContaining('PKCE verifier missing'),
    });
  });
});

describe('decodeIdToken', () => {
  it('extracts standard claims from a valid ID token payload', async () => {
    const { decodeIdToken } = await import('@/lib/auth');

    const payload = {
      sub: 'google-sub-12345',
      email: 'test@example.com',
      name: 'Test User',
      picture: 'https://example.com/photo.jpg',
    };
    const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fakeToken = `header.${encoded}.signature`;

    const claims = decodeIdToken(fakeToken);
    expect(claims.sub).toBe('google-sub-12345');
    expect(claims.email).toBe('test@example.com');
    expect(claims.name).toBe('Test User');
    expect(claims.picture).toBe('https://example.com/photo.jpg');
  });

  it('returns empty claims for a malformed token', async () => {
    const { decodeIdToken } = await import('@/lib/auth');
    const claims = decodeIdToken('not.a.jwt');
    expect(claims.sub).toBe('');
    expect(claims.email).toBeNull();
  });
});

describe('cognitoConfigured', () => {
  it('is true when pool ID and client ID are set', async () => {
    const { cognitoConfigured } = await import('@/lib/auth');
    // Both env vars have defaults in auth.ts, so this should be true
    expect(cognitoConfigured).toBe(true);
  });
});

describe('tokensToSession', () => {
  it('carries the access token for the read API and the ID token for approval', async () => {
    const { tokensToSession } = await import('@/lib/session');
    const session = tokensToSession(
      {
        accessToken: 'access-token',
        idToken: 'id-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3_600_000,
      },
      'ws_1',
    );

    // The read API verifies tokenUse 'access'; the approval authorizer matches
    // `aud`, which only the ID token has. Both are needed, for different calls.
    expect(session.token).toBe('access-token');
    expect(session.idToken).toBe('id-token');
    // The refresh token is never part of the session handed to API callers.
    expect(JSON.stringify(session)).not.toContain('refresh-token');
  });
});
