import { isTerminal, type InvestigationStatus } from '@netra/domain';
import { getInvestigation } from './store.js';

/**
 * Last state of the workflow.
 *
 * The Fargate task performs the investigation and records each transition as
 * it happens. This handler reads back what the task actually achieved, so the
 * workflow's success is decided by the stored record rather than by the task
 * merely exiting zero.
 */

export interface ConfirmResult {
  investigationId: string;
  status: InvestigationStatus;
  /** True once a human approved and the remediation task took over. */
  remediating?: boolean;
  awaitingApproval: boolean;
  severity: string | null;
  summary: string | null;
  failureReason: string | null;
}

export class OutcomeMissing extends Error {
  constructor(investigationId: string) {
    super(`No investigation record found for ${investigationId}`);
    this.name = 'OutcomeMissing';
  }
}

export class OutcomeIncomplete extends Error {
  constructor(status: string) {
    super(`The investigation stopped at ${status} without reaching a conclusion`);
    this.name = 'OutcomeIncomplete';
  }
}

/**
 * States that only a human approval can produce.
 *
 * Reaching one of these means the workflow's job is done: the decision was
 * made and the remediation task owns the record from here, including writing
 * the terminal status once post-fix verification has run.
 */
function isPostApproval(status: InvestigationStatus): boolean {
  return status === 'REMEDIATING' || status === 'POST_FIX_VERIFY';
}

function log(level: 'INFO' | 'WARN', message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, message, ...fields }));
}

export async function handler(event: { investigationId?: string }): Promise<ConfirmResult> {
  const investigationId = event.investigationId?.trim();
  if (!investigationId) throw new OutcomeMissing('(none supplied)');

  const record = await getInvestigation(investigationId);
  if (!record) throw new OutcomeMissing(investigationId);

  const status = record.status;

  // An investigation that ended mid-lifecycle is a failure even if the task
  // exited cleanly: something stopped without saying so.
  //
  // Approval is the exception. The investigator writes AWAITING_APPROVAL and
  // exits, and this step runs a moment later — so a reviewer who approves in
  // that window moves the record to REMEDIATING before this check reads it.
  // Treating that as "stopped mid-lifecycle" would fail an investigation that
  // a human had just approved, and abandon the remediation already running.
  if (status !== 'AWAITING_APPROVAL' && !isTerminal(status) && !isPostApproval(status)) {
    log('WARN', 'investigation ended mid-lifecycle', { investigationId, status });
    throw new OutcomeIncomplete(status);
  }

  log('INFO', 'investigation outcome confirmed', {
    investigationId,
    status,
    severity: record.severity ?? undefined,
  });

  return {
    investigationId,
    status,
    awaitingApproval: status === 'AWAITING_APPROVAL',
    // Already approved and under way; the workflow has nothing left to add.
    remediating: isPostApproval(status),
    severity: (record.severity as string | null) ?? null,
    summary: (record.summary as string | null) ?? null,
    failureReason: (record.failureReason as string | null) ?? null,
  };
}
