import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  KstarCandidateProposal,
  KstarEpisodeRecord,
  KstarReviewRecord,
} from '../../../../src/main/features/kstar/types';

// 标题闸门（设计 3.2）后晋升链对不合规 summary 走 LLM 起标题；本文件的候选
// 由 KStar 抽取/即时直投内生生成（summary＝模板拼接或正文首句），单测无模型，
// mock 出确定性合规标题（与 asset-title-suggestion.test.ts 同一边界口径）。
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({
  suggestAbilityAssetTitle: async () => ({ title: '模型重起的样本标题' }),
}));

// specs/015 US-701（T017/T018）：改进候选的**关联与依据链** + **四态反馈与幂等**。
//
// 测的是两条沉淀线的真实接线：
//  · 需求级 `precipitateRequirementLevel`（任务/需求收口触发）
//  · 直通线 `precipitateDirectExperienceAssets`（episode 级入口）
// 两条线都必须经同一个采用门（`improvement-admission.ts`）：更新型提案
// （update/limit_scope/pause + targetAssetId）**没有 `applied` 回执就不落候选**；
// 「被带入」（注入回执 injected/dispatched）不算采用。

// 语义查重不依赖真实 embedding 模型（95MB ONNX，测试环境无关性）：按文本
// 哈希生成确定性 512 维向量——不同文本向量不同 → 查重走 no_match 正常晋升。
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-improvement-association-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  // 需求级提交失败那一条用例用 `vi.doMock` 模拟出口抛错；mock 注册表不随
  // `vi.resetModules()` 清空，下一例会拿到"上一次 mock 里的原始实例"（它的
  // 工作区根还停在上一个临时目录）。显式撤销，避免跨用例串台。
  vi.doUnmock('../../../../src/main/features/kstar/direct-experience-assets');
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

const USER = 'user-assoc';
const EPISODE = 'kse-assoc-b';
const RUN = 'run-assoc-b';
const GOAL = 'Build the report with verified tooling';

async function modules() {
  const [
    precipitation, direct, outcome, usage, injections, candidates, assets,
    failures, reviewService, episodeStore, requirementStore,
  ] = await Promise.all([
    import('../../../../src/main/features/kstar/task-level-precipitation'),
    import('../../../../src/main/features/kstar/direct-experience-assets'),
    import('../../../../src/main/features/kstar/improvement-outcome'),
    import('../../../../src/main/features/recall/asset-usage-receipt'),
    import('../../../../src/main/features/recall/injection-receipt'),
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/kstar/failure-service'),
    import('../../../../src/main/features/kstar/review-service'),
    import('../../../../src/main/features/kstar/episode-store'),
    import('../../../../src/main/features/kstar/requirement-store'),
  ]);
  return {
    precipitation, direct, outcome, usage, injections, candidates, assets,
    failures, reviewService, episodeStore, requirementStore,
  };
}

/** 目标方法（改进对象）：真实资产，v1 生效。 */
async function seedTargetAsset(): Promise<string> {
  const { candidates } = await modules();
  const seeded = await candidates.saveRecallCandidate(USER, {
    judgment: 'Keep the report verification rule.',
    value: 'Keep report verification consistent across runs.',
    suggestedType: 'rule',
    suggestedScope: 'report',
    suggestedAction: 'create',
    applicableWhen: ['处理报告类任务时'],
    sourceRefs: [{ kind: 'execution', id: 'kse-assoc-seed' }],
  });
  const promoted = await candidates.promoteRecallCandidate(USER, seeded.id, { actor: 'user' });
  return promoted.asset.id;
}

