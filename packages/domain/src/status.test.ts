import { describe, expect, it } from 'vitest';
import {
  INVESTIGATION_STATUSES,
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isTerminal,
  STATUS_LABELS,
} from './status.js';

describe('investigation state machine', () => {
  it('walks the full happy path from event to resolution', () => {
    const happyPath = [
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
    ] as const;

    for (let i = 0; i < happyPath.length - 1; i += 1) {
      expect(canTransition(happyPath[i], happyPath[i + 1])).toBe(true);
    }
  });

  it('rejects skipping a phase', () => {
    expect(canTransition('CREATED', 'VERIFYING')).toBe(false);
    expect(() => assertTransition('CREATED', 'VERIFYING')).toThrow(InvalidTransitionError);
  });

  it('rejects moving backwards', () => {
    expect(canTransition('VERIFYING', 'PREPARING')).toBe(false);
  });

  it('allows failure from any non-terminal state', () => {
    for (const status of INVESTIGATION_STATUSES) {
      expect(canTransition(status, 'FAILED')).toBe(!isTerminal(status));
    }
  });

  it('never leaves a terminal state', () => {
    for (const terminal of ['RESOLVED', 'REJECTED', 'FAILED'] as const) {
      for (const target of INVESTIGATION_STATUSES) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('resolves directly from RECOMMENDATION when nothing needs remediation', () => {
    expect(canTransition('RECOMMENDATION', 'RESOLVED')).toBe(true);
  });

  it('requires a human decision to leave AWAITING_APPROVAL', () => {
    expect(canTransition('AWAITING_APPROVAL', 'REMEDIATING')).toBe(true);
    expect(canTransition('AWAITING_APPROVAL', 'REJECTED')).toBe(true);
    // Remediation can never bypass the approval boundary.
    expect(canTransition('RECOMMENDATION', 'REMEDIATING')).toBe(false);
  });

  it('labels every status', () => {
    for (const status of INVESTIGATION_STATUSES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
    }
  });
});
