/**
 * Repository detail / project page.
 *
 * Shows connection status, investigation history for this specific repository,
 * and a "Trigger investigation" action.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Investigation, Repository } from '@netra/domain';
import {
  AlertOctagon,
  ArrowLeft,
  CheckCircle2,
  GitBranch,
  Github,
  Lock,
  PlayCircle,
  RefreshCw,
  Unlock,
  XCircle,
} from 'lucide-react';
import { Button, Panel, PanelHeader, Skeleton } from '@/components/primitives';
import { LoadingState } from '@/components/loading';
import { StatusBadge } from '@/components/status';
import { AnalysisTarget } from '@/features/repository/AnalysisTarget';
import { api, ApiError, type Session } from '@/lib/api';
import { useInvestigations } from './CommandCenterPage';
import { cn } from '@/lib/cn';

interface Props {
  session: Session;
}

export function RepositoryPage({ session }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [repository, setRepository] = useState<Repository | null>(null);
  const [repoLoading, setRepoLoading] = useState(true);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const { investigations, loading: invLoading } = useInvestigations(session);

  // Only investigations for this repository
  const repoInvestigations = investigations.filter(
    (inv) => repository && inv.repositoryId === repository.id,
  );

  useEffect(() => {
    if (!id) return;
    setRepoLoading(true);
    api
      .getRepository(session, id)
      .then((r) => {
        setRepository(r);
        setRepoError(null);
      })
      .catch((err) => {
        setRepoError(
          err instanceof ApiError ? err.message : 'Could not load the repository.',
        );
      })
      .finally(() => setRepoLoading(false));
  }, [session, id]);

  /**
   * Trigger an investigation.
   *
   * For Cognito (real) sessions: calls POST /api/repositories/:id/analyze
   * which resolves the HEAD SHA from GitHub server-side and starts the
   * Step Functions → Fargate pipeline.
   *
   * For demo sessions: creates a synthetic investigation.
   */
  const handleAnalyze = async () => {
    if (!repository) return;
    if (starting) return; // duplicate click guard
    setStarting(true);
    setAnalyzeError(null);
    try {
      // Demo sessions cannot reach a real repository; they get the fixture.
      const inv = await api.startDemoInvestigation(session);
      void navigate(`/app/investigations/${inv.id}`);
    } catch (err) {
      setAnalyzeError(
        err instanceof ApiError ? err.message : 'Failed to start investigation. Please try again.',
      );
      setStarting(false);
    }
  };

  if (repoLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <LoadingState label="Loading repository…">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
        </LoadingState>
      </div>
    );
  }

  if (repoError || !repository) {
    return (
      <div className="mx-auto max-w-3xl py-20 text-center">
        <XCircle size={36} className="mx-auto mb-3 text-state-severe" />
        <h1 className="text-lg font-semibold">Repository not found</h1>
        <p className="mt-1 text-sm text-ink-muted">{repoError}</p>
        <Button variant="secondary" onClick={() => void navigate('/app')} className="mt-4">
          <ArrowLeft size={14} /> Back to Dashboard
        </Button>
      </div>
    );
  }

  const [owner, repoName] = repository.fullName.split('/');
  const githubUrl = `https://github.com/${repository.fullName}`;

  const awaiting = repoInvestigations.filter((i) => i.status === 'AWAITING_APPROVAL');
  const active = repoInvestigations.filter(
    (i) => !['RESOLVED', 'REJECTED', 'FAILED', 'AWAITING_APPROVAL'].includes(i.status),
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      {/* Back nav */}
      <Link
        to="/app"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors"
      >
        <ArrowLeft size={14} />
        Dashboard
      </Link>

      {/* Repository header */}
      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-raised">
              <Github size={18} className="text-ink-muted" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={githubUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-base font-semibold hover:underline"
                >
                  {owner}
                  <span className="text-ink-muted">/</span>
                  {repoName}
                </a>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.65rem] font-medium',
                    'bg-surface-raised text-ink-muted',
                  )}
                >
                  <Lock size={9} />
                  Private
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-subtle">
                <span className="flex items-center gap-1">
                  <GitBranch size={11} />
                  {repository.defaultBranch}
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      repository.monitoringEnabled
                        ? 'bg-state-resolved animate-pulse'
                        : 'bg-ink-subtle',
                    )}
                  />
                  {repository.monitoringEnabled ? 'Monitoring active' : 'Monitoring paused'}
                </span>
              </div>
            </div>
          </div>

          {/* Actions — demo sessions only; real sessions choose a target below. */}
          {session.scheme !== 'bearer' && (
            <div className="flex flex-col items-end gap-2">
              <Button variant="primary" onClick={() => void handleAnalyze()} disabled={starting}>
                <PlayCircle size={14} />
                {starting ? 'Starting…' : 'Investigate latest change'}
              </Button>
              {analyzeError && (
                <p className="max-w-xs text-right text-xs text-state-severe">{analyzeError}</p>
              )}
            </div>
          )}
        </div>

        {/* Choose analysis target: latest, or an exact commit from real history. */}
        {session.scheme === 'bearer' && (
          <div className="border-t border-line px-6 py-5">
            <AnalysisTarget
              session={session}
              repositoryId={repository.id}
              defaultBranch={repository.defaultBranch}
              onStarted={(investigationId) =>
                void navigate(`/app/investigations/${investigationId}`)
              }
            />
          </div>
        )}
      </Panel>

      {/* Awaiting decisions */}
      {awaiting.length > 0 && (
        <Panel className="overflow-hidden border-2 border-[color-mix(in_oklch,var(--color-state-review)_40%,transparent)]">
          <PanelHeader
            title="Awaiting your decision"
            subtitle={`${awaiting.length} pending`}
            icon={<AlertOctagon size={14} className="text-state-review" />}
          />
          <ul className="divide-y divide-line">
            {awaiting.map((inv) => (
              <InvRow key={inv.id} inv={inv} />
            ))}
          </ul>
        </Panel>
      )}

      {/* Active */}
      {active.length > 0 && (
        <Panel className="overflow-hidden">
          <PanelHeader title="Active" subtitle="In progress" />
          <ul className="divide-y divide-line">
            {active.map((inv) => (
              <InvRow key={inv.id} inv={inv} />
            ))}
          </ul>
        </Panel>
      )}

      {/* History */}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Investigation history"
          subtitle={`${repoInvestigations.length} total`}
          icon={<RefreshCw size={14} />}
        />
        {invLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : repoInvestigations.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-muted">
            No investigations yet for this repository.
            <br />
            Push a change or click "Investigate latest change" to start one.
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {repoInvestigations.map((inv) => (
              <InvRow key={inv.id} inv={inv} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function InvRow({ inv }: { inv: Investigation }) {
  const isResolved = inv.status === 'RESOLVED';
  const isFailed = ['FAILED', 'REJECTED'].includes(inv.status);

  return (
    <li>
      <Link
        to={`/app/investigations/${inv.id}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-raised"
      >
        <div className="shrink-0">
          {isResolved ? (
            <CheckCircle2 size={14} className="text-state-resolved" />
          ) : isFailed ? (
            <XCircle size={14} className="text-state-severe" />
          ) : (
            <div className="relative flex h-[14px] w-[14px] items-center justify-center">
              <div className="h-2 w-2 rounded-full bg-state-active" />
              <div className="absolute inset-0 animate-ping rounded-full bg-state-active opacity-30" />
            </div>
          )}
        </div>
        <span className="flex-1 truncate text-sm">{inv.change.title}</span>
        <StatusBadge status={inv.status} />
        <span className="shrink-0 text-xs text-ink-subtle">
          {formatAgo(inv.startedAt)}
        </span>
      </Link>
    </li>
  );
}

function formatAgo(iso: string) {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch { return ''; }
}
