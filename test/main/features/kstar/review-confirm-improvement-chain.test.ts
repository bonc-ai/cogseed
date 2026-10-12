/**
 * specs/015 T035（US-704）：`kstar.review.confirm` 处置后 review 落终态，并沿
 * **同一条**改进分析链路继续——即需求级沉淀入口 `precipitateRequirementLevel`
 * （US-701 的采用门 `improvement-admission.ts` 与四类结论 `improvement-outcome.ts`
 * 都收口在那条链上；finish/abandon/任务切换/静默自动闭环走的是同一个入口）。
 *
 * 验收点：确认后**要么出候选、要么出结论**，两条路径都有记录可查；`skip`
 * （需要修正）不产候选；缺归属上下文如实落结论；重复确认幂等；链路失败不阻断
 * review 落终态（best-effort）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KstarEpisodeRecord, KstarReviewRecord } from '../../../../src/main/features/kstar/types';
import type { KstarRequirementRecord } from '../../../../src/main/features/kstar/requirement-types';

// 语义查重不依赖真实 embedding 模型（测试环境无关性）：按文本哈希生成确定性
// 512 维向量——不同文本向量不同 → 查重走 no_match，沉淀链路照常走完。
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Array.from({ length: 512 }, (_, i) => Math.sin(h + i * 0.618) * 0.1);
  },
}));

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-confirm-improvement-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  // best-effort 失败用例用 `vi.doMock` 换掉分析入口；mock 注册表不随
  // `vi.resetModules()` 清空，显式撤销避免跨用例串台。
  vi.doUnmock('../../../../src/main/features/kstar/task-level-precipitation');
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

const GOAL = '为团队写一份验证报告';
const CONV = 'cid-confirm';

async function modules() {
  const [
    closure, episodeStore, reviewService, requirementStore, outcome, candidates,
    assets, usage, injections,
  ] = await Promise.all([
    import('../../../../src/main/features/kstar/task-closure'),
    import('../../../../src/main/features/kstar/episode-store'),
    import('../../../../src/main/features/kstar/review-service'),
    import('../../../../src/main/features/kstar/requirement-store'),
    import('../../../../src/main/features/kstar/improvement-outcome'),
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/asset-usage-receipt'),
    import('../../../../src/main/features/recall/injection-receipt'),
  ]);
  return { closure, episodeStore, reviewService, requirementStore, outcome, candidates, assets, usage, injections };
}

/** 改进对象：真实资产 v1（KStar 沉淀的目标方法）。 */
async function seedTargetAsset(userId: string): Promise<string> {
  const { candidates } = await modules();
  const seeded = await candidates.saveRecallCandidate(userId, {
    judgment: 'Keep the report verification rule.',
    value: 'Keep report verification consistent across runs.',
    summary: 'Report verification rule',
    suggestedType: 'rule',
    suggestedScope: 'report',
    suggestedAction: 'create',
    applicableWhen: ['处理报告类任务时'],
    sourceRefs: [{ kind: 'execution', id: 'kse-confirm-seed' }],
  });
  const promoted = await candidates.promoteRecallCandidate(userId, seeded.id, { actor: 'user' });
  return promoted.asset.id;
}

interface ConfirmScenario {
  userId: string;
  episodeId: string;
  runId: string;
  episode: KstarEpisodeRecord;
  requirement: KstarRequirementRecord;
  targetAssetId: string;
}

/**
 * 造一条"改既有方法"就绪的场景：episode 引用了唯一方法的 v1，复盘点名该方法
 * 已过时（`asset_outdated`）→ 聚合线会提一条 update 提案；是否放行由采用门
 * （必须有 v1 的 `applied` 回执）决定。
 *
 * `withIdentity: false` = 存量/退化 episode：不带 requirementId/taskId，也没有
 * 可解析的会话（sessionId 不是 `gconv-`），确认时找不到归属需求——用于验
 * "缺上下文如实落结论，不静默"。
 */
