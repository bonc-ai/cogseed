import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Extract the CLI-fallback logic from conversation.js and run it in a sandbox
// with a mocked window.cogseed, so we can verify the real branching behaviour:
// when no API-key model is configured but a CLI account is signed in, the
// conversation is routed to that CLI agent — the user is never prompted for a
// key.
const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const start = conversationSource.indexOf('let _cliFallbackApplied');
const end = conversationSource.indexOf('\nasync function sendInConversation', start);
if (start < 0 || end < 0) throw new Error('could not locate CLI-fallback source range');
const fallbackSource = conversationSource.slice(start, end);

interface InvokeLog {
  channel: string;
  payload: unknown;
}

function buildSandbox(routes: Record<string, unknown | ((payload: unknown) => unknown)>, opts: { recipient?: unknown; newChatRecipient?: unknown; hasConfiguredModel?: boolean } = {}) {
  const invokeLog: InvokeLog[] = [];
  const toasts: Array<{ message: string; opts: unknown }> = [];
  const recipientByCid: Record<string, unknown> = {};
  const newChatRecipient = opts.newChatRecipient ?? { kind: 'commander' };
  // 非 silent 的 ensureModelConfigured 调用次数：无模型时若被非 silent 调用，
  // 意味着会弹窗 + 跳转设置页——@ 外部智能体的发送路径必须为 0。
  const nonSilentModelGuardCalls: string[] = [];
  const sandbox: any = {
    Array,
    Math,
    String,
    Boolean,
    Promise,
    Map,
    Set,
    console,
    _recipientByCid: recipientByCid,
    _newChatRecipient: newChatRecipient,
    _COMMANDER: { kind: 'commander', id: '', name: '' },
    _LEADING_MENTION_RE: /^@([A-Za-z0-9_一-鿿-]+)\s?/u,
    ensureModelConfigured: () => false,
    DRAFT_CID: 'main_chat',
    ensureModelConfigured: (o?: unknown) => {
      if (!(o && (o as any).silent === true)) nonSilentModelGuardCalls.push('non-silent');
      return opts.hasConfiguredModel !== false;
    },
    _activeRecipient: (target: string) => {
      if (target === 'new-chat') return newChatRecipient;
      return opts.recipient === undefined ? { kind: 'commander' } : opts.recipient;
    },
    _renderRecipientChip: () => {},
    uiToast: (message: string, opts: unknown) => { toasts.push({ message, opts }); },
    _convLog: { info: () => {}, warn: () => {}, error: () => {} },
    // conversation.js 中该正则定义在抽取段起点之前，这里按源码镜像补上。
    _LEADING_MENTION_RE: /^@([A-Za-z0-9_一-鿿-]+)\s?/u,
    // 慢切换检测在 vm 里不会真的发射定时器；注入一个记数桩，供
    // 验证「外部智能体 → arm，收到输出 → clear」的时序分支。
    setTimeout: (fn: unknown, ms: number) => {
      (sandbox as any)._slowTimers.push({ fn, ms });
      return { unref: () => {} };
    },
    clearTimeout: () => {},
    window: {
      cogseed: {
        invoke: async (channel: string, payload: unknown) => {
          invokeLog.push({ channel, payload });
          const route = routes[channel];
          if (typeof route === 'function') return route(payload);
          if (route === undefined) throw new Error(`no mock for channel ${channel}`);
          return route;
        },
      },
    },
  };
  (sandbox as any)._slowTimers = [];
  sandbox._agentsCache = null; // 慢切换候选（外部 CLI agent 目录）
  vm.runInNewContext(fallbackSource, sandbox, { filename: 'cli-fallback.js' });
  return { sandbox, invokeLog, toasts, recipientByCid, newChatRecipient, nonSilentModelGuardCalls };
}

