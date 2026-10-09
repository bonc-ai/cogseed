import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Post-merge full-chain scenario (P3394 spec alignment):
 * user task → host routing (judge) → upsert_state → request_projection →
 * auto-forecast (world model) → Commander executes → per-run closure records
 * review (hidden from UI via system_kind) → task switch closes requirement →
 * lesson precipitates as a rule asset with honest lifecycle status.
 *
 * This exercises the whole Commander-centric line on the MERGED tree
 * (develop 39 commits + our 25), verifying no regression from the merge.
 */

const modelCalls = vi.hoisted(() => [] as Array<{ sessionId: string; message: string; toolNames: string[] }>);

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    const toolNames = (opts.extraTools || []).map((tool: any) => tool.name);
    modelCalls.push({ sessionId: opts.sessionId, message: opts.message, toolNames });
    opts.onResolvedRuntime?.({
      providerId: 'test-provider',
      modelId: 'test-model',
      profileId: 'test-profile',
      entryId: 'test-entry',
      toolNames: ['read_file', ...toolNames],
    });
    yield { type: 'final', text: 'Commander 正常回复' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
  hasActiveSession: vi.fn(() => true),
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevFlag: string | undefined;
let prevRouting: string | undefined;
const cids: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  modelCalls.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-merge-chain-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  prevFlag = process.env.COGSEED_COMMANDER_CENTRIC_KSTAR;
  prevRouting = process.env.COGSEED_KSTAR_HOST_ROUTING;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  process.env.COGSEED_COMMANDER_CENTRIC_KSTAR = '1';
  process.env.COGSEED_KSTAR_HOST_ROUTING = '1';
  const users = await import('../../../../src/main/features/users');
  users.activateUser('user-a');
  const busModule = await import('../../../../src/main/features/group_chat/bus');
  busModule._setHostRoutingJudgeForTest(async () => ({ isTask: true, continuation: false }));
  const autoForecast = await import('../../../../src/main/features/kstar/auto-forecast');
  autoForecast._setAutoForecastGeneratorForTest(async () => JSON.stringify([
    { id: 'c1', plan: ['Inspect', 'Verify'], expectedTools: ['read_file'], expectedActors: ['commander'], predictedResult: { summary: 'done' } },
    { id: 'c2', plan: ['Draft', 'Deliver'], expectedTools: ['read_file'], expectedActors: ['commander'], predictedResult: { summary: 'done too' } },
  ]));
});

