import type { InvestigationStatus } from '@netra/domain';
import { AlertTriangle, CheckCircle2, GitMerge, LoaderCircle, ScanSearch, ShieldCheck, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * A horizontal timeline of the investigation lifecycle.
 *
 * The seven steps compress the thirteen internal states into stages a
 * reviewer can reason about. Netra's trust model is visible here: the
 * "human decision" step is visually distinct from the automated stages
 * because only a person can authorize an action.
 */

interface Step {
  label: string;
  icon: typeof CheckCircle2;
  statuses: InvestigationStatus[];
}

const STEPS: Step[] = [
  {
    label: 'Detected',
    icon: Zap,
    statuses: ['RECEIVED', 'CREATED'],
  },
  {
    label: 'Investigating',
    icon: ScanSearch,
    statuses: ['PREPARING', 'INVESTIGATING', 'EVIDENCE_COLLECTION'],
  },
  {
    label: 'Verifying',
    icon: ShieldCheck,
    statuses: ['VERIFYING', 'IMPACT_ANALYSIS', 'RECOMMENDATION'],
  },
  {
    label: 'Human decision',
    icon: GitMerge,
    statuses: ['AWAITING_APPROVAL'],
  },
  {
    label: 'Remediating',
    icon: GitMerge,
    statuses: ['REMEDIATING', 'POST_FIX_VERIFY'],
  },
  {
    label: 'Resolved',
    icon: CheckCircle2,
    statuses: ['RESOLVED'],
  },
];

type StepState = 'done' | 'active' | 'pending';

function resolveStepState(step: Step, status: InvestigationStatus): StepState {
  // Find the first step that contains this status
  const activeStepIndex = STEPS.findIndex((s) => s.statuses.includes(status));
  const thisStepIndex = STEPS.indexOf(step);
  if (status === 'RESOLVED') return step.statuses.includes('RESOLVED') ? 'done' : 'done';
  if (activeStepIndex === -1) return 'pending';
  if (thisStepIndex < activeStepIndex) return 'done';
  if (thisStepIndex === activeStepIndex) return 'active';
  return 'pending';
}

export function LifecycleTimeline({
  status,
  className,
}: {
  status: InvestigationStatus | null;
  className?: string;
}) {
  if (!status) return null;

  const isFailed = status === 'FAILED';
  const isRejected = status === 'REJECTED';
  const isTerminalBad = isFailed || isRejected;

  return (
    <div
      className={cn('flex items-start gap-0', className)}
      role="list"
      aria-label="Investigation lifecycle"
    >
      {STEPS.map((step, index) => {
        const Icon = step.icon;
        const stepState = resolveStepState(step, status);
        const isLast = index === STEPS.length - 1;
        const isHumanDecision = step.label === 'Human decision';

        return (
          <div key={step.label} className="flex flex-1 items-start" role="listitem">
            <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              {/* Node */}
              <div className="relative flex items-center justify-center">
                {/* Connecting line left */}
                {index > 0 && (
                  <div
                    className={cn(
                      'absolute right-1/2 top-[11px] h-px w-[calc(50%+24px)] -translate-y-1/2',
                      stepState === 'done' || stepState === 'active'
                        ? 'bg-[--color-state-active] opacity-40'
                        : 'bg-[--color-line]',
                    )}
                    aria-hidden
                  />
                )}
                {/* Connecting line right */}
                {!isLast && (
                  <div
                    className={cn(
                      'absolute left-1/2 top-[11px] h-px w-[calc(50%+24px)] -translate-y-1/2',
                      stepState === 'done'
                        ? 'bg-[--color-state-active] opacity-40'
                        : 'bg-[--color-line]',
                    )}
                    aria-hidden
                  />
                )}

                {/* Icon node */}
                <div
                  className={cn(
                    'relative z-10 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border transition-colors duration-300',
                    stepState === 'done' &&
                      'border-[--color-state-resolved] bg-[color-mix(in_oklch,var(--color-state-resolved)_18%,transparent)] text-[--color-state-resolved]',
                    stepState === 'active' && !isTerminalBad &&
                      'border-[--color-state-active] bg-[color-mix(in_oklch,var(--color-state-active)_15%,transparent)] text-[--color-state-active]',
                    stepState === 'active' && isTerminalBad &&
                      'border-[--color-state-severe] bg-[color-mix(in_oklch,var(--color-state-severe)_15%,transparent)] text-[--color-state-severe]',
                    stepState === 'pending' &&
                      'border-[--color-line] text-[--color-ink-subtle]',
                    isHumanDecision && stepState === 'active' && !isTerminalBad &&
                      'border-[--color-state-review] bg-[color-mix(in_oklch,var(--color-state-review)_15%,transparent)] text-[--color-state-review]',
                    stepState === 'active' &&
                      !isTerminalBad &&
                      'timeline-node-active',
                  )}
                >
                  {isTerminalBad && stepState === 'active' ? (
                    <AlertTriangle size={11} aria-hidden />
                  ) : stepState === 'done' ? (
                    <CheckCircle2 size={11} aria-hidden />
                  ) : stepState === 'active' ? (
                    <LoaderCircle size={11} className="animate-spin" aria-hidden />
                  ) : (
                    <Icon size={11} aria-hidden />
                  )}

                  {/* Ping on active non-terminal */}
                  {stepState === 'active' && !isTerminalBad && (
                    <span
                      className="absolute inset-0 animate-ping rounded-full bg-current opacity-20"
                      aria-hidden
                    />
                  )}
                </div>
              </div>

              {/* Label */}
              <span
                className={cn(
                  'px-1 text-center text-[0.6rem] leading-tight tracking-wide transition-colors',
                  stepState === 'done' && 'text-[--color-ink-muted]',
                  stepState === 'active' && !isTerminalBad && !isHumanDecision && 'font-semibold text-[--color-state-active]',
                  stepState === 'active' && isHumanDecision && !isTerminalBad && 'font-semibold text-[--color-state-review]',
                  stepState === 'active' && isTerminalBad && 'font-semibold text-[--color-state-severe]',
                  stepState === 'pending' && 'text-[--color-ink-subtle]',
                )}
              >
                {isTerminalBad && stepState === 'active'
                  ? isFailed
                    ? 'Failed'
                    : 'Rejected'
                  : step.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
