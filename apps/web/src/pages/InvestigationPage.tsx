import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Finding } from '@netra/domain';
import {
  AlertTriangle,
  ArrowUpRight,
  FileCode,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  RefreshCw,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';
import { Button, Mono, Panel, Skeleton } from '@/components/primitives';
import { SeverityBadge, StatusBadge } from '@/components/status';
import { ActivityRail } from '@/features/investigation/Activity';
import { ApprovalPanel } from '@/features/investigation/Approval';
import { BlastRadius } from '@/features/investigation/BlastRadius';
import { EvidencePanel } from '@/features/investigation/Evidence';
import { LifecycleTimeline } from '@/features/investigation/LifecycleTimeline';
import { ProvenanceBar } from '@/features/investigation/ProvenanceBar';
import { InvestigationTerminal } from '@/features/investigation/Terminal';
import { useInvestigation } from '@/hooks/useInvestigation';
import { api, type Session } from '@/lib/api';

/**
 * The investigation workspace.
 *
 * Laid out to answer the reviewer's questions in order: what changed, why it
 * matters, what it can reach, what proves it, and what to do about it.
 */
export function InvestigationPage({ session }: { session: Session }) {
  const { id } = useParams<{ id: string }>();
  const state = useInvestigation(session, id);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const approve = useCallback(
    async (note?: string) => {
      if (!id || !state.action) return;
      await api.approve(session, id, state.action.id, note);
      await state.refresh();
    },
    [id, session, state],
  );

  const reject = useCallback(
    async (reason: string) => {
      if (!id || !state.action) return;
      await api.reject(session, id, state.action.id, reason);
      await state.refresh();
    },
    [id, session, state],
  );

  if (state.loading) return <InvestigationSkeleton />;

  if (state.error) {
    return (
      <div className="grid place-items-center py-24">
        <Panel className="max-w-md p-6 text-center">
          <AlertTriangle size={22} className="mx-auto text-[--color-state-review]" />
          <h1 className="mt-3 text-base font-semibold">This investigation could not be loaded</h1>
          <p className="mt-2 text-sm text-[--color-ink-muted]">{state.error}</p>
          <Button className="mt-4" variant="primary" onClick={() => void state.refresh()}>
            <RefreshCw size={14} />
            Try again
          </Button>
        </Panel>
      </div>
    );
  }

  const investigation = state.detail?.investigation;
  const finding = state.findings[0];
  const provenance = investigation?.modelProvenance ?? null;

  // The resolved PR URL comes from the action record.
  const resolvedPrUrl = state.action?.resultUrl ?? null;
  const isResolved = state.status === 'RESOLVED';
  const isFailed = state.status === 'FAILED';

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">

      {/* ── Top header: reference, repo, commit, badges ─────────────────── */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
        <div className="flex items-center gap-2.5">
          <Mono className="rounded bg-[--color-surface-raised] px-2 py-1 text-[0.72rem] font-semibold text-[--color-ink]">
            {investigation?.reference}
          </Mono>
          <span className="text-sm font-medium text-[--color-ink-muted]">
            {investigation?.change.repositoryFullName}
          </span>
          {investigation?.change.pullRequestNumber ? (
            <span className="flex items-center gap-1 text-xs text-[--color-ink-subtle]">
              <GitPullRequest size={12} />
              PR #{investigation.change.pullRequestNumber}
            </span>
          ) : null}
          {investigation?.change.branch ? (
            <span className="flex items-center gap-1 text-xs text-[--color-ink-subtle]">
              <GitBranch size={12} />
              <Mono>{investigation.change.branch}</Mono>
            </span>
          ) : null}
          <span className="flex items-center gap-1 text-xs text-[--color-ink-subtle]">
            <GitCommitHorizontal size={13} />
            <Mono>{investigation?.change.commitSha.slice(0, 8)}</Mono>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {investigation?.startedAt ? (
            <span className="hidden text-[0.68rem] text-[--color-ink-subtle] sm:block">
              {formatTimeAgo(investigation.startedAt)}
            </span>
          ) : null}
          {investigation?.severity ? <SeverityBadge severity={investigation.severity} /> : null}
          {state.status ? <StatusBadge status={state.status} /> : null}
        </div>
      </header>

      {/* ── Lifecycle timeline ────────────────────────────────────────────── */}
      <Panel className="px-5 py-3.5">
        <LifecycleTimeline status={state.status} />
      </Panel>

      {/* ── Resolved banner ───────────────────────────────────────────────── */}
      {isResolved && resolvedPrUrl ? (
        <a
          href={resolvedPrUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 rounded-[--radius-panel] border border-[color-mix(in_oklch,var(--color-state-resolved)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-state-resolved)_10%,transparent)] px-4 py-3 transition-colors hover:bg-[color-mix(in_oklch,var(--color-state-resolved)_15%,transparent)]"
        >
          <GitPullRequest size={16} className="shrink-0 text-[--color-state-resolved]" />
          <div className="min-w-0 flex-1">
            <p className="text-[0.7rem] uppercase tracking-[0.08em] text-[--color-state-resolved]">
              Remediation applied
            </p>
            <p className="mt-0.5 truncate text-sm font-medium text-[--color-ink]">
              {resolvedPrUrl.replace('https://github.com/', '')}
            </p>
          </div>
          <ArrowUpRight
            size={15}
            className="shrink-0 text-[--color-ink-subtle] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
          />
        </a>
      ) : null}

      {/* ── Consequence panel ─────────────────────────────────────────────── */}
      <Panel className="overflow-hidden">
        <div className="px-5 py-4">
          <p className="text-[0.68rem] uppercase tracking-[0.08em] text-[--color-ink-subtle]">
            {investigation?.change.title}
          </p>
          <h1 className="mt-2 text-lg font-semibold leading-snug text-[--color-ink] sm:text-xl">
            {investigation?.summary ??
              (isFailed
                ? 'This investigation could not be completed.'
                : 'Netra is investigating this change…')}
          </h1>
          {finding?.impact ? (
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[--color-ink-muted]">
              {finding.impact}
            </p>
          ) : null}

          {isFailed && state.failureReason ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-[color-mix(in_oklch,var(--color-state-severe)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-state-severe)_10%,transparent)] px-3 py-2.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[--color-state-severe]" />
              <div>
                <p className="text-sm text-[--color-ink]">{state.failureReason}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1.5 px-0"
                  onClick={() => void state.refresh()}
                >
                  <RefreshCw size={12} />
                  Reload investigation
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <ProvenanceBar provenance={provenance} />
      </Panel>

      {/* ── Finding summary card(s) ───────────────────────────────────────── */}
      {state.findings.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="list" aria-label="Findings">
          {state.findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      ) : null}

      {/* ── Workspace grid: graph + terminal / activity + evidence ─────────── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid min-h-0 grid-rows-[minmax(260px,1fr)_minmax(200px,0.85fr)] gap-3">
          <BlastRadius
            graph={state.graph}
            selectedEvidenceFile={selectedFile}
            onSelectNode={setSelectedFile}
          />
          <InvestigationTerminal commands={state.commands} />
        </div>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
          <ActivityRail status={state.status} activities={state.activities} />
          <EvidencePanel
            evidence={state.evidence}
            verifications={state.verifications}
            selectedFile={selectedFile}
            onSelect={setSelectedFile}
            modelUsed={provenance?.modelUsed ?? false}
          />
        </div>
      </div>

      {/* ── Approval / decision panel ─────────────────────────────────────── */}
      <ApprovalPanel
        finding={finding}
        remediation={state.remediation}
        action={state.action}
        verifications={state.verifications}
        onApprove={approve}
        onReject={reject}
      />
    </div>
  );
}

/** One finding — summarises the consequence, verification status, and recommendation. */
function FindingCard({ finding }: { finding: Finding }) {
  const isVerified = finding.verificationStatus === 'VERIFIED';
  const isRefuted = finding.verificationStatus === 'REFUTED';

  return (
    <article
      role="listitem"
      className="panel flex flex-col gap-3 p-4 transition-colors"
      aria-label={finding.title}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {isVerified ? (
            <ShieldCheck size={15} className="shrink-0 text-[--color-state-severe]" />
          ) : isRefuted ? (
            <ShieldX size={15} className="shrink-0 text-[--color-ink-subtle]" />
          ) : (
            <AlertTriangle size={15} className="shrink-0 text-[--color-state-review]" />
          )}
          <h3 className="text-sm font-semibold leading-snug text-[--color-ink]">{finding.title}</h3>
        </div>
        <span
          className={[
            'shrink-0 rounded px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide',
            isVerified
              ? 'bg-[color-mix(in_oklch,var(--color-state-severe)_15%,transparent)] text-[--color-state-severe]'
              : 'bg-[--color-surface-raised] text-[--color-ink-subtle]',
          ].join(' ')}
        >
          {finding.verificationStatus.replace('_', ' ')}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-[--color-ink-muted]">{finding.description}</p>

      {finding.affectedFiles.length > 0 ? (
        <ul className="space-y-1">
          {finding.affectedFiles.map((file) => (
            <li key={file} className="flex items-center gap-1.5">
              <FileCode size={11} className="shrink-0 text-[--color-ink-subtle]" />
              <span className="mono truncate text-[0.7rem] text-[--color-ink-muted]">{file}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {finding.recommendation ? (
        <div className="border-t border-[--color-line] pt-3">
          <p className="text-[0.68rem] uppercase tracking-[0.07em] text-[--color-ink-subtle]">Recommendation</p>
          <p className="mt-1 text-xs leading-relaxed text-[--color-ink-muted]">{finding.recommendation}</p>
        </div>
      ) : null}
    </article>
  );
}

function InvestigationSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3">
      <Skeleton className="h-8 w-80" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-28 w-full" />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid min-h-0 grid-rows-2 gap-3">
          <Skeleton className="h-full w-full" />
          <Skeleton className="h-full w-full" />
        </div>
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  );
}

/** Returns a compact, human-readable relative time string. */
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