describe('commander CLI fallback', () => {
  it('does not replace a manually typed Agent mention with automatic fallback', async () => {
    const { sandbox, invokeLog } = buildSandbox({});

    const allowed = await sandbox._ensureModelOrCliFallback('cid-manual', 'conversation', '@Codex hello');

    expect(allowed).toBe(true);
    expect(invokeLog).toEqual([]);
  });

  it('does NOT prompt for API key when a CLI account is signed in — routes to it instead', async () => {
    const { sandbox, toasts, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: '' }, // no explicit preference → auto-pick
      'localAgents.list': {
        entries: [
          { type: 'claude', available: true, auth: { loggedIn: true } },
        ],
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-claude-1', name: 'Claude', runtime: { kind: 'cli', cli: 'claude' } },
        ],
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-1');

    // Fallback was applied and the conversation now targets the CLI agent.
    expect(applied).toBe(true);
    expect(recipientByCid['cid-1']).toEqual({
      kind: 'agent',
      id: 'agent-claude-1',
      name: 'Claude',
      origin: 'cli_fallback',
    });
    // The user saw an informational toast, not an API-key prompt.
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('Claude Code');
    expect(toasts[0].message).toContain('自动交给');
    // Crucially: no "configure API key" guidance was shown.
    expect(toasts[0].message).not.toContain('配置 API Key');
  });

  it('creates a CLI agent on the fly when signed in but none exists yet', async () => {
    const created: unknown[] = [];
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: '' },
      'localAgents.list': {
        entries: [{ type: 'codex', available: true, auth: { loggedIn: true } }],
      },
      'agents.list': { agents: [] }, // no CLI agent exists yet
      'agents.create': (payload: unknown) => {
        created.push(payload);
        return { agent: { agent_id: 'agent-codex-new', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } } };
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-2');

    expect(applied).toBe(true);
    expect(created).toHaveLength(1);
    // 无模型直调走 P3394 外接网关类型（与「外接」tab 一致，不经 CogSeed 模型）。
    expect((created[0] as any).runtime).toEqual({ kind: 'p3394-gateway', cli: 'codex' });
    expect(recipientByCid['cid-2']).toMatchObject({ kind: 'agent', id: 'agent-codex-new' });
  });

  it('routes to WorkBuddy when it is the signed-in CLI and no preference is set', async () => {
    const created: unknown[] = [];
    const { sandbox, recipientByCid, toasts } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: '' },
      'localAgents.list': {
        entries: [{ type: 'workbuddy', available: true, auth: { loggedIn: true } }],
      },
      'agents.list': { agents: [] }, // no CLI agent yet → auto-create
      'agents.create': (payload: unknown) => {
        created.push(payload);
        return { agent: { agent_id: 'agent-wb-new', name: 'WorkBuddy', runtime: { kind: 'cli', cli: 'workbuddy' } } };
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-wb');

    expect(applied).toBe(true);
    expect(created).toHaveLength(1);
    // The on-the-fly agent is created with the WorkBuddy brand, not mislabeled OpenCode.
    expect((created[0] as any).name).toBe('WorkBuddy');
    expect((created[0] as any).runtime).toEqual({ kind: 'p3394-gateway', cli: 'workbuddy' });
    expect(recipientByCid['cid-wb']).toMatchObject({ kind: 'agent', id: 'agent-wb-new' });
    expect(toasts[0].message).toContain('WorkBuddy');
  });

  it('reuses an existing P3394-gateway external agent instead of creating one', async () => {
    const created: unknown[] = [];
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: '' },
      'localAgents.list': {
        entries: [{ type: 'openclaw', available: true, auth: { loggedIn: true } }],
      },
      'agents.list': {
        agents: [
          // 用户已通过「外接」tab 接入的 p3394-gateway 类型 agent → 直接复用。
          { agent_id: 'agent-openclaw-ext', name: 'OpenClaw', runtime: { kind: 'p3394-gateway', cli: 'openclaw' } },
        ],
      },
      'agents.create': (payload: unknown) => { created.push(payload); return { agent: null }; },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-ext');

    expect(applied).toBe(true);
    expect(created).toHaveLength(0);
    expect(recipientByCid['cid-ext']).toMatchObject({ kind: 'agent', id: 'agent-openclaw-ext' });
  });

  it('auto-picks openclaw when it is the only usable CLI (no model configured)', async () => {
    const created: unknown[] = [];
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: '' },
      'localAgents.list': {
        entries: [{ type: 'openclaw', available: true, auth: { loggedIn: true } }],
      },
      'agents.list': { agents: [] },
      'agents.create': (payload: unknown) => {
        created.push(payload);
        return { agent: { agent_id: 'agent-openclaw-new', name: 'OpenClaw', runtime: { kind: 'p3394-gateway', cli: 'openclaw' } } };
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-ocl');

    expect(applied).toBe(true);
    expect(created).toHaveLength(1);
    expect((created[0] as any).runtime).toEqual({ kind: 'p3394-gateway', cli: 'openclaw' });
    expect(recipientByCid['cid-ocl']).toMatchObject({ kind: 'agent', id: 'agent-openclaw-new' });
  });

  it('does NOT fall back (no model) when the recipient is already an external agent', async () => {
    // 无模型 + recipient 已手动选中 p3394-gateway 外接智能体 → 直接放行，
    // 不覆盖 recipient、不引导配置。这是「首次启动不配模型直调外接」的核心。
    const invokeLog: { channel: string }[] = [];
    const { sandbox, recipientByCid } = buildSandbox(
      {
        'model.hasConfigured': { configured: false },
      },
      {
        recipient: { kind: 'agent', id: 'agent-ext-1', name: 'Codex' },
      },
    );
    // 记录 invoke 以便断言没有走 prefs.getCliFallback / localAgents.list。
    const origInvoke = sandbox.window.orkas.invoke;
    sandbox.window.orkas.invoke = async (channel: string, payload: unknown) => {
      invokeLog.push({ channel });
      return origInvoke(channel, payload);
    };

    const ok = await sandbox._ensureModelOrCliFallback('cid-ext-1');

    expect(ok).toMatchObject({ ok: true });
    const fallbackChannels = invokeLog.filter((c) => (
      c.channel === 'prefs.getCliFallback'
      || c.channel === 'localAgents.list'
      || c.channel === 'agents.list'
      || c.channel === 'agents.create'
    ));
    expect(fallbackChannels).toHaveLength(0);
    expect(recipientByCid['cid-ext-1']).toBeUndefined();
  });

  it('lets a manual @external-agent mention through with no model configured', async () => {
    // 手动输入 `@Codex 消息`（recipient 仍是 commander）：leading mention
    // 命中本机 p3394-gateway 外部智能体 → 无模型也放行，不弹 API Key。
    const { sandbox } = buildSandbox({
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'p3394-gateway', cli: 'codex' } },
        ],
      },
    });

    expect(await sandbox._mentionTargetsExternalAgent('@Codex 帮我写个测试')).toBe(true);
    // 大小写/空白不敏感，匹配 agent_id 也行。
    expect(await sandbox._mentionTargetsExternalAgent('@agent-codex-1 hi')).toBe(true);
    // 未知 token / 无 mention → false。
    expect(await sandbox._mentionTargetsExternalAgent('@nobody hi')).toBe(false);
    expect(await sandbox._mentionTargetsExternalAgent('随便聊聊')).toBe(false);
  });

  it('does NOT let a manual @commander mention through with no model configured', async () => {
    const { sandbox } = buildSandbox({
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'p3394-gateway', cli: 'codex' } },
        ],
      },
    });
    expect(await sandbox._mentionTargetsExternalAgent('@commander 你好')).toBe(false);
    expect(await sandbox._mentionTargetsExternalAgent('@指挥官 你好')).toBe(false);
  });

  it('never triggers the non-silent model guard (no popup/navigation) when sending to an external agent without a model', async () => {
    // 回归：消息发出后「瞬间跳转 API 配置页」= 非 silent 的 ensureModelConfigured
    // 被调用。@ 外部智能体的发送必须只走 silent 探测，非 silent 调用次数为 0。
    const { sandbox, nonSilentModelGuardCalls } = buildSandbox(
      {
        'agents.list': {
          agents: [
            { agent_id: 'agent-claude-1', name: 'ClaudeCode', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
          ],
        },
      },
      { hasConfiguredModel: false },
    );

    // 直接测 send 门使用的判定路径（_ensureModelOrCliFallback 的 @mention 分支）。
    const ok = await sandbox._ensureModelOrCliFallback('cid-send', '@ClaudeCode 帮我写个测试');
    expect(ok).toMatchObject({ ok: true });
    expect(nonSilentModelGuardCalls).toHaveLength(0);

    // recipient 已是外部 agent 的路径同样零非 silent 调用。
    const { sandbox: sb2, nonSilentModelGuardCalls: calls2 } = buildSandbox(
      { 'agents.list': { agents: [] } },
      { hasConfiguredModel: false, recipient: { kind: 'agent', id: 'agent-claude-1', name: 'ClaudeCode' } },
    );
    const ok2 = await sb2._ensureModelOrCliFallback('cid-recipient', '帮我写个测试');
    expect(ok2).toMatchObject({ ok: true });
    expect(calls2).toHaveLength(0);
  });

  it('honours an explicit fallback preference over auto-pick', async () => {
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: 'workbuddy' },
      'localAgents.list': {
        entries: [
          { type: 'claude', available: true, auth: { loggedIn: true } },
          { type: 'workbuddy', available: true, auth: { loggedIn: true } },
        ],
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-wb-1', name: 'WorkBuddy', runtime: { kind: 'cli', cli: 'workbuddy' } },
        ],
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-pref');

    // Preference wins even though claude appears first in the detection list.
    expect(applied).toBe(true);
    expect(recipientByCid['cid-pref']).toMatchObject({ kind: 'agent', id: 'agent-wb-1' });
  });

  it('prefers a signed-in CLI over a preference that is not signed in', async () => {
    // 用户偏好 workbuddy，但 workbuddy 未登录（文件检测）；claude 已登录 →
    // 降级应选 claude，而不是派发未登录的 workbuddy（非 TTY 下会挂起后失败）。
    const { sandbox, recipientByCid, toasts } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: 'workbuddy' },
      'localAgents.list': {
        entries: [
          { type: 'claude', available: true, auth: { loggedIn: true } },
          { type: 'workbuddy', available: true, auth: { loggedIn: false } },
        ],
      },
      'localAgents.cliEndpointInfo': {
        endpoints: { claude: null, codex: null, opencode: null, workbuddy: null },
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-claude-1', name: 'Claude', runtime: { kind: 'cli', cli: 'claude' } },
        ],
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-pref-unlogged');

    expect(applied).toBe(true);
    expect(recipientByCid['cid-pref-unlogged']).toMatchObject({ kind: 'agent', id: 'agent-claude-1' });
    expect(toasts[0].message).toContain('Claude Code');
  });

  it('ignores a preference pointing at a missing CLI and auto-picks instead', async () => {
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: 'codex' },
      'localAgents.list': {
        entries: [
          { type: 'claude', available: true, auth: { loggedIn: true } },
          { type: 'codex', available: false, error: 'not_found' },
        ],
      },
      'localAgents.cliEndpointInfo': {
        endpoints: { claude: null, codex: null, opencode: null, workbuddy: null },
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-claude-1', name: 'Claude', runtime: { kind: 'cli', cli: 'claude' } },
        ],
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-pref-missing');

    expect(applied).toBe(true);
    expect(recipientByCid['cid-pref-missing']).toMatchObject({ kind: 'agent', id: 'agent-claude-1' });
  });

  it('force-falls back even when an API-key model IS configured (API failed at call time)', async () => {
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: true }, // config exists but failed at call time
      'prefs.getCliFallback': { cli: 'claude' },
      'agents.list': {
        agents: [
          { agent_id: 'agent-claude-1', name: 'Claude', runtime: { kind: 'cli', cli: 'claude' } },
        ],
      },
    });

    // Without force, the configured model blocks the fallback…
    expect(await sandbox._maybeApplyCliFallback('cid-noforce')).toBe(false);
    // …with force, the CLI agent takes over despite the stored API config.
    const applied = await sandbox._maybeApplyCliFallback('cid-force', { force: true });
    expect(applied).toBe(true);
    expect(recipientByCid['cid-force']).toMatchObject({ kind: 'agent', id: 'agent-claude-1' });
  });

  it('auto-falls back when a commander model turn fails with failureKind=model', async () => {
    const { sandbox, recipientByCid, toasts } = buildSandbox({
      'prefs.getCliFallback': { cli: 'codex' },
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
        ],
      },
    });

    await sandbox._maybeAutoCliFallbackOnModelFailure('cid-err', {
      failureKind: 'model',
      failureCode: 'provider_auth',
    });

    expect(recipientByCid['cid-err']).toMatchObject({ kind: 'agent', id: 'agent-codex-1' });
    expect(toasts.some((t) => t.message.includes('切换到本机 Agent'))).toBe(true);
  });

  it('does NOT auto-fallback when the failure is not model-related', async () => {
    const { sandbox, recipientByCid } = buildSandbox({});

    await sandbox._maybeAutoCliFallbackOnModelFailure('cid-err2', {
      failureKind: 'dependency',
      failureCode: 'skill_disabled',
    });

    expect(recipientByCid['cid-err2']).toBeUndefined();
  });

  it('does NOT auto-fallback when the recipient is already a non-commander agent', async () => {
    const { sandbox, recipientByCid } = buildSandbox({}, { recipient: { kind: 'agent', id: 'other-agent' } });

    await sandbox._maybeAutoCliFallbackOnModelFailure('cid-err3', {
      failureKind: 'model',
      failureCode: 'provider_timeout',
    });

    expect(recipientByCid['cid-err3']).toBeUndefined();
  });

  it('skips fallback entirely when an API-key model IS configured', async () => {
    const { sandbox, invokeLog, toasts } = buildSandbox({
      'model.hasConfigured': { configured: true },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-3');

    expect(applied).toBe(false);
    // It should short-circuit right after the model check — no CLI lookup.
    expect(invokeLog.map((e) => e.channel)).toEqual(['model.hasConfigured']);
    expect(toasts).toHaveLength(0);
  });

  it('re-applies the fallback when the recipient was switched back to the commander', async () => {
    // Scenario: fallback was applied earlier (_cliFallbackApplied === cid), but
    // the user later clicked the cogseed chip (recipient is commander again).
    // It must re-apply the CLI fallback instead of failing with "configure API".
    const { sandbox, recipientByCid, toasts } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: 'codex' },
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
        ],
      },
    }, { recipient: { kind: 'commander' } });
    // Simulate an earlier fallback for this cid.
    sandbox._cliFallbackApplied = 'cid-reapply';
    sandbox._recipientByCid['cid-reapply'] = { kind: 'agent', id: 'agent-codex-1', name: 'Codex' };

    const applied = await sandbox._maybeApplyCliFallback('cid-reapply');

    // Success: conversation is routed back to the CLI agent, no API prompt.
    expect(applied).toBe(true);
    expect(recipientByCid['cid-reapply']).toMatchObject({ kind: 'agent', id: 'agent-codex-1' });
    expect(toasts.some((t) => t.message.includes('自动交给'))).toBe(true);
    expect(toasts.some((t) => t.message.includes('配置 API Key'))).toBe(false);
  });

  it('guides the user only when there is neither an API key NOR any CLI backend', async () => {
    const { sandbox, toasts, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: '' },
      'localAgents.list': { entries: [] }, // nothing available
      'localAgents.detectDesktopApps': { apps: [] },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-4');
    // _cliFallbackGuideUser() is fire-and-forget (not awaited) inside the
    // fallback; let its async toast settle before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(applied).toBe(false);
    expect(recipientByCid['cid-4']).toBeUndefined();
    // Now — and only now — the user is guided toward installing a CLI or
    // configuring an API key.
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('API Key');
  });

  it('skips a signed-in CLI whose local proxy is confirmed unreachable when auto-picking', async () => {
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: '' }, // no preference → auto-pick
      // codex IS signed in and available, but its local proxy (CC Switch) is
      // confirmed down → auto-pick must skip it and choose workbuddy instead.
      'localAgents.list': {
        entries: [
          { type: 'codex', available: true, auth: { loggedIn: true } },
          { type: 'workbuddy', available: true, auth: { loggedIn: true } },
        ],
      },
      'localAgents.cliEndpointInfo': {
        endpoints: {
          claude: null,
          codex: { baseUrl: 'http://127.0.0.1:15721/v1', isLocalProxy: true, reachable: false },
          opencode: null,
          workbuddy: null, // no proxy → treated as usable
        },
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
          { agent_id: 'agent-wb-1', name: 'WorkBuddy', runtime: { kind: 'cli', cli: 'workbuddy' } },
        ],
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-proxy-down');

    expect(applied).toBe(true);
    expect(recipientByCid['cid-proxy-down']).toMatchObject({ kind: 'agent', id: 'agent-wb-1' });
  });

  it('honours an explicit fallback preference even when its local proxy is unreachable', async () => {
    // The user explicitly picked codex as the fallback backend. A dead local
    // proxy must not silently swap them to another CLI — respect the choice
    // and let the CLI's own run error surface the proxy hint.
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: 'codex' },
      'localAgents.cliEndpointInfo': {
        endpoints: {
          codex: { baseUrl: 'http://127.0.0.1:15721/v1', isLocalProxy: true, reachable: false },
        },
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
        ],
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('cid-proxy-pref');

    expect(applied).toBe(true);
    expect(recipientByCid['cid-proxy-pref']).toMatchObject({ kind: 'agent', id: 'agent-codex-1' });
  });

  it('syncs the fallback into _newChatRecipient when applied on the draft cid (new-chat)', async () => {
    // new-chat 发送路径：降级 applied 到 DRAFT_CID 时，必须同时更新
    // `_newChatRecipient`——handleNewChatSubmit 的结构化 recipient 快照读它。
    // 只写 `_recipientByCid[DRAFT_CID]` 会导致消息仍按 commander 路由。
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: '' },
      'localAgents.list': {
        entries: [{ type: 'codex', available: true, auth: { loggedIn: true } }],
      },
      'localAgents.cliEndpointInfo': {
        endpoints: { codex: null, claude: null, opencode: null, workbuddy: null },
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
        ],
      },
    });

    const applied = await sandbox._maybeApplyCliFallback('main_chat'); // DRAFT_CID

    expect(applied).toBe(true);
    expect(recipientByCid['main_chat']).toMatchObject({ kind: 'agent', id: 'agent-codex-1' });
    // The new-chat recipient must also carry the trusted fallback origin.
    expect(sandbox._newChatRecipient).toMatchObject({
      kind: 'agent', id: 'agent-codex-1', origin: 'cli_fallback',
    });
  });

  it('auto-switches to the next usable CLI when the current one fails at runtime', async () => {
    // codex 是唯一「已登录」CLI 但运行失败（如本地代理没开）；claude 可用但未标记
    // 登录。auto-switch 应排除 codex 并选 claude。
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: 'codex' }, // 显式偏好 codex
      'localAgents.list': {
        entries: [
          { type: 'codex', available: true, auth: { loggedIn: true } },
          { type: 'claude', available: true, auth: { loggedIn: false } },
        ],
      },
      'localAgents.cliEndpointInfo': {
        endpoints: { codex: null, claude: null, opencode: null, workbuddy: null },
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
          { agent_id: 'agent-claude-1', name: 'Claude', runtime: { kind: 'cli', cli: 'claude' } },
        ],
      },
    });
    // 先降级到 codex（模拟之前的降级）。
    const first = await sandbox._maybeApplyCliFallback('cid-switch');
    expect(first).toBe(true);
    expect(recipientByCid['cid-switch']).toMatchObject({ kind: 'agent', id: 'agent-codex-1' });

    // codex 运行失败 → 自动切换（排除 codex，选 claude）。
    await sandbox._maybeAutoSwitchCliOnFailure('cid-switch', {
      failureKind: 'runtime',
      failureCode: 'cli_failed',
      aborted: false,
    });

    expect(recipientByCid['cid-switch']).toMatchObject({ kind: 'agent', id: 'agent-claude-1' });
  });

  it('does not auto-switch twice to the same failed CLI', async () => {
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': { cli: 'codex' },
      'localAgents.list': {
        entries: [
          { type: 'codex', available: true, auth: { loggedIn: true } },
          { type: 'claude', available: true, auth: { loggedIn: false } },
        ],
      },
      'localAgents.cliEndpointInfo': {
        endpoints: { codex: null, claude: null, opencode: null, workbuddy: null },
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
          { agent_id: 'agent-claude-1', name: 'Claude', runtime: { kind: 'cli', cli: 'claude' } },
        ],
      },
    });
    await sandbox._maybeApplyCliFallback('cid-switch2');
    await sandbox._maybeAutoSwitchCliOnFailure('cid-switch2', {
      failureKind: 'runtime', failureCode: 'cli_failed', aborted: false,
    });
    // 第一次切换 → claude
    expect(recipientByCid['cid-switch2']).toMatchObject({ kind: 'agent', id: 'agent-claude-1' });
    // claude 也失败 → 已无其他可用 CLI，recipient 保持不变（不循环）。
    await sandbox._maybeAutoSwitchCliOnFailure('cid-switch2', {
      failureKind: 'runtime', failureCode: 'cli_failed', aborted: false,
    });
    expect(recipientByCid['cid-switch2']).toMatchObject({ kind: 'agent', id: 'agent-claude-1' });
  });

  it('persists the auto-switch as the new fallback preference', async () => {
    // codex（偏好）运行失败 → 切到 claude 后，把偏好持久化为 claude，
    // 这样下一个会话/重启不会再次先试失败的 codex。
    const saved: string[] = [];
    const { sandbox, recipientByCid } = buildSandbox({
      'model.hasConfigured': { configured: false },
      'prefs.getCliFallback': () => ({ cli: saved.length ? saved[saved.length - 1] : 'codex' }),
      'prefs.setCliFallback': (payload: unknown) => {
        saved.push(String((payload as any).cli || ''));
        return { cli: String((payload as any).cli || '') };
      },
      'localAgents.list': {
        entries: [
          { type: 'codex', available: true, auth: { loggedIn: true } },
          { type: 'claude', available: true, auth: { loggedIn: true } },
        ],
      },
      'localAgents.cliEndpointInfo': {
        endpoints: { codex: null, claude: null, opencode: null, workbuddy: null },
      },
      'agents.list': {
        agents: [
          { agent_id: 'agent-codex-1', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
          { agent_id: 'agent-claude-1', name: 'Claude', runtime: { kind: 'cli', cli: 'claude' } },
        ],
      },
    });

    await sandbox._maybeApplyCliFallback('cid-persist');
    await sandbox._maybeAutoSwitchCliOnFailure('cid-persist', {
      failureKind: 'runtime', failureCode: 'cli_failed', aborted: false,
    });

    expect(recipientByCid['cid-persist']).toMatchObject({ kind: 'agent', id: 'agent-claude-1' });
    // 偏好从 codex 更新为 claude（只写一次，且只在确实切换成功时）。
    expect(saved).toEqual(['claude']);
  });
});

