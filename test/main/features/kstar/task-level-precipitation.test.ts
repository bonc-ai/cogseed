import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KstarEpisodeRecord, KstarReviewRecord } from '../../../../src/main/features/kstar/types';

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
let previousRuntimeVariant: string | undefined;
let testRuntimeVariant: string;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-tasklevel-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  previousRuntimeVariant = process.env.COGSEED_RUNTIME_VARIANT;
  testRuntimeVariant = 'kstar-tasklevel-p3394-' + Math.random().toString(36).slice(2, 8);
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  process.env.COGSEED_RUNTIME_VARIANT = testRuntimeVariant;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', testRuntimeVariant), { recursive: true, force: true });
  if (previousRuntimeVariant === undefined) delete process.env.COGSEED_RUNTIME_VARIANT;
  else process.env.COGSEED_RUNTIME_VARIANT = previousRuntimeVariant;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function episode(
  id: string,
  goal: string,
  tools: Array<{ name: string; status?: 'ok' | 'error' }>,
  status: 'completed' | 'failed' = 'completed',
): KstarEpisodeRecord {
  const now = '2026-08-16T00:00:00.000Z';
  return {
    schemaVersion: 1,
    ownerId: 'user-b5',
    id,
    sessionId: `sess-${id}`,
    sessionKind: 'cogseed_runtime',
    taskRunId: `run-${id}`,
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: { workspaceId: 'ws-b5' },
    t: { userGoal: goal, constraints: [] },
    a: {
      toolCalls: tools.map((tool) => ({
        name: tool.name,
        status: tool.status || 'ok',
        argumentsSummary: '{}',
      })),
      agentActions: tools.map((tool) => ({ actor: 'runtime', action: tool.name })),
    },
    r: {
      status,
      producedFiles: [],
      ...(status === 'completed' ? { finalText: 'done' } : { failureKind: 'runtime_error' }),
    },
    evidenceRefs: [{ kind: 'context', id: `ctx-${id}` }],
    createdAt: now,
    updatedAt: now,
  };
}

async function seedEpisode(episodeRecord: KstarEpisodeRecord): Promise<void> {
  const store = await import('../../../../src/main/features/kstar/episode-store');
  await store.writeKstarEpisode('user-b5', episodeRecord);
}

async function seedReview(episodeRecord: KstarEpisodeRecord, overrides: Partial<KstarReviewRecord> = {}): Promise<void> {
  const reviews = await import('../../../../src/main/features/kstar/review-service');
  const initial = reviews.createInitialKstarReview(episodeRecord);
  await reviews.saveKstarReviewRecord('user-b5', { ...initial, ...overrides });
}

async function seedRequirement(episodeIds: string[]): Promise<import('../../../../src/main/features/kstar/requirement-types').KstarRequirementRecord> {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const task = store.createKstarTaskRecord('user-b5', { conversationId: 'cid-b5', title: 'B5 task' });
  const requirement = store.createKstarRequirementRecord('user-b5', {
    taskId: task.id,
    conversationId: 'cid-b5',
    userMessageIds: ['msg-b5'],
    title: 'Build the report',
    goalText: 'Build the report with verified tooling',
  });
  requirement.episodeIds = episodeIds;
  await store.replaceKstarTask('user-b5', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id });
  await store.replaceKstarRequirement('user-b5', requirement);
  return requirement;
}

async function seedForecastRecord(input: {
  id: string;
  requirementId: string;
  projectionId: string;
  ruleRefs: string[];
}): Promise<void> {
  const recallStore = await import('../../../../src/main/features/recall/store');
  await recallStore.writeRecallJsonRecord('user-b5', 'world-model-forecasts', input.id, {
    schemaVersion: 1,
    ownerId: 'user-b5',
    id: input.id,
    taskRunId: 'task-b5-provenance',
    requirementId: input.requirementId,
    projectionId: input.projectionId,
    projectionConfirmedAt: '2026-08-16T00:00:00.000Z',
    assetVersions: {},
    ruleRefs: input.ruleRefs,
    snapshotId: 'snap-b5-provenance',
    input: {
      k: { abilityAssetRefs: [], rules: [] },
      s: { conversationSummary: 'Build the report' },
      t: { userGoal: 'Build the report', constraints: [] },
    },
    forecast: {
      aHat: { plan: [], expectedTools: [], expectedActors: [] },
      rHat: { summary: 'The report is built.', acceptanceSignals: [], predictedFiles: [] },
      predictedRisks: [],
    },
    createdAt: '2026-08-16T00:00:00.000Z',
  });
}

