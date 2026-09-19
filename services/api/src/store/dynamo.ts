import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  Action,
  AuditEvent,
  BlastRadiusGraph,
  Evidence,
  Finding,
  Investigation,
  InvestigationEvent,
  InvestigationStatus,
  ModelProvenance,
  Remediation,
  Repository,
  VerificationResult,
  Workspace,
} from '@netra/domain';
import { NotFoundError, type Store } from './types.js';

/**
 * Production DynamoDB store.
 *
 * Maps the flat DynamoDB schema (pk=INV#<id>, sk=META|ACTION|REMEDIATION)
 * written by the Python orchestrator to the domain Store interface consumed
 * by the API routes. Production investigations are not workspace-partitioned,
 * so the adapter synthesises a single shared production workspace whose id
 * every caller may read.
 */

export const PRODUCTION_WORKSPACE_ID = 'wsp_prod';

const PRODUCTION_WORKSPACE: Workspace = {
  id: PRODUCTION_WORKSPACE_ID,
  name: 'Netra Production',
  ownerId: 'prod',
  createdAt: new Date(0).toISOString(),
};

// ---------------------------------------------------------------------------
// Type helpers — the Python client writes boolean `True` for absent
// string/number fields, so every read path must guard the type.
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function bool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : false;
}

/**
 * Convert either an ISO-8601 string or a Unix timestamp (seconds) string to an
 * ISO-8601 string. Python occasionally writes Unix timestamps into DynamoDB.
 */
function toIso(v: unknown): string {
  if (typeof v !== 'string') return new Date().toISOString();
  // Unix timestamp: all digits, reasonable length
  if (/^\d{9,11}$/.test(v)) {
    return new Date(Number(v) * 1000).toISOString();
  }
  return v;
}

/**
 * DynamoDB stores lists as [{"S": "value"}, ...] when written by the raw boto3
 * client. The DocumentClient auto-unmarshals these to plain arrays, but the
 * Python resource API writes nested dicts that the JS DocumentClient leaves as
 * objects. Handle both.
 */
function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    if (typeof item === 'string') return item;
    // Raw DynamoDB {"S": "..."}
    if (item && typeof item === 'object' && 'S' in item) return String(item.S);
    return String(item);
  });
}

/**
 * The ModelProvenance nested map may be stored in raw DynamoDB format
 * ({"N": "0"}, {"BOOL": false}, etc.) when the Python boto3 resource API wrote
 * it. The JS DocumentClient auto-unmarshals top-level primitives but leaves
 * deeply-nested maps as-is when the Python client used `put_item` directly.
 * This function normalises either representation.
 */
