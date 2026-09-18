import { INVESTIGATION_PHASES, STATUS_LABELS, type InvestigationStatus } from '@netra/domain';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, CircleDashed, LoaderCircle, X } from 'lucide-react';
import { PanelHeader } from '@/components/primitives';
import type { ActivityItem } from '@/hooks/useInvestigation';
import { cn } from '@/lib/cn';

/**
 * What Netra is doing, as it does it.
 *
 * These are summaries the pipeline chose to publish, each tied to real backend
 * work. The model's internal reasoning is never shown here or stored anywhere.
 */
export function ActivityRail({
  status,
  activities,
  className,
}: {
  status: InvestigationStatus | null;
  activities: ActivityItem[];
  className?: string;
}) {
  const currentPhase = status ? INVESTIGATION_PHASES.indexOf(status) : -1;

  return (
    <section className={cn('panel flex min-h-0 flex-col overflow-hidden', className)}>
      <PanelHeader title="Investigation activity" />

      <ol className="border-b border-[--color-line] px-4 py-3" aria-label="Investigation progress">
        {INVESTIGATION_PHASES.map((phase, index) => {
          const done = currentPhase > index || status === 'RESOLVED';
          const active = currentPhase === index;
          return (
            <li key={phase} className="flex items-center gap-2.5 py-[3px]">
              <span
                className={cn(
                  'grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[--color-ink-subtle]',
                  done && 'border-[--color-state-resolved] text-[--color-state-resolved]',
                  active && 'border-[--color-state-active] text-[--color-state-active]',
                  !done && !active && 'border-[--color-line]',
                )}
              >
                {done ? (
                  <Check size={9} strokeWidth={3} />
                ) : active ? (
                  <LoaderCircle size={10} className="animate-spin" />
                ) : (
                  <CircleDashed size={9} />
                )}
              </span>
              <span
                className={cn(
                  'text-xs',
                  active ? 'font-medium text-[--color-ink]' : 'text-[--color-ink-subtle]',
                  done && 'text-[--color-ink-muted]',
                )}
              >
                {STATUS_LABELS[phase]}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <AnimatePresence initial={false}>
          {activities.map((activity) => (
            <motion.div
              key={activity.id}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              className="flex items-start gap-2 py-1"
            >
              <span className="mt-0.5 shrink-0">
                {activity.state === 'COMPLETED' ? (
                  <Check size={12} className="text-[--color-state-resolved]" />
                ) : activity.state === 'FAILED' ? (
                  <X size={12} className="text-[--color-state-review]" />
                ) : (
                  <LoaderCircle size={12} className="animate-spin text-[--color-state-active]" />
                )}
              </span>
              <p
                className={cn(
                  'text-xs leading-relaxed',
                  activity.state === 'STARTED' ? 'text-[--color-ink]' : 'text-[--color-ink-muted]',
                )}
              >
                {activity.message}
              </p>
            </motion.div>
          ))}
        </AnimatePresence>
        {activities.length === 0 ? (
          <p className="text-xs text-[--color-ink-subtle]">Waiting for the investigation to start.</p>
        ) : null}
      </div>
    </section>
  );
}
