/**
 * 渠道任务接续（G0）回归测试：/agent /status /unbind 命令、撤权后拒绝
 * 与 /new 恢复、回复执行者标注、回合失败回执。
 *
 * 复用 messaging.test.ts 的 harness 模式（tmp workspace root + doMock
 * adapter/bus），manager 全链路走真实 bindings/ledger/chats 落盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessagingAdapter } from '../../../src/main/features/messaging/types';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-continuity-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('messaging continuity commands (pure)', () => {
  it('matches /agent /status /unbind and ignores unknown slashes', async () => {
    const { matchInboundCommand } = await import('../../../src/main/features/messaging/commands');
    expect(matchInboundCommand('/agent')).toMatchObject({ name: 'agent', args: '' });
    expect(matchInboundCommand('  /agent  Codex  ')).toMatchObject({ name: 'agent', args: 'Codex' });
    expect(matchInboundCommand('/status')).toMatchObject({ name: 'status' });
    expect(matchInboundCommand('/unbind')).toMatchObject({ name: 'unbind' });
    expect(matchInboundCommand('/agentX')).toBeNull();
    expect(matchInboundCommand('/foo bar')).toBeNull();
    expect(matchInboundCommand('hello /agent')).toBeNull();
  });

  it('withActorBadge prefixes the label and leaves user text untouched', async () => {
    const { withActorBadge } = await import('../../../src/main/features/messaging/runtime');
    expect(withActorBadge('done', 'Codex')).toBe('【Codex】 done');
    expect(withActorBadge('done', null)).toBe('done');
  });
});

describe('messaging continuity lifecycle (manager harness)', () => {
  let busListener: ((event: unknown) => void) | undefined;
  let sendMessage: ReturnType<typeof vi.fn>;

  async function boot() {
    sendMessage = vi.fn().mockResolvedValue({ deliveryId: 'delivered' });
    const adapter: MessagingAdapter = {
      platform: 'telegram',
      async start(signal, callbacks) {
        await callbacks.onStatus({ kind: 'connected', checkedAt: new Date().toISOString() });
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      async stop() {},
      async checkHealth() {
        return { kind: 'connected', checkedAt: new Date().toISOString() };
      },
      sendMessage,
    };
    busListener = undefined;
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: vi.fn(async () => ({ ok: true })) }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({
      subscribe: vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
        busListener = listener;
        return () => { busListener = undefined; };
      }),
    }));
    vi.doMock('../../../src/main/features/agents', () => ({
      listAgents: vi.fn(async () => [
        { agent_id: 'agent-codex', name: 'Codex', enabled: true },
        { agent_id: 'agent-claude', name: 'Claude Code', enabled: true },
      ]),
    }));
    const registry = await import('../../../src/main/features/messaging/registry');
    const manager = await import('../../../src/main/features/messaging/manager');
    const { installContinuityCommands } = await import('../../../src/main/features/messaging/continuity_commands');
    installContinuityCommands();
    const created = await registry.createInstance('user-1', {
      platform: 'telegram',
      displayName: 'Continuity Bot',
      policy: { allowUserIds: ['user-1'] },
      secret: { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' },
    });
    await manager.setEnabled('user-1', created.id, true);
    await vi.waitFor(async () => {
      const instances = await manager.listInstances('user-1');
      expect(instances[0]?.status.kind).toBe('connected');
    });
    return { manager, instanceId: created.id };
  }

  function envelope(instanceId: string, text: string, messageId: string) {
    return {
      platform: 'telegram' as const,
      instanceId,
      externalMessageId: messageId,
      externalChatId: 'chat-1',
      externalUserId: 'user-1',
      text,
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
    };
  }

  it('/agent switches the executor floor and confirms in-channel', async () => {
    const { manager, instanceId } = await boot();
    const switched = await manager.ingestInbound('user-1', envelope(instanceId, '/agent Codex', 'm-1'));
    expect(switched.accepted).toBe(true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text).toContain('Codex');
    const state = await import('../../../src/main/features/group_chat/state');
    const bindings = await import('../../../src/main/features/messaging/bindings');
    const all = await bindings.listBindings('user-1');
    expect(all.length).toBeGreaterThan(0);
    const convState = await state.readState('user-1', all[0].cid);
    expect(convState.active_recipient).toBe('agent-codex');
  });

  it('/unbind rejects subsequent messages, guides to /new, and /new recovers', async () => {
    const { manager, instanceId } = await boot();
    // 建立绑定
    const first = await manager.ingestInbound('user-1', envelope(instanceId, 'hello', 'm-10'));
    expect(first.accepted).toBe(true);
    // 撤权
    const unbind = await manager.ingestInbound('user-1', envelope(instanceId, '/unbind', 'm-11'));
    expect(unbind.accepted).toBe(true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    sendMessage.mockClear();
    // 撤权后的普通消息：明确拒绝 + 引导文案
    const rejected = await manager.ingestInbound('user-1', envelope(instanceId, 'still here?', 'm-12'));
    expect(rejected).toMatchObject({ accepted: false, reason: 'binding_unbound' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0][1] as string).toContain('/new');
    sendMessage.mockClear();
    // /new 重开：旧标记随 binding 轮换丢弃，消息恢复接收
    const reopened = await manager.ingestInbound('user-1', envelope(instanceId, '/new', 'm-13'));
    expect(reopened.accepted).toBe(true);
    const after = await manager.ingestInbound('user-1', envelope(instanceId, 'hello again', 'm-14'));
    expect(after.accepted).toBe(true);
  });

  it('/status reports the current task and executor', async () => {
    const { manager, instanceId } = await boot();
    await manager.ingestInbound('user-1', envelope(instanceId, '/status', 'm-20'));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text).toContain('指挥官');
  });

  it('badges the turn-end reply with the executing agent name', async () => {
    const { manager, instanceId } = await boot();
    const inbound = await manager.ingestInbound('user-1', envelope(instanceId, 'do the thing', 'm-30'));
    expect(inbound.accepted).toBe(true);
    expect(busListener).toBeTypeOf('function');
    busListener?.({
      type: 'message',
      turn_end: true,
      msg: { id: 'reply-30', from: 'agent-codex', text: 'task done' },
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text.startsWith('【Codex】')).toBe(true);
    expect(text).toContain('task done');
  });

  it('delivers a failure receipt only for unexpected turn errors', async () => {
    const { manager, instanceId } = await boot();
    await manager.ingestInbound('user-1', envelope(instanceId, 'risky task', 'm-40'));
    expect(busListener).toBeTypeOf('function');
    // 意外失败：带 error 的 turn_silent → 渠道收到失败回执
    busListener?.({
      type: 'turn_silent',
      actor: 'agent-codex',
      turn_id: 'turn-40',
      source_msg_id: 'm-40',
      error: 'provider timeout',
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text).toContain('Codex');
    expect(text).toContain('provider timeout');
    sendMessage.mockClear();
    // 用户取消 / 正常 silent：不带 error → 渠道保持静默
    busListener?.({
      type: 'turn_silent',
      actor: 'agent-codex',
      turn_id: 'turn-41',
      source_msg_id: 'm-41',
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
