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
