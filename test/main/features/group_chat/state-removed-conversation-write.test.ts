// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * A background group-chat status/members write must survive its conversation
 * being deleted.
 *
 * Full-suite evidence (one unhandled rejection, attributed to
 * `test/main/features/group_chat/bus-integration.test.ts`):
 *
 *   ENOENT: no such file or directory, open
 *     '<tmp>/u1/cloud/chats/<cid>/state.json.<pid>.<ts>.<rand>.tmp'
 *   writeJson (src/main/storage.ts) <- writeStateRaw
 *     <- _writeStatusTransition <- abortConversationRoutingState
 *
 * `chats.deleteConversation` purged `<uid>/cloud/chats/<cid>/` while an actor
 * was still unwinding and writing its status. Nobody holds that promise, so the
 * rejection escapes. The write must therefore be resilient to its destination
 * disappearing: skip (never recreate) with a warn, while a live conversation's
 * persistence failure still surfaces.
 *
 * `members.json` lives in the same `<uid>/cloud/chats/<cid>/` directory and
 * uses the same mkdir + atomic tmp+rename pattern, so the same class of bug
 * applies to `writeMembers` (roster growth while a worker unwinds after the
 * conversation was deleted) and is covered here too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => loggerMocks,
}));

// One armed filesystem hook per test, fired from the atomic writer seam right
// before the tmp file is opened — exactly where the full-suite failure landed.
const writeHooks = vi.hoisted(() => ({
  beforeStateWrite: null as null | ((filePath: string) => void),
  beforeMembersWrite: null as null | ((filePath: string) => void),
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

const TEST_UID = 'u1';
let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-state-removed-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  writeHooks.beforeStateWrite = null;
  writeHooks.beforeMembersWrite = null;
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
  storageMocks.writeJson.mockImplementation(
    async (filePath: string, data: unknown) => {
      const base = path.basename(filePath);
      if (base === 'state.json' && writeHooks.beforeStateWrite) {
        const hook = writeHooks.beforeStateWrite;
        writeHooks.beforeStateWrite = null;
        hook(filePath);
      }
      if (base === 'members.json' && writeHooks.beforeMembersWrite) {
        const hook = writeHooks.beforeMembersWrite;
        writeHooks.beforeMembersWrite = null;
        hook(filePath);
      }
      return storage.writeJson(filePath, data);
    },
  );
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  const { drainMainRuntimeForTest } =
    await import('../../../helpers/drain-main-runtime');
  await drainMainRuntimeForTest(TEST_UID);
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function errno(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** A real conversation whose group dir + `running` status already exist. */
async function runningConversation(title: string) {
  const chats = await import('../../../../src/main/features/chats');
  const state = await import('../../../../src/main/features/group_chat/state');
  const paths = await import('../../../../src/main/paths');
  const conv = await chats.createConversation(TEST_UID, { title });
  const cid = conv.conversation_id;
  await state.setStatus(TEST_UID, cid, 'running');
  const groupDir = paths.groupChatDir(TEST_UID, cid);
  return { chats, state, cid, groupDir };
}

describe('group_chat state › writes for a conversation that was deleted', () => {
  it('a late status write does not recreate the deleted conversation directory', async () => {
    const { chats, state, cid, groupDir } = await runningConversation(
      'deleted while a worker unwinds',
    );
    expect(fs.existsSync(path.join(groupDir, 'state.json'))).toBe(true);

    expect(await chats.deleteConversation(TEST_UID, cid)).toBe(true);
    expect(fs.existsSync(groupDir)).toBe(false);

    // The unwinding actor's status write lands after the purge.
    await expect(
      state.abortConversationRoutingState(TEST_UID, cid),
    ).resolves.toBeTruthy();

    expect(fs.existsSync(groupDir)).toBe(false);
    const registry = await state.readRunningConversationRegistry(TEST_UID);
    expect(registry.items.map((item) => item.conversation_id)).not.toContain(cid);
  });

  it('a status write whose directory vanishes mid-write reports no unhandled rejection', async () => {
    const { state, cid, groupDir } = await runningConversation(
      'vanishing target',
    );

    writeHooks.beforeStateWrite = (filePath) => {
      fs.rmSync(groupDir, { recursive: true, force: true });
      throw errno(
        'ENOENT',
        `ENOENT: no such file or directory, open '${filePath}.${process.pid}.0.tmp'`,
      );
    };

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      // Background write: the promise is not held by anyone.
      void state.abortConversationRoutingState(TEST_UID, cid);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(fs.existsSync(groupDir)).toBe(false);
  });

  it('a genuine persistence failure for a live conversation still surfaces', async () => {
    const { state, cid, groupDir } = await runningConversation('live target');
    writeHooks.beforeStateWrite = () => {
      throw errno('EACCES', 'EACCES: permission denied, open state.json');
    };

    await expect(state.setStatus(TEST_UID, cid, 'idle')).rejects.toThrow(
      /EACCES/,
    );
    expect(fs.existsSync(groupDir)).toBe(true);
  });
});

describe('group_chat members › writes for a conversation that was deleted', () => {
  it('a late member add does not recreate the deleted conversation directory', async () => {
    const { chats, state, cid, groupDir } = await runningConversation(
      'members written after delete',
    );
    expect(
      await state.addMember(TEST_UID, cid, {
        kind: 'agent',
        id: 'a1',
        name: 'Ada',
      }),
    ).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'members.json'))).toBe(true);

    expect(await chats.deleteConversation(TEST_UID, cid)).toBe(true);
    expect(fs.existsSync(groupDir)).toBe(false);

    // The unwinding actor's roster write lands after the purge.
    await expect(
      state.addMember(TEST_UID, cid, { kind: 'agent', id: 'a2', name: 'Bob' }),
    ).resolves.toBe(false);

    expect(fs.existsSync(groupDir)).toBe(false);
  });

  it('a late commander-spoken mark does not recreate the deleted conversation directory', async () => {
    const { chats, state, cid, groupDir } = await runningConversation(
      'commander mark after delete',
    );
    expect(await state.markCommanderSpoken(TEST_UID, cid)).toBe(true);

    expect(await chats.deleteConversation(TEST_UID, cid)).toBe(true);
    expect(fs.existsSync(groupDir)).toBe(false);

    await expect(state.markCommanderSpoken(TEST_UID, cid)).resolves.toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false);
  });

  it('a members write whose directory vanishes mid-write reports no unhandled rejection', async () => {
    const { state, cid, groupDir } = await runningConversation(
      'vanishing members target',
    );

    writeHooks.beforeMembersWrite = (filePath) => {
      fs.rmSync(groupDir, { recursive: true, force: true });
      throw errno(
        'ENOENT',
        `ENOENT: no such file or directory, open '${filePath}.${process.pid}.0.tmp'`,
      );
    };

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      // Background roster write: the promise is not held by anyone.
      void state.addMember(TEST_UID, cid, {
        kind: 'agent',
        id: 'a1',
        name: 'Ada',
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(fs.existsSync(groupDir)).toBe(false);
  });

  it('a genuine members persistence failure for a live conversation still surfaces', async () => {
    const { state, cid, groupDir } = await runningConversation(
      'live members target',
    );
    writeHooks.beforeMembersWrite = () => {
      throw errno('EACCES', 'EACCES: permission denied, open members.json');
    };

    await expect(
      state.addMember(TEST_UID, cid, { kind: 'agent', id: 'a1', name: 'Ada' }),
    ).rejects.toThrow(/EACCES/);
    expect(fs.existsSync(groupDir)).toBe(true);
  });
});
