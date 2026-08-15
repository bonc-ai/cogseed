import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Extract the CLI-fallback logic from conversation.js and run it in a sandbox
// with a mocked window.orkas, so we can verify the real branching behaviour:
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

function buildSandbox(routes: Record<string, unknown | ((payload: unknown) => unknown)>) {
  const invokeLog: InvokeLog[] = [];
  const toasts: Array<{ message: string; opts: unknown }> = [];
  const recipientByCid: Record<string, unknown> = {};
  const sandbox: any = {
    Array,
    Math,
    String,
    Boolean,
    Promise,
    console,
    _recipientByCid: recipientByCid,
    _renderRecipientChip: () => {},
    uiToast: (message: string, opts: unknown) => { toasts.push({ message, opts }); },
    _convLog: { info: () => {}, warn: () => {}, error: () => {} },
    window: {
      orkas: {
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
  vm.runInNewContext(fallbackSource, sandbox, { filename: 'cli-fallback.js' });
  return { sandbox, invokeLog, toasts, recipientByCid };
}

describe('commander CLI fallback', () => {
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
    expect((created[0] as any).runtime).toEqual({ kind: 'cli', cli: 'codex' });
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
    expect((created[0] as any).runtime).toEqual({ kind: 'cli', cli: 'workbuddy' });
    expect(recipientByCid['cid-wb']).toMatchObject({ kind: 'agent', id: 'agent-wb-new' });
    expect(toasts[0].message).toContain('WorkBuddy');
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
});
