import { createNightlyCandidateFixture } from '../helpers/nightly-formation-fixture';
/** 后台自动整理不处置候选：并发用户拒绝必须保持终态，不能重新进入待办。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

const semanticReviewMock = vi.hoisted(() => ({
  reviewCandidateSemantically: vi.fn(),
}));
vi.mock('../../src/main/features/cognition/semantic-review', () => ({
  reviewCandidateSemantically: semanticReviewMock.reviewCandidateSemantically,
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  semanticReviewMock.reviewCandidateSemantically.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-sm3a-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  return import('../../src/main/features/recall/candidate-service');
}

async function pendingCandidate() {
  const candidates = await import('../../src/main/features/recall/candidate-service');
  return createNightlyCandidateFixture('user-a', {
    judgment: 'Keep architecture decisions in a decision log before changing runtime boundaries.',
    summary: 'Use decision logs for architecture changes',
    suggestedType: 'rule',
    applicableWhen: ['Architecture review and runtime-boundary changes'],
    forbiddenWhen: ['Informal brainstorming without a decision'],
    suggestedScope: 'review,project',
    suggestedAction: 'create',
    sourceRefs: [{ kind: 'conversation', id: 'conv-sm3-terminal' }],
  });
}

describe('自动整理与用户终态一致性', () => {
  it('用户先拒绝后，自动入口保持终态且不调用模型', async () => {
    const candidates = await modules();
    const candidate = await pendingCandidate();
    const rejected = await candidates.rejectRecallCandidate('user-a', candidate.id, '用户不要');
    await expect(candidates.autoApplyRecallCandidate('user-a', candidate.id)).resolves.toEqual({ candidate: rejected });
    expect(semanticReviewMock.reviewCandidateSemantically).not.toHaveBeenCalled();
    expect(await candidates.readRecallCandidate('user-a', candidate.id)).toEqual(rejected);
  });

  it('后台调用与用户拒绝并发时，不覆写 rejected 或产生正式资产', async () => {
    const candidates = await modules();
    const candidate = await pendingCandidate();
    await Promise.all([
      candidates.autoApplyRecallCandidate('user-a', candidate.id),
      candidates.rejectRecallCandidate('user-a', candidate.id, '用户不要'),
    ]);
    const after = await candidates.readRecallCandidate('user-a', candidate.id);
    expect(after.status).toBe('rejected');
    expect(after.failureCode).toBeUndefined();
    expect(after.promotedAssetId).toBeUndefined();
    await expect(candidates.autoApplyRecallCandidate('user-a', candidate.id)).resolves.toEqual({ candidate: after });
    expect(semanticReviewMock.reviewCandidateSemantically).not.toHaveBeenCalled();
    expect(await candidates.readRecallCandidate('user-a', candidate.id)).toEqual(after);
  });
});
