// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-T04 — one honest closed loop per scenario.
//
// Every other Run Center test mocks the projection: it hands the renderer a
// hand-written `CogSeedRendererBoardProjection` and asserts the DOM. That
// proves the renderer, not the contract between the two halves. Here the
// projections come from the **real `ipc-service` reading a real task store on
// a real filesystem** — only the Group Chat boundary is mocked, exactly as
// spec §14 requires ("不得全部 mock 到只剩函数名").
//
// What this catches that the mocked tests cannot: a field the backend stopped
// emitting, an ordinal computed differently from what the renderer expects, a
// status the projection filters out, an action the store no longer allows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRunCenterHarness, type RunCenterHarness } from './_run-center-harness';

const USER = 'cogseed-e2e-user';
const CONVERSATION = 'conv-e2e-aaaa1111';
const OTHER_CONVERSATION = 'conv-e2e-bbbb2222';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
let harness: RunCenterHarness | null = null;
/** Conversations the Group Chat side still knows about. */
let liveConversations: Set<string>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-e2e-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  liveConversations = new Set([CONVERSATION, OTHER_CONVERSATION]);
  vi.resetModules();
});

afterEach(async () => {
  // Every IPC reply here does real filesystem work, so a refresh can still be
  // in flight when the test ends. Tearing the window down under it produced an
  // unhandled rejection (`panel()` reading `document` on a destroyed window),
  // which Vitest rightly flags as a false-positive risk. Retire the poll first,
  // then drain, then destroy.
  if (harness) {
    harness.setPanelActive(false);
    await harness.flush().catch(() => undefined);
    harness.destroy();
  }
  harness = null;
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const taskStore = () => import('../../src/main/features/cogseed_backend/task-store');
const lifecycle = () => import('../../src/main/features/cogseed_backend/lifecycle');
const recovery = () => import('../../src/main/features/cogseed_backend/recovery');
const ipc = () => import('../../src/main/features/cogseed_backend/ipc-service');

interface MadeTask { taskId: string; sessionId: string; requestId: string }

async function createTask(input: {
  requestId: string;
  conversationId?: string;
  executionKind?: 'group-chat' | 'local-cli' | 'cogseed-native';
  parentTaskId?: string;
  agentId?: string;
  turnId?: string;
  retryOfTaskId?: string;
}): Promise<MadeTask> {
  const { createCogSeedTask } = await taskStore();
  const result = await createCogSeedTask(USER, {
    requestId: input.requestId,
    task: 'do the work',
    // The Group Chat bridge puts every task of a conversation in one session
    // (`gconv-<cid>`); ordinals are per-session, so sharing it is what makes
    // "Run 1 / Run 2" mean anything.
    ...(input.conversationId && input.executionKind === 'group-chat'
      ? { sessionId: `gconv-${input.conversationId}` }
      : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.executionKind ? { executionKind: input.executionKind } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.retryOfTaskId ? { retryOfTaskId: input.retryOfTaskId } : {}),
    ...(input.executionKind === 'group-chat'
      ? {
        groupChatRunId: `gcrun-${input.requestId}`,
        ...(input.turnId ? { groupChatTurnId: input.turnId, groupChatActorKind: 'agent' as const } : {}),
      }
      : {}),
    ...(input.executionKind === 'local-cli' ? { localCli: { cli: 'claude' } } : {}),
  } as never);
  return { taskId: result.task.taskId, sessionId: result.task.sessionId, requestId: input.requestId };
}

async function moveTo(taskId: string, status: string, errorCode?: string) {
  const { transitionCogSeedTask } = await lifecycle();
  return transitionCogSeedTask(USER, taskId, status as never, {
    source: 'group-chat',
    ...(errorCode ? { errorCode } : {}),
  } as never);
}

/**
 * The real service over the real store. Only the Group Chat boundary is
 * substituted: conversation existence, and the abort/retry side effects that
 * would otherwise require the whole bus.
 */
async function realService(overrides: Record<string, unknown> = {}) {
  const { createCogSeedIpcService } = await ipc();
  return createCogSeedIpcService({
    isConversationAvailable: async (_u: string, cid: string) => liveConversations.has(cid),
    abortGroupChat: async (_u: string, cid: string) => {
      // What the bus eventually does: the run's tasks reach a terminal state.
      const { listCogSeedTasks } = await taskStore();
      for (const task of await listCogSeedTasks(USER)) {
        if (task.conversationId !== cid) continue;
        if (['completed', 'failed', 'cancelled'].includes(task.status)) continue;
        await moveTo(task.taskId, 'cancelled');
      }
      return { ok: true };
    },
    ...overrides,
  } as never);
}

/**
 * Flush until the DOM actually reflects the projection, or give up loudly.
 *
 * `harness.flush()` returns as soon as no timer is pending, which is right for
 * a canned fixture that resolves immediately. Here every IPC reply does real
 * filesystem work, so the render can still be in flight — under coverage
 * instrumentation it reliably was. Polling a predicate keeps this deterministic
 * (no wall-clock sleeps) and independent of how slow the environment is.
 */
async function settleUntil(h: RunCenterHarness, predicate: () => boolean, label: string): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    if (predicate()) return;
    await h.flush();
  }
  throw new Error(`run-center e2e: timed out waiting for ${label}`);
}

