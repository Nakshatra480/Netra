import { useState } from 'react';
import type { Action, Finding, Remediation, VerificationResult } from '@netra/domain';
import { motion } from 'framer-motion';
import { AlertOctagon, ArrowUpRight, Check, GitPullRequest, ShieldCheck, X } from 'lucide-react';
import { Button, Mono } from '@/components/primitives';
import { cn } from '@/lib/cn';

/**
 * The approval boundary.
 *
 * This is the moment the product exists for, so it is visually separated from
 * everything else and states exactly what will happen, on what evidence, before
 * asking for a decision. Netra cannot proceed without one.
 */
export function ApprovalPanel({
  finding,
  remediation,
  action,
  verifications,
  onApprove,
  onReject,
  className,
}: {
  finding: Finding | undefined;
  remediation: Remediation | null;
  action: Action | null;
  verifications: VerificationResult[];
  onApprove: (note?: string) => Promise<void>;
  onReject: (reason: string) => Promise<void>;
  className?: string;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!remediation || !action || !finding) return null;

  const decided = action.status !== 'PENDING';
  const verified = verifications.find((v) => v.phase === 'PRE_FIX')?.status === 'VERIFIED';

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The decision could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={cn(
        'rounded-panel border-2 bg-surface',
        decided
          ? 'border-line'
          : 'border-[color-mix(in_oklch,var(--color-state-review)_60%,transparent)]',
        className,
      )}
    >
      <header
        className={cn(
          'flex items-center gap-2.5 rounded-t-[0.6rem] px-4 py-2.5',
          decided
            ? 'bg-surface-raised'
            : 'bg-[color-mix(in_oklch,var(--color-state-review)_15%,transparent)]',
        )}
      >
        {decided ? (
          <ShieldCheck size={15} className="text-ink-muted" />
        ) : (
          <AlertOctagon size={15} className="text-state-review" />
        )}
        <h2
          className={cn(
            'text-[0.78rem] font-semibold uppercase tracking-[0.08em]',
            decided ? 'text-ink-muted' : 'text-state-review',
          )}
        >
          {decided ? `Decision recorded — ${action.status.toLowerCase()}` : 'Action requires your approval'}
        </h2>
      </header>

      <div className="space-y-4 p-4">
        <div>
          <h3 className="text-base font-semibold text-ink">{remediation.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
            {remediation.rationale}
          </p>
        </div>

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <div>
            <dt className="text-[0.68rem] uppercase tracking-[0.07em] text-ink-subtle">
              Evidence
            </dt>
            <dd className="mt-1 text-sm text-ink">
              {verified ? 'Verified by deterministic check' : 'Not verified'}
            </dd>
          </div>
          <div>
            <dt className="text-[0.68rem] uppercase tracking-[0.07em] text-ink-subtle">
              Files changed
            </dt>
            <dd className="mt-1 text-sm text-ink">{remediation.affectedFiles.length}</dd>
          </div>
          <div>
            <dt className="text-[0.68rem] uppercase tracking-[0.07em] text-ink-subtle">
              Approved by
            </dt>
            <dd className="mt-1 text-sm text-ink">
              {action.approvedBy ? <Mono>{action.approvedBy}</Mono> : 'Nobody yet'}
            </dd>
          </div>
        </dl>

        <div>
          <p className="text-[0.68rem] uppercase tracking-[0.07em] text-ink-subtle">
            Expected impact
          </p>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">
            {remediation.expectedImpact}
          </p>
        </div>

        <div>
          <Button size="sm" variant="secondary" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? 'Hide the exact change' : 'Review the exact change'}
          </Button>
          {showDiff ? (
            <pre className="mono mt-3 max-h-80 overflow-auto rounded-md border border-line bg-surface-sunken p-3 text-[0.72rem] leading-relaxed">
              {remediation.diff.split('\n').map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    line.startsWith('+') && !line.startsWith('+++') && 'text-state-resolved',
                    line.startsWith('-') && !line.startsWith('---') && 'text-state-severe',
                    line.startsWith('@@') && 'text-state-active',
                    line.startsWith('diff --git') && 'mt-2 font-semibold text-ink',
                  )}
                >
                  {line || ' '}
                </div>
              ))}
            </pre>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-md border border-[color-mix(in_oklch,var(--color-state-severe)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-state-severe)_10%,transparent)] px-3 py-2 text-xs text-state-severe">
            {error}
          </p>
        ) : null}

        {!decided ? (
          rejecting ? (
            <div className="space-y-2">
              <label htmlFor="reject-reason" className="block text-xs text-ink-muted">
                Why are you rejecting this? It is recorded in the audit trail.
              </label>
              <textarea
                id="reject-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                className="w-full rounded-md border border-line bg-surface-sunken px-3 py-2 text-sm text-ink placeholder:text-ink-subtle"
                placeholder="This upload path is behind a feature flag and never ships."
              />
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={busy || reason.trim().length === 0}
                  onClick={() => void act(() => onReject(reason.trim()))}
                >
                  Confirm rejection
                </Button>
                <Button variant="ghost" onClick={() => setRejecting(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button variant="danger" onClick={() => setRejecting(true)} disabled={busy}>
                <X size={14} />
                Reject
              </Button>
              <Button
                variant="approve"
                size="lg"
                disabled={busy}
                onClick={() => void act(() => onApprove())}
                className="ml-auto"
              >
                <GitPullRequest size={15} />
                {busy ? 'Applying…' : 'Approve & create remediation'}
              </Button>
            </div>
          )
        ) : (
          <div className="space-y-3 border-t border-line pt-4">
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <Check size={14} className="text-state-resolved" />
              {action.decisionNote ? `"${action.decisionNote}"` : 'No note was recorded.'}
            </div>
            {action.resultUrl ? (
              <a
                href={action.resultUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 rounded-md border border-[color-mix(in_oklch,var(--color-state-resolved)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-state-resolved)_10%,transparent)] px-3 py-2 text-sm font-medium text-state-resolved transition-colors hover:bg-[color-mix(in_oklch,var(--color-state-resolved)_15%,transparent)]"
              >
                <GitPullRequest size={14} />
                View remediation PR
                <ArrowUpRight
                  size={13}
                  className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                />
              </a>
            ) : null}
          </div>
        )}
      </div>
    </motion.section>
  );
}
