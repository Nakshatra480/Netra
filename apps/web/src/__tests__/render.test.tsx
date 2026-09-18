import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Evidence, VerificationResult } from '@netra/domain';
import { ActivityRail } from '@/features/investigation/Activity';
import { EvidencePanel } from '@/features/investigation/Evidence';
import { ProvenanceBar } from '@/features/investigation/ProvenanceBar';
import { SeverityBadge, StatusBadge, VerificationBadge } from '@/components/status';

const evidence: Evidence[] = [
  {
    id: 'evd_1',
    findingId: 'fnd_1',
    kind: 'REFERENCE_PATH',
    file: 'src/client/config.js',
    line: 11,
    endLine: null,
    snippet: 'secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,',
    relationship: 'Reachable from the browser entry point via src/client/main.js.',
    verificationStatus: 'VERIFIED',
    producedBy: 'secret-flow-v1',
    producedByCommand: 'rg --fixed-strings -- AWS_SECRET_ACCESS_KEY .',
    createdAt: new Date().toISOString(),
  },
];

const verification: VerificationResult = {
  id: 'vrf_1',
  findingId: 'fnd_1',
  verifier: 'secret-flow-v1',
  status: 'VERIFIED',
  claim: 'AWS_SECRET_ACCESS_KEY reaches the browser bundle.',
  detail: 'Bundler inlines AWS_SECRET_ACCESS_KEY at build time.',
  command: null,
  durationMs: 412,
  phase: 'PRE_FIX',
  createdAt: new Date().toISOString(),
};

describe('investigation UI', () => {
  it('shows a verified claim as verified by a deterministic check', () => {
    render(
      <EvidencePanel
        evidence={evidence}
        verifications={[verification]}
        selectedFile={null}
        onSelect={() => {}}
        modelUsed
      />,
    );
    expect(screen.getByText(/Verified by deterministic check/i)).toBeTruthy();
    expect(screen.getByText(verification.claim)).toBeTruthy();
    expect(screen.getByText(/src\/client\/config\.js:11/)).toBeTruthy();
  });

  it('says plainly when the model was unavailable', () => {
    const { rerender } = render(
      <EvidencePanel
        evidence={evidence}
        verifications={[]}
        selectedFile={null}
        onSelect={() => {}}
        modelUsed={false}
      />,
    );
    expect(screen.getByText(/model was unavailable/i)).toBeTruthy();

    rerender(
      <EvidencePanel
        evidence={evidence}
        verifications={[]}
        selectedFile={null}
        onSelect={() => {}}
        modelUsed
      />,
    );
    expect(screen.getByText(/cannot mark anything verified/i)).toBeTruthy();
  });

  it('never labels an unverified claim as verified', () => {
    render(<VerificationBadge status="UNVERIFIED" />);
    expect(screen.getByText(/Model hypothesis — not verified/)).toBeTruthy();
  });

  it('renders the lifecycle rail with the current phase', () => {
    render(
      <ActivityRail
        status="VERIFYING"
        activities={[
          { id: 'a1', message: 'Tracing credential flow', state: 'COMPLETED', at: '' },
          { id: 'a2', message: 'Running deterministic verification', state: 'STARTED', at: '' },
        ]}
      />,
    );
    expect(screen.getByText('Running deterministic verification')).toBeTruthy();
    expect(screen.getByText('Verifying deterministically')).toBeTruthy();
  });

  it('renders status and severity without crashing', () => {
    render(
      <>
        <StatusBadge status="AWAITING_APPROVAL" />
        <SeverityBadge severity="CRITICAL" />
      </>,
    );
    expect(screen.getByText('Awaiting your approval')).toBeTruthy();
    expect(screen.getByText('CRITICAL')).toBeTruthy();
  });
});

describe('AI provenance', () => {
  const base = {
    provider: 'OpenRouter',
    model: 'anthropic/claude-sonnet-4.5',
    modelLabel: 'Claude Sonnet 4.5',
    modelUsed: true,
    display: 'OpenRouter · Claude Sonnet 4.5',
    fallbackReason: null,
    unavailableReason: null,
    calls: 1,
    toolCalls: 0,
    inputTokens: 693,
    outputTokens: 191,
    totalTokens: 884,
    costUsd: 0.004944,
    estimatedTokens: 203,
  };

  it('names the provider and model that actually ran', () => {
    render(<ProvenanceBar provenance={base} />);
    expect(screen.getByText('OpenRouter · Claude Sonnet 4.5')).toBeTruthy();
    expect(screen.getByText('203 tokens')).toBeTruthy();
    expect(screen.getByText('$0.0049')).toBeTruthy();
  });

  it('says plainly when no model ran, and shows no usage', () => {
    render(
      <ProvenanceBar
        provenance={{
          ...base,
          provider: null,
          model: null,
          modelLabel: null,
          modelUsed: false,
          display: 'AI unavailable — deterministic analysis',
          unavailableReason: 'no OpenRouter credentials are configured',
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          estimatedTokens: null,
        }}
      />,
    );
    expect(screen.getByText('AI unavailable — deterministic analysis')).toBeTruthy();
    // Claiming turns or cost for a run that never happened would be a lie.
    expect(screen.queryByText('Model turns')).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('states that verification is deterministic either way', () => {
    render(<ProvenanceBar provenance={{ ...base, modelUsed: false }} />);
    expect(screen.getByText('deterministic')).toBeTruthy();
  });

  it('surfaces a fallback to the local provider', () => {
    render(
      <ProvenanceBar
        provenance={{
          ...base,
          provider: 'Ollama',
          modelLabel: 'qwen2.5-coder:7b',
          display: 'Ollama · qwen2.5-coder:7b',
          fallbackReason: 'all OpenRouter credentials are rate limited or exhausted',
          costUsd: 0,
        }}
      />,
    );
    expect(screen.getByText('Ollama · qwen2.5-coder:7b')).toBeTruthy();
    expect(screen.getByText(/Fell back:/)).toBeTruthy();
  });
});
