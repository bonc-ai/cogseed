import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const root = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const buttonSource = read('src/renderer/modules/ui-button.js');
const formSource = read('src/renderer/modules/ui-form.js');
const cardSource = read('src/renderer/modules/ui-card.js');
const statusSource = read('src/renderer/modules/ui-status.js');
const iconSource = read('src/renderer/modules/icons.js');
const settingsSource = read('src/renderer/modules/cognition-assets/settings.js');
const viewsSource = read('src/renderer/modules/cognition-assets/views.js');

const OVERFLOW_ITEM = {
  captureId: 'capture-a',
  conversationId: 'conv-a',
  conversationTitle: '季度复盘',
  candidateIndex: 0,
  relatedAssetIds: ['asset-a', 'asset-b', 'asset-c'],
  assets: [
    { id: 'asset-a', title: '目标条目', version: '3', status: 'active', readable: true },
    { id: 'asset-b', title: '同样条目', version: '1', status: 'active', readable: true },
    { id: 'asset-c', title: '暂停条目', version: '2', status: 'paused', readable: false },
  ],
  reformation: { status: 'none' },
};

function settingsRuntime(state: Record<string, unknown> = {}) {
  const confirmUser = vi.fn().mockResolvedValue(true);
  const calls: Array<{ channel: string; payload: any }> = [];
  const api = {
    call: vi.fn(async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'recall.captures.relatedOverflow.resolve') {
        return { ok: true, alreadyResolved: false, merge: { skipped: 1 }, reformation: { status: 'running' } };
      }
      return { ok: true, runId: 'run-a', items: [] };
    }),
  };
  const NS: any = {
    T: (_key: string, fallback: string, args: Record<string, string> = {}) => fallback.replace(/\{([^}]+)\}/g, (_match, key) => args[key] ?? `{${key}}`),
    esc: (value: unknown) => String(value ?? ''),
    fmtDate: (value: unknown) => String(value ?? ''),
    store: {
      captureSettings: { enabled: true },
      captureCapabilities: { autoApproval: true },
      captureModelError: '',
      captureStats: { sweep: {} },
      relatedOverflow: { status: 'ready', runId: 'run-a', items: [OVERFLOW_ITEM], targets: {}, savingKey: '', actionErrors: {}, error: '' },
      ...state,
    },
    confirmUser, alertUser: vi.fn(), notify: vi.fn(), toast: vi.fn(),
    actions: { updateCaptureSettings: vi.fn() }, api,
  };
  const window: any = {
    CogAssets: NS,
    uiSelect: (options: any) => `<select id="${options.id}" aria-label="${options.ariaLabel}" data-overflow-target-field="${options.attrs?.['data-overflow-target-field'] ?? ''}" data-overflow-key="${options.attrs?.['data-overflow-key'] ?? ''}">${options.options.map((item: any) => `<option value='${item.value}'${item.value === options.value ? ' selected' : ''}>${item.label}</option>`).join('')}</select>`,
    uiSwitch: (options: any) => `<button role="switch" data-act="${options.attrs?.['data-act']}"${options.disabled ? ' disabled' : ''}></button>`,
    uiAccordion: (options: any) => options.items.map((item: any) => `<details>${item.title}${item.bodyHtml}</details>`).join(''),
    uiCard: (options: any) => `<section class="${options.className || ''}">${options.bodyHtml || ''}</section>`,
    uiStatusPill: (options: any) => `<span role="status">${options.label}</span>`,
    uiProgressBar: () => '',
    addEventListener: vi.fn(),
  };
  for (const source of [iconSource, buttonSource, cardSource, statusSource, formSource]) runInNewContext(source, { window });
  runInNewContext(settingsSource, { window });
  runInNewContext(viewsSource.replace('NS.render = render;', 'NS.__settingsView = viewOrganizeSettingsPage; NS.render = render;'), { window });
  return { NS, window, api, calls, confirmUser, html: () => NS.__settingsView() as string };
}

