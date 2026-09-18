import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { assertTransition, type InvestigationStatus } from '@netra/domain';

/**
 * Investigation persistence for the Step Functions handlers.
 *
 * The same table and key layout the Fargate task writes to, so orchestration
 * and investigation are reading and writing one record rather than two views
 * that can disagree.
 *
 *   pk = INV#<investigationId>
 *   sk = META | EVENT#<seq> | FINDING#<id> | EVIDENCE#<id> | VERIFY#<id> | GRAPH
 */

const REGION = process.env.AWS_REGION ?? 'eu-north-1';
const TABLE = process.env.NETRA_TABLE_NAME ?? '';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface InvestigationRecord {
  id: string;
  deliveryId: string;
  status: InvestigationStatus;
  repository: string;
  commitSha: string;
  baseSha: string | null;
  pullRequestNumber: number | null;
  severity?: string | null;
  summary?: string | null;
  failureReason?: string | null;
  [key: string]: unknown;
}

export class StoreUnavailable extends Error {
  constructor(cause: string) {
    super(`The investigation store is unavailable: ${cause}`);
    this.name = 'StoreUnavailable';
  }
}

function requireTable(): string {
  if (!TABLE) throw new StoreUnavailable('NETRA_TABLE_NAME is not configured');
  return TABLE;
}

const pk = (investigationId: string) => `INV#${investigationId}`;

/**
 * Create the investigation record, or report that it already exists.
 *
 * A conditional write is what makes the workflow idempotent: a replayed
 * EventBridge event, or a GitHub redelivery that slipped past the webhook's
 * own claim, cannot start a second investigation.
 */
export async function createInvestigation(
  record: InvestigationRecord,
): Promise<'CREATED' | 'DUPLICATE'> {
  try {
    await client.send(
      new PutCommand({
        TableName: requireTable(),
        Item: { pk: pk(record.id), sk: 'META', ...record },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return 'CREATED';
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      return 'DUPLICATE';
    }
    throw new StoreUnavailable((error as Error).name);
  }
}

export async function getInvestigation(
  investigationId: string,
): Promise<InvestigationRecord | null> {
  try {
    const response = await client.send(
      new GetCommand({ TableName: requireTable(), Key: { pk: pk(investigationId), sk: 'META' } }),
    );
    return (response.Item as InvestigationRecord | undefined) ?? null;
  } catch (error) {
    throw new StoreUnavailable((error as Error).name);
  }
}

/**
 * Move an investigation to a new status, refusing transitions the lifecycle
 * does not allow.
 *
 * The check uses `@netra/domain`, the same definition the UI and the engine
 * use, so a state cannot come to mean one thing in orchestration and another
 * everywhere else.
 */
export async function transition(
  investigationId: string,
  from: InvestigationStatus,
  to: InvestigationStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  assertTransition(from, to);

  const names: Record<string, string> = { '#s': 'status' };
  const values: Record<string, unknown> = { ':s': to, ':from': from };
  const sets = ['#s = :s'];

  for (const [index, [key, value]] of Object.entries(extra).entries()) {
    names[`#e${index}`] = key;
    values[`:e${index}`] = value;
    sets.push(`#e${index} = :e${index}`);
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: requireTable(),
        Key: { pk: pk(investigationId), sk: 'META' },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        // Guards against two workers racing the same investigation forward.
        ConditionExpression: '#s = :from',
      }),
    );
  } catch (error) {
    throw new StoreUnavailable((error as Error).name);
  }
}

/** Record a terminal failure from any state. */
export async function markFailed(investigationId: string, reason: string): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: requireTable(),
        Key: { pk: pk(investigationId), sk: 'META' },
        UpdateExpression: 'SET #s = :s, #fr = :fr, #c = :c',
        ExpressionAttributeNames: {
          '#s': 'status',
          '#fr': 'failureReason',
          '#c': 'completedAt',
        },
        ExpressionAttributeValues: {
          ':s': 'FAILED',
          ':fr': reason.slice(0, 1000),
          ':c': new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    throw new StoreUnavailable((error as Error).name);
  }
}