describe('external-agent slow-response switch', () => {
  function sandboxWithAgents(agents: Array<Record<string, any>>, routes: Record<string, unknown> = {}) {
    const { sandbox } = buildSandbox(routes);
    (sandbox as any)._agentsCache = agents;
    return sandbox as any;
  }

  it('lists external-agent switch candidates in route order, excluding the stuck one', () => {
    const sandbox = sandboxWithAgents([
      { agent_id: 'a-hermes', name: 'Hermes', runtime: { kind: 'p3394-gateway', cli: 'hermes' } },
      { agent_id: 'a-openclaw', name: 'OpenClaw', runtime: { kind: 'p3394-gateway', cli: 'openclaw' } },
      { agent_id: 'a-codex', name: 'Codex', runtime: { kind: 'p3394-gateway', cli: 'codex' } },
      { agent_id: 'a-inproc', name: 'Commander', runtime: { kind: 'in_process' } },
    ]);

    const candidates = sandbox._externalSwitchCandidates('a-hermes');
    // in_process 被排除；hermes（卡住者）被排除；codex 在路由序里先于 openclaw。
    expect(candidates.map((c: any) => c.cli)).toEqual(['codex', 'openclaw']);
    expect(candidates[0].name).toBe('Codex');
  });

  it('only recognizes cli / p3394-gateway runtimes as external agents', () => {
    const sandbox = sandboxWithAgents([
      { agent_id: 'a-claude', name: 'Claude', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
      { agent_id: 'a-cli', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
      { agent_id: 'a-inproc', name: 'Commander', runtime: { kind: 'in_process' } },
    ]);
    expect(sandbox._isExternalGroupActor('a-claude')).toBe(true);
    expect(sandbox._isExternalGroupActor('a-cli')).toBe(true);
    expect(sandbox._isExternalGroupActor('a-inproc')).toBe(false);
    expect(sandbox._isExternalGroupActor('commander')).toBe(false);
    expect(sandbox._isExternalGroupActor('')).toBe(false);
  });

  it('arms a 2min slow timer for an external agent but not for commander', () => {
    const sandbox = sandboxWithAgents([
      { agent_id: 'a-hermes', name: 'Hermes', runtime: { kind: 'p3394-gateway', cli: 'hermes' } },
    ]);
    sandbox._armSlowSwitch('cid-x', 'a-hermes', 'turn-1', 'Hermes');
    expect((sandbox as any)._slowTimers).toHaveLength(1);
    expect((sandbox as any)._slowTimers[0].ms).toBe(120000);
    (sandbox as any)._slowTimers = [];
    sandbox._armSlowSwitch('cid-x', 'commander', 'turn-2', 'Commander');
    expect((sandbox as any)._slowTimers).toHaveLength(0);
  });

  it('clears the slow timer once a first output arrives', () => {
    const sandbox = sandboxWithAgents([
      { agent_id: 'a-hermes', name: 'Hermes', runtime: { kind: 'p3394-gateway', cli: 'hermes' } },
    ]);
    sandbox._armSlowSwitch('cid-x', 'a-hermes', 'turn-1', 'Hermes');
    expect((sandbox as any)._slowTimers).toHaveLength(1);
    // 首条 delta → clear：map 中该项被清掉，后续再 arm 会重新计时。
    sandbox._clearSlowSwitch('cid-x', 'a-hermes');
    (sandbox as any)._slowTimers = [];
    sandbox._armSlowSwitch('cid-x', 'a-hermes', 'turn-1', 'Hermes');
    expect((sandbox as any)._slowTimers).toHaveLength(1);
  });

  it('does not arm the slow switch for non-external actors even with a process event', () => {
    const sandbox = sandboxWithAgents([
      { agent_id: 'a-cli', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
    ]);
    sandbox._armSlowSwitch('cid-x', 'commander', 'turn-1', '');
    expect((sandbox as any)._slowTimers).toHaveLength(0);
  });

  it('recognizes gateway error replies so fast failures also offer a switch', () => {
    const sandbox = sandboxWithAgents([
      { agent_id: 'a-claude', name: 'Claude', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
    ]);
    expect(sandbox._isP3394GatewayErrorText('[p3394_gateway_error] agent exited 1')).toBe(true);
    expect(sandbox._isP3394GatewayErrorText('[p3394_gateway_error] spawn ENOENT')).toBe(true);
    expect(sandbox._isP3394GatewayErrorText('正常回复内容')).toBe(false);
    expect(sandbox._isP3394GatewayErrorText('')).toBe(false);
    expect(sandbox._isP3394GatewayErrorText(null)).toBe(false);
  });

  it('rebuilds the resend message with the NEW agent name, never the stuck old @ prefix', () => {
    const sandbox = sandboxWithAgents([]);
    const rebuild = sandbox._rebuildSwitchMessage as (task: string, targetName: string) => string;
    // 历史兜底带旧 @ 前缀 → 切换后必须是新 agent 名。
    expect(rebuild('@ClaudeCode 帮我整理这个项目', 'Codex')).toBe('@Codex 帮我整理这个项目');
    expect(rebuild('@ClaudeCode 1', 'Codex')).toBe('@Codex 1');
    // 无前缀的普通任务 → 直接加新 agent 前缀。
    expect(rebuild('帮我整理这个项目', 'Hermes')).toBe('@Hermes 帮我整理这个项目');
    // 空任务 → 空（提示手动输入）。
    expect(rebuild('', 'Codex')).toBe('');
    expect(rebuild('@ClaudeCode', 'Codex')).toBe('');
  });
});
