import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/cn';

/**
 * The primitives every screen is built from.
 *
 * Keeping them here is what stops each page inventing its own spacing, radius
 * and focus behaviour. Surfaces are solid: a hairline border and a shadow you
 * have to look for, never glass or blur.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'approve';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-ink text-white hover:bg-[#1F2937] shadow-card font-semibold',
  secondary:
    'bg-white text-ink border border-line hover:border-line-strong hover:bg-surface-raised font-medium',
  ghost: 'text-ink-muted hover:text-ink hover:bg-surface-raised',
  danger:
    'bg-white text-state-severe border border-[#FECACA] hover:bg-state-severe-bg font-medium',
  approve:
    'bg-accent text-[#7C2D12] hover:brightness-[0.97] shadow-card font-semibold',
};

const BUTTON_SIZES = {
  sm: 'px-2.5 py-1.5 text-[0.8125rem] gap-1.5',
  md: 'px-3.5 py-2 text-[0.875rem] gap-2',
  lg: 'px-5 py-2.5 text-[0.9375rem] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-control',
        'transition-[background-color,border-color,color,filter] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-45',
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
});

/** A solid surface. The only card treatment in the product. */
export function Panel({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn('panel', className)} {...props}>
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  subtitle,
  actions,
  icon,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode | undefined;
  icon?: ReactNode | undefined;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? <span className="text-ink-subtle">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="truncate text-[0.9375rem] font-semibold text-ink">{title}</h2>
          {subtitle ? (
            <p className="truncate text-[0.8125rem] text-ink-muted">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * A page heading block: where am I, and what is this page for.
 *
 * Every screen opens with one, so the answer to "where am I" never depends on
 * reading the navigation.
 */
export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
  serif = false,
}: {
  eyebrow?: string | undefined;
  title: string;
  description?: string | undefined;
  actions?: ReactNode | undefined;
  serif?: boolean | undefined;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 max-w-2xl">
        {eyebrow ? <p className="field-label mb-2">{eyebrow}</p> : null}
        <h1
          className={cn(
            'text-ink',
            serif
              ? 'display text-[2rem] sm:text-display'
              : 'text-[1.625rem] font-bold tracking-tight sm:text-[2rem]',
          )}
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A titled group. Uses a rule and spacing rather than another nested card. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-2.5">
        <div>
          <h2 className="text-[1.0625rem] font-semibold text-ink">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-[0.8125rem] text-ink-muted">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Technical value: a path, a commit, an identifier. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('mono', className)}>{children}</span>;
}

/** A label above a value. The workhorse of the report layout. */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="field-label">{label}</p>
      <div className="mt-1 truncate text-[0.875rem] text-ink">{children}</div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded-control bg-surface-sunken', className)}
      aria-hidden="true"
    />
  );
}

/**
 * Nothing here yet — and why.
 *
 * An empty state that only says "no data" makes the reader wonder whether
 * something is broken, so each one names the next action.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode | undefined;
  title: string;
  description: string;
  action?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-14 text-center', className)}>
      {icon ? (
        <div className="grid h-10 w-10 place-items-center rounded-full bg-surface-sunken text-ink-subtle">
          {icon}
        </div>
      ) : null}
      <div className="max-w-sm">
        <p className="text-[0.9375rem] font-semibold text-ink">{title}</p>
        <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-muted">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

/** A failure the reader can act on, rather than a stack trace. */
export function ErrorState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode | undefined;
}) {
  return (
    <div className="rounded-panel border border-[#FECACA] bg-state-severe-bg px-4 py-3.5">
      <p className="text-[0.875rem] font-semibold text-state-severe">{title}</p>
      <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-muted">{detail}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** A single number that matters, with its label. */
export function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  tone?: 'neutral' | 'severe' | 'resolved' | 'review';
}) {
  const toneClass = {
    neutral: 'text-ink',
    severe: 'text-state-severe',
    resolved: 'text-state-resolved',
    review: 'text-state-review',
  }[tone];

  return (
    <div>
      <p className="field-label">{label}</p>
      <p className={cn('mt-1 text-[1.5rem] font-bold tracking-tight', toneClass)}>{value}</p>
    </div>
  );
}

/**
 * Shared entrance motion.
 *
 * Prefer the helpers in `@/components/motion`, which read the reader's
 * reduced-motion preference. The stylesheet's `prefers-reduced-motion` rule
 * only collapses CSS transitions — Framer Motion animates inline styles and
 * never sees it — so this object alone does not honour the preference. It is
 * kept for the call sites that still spread it, all of which sit under the
 * app-wide `MotionProvider` that does.
 */
export const fadeUp = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const },
};

/** Staggers a list so rows arrive in order rather than all at once. */
export function StaggerList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.035 } } }}
    >
      {children}
    </motion.div>
  );
}

export const staggerItem = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const } },
};
