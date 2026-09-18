import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The investigation workflow's task handlers.
 *
 * DynamoDB is faked so the rules can be asserted exactly: what counts as a
 * duplicate, which transitions are allowed, what happens when a state fails,
 * and what a malformed event does.
 */

const dynamoSend = vi.fn();
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: dynamoSend }) },
  GetCommand: class {
    constructor(public input: unknown) {}
  },
  PutCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateCommand: class {
    constructor(public input: unknown) {}
  },
}));

process.env.NETRA_TABLE_NAME = 'netra-prod-investigations';

const { handler: createHandler, validate, investigationIdFor, InvalidEventError } = await import(
  '../createInvestigation.js'
);
const { handler: confirmHandler, OutcomeIncomplete, OutcomeMissing } = await import(
  '../confirmOutcome.js'
);
const { handler: failureHandler, describeFailure } = await import('../recordFailure.js');
const { transition, markFailed } = await import('../store.js');

const conditionalFailure = Object.assign(new Error('conditional'), {
  name: 'ConditionalCheckFailedException',
});

const VALID_DETAIL = {
  deliveryId: '56d450a0-b392-11f1-9382-6535715b1e04',
  source: 'push',
  installationId: 162823444,
  repository: { fullName: 'Nakshatra480/Netra', githubId: 1, defaultBranch: 'main', private: true },
  change: {
    commitSha: '3822663130de1a2b3c4d5e6f708192a3b4c5d6e7',
    baseSha: 'f9b7686c3cf5a1b2c3d4e5f60718293a4b5c6d7e',
    branch: 'main',
    pullRequestNumber: null,
    title: 'docs: note the webhook verification pipeline',
    author: 'Nakshatra480',
  },
  receivedAt: '2026-09-18T18:54:13.000Z',
};

beforeEach(() => {
  dynamoSend.mockReset();
  dynamoSend.mockResolvedValue({});
});

