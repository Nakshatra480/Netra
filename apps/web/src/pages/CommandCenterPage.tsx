import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { Investigation, Repository } from '@netra/domain';
import { FolderPlus, GitCommitHorizontal, PlayCircle, Search } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  Mono,
  PageHeading,
  Panel,
  Section,
  Skeleton,
  StaggerList,
  Stat,
  staggerItem,
} from '@/components/primitives';
import { LoadingState, RepositorySkeleton } from '@/components/loading';
import { SeverityBadge, StatusBadge } from '@/components/status';
import { api, ApiError, type Session } from '@/lib/api';
import { loadClaims } from '@/lib/session';

const ACTIVE_STATUSES = [
  'RECEIVED', 'CREATED', 'PREPARING', 'INVESTIGATING', 'EVIDENCE_COLLECTION',
  'VERIFYING', 'IMPACT_ANALYSIS', 'RECOMMENDATION', 'REMEDIATING', 'POST_FIX_VERIFY',
];

/**
 * Dashboard.
 *
 * Answers three questions in order: what needs me, what is running, and what
 * have we looked at. Numbers appear only where they are counts of real records
 * — there are no invented metrics and no decorative charts.
 */
export function CommandCenterPage({ session }: { session: Session }) {
  const navigate = useNavigate();
  const { investigations, loading, error, reload } = useInvestigations(session);
  const { repositories, loading: reposLoading } = useRepositories(session);
  const [starting, setStarting] = useState(false);

  const isDemo = session.scheme === 'demo';
  const claims = isDemo ? null : loadClaims();
  const firstName = claims?.name?.split(' ')[0] ?? claims?.email?.split('@')[0] ?? null;

  const startDemo = async () => {
    setStarting(true);
    try {
      const investigation = await api.startDemoInvestigation(session);
      navigate(`/app/investigations/${investigation.id}`);
    } catch {
      setStarting(false);
    }
  };

  const awaiting = investigations.filter((i) => i.status === 'AWAITING_APPROVAL');
  const active = investigations.filter((i) => ACTIVE_STATUSES.includes(i.status));
  const resolved = investigations.filter((i) => i.status === 'RESOLVED');

  // The headline states the one thing worth knowing right now.
  const headline = awaiting.length
    ? `${awaiting.length} investigation${awaiting.length === 1 ? '' : 's'} need your decision`
    : active.length
      ? `${active.length} investigation${active.length === 1 ? '' : 's'} in progress`
      : investigations.length
        ? 'Nothing needs your attention'
        : 'No investigations yet';

  return (
    <div className="space-y-10">
      <PageHeading
        eyebrow={firstName ? `Welcome back, ${firstName}` : 'Overview'}
        title={headline}
        description={
          repositories.length
            ? `Monitoring ${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}.`
            : 'Connect a repository and Netra will investigate every change that lands on it.'
        }
        actions={
          <>
            {isDemo ? (
              <Button variant="secondary" onClick={() => void startDemo()} disabled={starting}>
                <PlayCircle size={15} />
                {starting ? 'Starting…' : 'Run demo investigation'}
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => navigate('/app/projects/new')}>
              <FolderPlus size={15} />
              Create project
            </Button>
          </>
        }
      />

      {/* Counts, not analytics: each is a count of records on this page. */}
      {investigations.length > 0 ? (
        <motion.div
          {...{ initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-4"
        >
          <div className="bg-tint-peach px-5 py-4">
            <Stat label="Need a decision" value={awaiting.length} tone={awaiting.length ? 'review' : 'neutral'} />
          </div>
          <div className="bg-tint-yellow px-5 py-4">
            <Stat label="In progress" value={active.length} />
          </div>
          <div className="bg-tint-sage px-5 py-4">
            <Stat label="Resolved" value={resolved.length} tone={resolved.length ? 'resolved' : 'neutral'} />
          </div>
          <div className="bg-surface px-5 py-4">
            <Stat label="Repositories" value={reposLoading ? '—' : repositories.length} />
          </div>
        </motion.div>
      ) : null}

      {/* Decisions first: the only thing on this page that is blocking a person. */}
      {awaiting.length > 0 ? (
        <Section
          title="Waiting for you"
          description="Netra has finished investigating and proposed a fix. Nothing changes until you approve it."
        >
          <StaggerList className="space-y-2">
            {awaiting.map((investigation) => (
              <InvestigationRow key={investigation.id} investigation={investigation} emphasis />
            ))}
          </StaggerList>
        </Section>
      ) : null}

      <Section
        title="Repositories"
        description={repositories.length ? undefined : 'Nothing connected yet.'}
        actions={
          repositories.length ? (
            <Button size="sm" variant="ghost" onClick={() => navigate('/app/projects/new')}>
              Add repository
            </Button>
          ) : null
        }
      >
        {reposLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : repositories.length === 0 ? (
          <Panel>
            <EmptyState
              icon={<FolderPlus size={18} />}
              title="No repositories connected"
              description="Create a project to connect a GitHub repository. Netra investigates each change that lands on it."
              action={
                <Button variant="primary" onClick={() => navigate('/app/projects/new')}>
                  Create project
                </Button>
              }
            />
          </Panel>
        ) : (
          <StaggerList className="grid gap-2 sm:grid-cols-2">
            {repositories.map((repo) => (
              <motion.div key={repo.id} variants={staggerItem}>
                <Link
                  to={`/app/repositories/${repo.id}`}
                  className="panel flex items-center justify-between gap-3 px-4 py-3.5 transition-colors duration-150 hover:border-line-strong"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[0.9375rem] font-medium text-ink">
                      {repo.fullName}
                    </p>
                    <p className="mt-0.5 text-[0.8125rem] text-ink-muted">
                      <Mono>{repo.defaultBranch}</Mono>
                      {repo.monitoringEnabled ? ' · monitored' : ' · paused'}
                    </p>
                  </div>
                </Link>
              </motion.div>
            ))}
          </StaggerList>
        )}
      </Section>

      <Section
        title="Investigations"
        description={investigations.length ? 'Most recent first.' : undefined}
      >
        {loading ? (
          <LoadingState label="Loading investigations…">
            <RepositorySkeleton rows={3} />
          </LoadingState>
        ) : error ? (
          <ErrorState
            title="Could not load investigations"
            detail={error}
            action={
              <Button size="sm" variant="secondary" onClick={() => void reload()}>
                Try again
              </Button>
            }
          />
        ) : investigations.length === 0 ? (
          <Panel>
            <EmptyState
              icon={<Search size={18} />}
              title="No investigations yet"
              description={
                isDemo
                  ? 'Run the demo investigation to see the whole loop: findings, evidence, verification and approval.'
                  : 'Once a repository is connected, every push and pull request is investigated automatically.'
              }
              action={
                isDemo ? (
                  <Button variant="primary" onClick={() => void startDemo()} disabled={starting}>
                    {starting ? 'Starting…' : 'Run demo investigation'}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => navigate('/app/projects/new')}>
                    Create project
                  </Button>
                )
              }
            />
          </Panel>
        ) : (
          <StaggerList className="space-y-2">
            {investigations.map((investigation) => (
              <InvestigationRow key={investigation.id} investigation={investigation} />
            ))}
          </StaggerList>
        )}
      </Section>
    </div>
  );
}

/**
 * One investigation, as a row.
 *
 * The summary is the important part, so it gets the width; identifiers and
 * status sit either side of it.
 */
function InvestigationRow({
  investigation,
  emphasis = false,
}: {
  investigation: Investigation;
  emphasis?: boolean;
}) {
  return (
    <motion.div variants={staggerItem}>
      <Link
        to={`/app/investigations/${investigation.id}`}
        className={
          emphasis
            ? 'panel block border-accent-border bg-accent-soft px-4 py-3.5 transition-colors duration-150 hover:border-accent'
            : 'panel block px-4 py-3.5 transition-colors duration-150 hover:border-line-strong'
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Mono className="text-ink-muted">{investigation.reference}</Mono>
          <span className="text-[0.8125rem] text-ink-subtle">
            {investigation.change.repositoryFullName}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {investigation.severity ? <SeverityBadge severity={investigation.severity} /> : null}
            <StatusBadge status={investigation.status} />
          </span>
        </div>
        <p className="mt-2 text-[0.9375rem] leading-snug text-ink">
          {investigation.summary ?? investigation.change.title}
        </p>
        <p className="mt-1.5 flex items-center gap-1.5 text-[0.8125rem] text-ink-subtle">
          <GitCommitHorizontal size={13} />
          <Mono>{investigation.change.commitSha.slice(0, 8)}</Mono>
          {investigation.change.pullRequestNumber ? (
            <span>· PR #{investigation.change.pullRequestNumber}</span>
          ) : null}
        </p>
      </Link>
    </motion.div>
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

/** Loads connected repositories for the authenticated workspace. */
export function useRepositories(session: Session) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session.scheme === 'demo') return;
    setLoading(true);
    api
      .listRepositories(session)
      .then((repos) => setRepositories(repos))
      .catch(() => setRepositories([]))
      .finally(() => setLoading(false));
  }, [session]);

  return { repositories, loading };
}