describe('资产设置：需要你决定区块', () => {
  it('列出来源名称、版本、不可读标记和共享单选/按钮入口', () => {
    const { html } = settingsRuntime();
    const page = html();
    expect(page).toContain('需要你决定');
    expect(page).toContain('ca-decision-card');
    expect(page).toContain('季度复盘');
    expect(page).toContain('目标条目');
    expect(page).toContain('v3');
    expect(page).toContain('暂停条目');
    expect(page).toContain('不可读取');
    expect(page).toContain('data-overflow-target-field');
    expect(page).toContain('合并到');
    expect(page).toContain('data-act="related-overflow-merge"');
    expect(page).toContain('data-act="related-overflow-keep"');
    expect(page).toContain('data-act="related-overflow-reload"');
    // 不可读目标不进入单选项
    expect(page).not.toContain("value='asset-c'");
  });

  it('失败的重判给重试入口，已保留项不再提供动作', () => {
    const failed = settingsRuntime({
      relatedOverflow: { status: 'ready', runId: 'run-a', savingKey: '', actionErrors: {}, targets: {}, items: [{
        ...OVERFLOW_ITEM,
        resolution: { action: 'merged', targetAssetId: 'asset-a', at: '2026-10-28T03:00:00Z' },
        reformation: { status: 'failed', error: 'reformation_not_completed' },
      }] },
    });
    const failedPage = failed.html();
    expect(failedPage).toContain('重新核对未完成');
    expect(failedPage).toContain('data-act="related-overflow-retry"');
    expect(failedPage).not.toContain('data-act="related-overflow-merge"');

    const kept = settingsRuntime({
      relatedOverflow: { status: 'ready', runId: 'run-a', savingKey: '', actionErrors: {}, targets: {}, items: [{
        ...OVERFLOW_ITEM,
        resolution: { action: 'kept', at: '2026-10-28T03:00:00Z' },
      }] },
    });
    const keptPage = kept.html();
    expect(keptPage).toContain('已保留全部');
    expect(keptPage).not.toContain('data-act="related-overflow-retry"');
    expect(keptPage).not.toContain('data-act="related-overflow-keep"');
  });

  it('合并与保留都先走共享确认，再调用处置 IPC；合并传入选中的目标', async () => {
    const runtime = settingsRuntime();
    await runtime.NS.assetSettings.relatedOverflowAction('related-overflow-merge', { dataset: { overflowKey: 'capture-a:0' } });
    expect(runtime.confirmUser).toHaveBeenCalledTimes(1);
    expect(runtime.confirmUser.mock.calls[0][0]).toContain('目标条目');
    const resolveCall = runtime.calls.find(call => call.channel === 'recall.captures.relatedOverflow.resolve');
    expect(resolveCall?.payload).toEqual({ captureId: 'capture-a', candidateIndex: 0, action: 'merge', targetAssetId: 'asset-a' });
    expect(runtime.NS.toast).toHaveBeenCalled();

    const keepRuntime = settingsRuntime();
    await keepRuntime.NS.assetSettings.relatedOverflowAction('related-overflow-keep', { dataset: { overflowKey: 'capture-a:0' } });
    expect(keepRuntime.confirmUser).toHaveBeenCalledTimes(1);
    expect(keepRuntime.confirmUser.mock.calls[0][0]).toContain('保留全部关联内容');
    expect(keepRuntime.calls.find(call => call.channel === 'recall.captures.relatedOverflow.resolve')?.payload)
      .toEqual({ captureId: 'capture-a', candidateIndex: 0, action: 'keep' });
  });

  it('取消确认时不发写请求', async () => {
    const runtime = settingsRuntime();
    runtime.confirmUser.mockResolvedValueOnce(false);
    await runtime.NS.assetSettings.relatedOverflowAction('related-overflow-merge', { dataset: { overflowKey: 'capture-a:0' } });
    expect(runtime.calls.some(call => call.channel === 'recall.captures.relatedOverflow.resolve')).toBe(false);
  });

  it('所属整理任务不能重判时不提供合并，只保留', () => {
    const runtime = settingsRuntime({
      relatedOverflow: { status: 'ready', runId: 'run-a', savingKey: '', actionErrors: {}, targets: {},
        items: [{ ...OVERFLOW_ITEM, reformable: false }] },
    });
    const page = runtime.html();
    expect(page).toContain('所属整理任务不能重新核对这项建议，只能保留全部关联内容。');
    expect(page).not.toContain('data-act="related-overflow-merge"');
    expect(page).not.toContain('data-overflow-target-field');
    expect(page).toContain('data-act="related-overflow-keep"');
  });
});

