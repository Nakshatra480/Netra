import { STATUS_LABELS, type InvestigationStatus, type Severity } from '@netra/domain';
import { cn } from '@/lib/cn';

/**
 * How Netra says what state something is in.
 *
 * The mapping from state to colour lives here alone, so a status means the same
 * thing on every screen. Not everything worrying is red: red is reserved for a
 * severity that has been proven.
 */

type Tone = 'idle' | 'active' | 'review' | 'severe' | 'resolved';

const TONE_CLASS: Record<Tone, string> = {
  idle: 'text-[--color-state-idle] bg-[color-mix(in_oklch,var(--color-state-idle)_14%,transparent)] border-[color-mix(in_oklch,var(--color-state-idle)_30%,transparent)]',
  active:
    'text-[--color-state-active] bg-[color-mix(in_oklch,var(--color-state-active)_14%,transparent)] border-[color-mix(in_oklch,var(--color-state-active)_35%,transparent)]',
  review:
    'text-[--color-state-review] bg-[color-mix(in_oklch,var(--color-state-review)_14%,transparent)] border-[color-mix(in_oklch,var(--color-state-review)_35%,transparent)]',
  severe:
    'text-[--color-state-severe] bg-[color-mix(in_oklch,var(--color-state-severe)_14%,transparent)] border-[color-mix(in_oklch,var(--color-state-severe)_35%,transparent)]',
  resolved:
    'text-[--color-state-resolved] bg-[color-mix(in_oklch,var(--color-state-resolved)_14%,transparent)] border-[color-mix(in_oklch,var(--color-state-resolved)_35%,transparent)]',
};

export const STATUS_TONE: Record<InvestigationStatus, Tone> = {
  RECEIVED: 'idle',
  CREATED: 'idle',
  PREPARING: 'active',
  INVESTIGATING: 'active',
  EVIDENCE_COLLECTION: 'active',
  VERIFYING: 'active',
  IMPACT_ANALYSIS: 'active',
  RECOMMENDATION: 'active',
  AWAITING_APPROVAL: 'review',
  REMEDIATING: 'active',
  POST_FIX_VERIFY: 'active',
  RESOLVED: 'resolved',
  REJECTED: 'idle',
  FAILED: 'severe',
};

const SEVERITY_TONE: Record<Severity, Tone> = {
  INFO: 'idle',
  LOW: 'idle',
  MEDIUM: 'review',
  HIGH: 'severe',
  CRITICAL: 'severe',
};

const IN_PROGRESS: InvestigationStatus[] = [
  'PREPARING',
  'INVESTIGATING',
  'EVIDENCE_COLLECTION',
  'VERIFYING',
  'IMPACT_ANALYSIS',
  'RECOMMENDATION',
  'REMEDIATING',
  'POST_FIX_VERIFY',
];

export function Badge({
  tone,
  children,
  className,
  pulse = false,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string | undefined;
  pulse?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.06em]',
        TONE_CLASS[tone],
        className,
      )}
    >
      {pulse ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: InvestigationStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} pulse={IN_PROGRESS.includes(status)}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{severity}</Badge>;
}

/**
 * Whether a claim has been checked by deterministic code.
 *
 * This distinction is the product's core trust signal, so it is always stated
 * explicitly rather than implied by styling alone.
 */
export function VerificationBadge({
  status,
  className,
}: {
  status: 'VERIFIED' | 'UNVERIFIED' | 'REFUTED' | 'INCONCLUSIVE';
  className?: string;
}) {
  const label = {
    VERIFIED: 'Verified by deterministic check',
    UNVERIFIED: 'Model hypothesis — not verified',
    REFUTED: 'No longer present',
    INCONCLUSIVE: 'Inconclusive',
  }[status];

  const tone: Tone = {
    VERIFIED: 'severe' as const,
    UNVERIFIED: 'review' as const,
    REFUTED: 'resolved' as const,
    INCONCLUSIVE: 'idle' as const,
  }[status];

  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}

export function isInProgress(status: InvestigationStatus | null): boolean {
  return status !== null && IN_PROGRESS.includes(status);
}
