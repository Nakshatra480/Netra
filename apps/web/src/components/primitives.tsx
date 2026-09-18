import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The small set of primitives every screen is built from.
 *
 * Keeping them here means spacing, radius and focus behaviour stay consistent
 * without each screen reinventing them.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'approve';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[--color-state-active] text-[oklch(0.15_0.01_260)] hover:brightness-110 font-semibold',
  secondary:
    'bg-[--color-surface-raised] text-[--color-ink] border border-[--color-line] hover:border-[--color-line-strong]',
  ghost: 'text-[--color-ink-muted] hover:text-[--color-ink] hover:bg-[--color-surface-raised]',
  danger:
    'bg-transparent text-[--color-state-severe] border border-[color-mix(in_oklch,var(--color-state-severe)_45%,transparent)] hover:bg-[color-mix(in_oklch,var(--color-state-severe)_12%,transparent)]',
  approve:
    'bg-[--color-state-resolved] text-[oklch(0.15_0.01_260)] hover:brightness-110 font-semibold',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg transition-[filter,background-color,border-color,color] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' && 'px-2.5 py-1.5 text-xs',
        size === 'md' && 'px-3.5 py-2 text-sm',
        size === 'lg' && 'px-5 py-2.5 text-[0.95rem]',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
});

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
  subtitle?: string;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-[--color-line] px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? <span className="text-[--color-ink-subtle]">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="truncate text-[0.8rem] font-semibold uppercase tracking-[0.08em] text-[--color-ink-muted]">
            {title}
          </h2>
          {subtitle ? (
            <p className="truncate text-xs text-[--color-ink-subtle]">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}

/** Monospace technical value: a path, an identifier, a commit hash. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('mono text-[0.82em]', className)}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded bg-[--color-surface-raised]', className)}
      aria-hidden="true"
    />
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon ? <div className="text-[--color-ink-subtle]">{icon}</div> : null}
      <div className="max-w-sm">
        <p className="text-sm font-medium text-[--color-ink]">{title}</p>
        <p className="mt-1 text-sm text-[--color-ink-subtle]">{description}</p>
      </div>
      {action}
    </div>
  );
}
