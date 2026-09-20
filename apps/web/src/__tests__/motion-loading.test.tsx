import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act, renderHook } from '@testing-library/react';
import { Expand, FadeIn, MotionProvider, Stagger } from '@/components/motion';
import {
  CommitSkeleton,
  FindingSkeleton,
  LoadingState,
  PendingValue,
  RepositorySkeleton,
  useSettledFlag,
} from '@/components/loading';

/**
 * Motion and loading behaviour.
 *
 * The visual result cannot be asserted here, so these cover the parts that are
 * behaviour rather than appearance: that content is readable regardless of
 * animation, that a loading state says what it is waiting for, and that an
 * unknown value is never rendered as a result.
 */

describe('motion primitives', () => {
  it('renders content immediately rather than gating it on an animation', () => {
    render(
      <MotionProvider>
        <FadeIn>
          <p>Two credentials reach the browser bundle</p>
        </FadeIn>
      </MotionProvider>,
    );
    // Present on first paint: motion may move it, but never withholds it.
    expect(screen.getByText('Two credentials reach the browser bundle')).toBeTruthy();
  });

  it('keeps list content present while staggering', () => {
    render(
      <MotionProvider>
        <Stagger>
          <div>first</div>
          <div>second</div>
        </Stagger>
      </MotionProvider>,
    );
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('shows nothing for a collapsed region and content for an open one', () => {
    const { rerender } = render(
      <MotionProvider>
        <Expand open={false}>
          <p>hidden detail</p>
        </Expand>
      </MotionProvider>,
    );
    expect(screen.queryByText('hidden detail')).toBeNull();

    rerender(
      <MotionProvider>
        <Expand open>
          <p>hidden detail</p>
        </Expand>
      </MotionProvider>,
    );
    expect(screen.getByText('hidden detail')).toBeTruthy();
  });

  it('honours a reduced-motion preference in JavaScript, not only in CSS', async () => {
    // The stylesheet's prefers-reduced-motion rule collapses CSS transitions,
    // but Framer Motion animates inline styles and never reads it. The
    // preference therefore has to be declared to Framer Motion itself, which
    // is what MotionProvider exists to do.
    const seen: Array<Record<string, unknown>> = [];
    vi.resetModules();
    vi.doMock('framer-motion', async () => {
      const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion');
      return {
        ...actual,
        MotionConfig: (props: Record<string, unknown>) => {
          seen.push(props);
          return actual.MotionConfig(props as never);
        },
      };
    });

    const { MotionProvider: Provider } = await import('@/components/motion');
    render(
      <Provider>
        <p>still readable</p>
      </Provider>,
    );

    expect(screen.getByText('still readable')).toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reducedMotion).toBe('user');
    vi.doUnmock('framer-motion');
    vi.resetModules();
  });
});

describe('loading states', () => {
  it('names the operation being waited on', () => {
    render(<LoadingState label="Loading commit history…" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Loading commit history…');
  });

  it('marks the region busy for assistive technology', () => {
    const { container } = render(
      <LoadingState label="Investigating security impact…">
        <FindingSkeleton />
      </LoadingState>,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('hides decorative placeholders from the accessibility tree', () => {
    const { container } = render(<CommitSkeleton rows={3} />);
    const placeholders = container.querySelectorAll('[aria-hidden="true"]');
    expect(placeholders.length).toBeGreaterThan(0);
  });

  it('renders the requested number of placeholder rows', () => {
    const { container } = render(<RepositorySkeleton rows={5} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(5);
  });
});

describe('PendingValue', () => {
  it('shows a placeholder instead of a value that is not known yet', () => {
    render(<PendingValue ready={false} value={<span>0</span>} />);
    // A zero here would be a claim about the change, not an absence of data.
    expect(screen.queryByText('0')).toBeNull();
  });

  it('shows the value once it is established', () => {
    render(<PendingValue ready value={<span>12</span>} />);
    expect(screen.getByText('12')).toBeTruthy();
  });
});

describe('useSettledFlag', () => {
  it('holds a just-appeared loading state briefly to avoid a flicker', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ p }) => useSettledFlag(p, 250), {
      initialProps: { p: true },
    });
    expect(result.current).toBe(true);

    rerender({ p: false });
    // Still held: the skeleton had only just rendered.
    expect(result.current).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(260);
    });
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });

  it('never extends an operation that is already slow', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ p }) => useSettledFlag(p, 250), {
      initialProps: { p: true },
    });

    // A request that took well over the floor releases the moment it answers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    rerender({ p: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });

  it('adds no wait when nothing was pending to begin with', () => {
    const { result } = renderHook(() => useSettledFlag(false, 250));
    expect(result.current).toBe(false);
  });
});

