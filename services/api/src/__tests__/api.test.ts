import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config.js';
import { buildServer } from '../server.js';
import { MemoryStore } from '../store/memory.js';

const config = loadConfig({
  NODE_ENV: 'test',
  NETRA_DEMO_SESSION_SECRET: 'test-secret-value-for-signing-demo-sessions',
});

describe('API', () => {
  let app: FastifyInstance;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    app = await buildServer({ config, store });
  });

  async function demoSession() {
    const response = await app.inject({ method: 'POST', url: '/api/demo/session' });
    const body = response.json();
    return { token: body.token as string, workspaceId: body.workspace.id as string };
  }

  describe('authentication', () => {
    it('rejects requests without a token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/workspaces' });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects an unsupported authorization scheme', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/workspaces',
        headers: { authorization: 'Basic abc123' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a forged demo session', async () => {
      const { token } = await demoSession();
      const [userId, expiresAt] = token.split('.');
      const forged = `${userId}.${expiresAt}.${'0'.repeat(64)}`;

      const response = await app.inject({
        method: 'GET',
        url: '/api/workspaces',
        headers: { authorization: `Demo ${forged}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a demo session claiming a different user', async () => {
      const { token } = await demoSession();
      const [, expiresAt, signature] = token.split('.');
      const tampered = `demo_attacker.${expiresAt}.${signature}`;

      const response = await app.inject({
        method: 'GET',
        url: '/api/workspaces',
        headers: { authorization: `Demo ${tampered}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('explains that Cognito is unconfigured rather than failing silently', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/workspaces',
        headers: { authorization: 'Bearer some-cognito-access-token' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.message).toContain('Cognito authentication is not configured');
    });
  });

  describe('authorization', () => {
    it('does not let one user read another user\'s workspace', async () => {
      const owner = await demoSession();
      const other = await demoSession();

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories?workspaceId=${owner.workspaceId}`,
        headers: { authorization: `Demo ${other.token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    });

    it('derives the owner from the token, not from the request', async () => {
      const session = await demoSession();
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspaces',
        headers: { authorization: `Demo ${session.token}` },
        // A client-supplied ownerId must be ignored entirely.
        payload: { name: 'Mine', ownerId: 'demo_someone_else' },
      });
      expect(response.statusCode).toBe(201);
      const created = response.json();
      expect(created.ownerId).not.toBe('demo_someone_else');

      const stored = await store.getWorkspace(created.id);
      expect(stored?.ownerId).toBe(created.ownerId);
    });
  });

  describe('validation', () => {
    it('reports field-level problems for an invalid payload', async () => {
      const session = await demoSession();
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspaces',
        headers: { authorization: `Demo ${session.token}` },
        payload: { name: '' },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.details[0].path).toBe('name');
    });

    it('requires a workspace id where one is needed', async () => {
      const session = await demoSession();
      const response = await app.inject({
        method: 'GET',
        url: '/api/repositories',
        headers: { authorization: `Demo ${session.token}` },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('investigations', () => {
    it('returns 404 for an investigation that does not exist', async () => {
      const session = await demoSession();
      const response = await app.inject({
        method: 'GET',
        url: '/api/investigations/inv_missing',
        headers: { authorization: `Demo ${session.token}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('reports health without requiring authentication', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('ok');
    });
  });
});

describe('workspace provisioning', () => {
  let app: FastifyInstance;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    app = await buildServer({ config, store });
  });

  async function demoToken() {
    const response = await app.inject({ method: 'POST', url: '/api/demo/session' });
    return response.json().token as string;
  }

  it("returns the caller's own workspace", async () => {
    // A demo session is issued with a workspace already attached, so this
    // returns that one rather than provisioning a second.
    const token = await demoToken();
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/mine',
      headers: { authorization: `Demo ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ownerId).toMatch(/^demo_/);
  });

  it('gives different callers different workspaces', async () => {
    const [first, second] = await Promise.all([demoToken(), demoToken()]);
    const mine = async (token: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspaces/mine',
          headers: { authorization: `Demo ${token}` },
        })
      ).json();

    const a = await mine(first);
    const b = await mine(second);
    expect(a.id).not.toBe(b.id);
    expect(a.ownerId).not.toBe(b.ownerId);
  });

  it('is idempotent for a returning caller', async () => {
    const token = await demoToken();
    const first = await app.inject({
      method: 'POST',
      url: '/api/workspaces/mine',
      headers: { authorization: `Demo ${token}` },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/workspaces/mine',
      headers: { authorization: `Demo ${token}` },
    });

    // Signing in twice must not accumulate workspaces.
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/workspaces/mine' });
    expect(response.statusCode).toBe(401);
  });
});
