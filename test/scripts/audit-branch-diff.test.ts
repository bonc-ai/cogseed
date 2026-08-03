import { describe, expect, it } from 'vitest';
import {
  buildBranchAudit,
  classifyBranchChanges,
  parseCommitRows,
  parseMergeBase,
  parseNameStatusZ,
  sanitizeRef,
} from '../../scripts/audit-branch-diff.mjs';

describe('branch diff audit', () => {
  it('parses merge-base and commit rows without losing subjects', () => {
    expect(parseMergeBase('  abc123\n')).toBe('abc123');
    expect(parseCommitRows('abc123\tAdd provider\ndef456\tFix\twith tab\n')).toEqual([
      { hash: 'abc123', subject: 'Add provider' },
      { hash: 'def456', subject: 'Fix\twith tab' },
    ]);
  });

  it('parses NUL-delimited name-status output including renames', () => {
    expect(parseNameStatusZ('M\0src/provider.ts\0R100\0old.ts\0new.ts\0A\0new.ts\0')).toEqual([
      { status: 'M', paths: ['src/provider.ts'] },
      { status: 'R100', paths: ['old.ts', 'new.ts'] },
      { status: 'A', paths: ['new.ts'] },
    ]);
  });

  it('classifies exact overlaps as duplicate, differing overlaps as parallel, and disjoint paths as independent', () => {
    expect(classifyBranchChanges({
      left: [{ path: 'provider.ts', blob: 'same' }, { path: 'governance.ts', blob: 'left' }],
      right: [{ path: 'provider.ts', blob: 'same' }, { path: 'reimbursement.ts', blob: 'right' }],
    })).toEqual({
      duplicate: [{ path: 'provider.ts', leftBlob: 'same', rightBlob: 'same' }],
      parallel: [],
      independent: [
        { side: 'left', path: 'governance.ts', blob: 'left' },
        { side: 'right', path: 'reimbursement.ts', blob: 'right' },
      ],
    });

    expect(classifyBranchChanges({
      left: [{ path: 'provider.ts', blob: 'left' }],
      right: [{ path: 'provider.ts', blob: 'right' }],
    }).parallel).toEqual([{ path: 'provider.ts', leftBlob: 'left', rightBlob: 'right' }]);
  });

  it('builds a stable JSON-safe report with unique commits and classifications', () => {
    const report = buildBranchAudit({
      root: '/repo',
      baseRef: 'HEAD',
      targetRef: 'origin/dev/team',
      mergeBase: 'base123',
      leftTip: 'left123',
      rightTip: 'right123',
      leftCommits: [{ hash: 'l1', subject: 'Governance' }],
      rightCommits: [{ hash: 'r1', subject: 'Reimbursement' }],
      leftPaths: [{ path: 'governance.ts', blob: 'lblob' }],
      rightPaths: [{ path: 'reimbursement.ts', blob: 'rblob' }],
    });

    expect(report).toMatchObject({
      schema: 1,
      mergeBase: 'base123',
      uniqueCommits: { current: [{ hash: 'l1', subject: 'Governance' }], target: [{ hash: 'r1', subject: 'Reimbursement' }] },
      classifications: { duplicate: [], parallel: [], independent: expect.any(Array) },
    });
    expect(report.paths.overlap).toEqual([]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('sanitizes refs for report filenames', () => {
    expect(sanitizeRef('origin/dev/team name:1')).toBe('origin-dev-team-name-1');
    expect(sanitizeRef('///')).toBe('ref');
  });
});
