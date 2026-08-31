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
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
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

  it('rejects a persisted task whose lifecycle status is outside the schema', async () => {
    const store = await backend();
    const paths = await backendPaths();
    const created = await store.createCogSeedTask(USER_A, {
      requestId: 'req-invalid-status',
      task: 'Reject an unknown persisted lifecycle state.',
    });
    const file = paths.cogseedTaskFile(USER_A, created.task.taskId);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    persisted.status = 'paused';
    fs.writeFileSync(file, JSON.stringify(persisted));

    await expect(store.readCogSeedTask(USER_A, created.task.taskId)).rejects.toThrow(/malformed CogSeed task/i);
    await expect(store.listCogSeedTasks(USER_A)).rejects.toThrow(/malformed CogSeed task/i);
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

  it('repairs a stripped modern claim fingerprint while keeping fully legacy records readable', async () => {
    const store = await backend();
    const paths = await backendPaths();
    const created = await store.createCogSeedTask(USER_A, { requestId: 'req-legacy-claim', task: 'Original request.' });
    const claimFile = paths.cogseedRequestClaimFile(USER_A, 'req-legacy-claim');
    const taskFile = paths.cogseedTaskFile(USER_A, created.task.taskId);
    let claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    expect(claim.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    delete claim.requestFingerprint;
    fs.writeFileSync(claimFile, JSON.stringify(claim));

    await expect(store.createCogSeedTask(USER_A, {
      requestId: 'req-legacy-claim',
      task: 'Original request.',
    })).resolves.toMatchObject({ created: false, task: { taskId: created.task.taskId } });
    claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    expect(claim.requestFingerprint).toBe(created.task.requestFingerprint);

    const legacyTask = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    delete legacyTask.requestFingerprint;
    fs.writeFileSync(taskFile, JSON.stringify(legacyTask));
    delete claim.requestFingerprint;
    fs.writeFileSync(claimFile, JSON.stringify(claim));

    await expect(store.createCogSeedTask(USER_A, {
      requestId: 'req-legacy-claim',
      task: 'Legacy replay keeps its historical behavior.',
    })).resolves.toMatchObject({ created: false, task: { taskId: created.task.taskId } });
  });

  it('repairs a unique task written before its request claim without duplicating creation artifacts', async () => {
    const store = await backend();
    const paths = await backendPaths();
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const input = { requestId: 'req-orphan-repair', task: 'Repair this interrupted creation.' };
    const created = await store.createCogSeedTask(USER_A, input);
    const claimFile = paths.cogseedRequestClaimFile(USER_A, input.requestId);
    const eventFile = paths.cogseedTaskEventsFile(USER_A, created.task.taskId);
    const sessionFile = paths.cogseedSessionFile(USER_A, created.task.sessionId);

    fs.rmSync(claimFile);
    fs.rmSync(eventFile);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    delete session.activeTaskId;
    fs.writeFileSync(sessionFile, JSON.stringify(session));

    await expect(store.readCogSeedTaskByRequestId(USER_A, input.requestId)).resolves.toMatchObject({
      taskId: created.task.taskId,
    });

    const repaired = await store.createCogSeedTask(USER_A, input);
    const replay = await store.createCogSeedTask(USER_A, input);

    expect(repaired).toMatchObject({ created: false, task: { taskId: created.task.taskId } });
    expect(replay).toMatchObject({ created: false, task: { taskId: created.task.taskId } });
    expect(await store.listCogSeedTasks(USER_A)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(claimFile, 'utf8'))).toMatchObject({
      taskId: created.task.taskId,
      requestFingerprint: created.task.requestFingerprint,
    });
    await expect(store.readCogSeedSession(USER_A, created.task.sessionId)).resolves.toMatchObject({
      activeTaskId: created.task.taskId,
    });
    await expect(events.readCogSeedTaskEvents(USER_A, created.task.taskId, 0, 10)).resolves.toEqual([
      expect.objectContaining({ type: 'task.created', payload: { requestId: input.requestId } }),
    ]);
  });

  it('repairs a legacy orphan even when old recovery wrote the first lifecycle event', async () => {
    const store = await backend();
    const paths = await backendPaths();
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const input = { requestId: 'req-orphan-recovered-first', task: 'Repair after an interrupted admission.' };
    const created = await store.createCogSeedTask(USER_A, input);
    fs.rmSync(paths.cogseedRequestClaimFile(USER_A, input.requestId));
    fs.rmSync(paths.cogseedTaskEventsFile(USER_A, created.task.taskId));

    await lifecycle.markCogSeedTaskRecoverable(USER_A, created.task.taskId, 'worker_restart');
    await expect(store.createCogSeedTask(USER_A, input)).resolves.toMatchObject({
      created: false,
      task: { taskId: created.task.taskId, status: 'recoverable' },
    });

    expect(JSON.parse(fs.readFileSync(paths.cogseedRequestClaimFile(USER_A, input.requestId), 'utf8'))).toMatchObject({
      taskId: created.task.taskId,
      requestFingerprint: created.task.requestFingerprint,
    });
    await expect(events.readCogSeedTaskEvents(USER_A, created.task.taskId, 0, 10)).resolves.toEqual([
      expect.objectContaining({ type: 'task.recoverable', payload: { errorCode: 'worker_restart' } }),
    ]);
  });

  it('rejects a conflicting replay when repairing a missing request claim', async () => {
    const store = await backend();
    const paths = await backendPaths();
    const created = await store.createCogSeedTask(USER_A, {
      requestId: 'req-orphan-conflict',
      task: 'Original orphan payload.',
    });
    const claimFile = paths.cogseedRequestClaimFile(USER_A, 'req-orphan-conflict');
    fs.rmSync(claimFile);

    await expect(store.createCogSeedTask(USER_A, {
      requestId: 'req-orphan-conflict',
      task: 'Conflicting orphan payload.',
    })).rejects.toThrow(/payload conflict/i);
    expect(await store.listCogSeedTasks(USER_A)).toEqual([
      expect.objectContaining({ taskId: created.task.taskId, task: 'Original orphan payload.' }),
    ]);
    expect(fs.existsSync(claimFile)).toBe(false);
  });

  it('fails closed when one request has multiple orphan tasks', async () => {
    const store = await backend();
    const paths = await backendPaths();
    const first = await store.createCogSeedTask(USER_A, {
      requestId: 'req-multiple-orphans',
      task: 'First orphan.',
    });
    const second = await store.createCogSeedTask(USER_A, {
      requestId: 'req-other-orphan',
      task: 'Second orphan.',
    });
    const secondFile = paths.cogseedTaskFile(USER_A, second.task.taskId);
    const secondRecord = JSON.parse(fs.readFileSync(secondFile, 'utf8'));
    secondRecord.requestId = first.task.requestId;
    fs.writeFileSync(secondFile, JSON.stringify(secondRecord));
    fs.rmSync(paths.cogseedRequestClaimFile(USER_A, first.task.requestId));
    fs.rmSync(paths.cogseedRequestClaimFile(USER_A, second.task.requestId));

    await expect(store.createCogSeedTask(USER_A, {
      requestId: first.task.requestId,
      task: first.task.task,
    })).rejects.toThrow(/multiple CogSeed tasks/i);
    expect(await store.listCogSeedTasks(USER_A)).toHaveLength(2);
    expect(fs.existsSync(paths.cogseedRequestClaimFile(USER_A, first.task.requestId))).toBe(false);
  });

  it('fails closed for a legacy orphan whose request fingerprint cannot be reconstructed', async () => {
    const store = await backend();
    const paths = await backendPaths();
    const created = await store.createCogSeedTask(USER_A, {
      requestId: 'req-legacy-orphan',
      task: 'Legacy orphan payload.',
    });
    const taskFile = paths.cogseedTaskFile(USER_A, created.task.taskId);
    const record = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    delete record.requestFingerprint;
    fs.writeFileSync(taskFile, JSON.stringify(record));
    fs.rmSync(paths.cogseedRequestClaimFile(USER_A, created.task.requestId));

    await expect(store.createCogSeedTask(USER_A, {
      requestId: created.task.requestId,
      task: created.task.task,
    })).rejects.toThrow(/fingerprint is unavailable/i);
    expect(await store.listCogSeedTasks(USER_A)).toHaveLength(1);
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

  it('round-trips all durable KSTAR bridge identifiers', async () => {
    const store = await backend();
    const created = await store.createCogSeedTask(USER_A, {
      requestId: 'req-kstar-bridge-ids', task: 'Run a governed task.',
      kstarTaskId: 'kst-bridge-task', kstarRequirementId: 'ksr-bridge-requirement',
      kstarProjectionId: 'proj-bridge-projection', kstarForecastId: 'wf-bridge-forecast',
    });
    await expect(store.readCogSeedTask(USER_A, created.task.taskId)).resolves.toMatchObject({
      kstarTaskId: 'kst-bridge-task', kstarRequirementId: 'ksr-bridge-requirement',
      kstarProjectionId: 'proj-bridge-projection', kstarForecastId: 'wf-bridge-forecast',
    });
    await expect(store.createCogSeedTask(USER_A, {
      requestId: 'req-kstar-bridge-invalid', task: 'Reject unsafe bridge id.', kstarForecastId: '../escape',
    })).rejects.toThrow(/forecast/i);
  });


});