async function seedEpisode(input: {
  id?: string;
  runId?: string;
  targetAssetId: string;
  /** 缺省（undefined）= 存量老数据：episode 只留引用、不留任务当时用的版本。 */
  usedVersion?: string;
  status?: KstarEpisodeRecord['r']['status'];
}): Promise<KstarEpisodeRecord> {
  const { episodeStore } = await modules();
  const id = input.id ?? EPISODE;
  const now = '2026-09-20T00:00:00.000Z';
  const episode: KstarEpisodeRecord = {
    schemaVersion: 1,
    ownerId: USER,
    id,
    sessionId: `sess-${id}`,
    sessionKind: 'cogseed_runtime',
    taskRunId: input.runId ?? RUN,
    projectionId: `proj-${id}`,
    s: { workspaceId: 'ws-assoc' },
    t: { userGoal: GOAL, constraints: [] },
    a: {
      toolCalls: [
        { name: 'read_file', status: 'ok', argumentsSummary: '{}' },
        { name: 'write_file', status: 'ok', argumentsSummary: '{}' },
      ],
      agentActions: [{ actor: 'runtime', action: 'read_file' }],
    },
    r: { status: input.status ?? 'completed', producedFiles: [], finalText: 'done' },
    evidenceRefs: [{ kind: 'context', id: `ctx-${id}` }],
    k: {
      memoryRefs: [],
      contextRefs: [],
      abilityAssetRefs: [input.targetAssetId],
      ...(input.usedVersion === undefined
        ? {}
        : { abilityAssetVersions: { [input.targetAssetId]: input.usedVersion } }),
    },
    createdAt: now,
    updatedAt: now,
  };
  await episodeStore.writeKstarEpisode(USER, episode);
  return episode;
}

/** 复盘：任务里用的那条方法「已过时」→ 更新型提案（update + 版本锚）。
 *  归因细节的证据必须绑在该 episode 的证据上（复核记录的既有不变量）。 */
function updateReview(episodeId: string = EPISODE): Partial<KstarReviewRecord> {
  return {
    expectedResult: '报告按既有校验方法一次通过。',
    actualResult: '报告通过了，但校验方法漏掉了一个必填章节。',
    deltaR: 0.3,
    deltaA: 0.1,
    outcome: 'better_than_expected',
    attribution: 'execution_gap',
    reason: 'The verification rule in use missed a required section.',
    confidence: 0.9,
    lesson: 'Report verification must check every required section before delivery.',
    attributionDetails: [{
      category: 'asset_outdated',
      confidence: 0.9,
      evidenceRefs: [{ kind: 'context', id: `ctx-${episodeId}` }],
      source: 'model',
    }],
  };
}

/** 复盘：结果符合预期、无可复用增量 → 沉淀闸门不达阈（no_update 的那一类）。 */
function routineReview(): Partial<KstarReviewRecord> {
  return {
    expectedResult: '报告按预期完成。',
    actualResult: '报告按预期完成。',
    deltaR: 0,
    deltaA: 0,
    outcome: 'met_expected',
    attribution: 'unclear',
    reason: '任务按预期完成。',
    confidence: 0.95,
  };
}

async function seedReview(episodeId: string, review: Partial<KstarReviewRecord>): Promise<void> {
  const { reviewService, episodeStore } = await modules();
  const episode = await episodeStore.readKstarEpisode(USER, episodeId);
  const initial = reviewService.createInitialKstarReview(episode!);
  await reviewService.saveKstarReviewRecord(USER, { ...initial, ...review });
}

async function seedRequirement(
  episodeIds: string[] = [EPISODE],
): Promise<import('../../../../src/main/features/kstar/requirement-types').KstarRequirementRecord> {
  const { requirementStore } = await modules();
  const task = requirementStore.createKstarTaskRecord(USER, { conversationId: 'cid-assoc', title: 'Assoc task' });
  const requirement = requirementStore.createKstarRequirementRecord(USER, {
    taskId: task.id,
    conversationId: 'cid-assoc',
    userMessageIds: ['msg-assoc'],
    title: GOAL,
    goalText: GOAL,
  });
  requirement.episodeIds = episodeIds;
  await requirementStore.replaceKstarTask(USER, {
    ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id,
  });
  await requirementStore.replaceKstarRequirement(USER, requirement);
  return requirement;
}

type UsageStatus =
  | 'applied'
  | 'considered_not_applicable'
  | 'available_no_opportunity'
  | 'contradicted'
  | 'usage_unknown';

/** 与真实链路同序：先落注入回执（usage 回执的外键），再落使用回执。 */
async function recordUsage(input: {
  taskRunId?: string;
  assetId: string;
  assetVersion?: string;
  status: UsageStatus;
  injectionStatus?: 'injected' | 'dispatched';
}): Promise<{ receiptId: string }> {
  const { usage, injections } = await modules();
  const taskRunId = input.taskRunId ?? RUN;
  const assetVersion = input.assetVersion ?? '1';
  const injection = await injections.recordInjectionReceipt(USER, {
    taskRunId,
    projectionId: 'proj-assoc',
    assetId: input.assetId,
    assetVersion,
    boundary: 'real',
    status: input.injectionStatus ?? 'injected',
    messageId: `message-${taskRunId}`,
  });
  const applied = input.status === 'applied';
  const receipt = await usage.recordAssetUsageReceipt(USER, {
    taskRunId,
    projectionId: 'proj-assoc',
    assetId: input.assetId,
    assetVersion,
    injectionReceiptId: injection.id,
    status: input.status,
    evidenceKind: applied ? 'tool_call' : 'none',
    evidenceRefs: applied ? [{ kind: 'conversation', id: `conv-${taskRunId}` }] : [],
    boundary: 'real',
  });
  return { receiptId: receipt.id };
}

