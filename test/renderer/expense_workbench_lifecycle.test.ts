import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import type { JsonObject } from '../../src/main/features/expense_workbench/contracts';

interface InvokeCall {
  channel: string;
  payload: JsonObject;
}

type InvokeHandler = (channel: string, payload: JsonObject) => Promise<JsonObject>;

interface ClickTarget {
  dataset: Record<string, string>;
  hasAttribute: (name: string) => boolean;
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function target(dataset: Record<string, string>, attributes: readonly string[] = []): ClickTarget {
  const names = new Set(attributes);
  return { dataset, hasAttribute: (name) => names.has(name) };
}

function loadWorkbench(handler: InvokeHandler) {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/renderer/modules/expense-workbench.js'),
    'utf8',
  );
  const calls: InvokeCall[] = [];
  const renders: string[] = [];
  const main = { innerHTML: '', querySelectorAll: () => [] };
  const host: {
    hidden: boolean;
    innerHTML: string;
    onclick: ((event: { target: { closest: () => ClickTarget } }) => Promise<void>) | null;
  } = { hidden: true, innerHTML: '', onclick: null };
  const elements: Record<string, JsonObject> = {
    'agent-management-surface': host,
    'agents-detail-content': { style: { display: '' } },
    'agents-chat-col': { style: { display: 'none' } },
    'ew-main': main,
    'ew-header-status': { textContent: '' },
    'ew-config-banner': { hidden: true },
  };
  const render = (page: string) => (state: JsonObject) => {
    const value = `${page}:${JSON.stringify(state.selectedApplication ?? null)}`;
    renders.push(value);
    return value;
  };
  const workbenchWindow: {
    orkas: { invoke: InvokeHandler };
    expenseWorkbenchMarkup: JsonObject;
    confirm: () => boolean;
    openExpenseWorkbench?: (agentId: string) => Promise<void>;
    closeExpenseWorkbench?: () => void;
  } = {
    orkas: {
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return handler(channel, payload);
      },
    },
    expenseWorkbenchMarkup: {
      shell: () => '<section></section>',
      assistant: render('assistant'),
      applications: render('applications'),
      precheck: render('precheck'),
      overview: render('overview'),
      reviews: render('reviews'),
      connections: render('connections'),
      audit: render('audit'),
      text: (_key: string, fallback: string) => fallback,
    },
    confirm: () => true,
  };
  const context = {
    window: workbenchWindow,
    document: { getElementById: (id: string) => elements[id] || null },
    uiConfirm: async () => true,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'expense-workbench.js' });

  return {
    calls,
    renders,
    host,
    open: async (agentId = 'expense-agent') => {
      if (!workbenchWindow.openExpenseWorkbench) throw new Error('open handler is unavailable');
      await workbenchWindow.openExpenseWorkbench(agentId);
    },
    close: () => {
      if (!workbenchWindow.closeExpenseWorkbench) throw new Error('close handler is unavailable');
      workbenchWindow.closeExpenseWorkbench();
    },
    click: async (clickTarget: ClickTarget) => {
      if (!host.onclick) throw new Error('click handler is unavailable');
      await host.onclick({ target: { closest: () => clickTarget } });
    },
  };
}

function applicationState(applicationId: string): JsonObject {
  return {
    ok: true,
    application: {
      application_id: applicationId,
      current_version: 1,
      current_payload_hash: 'a'.repeat(64),
      precheck_status: 'ready_for_confirmation',
      oa_status: 'submission_unknown',
      target: { environment: 'feishu', adapter: 'feishu-approval' },
    },
    draft: { payload: { expense_items: [{ amount: 1 }] }, material_refs: [], material_categories: {} },
    unified_precheck: { status: 'ready' },
  };
}

