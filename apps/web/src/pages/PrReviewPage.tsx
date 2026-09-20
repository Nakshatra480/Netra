import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  BadgeCheck,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
} from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Mono,
  PageHeading,
  Panel,
  Section,
  Skeleton,
} from '@/components/primitives';
import { LoadingState } from '@/components/loading';
import { useInvestigation } from '@/hooks/useInvestigation';
import type { Session } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Pull request review.
 *
 * Everything here comes from the investigation record the remediation task
 * wrote: the PR URL it received from GitHub, the diff it actually applied, and
 * the verification that ran afterwards. Nothing is reconstructed or guessed —
 * if the PR does not exist yet, the page says so rather than inventing one.
 */
export function PrReviewPage({ session }: { session: Session }) {
  const { id } = useParams<{ id: string }>();
  const state = useInvestigation(session, id);

  const investigation = state.detail?.investigation;
  const remediation = state.remediation;
  const action = state.action;
  const prUrl = action?.resultUrl ?? null;

  const diffStats = useMemo(() => summarizeDiff(remediation?.diff ?? ''), [remediation?.diff]);
  const postFix = state.verifications.find((v) => v.phase === 'POST_FIX');

  if (state.loading) {
    return (
      <div className="space-y-6">
        <LoadingState label="Loading pull request…">
          <Skeleton className="h-9 w-80" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-72 w-full" />
        </LoadingState>
      </div>
    );
  }

  if (state.error) {
    return (
      <ErrorState
        title="Could not load this pull request"
        detail={state.error}
        action={
          <Button size="sm" variant="secondary" onClick={() => void state.refresh()}>
            Try again
          </Button>
        }
      />
    );
  }

  // The page is only meaningful once a real PR exists.
  if (!prUrl) {
    return (
      <div className="space-y-6">
        <BackLink id={id} />
        <Panel>
          <EmptyState
            icon={<GitPullRequest size={18} />}
            title="No pull request yet"
            description={
              state.status === 'REMEDIATING' || state.status === 'POST_FIX_VERIFY'
                ? 'Remediation is still running. This page will show the pull request as soon as GitHub returns it.'
                : 'This investigation has no remediation pull request. Approve the recommended fix to create one.'
            }
            action={
              <Button variant="secondary" onClick={() => void state.refresh()}>
                Refresh
              </Button>
            }
          />
        </Panel>
      </div>
    );
  }

  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-8"
    >
      <BackLink id={id} />

      <PageHeading
        eyebrow="Remediation pull request"
        title={remediation?.title ?? 'Remediation'}
        description={remediation?.rationale ?? undefined}
        actions={
          <Button variant="primary" onClick={() => window.open(prUrl, '_blank', 'noopener')}>
            <ExternalLink size={15} />
            Open on GitHub
          </Button>
        }
      />

      {/* Identity of the change, straight from the record. */}
      <Panel className="overflow-hidden">
        <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-surface px-5 py-4">
            <Field label="Repository">
              <Mono>{investigation?.change.repositoryFullName ?? '—'}</Mono>
            </Field>
          </div>
          <div className="bg-surface px-5 py-4">
            <Field label="Pull request">
              {prNumber ? <Mono>#{prNumber}</Mono> : <span className="text-ink-muted">Created</span>}
            </Field>
          </div>
          <div className="bg-surface px-5 py-4">
            <Field label="Branch">
              <span className="flex items-center gap-1.5">
                <GitBranch size={13} className="text-ink-subtle" />
                <Mono>{investigation?.change.branch ?? 'main'}</Mono>
              </span>
            </Field>
          </div>
          <div className="bg-surface px-5 py-4">
            <Field label="Commit">
              <span className="flex items-center gap-1.5">
                <GitCommitHorizontal size={13} className="text-ink-subtle" />
                <Mono>{investigation?.change.commitSha.slice(0, 10) ?? '—'}</Mono>
              </span>
            </Field>
          </div>
        </div>
      </Panel>

      {/* Verification is what earns the resolved state, so it leads. */}
      <Section title="Verification" description="The same check that proved the finding, re-run against the fix.">
        {postFix ? (
          <Panel className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[0.75rem] font-semibold',
                  postFix.status === 'REFUTED'
                    ? 'border-[#BBD98F] bg-state-resolved-bg text-state-resolved'
                    : 'border-[#FECACA] bg-state-severe-bg text-state-severe',
                )}
              >
                <BadgeCheck size={14} />
                {postFix.status === 'REFUTED' ? 'Finding no longer present' : postFix.status}
              </span>
              <Mono className="text-ink-subtle">
                {postFix.verifier} · {postFix.durationMs}ms
              </Mono>
            </div>
            <p className="mt-3 text-[0.9375rem] font-medium text-ink">{postFix.claim}</p>
            <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-muted">{postFix.detail}</p>
          </Panel>
        ) : (
          <Panel>
            <EmptyState
              title="Not verified yet"
              description={
                state.status === 'RESOLVED'
                  ? 'This remediation completed without a recorded post-fix check.'
                  : 'Post-fix verification runs once the pull request has been created.'
              }
            />
          </Panel>
        )}
      </Section>

      {/* The exact diff that was applied. */}
      <Section
        title="Changes"
        description={
          remediation
            ? `${remediation.affectedFiles.length} file${remediation.affectedFiles.length === 1 ? '' : 's'} · +${diffStats.additions} −${diffStats.deletions}`
            : undefined
        }
      >
        {remediation?.diff ? (
          <Panel className="overflow-hidden">
            <ul className="divide-y divide-line border-b border-line">
              {remediation.affectedFiles.map((file) => (
                <li key={file} className="flex items-center gap-2 px-5 py-2.5">
                  <FileDiff size={14} className="shrink-0 text-ink-subtle" />
                  <Mono className="truncate text-ink">{file}</Mono>
                </li>
              ))}
            </ul>
            <DiffView diff={remediation.diff} />
          </Panel>
        ) : (
          <Panel>
            <EmptyState
              title="No diff recorded"
              description="The remediation record for this investigation has no stored patch."
            />
          </Panel>
        )}
      </Section>

      <Section title="Approval" description="Recorded when the fix was authorised.">
        <Panel className="grid gap-px bg-line sm:grid-cols-3">
          <div className="bg-surface px-5 py-4">
            <Field label="Approved by">{action?.approvedBy ?? '—'}</Field>
          </div>
          <div className="bg-surface px-5 py-4">
            <Field label="Decided at">
              {action?.decidedAt ? new Date(action.decidedAt).toLocaleString() : '—'}
            </Field>
          </div>
          <div className="bg-surface px-5 py-4">
            <Field label="Action status">{action?.status ?? '—'}</Field>
          </div>
        </Panel>
      </Section>
    </motion.div>
  );
}

