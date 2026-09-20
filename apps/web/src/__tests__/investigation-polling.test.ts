import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useInvestigation } from '@/hooks/useInvestigation';
import { api, ApiError, type Session } from '@/lib/api';
import type { InvestigationDetail, InvestigationStatus } from '@netra/domain';

/**
 * Following a running investigation.
 *
 * The backend record is the only source of truth for progress, and the event
 * stream does not deliver it in the deployed setup. These tests pin the
 * behaviour that replaced it: keep asking while it runs, back off when the API
 * is failing, and stop only at a real terminal state.
 */

const session: Session = { token: 't', idToken: 'i', scheme: 'bearer', workspaceId: 'w' };

function detail(status: InvestigationStatus, findings: unknown[] = []): InvestigationDetail {
  return {
    investigation: {
      id: 'inv_1',
      status,
      failureReason: null,
      severity: null,
      summary: null,
      change: { commitSha: 'abc', baseSha: null, branch: 'main' },
    },
    findings,
    evidence: [],
    verifications: [],
    graph: null,
    remediation: null,
    action: null,
  } as unknown as InvestigationDetail;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  // EventSource does not exist in jsdom; the hook attaches one but must not
  // depend on it, which is precisely what these tests assert.
  vi.stubGlobal(
    'EventSource',
    class {
      close() {}
      set onopen(_v: unknown) {}
      set onmessage(_v: unknown) {}
      set onerror(_v: unknown) {}
    },
  );
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Let the effect's already-resolved promises settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useInvestigation polling', () => {
  it('keeps re-reading a running investigation', async () => {
    const spy = vi.spyOn(api, 'getInvestigation').mockResolvedValue(detail('INVESTIGATING'));
    renderHook(() => useInvestigation(session, 'inv_1'));

    await flush();
    expect(spy).toHaveBeenCalledTimes(1); // initial load
    await advance(2500);
    expect(spy).toHaveBeenCalledTimes(2);
    await advance(2500);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('surfaces each real phase the backend reports', async () => {
    const spy = vi
      .spyOn(api, 'getInvestigation')
      .mockResolvedValueOnce(detail('PREPARING'))
      .mockResolvedValueOnce(detail('INVESTIGATING'))
      .mockResolvedValueOnce(detail('VERIFYING'))
      .mockResolvedValue(detail('RESOLVED'));

    const { result } = renderHook(() => useInvestigation(session, 'inv_1'));
    await flush();
    expect(result.current.status).toBe('PREPARING');

    await advance(2500);
    expect(result.current.status).toBe('INVESTIGATING');
    await advance(2500);
    expect(result.current.status).toBe('VERIFYING');
    await advance(2500);
    expect(result.current.status).toBe('RESOLVED');
    expect(spy).toHaveBeenCalled();
  });

  it('stops polling once a terminal state is reached', async () => {
    const spy = vi.spyOn(api, 'getInvestigation').mockResolvedValue(detail('RESOLVED'));
    renderHook(() => useInvestigation(session, 'inv_1'));

    await flush();
    expect(spy).toHaveBeenCalled();
    const afterTerminal = spy.mock.calls.length;

    await advance(30_000);
    // A reconcile read is allowed; a continuing timer is not.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(afterTerminal + 1);
  });

  it('does not stop on a non-terminal status it has no special case for', async () => {
    const spy = vi.spyOn(api, 'getInvestigation').mockResolvedValue(detail('AWAITING_APPROVAL'));
    renderHook(() => useInvestigation(session, 'inv_1'));

    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(2500);
    // Awaiting a human is not finished; the record can still change under it.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('backs off while the API is failing and recovers on success', async () => {
    const spy = vi
      .spyOn(api, 'getInvestigation')
      .mockRejectedValueOnce(new ApiError('INTERNAL', 'boom', 500))
      .mockRejectedValueOnce(new ApiError('INTERNAL', 'boom', 500))
      .mockResolvedValue(detail('INVESTIGATING'));

    const { result } = renderHook(() => useInvestigation(session, 'inv_1'));
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    await flush();
    expect(result.current.error).toBeTruthy();

    // Call 1 was the initial load, which failed. The poller itself starts at
    // the normal interval, so its first attempt lands at 2.5s and also fails.
    await advance(2500);
    expect(spy).toHaveBeenCalledTimes(2);

    // Now one failure is on record, so the next attempt waits 5s, not 2.5s.
    await advance(2499);
    expect(spy).toHaveBeenCalledTimes(2);
    await advance(2501);
    expect(spy).toHaveBeenCalledTimes(3);

    // That attempt succeeded, so the interval returns to normal.
    await flush();
    expect(result.current.error).toBeNull();
    await advance(2500);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('never runs two requests at once', async () => {
    let resolve!: (d: InvestigationDetail) => void;
    const spy = vi
      .spyOn(api, 'getInvestigation')
      .mockReturnValue(new Promise<InvestigationDetail>((r) => { resolve = r; }));

    renderHook(() => useInvestigation(session, 'inv_1'));
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);

    // The first read has not answered yet; timers firing must not stack on it.
    await advance(12_000);
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => { resolve(detail('INVESTIGATING')); });
  });

  it('stops polling when the page is left', async () => {
    const spy = vi.spyOn(api, 'getInvestigation').mockResolvedValue(detail('INVESTIGATING'));
    const { unmount } = renderHook(() => useInvestigation(session, 'inv_1'));

    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    unmount();

    await advance(15_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
