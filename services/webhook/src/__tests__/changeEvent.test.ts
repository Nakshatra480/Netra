import { describe, expect, it } from 'vitest';
import { extractCodeChange } from '../changeEvent.js';

/** `push` and `pull_request` describe the same thing in two shapes. */
describe('code change extraction', () => {
  const repository = {
    full_name: 'Nakshatra480/Netra',
    id: 42,
    default_branch: 'main',
    private: true,
  };

  describe('push', () => {
    const push = {
      ref: 'refs/heads/feature/upload',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      repository,
      installation: { id: 162823444 },
      head_commit: { message: 'Enable direct receipt upload\n\nlonger body ignored' },
      pusher: { name: 'priya' },
    };

    it('reads the commit range, branch and author', () => {
      const result = extractCodeChange('push', push, 'delivery-1');
      expect(result.kind).toBe('event');
      if (result.kind !== 'event') return;

      expect(result.event.change.commitSha).toBe('b'.repeat(40));
      expect(result.event.change.baseSha).toBe('a'.repeat(40));
      expect(result.event.change.branch).toBe('feature/upload');
      expect(result.event.change.author).toBe('priya');
      expect(result.event.installationId).toBe(162823444);
    });

    it('uses only the first line of the commit message as the title', () => {
      const result = extractCodeChange('push', push, 'd');
      if (result.kind !== 'event') throw new Error('expected an event');
      expect(result.event.change.title).toBe('Enable direct receipt upload');
    });

    it('skips a branch deletion, which has nothing to investigate', () => {
      const deletion = { ...push, after: '0'.repeat(40) };
      const result = extractCodeChange('push', deletion, 'd');
      expect(result.kind).toBe('skip');
    });

    it('treats a branch creation as having no base to diff against', () => {
      const creation = { ...push, before: '0'.repeat(40) };
      const result = extractCodeChange('push', creation, 'd');
      if (result.kind !== 'event') throw new Error('expected an event');
      // Null rather than the all-zero sha: a consumer must not try to diff it.
      expect(result.event.change.baseSha).toBeNull();
    });
  });

  describe('pull_request', () => {
    const pr = {
      action: 'opened',
      number: 182,
      repository,
      installation: { id: 162823444 },
      pull_request: {
        title: 'Enable direct receipt upload from the browser',
        head: { sha: 'c'.repeat(40), ref: 'feature/upload' },
        base: { sha: 'd'.repeat(40) },
        user: { login: 'priya' },
      },
    };

    it('reads head and base from the pull request', () => {
      const result = extractCodeChange('pull_request', pr, 'delivery-2');
      if (result.kind !== 'event') throw new Error('expected an event');

      expect(result.event.change.commitSha).toBe('c'.repeat(40));
      expect(result.event.change.baseSha).toBe('d'.repeat(40));
      expect(result.event.change.pullRequestNumber).toBe(182);
      expect(result.event.source).toBe('pull_request');
    });

    it.each(['opened', 'synchronize', 'reopened', 'ready_for_review'])(
      'investigates the %s action',
      (action) => {
        expect(extractCodeChange('pull_request', { ...pr, action }, 'd').kind).toBe('event');
      },
    );

    it.each(['closed', 'labeled', 'assigned', 'review_requested', 'edited'])(
      'skips the %s action, which does not change code',
      (action) => {
        // Investigating these would spend money re-analysing identical code.
        expect(extractCodeChange('pull_request', { ...pr, action }, 'd').kind).toBe('skip');
      },
    );
  });

  describe('defensive handling', () => {
    it('skips a payload with no repository', () => {
      expect(extractCodeChange('push', {}, 'd').kind).toBe('skip');
    });

    it('skips an unhandled event type', () => {
      expect(extractCodeChange('star', { repository }, 'd').kind).toBe('skip');
    });

    it('survives missing optional fields', () => {
      const sparse = { ref: 'refs/heads/main', after: 'e'.repeat(40), repository };
      const result = extractCodeChange('push', sparse, 'd');
      if (result.kind !== 'event') throw new Error('expected an event');
      expect(result.event.change.author).toBe('unknown');
      expect(result.event.installationId).toBeNull();
    });
  });
});
