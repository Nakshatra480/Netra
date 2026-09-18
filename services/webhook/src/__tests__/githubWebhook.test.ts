import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The webhook is a public, unauthenticated endpoint. Its only defence is the
 * signature check, so that is what these tests pin down.
 */

const TEST_SECRET = 'a-test-webhook-secret-value-not-a-real-one';

const send = vi.fn();
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = send;
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

const claim = vi.fn();
const release = vi.fn();
vi.mock('../deliveries.js', () => ({
  claimDelivery: (...args: unknown[]) => claim(...args),
  releaseDelivery: (...args: unknown[]) => release(...args),
  DeliveryStoreUnavailable: class extends Error {},
}));

const publish = vi.fn();
vi.mock('../publisher.js', () => ({
  publishCodeChange: (...args: unknown[]) => publish(...args),
  PublishFailed: class extends Error {},
}));

process.env.GITHUB_WEBHOOK_SECRET_ARN = 'arn:aws:secretsmanager:eu-north-1:123:secret:test';

type Handler = (event: never) => Promise<unknown>;

/**
 * A fresh module instance per test.
 *
 * The handler caches the secret in module scope, which is the behaviour we
 * want in Lambda and exactly what would leak state between tests here.
 */
async function freshHandler(): Promise<Handler> {
  vi.resetModules();
  const module = await import('../githubWebhook.js');
  return module.handler as unknown as Handler;
}

let handler: Handler;

