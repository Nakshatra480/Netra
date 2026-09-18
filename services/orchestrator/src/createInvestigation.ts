import { randomBytes } from 'node:crypto';
import { createInvestigation, type InvestigationRecord } from './store.js';

/**
 * First state of the investigation workflow.
 *
 * Turns a `Netra.CodeChange` event into an investigation record, and decides
 * whether this workflow should continue at all. A replayed event -- from an
 * EventBridge archive replay, a GitHub redelivery, or a Step Functions retry --
 * finds the record already present and stops here rather than investigating the
 * same commit twice.
 */

export interface CodeChangeDetail {
  deliveryId?: string;
  source?: string;
  installationId?: number | null;
  repository?: {
    fullName?: string;
    githubId?: number | null;
    defaultBranch?: string | null;
    private?: boolean;
  };
  change?: {
    commitSha?: string;
    baseSha?: string | null;
    branch?: string | null;
    pullRequestNumber?: number | null;
    title?: string;
    author?: string;
  };
  receivedAt?: string;
}

export interface CreateResult {
  investigationId: string;
  deliveryId: string;
  duplicate: boolean;
  repository: string;
  commitSha: string;
  baseSha: string;
  installationId: number;
  changeTitle: string;
}

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, message, ...fields }));
}

/**
 * Derive a stable investigation id from the delivery id.
 *
 * Deterministic on purpose: the same delivery always maps to the same
 * investigation, so idempotency does not depend on a lookup succeeding first.
 */
export function investigationIdFor(deliveryId: string): string {
  const compact = deliveryId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return `inv_${compact || randomBytes(12).toString('hex')}`;
}

export function validate(detail: CodeChangeDetail): Required<
  Pick<CreateResult, 'deliveryId' | 'repository' | 'commitSha' | 'installationId' | 'changeTitle'>
> & { baseSha: string; pullRequestNumber: number | null } {
  const deliveryId = detail.deliveryId?.trim();
  if (!deliveryId) throw new InvalidEventError('deliveryId is missing');

  const repository = detail.repository?.fullName?.trim();
  if (!repository) throw new InvalidEventError('repository.fullName is missing');
  // Guard the value that will become a clone target.
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new InvalidEventError(`repository.fullName is not an owner/name pair: ${repository}`);
  }

  const commitSha = detail.change?.commitSha?.trim();
  if (!commitSha || !/^[0-9a-f]{7,40}$/.test(commitSha)) {
    throw new InvalidEventError('change.commitSha is missing or not a commit sha');
  }

  const baseSha = detail.change?.baseSha?.trim() ?? '';
  if (baseSha && !/^[0-9a-f]{7,40}$/.test(baseSha)) {
    throw new InvalidEventError('change.baseSha is not a commit sha');
  }

  const installationId = detail.installationId;
  if (typeof installationId !== 'number' || !Number.isFinite(installationId)) {
    // Without an installation there is no token, so there is no clone.
    throw new InvalidEventError('installationId is missing');
  }

  return {
    deliveryId,
    repository,
    commitSha,
    baseSha,
    installationId,
    changeTitle: (detail.change?.title ?? 'Change under investigation').slice(0, 200),
    pullRequestNumber: detail.change?.pullRequestNumber ?? null,
  };
}

export async function handler(event: { detail?: CodeChangeDetail }): Promise<CreateResult> {
  const detail = event.detail ?? {};
  const change = validate(detail);
  const investigationId = investigationIdFor(change.deliveryId);

  const record: InvestigationRecord = {
    id: investigationId,
    deliveryId: change.deliveryId,
    status: 'CREATED',
    repository: change.repository,
    commitSha: change.commitSha,
    baseSha: change.baseSha || null,
    pullRequestNumber: change.pullRequestNumber,
    branch: detail.change?.branch ?? null,
    author: detail.change?.author ?? 'unknown',
    changeTitle: change.changeTitle,
    installationId: change.installationId,
    source: detail.source ?? 'unknown',
    severity: null,
    summary: null,
    failureReason: null,
    isDemo: false,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  const outcome = await createInvestigation(record);
  const duplicate = outcome === 'DUPLICATE';

  log('INFO', duplicate ? 'investigation already exists' : 'investigation created', {
    investigationId,
    deliveryId: change.deliveryId,
    repository: change.repository,
    commitSha: change.commitSha.slice(0, 12),
  });

  return {
    investigationId,
    deliveryId: change.deliveryId,
    duplicate,
    repository: change.repository,
    commitSha: change.commitSha,
    baseSha: change.baseSha,
    installationId: change.installationId,
    changeTitle: change.changeTitle,
  };
}