/** Drive the renderer from the real projections. */
async function mountAgainst(
  service: Awaited<ReturnType<typeof realService>>,
  expectedCards: number,
) {
  const created = await createRunCenterHarness({
    board: () => service.boardProjection(USER),
    sessions: async () => ({ sessions: await service.sessionListProjection(USER) }),
    detail: (payload) => service.sessionProjection(USER, payload),
    action: (payload) => service.action(USER, payload),
  });
  await created.render();
  await settleUntil(
    created,
    () => created.$$('.dashboard-board-card').length === expectedCards,
    `${expectedCards} board card(s)`,
  );
  return created;
}

/** Click, then wait for the resulting async render to land. */
async function clickUntil(h: RunCenterHarness, selector: string, predicate: () => boolean, label: string) {
  await h.click(selector);
  await settleUntil(h, predicate, label);
}

const cardIds = (h: RunCenterHarness) =>
  h.$$('.dashboard-board-card').map((n) => n.getAttribute('data-dashboard-board-task-id'));

describe('RC-T04 Scenario A — a completed run, end to end', () => {
  it('agrees on identity and status across board, runs tree and detail', async () => {
    const run = await createTask({ requestId: 'req-a-run', conversationId: CONVERSATION, executionKind: 'group-chat' });
    const turn = await createTask({
      requestId: 'req-a-turn', conversationId: CONVERSATION, executionKind: 'group-chat',
      parentTaskId: run.taskId, turnId: 'turn-1', agentId: 'planner',
    });
    await moveTo(turn.taskId, 'queued');
    await moveTo(turn.taskId, 'running');
    await moveTo(turn.taskId, 'completed');
    await moveTo(run.taskId, 'queued');
    await moveTo(run.taskId, 'running');
    await moveTo(run.taskId, 'completed');

    const service = await realService();
    harness = await mountAgainst(service, 2);

    // Board — both records, in the completed column, from the real store.
    expect(cardIds(harness).sort()).toEqual([run.taskId, turn.taskId].sort());
    const completed = harness.$$('[data-dashboard-board-column="completed"] .dashboard-board-card');
    expect(completed).toHaveLength(2);

    // Identity is server-computed; the renderer must be reading the real one.
    const runIdentity = harness.$(`[data-run-center-identity="${run.taskId}"]`)!.textContent ?? '';
    const turnIdentity = harness.$(`[data-run-center-identity="${turn.taskId}"]`)!.textContent ?? '';
    expect(runIdentity).toContain('Run 1');
    expect(turnIdentity).toContain('Run 1');
    expect(turnIdentity).toContain('Turn 1');
    expect(turnIdentity).toContain('planner');
    expect(runIdentity).not.toEqual(turnIdentity);

    // Detail, then the runs tree — same identity string on every surface.
    await clickUntil(harness, `[data-dashboard-board-task-id="${turn.taskId}"]`,
      () => !!harness!.$('.run-center-detail [data-run-center-identity]'), 'detail identity');
    expect(harness.$('.run-center-detail [data-run-center-identity]')!.textContent!.trim())
      .toBe(turnIdentity.trim());

    await clickUntil(harness, '[data-run-center-view="runs"]',
      () => harness!.$$('.run-center-tree-task').length === 2, 'the run tree');
    expect(harness.$(`.run-center-tree-task[data-run-center-task="${run.taskId}"]`)).not.toBeNull();
    expect(harness.$(`.run-center-tree-task[data-run-center-task="${turn.taskId}"]`)).not.toBeNull();
    expect(harness.$('.run-center-task-tree > li > .run-center-tree-task')!.getAttribute('data-run-center-task'))
      .toBe(run.taskId);
  });
});

