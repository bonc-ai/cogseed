import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-extraction-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(() => { if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });

describe('KSTAR extraction run results', () => {
  it('writes actual candidate and asset ids after requirement precipitation', async () => {
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const episodes = await import('../../../../src/main/features/kstar/episode-store');
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-a', title: 'Build report' });
    const requirement = store.createKstarRequirementRecord('user-a', { taskId: task.id, conversationId: task.conversationId, userMessageIds: ['msg-a'], title: 'Build report', goalText: 'Build the report' });
    const episode = {
      schemaVersion: 1 as const, ownerId: 'user-a', id: 'kse-a', sessionId: 'sess-a', sessionKind: 'cogseed_runtime' as const,
      taskRunId: 'run-a', k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] }, s: {}, t: { userGoal: 'Build report', constraints: [] },
      a: { toolCalls: [{ name: 'read_file', status: 'ok' as const }, { name: 'write_file', status: 'ok' as const }], agentActions: [] },
      r: { status: 'completed' as const, producedFiles: [], finalText: 'done' }, evidenceRefs: [{ kind: 'execution' as const, id: 'kse-a' }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await episodes.writeKstarEpisode('user-a', episode);
    const review = await import('../../../../src/main/features/kstar/review-service');
    await review.saveKstarReviewRecord('user-a', { ...review.createInitialKstarReview(episode), deltaR: 0.3, deltaA: 0, outcome: 'better_than_expected', attribution: 'execution_gap', reason: 'Reusable workflow', confidence: 0.9, lesson: 'Use the verified report workflow.' });
    requirement.episodeIds = [episode.id];
    await store.replaceKstarRequirement('user-a', requirement);
    const result = await (await import('../../../../src/main/features/kstar/task-level-precipitation')).precipitateRequirementLevel('user-a', requirement);
    const run = await episodes.readKstarJsonRecord('user-a', 'extraction-runs', `ksx-${episode.id}`);
    expect(result.candidateIds.length).toBeGreaterThan(0);
    expect(run).toMatchObject({
      candidateIds: result.candidateIds,
      createdAssetIds: result.createdAssetIds,
      status: 'degraded',
      error: 'Forecast provenance is unavailable; candidate evidence is incomplete.',
    });
  });
});
