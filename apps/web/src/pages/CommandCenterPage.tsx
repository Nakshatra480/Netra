import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Investigation } from '@netra/domain';
import { PlayCircle, Search } from 'lucide-react';
import { Button, EmptyState, Mono, Panel, PanelHeader, Skeleton } from '@/components/primitives';
import { SeverityBadge, StatusBadge } from '@/components/status';
import { api, ApiError, type Session } from '@/lib/api';

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

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Command Center</h1>
          <p className="mt-1 text-sm text-[--color-ink-muted]">
            {awaiting.length > 0
              ? `${awaiting.length} investigation${awaiting.length === 1 ? '' : 's'} need your decision.`
              : active.length > 0
                ? `${active.length} investigation${active.length === 1 ? '' : 's'} in progress.`
                : 'Nothing needs your attention.'}
          </p>
        </div>
        <Button variant="primary" onClick={() => void start()} disabled={starting}>
          <PlayCircle size={15} />
          {starting ? 'Starting…' : 'Investigate a change'}
        </Button>
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader title="Investigations" subtitle="Most recent first" icon={<Search size={15} />} />
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
            {investigations.map((investigation) => (
              <li key={investigation.id}>
                <Link
                  to={`/app/investigations/${investigation.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 hover:bg-[--color-surface-raised]"
                >
                  <Mono className="text-[--color-ink-muted]">{investigation.reference}</Mono>
                  <span className="min-w-0 flex-1 truncate text-sm text-[--color-ink]">
                    {investigation.summary ?? investigation.change.title}
                  </span>
                  {investigation.severity ? (
                    <SeverityBadge severity={investigation.severity} />
                  ) : null}
                  <StatusBadge status={investigation.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
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
