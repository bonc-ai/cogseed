// 多 Agent 协作运行记录（设计 §4.1）——提交时冻结范围，回读一致，派发可登记。
//
// 关注业务不变量，不测文件实现细节：
//   - 成员/点名/配置在提交时冻结：之后改配置不影响已建 run
//   - 保留 id（协调者/用户）不是 agent 成员，不写进名单
//   - 外接实例 id 单独记录（供「不可见其他成员」与按来源配置使用）
//   - 顺序意图落 requires_sequential，点名顺序落 mention_order
//   - 派发登记按 actor 累计回合且去重；run 目录可按扫描列出

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const storageMocks = vi.hoisted(() => ({
  readJson: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock('../../../../src/main/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/storage')>();
  return {
    ...actual,
    readJson: (...args: Parameters<typeof actual.readJson>) => storageMocks.readJson(...args),
    writeJson: (...args: Parameters<typeof actual.writeJson>) => storageMocks.writeJson(...args),
  };
});

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-run-record';
const CID = 'cid-run-1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-run-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  storageMocks.readJson.mockReset();
  storageMocks.writeJson.mockReset();
  const storage = await vi.importActual<typeof import('../../../../src/main/storage')>(
    '../../../../src/main/storage',
  );
  storageMocks.readJson.mockImplementation(storage.readJson);
  storageMocks.writeJson.mockImplementation(storage.writeJson);
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function loadStore() {
  return import('../../../../src/main/features/group_chat/run_store');
}

describe('group_chat › run record（提交时冻结的协作运行）', () => {
  it('建立运行并冻结成员 / 点名 / 来源配置', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: '@Codex 先做方案，再让 @集成验证Agent 验证',
      memberAgentIds: ['agent-codex-1', 'agent-task-2'],
      mentionAgentIds: ['agent-codex-1', 'agent-task-2'],
      externalAgentIds: ['agent-codex-1'],
      sourceConfigs: { internal: { model: 'deepseek-v4-pro' }, 'agent-codex-1': { model: 'gpt-5.6-sol' } },
      requiresSequential: true,
    });
    expect(run).not.toBeNull();
    expect(run!.status).toBe('running');
    expect(run!.member_agent_ids).toEqual(['agent-codex-1', 'agent-task-2']);
    expect(run!.mention_order).toEqual(['agent-codex-1', 'agent-task-2']);
    expect(run!.external_agent_ids).toEqual(['agent-codex-1']);
    expect(run!.requires_sequential).toBe(true);
    expect(run!.source_configs).toEqual({
      internal: { model: 'deepseek-v4-pro' },
      'agent-codex-1': { model: 'gpt-5.6-sol' },
    });

    const back = await store.readRun(TEST_UID, CID, run!.run_id);
    expect(back).toEqual(run);
  });

  it('在 input_snapshot 中往返保存单来源配置、附件与引用描述符', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: '@Codex 检查附件和引用',
      memberAgentIds: ['agent-codex-1'],
      mentionAgentIds: ['agent-codex-1'],
      externalAgentIds: ['agent-codex-1'],
      sourceConfigs: { 'agent-codex-1': { model: 'gpt-5.6-sol', effort: 'high' } },
      attachmentIds: ['brief.txt'],
      attachmentDescriptors: [
        { id: 'brief.txt', name: 'brief.txt', kind: 'text', bytes: 42, mtime: 1_795_000_000 },
      ],
      references: [
        {
          source_cid: 'cid-source',
          source_title: 'Source',
          source_msg_id: 'msg-source',
          from_actor: 'agent-source',
          source_ts: '2026-09-20T00:00:00.000Z',
          text: 'source result',
          attachments: [{ name: 'evidence.pdf', kind: 'pdf' }],
          produced: ['result.md'],
        },
      ],
      requiresSequential: false,
    });

    expect(run?.input_snapshot).toEqual({
      submitted_text: '@Codex 检查附件和引用',
      member_agent_ids: ['agent-codex-1'],
      mention_agent_ids: ['agent-codex-1'],
      mention_order: ['agent-codex-1'],
      external_agent_ids: ['agent-codex-1'],
      source_configs: { 'agent-codex-1': { model: 'gpt-5.6-sol', effort: 'high' } },
      attachment_ids: ['brief.txt'],
      attachments: [
        { id: 'brief.txt', name: 'brief.txt', kind: 'text', bytes: 42, mtime: 1_795_000_000 },
      ],
      references: [
        {
          source_cid: 'cid-source',
          source_title: 'Source',
          source_msg_id: 'msg-source',
          from_actor: 'agent-source',
          source_ts: '2026-09-20T00:00:00.000Z',
          text: 'source result',
          attachments: [{ name: 'evidence.pdf', kind: 'pdf' }],
          produced: ['result.md'],
        },
      ],
      requires_sequential: false,
    });
    expect(await store.readRun(TEST_UID, CID, run!.run_id)).toEqual(run);
  });

  it('严格拒绝未知版本、未知枚举、不安全 id、非法配置与路径 CID 不一致', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: 'strict decode',
      memberAgentIds: ['agent-a'],
      mentionAgentIds: ['agent-a'],
      sourceConfigs: { internal: { provider: 'openai', model: 'gpt-5.6-sol', effort: 'low' } },
    });
    const file = store.runFileOf(TEST_UID, CID, run!.run_id);
    const valid = JSON.parse(fs.readFileSync(file, 'utf8'));
    const corruptions: Array<(row: any) => void> = [
      (row) => { row.version = 2; },
      (row) => { row.status = 'future'; },
      (row) => { row.actors[0].terminal = 'future'; },
      (row) => { row.actors[0].agent_id = '../escape'; },
      (row) => { row.actors[0].dispatched = ['../turn']; },
      (row) => { row.cid = 'cid-other'; },
      (row) => { row.run_id = 'run_other'; },
      (row) => { row.input_snapshot.member_agent_ids = ['../escape']; },
      (row) => { row.input_snapshot.source_configs.internal.effort = 'ultra'; },
      (row) => { row.input_snapshot.source_configs['../external'] = { model: 'x' }; },
    ];

    for (const corrupt of corruptions) {
      const row = structuredClone(valid);
      corrupt(row);
      fs.writeFileSync(file, JSON.stringify(row));
      expect(await store.readRun(TEST_UID, CID, run!.run_id)).toBeNull();
    }
  });

  it('input_snapshot 在运行状态更新中不可改写', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: 'original',
      memberAgentIds: ['agent-a'],
      mentionAgentIds: ['agent-a'],
    });
    const updated = await store.updateRun(TEST_UID, CID, run!.run_id, (record) => {
      record.input_snapshot.submitted_text = 'mutated';
      return record;
    });
    expect(updated).toBeNull();
    expect((await store.readRun(TEST_UID, CID, run!.run_id))?.input_snapshot.submitted_text)
      .toBe('original');
  });

  it('保留 id（协调者 / 用户）不是成员，不写进名单', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: '看这个',
      memberAgentIds: ['commander', 'agent-codex-1', 'user', 'agent-codex-1'],
      mentionAgentIds: [],
    });
    expect(run!.member_agent_ids).toEqual(['agent-codex-1']);
    expect(run!.mention_agent_ids).toEqual([]);
    expect(run!.mention_order).toEqual([]);
    expect(run!.requires_sequential).toBe(false);
  });

  it('派发登记按 actor 累计且去重，重复 runId 读回同一份', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: '@Codex 看这个',
      memberAgentIds: ['agent-codex-1'],
      mentionAgentIds: ['agent-codex-1'],
    });
    await store.recordRunDispatch(TEST_UID, CID, run!.run_id, 'agent-codex-1', 'turn-1');
    await store.recordRunDispatch(TEST_UID, CID, run!.run_id, 'agent-codex-1', 'turn-1');
    await store.recordRunDispatch(TEST_UID, CID, run!.run_id, 'agent-task-2', 'turn-2');
    const back = await store.readRun(TEST_UID, CID, run!.run_id);
    const codex = back!.actors.find((a) => a.agent_id === 'agent-codex-1')!;
    expect(codex.dispatched).toEqual(['turn-1']);
    expect(codex.attempts).toBe(1);
    expect(back!.actors.map((a) => a.agent_id).sort()).toEqual(['agent-codex-1', 'agent-task-2']);
  });

  it('retry pending 显式绑定 durable operation，进入新终态后清除 ownership', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: '@Agent retry me',
      memberAgentIds: ['agent-a'],
      mentionAgentIds: ['agent-a'],
    });
    await store.recordRunActorTerminal(TEST_UID, CID, run!.run_id, 'agent-a', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });
    await store.finalizeRun(TEST_UID, CID, run!.run_id);

    await store.prepareRunRetry(TEST_UID, CID, run!.run_id, ['agent-a'], 'retry-operation-1');
    let back = await store.readRun(TEST_UID, CID, run!.run_id);
    expect(back?.actors[0]).toMatchObject({
      terminal: 'pending',
      retry_operation_id: 'retry-operation-1',
    });

    await store.recordRunActorTerminal(TEST_UID, CID, run!.run_id, 'agent-a', {
      terminal: 'failed', reason: 'retry_failed', messages: 0, artifacts: [],
    });
    back = await store.readRun(TEST_UID, CID, run!.run_id);
    expect(back?.actors[0]).not.toHaveProperty('retry_operation_id');
  });

  it('按扫描列出本会话的运行 id；非法 id 直接拒绝', async () => {
    const store = await loadStore();
    const a = await store.createRun({
      uid: TEST_UID, cid: CID, submittedText: 'a', memberAgentIds: [], mentionAgentIds: [],
    });
    const b = await store.createRun({
      uid: TEST_UID, cid: CID, submittedText: 'b', memberAgentIds: [], mentionAgentIds: [],
    });
    const ids = await store.listRunIds(TEST_UID, CID);
    expect(ids).toContain(a!.run_id);
    expect(ids).toContain(b!.run_id);
    expect(await store.readRun(TEST_UID, CID, '../escape')).toBeNull();
    expect(await store.readRun(TEST_UID, CID, 'run_missing')).toBeNull();
  });

  it('run 文件落在会话 group 目录的 runs/ 下（不建聚合索引）', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID, cid: CID, submittedText: 'x', memberAgentIds: [], mentionAgentIds: [],
    });
    const file = store.runFileOf(TEST_UID, CID, run!.run_id);
    expect(fs.existsSync(file)).toBe(true);
    expect(path.basename(path.dirname(file))).toBe('runs');
    expect(fs.existsSync(path.join(path.dirname(path.dirname(file)), 'runs.json'))).toBe(false);
  });

  it('只有真正产出结果的 done 成员计入贡献；任一未完成则 run 不得 completed', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: '先方案后验证',
      memberAgentIds: ['agent-a', 'agent-b'],
      mentionAgentIds: ['agent-a', 'agent-b'],
      requiresSequential: true,
    });
    await store.recordRunDispatch(TEST_UID, CID, run!.run_id, 'agent-a', 'turn-a');
    await store.recordRunDispatch(TEST_UID, CID, run!.run_id, 'agent-b', 'turn-b');
    await store.recordRunActorTerminal(TEST_UID, CID, run!.run_id, 'agent-a', {
      terminal: 'done', messages: 1, artifacts: ['artifact-a'],
    });
    await store.recordRunActorTerminal(TEST_UID, CID, run!.run_id, 'agent-b', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });

    const final = await store.finalizeRun(TEST_UID, CID, run!.run_id);
    expect(final?.status).toBe('failed');
    expect(final?.summary).toEqual({
      contributed: [{ agent_id: 'agent-a', messages: 1, artifacts: ['artifact-a'] }],
      missing: [{ agent_id: 'agent-b', reason: 'runtime_failed' }],
    });
  });

  it('被点名但未派发 / 无产出的成员必须显式进入 missing', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: '独立分析后汇总',
      memberAgentIds: ['agent-a', 'agent-b'],
      mentionAgentIds: ['agent-a', 'agent-b'],
    });
    await store.recordRunDispatch(TEST_UID, CID, run!.run_id, 'agent-a', 'turn-a');
    await store.recordRunActorTerminal(TEST_UID, CID, run!.run_id, 'agent-a', {
      terminal: 'done', messages: 0, artifacts: [],
    });

    const final = await store.finalizeRun(TEST_UID, CID, run!.run_id);
    expect(final?.status).toBe('failed');
    expect(final?.summary?.missing).toEqual([
      { agent_id: 'agent-a', reason: 'no_contribution' },
      { agent_id: 'agent-b', reason: 'no_terminal' },
    ]);
  });

  it('运行中移除只停指定成员，保留已完成成果；重试只重置未完成成员', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: '请协作',
      memberAgentIds: ['agent-a', 'agent-b', 'agent-c'],
      mentionAgentIds: ['agent-a', 'agent-b', 'agent-c'],
    });
    await store.recordRunActorTerminal(TEST_UID, CID, run!.run_id, 'agent-a', {
      terminal: 'done', messages: 1, artifacts: ['kept'],
    });
    await store.stopRun(TEST_UID, CID, run!.run_id, {
      agentIds: ['agent-b'], reason: 'member_removed', terminal: 'removed',
    });
    await store.recordRunActorTerminal(TEST_UID, CID, run!.run_id, 'agent-c', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });
    const stopped = await store.readRun(TEST_UID, CID, run!.run_id);
    expect(stopped?.actors.find((a) => a.agent_id === 'agent-a')).toMatchObject({
      terminal: 'done', produced: { messages: 1, artifacts: ['kept'] },
    });
    expect(stopped?.actors.find((a) => a.agent_id === 'agent-b')).toMatchObject({
      terminal: 'removed', reason: 'member_removed',
    });

    const retry = await store.prepareRunRetry(TEST_UID, CID, run!.run_id);
    expect(retry?.retry_agent_ids).toEqual(['agent-b', 'agent-c']);
    expect(retry?.run.actors.find((a) => a.agent_id === 'agent-a')?.terminal).toBe('done');
    expect(retry?.run.actors.find((a) => a.agent_id === 'agent-b')?.terminal).toBe('pending');
    expect(retry?.run.actors.find((a) => a.agent_id === 'agent-c')?.terminal).toBe('pending');
    expect(retry?.run.status).toBe('running');
    expect(retry?.run.summary).toBeUndefined();
  });

  it('停止或移除后的迟到派发不得改写耐久终态，显式重试前不会复活', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: '请协作',
      memberAgentIds: ['agent-a', 'agent-b'],
      mentionAgentIds: ['agent-a', 'agent-b'],
    });
    await store.stopRun(TEST_UID, CID, run!.run_id, {
      agentIds: ['agent-a'], reason: 'member_removed', terminal: 'removed',
    });
    await store.stopRun(TEST_UID, CID, run!.run_id, {
      agentIds: ['agent-b'], reason: 'user_stopped', terminal: 'stopped',
    });

    await store.recordRunDispatch(TEST_UID, CID, run!.run_id, 'agent-a', 'late-turn-a');
    await store.recordRunDispatch(TEST_UID, CID, run!.run_id, 'agent-b', 'late-turn-b');

    const back = await store.readRun(TEST_UID, CID, run!.run_id);
    expect(back?.actors.find((a) => a.agent_id === 'agent-a')).toMatchObject({
      terminal: 'removed', reason: 'member_removed', attempts: 0, dispatched: [],
    });
    expect(back?.actors.find((a) => a.agent_id === 'agent-b')).toMatchObject({
      terminal: 'stopped', reason: 'user_stopped', attempts: 0, dispatched: [],
    });
  });

  it('指定成员在 actor row 尚不存在时停止，也会写入不可复活的 tombstone', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: 'member was selected but dispatch has not started',
      memberAgentIds: ['agent-late'],
      mentionAgentIds: [],
    });
    expect(run?.actors).toEqual([]);

    const stopped = await store.stopRun(TEST_UID, CID, run!.run_id, {
      agentIds: ['agent-late'],
      reason: 'member_removed',
      terminal: 'removed',
    });

    expect(stopped?.actors).toContainEqual({
      agent_id: 'agent-late',
      dispatched: [],
      attempts: 0,
      terminal: 'removed',
      reason: 'member_removed',
    });
  });

  it('完整停止即使没有 actor row 也会原子封住 run', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: 'stop before routing',
      memberAgentIds: [],
      mentionAgentIds: [],
    });

    const stopped = await store.stopRun(TEST_UID, CID, run!.run_id);

    expect(stopped?.status).toBe('stopped');
    expect((await store.readRun(TEST_UID, CID, run!.run_id))?.status).toBe('stopped');
  });

  it('停止写入失败时返回 null，并保留原始未停止记录', async () => {
    const store = await loadStore();
    const run = await store.createRun({
      uid: TEST_UID,
      cid: CID,
      submittedText: 'durable stop must succeed first',
      memberAgentIds: ['agent-a'],
      mentionAgentIds: ['agent-a'],
    });
    storageMocks.writeJson.mockRejectedValueOnce(new Error('forced durable stop failure'));

    const stopped = await store.stopRun(TEST_UID, CID, run!.run_id);

    expect(stopped).toBeNull();
    expect(await store.readRun(TEST_UID, CID, run!.run_id)).toMatchObject({
      status: 'running',
      actors: [expect.objectContaining({ agent_id: 'agent-a', terminal: 'pending' })],
    });
  });
});
