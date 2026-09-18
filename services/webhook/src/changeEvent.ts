/**
 * Turning a GitHub webhook payload into the change Netra investigates.
 *
 * GitHub's `push` and `pull_request` payloads describe the same underlying
 * thing -- a commit range on a repository -- in two different shapes. Netra
 * cares about the change, not the shape, so the difference is resolved once
 * here rather than in every consumer downstream.
 */

/** The event Netra publishes to EventBridge. */
export interface CodeChangeEvent {
  readonly deliveryId: string;
  readonly source: 'push' | 'pull_request';
  readonly installationId: number | null;
  readonly repository: {
    readonly fullName: string;
    readonly githubId: number | null;
    readonly defaultBranch: string | null;
    readonly private: boolean;
  };
  readonly change: {
    readonly commitSha: string;
    /** The commit to diff against; null when GitHub gave no usable base. */
    readonly baseSha: string | null;
    readonly branch: string | null;
    readonly pullRequestNumber: number | null;
    readonly title: string;
    readonly author: string;
  };
  readonly receivedAt: string;
}

/** Pull request actions that change the code under review. */
const INVESTIGATED_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

/** The all-zero sha GitHub sends for a branch creation or deletion. */
const EMPTY_SHA = '0000000000000000000000000000000000000000';

export type ExtractionResult =
  | { readonly kind: 'event'; readonly event: CodeChangeEvent }
  | { readonly kind: 'skip'; readonly reason: string };

export function extractCodeChange(
  eventType: string,
  payload: Record<string, unknown>,
  deliveryId: string,
): ExtractionResult {
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (!repository?.full_name) {
    return { kind: 'skip', reason: 'payload has no repository' };
  }

  const base = {
    deliveryId,
    installationId: numberOrNull((payload.installation as Record<string, unknown>)?.id),
    repository: {
      fullName: String(repository.full_name),
      githubId: numberOrNull(repository.id),
      defaultBranch: stringOrNull(repository.default_branch),
      private: repository.private === true,
    },
    receivedAt: new Date().toISOString(),
  };

  if (eventType === 'push') {
    const after = stringOrNull(payload.after);
    const before = stringOrNull(payload.before);

    // A deletion has nothing to investigate, and a creation has no base commit
    // to diff against.
    if (!after || after === EMPTY_SHA) {
      return { kind: 'skip', reason: 'branch deletion' };
    }

    const headCommit = payload.head_commit as Record<string, unknown> | undefined;
    return {
      kind: 'event',
      event: {
        ...base,
        source: 'push',
        change: {
          commitSha: after,
          baseSha: before && before !== EMPTY_SHA ? before : null,
          branch: refToBranch(stringOrNull(payload.ref)),
          pullRequestNumber: null,
          title: firstLine(stringOrNull(headCommit?.message) ?? 'Push'),
          author:
            stringOrNull((payload.pusher as Record<string, unknown>)?.name) ??
            stringOrNull((payload.sender as Record<string, unknown>)?.login) ??
            'unknown',
        },
      },
    };
  }

  if (eventType === 'pull_request') {
    const action = String(payload.action ?? '');
    if (!INVESTIGATED_PR_ACTIONS.has(action)) {
      return { kind: 'skip', reason: `pull_request action "${action}" does not change code` };
    }

    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const head = pr?.head as Record<string, unknown> | undefined;
    const baseRef = pr?.base as Record<string, unknown> | undefined;
    const headSha = stringOrNull(head?.sha);
    if (!headSha) return { kind: 'skip', reason: 'pull request has no head sha' };

    return {
      kind: 'event',
      event: {
        ...base,
        source: 'pull_request',
        change: {
          commitSha: headSha,
          baseSha: stringOrNull(baseRef?.sha),
          branch: stringOrNull(head?.ref),
          pullRequestNumber: numberOrNull(payload.number) ?? numberOrNull(pr?.number),
          title: stringOrNull(pr?.title) ?? 'Pull request',
          author: stringOrNull((pr?.user as Record<string, unknown>)?.login) ?? 'unknown',
        },
      },
    };
  }

  return { kind: 'skip', reason: `unhandled event type "${eventType}"` };
}

function refToBranch(ref: string | null): string | null {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function firstLine(text: string): string {
  return text.split('\n')[0]!.slice(0, 200);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
