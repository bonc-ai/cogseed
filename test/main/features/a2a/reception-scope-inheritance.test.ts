/**
 * S1 / B1 / E08 — 可信接待 scope 的嵌套/worker 继承（宿主接线契约）。
 *
 * 断言对象是 **bus 交给每一层回合的 ChatOptions.receptionScope**：
 *   - 可信外部回合（commander / agent）本身带着冻结 scope；
 *   - 该回合派生的 nested dispatch（dispatch_to / hand_off_to / run_worker）
 *     必须继承同一个 scope（同 sourceActorId、同 CID、同 root），不得丢失、
 *     换源或扩大；
 *   - 同一 CID 的普通本地用户回合不带 scope（本地路径不受影响）。
 *
 * 这里 mock `model/client`（与 group_chat/bus.test.ts 同一手法），因为断言点是
 * 宿主的参数接线，而不是模型/provider 行为；真实 provider 请求的隔离由
 * `reception-context-isolation.test.ts` 覆盖。`receptionSourceActorId` 已在
 * QueueItem 上冻结，本用例同时钉住它到 `streamChatWithModel` 的传递链。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('../../../../src/main/logger', () => {
  const log = () => {};
  return {
    createLogger: () => ({ debug: log, info: log, warn: log, error: log }),
    initLogger: () => {},
    logFromRenderer: () => {},
    redact: (value: unknown) => value,
    sweepLogs: () => ({ removed: 0, remaining: 0, totalBytes: 0 }),
  };
});

// KStar 投影预检在全新会话里会拦截 commander dispatch；本用例只关心 scope
// 继承，不验证投影门禁。
vi.mock('../../../../src/main/features/recall/context-projection', () => ({
  previewContextProjection: vi.fn(async () => { throw new Error('no projection in inheritance tests'); }),
}));

const probe = vi.hoisted(() => ({
  calls: [] as Array<{
    sessionId: string;
    agentId?: string;
    message: string;
    receptionScope: any;
    permissionMode?: string;
  }>,
  marker: 'S1SCOPEINHERIT',
  toolName: 'dispatch_to',
  agentName: 'InheritAgent',
  /** 产出文件资源测试：仅当消息含该标记时调用 onFileWritten。 */
  outputMarker: '',
  producedFilePath: '',
}));

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    probe.calls.push({
      sessionId: String(opts?.sessionId || ''),
      ...(opts?.agentId ? { agentId: String(opts.agentId) } : {}),
      message: String(opts?.message || ''),
      receptionScope: opts?.receptionScope,
      ...(typeof opts?.permissionMode === 'string' ? { permissionMode: opts.permissionMode } : {}),
    });
    const message = String(opts?.message || '');
    // 产出文件控制：只在本用例的触发消息上模拟一次写文件回调。
    if (probe.outputMarker && probe.producedFilePath && message.includes(probe.outputMarker)) {
      await opts?.onFileWritten?.(probe.producedFilePath);
    }
    // 只在“本用例的触发消息”上派发一次；nested agent 回合没有 dispatch 工具，
    // 因此不会再进入这个分支。
    const tool = (Array.isArray(opts?.extraTools) ? opts.extraTools : [])
      .find((candidate: any) => candidate?.name === probe.toolName);
    if (message.includes(probe.marker) && tool) {
      await tool.execute(
        probe.toolName === 'run_worker'
          ? { to: probe.agentName, task: `nested task ${probe.marker}` }
          : { to: probe.agentName, message: `nested task ${probe.marker}` },
        { signal: new AbortController().signal },
      );
      yield { type: 'final', text: 'external commander synthesis' };
      yield { type: 'done' };
      return;
    }
    yield { type: 'final', text: opts?.agentId ? 'nested agent answer' : 'local answer' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
}));

const UID = 'u-s1inherit';
const AGENT_ID = 'f1e2d3c4b5a6';
const AGENT_NAME = 'InheritAgent';
const PEER_USER_ID = 'cs_s1inheritpeer';
const PEER_ACTOR_ID = 'a2a_cs_s1inheritpeer';

