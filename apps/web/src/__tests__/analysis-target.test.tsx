import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnalysisTarget } from '@/features/repository/AnalysisTarget';
import { api, ApiError, type Session } from '@/lib/api';

/**
 * Choosing what to analyze.
 *
 * The failure modes carry the weight here: an unreachable GitHub, a repository
 * with no history, and a second click while a request is already open. Each has
 * to be visible and safe, because the alternative is either a silent no-op or a
 * second investigation of the same commit.
 */

const session: Session = { token: 't', idToken: 'id', scheme: 'bearer', workspaceId: 'w' };

const commits = [
  {
    sha: '241f6a87c22d99068fba2d43e118064d2f65ceb7',
    shortSha: '241f6a8',
    message: 'fixture: add authorization examples',
    authorName: 'netra-security[bot]',
    authoredAt: '2026-09-20T09:40:00Z',
  },
  {
    sha: '3027994a61cbdf3717134ec66db4a89c090045fa',
    shortSha: '3027994',
    message: 'feat: add Stripe payment client for checkout flow',
    authorName: 'Nakshatra Sharma',
    authoredAt: '2026-09-19T22:31:43Z',
  },
];

/** A click plus the re-render it causes. */
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

function setup(onStarted = vi.fn()) {
  render(
    <AnalysisTarget
      session={session}
      repositoryId="repo_1"
      defaultBranch="main"
      onStarted={onStarted}
    />,
  );
  return onStarted;
}

beforeEach(() => vi.restoreAllMocks());

describe('AnalysisTarget', () => {
  it('offers exactly the two documented choices', () => {
    setup();
    expect(screen.getByRole('button', { name: /analyze latest commit/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /select commit/i })).toBeTruthy();
  });

  it('analyzes the branch tip with no sha when latest is chosen', async () => {
    const spy = vi
      .spyOn(api, 'analyzeRepository')
      .mockResolvedValue({ investigationId: 'inv_1', headSha: 'abc', branch: 'main', repository: 'a/b', alreadyRunning: false });
    const onStarted = setup();

    await click(screen.getByRole('button', { name: /analyze latest commit/i }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('inv_1'));
    // No SHA argument: the server resolves the tip, the browser does not guess it.
    expect(spy).toHaveBeenCalledWith(session, 'repo_1', undefined);
  });

  it('shows real commit metadata and analyzes the exact sha that was picked', async () => {
    vi.spyOn(api, 'listCommits').mockResolvedValue({ commits, branch: 'main' });
    const spy = vi
      .spyOn(api, 'analyzeRepository')
      .mockResolvedValue({ investigationId: 'inv_2', headSha: commits[1]!.sha, branch: 'main', repository: 'a/b', alreadyRunning: false, selected: true });
    const onStarted = setup();

    await click(screen.getByRole('button', { name: /select commit/i }));
    await screen.findByText('feat: add Stripe payment client for checkout flow');

    // Message, author and short SHA are all shown for the choice to be real.
    expect(screen.getByText(/Nakshatra Sharma/)).toBeTruthy();
    expect(screen.getByText('3027994')).toBeTruthy();

    await click(screen.getByText('feat: add Stripe payment client for checkout flow'));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('inv_2'));
    // The chosen commit, not the tip.
    expect(spy).toHaveBeenCalledWith(session, 'repo_1', commits[1]!.sha);
  });

  it('starts only one investigation when the button is clicked twice', async () => {
    let resolve!: (v: never) => void;
    const spy = vi
      .spyOn(api, 'analyzeRepository')
      .mockReturnValue(new Promise((r) => { resolve = r as never; }) as never);
    setup();

    const button = screen.getByRole('button', { name: /analyze latest commit/i });
    await click(button);
    // The button is replaced by the analyzing state, but fire again anyway to
    // prove the guard and not just the re-render.
    await click(button);

    expect(spy).toHaveBeenCalledTimes(1);
    resolve({ investigationId: 'inv_3' } as never);
  });

  it('names the commit it is analyzing', async () => {
    vi.spyOn(api, 'listCommits').mockResolvedValue({ commits, branch: 'main' });
    vi.spyOn(api, 'analyzeRepository').mockReturnValue(new Promise(() => {}) as never);
    setup();

    await click(screen.getByRole('button', { name: /select commit/i }));
    await screen.findByText('feat: add Stripe payment client for checkout flow');
    await click(screen.getByText('feat: add Stripe payment client for checkout flow'));

    expect(await screen.findByText(/analyzing/i)).toBeTruthy();
    expect(screen.getByText('3027994')).toBeTruthy();
  });

  it('reports a GitHub failure and offers a retry', async () => {
    const spy = vi
      .spyOn(api, 'listCommits')
      .mockRejectedValueOnce(new ApiError('INTERNAL', 'GitHub API rate limit exceeded', 500))
      .mockResolvedValueOnce({ commits, branch: 'main' });
    setup();

    await click(screen.getByRole('button', { name: /select commit/i }));
    expect(await screen.findByText(/rate limit exceeded/i)).toBeTruthy();

    await click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('feat: add Stripe payment client for checkout flow');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('says so when the repository has no history', async () => {
    vi.spyOn(api, 'listCommits').mockResolvedValue({ commits: [], branch: 'main', empty: true });
    setup();

    await click(screen.getByRole('button', { name: /select commit/i }));
    expect(await screen.findByText(/no commits to analyze/i)).toBeTruthy();
  });

  it('surfaces a stale sha rather than falling back to the tip', async () => {
    vi.spyOn(api, 'listCommits').mockResolvedValue({ commits, branch: 'main' });
    vi.spyOn(api, 'analyzeRepository').mockRejectedValue(
      new ApiError('NOT_FOUND', 'Commit 3027994 is not on acme/app. It may have been rewritten or force-pushed away.', 404),
    );
    const onStarted = setup();

    await click(screen.getByRole('button', { name: /select commit/i }));
    await screen.findByText('feat: add Stripe payment client for checkout flow');
    await click(screen.getByText('feat: add Stripe payment client for checkout flow'));

    expect(await screen.findByText(/force-pushed away/i)).toBeTruthy();
    // Nothing was started, so nothing may navigate away.
    expect(onStarted).not.toHaveBeenCalled();
  });
});
