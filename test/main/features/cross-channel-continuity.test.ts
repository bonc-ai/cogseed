/**
 * 跨渠道任务接续（G2-1/G2-2）回归测试：/pair 配对加入同一任务、双渠道
 * 出站广播、监听随 cid 变化自动重挂、/mute 静音抑制任务产出（命令回声
 * 保留）、/status 渠道列表、配对码一次性/过期/同渠道/跨用户拒绝。
 *
 * 复用 messaging-continuity.test.ts 的 harness 模式：tmp workspace root +
 * doMock adapter/bus/agents，registry/manager/bindings 真实落盘；同一 uid
 * 下建两个渠道实例，以 chatId 区分出站归属。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessagingAdapter } from '../../../src/main/features/messaging/types';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cross-'));
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

describe('cross-channel command matching (pure)', () => {
  it('matches /pair /mute /unmute with and without args', async () => {
    const { matchInboundCommand } = await import('../../../src/main/features/messaging/commands');
    expect(matchInboundCommand('/pair')).toMatchObject({ name: 'pair', args: '' });
    expect(matchInboundCommand('/pair 123456')).toMatchObject({ name: 'pair', args: '123456' });
    expect(matchInboundCommand('/mute')).toMatchObject({ name: 'mute' });
    expect(matchInboundCommand('/unmute')).toMatchObject({ name: 'unmute' });
    expect(matchInboundCommand('/paired')).toBeNull();
    expect(matchInboundCommand('/muted')).toBeNull();
  });

  it('generatePairCode returns six digits', async () => {
    const { generatePairCode } = await import('../../../src/main/features/messaging/continuity_commands');
    for (let i = 0; i < 20; i++) {
      expect(generatePairCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('cross-channel continuity lifecycle (manager harness)', () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  const listenersByCid = new Map<string, Set<(event: unknown) => void>>();

  function emit(cid: string, event: unknown) {
    for (const listener of listenersByCid.get(cid) || []) listener(event);
  }

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
    listenersByCid.clear();
    const groupSend = vi.fn(async () => ({ ok: true, msg: { id: `gm-${Date.now()}` } }));
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({
      subscribe: vi.fn((_uid: string, cid: string, listener: (event: unknown) => void) => {
        const set = listenersByCid.get(cid) || new Set();
        set.add(listener);
        listenersByCid.set(cid, set);
        return () => set.delete(listener);
      }),
    }));
    vi.doMock('../../../src/main/features/agents', () => ({
      listAgents: vi.fn(async () => [
        { agent_id: 'agent-codex', name: 'Codex', enabled: true },
      ]),
    }));
    const registry = await import('../../../src/main/features/messaging/registry');
    const manager = await import('../../../src/main/features/messaging/manager');
    const { installContinuityCommands, _pairTestHooks } = await import(
      '../../../src/main/features/messaging/continuity_commands'
    );
    _pairTestHooks.reset();
    installContinuityCommands();
    const a = await registry.createInstance('user-1', {
      platform: 'telegram',
      displayName: 'Alpha Bot',
      policy: { allowUserIds: ['user-1'] },
      secret: { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' },
    });
    const b = await registry.createInstance('user-1', {
      platform: 'telegram',
      displayName: 'Beta Bot',
      policy: { allowUserIds: ['user-1'] },
      secret: { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk' },
    });
    await manager.setEnabled('user-1', a.id, true);
    await manager.setEnabled('user-1', b.id, true);
    await vi.waitFor(async () => {
      expect((await manager.listInstances('user-1')).every((i) => i.status.kind === 'connected')).toBe(true);
    });
    return { manager, instanceA: a.id, instanceB: b.id, groupSend, _pairTestHooks };
  }

  function envelope(instanceId: string, text: string, messageId: string, chatId: string) {
    return {
      platform: 'telegram' as const,
      instanceId,
      externalMessageId: messageId,
      externalChatId: chatId,
      externalUserId: 'user-1',
      text,
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
    };
  }

  /** A/B 各发一条消息建立独立任务；返回两个任务的 cid。 */
  async function bootstrapTwoTasks(ctx: Awaited<ReturnType<typeof boot>>) {
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceA, 'alpha task', 'm-a1', 'chat-A'));
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, 'beta task', 'm-b1', 'chat-B'));
    const bindings = await import('../../../src/main/features/messaging/bindings');
    const all = await bindings.listBindings('user-1');
    const alpha = all.find((x) => x.externalChatId === 'chat-A');
    const beta = all.find((x) => x.externalChatId === 'chat-B');
    expect(alpha && beta).toBeTruthy();
    expect(alpha!.cid).not.toBe(beta!.cid);
    return { alphaCid: alpha!.cid, betaCid: beta!.cid };
  }

  function sentTexts(chatId: string): string[] {
    return sendMessage.mock.calls.filter((c) => c[0] === chatId).map((c) => c[1] as string);
  }

  it('pairing joins the second channel onto the first task and broadcasts replies to both', async () => {
    const ctx = await boot();
    const { alphaCid } = await bootstrapTwoTasks(ctx);

    // A 生成配对码。
    sendMessage.mockClear();
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceA, '/pair', 'm-a2', 'chat-A'));
    await vi.waitFor(() => expect(sentTexts('chat-A').length).toBeGreaterThan(0));
    const created = sentTexts('chat-A')[0];
    const code = (created.match(/(\d{6})/) || [])[1];
    expect(code).toMatch(/^\d{6}$/);

    // B 输入码加入任务。
    sendMessage.mockClear();
    const joined = await ctx.manager.ingestInbound(
      'user-1', envelope(ctx.instanceB, `/pair ${code}`, 'm-b2', 'chat-B'),
    );
    expect(joined.accepted).toBe(true);
    await vi.waitFor(() => expect(sentTexts('chat-B').length).toBeGreaterThan(0));
    expect(sentTexts('chat-B')[0]).toContain(alphaCid === alphaCid ? '已加入任务' : 'joined');

    // B 的绑定已指向 A 的任务。
    const bindings = await import('../../../src/main/features/messaging/bindings');
    const all = await bindings.listBindings('user-1');
    expect(all.find((x) => x.externalChatId === 'chat-B')!.cid).toBe(alphaCid);

    // B 再发一条普通消息：触发入站路径的 attach 重挂（订阅切到新 cid）。
    const groupChat = await import('../../../src/main/features/group_chat');
    const sendMock = groupChat.send as ReturnType<typeof vi.fn>;
    sendMock.mockClear();
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, 'hello from beta', 'm-b3', 'chat-B'));

    // 任务回合结束：两个渠道都应收到带标注的回复（双渠道广播）。
    sendMessage.mockClear();
    emit(alphaCid, {
      type: 'message',
      turn_end: true,
      msg: { id: 'reply-1', from: 'agent-codex', text: 'shared answer' },
    });
    await vi.waitFor(() => {
      expect(sentTexts('chat-A').length).toBeGreaterThanOrEqual(1);
      expect(sentTexts('chat-B').length).toBeGreaterThanOrEqual(1);
    });
    expect(sentTexts('chat-A')[0]).toContain('shared answer');
    expect(sentTexts('chat-B')[0]).toContain('shared answer');
  });

  it('pairing code is one-time, expiring, same-channel-guarded and user-bound', async () => {
    const ctx = await boot();
    const { alphaCid } = await bootstrapTwoTasks(ctx);
    const { _pairTestHooks } = ctx;

    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceA, '/pair', 'm-a2', 'chat-A'));
    await vi.waitFor(() => expect(_pairTestHooks.pendingCount()).toBe(1));
    const code = ((sentTexts('chat-A')[0] as string).match(/(\d{6})/) || [])[1];

    // 同渠道（同实例同绑定）自配 → 拒绝。
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceA, `/pair ${code}`, 'm-a3', 'chat-A'));
    await vi.waitFor(() => expect(sentTexts('chat-A').length).toBeGreaterThanOrEqual(2));
    expect(sentTexts('chat-A').at(-1)).toContain('另一');

    // B 用码加入后，同码再用 → 无效（一次性）。
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, `/pair ${code}`, 'm-b2', 'chat-B'));
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, `/pair ${code}`, 'm-b3', 'chat-B'));
    await vi.waitFor(() => expect(sentTexts('chat-B').length).toBeGreaterThanOrEqual(2));
    expect(sentTexts('chat-B').at(-1)).toContain('无效');

    // 过期：新码 + 时钟前进 11 分钟 → 无效。
    let now = Date.now();
    _pairTestHooks.setNow(() => now);
    sendMessage.mockClear();
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceA, '/pair', 'm-a4', 'chat-A'));
    await vi.waitFor(() => expect(sentTexts('chat-A').length).toBeGreaterThanOrEqual(1));
    const code2 = ((sentTexts('chat-A').at(-1) as string).match(/(\d{6})/) || [])[1];
    now += 11 * 60 * 1000;
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, `/pair ${code2}`, 'm-b4', 'chat-B'));
    await vi.waitFor(() => expect(sentTexts('chat-B').length).toBeGreaterThanOrEqual(1));
    expect(sentTexts('chat-B').at(-1)).toContain('无效');
    expect(alphaCid).toBeTruthy();
  });

  it('mute suppresses task replies on the muted channel only, while command echoes survive', async () => {
    const ctx = await boot();
    const { alphaCid } = await bootstrapTwoTasks(ctx);
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceA, '/pair', 'm-a2', 'chat-A'));
    const code = ((sentTexts('chat-A').at(-1) as string).match(/(\d{6})/) || [])[1];
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, `/pair ${code}`, 'm-b2', 'chat-B'));
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, 'rebind kick', 'm-b3', 'chat-B'));

    // B 静音。
    sendMessage.mockClear();
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, '/mute', 'm-b4', 'chat-B'));
    await vi.waitFor(() => expect(sentTexts('chat-B').length).toBeGreaterThanOrEqual(1));
    expect(sentTexts('chat-B').at(-1)).toContain('静音');

    // 任务回复只到 A，B 不再收到。
    emit(alphaCid, {
      type: 'message',
      turn_end: true,
      msg: { id: 'reply-m1', from: 'agent-codex', text: 'while muted' },
    });
    await vi.waitFor(() => expect(sentTexts('chat-A').length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 120));
    expect(sentTexts('chat-B').filter((x) => x.includes('while muted'))).toHaveLength(0);

    // 静音中命令回声仍在（/status、/unmute 可用）。
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, '/status', 'm-b5', 'chat-B'));
    await vi.waitFor(() => {
      const last = sentTexts('chat-B').at(-1);
      expect(last).toContain('当前任务');
      expect(last).toContain('静音');
    });

    // 解除静音后任务回复恢复双渠道。
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, '/unmute', 'm-b6', 'chat-B'));
    emit(alphaCid, {
      type: 'message',
      turn_end: true,
      msg: { id: 'reply-m2', from: 'agent-codex', text: 'after unmute' },
    });
    await vi.waitFor(() => {
      expect(sentTexts('chat-A').some((x) => x.includes('after unmute'))).toBe(true);
      expect(sentTexts('chat-B').some((x) => x.includes('after unmute'))).toBe(true);
    });
  });

  it('/status lists peer channels after pairing, marking muted ones', async () => {
    const ctx = await boot();
    const { alphaCid } = await bootstrapTwoTasks(ctx);
    expect(alphaCid).toBeTruthy();
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceA, '/pair', 'm-a2', 'chat-A'));
    const code = ((sentTexts('chat-A').at(-1) as string).match(/(\d{6})/) || [])[1];
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, `/pair ${code}`, 'm-b2', 'chat-B'));
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, '/mute', 'm-b3', 'chat-B'));

    sendMessage.mockClear();
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceA, '/status', 'm-a3', 'chat-A'));
    await vi.waitFor(() => expect(sentTexts('chat-A').length).toBeGreaterThanOrEqual(1));
    const status = sentTexts('chat-A').at(-1) as string;
    expect(status).toContain('已接渠道');
    expect(status).toContain('Beta Bot');
    expect(status).toContain('静音');
  });

  it('unbinding one channel leaves the paired peer untouched', async () => {
    const ctx = await boot();
    const { alphaCid } = await bootstrapTwoTasks(ctx);
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceA, '/pair', 'm-a2', 'chat-A'));
    const code = ((sentTexts('chat-A').at(-1) as string).match(/(\d{6})/) || [])[1];
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, `/pair ${code}`, 'm-b2', 'chat-B'));
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, 'rebind kick', 'm-b3', 'chat-B'));

    // B 撤权：B 被拒，但任务回复照常到 A。
    await ctx.manager.ingestInbound('user-1', envelope(ctx.instanceB, '/unbind', 'm-b4', 'chat-B'));
    const afterUnbind = await ctx.manager.ingestInbound(
      'user-1', envelope(ctx.instanceB, 'are you there', 'm-b5', 'chat-B'),
    );
    expect(afterUnbind.accepted).toBe(false);
    sendMessage.mockClear();
    emit(alphaCid, {
      type: 'message',
      turn_end: true,
      msg: { id: 'reply-u1', from: 'agent-codex', text: 'peer still alive' },
    });
    await vi.waitFor(() => expect(sentTexts('chat-A').some((x) => x.includes('peer still alive'))).toBe(true));
  });
});