const ENV_KEYS = [
  'COGSEED_WORKSPACE_ROOT',
  'COGSEED_KSTAR_HOST_ROUTING',
  'COGSEED_P3394_WAKE_GATE',
  'COGSEED_LEGACY_RUN_WORKER_TEST',
] as const;
const previousEnv: Record<string, string | undefined> = {};
let tmpRoot = '';
let grantRoot = '';

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-s1-inherit-'));
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  process.env.COGSEED_WORKSPACE_ROOT = tmpRoot;
  process.env.COGSEED_KSTAR_HOST_ROUTING = '0';
  process.env.COGSEED_P3394_WAKE_GATE = '0';
  process.env.COGSEED_LEGACY_RUN_WORKER_TEST = '0';
  probe.calls.length = 0;
  probe.toolName = 'dispatch_to';
  probe.outputMarker = '';
  probe.producedFilePath = '';
  vi.resetModules();

  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);

  const paths = await import('../../../../src/main/paths');
  const agentDir = paths.agentDir(UID, AGENT_ID);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
    agent_id: AGENT_ID,
    name: AGENT_NAME,
    description: 'S1 scope inheritance synthetic agent',
    workflow: 'Answer synthetically.',
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
  }));

  const grantRaw = path.join(tmpRoot, 'reception-workspace');
  fs.mkdirSync(grantRaw, { recursive: true });
  grantRoot = fs.realpathSync(grantRaw);
});