afterEach(async () => {
  const groupChat = await import('../../../../src/main/features/group_chat');
  for (const cid of cids.splice(0)) await groupChat.dropConv('user-a', cid).catch(() => undefined);
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  if (prevFlag === undefined) delete process.env.COGSEED_COMMANDER_CENTRIC_KSTAR;
  else process.env.COGSEED_COMMANDER_CENTRIC_KSTAR = prevFlag;
  if (prevRouting === undefined) delete process.env.COGSEED_KSTAR_HOST_ROUTING;
  else process.env.COGSEED_KSTAR_HOST_ROUTING = prevRouting;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function newCid(): string {
  const cid = `cid-${Math.random().toString(16).slice(2, 10)}`;
  cids.push(cid);
  return cid;
}

async function waitForQuiescent(bus: typeof import('../../../../src/main/features/group_chat/bus'), cid: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (bus.isQuiescent('user-a', cid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`conversation did not quiesce: ${cid}`);
}

function recordsIn(collection: string): string[] {
  const dir = path.join(tmpDir, 'user-a', 'cloud', 'kstar', collection);
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
}

function recallRecords(sub: string): string[] {
  const dir = path.join(tmpDir, 'user-a', 'cloud', 'recall', 'records', sub);
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
}

async function seedClosedRequirementWithLesson(): Promise<{ taskId: string; requirementId: string; cid: string }> {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const cid = newCid();
  const task = store.createKstarTaskRecord('user-a', { conversationId: cid, title: 'T' });
  const req = store.createKstarRequirementRecord('user-a', {
    taskId: task.id, conversationId: cid, userMessageIds: ['m1'], title: 'T', goalText: '写一份 500 字资料',
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
    taskRunId: task.id, purpose: 'review', taskText: '写一份 500 字资料',
    authorization: 'workspace_policy', confirm: true,
  });
  const episode = {
    schemaVersion: 1, ownerId: 'user-a', id: `kse-${req.id}-ep`, sessionId: 'sess-1', sessionKind: 'cogseed_runtime',
    taskRunId: `run-${req.id}`, k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: { workspaceId: 'workspace-a' }, t: { userGoal: '写一份 500 字资料', constraints: [] },
    a: { toolCalls: [{ name: 'read_file', status: 'ok' as const, argumentsSummary: '{}' }, { name: 'write_file', status: 'ok' as const, argumentsSummary: '{}' }], agentActions: [] },
    r: { status: 'completed' as const, producedFiles: [], finalText: '497 字资料已交付' },
    evidenceRefs: [{ kind: 'conversation' as const, id: cid }],
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  };
  const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
  await episodeStore.writeKstarEpisode('user-a', episode);
  const reviews = await import('../../../../src/main/features/kstar/review-service');
  await reviews.saveKstarReviewRecord('user-a', {
    schemaVersion: 1, ownerId: 'user-a', id: `ksr-${episode.id}`, episodeId: episode.id,
    deltaR: 'unknown', deltaA: 'unknown', outcome: 'met_expected', attribution: 'unclear',
    reason: '任务完成且 lesson 可复用', confidence: 0.9,
    lesson: 'N 字资料类请求：交付开头注明实际字数并按板块组织',
    reviewState: 'inferred', inferenceMethod: 'commander', needsConfirmation: false,
    evidenceRefs: episode.evidenceRefs, createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  });
  await store.replaceKstarRequirement('user-a', {
    ...req, projectionId: preview.id, projectionIds: [preview.id],
    episodeIds: [episode.id],
  });
  return { taskId: task.id, requirementId: req.id, cid };
}

describe('post-merge full-chain scenario (Commander-centric KStar on merged tree)', () => {
  it('opens task + projection + auto-forecast from a user task message', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    bus.subscribe('user-a', cid, () => undefined);

    await bus.enqueue({ uid: 'user-a', cid, fromActorId: 'user', text: '帮我写一份 安阳城市 的资料 500 字' });
    await waitForQuiescent(bus, cid);

    // 1. Commander has NO kstar_control tool (world model owns lifecycle).
    expect(modelCalls[0].toolNames).not.toContain('kstar_control');
    // 2. Host routing opened task + projection.
    const taskState = await store.readConversationTaskState('user-a', cid);
    expect(taskState?.currentTaskId).toMatch(/^kst-/);
    const requirement = await store.readKstarRequirement('user-a', taskState!.currentRequirementId!);
    expect(requirement?.projectionId).toBeTruthy();
    // 3. World-model auto-forecast committed.
    expect(requirement?.forecastId).toMatch(/^wf-/);
    expect(recallRecords('world-model-forecasts')).toHaveLength(1);
    expect(recallRecords('projections')).toHaveLength(1);
  });

  it('tags the Commander review reply as host-internal so the UI hides it', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    bus.subscribe('user-a', cid, () => undefined);

    await bus.enqueue({
      uid: 'user-a', cid, fromActorId: 'commander',
      text: '<kstar-review>{"outcome":"met_expected","attribution":"unclear","deltaR":0,"deltaA":0,"reason":"done","confidence":0.9}</kstar-review>',
    });
    await waitForQuiescent(bus, cid);

    const messages = await groupChat.readMessages('user-a', cid);
    const review = messages.find((m) => String(m.text).includes('<kstar-review>'));
    expect(review?.system_kind).toBe('kstar_review');
  });

  it('precipitates a lesson-bearing closed requirement as an honest rule asset (P3394 §3.1 line)', async () => {
    const seeded = await seedClosedRequirementWithLesson();
    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const requirement = await (await import('../../../../src/main/features/kstar/requirement-store'))
      .readKstarRequirement('user-a', seeded.requirementId);

    const result = await precipitation.precipitateRequirementLevel('user-a', requirement!);

    expect(result.createdAssetIds.length).toBeGreaterThan(0);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const asset = await assets.readAbilityAsset('user-a', result.createdAssetIds[0]);
    // Lesson became the asset body; honest lifecycle (P0-2) survives the
    // merged normalization (develop renamed the enum, both values preserved).
    expect(asset.statement).toContain('N 字资料');
    expect(['system_precipitated_unverified', 'automatically_extracted_unverified']).toContain(asset.lifecycleStatus);
    expect(asset.maturity).toBe('seed');
  });
});
