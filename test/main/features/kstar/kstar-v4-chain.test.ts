import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Scenario test for the design-v4 implementation (2026-08-15):
 *
 *  1. KStar lesson → unified candidate pool (saveRecallCandidate with
 *     captureKey `kstar-...` + learningProvenance) — no direct asset write.
 *  2. autoApplyRecallCandidate runs semantic dedup before promote:
 *     - same wording → exact fingerprint merge (pool dedup);
 *     - different wording, same meaning → semantic dedup merges into one
 *       asset (quality fusion: existing wins → evidence merge);
 *     - no match → normal promote (asset with automatically_extracted_
 *       unverified lifecycle).
 *  3. Quiet-window auto-close: task terminal schedules pendingAutoCloseAt;
 *     window expiry runs finish → requirement-level precipitation.
 *  4. User message cancels the pending auto-close.
 *
 * Embedding is injected via _injectEmbeddingForTest (no ONNX in tests).
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
let _stopClosure: (() => void) | undefined;
const cids: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  modelCalls.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kstar-v4-chain-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevFlag = process.env.ORKAS_COMMANDER_CENTRIC_KSTAR;
  prevRouting = process.env.ORKAS_KSTAR_HOST_ROUTING;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  process.env.ORKAS_COMMANDER_CENTRIC_KSTAR = '1';
  process.env.ORKAS_KSTAR_HOST_ROUTING = '1';
  const users = await import('../../../../src/main/features/users');
  users.activateUser('user-a');
  const busModule = await import('../../../../src/main/features/group_chat/bus');
  busModule._setHostRoutingJudgeForTest(async () => ({ isTask: true, continuation: false }));
  const autoForecast = await import('../../../../src/main/features/kstar/auto-forecast');
  autoForecast._setAutoForecastGeneratorForTest(async () => JSON.stringify([
    { id: 'c1', plan: ['Inspect', 'Verify'], expectedTools: ['read_file'], expectedActors: ['commander'], predictedResult: { summary: 'done' } },
    { id: 'c2', plan: ['Draft', 'Deliver'], expectedTools: ['write_file'], expectedActors: ['commander'], predictedResult: { summary: 'done too' } },
  ]));
  const closure = await import('../../../../src/main/features/kstar/task-closure');
  closure._setAutoCloseQuietMsForTest(50);
  // Start the terminal subscriber so scheduleAutoClose runs on completed runs.
  _stopClosure = closure.startGroupKstarClosure();
});

