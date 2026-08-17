import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KstarEpisodeRecord, KstarReviewRecord } from '../../../../src/main/features/kstar/types';

/**
 * 场景测试：2026-08-17 修复集端到端验证
 *
 * 覆盖四个验证点（对应提交 67c3f134 + c529dabd）：
 *   A. B1 — KStar 聚合产出的 rule 候选只有 applicableWhen（单边界），系统线
 *      晋升不再被 rule_boundary_required 阻断（chen 的 && 收紧已改回 ||）。
 *   B. A1 — 沉淀路径收口：drainKstarTaskState 不再产候选（proposals/candidates
 *      恒空），无 drain + requirement 级双写；requirement 级正常产出资产。
 *   C. B4 — 迁移证明改回执并集覆盖：多回合每回合注入不同资产（回执分散），
 *      终态证明仍升档（单张全覆盖会永不升档）。
 *   D. 语言硬闸 — 中文任务产出英文 lesson 时在出生点被丢弃（回退确定性模板
 *      或空 lesson），英文经验绝不进候选池。
 */

// 语义查重不依赖真实 embedding 模型（测试环境无关性）：按文本哈希生成
// 确定性 512 维向量——不同文本向量不同 → 查重走 no_match 正常晋升。
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Array.from({ length: 512 }, (_, i) => Math.sin(h + i * 0.618) * 0.1);
  },
}));

const UID = 'user-scenario';
let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-receipt-scenario-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function episode(id: string, goal: string, tools: Array<{ name: string; status?: 'ok' | 'error' | 'unknown' }> = []): KstarEpisodeRecord {
  return {
    schemaVersion: 1,
    ownerId: UID,
    id,
    sessionId: 'gconv-scenario',
    taskRunId: `run-${id}`,
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: { workspaceId: 'workspace-scenario' },
    t: { userGoal: goal, constraints: [] },
    a: { toolCalls: tools, agentActions: [] },
    r: { status: 'completed', finalText: 'Done.', producedFiles: [] },
    evidenceRefs: [{ kind: 'execution', id: `exec-${id}` }],
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:01:00.000Z',
  };
}

async function seedEpisode(record: KstarEpisodeRecord): Promise<void> {
  const store = await import('../../../../src/main/features/kstar/episode-store');
  await store.writeKstarEpisode(UID, record);
}

async function seedReview(record: KstarEpisodeRecord, overrides: Partial<KstarReviewRecord> = {}): Promise<void> {
  const reviews = await import('../../../../src/main/features/kstar/review-service');
  const initial = reviews.createInitialKstarReview(record);
  await reviews.saveKstarReviewRecord(UID, { ...initial, ...overrides });
}

async function seedRequirement(episodeIds: string[], goal: string): Promise<import('../../../../src/main/features/kstar/requirement-types').KstarRequirementRecord> {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const task = store.createKstarTaskRecord(UID, { conversationId: 'cid-scenario', title: 'Scenario task' });
  const requirement = store.createKstarRequirementRecord(UID, {
    taskId: task.id,
    conversationId: 'cid-scenario',
    userMessageIds: ['msg-scenario'],
    title: goal,
    goalText: goal,
  });
  requirement.episodeIds = episodeIds;
  await store.replaceKstarTask(UID, { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id });
  await store.replaceKstarRequirement(UID, requirement);
  return requirement;
}

