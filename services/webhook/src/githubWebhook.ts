import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractCodeChange } from './changeEvent.js';
import { claimDelivery, releaseDelivery } from './deliveries.js';
import { publishCodeChange } from './publisher.js';

/**
 * GitHub webhook receiver.
 *
 * GitHub expects a fast answer and retries anything slow, so this handler does
 * only what cannot be deferred:
 *
 *   verify the signature -> claim the delivery -> publish the change -> 202
 *
 * The investigation happens behind EventBridge, where it can take as long as it
 * needs without GitHub ever waiting. Claiming the delivery before publishing is
 * what stops a GitHub retry becoming a second investigation.
 *
 * The webhook secret lives in AWS Secrets Manager. It is never in source, never
 * in an environment variable, and never logged.
 */

const REGION = process.env.AWS_REGION ?? 'eu-north-1';
const SECRET_ARN = process.env.GITHUB_WEBHOOK_SECRET_ARN ?? '';

const secrets = new SecretsManagerClient({ region: REGION });

/**
 * Cached across invocations on a warm container, so a burst of deliveries
 * costs one Secrets Manager read rather than one per event. Short-lived so a
 * rotated secret is picked up without a redeployment.
 */
const SECRET_TTL_MS = 5 * 60 * 1000;
let cachedSecret: { value: string; fetchedAt: number } | null = null;

/** Events Netra acts on. Anything else is acknowledged and ignored. */
const HANDLED_EVENTS = new Set(['push', 'pull_request']);

/** GitHub sends this to verify the endpoint when the App is created. */
const PING_EVENT = 'ping';

interface LogFields {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Structured logs, so CloudWatch Logs Insights can query them.
 *
 * Only metadata is logged: the delivery id, the event type and the repository.
 * Never the payload, never a header, never the secret.
 */
function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ level, message, ...fields }));
}

async function getWebhookSecret(): Promise<string> {
  const now = Date.now();
  if (cachedSecret && now - cachedSecret.fetchedAt < SECRET_TTL_MS) {
    return cachedSecret.value;
  }
  if (!SECRET_ARN) {
    throw new Error('GITHUB_WEBHOOK_SECRET_ARN is not configured');
  }

  const response = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  const raw = response.SecretString;
  if (!raw) throw new Error('The webhook secret is empty');

  // The secret is stored as JSON so it can hold more GitHub App fields later
  // without changing this contract; a bare string is still accepted.
  let value = raw;
  try {
    const parsed = JSON.parse(raw) as { webhookSecret?: string };
    if (parsed && typeof parsed.webhookSecret === 'string') value = parsed.webhookSecret;
  } catch {
    // Not JSON: the whole string is the secret.
  }

  cachedSecret = { value, fetchedAt: now };
  return value;
}

/**
 * Verify GitHub's HMAC signature over the exact bytes that were delivered.
 *
 * Compared in constant time: a plain `===` would leak the expected signature
 * one byte at a time to anyone willing to measure.
 */
function isSignatureValid(body: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;

  const expected = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const provided = Buffer.from(signatureHeader, 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  if (provided.length !== computed.length) return false;
  return timingSafeEqual(provided, computed);
}

function reply(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const headers = event.headers ?? {};
  // API Gateway lowercases header names, but GitHub's docs use mixed case and
  // local test tooling does not always agree; read both.
  const get = (name: string) => headers[name] ?? headers[name.toLowerCase()];

  const deliveryId = get('x-github-delivery') ?? 'unknown';
  const eventType = get('x-github-event') ?? 'unknown';
  const signature = get('x-hub-signature-256');

  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  if (!signature) {
    log('WARN', 'webhook rejected: no signature', { deliveryId, eventType });
    return reply(401, { error: 'Missing X-Hub-Signature-256' });
  }

  let secret: string;
  try {
    secret = await getWebhookSecret();
  } catch (error) {
    // A configuration fault is ours, not GitHub's: 500 so the delivery is
    // retried once the secret is in place.
    log('ERROR', 'could not read the webhook secret', {
      deliveryId,
      reason: (error as Error).message,
    });
    return reply(500, { error: 'Webhook verification is unavailable' });
  }

  if (!isSignatureValid(body, signature, secret)) {
    log('WARN', 'webhook rejected: bad signature', { deliveryId, eventType });
    return reply(401, { error: 'Invalid signature' });
  }

  if (eventType === PING_EVENT) {
    log('INFO', 'webhook ping verified', { deliveryId });
    return reply(200, { ok: true, message: 'Netra webhook is live' });
  }

  if (!HANDLED_EVENTS.has(eventType)) {
    // Acknowledged deliberately: an unhandled event is not an error, and a
    // non-200 would make GitHub retry something Netra will never act on.
    log('INFO', 'webhook ignored: unhandled event', { deliveryId, eventType });
    return reply(200, { ok: true, handled: false, event: eventType });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    log('WARN', 'webhook body was not valid JSON', { deliveryId, eventType });
    return reply(400, { error: 'Body is not valid JSON' });
  }

  const extracted = extractCodeChange(eventType, payload, deliveryId);
  if (extracted.kind === 'skip') {
    // Nothing to investigate, but the delivery was legitimate: acknowledge it
    // so GitHub does not retry.
    log('INFO', 'webhook skipped', { deliveryId, eventType, reason: extracted.reason });
    return reply(200, { ok: true, handled: false, reason: extracted.reason });
  }

  const change = extracted.event;
  const repository = change.repository.fullName;

  // Claim before publishing. A retry of an already-published delivery must not
  // produce a second investigation.
  let claim: Awaited<ReturnType<typeof claimDelivery>>;
  try {
    claim = await claimDelivery(deliveryId, { event: eventType, repository });
  } catch (error) {
    // Without a claim we cannot promise exactly-once, so refuse the delivery
    // rather than risk duplicate work. GitHub will retry.
    log('ERROR', 'could not claim the delivery', {
      deliveryId,
      eventType,
      reason: (error as Error).message,
    });
    return reply(500, { error: 'Delivery could not be recorded' });
  }

  if (claim === 'DUPLICATE') {
    log('INFO', 'webhook duplicate ignored', { deliveryId, eventType, repository });
    return reply(200, { ok: true, handled: false, duplicate: true, deliveryId });
  }

  try {
    const eventId = await publishCodeChange(change);
    log('INFO', 'change published', {
      deliveryId,
      eventType,
      repository,
      commitSha: change.change.commitSha.slice(0, 12),
      pullRequest: change.change.pullRequestNumber ?? undefined,
      eventId,
    });
    return reply(202, { ok: true, handled: true, deliveryId });
  } catch (error) {
    // The claim was taken but the work did not go through. Release it, or
    // GitHub's retry would look like a duplicate and the change would be lost.
    const released = await releaseDelivery(deliveryId);
    log('ERROR', 'could not publish the change', {
      deliveryId,
      eventType,
      repository,
      reason: (error as Error).message,
      claimReleased: released,
    });
    return reply(500, { error: 'Change could not be queued for investigation' });
  }
}
