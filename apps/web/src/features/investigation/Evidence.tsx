import { useState } from 'react';
import type { Evidence, VerificationResult } from '@netra/domain';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronRight, Copy, FileSearch, Sparkles } from 'lucide-react';
import { EmptyState, Mono, PanelHeader } from '@/components/primitives';
import { VerificationBadge } from '@/components/status';
import { cn } from '@/lib/cn';

/**
 * The evidence chain.
 *
 * Each item states where a fact came from and which deterministic analyzer
 * produced it, so a reviewer can check Netra's work instead of trusting it.
 */

const KIND_LABEL: Record<Evidence['kind'], string> = {
  DIFF_HUNK: 'From the diff',
  SOURCE_REFERENCE: 'Source reference',
  CONFIG_ENTRY: 'Configuration',
  REFERENCE_PATH: 'Reference path',
  GIT_HISTORY: 'Git history',
  STATIC_CHECK: 'Static check',
};

export function EvidencePanel({
  evidence,
  verifications,
  selectedFile,
  onSelect,
  modelUsed,
  className,
}: {
  evidence: Evidence[];
  verifications: VerificationResult[];
  selectedFile: string | null;
  onSelect: (file: string | null) => void;
  modelUsed: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className={cn('panel flex min-h-0 flex-col overflow-hidden', className)}>
      <PanelHeader
        title="Evidence"
        subtitle={
          evidence.length
            ? `${evidence.length} location${evidence.length === 1 ? '' : 's'}`
            : 'Collected during the investigation'
        }
        icon={<FileSearch size={15} />}
      />

      {/* The trust statement, stated plainly and always present. */}
      <div className="flex items-start gap-2 border-b border-line bg-surface-sunken px-4 py-2.5">
        <Sparkles size={13} className="mt-0.5 shrink-0 text-ink-subtle" />
        <p className="text-[0.72rem] leading-relaxed text-ink-subtle">
          {modelUsed
            ? 'A model investigated and explained this change. Every claim below was then re-derived by deterministic code — the model cannot mark anything verified.'
            : 'The model was unavailable for this investigation, so everything below comes from deterministic analysis alone.'}
        </p>
      </div>

      {verifications.length > 0 ? (
        <ul className="divide-y divide-line border-b border-line">
          {verifications.map((result) => (
            <li key={result.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <VerificationBadge status={result.status} />
                <Mono className="text-ink-subtle">
                  {result.verifier} · {result.phase === 'POST_FIX' ? 'after fix' : 'before fix'}
                </Mono>
              </div>
              <p className="mt-2 text-[0.82rem] font-medium text-ink">{result.claim}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">{result.detail}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {evidence.length === 0 ? (
          <EmptyState
            title="No evidence yet"
            description="Evidence appears as Netra establishes facts about the repository."
          />
        ) : (
          <ul className="divide-y divide-line">
            {evidence.map((item, index) => (
              <EvidenceRow
                key={item.id}
                item={item}
                index={index + 1}
                expanded={expanded === item.id}
                highlighted={selectedFile === item.file}
                onToggle={() => {
                  setExpanded(expanded === item.id ? null : item.id);
                  onSelect(expanded === item.id ? null : item.file);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function EvidenceRow({
  item,
  index,
  expanded,
  highlighted,
  onToggle,
}: {
  item: Evidence;
  index: number;
  expanded: boolean;
  highlighted: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; the snippet is still selectable.
    }
  };

  return (
    <li className={cn('transition-colors', highlighted && 'bg-surface-raised')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2.5 px-4 py-3 text-left hover:bg-surface-raised"
      >
        <ChevronRight
          size={14}
          className={cn(
            'mt-0.5 shrink-0 text-ink-subtle transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="mono text-[0.68rem] font-semibold text-ink-subtle">
              #{String(index).padStart(2, '0')}
            </span>
            <Mono className="truncate text-ink">
              {item.file}
              {item.line !== null ? `:${item.line}` : ''}
            </Mono>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{item.relationship}</p>
        </div>
        <span className="mono shrink-0 text-[0.62rem] uppercase tracking-wider text-ink-subtle">
          {KIND_LABEL[item.kind]}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-2.5 px-4 pb-4 pl-11">
              <div className="relative">
                <pre className="mono overflow-x-auto rounded-md border border-line bg-surface-sunken px-3 py-2.5 text-[0.72rem] leading-relaxed text-ink">
                  {item.snippet}
                </pre>
                <button
                  type="button"
                  onClick={() => void copy(item.snippet)}
                  className="absolute right-2 top-2 rounded p-1 text-ink-subtle hover:bg-surface-raised hover:text-ink"
                  aria-label="Copy snippet"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
              {item.producedByCommand ? (
                <p className="text-[0.68rem] text-ink-subtle">
                  Produced by{' '}
                  <Mono className="text-ink-muted">{item.producedBy}</Mono> running{' '}
                  <Mono className="text-ink-muted">{item.producedByCommand}</Mono>
                </p>
              ) : (
                <p className="text-[0.68rem] text-ink-subtle">
                  Produced by <Mono className="text-ink-muted">{item.producedBy}</Mono>
                </p>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}
