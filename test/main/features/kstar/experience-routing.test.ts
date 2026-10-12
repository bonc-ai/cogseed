import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../../../../src/main/features/cogseed_runtime/protocol';
import type { KstarEpisodeRecord } from '../../../../src/main/features/kstar/types';

// 标题闸门（设计 3.2）后晋升链对不合规 summary 走 LLM 起标题；本文件的候选
// 由 KStar 抽取/即时直投内生生成（summary＝模板拼接或正文首句），单测无模型，
// mock 出确定性合规标题（与 asset-title-suggestion.test.ts 同一边界口径）。
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({
  suggestAbilityAssetTitle: async () => ({ title: '模型重起的样本标题' }),
}));


/**
 * specs/016 T010（US-801 / FR-001）——沉淀分流四条断言：
 *  ① create 线提案 → 产出**经验条目**（experiences 集合），candidateIds 为空、
 *     资产库零新增（create 线不落候选池、不自动晋升）；
 *  ② mutating（asset_outdated 归因 + episode 恰引用一条资产）→ **仍产候选**且
 *     资产更新走原路（Epic 7 主链不能被分流误伤）；
 *  ③ keep_current / reject → 无经验无资产（原路只留决策档）；
 *  ④ preference_scan 线 → 既不是经验也不受影响（「关于我」仍走候选池晋升）。
 *
 * 实现前四条中涉及经验面的断言全红（现状 create 线产候选 + 资产）。
 */

// 语义查重不依赖真实 embedding 模型（95MB ONNX，测试环境无关性）：按文本
// 哈希生成确定性 512 维向量——不同文本向量不同 → 查重走 no_match 正常晋升。
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Array.from({ length: 512 }, (_, i) => Math.sin(h + i * 0.618) * 0.1);
  },
}));

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-experience-routing-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const request: RuntimeRunRequest = {
  protocol_version: 1, type: 'run', request_id: 'req-routing', runtime_session_id: 'mruntime-routing',
  user_id: 'route-user', task: 'Create a report.', context: [], attachments: [],
};
const events: RuntimeEventEnvelope[] = [
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_call', id: 'a', name: 'read_file', arguments: { path: 'x' } } },
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_result', id: 'a', name: 'read_file', isError: false } },
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_call', id: 'b', name: 'write_file', arguments: { path: 'y', content: '...' } } },
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_result', id: 'b', name: 'write_file', isError: false } },
  { type: 'result', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'completed', text: 'Report created.' },
];

async function buildEpisode(runId: string, overrides: Partial<KstarEpisodeRecord> = {}): Promise<KstarEpisodeRecord> {
  const builder = await import('../../../../src/main/features/kstar/episode-builder');
  return {
    ...builder.buildRuntimeKstarEpisode({ userId: 'route-user', runId, request, events, createdAt: '2026-08-05T00:00:00.000Z' }),
    ...overrides,
  };
}

async function seedEpisode(episode: KstarEpisodeRecord): Promise<void> {
  const store = await import('../../../../src/main/features/kstar/episode-store');
  await store.writeKstarEpisode('route-user', episode);
}

async function seedReview(episode: KstarEpisodeRecord, overrides: Record<string, unknown> = {}): Promise<void> {
  const reviews = await import('../../../../src/main/features/kstar/review-service');
  const initial = reviews.createInitialKstarReview(episode);
  await reviews.saveKstarReviewRecord('route-user', { ...initial, ...overrides });
}

