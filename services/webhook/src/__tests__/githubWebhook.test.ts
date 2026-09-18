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

const PUSH_BODY = JSON.stringify({ repository: { full_name: 'orbital/payments' } });

function parse(result: unknown) {
  const response = result as { statusCode: number; body: string };
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

describe('GitHub webhook receiver', () => {
  beforeEach(async () => {
    send.mockReset();
    send.mockResolvedValue({ SecretString: JSON.stringify({ webhookSecret: TEST_SECRET }) });
    vi.useRealTimers();
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
      const { status } = parse(await handler(delivery(PUSH_BODY, { event: 'pull_request' })));
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
