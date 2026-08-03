import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

interface InvokeCall {
  channel: string;
  payload: Record<string, object | string>;
}

function loadWorkbench(options: { application?: Record<string, unknown> } = {}) {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/renderer/modules/expense-workbench.js'),
    'utf8',
  );
  const calls: InvokeCall[] = [];
  const main = {
    innerHTML: '',
    querySelectorAll: () => [],
  };
  const host = {
    hidden: true,
    innerHTML: '',
    onclick: null as ((event: { target: { closest: () => object } }) => Promise<void>) | null,
  };
  const elements: Record<string, object> = {
    'agent-management-surface': host,
    'agents-detail-content': { style: { display: '' } },
    'agents-chat-col': { style: { display: 'none' } },
    'ew-main': main,
    'ew-header-status': { textContent: '' },
    'ew-config-banner': { hidden: true },
  };
  const application = options.application;
  const invoke = vi.fn(async (channel: string, payload: Record<string, object | string>) => {
    calls.push({ channel, payload });
    if (channel === 'expenseWorkbench.status') return { ok: true, configured: true };
    if (channel === 'expenseWorkbench.invoke') {
      if (payload.operation === 'applications.list') {
        return { ok: true, applications: application ? [application] : [] };
      }
      if (payload.operation === 'applications.get') {
        return {
          ok: true,
          application,
          draft: { payload: {}, material_refs: [], material_categories: {} },
        };
      }
      if (payload.operation === 'settings.get') return { ok: true, configured: true };
      return { ok: true };
    }
    if (channel === 'expenseWorkbench.invokeExternal') return { ok: true, status: 'ready' };
    if (channel === 'expenseWorkbench.pickAndAddMaterials') {
      return {
        ok: true,
        cancelled: false,
        materials: [{
          ref: 'workspace://MAT-1',
          name: 'receipt.pdf',
          media_type: 'application/pdf',
          size: 12,
          sha256: 'a'.repeat(64),
          material_category: 'expense_receipt',
        }],
        failed: [],
      };
    }
    return { ok: true };
  });
  const markup = {
    shell: () => '<section></section>',
    assistant: () => '',
    applications: () => '',
    precheck: () => '',
    overview: () => '',
    reviews: () => '',
    connections: () => '',
    audit: () => '',
    text: (_key: string, fallback: string) => fallback,
  };
  const context = {
    window: { orkas: { invoke }, expenseWorkbenchMarkup: markup },
    document: { getElementById: (id: string) => elements[id] || null },
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'expense-workbench.js' });
  return { calls, context, host };
}

function clickTarget(attributes: string[]) {
  const attributeSet = new Set(attributes);
  const dataset: Record<string, string> = {};
  if (attributeSet.has('data-ew-settings-test')) dataset.ewSettingsTest = '';
  if (attributeSet.has('data-ew-add-material')) dataset.ewAddMaterial = '';
  return {
    hasAttribute: (name: string) => attributeSet.has(name),
    dataset,
  };
}

describe('expense workbench external controls', () => {
  it('does not contact Feishu when the connections page loads', async () => {
    const { calls, context, host } = loadWorkbench();
    await context.window.openExpenseWorkbench('expense-agent');
    if (!host.onclick) throw new Error('workbench click handler is unavailable');
    await host.onclick({ target: { closest: () => ({ dataset: { ewPage: 'connections' }, hasAttribute: () => false }) } });

    expect(calls.filter((call) => call.channel === 'expenseWorkbench.invokeExternal')).toEqual([]);
    expect(calls).toContainEqual({
      channel: 'expenseWorkbench.invoke',
      payload: { agent_id: 'expense-agent', operation: 'settings.get', payload: {} },
    });
  });

  it('uses the dedicated external route only after the user clicks the disclosed action', async () => {
    const { calls, context, host } = loadWorkbench();
    await context.window.openExpenseWorkbench('expense-agent');
    if (!host.onclick) throw new Error('workbench click handler is unavailable');
    await host.onclick({ target: { closest: () => clickTarget(['data-ew-settings-test']) } });

    expect(calls).toContainEqual({
      channel: 'expenseWorkbench.invokeExternal',
      payload: { agent_id: 'expense-agent', operation: 'settings.preflight', payload: {} },
    });
    expect(calls.some((call) => (
      call.channel === 'expenseWorkbench.invoke'
      && ['settings.preflight', 'settings.test'].includes(String(call.payload.operation))
    ))).toBe(false);
  });

  it('adds materials through the dedicated route without receiving paths or bytes', async () => {
    const application = { application_id: 'APP-1', current_version: 1 };
    const { calls, context, host } = loadWorkbench({ application });
    await context.window.openExpenseWorkbench('expense-agent');
    if (!host.onclick) throw new Error('workbench click handler is unavailable');
    await host.onclick({ target: { closest: () => clickTarget(['data-ew-add-material']) } });

    expect(calls).toContainEqual({
      channel: 'expenseWorkbench.pickAndAddMaterials',
      payload: { agent_id: 'expense-agent', application_id: 'APP-1' },
    });
    expect(calls.some((call) => call.channel === 'common.pickFiles')).toBe(false);
    expect(calls.some((call) => (
      call.channel === 'expenseWorkbench.invoke'
      && call.payload.operation === 'materials.add'
    ))).toBe(false);
    expect(JSON.stringify(calls)).not.toContain('data_base64');
    expect(JSON.stringify(calls)).not.toContain('/Users/');
  });

  it('configures the project through a main-only atomic picker', async () => {
    const { calls, context, host } = loadWorkbench();
    await context.window.openExpenseWorkbench('expense-agent');
    if (!host.onclick) throw new Error('workbench click handler is unavailable');
    await host.onclick({ target: { closest: () => clickTarget(['data-ew-configure']) } });

    expect(calls).toContainEqual({
      channel: 'expenseWorkbench.pickAndConfigure',
      payload: { agent_id: 'expense-agent' },
    });
    expect(calls.some((call) => call.channel === 'common.pickDirectory')).toBe(false);
    expect(JSON.stringify(calls)).not.toContain('project_root');
  });
});