describe('investigation phases', () => {
  it('treats every pre-result status as still running', async () => {
    const { analysisRunning } = await import('@/pages/InvestigationPage');
    for (const status of [
      'RECEIVED',
      'CREATED',
      'PREPARING',
      'INVESTIGATING',
      'EVIDENCE_COLLECTION',
      'VERIFYING',
      'IMPACT_ANALYSIS',
      'RECOMMENDATION',
    ]) {
      expect(analysisRunning(status)).toBe(true);
    }
  });

  it('does not treat a decided investigation as running', async () => {
    const { analysisRunning } = await import('@/pages/InvestigationPage');
    // Each of these means the analysis reached an answer. Showing skeletons
    // past this point would imply work that is not happening.
    for (const status of ['AWAITING_APPROVAL', 'REMEDIATING', 'RESOLVED', 'FAILED', 'REJECTED']) {
      expect(analysisRunning(status)).toBe(false);
    }
    expect(analysisRunning(null)).toBe(false);
  });

  it('describes each backend phase in the reader’s language', async () => {
    const { phaseLabel } = await import('@/pages/InvestigationPage');
    expect(phaseLabel('PREPARING')).toMatch(/preparing the repository/i);
    expect(phaseLabel('INVESTIGATING')).toMatch(/investigating/i);
    expect(phaseLabel('VERIFYING')).toMatch(/verifying/i);
    expect(phaseLabel('IMPACT_ANALYSIS')).toMatch(/affected components/i);
    expect(phaseLabel('REMEDIATING')).toMatch(/pull request/i);
    expect(phaseLabel('POST_FIX_VERIFY')).toMatch(/verifying the remediation/i);
  });

  it('never describes a phase as a finding count or a percentage', async () => {
    const { phaseLabel } = await import('@/pages/InvestigationPage');
    // Progress here is a named backend state, never a fabricated number.
    for (const status of ['CREATED', 'PREPARING', 'INVESTIGATING', 'VERIFYING']) {
      expect(phaseLabel(status)).not.toMatch(/\d+\s*%/);
    }
  });
});

describe('blast radius affected-path filter', () => {
  // React Flow measures its canvas; jsdom has no ResizeObserver to measure with.
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('DOMMatrixReadOnly', class { constructor(_t?: string) {} m22 = 1; });
  });
  afterAll(() => vi.unstubAllGlobals());

  const graph = (affected: number) => ({
    nodes: Array.from({ length: 5 }, (_, i) => ({
      id: `file:src/f${i}.js`,
      kind: 'CHANGED_FILE' as const,
      label: `f${i}.js`,
      file: `src/f${i}.js`,
      line: null,
      evidenceIds: [],
      verificationStatus: 'VERIFIED' as const,
      onAffectedPath: i < affected,
    })),
    edges: [],
    summary: '5 changed file(s) were analysed.',
  });

  it('is disabled when nothing is on the affected path', async () => {
    const { BlastRadius } = await import('@/features/investigation/BlastRadius');
    render(<BlastRadius graph={graph(0) as never} />);

    const button = screen.getByRole('button', { name: /affected path/i });
    // Enabled, this filter could only empty the canvas — which looks broken
    // rather than answering the question.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toMatch(/nothing is on the affected path/i);
  });

  it('is usable when something is on the affected path', async () => {
    const { BlastRadius } = await import('@/features/investigation/BlastRadius');
    render(<BlastRadius graph={graph(2) as never} />);

    const button = screen.getByRole('button', { name: /affected path/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the real counts in the subtitle', async () => {
    const { BlastRadius } = await import('@/features/investigation/BlastRadius');
    render(<BlastRadius graph={graph(2) as never} />);
    expect(screen.getByText(/5 artifacts · 2 on the affected path/)).toBeTruthy();
  });
});
