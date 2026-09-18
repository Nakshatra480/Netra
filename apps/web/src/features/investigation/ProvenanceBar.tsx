import type { ModelProvenance } from '@netra/domain';
import { BrainCircuit, Coins, Hash, Repeat2, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * How this investigation was interpreted.
 *
 * States the path that actually ran. When no model was involved it says so
 * rather than leaving the reader to assume one was, because the difference
 * between "a model explained this" and "code proved this" is the product.
 */
export function ProvenanceBar({
  provenance,
  className,
}: {
  provenance: ModelProvenance | null;
  className?: string;
}) {
  if (!provenance) return null;

  const { modelUsed } = provenance;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-[--color-line] px-5 py-2.5 text-xs',
        className,
      )}
    >
      <span className="flex items-center gap-1.5">
        <BrainCircuit
          size={13}
          className={modelUsed ? 'text-[--color-state-active]' : 'text-[--color-ink-subtle]'}
        />
        <span className={modelUsed ? 'text-[--color-ink]' : 'text-[--color-ink-muted]'}>
          {provenance.display}
        </span>
      </span>

      {modelUsed ? (
        <>
          {provenance.estimatedTokens !== null ? (
            <Stat icon={<Hash size={12} />} label="Context">
              {formatTokens(provenance.estimatedTokens)}
            </Stat>
          ) : null}
          <Stat icon={<Repeat2 size={12} />} label="Model turns">
            {provenance.calls}
          </Stat>
          {provenance.costUsd > 0 ? (
            <Stat icon={<Coins size={12} />} label="Cost">
              ${provenance.costUsd.toFixed(4)}
            </Stat>
          ) : null}
        </>
      ) : null}

      {/* The claim that matters regardless of which model ran, or whether one did. */}
      <Stat icon={<ShieldCheck size={12} />} label="Verification">
        deterministic
      </Stat>

      {provenance.fallbackReason ? (
        <span className="text-[--color-state-review]">
          Fell back: {provenance.fallbackReason}
        </span>
      ) : null}
    </div>
  );
}

function Stat({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[--color-ink-subtle]">
      {icon}
      {label}
      <span className="mono text-[--color-ink-muted]">{children}</span>
    </span>
  );
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k tokens` : `${count} tokens`;
}
