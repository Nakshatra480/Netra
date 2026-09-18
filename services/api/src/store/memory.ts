import type {
  Action,
  AuditEvent,
  BlastRadiusGraph,
  Evidence,
  Finding,
  Investigation,
  InvestigationEvent,
  Remediation,
  Repository,
  VerificationResult,
  Workspace,
} from '@netra/domain';
import { NotFoundError, type Store } from './types.js';

/**
 * In-memory store used for local development and tests.
 *
 * It implements exactly the same contract as the DynamoDB store, so the code
 * paths exercised locally are the code paths that run in AWS.
 */
export class MemoryStore implements Store {
  #workspaces = new Map<string, Workspace>();
  #repositories = new Map<string, Repository>();
  #investigations = new Map<string, Investigation>();
  #events = new Map<string, InvestigationEvent[]>();
  #findings = new Map<string, Finding[]>();
  #evidence = new Map<string, Evidence[]>();
  #verifications = new Map<string, VerificationResult[]>();
  #graphs = new Map<string, BlastRadiusGraph>();
  #remediations = new Map<string, Remediation>();
  #actions = new Map<string, Action>();
  #audit: AuditEvent[] = [];

  async createWorkspace(workspace: Workspace): Promise<Workspace> {
    this.#workspaces.set(workspace.id, workspace);
    return workspace;
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    return this.#workspaces.get(id) ?? null;
  }

  async listWorkspacesForOwner(ownerId: string): Promise<Workspace[]> {
    return [...this.#workspaces.values()].filter((w) => w.ownerId === ownerId);
  }

  async createRepository(repository: Repository): Promise<Repository> {
    this.#repositories.set(repository.id, repository);
    return repository;
  }

  async getRepository(id: string): Promise<Repository | null> {
    return this.#repositories.get(id) ?? null;
  }

  async listRepositories(workspaceId: string): Promise<Repository[]> {
    return [...this.#repositories.values()].filter((r) => r.workspaceId === workspaceId);
  }

  async createInvestigation(investigation: Investigation): Promise<Investigation> {
    this.#investigations.set(investigation.id, investigation);
    return investigation;
  }

  async getInvestigation(id: string): Promise<Investigation | null> {
    return this.#investigations.get(id) ?? null;
  }

  async listInvestigations(workspaceId: string, limit: number): Promise<Investigation[]> {
    return [...this.#investigations.values()]
      .filter((i) => i.workspaceId === workspaceId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  async updateInvestigation(
    id: string,
    patch: Partial<Investigation>,
  ): Promise<Investigation> {
    const existing = this.#investigations.get(id);
    if (!existing) throw new NotFoundError(`Investigation ${id}`);
    const updated = { ...existing, ...patch };
    this.#investigations.set(id, updated);
    return updated;
  }

  async appendEvents(investigationId: string, events: InvestigationEvent[]): Promise<void> {
    const list = this.#events.get(investigationId) ?? [];
    list.push(...events);
    this.#events.set(investigationId, list);
  }

  async listEvents(investigationId: string, afterSeq: number): Promise<InvestigationEvent[]> {
    return (this.#events.get(investigationId) ?? []).filter((e) => e.seq > afterSeq);
  }

  async putFindings(investigationId: string, findings: Finding[]): Promise<void> {
    this.#findings.set(investigationId, findings);
  }

  async listFindings(investigationId: string): Promise<Finding[]> {
    return this.#findings.get(investigationId) ?? [];
  }

  async updateFindingStatus(findingId: string, status: Finding['status']): Promise<void> {
    for (const [key, findings] of this.#findings) {
      const next = findings.map((f) => (f.id === findingId ? { ...f, status } : f));
      this.#findings.set(key, next);
    }
  }

  async putEvidence(investigationId: string, evidence: Evidence[]): Promise<void> {
    this.#evidence.set(investigationId, evidence);
  }

  async listEvidence(investigationId: string): Promise<Evidence[]> {
    return this.#evidence.get(investigationId) ?? [];
  }

  async putVerifications(investigationId: string, results: VerificationResult[]): Promise<void> {
    const existing = this.#verifications.get(investigationId) ?? [];
    this.#verifications.set(investigationId, [...existing, ...results]);
  }

  async listVerifications(investigationId: string): Promise<VerificationResult[]> {
    return this.#verifications.get(investigationId) ?? [];
  }

  async putGraph(investigationId: string, graph: BlastRadiusGraph): Promise<void> {
    this.#graphs.set(investigationId, graph);
  }

  async getGraph(investigationId: string): Promise<BlastRadiusGraph | null> {
    return this.#graphs.get(investigationId) ?? null;
  }

  async putRemediation(investigationId: string, remediation: Remediation): Promise<void> {
    this.#remediations.set(investigationId, remediation);
  }

  async getRemediation(investigationId: string): Promise<Remediation | null> {
    return this.#remediations.get(investigationId) ?? null;
  }

  async putAction(action: Action): Promise<void> {
    this.#actions.set(action.investigationId, action);
  }

  async getAction(investigationId: string): Promise<Action | null> {
    return this.#actions.get(investigationId) ?? null;
  }

  async updateAction(actionId: string, patch: Partial<Action>): Promise<Action> {
    for (const [key, action] of this.#actions) {
      if (action.id === actionId) {
        const updated = { ...action, ...patch };
        this.#actions.set(key, updated);
        return updated;
      }
    }
    throw new NotFoundError(`Action ${actionId}`);
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.#audit.push(event);
  }

  async listAudit(workspaceId: string, limit: number): Promise<AuditEvent[]> {
    return this.#audit
      .filter((a) => a.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}
