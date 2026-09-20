import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Evidence, VerificationResult } from '@netra/domain';
import {
  ActivitySection,
  EvidenceChainSection,
  VerificationSection,
} from '@/pages/InvestigationPage';

/**
 * The three report sections that carry the investigation's argument.
 *
 * They are tested against realistically shaped records because their whole job
 * is to make a causal chain and a verification verdict legible.
 */

function evidence(overrides: Partial<Evidence>): Evidence {
  return {
    id: 'evd_1',
    findingId: 'fnd_1',
    kind: 'REFERENCE_PATH',
    file: 'src/client/config.js',
    line: 11,
    endLine: null,
    snippet: 'secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,',
    relationship: 'Reachable from the browser entry point.',
    verificationStatus: 'VERIFIED',
    producedBy: 'secret-flow-v1',
    producedByCommand: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function verification(overrides: Partial<VerificationResult>): VerificationResult {
  return {
    id: 'vrf_1',
    findingId: 'fnd_1',
    verifier: 'secret-flow-v1',
    status: 'VERIFIED',
    claim: 'AWS_SECRET_ACCESS_KEY reaches the browser bundle.',
    detail: 'Bundler inlines the credential at build time.',
    command: null,
    durationMs: 412,
    phase: 'PRE_FIX',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('evidence chain', () => {
  it('groups evidence into source, transformation and sink', () => {
    render(
      <EvidenceChainSection
        evidence={[
          evidence({ id: 'a', kind: 'DIFF_HUNK', file: 'src/client/config.js' }),
          evidence({ id: 'b', kind: 'CONFIG_ENTRY', file: 'vite.config.js' }),
          evidence({ id: 'c', kind: 'REFERENCE_PATH', file: 'src/client/main.js' }),
        ]}
      />,
    );

    // The stage labels are the argument: where it enters, what moves it, where
    // it escapes.
    expect(screen.getAllByText('Source').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Transformation').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sink').length).toBeGreaterThan(0);
    expect(screen.getByText(/vite\.config\.js/)).toBeTruthy();
  });

  it('omits a stage that has no evidence rather than showing it empty', () => {
    render(<EvidenceChainSection evidence={[evidence({ kind: 'DIFF_HUNK' })]} />);
    expect(screen.getAllByText('Source').length).toBeGreaterThan(0);
    expect(screen.queryByText('Transformation')).toBeNull();
    expect(screen.queryByText('Sink')).toBeNull();
  });

  it('names the analyzer that established each fact', () => {
    render(<EvidenceChainSection evidence={[evidence({})]} />);
    expect(screen.getByText(/secret-flow-v1/)).toBeTruthy();
  });

  it('says so plainly when there is no chain', () => {
    render(<EvidenceChainSection evidence={[]} />);
    expect(screen.getByText(/No causal chain was recorded/)).toBeTruthy();
  });
});

describe('verification', () => {
  it('labels the pre-fix and post-fix phases in order', () => {
    render(
      <VerificationSection
        verifications={[
          verification({ id: 'v2', phase: 'POST_FIX', status: 'REFUTED' }),
          verification({ id: 'v1', phase: 'PRE_FIX', status: 'VERIFIED' }),
        ]}
      />,
    );
    expect(screen.getByText('Before the fix')).toBeTruthy();
    expect(screen.getByText('After the fix')).toBeTruthy();
  });

  it('presents a refuted post-fix result as the finding no longer being present', () => {
    // This is what earns the resolved state, so it must read as a resolution
    // rather than as a failed check.
    render(
      <VerificationSection
        verifications={[verification({ phase: 'POST_FIX', status: 'REFUTED' })]}
      />,
    );
    expect(screen.getByText('No longer present')).toBeTruthy();
  });

  it('attributes the verdict to the deterministic verifier', () => {
    render(<VerificationSection verifications={[verification({})]} />);
    expect(screen.getByText(/secret-flow-v1/)).toBeTruthy();
    expect(screen.getByText(/412ms/)).toBeTruthy();
  });
});

describe('investigation activity', () => {
  it('lists what the investigation did, in order', () => {
    render(
      <ActivitySection
        activities={[
          { id: 'a1', message: 'Tracing credential flow', state: 'COMPLETED', at: '' },
          { id: 'a2', message: 'Running deterministic verification', state: 'STARTED', at: '' },
        ]}
      />,
    );
    expect(screen.getByText('Tracing credential flow')).toBeTruthy();
    expect(screen.getByText('Running deterministic verification')).toBeTruthy();
  });

  it('renders a failed step without hiding it', () => {
    render(
      <ActivitySection
        activities={[{ id: 'a1', message: 'Model unavailable', state: 'FAILED', at: '' }]}
      />,
    );
    expect(screen.getByText('Model unavailable')).toBeTruthy();
  });
});
