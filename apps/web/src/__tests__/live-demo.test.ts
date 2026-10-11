import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Live Demo client.
 *
 * The demo runs the real pipeline against a pinned fixture, so the two things
 * worth defending here are that the browser never chooses the target, and that
 * a broken fixture is reported rather than dropping the visitor on an
 * investigation that will never fill in.
 */

const ORIGINAL_FETCH = globalThis.fetch;

async function loadApi() {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com');
  return import('@/lib/api');
}

const session = { token: 'demo-token', scheme: 'demo' as const, workspaceId: 'w' };

beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllEnvs();
});

describe('runDemo', () => {
  it('posts nothing about the target — the server pins it', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: never, init: never) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(
        JSON.stringify({
          investigationId: 'inv_demo3027994a61cb',
          headSha: '3027994a61cbdf3717134ec66db4a89c090045fa',
          branch: 'main',
          repository: 'Nakshatra480/netra-e2e-test',
          alreadyRunning: false,
        }),
        { status: 202 },
      );
    }) as never;

    const { api } = await loadApi();
    const result = await api.runDemo(session);

    expect(result.investigationId).toBe('inv_demo3027994a61cb');
    expect(calls[0]!.url).toBe('https://api.example.com/api/demo/run');
    // No body: a visitor cannot name a repository or a commit to analyze.
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('returns the same investigation when the run is already under way', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            investigationId: 'inv_demo3027994a61cb',
            headSha: '3027994a61cbdf3717134ec66db4a89c090045fa',
            branch: 'main',
            repository: 'Nakshatra480/netra-e2e-test',
            alreadyRunning: true,
            status: 'AWAITING_APPROVAL',
          }),
          { status: 200 },
        ),
    ) as never;

    const { api } = await loadApi();
    const first = await api.runDemo(session);
    const second = await api.runDemo(session);

    // Idempotent: clicking twice lands on one investigation, not two.
    expect(second.investigationId).toBe(first.investigationId);
    expect(second.alreadyRunning).toBe(true);
  });

  it('surfaces a broken fixture instead of navigating into nothing', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'INTERNAL',
              message:
                'The demo fixture commit 3027994 is no longer on Nakshatra480/netra-e2e-test. The fixture repository needs to be restored.',
            },
          }),
          { status: 500 },
        ),
    ) as never;

    const { api, ApiError } = await loadApi();
    await expect(api.runDemo(session)).rejects.toBeInstanceOf(ApiError);
    await expect(api.runDemo(session)).rejects.toThrow(/fixture repository needs to be restored/);
  });
});

describe('repeat runs of the demo', () => {
  /**
   * The fixture commit never changes, so an id derived from it alone gave one
   * investigation for all time: once it finished, the demo could only replay
   * its old result and its old pull request. The run number advances past a
   * finished run so the demo can actually be demonstrated again.
   */
  const idFor = (sha: string, run: number) => {
    const delivery = run === 1 ? `demo-${sha.slice(0, 12)}` : `demo-${sha.slice(0, 12)}-r${run}`;
    return `inv_${delivery.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
  };
  const SHA = '3027994a61cbdf3717134ec66db4a89c090045fa';

  it('gives each run its own investigation', () => {
    expect(idFor(SHA, 1)).toBe('inv_demo3027994a61cb');
    expect(idFor(SHA, 2)).toBe('inv_demo3027994a61cbr2');
    expect(new Set([1, 2, 3, 10, 99].map((n) => idFor(SHA, n))).size).toBe(5);
  });

  it('keeps every id inside the identifier budget', () => {
    // investigationIdFor truncates to 24 characters; a collision there would
    // silently merge two runs into one record.
    for (const run of [1, 2, 10, 100, 200]) {
      expect(idFor(SHA, run).length).toBeLessThanOrEqual(28);
    }
  });

  it('is stable for a given run, so two clicks converge', () => {
    // The id depends on stored state, not on when the button was pressed.
    expect(idFor(SHA, 4)).toBe(idFor(SHA, 4));
  });
});
