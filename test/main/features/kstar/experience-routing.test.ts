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
 * specs/016 T010（US-801 / FR-001）→ 2026-10-08 U09 改写——沉淀分流四条断言：
 *  ① create 线提案 → 统一进候选池（pending_review，只作建议），经验库零
 *     条目、资产库零新增（用户确认前不自动晋升）；
 *  ② mutating（asset_outdated 归因 + episode 恰引用一条资产）→ **仍产候选**且
 *     资产更新走原路（Epic 7 主链不能被分流误伤）；
 *  ③ keep_current / reject → 无经验无资产（原路只留决策档）；
 *  ④ preference_scan 线 → 既不是经验也不受影响（「关于我」仍走候选池晋升）。
 *
 * 退役说明：原 ① 中 specs/016 T013 的经验字段映射断言（experienceType 走
 * experienceTypeOf、标题走 userFacingSummary、verification 从 review 映射、
 * source.taskType/taskStatus）随 create 线直写经验的删除一并退役——候选
 * 输入没有这些字段；可迁移的字段构造（judgment/scope/learningSignal/
 * evidenceRefs）改为候选输入断言保留。
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

    // 兼容入口不写经验、资产或候选；任务决策留在KSTAR自己的记录中。
    expect(keep.experienceIds).toEqual([]);
    expect(reject.experienceIds).toEqual([]);
    expect(keep.candidateIds).toEqual([]);
    expect(reject.candidateIds).toEqual([]);
    const experiences = await import('../../../../src/main/features/recall/experience-service');
    expect(await experiences.listExperiences('route-user')).toHaveLength(0);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect(await assets.listAbilityAssets('route-user')).toHaveLength(0);
  });
});
