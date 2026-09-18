import { z } from 'zod';
import { INVESTIGATION_STATUSES } from './status.js';

export const severitySchema = z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type Severity = z.infer<typeof severitySchema>;

export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export const findingCategorySchema = z.enum([
  /** A secret or credential reaches a context that can expose it. */
  'CREDENTIAL_EXPOSURE',
  /** A change widens access to a resource or capability. */
  'PERMISSION_BOUNDARY_CHANGE',
]);
export type FindingCategory = z.infer<typeof findingCategorySchema>;

/**
 * Whether a claim has been checked by deterministic code.
 *
 * `UNVERIFIED` means the model proposed it and nothing has confirmed it. Only a
 * deterministic analyzer may set `VERIFIED`; the model can never do so.
 */
export const verificationStatusSchema = z.enum([
  'UNVERIFIED',
  'VERIFIED',
  'REFUTED',
  'INCONCLUSIVE',
]);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const evidenceKindSchema = z.enum([
  'DIFF_HUNK',
  'SOURCE_REFERENCE',
  'CONFIG_ENTRY',
  'REFERENCE_PATH',
  'GIT_HISTORY',
  'STATIC_CHECK',
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceSchema = z.object({
  id: z.string().min(1),
  findingId: z.string().min(1),
  kind: evidenceKindSchema,
  file: z.string().min(1),
  line: z.number().int().nonnegative().nullable(),
  endLine: z.number().int().nonnegative().nullable(),
  snippet: z.string(),
  /** Why this location matters, e.g. "references AWS_SECRET_ACCESS_KEY". */
  relationship: z.string(),
  verificationStatus: verificationStatusSchema,
  /** Deterministic analyzer that produced this evidence. Never a model name. */
  producedBy: z.string().min(1),
  /** The exact allowlisted command whose output produced this evidence. */
  producedByCommand: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const verificationResultSchema = z.object({
  id: z.string().min(1),
  findingId: z.string().min(1),
  /** Stable identifier of the deterministic check, e.g. "secret-flow-v1". */
  verifier: z.string().min(1),
  status: verificationStatusSchema,
  /** Plain-language statement of what the check proved or failed to prove. */
  claim: z.string(),
  detail: z.string(),
  command: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** Set when this verification re-ran after a remediation was applied. */
  phase: z.enum(['PRE_FIX', 'POST_FIX']),
  createdAt: z.string().datetime(),
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const findingStatusSchema = z.enum(['OPEN', 'APPROVED', 'REJECTED', 'REMEDIATED', 'RESOLVED']);
export type FindingStatus = z.infer<typeof findingStatusSchema>;

export const findingSchema = z.object({
  id: z.string().min(1),
  investigationId: z.string().min(1),
  category: findingCategorySchema,
  severity: severitySchema,
  title: z.string().min(1),
  /** Plain-English consequence statement shown as the investigation summary. */
  description: z.string(),
  /** Why the consequence matters, in reviewer terms. */
  impact: z.string(),
  /** The secret name, permission, or artifact the finding is about. */
  subject: z.string(),
  affectedFiles: z.array(z.string()),
  /** 0..1. Derived from verification status, never asserted by the model. */
  confidence: z.number().min(0).max(1),
  verificationStatus: verificationStatusSchema,
  recommendation: z.string(),
  remediationAvailable: z.boolean(),
  status: findingStatusSchema,
  createdAt: z.string().datetime(),
});
export type Finding = z.infer<typeof findingSchema>;

export const graphNodeKindSchema = z.enum([
  'CHANGED_FILE',
  'FILE',
  'MODULE',
  'ENV_VAR',
  'SECRET',
  'DEPENDENCY',
  'ENDPOINT',
  'PERMISSION',
  'DATA_STORE',
  'EXTERNAL_SERVICE',
  'FINDING',
]);
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;

export const blastRadiusNodeSchema = z.object({
  id: z.string().min(1),
  kind: graphNodeKindSchema,
  label: z.string().min(1),
  /** Repository path when the node maps to a file. */
  file: z.string().nullable(),
  line: z.number().int().nonnegative().nullable(),
  /** True when the node lies on a path from the change to a finding. */
  onAffectedPath: z.boolean(),
  /** Evidence ids that justify this node's presence in the graph. */
  evidenceIds: z.array(z.string()),
  /** Whether a deterministic check placed this node here. */
  verificationStatus: verificationStatusSchema,
});
export type BlastRadiusNode = z.infer<typeof blastRadiusNodeSchema>;

export const blastRadiusEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  /** e.g. "reads", "imports", "exposes", "bundled into". */
  relationship: z.string().min(1),
  onAffectedPath: z.boolean(),
  evidenceIds: z.array(z.string()),
});
export type BlastRadiusEdge = z.infer<typeof blastRadiusEdgeSchema>;

export const blastRadiusGraphSchema = z.object({
  nodes: z.array(blastRadiusNodeSchema),
  edges: z.array(blastRadiusEdgeSchema),
  /** Accessible text alternative for users who cannot use the graph. */
  summary: z.string(),
});
export type BlastRadiusGraph = z.infer<typeof blastRadiusGraphSchema>;

export const changedFileSchema = z.object({
  path: z.string().min(1),
  changeType: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'RENAMED']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const changeRefSchema = z.object({
  provider: z.enum(['GITHUB', 'DEMO']),
  repositoryFullName: z.string().min(1),
  commitSha: z.string().min(1),
  baseSha: z.string().nullable(),
  branch: z.string().nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  title: z.string(),
  author: z.string(),
});
export type ChangeRef = z.infer<typeof changeRefSchema>;

export const remediationSchema = z.object({
  findingId: z.string().min(1),
  /** Stable id of the remediation generator, e.g. "secret-flow-env-removal-v1". */
  strategy: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string(),
  /** Unified diff. Generated by deterministic code, reviewed by a human. */
  diff: z.string(),
  affectedFiles: z.array(z.string()),
  expectedImpact: z.string(),
});
export type Remediation = z.infer<typeof remediationSchema>;

/**
 * How a model contributed to an investigation, if one did.
 *
 * Recorded so the UI can state the path that actually ran. It never contains a
 * credential: only the provider name, the model, and usage counters.
 */
export const modelProvenanceSchema = z.object({
  /** e.g. "OpenRouter" or "Ollama". Null when no model ran. */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  modelLabel: z.string().nullable(),
  modelUsed: z.boolean(),
  /** One line for the UI, e.g. "OpenRouter · Claude Sonnet 4.5". */
  display: z.string(),
  /** Why a non-preferred provider was used, when one was. */
  fallbackReason: z.string().nullable(),
  /** Why no model ran at all. */
  unavailableReason: z.string().nullable(),
  calls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Estimated tokens of context actually assembled for the model. */
  estimatedTokens: z.number().int().nonnegative().nullable(),
});
export type ModelProvenance = z.infer<typeof modelProvenanceSchema>;

export const investigationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  repositoryId: z.string().min(1),
  /** Human-facing reference such as INV-0042. */
  reference: z.string().min(1),
  change: changeRefSchema,
  changedFiles: z.array(changedFileSchema),
  status: z.enum(INVESTIGATION_STATUSES),
  severity: severitySchema.nullable(),
  /** One-sentence consequence statement, or null before analysis completes. */
  summary: z.string().nullable(),
  /** Set only when status is FAILED. */
  failureReason: z.string().nullable(),
  /** True when the investigation ran against the built-in demo fixture. */
  isDemo: z.boolean(),
  /** Null until the investigation has decided how it was interpreted. */
  modelProvenance: modelProvenanceSchema.nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type Investigation = z.infer<typeof investigationSchema>;

export const actionSchema = z.object({
  id: z.string().min(1),
  investigationId: z.string().min(1),
  type: z.enum(['CREATE_REMEDIATION_PR']),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED']),
  /** Verified identity of the approver. Never supplied by the client. */
  requestedBy: z.string(),
  approvedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  /** URL of the created pull request, once executed. */
  resultUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
});
export type Action = z.infer<typeof actionSchema>;

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  ownerId: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const repositorySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  provider: z.enum(['GITHUB', 'DEMO']),
  fullName: z.string().min(1),
  defaultBranch: z.string().min(1),
  githubInstallationId: z.number().int().positive().nullable(),
  githubRepositoryId: z.number().int().positive().nullable(),
  monitoringEnabled: z.boolean(),
  createdAt: z.string().datetime(),
});
export type Repository = z.infer<typeof repositorySchema>;

export const auditEventSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  actorId: z.string().min(1),
  action: z.string().min(1),
  resource: z.string().min(1),
  result: z.enum(['SUCCESS', 'FAILURE', 'DENIED']),
  detail: z.string(),
  createdAt: z.string().datetime(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** The complete investigation payload the investigation screen renders. */
export const investigationDetailSchema = z.object({
  investigation: investigationSchema,
  findings: z.array(findingSchema),
  evidence: z.array(evidenceSchema),
  verifications: z.array(verificationResultSchema),
  graph: blastRadiusGraphSchema.nullable(),
  remediation: remediationSchema.nullable(),
  action: actionSchema.nullable(),
});
export type InvestigationDetail = z.infer<typeof investigationDetailSchema>;
