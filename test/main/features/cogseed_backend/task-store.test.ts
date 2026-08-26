import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_A = 'cogseed-store-user-a';
const USER_B = 'cogseed-store-user-b';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-task-store-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function backend() {
  return import('../../../../src/main/features/cogseed_backend/task-store');
}

async function backendPaths() {
  return import('../../../../src/main/features/cogseed_backend/paths');
}

describe('CogSeed task and session store', () => {
  it('creates a CogSeed-owned cloud task/session mapping and reads it from the owner root', async () => {
    const store = await backend();
    const paths = await backendPaths();

    const result = await store.createCogSeedTask(USER_A, {
      requestId: 'req-store-a',
      task: 'Summarize the selected file.',
      profileId: 'openai-compatible:cogseed',
    });

    expect(result.created).toBe(true);
    expect(result.task).toMatchObject({
      ownerId: USER_A,
      executionId: expect.stringMatching(/^cogseed-exec-/),
      requestId: 'req-store-a',
      task: 'Summarize the selected file.',
      profileId: 'openai-compatible:cogseed',
      status: 'created',
    });
    expect(result.task.taskId).toMatch(/^cogseed-task-/);
    expect(result.task.sessionId).toMatch(/^cogseed-session-/);
    expect(result.task.runtimeSessionId).toMatch(/^mruntime-/);
    expect(paths.cogseedTaskFile(USER_A, result.task.taskId)).toBe(
      path.join(tmpDir, USER_A, 'cloud', 'cogseed', 'tasks', `${result.task.taskId}.json`),
    );
    await expect(store.readCogSeedTask(USER_A, result.task.taskId)).resolves.toEqual(result.task);
    await expect(store.readCogSeedTask(USER_B, result.task.taskId)).resolves.toBeNull();
    const events = await import("../../../../src/main/features/cogseed_backend/event-store");
    await expect(events.readCogSeedTaskEvents(USER_A, result.task.taskId, 0, 10)).resolves.toEqual([expect.objectContaining({ type: "task.created", sequence: 1, payload: { requestId: "req-store-a" } })]);
  });

  it('claims each request exactly once and returns the existing task on repeat start', async () => {
    const store = await backend();

    const [first, second] = await Promise.all([
      store.createCogSeedTask(USER_A, { requestId: 'req-idempotent', task: 'First payload.' }),
      store.createCogSeedTask(USER_A, { requestId: 'req-idempotent', task: 'First payload.' }),
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.task.taskId).toBe(second.task.taskId);
    expect(first.task.task).toBe(second.task.task);
    await expect(store.createCogSeedTask(USER_A, {
      requestId: 'req-idempotent',
      task: 'Second payload must not run.',
    })).rejects.toThrow(/payload conflict/i);
  });

  it('keeps legacy request claims readable while fingerprinting all new claims', async () => {
    const store = await backend();
    const paths = await backendPaths();
    const created = await store.createCogSeedTask(USER_A, { requestId: 'req-legacy-claim', task: 'Original request.' });
    const claimFile = paths.cogseedRequestClaimFile(USER_A, 'req-legacy-claim');
    const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    expect(claim.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    delete claim.requestFingerprint;
    fs.writeFileSync(claimFile, JSON.stringify(claim));

    await expect(store.createCogSeedTask(USER_A, {
      requestId: 'req-legacy-claim',
      task: 'Legacy replay keeps its historical behavior.',
    })).resolves.toMatchObject({ created: false, task: { taskId: created.task.taskId } });
  });

  it('persists formal Agent identity and maps a commander conversation alias to the durable member session', async () => {
    const store = await backend();
    const created = await store.createCogSeedTask(USER_A, {
      requestId: 'req-formal-agent',
      task: 'Run the formal Agent.',
      sessionId: 'gconv-cid-formal',
      agentId: 'agent-formal',
    });

    expect(created.task).toMatchObject({
      sessionId: expect.stringMatching(/^cogseed-session-/),
      conversationId: 'cid-formal',
      agentId: 'agent-formal',
    });
    await expect(store.readCogSeedSession(USER_A, created.task.sessionId)).resolves.toMatchObject({
      sessionKind: 'member',
      actorId: 'agent-formal',
      agentId: 'agent-formal',
      conversationId: 'cid-formal',
    });
  });

  it('reuses only a valid owner session mapping and rejects unsafe IDs before constructing paths', async () => {
    const store = await backend();
    const paths = await backendPaths();

    const session = await store.getOrCreateCogSeedSession(USER_A);
    const reused = await store.getOrCreateCogSeedSession(USER_A, session.sessionId);
    expect(reused).toEqual(session);

    await expect(store.getOrCreateCogSeedSession(USER_B, session.sessionId)).rejects.toThrow(/session/i);
    expect(() => paths.cogseedTaskFile('../escape', 'cogseed-task-a')).toThrow(/user/i);
    expect(() => paths.cogseedTaskFile(USER_A, '../escape')).toThrow(/task/i);
  });
  it('lists only CogSeed sessions in the owner scope in stable order', async () => {
    const store = await backend();
    const first = await store.getOrCreateCogSeedSession(USER_A);
    const second = await store.getOrCreateCogSeedSession(USER_A);
    const sessions = await store.listCogSeedSessions(USER_A);
    expect(sessions.map((row) => row.sessionId)).toEqual(expect.arrayContaining([first.sessionId, second.sessionId]));
    expect(await store.listCogSeedSessions(USER_B)).toEqual([]);
  });

  it('freezes the current complete Skill versions when a task is created', async () => {
    const versions = await import('../../../../src/main/features/skills/version-store');
    const record = await versions.appendFullSkillVersion(USER_A, 'skill-versioned', {
      operation: 'install',
      files: [{ path: 'SKILL.md', content: '---\nname: skill-versioned\ndescription: test\n---\n' }],
      source: { kind: 'manual_edit' },
      security: { outcome: 'pass', findingCount: 0 },
    });
    const store = await backend();
    const pinned = await store.createCogSeedTask(USER_A, {
      requestId: 'req-pinned-skill',
      task: 'Use the versioned Skill.',
      allowedSkillIds: ['skill-versioned'],
    });
    expect(pinned.task).toMatchObject({
      skillVersionPinStatus: 'pinned',
      skillVersionPins: [{
        skillId: 'skill-versioned',
        version: record.version,
        revisionId: record.revisionId,
        manifestHash: record.manifestHash,
      }],
    });
    const runtimeSnapshots = await import('../../../../src/main/features/skills/runtime-snapshot-service');
    const snapshotDir = runtimeSnapshots.skillRuntimeSnapshotDir(USER_A, 'skill-versioned', record.revisionId);
    expect(fs.readFileSync(path.join(snapshotDir, 'SKILL.md'), 'utf8')).toContain('name: skill-versioned');

    const partial = await store.createCogSeedTask(USER_A, {
      requestId: 'req-partial-skill-pins',
      task: 'Use one versioned and one legacy Skill.',
      allowedSkillIds: ['skill-versioned', 'skill-unversioned'],
    });
    expect(partial.task.skillVersionPinStatus).toBe('unpinned');
    expect(partial.task.skillVersionPins).toHaveLength(1);
  });

  it('round-trips the viaP3394Gateway flag so P3394 external agents execute via the gateway, not the raw CLI runner', async () => {
    const store = await backend();

    const result = await store.createCogSeedTask(USER_A, {
      requestId: 'req-p3394-gateway-flag',
      task: 'Cooperate over P3394.',
      executionKind: 'local-cli',
      localCli: { cli: 'codex', agentName: 'Codex', viaP3394Gateway: true },
    });

    // 关键不变量：外接智能体（runtime.kind='p3394-gateway'）的 viaP3394Gateway
    // 标记必须落盘并原样读回，否则 consumeRuntime 退化为 local_agents runner
    // 直连（绕过托管 gateway），P3394 协作失效。
    expect(result.task.localCli).toMatchObject({ cli: 'codex', agentName: 'Codex', viaP3394Gateway: true });
    const reread = await store.readCogSeedTask(USER_A, result.task.taskId);
    expect(reread?.localCli?.viaP3394Gateway).toBe(true);
    // 未设置时既不落盘也不读回 true（默认为本地直连语义）。
    const plain = await store.createCogSeedTask(USER_A, {
      requestId: 'req-plain-cli-flag',
      task: 'Run locally.',
      executionKind: 'local-cli',
      localCli: { cli: 'claude' },
    });
    expect(plain.task.localCli?.viaP3394Gateway).not.toBe(true);
  });


});
