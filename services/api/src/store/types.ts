import type {
  Action,
  AuditEvent,
  BlastRadiusGraph,
  Evidence,
  Finding,
  Investigation,
  InvestigationEvent,
  InvestigationStatus,
  Remediation,
  Repository,
  VerificationResult,
  Workspace,
} from '@netra/domain';

/**
 * Persistence boundary.
 *
 * Every route talks to this interface rather than to DynamoDB directly, so the
 * data model is defined in one place and the API can run locally without AWS.
 */
export interface Store {
  createWorkspace(workspace: Workspace): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  listWorkspacesForOwner(ownerId: string): Promise<Workspace[]>;

  createRepository(repository: Repository): Promise<Repository>;
  getRepository(id: string): Promise<Repository | null>;
  listRepositories(workspaceId: string): Promise<Repository[]>;

  createInvestigation(investigation: Investigation): Promise<Investigation>;
  getInvestigation(id: string): Promise<Investigation | null>;
  listInvestigations(workspaceId: string, limit: number): Promise<Investigation[]>;
  updateInvestigation(
    id: string,
    patch: Partial<
      Pick<
        Investigation,
        | 'status'
        | 'severity'
        | 'summary'
        | 'failureReason'
        | 'completedAt'
        | 'changedFiles'
        | 'modelProvenance'
      >
    >,
  ): Promise<Investigation>;

  appendEvents(investigationId: string, events: InvestigationEvent[]): Promise<void>;
  listEvents(investigationId: string, afterSeq: number): Promise<InvestigationEvent[]>;

  putFindings(investigationId: string, findings: Finding[]): Promise<void>;
  listFindings(investigationId: string): Promise<Finding[]>;
  updateFindingStatus(findingId: string, status: Finding['status']): Promise<void>;

  putEvidence(investigationId: string, evidence: Evidence[]): Promise<void>;
  listEvidence(investigationId: string): Promise<Evidence[]>;

  putVerifications(investigationId: string, results: VerificationResult[]): Promise<void>;
  listVerifications(investigationId: string): Promise<VerificationResult[]>;

  putGraph(investigationId: string, graph: BlastRadiusGraph): Promise<void>;
  getGraph(investigationId: string): Promise<BlastRadiusGraph | null>;

  putRemediation(investigationId: string, remediation: Remediation): Promise<void>;
  getRemediation(investigationId: string): Promise<Remediation | null>;

  putAction(action: Action): Promise<void>;
  getAction(investigationId: string): Promise<Action | null>;
  updateAction(actionId: string, patch: Partial<Action>): Promise<Action>;

  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(workspaceId: string, limit: number): Promise<AuditEvent[]>;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export type StatusPatch = { status: InvestigationStatus };