describe('expense workbench renderer lifecycle isolation', () => {
  it('drops a page response that arrives after the workbench closes', async () => {
    const settings = deferred<JsonObject>();
    const workbench = loadWorkbench(async (channel, payload) => {
      if (channel === 'expenseWorkbench.status') return { ok: true, configured: true };
      if (channel === 'expenseWorkbench.close') return { ok: true, closed: true };
      if (channel === 'expenseWorkbench.invoke' && payload.operation === 'applications.list') {
        return { ok: true, applications: [] };
      }
      if (channel === 'expenseWorkbench.invoke' && payload.operation === 'settings.get') return settings.promise;
      throw new Error(`unexpected call: ${channel}:${String(payload.operation || '')}`);
    });
    await workbench.open();

    const pageRequest = workbench.click(target({ ewPage: 'connections' }));
    const renderCountAtClose = workbench.renders.length;
    workbench.close();
    settings.resolve({ ok: true, configured: true });
    await pageRequest;

    expect(workbench.host.hidden).toBe(true);
    expect(workbench.host.innerHTML).toBe('');
    expect(workbench.renders).toHaveLength(renderCountAtClose);
  });

  it('keeps the newest application when older selection data arrives last', async () => {
    const first = deferred<JsonObject>();
    const second = deferred<JsonObject>();
    const workbench = loadWorkbench(async (channel, payload) => {
      if (channel === 'expenseWorkbench.status') return { ok: true, configured: true };
      if (channel === 'expenseWorkbench.invoke' && payload.operation === 'applications.list') {
        return { ok: true, applications: [] };
      }
      if (channel === 'expenseWorkbench.invoke' && payload.operation === 'applications.get') {
        return payload.payload && typeof payload.payload === 'object'
          && !Array.isArray(payload.payload) && payload.payload.application_id === 'APP-A'
          ? first.promise
          : second.promise;
      }
      throw new Error(`unexpected call: ${channel}:${String(payload.operation || '')}`);
    });
    await workbench.open();

    const selectFirst = workbench.click(target({ ewApplication: 'APP-A' }));
    const selectSecond = workbench.click(target({ ewApplication: 'APP-B' }));
    second.resolve(applicationState('APP-B'));
    await selectSecond;
    first.resolve(applicationState('APP-A'));
    await selectFirst;

    expect(workbench.renders.at(-1)).toContain('APP-B');
    expect(workbench.renders.at(-1)).not.toContain('APP-A');
  });

  it('coalesces repeated submit clicks while the first submission is in flight', async () => {
    const submission = deferred<JsonObject>();
    const workbench = loadWorkbench(async (channel, payload) => {
      if (channel === 'expenseWorkbench.status') return { ok: true, configured: true };
      if (channel === 'expenseWorkbench.invoke' && payload.operation === 'applications.list') {
        return { ok: true, applications: [{ application_id: 'APP-1' }] };
      }
      if (channel === 'expenseWorkbench.invoke' && payload.operation === 'applications.get') {
        return applicationState('APP-1');
      }
      if (channel === 'expenseWorkbench.confirmAndSubmit') return submission.promise;
      throw new Error(`unexpected call: ${channel}:${String(payload.operation || '')}`);
    });
    await workbench.open();

    const firstClick = workbench.click(target({ ewSubmit: '' }));
    const secondClick = workbench.click(target({ ewSubmit: '' }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(workbench.calls.filter(({ channel }) => channel === 'expenseWorkbench.confirmAndSubmit')).toHaveLength(1);

    submission.resolve({ ok: true, submitted: applicationState('APP-1') });
    await Promise.all([firstClick, secondClick]);
  });

  it('coalesces repeated recovery clicks while the external operation is in flight', async () => {
    const recovery = deferred<JsonObject>();
    const workbench = loadWorkbench(async (channel, payload) => {
      if (channel === 'expenseWorkbench.status') return { ok: true, configured: true };
      if (channel === 'expenseWorkbench.invoke' && payload.operation === 'applications.list') {
        return { ok: true, applications: [{ application_id: 'APP-1' }] };
      }
      if (channel === 'expenseWorkbench.invoke' && payload.operation === 'applications.get') {
        return applicationState('APP-1');
      }
      if (channel === 'expenseWorkbench.invokeExternal' && payload.operation === 'applications.recoverSubmission') {
        return recovery.promise;
      }
      throw new Error(`unexpected call: ${channel}:${String(payload.operation || '')}`);
    });
    await workbench.open();

    const firstClick = workbench.click(target({ ewRecoverSubmission: '' }));
    const secondClick = workbench.click(target({ ewRecoverSubmission: '' }));
    await Promise.resolve();
    expect(workbench.calls.filter(({ channel }) => channel === 'expenseWorkbench.invokeExternal')).toHaveLength(1);

    recovery.resolve(applicationState('APP-1'));
    await Promise.all([firstClick, secondClick]);
  });
});
