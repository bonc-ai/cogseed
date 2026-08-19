/**
 * 候选「可确认」契约：审批阶段与晋升阶段必须用同一套准入语义。
 *
 * 这一批测试守的是一条产品不变量：
 *   **UI 展示 canPromote=true 的候选，在状态未变的前提下 promote 不得因
 *   classification / formal asset bar 被拒。**
 *
 * 回归历史（docs/recall-candidate-promotion-audit.md）：分类不合格的候选曾经
 * 被 forceWeakObservation 压成 weak_observation 后照常落库，而 weak_observation
 * 在能力表里是完全可操作的——于是它以普通待确认候选的样子进「待我处理」，
 * 用户认真审批、点确认，promoteRecallCandidate 里的同一道闸再拒一次。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

import { getRecallCandidateCapabilities } from '../../../../src/main/features/recall/candidate-capabilities';
import { buildCognitionInbox } from '../../../../src/main/features/recall/formal-assets/inbox';

/** 项目事实伪装成 personal —— PRD 3.4 明确排除，classification 阻断。 */
const PROJECT_FACT = {
  judgment: '我今天在修 KSTAR 的候选池',
  summary: '当前任务',
  value: '记录当前进度',
  suggestedType: 'personal' as const,
  suggestedScope: 'project',
  suggestedAction: 'create' as const,
};

/** 真正的长期偏好 —— 过闸。 */
const DURABLE_PREFERENCE = {
  judgment: '我长期更喜欢先看整体结构再看细节',
  summary: '结构优先',
  value: '后续任务先给结构再展开，可以少一轮返工',
  suggestedType: 'personal' as const,
  suggestedScope: 'global',
  suggestedAction: 'create' as const,
};

const REFS = [{ kind: 'conversation', id: 'conv-1' }];

function inboxCandidate(id: string, content: typeof PROJECT_FACT, status = 'weak_observation') {
  return { id, status, ...content, sourceRefs: REFS, evidenceRefs: REFS };
}

describe('TG-01 分类不合格的候选不得作为普通可确认待办', () => {
  it('能力判据关掉确认与晋升，并给出可翻译的阻断原因', () => {
    const caps = getRecallCandidateCapabilities({
      status: 'weak_observation', risk: 'low', sourceRefs: REFS, evidenceRefs: REFS, ...PROJECT_FACT,
    });
    expect(caps.eligibility).toBe('ineligible');
    expect(caps.ineligibleReasons).toContain('personal_is_project_fact');
    expect(caps.canPromote).toBe(false);
    expect(caps.canConfirm).toBe(false);
    expect(caps.canBatchSelect).toBe(false);
    // 方案 B：仍然看得见、改得动、否得掉。
    expect(caps.canView).toBe(true);
    expect(caps.canEdit).toBe(true);
    expect(caps.canReject).toBe(true);
  });

  it('「待我处理」把它出成 candidate_ineligible，而不是 candidate_pending_review', () => {
    const items = buildCognitionInbox({
      assets: [], candidates: [inboxCandidate('c-bad', PROJECT_FACT)],
      unavailableSourceIds: new Set(), latestDiffs: new Map(),
    } as never);
    const kinds = items.map((entry) => entry.kind);
    expect(kinds).toContain('candidate_ineligible');
    expect(kinds).not.toContain('candidate_pending_review');
    expect(items.find((entry) => entry.kind === 'candidate_ineligible')?.detail)
      .toContain('personal_is_project_fact');
  });

  it('合格候选仍然正常进入 candidate_pending_review', () => {
    const items = buildCognitionInbox({
      assets: [], candidates: [inboxCandidate('c-good', DURABLE_PREFERENCE)],
      unavailableSourceIds: new Set(), latestDiffs: new Map(),
    } as never);
    expect(items.map((entry) => entry.kind)).toEqual(['candidate_pending_review']);
  });

  it('内容字段缺失时不收紧——只带状态与证据的旧调用方仍然可操作', () => {
    const caps = getRecallCandidateCapabilities({
      status: 'pending_review', risk: 'low', sourceRefs: REFS, evidenceRefs: REFS,
    });
    expect(caps.eligibility).toBe('eligible');
    expect(caps.canPromote).toBe(true);
  });
});