afterEach(async () => {
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.dropConv(UID, 'c-s1inherit-dispatch_to');
    await bus.dropConv(UID, 'c-s1inherit-hand_off_to');
    await bus.dropConv(UID, 'c-s1inherit-run_worker');
    await bus.dropConv(UID, 'c-s1inherit-local-output');
    await bus.dropConv(UID, 'c-s1inherit-external-output');
  } catch {
    /* teardown is best effort */
  }
  await drainMainRuntimeForTest(UID);
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function createReceptionConversation(cid: string): Promise<void> {
  const chats = await import('../../../../src/main/features/chats');
  const groupState = await import('../../../../src/main/features/group_chat/state');
  await chats.createConversation(UID, { conversationId: cid, title: `S1 inherit ${cid}` });
  const withMarker = await chats.updateConversation(UID, cid, {
    a2a: {
      inbound: true,
      peer_user_id: PEER_USER_ID,
      peer_name: 'S1 Inherit Peer',
      state: 'active',
      workspace: grantRoot,
      assistant_agent_id: AGENT_ID,
      exchange_id: `a2a-${cid}`,
    },
  });
  expect(withMarker, 'fixture: the A2A inbound marker must persist').not.toBeNull();
  await groupState.addMember(UID, cid, { kind: 'agent', id: AGENT_ID, name: AGENT_NAME });
}

async function waitForQuiescent(cid: string, timeoutMs = 30_000): Promise<void> {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (bus.isQuiescent(UID, cid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`group chat bus did not quiesce within ${timeoutMs}ms`);
}

describe('a2a reception scope › nested inheritance', () => {
  it.each(['dispatch_to', 'hand_off_to', 'run_worker'] as const)(
    '%s inherits the frozen reception scope and the same-CID local turn does not',
    async (tool) => {
      probe.toolName = tool;
      const cid = `c-s1inherit-${tool}`;
      await createReceptionConversation(cid);

      const bus = await import('../../../../src/main/features/group_chat/bus');
      const externalMessage = await bus.enqueue({
        uid: UID,
        cid,
        fromActorId: PEER_ACTOR_ID,
        forceTo: ['commander'],
        externalInbound: true,
        text: `公开问题（${probe.marker}）：外部回合`,
      });
      expect(externalMessage.to, 'fixture: the external turn must dispatch to the commander')
        .toContain('commander');
      await waitForQuiescent(cid);

      const parentCall = probe.calls.find((call) => !call.agentId);
      const nestedCall = probe.calls.find((call) => call.agentId === AGENT_ID);
      expect(parentCall, `no parent model call observed for ${tool}`).toBeTruthy();
      expect(nestedCall, `no nested model call observed for ${tool} (calls=${probe.calls.map((call) => call.sessionId).join(',')})`)
        .toBeTruthy();

      for (const call of [parentCall!, nestedCall!]) {
        expect(call.receptionScope, `scope lost on a ${tool} path`).toMatchObject({
          sourceActorId: PEER_ACTOR_ID,
          conversationId: cid,
          root: grantRoot,
        });
        // 逐次审批仍是接待语义（scope 没有被放宽回本地模式）。
        expect(call.permissionMode).toBe('ask');
      }

      // 同 CID 的普通本地回合：不带 scope，本地路径保持原行为。
      probe.calls.length = 0;
      await bus.enqueue({
        uid: UID,
        cid,
        fromActorId: 'user',
        text: `本地消息（${probe.marker}-LOCAL）`,
      });
      await waitForQuiescent(cid);
      const localCall = probe.calls.find((call) => call.message.includes(`${probe.marker}-LOCAL`));
      expect(localCall, 'no local model call observed in the same CID').toBeTruthy();
      expect(localCall!.receptionScope, 'a local turn must never receive a reception scope').toBeUndefined();
    },
    120_000,
  );

  // 收口轮：外部接待回合不得把 produced-file 资源写进本地持久 Session
  // （`registerFinalOutputResources` 走 `getSession`）。用 mock 的 onFileWritten
  // 走同一条产出路径；本地 commander 正对照必须真的写出 sidecar，避免“全关掉”假绿。
  it('does not write produced-file resources into the local session for an external turn (local control does)', async () => {
    const localCid = 'c-s1inherit-local-output';
    const externalCid = 'c-s1inherit-external-output';
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(UID, { conversationId: localCid, title: 'S1 local output control' });
    await createReceptionConversation(externalCid);

    const sessionStore = await import('../../../../src/main/model/core-agent/session-store');
    const localSession = sessionStore.resolveSessionPath(UID, `gconv-${localCid}`);
    const externalSession = sessionStore.resolveSessionPath(UID, `gconv-${externalCid}`);
    // 快照口径：只比较 <uid>/cloud/sessions/gconv-<cid>.jsonl 与其 .context.json；
    // logger 在本文件被 mock 静音，日志文件不在比较范围。
    const snapshot = (file: string) => ({
      jsonl: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
      context: fs.existsSync(`${file}.context.json`) ? fs.readFileSync(`${file}.context.json`, 'utf8') : null,
    });
    const before = { local: snapshot(localSession), external: snapshot(externalSession) };
    expect(before.external.jsonl, 'fixture: no local session before the external turn').toBeNull();
    expect(before.external.context, 'fixture: no local context sidecar before the external turn').toBeNull();

    const bus = await import('../../../../src/main/features/group_chat/bus');

    // 本地正对照：普通本地 commander 回合的产出必须登记进本地 Session。
    const localFile = path.join(grantRoot, 'local-produced-s1.txt');
    fs.writeFileSync(localFile, 'local control output');
    probe.outputMarker = 'S1LOCALPRODUCED';
    probe.producedFilePath = localFile;
    await bus.enqueue({
      uid: UID,
      cid: localCid,
      fromActorId: 'user',
      forceTo: ['commander'],
      text: `本地产出控制 ${probe.outputMarker}`,
    });
    await waitForQuiescent(localCid);
    const afterLocal = snapshot(localSession);
    expect(
      afterLocal.context,
      'positive control: the local turn must register its produced file in the local session',
    ).not.toBeNull();
    expect(afterLocal.context).toContain('final_output');
    expect(afterLocal.context).toContain(path.basename(localFile));

    // 外部接待回合：同样产出文件，但不得创建/改写本地 Session。
    const externalFile = path.join(grantRoot, 'external-produced-s1.txt');
    fs.writeFileSync(externalFile, 'external output');
    probe.outputMarker = 'S1EXTERNALPRODUCED';
    probe.producedFilePath = externalFile;
    await bus.enqueue({
      uid: UID,
      cid: externalCid,
      fromActorId: PEER_ACTOR_ID,
      forceTo: ['commander'],
      externalInbound: true,
      text: `外部产出 ${probe.outputMarker}`,
    });
    await waitForQuiescent(externalCid);

    const afterExternal = snapshot(externalSession);
    expect(afterExternal.jsonl, 'the external turn created the local session jsonl').toBeNull();
    expect(afterExternal.context, 'the external turn wrote the local session context sidecar').toBeNull();

    // 证明外部回合确实产生并持久化了 produced（否则上面的“不存在”可能是假绿）。
    const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
    const { readJsonl } = await import('../../../../src/main/storage');
    const rows = await readJsonl<any>(conversationMessageFile(UID, externalCid), 50);
    const producedRows = rows.filter(
      (row) => Array.isArray(row.produced) && row.produced.includes(externalFile),
    );
    expect(producedRows.length, 'fixture: the external turn must persist its produced file')
      .toBeGreaterThan(0);
  }, 120_000);
});