const learningReview = {
  expectedResult: 'The report is built.',
  actualResult: 'The report was built with the workflow.',
  deltaR: 0.3,
  deltaA: 0.1,
  outcome: 'better_than_expected',
  attribution: 'execution_gap',
  reason: 'The workflow is worth reusing.',
  confidence: 0.9,
};

describe('KStar task-level precipitation (B5)', () => {
  it('builds a B-local proposal without any ownerless external update', async () => {
    const epB = episode('kse-b5-ownerless-p3394', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    await seedEpisode(epB);
    await seedReview(epB, learningReview);
    const requirement = await seedRequirement([epB.id]);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    expect(result.proposals).toHaveLength(1);
    // 并行 episode store 已删除（它没有 uid 作用域、读侧从未接线）：不再存在"外部无主更新"
    // 这一输入通道，因此这里断言的是 B 本地沉淀本身不引入任何外部来源。
    expect(result.proposals[0].sourceRefs.some((ref) => ref.kind === 'authorized_external_system')).toBe(false);
    expect(result.proposals[0].sourceRefs).toContainEqual(expect.objectContaining({ kind: 'execution', id: epB.id }));
    expect(result.createdAssetIds).toEqual([]);
    expect(result.candidateIds).toEqual([]);
    expect(result.experienceIds).toEqual([]);
  });


  it('carries persisted Projection, Forecast, Episode, Review and delta provenance into candidates', async () => {
    const ep = {
      ...episode('kse-b5-provenance', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]),
      projectionId: 'proj-b5-provenance',
      forecastId: 'wf-b5-provenance',
    };
    await seedEpisode(ep);
    await seedReview(ep, {
      ...learningReview,
      actionDelta: {
        missingTools: [], unexpectedTools: [], missingActors: [], unexpectedActors: [],
        missingPlanSteps: [], extraActions: [], failedActions: [], orderMismatch: false,
      },
      resultDelta: {
        acceptanceSignals: [{ signal: 'report exists', status: 'met', evidence: 'file check' }],
        missingPredictedFiles: [], unexpectedProducedFiles: [], terminalStatus: 'completed',
      },
    });
    const requirement = await seedRequirement([ep.id]);
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const linkedRequirement = { ...requirement, projectionId: 'proj-b5-provenance', forecastId: 'wf-b5-provenance' };
    await requirementStore.replaceKstarRequirement('user-b5', linkedRequirement);
    await seedForecastRecord({
      id: 'wf-b5-provenance',
      requirementId: linkedRequirement.id,
      projectionId: 'proj-b5-provenance',
      ruleRefs: ['rule:asset-b5:1'],
    });

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', linkedRequirement);

    expect(result.proposals[0].learningProvenance).toMatchObject({
      projectionId: 'proj-b5-provenance',
      forecastId: 'wf-b5-provenance',
      episodeId: ep.id,
      attribution: 'execution_gap',
      ruleRefs: ['rule:asset-b5:1'],
    });
    expect(result.proposals[0].learningProvenance?.actionDelta).toBeDefined();
    expect(result.proposals[0].learningProvenance?.resultDelta).toBeDefined();
  });

  it('keeps missing Forecast provenance explicit and marks ExtractionRun degraded', async () => {
    const ep = {
      ...episode('kse-b5-no-forecast', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]),
      projectionId: 'proj-b5-no-forecast',
      forecastId: 'wf-b5-missing',
    };
    await seedEpisode(ep);
    await seedReview(ep, learningReview);
    const requirement = await seedRequirement([ep.id]);
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const linkedRequirement = { ...requirement, projectionId: ep.projectionId, forecastId: ep.forecastId };
    await requirementStore.replaceKstarRequirement('user-b5', linkedRequirement);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', linkedRequirement);

    expect(result.proposals[0].learningProvenance).toMatchObject({
      projectionId: ep.projectionId,
      episodeId: ep.id,
      attribution: 'execution_gap',
      ruleRefs: [],
    });
    expect(result.proposals[0].learningProvenance).not.toHaveProperty('forecastId');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    expect(await episodeStore.readKstarJsonRecord('user-b5', 'extraction-runs', `ksx-${ep.id}`)).toMatchObject({
      status: 'degraded',
      error: 'Forecast provenance is unavailable; candidate evidence is incomplete.',
    });
  });

  it('emits nothing when no review clears the evidence gate', async () => {
    const epA = episode('kse-b5-nosig', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    await seedEpisode(epA);
    await seedReview(epA, { confidence: 0.2 }); // no learning signal, no high-confidence gap
    const requirement = await seedRequirement(['kse-b5-nosig']);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    expect(result.proposals).toHaveLength(0);
    expect(result.experienceIds).toHaveLength(0);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect(await assets.listAbilityAssets('user-b5')).toHaveLength(0);
  });

  it('emits a gap asset from the highest-confidence review across episodes', async () => {
    const epA = episode('kse-b5-gap-a', 'Build the report', [{ name: 'read_file' }], 'failed');
    const epB = episode('kse-b5-gap-b', 'Build the report', [{ name: 'read_file' }]);
    await seedEpisode(epA);
    await seedEpisode(epB);
    await seedReview(epA, {
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'worse_than_expected',
      attribution: 'template_gap',
      reason: 'A report template is missing for this kind of task.',
      // 缺口候选必须有推理出的 lesson：只有 reason（诊断文本）时不再产候选，
      // 否则写进池子的是一句读不懂的诊断而不是可复用认知。
      lesson: 'When a report task lacks a fixed template, scaffold the section structure first to avoid reworking the layout each time.',
      confidence: 0.85,
    });
    await seedReview(epB, {
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'unclear',
      attribution: 'unclear',
      reason: 'No signal.',
      confidence: 0.3,
    });
    const requirement = await seedRequirement(['kse-b5-gap-a', 'kse-b5-gap-b']);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    // 缺口候选的正文必须是推理出的 lesson。此前会拿 review.reason 拼成
    // 「遇到同类情况时，应注意修正：<诊断文本>」——那是诊断，不是可复用认知。
    const gap = result.proposals.find((proposal) => proposal.suggestedType === 'template');
    expect(gap).toBeDefined();
    // 标题 = 内容核心本身（无模板前缀/scope 后缀——前缀由渲染层分类标签承担）。
    // 标题 = 内容核心第一句主干（lessonTitleCore），无模板前缀/scope 后缀。
    expect(gap!.summary).toBe('When a report task lacks a fixed templat…');
    expect(gap!.summary).not.toContain('待修正经验：');
    expect(gap!.judgment).toBe('When a report task lacks a fixed template, scaffold the section structure first to avoid reworking the layout each time.');
    expect(gap!.judgment).not.toContain('A report template is missing');
    expect(gap!.learningSignal?.confidence).toBe(0.85);
  });

  it('does not precipitate when the ΔR signal is below the noise gate (|ΔR| < 0.15)', async () => {
    const epA = episode('kse-b5-tiny', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    await seedEpisode(epA);
    await seedReview(epA, {
      expectedResult: 'A report is built.',
      actualResult: 'The report was built.',
      deltaR: 0.05, // tiny delta = measurement noise, not a lesson
      deltaA: 0.02,
      outcome: 'unclear',
      attribution: 'execution_gap',
      reason: 'Minor difference only.',
      confidence: 0.8,
    });
    const requirement = await seedRequirement(['kse-b5-tiny']);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    expect(result.proposals).toHaveLength(0);
    expect(result.experienceIds).toHaveLength(0);
  });

  it('does not precipitate a routine met_expected without a lesson (process-experience noise gate)', async () => {
    const epA = episode('kse-b5-routine', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    await seedEpisode(epA);
    await seedReview(epA, {
      expectedResult: 'A report is built.',
      actualResult: 'The report was built.',
      deltaR: 0,
      deltaA: 0,
      outcome: 'met_expected',
      attribution: 'unclear',
      reason: '任务按预期完成。',
      confidence: 0.95,
      // No lesson: routine success carries nothing forward.
    });
    const requirement = await seedRequirement(['kse-b5-routine']);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    expect(result.proposals).toHaveLength(0);
    expect(result.experienceIds).toHaveLength(0);
  });

  it('does not aggregate an excluded-only secondary attribution into a reusable asset', async () => {
    const epA = episode('kse-b5-permission', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    await seedEpisode(epA);
    await seedReview(epA, {
      deltaR: -0.8,
      deltaA: -0.2,
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: 'The operation was blocked by an authorization policy.',
      confidence: 0.95,
      lesson: 'Do not retry an operation after an authorization policy blocks it.',
      attributionDetails: [{
        category: 'permission_blocked',
        confidence: 1,
        evidenceRefs: epA.evidenceRefs,
        source: 'deterministic',
      }],
    });
    const requirement = await seedRequirement([epA.id]);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = precipitation.aggregateRequirementProposals({
      requirement,
      episodes: [epA],
      reviews: [await (await import('../../../../src/main/features/kstar/review-service')).readKstarReview('user-b5', epA.id)].filter(Boolean) as KstarReviewRecord[],
    });
    expect(result).toEqual([]);
  });

  it('tolerates missing episodes/reviews without throwing', async () => {
    const requirement = await seedRequirement(['kse-b5-missing']);
    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    await expect(precipitation.precipitateRequirementLevel('user-b5', requirement)).resolves.toMatchObject({
      proposals: [],
      experienceIds: [],
    });
  });
});
