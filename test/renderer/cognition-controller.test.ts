import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/cognition/cognition.js'),
  'utf8',
);

interface TestElement {
  innerHTML?: string;
  dataset?: Record<string, string>;
  disabled?: boolean;
  hidden?: boolean;
  isConnected?: boolean;
  textContent?: string;
  className?: string;
  querySelector?: (selector: string) => TestElement | null;
  querySelectorAll?: (selector: string) => TestElement[];
  addEventListener?: (event: string, handler: () => void) => void;
  prepend?: (element: TestElement) => void;
  focus?: () => void;
}

interface ResponseLike {
  ok: boolean;
  json: () => Promise<unknown>;
}

interface RenderInput {
  assets: Array<Record<string, unknown>>;
  activeId: string | null;
  activeAsset: Record<string, unknown> | null;
  detailLoading: boolean;
  listLoading: boolean;
  pagination: Record<string, number>;
  view: string;
}

const summaries = [
  {
    id: 'cog_a', title: 'Asset A', summary: 'Summary A', stage: 'sprout', reviewState: 'pending',
    evidenceCount: 1, reuseCount: 0, updatedAt: '2026-08-03T10:00:00.000Z',
  },
  {
    id: 'cog_b', title: 'Asset B', summary: 'Summary B', stage: 'sprout', reviewState: 'pending',
    evidenceCount: 1, reuseCount: 0, updatedAt: '2026-08-03T11:00:00.000Z',
  },
];

function fullAsset(summary: typeof summaries[number], evidence: string) {
  return {
    ...summary,
    evidence: [{
      id: `ev_${summary.id}`,
      kind: 'conversation',
      summary: evidence,
      sourceLabel: 'Conversation',
      createdAt: '2026-08-03T09:30:00.000Z',
    }],
    reuseEvents: [],
    createdAt: '2026-08-03T09:00:00.000Z',
  };
}

