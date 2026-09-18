import { describe, expect, it } from 'vitest';
import { investigationSchema, modelProvenanceSchema } from './models.js';

describe('model provenance', () => {
  const provenance = {
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
    costUsd: 0.005205,
    estimatedTokens: 203,
  };

  it('accepts a completed model run', () => {
    expect(modelProvenanceSchema.parse(provenance).modelUsed).toBe(true);
  });

  it('accepts a run where no model was available', () => {
    const none = modelProvenanceSchema.parse({
      ...provenance,
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
    });
    expect(none.modelUsed).toBe(false);
    expect(none.provider).toBeNull();
  });

  it('requires a display string, so the UI can never render a blank claim', () => {
    const { display: _display, ...withoutDisplay } = provenance;
    expect(() => modelProvenanceSchema.parse(withoutDisplay)).toThrow();
  });

  it('rejects negative usage counters', () => {
    expect(() => modelProvenanceSchema.parse({ ...provenance, calls: -1 })).toThrow();
    expect(() => modelProvenanceSchema.parse({ ...provenance, costUsd: -0.01 })).toThrow();
  });

  it('is nullable on an investigation that has not decided yet', () => {
    const investigation = {
      id: 'inv_1',
      workspaceId: 'wsp_1',
      repositoryId: 'repo_1',
      reference: 'INV-2026-0001',
      change: {
        provider: 'DEMO' as const,
        repositoryFullName: 'orbital/payments',
        commitSha: 'abc1234',
        baseSha: 'def5678',
        branch: 'main',
        pullRequestNumber: null,
        title: 'a change',
        author: 'someone',
      },
      changedFiles: [],
      status: 'CREATED' as const,
      severity: null,
      summary: null,
      failureReason: null,
      isDemo: true,
      modelProvenance: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    expect(investigationSchema.parse(investigation).modelProvenance).toBeNull();
  });
});
