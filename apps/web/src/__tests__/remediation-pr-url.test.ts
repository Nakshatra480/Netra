import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where a pull-request link is allowed to come from.
 *
 * The UI once carried a hardcoded demo PR URL and a scripted approval that
 * replayed eleven invented terminal lines before redirecting to it. Every
 * demo visitor was therefore sent to the same pull request, whichever
 * investigation they were looking at, and whether or not a remediation had
 * run. These tests keep that from coming back.
 */

const SRC = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

const SOURCES = [
  'pages/InvestigationPage.tsx',
  'pages/PrReviewPage.tsx',
  'features/investigation/Approval.tsx',
  'lib/api.ts',
];

describe('pull-request links', () => {
  it('are never hardcoded in the UI', () => {
    for (const file of SOURCES) {
      const src = read(file);
      expect(src, `${file} must not hardcode a pull request`).not.toMatch(
        /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/,
      );
    }
  });

  it('never name a fixture repository in the UI', () => {
    // The demo's repository is server configuration, read back from the
    // investigation record. The browser must not know it.
    for (const file of SOURCES) {
      expect(read(file), `${file} must not name the fixture repo`).not.toMatch(/netra-e2e-test/);
    }
  });

  it('are not assembled from parts either', () => {
    // Building "github.com/.../pull/" + number would be just as wrong: the
    // number has to come from GitHub's response, not from the client.
    for (const file of SOURCES) {
      expect(read(file)).not.toMatch(/['"`]https:\/\/github\.com\/\$\{/);
      expect(read(file)).not.toMatch(/\/pull\/['"`]\s*\+/);
    }
  });

  it('come only from the persisted action result', () => {
    const page = read('pages/InvestigationPage.tsx');
    // Both the redirect target and the header link read the same field.
    expect(page).toMatch(/const prUrl = state\.action\?\.resultUrl \?\? null;/);
    expect(page).toMatch(/const resolvedPrUrl = state\.action\?\.resultUrl \?\? null;/);

    const review = read('pages/PrReviewPage.tsx');
    expect(review).toMatch(/const prUrl = action\?\.resultUrl \?\? null;/);
  });
});

describe('approval has a single path', () => {
  it('does not branch on demo mode', () => {
    const page = read('pages/InvestigationPage.tsx');
    // A demo-only branch is what allowed the fabricated pipeline to exist.
    expect(page).not.toMatch(/\bisDemo\b/);
  });

  it('does not replay a scripted pipeline', () => {
    const page = read('pages/InvestigationPage.tsx');
    for (const ghost of ['demoSteps', 'demoActivities', 'demoStatus', 'DEMO_PR_URL']) {
      expect(page, `${ghost} must be gone`).not.toContain(ghost);
    }
    // Progress came from timers rather than from the backend.
    expect(page).not.toMatch(/delayMs/);
  });

  it('does not invent terminal output', () => {
    const page = read('pages/InvestigationPage.tsx');
    // Lines the pipeline never produced, including a technique Netra's
    // analyzer does not implement.
    expect(page).not.toMatch(/AST taint analysis/);
    // The banner that announces a real, persisted PR is legitimate; the
    // scripted line that interpolated a hardcoded URL into it was not.
    expect(page).not.toMatch(/Pull request created successfully: \$\{/);
    expect(page).not.toMatch(/Committed and pushed fix commit/);
  });

  it('gates approval on the real action status', () => {
    const page = read('pages/InvestigationPage.tsx');
    expect(page).toMatch(/const canApprove = state\.action\?\.status === 'PENDING';/);
  });
});
