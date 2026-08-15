import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KstarEpisodeRecord, KstarReviewRecord } from '../../../../src/main/features/kstar/types';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-tasklevel-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
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
  it('aggregates two episodes into one skill_method asset carrying both episodes evidence', async () => {
    const epA = episode('kse-b5-a', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    const epB = episode('kse-b5-b', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }, { name: 'grep' }]);
    await seedEpisode(epA);
    await seedEpisode(epB);
    await seedReview(epA, learningReview);
    await seedReview(epB, { ...learningReview, confidence: 0.6 });
    const requirement = await seedRequirement(['kse-b5-a', 'kse-b5-b']);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      suggestedType: 'skill_method',
      suggestedScope: 'report',
    });
    // Merged tool chain spans BOTH episodes, preserving first-seen order.
    expect(result.proposals[0].judgment).toContain('read_file → write_file → grep');
    // Merged evidence includes both executions.
    const sourceKinds = result.proposals[0].sourceRefs.filter((ref) => ref.kind === 'execution');
    expect(sourceKinds.map((ref) => ref.id).sort()).toEqual(['kse-b5-a', 'kse-b5-b']);
    // Strongest review drives the signal (confidence 0.9 > 0.6).
    expect(result.proposals[0].learningSignal?.confidence).toBe(0.9);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    const abilityAssets = await assets.listAbilityAssets('user-b5');
    const created = abilityAssets.filter((asset) => asset.id === result.createdAssetIds[0]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'skill_method',
      status: 'active',
      maturity: 'seed',
      // Honest confirmation semantics: promoted by the system actor via the
      // unified candidate pool — never claims user confirmation (P0-2).
      lifecycleStatus: 'automatically_extracted_unverified',
    });
    // Unified pool: the promoted candidate exists (confirmed) behind the asset.
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const saved = await candidates.listRecallCandidates('user-b5');
    expect(saved.some((c) => c.status === 'confirmed')).toBe(true);
    expect(result.candidateIds).toHaveLength(1);
  });

  it('is idempotent: re-running precipitation does not duplicate assets', async () => {
    const epA = episode('kse-b5-ida', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    await seedEpisode(epA);
    await seedReview(epA, learningReview);
    const requirement = await seedRequirement(['kse-b5-ida']);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const first = await precipitation.precipitateRequirementLevel('user-b5', requirement);
    const second = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    expect(second.createdAssetIds).toEqual(first.createdAssetIds);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const abilityAssets = await assets.listAbilityAssets('user-b5');
    expect(abilityAssets.filter((asset) => asset.id === first.createdAssetIds[0])).toHaveLength(1);
  });

  it('emits nothing when no review clears the evidence gate', async () => {
    const epA = episode('kse-b5-nosig', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    await seedEpisode(epA);
    await seedReview(epA, { confidence: 0.2 }); // no learning signal, no high-confidence gap
    const requirement = await seedRequirement(['kse-b5-nosig']);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    expect(result.proposals).toHaveLength(0);
    expect(result.createdAssetIds).toHaveLength(0);
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

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      suggestedType: 'template',
      summary: expect.stringContaining('待修正经验：'),
    });
    expect(result.proposals[0].judgment).toContain('A report template is missing');
    expect(result.proposals[0].learningSignal?.confidence).toBe(0.85);
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
    expect(result.createdAssetIds).toHaveLength(0);
  });

  it('precipitates when the ΔR signal clears the noise gate (|ΔR| >= 0.15)', async () => {
    const epA = episode('kse-b5-clear', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    await seedEpisode(epA);
    await seedReview(epA, {
      expectedResult: 'A report is built.',
      actualResult: 'The report was built much faster.',
      deltaR: 0.2,
      deltaA: 0.1,
      outcome: 'better_than_expected',
      attribution: 'execution_gap',
      reason: 'The workflow is worth reusing.',
      confidence: 0.9,
    });
    const requirement = await seedRequirement(['kse-b5-clear']);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    expect(result.proposals).toHaveLength(1);
    expect(result.createdAssetIds).toHaveLength(1);
  });

  it('precipitates a process-experience lesson even when the task met expectations (met_expected + lesson)', async () => {
    const epA = episode('kse-b5-proc', 'Build the report', [{ name: 'read_file' }, { name: 'write_file' }]);
    await seedEpisode(epA);
    await seedReview(epA, {
      expectedResult: 'A report is built.',
      actualResult: 'The report was built.',
      deltaR: 0,
      deltaA: 0,
      outcome: 'met_expected',
      attribution: 'unclear',
      reason: '审查发现合并冲突的类型断言（as X）会掩盖运行时错误，应改为显式判别。',
      confidence: 0.9,
      lesson: '合并冲突的类型断言（as X）会掩盖运行时错误，应改为显式判别联合。',
    });
    const requirement = await seedRequirement(['kse-b5-proc']);

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('user-b5', requirement);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].judgment).toContain('类型断言');
    expect(result.createdAssetIds).toHaveLength(1);
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
    expect(result.createdAssetIds).toHaveLength(0);
  });

  it('tolerates missing episodes/reviews without throwing', async () => {
    const requirement = await seedRequirement(['kse-b5-missing']);
    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    await expect(precipitation.precipitateRequirementLevel('user-b5', requirement)).resolves.toMatchObject({
      proposals: [],
      createdAssetIds: [],
    });
  });
});
