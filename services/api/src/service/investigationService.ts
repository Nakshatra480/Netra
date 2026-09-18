import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertTransition,
  type Action,
  type ChangedFile,
  type Investigation,
  type InvestigationDetail,
  type InvestigationEvent,
  type ModelProvenance,
  type Severity,
} from '@netra/domain';
import { investigatorEnv, type Config } from '../config.js';
import type { Identity } from '../auth/identity.js';
import { EventBroker } from '../runner/broker.js';
import { InvestigatorRunner } from '../runner/investigator.js';
import type { Store } from '../store/types.js';
import { createDemoCheckout, type DemoCheckout } from './demoRepository.js';
import { investigationReference, newId, nowIso } from './ids.js';

/**
 * Orchestrates investigations: creating them, running the engine, recording
 * what it found, and applying remediation once a human has approved it.
 *
 * The approval boundary is enforced here as well as in the state machine: an
 * action must exist, be PENDING, and be approved by a verified identity before
 * any remediation runs.
 */
export class InvestigationService {
  #sequence = 0;
  readonly #checkouts = new Map<string, DemoCheckout>();

  constructor(
    private readonly store: Store,
    private readonly broker: EventBroker,
    private readonly config: Config,
    private readonly runner = new InvestigatorRunner(),
  ) {}

  async startDemoInvestigation(
    identity: Identity,
    workspaceId: string,
  ): Promise<Investigation> {
    const checkout = await createDemoCheckout(this.config.demoRepoBuilder);

    const repository = await this.store.createRepository({
      id: newId('repo'),
      workspaceId,
      provider: 'DEMO',
      fullName: 'orbital/payments',
      defaultBranch: 'main',
      githubInstallationId: null,
      githubRepositoryId: null,
      monitoringEnabled: true,
      createdAt: nowIso(),
    });

    this.#sequence += 1;
    const investigation: Investigation = {
      id: newId('inv'),
      workspaceId,
      repositoryId: repository.id,
      reference: investigationReference(this.#sequence),
      change: {
        provider: 'DEMO',
        repositoryFullName: repository.fullName,
        commitSha: checkout.headSha,
        baseSha: checkout.baseSha,
        branch: 'feature/browser-receipt-upload',
        pullRequestNumber: 182,
        title: 'Enable direct receipt upload from the browser',
        author: 'priya@orbital.example',
      },
      changedFiles: [],
      modelProvenance: null,
      status: 'RECEIVED',
      severity: null,
      summary: null,
      failureReason: null,
      isDemo: true,
      startedAt: nowIso(),
      completedAt: null,
    };

    await this.store.createInvestigation(investigation);
    this.#checkouts.set(investigation.id, checkout);

    // The investigation runs in the background so the client can subscribe to
    // its event stream immediately rather than waiting for a slow response.
    void this.#run(investigation, checkout);

    await this.#audit(identity, workspaceId, 'investigation.start', investigation.id, 'SUCCESS');
    return investigation;
  }

  async #run(investigation: Investigation, checkout: DemoCheckout): Promise<void> {
    try {
      const outcome = await this.runner.run(
        {
          python: this.config.investigatorPython,
          cwd: this.config.investigatorCwd,
          args: [
            'run',
            '--investigation-id', investigation.id,
            '--repo', checkout.path,
            '--base-sha', checkout.baseSha,
            '--head-sha', checkout.headSha,
            '--repository', investigation.change.repositoryFullName,
            '--title', investigation.change.title,
          ],
          env: investigatorEnv(this.config),
        },
        (event) => this.#handleEvent(investigation.id, event),
      );

      await this.#persistOutcome(investigation, outcome.result, outcome.exitCode, outcome.stderr);
    } catch (error) {
      await this.#fail(investigation.id, `The investigation could not be started: ${(error as Error).message}`);
    }
  }

  async #handleEvent(investigationId: string, event: InvestigationEvent): Promise<void> {
    await this.store.appendEvents(investigationId, [event]);
    this.broker.publish(investigationId, event);