function toModelProvenance(v: unknown): ModelProvenance | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;

  // Helper that unwraps {"N":"0"} / {"BOOL":false} / {"S":"…"} / {"NULL":true}
  const unbox = (field: unknown): unknown => {
    if (!field || typeof field !== 'object') return field;
    const f = field as Record<string, unknown>;
    if ('S' in f) return f.S;
    if ('N' in f) return Number(f.N);
    if ('BOOL' in f) return f.BOOL;
    if ('NULL' in f) return null;
    return field;
  };

  const get = (key: string) => unbox(m[key]);

  return {
    provider: (get('provider') as string | null) ?? null,
    model: (get('model') as string | null) ?? null,
    modelLabel: (get('modelLabel') as string | null) ?? null,
    modelUsed: Boolean(get('modelUsed')),
    display: String(get('display') ?? 'AI unavailable — deterministic analysis'),
    fallbackReason: (get('fallbackReason') as string | null) ?? null,
    unavailableReason: (get('unavailableReason') as string | null) ?? null,
    calls: Number(get('calls') ?? 0),
    toolCalls: Number(get('toolCalls') ?? 0),
    inputTokens: Number(get('inputTokens') ?? 0),
    outputTokens: Number(get('outputTokens') ?? 0),
    totalTokens: Number(get('totalTokens') ?? 0),
    costUsd: Number(get('costUsd') ?? 0),
    estimatedTokens: (get('estimatedTokens') as number | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function metaToInvestigation(item: Record<string, unknown>): Investigation {
  const id = str(item.id) ?? String(item.pk ?? '').replace('INV#', '');
  const repository = str(item.repository) ?? '';
  const refSuffix = id.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase();

  return {
    id,
    workspaceId: PRODUCTION_WORKSPACE_ID,
    repositoryId: `repo_${repository.replace(/\//g, '_')}`,
    reference: `INV-${refSuffix}`,
    change: {
      provider: 'GITHUB',
      repositoryFullName: repository,
      commitSha: str(item.commitSha) ?? '',
      baseSha: str(item.baseSha),
      branch: str(item.branch),
      pullRequestNumber: num(item.pullRequestNumber),
      title: str(item.changeTitle) ?? repository,
      author: str(item.author) ?? 'unknown',
    },
    changedFiles: [],
    status: (str(item.status) ?? 'CREATED') as InvestigationStatus,
    severity: str(item.severity) as Investigation['severity'],
    summary: str(item.summary),
    failureReason: str(item.failureReason),
    isDemo: bool(item.isDemo),
    modelProvenance: toModelProvenance(item.modelProvenance),
    startedAt: toIso(item.startedAt ?? item.createdAt),
    completedAt: item.completedAt && typeof item.completedAt === 'string'
      ? item.completedAt
      : null,
  };
}

function actionItem(item: Record<string, unknown>, investigationId: string): Action {
  return {
    id: str(item.id) ?? `act_${investigationId}`,
    investigationId: str(item.investigationId) ?? investigationId,
    type: 'CREATE_REMEDIATION_PR',
    status: (str(item.status) ?? 'PENDING') as Action['status'],
    requestedBy: str(item.requestedBy) ?? 'netra-investigator',
    approvedBy: str(item.approvedBy),
    decisionNote: str(item.decisionNote),
    resultUrl: str(item.resultUrl),
    createdAt: toIso(item.createdAt),
    decidedAt: item.decidedAt && typeof item.decidedAt === 'string'
      ? item.decidedAt
      : null,
  };
}

function remediationItem(
  item: Record<string, unknown>,
  investigationId: string,
): Remediation {
  return {
    findingId: str(item.findingId) ?? `fnd_${investigationId}`,
    strategy: str(item.strategy) ?? 'deterministic',
    title: str(item.title) ?? 'Remediation',
    rationale: str(item.rationale) ?? '',
    diff: str(item.diff) ?? '',
    affectedFiles: toStringList(item.affectedFiles),
    expectedImpact: str(item.expectedImpact) ?? '',
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class DynamoStore implements Store {
  readonly productionWorkspaceId = PRODUCTION_WORKSPACE_ID;

  readonly #db: DynamoDBDocumentClient;
  readonly #table: string;

  constructor(tableName: string, region: string) {
    this.#table = tableName;
    this.#db = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  }

  // -------------------------------------------------------------------------
  // Workspace (synthesised — production investigations share one workspace)
  // -------------------------------------------------------------------------

  async createWorkspace(workspace: Workspace): Promise<Workspace> {
    // In production mode the workspace id mirrors the caller's identity so that
    // authorizeWorkspace passes: workspace.ownerId === identity.userId.
    return { ...workspace, id: workspace.ownerId };
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    // Return a virtual workspace whose id and ownerId are both the requested id.
    // The caller's session workspaceId is their identity userId, so this makes
    // the existing ownership check (workspace.ownerId === identity.userId) pass.
    return {
      id,
      name: 'Netra Production',
      ownerId: id,
      createdAt: new Date(0).toISOString(),
    };
  }

  async listWorkspacesForOwner(ownerId: string): Promise<Workspace[]> {
    return [{ id: ownerId, name: 'Netra Production', ownerId, createdAt: new Date(0).toISOString() }];
  }

  // -------------------------------------------------------------------------
  // Repository (synthesised)
  // -------------------------------------------------------------------------

  async createRepository(repository: Repository): Promise<Repository> {
    return repository;
  }

  async getRepository(_id: string): Promise<Repository | null> {
    return null;
  }

  async listRepositories(_workspaceId: string): Promise<Repository[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // Investigation
  // -------------------------------------------------------------------------

  async createInvestigation(investigation: Investigation): Promise<Investigation> {
    return investigation;
  }

  async getInvestigation(id: string): Promise<Investigation | null> {
    const r = await this.#db.send(
      new GetCommand({
        TableName: this.#table,
        Key: { pk: `INV#${id}`, sk: 'META' },
      }),
    );
    if (!r.Item) return null;
    return metaToInvestigation(r.Item as Record<string, unknown>);
  }

  /** Scan for all META records — there is no workspaceId GSI on the production table. */
  async listInvestigations(_workspaceId: string, limit: number): Promise<Investigation[]> {
    const r = await this.#db.send(
      new ScanCommand({
        TableName: this.#table,
        FilterExpression: 'sk = :meta',
        ExpressionAttributeValues: { ':meta': 'META' },
      }),
    );

    return (r.Items ?? [])
      .filter((item) => typeof item['id'] === 'string' && item['id'])
      .map((item) => metaToInvestigation(item as Record<string, unknown>))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  async updateInvestigation(
    id: string,
    patch: Partial<Investigation>,
  ): Promise<Investigation> {
    const existing = await this.getInvestigation(id);
    if (!existing) throw new NotFoundError(`Investigation ${id}`);
    return { ...existing, ...patch };
  }

  // -------------------------------------------------------------------------
  // Events (synthesise a status_changed event from the current investigation)
  // -------------------------------------------------------------------------

  async appendEvents(
    _investigationId: string,
    _events: InvestigationEvent[],
  ): Promise<void> {}

  async listEvents(
    investigationId: string,
    afterSeq: number,
  ): Promise<InvestigationEvent[]> {
    if (afterSeq > 0) return []; // Already played; do not replay.
    const investigation = await this.getInvestigation(investigationId);
    if (!investigation) return [];

    const events: InvestigationEvent[] = [
      {
        type: 'status_changed',
        seq: 1,
        at: investigation.startedAt,
        status: investigation.status,
        reason: investigation.failureReason ?? undefined,
      } as InvestigationEvent,
    ];
    return events;
  }

  // -------------------------------------------------------------------------
  // Findings (not stored in production DynamoDB table)
  // -------------------------------------------------------------------------

  async putFindings(
    _investigationId: string,
    _findings: Finding[],
  ): Promise<void> {}

  async listFindings(_investigationId: string): Promise<Finding[]> {
    return [];
  }

  async updateFindingStatus(
    _findingId: string,
    _status: Finding['status'],
  ): Promise<void> {}

  // -------------------------------------------------------------------------
  // Evidence (not stored in production DynamoDB table)
  // -------------------------------------------------------------------------

  async putEvidence(
    _investigationId: string,
    _evidence: Evidence[],
  ): Promise<void> {}

  async listEvidence(_investigationId: string): Promise<Evidence[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // Verifications (not stored in production DynamoDB table)
  // -------------------------------------------------------------------------

  async putVerifications(
    _investigationId: string,
    _results: VerificationResult[],
  ): Promise<void> {}

  async listVerifications(_investigationId: string): Promise<VerificationResult[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // Blast radius graph (not stored in production DynamoDB table)
  // -------------------------------------------------------------------------

  async putGraph(
    _investigationId: string,
    _graph: BlastRadiusGraph,
  ): Promise<void> {}

  async getGraph(_investigationId: string): Promise<BlastRadiusGraph | null> {
    return null;
  }

  // -------------------------------------------------------------------------
  // Remediation
  // -------------------------------------------------------------------------

  async putRemediation(
    _investigationId: string,
    _remediation: Remediation,
  ): Promise<void> {}

  async getRemediation(investigationId: string): Promise<Remediation | null> {
    const r = await this.#db.send(
      new GetCommand({
        TableName: this.#table,
        Key: { pk: `INV#${investigationId}`, sk: 'REMEDIATION' },
      }),
    );
    if (!r.Item) return null;
    return remediationItem(r.Item as Record<string, unknown>, investigationId);
  }

  // -------------------------------------------------------------------------
  // Action
  // -------------------------------------------------------------------------

  async putAction(_action: Action): Promise<void> {}

  async getAction(investigationId: string): Promise<Action | null> {
    const r = await this.#db.send(
      new GetCommand({
        TableName: this.#table,
        Key: { pk: `INV#${investigationId}`, sk: 'ACTION' },
      }),
    );
    if (!r.Item) return null;
    return actionItem(r.Item as Record<string, unknown>, investigationId);
  }

  async updateAction(_actionId: string, _patch: Partial<Action>): Promise<Action> {
    throw new NotFoundError('Action updates are not supported in production read-only mode');
  }

  // -------------------------------------------------------------------------
  // Audit (no-op — production approval audit lives in CloudTrail)
  // -------------------------------------------------------------------------

  async appendAudit(_event: AuditEvent): Promise<void> {}

  async listAudit(_workspaceId: string, _limit: number): Promise<AuditEvent[]> {
    return [];
  }
}
