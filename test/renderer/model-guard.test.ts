import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const source = readFileSync(resolve(root, 'src/renderer/modules/model-guard.js'), 'utf8');

function makeSandbox() {
  const listeners: Record<string, Function[]> = {};
  let configured = false;
  let now = 1_000_000;
  const bodyClasses = new Set<string>();
  const calls: string[] = [];
  const sandbox: any = {
    console,
    Date: { now: () => now },
    Math,
    Promise,
    createLogger: () => ({ warn: () => {}, info: () => {} }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    uiAlert: () => { calls.push('alert'); },
    setView: (view: string) => { calls.push(`view:${view}`); },
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
      orkas: {
        invoke: async (channel: string) => {
          if (channel === 'auth.hasConfiguredModel') return { ok: true, configured };
          if (channel === 'auth.listEntries') return { ok: true, entries: configured ? [{ provider: 'p', model: 'm' }] : [] };
          throw new Error(`unexpected channel ${channel}`);
        },
      },
      addEventListener: (name: string, fn: Function) => {
        (listeners[`window:${name}`] ||= []).push(fn);
      },
      dispatchEvent: () => true,
      activateSettingsTab: (tab: string) => { calls.push(`tab:${tab}`); },
    },
  };
  sandbox.globalThis = sandbox;
  return {
    sandbox,
    listeners,
    calls,
    bodyClasses,
    setConfigured(value: boolean) { configured = value; },
    advance(ms: number) { now += ms; },
    async tick() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); },
  };
}

describe('model-guard stale state recovery', () => {
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
});
