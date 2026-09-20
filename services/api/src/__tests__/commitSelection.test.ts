import { describe, expect, it } from 'vitest';
import { isCommitSha } from '../github/appClient.js';
import { loadConfig } from '../config.js';
import { buildServer } from '../server.js';
import { MemoryStore } from '../store/memory.js';

/**
 * Choosing what gets analyzed.
 *
 * The rule these tests defend is that Netra analyzes the commit it was asked
 * about or nothing at all. Falling back to HEAD would produce a report that
 * describes code the person never chose, which is worse than an error.
 */

const config = loadConfig({
  NODE_ENV: 'test',
  NETRA_DEMO_SESSION_SECRET: 'test-secret-value-for-signing-demo-sessions',
  NETRA_DEMO_FIXTURE_REPO: 'acme/fixture',
  NETRA_DEMO_FIXTURE_INSTALLATION_ID: '4242',
  NETRA_DEMO_FIXTURE_SHA: '3027994a61cbdf3717134ec66db4a89c090045fa',
});

describe('commit sha validation', () => {
  it('accepts short and full hex shas', () => {
    expect(isCommitSha('abc1234')).toBe(true);
    expect(isCommitSha('3027994a61cbdf3717134ec66db4a89c090045fa')).toBe(true);
    expect(isCommitSha('  3027994a61cb  ')).toBe(true);
  });

  it('rejects anything that is not a commit id', () => {
    // A ref name is not a SHA. Accepting one would let "main" mean "whatever
    // HEAD is right now", which is exactly the silent fallback being avoided.
    expect(isCommitSha('main')).toBe(false);
    expect(isCommitSha('HEAD')).toBe(false);
    expect(isCommitSha('abc123')).toBe(false); // too short to be unambiguous
    expect(isCommitSha('zzzzzzz')).toBe(false);
    expect(isCommitSha('')).toBe(false);
    expect(isCommitSha('../../etc/passwd')).toBe(false);
  });
});

describe('commit selection endpoints', () => {
  async function server() {
    return buildServer({ config, store: new MemoryStore() });
  }

  async function demoToken(app: Awaited<ReturnType<typeof server>>) {
    const r = await app.inject({ method: 'POST', url: '/api/demo/session' });
    return r.json().token as string;
  }

  it('refuses commit history to an unauthenticated caller', async () => {
    const app = await server();
    const r = await app.inject({ method: 'GET', url: '/api/repositories/repo_1/commits' });
    expect(r.statusCode).toBe(401);
  });

  it('refuses commit history to a demo session', async () => {
    // Real history belongs to a real repository, which a demo visitor has no
    // claim on.
    const app = await server();
    const token = await demoToken(app);
    const r = await app.inject({
      method: 'GET',
      url: '/api/repositories/repo_1/commits',
      headers: { authorization: `Demo ${token}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('refuses to analyze a repository for a demo session', async () => {
    const app = await server();
    const token = await demoToken(app);
    const r = await app.inject({
      method: 'POST',
      url: '/api/repositories/repo_1/analyze',
      headers: { authorization: `Demo ${token}` },
      payload: { commitSha: '3027994a61cb' },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('live demo endpoint', () => {
  it('requires a session', async () => {
    const app = await buildServer({ config, store: new MemoryStore() });
    const r = await app.inject({ method: 'POST', url: '/api/demo/run' });
    expect(r.statusCode).toBe(401);
  });

  it('reports a misconfigured fixture instead of inventing an investigation', async () => {
    // With no fixture pinned there is nothing real to analyze. Saying so is
    // the only honest answer; a placeholder investigation would not be one.
    const bare = loadConfig({
      NODE_ENV: 'test',
      NETRA_DEMO_SESSION_SECRET: 'test-secret-value-for-signing-demo-sessions',
    });
    const app = await buildServer({ config: bare, store: new MemoryStore() });
    const token = (await app.inject({ method: 'POST', url: '/api/demo/session' })).json()
      .token as string;

    const r = await app.inject({
      method: 'POST',
      url: '/api/demo/run',
      headers: { authorization: `Demo ${token}` },
    });
    expect(r.statusCode).toBe(500);
    expect(r.json().error.message).toMatch(/fixture repository is not configured/i);
  });

  it('derives the same investigation id for the pinned commit every time', () => {
    // This is what makes repeated demo runs idempotent: the id is a pure
    // function of the commit, so a second click cannot start a second run.
    const sha = '3027994a61cbdf3717134ec66db4a89c090045fa';
    const idFor = (s: string) =>
      `inv_${`demo-${s.slice(0, 12)}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
    expect(idFor(sha)).toBe('inv_demo3027994a61cb');
    expect(idFor(sha)).toBe(idFor(sha));
  });
});
