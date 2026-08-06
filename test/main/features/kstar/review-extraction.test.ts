import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-review-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function episode(toolCalls: Array<{ name: string; status?: 'ok' | 'error' | 'unknown' }> = []) {
  return {
    schemaVersion: 1 as const,
    ownerId: 'review-user',
    id: 'kse-run-review',
    sessionId: 'mruntime-review',
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: {},
    t: { userGoal: 'Create a reliable report.', constraints: [] },
    a: { toolCalls, agentActions: [] },
    r: { status: 'completed' as const, finalText: 'Done.', producedFiles: [] },
    evidenceRefs: [{ kind: 'execution' as const, id: 'run-review' }],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  };
}

describe('KSTAR review and Recall bridge', () => {
  it('keeps initial review unclear when expectation or verification evidence is missing', async () => {
    const { createInitialKstarReview } = await import('../../../../src/main/features/kstar/review-service');
    expect(createInitialKstarReview(episode())).toMatchObject({
      id: 'ksr-kse-run-review',
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'unclear',
      attribution: 'unclear',
      confidence: 0,
    });
  });

  it('does not extract a candidate from an unverified one-tool episode', async () => {
    const [{ createInitialKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = episode([{ name: 'read_file', status: 'ok' }]);
    expect(proposeKstarCandidates(current, createInitialKstarReview(current))).toEqual([]);
  });

  it('extracts one bounded skill-method proposal from a verified multi-tool workflow', async () => {
    const [{ createInitialKstarReview }, { proposeKstarCandidates }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
    ]);
    const current = episode([
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);
    const proposals = proposeKstarCandidates(current, createInitialKstarReview(current));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      suggestedType: 'skill_method',
      suggestedScope: 'report',
      sourceRefs: [expect.objectContaining({ kind: 'execution', id: current.id })],
    });
  });

  it('bridges an explicitly reviewed gap into a pending Recall candidate only', async () => {
    const [{ saveKstarReview }, { proposeKstarCandidates }, { saveKstarCandidateProposals }] = await Promise.all([
      import('../../../../src/main/features/kstar/review-service'),
      import('../../../../src/main/features/kstar/extraction-service'),
      import('../../../../src/main/features/kstar/recall-bridge'),
    ]);
    const current = episode();
    const review = await saveKstarReview('review-user', current, {
      deltaR: -0.8,
      deltaA: 0.2,
      outcome: 'worse_than_expected',
      attribution: 'rule_gap',
      reason: 'Check the report acceptance criteria before writing the final file.',
      confidence: 0.9,
      evidenceRefs: current.evidenceRefs,
    });
    const proposals = proposeKstarCandidates(current, review);
    const candidates = await saveKstarCandidateProposals('review-user', proposals);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ status: 'pending', suggestedType: 'rule' });
    expect(fs.existsSync(path.join(tmpDir, 'review-user', 'cloud', 'recall', 'records', 'ability-assets'))).toBe(false);
  });
});
