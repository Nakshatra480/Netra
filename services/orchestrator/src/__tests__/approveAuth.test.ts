import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The approval endpoint's authorization boundary.
 *
 * Approving launches a task that pushes a commit to a customer repository, so
 * the two questions that must never be answered from the request body are who
 * the caller is and whether the investigation is theirs. API Gateway verifies
 * the token; these tests cover what the Lambda does with the verified claims.
 */

const sent: unknown[] = [];
const items = new Map<string, Record<string, unknown>>();

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class GetCommand {
    constructor(public input: { Key: { pk: string; sk: string } }) {}
  }
  class UpdateCommand {
    constructor(public input: unknown) {}
  }
  return {
    GetCommand,
    UpdateCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: GetCommand | UpdateCommand) {
          sent.push(cmd);
          if (cmd instanceof GetCommand) {
            return { Item: items.get(cmd.input.Key.sk) };
          }
          return {};
        },
      }),
    },
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
  ConditionalCheckFailedException: class extends Error {},
}));

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: class {
    async send() {
      return { tasks: [{ taskArn: 'arn:task/1' }] };
    }
  },
  RunTaskCommand: class {
    constructor(public input: unknown) {}
  },
}));

const OWNER = 'sub-owner-1';

function event(claims: Record<string, unknown> | undefined, body: unknown = { actionId: 'act_1' }) {
  return {
    pathParameters: { id: 'inv_1' },
    body: JSON.stringify(body),
    requestContext: { authorizer: claims ? { jwt: { claims } } : undefined },
  } as never;
}

function seed() {
  items.clear();
  items.set('META', {
    status: 'AWAITING_APPROVAL',
    author: OWNER,
    repository: 'acme/app',
    commitSha: 'deadbeef',
    baseSha: 'cafe',
    branch: 'main',
    installationId: 1,
  });
  items.set('ACTION', { id: 'act_1', status: 'PENDING' });
  items.set('REMEDIATION', { findingId: 'fnd_1', title: 'Secret', diff: '--- a\n+++ b\n' });
}

async function load() {
  process.env.NETRA_TABLE_NAME = 'tbl';
  process.env.NETRA_TASK_DEFINITION_ARN = 'arn:taskdef/1';
  vi.resetModules();
  return import('../approveInvestigation.js');
}

beforeEach(() => {
  sent.length = 0;
  seed();
});

describe('approval authorization', () => {
  it('rejects a request whose authorizer context has no subject', async () => {
    const { handler } = await load();
    const res = (await handler(event(undefined))) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(401);
    // Nothing was read or written on the strength of an unauthenticated call.
    expect(sent).toHaveLength(0);
  });

  it('rejects a token that carries an email but no subject', async () => {
    const { handler } = await load();
    const res = (await handler(event({ email: 'someone@example.com' }))) as { statusCode: number };
    expect(res.statusCode).toBe(401);
  });

  it('refuses a caller who does not own the investigation', async () => {
    const { handler } = await load();
    const res = (await handler(event({ sub: 'sub-someone-else' }))) as {
      statusCode: number;
      body: string;
    };
    expect(res.statusCode).toBe(403);
    // The refusal happens before anything is mutated.
    expect(sent.every((c) => (c as { input: { Key?: unknown } }).input.Key !== undefined)).toBe(true);
  });

  it('does not let a body-supplied identity stand in for the token', async () => {
    const { handler } = await load();
    const res = (await handler(
      event({ sub: 'sub-someone-else' }, { actionId: 'act_1', userId: OWNER, approvedBy: OWNER }),
    )) as { statusCode: number };
    expect(res.statusCode).toBe(403);
  });

  it('approves for the owner and records the subject as the approver', async () => {
    const { handler } = await load();
    const res = (await handler(event({ sub: OWNER, email: 'owner@example.com' }))) as {
      statusCode: number;
      body: string;
    };
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { approvedBy: string };
    expect(body.approvedBy).toBe(OWNER);

    const update = sent.find(
      (c) =>
        (c as { input: { ExpressionAttributeValues?: Record<string, unknown> } }).input
          .ExpressionAttributeValues?.[':approved'] === 'APPROVED',
    ) as { input: { ExpressionAttributeValues: Record<string, unknown> } };
    // The approver stored is the verified subject, not the email or anything
    // the client sent.
    expect(update.input.ExpressionAttributeValues[':approver']).toBe(OWNER);
  });
});