/** 直通线的提案：update / limit_scope / pause 三类都带目标与版本（受采用门约束）。 */
function mutationProposal(
  targetAssetId: string,
  overrides: Partial<KstarCandidateProposal> = {},
): KstarCandidateProposal {
  return {
    judgment: 'Report verification must check every required section before delivery.',
    summary: '报告校验规则修订',
    suggestedType: 'rule',
    suggestedScope: 'report',
    suggestedAction: 'update',
    targetAssetId,
    targetVersionUsed: '1',
    sourceRefs: [{ kind: 'execution', id: EPISODE }],
    ...overrides,
  };
}

/** 结论落点（data-model §2）：`<uid>/cloud/kstar/improvement-outcomes/kio-<episodeId>.json`。 */
function outcomeFile(episodeId: string = EPISODE): string {
  return path.join(root, USER, 'cloud', 'kstar', 'improvement-outcomes', `kio-${episodeId}.json`);
}

function usageJsonl(): string {
  return path.join(root, USER, 'cloud', 'recall', 'jsonl', 'asset-usage-receipts', 'events.jsonl');
}

describe('US-701 关联与依据链（T017）', () => {
  it('links a candidate back to the original method+version, the same task run, the baseline signal, sources and evidence', async () => {
    const { precipitation, candidates, usage, outcome, assets } = await modules();
    const targetAssetId = await seedTargetAsset();
    await seedEpisode({ targetAssetId, usedVersion: '1' });
    await seedReview(EPISODE, updateReview());
    const requirement = await seedRequirement();
    const { receiptId } = await recordUsage({ assetId: targetAssetId, status: 'applied' });

    const result = await precipitation.precipitateRequirementLevel(USER, requirement);

    // 分析确实提出了"改既有方法"的提案：原方法与版本（任务当时用的那一版）在提案上。
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      suggestedAction: 'update',
      targetAssetId,
      targetVersionUsed: '1',
    });
    // AC1：基线/预期/实际跟着提案走。
    expect(result.proposals[0].learningSignal).toMatchObject({
      expectedResult: '报告按既有校验方法一次通过。',
      actualResult: '报告通过了，但校验方法漏掉了一个必填章节。',
      deltaR: 0.3,
      outcome: 'better_than_expected',
    });

    // 候选回指四要素：原方法与版本 / 同次任务 / 基线信号 / 来源与证据。
    const update = (await candidates.listRecallCandidates(USER))
      .find((candidate) => candidate.targetAssetId === targetAssetId);
    expect(update).toBeDefined();
    expect(update).toMatchObject({
      suggestedAction: 'update',
      targetAssetId,
      targetVersionUsed: '1',
      suggestedScope: 'report',
    });
    expect(update!.learningSignal).toMatchObject({
      expectedResult: '报告按既有校验方法一次通过。',
      actualResult: '报告通过了，但校验方法漏掉了一个必填章节。',
      deltaR: 0.3,
      deltaA: 0.1,
      outcome: 'better_than_expected',
    });
    expect(update!.sourceRefs.length).toBeGreaterThan(0);
    expect(update!.sourceRefs.some((ref) => ref.kind === 'execution' && ref.id === EPISODE)).toBe(true);
    expect(update!.evidenceRefs.length).toBeGreaterThan(0);
    expect(update!.learningProvenance?.episodeId).toBe(EPISODE);

    // 「同次任务」由采用回执锚定（contracts/renderer-seams.md §2.1）：候选锚定的
    // assetId+version 能 join 回那条 applied 回执，而回执带同一次 run 的 taskRunId。
    const applied = await usage.listAppliedUsageReceipts(USER, { taskRunIds: [RUN], assetId: targetAssetId });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      id: receiptId, assetId: targetAssetId, assetVersion: '1', taskRunId: RUN,
    });
    expect(applied[0].evidenceRefs.length).toBeGreaterThan(0);
    // 采用证据的版本与候选锚定的版本一致（改的确实是当年那一版）。
    expect(applied[0].assetVersion).toBe(update!.targetVersionUsed);

    // 放行 = 没有"没出候选"的结论（结论只装没出候选的实话）。
    expect(await outcome.readKstarImprovementOutcome(USER, EPISODE)).toBeNull();
    expect(fs.existsSync(outcomeFile())).toBe(false);
  });

  it('emits no update candidate when the target version was only carried in, never applied', async () => {
    const { precipitation, candidates, outcome, assets } = await modules();
    const targetAssetId = await seedTargetAsset();
    await seedEpisode({ targetAssetId, usedVersion: '1' });
    await seedReview(EPISODE, updateReview());
    const requirement = await seedRequirement();
    // 只被带入：注入回执在（injected），使用回执是 usage_unknown——不算采用。
    await recordUsage({ assetId: targetAssetId, status: 'usage_unknown' });
    const before = await assets.readAbilityAsset(USER, targetAssetId);

    const result = await precipitation.precipitateRequirementLevel(USER, requirement);

    // 分析提出了改进（proposals 里有），但**没有**进候选池。
    expect(result.proposals).toHaveLength(1);
    expect(result.candidateIds).toEqual([]);
    expect(result.updateCandidateIds).toEqual([]);
    expect(result.createdAssetIds).toEqual([]);
    expect((await candidates.listRecallCandidates(USER))
      .filter((candidate) => candidate.targetAssetId === targetAssetId)).toEqual([]);
    // 资产零改动（确认前 v1 不变）。
    expect(await assets.readAbilityAsset(USER, targetAssetId))
      .toMatchObject({ id: before.id, version: '1', statement: before.statement });

    // 如实反馈：缺的是"实际采用的证据"，不是"无需更新"。
    const record = await outcome.readKstarImprovementOutcome(USER, EPISODE);
    expect(record?.conclusion).toBe('insufficient_evidence');
    expect(record?.failureCategory).toBeUndefined();
    expect(record?.adoptedAssetRefs).toBeUndefined();
    expect(record?.reason).toContain('实际采用');
  });

  it('keeps update / limit_scope / pause behind the same adoption gate on the direct line', async () => {
    const { direct, candidates, outcome } = await modules();
    const targetAssetId = await seedTargetAsset();
    const episode = await seedEpisode({ targetAssetId, usedVersion: '1' });
    // 三类动作都只有"带入"证据（无 applied 回执）。
    await recordUsage({
      assetId: targetAssetId, status: 'usage_unknown', injectionStatus: 'dispatched',
    });

    for (const suggestedAction of ['update', 'limit_scope', 'pause'] as const) {
      const result = await direct.precipitateDirectExperienceAssets(USER, episode, [
        mutationProposal(targetAssetId, { suggestedAction }),
      ]);
      expect(result.candidateIds).toEqual([]);
      expect(result.updateCandidateIds).toEqual([]);
      expect(result.failureIds).toEqual([]);
    }

    expect((await candidates.listRecallCandidates(USER))
      .filter((candidate) => candidate.targetAssetId === targetAssetId)).toEqual([]);
    expect((await outcome.readKstarImprovementOutcome(USER, EPISODE)).conclusion)
      .toBe('insufficient_evidence');
  });

  it('admits the direct line once the applied receipt exists and carries targetVersionUsed into the candidate', async () => {
    const { direct, candidates, assets, outcome } = await modules();
    const targetAssetId = await seedTargetAsset();
    const episode = await seedEpisode({ targetAssetId, usedVersion: '1' });
    await recordUsage({ assetId: targetAssetId, status: 'applied' });

    const result = await direct.precipitateDirectExperienceAssets(USER, episode, [
      mutationProposal(targetAssetId),
    ]);

    expect(result.candidateIds).toHaveLength(1);
    const saved = (await candidates.listRecallCandidates(USER))
      .find((candidate) => candidate.id === result.candidateIds[0]);
    // 两条沉淀线的字段同口径（T011 ②）：直通线也必须把任务当时用的版本带进候选。
    expect(saved).toMatchObject({
      suggestedAction: 'update',
      targetAssetId,
      targetVersionUsed: '1',
    });
    // 放行且带版本 → 统一晋升出口按既有语义融合生效（不是本次改动引入的行为）。
    expect((await assets.readAbilityAsset(USER, targetAssetId)).version).toBe('2');
    expect(await outcome.readKstarImprovementOutcome(USER, EPISODE)).toBeNull();
  });

  it('lets a legacy proposal without targetVersionUsed pass the gate but records the unverifiable target', async () => {
    const { precipitation, candidates, outcome } = await modules();
    const targetAssetId = await seedTargetAsset();
    // 存量 episode：只记了引用了哪条方法，没记任务当时用的版本。
    await seedEpisode({ targetAssetId });
    await seedReview(EPISODE, updateReview());
    const requirement = await seedRequirement();

    const result = await precipitation.precipitateRequirementLevel(USER, requirement);

    // 不拦存量数据（否则会拦死一批合法改进），但提案上确实没有版本锚。
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ suggestedAction: 'update', targetAssetId });
    expect(result.proposals[0]).not.toHaveProperty('targetVersionUsed');
    expect((await candidates.listRecallCandidates(USER))
      .some((candidate) => candidate.targetAssetId === targetAssetId)).toBe(true);

    // 如实记下"无法核对改进对象"（insufficient_evidence 的另一种落点：不阻断）。
    const record = await outcome.readKstarImprovementOutcome(USER, EPISODE);
    expect(record?.conclusion).toBe('insufficient_evidence');
    expect(record?.reason).toContain('无法核对');
    expect(record?.failureCategory).toBeUndefined();
  });
});

