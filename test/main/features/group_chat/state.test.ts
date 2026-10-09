import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => loggerMocks,
}));

const storageMocks = vi.hoisted(() => ({
  readJson: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock('../../../../src/main/storage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/main/storage')>();
  return {
    ...actual,
    readJson: (...args: Parameters<typeof actual.readJson>) =>
      storageMocks.readJson(...args),
    writeJson: (...args: Parameters<typeof actual.writeJson>) =>
      storageMocks.writeJson(...args),
  };
});

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cid01';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-state-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  loggerMocks.debug.mockClear();
  loggerMocks.info.mockClear();
  loggerMocks.warn.mockClear();
  loggerMocks.error.mockClear();
  storageMocks.readJson.mockReset();
  storageMocks.writeJson.mockReset();
  const storage = await vi.importActual<
    typeof import('../../../../src/main/storage')
  >('../../../../src/main/storage');
  storageMocks.readJson.mockImplementation(storage.readJson);
  storageMocks.writeJson.mockImplementation(storage.writeJson);
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('group_chat state › sessionId builders', () => {
  // session_id format is `<kind>-<tail>` (CLAUDE.md §5 — uid no longer in session_id; user
  // scoping comes from the path root `<activeUid>/cloud/sessions/<sid>.jsonl`).
  it('build commander / member session ids with the right kind segment', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    expect(s.buildGconvSessionId('cidA')).toBe('gconv-cidA');
    expect(s.buildGmemberSessionId('cidA', 'agentX')).toBe('gmember-cidA-agentX');
  });

  it('actorSessionId routes commander → gconv, agent → gmember, user → throw', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    expect(s.actorSessionId('cidA', { kind: 'commander', id: 'commander', joined_at: 't' }))
      .toBe('gconv-cidA');
    expect(s.actorSessionId('cidA', { kind: 'agent', id: 'agentX', joined_at: 't' }))
      .toBe('gmember-cidA-agentX');
    expect(() => s.actorSessionId('cidA', { kind: 'user', id: 'user', joined_at: 't' })).toThrow();
  });
});

function serializedLogs(): string {
  return JSON.stringify([
    loggerMocks.debug.mock.calls,
    loggerMocks.info.mock.calls,
    loggerMocks.warn.mock.calls,
    loggerMocks.error.mock.calls,
  ]);
}

function expectLogsExclude(...sentinels: string[]): void {
  const logs = serializedLogs();
  for (const sentinel of sentinels) expect(logs).not.toContain(sentinel);
}