async function seedScenario(input: { userId: string; caseId: string; withIdentity?: boolean }): Promise<ConfirmScenario> {
  const { episodeStore, requirementStore } = await modules();
  const episodeId = `kse-confirm-${input.caseId}`;
  const runId = `run-confirm-${input.caseId}`;
  const now = '2026-09-25T00:00:00.000Z';
  const targetAssetId = await seedTargetAsset(input.userId);
  const task = requirementStore.createKstarTaskRecord(input.userId, {
    conversationId: CONV,
    title: `Confirm ${input.caseId}`,
  });
  const requirement = requirementStore.createKstarRequirementRecord(input.userId, {
    taskId: task.id,
    conversationId: CONV,
    userMessageIds: [`msg-${input.caseId}`],
    title: GOAL,
    goalText: GOAL,
  });
  await requirementStore.replaceKstarTask(input.userId, {
    ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id,
  });
  requirement.episodeIds = [episodeId];
  await requirementStore.replaceKstarRequirement(input.userId, requirement);
  const withIdentity = input.withIdentity !== false;
  const episode: KstarEpisodeRecord = {
    schemaVersion: 1,
    ownerId: input.userId,
    id: episodeId,
    // 有身份：`gconv-<cid>`（真实群聊 episode 形态）；无身份：不可解析的会话 id。
    sessionId: withIdentity ? `gconv-${CONV}` : `sess-${input.caseId}`,
    sessionKind: withIdentity ? 'group_chat' : 'cogseed_runtime',
    taskRunId: runId,
    ...(withIdentity ? { taskId: task.id, requirementId: requirement.id } : {}),
    s: { workspaceId: 'ws-confirm' },
    t: { userGoal: GOAL, constraints: [] },
    a: {
      toolCalls: [
        { name: 'read_file', status: 'ok', argumentsSummary: '{}' },
        { name: 'write_file', status: 'ok', argumentsSummary: '{}' },
      ],
      agentActions: [{ actor: 'commander', action: 'read_file' }],
    },
    r: { status: 'completed', producedFiles: [], finalText: '报告已生成。' },
    evidenceRefs: [{ kind: 'context', id: `ctx-${episodeId}` }],
    k: {
      memoryRefs: [],
      contextRefs: [],
      abilityAssetRefs: [targetAssetId],
      abilityAssetVersions: { [targetAssetId]: '1' },
    },
    createdAt: now,
    updatedAt: now,
  };
  await episodeStore.writeKstarEpisode(input.userId, episode);
  return { userId: input.userId, episodeId, runId, episode, requirement, targetAssetId };
}

/** 复盘：任务里用的那条方法「已过时」→ 聚合线提 update 提案；归因证据必须绑在
 *  该 episode 的证据上（复核记录的既有不变量）。 */
function outdatedReview(episodeId: string): Partial<KstarReviewRecord> {
  return {
    expectedResult: '报告按既有校验方法一次通过。',
    actualResult: '报告通过了，但校验方法漏掉了一个必填章节。',
    deltaR: 0.3,
    deltaA: 0.1,
    outcome: 'better_than_expected',
    attribution: 'execution_gap',
    reason: 'The verification rule in use missed a required section.',
    confidence: 0.9,
    attributionDetails: [{
      category: 'asset_outdated',
      confidence: 0.9,
      evidenceRefs: [{ kind: 'context', id: `ctx-${episodeId}` }],
      source: 'model',
    }],
  };
}

/** 复盘：带着一条可复用 lesson（确认 met 后这条 lesson 按既有语义不再保留）。 */
function lessonReview(): Partial<KstarReviewRecord> {
  return {
    expectedResult: '报告按预期完成。',
    actualResult: '报告按预期完成。',
    deltaR: 0.3,
    deltaA: 0.1,
    outcome: 'better_than_expected',
    attribution: 'execution_gap',
    reason: '这条经验值得复用。',
    confidence: 0.9,
    lesson: '先列大纲再写正文，能减少返工。',
  };
}

async function seedReview(userId: string, episodeId: string, review: Partial<KstarReviewRecord>): Promise<void> {
  const { reviewService, episodeStore } = await modules();
  const episode = await episodeStore.readKstarEpisode(userId, episodeId);
  const initial = reviewService.createInitialKstarReview(episode!);
  await reviewService.saveKstarReviewRecord(userId, { ...initial, ...review });
}

/** 与真实链路同序：先落注入回执（usage 回执的外键），再落使用回执。 */
async function recordAppliedUsage(userId: string, runId: string, assetId: string): Promise<void> {
  const { usage, injections } = await modules();
  const injection = await injections.recordInjectionReceipt(userId, {
    taskRunId: runId,
    projectionId: `proj-${runId}`,
    assetId,
    assetVersion: '1',
    boundary: 'real',
    status: 'injected',
    messageId: `message-${runId}`,
  });
  await usage.recordAssetUsageReceipt(userId, {
    taskRunId: runId,
    projectionId: `proj-${runId}`,
    assetId,
    assetVersion: '1',
    injectionReceiptId: injection.id,
    status: 'applied',
    evidenceKind: 'tool_call',
    evidenceRefs: [{ kind: 'conversation', id: `conv-${runId}` }],
    boundary: 'real',
  });
}

/** 候选 id 快照：确认前后对比，用来断言"没有产出 / 没有重复产出"。 */
async function candidateIds(userId: string): Promise<string[]> {
  const { candidates } = await modules();
  return (await candidates.listRecallCandidates(userId)).map((candidate) => candidate.id).sort();
}