describe('creating an investigation', () => {
  it('creates a record from a valid code change', async () => {
    const result = await createHandler({ detail: VALID_DETAIL });

    expect(result.duplicate).toBe(false);
    expect(result.repository).toBe('Nakshatra480/Netra');
    expect(result.commitSha).toBe(VALID_DETAIL.change.commitSha);
    expect(result.installationId).toBe(162823444);
  });

  it('derives the investigation id deterministically from the delivery', () => {
    // Idempotency must not depend on a lookup succeeding first.
    const first = investigationIdFor(VALID_DETAIL.deliveryId);
    const second = investigationIdFor(VALID_DETAIL.deliveryId);
    expect(first).toBe(second);
    expect(first).toMatch(/^inv_[a-zA-Z0-9]+$/);
  });

  it('writes conditionally so a race cannot create two records', async () => {
    await createHandler({ detail: VALID_DETAIL });
    const input = (dynamoSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  describe('duplicate events', () => {
    it('reports a replayed event as a duplicate instead of investigating again', async () => {
      dynamoSend.mockRejectedValueOnce(conditionalFailure);
      const result = await createHandler({ detail: VALID_DETAIL });

      expect(result.duplicate).toBe(true);
      // The id is still returned, so the workflow can report which
      // investigation the replay referred to.
      expect(result.investigationId).toBe(investigationIdFor(VALID_DETAIL.deliveryId));
    });

    it('maps a redelivery of the same GitHub delivery to the same investigation', async () => {
      const first = await createHandler({ detail: VALID_DETAIL });
      dynamoSend.mockRejectedValueOnce(conditionalFailure);
      const replay = await createHandler({ detail: VALID_DETAIL });

      expect(replay.investigationId).toBe(first.investigationId);
      expect(replay.duplicate).toBe(true);
    });
  });

  describe('malformed events', () => {
    it.each([
      ['no detail at all', {}],
      ['missing deliveryId', { ...VALID_DETAIL, deliveryId: undefined }],
      ['missing repository', { ...VALID_DETAIL, repository: {} }],
      ['missing installationId', { ...VALID_DETAIL, installationId: undefined }],
      ['missing commit sha', { ...VALID_DETAIL, change: { ...VALID_DETAIL.change, commitSha: '' } }],
    ])('rejects an event with %s', async (_label, detail) => {
      await expect(createHandler({ detail: detail as never })).rejects.toThrow(InvalidEventError);
      expect(dynamoSend).not.toHaveBeenCalled();
    });

    it.each([
      'not-a-sha',
      'HEAD',
      '../../etc/passwd',
      'zzzzzzz',
    ])('rejects commit sha %s', async (commitSha) => {
      const detail = { ...VALID_DETAIL, change: { ...VALID_DETAIL.change, commitSha } };
      await expect(createHandler({ detail })).rejects.toThrow(InvalidEventError);
    });

    it.each([
      'not-an-owner-name-pair',
      '../../../etc',
      'owner/name; rm -rf /',
      'https://evil.example/owner/name',
    ])('rejects repository %s, which would become a clone target', async (fullName) => {
      const detail = { ...VALID_DETAIL, repository: { fullName } };
      await expect(createHandler({ detail })).rejects.toThrow(InvalidEventError);
    });

    it('accepts a change with no base sha', () => {
      // A branch creation has no parent; the task resolves one or fails clearly.
      const detail = { ...VALID_DETAIL, change: { ...VALID_DETAIL.change, baseSha: null } };
      expect(validate(detail).baseSha).toBe('');
    });
  });
});

describe('state transitions', () => {
  it('allows a transition the lifecycle permits', async () => {
    await expect(transition('inv_1', 'CREATED', 'PREPARING')).resolves.toBeUndefined();
  });

  it.each([
    ['CREATED', 'VERIFYING'],
    ['PREPARING', 'AWAITING_APPROVAL'],
    ['VERIFYING', 'PREPARING'],
    ['RECOMMENDATION', 'REMEDIATING'],
  ] as const)('refuses %s -> %s', async (from, to) => {
    // Reusing @netra/domain means a state cannot mean one thing here and
    // something else in the engine or the UI.
    await expect(transition('inv_1', from, to)).rejects.toThrow(/Invalid investigation transition/);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('refuses to bypass the approval boundary', async () => {
    await expect(transition('inv_1', 'RECOMMENDATION', 'REMEDIATING')).rejects.toThrow();
  });

  it('guards against two workers racing the same investigation forward', async () => {
    await transition('inv_1', 'CREATED', 'PREPARING');
    const input = (dynamoSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input.ConditionExpression).toBe('#s = :from');
  });
});

describe('confirming the outcome', () => {
  const record = (status: string, extra: Record<string, unknown> = {}) =>
    dynamoSend.mockResolvedValueOnce({
      Item: { id: 'inv_1', status, severity: null, summary: null, ...extra },
    });

  it('succeeds when the investigation is awaiting approval', async () => {
    record('AWAITING_APPROVAL', { severity: 'CRITICAL', summary: 'A credential reaches the bundle' });
    const result = await confirmHandler({ investigationId: 'inv_1' });

    expect(result.awaitingApproval).toBe(true);
    expect(result.severity).toBe('CRITICAL');
  });

  it('accepts a terminal outcome that needed no remediation', async () => {
    record('RESOLVED');
    const result = await confirmHandler({ investigationId: 'inv_1' });
    expect(result.awaitingApproval).toBe(false);
    expect(result.status).toBe('RESOLVED');
  });

  it.each(['PREPARING', 'INVESTIGATING', 'EVIDENCE_COLLECTION', 'VERIFYING'])(
    'fails when the investigation stopped at %s',
    async (status) => {
      // A task can exit zero and still have abandoned the investigation.
      record(status);
      await expect(confirmHandler({ investigationId: 'inv_1' })).rejects.toThrow(OutcomeIncomplete);
    },
  );

  it('fails when there is no record to confirm', async () => {
    dynamoSend.mockResolvedValueOnce({});
    await expect(confirmHandler({ investigationId: 'inv_1' })).rejects.toThrow(OutcomeMissing);
  });

  it('fails when no investigation id was supplied', async () => {
    await expect(confirmHandler({})).rejects.toThrow(OutcomeMissing);
  });
});

describe('recording a failure', () => {
  it('marks the investigation failed with a readable reason', async () => {
    const result = await failureHandler({
      investigationId: 'inv_1',
      error: { Error: 'States.TaskFailed', Cause: JSON.stringify({ errorMessage: 'clone failed' }) },
    });

    expect(result.recorded).toBe(true);
    const input = (dynamoSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect((input.ExpressionAttributeValues as Record<string, string>)[':s']).toBe('FAILED');
    expect((input.ExpressionAttributeValues as Record<string, string>)[':fr']).toContain(
      'clone failed',
    );
  });

  it('explains a timeout in words rather than an error code', () => {
    expect(describeFailure({ Error: 'States.Timeout' })).toContain('time limit');
  });

  it('extracts the message from a JSON-encoded cause', () => {
    const described = describeFailure({
      Error: 'Error',
      Cause: JSON.stringify({ errorType: 'X', errorMessage: 'the model gateway refused' }),
    });
    expect(described).toContain('the model gateway refused');
    expect(described).not.toContain('errorType');
  });

  it('never leaves an investigation stuck when the id is missing', async () => {
    const result = await failureHandler({ error: { Error: 'States.Timeout' } });
    expect(result.recorded).toBe(false);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('records a failure from any state, without a transition check', async () => {
    // A failure must be recordable even from a state no forward transition
    // allows; otherwise a stuck investigation could not be closed.
    await expect(markFailed('inv_1', 'anything')).resolves.toBeUndefined();
  });
});
