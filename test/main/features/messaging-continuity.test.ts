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
import type { MessagingAdapter, MessagingCardAdapter } from '../../../src/main/features/messaging/types';

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

  it('sanitizeFailureText strips absolute paths but keeps file names', async () => {
    const { sanitizeFailureText } = await import('../../../src/main/features/messaging/runtime');
    expect(sanitizeFailureText('ENOENT: /Users/someone/work/cogseed/dist/gateway.cjs missing')).toBe(
      'ENOENT: gateway.cjs missing',
    );
    expect(sanitizeFailureText('plain provider timeout')).toBe('plain provider timeout');
  });

  it('sanitizeFailureText handles paths with spaces in directory names (PR209 M1)', async () => {
    const { sanitizeFailureText } = await import('../../../src/main/features/messaging/runtime');
    // 含空格用户名目录：旧排除式正则会外泄 "alice smith" 前缀。
    expect(sanitizeFailureText('/Users/alice smith/Desktop/code/main.ts')).toBe('main.ts');
    expect(sanitizeFailureText('C:\\Users\\bob smith\\code\\main.ts')).toBe('main.ts');
    expect(sanitizeFailureText('失败: 无法写入 /Users/li ming/文档/报告.docx')).toBe(
      '失败: 无法写入 报告.docx',
    );
    // 多路径同串独立剥离，普通词间斜杠不误伤
    expect(sanitizeFailureText('先看 /a/b.txt 再看 /c/d.txt 两处')).toBe(
      '先看 b.txt 再看 d.txt 两处',
    );
  });

  it('sanitizeFailureText masks paths ending in a spaced home segment (M1 复核收窄)', async () => {
    const { sanitizeFailureText } = await import('../../../src/main/features/messaging/runtime');
    // 路径以含空格段结尾：basename 本身=用户名，剥了也泄 → 引号段整段占位。
    expect(sanitizeFailureText("scandir '/Users/alice smith'")).toBe('scandir [路径]');
    expect(sanitizeFailureText('no such file: "C:\\Users\\bob smith"')).toBe('no such file: [路径]');
    // 无引号的家目录一级：紧邻词并入后占位（只并入一次，后续词不连拼）。
    expect(sanitizeFailureText('open /Users/alice smith failed')).toBe('open [路径] failed');
    expect(sanitizeFailureText('stat /home/测试用户甲 结束')).toBe('stat [路径] 结束');
    // 引号内多段含空格路径：basename 无空白仍正常剥成文件名。
    expect(sanitizeFailureText("read '/Users/alice smith/Docs/a.txt'")).toBe('read a.txt');
    // 家目录下多段路径不受规则 b 影响（走常规 basename）。
    expect(sanitizeFailureText('failed: /Users/someone/work/gateway.cjs missing')).toBe(
      'failed: gateway.cjs missing',
    );
  });

  it('sanitizeFailureText also strips non-ASCII and Windows path segments', async () => {
    const { sanitizeFailureText } = await import('../../../src/main/features/messaging/runtime');
    // 中文用户名目录：枚举 ASCII 的旧正则会漏掉 /Users/测试用户甲/ 前缀。
    expect(sanitizeFailureText('failed: /Users/测试用户甲/project/report.md unreadable')).toBe(
      'failed: report.md unreadable',
    );
    // Windows 反斜杠绝对路径。
    expect(sanitizeFailureText('spawn C:\\Users\\admin\\AppData\\cli.exe failed')).toBe(
      'spawn cli.exe failed',
    );
  });

  it('formatAgentList truncates long rosters and appends usage', async () => {
    const { formatAgentList, AGENT_LIST_MAX } = await import('../../../src/main/features/messaging/continuity_commands');
    const many = Array.from({ length: AGENT_LIST_MAX + 8 }, (_v, i) => `Agent${i + 1}`);
    const rendered = formatAgentList(['指挥官', ...many]);
    expect(rendered).toContain('指挥官');
    // 截断上限含首位的指挥官：显示到 Agent14，其余折叠。
    expect(rendered).toContain('Agent14');
    expect(rendered).not.toContain('Agent15');
    expect(rendered).toContain('9');
    expect(rendered).toContain('/agent');
    const short = formatAgentList(['指挥官', 'Codex']);
    expect(short).toContain('Codex');
    expect(short).not.toContain('等');
  });
});