describe('group_chat state › membership log privacy', () => {
  const uid = 'privacy-user-raw-123456';
  const cid = 'privacy-cid-raw-654321';
  const actorId = 'privacy-agent-raw-abcdef';
  const actorName = 'SECRET_AGENT_DISPLAY_NAME';
  const secretError =
    'SECRET_MEMBERSHIP_ERROR /Users/tester/member-token.json token=raw';

  async function activatePrivacyUser(): Promise<void> {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(uid);
  }

  async function seedConv(actors: any[]): Promise<void> {
    const paths = await import('../../../../src/main/paths');
    const dir = path.join(paths.userChatsDir(uid), cid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'members.json'),
      JSON.stringify({ version: 1, actors }),
    );
  }

  async function seedIndex(): Promise<void> {
    const paths = await import('../../../../src/main/paths');
    const dir = paths.userChatsDir(uid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '_index.json'),
      JSON.stringify({ items: [{ conversation_id: cid }] }),
    );
  }

  it('logs member join with masked ids and kind only', async () => {
    await activatePrivacyUser();
    const s = await import('../../../../src/main/features/group_chat/state');
    const { maskId } = await import('../../../../src/main/util/log-redact');

    await s.addMember(uid, cid, {
      kind: 'agent',
      id: actorId,
      name: actorName,
    });

    expectLogsExclude(uid, cid, actorId, actorName);
    expect(loggerMocks.info).toHaveBeenCalledWith('member joined', {
      user_id: maskId(uid),
      cid: maskId(cid),
      actor_id: maskId(actorId),
      kind: 'agent',
    });
  });

  it('redacts readMembers failures and emits a stable failure code', async () => {
    await activatePrivacyUser();
    await seedConv([]);
    const s = await import('../../../../src/main/features/group_chat/state');
    const { maskId } = await import('../../../../src/main/util/log-redact');
    storageMocks.readJson.mockRejectedValueOnce(new Error(secretError));

    await expect(s.readMembers(uid, cid)).resolves.toEqual({
      version: 1,
      actors: [],
    });

    expectLogsExclude(
      uid,
      cid,
      actorId,
      actorName,
      secretError,
      'SECRET_MEMBERSHIP_ERROR',
      '/Users/tester',
      'token=raw',
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith('members read failed', {
      user_id: maskId(uid),
      cid: maskId(cid),
      failure_code: 'members_read_failed',
      error: expect.objectContaining({ message: 'Members read failed.' }),
    });
  });

  it('redacts rename index-read failures and emits a stable failure code', async () => {
    await activatePrivacyUser();
    await seedIndex();
    const s = await import('../../../../src/main/features/group_chat/state');
    const { maskId } = await import('../../../../src/main/util/log-redact');
    storageMocks.readJson.mockRejectedValueOnce(new Error(secretError));

    await expect(
      s.renameAgentInMembers(uid, actorId, actorName),
    ).resolves.toBe(0);

    expectLogsExclude(
      uid,
      cid,
      actorId,
      actorName,
      secretError,
      'SECRET_MEMBERSHIP_ERROR',
      '/Users/tester',
      'token=raw',
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'member rename index read failed',
      {
        user_id: maskId(uid),
        actor_id: maskId(actorId),
        kind: 'agent',
        failure_code: 'member_rename_index_read_failed',
        error: expect.objectContaining({
          message: 'Member rename index read failed.',
        }),
      },
    );
  });

  it('redacts rename member-write failures and emits a stable failure code', async () => {
    await activatePrivacyUser();
    await seedConv([
      {
        kind: 'agent',
        id: actorId,
        name: 'Old private name',
        joined_at: 't',
      },
    ]);
    await seedIndex();
    const s = await import('../../../../src/main/features/group_chat/state');
    const { maskId } = await import('../../../../src/main/util/log-redact');
    const paths = await import('../../../../src/main/paths');
    const actualStorage = await vi.importActual<
      typeof import('../../../../src/main/storage')
    >('../../../../src/main/storage');
    const membersFile = path.join(paths.userChatsDir(uid), cid, 'members.json');
    storageMocks.writeJson.mockImplementation(async (file, value) => {
      if (file === membersFile) throw new Error(secretError);
      return actualStorage.writeJson(file, value);
    });

    await expect(
      s.renameAgentInMembers(uid, actorId, actorName),
    ).resolves.toBe(0);

    expectLogsExclude(
      uid,
      cid,
      actorId,
      actorName,
      secretError,
      'SECRET_MEMBERSHIP_ERROR',
      '/Users/tester',
      'token=raw',
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith('member rename write failed', {
      user_id: maskId(uid),
      cid: maskId(cid),
      actor_id: maskId(actorId),
      kind: 'agent',
      failure_code: 'member_rename_write_failed',
      error: expect.objectContaining({
        message: 'Member rename write failed.',
      }),
    });
  });

  it('logs rename success with masked ids, kind, and count only', async () => {
    await activatePrivacyUser();
    await seedConv([
      {
        kind: 'agent',
        id: actorId,
        name: 'Old private name',
        joined_at: 't',
      },
    ]);
    await seedIndex();
    const s = await import('../../../../src/main/features/group_chat/state');
    const { maskId } = await import('../../../../src/main/util/log-redact');

    await expect(
      s.renameAgentInMembers(uid, actorId, actorName),
    ).resolves.toBe(1);

    expectLogsExclude(uid, cid, actorId, actorName, 'Old private name');
    expect(loggerMocks.info).toHaveBeenCalledWith('member rename completed', {
      user_id: maskId(uid),
      actor_id: maskId(actorId),
      kind: 'agent',
      count: 1,
    });
  });
});