describe('KSTAR 沉淀分流（specs/016 T010）', () => {
  it('① create 线提案产出经验条目：不落候选池、资产库零新增，重复沉淀幂等', async () => {
    const direct = await import('../../../../src/main/features/kstar/direct-experience-assets');
    const episode = await buildEpisode('run-route-create');
    const judgment = 'For similar report tasks, use the verified workflow: read_file → write_file.';
    const proposal = {
      judgment,
      summary: 'Verified multi-tool workflow for report tasks',
      suggestedType: 'skill_method',
      suggestedScope: 'report',
      sourceRefs: [{ kind: 'execution' as const, id: episode.id }],
      learningSignal: {
        expectedResult: 'A report is created.',
        actualResult: 'The report was created with the verified workflow.',
        deltaR: 0.3 as const,
        deltaA: 0.1 as const,
        outcome: 'better_than_expected' as const,
        confidence: 0.9,
        source: 'review' as const,
      },
    };

    const first = await direct.precipitateDirectExperienceAssets('route-user', episode, [proposal]);

    // 分流主断言：经验面有产出、候选池与资产库零产出。
    expect(first.experienceIds).toHaveLength(1);
    expect(first.candidateIds).toEqual([]);
    expect(first.createdAssetIds).toEqual([]);
    const experiences = await import('../../../../src/main/features/recall/experience-service');
    const stored = await experiences.listExperiences('route-user');
    expect(stored).toHaveLength(1);
    expect(stored[0].id.startsWith('exp-')).toBe(true);
    expect(stored[0].body).toBe(judgment);
    expect(stored[0].status).toBe('active');
    // 字段映射：类型走 experienceTypeOf（skill_method 分支 → workflow），
    // 标题走 userFacingSummary 既有口径，任务类型走 scopeForTask。
    expect(stored[0].experienceType).toBe('workflow');
    const { userFacingSummary } = await import('../../../../src/main/features/kstar/task-level-precipitation');
    expect(stored[0].title).toBe(userFacingSummary('workflow', 'report', judgment));
    expect(stored[0].source).toMatchObject({ episodeId: episode.id, taskType: 'report', taskStatus: 'completed' });
    expect(stored[0].verification).toMatchObject({ outcome: 'better_than_expected', deltaR: 0.3, confidence: 0.9 });
    expect(stored[0].evidenceRefs.some((ref) => ref.kind === 'execution' && ref.id === episode.id)).toBe(true);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect(await assets.listAbilityAssets('route-user')).toHaveLength(0);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    expect(await candidates.listRecallCandidates('route-user')).toHaveLength(0);

    // 幂等：同 episode 同提案重试不产生第二条经验（createExperience 同 id 返回既有）。
    const second = await direct.precipitateDirectExperienceAssets('route-user', episode, [proposal]);
    expect(second.experienceIds).toEqual(first.experienceIds);
    expect(await experiences.listExperiences('route-user')).toHaveLength(1);
  });

  it('② mutating（asset_outdated + episode 恰引用一条资产）仍产候选且资产更新走原路', async () => {
    const direct = await import('../../../../src/main/features/kstar/direct-experience-assets');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    // 先放一条正式资产在库里，作为 episode 恰好引用的目标。
    const originalCandidate = await candidates.saveRecallCandidate('route-user', {
      judgment: 'Keep the report verification rule.',
      value: 'Keep report verification consistent across runs.',
      suggestedType: 'rule',
      suggestedScope: 'report',
      suggestedAction: 'create',
      applicableWhen: ['处理报告类任务时'],
      sourceRefs: [{ kind: 'execution', id: 'kse-run-route-target' }],
    });
    const original = await candidates.promoteRecallCandidate('route-user', originalCandidate.id, { actor: 'user' });

    const episode = await buildEpisode('run-route-update', {
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [original.asset.id] },
    });
    await seedEpisode(episode);
    // asset_outdated 归因：assetMutationFor 据此产出 update 提案的输入条件。
    await seedReview(episode, {
      attributionDetails: [{
        category: 'asset_outdated',
        confidence: 1,
        evidenceRefs: episode.evidenceRefs,
        source: 'deterministic',
      }],
    });

    const result = await direct.precipitateDirectExperienceAssets('route-user', episode, [{
      judgment: 'Update the report verification rule to require an acceptance check.',
      summary: 'Updated report verification rule',
      suggestedType: 'rule',
      suggestedScope: 'report',
      suggestedAction: 'update',
      targetAssetId: original.asset.id,
      applicableWhen: ['处理报告类任务时'],
      sourceRefs: [{ kind: 'execution', id: episode.id }],
    }]);

    // 分流另一侧：mutating 线必须原样走候选池 → 审批/融合主链。
    expect(result.candidateIds).toHaveLength(1);
    expect(result.experienceIds).toEqual([]);
    const experiences = await import('../../../../src/main/features/recall/experience-service');
    expect(await experiences.listExperiences('route-user')).toHaveLength(0);
    const updated = await assets.readAbilityAsset('route-user', original.asset.id);
    expect(updated).toMatchObject({ id: original.asset.id, version: '2' });
    expect(String(updated!.statement)).toContain('acceptance check');
  });

  it('③ keep_current / reject：无经验无资产（原路只留决策档）', async () => {
    const direct = await import('../../../../src/main/features/kstar/direct-experience-assets');
    const episode = await buildEpisode('run-route-keep');
    const base = {
      judgment: 'The current rule is already accurate; no change needed.',
      summary: 'Keep the current rule',
      suggestedType: 'rule',
      suggestedScope: 'report',
      sourceRefs: [{ kind: 'execution' as const, id: episode.id }],
    };

    const keep = await direct.precipitateDirectExperienceAssets('route-user', episode, [
      { ...base, suggestedAction: 'keep_current' as const },
    ]);
    const reject = await direct.precipitateDirectExperienceAssets('route-user', episode, [
      { ...base, suggestedAction: 'reject' as const },
    ]);

    // 无经验无资产；仍走原路落候选（决策档），分流不吞掉它们。
    expect(keep.experienceIds).toEqual([]);
    expect(reject.experienceIds).toEqual([]);
    const experiences = await import('../../../../src/main/features/recall/experience-service');
    expect(await experiences.listExperiences('route-user')).toHaveLength(0);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect(await assets.listAbilityAssets('route-user')).toHaveLength(0);
  });

  it('④ preference_scan 线：既不是经验也不受影响（「关于我」仍走候选池晋升）', async () => {
    const direct = await import('../../../../src/main/features/kstar/direct-experience-assets');
    const episode = await buildEpisode('run-route-preference');
    await seedEpisode(episode);
    const admission = await direct.kstarPrecipitationAdmission('route-user', {
      source: 'requirement_level',
      episodes: [episode],
      episodeId: episode.id,
    });
    // preference_scan 线的提案形状（personalStatementsToProposals 的产出）：
    // create + 无 target，但 learningSignal.source = 'preference_scan'。
    const result = await direct.precipitateDirectExperienceFromSource('route-user', { id: episode.id }, [{
      judgment: '我以后的周报都要按固定板块组织。',
      summary: '周报固定板块',
      suggestedType: 'personal',
      suggestedScope: 'personal',
      suggestedAction: 'create',
      sourceRefs: [{ kind: 'execution', id: episode.id }],
      learningSignal: {
        deltaR: 'unknown',
        deltaA: 'unknown',
        outcome: 'met_expected',
        confidence: 0.9,
        source: 'preference_scan',
      },
    }], admission, { taskGoal: '整理团队周报', taskStatus: 'completed' });

    // 不是经验：偏好陈述仍属于「关于我」资产域，不进经验目录。
    expect(result.experienceIds).toEqual([]);
    const experiences = await import('../../../../src/main/features/recall/experience-service');
    expect(await experiences.listExperiences('route-user')).toHaveLength(0);
    // 不受影响：行为指纹与分流引入前完全一致——create+无 target 的形状也
    // 没有被改道（仍走候选池出口）。该提案被候选侧的 learningSignal 校验
    // 拒收（candidate-service 现状只认 source==='review'，与本分流无关），
    // 失败面照常记录：failureIds 恰一条证明它走的是原路而非被分流吞掉。
    expect(result.candidateIds).toEqual([]);
    expect(result.failureIds).toHaveLength(1);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect(await assets.listAbilityAssets('route-user')).toHaveLength(0);
  });
});
