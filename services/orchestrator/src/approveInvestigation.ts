/**
 * ApproveInvestigation Lambda — the AWS approval boundary.
 *
 * Called by the HTTP API (`POST /prod/investigations/{id}/approve`).
 * Reads the existing investigation and action records from DynamoDB,
 * validates state, records the approval (atomically, guarded by condition
 * expressions), and launches a Fargate task with the `remediate-from-env`
 * command. The Fargate task already has NETRA_GITHUB_APP_SECRET injected
 * by the ECS agent — this Lambda never reads or logs any secret.
 *
 * Trust model:
 *   - approver identity comes from the Cognito JWT/IAM context, never the body
 *   - only AWAITING_APPROVAL + PENDING action can advance
 *   - the diff is byte-for-byte what the reviewer approved (stored in DynamoDB)
 */

import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// ---------------------------------------------------------------------------
// Configuration (from environment; never from the request)
// ---------------------------------------------------------------------------

const REGION = process.env.AWS_REGION ?? 'eu-north-1';
const TABLE = process.env.NETRA_TABLE_NAME ?? '';
const CLUSTER_ARN = process.env.NETRA_CLUSTER_ARN ?? '';
const TASK_DEFINITION_ARN = process.env.NETRA_TASK_DEFINITION_ARN ?? '';
const SUBNET_IDS = (process.env.NETRA_SUBNET_IDS ?? '').split(',').filter(Boolean);
const SECURITY_GROUP_ID = process.env.NETRA_SECURITY_GROUP_ID ?? '';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const ecs = new ECSClient({ region: REGION });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pk = (id: string) => `INV#${id}`;

function respond(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, msg, ...fields }));
}

async function get<T>(investigationId: string, sk: string): Promise<T | null> {
  const r = await dynamo.send(
    new GetCommand({ TableName: TABLE, Key: { pk: pk(investigationId), sk } }),
  );
  return (r.Item as T | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function recordApproval(
  investigationId: string,
  actionId: string,
  approver: string,
  note: string | null,
): Promise<void> {
  const now = new Date().toISOString();

  // Step 1 — mark action APPROVED, guarded: must still be PENDING + correct ID
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: pk(investigationId), sk: 'ACTION' },
        UpdateExpression: 'SET #s = :approved, approvedBy = :approver, decisionNote = :note, decidedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':approved': 'APPROVED',
          ':approver': approver,
          ':note': note,
          ':now': now,
          ':pending': 'PENDING',
          ':aid': actionId,
        },
        ConditionExpression: '#s = :pending AND id = :aid',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(new Error('action is not PENDING or actionId mismatch'), { code: 'CONFLICT' });
    }
    throw err;
  }

  // Step 2 — transition META to REMEDIATING, guarded: must be AWAITING_APPROVAL
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: pk(investigationId), sk: 'META' },
        UpdateExpression: 'SET #s = :remediating',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':remediating': 'REMEDIATING', ':awaiting': 'AWAITING_APPROVAL' },
        ConditionExpression: '#s = :awaiting',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Roll back action so it stays PENDING (best-effort)
      await dynamo
        .send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { pk: pk(investigationId), sk: 'ACTION' },
            UpdateExpression: 'SET #s = :pending',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':pending': 'PENDING' },
          }),
        )
        .catch(() => undefined);
      throw Object.assign(
        new Error('investigation is no longer AWAITING_APPROVAL'),
        { code: 'CONFLICT' },
      );
    }
    throw err;
  }
}