function sign(body: string, secret = TEST_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function delivery(
  body: string,
  options: { event?: string; signature?: string | null; base64?: boolean } = {},
) {
  const headers: Record<string, string> = {
    'x-github-delivery': 'test-delivery-id',
    'x-github-event': options.event ?? 'push',
  };
  const signature = options.signature === undefined ? sign(body) : options.signature;
  if (signature) headers['x-hub-signature-256'] = signature;

  return {
    headers,
    body: options.base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: Boolean(options.base64),
  } as never;
}

const PUSH_BODY = JSON.stringify({
  ref: 'refs/heads/main',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  repository: { full_name: 'orbital/payments', id: 1, default_branch: 'main', private: true },
  installation: { id: 99 },
  head_commit: { message: 'a change' },
  pusher: { name: 'priya' },
});

function parse(result: unknown) {
  const response = result as { statusCode: number; body: string };
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

describe('GitHub webhook receiver', () => {
  beforeEach(async () => {
    send.mockReset();
    send.mockResolvedValue({ SecretString: JSON.stringify({ webhookSecret: TEST_SECRET }) });
    vi.useRealTimers();
    claim.mockReset();
    claim.mockResolvedValue('CLAIMED');
    release.mockReset();
    release.mockResolvedValue(true);
    publish.mockReset();
    publish.mockResolvedValue('event-id-1');
    handler = await freshHandler();
  });

  describe('signature verification', () => {
    it('accepts a correctly signed delivery', async () => {
      const { status, body } = parse(await handler(delivery(PUSH_BODY)));
      expect(status).toBe(202);
      expect(body.handled).toBe(true);
    });

    it('rejects a delivery with no signature', async () => {
      const { status } = parse(await handler(delivery(PUSH_BODY, { signature: null })));
      expect(status).toBe(401);
    });

    it('rejects a signature computed with the wrong secret', async () => {
      const forged = sign(PUSH_BODY, 'an-attackers-guess');
      const { status } = parse(await handler(delivery(PUSH_BODY, { signature: forged })));
      expect(status).toBe(401);
    });

    it('rejects a body altered after signing', async () => {
      const signature = sign(PUSH_BODY);
      const tampered = JSON.stringify({ repository: { full_name: 'attacker/repo' } });
      const { status } = parse(await handler(delivery(tampered, { signature })));
      expect(status).toBe(401);
    });

    it('rejects an unsupported signature algorithm', async () => {
      // sha1 is GitHub's legacy scheme and must not be honoured.
      const sha1 = 'sha1=' + createHmac('sha1', TEST_SECRET).update(PUSH_BODY).digest('hex');
      const { status } = parse(await handler(delivery(PUSH_BODY, { signature: sha1 })));
      expect(status).toBe(401);
    });

    it('rejects a malformed signature without throwing', async () => {
      for (const signature of ['sha256=', 'sha256=zzzz', 'garbage', 'sha256=' + 'a'.repeat(64)]) {
        const { status } = parse(await handler(delivery(PUSH_BODY, { signature })));
        expect(status).toBe(401);
      }
    });

    it('verifies against the exact delivered bytes when base64 encoded', async () => {
      const result = parse(
        await handler(delivery(PUSH_BODY, { signature: sign(PUSH_BODY), base64: true })),
      );
      expect(result.status).toBe(202);
    });
  });

  describe('event handling', () => {
    it('answers a ping so the App can verify the endpoint', async () => {
      const { status, body } = parse(await handler(delivery('{}', { event: 'ping' })));
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it('acknowledges an event it does not act on', async () => {
      // A non-200 would make GitHub retry something Netra will never handle.
      const { status, body } = parse(await handler(delivery('{}', { event: 'star' })));
      expect(status).toBe(200);
      expect(body.handled).toBe(false);
    });

    it('handles pull_request as well as push', async () => {
      const body = JSON.stringify({
        action: 'opened',
        number: 182,
        repository: { full_name: 'orbital/payments', id: 1, default_branch: 'main' },
        pull_request: {
          title: 'Enable direct receipt upload',
          head: { sha: 'c'.repeat(40), ref: 'feature/upload' },
          base: { sha: 'd'.repeat(40) },
          user: { login: 'priya' },
        },
      });
      const { status } = parse(await handler(delivery(body, { event: 'pull_request' })));
      expect(status).toBe(202);
    });

    it('rejects a signed body that is not JSON', async () => {
      const { status } = parse(await handler(delivery('not json at all')));
      expect(status).toBe(400);
    });
  });

  describe('secret handling', () => {
    it('reads the secret from Secrets Manager, not from the environment', async () => {
      await handler(delivery(PUSH_BODY));
      expect(send).toHaveBeenCalled();
      expect(process.env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    });

    it('caches the secret across deliveries', async () => {
      await handler(delivery(PUSH_BODY));
      await handler(delivery(PUSH_BODY));
      // A burst of deliveries must not become a burst of Secrets Manager reads.
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('accepts a secret stored as a bare string', async () => {
      send.mockResolvedValue({ SecretString: TEST_SECRET });
      const { status } = parse(await handler(delivery(PUSH_BODY)));
      expect(status).toBe(202);
    });

    it('returns 500 when the secret cannot be read, so GitHub retries', async () => {
      send.mockRejectedValue(new Error('AccessDeniedException'));
      const { status } = parse(await handler(delivery(PUSH_BODY)));
      // A configuration fault is ours, not GitHub's: a retry should succeed
      // once the secret is readable.
      expect(status).toBe(500);
    });
  });

  describe('logging', () => {
    it('never logs the payload, the signature or the secret', async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));

      await handler(delivery(PUSH_BODY));
      await handler(delivery(PUSH_BODY, { signature: 'sha256=deadbeef' }));
      spy.mockRestore();

      const output = lines.join('\n');
      expect(output).not.toContain(TEST_SECRET);
      expect(output).not.toContain('deadbeef');
      expect(output).not.toContain('full_name');
      // Metadata that helps an operator is fine, and expected.
      expect(output).toContain('test-delivery-id');
    });
  });
});


describe('delivery idempotency and publishing', () => {
  beforeEach(async () => {
    send.mockReset();
    send.mockResolvedValue({ SecretString: JSON.stringify({ webhookSecret: TEST_SECRET }) });
    claim.mockReset();
    claim.mockResolvedValue('CLAIMED');
    release.mockReset();
    release.mockResolvedValue(true);
    publish.mockReset();
    publish.mockResolvedValue('event-id-1');
    handler = await freshHandler();
  });

  it('claims the delivery before publishing it', async () => {
    const { status } = parse(await handler(delivery(PUSH_BODY)));
    expect(status).toBe(202);

    // Order matters: publishing first would let a retry duplicate the work.
    expect(claim).toHaveBeenCalledWith('test-delivery-id', {
      event: 'push',
      repository: 'orbital/payments',
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publishes the extracted change, not the raw payload', async () => {
    await handler(delivery(PUSH_BODY));
    const event = publish.mock.calls[0]![0] as Record<string, never>;

    expect(event).toMatchObject({
      deliveryId: 'test-delivery-id',
      source: 'push',
      installationId: 99,
    });
    expect((event as never as { change: { commitSha: string } }).change.commitSha).toBe(
      'b'.repeat(40),
    );
  });

  it('ignores a duplicate delivery without publishing again', async () => {
    claim.mockResolvedValue('DUPLICATE');
    const { status, body } = parse(await handler(delivery(PUSH_BODY)));

    expect(status).toBe(200);
    expect(body.duplicate).toBe(true);
    // The whole point: a GitHub retry must not start a second investigation.
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses the delivery when the claim store is unreachable', async () => {
    claim.mockRejectedValue(new Error('DynamoDB unavailable'));
    const { status } = parse(await handler(delivery(PUSH_BODY)));

    // Without a claim we cannot promise exactly-once, so we do not process it.
    expect(status).toBe(500);
    expect(publish).not.toHaveBeenCalled();
  });

  it('releases the claim when publishing fails, so a retry still works', async () => {
    publish.mockRejectedValue(new Error('EventBridge unavailable'));
    const { status } = parse(await handler(delivery(PUSH_BODY)));

    expect(status).toBe(500);
    // Otherwise the retry would look like a duplicate and the change would be
    // lost permanently.
    expect(release).toHaveBeenCalledWith('test-delivery-id');
  });

  it('does not claim or publish an event it will not investigate', async () => {
    const closed = JSON.stringify({
      action: 'closed',
      number: 1,
      repository: { full_name: 'orbital/payments' },
      pull_request: { head: { sha: 'c'.repeat(40) }, base: { sha: 'd'.repeat(40) } },
    });
    const { status, body } = parse(await handler(delivery(closed, { event: 'pull_request' })));

    expect(status).toBe(200);
    expect(body.handled).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not claim a delivery that failed signature verification', async () => {
    await handler(delivery(PUSH_BODY, { signature: 'sha256=' + 'a'.repeat(64) }));
    // An unauthenticated caller must not be able to consume delivery ids.
    expect(claim).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