describe('US-701 四态反馈与幂等（T018）', () => {
  it('records no_update when the precipitation gate yields nothing, and stays idempotent across retries', async () => {
    const { precipitation, candidates, assets, outcome } = await modules();
    const targetAssetId = await seedTargetAsset();
    await seedEpisode({ targetAssetId, usedVersion: '1' });
    await seedReview(EPISODE, routineReview());
    const requirement = await seedRequirement();

    const first = await precipitation.precipitateRequirementLevel(USER, requirement);
    expect(first.proposals).toEqual([]);
    expect(first.candidateIds).toEqual([]);

    const record = await outcome.readKstarImprovementOutcome(USER, EPISODE);
    expect(record?.conclusion).toBe('no_update');
    expect(record?.failureCategory).toBeUndefined();
    expect(record?.requirementId).toBe(requirement.id);
    expect(record?.reviewId).toBe(`ksr-${EPISODE}`);
    expect(record?.reason).toContain('没有需要更新');
    // 结论只存摘要与 id：不落受限正文（evidenceRefs 只带元数据）。
    expect(record?.evidenceRefs.every((ref) => (
      !('excerpt' in (ref as unknown as Record<string, unknown>))
    ))).toBe(true);
    // 无需更新 → 零候选、资产零改动。
    expect((await candidates.listRecallCandidates(USER))
      .filter((candidate) => candidate.targetAssetId === targetAssetId)).toEqual([]);
    expect((await assets.readAbilityAsset(USER, targetAssetId)).version).toBe('1');

    // 同一 episode 重试：结论仍一条（覆盖同一条，不新增）。
    const second = await precipitation.precipitateRequirementLevel(USER, requirement);
    expect(second.proposals).toEqual([]);
    const records = await outcome.listKstarImprovementOutcomes(USER);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(`kio-${EPISODE}`);
    expect(records[0].createdAt).toBe(record!.createdAt);
    expect(records[0].conclusion).toBe('no_update');
    expect(fs.readdirSync(path.dirname(outcomeFile()))).toEqual([`kio-${EPISODE}.json`]);
  });

  it('writes no_update on the direct line too, but never for a timed-out episode', async () => {
    const { direct, outcome } = await modules();
    const targetAssetId = await seedTargetAsset();
    const episode = await seedEpisode({ targetAssetId, usedVersion: '1' });

    // 上游闸门判完没有提案 → 直通线如实回一条 no_update。
    const empty = await direct.precipitateDirectExperienceAssets(USER, episode, []);
    expect(empty.candidateIds).toEqual([]);
    const record = await outcome.readKstarImprovementOutcome(USER, EPISODE);
    expect(record?.conclusion).toBe('no_update');
    expect(record?.failureCategory).toBeUndefined();

    // timed_out 的 episode：`proposeKstarCandidates` 直接返回空——那是"这次不算数"，
    // 不是"没什么可沉淀"，不得写成 no_update（不得掩盖失败）。
    const timedOut = await seedEpisode({
      id: 'kse-assoc-timeout', runId: 'run-assoc-timeout', targetAssetId, usedVersion: '1', status: 'timed_out',
    });
    await direct.precipitateDirectExperienceAssets(USER, timedOut, []);
    expect(fs.existsSync(outcomeFile('kse-assoc-timeout'))).toBe(false);
  });

  it('fails closed with analysis_failed (never no_update) when the adoption evidence cannot be read', async () => {
    const { precipitation, candidates, outcome } = await modules();
    const targetAssetId = await seedTargetAsset();
    await seedEpisode({ targetAssetId, usedVersion: '1' });
    await seedReview(EPISODE, updateReview());
    const requirement = await seedRequirement();
    await recordUsage({ assetId: targetAssetId, status: 'applied' });
    // 存储损坏：使用回执流里混入一行坏 JSON → 整个采用证据读取失败。
    fs.appendFileSync(usageJsonl(), '{ not json }\n', 'utf8');

    const result = await precipitation.precipitateRequirementLevel(USER, requirement);

    // fail-closed 不炸整条沉淀（需求收口照旧完成），也不产候选。
    expect(result.proposals).toHaveLength(1);
    expect(result.candidateIds).toEqual([]);
    expect((await candidates.listRecallCandidates(USER))
      .filter((candidate) => candidate.targetAssetId === targetAssetId)).toEqual([]);

    const record = await outcome.readKstarImprovementOutcome(USER, EPISODE);
    expect(record?.conclusion).toBe('analysis_failed');
    expect(record?.failureCategory).toBe('evidence');
    // 读取失败**不得**退化成"无需更新"。
    expect(record?.conclusion).not.toBe('no_update');
    expect(record?.adoptedAssetRefs).toBeUndefined();
  });

  it('records submit_failed with a category when the candidate write fails, keeping the existing failure record', async () => {
    const { direct, candidates, assets, failures, outcome } = await modules();
    const targetAssetId = await seedTargetAsset();
    const episode = await seedEpisode({ targetAssetId, usedVersion: '1' });
    await recordUsage({ assetId: targetAssetId, status: 'applied' });
    // 写候选必然失败：judgment 为空（保存入口的不变量会抛）。
    const broken = mutationProposal(targetAssetId, { judgment: '' });

    const first = await direct.precipitateDirectExperienceAssets(USER, episode, [broken]);
    expect(first.candidateIds).toEqual([]);
    expect(first.failureIds).toHaveLength(1);

    const record = await outcome.readKstarImprovementOutcome(USER, EPISODE);
    expect(record?.conclusion).toBe('submit_failed');
    expect(record?.failureCategory).toBeDefined();
    expect(record?.reason).toContain('提交失败');
    // 结论与失败面并存：既有 `recordKstarFailure(stage='precipitation')` 语义不变。
    const failureRecords = await failures.listKstarFailures(USER);
    expect(failureRecords).toHaveLength(1);
    expect(failureRecords[0]).toMatchObject({ stage: 'precipitation', errorCode: 'asset_write_failed' });
    expect(record?.reason).toContain(failureRecords[0].id);
    // 不产生第二条成功对象：零候选、资产 v1 不动。
    expect((await candidates.listRecallCandidates(USER))
      .filter((candidate) => candidate.targetAssetId === targetAssetId)).toEqual([]);
    expect((await assets.readAbilityAsset(USER, targetAssetId)).version).toBe('1');

    // 同一失败重试：失败记录与结论都只有一条（派生 id 幂等）。
    const retry = await direct.precipitateDirectExperienceAssets(USER, episode, [broken]);
    expect(retry.candidateIds).toEqual([]);
    expect(await failures.listKstarFailures(USER)).toHaveLength(1);
    const records = await outcome.listKstarImprovementOutcomes(USER);
    expect(records).toHaveLength(1);
    expect(records[0].conclusion).toBe('submit_failed');
    expect(records[0].createdAt).toBe(record!.createdAt);
  });

  it('records a requirement-level submit_failed when the precipitation exit throws (best-effort preserved)', async () => {
    // `vi.doMock` 是**非提升**式：注册后必须再清一次模块注册表，下一次 import
    // 才会解析到 mock（Vitest 的 `doMock` 只对"后续 import"生效，已缓存的图
    // 仍旧是原实现）。少了这一步，本用例会偶发地跑真实出口、产出一个候选。
    vi.doMock('../../../../src/main/features/kstar/direct-experience-assets', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../../src/main/features/kstar/direct-experience-assets')>()),
      precipitateDirectExperienceFromSource: async () => {
        throw new Error('simulated direct precipitation failure');
      },
    }));
    vi.resetModules();
    // 再**顺序**解析一次需求级模块：它静态依赖 `direct-experience-assets`，
    // 而 `modules()` 用 `Promise.all` 并发导入 11 个模块——并发解析时静态依赖
    // 可能拿到"mock 之前"的实例（实测偶发：同一文件曾一次全绿、随后稳定红）。
    // 先单独 import 一次把依赖图的解析顺序钉死，mock 才会进入它的静态依赖。
    await import('../../../../src/main/features/kstar/task-level-precipitation');
    const { precipitation, outcome, episodeStore } = await modules();
    const targetAssetId = await seedTargetAsset();
    await seedEpisode({ targetAssetId, usedVersion: '1' });
    await seedReview(EPISODE, updateReview());
    const requirement = await seedRequirement();
    await recordUsage({ assetId: targetAssetId, status: 'applied' });

    // best-effort：提交失败**不**中断需求收口（函数照常返回结果）。
    const result = await precipitation.precipitateRequirementLevel(USER, requirement);
    expect(result.candidateIds).toEqual([]);
    expect(result.failureIds).toEqual([]);

    const record = await outcome.readKstarImprovementOutcome(USER, EPISODE);
    expect(record?.conclusion).toBe('submit_failed');
    expect(record?.failureCategory).toBeDefined();
    expect(record?.requirementId).toBe(requirement.id);
    // 收口链条照旧留档（extraction run 写入没有被失败挡住）。
    expect(await episodeStore.readKstarJsonRecord(USER, 'extraction-runs', `ksx-${EPISODE}`)).toMatchObject({
      episodeId: EPISODE,
    });
  });

  it('does not duplicate a successful candidate or a conclusion when the same episode is analyzed again', async () => {
    const { precipitation, candidates, assets, outcome } = await modules();
    const targetAssetId = await seedTargetAsset();
    await seedEpisode({ targetAssetId, usedVersion: '1' });
    await seedReview(EPISODE, updateReview());
    const requirement = await seedRequirement();
    await recordUsage({ assetId: targetAssetId, status: 'applied' });

    const first = await precipitation.precipitateRequirementLevel(USER, requirement);
    const second = await precipitation.precipitateRequirementLevel(USER, requirement);

    expect(first.candidateIds).toEqual(second.candidateIds);
    const related = (await candidates.listRecallCandidates(USER))
      .filter((candidate) => candidate.targetAssetId === targetAssetId);
    expect(related).toHaveLength(1);
    expect(related[0].targetVersionUsed).toBe('1');
    // 已成功的候选不重复生成、资产不重复写：成功路径不产结论记录。
    expect((await assets.listAbilityAssets(USER)).filter((asset) => asset.id === targetAssetId))
      .toHaveLength(1);
    expect(await outcome.listKstarImprovementOutcomes(USER)).toEqual([]);
  });

  it('never lets a blocked proposal masquerade as no_update (create proposals stay outside the gate)', async () => {
    const { direct, outcome } = await modules();
    const targetAssetId = await seedTargetAsset();
    const episode = await seedEpisode({ targetAssetId, usedVersion: '1' });

    // 没有采用证据：更新型提案被拦 → insufficient_evidence（不是 no_update）。
    const blocked = await direct.precipitateDirectExperienceAssets(USER, episode, [
      mutationProposal(targetAssetId),
    ]);
    expect(blocked.candidateIds).toEqual([]);
    const blockedRecord = await outcome.readKstarImprovementOutcome(USER, EPISODE);
    expect(blockedRecord?.conclusion).toBe('insufficient_evidence');
    expect(blockedRecord?.conclusion).not.toBe('no_update');

    // 新建型提案不受采用门影响（门只管"改既有对象"）——specs/016 分流后
    // 等价表达为：照常产出沉淀物（经验条目），且不进候选池。
    const created = await direct.precipitateDirectExperienceAssets(USER, episode, [{
      judgment: 'Write the section outline before drafting the report body.',
      summary: '报告先列大纲',
      suggestedType: 'rule',
      suggestedScope: 'report',
      sourceRefs: [{ kind: 'execution', id: EPISODE }],
    }]);
    expect(created.candidateIds).toEqual([]);
    expect(created.experienceIds).toHaveLength(1);
  });
});
