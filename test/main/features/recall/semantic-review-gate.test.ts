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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-semantic-gate-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
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
  return candidates.saveRecallCandidate('user-a', {
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

describe('Recall auto promotion × semantic review gate (N-2)', () => {
  it('defers the candidate when semantic review flags a MEDIUM+ finding', async () => {
    const { candidates } = await modules();
    const candidate = await pendingCandidate();
    semanticReviewMock.reviewCandidateSemantically.mockResolvedValue({
      ok: true,
      findings: [{ rule: 'semantic_sensitive_personal_data', level: 'MEDIUM', field: 'semantic', snippet: 'phone number', suggested_fix: 'Remove the personal identifier' }],
    });

    const result = await candidates.autoApplyRecallCandidate('user-a', candidate.id);

    expect(result.asset).toBeUndefined();
    expect(result.candidate.status).toBe('deferred');
    expect(result.candidate.failureCode).toBe('semantic_review_flagged');
    // 落账：review-decision 里留 defer 记录，列表层可据此抑制重复提示。
    const review = await import('../../../../src/main/features/cognition/review-decision');
    const decisions = await review.listReviewDecisions('user-a', `recall_candidate:${candidate.id}`);
    expect(decisions[decisions.length - 1]).toMatchObject({
      decision_type: 'defer',
      actor: 'system',
    });
    // 没有资产被创建。
    const { assets } = await modules();
    await expect(assets.listAbilityAssets('user-a')).resolves.toHaveLength(0);
  });

  it('promotes normally when semantic review finds nothing', async () => {
    const { candidates } = await modules();
    const candidate = await pendingCandidate();
    semanticReviewMock.reviewCandidateSemantically.mockResolvedValue({ ok: true, findings: [] });

    const result = await candidates.autoApplyRecallCandidate('user-a', candidate.id);

    expect(result.asset).toBeDefined();
    expect(result.candidate.status).toBe('confirmed');
    expect(result.asset.lifecycleStatus).toBe('automatically_extracted_unverified');
  });

  it('promotes normally when semantic review is unavailable (degraded, not blocked)', async () => {
    const { candidates } = await modules();
    const candidate = await pendingCandidate();
    semanticReviewMock.reviewCandidateSemantically.mockResolvedValue({ ok: false, reason: 'model_unavailable' });

    const result = await candidates.autoApplyRecallCandidate('user-a', candidate.id);

    expect(result.asset).toBeDefined();
    expect(result.candidate.status).toBe('confirmed');
  });

  it('keeps LOW findings advisory-only (no defer)', async () => {
    const { candidates } = await modules();
    const candidate = await pendingCandidate();
    semanticReviewMock.reviewCandidateSemantically.mockResolvedValue({
      ok: true,
      findings: [{ rule: 'semantic_overbroad_scope', level: 'LOW', field: 'semantic', snippet: 'maybe too broad', suggested_fix: 'Narrow the claim' }],
    });

    const result = await candidates.autoApplyRecallCandidate('user-a', candidate.id);

    expect(result.asset).toBeDefined();
    expect(result.candidate.status).toBe('confirmed');
  });

  it('does not re-review a deferred candidate (idempotent deferral)', async () => {
    const { candidates } = await modules();
    const candidate = await pendingCandidate();
    semanticReviewMock.reviewCandidateSemantically.mockResolvedValue({
      ok: true,
      findings: [{ rule: 'semantic_sensitive_personal_data', level: 'MEDIUM', field: 'semantic', snippet: 'phone number', suggested_fix: 'Remove the personal identifier' }],
    });

    await candidates.autoApplyRecallCandidate('user-a', candidate.id);
    const reviewCalls = semanticReviewMock.reviewCandidateSemantically.mock.calls.length;

    // deferred 候选不在 reviewable 集合 → 再次自动晋升应抛错，不再触发复核。
    await expect(candidates.autoApplyRecallCandidate('user-a', candidate.id)).rejects.toThrow(/not ready for automatic capture/i);
    expect(semanticReviewMock.reviewCandidateSemantically.mock.calls.length).toBe(reviewCalls);
  });
});
