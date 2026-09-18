import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { investigationEventSchema, type InvestigationEvent } from '@netra/domain';

/**
 * Runs the Python investigator and turns its output into typed events.
 *
 * The investigator writes one JSON event per line as work happens and a final
 * `result` line. Arguments are passed as an argv array, never through a shell,
 * and the approved diff is passed as a file so it is never interpolated into a
 * command line.
 */

export interface InvestigatorRunOptions {
  readonly python: string;
  readonly cwd: string;
  readonly args: string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface InvestigatorResult {
  readonly events: InvestigationEvent[];
  readonly result: Record<string, unknown> | null;
  readonly exitCode: number;
  readonly stderr: string;
}

export class InvestigatorRunner {
  /**
   * Execute the investigator, invoking `onEvent` for each event as it arrives.
   *
   * Events are delivered as they are produced rather than batched at the end,
   * which is what makes the terminal in the UI show work in progress.
   */
  async run(
    options: InvestigatorRunOptions,
    onEvent: (event: InvestigationEvent) => void | Promise<void>,
  ): Promise<InvestigatorResult> {
    const child = spawn(options.python, ['-m', 'netra_investigator', ...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const events: InvestigationEvent[] = [];
    let result: Record<string, unknown> | null = null;
    let stderr = '';
    const pending: Array<Promise<void>> = [];

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Bounded: investigator logs are diagnostics, not a data channel.
      if (stderr.length < 64_000) stderr += chunk;
    });

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if ((parsed as { type?: string }).type === 'result') {
        result = (parsed as { result: Record<string, unknown> }).result;
        return;
      }

      const event = investigationEventSchema.safeParse(parsed);
      if (!event.success) return;
      events.push(event.data);
      pending.push(Promise.resolve(onEvent(event.data)).catch(() => undefined));
    });

    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timer));

    await Promise.all(pending);
    return { events, result, exitCode, stderr: stderr.slice(-4_000) };
  }
}
