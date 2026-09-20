import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The approval client.
 *
 * Approving is the only browser action that changes a repository, so the
 * failure modes matter as much as the success path: a missing endpoint, a
 * second click, and a backend refusal must each be reported rather than
 * swallowed.
 */

const ORIGINAL_FETCH = globalThis.fetch;

async function loadApi(approvalUrl: string | undefined) {
  vi.resetModules();
  vi.stubEnv('VITE_APPROVAL_API_URL', approvalUrl ?? '');
  return import('@/lib/api');
}

const session = {
  token: 'access-token',
  idToken: 'id-token',
  scheme: 'bearer' as const,
  workspaceId: 'w',
};
const demoSession = { token: 't', scheme: 'demo' as const, workspaceId: 'w' };

beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllEnvs();
});

describe('approveRemediation', () => {
  it('posts the action id to the approval endpoint', async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (url: never, init: never) => {
      calls.push({
        url: String(url),
        body: JSON.parse((init as RequestInit).body as string),
        headers: (init as RequestInit).headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ status: 'REMEDIATING' }), { status: 202 });
    }) as never;

    const { api } = await loadApi('https://approval.example.com/prod');
    const result = await api.approveRemediation(session, 'inv_1', 'act_1', 'looks right');

    expect(result.status).toBe('REMEDIATING');
    expect(calls[0]!.url).toBe('https://approval.example.com/prod/investigations/inv_1/approve');
    expect(calls[0]!.body).toEqual({ actionId: 'act_1', note: 'looks right' });
    // The authorizer matches `aud` against the app client id, and only the ID
    // token carries that claim — sending the access token would be a 401.
    expect(calls[0]!.headers.authorization).toBe('Bearer id-token');
    expect(calls[0]!.headers.authorization).not.toContain('access-token');
  });

  it('fails loudly when the approval endpoint is not configured', async () => {
    const { api, ApprovalNotConfigured } = await loadApi('');
    // Silently doing nothing would look identical to a working approval.
    await expect(api.approveRemediation(session, 'inv_1', 'act_1')).rejects.toBeInstanceOf(
      ApprovalNotConfigured,
    );
  });

  it('surfaces a conflict when the investigation was already approved', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'CONFLICT', message: 'investigation is no longer AWAITING_APPROVAL' },
          }),
          { status: 409 },
        ),
    ) as never;

    const { api } = await loadApi('https://approval.example.com/prod');
    // The backend's conditional write is what makes a double click safe; the
    // client's job is to report that it happened.
    await expect(api.approveRemediation(session, 'inv_1', 'act_1')).rejects.toThrow(
      /no longer AWAITING_APPROVAL/,
    );
  });

  it('reports an unreachable approval service', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    }) as never;

    const { api } = await loadApi('https://approval.example.com/prod');
    await expect(api.approveRemediation(session, 'inv_1', 'act_1')).rejects.toThrow(
      /Could not reach the approval service/,
    );
  });

  it('trims a trailing slash on the configured endpoint', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: never) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ status: 'REMEDIATING' }), { status: 202 });
    }) as never;

    const { api } = await loadApi('https://approval.example.com/prod/');
    await api.approveRemediation(session, 'inv_1', 'act_1');
    expect(seen[0]).not.toContain('prod//investigations');
  });
});

describe('diff summary', () => {
  it('counts real additions and deletions, ignoring file headers', async () => {
    const { summarizeDiff } = await import('@/pages/PrReviewPage');
    const diff = [
      'diff --git a/src/config.js b/src/config.js',
      '--- a/src/config.js',
      '+++ b/src/config.js',
      '@@ -1,4 +1,3 @@',
      ' const a = 1;',
      '-  secret: process.env.AWS_SECRET_ACCESS_KEY,',
      '+  // removed',
      '+  safe: true,',
    ].join('\n');

    // The +++/--- header lines are not changes and must not be counted.
    expect(summarizeDiff(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it('returns zeroes for an empty diff', async () => {
    const { summarizeDiff } = await import('@/pages/PrReviewPage');
    expect(summarizeDiff('')).toEqual({ additions: 0, deletions: 0 });
  });

  it('refuses to approve from a demo session without calling the endpoint', async () => {
    // The demo token is not a Cognito token; the endpoint would answer 401.
    // Saying so here is clearer than surfacing a raw gateway rejection.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;

    const { api, ApiError } = await loadApi('https://approval.example.com/prod');
    await expect(api.approveRemediation(demoSession, 'inv_1', 'act_1')).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('explains an expired session when the gateway rejects the token', async () => {
    // API Gateway rejects before the Lambda runs, so there is no Netra error body.
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
    ) as never;

    const { api } = await loadApi('https://approval.example.com/prod');
    await expect(api.approveRemediation(session, 'inv_1', 'act_1')).rejects.toThrow(/Sign in again/);
  });

  it('explains a refusal when the investigation belongs to someone else', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 403 }),
    ) as never;

    const { api } = await loadApi('https://approval.example.com/prod');
    await expect(api.approveRemediation(session, 'inv_1', 'act_1')).rejects.toThrow(
      /do not have access/,
    );
  });

  it('refuses a signed-in session that has no ID token rather than sending the wrong one', async () => {
    // Sessions restored from storage before the approval endpoint required a
    // JWT have only an access token, which the gateway would reject opaquely.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;

    const { api } = await loadApi('https://approval.example.com/prod');
    await expect(
      api.approveRemediation(
        { token: 'access-token', scheme: 'bearer', workspaceId: 'w' },
        'inv_1',
        'act_1',
      ),
    ).rejects.toThrow(/Sign in again/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
