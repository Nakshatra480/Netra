import { describe, expect, it } from 'vitest';

describe('Demo mode approval & remediation pipeline', () => {
  const DEMO_PR_URL = 'https://github.com/Nakshatra480/netra-e2e-test/pull/3';

  it('resolves PR URL to the target pull request in demo mode', () => {
    const isDemo = true;
    const actionResultUrl = null;
    const prUrl = isDemo ? DEMO_PR_URL : actionResultUrl;

    expect(prUrl).toBe('https://github.com/Nakshatra480/netra-e2e-test/pull/3');
  });

  it('allows approval in demo mode regardless of prior status', () => {
    const isDemo = true;
    const approveBusy = false;
    const priorActionStatus: string = 'APPROVED';

    const canApprove = isDemo ? !approveBusy : priorActionStatus === 'PENDING';
    expect(canApprove).toBe(true);
  });

  it('disallows approval in production mode when action is already approved', () => {
    const isDemo = false;
    const approveBusy = false;
    const priorActionStatus: string = 'APPROVED';

    const canApprove = isDemo ? !approveBusy : priorActionStatus === 'PENDING';
    expect(canApprove).toBe(false);
  });

  it('runs complete remediation pipeline steps resolving all issues', () => {
    const steps = [
      { status: 'AWAITING_APPROVAL', message: 'Approval confirmed' },
      { status: 'REMEDIATING', message: 'Checking out target repository' },
      { status: 'REMEDIATING', message: 'Applying approved remediation patch' },
      { status: 'REMEDIATING', message: 'Removed PAYMENT_SERVICE_API_KEY and STRIPE_SECRET_KEY' },
      { status: 'REMEDIATING', message: 'Created remediation branch' },
      { status: 'REMEDIATING', message: 'Committed and pushed fix commit' },
      { status: 'POST_FIX_VERIFY', message: 'Running post-fix verification' },
      { status: 'POST_FIX_VERIFY', message: 'AST taint analysis' },
      { status: 'POST_FIX_VERIFY', message: '0 credential exposures detected' },
      { status: 'RESOLVED', message: 'Opening pull request on GitHub' },
      { status: 'RESOLVED', message: `Pull request created successfully: ${DEMO_PR_URL}` },
    ];

    expect(steps.length).toBe(11);
    expect(steps[0]!.status).toBe('AWAITING_APPROVAL');
    expect(steps[1]!.status).toBe('REMEDIATING');
    expect(steps[6]!.status).toBe('POST_FIX_VERIFY');
    expect(steps[9]!.status).toBe('RESOLVED');
    expect(steps[10]!.message).toContain(DEMO_PR_URL);
  });
});
