import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
    if (String(opts.message).includes('帮我修复登录问题')) {
      const tool = (opts.extraTools || []).find((candidate: any) => candidate.name === 'kstar_control');
      if (!tool) throw new Error('kstar_control not available');
      await tool.execute({
        operation: 'upsert_state',
        idempotencyKey: 'mixed-task-create',
        task: { operation: 'create', title: '修复登录问题' },
        requirement: { operation: 'create', goalText: '修复登录问题并验证' },
      }, {});
    }
    yield { type: 'final', text: 'Commander 正常回复' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
  hasActiveSession: vi.fn(() => true),
}));

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
let previousFlag: string | undefined;
const cids: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  modelCalls.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-commander-centric-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  previousFlag = process.env.ORKAS_COMMANDER_CENTRIC_KSTAR;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  process.env.ORKAS_COMMANDER_CENTRIC_KSTAR = '1';
  const users = await import('../../../../src/main/features/users');
  users.activateUser('user-a');
});

afterEach(async () => {
  const groupChat = await import('../../../../src/main/features/group_chat');
  for (const cid of cids.splice(0)) await groupChat.dropConv('user-a', cid).catch(() => undefined);
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  if (previousFlag === undefined) delete process.env.ORKAS_COMMANDER_CENTRIC_KSTAR;
  else process.env.ORKAS_COMMANDER_CENTRIC_KSTAR = previousFlag;
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

function recordFiles(collection: 'tasks' | 'requirements'): string[] {
  const dir = path.join(tmpDir, 'user-a', 'cloud', 'kstar', collection);
  try { return fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
}

function projectionFiles(): string[] {
  const dir = path.join(tmpDir, 'user-a', 'cloud', 'recall', 'records', 'context-projections');
  try { return fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
}

describe('Commander-centric KStar routing', () => {
  it.each(['你好', '谢谢', '好的', '？！', '👍'])(
    '%s reaches Commander and writes no KStar records',
    async (text) => {
      const cid = newCid();
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const groupChat = await import('../../../../src/main/features/group_chat');
      const store = await import('../../../../src/main/features/kstar/requirement-store');
      bus.subscribe('user-a', cid, () => undefined);

      await bus.enqueue({ uid: 'user-a', cid, fromActorId: 'user', text });
      await waitForQuiescent(bus, cid);

      expect(modelCalls).toHaveLength(1);
      expect(modelCalls[0].message).toContain(text);
      expect(await groupChat.readMessages('user-a', cid)).toContainEqual(expect.objectContaining({
        from: 'commander',
        text: 'Commander 正常回复',
      }));
      expect(await store.readConversationTaskState('user-a', cid)).toBeNull();
      expect(recordFiles('tasks')).toEqual([]);
      expect(recordFiles('requirements')).toEqual([]);
      expect(projectionFiles()).toEqual([]);
      expect((await import('../../../../src/main/features/group_chat/state')).readState('user-a', cid))
        .resolves.not.toHaveProperty('pending_projection_dispatch');
    },
  );

  it('does not mutate an existing Task when Commander makes no control call', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const task = store.createKstarTaskRecord('user-a', { conversationId: cid, title: 'Existing task' });
    const requirement = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: cid,
      userMessageIds: ['msg-existing'],
      title: 'Existing requirement',
      goalText: 'Keep this state unchanged',
    });
    task.requirementIds = [requirement.id];
    task.currentRequirementId = requirement.id;
    await store.replaceKstarTask('user-a', task);
    await store.replaceKstarRequirement('user-a', requirement);
    await store.writeConversationTaskState('user-a', {
      ...store.createInitialConversationTaskState('user-a', cid),
      currentTaskId: task.id,
      currentRequirementId: requirement.id,
    });
    const beforeTask = fs.readFileSync(path.join(tmpDir, 'user-a', 'cloud', 'kstar', 'tasks', `${task.id}.json`), 'utf8');
    const beforeRequirement = fs.readFileSync(path.join(tmpDir, 'user-a', 'cloud', 'kstar', 'requirements', `${requirement.id}.json`), 'utf8');

    bus.subscribe('user-a', cid, () => undefined);
    await bus.enqueue({ uid: 'user-a', cid, fromActorId: 'user', text: '谢谢' });
    await waitForQuiescent(bus, cid);

    expect(modelCalls).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, 'user-a', 'cloud', 'kstar', 'tasks', `${task.id}.json`), 'utf8')).toBe(beforeTask);
    expect(fs.readFileSync(path.join(tmpDir, 'user-a', 'cloud', 'kstar', 'requirements', `${requirement.id}.json`), 'utf8')).toBe(beforeRequirement);
  });

  it('tracks a mixed greeting and task only when Commander calls kstar_control', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    bus.subscribe('user-a', cid, () => undefined);

    await bus.enqueue({ uid: 'user-a', cid, fromActorId: 'user', text: '你好，帮我修复登录问题' });
    await waitForQuiescent(bus, cid);

    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0].toolNames).toContain('kstar_control');
    expect(await store.readConversationTaskState('user-a', cid)).toMatchObject({
      currentTaskId: expect.stringMatching(/^kst-/),
      currentRequirementId: expect.stringMatching(/^ksreq-/),
      controlReceipts: [expect.objectContaining({ idempotencyKey: 'mixed-task-create' })],
    });
    expect(recordFiles('tasks')).toHaveLength(1);
    expect(recordFiles('requirements')).toHaveLength(1);
    expect(projectionFiles()).toEqual([]);
  });
});
