import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-req-close-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeCompletedEpisode() {
  const episodes = await import('../../../../src/main/features/kstar/episode-store');
  await episodes.writeKstarEpisode('user-a', {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: 'kse-run-a',
    sessionId: 'gconv-cid-a',
    taskRunId: 'task-a',
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: { workspaceId: 'workspace-a' },
    t: { userGoal: 'Fix OAuth callback and verify login succeeds', constraints: [] },
    a: { toolCalls: [{ name: 'write_file', status: 'ok' }], agentActions: [] },
    r: {
      status: 'completed',
      finalText: 'Fixed the OAuth callback and wrote the regression test.',
      producedFiles: ['src/auth/callback.ts', 'test/auth/callback.test.ts'],
    },
    evidenceRefs: [{ kind: 'execution', id: 'task-a' }],
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:01:00.000Z',
  });
}

async function seedRequirement() {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-a', title: 'Fix OAuth' });
  const requirement = store.createKstarRequirementRecord('user-a', {
    taskId: task.id,
    conversationId: 'cid-a',
    userMessageIds: ['msg-a'],
    title: 'Fix OAuth callback',
    goalText: 'Fix OAuth callback and verify login succeeds',
  });
  requirement.status = 'waiting_review';
  requirement.episodeIds = ['kse-run-a'];
  await store.replaceKstarTask('user-a', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id });
  await store.replaceKstarRequirement('user-a', requirement);
  return { store, task, requirement };
}

async function seedWorldModelForecast(requirementId: string): Promise<string> {
  const { saveWorldModelForecast } = await import('../../../../src/main/features/recall/world-model');
  const record = {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: 'wf-test-forecast',
    taskRunId: 'task-a',
    requirementId,
    input: {
      k: { abilityAssetRefs: [], rules: [] },
      s: { conversationSummary: 'Fix OAuth callback and verify login succeeds' },
      t: { userGoal: 'Fix OAuth callback and verify login succeeds', constraints: [] },
    },
    forecast: {
      aHat: { plan: ['write_file'], expectedTools: ['write_file'], expectedActors: ['commander'] },
      rHat: {
        summary: 'Fixed the OAuth callback and wrote the regression test.',
        acceptanceSignals: [],
        predictedFiles: ['src/auth/callback.ts', 'test/auth/callback.test.ts'],
      },
      predictedRisks: [],
    },
    createdAt: '2026-08-09T00:00:00.000Z',
  };
  await saveWorldModelForecast('user-a', record as any);
  return record.id;
}

describe('KSTAR requirement closure', () => {
  it('computes weighted PRM score with the Phase 2 weights', async () => {
    const closure = await import('../../../../src/main/features/kstar/requirement-closure');
    expect(closure.computeKstarPrmWeightedScore({ accuracy: 1, completeness: 0.5, usefulness: 0.25, clarity: 0 })).toBe(0.5);
  });

  it('closes with explicit met feedback as the highest priority signal', async () => {
    const { store, requirement } = await seedRequirement();
    const closure = await import('../../../../src/main/features/kstar/requirement-closure');

    const closed = await closure.closeKstarRequirement('user-a', {
      requirementId: requirement.id,
      userFeedback: { verdict: 'met', text: '用户确认已满足预期' },
    });

    expect(closed).toMatchObject({ status: 'closed' });
    expect(closed.prmReview).toMatchObject({ weightedScore: 1, deltaR: 0, deltaA: 0, outcome: 'met_expected', confidence: 1 });
    expect(closed.aar).toMatchObject({ candidateSeed: '用户确认已满足预期' });
    await expect(store.readKstarRequirement('user-a', requirement.id)).resolves.toMatchObject({ status: 'closed' });
  });

  it('does not fabricate a met_expected signal without a configured model', async () => {
    const { store, requirement } = await seedRequirement();
    await writeCompletedEpisode();
    const closure = await import('../../../../src/main/features/kstar/requirement-closure');

    const closed = await closure.closeKstarRequirement('user-a', { requirementId: requirement.id });

    expect(closed.prmReview).toMatchObject({
      outcome: 'unclear',
      deltaR: 'unknown',
      deltaA: 'unknown',
      confidence: 0,
    });
    expect(closed.aar?.candidateSeed).toBeUndefined();
  });

  it('uses conservative unknown scoring when no subjective feedback exists', async () => {
    const { requirement } = await seedRequirement();
    const closure = await import('../../../../src/main/features/kstar/requirement-closure');

    const closed = await closure.closeKstarRequirement('user-a', { requirementId: requirement.id });

    expect(closed.prmReview).toMatchObject({ weightedScore: 0.5, deltaR: 'unknown', deltaA: 'unknown', outcome: 'unclear', attribution: 'unclear', confidence: 0 });
    expect(closed.aar?.candidateSeed).toBeUndefined();
  });

  it('re-evaluates a previously unclear closed review when completion evidence and a world-model forecast become available', async () => {
    const { store, requirement } = await seedRequirement();
    const forecastId = await seedWorldModelForecast(requirement.id);
    await store.replaceKstarRequirement('user-a', { ...requirement, forecastId });
    const closure = await import('../../../../src/main/features/kstar/requirement-closure');

    const first = await closure.closeKstarRequirement('user-a', { requirementId: requirement.id });
    expect(first.prmReview?.deltaR).toBe('unknown');

    await writeCompletedEpisode();
    const second = await closure.closeKstarRequirement('user-a', { requirementId: requirement.id });

    expect(second.prmReview).toMatchObject({ outcome: 'met_expected', deltaR: 0 });
    expect(second.aar?.candidateSeed).toBeTruthy();
  });

  it('closes idempotently without rewriting an existing review', async () => {
    const { requirement } = await seedRequirement();
    const closure = await import('../../../../src/main/features/kstar/requirement-closure');

    const first = await closure.closeKstarRequirement('user-a', { requirementId: requirement.id, userFeedback: { verdict: 'partial', text: '遗漏刷新 token' } });
    const second = await closure.closeKstarRequirement('user-a', { requirementId: requirement.id, userFeedback: { verdict: 'not_met', text: 'ignored on rerun' } });

    expect(second).toEqual(first);
    expect(second.prmReview).toMatchObject({ deltaR: -0.5, outcome: 'worse_than_expected' });
  });
});