const candidate = (id: string, extra: Record<string, unknown> = {}) => ({
  id, summary: `长期建议 ${id}`, judgment: `稳定正文 ${id}`, suggestedType: 'template',
  suggestedScope: 'general', suggestedAction: 'create', status: 'pending_review',
  createdAt: '2026-10-12T01:00:00Z', value: '可用于后续任务',
  sourceRefs: [{ kind: 'conversation', subtype: 'message', id: 'source-a' }],
  captureProvenance: { pipeline: 'nightly_conversation', captureId: 'capture-a', messageIds: ['message-a'],
    extractionCompletedAt: '2026-10-12T01:00:00Z', valueJudgment: { eligible: true, reason: '可重复使用', judgedAt: '2026-10-12T00:59:00Z', evidence: [{ messageId: 'message-a', sourceId: 'source-a', quote: '这是真实来源原文' }] } },
  capabilities: { countsAsPending: true, needsUserAction: true, canEdit: true, canPromote: true, canReject: true }, ...extra,
});
const relatedComparison = { relation: 'new', reason: '与同一批关联内容有关', relatedAssets: [{ assetId: 'asset-a', version: '1' }] };
const activeAsset = (id = 'asset-a', status = 'active') => ({ id, title: '共享关联条目', version: '1', status, scope: 'general' });

describe('认知生长：create 建议的相关提示', () => {
  it('create 候选按关联资产互相提示，终态行不再提示', () => {
    const loaded = loadCognitionAssets({
      assets: [activeAsset()],
      candidates: [
        candidate('one', { formationComparison: relatedComparison }),
        candidate('two', { formationComparison: relatedComparison }),
        candidate('done', { status: 'confirmed', formationComparison: relatedComparison }),
      ],
    }, { name: 'activity' });
    const model = loaded.ns.activityModel();
    expect(model.attention.map((row: any) => row.key)).toEqual(['candidate:one', 'candidate:two']);
    expect(model.attention.find((row: any) => row.key === 'candidate:one').relatedSuggestionIds).toEqual(['candidate:two']);
    expect(model.done.find((row: any) => row.key === 'candidate:done').relatedSuggestionIds).toEqual([]);
  });

  it('不可读关联资产不产生交叉提示', () => {
    const loaded = loadCognitionAssets({
      assets: [activeAsset('asset-a', 'paused')],
      candidates: [
        candidate('one', { formationComparison: relatedComparison }),
        candidate('two', { formationComparison: relatedComparison }),
      ],
    }, { name: 'activity' });
    const model = loaded.ns.activityModel();
    expect(model.attention).toHaveLength(2);
    expect(model.attention.every((row: any) => row.relatedSuggestionIds.length === 0)).toBe(true);
  });

  it('相关提示最多 4 条且排除当前行', () => {
    const loaded = loadCognitionAssets({
      assets: [activeAsset()],
      candidates: [1, 2, 3, 4, 5, 6].map(index => candidate(`c${index}`, { formationComparison: relatedComparison })),
    }, { name: 'activity' });
    const model = loaded.ns.activityModel();
    for (const row of model.attention) {
      expect(row.relatedSuggestionIds).toHaveLength(4);
      expect(row.relatedSuggestionIds).not.toContain(row.key);
    }
  });

  it('详情对 create 建议显示可能相关提示', () => {
    const loaded = loadCognitionAssets({
      assets: [activeAsset()],
      candidates: [
        candidate('one', { formationComparison: relatedComparison }),
        candidate('two', { formationComparison: relatedComparison }),
      ],
    }, { name: 'activity', candidateId: 'one' });
    const html = loaded.render();
    expect(html).toContain('这条是新增建议，但与已有建议涉及同一批关联内容');
  });
});