    // Investigation state is kept current as it changes, so a client that loads
    // the page mid-investigation sees the true state without waiting.
    if (event.type === 'status_changed') {
      await this.store.updateInvestigation(investigationId, {
        status: event.status,
        failureReason: event.reason ?? null,
        ...(event.status === 'RESOLVED' || event.status === 'FAILED'
          ? { completedAt: nowIso() }
          : {}),
      });
    }
  }

  async #persistOutcome(
    investigation: Investigation,
    result: Record<string, unknown> | null,
    exitCode: number,
    stderr: string,
  ): Promise<void> {
    if (!result) {
      await this.#fail(
        investigation.id,
        exitCode === 0
          ? 'The investigation finished without reporting a result.'
          : `The investigation engine exited with code ${exitCode}. ${lastLine(stderr)}`,
      );
      return;
    }

    const finding = result.finding as InvestigationDetail['findings'][number] | null;
    const evidence = (result.evidence ?? []) as InvestigationDetail['evidence'];
    const verifications = (result.verifications ?? []) as InvestigationDetail['verifications'];
    const graph = result.graph as InvestigationDetail['graph'];
    const remediation = result.remediation as InvestigationDetail['remediation'];
    const action = result.action as Action | null;

    if (finding) await this.store.putFindings(investigation.id, [finding]);
    if (evidence.length) await this.store.putEvidence(investigation.id, evidence);
    if (verifications.length) await this.store.putVerifications(investigation.id, verifications);
    if (graph) await this.store.putGraph(investigation.id, graph);
    if (remediation) await this.store.putRemediation(investigation.id, remediation);
    if (action) await this.store.putAction(action);

    await this.store.updateInvestigation(investigation.id, {
      status: result.status as Investigation['status'],
      severity: (result.severity as Severity | null) ?? null,
      summary: (result.summary as string | null) ?? null,
      failureReason: (result.failureReason as string | null) ?? null,
      changedFiles: (result.changedFiles as ChangedFile[]) ?? [],
      modelProvenance: toProvenance(result.model_metadata),
    });
  }

  async #fail(investigationId: string, reason: string): Promise<void> {
    const current = await this.store.getInvestigation(investigationId);
    if (!current || current.status === 'FAILED') return;

    const event: InvestigationEvent = {
      type: 'status_changed',
      seq: Number.MAX_SAFE_INTEGER,
      investigationId,
      at: nowIso(),
      status: 'FAILED',
      reason,
    };
    await this.store.appendEvents(investigationId, [event]);
    this.broker.publish(investigationId, event);
    await this.store.updateInvestigation(investigationId, {
      status: 'FAILED',
      failureReason: reason,
      completedAt: nowIso(),
    });
  }

  // -- human decisions ---------------------------------------------------

  async approve(
    identity: Identity,
    investigationId: string,
    actionId: string,
    note: string | undefined,
  ): Promise<Action> {
    const { investigation, action } = await this.#pendingAction(investigationId, actionId);
    assertTransition(investigation.status, 'REMEDIATING');

    const approved = await this.store.updateAction(action.id, {
      status: 'APPROVED',
      // The approver is the verified identity, never a value from the request.
      approvedBy: identity.userId,
      decisionNote: note ?? null,
      decidedAt: nowIso(),
    });
    await this.#audit(
      identity,
      investigation.workspaceId,
      'remediation.approve',
      investigationId,
      'SUCCESS',
    );

    void this.#remediate(investigation, approved, identity);
    return approved;
  }

  async reject(
    identity: Identity,
    investigationId: string,
    actionId: string,
    reason: string,
  ): Promise<Action> {
    const { investigation, action } = await this.#pendingAction(investigationId, actionId);
    assertTransition(investigation.status, 'REJECTED');

    const rejected = await this.store.updateAction(action.id, {
      status: 'REJECTED',
      approvedBy: identity.userId,
      decisionNote: reason,
      decidedAt: nowIso(),
    });

    const findings = await this.store.listFindings(investigationId);
    for (const finding of findings) {
      await this.store.updateFindingStatus(finding.id, 'REJECTED');
    }

    await this.#emit(investigationId, { type: 'action_updated', action: rejected });
    await this.#emit(investigationId, {
      type: 'status_changed',
      status: 'REJECTED',
      reason: null,
    });
    await this.store.updateInvestigation(investigationId, {
      status: 'REJECTED',
      completedAt: nowIso(),
    });
    await this.#audit(
      identity,
      investigation.workspaceId,
      'remediation.reject',
      investigationId,
      'SUCCESS',
    );
    return rejected;
  }

  async #pendingAction(
    investigationId: string,
    actionId: string,
  ): Promise<{ investigation: Investigation; action: Action }> {
    const investigation = await this.store.getInvestigation(investigationId);
    if (!investigation) throw new ApprovalError('NOT_FOUND', 'Investigation not found');

    const action = await this.store.getAction(investigationId);
    if (!action) throw new ApprovalError('NOT_FOUND', 'No action awaits approval');
    if (action.id !== actionId) {
      throw new ApprovalError('CONFLICT', 'That action does not belong to this investigation');
    }
    if (action.status !== 'PENDING') {
      throw new ApprovalError('CONFLICT', `This action was already ${action.status.toLowerCase()}`);
    }
    return { investigation, action };
  }

  async #remediate(investigation: Investigation, action: Action, identity: Identity): Promise<void> {
    const checkout = this.#checkouts.get(investigation.id);
    const remediation = await this.store.getRemediation(investigation.id);
    const findings = await this.store.listFindings(investigation.id);
    const finding = findings[0];

    if (!checkout || !remediation || !finding) {
      await this.#fail(investigation.id, 'The approved remediation is no longer available.');
      return;
    }

    await this.#emit(investigation.id, { type: 'status_changed', status: 'REMEDIATING', reason: null });

    const diffDir = await mkdtemp(join(tmpdir(), 'netra-diff-'));
    const diffFile = join(diffDir, 'remediation.patch');
    await writeFile(diffFile, remediation.diff, 'utf8');

    try {
      const outcome = await this.runner.run(
        {
          python: this.config.investigatorPython,
          cwd: this.config.investigatorCwd,
          args: [
            'remediate',
            '--investigation-id', investigation.id,
            '--reference', investigation.reference,
            '--repo', checkout.path,
            '--base-sha', checkout.baseSha,
            '--finding-id', finding.id,
            '--finding-title', finding.title,
            '--approver', identity.userId,
            '--diff-file', diffFile,
          ],
          env: investigatorEnv(this.config),
        },
        (event) => this.#handleEvent(investigation.id, event),
      );

      const result = outcome.result ?? {};
      const verification = result.verification as InvestigationDetail['verifications'][number] | undefined;
      if (verification) await this.store.putVerifications(investigation.id, [verification]);

      const resolved = result.status === 'RESOLVED';
      await this.store.updateAction(action.id, {
        status: resolved ? 'EXECUTED' : 'FAILED',
      });
      await this.store.updateFindingStatus(finding.id, resolved ? 'RESOLVED' : 'REMEDIATED');
      await this.store.updateInvestigation(investigation.id, {
        status: resolved ? 'RESOLVED' : 'FAILED',
        completedAt: nowIso(),
        failureReason: resolved
          ? null
          : 'Post-fix verification still finds the credential exposure.',
      });
    } catch (error) {
      await this.#fail(investigation.id, `Remediation failed: ${(error as Error).message}`);
    } finally {
      await rm(diffDir, { recursive: true, force: true });
    }
  }

  async #emit(investigationId: string, partial: EmittableEvent): Promise<void> {
    const existing = await this.store.listEvents(investigationId, 0);
    const event = {
      ...partial,
      seq: existing.length + 1,
      investigationId,
      at: nowIso(),
    } as InvestigationEvent;
    await this.store.appendEvents(investigationId, [event]);
    this.broker.publish(investigationId, event);
  }

  async #audit(
    identity: Identity,
    workspaceId: string,
    action: string,
    resource: string,
    result: 'SUCCESS' | 'FAILURE' | 'DENIED',
    detail = '',
  ): Promise<void> {
    await this.store.appendAudit({
      id: newId('aud'),
      workspaceId,
      actorId: identity.userId,
      action,
      resource,
      result,
      detail,
      createdAt: nowIso(),
    });
  }

  async releaseCheckout(investigationId: string): Promise<void> {
    const checkout = this.#checkouts.get(investigationId);
    if (!checkout) return;
    this.#checkouts.delete(investigationId);
    await checkout.cleanup();
  }
}