describe('group_chat state › addMember + ensureAgentMember', () => {
  it('addMember idempotent — second call with same id returns false', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const a = await s.addMember(TEST_UID, TEST_CID, { kind: 'agent', id: 'writer', name: 'Writer' });
    const b = await s.addMember(TEST_UID, TEST_CID, { kind: 'agent', id: 'writer', name: 'Writer' });
    expect(a).toBe(true);
    expect(b).toBe(false);
    const m = await s.readMembers(TEST_UID, TEST_CID);
    expect(m.actors.filter((x) => x.id === 'writer')).toHaveLength(1);
  });

  it('seedReservedActors creates commander + user and is idempotent', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.seedReservedActors(TEST_UID, TEST_CID);
    await s.seedReservedActors(TEST_UID, TEST_CID); // again
    const m = await s.readMembers(TEST_UID, TEST_CID);
    expect(m.actors.map((a) => a.id).sort()).toEqual(['commander', 'user']);
  });

  it('ensureAgentMember rejects reserved ids + non-safeId tokens', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    expect(await s.ensureAgentMember(TEST_UID, TEST_CID, 'commander')).toBe(false);
    expect(await s.ensureAgentMember(TEST_UID, TEST_CID, 'user')).toBe(false);
    expect(await s.ensureAgentMember(TEST_UID, TEST_CID, '../etc')).toBe(false);
    expect(await s.ensureAgentMember(TEST_UID, TEST_CID, 'writer', 'Writer')).toBe(true);
  });
});

describe('group_chat state › markCommanderSpoken', () => {
  it('sets the flag once and readMembers preserves it', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.seedReservedActors(TEST_UID, TEST_CID);
    expect(await s.markCommanderSpoken(TEST_UID, TEST_CID)).toBe(true);
    const m = await s.readMembers(TEST_UID, TEST_CID);
    expect(m.commander_spoken).toBe(true);
    expect(m.actors.map((a) => a.id).sort()).toEqual(['commander', 'user']);
    // 幂等：第二次不再写盘（返回 false）
    expect(await s.markCommanderSpoken(TEST_UID, TEST_CID)).toBe(false);
  });

  it('marks without clobbering a concurrent-looking existing roster', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.addMember(TEST_UID, TEST_CID, { kind: 'agent', id: 'writer', name: 'Writer' });
    await s.markCommanderSpoken(TEST_UID, TEST_CID);
    const m = await s.readMembers(TEST_UID, TEST_CID);
    expect(m.commander_spoken).toBe(true);
    expect(m.actors.find((a) => a.id === 'writer')).toBeTruthy();
  });
});