describe('RC-T04 Scenario B — abort converges through the real store', () => {
  it('sends the action and lands on a terminal state the store actually wrote', async () => {
    const run = await createTask({ requestId: 'req-b-run', conversationId: CONVERSATION, executionKind: 'group-chat' });
    await moveTo(run.taskId, 'queued');
    await moveTo(run.taskId, 'running');

    const service = await realService();
    harness = await mountAgainst(service, 1);

    await clickUntil(harness, `[data-dashboard-board-task-id="${run.taskId}"]`,
      () => !!harness!.$('[data-run-center-action="abort"]'), 'the abort button');

    await clickUntil(harness, '[data-run-center-action="abort"]',
      () => !harness!.$('[data-run-center-action="abort"]'), 'abort to converge');

    expect(harness.callsTo('cogseed.task.action')).toHaveLength(1);
    // The store is the source of truth, not the UI's optimism.
    const { readCogSeedTask } = await taskStore();
    expect((await readCogSeedTask(USER, run.taskId))?.status).toBe('cancelled');
    // ...and the convergence window ended without a fabricated state.
    expect(harness.$('[data-run-center-unconfirmed]')).toBeNull();
    expect(harness.$('[data-run-center-action="abort"]')).toBeNull();
  });
});

describe('RC-T04 Scenario C — retry links the new run to the old', () => {
  it('surfaces retryOfTaskId from the real projection and keeps the two distinguishable', async () => {
    const original = await createTask({ requestId: 'req-c-1', conversationId: CONVERSATION, executionKind: 'group-chat' });
    await moveTo(original.taskId, 'queued');
    await moveTo(original.taskId, 'running');
    await moveTo(original.taskId, 'failed', 'turn_failed');

    const replacement = await createTask({
      requestId: 'req-c-2', conversationId: CONVERSATION, executionKind: 'group-chat',
      retryOfTaskId: original.taskId,
    });

    const service = await realService();
    harness = await mountAgainst(service, 2);

    const link = harness.$(`[data-dashboard-board-task-id="${replacement.taskId}"] [data-run-center-retry-of]`);
    expect(link?.getAttribute('data-run-center-retry-of')).toBe(original.taskId);
    // The original carries no such marker.
    expect(harness.$(`[data-dashboard-board-task-id="${original.taskId}"] [data-run-center-retry-of]`)).toBeNull();

    // Two runs of one session, told apart by server-computed ordinals.
    const first = harness.$(`[data-run-center-identity="${original.taskId}"]`)!.textContent ?? '';
    const second = harness.$(`[data-run-center-identity="${replacement.taskId}"]`)!.textContent ?? '';
    // Ordinals are per-session and, for same-second `createdAt`, broken by
    // `taskId` — deterministic, but not necessarily creation order. What the
    // product promises is that the two are told apart, so assert that.
    expect([first, second].map((identity) => identity.match(/Run \d+/)?.[0]).sort())
      .toEqual(['Run 1', 'Run 2']);
    expect(first).not.toEqual(second);
  });
});

