import * as fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import * as paths from '../../../../src/main/paths';

// 真机复现背景（会话 9cd205d30bb0 / run_de70d690d421d9b6699cb2f5）：
// hand_off_to 的唤醒绑定的 actor 已经 failed（终态），dispatcher 预检必然拒绝，
// 但请求一直挂在 pending —— 用户反复点批准、每次都失败，而它还挡住宿主侧收口
// （收口门要求本 run 没有 pending/approved 的 Wake）。这里钉住：对账时必须由
// 系统自己把它判死（expired + 写明原因），且不能误杀仍可派发的唤醒。
const UID = 'wake-expiry-user';
afterEach(() => fs.rmSync(paths.userRoot(UID), { recursive: true, force: true }));

async function seedRunWithWake(input: {
  cid: string;
  agentId: string;
  runId: string;
  terminal?: 'failed' | 'done' | 'pending';
  stopRun?: boolean;
}): Promise<{ requestId: string; runId: string }> {
  const runStore = await import('../../../../src/main/features/group_chat/run_store');
  const wake = await import('../../../../src/main/features/p3394/wake-service');
  const run = await runStore.createRun({
    uid: UID,
    cid: input.cid,
    submittedText: `wake expiry ${input.agentId}`,
    memberAgentIds: [input.agentId],
    mentionAgentIds: [input.agentId],
  });
  if (input.terminal && input.terminal !== 'pending') {
    await runStore.recordRunDispatch(UID, input.cid, run!.run_id, input.agentId, `turn-${input.agentId}`);
    await runStore.recordRunActorTerminal(UID, input.cid, run!.run_id, input.agentId, {
      terminal: input.terminal,
      reason: input.terminal === 'failed' ? 'runtime_failed' : undefined,
      messages: input.terminal === 'done' ? 1 : 0,
      artifacts: [],
    });
  }
  if (input.stopRun) await runStore.stopRun(UID, input.cid, run!.run_id);
  const created = await wake.evaluateWake(UID, {
    conversationId: input.cid,
    agentId: input.agentId,
    source: 'hand_off_to',
    sourceActorId: 'commander',
    objective: 'handoff must not hang forever',
    dispatchPayload: { text: 'handoff must not hang forever', run_id: run!.run_id },
  });
  if (created.approved) throw new Error('unexpected auto-approval');
  expect(created.request.status).toBe('pending');
  return { requestId: created.request.id, runId: run!.run_id };
}

it('expires a pending wake whose bound actor already reached a terminal state', async () => {
  const chats = await import('../../../../src/main/features/chats');
  const runStore = await import('../../../../src/main/features/group_chat/run_store');
  const wake = await import('../../../../src/main/features/p3394/wake-service');
  const cid = (await chats.createConversation(UID, { title: 'wake expiry actor terminal' })).conversation_id;
  const { requestId, runId } = await seedRunWithWake({ cid, agentId: 'agent-failed', runId: 'run-1', terminal: 'failed' });

  const listed = await wake.listWakeRequests(UID, cid);
  const found = listed.find((request) => request.id === requestId);
  expect(found?.status).toBe('expired');
  expect(found?.decision_reason).toBe('actor_terminal:failed');

  // 判死之后宿主侧必须收口：不能只把 Wake 处理掉、run 还挂在 running。
  const settled = await runStore.readRun(UID, cid, runId);
  expect(settled?.status).not.toBe('running');
  expect(settled?.summary_publication?.status).toBe('published');
  expect(settled?.actors.find((actor) => actor.agent_id === 'agent-failed'))
    .toMatchObject({ terminal: 'blocked', reason: 'approval_expired' });
});

it('expires a pending wake whose bound run is already terminal', async () => {
  const chats = await import('../../../../src/main/features/chats');
  const wake = await import('../../../../src/main/features/p3394/wake-service');
  const cid = (await chats.createConversation(UID, { title: 'wake expiry run terminal' })).conversation_id;
  const { requestId } = await seedRunWithWake({ cid, agentId: 'agent-stopped', runId: 'run-2', stopRun: true });

  const listed = await wake.listWakeRequests(UID, cid);
  const found = listed.find((request) => request.id === requestId);
  expect(found?.status).toBe('expired');
  expect(found?.decision_reason).toBe('run_terminal:stopped');
});

it('keeps a wake whose actor is still pending dispatchable', async () => {
  const chats = await import('../../../../src/main/features/chats');
  const wake = await import('../../../../src/main/features/p3394/wake-service');
  const cid = (await chats.createConversation(UID, { title: 'wake expiry control' })).conversation_id;
  const { requestId } = await seedRunWithWake({ cid, agentId: 'agent-ready', runId: 'run-3' });

  const listed = await wake.listWakeRequests(UID, cid);
  expect(listed.find((request) => request.id === requestId)?.status).toBe('pending');
});
