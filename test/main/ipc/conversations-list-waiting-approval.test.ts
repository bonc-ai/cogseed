/**
 * 侧栏列表契约：`conversations.list` 必须把「等用户批准」随每一行下发。
 *
 * 为什么必须在列表里（而不是只靠 /runtime）：**闲置会话不会被轮询**——本机实测
 * 有两条 run/actor/wake 互等挂了三天、一个任务都不在执行的会话，只靠 runtime
 * 同步永远标不出它们，用户看不到"有个几天前没答的批准"。
 *
 * 数据源是 wake-store 的只读索引（文件戳失效，写入立即生效），所以这里也顺带
 * 锁住"批准/拒绝后标记立刻消失"。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

// ipc/index.ts 的 handler 表是模块私有的，按仓库既有做法用 electron mock 抓
// `cogseed.invoke` 的注册函数（见 conversation-copy-merge.test.ts）。
let invokeHandler: InvokeFn | null = null;
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'cogseed.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const TEST_UID = 'u-list-waiting-approval';
let previousVariant: string | undefined;
let variant = '';

async function writeWakeState(requests: Array<Record<string, unknown>>) {
  const { wakeStateFile } = await import('../../../src/main/features/p3394/wake-store');
  const file = wakeStateFile(TEST_UID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, updated_at: new Date().toISOString(), approvals: [], requests }));
  expect(fs.existsSync(file), 'wake state seeded at the production path').toBe(true);
}

function wakeRequest(cid: string, status: string, runId: string) {
  const now = new Date().toISOString();
  return {
    id: 'wake-' + cid,
    conversation_id: cid,
    agent_id: 'agent-external',
    source: 'commander',
    source_actor_id: 'commander',
    objective: 'dispatch needs a decision',
    context_scope: [],
    behavior_scope: [],
    dispatch_payload: { run_id: runId },
    status,
    created_at: now,
    updated_at: now,
  };
}

beforeEach(async () => {
  previousVariant = process.env.COGSEED_RUNTIME_VARIANT;
  variant = 'p3394-list-approval-' + Math.random().toString(36).slice(2, 8);
  process.env.COGSEED_RUNTIME_VARIANT = variant;
  invokeHandler = null;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

/** 走真实 IPC 通道（含参数校验与 ctx.userId 注入）。 */
function invoke(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

afterEach(() => {
  if (previousVariant === undefined) delete process.env.COGSEED_RUNTIME_VARIANT;
  else process.env.COGSEED_RUNTIME_VARIANT = previousVariant;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variant), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('conversations.list › waiting_approval annotation', () => {
  it('marks the rows whose conversation has a pending or approved wake, and clears after the decision', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const chats = await import('../../../src/main/features/chats');
    const waiting = await chats.createConversation(TEST_UID, { title: 'Waiting approval' });
    const other = await chats.createConversation(TEST_UID, { title: 'No approval' });

    await writeWakeState([wakeRequest(waiting.conversation_id, 'pending', 'run-pending-1')]);

    const list = await invoke('conversations.list') as unknown as { conversations: Array<Record<string, unknown>> };

    const rows = new Map(list.conversations.map((row) => [String(row.conversation_id), row]));
    expect(rows.get(waiting.conversation_id)?.waiting_approval).toBe(true);
    expect(rows.get(other.conversation_id)?.waiting_approval).toBe(false);

    // 单条 hydrate 也要带同一字段（否则渲染层按行打标会把刚打开的那行清掉）。
    const single = await invoke('conversations.get', { cid: waiting.conversation_id }) as unknown as { conversation: Record<string, unknown> };
    expect(single.conversation.waiting_approval).toBe(true);

    // approved = 用户已经决定过：不该再显示"等待你批准"（真机反馈：唤醒后停止仍挂着）。
    await writeWakeState([wakeRequest(waiting.conversation_id, 'approved', 'run-pending-1')]);
    const approved = await invoke('conversations.list') as unknown as { conversations: Array<Record<string, unknown>> };
    const approvedRows = new Map(approved.conversations.map((row) => [String(row.conversation_id), row]));
    expect(approvedRows.get(waiting.conversation_id)?.waiting_approval).toBe(false);

    // 用户拒绝后（同一个文件被改写 → 文件戳变化）标记必须立刻消失，不再等 TTL。
    await writeWakeState([wakeRequest(waiting.conversation_id, 'rejected', 'run-pending-1')]);
    const after = await invoke('conversations.list') as unknown as { conversations: Array<Record<string, unknown>> };
    const afterRows = new Map(after.conversations.map((row) => [String(row.conversation_id), row]));
    expect(afterRows.get(waiting.conversation_id)?.waiting_approval).toBe(false);
  }, 30_000);
});
