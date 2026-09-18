import { markFailed } from './store.js';

/**
 * The workflow's catch handler.
 *
 * Every failure path ends here so an investigation can never be left silently
 * stuck mid-lifecycle: whatever went wrong, the stored record says FAILED and
 * carries a reason a person can read.
 */

export interface FailureEvent {
  investigationId?: string;
  error?: { Error?: string; Cause?: string };
}

function log(level: 'INFO' | 'ERROR', message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, message, ...fields }));
}

/**
 * Turn a Step Functions error into something a reviewer can act on.
 *
 * `Cause` is often a JSON-encoded stack trace; the message inside it is the
 * useful part, and the trace is noise on an investigation page.
 */
export function describeFailure(error: FailureEvent['error']): string {
  if (!error) return 'The investigation failed for an unrecorded reason.';

  const name = error.Error ?? 'Error';
  let detail = error.Cause ?? '';
  try {
    const parsed = JSON.parse(detail) as {
      errorMessage?: string;
      StoppedReason?: string;
      Containers?: Array<{ Reason?: string; ExitCode?: number }>;
    };

    // An ECS task failure arrives as the whole task description. Its
    // StoppedReason is the sentence a person needs; the rest is network
    // interfaces and ARNs that would bury it on an investigation page.
    if (parsed.StoppedReason) {
      const container = parsed.Containers?.[0];
      detail = container?.Reason
        ? `${parsed.StoppedReason} (${container.Reason})`
        : parsed.StoppedReason;
    } else {
      detail = parsed.errorMessage ?? detail;
    }
  } catch {
    // Not JSON; the raw cause is already the message.
  }

  if (name === 'States.Timeout') {
    return 'The investigation exceeded its time limit and was stopped.';
  }
  if (name === 'States.TaskFailed' && !detail) {
    return 'The investigation task failed to run.';
  }
  return `${name}: ${detail}`.slice(0, 500);
}

export async function handler(event: FailureEvent): Promise<{ recorded: boolean }> {
  const investigationId = event.investigationId?.trim();
  const reason = describeFailure(event.error);

  if (!investigationId) {
    // Nothing to attach the failure to; the workflow still fails, loudly.
    log('ERROR', 'failure with no investigation to record it against', { reason });
    return { recorded: false };
  }

  await markFailed(investigationId, reason);
  log('ERROR', 'investigation marked failed', { investigationId, reason });
  return { recorded: true };
}
