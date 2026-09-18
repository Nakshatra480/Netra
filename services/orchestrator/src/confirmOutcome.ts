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
  if (status !== 'AWAITING_APPROVAL' && !isTerminal(status)) {
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
    severity: (record.severity as string | null) ?? null,
    summary: (record.summary as string | null) ?? null,
    failureReason: (record.failureReason as string | null) ?? null,
  };
}