function response(result: unknown, ok = true) {
  return { ok, json: async () => result };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function loadController(apiFetch: (url: string, options?: Record<string, unknown>) => Promise<unknown>) {
  const handlers = new Map<string, () => void>();
  const actionHandlers = new Map<string, () => void>();
  const page: TestElement = {
    innerHTML: '',
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn((selector: string) => {
      if (selector === '[data-cognition-select]') {
        return Array.from(handlers.keys()).map((id) => ({
          dataset: { cognitionSelect: id },
          addEventListener: vi.fn((_event: string, next: () => void) => { handlers.set(id, next); }),
        }));
      }
      if (selector === '[data-cognition-action]') {
        return Array.from(actionHandlers.keys()).map((action) => ({
          dataset: { cognitionAction: action },
          disabled: false,
          isConnected: true,
          addEventListener: vi.fn((_event: string, next: () => void) => { actionHandlers.set(action, next); }),
        }));
      }
      return [];
    }),
    prepend: vi.fn(),
  };
  const renders: RenderInput[] = [];
  const windowObject: Record<string, unknown> = {
    apiFetch,
    CognitionPages: {
      renderCognitionPage(input: RenderInput) {
        renders.push(input);
        handlers.clear();
        for (const item of input.assets || []) handlers.set(item.id, () => {});
        actionHandlers.clear();
        if (input.activeAsset) actionHandlers.set('defer', () => {});
        return '<rendered />';
      },
      renderCognitionCapture: () => '',
    },
    addEventListener: vi.fn(),
  };
  windowObject.window = windowObject;
  const sandbox: Record<string, unknown> = {
    window: windowObject,
    document: {
      activeElement: null,
      body: { appendChild: vi.fn() },
      getElementById: (id: string) => id === 'cognition-page' ? page : null,
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({ firstElementChild: null })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    t: (key: string) => key,
    encodeURIComponent,
    Map,
    Set,
    Array,
    Number,
    Math,
    Error,
    String,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'cognition.js' });
  return {
    renderPage: windowObject.renderCognitionPage as () => void,
    select(id: string) {
      const handler = handlers.get(id);
      if (!handler) throw new Error(`missing selection handler: ${id}`);
      handler();
    },
    act(action: string) {
      const handler = actionHandlers.get(action);
      if (!handler) throw new Error(`missing action handler: ${action}`);
      handler();
    },
    renders,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('cognition renderer controller', () => {
  it('loads paginated summaries first and then fetches the selected detail', async () => {
    const apiFetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/cognition/assets/page?')) {
        return response({ page: { items: [summaries[0]], page: 1, pageSize: 50, total: 1, totalPages: 1 } });
      }
      if (url === '/api/cognition/assets/cog_a') return response({ asset: fullAsset(summaries[0], 'Evidence A') });
      throw new Error(`unexpected url: ${url}`);
    });
    const controller = loadController(apiFetch);

    controller.renderPage();
    await flush();

    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/cognition/assets/page?page=1&pageSize=50',
      '/api/cognition/assets/cog_a',
    ]);
    const finalRender = controller.renders.at(-1);
    expect(finalRender?.assets).toEqual([summaries[0]]);
    expect(finalRender?.activeAsset?.evidence[0].summary).toBe('Evidence A');
  });

  it('falls back to the legacy full list only when the page channel is unavailable', async () => {
    const legacy = fullAsset(summaries[0], 'Legacy evidence');
    const apiFetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/cognition/assets/page?')) {
        return response({ ok: false, error: 'unknown channel: cognition.assets.page' }, false);
      }
      if (url === '/api/cognition/assets') return response({ assets: [legacy] });
      throw new Error(`unexpected url: ${url}`);
    });
    const controller = loadController(apiFetch);

    controller.renderPage();
    await flush();

    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/cognition/assets/page?page=1&pageSize=50',
      '/api/cognition/assets',
    ]);
    expect(controller.renders.at(-1)?.activeAsset?.evidence[0].summary).toBe('Legacy evidence');
  });

  it('does not mask a real page failure by loading the legacy full list', async () => {
    const apiFetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/cognition/assets/page?')) {
        return response({ ok: false, error: 'cognition storage unavailable' }, false);
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const controller = loadController(apiFetch);

    controller.renderPage();
    await flush();

    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/cognition/assets/page?page=1&pageSize=50',
    ]);
  });

  it('ignores a stale detail response after the user selects another asset', async () => {
    const detailA = deferred<ResponseLike>();
    const detailB = deferred<ResponseLike>();
    const apiFetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/cognition/assets/page?')) {
        return response({ page: { items: summaries, page: 1, pageSize: 50, total: 2, totalPages: 1 } });
      }
      if (url === '/api/cognition/assets/cog_a') return detailA.promise;
      if (url === '/api/cognition/assets/cog_b') return detailB.promise;
      throw new Error(`unexpected url: ${url}`);
    });
    const controller = loadController(apiFetch);
    controller.renderPage();
    await flush();

    controller.select('cog_b');
    await flush();
    detailB.resolve(response({ asset: fullAsset(summaries[1], 'Evidence B') }));
    await flush();
    detailA.resolve(response({ asset: fullAsset(summaries[0], 'Late evidence A') }));
    await flush();

    const finalRender = controller.renders.at(-1);
    expect(finalRender?.activeId).toBe('cog_b');
    expect(finalRender?.activeAsset?.id).toBe('cog_b');
    expect(finalRender?.activeAsset?.evidence[0].summary).toBe('Evidence B');
  });

  it('refetches cached detail when state metadata and counts change independently at the same timestamp', async () => {
    const stateChangedSummary = {
      ...summaries[0],
      stage: 'growing',
      reviewState: 'invalidated',
      invalidation: {
        at: '2026-08-03T10:30:00.000Z',
        reason: 'content_changed',
        previousRecordId: 'memory_old',
      },
    };
    const countChangedSummary = {
      ...stateChangedSummary,
      evidenceCount: 2,
      reuseCount: 1,
    };
    const countChangedAsset = {
      ...fullAsset(countChangedSummary, 'Updated evidence A'),
      evidence: [
        ...fullAsset(countChangedSummary, 'Updated evidence A').evidence,
        {
          id: 'ev_cog_a_2',
          kind: 'manual',
          summary: 'Additional evidence A',
          sourceLabel: 'Manual review',
          createdAt: '2026-08-03T10:15:00.000Z',
        },
      ],
      reuseEvents: [{
        id: 'reuse_cog_a_1',
        sourceLabel: 'Follow-up conversation',
        createdAt: '2026-08-03T10:20:00.000Z',
      }],
    };
    let pageFetchCount = 0;
    let detailFetchCount = 0;
    const apiFetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/cognition/assets/page?')) {
        pageFetchCount += 1;
        const item = [summaries[0], stateChangedSummary, countChangedSummary][pageFetchCount - 1];
        return response({ page: { items: [item], page: 1, pageSize: 50, total: 1, totalPages: 1 } });
      }
      if (url === '/api/cognition/assets/cog_a') {
        detailFetchCount += 1;
        const asset = [
          fullAsset(summaries[0], 'Initial evidence A'),
          fullAsset(stateChangedSummary, 'State-updated evidence A'),
          countChangedAsset,
        ][detailFetchCount - 1];
        return response({ asset });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const controller = loadController(apiFetch);

    controller.renderPage();
    await flush();
    controller.renderPage();
    await flush();
    controller.renderPage();
    await flush();

    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/cognition/assets/page?page=1&pageSize=50',
      '/api/cognition/assets/cog_a',
      '/api/cognition/assets/page?page=1&pageSize=50',
      '/api/cognition/assets/cog_a',
      '/api/cognition/assets/page?page=1&pageSize=50',
      '/api/cognition/assets/cog_a',
    ]);
    expect(stateChangedSummary.updatedAt).toBe(summaries[0].updatedAt);
    expect(countChangedSummary.updatedAt).toBe(summaries[0].updatedAt);
    expect(controller.renders.at(-1)?.activeAsset).toMatchObject({
      stage: 'growing',
      reviewState: 'invalidated',
      invalidation: { reason: 'content_changed', previousRecordId: 'memory_old' },
    });
    expect(controller.renders.at(-1)?.activeAsset?.evidence).toHaveLength(2);
    expect(controller.renders.at(-1)?.activeAsset?.reuseEvents).toHaveLength(1);
  });

  it('moves a mutated asset to the bounded first page before reloading that valid page', async () => {
    const pageItems = Array.from({ length: 50 }, (_, index) => ({
      id: `cog_${index + 1}`,
      title: `Asset ${index + 1}`,
      summary: `Summary ${index + 1}`,
      stage: 'sprout',
      reviewState: 'pending',
      evidenceCount: 1,
      reuseCount: 0,
      updatedAt: `2026-08-03T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    }));
    let pageFetchCount = 0;
    const apiFetch = vi.fn(async (url: string, options?: Record<string, unknown>) => {
      if (url.startsWith('/api/cognition/assets/page?')) {
        pageFetchCount += 1;
        const items = pageFetchCount === 1
          ? pageItems
          : [{
              ...pageItems[0], reviewState: 'deferred', updatedAt: '2026-08-03T23:59:59.000Z',
            }, ...pageItems.slice(1)];
        return response({ page: { items, page: 1, pageSize: 50, total: 51, totalPages: 2 } });
      }
      if (url === '/api/cognition/assets/cog_1' && !options) {
        return response({ asset: fullAsset(pageItems[0], 'Evidence before mutation') });
      }
      if (url === '/api/cognition/assets/cog_1/defer') {
        return response({
          asset: {
            ...fullAsset({
              ...pageItems[0], reviewState: 'deferred', updatedAt: '2026-08-03T23:59:59.000Z',
            }, 'Evidence after mutation'),
          },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const controller = loadController(apiFetch);
    controller.renderPage();
    await flush();

    controller.act('defer');
    await flush();

    expect(pageFetchCount).toBe(2);
    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/cognition/assets/page?page=1&pageSize=50',
      '/api/cognition/assets/cog_1',
      '/api/cognition/assets/cog_1/defer',
      '/api/cognition/assets/page?page=1&pageSize=50',
    ]);
    const mutationRender = controller.renders.findLast((input) =>
      input.activeAsset?.reviewState === 'deferred' && input.listLoading === true);
    expect(mutationRender?.assets).toHaveLength(50);
    expect(mutationRender?.assets[0]).toMatchObject({
      id: 'cog_1', reviewState: 'deferred', updatedAt: '2026-08-03T23:59:59.000Z',
    });
    expect(mutationRender?.pagination).toMatchObject({ page: 1, pageSize: 50, total: 51, totalPages: 2 });
  });
});
