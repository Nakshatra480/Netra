/**
 * The investigation lifecycle.
 *
 * This is the single source of truth for investigation state. The AWS Step
 * Functions state machine, the API and the UI all derive their behaviour from
 * these definitions so that a state can never mean two different things.
 */

export const INVESTIGATION_STATUSES = [
  'RECEIVED',
  'CREATED',
  'PREPARING',
  'INVESTIGATING',
  'EVIDENCE_COLLECTION',
  'VERIFYING',
  'IMPACT_ANALYSIS',
  'RECOMMENDATION',
  'AWAITING_APPROVAL',
  'REMEDIATING',
  'POST_FIX_VERIFY',
  'RESOLVED',
  'REJECTED',
  'FAILED',
] as const;

export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];

/**
 * Allowed forward transitions. `FAILED` is reachable from every non-terminal
 * state and is therefore handled separately rather than duplicated here.
 */
const FORWARD_TRANSITIONS: Readonly<Record<InvestigationStatus, readonly InvestigationStatus[]>> = {
  RECEIVED: ['CREATED'],
  CREATED: ['PREPARING'],
  PREPARING: ['INVESTIGATING'],
  INVESTIGATING: ['EVIDENCE_COLLECTION'],
  EVIDENCE_COLLECTION: ['VERIFYING'],
  VERIFYING: ['IMPACT_ANALYSIS'],
  IMPACT_ANALYSIS: ['RECOMMENDATION'],
  // An investigation that produced no remediable finding resolves directly.
  RECOMMENDATION: ['AWAITING_APPROVAL', 'RESOLVED'],
  AWAITING_APPROVAL: ['REMEDIATING', 'REJECTED'],
  REMEDIATING: ['POST_FIX_VERIFY'],
  POST_FIX_VERIFY: ['RESOLVED'],
  RESOLVED: [],
  REJECTED: [],
  FAILED: [],
};

export const TERMINAL_STATUSES: readonly InvestigationStatus[] = ['RESOLVED', 'REJECTED', 'FAILED'];

export function isTerminal(status: InvestigationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: InvestigationStatus, to: InvestigationStatus): boolean {
  if (from === to) return false;
  if (to === 'FAILED') return !isTerminal(from);
  return FORWARD_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: InvestigationStatus,
    readonly to: InvestigationStatus,
  ) {
    super(`Invalid investigation transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: InvestigationStatus, to: InvestigationStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Ordered phases used by the UI progress rail. Excludes terminal outcomes. */
export const INVESTIGATION_PHASES: readonly InvestigationStatus[] = [
  'CREATED',
  'PREPARING',
  'INVESTIGATING',
  'EVIDENCE_COLLECTION',
  'VERIFYING',
  'IMPACT_ANALYSIS',
  'RECOMMENDATION',
  'AWAITING_APPROVAL',
  'REMEDIATING',
  'POST_FIX_VERIFY',
];

/** Short human-readable label for each state, used in UI and logs. */
export const STATUS_LABELS: Readonly<Record<InvestigationStatus, string>> = {
  RECEIVED: 'Event received',
  CREATED: 'Investigation created',
  PREPARING: 'Preparing workspace',
  INVESTIGATING: 'Investigating change',
  EVIDENCE_COLLECTION: 'Collecting evidence',
  VERIFYING: 'Verifying deterministically',
  IMPACT_ANALYSIS: 'Analysing blast radius',
  RECOMMENDATION: 'Preparing recommendation',
  AWAITING_APPROVAL: 'Awaiting your approval',
  REMEDIATING: 'Creating remediation',
  POST_FIX_VERIFY: 'Verifying the fix',
  RESOLVED: 'Resolved',
  REJECTED: 'Rejected by reviewer',
  FAILED: 'Failed',
};
