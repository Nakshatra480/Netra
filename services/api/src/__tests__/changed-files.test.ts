import { describe, expect, it } from 'vitest';
import { metaToInvestigation as toInvestigation } from '../store/dynamo.js';

/**
 * The changed-file list.
 *
 * This was previously hardcoded to an empty array, so every report claimed the
 * change touched no files and showed a dash for all three counts — including
 * for changes the same investigation had just analysed. These tests pin the
 * mapping, and in particular that nothing is invented when the record is
 * malformed: a fabricated row in a file list is indistinguishable from a real
 * one.
 */

function meta(extra: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    repository: 'acme/app',
    commitSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    branch: 'main',
    status: 'RESOLVED',
    createdAt: '2026-09-20T10:00:00.000Z',
    ...extra,
  };
}

describe('changedFiles mapping', () => {
  it('surfaces what the investigator measured', () => {
    const inv = toInvestigation(
      meta({
        changedFiles: [
          { path: 'src/client/payment.js', changeType: 'ADDED', additions: 38, deletions: 0 },
          { path: 'src/client/main.js', changeType: 'MODIFIED', additions: 2, deletions: 1 },
        ],
      }),
    );

    expect(inv.changedFiles).toHaveLength(2);
    expect(inv.changedFiles[0]).toEqual({
      path: 'src/client/payment.js',
      changeType: 'ADDED',
      additions: 38,
      deletions: 0,
    });
    // The totals the report shows are sums of real per-file counts.
    expect(inv.changedFiles.reduce((n, f) => n + f.additions, 0)).toBe(40);
    expect(inv.changedFiles.reduce((n, f) => n + f.deletions, 0)).toBe(1);
  });

  it('returns an empty list for a record written before this was tracked', () => {
    expect(toInvestigation(meta()).changedFiles).toEqual([]);
  });

  it('drops rows with no path rather than inventing one', () => {
    const inv = toInvestigation(
      meta({
        changedFiles: [
          { changeType: 'ADDED', additions: 5, deletions: 0 },
          null,
          'not-an-object',
          { path: 'src/real.js', changeType: 'MODIFIED', additions: 1, deletions: 1 },
        ],
      }),
    );
    expect(inv.changedFiles).toHaveLength(1);
    expect(inv.changedFiles[0]!.path).toBe('src/real.js');
  });

  it('falls back to MODIFIED for a change type it does not recognise', () => {
    const inv = toInvestigation(
      meta({ changedFiles: [{ path: 'a.js', changeType: 'EXPLODED', additions: 1, deletions: 0 }] }),
    );
    expect(inv.changedFiles[0]!.changeType).toBe('MODIFIED');
  });

  it('reports a binary file as zero rather than as a missing value', () => {
    // git cannot count lines in a binary file, so the investigator records
    // null. The schema has no way to express that, so it becomes zero and the
    // UI simply shows no +/- for the row.
    const inv = toInvestigation(
      meta({ changedFiles: [{ path: 'logo.png', changeType: 'ADDED', additions: null, deletions: null }] }),
    );
    expect(inv.changedFiles[0]!.additions).toBe(0);
    expect(inv.changedFiles[0]!.deletions).toBe(0);
  });

  it('never produces a negative count', () => {
    const inv = toInvestigation(
      meta({ changedFiles: [{ path: 'a.js', changeType: 'MODIFIED', additions: -4, deletions: -9 }] }),
    );
    expect(inv.changedFiles[0]!.additions).toBe(0);
    expect(inv.changedFiles[0]!.deletions).toBe(0);
  });

  it('ignores a changedFiles value that is not a list', () => {
    expect(toInvestigation(meta({ changedFiles: 'five' })).changedFiles).toEqual([]);
  });
});
