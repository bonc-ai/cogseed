import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const source = readFileSync(resolve(root, 'src/renderer/modules/model-guard.js'), 'utf8');

function makeSandbox() {
  const listeners: Record<string, Function[]> = {};
  let configured = false;
  let localAgentAvailable = false;
  let now = 1_000_000;
  const bodyClasses = new Set<string>();
  const calls: string[] = [];
  // 跳转缝的原始参数（setView / activateSettingsTab 都是多参，「只记第一个参数」
  // 会看不见 settingsTab / settingsAnchor 有没有传——正是这次真机故障的盲区）。
  const navCalls: Array<{ fn: string; args: unknown[] }> = [];
  const sandbox: any = {
    console,
    Date: { now: () => now },
    Math,
    Promise,
    createLogger: () => ({ warn: () => {}, info: () => {} }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    uiAlert: () => { calls.push('alert'); },
    setView: (...args: unknown[]) => { calls.push(`view:${args[0]}`); navCalls.push({ fn: 'setView', args }); },
    CustomEvent: function CustomEvent(type: string, init?: unknown) { return { type, ...(init ? { init } : {}) }; },
    document: {
      visibilityState: 'visible',
      querySelector: () => null,
      addEventListener: (name: string, fn: Function) => {
        (listeners[`document:${name}`] ||= []).push(fn);
      },
      body: {
        classList: {
          toggle: (name: string, enabled: boolean) => {
            if (enabled) bodyClasses.add(name);
            else bodyClasses.delete(name);
          },
        },
      },
    },
    window: {
      cogseed: {
        invoke: async (channel: string) => {
          if (channel === 'auth.hasConfiguredModel') return { ok: true, configured };
          if (channel === 'chat.executionCapability') return {
            ok: true,
            apiConfigured: configured,
            localAgentAvailable,
            chatAvailable: configured || localAgentAvailable,
          };
          if (channel === 'auth.listEntries') return { ok: true, entries: configured ? [{ provider: 'p', model: 'm' }] : [] };
          throw new Error(`unexpected channel ${channel}`);
        },
      },
      addEventListener: (name: string, fn: Function) => {
        (listeners[`window:${name}`] ||= []).push(fn);
      },
      dispatchEvent: () => true,
      activateSettingsTab: (...args: unknown[]) => { calls.push(`tab:${args[0]}`); navCalls.push({ fn: 'activateSettingsTab', args }); },
    },
  };
  sandbox.globalThis = sandbox;
  return {
    sandbox,
    listeners,
    calls,
    navCalls,
    bodyClasses,
    setConfigured(value: boolean) { configured = value; },
    setLocalAgentAvailable(value: boolean) { localAgentAvailable = value; },
    advance(ms: number) { now += ms; },
    async tick() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); },
  };
}

describe('model-guard stale state recovery', () => {
  it('includes a dismiss control without changing the configuration gate', () => {
    expect(source).toContain('model-guard-dismiss');
    expect(source).toContain('_guardDismissed');
  });

  it('refreshes after window focus when credentials are added elsewhere', async () => {
    const ctx = makeSandbox();
    vm.runInNewContext(source, ctx.sandbox, { filename: 'model-guard.js' });

    expect(await ctx.sandbox.refreshModelGuard()).toBe(false);
    expect(ctx.bodyClasses.has('model-not-configured')).toBe(true);

    ctx.setConfigured(true);
    ctx.advance(1500);
    for (const fn of ctx.listeners['window:focus'] || []) fn();
    await ctx.tick();

    expect(ctx.sandbox.isModelConfigured()).toBe(true);
    expect(ctx.bodyClasses.has('model-not-configured')).toBe(false);
  });

  it('kicks a backend refresh when a stale disabled gate is used again', async () => {
    const ctx = makeSandbox();
    vm.runInNewContext(source, ctx.sandbox, { filename: 'model-guard.js' });

    expect(await ctx.sandbox.refreshModelGuard()).toBe(false);
    ctx.setConfigured(true);
    ctx.advance(600);

    expect(ctx.sandbox.ensureModelConfigured({ silent: true })).toBe(false);
    await ctx.tick();

    expect(ctx.sandbox.isModelConfigured()).toBe(true);
    expect(ctx.sandbox.ensureModelConfigured({ silent: true })).toBe(true);
  });

  it('keeps the model configuration warning when only local Agent chat is available', async () => {
    const ctx = makeSandbox();
    ctx.setLocalAgentAvailable(true);
    vm.runInNewContext(source, ctx.sandbox, { filename: 'model-guard.js' });

    expect(await ctx.sandbox.refreshModelGuard()).toBe(false);
    expect(ctx.sandbox.isModelConfigured()).toBe(false);
    expect(ctx.bodyClasses.has('model-not-configured')).toBe(true);
  });

  // 回归（与知识库「去设置管理模型」同一类真机故障）：模型守卫的「去配置模型」
  // 此前也是旧的两段跳转（setView('settings') 不带 tab/锚点 + activateSettingsTab
  // ('credentials')），设置页懒加载完后停在默认的「数据」tab，落不到模型配置。
  it('sends the model-config entry to Settings → Configuration with the models anchor', async () => {
    const ctx = makeSandbox();
    vm.runInNewContext(source, ctx.sandbox, { filename: 'model-guard.js' });
    expect(await ctx.sandbox.refreshModelGuard()).toBe(false);

    expect(ctx.sandbox.ensureModelConfigured()).toBe(false);

    expect(ctx.navCalls).toEqual([
      { fn: 'setView', args: ['settings', undefined, { settingsTab: 'configuration', settingsAnchor: 'models' }] },
      { fn: 'activateSettingsTab', args: ['configuration', { anchor: 'models' }] },
    ]);
  });

  // 绊线：旧写法（裸 setView('settings') / 'credentials' tab 名）不许再回来——
  // 两个调用点都必须走 _openModelConfiguration()，否则又会静默停在「数据」tab。
  // 先剥掉注释再扫：说明这条坑的注释里就写着旧写法（同 AGENTS.md §1.5.1 的教训，
  // 不剥注释会让"文档里提到过"被判成"代码里还在用"→ 假红）。
  it('keeps both entry points on the shared model-config navigation seam', () => {
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/setView\('settings'\)/);
    expect(codeOnly).not.toContain("activateSettingsTab('credentials'");
    expect((codeOnly.match(/_openModelConfiguration\(\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});
