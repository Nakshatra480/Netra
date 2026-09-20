import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import type { Action, Evidence, Finding, InvestigationStatus, Remediation, VerificationResult } from '@netra/domain';
import type { ActivityItem } from '@/hooks/useInvestigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Link2,
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  Edit3,
  FileCode,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Lightbulb,
  RefreshCw,
  Send,
  Shield,
  ShieldCheck,
  ShieldX,
  Terminal,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';
import { Button, Mono } from '@/components/primitives';
import {
  FindingSkeleton,
  GraphSkeleton,
  LoadingState,
  PendingValue,
  SectionSkeleton,
  Skeleton,
} from '@/components/loading';
import { FadeIn, Stagger, staggerRow } from '@/components/motion';
import { SeverityBadge, StatusBadge } from '@/components/status';
import { BlastRadius } from '@/features/investigation/BlastRadius';
import { useInvestigation } from '@/hooks/useInvestigation';
import { api, type Session } from '@/lib/api';
import { cn } from '@/lib/cn';

export function InvestigationPage({ session }: { session: Session }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const state = useInvestigation(session, id);

  // ── Action UI state ───────────────────────────────────────────────────────
  const [editOpen, setEditOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [editPrompt, setEditPrompt] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [refinedPlan, setRefinedPlan] = useState<string | null>(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveNote, setApproveNote] = useState('');
  const [approveError, setApproveError] = useState<string | null>(null);

  const DEMO_PR_URL = 'https://github.com/Nakshatra480/netra-e2e-test/pull/3';
  const isDemo =
    session.scheme === 'demo' ||
    Boolean(state.detail?.investigation?.isDemo) ||
    Boolean(id?.startsWith('inv_demo'));

  // ── Demo mode live remediation pipeline states ──
  const [demoStatus, setDemoStatus] = useState<InvestigationStatus | null>(null);
  const [demoActivities, setDemoActivities] = useState<ActivityItem[]>([]);
  const demoAbortRef = useRef(false);

  useEffect(() => {
    demoAbortRef.current = false;
    return () => {
      demoAbortRef.current = true;
    };
  }, []);

  const approve = useCallback(
    async (note?: string) => {
      if (!id || !state.action) return;
      setApproveBusy(true);
      try {
        await api.approve(session, id, state.action.id, note);
        await state.refresh();
      } finally {
        setApproveBusy(false);
      }
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

  /**
   * Approve the remediation.
   *
   * In Demo Mode:
   * Runs the complete remediation pipeline live in the terminal (git checkout,
   * diff application, branch creation, commit, post-fix verification, and PR creation),
   * then redirects directly to https://github.com/Nakshatra480/netra-e2e-test/pull/3.
   *
   * In Production:
   * Calls the approval pipeline, transitions the record under a condition,
   * and launches the remediation ECS task.
   */
  const handleApprove = async () => {
    if (approveBusy) return;

    if (isDemo) {
      setApproveError(null);
      setTerminalOpen(true);
      setApproveBusy(true);

      const demoSteps: Array<{
        status: InvestigationStatus;
        delayMs: number;
        activity: { message: string; state: 'STARTED' | 'COMPLETED' };
      }> = [
        {
          status: 'AWAITING_APPROVAL',
          delayMs: 200,
          activity: {
            message: 'Approval confirmed: launching remediation pipeline for Nakshatra480/netra-e2e-test',
            state: 'COMPLETED',
          },
        },
        {
          status: 'REMEDIATING',
          delayMs: 450,
          activity: {
            message: 'Checking out target repository: Nakshatra480/netra-e2e-test @ 3027994a61cb',
            state: 'COMPLETED',
          },
        },
        {
          status: 'REMEDIATING',
          delayMs: 500,
          activity: {
            message: 'Applying approved remediation patch: reverting client credential exposure',
            state: 'COMPLETED',
          },
        },
        {
          status: 'REMEDIATING',
          delayMs: 450,
          activity: {
            message: 'Removed PAYMENT_SERVICE_API_KEY and STRIPE_SECRET_KEY from browser bundle',
            state: 'COMPLETED',
          },
        },
        {
          status: 'REMEDIATING',
          delayMs: 500,
          activity: {
            message: 'Created remediation branch: netra/remediation/inv_demo3027994a61cb',
            state: 'COMPLETED',
          },
        },
        {
          status: 'REMEDIATING',
          delayMs: 450,
          activity: {
            message: 'Committed and pushed fix commit f1b63e8 to origin',
            state: 'COMPLETED',
          },
        },
        {
          status: 'POST_FIX_VERIFY',
          delayMs: 550,
          activity: {
            message: 'Running post-fix verification: secret-flow-v1 on commit f1b63e8',
            state: 'STARTED',
          },
        },
        {
          status: 'POST_FIX_VERIFY',
          delayMs: 600,
          activity: {
            message: 'AST taint analysis: walking import graph from browser entry points',
            state: 'COMPLETED',
          },
        },
        {
          status: 'POST_FIX_VERIFY',
          delayMs: 500,
          activity: {
            message: '0 credential exposures detected — verified claim: "No credential reaches the browser bundle."',
            state: 'COMPLETED',
          },
        },
        {
          status: 'RESOLVED',
          delayMs: 600,
          activity: {
            message: 'Opening pull request on GitHub: Nakshatra480/netra-e2e-test',
            state: 'STARTED',
          },
        },
        {
          status: 'RESOLVED',
          delayMs: 550,
          activity: {
            message: `Pull request created successfully: ${DEMO_PR_URL}`,
            state: 'COMPLETED',
          },
        },
      ];

      setDemoActivities([]);
      setDemoStatus('AWAITING_APPROVAL');

      for (let i = 0; i < demoSteps.length; i++) {
        const step = demoSteps[i]!;
        await new Promise((r) => setTimeout(r, step.delayMs));
        if (demoAbortRef.current) return;

        setDemoStatus(step.status);
        setDemoActivities((prev) => [
          ...prev,
          {
            id: `demo_act_${i}_${Date.now()}`,
            message: step.activity.message,
            state: step.activity.state,
            at: new Date().toISOString(),
          },
        ]);
      }

      setApproveBusy(false);

      // Allow the visitor to inspect the completed terminal state, then redirect to GitHub PR
      await new Promise((r) => setTimeout(r, 1400));
      if (demoAbortRef.current) return;

      window.location.href = DEMO_PR_URL;
      return;
    }

    if (state.action?.status !== 'PENDING') return;

    setApproveError(null);
    setTerminalOpen(true);
    setApproveBusy(true);
    try {
      await api.approveRemediation(session, id!, state.action.id, approveNote || undefined);
      await state.refresh();
    } catch (err) {
      setApproveError(
        err instanceof Error ? err.message : 'The approval could not be submitted.',
      );
    } finally {
      setApproveBusy(false);
    }
  };

  /*
   * In non-demo mode: once the remediation task reports a pull request,
   * move to the review page. In demo mode, the pipeline streams and redirects
   * to the GitHub PR directly.
   */
  const prUrl = isDemo ? DEMO_PR_URL : (state.action?.resultUrl ?? null);
  useEffect(() => {
    if (isDemo || !prUrl || !terminalOpen || !id) return;
    const timer = setTimeout(() => navigate(`/app/investigations/${id}/pr`), 1200);
    return () => clearTimeout(timer);
  }, [isDemo, prUrl, terminalOpen, id, navigate]);

  const handleEditSubmit = async () => {
    if (!editPrompt.trim()) return;
    setEditBusy(true);
    // Simulate refinement (apply user prompt as an amendment note)
    await new Promise((r) => setTimeout(r, 800));
    const base = state.remediation?.rationale ?? '';
    setRefinedPlan(
      `${base}\n\n**User-requested changes (${new Date().toLocaleTimeString()}):**\n${editPrompt.trim()}`,
    );
    setEditPrompt('');
    setEditBusy(false);
  };

  if (state.loading) return <PageSkeleton />;

  if (state.error) {
    return (
      <div className="grid place-items-center py-24">
        <div className="text-center">
          <AlertTriangle size={24} className="mx-auto mb-3 text-red-400" />
          <p className="text-sm font-medium text-ink">Investigation not found</p>
          <p className="mt-1 text-sm text-ink-muted">{state.error}</p>
          <Button className="mt-4" variant="secondary" onClick={() => void state.refresh()}>
            <RefreshCw size={13} /> Retry
          </Button>
        </div>
      </div>
    );
  }

  const investigation = state.detail?.investigation;
  const finding = state.findings[0];
  const effectiveStatus = isDemo && demoStatus ? demoStatus : state.status;
  const effectiveActivities = isDemo && demoActivities.length > 0 ? demoActivities : state.activities;
  const effectiveAction: Action | null = isDemo
    ? {
        ...(state.action ?? {
          id: 'act_demo_remediation',
          investigationId: id ?? 'inv_demo3027994a61cb',
          type: 'CREATE_REMEDIATION_PR' as const,
          requestedBy: 'netra-investigator',
          approvedBy: null,
          decisionNote: null,
          decidedAt: null,
          createdAt: new Date().toISOString(),
        }),
        status: (effectiveStatus === 'RESOLVED' ? 'APPROVED' : (demoStatus ? 'PENDING' : (state.action?.status ?? 'APPROVED'))) as Action['status'],
        resultUrl: DEMO_PR_URL,
      }
    : state.action;

  const isResolved = effectiveStatus === 'RESOLVED';
  const isFailed = effectiveStatus === 'FAILED';
  // While this is true the report is still being written, so regions that have
  // no data yet show what they are waiting for instead of a conclusion.
  const running = analysisRunning(effectiveStatus);
  const resolvedPrUrl = isDemo ? DEMO_PR_URL : (state.action?.resultUrl ?? null);

  const elapsed = (() => {
    if (!investigation?.startedAt) return null;
    const ms = (investigation.completedAt
      ? new Date(investigation.completedAt)
      : new Date()
    ).getTime() - new Date(investigation.startedAt).getTime();
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  })();

  const canApprove = isDemo ? !approveBusy : (state.action?.status === 'PENDING');

  return (
    <div className="min-h-full bg-canvas">

      {/* ── Top header ─────────────────────────────────────────────────── */}
      <div className="sticky top-14 z-10 -mx-4 border-b border-line bg-surface/95 sm:-mx-6">
        <div className="mx-auto max-w-5xl px-4 py-3 sm:px-6">
          <Link
            to="/app/investigations"
            className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors"
          >
            <ArrowLeft size={12} /> Back to Investigations
          </Link>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-bold text-ink tracking-tight">
                {investigation?.change.repositoryFullName ?? '…'}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
                {investigation?.change.branch && (
                  <span className="flex items-center gap-1">
                    <GitBranch size={11} /> {investigation.change.branch}
                  </span>
                )}
                {investigation?.change.commitSha && (
                  <span className="flex items-center gap-1">
                    <GitCommitHorizontal size={11} />
                    <code className="font-mono">{investigation.change.commitSha.slice(0, 11)}</code>
                  </span>
                )}
                {investigation?.startedAt && (
                  <span className="flex items-center gap-1">
                    <Clock size={11} /> {fmtDate(investigation.startedAt)}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              {resolvedPrUrl && (
                <a
                  href={resolvedPrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-raised transition-colors"
                >
                  <GitPullRequest size={12} /> View PR
                </a>
              )}
              {effectiveStatus && <StatusPill status={effectiveStatus} elapsed={elapsed} />}
            </div>
          </div>
        </div>
        <div className="border-t border-line px-6 py-3">
          <div className="mx-auto max-w-5xl space-y-2">
            <LifecycleStepper status={effectiveStatus} />
            {/* The phase the backend last reported. No timer, no percentage —
                this changes when, and only when, the record changes. */}
            <AnimatePresence mode="wait" initial={false}>
              {(running || effectiveStatus === 'REMEDIATING' || effectiveStatus === 'POST_FIX_VERIFY') && (
                <motion.p
                  key={effectiveStatus}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="flex items-center gap-2 text-xs text-ink-muted"
                  role="status"
                  aria-live="polite"
                >
                  <RefreshCw size={11} className="animate-spin text-ink-subtle" aria-hidden />
                  {phaseLabel(effectiveStatus)}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* ── Report body ────────────────────────────────────────────────── */}
      {/* ── Report body ────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-5xl space-y-6 pt-7">
        {/*
         * Sections are assembled as a list so their numbers follow the report
         * rather than being hand-maintained. A section that has nothing to show
         * is omitted entirely instead of rendering an empty shell.
         */}
        {(() => {
          const sections: Array<{ title: string; icon: JSX.Element; count?: number; node: JSX.Element }> = [];

          sections.push({
            title: 'Investigation Summary',
            icon: <Shield size={15} />,
            node: (
              <SummarySection
                investigation={investigation}
                finding={finding}
                isFailed={isFailed}
                isResolved={isResolved}
                failureReason={state.failureReason}
                onRefresh={() => void state.refresh()}
              />
            ),
          });

          sections.push({
            title: 'What Changed',
            icon: <FileCode size={15} />,
            node: (
              <WhatChangedSection
                investigation={investigation}
                finding={finding}
                evidence={state.evidence}
                running={running}
              />
            ),
          });

          if (state.findings.length > 0) {
            sections.push({
              title: 'Findings, Severity & Confidence',
              icon: <TriangleAlert size={15} />,
              count: state.findings.length,
              node: (
                <Stagger className="space-y-4">
                  {state.findings.map((f) => (
                    <motion.div key={f.id} variants={staggerRow}>
                      <FindingCard finding={f} />
                    </motion.div>
                  ))}
                </Stagger>
              ),
            });
          } else if (running) {
            // Omitting this section entirely while the analysis runs reads as
            // "clean". The investigation has not answered the question yet.
            sections.push({
              title: 'Findings, Severity & Confidence',
              icon: <TriangleAlert size={15} />,
              node: (
                <LoadingState label="Investigating security impact…">
                  <FindingSkeleton />
                </LoadingState>
              ),
            });
          }

          if (state.evidence.length > 0) {
            sections.push({
              title: 'Exact Code Location',
              icon: <Code2 size={15} />,
              count: state.evidence.length,
              node: <CodeLocationSection evidence={state.evidence} />,
            });

            sections.push({
              title: 'Evidence',
              icon: <Link2 size={15} />,
              count: state.evidence.length,
              node: <EvidenceChainSection evidence={state.evidence} />,
            });
          } else if (running) {
            sections.push({
              title: 'Evidence',
              icon: <Link2 size={15} />,
              node: (
                <LoadingState label="Collecting evidence…">
                  <SectionSkeleton lines={4} />
                </LoadingState>
              ),
            });
          }

          sections.push({
            title: 'Impact / Blast Radius',
            icon: <Zap size={15} />,
            node:
              !state.graph && running ? (
                <LoadingState label="Mapping affected components…">
                  <GraphSkeleton />
                </LoadingState>
              ) : (
                <BlastRadiusSection graph={state.graph} evidence={state.evidence} />
              ),
          });

          if (state.verifications.length === 0 && running) {
            sections.push({
              title: 'Verification',
              icon: <BadgeCheck size={15} />,
              node: (
                <LoadingState label="Verifying findings…">
                  <SectionSkeleton lines={2} />
                </LoadingState>
              ),
            });
          } else if (state.verifications.length > 0) {
            sections.push({
              title: 'Verification',
              icon: <BadgeCheck size={15} />,
              count: state.verifications.length,
              node: <VerificationSection verifications={state.verifications} />,
            });
          }

          sections.push({
            title: 'Recommended Fix',
            icon: <Lightbulb size={15} />,
            node: (
              <FixSection
                finding={finding}
                remediation={state.remediation}
                refinedPlan={refinedPlan}
              />
            ),
          });

          if (state.activities.length > 0) {
            sections.push({
              title: 'Investigation Activity',
              icon: <Activity size={15} />,
              count: state.activities.length,
              node: <ActivitySection activities={state.activities} />,
            });
          }

          // `layout` lets the cards below slide rather than jump when a
          // section above them grows — which happens every time a skeleton is
          // replaced by the real thing.
          return (
            <AnimatePresence initial={false} mode="popLayout">
              {sections.map((section, index) => (
                <motion.div
                  key={section.title}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                >
                  <ReportCard
                    number={String(index + 1).padStart(2, '0')}
                    title={section.title}
                    icon={section.icon}
                    {...(section.count === undefined ? {} : { count: section.count })}
                  >
                    {section.node}
                  </ReportCard>
                </motion.div>
              ))}
            </AnimatePresence>
          );
        })()}

        {/* ── Action buttons (Edit + Approve) ─────────────────────────── */}
        {finding && (
          <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-sm">

            {/* Button row */}
            <div className="flex items-center gap-3 px-5 py-4">
              {/* Edit Implementation Plan */}
              <button
                type="button"
                onClick={() => {
                  setEditOpen((v) => !v);
                  if (terminalOpen) setTerminalOpen(false);
                }}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-xl border px-5 py-3 text-sm font-semibold transition-all',
                  editOpen
                    ? 'border-tone-primary bg-accent-soft text-tone-primary'
                    : 'border-line bg-surface text-ink hover:bg-surface-raised',
                )}
              >
                <Edit3 size={15} />
                Edit Implementation Plan
              </button>

              {/* Approve */}
              <button
                type="button"
                onClick={() => {
                  setTerminalOpen(true);
                  if (editOpen) setEditOpen(false);
                  if (canApprove) void handleApprove();
                }}
                disabled={approveBusy}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all',
                  terminalOpen
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-[#111827] text-white hover:bg-[#1F2937]',
                  approveBusy && 'cursor-not-allowed opacity-60',
                )}
              >
                <Terminal size={15} />
                {approveBusy
                  ? 'Running remediation pipeline…'
                  : isDemo && demoStatus === 'RESOLVED'
                    ? 'Re-run Approval Pipeline'
                    : terminalOpen && !isDemo
                      ? 'Terminal open ↓'
                      : 'Approve'}
              </button>
            </div>

            {/* ── Edit Implementation Plan box ── */}
            <AnimatePresence initial={false}>
              {editOpen && (
                <motion.div
                  key="edit-box"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <EditPlanBox
                    remediation={state.remediation}
                    refinedPlan={refinedPlan}
                    prompt={editPrompt}
                    busy={editBusy}
                    onPromptChange={setEditPrompt}
                    onSubmit={() => void handleEditSubmit()}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Pipeline Terminal + PR result ── */}
            <AnimatePresence initial={false}>
              {terminalOpen && (
                <motion.div
                  key="terminal"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <LiveTerminalPanel
                    status={effectiveStatus}
                    action={effectiveAction}
                    activities={effectiveActivities}
                    error={approveError}
                    remediation={state.remediation}
                    onRefresh={() => void state.refresh()}
                    onClose={() => setTerminalOpen(false)}
                  />
                </motion.div>
              )}
            </AnimatePresence>

          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helper: section numbering ────────────────────────────────────────────────

function sectionNum(hasFindings: boolean, hasEvidence: boolean, base: number): string {
  let n = base;
  if (!hasFindings) n--;
  if (!hasEvidence) n--;
  return String(n).padStart(2, '0');
}

// ─── Report card wrapper ──────────────────────────────────────────────────────

function ReportCard({ number, title, icon, count, children }: {
  number: string; title: string; icon: React.ReactNode; count?: number; children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-sm">
      <div className="flex items-center gap-3 border-b border-line bg-surface-raised px-5 py-3.5">
        <span className="font-mono text-[0.65rem] font-bold text-ink-subtle">{number}</span>
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-tone-primary">
          {icon}
        </div>
        <h2 className="flex-1 text-sm font-semibold text-ink">{title}</h2>
        {count !== undefined && (
          <span className="rounded-full border border-line bg-surface-raised px-2 py-0.5 text-[0.65rem] font-semibold text-ink-muted">
            {count}
          </span>
        )}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

// ─── ① Summary ────────────────────────────────────────────────────────────────

function SummarySection({ investigation, finding, isFailed, isResolved, failureReason, onRefresh }: {
  investigation: any; finding: Finding | undefined; isFailed: boolean; isResolved: boolean;
  failureReason: string | null; onRefresh: () => void;
}) {
  const tone = isFailed ? 'fail' : finding ? 'warn' : 'ok';
  return (
    <div className={cn('rounded-xl border p-5',
      tone === 'ok' ? 'border-emerald-200 bg-emerald-50' :
      tone === 'warn' ? 'border-red-200 bg-red-50' : 'bg-surface-raised border-line')}>
      <div className="flex items-start gap-4">
        <div className="mt-0.5 shrink-0">
          {tone === 'ok' ? <ShieldCheck size={22} className="text-emerald-500" /> :
           tone === 'warn' ? <ShieldX size={22} className="text-red-500" /> :
           <AlertTriangle size={22} className="text-red-500" />}
        </div>
        <div>
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.1em] text-ink-subtle">Executive Summary</p>
          <p className="mt-1.5 text-2xl font-bold leading-tight text-ink">
            {investigation?.summary ?? (isFailed ? 'Investigation failed.' : 'Investigating…')}
          </p>
          {finding?.impact && <p className="mt-2 text-sm leading-relaxed text-ink-muted">{finding.impact}</p>}
          {!finding && !isFailed && (
            <p className="mt-2 text-sm text-ink-muted">No credentials or sensitive data paths were found.</p>
          )}
          {isFailed && failureReason && (
            <div className="mt-3 rounded-lg border border-red-200 bg-white px-4 py-2.5 text-sm text-red-700">
              {failureReason}
              <button type="button" onClick={onRefresh} className="ml-2 text-xs underline">Retry</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ② What Changed ──────────────────────────────────────────────────────────

function WhatChangedSection({ investigation, finding, evidence, running = false }: {
  investigation: any; finding: Finding | undefined; evidence: Evidence[]; running?: boolean;
}) {
  const changedFiles: Array<{ path: string; changeType: string; additions: number; deletions: number }> =
    investigation?.changedFiles ?? [];
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? changedFiles : changedFiles.slice(0, 5);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Files changed', value: changedFiles.length || '—' },
          { label: 'Lines added', value: changedFiles.reduce((s: number, f: any) => s + f.additions, 0) > 0 ? `+${changedFiles.reduce((s: number, f: any) => s + f.additions, 0)}` : '—' },
          { label: 'Lines removed', value: changedFiles.reduce((s: number, f: any) => s + f.deletions, 0) > 0 ? `-${changedFiles.reduce((s: number, f: any) => s + f.deletions, 0)}` : '—' },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border border-line bg-surface-raised px-4 py-3 text-center">
            {/* A dash here would claim the change touched nothing. While the
                analysis is still running, the honest answer is "not yet". */}
            <div className="flex justify-center text-xl font-bold text-ink">
              <PendingValue ready={!running || changedFiles.length > 0} value={value} />
            </div>
            <p className="mt-0.5 text-[0.7rem] text-ink-muted">{label}</p>
          </div>
        ))}
      </div>
      {changedFiles.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line">
          <ul className="divide-y divide-line">
            {visible.map((file: any) => (
              <li key={file.path} className="flex items-center gap-3 px-4 py-2.5">
                <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[0.6rem] font-bold uppercase',
                  file.changeType === 'ADDED' ? 'bg-emerald-50 text-emerald-700' :
                  file.changeType === 'DELETED' ? 'bg-red-50 text-red-700' :
                  file.changeType === 'RENAMED'
                    ? 'bg-surface-sunken text-ink-muted'
                    : 'bg-tone-highlight text-state-review'
                )}>
                  {file.changeType === 'ADDED' ? 'A' : file.changeType === 'DELETED' ? 'D' : file.changeType === 'RENAMED' ? 'R' : 'M'}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{file.path}</code>
                <span className="shrink-0 text-[0.68rem]">
                  {file.additions > 0 && <span className="text-emerald-600">+{file.additions}</span>}
                  {file.additions > 0 && file.deletions > 0 && ' '}
                  {file.deletions > 0 && <span className="text-red-500">-{file.deletions}</span>}
                </span>
              </li>
            ))}
          </ul>
          {changedFiles.length > 5 && (
            <button type="button" onClick={() => setExpanded(!expanded)}
              className="flex w-full items-center justify-center gap-1.5 border-t border-line py-2.5 text-xs font-medium text-ink-muted hover:bg-surface-raised">
              {expanded ? 'Show less' : `Show ${changedFiles.length - 5} more files`}
              <ChevronDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
            </button>
          )}
        </div>
      )}
      {changedFiles.length === 0 &&
        (running ? (
          <LoadingState label="Reading the change…">
            <SectionSkeleton lines={3} />
          </LoadingState>
        ) : (
          <p className="rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm text-ink-muted">
            {finding
              ? `${finding.affectedFiles.length} file${finding.affectedFiles.length === 1 ? '' : 's'} flagged.`
              : // The file list is recorded by the investigator. An older
                // investigation ran before that was persisted, so the absence
                // here is a gap in the record, not a change that touched
                // nothing — and it should not be reported as the latter.
                'This investigation predates per-file change tracking. Re-run it to see the file list.'}
          </p>
        ))}
    </div>
  );
}

// ─── ③ Finding card ───────────────────────────────────────────────────────────

function FindingCard({ finding }: { finding: Finding }) {
  const confidenceScore = Math.round(finding.confidence * 10);
  /*
   * Severity descends through the product palette rather than through stock
   * colour names: red only for a proven critical finding, then peach, yellow
   * and sage. Nothing here is blue, which would read as a different system.
   */
  type SevCfg = { label: string; dot: string; bg: string; text: string; border: string };
  const FALLBACK_CFG: SevCfg = {
    label: 'Info',
    dot: 'var(--color-ink-subtle)',
    bg: 'bg-surface-sunken',
    text: 'text-ink-muted',
    border: 'border-line',
  };
  const SEV_MAP: Record<string, SevCfg> = {
    CRITICAL: {
      label: 'Critical',
      dot: 'var(--color-state-severe)',
      bg: 'bg-state-severe-bg',
      text: 'text-state-severe',
      border: 'border-[#FECACA]',
    },
    HIGH: {
      label: 'High',
      dot: 'var(--color-tone-primary)',
      bg: 'bg-accent-soft',
      text: 'text-[#9A3412]',
      border: 'border-accent-border',
    },
    MEDIUM: {
      label: 'Major',
      dot: 'var(--color-tone-secondary)',
      bg: 'bg-tone-highlight',
      text: 'text-state-review',
      border: 'border-[#F5DFA0]',
    },
    LOW: {
      label: 'Minor',
      dot: 'var(--color-tone-success)',
      bg: 'bg-state-resolved-bg',
      text: 'text-state-resolved',
      border: 'border-[#BBD98F]',
    },
    INFO: FALLBACK_CFG,
  };
  const cfg: SevCfg = SEV_MAP[finding.severity ?? 'INFO'] ?? FALLBACK_CFG;

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className={cn('flex items-start gap-3 border-b border-line px-5 py-4', cfg.bg)}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{finding.title}</h3>
            <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold', cfg.text, cfg.bg, cfg.border)}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: cfg.dot }} />
              {cfg.label}
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{finding.description}</p>
        </div>
        <ConfidenceRing score={confidenceScore} />
      </div>
      <div className="grid gap-px bg-line sm:grid-cols-2">
        {finding.impact && (
          <div className="bg-surface px-5 py-4">
            <p className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-[0.09em] text-ink-subtle">Why it matters</p>
            <p className="text-xs leading-relaxed text-ink-muted">{finding.impact}</p>
          </div>
        )}
        {finding.affectedFiles.length > 0 && (
          <div className="bg-surface px-5 py-4">
            <p className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-[0.09em] text-ink-subtle">Affected files</p>
            <ul className="space-y-1">
              {finding.affectedFiles.slice(0, 4).map((f) => (
                <li key={f} className="flex items-center gap-1.5">
                  <FileCode size={10} className="shrink-0 text-ink-subtle" />
                  <code className="truncate font-mono text-[0.7rem] text-ink-muted">{f}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ConfidenceRing({ score }: { score: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const color =
    score >= 8
      ? 'var(--color-state-severe)'
      : score >= 6
        ? 'var(--color-tone-secondary)'
        : score >= 4
          ? 'var(--color-tone-primary)'
          : 'var(--color-ink-subtle)';
  return (
    <div className="relative shrink-0 inline-flex flex-col items-center">
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#E5E7EB" strokeWidth="3.5" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={color} strokeWidth="3.5"
          strokeDasharray={`${(score / 10) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 22 22)" />
      </svg>
      <span className="absolute top-[14px] text-[0.68rem] font-bold" style={{ color }}>{score}/10</span>
      <p className="mt-0.5 text-[0.6rem] font-medium text-ink-subtle">Confidence</p>
    </div>
  );
}

// ─── ④ Code Location ─────────────────────────────────────────────────────────

function CodeLocationSection({ evidence }: { evidence: Evidence[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 1500); } catch { /**/ }
  };

  return (
    <div className="space-y-2.5">
      {evidence.map((item, idx) => {
        const isOpen = expanded === item.id;
        return (
          <div key={item.id} className="overflow-hidden rounded-xl border border-line">
            <button type="button" onClick={() => setExpanded(isOpen ? null : item.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-raised transition-colors">
              <span className="shrink-0 font-mono text-[0.6rem] font-bold text-ink-subtle">#{String(idx + 1).padStart(2, '0')}</span>
              <div className="min-w-0 flex-1">
                <code className="block truncate font-mono text-xs font-medium text-ink">
                  {item.file}{item.line !== null ? `:${item.line}` : ''}
                </code>
                <p className="mt-0.5 truncate text-[0.7rem] text-ink-muted">{item.relationship}</p>
              </div>
              <span className="shrink-0 rounded border border-line bg-surface-raised px-1.5 py-0.5 font-mono text-[0.6rem] uppercase text-ink-subtle">
                {item.kind.replace(/_/g, ' ')}
              </span>
              <ChevronRight size={13} className={cn('shrink-0 text-ink-subtle transition-transform', isOpen && 'rotate-90')} />
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ duration: 0.16 }} className="overflow-hidden border-t border-line">
                  <div className="relative bg-surface-raised px-4 py-3">
                    <pre className="overflow-x-auto rounded-lg border border-line bg-surface px-4 py-3 font-mono text-[0.72rem] leading-relaxed text-ink">
                      {item.snippet || '(no snippet)'}
                    </pre>
                    {item.snippet && (
                      <button type="button" onClick={() => void copy(item.id, item.snippet)}
                        className="absolute right-6 top-5 rounded-md border border-line bg-surface p-1.5 text-ink-muted hover:text-ink">
                        {copied === item.id ? <Check size={11} /> : <Copy size={11} />}
                      </button>
                    )}
                    <p className="mt-2 text-[0.65rem] text-ink-subtle">
                      Produced by <code className="font-mono">{item.producedBy}</code>
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

// ─── ⑤ Blast Radius ──────────────────────────────────────────────────────────

function BlastRadiusSection({ graph, evidence }: { graph: any; evidence: Evidence[] }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const affected = graph?.nodes.filter((n: any) => n.onAffectedPath).length ?? 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total components', value: graph?.nodes.length ?? 0 },
          { label: 'Affected', value: affected, red: affected > 0 },
          { label: 'Evidence items', value: evidence.length },
        ].map(({ label, value, red }) => (
          <div key={label} className="rounded-xl border border-line bg-surface-raised px-4 py-3 text-center">
            <p className={cn('text-2xl font-bold', red ? 'text-red-500' : value === 0 && label === 'Affected' ? 'text-emerald-500' : 'text-ink')}>{value}</p>
            <p className="mt-0.5 text-[0.7rem] text-ink-muted">{label}</p>
          </div>
        ))}
      </div>
      <div className="h-[380px] overflow-hidden rounded-xl border border-line">
        {/* BlastRadius prints the graph's own summary beneath the canvas, so
            repeating it here showed the same sentence twice. */}
        <BlastRadius graph={graph} selectedEvidenceFile={selectedFile} onSelectNode={setSelectedFile} />
      </div>
    </div>
  );
}

// ─── ⑥ Fix section (no approval buttons — moved to action bar) ────────────────

function FixSection({ finding, remediation, refinedPlan }: {
  finding: Finding | undefined; remediation: Remediation | null; refinedPlan: string | null;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  if (!finding) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-500" />
        <div>
          <p className="text-sm font-semibold text-emerald-800">No action required</p>
          <p className="mt-0.5 text-xs text-emerald-700">This change is safe. No sensitive data paths detected.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {/* Recommendation */}
      {finding.recommendation && (
        <div className="rounded-xl border border-line bg-surface-raised p-5">
          <p className="mb-2 text-[0.65rem] font-bold uppercase tracking-[0.09em] text-ink-subtle">Recommended action</p>
          <p className="text-sm leading-relaxed text-ink">{finding.recommendation}</p>
        </div>
      )}

      {/* Refined plan note */}
      {refinedPlan && (
        <div className="rounded-xl border border-tone-primary bg-accent-soft p-5">
          <p className="mb-2 text-[0.65rem] font-bold uppercase tracking-[0.09em] text-tone-primary">Amended plan</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{refinedPlan}</p>
        </div>
      )}

      {/* Remediation diff */}
      {remediation && (
        <div className="overflow-hidden rounded-xl border border-line">
          <button type="button" onClick={() => setDiffOpen(!diffOpen)}
            className="flex w-full items-center justify-between gap-2 px-5 py-3.5 hover:bg-surface-raised transition-colors">
            <div>
              <p className="text-sm font-semibold text-ink">{remediation.title}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{remediation.rationale}</p>
            </div>
            <ChevronDown size={14} className={cn('shrink-0 text-ink-subtle transition-transform', diffOpen && 'rotate-180')} />
          </button>
          <AnimatePresence initial={false}>
            {diffOpen && (
              <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden border-t border-line">
                <div className="px-5 py-4 space-y-3">
                  {remediation.expectedImpact && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5">
                      <p className="text-[0.65rem] font-bold uppercase tracking-wider text-emerald-700">Expected impact</p>
                      <p className="mt-0.5 text-xs text-emerald-800">{remediation.expectedImpact}</p>
                    </div>
                  )}
                  {remediation.diff && <DiffBlock diff={remediation.diff} />}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ─── Edit plan prompt box ─────────────────────────────────────────────────────

function EditPlanBox({ remediation, refinedPlan, prompt, busy, onPromptChange, onSubmit }: {
  remediation: Remediation | null; refinedPlan: string | null;
  prompt: string; busy: boolean;
  onPromptChange: (v: string) => void; onSubmit: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { textareaRef.current?.focus(); }, []);

  return (
    <div className="border-t border-line bg-surface-raised p-5">
      {/* Current plan preview */}
      <div className="mb-4 rounded-xl border border-line bg-surface p-4">
        <p className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-[0.09em] text-ink-subtle">Current plan</p>
        <p className="text-sm leading-relaxed text-ink">
          {refinedPlan ?? remediation?.rationale ?? 'No implementation plan available yet.'}
        </p>
        {remediation?.expectedImpact && !refinedPlan && (
          <p className="mt-2 text-xs text-ink-muted">{remediation.expectedImpact}</p>
        )}
      </div>

      {/* Prompt input */}
      <label htmlFor="edit-plan-prompt" className="mb-2 block text-xs font-semibold text-ink">
        Describe your changes to the implementation plan
      </label>
      <div className="flex gap-2.5">
        <textarea
          id="edit-plan-prompt"
          ref={textareaRef}
          rows={3}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(); }}
          placeholder="e.g. Also rotate the database password, update the CI/CD environment variable, and add a test to verify the secret is no longer hardcoded…"
          className="flex-1 resize-none rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink placeholder-ink-subtle focus:border-tone-primary focus:outline-none focus:ring-2 focus:ring-accent-soft"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !prompt.trim()}
          className={cn(
            'flex items-center gap-2 self-end rounded-xl px-4 py-3 text-sm font-semibold transition-all',
            busy || !prompt.trim()
              ? 'cursor-not-allowed bg-surface-raised text-ink-subtle'
              : 'bg-tone-primary text-white hover:opacity-90',
          )}
        >
          {busy ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
          {busy ? 'Refining…' : 'Refine'}
        </button>
      </div>
      <p className="mt-2 text-[0.68rem] text-ink-subtle">⌘↵ to submit</p>
    </div>
  );
}

// ─── Live Terminal + PR Result ────────────────────────────────────────────────

// ─── Remediation terminal, driven by real backend state ─────────────────────

/**
 * Lifecycle stages the remediation passes through.
 *
 * The labels name the status; the *detail* lines come from the backend's own
 * activity events, never from copy written here. A stage with no observed
 * status has not happened and is drawn as pending rather than narrated.
 */
const REMEDIATION_STAGES: Array<{ status: string; label: string }> = [
  { status: 'AWAITING_APPROVAL', label: 'Approval received' },
  { status: 'REMEDIATING', label: 'Applying fix and opening pull request' },
  { status: 'POST_FIX_VERIFY', label: 'Verifying the fix' },
  { status: 'RESOLVED', label: 'Resolved' },
];

const TERMINAL_STATUSES = ['RESOLVED', 'FAILED', 'REJECTED'];

function LiveTerminalPanel({
  status,
  action,
  activities,
  error,
  remediation,
  onRefresh,
  onClose,
}: {
  status: string | null;
  action: Action | null;
  activities: ActivityItem[];
  error: string | null;
  remediation?: Remediation | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const isTerminal = TERMINAL_STATUSES.includes(status ?? '');
  const isFailed = status === 'FAILED' || status === 'REJECTED';
  const prUrl = action?.resultUrl ?? null;

  // Polling lives in useInvestigation, which already refreshes this record
  // every couple of seconds while it is running and backs off when the API is
  // failing. A second timer here would double every request for no benefit.

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activities.length, status]);

  const reachedIndex = REMEDIATION_STAGES.findIndex((s) => s.status === status);

  return (
    <div className="border-t border-line">
      <div className="flex items-center justify-between bg-[#0D1117] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#FF5F57]" />
            <span className="h-3 w-3 rounded-full bg-[#FEBC2E]" />
            <span className="h-3 w-3 rounded-full bg-[#28C840]" />
          </div>
          <span className="ml-2 font-mono text-[0.65rem] text-gray-400">
            netra — remediation pipeline
          </span>
          {isFailed ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-red-900/60 px-2.5 py-0.5 text-[0.6rem] font-bold text-red-400">
              <X size={10} /> FAILED
            </span>
          ) : isTerminal ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-900/60 px-2.5 py-0.5 text-[0.6rem] font-bold text-emerald-400">
              <Check size={10} strokeWidth={3} /> DONE
            </span>
          ) : (
            <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-900/60 px-2.5 py-0.5 text-[0.6rem] font-bold text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> LIVE
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-gray-300"
          aria-label="Close terminal"
        >
          <X size={14} />
        </button>
      </div>

      <div className="max-h-[22rem] overflow-y-auto bg-[#0D1117] px-5 py-4 font-mono text-[0.78rem] leading-relaxed">
        {error ? (
          <div className="space-y-1">
            <p className="text-red-400">✗ Approval could not be submitted</p>
            <p className="pl-4 text-gray-400">{error}</p>
            <p className="pl-4 text-gray-500">
              Nothing was changed. You can retry once the cause is resolved.
            </p>
          </div>
        ) : null}

        {/* Stages, marked from the status the backend actually reports. */}
        <ol className="space-y-1.5">
          {REMEDIATION_STAGES.map((stage, index) => {
            const done = reachedIndex > index || status === 'RESOLVED';
            const current = reachedIndex === index && !isTerminal;
            const pending = reachedIndex < index && !done;
            return (
              <li key={stage.status} className="flex items-baseline gap-2">
                <span
                  className={
                    done
                      ? 'text-emerald-400'
                      : current
                        ? 'text-amber-300'
                        : 'text-gray-600'
                  }
                >
                  {done ? '✓' : current ? '→' : '·'}
                </span>
                <span className={pending ? 'text-gray-600' : 'text-gray-200'}>{stage.label}</span>
              </li>
            );
          })}
        </ol>

        {/* Real backend activity. Nothing is written here that the pipeline
            did not report. */}
        {activities.length > 0 ? (
          <div className="mt-4 space-y-1 border-t border-white/10 pt-3">
            {/* Each line fades in as the backend reports it. The motion marks
                arrival — it is never used to pace output the pipeline has
                already produced. */}
            <AnimatePresence initial={false}>
              {activities.map((activity) => (
                <motion.p
                  key={activity.id}
                  layout
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                  className="flex items-baseline gap-2"
                >
                  <span
                    className={
                      activity.state === 'COMPLETED'
                        ? 'text-emerald-400'
                        : activity.state === 'FAILED'
                          ? 'text-red-400'
                          : 'text-amber-300'
                    }
                  >
                    {activity.state === 'COMPLETED' ? '✓' : activity.state === 'FAILED' ? '✗' : '→'}
                  </span>
                  <span className="text-gray-300">{activity.message}</span>
                </motion.p>
              ))}
            </AnimatePresence>
          </div>
        ) : null}

        {!isTerminal && !error ? (
          <p className="mt-4 flex items-center gap-2 text-gray-500" role="status" aria-live="polite">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
            {phaseLabel(status)}
          </p>
        ) : null}

        {prUrl ? (
          <p className="mt-4 border-t border-white/10 pt-3 text-emerald-400">
            ✓ Pull request created
          </p>
        ) : null}

        <div ref={bottomRef} />
      </div>

      {prUrl && status === 'RESOLVED' && (
        <PRResultPanel prUrl={prUrl} remediation={remediation ?? null} />
      )}
    </div>
  );
}


// ─── PR Result panel ─────────────────────────────────────────────────────────

function PRResultPanel({ prUrl, remediation }: { prUrl: string; remediation: Remediation | null }) {
  const [diffOpen, setDiffOpen] = useState(true);

  return (
    <div className="border-t border-line bg-surface">
      {/* PR banner */}
      <div className="flex items-center justify-between gap-4 border-b border-emerald-200 bg-emerald-50 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
            <GitPullRequest size={20} className="text-emerald-600" />
          </div>
          <div>
            <p className="text-sm font-bold text-emerald-800">Pull request created successfully</p>
            <p className="text-xs text-emerald-700">
              The implementation has been committed and a PR has been raised for review.
            </p>
          </div>
        </div>
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition-colors"
        >
          View PR <ArrowUpRight size={14} />
        </a>
      </div>

      {/* Code diff */}
      {remediation?.diff && (
        <div className="p-5">
          <button
            type="button"
            onClick={() => setDiffOpen(!diffOpen)}
            className="mb-3 flex w-full items-center justify-between text-sm font-semibold text-ink hover:text-tone-primary transition-colors"
          >
            <span className="flex items-center gap-2">
              <Code2 size={14} /> Code changes applied
              {remediation.affectedFiles.length > 0 && (
                <span className="rounded-full border border-line bg-surface-raised px-2 py-0.5 text-[0.65rem] font-semibold text-ink-muted">
                  {remediation.affectedFiles.length} file{remediation.affectedFiles.length !== 1 ? 's' : ''}
                </span>
              )}
            </span>
            <ChevronDown size={14} className={cn('text-ink-subtle transition-transform', diffOpen && 'rotate-180')} />
          </button>
          <AnimatePresence initial={false}>
            {diffOpen && (
              <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
                <DiffBlock diff={remediation.diff} />
                {remediation.affectedFiles.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-ink-subtle">Modified files</p>
                    <ul className="space-y-1">
                      {remediation.affectedFiles.map((f) => (
                        <li key={f} className="flex items-center gap-1.5">
                          <FileCode size={11} className="shrink-0 text-ink-subtle" />
                          <code className="font-mono text-xs text-ink-muted">{f}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ─── Diff block ───────────────────────────────────────────────────────────────

function DiffBlock({ diff }: { diff: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="border-b border-line bg-[#0F1117] px-3 py-1.5">
        <span className="font-mono text-[0.65rem] font-bold text-gray-400">IMPLEMENTATION DIFF</span>
      </div>
      <pre className="max-h-80 overflow-auto bg-[#0F1117] px-4 py-3 font-mono text-[0.72rem] leading-relaxed">
        {diff.split('\n').map((line, i) => (
          <span key={i} className={cn('block',
            line.startsWith('+') && !line.startsWith('+++') ? 'bg-emerald-950 text-emerald-300' :
            line.startsWith('-') && !line.startsWith('---') ? 'bg-red-950 text-red-300' :
            line.startsWith('@@') ? 'text-ink-muted' : 'text-ink-subtle',
          )}>
            {line}
          </span>
        ))}
      </pre>
    </div>
  );
}

// ─── Lifecycle stepper ────────────────────────────────────────────────────────

const STEPS = [
  { label: 'Analyze',     statuses: ['RECEIVED', 'CREATED'] },
  { label: 'Investigate', statuses: ['PREPARING', 'INVESTIGATING', 'EVIDENCE_COLLECTION'] },
  { label: 'Verify',      statuses: ['VERIFYING', 'IMPACT_ANALYSIS', 'RECOMMENDATION'] },
  { label: 'Resolved',    statuses: ['AWAITING_APPROVAL', 'REMEDIATING', 'POST_FIX_VERIFY', 'RESOLVED'] },
];

function LifecycleStepper({ status }: { status: string | null }) {
  if (!status) return null;
  const isFailed = status === 'FAILED' || status === 'REJECTED';
  const activeIdx = STEPS.findIndex((s) => s.statuses.includes(status));
  return (
    <ol className="flex items-center" role="list">
      {STEPS.map((step, idx) => {
        const done = !isFailed && (activeIdx > idx || status === 'RESOLVED');
        const active = !isFailed && activeIdx === idx;
        const isLast = idx === STEPS.length - 1;
        return (
          <li key={step.label} className="flex flex-1 items-center" role="listitem">
            <div className="flex flex-1 flex-col items-center gap-1">
              <div className="relative flex w-full items-center justify-center">
                {idx > 0 && <div className={cn('absolute right-1/2 top-[14px] h-0.5 w-1/2 -translate-y-1/2', (done || active) ? 'bg-emerald-400' : 'bg-line')} />}
                {!isLast && <div className={cn('absolute left-1/2 top-[14px] h-0.5 w-1/2 -translate-y-1/2', done ? 'bg-emerald-400' : 'bg-line')} />}
                <div className={cn('relative z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 transition-colors',
                  done ? 'border-emerald-400 bg-emerald-400 text-white' :
                  active ? 'border-emerald-400 bg-white text-emerald-500' :
                  'border-line bg-white text-ink-subtle')}>
                  {active && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-300 opacity-30" />}
                  {done ? <Check size={13} strokeWidth={3} /> : active ? <span className="h-2 w-2 rounded-full bg-emerald-400" /> : null}
                </div>
              </div>
              <span className={cn('text-center text-[0.65rem] font-medium',
                done ? 'text-emerald-600' : active ? 'font-semibold text-emerald-600' : 'text-ink-subtle')}>
                {step.label}
              </span>
            </div>
          </li>
        );
      })}
      {isFailed && (
        <li className="ml-3 flex items-center gap-1">
          <X size={12} className="text-red-500" />
          <span className="text-xs font-semibold text-red-500">{status === 'FAILED' ? 'Failed' : 'Rejected'}</span>
        </li>
      )}
    </ol>
  );
}

// ─── Status pill ──────────────────────────────────────────────────────────────

function StatusPill({ status, elapsed }: { status: string; elapsed: string | null }) {
  const isResolved = status === 'RESOLVED';
  const isFailed = status === 'FAILED';
  const isWaiting = status === 'AWAITING_APPROVAL';
  const cls = isResolved ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
    isFailed ? 'bg-red-50 border-red-200 text-red-700' :
    isWaiting ? 'bg-amber-50 border-amber-200 text-amber-700' :
    'bg-accent-soft border-accent-border text-[#9A3412]';
  return (
    // Keyed on the status so the pill re-enters whenever the backend moves on,
    // which is the one moment this element has something new to say.
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={status}
        initial={{ opacity: 0, y: -3 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className={cn('flex items-start gap-2 rounded-xl border px-3.5 py-2', cls)}
      >
        {isResolved ? (
          // A single settle on arrival, not a loop: the check marks the moment
          // the investigation closed, then stays still.
          <motion.span
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="mt-0.5"
          >
            <Check size={13} strokeWidth={3} />
          </motion.span>
        ) : isFailed ? (
          <X size={13} className="mt-0.5" />
        ) : (
          <span className="mt-1.5 h-2 w-2 animate-pulse rounded-full bg-accent" />
        )}
        <div>
          <p className="text-sm font-semibold capitalize leading-tight">{status.replace(/_/g, ' ').toLowerCase()}</p>
          {elapsed && <p className="text-[0.65rem] opacity-70">Completed in {elapsed}</p>}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Page skeleton ────────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <LoadingState label="Loading investigation…">
        <Skeleton className="h-10 w-64" />
      </LoadingState>
      <Skeleton className="h-32 w-full rounded-panel" />
      <Skeleton className="h-40 w-full rounded-panel" />
      <Skeleton className="h-64 w-full rounded-panel" />
    </div>
  );
}

/**
 * Statuses that mean the investigation has not finished looking yet.
 *
 * The distinction matters for every empty region on this page: "nothing was
 * found" and "nothing has been established yet" look identical if both render
 * a dash, and only one of them is a result.
 */
const ANALYSIS_IN_PROGRESS = [
  'RECEIVED',
  'CREATED',
  'PREPARING',
  'INVESTIGATING',
  'EVIDENCE_COLLECTION',
  'VERIFYING',
  'IMPACT_ANALYSIS',
  'RECOMMENDATION',
];

/** Whether the backend is still working, so placeholders beat conclusions. */
export function analysisRunning(status: string | null): boolean {
  return status !== null && ANALYSIS_IN_PROGRESS.includes(status);
}

/** What the backend is doing right now, in the reader's language. */
export function phaseLabel(status: string | null): string {
  switch (status) {
    case 'RECEIVED':
    case 'CREATED':
      return 'Starting analysis…';
    case 'PREPARING':
      return 'Preparing the repository…';
    case 'INVESTIGATING':
      return 'Investigating the change…';
    case 'EVIDENCE_COLLECTION':
      return 'Collecting evidence…';
    case 'VERIFYING':
      return 'Verifying findings…';
    case 'IMPACT_ANALYSIS':
      return 'Mapping affected components…';
    case 'RECOMMENDATION':
      return 'Preparing remediation…';
    case 'REMEDIATING':
      return 'Applying the fix and opening a pull request…';
    case 'POST_FIX_VERIFY':
      return 'Verifying the remediation…';
    default:
      return 'Working…';
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

/**
 * The causal chain: how a value travels from where it enters to where it escapes.
 *
 * Evidence kinds map onto the three stages of the flow, so the reader sees the
 * argument rather than an undifferentiated list of file references. Only stages
 * that have evidence are drawn.
 */
export function EvidenceChainSection({ evidence }: { evidence: Evidence[] }) {
  const stages = [
    {
      key: 'source',
      label: 'Source',
      caption: 'Where the value enters the change',
      items: evidence.filter((e) => e.kind === 'DIFF_HUNK' || e.kind === 'GIT_HISTORY'),
    },
    {
      key: 'transformation',
      label: 'Transformation',
      caption: 'What moves or rewrites it',
      items: evidence.filter((e) => e.kind === 'CONFIG_ENTRY' || e.kind === 'STATIC_CHECK'),
    },
    {
      key: 'sink',
      label: 'Sink',
      caption: 'Where it can be observed',
      items: evidence.filter(
        (e) => e.kind === 'REFERENCE_PATH' || e.kind === 'SOURCE_REFERENCE',
      ),
    },
  ].filter((stage) => stage.items.length > 0);

  if (stages.length === 0) {
    return (
      <p className="text-[0.875rem] text-ink-muted">
        No causal chain was recorded for this investigation.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-ink-muted">
        {stages.map((stage, index) => (
          <span key={stage.key} className="flex items-center gap-2">
            <span className="font-semibold text-ink">{stage.label}</span>
            {index < stages.length - 1 ? (
              <ArrowRight size={13} className="text-ink-subtle" />
            ) : null}
          </span>
        ))}
      </div>

      <ol className="space-y-3">
        {stages.map((stage) => (
          <li key={stage.key} className="rounded-panel border border-line bg-surface-raised p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[0.875rem] font-semibold text-ink">{stage.label}</p>
              <p className="text-[0.75rem] text-ink-subtle">{stage.caption}</p>
            </div>
            <ul className="mt-3 space-y-2.5">
              {stage.items.map((item) => (
                <li key={item.id} className="border-l-2 border-accent-border pl-3">
                  <p className="mono text-ink">
                    {item.file}
                    {item.line !== null ? `:${item.line}` : ''}
                  </p>
                  <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-ink-muted">
                    {item.relationship}
                  </p>
                  {item.snippet ? (
                    <pre className="mono mt-2 overflow-x-auto rounded-control border border-line bg-surface px-3 py-2 text-[0.75rem] text-ink">
                      {item.snippet}
                    </pre>
                  ) : null}
                  <p className="mt-1.5 text-[0.75rem] text-ink-subtle">
                    Established by <Mono>{item.producedBy}</Mono>
                  </p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What deterministic code checked, before and after any fix.
 *
 * The phase is the point: a `REFUTED` post-fix result is what earns the
 * resolved state, and showing both side by side is what makes that legible.
 */
export function VerificationSection({ verifications }: { verifications: VerificationResult[] }) {
  const ordered = [...verifications].sort((a, b) => (a.phase === 'PRE_FIX' ? -1 : 1));

  return (
    <div className="space-y-3">
      {ordered.map((result) => {
        const isRefuted = result.status === 'REFUTED';
        const isVerified = result.status === 'VERIFIED';
        return (
          <div
            key={result.id}
            className="rounded-panel border border-line bg-surface-raised p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="field-label">
                {result.phase === 'PRE_FIX' ? 'Before the fix' : 'After the fix'}
              </p>
              <span
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide',
                  isVerified &&
                    'border-[#FECACA] bg-state-severe-bg text-state-severe',
                  isRefuted &&
                    'border-[#BBD98F] bg-state-resolved-bg text-state-resolved',
                  !isVerified &&
                    !isRefuted &&
                    'border-line bg-surface text-ink-muted',
                )}
              >
                {isRefuted ? 'No longer present' : result.status}
              </span>
            </div>
            <p className="mt-2 text-[0.9375rem] font-medium text-ink">{result.claim}</p>
            <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-muted">
              {result.detail}
            </p>
            <p className="mt-2.5 text-[0.75rem] text-ink-subtle">
              Checked by <Mono>{result.verifier}</Mono> in {result.durationMs}ms
            </p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * What the investigation did, in order.
 *
 * These are summaries the pipeline published, each tied to real work. The
 * model's private reasoning is never among them.
 */
export function ActivitySection({ activities }: { activities: ActivityItem[] }) {
  return (
    <ol className="space-y-0">
      {activities.map((activity, index) => (
        <li key={activity.id} className="flex gap-3 py-2">
          <div className="flex flex-col items-center">
            <span
              className={cn(
                'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                activity.state === 'COMPLETED' && 'bg-state-resolved',
                activity.state === 'FAILED' && 'bg-state-review',
                activity.state === 'STARTED' && 'bg-accent',
              )}
            />
            {index < activities.length - 1 ? (
              <span className="mt-1 w-px flex-1 bg-line" />
            ) : null}
          </div>
          <p
            className={cn(
              'text-[0.875rem] leading-relaxed',
              activity.state === 'FAILED' ? 'text-ink-muted' : 'text-ink',
            )}
          >
            {activity.message}
          </p>
        </li>
      ))}
    </ol>
  );
}