describe('group_chat state › renameAgentInMembers', () => {
  // Drive the rename sweep through a seeded `_index.json` + a couple of
  // pre-populated members.json files. The bug this guards: members.name is a
  // join-time snapshot the @-router resolves on first, so without the sweep
  // old conversations would keep matching `@<old-name>` after a rename.
  async function seedConv(uid: string, cid: string, actors: any[]): Promise<void> {
    const paths = await import('../../../../src/main/paths');
    const dir = path.join(paths.userChatsDir(uid), cid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify({ version: 1, actors }));
  }
  async function seedIndex(uid: string, cids: string[]): Promise<void> {
    const paths = await import('../../../../src/main/paths');
    const dir = paths.userChatsDir(uid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '_index.json'),
      JSON.stringify({ items: cids.map((c) => ({ conversation_id: c })) }),
    );
  }

  it('updates the name on every roster carrying the agent and skips others', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await seedConv(TEST_UID, 'cidA', [
      { kind: 'agent', id: 'writer', name: 'OldWriter', joined_at: 't' },
      { kind: 'commander', id: 'commander', name: 'Commander', joined_at: 't' },
    ]);
    await seedConv(TEST_UID, 'cidB', [
      { kind: 'agent', id: 'reviewer', name: 'Reviewer', joined_at: 't' },
    ]);
    await seedConv(TEST_UID, 'cidC', [
      { kind: 'agent', id: 'writer', name: 'OldWriter', joined_at: 't' },
    ]);
    await seedIndex(TEST_UID, ['cidA', 'cidB', 'cidC']);

    const touched = await s.renameAgentInMembers(TEST_UID, 'writer', 'NewWriter');
    expect(touched).toBe(2);

    const a = await s.readMembers(TEST_UID, 'cidA');
    expect(a.actors.find((x) => x.id === 'writer')?.name).toBe('NewWriter');
    expect(a.actors.find((x) => x.id === 'commander')?.name).toBe('Commander');

    const b = await s.readMembers(TEST_UID, 'cidB');
    expect(b.actors.find((x) => x.id === 'reviewer')?.name).toBe('Reviewer');

    const c = await s.readMembers(TEST_UID, 'cidC');
    expect(c.actors.find((x) => x.id === 'writer')?.name).toBe('NewWriter');
  });

  it('rejects reserved ids and non-safeId tokens', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await seedIndex(TEST_UID, ['cidA']);
    expect(await s.renameAgentInMembers(TEST_UID, 'commander', 'X')).toBe(0);
    expect(await s.renameAgentInMembers(TEST_UID, 'user', 'X')).toBe(0);
    expect(await s.renameAgentInMembers(TEST_UID, '../etc', 'X')).toBe(0);
  });

  it('returns 0 when the same name is already on the roster (no-op write)', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await seedConv(TEST_UID, 'cidA', [
      { kind: 'agent', id: 'writer', name: 'Writer', joined_at: 't' },
    ]);
    await seedIndex(TEST_UID, ['cidA']);
    expect(await s.renameAgentInMembers(TEST_UID, 'writer', 'Writer')).toBe(0);
  });
});

describe('group_chat state › markInFlight does NOT touch status', () => {
  it('flipping in_flight on/off leaves status untouched (status is owned by bus)', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    // Pre-set status='running' to simulate worker activation.
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    let st = await s.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('running');

    // Add an actor; status must stay 'running' (the previous bug had
    // markInFlight flip status to 'idle' here, racing the IPC handler).
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', true);
    st = await s.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('running');
    expect(st.in_flight).toEqual(['commander']);

    // Remove the actor; status STILL stays 'running'.
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', false);
    st = await s.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('running');
    expect(st.in_flight).toEqual([]);
  });

  it('setStatus to idle clears in_flight; aborted clears too', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', true);
    await s.markInFlight(TEST_UID, TEST_CID, 'agent-a', true);
    let st = await s.readState(TEST_UID, TEST_CID);
    expect(st.in_flight).toContain('commander');
    expect(st.in_flight).toContain('agent-a');

    await s.setStatus(TEST_UID, TEST_CID, 'idle');
    st = await s.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('idle');
    expect(st.in_flight).toEqual([]);
  });
});

describe('group_chat state › compact running registry', () => {
  it('tracks running before state persistence and removes it after idle', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const paths = await import('../../../../src/main/paths');
    await s.setStatus(TEST_UID, TEST_CID, 'running');

    const running = JSON.parse(fs.readFileSync(
      paths.userRunningConversationsFile(TEST_UID), 'utf8'));
    expect(running).toEqual({
      version: 1,
      items: [{ conversation_id: TEST_CID }],
    });

    await s.setStatus(TEST_UID, TEST_CID, 'idle');
    const idle = JSON.parse(fs.readFileSync(
      paths.userRunningConversationsFile(TEST_UID), 'utf8'));
    expect(idle).toEqual({ version: 1, items: [] });
  });

  it('serialises concurrent conversation starts without losing entries', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await Promise.all([
      s.transitionStatus(TEST_UID, 'cid-a', () => 'running'),
      s.transitionStatus(TEST_UID, 'cid-b', () => 'running'),
    ]);

    const registry = await s.readRunningConversationRegistry(TEST_UID);
    expect(registry.valid).toBe(true);
    expect(registry.items.map((item) => item.conversation_id).sort())
      .toEqual(['cid-a', 'cid-b']);
  });
});

