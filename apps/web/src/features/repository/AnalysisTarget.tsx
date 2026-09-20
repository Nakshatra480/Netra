import { useState } from 'react';
import { GitCommitHorizontal, PlayCircle, RefreshCw, X } from 'lucide-react';
import { api, ApiError, type GhCommit, type Session } from '@/lib/api';
import { Button, ErrorState, Mono } from '@/components/primitives';
import { CommitSkeleton, LoadingState } from '@/components/loading';
import { AnimatePresence, FadeIn, Stagger, motion, staggerRow } from '@/components/motion';

/**
 * Choosing what to analyze.
 *
 * Two ways in: the branch tip, or an exact commit from the repository's real
 * history. The distinction is kept visible throughout, because a report that
 * says "analyzed" without saying *what* was analyzed is not worth much — and
 * because a commit that has been force-pushed away must fail loudly rather
 * than quietly becoming an analysis of HEAD.
 */
export function AnalysisTarget({
  session,
  repositoryId,
  defaultBranch,
  onStarted,
}: {
  session: Session;
  repositoryId: string;
  defaultBranch: string;
  onStarted: (investigationId: string) => void;
}) {
  const [mode, setMode] = useState<'choose' | 'picking'>('choose');
  const [commits, setCommits] = useState<GhCommit[] | null>(null);
  const [historyEmpty, setHistoryEmpty] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // One in-flight start at a time. A second click while a request is open
  // would risk a second investigation for the same commit.
  const [startingSha, setStartingSha] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = async () => {
    setLoadingHistory(true);
    setHistoryError(null);
    setHistoryEmpty(false);
    try {
      const result = await api.listCommits(session, repositoryId);
      setCommits(result.commits);
      setHistoryEmpty(Boolean(result.empty) || result.commits.length === 0);
    } catch (err) {
      setHistoryError(
        err instanceof ApiError ? err.message : 'Commit history could not be loaded from GitHub.',
      );
    } finally {
      setLoadingHistory(false);
    }
  };

  const openPicker = () => {
    setMode('picking');
    setError(null);
    if (!commits && !loadingHistory) void loadHistory();
  };

  const start = async (commitSha?: string) => {
    if (starting) return; // duplicate click guard
    setStarting(true);
    setStartingSha(commitSha ?? null);
    setError(null);
    try {
      const result = await api.analyzeRepository(session, repositoryId, commitSha);
      onStarted(result.investigationId);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The investigation could not be started. Please try again.',
      );
      setStarting(false);
      setStartingSha(null);
    }
  };

  // ── Analyzing ─────────────────────────────────────────────────────────────
  if (starting) {
    return (
      <FadeIn className="flex items-center gap-3 rounded-control border border-line bg-surface-raised px-4 py-3">
        <RefreshCw size={15} className="animate-spin text-ink-muted" />
        <span className="text-[0.9375rem] text-ink">
          Analyzing{' '}
          {startingSha ? (
            <Mono>{startingSha.slice(0, 7)}</Mono>
          ) : (
            <>
              latest on <Mono>{defaultBranch}</Mono>
            </>
          )}
          …
        </span>
      </FadeIn>
    );
  }

  // ── Choose analysis target ────────────────────────────────────────────────
  if (mode === 'choose') {
    return (
      <FadeIn className="space-y-2">
        <p className="text-[0.8125rem] font-semibold uppercase tracking-wide text-ink-subtle">
          Choose analysis target
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void start()}>
            <PlayCircle size={14} />
            Analyze latest commit
          </Button>
          <Button variant="secondary" onClick={openPicker}>
            <GitCommitHorizontal size={14} />
            Select commit
          </Button>
        </div>
        <p className="text-[0.8125rem] text-ink-subtle">
          Latest is the current tip of <Mono>{defaultBranch}</Mono>.
        </p>
        {error && <ErrorState title="Could not start" detail={error} />}
      </FadeIn>
    );
  }

  // ── Pick a commit ─────────────────────────────────────────────────────────
  return (
    <FadeIn className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[0.8125rem] font-semibold uppercase tracking-wide text-ink-subtle">
          Select commit on <Mono>{defaultBranch}</Mono>
        </p>
        <Button variant="ghost" size="sm" onClick={() => setMode('choose')}>
          <X size={14} />
          Cancel
        </Button>
      </div>

      {loadingHistory && (
        <LoadingState label="Loading commit history…">
          <CommitSkeleton />
        </LoadingState>
      )}

      {historyError && (
        <div className="space-y-2">
          <ErrorState title="GitHub could not be reached" detail={historyError} />
          <Button variant="secondary" size="sm" onClick={() => void loadHistory()}>
            <RefreshCw size={14} />
            Retry
          </Button>
        </div>
      )}

      {!loadingHistory && !historyError && historyEmpty && (
        <div className="rounded-control border border-line bg-surface-raised px-4 py-3">
          <p className="text-[0.875rem] font-semibold text-ink">No commits to analyze</p>
          <p className="mt-1 text-[0.875rem] text-ink-muted">
            This repository has no commit history on <Mono>{defaultBranch}</Mono>.
          </p>
        </div>
      )}

      {!loadingHistory && !historyError && !historyEmpty && commits && (
        <Stagger className="divide-y divide-line overflow-hidden rounded-control border border-line">
          {commits.map((commit) => (
            <motion.div key={commit.sha} variants={staggerRow}>
              <button
                type="button"
                onClick={() => void start(commit.sha)}
                className="flex w-full items-start gap-3 bg-surface px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
              >
                <GitCommitHorizontal size={15} className="mt-0.5 shrink-0 text-ink-subtle" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9375rem] font-medium text-ink">
                    {commit.message}
                  </span>
                  <span className="mt-0.5 block text-[0.8125rem] text-ink-muted">
                    {commit.authorName}
                    {commit.authoredAt ? ` · ${formatDate(commit.authoredAt)}` : ''}
                  </span>
                </span>
                <Mono className="shrink-0 text-[0.8125rem] text-ink-muted">{commit.shortSha}</Mono>
              </button>
            </motion.div>
          ))}
        </Stagger>
      )}

      <AnimatePresence>{error && <ErrorState title="Could not start" detail={error} />}</AnimatePresence>
    </FadeIn>
  );
}

/** Dates are shown in the viewer's locale; an invalid one is simply omitted. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