function BackLink({ id }: { id: string | undefined }) {
  return (
    <Link
      to={`/app/investigations/${id}`}
      className="inline-flex items-center gap-1.5 text-[0.875rem] text-ink-muted transition-colors hover:text-ink"
    >
      <ArrowLeft size={14} />
      Back to investigation
    </Link>
  );
}

/** Render a unified diff with the usual add/remove colouring. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="mono max-h-[32rem] overflow-auto bg-surface-sunken px-5 py-4 text-[0.75rem] leading-relaxed">
      {lines.map((line, index) => {
        const isAdd = line.startsWith('+') && !line.startsWith('+++');
        const isDel = line.startsWith('-') && !line.startsWith('---');
        const isHunk = line.startsWith('@@');
        const isFile = line.startsWith('diff --git');
        return (
          <div
            key={index}
            className={cn(
              'whitespace-pre-wrap',
              isAdd && 'bg-state-resolved-bg text-state-resolved',
              isDel && 'bg-state-severe-bg text-state-severe',
              isHunk && 'text-ink-muted',
              isFile && 'mt-3 font-semibold text-ink',
              !isAdd && !isDel && !isHunk && !isFile && 'text-ink-muted',
            )}
          >
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

/** Count real additions and deletions from the unified diff. */
export function summarizeDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}
