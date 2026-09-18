import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, GitCommitHorizontal, RefreshCw } from 'lucide-react';
import { Button, Mono, Panel, Skeleton } from '@/components/primitives';
import { SeverityBadge, StatusBadge } from '@/components/status';
import { ActivityRail } from '@/features/investigation/Activity';
import { ApprovalPanel } from '@/features/investigation/Approval';
import { BlastRadius } from '@/features/investigation/BlastRadius';
import { EvidencePanel } from '@/features/investigation/Evidence';
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
  const modelUsed = state.activities.every(
    (a) => !a.message.includes('Model investigation unavailable'),
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
        <div className="flex items-center gap-2.5">
          <Mono className="rounded bg-[--color-surface-raised] px-2 py-1 text-[0.72rem] font-semibold text-[--color-ink]">
            {investigation?.reference}
          </Mono>
          <span className="text-sm text-[--color-ink-muted]">
            {investigation?.change.repositoryFullName}
            {investigation?.change.pullRequestNumber
              ? ` · PR #${investigation.change.pullRequestNumber}`
              : ''}
          </span>
          <span className="flex items-center gap-1 text-xs text-[--color-ink-subtle]">
            <GitCommitHorizontal size={13} />
            <Mono>{investigation?.change.commitSha.slice(0, 8)}</Mono>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {investigation?.severity ? <SeverityBadge severity={investigation.severity} /> : null}
          {state.status ? <StatusBadge status={state.status} /> : null}
        </div>
      </header>

      {/* The one-sentence answer, before any detail. */}
      <Panel className="px-5 py-4">
        <p className="text-[0.68rem] uppercase tracking-[0.08em] text-[--color-ink-subtle]">
          {investigation?.change.title}
        </p>
        <h1 className="mt-2 text-lg font-semibold leading-snug text-[--color-ink] sm:text-xl">
          {investigation?.summary ??
            (state.status === 'FAILED'
              ? 'This investigation could not be completed.'
              : 'Netra is investigating this change…')}
        </h1>
        {finding?.impact ? (
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[--color-ink-muted]">
            {finding.impact}
          </p>
        ) : null}

        {state.status === 'FAILED' && state.failureReason ? (
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
      </Panel>

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
            modelUsed={modelUsed}
          />
        </div>
      </div>

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

function InvestigationSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3">
      <Skeleton className="h-8 w-80" />
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