/**
 * An investigation event minus the fields the service fills in.
 *
 * `Omit` does not distribute over a union, so it is applied per member to keep
 * each event variant's own fields required.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EmittableEvent = DistributiveOmit<InvestigationEvent, 'seq' | 'investigationId' | 'at'>;

export class ApprovalError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/**
 * Normalise the engine's model metadata for storage.
 *
 * Defensive by design: the UI must never claim an AI run happened because a
 * field was missing, so an unreadable payload becomes "no model ran".
 */
function toProvenance(raw: unknown): ModelProvenance | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const num = (key: string) => (typeof m[key] === 'number' ? (m[key] as number) : 0);
  const str = (key: string) => (typeof m[key] === 'string' ? (m[key] as string) : null);

  return {
    provider: str('provider'),
    model: str('model'),
    modelLabel: str('modelLabel'),
    modelUsed: m.modelUsed === true,
    display: str('display') ?? 'AI unavailable — deterministic analysis',
    fallbackReason: str('fallbackReason'),
    unavailableReason: str('unavailableReason'),
    calls: num('calls'),
    toolCalls: num('toolCalls'),
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    totalTokens: num('totalTokens'),
    costUsd: num('costUsd'),
    estimatedTokens: typeof m.estimatedTokens === 'number' ? m.estimatedTokens : null,
  };
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}