describe('group_chat state › touchActivity (stuck-turn watchdog heartbeat)', () => {
  // `touchActivity` is what keeps `processing_since` (= last_active_at) fresh
  // during a long single turn so the renderer's 12-min stuck-turn watchdog
  // doesn't false-positive. Invariants: bumps while running, throttles bursts
  // to one write per window, and never resurrects an idle conversation.
  it('bumps while running, throttles within the window, ignores idle convs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 12, 16, 0, 0, 0));
    try {
      const s = await import('../../../../src/main/features/group_chat/state');
      await s.setStatus(TEST_UID, TEST_CID, 'running');
      const t0 = (await s.readState(TEST_UID, TEST_CID)).last_active_at;

      // Past the 30s throttle window → first touch writes a fresh stamp.
      vi.advanceTimersByTime(40_000);
      await s.touchActivity(TEST_UID, TEST_CID);
      const t1 = (await s.readState(TEST_UID, TEST_CID)).last_active_at;
      expect(t1).not.toBe(t0);

      // Immediate second touch is inside the window → no new write.
      vi.advanceTimersByTime(5_000);
      await s.touchActivity(TEST_UID, TEST_CID);
      const t2 = (await s.readState(TEST_UID, TEST_CID)).last_active_at;
      expect(t2).toBe(t1);

      // Conversation goes idle; a later touch must NOT re-stamp it (would
      // otherwise keep a crashed/finished turn looking "fresh" forever).
      await s.setStatus(TEST_UID, TEST_CID, 'idle');
      const tIdle = (await s.readState(TEST_UID, TEST_CID)).last_active_at;
      vi.advanceTimersByTime(40_000);
      await s.touchActivity(TEST_UID, TEST_CID);
      const tAfter = (await s.readState(TEST_UID, TEST_CID)).last_active_at;
      expect(tAfter).toBe(tIdle);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('group_chat facade › runtimeStatus orphan recovery', () => {
  it('heals persisted running/in_flight state when no worker exists in this process', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    await s.setStatus(TEST_UID, TEST_CID, 'running');
    await s.markInFlight(TEST_UID, TEST_CID, 'commander', true);

    const facade = await import('../../../../src/main/features/group_chat');
    const runtime = await facade.runtimeStatus(TEST_UID, TEST_CID);
    expect(runtime).toEqual({
      processing: false,
      processing_since: null,
      in_flight: [],
      active_turns: [],
      backend_active: false,
    });

    const healed = await s.readState(TEST_UID, TEST_CID);
    expect(healed.status).toBe('idle');
    expect(healed.in_flight).toEqual([]);
  });

  it('keeps processing=true while a CogSeed Backend task for the conversation is active', async () => {
    // Backend (Mate / local-CLI) tasks run outside the group-chat bus: the
    // bus is quiescent while they execute, so runtimeStatus must surface them
    // or the renderer finalizes the run early (imported-session continuation
    // dispatches long work there).
    const { cogseedTaskFile } = await import('../../../../src/main/features/cogseed_backend/paths');
    const { COGSEED_AGENT_BACKEND_SCHEMA_VERSION } = await import('../../../../src/main/features/cogseed_backend/types');
    const taskId = 'cogseed-task-runtime-status-active';
    const nowIso = new Date().toISOString();
    const task: CogSeedTaskRecord = {
      schemaVersion: COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
      taskId,
      sessionId: 'cogseed-session-runtime-status',
      runtimeSessionId: 'mruntime-session-runtime-status',
      executionId: 'cogseed-exec-runtime-status',
      requestId: 'req-runtime-status-active',
      ownerId: TEST_UID,
      status: 'running',
      task: 'continue the imported session',
      conversationId: TEST_CID,
      agentId: 'agent-backend-a',
      executionKind: 'cogseed-native',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const taskFile = cogseedTaskFile(TEST_UID, taskId);
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    fs.writeFileSync(taskFile, JSON.stringify(task));

    const facade = await import('../../../../src/main/features/group_chat');
    const runtime = await facade.runtimeStatus(TEST_UID, TEST_CID);
    expect(runtime.backend_active).toBe(true);
    expect(runtime.processing).toBe(true);
    expect(runtime.in_flight).toContain('agent-backend-a');
    expect(runtime.active_turns.some((t) => t.turn_id === taskId && t.actor === 'agent-backend-a')).toBe(true);

    // Once the task reaches a terminal status, the conversation is idle again.
    fs.writeFileSync(taskFile, JSON.stringify({ ...task, status: 'completed', terminalAt: nowIso }));
    const idle = await facade.runtimeStatus(TEST_UID, TEST_CID);
    expect(idle.backend_active).toBe(false);
    expect(idle.processing).toBe(false);
  });
});

describe('group_chat state › atomic handoff finalization', () => {
  const AGENT_A = 'agent-final-a';
  const AGENT_B = 'agent-final-b';

  function ledger(owner = AGENT_A, id = 'ledger-final-a') {
    return {
      id,
      status: 'waiting_for_agent' as const,
      blocked_on: 'agent_handoff' as const,
      source_tool: 'hand_off_to' as const,
      owner_agent_id: owner,
      owner_agent_name: 'Private Agent Name',
      user_goal: 'private goal',
      handoff_message: 'private task',
      resume_instruction: 'resume privately',
    };
  }

  function requireApi<T extends (...args: any[]) => any>(
    module: any,
    name: string,
  ): T {
    expect(typeof module[name]).toBe('function');
    return module[name] as T;
  }

  it('commits floor and optional ledger with one locked state write and returns a rollback token', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const commit = requireApi<any>(s, 'commitHandoffState');

    const committed = await commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      ledger: ledger(),
      guard: { isTerminating: () => false },
    });

    expect(storageMocks.writeJson).toHaveBeenCalledTimes(1);
    expect(committed.state).toMatchObject({
      active_recipient: AGENT_A,
      orchestration_ledger: {
        id: 'ledger-final-a',
        owner_agent_id: AGENT_A,
      },
    });
    expect(committed.rollbackToken).toMatchObject({
      committed: {
        active_recipient: AGENT_A,
        ledger_id: 'ledger-final-a',
      },
    });
    expect(JSON.stringify(committed.rollbackToken)).not.toContain('token=');
  });

  it('fails before writing when aborted or terminating', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const commit = requireApi<any>(s, 'commitHandoffState');
    const controller = new AbortController();
    controller.abort();

    await expect(commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      guard: { signal: controller.signal, isTerminating: () => false },
    })).rejects.toThrow('handoff state commit cancelled');
    await expect(commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      guard: { isTerminating: () => true },
    })).rejects.toThrow('handoff state commit cancelled');
    await s.setStatus(TEST_UID, TEST_CID, 'aborted');
    storageMocks.writeJson.mockClear();
    await expect(commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      guard: { isTerminating: () => false },
    })).rejects.toThrow('handoff state commit cancelled');
    expect(storageMocks.writeJson).not.toHaveBeenCalled();
  });

  it('fails with a stable invariant and leaves the floor unchanged when the atomic write fails', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const commit = requireApi<any>(s, 'commitHandoffState');
    storageMocks.writeJson.mockRejectedValueOnce(
      new Error('RAW_FLOOR_WRITE /private/path token=secret'),
    );

    const error = await commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      ledger: ledger(),
      guard: { isTerminating: () => false },
    }).catch((caught: unknown) => caught as Error);

    expect(error).toMatchObject({
      name: 'Error',
      message: 'handoff state commit invariant',
    });
    expect(String(error)).not.toContain('RAW_FLOOR_WRITE');
    const persisted = await s.readState(TEST_UID, TEST_CID);
    expect(persisted.active_recipient).toBeUndefined();
    expect(persisted.orchestration_ledger).toBeUndefined();
  });

  it('restores the locked snapshot when abort arrives during the atomic write', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const commit = requireApi<any>(s, 'commitHandoffState');
    const controller = new AbortController();
    const actualStorage = await vi.importActual<
      typeof import('../../../../src/main/storage')
    >('../../../../src/main/storage');
    let writes = 0;
    storageMocks.writeJson.mockImplementation(async (file, value) => {
      writes += 1;
      await actualStorage.writeJson(file, value);
      if (writes === 1) controller.abort();
    });

    await expect(commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      ledger: ledger(),
      guard: { signal: controller.signal, isTerminating: () => false },
    })).rejects.toThrow('handoff state commit cancelled');

    expect(writes).toBe(2);
    const persisted = await s.readState(TEST_UID, TEST_CID);
    expect(persisted.active_recipient).toBeUndefined();
    expect(persisted.orchestration_ledger).toBeUndefined();
  });

  it('CAS rollback restores only matching handoff fields and preserves concurrent floor and ledger', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const commit = requireApi<any>(s, 'commitHandoffState');
    const rollback = requireApi<any>(s, 'rollbackHandoffState');
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'agent-prior');
    await s.setOrchestrationLedger(TEST_UID, TEST_CID, ledger('agent-prior', 'ledger-prior'));
    const { rollbackToken } = await commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      ledger: ledger(),
      guard: { isTerminating: () => false },
    });

    await s.setActiveRecipient(TEST_UID, TEST_CID, AGENT_B);
    await s.setOrchestrationLedger(TEST_UID, TEST_CID, ledger(AGENT_B, 'ledger-concurrent'));
    const result = await rollback(TEST_UID, TEST_CID, rollbackToken);

    expect(result).toMatchObject({ floor_restored: false, ledger_restored: false });
    expect(result.state).toMatchObject({
      active_recipient: AGENT_B,
      orchestration_ledger: {
        id: 'ledger-concurrent',
        owner_agent_id: AGENT_B,
      },
    });
  });

  it('CAS rollback can restore a matching floor without clobbering a concurrent ledger', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const commit = requireApi<any>(s, 'commitHandoffState');
    const rollback = requireApi<any>(s, 'rollbackHandoffState');
    await s.setActiveRecipient(TEST_UID, TEST_CID, 'agent-prior');
    await s.setOrchestrationLedger(TEST_UID, TEST_CID, ledger('agent-prior', 'ledger-prior'));
    const { rollbackToken } = await commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      ledger: ledger(),
      guard: { isTerminating: () => false },
    });
    await s.setOrchestrationLedger(TEST_UID, TEST_CID, ledger(AGENT_B, 'ledger-concurrent'));

    const result = await rollback(TEST_UID, TEST_CID, rollbackToken);

    expect(result).toMatchObject({ floor_restored: true, ledger_restored: false });
    expect(result.state.active_recipient).toBe('agent-prior');
    expect(result.state.orchestration_ledger).toMatchObject({
      id: 'ledger-concurrent',
      owner_agent_id: AGENT_B,
    });
  });

  it('preserves unrelated ledger when committing floor without a ledger', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const commit = requireApi<any>(s, 'commitHandoffState');
    await s.setOrchestrationLedger(TEST_UID, TEST_CID, ledger('agent-prior', 'ledger-prior'));

    const committed = await commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      guard: { isTerminating: () => false },
    });

    expect(committed.state.active_recipient).toBe(AGENT_A);
    expect(committed.state.orchestration_ledger).toMatchObject({ id: 'ledger-prior' });
    expect(committed.rollbackToken.committed.ledger_id).toBeUndefined();
  });

  it('propagates a stable invariant when CAS rollback cleanup cannot persist', async () => {
    const s = await import('../../../../src/main/features/group_chat/state');
    const commit = requireApi<any>(s, 'commitHandoffState');
    const rollback = requireApi<any>(s, 'rollbackHandoffState');
    const { rollbackToken } = await commit(TEST_UID, TEST_CID, {
      recipient_id: AGENT_A,
      ledger: ledger(),
      guard: { isTerminating: () => false },
    });
    storageMocks.writeJson.mockRejectedValueOnce(
      new Error('RAW_ROLLBACK /private/path token=secret'),
    );

    await expect(
      rollback(TEST_UID, TEST_CID, rollbackToken),
    ).rejects.toThrow('handoff state rollback invariant');
  });
});
