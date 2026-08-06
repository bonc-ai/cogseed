import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_A = 'mate-phase1-user-a';
const USER_B = 'mate-phase1-user-b';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-phase1-commander-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Mate commander/member session facade', () => {
  it('maps gconv and gmember aliases to stable Mate-owned canonical sessions', async () => {
    const facade = await import('../../../../src/main/features/mate_agent_backend/actor-session-facade');
    const store = await import('../../../../src/main/features/mate_agent_backend/session-store');

    expect(facade.resolveMateSessionIdentity('gconv-conversation-a')).toMatchObject({
      externalSessionId: 'gconv-conversation-a',
      canonicalSessionId: 'mate-session-gconv-conversation-a',
      sessionKind: 'commander',
      actorRole: 'commander',
      conversationId: 'conversation-a',
      actorId: 'commander',
    });
    expect(facade.resolveMateSessionIdentity('gmember-conversation-a-writer')).toMatchObject({
      externalSessionId: 'gmember-conversation-a-writer',
      canonicalSessionId: 'mate-session-gmember-conversation-a-writer',
      sessionKind: 'member',
      actorRole: 'member',
      conversationId: 'conversation-a',
      actorId: 'writer',
    });

    const commander = await store.getOrCreateMateSession(USER_A, 'gconv-conversation-a');
    const member = await store.getOrCreateMateSession(USER_A, 'gmember-conversation-a-writer');

    expect(commander).toMatchObject({
      sessionId: 'mate-session-gconv-conversation-a',
      compatibilitySessionId: 'gconv-conversation-a',
      sessionKind: 'commander',
      actorRole: 'commander',
      actorId: 'commander',
    });
    expect(member).toMatchObject({
      sessionId: 'mate-session-gmember-conversation-a-writer',
      compatibilitySessionId: 'gmember-conversation-a-writer',
      sessionKind: 'member',
      actorRole: 'member',
      actorId: 'writer',
      commanderSessionId: commander.sessionId,
    });

    await expect(store.readMateSession(USER_A, 'gconv-conversation-a')).resolves.toEqual(commander);
    await expect(store.readMateSession(USER_A, 'gmember-conversation-a-writer')).resolves.toEqual(member);
  });

  it('supports commander roster join, rename, leave, and rejoin without crossing users', async () => {
    const store = await import('../../../../src/main/features/mate_agent_backend/session-store');

    const commander = await store.getOrCreateMateCommanderSession(USER_A, 'conversation-roster');
    await expect(store.readMateRoster(USER_A, commander.sessionId)).resolves.toEqual([
      expect.objectContaining({ actorId: 'commander', actorRole: 'commander', lifecycleState: 'active' }),
    ]);

    const joined = await store.joinMateMember(USER_A, 'conversation-roster', 'writer', 'Writer');
    expect(joined).toMatchObject({
      actorId: 'writer',
      actorRole: 'member',
      displayName: 'Writer',
      lifecycleState: 'active',
      commanderSessionId: commander.sessionId,
    });
    await expect(store.readMateRoster(USER_A, 'conversation-roster')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'writer', displayName: 'Writer', lifecycleState: 'active' }),
    ]));

    const renamed = await store.renameMateMember(USER_A, 'conversation-roster', 'writer', 'Senior Writer');
    expect(renamed).toMatchObject({ actorId: 'writer', displayName: 'Senior Writer', lifecycleState: 'active' });

    const left = await store.leaveMateMember(USER_A, 'conversation-roster', 'writer');
    expect(left).toMatchObject({ actorId: 'writer', lifecycleState: 'left' });
    await expect(store.readMateRoster(USER_A, 'conversation-roster')).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'writer', lifecycleState: 'active' }),
    ]));

    const rejoined = await store.joinMateMember(USER_A, 'conversation-roster', 'writer', 'Writer Again');
    expect(rejoined).toMatchObject({ actorId: 'writer', displayName: 'Writer Again', lifecycleState: 'active' });

    await expect(store.readMateSession(USER_B, commander.sessionId)).resolves.toBeNull();
    await expect(store.readMateRoster(USER_B, 'conversation-roster')).resolves.toEqual([]);
  });

  it('rejects malformed compatibility ids and preserves task-to-session lineage', async () => {
    const facade = await import('../../../../src/main/features/mate_agent_backend/actor-session-facade');
    const store = await import('../../../../src/main/features/mate_agent_backend/session-store');
    const tasks = await import('../../../../src/main/features/mate_agent_backend/task-store');

    expect(() => facade.resolveMateSessionIdentity('gconv-')).toThrow(/invalid/i);
    expect(() => facade.resolveMateSessionIdentity('gmember-conversation-')).toThrow(/invalid/i);
    expect(() => facade.resolveMateSessionIdentity('gmember-conversation-../writer')).toThrow(/invalid/i);
    await expect(store.getOrCreateMateSession(USER_A, '../escape')).rejects.toThrow(/invalid/i);

    const commander = await store.getOrCreateMateCommanderSession(USER_A, 'conversation-lineage');
    const parent = (await tasks.createMateTask(USER_A, {
      requestId: 'req-phase1-parent',
      task: 'Parent task',
      sessionId: commander.sessionId,
    })).task;
    const member = await store.getOrCreateMateMemberSession(USER_A, 'conversation-lineage', 'researcher');
    const child = (await tasks.createMateTask(USER_A, {
      requestId: 'req-phase1-child',
      task: 'Child task',
      sessionId: member.sessionId,
      parentTaskId: parent.taskId,
      coordinationId: 'mate-coord-phase1',
      coordinationDepth: 1,
    })).task;

    expect(child).toMatchObject({
      sessionId: member.sessionId,
      parentTaskId: parent.taskId,
      coordinationId: 'mate-coord-phase1',
      coordinationDepth: 1,
    });
  });
});