afterEach(async () => {
  _stopClosure?.();
  _stopClosure = undefined;
  const groupChat = await import('../../../../src/main/features/group_chat');
  for (const cid of cids.splice(0)) await groupChat.dropConv('user-a', cid).catch(() => undefined);
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevFlag === undefined) delete process.env.ORKAS_COMMANDER_CENTRIC_KSTAR;
  else process.env.ORKAS_COMMANDER_CENTRIC_KSTAR = prevFlag;
  if (prevRouting === undefined) delete process.env.ORKAS_KSTAR_HOST_ROUTING;
  else process.env.ORKAS_KSTAR_HOST_ROUTING = prevRouting;
  const similarity = await import('../../../../src/main/features/recall/similarity');
  similarity.clearEmbedCacheForTest();
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

/** Seed a closed requirement with a lesson-bearing review + episode. */
async function seedRequirementWithLesson(cid: string, goal: string, lesson: string): Promise<string> {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const task = store.createKstarTaskRecord('user-a', { conversationId: cid, title: goal.slice(0, 30) });
  const req = store.createKstarRequirementRecord('user-a', {
    taskId: task.id, conversationId: cid, userMessageIds: ['m1'], title: goal.slice(0, 30), goalText: goal,
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
    taskRunId: task.id, purpose: 'review', taskText: goal,
    authorization: 'workspace_policy', confirm: true,
  });
  const episode = {
    schemaVersion: 1, ownerId: 'user-a', id: `kse-${req.id}-ep`, sessionId: 'sess-1', sessionKind: 'cogseed_runtime',
    taskRunId: `run-${req.id}`, k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: { workspaceId: 'workspace-a' }, t: { userGoal: goal, constraints: [] },
    a: { toolCalls: [{ name: 'read_file', status: 'ok' as const, argumentsSummary: '{}' }, { name: 'write_file', status: 'ok' as const, argumentsSummary: '{}' }], agentActions: [] },
    r: { status: 'completed' as const, producedFiles: [], finalText: 'done' },
    evidenceRefs: [{ kind: 'conversation' as const, id: cid }],
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  };
  const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
  await episodeStore.writeKstarEpisode('user-a', episode);
  const reviews = await import('../../../../src/main/features/kstar/review-service');
  await reviews.saveKstarReviewRecord('user-a', {
    schemaVersion: 1, ownerId: 'user-a', id: `ksr-${episode.id}`, episodeId: episode.id,
    deltaR: 'unknown', deltaA: 'unknown', outcome: 'met_expected', attribution: 'unclear',
    reason: 'lesson reusable', confidence: 0.9, lesson,
    reviewState: 'inferred', inferenceMethod: 'commander', needsConfirmation: false,
    evidenceRefs: episode.evidenceRefs, createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  });
  await store.replaceKstarRequirement('user-a', {
    ...req, projectionId: preview.id, projectionIds: [preview.id], episodeIds: [episode.id],
  });
  return req.id;
}

describe('KStar design-v4 chain (candidate pool + semantic dedup + auto-close)', () => {
  it('1. precipitates a lesson into the unified candidate pool then promotes it to an asset', async () => {
    const cid = newCid();
    const requirementId = await seedRequirementWithLesson(cid, '写一份 500 字资料', 'N 字资料类请求：交付开头注明实际字数并按板块组织');
    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const requirement = await (await import('../../../../src/main/features/kstar/requirement-store'))
      .readKstarRequirement('user-a', requirementId);

    const result = await precipitation.precipitateRequirementLevel('user-a', requirement!);

    // Lesson entered the unified pool (kstar- captureKey) and promoted.
    expect(result.candidateIds.length).toBeGreaterThan(0);
    expect(result.createdAssetIds).toHaveLength(1);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const asset = await assets.readAbilityAsset('user-a', result.createdAssetIds[0]);
    expect(asset.statement).toContain('N 字资料');
    // Honest lifecycle from the system-actor promote (P0-2).
    expect(asset.lifecycleStatus).toBe('automatically_extracted_unverified');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const all = await candidates.listRecallCandidates('user-a');
    expect(all.some((c) => c.status === 'confirmed' && String(c.captureKey).startsWith('kstar-'))).toBe(true);
  });

  it('2. semantic dedup: same rule, different wording → merges into one asset', async () => {
    const similarity = await import('../../../../src/main/features/recall/similarity');
    // Both lessons "say the same thing" → identical embedding → cosine 1.0.
    const vector = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
    similarity._injectEmbeddingForTest('user-a', 'A 类任务：交付开头注明实际字数', vector);
    similarity._injectEmbeddingForTest('user-a', 'B 类任务：开头标注真实字数', vector);

    const cid = newCid();
    const req1 = await seedRequirementWithLesson(cid, '任务一', 'A 类任务：交付开头注明实际字数');
    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const r1 = await store.readKstarRequirement('user-a', req1);
    await precipitation.precipitateRequirementLevel('user-a', r1!);

    const cid2 = newCid();
    const req2 = await seedRequirementWithLesson(cid2, '任务二', 'B 类任务：开头标注真实字数');
    const r2 = await store.readKstarRequirement('user-a', req2);
    const result2 = await precipitation.precipitateRequirementLevel('user-a', r2!);

    // Second precipitation found the semantic duplicate: no NEW asset.
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const all = await assets.listAbilityAssets('user-a');
    expect(all).toHaveLength(1);
    // And the second candidate was merged (mergedIntoAssetId) not promoted.
    expect(result2.createdAssetIds).toHaveLength(0);
    expect(result2.mergedIntoIds.length).toBeGreaterThan(0);
  });

  it('3. quiet-window auto-close: schedule → pendingAutoCloseAt → expiry runs finish', async () => {
    // Seed an open requirement directly (terminal events are failed in the
    // mock-model test env; the schedule logic itself is what we verify).
    const cid = newCid();
    const requirementId = await seedRequirementWithLesson(cid, '写一份 500 字资料', 'N 字资料类请求：交付开头注明实际字数');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const closure = await import('../../../../src/main/features/kstar/task-closure');

    // Schedule the quiet window (as the terminal listener would).
    const scheduled = await closure.scheduleAutoClose('user-a', cid);
    expect(scheduled.scheduled).toBe(true);
    const state = await store.readConversationTaskState('user-a', cid);
    expect(state?.pendingAutoCloseAt).toBeTruthy();

    // Idempotent: re-schedule returns the same window.
    const again = await closure.scheduleAutoClose('user-a', cid);
    expect(again.at).toBe(state!.pendingAutoCloseAt);

    // Force expiry, then run the auto-close → finish → taskComplete.
    await store.replaceConversationTaskState('user-a', {
      ...state!,
      pendingAutoCloseAt: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const outcome = await closure.runAutoClose('user-a', cid);
    expect(outcome.ok).toBe(true);
    const after = await store.readConversationTaskState('user-a', cid);
    expect(after?.taskComplete).toBe(true);
    void requirementId;
  });

  it('4. user message cancels the pending auto-close window', async () => {
    const cid = newCid();
    await seedRequirementWithLesson(cid, '写一份 500 字资料', 'N 字资料类请求：交付开头注明实际字数');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const closure = await import('../../../../src/main/features/kstar/task-closure');

    await closure.scheduleAutoClose('user-a', cid);
    const state = await store.readConversationTaskState('user-a', cid);
    expect(state?.pendingAutoCloseAt).toBeTruthy();

    // A user message cancels the window (continuation keeps the task open).
    await closure.cancelAutoClose('user-a', cid);
    const after = await store.readConversationTaskState('user-a', cid);
    expect(after?.pendingAutoCloseAt).toBeUndefined();
    expect(after?.taskComplete).toBe(false);
  });

  it('5. internal-control turn (Commander review request) does NOT cancel the auto-close window', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const closure = await import('../../../../src/main/features/kstar/task-closure');

    const cid = newCid();
    await seedRequirementWithLesson(cid, '写一份 500 字资料', 'N 字资料类请求：交付开头注明实际字数');
    await closure.scheduleAutoClose('user-a', cid);
    const before = await store.readConversationTaskState('user-a', cid);
    expect(before?.pendingAutoCloseAt).toBeTruthy();

    // A Commander review request rides fromActorId=USER_ID for routing but is
    // internalControl=true: it must NOT behave like a user message (the old
    // turn gate cancelled the just-scheduled window on every review turn —
    // the auto-close timer was killed by the closure's own review request).
    await bus.enqueueCommanderControlMessage({
      userId: 'user-a',
      cid,
      displayText: '',
      control: { type: 'kstar_review_request', episodeId: 'kse-test', evidence: {} },
    });
    await waitForQuiescent(bus, cid);

    const after = await store.readConversationTaskState('user-a', cid);
    expect(after?.pendingAutoCloseAt).toBe(before!.pendingAutoCloseAt);
    expect(after?.taskComplete).toBe(false);
  });

  it('6. real user message cancels then re-schedules the auto-close window (activity-based)', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const closure = await import('../../../../src/main/features/kstar/task-closure');

    const cid = newCid();
    await seedRequirementWithLesson(cid, '写一份 500 字资料', 'N 字资料类请求：交付开头注明实际字数');
    await closure.scheduleAutoClose('user-a', cid);
    const before = await store.readConversationTaskState('user-a', cid);
    expect(before?.pendingAutoCloseAt).toBeTruthy();

    // Non-task judgement keeps the seeded state untouched; the turn gate must
    // still cancel the window for a genuine user message (activity-based:
    // the completed turn then schedules a fresh window).
    bus._setHostRoutingJudgeForTest(async () => ({ isTask: false, continuation: false }));
    await bus.enqueue({ uid: 'user-a', cid, fromActorId: 'user', text: '继续' });
    await waitForQuiescent(bus, cid);

    const after = await store.readConversationTaskState('user-a', cid);
    expect(after?.taskComplete).toBe(false);
    if (after?.pendingAutoCloseAt) {
      // A fresh window replaced the cancelled one (terminal re-schedule).
      expect(after.pendingAutoCloseAt).not.toBe(before!.pendingAutoCloseAt);
    }
  });


});
