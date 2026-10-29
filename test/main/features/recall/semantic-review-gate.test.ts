import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 语义复核（N-2）：自动晋升出口接入模型级复核，命中语义发现时候选降级为
// deferred 留给用户，复核不可用时不阻断（纯确定性闸兜底）。
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

const semanticReviewMock = vi.hoisted(() => ({
  reviewCandidateSemantically: vi.fn(),
}));

vi.mock('../../../../src/main/features/cognition/semantic-review', () => ({
  reviewCandidateSemantically: semanticReviewMock.reviewCandidateSemantically,
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  semanticReviewMock.reviewCandidateSemantically.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-semantic-gate-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
  ]);
  return { candidates, assets };
}

async function pendingCandidate() {
  const { candidates } = await modules();
  return createNightlyCandidateFixture('user-a', {
    judgment: 'Keep architecture decisions in a decision log before changing runtime boundaries.',
    summary: 'Use decision logs for architecture changes',
    suggestedType: 'rule',
    applicableWhen: ['Architecture review and runtime-boundary changes'],
    forbiddenWhen: ['Informal brainstorming without a decision'],
    suggestedScope: 'review,project',
    suggestedAction: 'create',
    sourceRefs: [{ kind: 'conversation', id: 'conv-semantic-gate' }],
  });
}

describe('自动来源只能形成候选，模型语义复核不能替代用户授权', () => {
  it.each([
    { name: '模型发现高风险', response: { ok: true, findings: [{ level: 'MEDIUM', rule: 'semantic_sensitive_personal_data' }] } },
    { name: '模型认为没有问题', response: { ok: true, findings: [] } },
    { name: '模型不可用', response: { ok: false, reason: 'model_unavailable' } },
    { name: '模型只有低风险提示', response: { ok: true, findings: [{ level: 'LOW', rule: 'advisory' }] } },
  ])('$name 不得发布资产或自行决定候选', async ({ response }) => {
    const { candidates, assets } = await modules();
    const candidate = await pendingCandidate();
    semanticReviewMock.reviewCandidateSemantically.mockResolvedValue(response);
    const result = await candidates.autoApplyRecallCandidate('user-a', candidate.id);
    expect(result.asset).toBeUndefined();
    expect(result.candidate).toMatchObject({ id: candidate.id, status: candidate.status, sourceRefs: candidate.sourceRefs });
    expect(semanticReviewMock.reviewCandidateSemantically).not.toHaveBeenCalled();
    await expect(assets.listAbilityAssets('user-a')).resolves.toHaveLength(0);
    const review = await import('../../../../src/main/features/cognition/review-decision');
    await expect(review.listReviewDecisions('user-a', `recall_candidate:${candidate.id}`)).resolves.toEqual([]);
  });
  it('重复自动调用保持候选身份、原文和待处理状态，不能产生版本或决定', async () => {
    const { candidates, assets } = await modules();
    const candidate = await pendingCandidate();
    const first = await candidates.autoApplyRecallCandidate('user-a', candidate.id);
    const retry = await candidates.autoApplyRecallCandidate('user-a', candidate.id);
    expect(retry).toEqual(first);
    expect(retry.candidate.judgment).toBe(candidate.judgment);
    await expect(assets.listAbilityAssets('user-a')).resolves.toHaveLength(0);
  });
});