describe('messaging continuity lifecycle (manager harness)', () => {
  let busListener: ((event: unknown) => void) | undefined;
  let sendMessage: ReturnType<typeof vi.fn>;

  async function boot(opts?: { extraAgents?: Array<{ agent_id: string; name: string; enabled?: boolean }> }) {
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
    const groupSend = vi.fn(async () => ({ ok: true }));
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
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
        ...(opts?.extraAgents || []),
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
    return { manager, instanceId: created.id, groupSend };
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
    const switched = await manager.ingestInbound('user-1', envelope(instanceId, '/agent cod', 'm-1a'));
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

  it('/agent reports ambiguity when a prefix matches several agents', async () => {
    const { manager, instanceId } = await boot();
    await manager.ingestInbound('user-1', envelope(instanceId, '/agent c', 'm-1b'));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text).toContain('Codex');
    expect(text).toContain('Claude Code');
  });

  it('refuses to switch to a disabled agent', async () => {
    const { manager, instanceId } = await boot({
      extraAgents: [{ agent_id: 'agent-retired', name: 'Retired', enabled: false }],
    });
    const outcome = await manager.ingestInbound('user-1', envelope(instanceId, '/agent Retired', 'm-1c'));
    expect(outcome.accepted).toBe(true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text).toContain('Retired');
    expect(text).toContain('/agent');
    const state = await import('../../../src/main/features/group_chat/state');
    const bindings = await import('../../../src/main/features/messaging/bindings');
    const all = await bindings.listBindings('user-1');
    const convState = await state.readState('user-1', all[0].cid);
    expect(convState.active_recipient).toBeUndefined();
  });

  it('switches back to the commander via the Chinese alias and by raw agent id', async () => {
    const { manager, instanceId } = await boot();
    const state = await import('../../../src/main/features/group_chat/state');
    const bindings = await import('../../../src/main/features/messaging/bindings');
    // 先用 agent_id 精确切换
    await manager.ingestInbound('user-1', envelope(instanceId, '/agent agent-codex', 'm-1d'));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const all = await bindings.listBindings('user-1');
    expect((await state.readState('user-1', all[0].cid)).active_recipient).toBe('agent-codex');
    // 再用中文别名切回指挥官：楼层清空（回默认 commander 路由）
    await manager.ingestInbound('user-1', envelope(instanceId, '/agent 指挥官', 'm-1e'));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect((await state.readState('user-1', all[0].cid)).active_recipient).toBeUndefined();
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

  it('a second /unbind and other slash commands are rejected the same way after unbind', async () => {
    const { manager, instanceId } = await boot();
    await manager.ingestInbound('user-1', envelope(instanceId, 'hello', 'm-15'));
    await manager.ingestInbound('user-1', envelope(instanceId, '/unbind', 'm-16'));
    sendMessage.mockClear();
    // 撤权状态下 /unbind 自身、/status、/agent 一律按未绑定会话拒绝并引导。
    for (const [text, id] of [
      ['/unbind', 'm-17'],
      ['/status', 'm-18'],
      ['/agent Codex', 'm-19'],
    ] as const) {
      const outcome = await manager.ingestInbound('user-1', envelope(instanceId, text, id));
      expect(outcome).toMatchObject({ accepted: false, reason: 'binding_unbound' });
    }
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
    for (const call of sendMessage.mock.calls) {
      expect(call[1] as string).toContain('/new');
    }
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
    // 意外失败：带 error 的 turn_silent → 渠道收到失败回执；
    // 未注册的 actor 落"智能体"兜底名，错误串中的绝对路径被剥掉。
    busListener?.({
      type: 'turn_silent',
      actor: 'agent-unknown-xyz',
      turn_id: 'turn-40',
      source_msg_id: 'm-40',
      error: 'spawn failed: /Users/dev/project/dist/worker.js ENOENT',
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text).toContain('智能体');
    expect(text).not.toContain('/Users');
    expect(text).toContain('worker.js');
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

  it('redelivering the same inbound message executes exactly once (idempotency regression)', async () => {
    const { manager, instanceId, groupSend } = await boot();
    const redelivered = envelope(instanceId, '帮我整理周报', 'm-idem-1');
    const first = await manager.ingestInbound('user-1', redelivered);
    expect(first.accepted).toBe(true);
    // 平台重发同一条消息（同 externalMessageId）：入站台账判重，直接拒绝，
    // 绝不第二次进入群聊派发。
    const second = await manager.ingestInbound('user-1', redelivered);
    expect(second).toMatchObject({ accepted: false, duplicate: true });
    expect(groupSend).toHaveBeenCalledTimes(1);
    expect(groupSend).toHaveBeenCalledWith(expect.objectContaining({ text: '帮我整理周报' }));
    // 台账终态：一次 accepted；重投不产生第二条派发记录。
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const entry = await ledger.readInbound('user-1', ledger.inboundKey(instanceId, 'm-idem-1'));
    expect(entry?.status).toBe('accepted');
    expect(entry?.cid).toBe(first.cid);
  });

  it('badges the finalized Feishu streaming card with the executor (F1 card path)', async () => {
    let cardListener: ((event: unknown) => void) | undefined;
    const sendCard = vi.fn(async () => ({ deliveryId: 'om_card_1' }));
    const updateCard = vi.fn(async () => ({}));
    const adapter: MessagingCardAdapter = {
      platform: 'feishu_lark',
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
      sendMessage: vi.fn(async () => ({})),
      sendCard,
      updateCard,
    };
    cardListener = undefined;
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: vi.fn(async () => ({ ok: true })) }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({
      subscribe: vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
        cardListener = listener;
        return () => { cardListener = undefined; };
      }),
    }));
    vi.doMock('../../../src/main/features/agents', () => ({
      listAgents: vi.fn(async () => [
        { agent_id: 'agent-codex', name: 'Codex', enabled: true },
      ]),
    }));
    const registry = await import('../../../src/main/features/messaging/registry');
    const manager = await import('../../../src/main/features/messaging/manager');
    const { installContinuityCommands } = await import('../../../src/main/features/messaging/continuity_commands');
    installContinuityCommands();
    const created = await registry.createInstance('user-1', {
      platform: 'feishu_lark',
      displayName: 'Feishu bot',
      responseMode: 'streaming_card',
      policy: { allowUserIds: ['user-1'] },
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'app-secret' },
    });
    await manager.setEnabled('user-1', created.id, true);
    await vi.waitFor(async () => {
      const instances = await manager.listInstances('user-1');
      expect(instances[0]?.status.kind).toBe('connected');
    });

    // 建绑定 + 触发一轮流式 delta（卡片创建）→ 回合结束（卡片 finalize）。
    const first = await manager.ingestInbound('user-1', {
      platform: 'feishu_lark' as const,
      instanceId: created.id,
      externalMessageId: 'm-card-1',
      externalChatId: 'chat-9',
      externalUserId: 'user-1',
      text: '帮我做幻灯片',
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
    });
    expect(first.accepted).toBe(true);
    expect(cardListener).toBeTypeOf('function');
    cardListener?.({ type: 'process', actor: 'agent-codex', turn_id: 'turn-card-1', data: { type: 'delta', text: '正在生成…' } });
    await vi.waitFor(() => expect(sendCard).toHaveBeenCalledTimes(1));
    cardListener?.({
      type: 'message',
      turn_end: true,
      turn_id: 'turn-card-1',
      msg: { id: 'reply-card-1', from: 'agent-codex', text: '幻灯片已完成' },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const card = updateCard.mock.calls[0][1] as {
      header?: { title?: { content?: string } };
      elements?: Array<{ tag?: string; content?: string }>;
    };
    expect(card.header?.title?.content).toContain('Feishu bot · Codex');
    const body = (card.elements || []).map((el) => el.content || '').join('\n');
    expect(body).toContain('【Codex】');
  });
});
