import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const controls = vi.hoisted(() => ({
  failPendingClaimWrite: false,
  failCompletedClaimWrite: false,
  collaboration: null as any,
  wakes: [] as any[],
  enqueue: vi.fn(async (input: any) => {
    const msg = {
      id: input.messageId || 'run-retry-message',
      ts: '2026-09-21T00:00:00.000Z',
      from: input.fromActorId,
      to: input.forceTo || [],
      text: input.text,
      ...(input.actionRequestId ? { action_request_id: input.actionRequestId } : {}),
      ...(input.runId ? { run_id: input.runId } : {}),
    };
    const layout = await import('../../../../src/main/util/project-layout');
    const file = layout.conversationMessageFile(input.uid, input.cid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(msg)}\n`, 'utf8');
    return msg;
  }),
  recover: vi.fn(async (input: any) => ({
    msg: { id: input.messageId },
    disposition: 'redispatched',
  })),
}));

vi.mock('../../../../src/main/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/storage')>();
  return {
    ...actual,
    writeJson: async (...args: Parameters<typeof actual.writeJson>) => {
      const [file, value] = args;
      if (controls.failPendingClaimWrite
        && String(file).includes('dashboard-retry-claims')
        && String(path.basename(String(file))).startsWith('run-')
        && value && typeof value === 'object'
        && (value as { status?: unknown }).status === 'pending') {
        controls.failPendingClaimWrite = false;
        throw new Error('simulated run retry claim write failure');
      }
      if (controls.failCompletedClaimWrite
        && String(file).includes('dashboard-retry-claims')
        && String(path.basename(String(file))).startsWith('run-')
        && value && typeof value === 'object'
        && (value as { status?: unknown }).status === 'completed') {
        controls.failCompletedClaimWrite = false;
        throw new Error('simulated run retry completion write failure');
      }
      return actual.writeJson(...args);
    },
  };
});

vi.mock('../../../../src/main/features/group_chat/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/group_chat/bus')>();
  return {
    ...actual,
    enqueue: controls.enqueue,
    recoverPersistedUserDispatch: controls.recover,
  };
});

vi.mock('../../../../src/main/features/group_chat/collaboration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/group_chat/collaboration')>();
  return {
    ...actual,
    readCollaborationSnapshot: vi.fn(async () => controls.collaboration),
  };
});

vi.mock('../../../../src/main/features/p3394/wake-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/p3394/wake-service')>();
  return {
    ...actual,
    listWakeRequests: vi.fn(async () => controls.wakes),
  };
});

vi.mock('../../../../src/main/features/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/agents')>();
  return {
    ...actual,
    getAgentForChatDispatch: vi.fn(async (_uid: string, agentId: string) => ({
      agent_id: agentId,
      name: agentId === 'agent-done' ? 'Done Agent' : 'Failed Agent',
    })),
  };
});

vi.mock('../../../../src/main/features/component_enabled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/component_enabled')>();
  return { ...actual, isAgentEnabled: vi.fn(() => true) };
});

let tmpDir: string;
let previousWorkspace: string | undefined;
const UID = 'u-run-retry';
const CID = 'cid-run-retry';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-run-retry-'));
  previousWorkspace = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  controls.failPendingClaimWrite = false;
  controls.failCompletedClaimWrite = false;
  controls.collaboration = null;
  controls.wakes = [];
  controls.enqueue.mockClear();
  controls.recover.mockClear();
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createSettledRun() {
  const store = await import('../../../../src/main/features/group_chat/run_store');
  const run = await store.createRun({
    uid: UID,
    cid: CID,
    submittedText: '让两位成员协作',
    memberAgentIds: ['agent-done', 'agent-failed'],
    mentionAgentIds: ['agent-done', 'agent-failed'],
  });
  await store.recordRunActorTerminal(UID, CID, run!.run_id, 'agent-done', {
    terminal: 'done', messages: 1, artifacts: ['kept-result'],
  });
  await store.recordRunActorTerminal(UID, CID, run!.run_id, 'agent-failed', {
    terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
  });
  await store.finalizeRun(UID, CID, run!.run_id);
  return run!;
}

describe('group_chat › run retry (FR-019)', () => {
  it('两个不同 request id 并发重试同一 run-target 时只派发一次，并共享同一结果', async () => {
    const run = await createSettledRun();
    const groupChat = await import('../../../../src/main/features/group_chat');

    const [first, second] = await Promise.all([
      groupChat.retryRun({
        userId: UID,
        cid: CID,
        runId: run.run_id,
        agentIds: ['agent-done', 'agent-failed'],
        requestId: 'retry-run-concurrent-a',
      }),
      groupChat.retryRun({
        userId: UID,
        cid: CID,
        runId: run.run_id,
        agentIds: ['agent-failed'],
        requestId: 'retry-run-concurrent-b',
      }),
    ]);

    expect(first).toMatchObject({ ok: true, retry_agent_ids: ['agent-failed'] });
    expect(second).toMatchObject({ ok: true, retry_agent_ids: ['agent-failed'] });
    expect(first.msg?.id).toBe(second.msg?.id);
    expect(controls.enqueue).toHaveBeenCalledTimes(1);

    const layout = await import('../../../../src/main/util/project-layout');
    const claimDir = path.join(layout.conversationLayout(UID, CID).groupDir, 'dashboard-retry-claims');
    const targetFiles = fs.readdirSync(claimDir).filter((name) => name.startsWith('run-target-'));
    expect(targetFiles).toHaveLength(1);
    const operation = JSON.parse(fs.readFileSync(path.join(claimDir, targetFiles[0]), 'utf8'));
    expect(operation).toMatchObject({
      state: 'accepted',
      retry_agent_ids: ['agent-failed'],
    });
    expect(operation.request_aliases.slice().sort()).toEqual([
      'retry-run-concurrent-a',
      'retry-run-concurrent-b',
    ]);
  });

  it('进程重启后新的 request id 复用同一 active run-target 操作而不再次派发', async () => {
    const run = await createSettledRun();
    const firstModule = await import('../../../../src/main/features/group_chat');
    const first = await firstModule.retryRun({
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-before-restart',
    });
    expect(first).toMatchObject({ ok: true, retry_agent_ids: ['agent-failed'] });

    vi.resetModules();
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const restartedModule = await import('../../../../src/main/features/group_chat');
    const afterRestart = await restartedModule.retryRun({
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-after-restart',
    });

    expect(afterRestart).toMatchObject({
      ok: true,
      retry_agent_ids: ['agent-failed'],
      msg: { id: first.msg?.id },
    });
    expect(controls.enqueue).toHaveBeenCalledTimes(1);
  });

  it('actor 完成后重放原 request id 仍返回原接受结果', async () => {
    const run = await createSettledRun();
    const groupChat = await import('../../../../src/main/features/group_chat');
    const input = {
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-replay-after-done',
    };
    const first = await groupChat.retryRun(input);
    expect(first).toMatchObject({ ok: true, retry_agent_ids: ['agent-failed'] });

    const store = await import('../../../../src/main/features/group_chat/run_store');
    await store.recordRunActorTerminal(UID, CID, run.run_id, 'agent-failed', {
      terminal: 'done', messages: 1, artifacts: ['retry-result'],
    });
    await store.finalizeRun(UID, CID, run.run_id);

    await expect(groupChat.retryRun(input)).resolves.toMatchObject({
      ok: true,
      retry_agent_ids: ['agent-failed'],
      msg: { id: first.msg?.id },
    });
    expect(controls.enqueue).toHaveBeenCalledTimes(1);
  });

  it('上一轮 retry 失败后，新 request id 建立下一代 operation 和新的稳定派发 id', async () => {
    const run = await createSettledRun();
    const groupChat = await import('../../../../src/main/features/group_chat');
    const first = await groupChat.retryRun({
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-generation-1',
    });
    const firstDispatchTurnId = controls.enqueue.mock.calls[0][0]
      .dispatchTurnIds['agent-failed'];

    const store = await import('../../../../src/main/features/group_chat/run_store');
    await store.recordRunDispatch(
      UID, CID, run.run_id, 'agent-failed', firstDispatchTurnId,
    );
    await store.recordRunActorTerminal(UID, CID, run.run_id, 'agent-failed', {
      terminal: 'failed', reason: 'retry_failed', messages: 0, artifacts: [],
    });
    await store.finalizeRun(UID, CID, run.run_id);

    const second = await groupChat.retryRun({
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-generation-2',
    });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, retry_agent_ids: ['agent-failed'] });
    expect(second.msg?.id).not.toBe(first.msg?.id);
    expect(controls.enqueue).toHaveBeenCalledTimes(2);
    expect(controls.enqueue.mock.calls[1][0].dispatchTurnIds['agent-failed'])
      .not.toBe(firstDispatchTurnId);
  });

  it('同一 request id 只排队一次，且 done 成员及其成果不会被重跑', async () => {
    const run = await createSettledRun();
    const groupChat = await import('../../../../src/main/features/group_chat');
    const input = {
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-done', 'agent-failed'],
      requestId: 'retry-run-once',
    };

    await expect(groupChat.retryRun(input)).resolves.toMatchObject({
      ok: true,
      retry_agent_ids: ['agent-failed'],
    });
    await expect(groupChat.retryRun(input)).resolves.toMatchObject({
      ok: true,
      retry_agent_ids: ['agent-failed'],
    });
    expect(controls.enqueue).toHaveBeenCalledTimes(1);
    expect(controls.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      forceTo: ['agent-failed'],
      runId: run.run_id,
    }));

    const store = await import('../../../../src/main/features/group_chat/run_store');
    const back = await store.readRun(UID, CID, run.run_id);
    expect(back?.actors.find((actor) => actor.agent_id === 'agent-done')).toMatchObject({
      terminal: 'done', produced: { messages: 1, artifacts: ['kept-result'] },
    });
    expect(back?.actors.find((actor) => actor.agent_id === 'agent-failed')?.terminal).toBe('pending');
  });

  it('幂等 claim 写失败时不先把失败成员改成 pending', async () => {
    const run = await createSettledRun();
    controls.failPendingClaimWrite = true;
    const groupChat = await import('../../../../src/main/features/group_chat');

    await expect(groupChat.retryRun({
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-claim-failure',
    })).resolves.toEqual({ ok: false, error: 'simulated run retry claim write failure' });

    const store = await import('../../../../src/main/features/group_chat/run_store');
    const back = await store.readRun(UID, CID, run.run_id);
    expect(back?.status).toBe('failed');
    expect(back?.actors.find((actor) => actor.agent_id === 'agent-failed')).toMatchObject({
      terminal: 'failed', reason: 'runtime_failed',
    });
    expect(controls.enqueue).not.toHaveBeenCalled();
  });

  it('消息已落盘但 completed claim 写失败时，同一 request id 恢复原消息而不重复排队', async () => {
    const run = await createSettledRun();
    const layout = await import('../../../../src/main/util/project-layout');
    controls.enqueue.mockImplementationOnce(async (input: any) => {
      const msg = {
        id: input.messageId,
        ts: '2026-09-21T00:00:00.000Z',
        from: input.fromActorId,
        to: input.forceTo || [],
        text: input.text,
        action_request_id: input.actionRequestId,
        run_id: input.runId,
      };
      const file = layout.conversationMessageFile(UID, CID);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(msg)}\n`, 'utf8');
      return msg;
    });
    controls.failCompletedClaimWrite = true;
    const groupChat = await import('../../../../src/main/features/group_chat');
    const input = {
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-after-message',
    };

    await expect(groupChat.retryRun(input)).resolves.toEqual({
      ok: false,
      error: 'simulated run retry completion write failure',
    });
    await expect(groupChat.retryRun(input)).resolves.toMatchObject({
      ok: true,
      retry_agent_ids: ['agent-failed'],
      msg: { id: expect.stringMatching(/^msg-run-retry-/) },
    });
    expect(controls.enqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueue 在消息落盘后失败时，用耐久 turn id 恢复原执行而不创建第二条消息', async () => {
    const run = await createSettledRun();
    const layout = await import('../../../../src/main/util/project-layout');
    controls.enqueue.mockImplementationOnce(async (input: any) => {
      const msg = {
        id: input.messageId,
        ts: '2026-09-21T00:00:00.000Z',
        from: input.fromActorId,
        to: input.forceTo || [],
        text: input.text,
        action_request_id: input.actionRequestId,
        run_id: input.runId,
      };
      const file = layout.conversationMessageFile(UID, CID);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(msg)}\n`, 'utf8');
      throw new Error('simulated failure before queue insertion');
    });
    const groupChat = await import('../../../../src/main/features/group_chat');
    const input = {
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-before-queue',
    };

    await expect(groupChat.retryRun(input)).resolves.toEqual({
      ok: false,
      error: 'simulated failure before queue insertion',
    });
    await expect(groupChat.retryRun(input)).resolves.toMatchObject({
      ok: true,
      retry_agent_ids: ['agent-failed'],
      msg: { id: expect.stringMatching(/^msg-run-retry-/) },
    });
    expect(controls.enqueue).toHaveBeenCalledTimes(1);
    expect(controls.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      dispatchTurnIds: {
        'agent-failed': expect.stringMatching(/^turn-run-retry-/),
      },
    }));
    expect(controls.recover).toHaveBeenCalledTimes(1);
    expect(controls.recover).toHaveBeenCalledWith(expect.objectContaining({
      uid: UID,
      cid: CID,
      messageId: expect.stringMatching(/^msg-run-retry-/),
      actionRequestId: input.requestId,
      recipientId: 'agent-failed',
      turnId: expect.stringMatching(/^turn-run-retry-/),
    }));
  });

  it('只从 run input_snapshot 恢复原文、附件、引用、来源分类与执行配置', async () => {
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const reference = {
      source_cid: 'cid-source',
      source_title: 'Source task',
      source_msg_id: 'msg-source',
      from_actor: 'agent-source',
      source_ts: '2026-09-20T00:00:00.000Z',
      text: 'frozen referenced result',
      attachments: [{ name: 'evidence.pdf', kind: 'pdf' }],
      produced: ['result.md'],
    };
    const run = await store.createRun({
      uid: UID,
      cid: CID,
      submittedText: '@Failed Agent inspect the frozen input',
      memberAgentIds: ['agent-failed'],
      mentionAgentIds: ['agent-failed'],
      externalAgentIds: ['agent-failed'],
      sourceConfigs: { 'agent-failed': { model: 'gpt-5.6-sol', effort: 'high' } },
      attachmentIds: ['brief.txt'],
      attachmentDescriptors: [{ id: 'brief.txt', name: 'brief.txt', kind: 'text', bytes: 42 }],
      references: [reference],
    });
    await store.recordRunActorTerminal(UID, CID, run!.run_id, 'agent-failed', {
      terminal: 'failed', reason: 'runtime_failed', messages: 0, artifacts: [],
    });
    await store.finalizeRun(UID, CID, run!.run_id);

    const groupChat = await import('../../../../src/main/features/group_chat');
    await expect(groupChat.retryRun({
      userId: UID,
      cid: CID,
      runId: run!.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-frozen-input',
    })).resolves.toMatchObject({ ok: true, retry_agent_ids: ['agent-failed'] });

    expect(controls.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      attachments: ['brief.txt'],
      references: [reference],
      memberConfigs: { 'agent-failed': { model: 'gpt-5.6-sol', effort: 'high' } },
      memberConfigScope: { external_ids: ['agent-failed'] },
      member_snapshot: expect.objectContaining({
        external_agent_ids: ['agent-failed'],
        execution_configs: { 'agent-failed': { model: 'gpt-5.6-sol', effort: 'high' } },
      }),
      model_text: expect.stringContaining('@Failed Agent inspect the frozen input'),
    }));
  });

  it('忽略其他 run 的拒绝 gate，只让当前 run 的 gate 阻断并持久化 actor 拒绝终态', async () => {
    const store = await import('../../../../src/main/features/group_chat/run_store');
    const unrelatedRun = await createSettledRun();
    controls.collaboration = {
      steps: [{
        id: 'step-other-run',
        actor_id: 'agent-failed',
        group_chat_run_id: 'run-other',
      }],
      gates: [{ step_id: 'step-other-run', review_decision: 'rejected' }],
    };
    const groupChat = await import('../../../../src/main/features/group_chat');
    await expect(groupChat.retryRun({
      userId: UID,
      cid: CID,
      runId: unrelatedRun.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-unrelated-rejected-gate',
    })).resolves.toMatchObject({ ok: true, retry_agent_ids: ['agent-failed'] });

    controls.enqueue.mockClear();
    const matchingRun = await createSettledRun();
    controls.collaboration = {
      steps: [{
        id: 'step-current-run',
        actor_id: 'agent-failed',
        group_chat_run_id: matchingRun.run_id,
      }],
      gates: [{ step_id: 'step-current-run', review_decision: 'rejected' }],
    };
    await expect(groupChat.retryRun({
      userId: UID,
      cid: CID,
      runId: matchingRun.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-matching-rejected-gate',
    })).resolves.toEqual({ ok: false, error: 'retry blocked by rejected approval' });
    expect(controls.enqueue).not.toHaveBeenCalled();

    const matchingBack = await store.readRun(UID, CID, matchingRun.run_id);
    expect(matchingBack?.actors.find((actor) => actor.agent_id === 'agent-failed')).toMatchObject({
      terminal: 'blocked',
      reason: 'approval_rejected',
    });
  });

  it('拒绝过的 Wake 或 collaboration gate 都不能由重试绕过', async () => {
    const run = await createSettledRun();
    const groupChat = await import('../../../../src/main/features/group_chat');
    controls.wakes = [{
      status: 'rejected',
      agent_id: 'agent-failed',
      dispatch_payload: { run_id: run.run_id },
    }];
    await expect(groupChat.retryRun({
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-rejected-wake',
    })).resolves.toEqual({ ok: false, error: 'retry blocked by rejected approval' });

    controls.wakes = [];
    controls.collaboration = {
      steps: [{
        id: 'step-run-rejected',
        actor_id: 'agent-failed',
        group_chat_run_id: run.run_id,
      }],
      gates: [{ step_id: 'step-run-rejected', review_decision: 'rejected' }],
    };
    await expect(groupChat.retryRun({
      userId: UID,
      cid: CID,
      runId: run.run_id,
      agentIds: ['agent-failed'],
      requestId: 'retry-run-rejected-gate',
    })).resolves.toEqual({ ok: false, error: 'retry blocked by rejected approval' });
    expect(controls.enqueue).not.toHaveBeenCalled();
  });
});