describe('2026-08-17 修复集场景（边界单路径 + 回执并集 + 语言硬闸）', () => {
  it('A. KStar rule 候选带单边界即可沉淀为资产（B1: && → ||）', async () => {
    // 中文任务 + 中文 lesson + 无缺口归因 → rule 候选，只有 applicableWhen
    // （KStar 聚合刻意不编造 forbiddenWhen）。
    const ep = episode('kse-scenario-a', '帮我写一份城市资料，500 字', [
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);
    await seedEpisode(ep);
    await seedReview(ep, {
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'met_expected',
      attribution: 'unclear',
      reason: '任务按预期完成，lesson 可复用。',
      confidence: 0.9,
      lesson: '写城市资料时应先收集数据再成文，避免编造。',
    });
    const requirement = await seedRequirement([ep.id], '帮我写一份城市资料，500 字');

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel(UID, requirement);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].suggestedType).toBe('rule');
    // 单边界：只带 applicableWhen，不带 forbiddenWhen
    expect(result.proposals[0].applicableWhen).toBeTruthy();
    expect((result.proposals[0] as { forbiddenWhen?: string[] }).forbiddenWhen).toBeUndefined();
    // 系统线晋升不被 rule_boundary_required 阻断
    expect(result.createdAssetIds).toHaveLength(1);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const asset = await assets.readAbilityAsset(UID, result.createdAssetIds[0]);
    expect(asset.type).toBe('rule');
    expect(asset.maturity).toBe('seed');
    expect(asset.lifecycleStatus).toBe('system_precipitated_unverified');
    expect(asset.statement).toContain('写城市资料时应先收集数据再成文');
    // statement 纯净：value=judgment 时不再拼接标题残片
    expect(asset.statement).not.toContain('可复用经验：');
  });

  it('B. drain 收口：drainKstarTaskState 不产候选，requirement 级为唯一沉淀路径（A1）', async () => {
    const ep = episode('kse-scenario-b', '帮我写一份城市资料，500 字', [
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);
    await seedEpisode(ep);
    await seedReview(ep, {
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'met_expected',
      attribution: 'unclear',
      reason: '任务完成，lesson 可复用。',
      confidence: 0.9,
      lesson: '城市资料交付应注明实际字数并按板块组织。',
    });
    const requirement = await seedRequirement([ep.id], '帮我写一份城市资料，500 字');
    // drain 的前置状态：会话任务状态必须 taskComplete 才会走到收口逻辑
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const state = store.createInitialConversationTaskState(UID, 'cid-scenario');
    await store.writeConversationTaskState(UID, {
      ...state,
      currentTaskId: requirement.taskId,
      currentRequirementId: requirement.id,
      taskComplete: true,
    });

    // 1. drain 不再调用 bridge、不产候选（任务/会话关闭职责保留）
    const aggregate = await import('../../../../src/main/features/kstar/task-aggregate');
    let bridgeCalls = 0;
    const drainResult = await aggregate.drainKstarTaskState(UID, 'cid-scenario', {
      candidateBridge: async () => { bridgeCalls += 1; return []; },
    });
    expect(bridgeCalls).toBe(0);
    expect(drainResult?.proposals).toEqual([]);
    expect(drainResult?.candidates).toEqual([]);
    expect(drainResult?.task.status).toBe('closed');

    // 2. requirement 级路径正常产出（唯一沉淀路径）
    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel(UID, requirement);
    expect(result.createdAssetIds).toHaveLength(1);

    // 3. 无双写：候选池里恰好一条 confirmed（无 drain 线带来的重复候选）
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const pool = await candidates.listRecallCandidates(UID);
    const related = pool.filter((c) => String(c.judgment).includes('城市资料交付应注明实际字数'));
    expect(related).toHaveLength(1);
    expect(related[0].status).toBe('confirmed');
    expect(related[0].promotedAssetId).toBe(result.createdAssetIds[0]);
  });

  it('C. 迁移证明回执并集覆盖：多回合分散注入仍升档（B4）', async () => {
    // 两条真实资产（带规则边界，与 KStar 聚合产出的候选一致），经统一晋升出口
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const c1 = await candidates.saveRecallCandidate(UID, {
      judgment: '资产一：跨回合注入的第一条经验。',
      value: '资产一：跨回合注入的第一条经验。',
      summary: '资产一',
      suggestedType: 'rule',
      suggestedScope: 'general',
      suggestedAction: 'create',
      applicableWhen: ['处理通用任务时'],
      sourceRefs: [{ kind: 'execution', id: 'exec-c1' }],
      evidenceRefs: [{ kind: 'execution', id: 'exec-c1' }],
    });
    const p1 = await candidates.autoApplyRecallCandidate(UID, c1.id, { provenance: 'kstar' });
    const c2 = await candidates.saveRecallCandidate(UID, {
      judgment: '资产二：另一个回合注入的第二条经验。',
      value: '资产二：另一个回合注入的第二条经验。',
      summary: '资产二',
      suggestedType: 'rule',
      suggestedScope: 'general',
      suggestedAction: 'create',
      applicableWhen: ['处理通用任务时'],
      sourceRefs: [{ kind: 'execution', id: 'exec-c2' }],
      evidenceRefs: [{ kind: 'execution', id: 'exec-c2' }],
    });
    const p2 = await candidates.autoApplyRecallCandidate(UID, c2.id, { provenance: 'kstar' });
    expect(p1.asset).toBeTruthy();
    expect(p2.asset).toBeTruthy();

    const projection = await import('../../../../src/main/features/recall/context-projection');
    const preview = await projection.previewContextProjection(UID, {
      taskRunId: 'run-union', workspaceId: 'workspace-scenario', purpose: 'review',
      authorization: 'workspace_policy', confirm: true,
    });

    // 回合 1 只注入资产一；回合 2 只注入资产二——两张真实回执各覆盖一半。
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await receipts.prepareReceipt(UID, {
      executionId: 'turn-union-1', targetSessionId: 'gconv-scenario',
      reusedRefs: [p1.asset.id], omittedRefs: [],
      permissionMode: 'read-only', allowedScopes: ['cognition:projection'], boundary: 'real',
    }, { sessionId: 'gconv-scenario' });
    await receipts.prepareReceipt(UID, {
      executionId: 'turn-union-2', targetSessionId: 'gconv-scenario',
      reusedRefs: [p2.asset.id], omittedRefs: [],
      permissionMode: 'read-only', allowedScopes: ['cognition:projection'], boundary: 'real',
    }, { sessionId: 'gconv-scenario' });

    const terminalProof = await import('../../../../src/main/features/recall/terminal-proof');
    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-union', user_id: UID, conversation_id: 'cid-scenario',
      status: 'completed', projection_id: preview.id,
      reuse_turn_ids: ['union-1', 'union-2'],
      started_at_ms: 1, finished_at_ms: 2,
    });

    expect(result).toMatchObject({ handled: true, proof: { status: 'succeeded', receiptId: expect.any(String) } });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const list = await assets.listAbilityAssets(UID);
    expect(list.find((a) => a.id === p1.asset.id)?.maturity).toBe('transfer_validated');
    expect(list.find((a) => a.id === p2.asset.id)?.maturity).toBe('transfer_validated');
    // 证明记录带上了回执绑定
    const proofs = await import('../../../../src/main/features/recall/proof-service');
    const proof = (await proofs.listTransferProofs(UID))[0];
    expect(proof.receiptId).toBeTruthy();
    expect(proof.receiptExecutionId).toBeTruthy();
  });

  it('D. 语言硬闸：中文任务产出英文 lesson 被丢弃，绝不进候选池', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');
    const runModel = vi.fn(async () => JSON.stringify({
      outcome: 'better_than_expected',
      attribution: 'unclear',
      deltaR: 0.3,
      deltaA: 0.2,
      reason: 'Task completed faster than predicted.',
      confidence: 0.8,
      needsConfirmation: false,
      lesson: 'For well-known factual city profiles, skip explicit information-gathering plan steps.',
    }));

    const ep = episode('kse-scenario-d', '帮我写一份城市资料，500 字');
    const result = await inference.inferKstarReview(UID, ep, {
      forecast: {
        aHat: { plan: ['Gather', 'Write'], expectedTools: ['read_file'], expectedActors: ['commander'] },
        rHat: { summary: 'City profile written', acceptanceSignals: [], predictedFiles: [] },
        predictedRisks: [],
        selectedCandidateId: 'cand-d',
      },
      selectedAssetTypes: ['rule'],
      runModel,
    });

    // 出生点拦截：英文 lesson 直接丢弃（中文任务）
    expect(result.review.lesson).toBeUndefined();
    expect(result.review.reason).toBe('Task completed faster than predicted.');

    // 消费方防御：即使历史 review 带英文 lesson，聚合也不产候选（回退模板或空）
    const epB = episode('kse-scenario-d2', '帮我写一份城市资料，500 字', [
      { name: 'read_file', status: 'ok' },
      { name: 'write_file', status: 'ok' },
    ]);
    await seedEpisode(epB);
    await seedReview(epB, {
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'met_expected',
      attribution: 'unclear',
      reason: '任务完成。',
      confidence: 0.9,
      lesson: 'When user request is ambiguous, clarify the intent before producing output.',
    });
    const requirement = await seedRequirement([epB.id], '帮我写一份城市资料，500 字');
    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result2 = await precipitation.precipitateRequirementLevel(UID, requirement);
    // 英文 lesson 不产 rule 候选：verifiedWorkflow → 回退 skill_method 模板
    expect(result2.proposals.every((p) => !String(p.judgment).includes('When user request is ambiguous'))).toBe(true);
    expect(result2.proposals.every((p) => p.suggestedType !== 'rule')).toBe(true);
  });
});
