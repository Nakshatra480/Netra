import { useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { ArrowDownToLine, TerminalSquare } from 'lucide-react';
import { Button, PanelHeader } from '@/components/primitives';
import type { CommandBlock } from '@/hooks/useInvestigation';
import { cn } from '@/lib/cn';

/**
 * The investigation terminal.
 *
 * Everything rendered here came from a command that actually ran in the
 * sandbox: the prompt is the argv the allowlist built, the body is the process
 * output, and the status line is its real exit code and duration. Nothing is
 * typed out for effect.
 */

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[38;5;245m',
  prompt: '\x1b[38;5;75m',
  command: '\x1b[38;5;252m',
  ok: '\x1b[38;5;78m',
  fail: '\x1b[38;5;203m',
  stderr: '\x1b[38;5;215m',
};

export function InvestigationTerminal({
  commands,
  className,
}: {
  commands: CommandBlock[];
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef({ blocks: 0, chunks: new Map<string, number>(), finished: new Set<string>() });
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new XTerm({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12.5,
      lineHeight: 1.5,
      convertEol: true,
      cursorStyle: 'bar',
      cursorBlink: false,
      // Reading long output is the job; scrollback needs to be generous.
      scrollback: 5000,
      theme: {
        background: 'rgba(0,0,0,0)',
        foreground: '#d7dbe4',
        selectionBackground: 'rgba(96,165,250,0.3)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // The panel can be measured mid-layout; the next resize will settle it.
      }
    });
    observer.observe(hostRef.current);

    // Scrolling up pauses auto-follow, exactly as a terminal emulator would.
    const disposable = term.onScroll(() => {
      const atBottom = term.buffer.active.viewportY >= term.buffer.active.baseY - 1;
      setFollow(atBottom);
    });

    return () => {
      observer.disconnect();
      disposable.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const written = writtenRef.current;

    for (let i = 0; i < commands.length; i += 1) {
      const block = commands[i]!;

      if (i >= written.blocks) {
        if (i > 0) term.writeln('');
        term.writeln(`${ANSI.prompt}❯${ANSI.reset} ${ANSI.command}${block.command}${ANSI.reset}`);
        written.blocks = i + 1;
      }

      const already = written.chunks.get(block.id) ?? 0;
      for (let c = already; c < block.output.length; c += 1) {
        const chunk = block.output[c]!;
        const colour = chunk.stream === 'stderr' ? ANSI.stderr : '';
        term.write(colour + chunk.text.replace(/\n$/, '\r\n') + (colour ? ANSI.reset : ''));
      }
      written.chunks.set(block.id, block.output.length);

      if (block.exitCode !== null && !written.finished.has(block.id)) {
        written.finished.add(block.id);
        const ok = block.exitCode === 0;
        const mark = ok ? `${ANSI.ok}✓` : `${ANSI.fail}exit ${block.exitCode}`;
        const note = block.timedOut ? ' (timed out)' : '';
        term.writeln(
          `${mark}${ANSI.reset} ${ANSI.dim}${formatDuration(block.durationMs)}${note}${ANSI.reset}`,
        );
      }
    }

    if (follow) term.scrollToBottom();
  }, [commands, follow]);

  const summary = useMemo(() => {
    const finished = commands.filter((c) => c.exitCode !== null).length;
    return `${finished}/${commands.length} commands`;
  }, [commands]);

  return (
    <section className={cn('panel flex min-h-0 flex-col overflow-hidden', className)}>
      <PanelHeader
        title="Investigation terminal"
        subtitle={commands.length ? summary : 'Waiting for the sandbox'}
        icon={<TerminalSquare size={15} />}
        actions={
          !follow ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFollow(true);
                termRef.current?.scrollToBottom();
              }}
            >
              <ArrowDownToLine size={13} />
              Follow output
            </Button>
          ) : null
        }
      />
      <div className="relative min-h-0 flex-1 bg-[--color-surface-sunken]">
        <div
          ref={hostRef}
          className="absolute inset-0 px-3 py-2"
          role="log"
          aria-live="polite"
          aria-label="Investigation command output"
        />
        {commands.length === 0 ? (
          <p className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-[--color-ink-subtle]">
            Commands appear here as the sandbox runs them.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}
