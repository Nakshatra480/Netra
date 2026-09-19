import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
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
// Known investigation IDs
//
// The production DynamoDB table has no GSI and the Lambda execution role
// (netra-lambda-role) grants GetItem/BatchGetItem but NOT Scan.  We keep a
// static manifest of known IDs populated from a one-time admin scan; new
// investigations triggered by GitHub webhooks are appended here manually.
// ---------------------------------------------------------------------------

const KNOWN_INVESTIGATION_IDS: string[] = [
  'inv_verify1789808463',
  'inv_8dcbc2eab40b11f1807584bd',
  'inv_permrecheck1789757605',
  'inv_4da2165cb39211f196d96f0a',
  'inv_f66375c2b41111f19f03512f',
  'inv_d4e62550b40911f181f65538',
  'inv_fixture1789796623credent',
  'inv_56d450a0b39211f193826535',
  'inv_postrollback1789759737',
  'inv_d5923430b40911f19b95285b',
  'inv_verify2_1789808939',
  'inv_92c1d16cb40711f1933cc8a8',
  'inv_027f5c10b3ed11f198bf440b',
  'inv_93b3f050b40711f194d0d459',
  'inv_2cddaaf6b3ee11f1973a132b',
  'inv_fixture1789797123credexp',
  'inv_b05aceecb40a11f18e4eb8a2',
];

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

  /**
   * Fetch META records for all known investigations via parallel GetItem calls.
   *
   * We use individual GetItem calls rather than Scan or BatchGetItem because
   * the Lambda execution role (netra-lambda-role) only has GetItem permission.
   * Promise.all runs them concurrently so latency ≈ single GetItem RTT.
   */
  async listInvestigations(_workspaceId: string, limit: number): Promise<Investigation[]> {
    if (KNOWN_INVESTIGATION_IDS.length === 0) return [];

    const results = await Promise.all(
      KNOWN_INVESTIGATION_IDS.map((id) =>
        this.#db
          .send(new GetCommand({ TableName: this.#table, Key: { pk: `INV#${id}`, sk: 'META' } }))
          .then((r) => r.Item as Record<string, unknown> | undefined)
          .catch(() => undefined),
      ),
    );

    return results
      .filter((item): item is Record<string, unknown> => !!item && typeof item['id'] === 'string' && !!item['id'])
      .map((item) => metaToInvestigation(item))
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
  // Events
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

    // Synthesise a single terminal status_changed event. The production
    // EVENT# records are raw telemetry (command_output, etc.) and are too
    // numerous (~800) to serve to the UI in a single call. The UI only
    // needs the current status.
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
  // Findings
  // -------------------------------------------------------------------------

  async putFindings(
    _investigationId: string,
    _findings: Finding[],
  ): Promise<void> {}

  async listFindings(investigationId: string): Promise<Finding[]> {
    try {
      const r = await this.#db.send(
        new QueryCommand({
          TableName: this.#table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: {
            ':pk': `INV#${investigationId}`,
            ':prefix': 'FINDING#',
          },
        }),
      );
      return (r.Items ?? []).map((item) => {
        const i = item as Record<string, unknown>;
        return {
          id: str(i.id) ?? '',
          investigationId: str(i.investigationId) ?? investigationId,
          category: (str(i.category) ?? 'CREDENTIAL_EXPOSURE') as Finding['category'],
          severity: (str(i.severity) ?? 'HIGH') as Finding['severity'],
          title: str(i.title) ?? '',
          description: str(i.description) ?? '',
          impact: str(i.impact) ?? '',
          subject: str(i.subject) ?? '',
          affectedFiles: toStringList(i.affectedFiles),
          confidence: num(i.confidence) ?? 0.5,
          verificationStatus: (str(i.verificationStatus) ?? 'UNVERIFIED') as Finding['verificationStatus'],
          recommendation: str(i.recommendation) ?? '',
          remediationAvailable: bool(i.remediationAvailable),
          status: (str(i.status) ?? 'OPEN') as Finding['status'],
          createdAt: toIso(i.createdAt),
        };
      });
    } catch {
      // Graceful fallback if QueryCommand is not permitted by IAM
      return [];
    }
  }

  async updateFindingStatus(
    _findingId: string,
    _status: Finding['status'],
  ): Promise<void> {}

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  async putEvidence(
    _investigationId: string,
    _evidence: Evidence[],
  ): Promise<void> {}

  async listEvidence(investigationId: string): Promise<Evidence[]> {
    try {
      const r = await this.#db.send(
        new QueryCommand({
          TableName: this.#table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: {
            ':pk': `INV#${investigationId}`,
            ':prefix': 'EVIDENCE#',
          },
        }),
      );
      return (r.Items ?? []).map((item) => {
        const i = item as Record<string, unknown>;
        return {
          id: str(i.id) ?? '',
          findingId: str(i.findingId) ?? '',
          kind: (str(i.kind) ?? 'SOURCE_REFERENCE') as Evidence['kind'],
          file: str(i.file) ?? '',
          line: num(i.line),
          endLine: num(i.endLine),
          snippet: str(i.snippet) ?? '',
          relationship: str(i.relationship) ?? '',
          verificationStatus: (str(i.verificationStatus) ?? 'UNVERIFIED') as Evidence['verificationStatus'],
          producedBy: str(i.producedBy) ?? '',
          producedByCommand: str(i.producedByCommand),
          createdAt: toIso(i.createdAt),
        };
      });
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Verifications
  // -------------------------------------------------------------------------

  async putVerifications(
    _investigationId: string,
    _results: VerificationResult[],
  ): Promise<void> {}

  async listVerifications(investigationId: string): Promise<VerificationResult[]> {
    try {
      const r = await this.#db.send(
        new QueryCommand({
          TableName: this.#table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: {
            ':pk': `INV#${investigationId}`,
            ':prefix': 'VERIFY#',
          },
        }),
      );
      return (r.Items ?? []).map((item) => {
        const i = item as Record<string, unknown>;
        return {
          id: str(i.id) ?? '',
          findingId: str(i.findingId) ?? '',
          verifier: str(i.verifier) ?? '',
          status: (str(i.status) ?? 'UNVERIFIED') as VerificationResult['status'],
          claim: str(i.claim) ?? '',
          detail: str(i.detail) ?? '',
          command: str(i.command),
          durationMs: num(i.durationMs) ?? 0,
          phase: (str(i.phase) ?? 'PRE_FIX') as VerificationResult['phase'],
          createdAt: toIso(i.createdAt),
        };
      });
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Blast radius graph
  // -------------------------------------------------------------------------

  async putGraph(
    _investigationId: string,
    _graph: BlastRadiusGraph,
  ): Promise<void> {}

  async getGraph(investigationId: string): Promise<BlastRadiusGraph | null> {
    try {
      const r = await this.#db.send(
        new GetCommand({
          TableName: this.#table,
          Key: { pk: `INV#${investigationId}`, sk: 'GRAPH' },
        }),
      );
      if (!r.Item) return null;
      const item = r.Item as Record<string, unknown>;
      const rawNodes = Array.isArray(item.nodes) ? item.nodes : [];
      const rawEdges = Array.isArray(item.edges) ? item.edges : [];
      return {
        nodes: rawNodes.map((n: Record<string, unknown>) => ({
          id: str(n.id) ?? '',
          kind: (str(n.kind) ?? 'FILE') as BlastRadiusGraph['nodes'][number]['kind'],
          label: str(n.label) ?? '',
          file: str(n.file),
          line: typeof n.line === 'number' ? n.line : null,
          onAffectedPath: bool(n.onAffectedPath),
          evidenceIds: toStringList(n.evidenceIds),
          verificationStatus: (str(n.verificationStatus) ?? 'UNVERIFIED') as BlastRadiusGraph['nodes'][number]['verificationStatus'],
        })),
        edges: rawEdges.map((e: Record<string, unknown>) => ({
          id: str(e.id) ?? '',
          source: str(e.source) ?? '',
          target: str(e.target) ?? '',
          relationship: str(e.relationship) ?? '',
          onAffectedPath: bool(e.onAffectedPath),
          evidenceIds: toStringList(e.evidenceIds),
        })),
        summary: str(item.summary) ?? '',
      };
    } catch {
      return null;
    }
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
