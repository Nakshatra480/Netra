import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { FadeIn, Stagger, staggerRow, motion } from '@/components/motion';
import { Skeleton } from '@/components/primitives';

/**
 * Waiting, with something to read.
 *
 * A spinner alone says "wait" and nothing else. Each state here names the
 * operation that is actually running and sketches the shape of what will
 * replace it, so the page does not change size or meaning when the data lands.
 *
 * None of these introduce delay. They are shown while a real request is in
 * flight and removed the moment it answers — see {@link useSettledFlag} for the
 * one narrow exception, which exists to stop a flicker rather than to create a
 * wait.
 */

// The shimmering placeholder itself already lives with the other primitives;
// re-exported here so a caller needs one import for a loading region.
export { Skeleton };

/**
 * A labelled loading region.
 *
 * The label is the contract: it says which operation the reader is waiting on.
 * `aria-busy` and the polite live region carry the same information to a screen
 * reader, which otherwise gets silence.
 */
export function LoadingState({
  label,
  children,
  className,
}: {
  label: string;
  children?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn('space-y-3', className)} aria-busy="true">
      <p
        className="flex items-center gap-2 text-[0.875rem] text-ink-muted"
        role="status"
        aria-live="polite"
      >
        <LoaderCircle size={14} className="animate-spin text-ink-subtle" aria-hidden />
        {label}
      </p>
      {children}
    </div>
  );
}

/** Placeholder rows for a repository list. */
export function RepositorySkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Stagger className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <motion.div
          key={i}
          variants={staggerRow}
          className="flex items-center gap-3 rounded-control border border-line bg-surface px-4 py-3"
        >
          <Skeleton className="h-8 w-8 shrink-0 rounded-control" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/5" />
          </div>
        </motion.div>
      ))}
    </Stagger>
  );
}

/** Placeholder rows shaped like the commit picker's entries. */
export function CommitSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Stagger className="divide-y divide-line overflow-hidden rounded-control border border-line">
      {Array.from({ length: rows }, (_, i) => (
        <motion.div
          key={i}
          variants={staggerRow}
          className="flex items-start gap-3 bg-surface px-4 py-3"
        >
          <Skeleton className="mt-0.5 h-4 w-4 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-3 w-14 shrink-0" />
        </motion.div>
      ))}
    </Stagger>
  );
}

/** Placeholder shaped like a finding card. */
export function FindingSkeleton() {
  return (
    <div className="space-y-3 rounded-panel border border-line bg-surface p-5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

/** Placeholder for a report section that has not been reached yet. */
export function SectionSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

/** Placeholder for the blast-radius graph, which is tall and would jump. */
export function GraphSkeleton() {
  return <Skeleton className="h-56 w-full rounded-panel" />;
}

/** A metric whose value has not been established yet. */
export function StatSkeleton() {
  return <Skeleton className="h-6 w-12" />;
}

/**
 * Keeps a just-finished state visible for a moment, but only when it barely
 * appeared at all.
 *
 * A request that answers in 40ms would otherwise flash a skeleton for two
 * frames, which reads as a glitch. This holds the loading state to a floor of
 * ~250ms *only if it was already showing*; an operation that was never pending
 * long enough to render is not delayed, and a slow one is never extended. It
 * adds nothing to the wait the reader actually experiences.
 */
export function useSettledFlag(pending: boolean, minVisibleMs = 250): boolean {
  const [held, setHeld] = useState(pending);
  const shownAt = useRef<number | null>(pending ? Date.now() : null);

  useEffect(() => {
    if (pending) {
      shownAt.current ??= Date.now();
      setHeld(true);
      return;
    }
    const since = shownAt.current;
    shownAt.current = null;
    if (since === null) {
      setHeld(false);
      return;
    }
    const remaining = minVisibleMs - (Date.now() - since);
    if (remaining <= 0) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(false), remaining);
    return () => clearTimeout(timer);
  }, [pending, minVisibleMs]);

  return held;
}

/**
 * A value that is not known yet.
 *
 * Shows a placeholder while the work that would produce it is still running,
 * and the value itself once there is one — never a dash standing in for both
 * "nothing" and "not yet", which are different answers.
 */
export function PendingValue({
  ready,
  value,
  placeholder,
}: {
  ready: boolean;
  value: ReactNode;
  placeholder?: ReactNode;
}) {
  if (!ready) return <>{placeholder ?? <StatSkeleton />}</>;
  return <FadeIn>{value}</FadeIn>;
}
