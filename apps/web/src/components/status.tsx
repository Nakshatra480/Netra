import { Check, Clock, AlertTriangle, X, Loader2 } from 'lucide-react';
import { STATUS_LABELS, type InvestigationStatus, type Severity } from '@netra/domain';
import { cn } from '@/lib/cn';

/**
 * Status badges — light theme.
 * Color carries meaning: orange = attention, green = resolved, red = critical.
 */

type Tone = 'idle' | 'active' | 'review' | 'severe' | 'resolved';

const TONE_CLASS: Record<Tone, string> = {
  idle:     'text-ink-muted bg-surface-raised border-line',
  active:   'text-[#9A3412] bg-accent-soft border-accent-border',
  review:   'text-amber-600 bg-amber-50 border-amber-200',
  severe:   'text-red-600 bg-red-50 border-red-200',
  resolved: 'text-emerald-600 bg-tone-success border-emerald-200',
};

export const STATUS_TONE: Record<InvestigationStatus, Tone> = {
  RECEIVED:           'idle',
  CREATED:            'idle',
  PREPARING:          'active',
  INVESTIGATING:      'active',
  EVIDENCE_COLLECTION:'active',
  VERIFYING:          'active',
  IMPACT_ANALYSIS:    'active',
  RECOMMENDATION:     'active',
  AWAITING_APPROVAL:  'review',
  REMEDIATING:        'active',
  POST_FIX_VERIFY:    'active',
  RESOLVED:           'resolved',
  REJECTED:           'idle',
  FAILED:             'severe',
};

const SEVERITY_TONE: Record<Severity, Tone> = {
  INFO:     'idle',
  LOW:      'idle',
  MEDIUM:   'review',
  HIGH:     'severe',
  CRITICAL: 'severe',
};

const IN_PROGRESS: InvestigationStatus[] = [
  'PREPARING', 'INVESTIGATING', 'EVIDENCE_COLLECTION', 'VERIFYING',
  'IMPACT_ANALYSIS', 'RECOMMENDATION', 'REMEDIATING', 'POST_FIX_VERIFY',
];

export function Badge({
  tone,
  children,
  className,
  pulse = false,
  icon,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string | undefined;
  pulse?: boolean | undefined;
  icon?: React.ReactNode | undefined;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.05em]',
        TONE_CLASS[tone],
        className,
      )}
    >
      {pulse ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      ) : icon ? (
        <span className="flex h-3 w-3 items-center justify-center">{icon}</span>
      ) : null}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: InvestigationStatus }) {
  const tone = STATUS_TONE[status];
  const isActive = IN_PROGRESS.includes(status);

  // Choose a small icon per tone
  const icon =
    tone === 'resolved' ? <Check size={10} strokeWidth={3} /> :
    tone === 'severe'   ? <AlertTriangle size={10} strokeWidth={2.5} /> :
    tone === 'review'   ? <Clock size={10} strokeWidth={2.5} /> : null;

  return (
    <Badge tone={tone} pulse={isActive} icon={!isActive ? icon : undefined}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{severity}</Badge>;
}

/**
 * Deterministic verification label.
 * This is the product's core trust signal.
 */
export function VerificationBadge({
  status,
  className,
}: {
  status: 'VERIFIED' | 'UNVERIFIED' | 'REFUTED' | 'INCONCLUSIVE';
  className?: string | undefined;
}) {
  /*
   * Spelled out deliberately. A badge reading only "Verified" lets a reader
   * assume the model verified it, which is the one inference this product must
   * never invite: deterministic code decides, and the label says so.
   */
  const label = {
    VERIFIED: 'Verified by deterministic check',
    UNVERIFIED: 'Model hypothesis — not verified',
    REFUTED: 'No longer present',
    INCONCLUSIVE: 'Inconclusive',
  }[status];

  const tone: Tone = {
    VERIFIED:     'severe' as const,
    UNVERIFIED:   'review' as const,
    REFUTED:      'resolved' as const,
    INCONCLUSIVE: 'idle' as const,
  }[status];

  const icon =
    status === 'VERIFIED' ? <AlertTriangle size={10} strokeWidth={2.5} /> :
    status === 'REFUTED'  ? <Check size={10} strokeWidth={3} /> : null;

  return (
    <Badge tone={tone} icon={icon ?? undefined} className={className ?? undefined}>
      {label}
    </Badge>
  );
}

export function isInProgress(status: InvestigationStatus | null): boolean {
  return status !== null && IN_PROGRESS.includes(status);
}