describe('RC-T04 Scenario D — waiting_user', () => {
  it('shows the conversation as the only exit, and never a resume', async () => {
    const run = await createTask({ requestId: 'req-d-run', conversationId: CONVERSATION, executionKind: 'group-chat' });
    await moveTo(run.taskId, 'queued');
    await moveTo(run.taskId, 'running');
    await moveTo(run.taskId, 'waiting_user');

    const service = await realService();
    harness = await mountAgainst(service, 1);
    await clickUntil(harness, `[data-dashboard-board-task-id="${run.taskId}"]`,
      () => !!harness!.$('.run-center-detail'), 'the detail pane');

    // Still visible, in attention, with its real status.
    expect(harness.$('[data-dashboard-board-column="attention"] .dashboard-board-card')).not.toBeNull();

    const open = harness.$('[data-run-center-open]');
    expect(open?.getAttribute('data-run-center-open')).toBe(CONVERSATION);
    expect(open!.hasAttribute('data-run-center-open-primary')).toBe(true);
    expect(harness.$('[data-run-center-waiting-user]')).not.toBeNull();

    // v1 guarantee: the conversation is the recovery entry. Resume is not
    // offered, and D-9 (who finally closes this shadow task) stays open —
    // this test deliberately asserts nothing about that.
    expect(harness.$('[data-run-center-action="resume"]')).toBeNull();
    expect(harness.$('[data-run-center-action="retry"]')).toBeNull();

    await harness.click('[data-run-center-open]');
    expect(harness.setViewCalls).toEqual([['conversation', CONVERSATION]]);
  });
});

describe('RC-T04 Scenario E — restart reconciliation', () => {
  it('fails out the previous process\'s run, spares waiting_user and the live one', async () => {
    const stale = await createTask({ requestId: 'req-e-stale', conversationId: CONVERSATION, executionKind: 'group-chat' });
    await moveTo(stale.taskId, 'queued');
    await moveTo(stale.taskId, 'running');

    const waiting = await createTask({ requestId: 'req-e-waiting', conversationId: CONVERSATION, executionKind: 'group-chat' });
    await moveTo(waiting.taskId, 'queued');
    await moveTo(waiting.taskId, 'running');
    await moveTo(waiting.taskId, 'waiting_user');

    // Boundary in the future: everything above looks like a previous process.
    // It MUST be produced the same way task timestamps are — `nowIso()` is
    // local time with second precision and no zone, so a UTC `toISOString()`
    // would compare lexicographically against a different format and silently
    // never match (the trap documented in the Phase 2 evidence).
    const { nowIso } = await import('../../src/main/storage');
    const boundary = nowIso().replace(/^\d{4}/, (year) => String(Number(year) + 1));
    const { recoverCogSeedTasks } = await recovery();
    const first = await recoverCogSeedTasks(USER, { processStartedAt: boundary, projectTaskEvent: async () => undefined } as never);

    const { readCogSeedTask } = await taskStore();
    const staleAfter = await readCogSeedTask(USER, stale.taskId);
    expect(staleAfter?.status).toBe('failed');
    expect(staleAfter?.errorCode).toBe('app_restart');
    // waiting_user is untouched: that run had already ended normally.
    expect((await readCogSeedTask(USER, waiting.taskId))?.status).toBe('waiting_user');

    // Idempotent: a second sweep re-counts nothing.
    const second = await recoverCogSeedTasks(USER, { processStartedAt: boundary, projectTaskEvent: async () => undefined } as never);
    expect(second.groupChatFailedCount ?? 0).toBe(0);
    expect(first.groupChatFailedCount).toBeGreaterThan(0);

    const service = await realService();
    // Both survive the sweep: the stale run as `failed`, the waiting one intact.
    harness = await mountAgainst(service, 2);
    await clickUntil(harness, `[data-dashboard-board-task-id="${stale.taskId}"]`,
      () => !!harness!.$('[data-run-center-retry-unavailable]'), 'the app_restart note');

    // No promise the runtime cannot keep, but the conversation is reachable.
    expect(harness.$('[data-run-center-action="retry"]')).toBeNull();
    expect(harness.$('[data-run-center-action="resume"]')).toBeNull();
    expect(harness.$('[data-run-center-open]')).not.toBeNull();
    const note = harness.$('[data-run-center-retry-unavailable]');
    expect(note?.getAttribute('data-run-center-retry-unavailable')).toBe('app_restart');
    expect(note!.textContent).toMatch(/cannot be resumed or retried/i);
  });

  it('does not touch a task this process is still working on', async () => {
    const live = await createTask({ requestId: 'req-e-live', conversationId: CONVERSATION, executionKind: 'group-chat' });
    await moveTo(live.taskId, 'queued');
    await moveTo(live.taskId, 'running');

    // Boundary in the past: nothing predates it.
    const { recoverCogSeedTasks } = await recovery();
    const { nowIso } = await import('../../src/main/storage');
    await recoverCogSeedTasks(USER, {
      processStartedAt: nowIso().replace(/^\d{4}/, (year) => String(Number(year) - 1)),
      projectTaskEvent: async () => undefined,
    } as never);

    const { readCogSeedTask } = await taskStore();
    expect((await readCogSeedTask(USER, live.taskId))?.status).toBe('running');
  });
});