async function launchRemediationTask(
  investigationId: string,
  meta: Record<string, unknown>,
  remediation: Record<string, unknown>,
  approver: string,
): Promise<string> {
  const reference = (meta.reference as string | undefined) ?? investigationId;
  const baseSha = (meta.baseSha as string | null) ?? '';
  const branch = (meta.branch as string | null) ?? 'main';
  const installationId = String(meta.installationId ?? '');
  const repository = meta.repository as string;
  const findingId = remediation.findingId as string;
  const findingTitle = remediation.title as string;
  const diff = remediation.diff as string;

  // Pass non-secret args as environment overrides.
  // NETRA_GITHUB_APP_SECRET is already injected by the ECS agent from Secrets
  // Manager into the task definition — this Lambda never touches it.
  const environment = [
    { name: 'NETRA_TASK_MODE', value: 'remediate' },   // route to remediation path, not investigation
    { name: 'NETRA_TABLE_NAME', value: TABLE },          // Fargate reads diff + writes result
    { name: 'NETRA_INVESTIGATION_ID', value: investigationId },
    { name: 'NETRA_REMEDIATION_REFERENCE', value: reference },
    { name: 'NETRA_REMEDIATION_BASE_SHA', value: baseSha },
    // NETRA_REMEDIATION_DIFF intentionally omitted — Fargate reads it from DynamoDB directly
    // to avoid JSON-encoding corruption of the multi-line unified diff.
    { name: 'NETRA_REMEDIATION_FINDING_TITLE', value: findingTitle },
    { name: 'NETRA_REMEDIATION_APPROVER', value: approver },
    { name: 'NETRA_REPOSITORY', value: repository },
    { name: 'NETRA_HEAD_SHA', value: meta.commitSha as string },
    { name: 'NETRA_BASE_SHA', value: baseSha },
    { name: 'NETRA_BASE_BRANCH', value: branch },
    ...(installationId ? [{ name: 'NETRA_INSTALLATION_ID', value: installationId }] : []),
  ];


  log('INFO', 'launching remediation task', {
    investigationId,
    cluster: CLUSTER_ARN,
    taskDefinition: TASK_DEFINITION_ARN,
    subnets: SUBNET_IDS,
    sg: SECURITY_GROUP_ID,
  });

  if (!TASK_DEFINITION_ARN) {
    throw new Error('NETRA_TASK_DEFINITION_ARN is not set — cannot launch remediation task');
  }

  const result = await ecs.send(
    new RunTaskCommand({
      cluster: CLUSTER_ARN,           // SDK v3 uses camelCase, not PascalCase
      taskDefinition: TASK_DEFINITION_ARN,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNET_IDS,
          securityGroups: [SECURITY_GROUP_ID],
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'investigator',
            // No command override — the ENTRYPOINT stays as-is.
            // NETRA_TASK_MODE=remediate routes to the remediation path at runtime.
            environment,
          },
        ],
      },
    }),
  );

  const taskArn = result.tasks?.[0]?.taskArn ?? '(unknown)';
  log('INFO', 'remediation task launched', { investigationId, taskArn });
  return taskArn;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const investigationId = event.pathParameters?.id?.trim();
  if (!investigationId) {
    return respond(400, { error: { code: 'BAD_REQUEST', message: 'Missing investigation id' } });
  }

  let body: { actionId?: string; note?: string };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return respond(400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } });
  }

  if (!body.actionId?.trim()) {
    return respond(400, { error: { code: 'BAD_REQUEST', message: 'actionId is required' } });
  }

  // Approver identity from the verified JWT context — never from request body.
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const approver = (claims.email as string | undefined) ?? (claims.sub as string | undefined) ?? 'netra-operator';

  log('INFO', 'approval requested', { investigationId, actionId: body.actionId, approver });

  try {
    const meta = await get<Record<string, unknown>>(investigationId, 'META');
    if (!meta) return respond(404, { error: { code: 'NOT_FOUND', message: 'Investigation not found' } });

    if (meta.status !== 'AWAITING_APPROVAL') {
      return respond(409, { error: { code: 'CONFLICT', message: `Investigation is ${meta.status}, not AWAITING_APPROVAL` } });
    }

    const action = await get<Record<string, unknown>>(investigationId, 'ACTION');
    if (!action) return respond(404, { error: { code: 'NOT_FOUND', message: 'No pending action found' } });

    if (action.id !== body.actionId) {
      return respond(409, { error: { code: 'CONFLICT', message: `actionId mismatch: expected ${action.id}` } });
    }
    if (action.status !== 'PENDING') {
      return respond(409, { error: { code: 'CONFLICT', message: `Action is already ${action.status}` } });
    }

    const remediation = await get<Record<string, unknown>>(investigationId, 'REMEDIATION');
    if (!remediation) {
      return respond(409, { error: { code: 'CONFLICT', message: 'No remediation plan found' } });
    }

    await recordApproval(investigationId, body.actionId, approver, body.note ?? null);
    const taskArn = await launchRemediationTask(investigationId, meta, remediation, approver);

    log('INFO', 'approval complete', { investigationId, taskArn });
    return respond(200, {
      investigationId,
      actionId: body.actionId,
      status: 'APPROVED',
      approvedBy: approver,
      remediationTaskArn: taskArn,
    });
  } catch (err) {
    const msg = (err as Error & { code?: string }).message;
    const code = (err as Error & { code?: string }).code;
    if (code === 'CONFLICT') return respond(409, { error: { code: 'CONFLICT', message: msg } });
    log('ERROR', 'approval handler error', { investigationId, error: msg });
    return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'Approval processing failed' } });
  }
}
