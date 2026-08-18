import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-forecast-'));
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  const { activateUser } = await import('../../../../src/main/features/users');
  activateUser('user-a');
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function seedConfirmedRequirement(cid: string): Promise<{ taskId: string; requirementId: string; projectionId: string }> {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const task = store.createKstarTaskRecord('user-a', { conversationId: cid, title: 'T' });
  const req = store.createKstarRequirementRecord('user-a', {
    taskId: task.id, conversationId: cid, userMessageIds: ['m1'], title: 'T', goalText: 'Review the code',
  });
  task.requirementIds = [req.id];
  task.currentRequirementId = req.id;
  await store.replaceKstarTask('user-a', task);
  await store.replaceKstarRequirement('user-a', req);
  await store.writeConversationTaskState('user-a', {
    ...store.createInitialConversationTaskState('user-a', cid),
    currentTaskId: task.id,
    currentRequirementId: req.id,
  });
  const proj = await import('../../../../src/main/features/recall/context-projection');
  const preview = await proj.previewContextProjection('user-a', {
    taskRunId: task.id, purpose: 'review', taskText: 'Review the code',
    authorization: 'workspace_policy', confirm: true,
  });
  await store.replaceKstarRequirement('user-a', { ...req, projectionId: preview.id, projectionIds: [preview.id] });
  return { taskId: task.id, requirementId: req.id, projectionId: preview.id };
}

const GENERATOR = async () => JSON.stringify([
  { id: 'c1', plan: ['Inspect', 'Verify'], expectedTools: ['read_file'], expectedActors: ['commander'], predictedResult: { summary: 'done' } },
  { id: 'c2', plan: ['Draft', 'Deliver'], expectedTools: ['write_file'], expectedActors: ['commander'], predictedResult: { summary: 'done too' } },
]);

describe('KStar world-model auto-forecast', () => {
  it('commits a forecast for a confirmed projection (world model owns prediction)', async () => {
    const cid = 'cid-af-1';
    const seeded = await seedConfirmedRequirement(cid);
    const af = await import('../../../../src/main/features/kstar/auto-forecast');
    af._setAutoForecastGeneratorForTest(GENERATOR);

    const res = await af.autoForecastForRequirement('user-a', cid, seeded.requirementId);
    expect(res.ok).toBe(true);
    expect(res.forecastId).toMatch(/^wf-/);

    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const requirement = await store.readKstarRequirement('user-a', seeded.requirementId);
    expect(requirement?.forecastId).toBe(res.forecastId);
  });

  it('is idempotent — a second call reuses the existing forecast', async () => {
    const cid = 'cid-af-2';
    const seeded = await seedConfirmedRequirement(cid);
    const af = await import('../../../../src/main/features/kstar/auto-forecast');
    af._setAutoForecastGeneratorForTest(GENERATOR);

    const first = await af.autoForecastForRequirement('user-a', cid, seeded.requirementId);
    const second = await af.autoForecastForRequirement('user-a', cid, seeded.requirementId);
    expect(second.ok).toBe(true);
    expect(second.forecastId).toBe(first.forecastId);
  });

  it('skips (ok:false) when the requirement has no confirmed projection yet', async () => {
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-b2', title: 'T2' });
    const req = store.createKstarRequirementRecord('user-a', {
      taskId: task.id, conversationId: 'cid-b2', userMessageIds: ['m2'], title: 'T2', goalText: 'Do something',
    });
    task.requirementIds = [req.id];
    task.currentRequirementId = req.id;
    await store.replaceKstarTask('user-a', task);
    await store.replaceKstarRequirement('user-a', req);

    const af = await import('../../../../src/main/features/kstar/auto-forecast');
    af._setAutoForecastGeneratorForTest(GENERATOR);
    const res = await af.autoForecastForRequirement('user-a', 'cid-b2', req.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/projection/);
  });

  it('returns ok:false when the generator produces no candidates (never blocks execution)', async () => {
    const seeded = await seedConfirmedRequirement('cid-af-4');
    const af = await import('../../../../src/main/features/kstar/auto-forecast');
    af._setAutoForecastGeneratorForTest(async () => 'no candidates here');

    const res = await af.autoForecastForRequirement('user-a', 'cid-a1', seeded.requirementId);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/candidates/);
  });

  it('parses tagged and bare JSON forecast output tolerantly', async () => {
    const af = await import('../../../../src/main/features/kstar/auto-forecast');
    const tagged = af.parseGeneratedForecastCandidates(
      '<kstar-forecast>[{"plan":["a"],"predictedResult":{"summary":"x"}}]</kstar-forecast>',
    );
    expect(tagged).toHaveLength(1);
    const bare = af.parseGeneratedForecastCandidates('[{"plan":["a"]},{"plan":["b"]}]');
    expect(bare).toHaveLength(2);
    const prose = af.parseGeneratedForecastCandidates('Here you go: [{"plan":["a"]}] thanks');
    expect(prose).toHaveLength(1);
    expect(af.parseGeneratedForecastCandidates('nothing')).toEqual([]);
  });
});