describe('RC-T04 Scenario F — conversation deletion', () => {
  it('purges the group-chat ledger, keeps native history, and drops the dead exit', async () => {
    const shadow = await createTask({ requestId: 'req-f-shadow', conversationId: CONVERSATION, executionKind: 'group-chat' });
    const shadowTurn = await createTask({
      requestId: 'req-f-turn', conversationId: CONVERSATION, executionKind: 'group-chat',
      parentTaskId: shadow.taskId, turnId: 'turn-f',
    });
    const native = await createTask({
      requestId: 'req-f-native', conversationId: CONVERSATION,
      executionKind: 'cogseed-native', agentId: 'planner',
    });
    const untouched = await createTask({ requestId: 'req-f-other', conversationId: OTHER_CONVERSATION, executionKind: 'group-chat' });

    // The user deletes the conversation.
    liveConversations.delete(CONVERSATION);
    const { purgeCogSeedGroupChatTasksByConversation, readCogSeedTask } = await taskStore();
    const purged = await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION);

    expect(purged.purgedTaskIds.sort()).toEqual([shadow.taskId, shadowTurn.taskId].sort());
    expect(await readCogSeedTask(USER, native.taskId)).not.toBeNull();
    expect(await readCogSeedTask(USER, untouched.taskId)).not.toBeNull();

    const service = await realService();
    harness = await mountAgainst(service, 2);

    // c2: the native record survives on screen, without its dead exit.
    expect(cardIds(harness).sort()).toEqual([native.taskId, untouched.taskId].sort());
    await clickUntil(harness, `[data-dashboard-board-task-id="${native.taskId}"]`,
      () => !!harness!.$('[data-run-center-conversation-unavailable]'), 'the unavailable note');
    expect(harness.$('[data-run-center-open]')).toBeNull();
    expect(harness.$('[data-run-center-conversation-unavailable]')).not.toBeNull();
    expect(harness.$('.run-center-detail')!.textContent).toContain('planner');
    // Nothing anywhere still points at the deleted conversation.
    expect(harness.html()).not.toContain(CONVERSATION);
  });
});

describe('RC-T04 Scenario G — an orphaned turn', () => {
  it('keeps a child whose parent is gone visible, with no invented parent', async () => {
    const parent = await createTask({ requestId: 'req-g-parent', conversationId: CONVERSATION, executionKind: 'group-chat' });
    const child = await createTask({
      requestId: 'req-g-child', conversationId: CONVERSATION, executionKind: 'group-chat',
      parentTaskId: parent.taskId, turnId: 'turn-g', agentId: 'planner',
    });

    // The parent record disappears — the retention/history shape RC-P2-20 hit.
    const { cogseedTaskFile } = await import('../../src/main/features/cogseed_backend/paths');
    fs.rmSync(cogseedTaskFile(USER, parent.taskId), { force: true });

    const service = await realService();
    harness = await mountAgainst(service, 1);

    expect(cardIds(harness)).toEqual([child.taskId]);

    await clickUntil(harness, `[data-dashboard-board-task-id="${child.taskId}"]`,
      () => !!harness!.$('.run-center-detail'), 'the detail pane');
    await clickUntil(harness, '[data-run-center-view="runs"]',
      () => harness!.$$('.run-center-tree-task').length === 1, 'the run tree');

    const roots = harness.$$('.run-center-task-tree > li > .run-center-tree-task')
      .map((n) => n.getAttribute('data-run-center-task'));
    expect(roots).toEqual([child.taskId]);
    expect(harness.$(`[data-run-center-task="${parent.taskId}"]`)).toBeNull();
    expect(harness.$('[data-run-center-orphan]')?.getAttribute('data-run-center-orphan')).toBe(parent.taskId);
  });
});
