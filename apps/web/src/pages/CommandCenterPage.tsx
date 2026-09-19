import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Investigation } from '@netra/domain';
import {
  AlertOctagon,
  CheckCircle2,
  Clock,
  GitBranch,
  GitCommitHorizontal,
  PlayCircle,
  Search,
  XCircle,
} from 'lucide-react';
import { Button, EmptyState, Mono, Panel, PanelHeader, Skeleton } from '@/components/primitives';
import { SeverityBadge, StatusBadge } from '@/components/status';
import { api, ApiError, type Session } from '@/lib/api';
import { cn } from '@/lib/cn';

/** Where a returning user starts: what is open, and what needs a decision. */
export function CommandCenterPage({ session }: { session: Session }) {
  const navigate = useNavigate();
  const { investigations, loading, error, reload } = useInvestigations(session);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    try {
      const investigation = await api.startDemoInvestigation(session);
      navigate(`/app/investigations/${investigation.id}`);
    } catch {
      setStarting(false);
    }
  };

  const awaiting = investigations.filter((i) => i.status === 'AWAITING_APPROVAL');
  const active = investigations.filter(
    (i) => !['RESOLVED', 'REJECTED', 'FAILED', 'AWAITING_APPROVAL'].includes(i.status),
  );
  const terminal = investigations.filter((i) =>
    ['RESOLVED', 'REJECTED', 'FAILED'].includes(i.status),
  );

  const statusLine =
    awaiting.length > 0
      ? `${awaiting.length} investigation${awaiting.length === 1 ? '' : 's'} need your decision`
      : active.length > 0
        ? `${active.length} investigation${active.length === 1 ? '' : 's'} in progress`
        : 'No active investigations';

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Command Center</h1>
          <p className="mt-1 text-sm text-[--color-ink-muted]">{statusLine}</p>
        </div>
        <Button variant="primary" onClick={() => void start()} disabled={starting}>
          <PlayCircle size={15} />
          {starting ? 'Starting…' : 'Investigate a change'}
        </Button>
      </div>

      {/* Awaiting approval — most urgent, shown first */}
      {awaiting.length > 0 ? (
        <Panel className="overflow-hidden border-2 border-[color-mix(in_oklch,var(--color-state-review)_45%,transparent)]">
          <PanelHeader
            title="Awaiting your decision"
            subtitle={`${awaiting.length} need${awaiting.length === 1 ? 's' : ''} approval`}
            icon={<AlertOctagon size={15} className="text-[--color-state-review]" />}
          />
          <ul className="divide-y divide-[--color-line]">
            {awaiting.map((inv) => (
              <InvestigationRow key={inv.id} investigation={inv} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* Active investigations */}
      {active.length > 0 ? (
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Active"
            subtitle="Currently being investigated"
            icon={<Clock size={15} />}
          />
          <ul className="divide-y divide-[--color-line]">
            {active.map((inv) => (
              <InvestigationRow key={inv.id} investigation={inv} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* All investigations */}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="All investigations"
          subtitle="Most recent first"
          icon={<Search size={15} />}
        />
        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : error ? (
          <EmptyState
            title="Could not load investigations"
            description={error}
            action={
              <Button variant="secondary" onClick={() => void reload()}>
                Try again
              </Button>
            }
          />
        ) : investigations.length === 0 ? (
          <EmptyState
            title="No investigations yet"
            description="Start one against the demo repository to see the whole loop: evidence, blast radius, verification and approval."
            action={
              <Button variant="primary" onClick={() => void start()}>
                Investigate a change
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-[--color-line]">
            {investigations.map((inv) => (
              <InvestigationRow key={inv.id} investigation={inv} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function InvestigationRow({ investigation }: { investigation: Investigation }) {
  const isResolved = investigation.status === 'RESOLVED';
  const isFailed = investigation.status === 'FAILED';
  const isRejected = investigation.status === 'REJECTED';

  return (
    <li>
      <Link
        to={`/app/investigations/${investigation.id}`}
        className="group flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5 transition-colors hover:bg-[--color-surface-raised]"
      >
        {/* Status icon */}
        <div className="mt-0.5 shrink-0">
          {isResolved ? (
            <CheckCircle2 size={15} className="text-[--color-state-resolved]" />
          ) : isFailed || isRejected ? (
            <XCircle size={15} className="text-[--color-state-severe]" />
          ) : (
            <div className="relative flex h-[15px] w-[15px] items-center justify-center">
              <div className="h-2 w-2 rounded-full bg-[--color-state-active]" />
              <div className="absolute inset-0 animate-ping rounded-full bg-[--color-state-active] opacity-30" />
            </div>
          )}
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1 space-y-1">
          {/* Title row */}
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <Mono className="text-[0.68rem] text-[--color-ink-subtle]">
              {investigation.reference}
            </Mono>
            <span className="truncate text-sm font-medium text-[--color-ink]">
              {investigation.summary ?? investigation.change.title}
            </span>
          </div>

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="text-[0.7rem] text-[--color-ink-subtle]">
              {investigation.change.repositoryFullName}
            </span>
            {investigation.change.branch ? (
              <span className="flex items-center gap-1 text-[0.68rem] text-[--color-ink-subtle]">
                <GitBranch size={10} />
                <Mono>{investigation.change.branch}</Mono>
              </span>
            ) : null}
            <span className="flex items-center gap-1 text-[0.68rem] text-[--color-ink-subtle]">
              <GitCommitHorizontal size={11} />
              <Mono>{investigation.change.commitSha.slice(0, 8)}</Mono>
            </span>
            <span
              className={cn(
                'text-[0.68rem]',
                isResolved ? 'text-[--color-state-resolved]' : 'text-[--color-ink-subtle]',
              )}
            >
              {formatTimeAgo(investigation.startedAt)}
            </span>
          </div>
        </div>

        {/* Badges */}
        <div className="flex shrink-0 items-center gap-2">
          {investigation.severity ? (
            <SeverityBadge severity={investigation.severity} />
          ) : null}
          <StatusBadge status={investigation.status} />
        </div>
      </Link>
    </li>
  );
}

export function useInvestigations(session: Session) {
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      setInvestigations(await api.listInvestigations(session));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // The list only changes when the user acts, so it is loaded on mount rather
    // than polled; individual investigations stream their own updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.workspaceId]);

  return { investigations, loading, error, reload };
}

function formatTimeAgo(isoString: string): string {
  try {
    const diff = Date.now() - new Date(isoString).getTime();
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return '';
  }
}
