import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// External-agent launch confirm prompt: a `local-agents:launch-confirm` push
// shows the allow / deny dialog and relays the verdict through
// `local-agents.launch_confirm_response`. Mirrors the bridge.js /
// bash_permission.js prompt harness.

function loadHarness(dialogResult: string) {
  let pushHandler: ((info: any) => void) | null = null;
  const invokeCalls: Array<{ channel: string; payload: any }> = [];
  const uiChoiceCalls: any[] = [];

  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    String,
    Array,
    createLogger: () => ({ warn: vi.fn(), info() {}, error() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'cli_launch_confirm.title': 'Allow launching the external agent in this conversation?',
        'cli_launch_confirm.message': 'This conversation is about to use {agent} ({cli}) for the first time. Allow it?',
        'cli_launch_confirm.allow': 'Allow for this conversation',
        'cli_launch_confirm.deny': 'Deny',
      };
      let text = dict[key] || key;
      for (const [k, v] of Object.entries(vars || {})) {
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
      return text;
    },
    uiChoice: async ({ title, message, cancelLabel, choices }: any) => {
      uiChoiceCalls.push({ title, message, cancelLabel, choices });
      return dialogResult;
    },
    window: {
      cogseed: {
        invoke: vi.fn(async (channel: string, payload: any) => {
          invokeCalls.push({ channel, payload });
          return { handled: true };
        }),
        onPushEvent: vi.fn((name: string, cb: (info: any) => void) => {
          if (name === 'local-agents:launch-confirm') pushHandler = cb;
        }),
      },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/local_agents_launch_confirm.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'local_agents_launch_confirm.js' });
  if (!pushHandler) throw new Error('local-agents:launch-confirm handler was not registered');
  return { context, pushHandler, invokeCalls, uiChoiceCalls };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

const INFO = { request_id: 'req-1', agent_id: 'a1', agent_name: 'Claude Code', cli: 'claude', cid: 'c1' };

describe('renderer local-agent launch confirm prompt', () => {
  it('shows the dialog with agent + cli and relays allow', async () => {
    const h = loadHarness('allow');
    h.pushHandler(INFO);
    await flush();
    expect(h.uiChoiceCalls[0]).toMatchObject({
      title: 'Allow launching the external agent in this conversation?',
      message: 'This conversation is about to use Claude Code (claude) for the first time. Allow it?',
      cancelLabel: 'Deny',
    });
    expect(h.uiChoiceCalls[0].choices.map((c: any) => c.id)).toEqual(['allow']);
    expect(h.invokeCalls).toEqual([{
      channel: 'local-agents.launch_confirm_response',
      payload: { request_id: 'req-1', allow: true, always: false },
    }]);
  });

  it('relays deny and does not allow', async () => {
    const h = loadHarness(null);
    h.pushHandler(INFO);
    await flush();
    expect(h.invokeCalls).toEqual([{
      channel: 'local-agents.launch_confirm_response',
      payload: { request_id: 'req-1', allow: false, always: false },
    }]);
  });

  it('queues concurrent pushes FIFO instead of stacking dialogs', async () => {
    const h = loadHarness('allow');
    h.pushHandler(INFO);
    h.pushHandler({ ...INFO, request_id: 'req-2', cli: 'codex', agent_name: 'Codex' });
    await flush();
    expect(h.uiChoiceCalls).toHaveLength(2);
    expect(h.uiChoiceCalls[0].message).toContain('Claude Code');
    expect(h.uiChoiceCalls[1].message).toContain('Codex');
    expect(h.invokeCalls).toHaveLength(2);
    expect(h.invokeCalls[0].payload.request_id).toBe('req-1');
    expect(h.invokeCalls[1].payload.request_id).toBe('req-2');
  });
});