describe('TG-03 Inbox 与 Tree 消费同一套 eligibility', () => {
  it('同一条候选在两边得到同一个 canPromote', () => {
    const input = {
      status: 'weak_observation' as const, risk: 'low' as const,
      sourceRefs: REFS, evidenceRefs: REFS, ...PROJECT_FACT,
    };
    // 树的芽判据（tree-service::isBudCandidate）取的就是这个 canPromote。
    const treeCanPromote = getRecallCandidateCapabilities(input).canPromote;
    const items = buildCognitionInbox({
      assets: [], candidates: [inboxCandidate('c-bad', PROJECT_FACT)],
      unavailableSourceIds: new Set(), latestDiffs: new Map(),
    } as never);
    const inboxTreatsAsConfirmable = items.some((entry) => entry.kind === 'candidate_pending_review');
    expect(treeCanPromote).toBe(false);
    expect(inboxTreatsAsConfirmable).toBe(false);
    expect(inboxTreatsAsConfirmable).toBe(treeCanPromote);
  });

  it('跨候选分类冲突两边都判得出来（conflictingTypes 传入时）', () => {
    const conflicted = getRecallCandidateCapabilities({
      status: 'pending_review', risk: 'low', sourceRefs: REFS, evidenceRefs: REFS,
      ...DURABLE_PREFERENCE, conflictingTypes: ['rule'],
    });
    expect(conflicted.eligibility).toBe('ineligible');
    expect(conflicted.ineligibleReasons).toContain('type_conflicts_with_existing');
    expect(conflicted.canPromote).toBe(false);
  });
});

describe('候选 eligibility 的落库与编辑行为', () => {
  let tmpDir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-eligibility-'));
    previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
    process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
    else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const service = () => import('../../../../src/main/features/recall/candidate-service');

  it('TG-02 编辑不得把分类不合格的候选洗成 pending_review', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('u1', {
      ...PROJECT_FACT, sourceRefs: REFS as never, forceWeakObservation: true,
    });
    expect(saved.status).toBe('weak_observation');

    // 只改摘要，内容仍是项目事实 —— 状态必须原地不动。
    const edited = await candidates.updateRecallCandidate('u1', saved.id, {
      ...PROJECT_FACT, summary: '当前任务（改过）', sourceRefs: REFS as never,
    });
    expect(edited.status).toBe('weak_observation');
  });

  it('TG-02 真正改成合格内容后允许迁回 pending_review', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('u1', {
      ...PROJECT_FACT, sourceRefs: REFS as never, forceWeakObservation: true,
    });
    const fixed = await candidates.updateRecallCandidate('u1', saved.id, {
      ...DURABLE_PREFERENCE, sourceRefs: REFS as never,
    });
    expect(fixed.status).toBe('pending_review');
    expect(getRecallCandidateCapabilities(fixed).canPromote).toBe(true);
  });

  it('TG-06 可确认候选真实走通 promote → 正式资产', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('u1', {
      ...DURABLE_PREFERENCE, sourceRefs: REFS as never,
    });
    expect(getRecallCandidateCapabilities(saved).canPromote).toBe(true);

    const promoted = await candidates.promoteRecallCandidate('u1', saved.id, { actor: 'user' });
    expect(promoted.candidate.status).toBe('confirmed');
    expect(promoted.candidate.promotedAssetId).toBeTruthy();
    // 真的落出了一条正式资产，不是只把候选标成 confirmed。
    expect(promoted.asset.id).toBe(promoted.candidate.promotedAssetId);
    expect(promoted.asset.type).toBe('personal');
  });

  it('不变量：canPromote 为 true 的候选，promote 不因 formal asset bar 被拒', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('u1', {
      ...DURABLE_PREFERENCE, sourceRefs: REFS as never,
    });
    const before = await candidates.readRecallCandidate('u1', saved.id);
    expect(getRecallCandidateCapabilities(before).canPromote).toBe(true);

    // updatedAt 未变（没有其它路径改过它），promote 必须成功。
    await expect(candidates.promoteRecallCandidate('u1', before.id, { actor: 'user' }))
      .resolves.toMatchObject({ candidate: { status: 'confirmed' } });
  });

  it('最后一道防线仍在：不合格候选即使绕过 UI 直接 promote 也会被拒', async () => {
    const candidates = await service();
    const saved = await candidates.saveRecallCandidate('u1', {
      ...PROJECT_FACT, sourceRefs: REFS as never, forceWeakObservation: true,
    });
    expect(getRecallCandidateCapabilities(saved).canPromote).toBe(false);
    await expect(candidates.promoteRecallCandidate('u1', saved.id, { actor: 'user' }))
      .rejects.toMatchObject({ code: 'promotion_blocked' });
  });
});