describe('US-704 T035 复盘确认沿同一改进分析链路继续', () => {
  it('met：确认落终态后走同一链路 —— 至少一条记录可查（本例 = no_update 结论，零候选）', async () => {
    const { closure, outcome } = await modules();
    const userId = 'u-confirm-met';
    const scenario = await seedScenario({ userId, caseId: 'met' });
    // 确认前这条复盘带着 lesson 与正向度量差（本来够沉淀门槛）；met 确认按既有
    // 语义重建记录（不带 lesson、ΔR=0）→ 本次分析确实没有可沉淀增量。
    await seedReview(userId, scenario.episodeId, lessonReview());
    const before = await candidateIds(userId);

    const result = await closure.confirmKstarReview(userId, scenario.episodeId, { verdict: 'met' });

    // review 落用户确认的终态。
    expect(result.review).toMatchObject({
      reviewState: 'confirmed', inferenceMethod: 'user', outcome: 'met_expected', deltaR: 0,
    });
    // 验收点的通用形态：要么出候选、要么出结论，两者至少一个可查。
    const after = await candidateIds(userId);
    const record = await outcome.readKstarImprovementOutcome(userId, scenario.episodeId);
    expect(after.length > before.length || record !== null).toBe(true);
    // 本例的具体落点：确实没有达到沉淀门槛 → no_update（不是失败、不是候选）。
    expect(after).toEqual(before);
    expect(record).toMatchObject({
      id: `kio-${scenario.episodeId}`,
      conclusion: 'no_update',
      reviewId: `ksr-${scenario.episodeId}`,
      requirementId: scenario.requirement.id,
    });
    expect(record?.failureCategory).toBeUndefined();
  });

  it('partial：确认后同一链路的采用门放行 update 候选（回指原方法与版本）', async () => {
    const { closure, outcome, candidates } = await modules();
    const userId = 'u-confirm-partial';
    const scenario = await seedScenario({ userId, caseId: 'partial' });
    await seedReview(userId, scenario.episodeId, outdatedReview(scenario.episodeId));
    await recordAppliedUsage(userId, scenario.runId, scenario.targetAssetId);
    const before = await candidateIds(userId);

    await closure.confirmKstarReview(userId, scenario.episodeId, { verdict: 'partial' });

    // 出候选这一条路径同样有记录可查：候选回指原方法 + 任务当时用的版本。
    const after = await candidateIds(userId);
    expect(after.length).toBe(before.length + 1);
    const created = (await candidates.listRecallCandidates(userId))
      .find((candidate) => !before.includes(candidate.id));
    expect(created).toMatchObject({
      suggestedAction: 'update',
      targetAssetId: scenario.targetAssetId,
      targetVersionUsed: '1',
    });
    // 确认后的终态（用户口径）进了候选的学习信号。
    expect(created?.learningSignal?.outcome).toBe('worse_than_expected');
    // 成功路径不产"没出候选"的结论（结论只装实话）。
    expect(await outcome.readKstarImprovementOutcome(userId, scenario.episodeId)).toBeNull();
  });

  it('skip（需要修正）：不产候选，只如实落一条结论留痕', async () => {
    const { closure, outcome } = await modules();
    const userId = 'u-confirm-skip';
    // 与 partial 用例同一套"就绪"场景（有 applied 证据、更新型提案齐备）——
    // 若链路被触发，这里一定会出候选；skip 的落点因此可判定。
    const scenario = await seedScenario({ userId, caseId: 'skip' });
    await seedReview(userId, scenario.episodeId, outdatedReview(scenario.episodeId));
    await recordAppliedUsage(userId, scenario.runId, scenario.targetAssetId);
    const before = await candidateIds(userId);

    const result = await closure.confirmKstarReview(userId, scenario.episodeId, { verdict: 'skip' });

    // 复盘落"未定"终态；零候选。
    expect(result.review).toMatchObject({ reviewState: 'unknown', outcome: 'unclear', needsConfirmation: false });
    expect(await candidateIds(userId)).toEqual(before);
    // 但**不静默**：如实落一条结论，说清为什么没有候选。
    const record = await outcome.readKstarImprovementOutcome(userId, scenario.episodeId);
    expect(record).toMatchObject({
      conclusion: 'insufficient_evidence',
      reviewId: `ksr-${scenario.episodeId}`,
    });
    expect(record?.reason).toContain('需要修正');
    expect(record?.failureCategory).toBeUndefined();
  });

  it('缺归属需求：如实落一条 insufficient_evidence 结论，不是静默什么都不做', async () => {
    const { closure, outcome, episodeStore } = await modules();
    const userId = 'u-confirm-noreq';
    const scenario = await seedScenario({ userId, caseId: 'noreq', withIdentity: false });
    await seedReview(userId, scenario.episodeId, lessonReview());
    const before = await candidateIds(userId);

    const result = await closure.confirmKstarReview(userId, scenario.episodeId, { verdict: 'partial' });

    // 终态照落（缺上下文不影响确认本身）。
    expect(result.review.reviewState).toBe('confirmed');
    expect(await candidateIds(userId)).toEqual(before);
    // 改进分析链路没有可分析范围 → 结论如实说明缺的是"任务归属"。
    const record = await outcome.readKstarImprovementOutcome(userId, scenario.episodeId);
    expect(record?.conclusion).toBe('insufficient_evidence');
    expect(record?.reason).toContain('没有归属到任务需求');
    expect(record?.failureCategory).toBeUndefined();
    // 记录里只有摘要与 id（只读回原文，不出现复盘正文）。
    const raw = await episodeStore.readKstarJsonRecord(userId, 'improvement-outcomes', `kio-${scenario.episodeId}`);
    expect(JSON.stringify(raw)).not.toContain('先列大纲再写正文');
  });

  it('重复确认幂等：结论仍一条（createdAt 不变）、候选不重复生成', async () => {
    const { closure, outcome } = await modules();
    const metUser = 'u-confirm-met-twice';
    const metScenario = await seedScenario({ userId: metUser, caseId: 'met2' });
    await seedReview(metUser, metScenario.episodeId, lessonReview());

    await closure.confirmKstarReview(metUser, metScenario.episodeId, { verdict: 'met' });
    const first = await outcome.readKstarImprovementOutcome(metUser, metScenario.episodeId);
    await closure.confirmKstarReview(metUser, metScenario.episodeId, { verdict: 'met' });

    // 结论仍一条：同一派生 id 覆盖写，createdAt 保留首次写入值。
    expect((await outcome.listKstarImprovementOutcomes(metUser)).filter(
      (item) => item.episodeId === metScenario.episodeId,
    )).toHaveLength(1);
    expect(await outcome.readKstarImprovementOutcome(metUser, metScenario.episodeId)).toMatchObject({
      id: `kio-${metScenario.episodeId}`, createdAt: first!.createdAt, conclusion: 'no_update',
    });
    expect(fs.readdirSync(path.join(root, metUser, 'cloud', 'kstar', 'improvement-outcomes')))
      .toEqual([`kio-${metScenario.episodeId}.json`]);

    // 候选侧：同一 captureKey → 同一条候选，不产生第二个成功对象。
    const partialUser = 'u-confirm-partial-twice';
    const partialScenario = await seedScenario({ userId: partialUser, caseId: 'partial2' });
    await seedReview(partialUser, partialScenario.episodeId, outdatedReview(partialScenario.episodeId));
    await recordAppliedUsage(partialUser, partialScenario.runId, partialScenario.targetAssetId);

    await closure.confirmKstarReview(partialUser, partialScenario.episodeId, { verdict: 'partial' });
    const afterFirst = await candidateIds(partialUser);
    await closure.confirmKstarReview(partialUser, partialScenario.episodeId, { verdict: 'partial' });

    expect(await candidateIds(partialUser)).toEqual(afterFirst);
    expect(await outcome.readKstarImprovementOutcome(partialUser, partialScenario.episodeId)).toBeNull();
  });

  it('链路失败 best-effort：不阻断 review 落终态，且如实落 analysis_failed（不是 no_update）', async () => {
    // 分析入口抛错（模型/推理不可用一类）：确认必须照旧成功、终态照旧落盘。
    vi.doMock('../../../../src/main/features/kstar/task-level-precipitation', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../../src/main/features/kstar/task-level-precipitation')>()),
      precipitateRequirementLevel: async () => {
        throw new Error('simulated improvement analysis failure');
      },
    }));
    vi.resetModules();
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const outcome = await import('../../../../src/main/features/kstar/improvement-outcome');
    const reviewService = await import('../../../../src/main/features/kstar/review-service');
    const userId = 'u-confirm-fail';
    const scenario = await seedScenario({ userId, caseId: 'fail' });
    await seedReview(userId, scenario.episodeId, outdatedReview(scenario.episodeId));

    const result = await closure.confirmKstarReview(userId, scenario.episodeId, { verdict: 'partial' });

    // review 的终态在链路之前已落盘，链路失败改不了它。
    expect(result.review.reviewState).toBe('confirmed');
    expect((await reviewService.readKstarReview(userId, scenario.episodeId))?.reviewState).toBe('confirmed');
    // 失败如实归因，不得退化成"无需更新"。
    const record = await outcome.readKstarImprovementOutcome(userId, scenario.episodeId);
    expect(record?.conclusion).toBe('analysis_failed');
    expect(record?.conclusion).not.toBe('no_update');
    expect(record?.failureCategory).toBe('unknown');
    expect(record?.requirementId).toBe(scenario.requirement.id);
  });
});
