import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const buttonSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/ui-button.js'), 'utf8');
const formSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/ui-form.js'), 'utf8');
const cardSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/ui-card.js'), 'utf8');
const statusSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/ui-status.js'), 'utf8');
const iconSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/icons.js'), 'utf8');
const tabsSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/ui-tabs.js'), 'utf8');
const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/settings.js'), 'utf8');
function setup(settings = { autoApproval: false }) {
  const confirmUser = vi.fn().mockResolvedValue(true);
  const updateCaptureSettings = vi.fn().mockResolvedValue(undefined);
  const NS: any = {
    T: (_key: string, fallback: string, args: Record<string, string> = {}) => fallback.replace(/\{([^}]+)\}/g, (_match, key) => args[key] ?? `{${key}}`),
    store: { captureSettings: settings, captureCapabilities: { autoApproval: true }, captureModelError: '' },
    confirmUser, alertUser: vi.fn(), notify: vi.fn(), toast: vi.fn(), actions: { updateCaptureSettings },
    esc: (value: unknown) => String(value ?? ''),
  };
  const window = { CogAssets: NS };
  runInNewContext(iconSource, { window });
  runInNewContext(buttonSource, { window });
  runInNewContext(cardSource, { window });
  runInNewContext(statusSource, { window });
  runInNewContext(formSource, { window });
  runInNewContext(tabsSource, { window });
  runInNewContext(source, { window });
  return { NS, policy: NS.assetSettings, confirmUser, updateCaptureSettings };
}

describe('资产设置真实状态', () => {
  it('读取失败与从未运行区分；扫描排队不能冒充已发现建议', () => {
    const { policy } = setup();
    expect(policy.discoveryStatus(null).state).toBe('unknown');
    expect(policy.discoveryStatus({ sweep: {} }).state).toBe('never');
    const state = policy.discoveryStatus({ sweep: { lastResult: { finishedAt: '2026-10-11T02:00:00Z', scanned: 4, queued: 3, deferred: 1, failed: 0 } } });
    expect(state).toMatchObject({ state: 'completed', scanned: 4, queued: 3, deferred: 1 });
    expect(state).not.toHaveProperty('suggestions');
    expect(policy.discoveryStatus({ sweep: { lastResult: { error: 'network error', failed: 1 } } }).state).toBe('failed');
    expect(policy.discoveryStatus({ sweep: {} }, 'timeout').state).toBe('unknown');
  });
});

const viewsSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf8');
let lastSettingsNS: any = null;
function settingsHtml(patch: Record<string, unknown> = {}) {
  const { NS } = setup();
  Object.assign(NS.store, {
    captureModel: { channel: 'cli', available: true }, captureStats: { sweep: {} },
    legacyMemoryMigration: { preview: { items: [], sources: {} } },
    legacyScopedMemoryMigration: { preview: { items: [], sources: [] } },
  }, patch);
  NS.esc = (value: unknown) => String(value ?? '');
  NS.fmtDate = NS.esc;
  const window = {
    CogAssets: NS,
    uiSelect: (options: any) => `<select id="${options.id}"${options.disabled ? ' disabled' : ''}>${options.options.map((item: any) => `<option value='${item.value}'>${item.label}</option>`).join('')}</select>`,
    uiButton: (options: any) => `<button data-act="${options.attrs?.['data-act'] || ''}"${options.className ? ` class="${options.className}"` : ''}${options.attrs?.['aria-label'] ? ` aria-label="${options.attrs['aria-label']}"` : ''}${options.disabled ? ' disabled' : ''}>${options.label}</button>`,
    uiSwitch: (options: any) => `<button role="switch" data-act="${options.attrs?.['data-act']}"${options.disabled ? ' disabled' : ''}></button>`,
    uiAccordion: (options: any) => options.items.map((item: any) => `<details${item.open ? ' open' : ''}>${item.title}${item.meta || ''}${item.bodyHtml}</details>`).join(''),
    uiCard: (options: any) => `<section class="${options.className || ''}"${options.attrs?.id ? ` id="${options.attrs.id}"` : ''}${options.attrs?.tabindex ? ` tabindex="${options.attrs.tabindex}"` : ''}>${options.bodyHtml || ''}</section>`,
    uiStatusPill: (options: any) => `<span role="status">${options.label}</span>`,
    uiProgressBar: (options: any) => `<div role="progressbar" aria-label="${options.ariaLabel}" aria-valuenow="${options.value}" aria-valuemax="${options.max}"></div>`,
  };
  runInNewContext(iconSource, { window });
  runInNewContext(buttonSource, { window });
  runInNewContext(cardSource, { window });
  runInNewContext(statusSource, { window });
  runInNewContext(formSource, { window });
  runInNewContext(tabsSource, { window });
  runInNewContext(source, { window });
  runInNewContext(viewsSource.replace('NS.render = render;', 'NS.__settingsView = viewOrganizeSettingsPage; NS.render = render;'), { window });
  lastSettingsNS = NS;
  return NS.__settingsView();
}

describe('资产设置只承接夜间发现', () => {
  it('提供夜间开关和模型顺序，不支持自动确认的运行版本禁用开关', () => {
    const html = settingsHtml({ captureSettings: { enabled: true, nightlyStart: '01:00', nightlyEnd: '05:00' }, captureCapabilities: null,
      legacyMemoryMigration: { preview: { items: [{ id: 'legacy' }], sources: {} } } });
    expect(html).toContain('data-act="nightly-toggle"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-act="auto-approval-toggle"/);
    for (const action of ['auto-approval-boundary', 'run-maintenance', 'open-cleanup']) expect(html).not.toContain(`data-act="${action}"`);
    expect(html).toContain('查看已处理');
    expect(html).not.toContain('旧记忆迁移');
  });
  it('页面顺序为夜间发现、最近运行、自动确认、运行设置，窗口与模型常驻可见', () => {
    const html = settingsHtml({ captureSettings: { enabled: true } });
    const discoveryStart = html.indexOf('id="ca-settings-organize"');
    const receiptStart = html.indexOf('id="ca-settings-recent-run"');
    const runStart = html.indexOf('id="ca-settings-run"');
    expect(discoveryStart).toBeGreaterThan(-1);
    expect(receiptStart).toBeGreaterThan(discoveryStart);
    expect(runStart).toBeGreaterThan(receiptStart);
    expect(html.indexOf('自动确认')).toBeGreaterThan(receiptStart);
    expect(html.indexOf('自动确认')).toBeLessThan(runStart);
    const discovery = html.slice(discoveryStart, receiptStart);
    expect(discovery).toContain('data-act="nightly-toggle"');
    expect(discovery).toContain('data-act="nightly-scan-now"');
    expect(discovery).toContain('class="ca-run-strip"');
    expect(discovery).toContain('data-act="go-run-settings"');
    expect(discovery).toContain('下次自动运行');
    expect(discovery).not.toContain('<details');
    expect(discovery).not.toContain('data-window-field');
    expect(html).not.toContain('data-settings-disclosure');
    const run = html.slice(runStart);
    expect(run).toContain('data-window-field="start"');
    expect(run).toContain('data-window-field="end"');
    expect(run).toContain('data-window-duration');
    expect(run).toContain('data-window-next');
    expect(run).toContain('模型顺序');
    expect(run).toContain('data-act="nightly-model-add"');
    const windowPanel = run.slice(run.indexOf('data-settings-window'), run.indexOf('data-settings-models'));
    const windowHead = windowPanel.slice(0, windowPanel.indexOf('class="ca-run-lines"'));
    const windowLines = windowPanel.slice(windowPanel.indexOf('class="ca-run-lines"'));
    expect(windowHead).toContain('每日运行窗口');
    expect(windowLines).toContain('每天运行一次');
    expect(windowLines).toContain('时区跟随系统');
    expect(windowLines).toContain('共');
    expect(windowLines).toContain('data-window-duration>4 小时');
    expect(windowLines).toContain('下次运行');
    expect(windowLines).toContain('待核对');
    expect(windowLines).toContain('data-act="nightly-window-reset"');
    expect(windowLines).toContain('data-act="nightly-window-save"');
    expect(settingsHtml({ captureSettings: { enabled: false } }))
      .toMatch(/<button[^>]*disabled[^>]*data-act="nightly-scan-now"/);
    const running = settingsHtml({
      captureSettings: { enabled: true },
      captureStats: { sweep: { lastResult: { finishedAt: '2026-10-14T02:00:00Z', scanned: 2, queued: 0, failed: 0 } }, runtime: { running: true, startedAt: '2026-10-14T02:00:00Z' } },
    });
    expect(running).toContain('扫描中…');
    expect(running).toMatch(/<button[^>]*disabled[^>]*data-act="nightly-scan-now"/);
    expect(running).toContain('data-act="nightly-scan-stop"');
    expect(running).toContain('本轮进度');
  });
  it('模型授权未完成和通道不可用也不展示旧配置提醒', () => {
    for (const captureModel of [{ channel: 'unavailable', authorizationRequired: true }, { channel: 'api', configured: false }, { channel: 'cli', available: false }]) {
      const html = settingsHtml({ captureModel });
      for (const text of ['ca-settings-model', '模型状态', '授权', 'API', 'CLI', '去应用设置']) expect(html).not.toContain(text);
      expect(html).toContain('nightly-toggle');
    }
  });
  it('关闭和读取失败如实显示，模型配置提醒彻底下线', () => {
    expect(settingsHtml({ captureSettings: { enabled: false } })).toContain('已暂停');
    const html = settingsHtml({ captureModelError: 'timeout', captureStatsError: 'timeout' });
    for (const text of ['ca-settings-model', '模型状态', '模型未配置', '授权', 'API', 'CLI', '去应用设置']) expect(html).not.toContain(text);
    expect(html).toContain('状态暂时无法读取');
    expect(html).not.toContain('data-act="refresh"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-act="nightly-toggle"/);
    const failed = settingsHtml({ captureStats: { sweep: { lastResult: { error: 'interrupted', scanned: 4, queued: 0, failed: 0 } } } });
    expect(failed).toContain('本轮扫描未全部完成');
    expect(failed).not.toContain('失败 0 场');
    expect(failed).not.toContain('data-act="capture-action"');
  });
});

const partialStats = () => ({
  window: { state: 'completed', nextRunAt: '2026-10-30T02:00:00.000Z' },
  runtime: { running: false },
  sweep: {
    trigger: 'scheduled',
    phase: 'partial_complete',
    lastResult: {
      finishedAt: '2026-10-29T02:03:00Z', scanned: 12, queued: 5, failed: 1, deferred: 0,
      reconcile: { superseded: 1, related: 1 },
      inspection: {
        scanned: 18, findings: 2, duplicate: 1, conflict: 1, outdated: 0, skippedClaimed: 3,
        coverage: { evaluated: 18, total: 40, remaining: 22, unavailable: 2 },
      },
    },
    receipt: {
      runId: 'run-1', candidateIds: ['a', 'b', 'c'], items: [
        { captureId: 'c1', conversationId: 'x', status: 'completed', candidateIds: ['a'] },
        { captureId: 'c2', conversationId: 'y', status: 'failed', errorCode: 'invalid_model_output', candidateIds: [] },
        { captureId: 'c3', conversationId: 'z', status: 'pending', candidateIds: [] },
      ],
    },
    stock: { checked: 18, total: 40, proposed: 2, saved: 1, noChange: 15, insufficient: 0, remaining: 21, items: {} },
  },
});

describe('最近运行的结果卡', () => {
  it('部分完成显示横幅、四项指标与页签，概览汇总本轮数字', () => {
    const html = settingsHtml({ captureSettings: { enabled: true }, captureStats: partialStats() });
    expect(html).toContain('ca-run-banner is-warn');
    expect(html).toContain('本轮未全部完成');
    expect(html).toContain('class="ca-run-metrics"');
    expect(html).toMatch(/class="ca-run-metric is-bad"><b>1<\/b>/);
    expect(html).toContain('<b>12</b>');
    expect(html).toContain('<b>3</b>');
    expect(html).toContain('data-settings-run-tabs');
    expect(html).toContain('id="ca-run-tab-overview"');
    expect(html).toContain('id="ca-run-tab-failures"');
    expect(html).toContain('形成 3 条建议');
    expect(html).toContain('存量整理检查 18/40，保存 1 条');
    expect(html).toContain('取代 1 条旧建议，关联 1 条到已有内容');
    expect(html).toContain('自动运行');
    // 时间·触发随标题同行（2026-11-06），不再独占一行 hint。
    expect(html).toMatch(/class="tt">最近运行<span class="ca-setting-head-hint">[^<]*· (?:手动|自动)运行<\/span><\/div>/);
    expect(html).toContain('data-act="go-run-review"');
  });
  it('页签切换只换面板并保留选择，失败页签给出阶段与原因', () => {
    settingsHtml({ captureSettings: { enabled: true }, captureStats: partialStats() });
    lastSettingsNS.assetSettings.setRunTab('failures');
    const failures = lastSettingsNS.__settingsView();
    expect(failures).toContain('id="ca-run-pane"');
    expect(failures).toContain('模型结果无法识别');
    expect(failures).toContain('对话处理');
    expect(failures).toContain('已保留建议');
    expect(failures).not.toContain('本轮没有失败项');
    lastSettingsNS.assetSettings.setRunTab('existing');
    const existing = lastSettingsNS.__settingsView();
    expect(existing).toContain('巡检已有认知与本体');
    expect(existing).toContain('提出整理');
    expect(existing).toContain('18/40');
    lastSettingsNS.assetSettings.setRunTab('conversations');
    const conversations = lastSettingsNS.__settingsView();
    expect(conversations).toContain('class="ca-run-table"');
    expect(conversations).not.toContain('本轮没有逐条对话记录');
    lastSettingsNS.assetSettings.setRunTab('bogus');
    expect(lastSettingsNS.__settingsView()).toContain('class="ca-run-table"');
  });
  it('从未运行只显示空态与下次运行，运行中不冒充完成结果', () => {
    const empty = settingsHtml({ captureSettings: { enabled: true } });
    expect(empty).toContain('还没有运行记录');
    expect(empty).not.toContain('class="ca-run-metrics"');
    expect(empty).not.toContain('data-settings-run-tabs');
    const running = settingsHtml({
      captureSettings: { enabled: true },
      captureStats: {
        sweep: { phase: 'discovery', discovery: { ranges: 3, queued: 1 }, receipt: { runId: 'run-2', candidateIds: [], items: [
          { captureId: 'c1', conversationId: 'x', status: 'pending', candidateIds: [] },
          { captureId: 'c2', conversationId: 'y', status: 'pending', candidateIds: [] },
        ] } },
        runtime: { running: true, startedAt: '2026-10-29T02:00:00Z' },
        window: { state: 'running' },
      },
    });
    expect(running).toContain('本轮进度');
    expect(running).toContain('正在检查对话 0/2');
    expect(running).not.toContain('data-settings-run-tabs');
  });
});

describe('每日运行窗口校验', () => {
  const rootFor = (start: string, end: string) => ({
    querySelector: (selector: string) => selector.includes('start') ? { value: start }
      : selector.includes('end') ? { value: end } : null,
  });
  it('起止相同、格式错误不保存；合法时间保存并恢复默认', async () => {
    const { NS, policy, updateCaptureSettings } = setup({ enabled: true, nightlyStart: '02:00', nightlyEnd: '06:00' });
    NS.store.captureStats = { window: { state: 'scheduled', withinWindow: false, nextRunAt: '2026-10-28T02:00:00.000Z' } };

    await policy.windowAction('nightly-window-save', null, rootFor('02:00', '02:00'));
    expect(updateCaptureSettings).not.toHaveBeenCalled();
    expect(NS.toast).not.toHaveBeenCalled();
    expect(policy.windowControls()).toContain('aria-invalid="true"');
    expect(policy.windowControls()).toContain('aria-describedby="ca-window-error"');

    await policy.windowAction('nightly-window-save', null, rootFor('2:00', '06:00'));
    expect(updateCaptureSettings).not.toHaveBeenCalled();

    await policy.windowAction('nightly-window-save', null, rootFor('22:00', '06:00'));
    expect(updateCaptureSettings).toHaveBeenCalledWith({ nightlyStart: '22:00', nightlyEnd: '06:00' }, { silent: true });
    expect(NS.toast).toHaveBeenCalledWith('已保存，下一轮生效。', 'success');

    updateCaptureSettings.mockClear();
    await policy.windowAction('nightly-window-reset', null, rootFor('22:00', '06:00'));
    expect(updateCaptureSettings).toHaveBeenCalledWith({ nightlyStart: '02:00', nightlyEnd: '06:00' }, { silent: true });
    expect(NS.toast).toHaveBeenLastCalledWith('已恢复默认，下一轮生效。', 'success');
  });
  it('跨午夜输入原样呈现，保存失败保留可读错误', async () => {
    const html = settingsHtml({ captureSettings: { enabled: true, nightlyStart: '22:00', nightlyEnd: '06:00' } });
    expect(html).toContain('value="22:00"');
    expect(html).toContain('value="06:00"');
    const { NS, policy, updateCaptureSettings } = setup({ enabled: true, nightlyStart: '22:00', nightlyEnd: '06:00' });
    updateCaptureSettings.mockRejectedValueOnce(new Error('synthetic write failure'));
    await policy.windowAction('nightly-window-save', null, rootFor('23:00', '05:00'));
    expect(NS.toast).not.toHaveBeenCalled();
    expect(policy.windowControls()).toContain('未能保存时间，请重试。');
    expect(policy.windowControls()).not.toContain('aria-invalid="true"');
  });
  it('恢复默认失败时保留输入草稿，供修改或重试', async () => {
    const { policy, updateCaptureSettings } = setup({ enabled: true, nightlyStart: '02:00', nightlyEnd: '06:00' });
    policy.windowInput({ target: { dataset: { windowField: 'start' }, value: '23:00' } });
    policy.windowInput({ target: { dataset: { windowField: 'end' }, value: '05:00' } });
    updateCaptureSettings.mockRejectedValueOnce(new Error('synthetic write failure'));
    await policy.windowAction('nightly-window-reset', null, rootFor('23:00', '05:00'));
    const html = policy.windowControls();
    expect(html).toContain('value="23:00"');
    expect(html).toContain('value="05:00"');
    expect(html).toContain('未能保存时间，请重试。');
  });
  it('设置读取失败时不显示假定的时间，也不允许保存或恢复', async () => {
    const { NS, policy, updateCaptureSettings } = setup();
    NS.store.captureSettings = null;
    NS.store.captureModelError = 'timeout';
    const html = policy.windowControls();
    expect(html).toContain('状态未知');
    expect(html).not.toContain('value="02:00"');
    expect(html).toMatch(/<input[^>]*disabled[^>]*data-window-field="start"/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-act="nightly-window-save"/);
    await policy.windowAction('nightly-window-reset', null, rootFor('02:00', '06:00'));
    expect(updateCaptureSettings).not.toHaveBeenCalled();
  });
});

describe('设置不再触发旧迁移或自动批准流程', () => {
  it('进入页面和重复变化只读取已加载的运行状态', () => {
    const { NS } = setup();
    NS.onChange = vi.fn();
    NS.store.route = { name: 'settings' };
    runInNewContext(source, { window: { CogAssets: NS } });
    expect(NS.actions.updateCaptureSettings).not.toHaveBeenCalled();
  });
});

describe('自动确认设置的真实页面闭环', () => {
  it('默认关闭；只有运行能力明确支持才允许开启，读取失败不伪装为已开启', () => {
    const defaultHtml = settingsHtml();
    expect(defaultHtml).toContain('依据完整、范围明确');
    expect(defaultHtml).toMatch(/aria-checked="false"[^>]*data-act="auto-approval-toggle"/);
    expect(defaultHtml).not.toMatch(/disabled[^>]*data-act="auto-approval-toggle"/);
    const missing = settingsHtml({ captureCapabilities: null, captureSettings: { autoApproval: true } });
    expect(missing).toMatch(/aria-checked="false"[^>]*disabled[^>]*data-act="auto-approval-toggle"/);
    expect(missing).toContain('尚不支持自动确认');
    const error = settingsHtml({ captureModelError: 'timeout', captureSettings: { autoApproval: true } });
    expect(error).toMatch(/aria-checked="false"[^>]*disabled[^>]*data-act="auto-approval-toggle"/);
    const enabled = settingsHtml({ captureSettings: { autoApproval: true } });
    expect(enabled).toMatch(/aria-checked="true"[^>]*data-act="auto-approval-toggle"/);
    expect(enabled).toContain('可在“已处理”里修改、暂停或撤回');
    expect(enabled).toContain('结构变化、冲突和不确定内容仍需你确认');
  });
  it('开启需说明确认范围，取消不写入，重复点击不会产生两次授权', async () => {
    const { NS, policy, confirmUser, updateCaptureSettings } = setup();
    let approve!: (value: boolean) => void;
    confirmUser.mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
    const first = policy.toggleAutoApproval();
    await policy.toggleAutoApproval();
    expect(confirmUser).toHaveBeenCalledOnce();
    expect(confirmUser.mock.calls[0][0]).toContain('T 结构变化');
    expect(updateCaptureSettings).not.toHaveBeenCalled();
    approve(false);
    await first;
    expect(updateCaptureSettings).not.toHaveBeenCalled();
    await policy.toggleAutoApproval();
    expect(updateCaptureSettings).toHaveBeenCalledOnce();
    expect(updateCaptureSettings).toHaveBeenCalledWith({ autoApproval: true });
    expect(NS.store.captureSettings.autoApproval).toBe(false);
  });
  it('关闭直接保存，保存失败维持后端已确认的值并恢复可重试状态', async () => {
    const { NS, policy, confirmUser, updateCaptureSettings } = setup({ autoApproval: true });
    updateCaptureSettings.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(policy.toggleAutoApproval()).rejects.toThrow('disk unavailable');
    expect(NS.store.captureSettings.autoApproval).toBe(true);
    expect(confirmUser).not.toHaveBeenCalled();
    await policy.toggleAutoApproval();
    expect(updateCaptureSettings).toHaveBeenLastCalledWith({ autoApproval: false });
    expect(updateCaptureSettings).toHaveBeenCalledTimes(2);
  });
  it('后端没有返回所请求的设置时不冒充保存成功', async () => {
    const { loadCognitionAssets } = await import('./helpers/cognition-renderer');
    const invoke = vi.fn().mockResolvedValue({ ok: true, settings: { autoApproval: false } });
    const toast = vi.fn();
    const loaded = loadCognitionAssets({ captureSettings: { autoApproval: false } }, {}, { cogseed: { invoke }, uiToast: toast });
    await expect(loaded.ns.actions.updateCaptureSettings({ autoApproval: true })).rejects.toThrow('有效保存结果');
    expect(loaded.store.captureSettings.autoApproval).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});

function modelSettingsHarness() {
  const { NS } = setup({ enabled: true, modelCandidates: [] } as any);
  NS.store.route = { name: 'settings' };
  NS.esc = (value: unknown) => String(value ?? '');
  let models = [
    { provider: 'cp:one', model: 'first', label: 'One · First', available: true, configured: true },
    { provider: 'cp:one', model: 'second', label: 'One · Second', available: true, configured: true },
    { provider: 'expired', model: 'gone', label: 'Expired · Gone', available: false, configured: true },
  ];
  const invoke = vi.fn(async () => ({ ok: true, modelSelection: { configured: models } }));
  let modal: any;
  const focus = vi.fn();
  const root = { querySelector: () => ({ focus }) };
  const events: Record<string, () => void> = {};
  const window = {
    CogAssets: NS, cogseed: { invoke },
    addEventListener: (name: string, handler: () => void) => { events[name] = handler; },
    uiModal: vi.fn((options: any) => {
      let resolveModal: (value: unknown) => void;
      const body = { innerHTML: options.bodyHtml };
      const heading = { textContent: '' };
      const close = { setAttribute: vi.fn() };
      let onClick: (event: any) => Promise<void>;
      const dialog = {
        querySelector: (selector: string) => selector === '.ui-modal__body' ? body : selector === '.ui-modal__title' ? heading : selector === '[data-ui-modal-close]' ? close : null,
        querySelectorAll: () => [],
        addEventListener: (_name: string, handler: any) => { onClick = handler; }, removeEventListener: vi.fn(), focus: vi.fn(),
      };
      modal = Object.assign(new Promise(resolve => { resolveModal = resolve; }), {
        dialog, body, options, close: vi.fn(() => resolveModal(null)),
        choose: (provider: string, model: string, disabled = false) => onClick({ target: { closest: () => ({ dataset: { modelKey: JSON.stringify([provider, model]) }, disabled }) } }),
      });
      return modal;
    }),
  };
  runInNewContext(iconSource, { window });
  runInNewContext(buttonSource, { window });
  runInNewContext(cardSource, { window });
  runInNewContext(statusSource, { window });
  runInNewContext(source, { window });
  NS.actions.updateCaptureSettings.mockImplementation(async (patch: any) => { Object.assign(NS.store.captureSettings, patch); });
  return { NS, policy: NS.assetSettings, invoke, root, focus, events,
    models: () => models, setModels: (next: typeof models) => { models = next; },
    modal: () => modal,
    open: () => NS.assetSettings.modelAction('nightly-model-add', { dataset: {} }, root),
    act: (action: string, index = 0) => NS.assetSettings.modelAction(action, { dataset: { index: String(index) } }, root),
  };
}

describe('夜间模型条目与选择弹窗', () => {
  it('默认只显示首个模型及末尾添加行；弹窗只使用后端配置列表', async () => {
    const h = modelSettingsHarness();
    await h.policy.loadModels();
    const html = h.policy.modelControls();
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('recall.captures.settings.get', {});
    expect(html).toContain('拖动模型行可调整顺序');
    expect(html).toContain('<strong>First</strong>');
    expect(html).not.toContain('<strong>Second</strong>');
    expect(html).not.toContain('<strong>Gone</strong>');
    expect(html.indexOf('添加模型')).toBeGreaterThan(html.indexOf('<strong>First</strong>'));
    expect(html).not.toContain('<select');
    expect(html).not.toContain('设为首选模型');
    for (const act of ['nightly-model-up', 'nightly-model-down', 'nightly-model-remove', 'nightly-model-reset']) expect(html).not.toContain(`data-act="${act}"`);
    const opened = h.open();
    expect(h.modal().body.innerHTML).toContain('已添加');
    expect(h.modal().body.innerHTML).toContain('One · Second');
    expect(h.modal().body.innerHTML).toContain('系统配置中已停用或移除');
    await h.modal().choose('cp:one', 'first');
    await h.modal().choose('expired', 'gone');
    expect(h.NS.actions.updateCaptureSettings).not.toHaveBeenCalled();
    await h.modal().choose('cp:one', 'second');
    await opened;
    expect(h.NS.store.captureSettings.modelCandidates).toEqual([{ provider: 'cp:one', model: 'first' }, { provider: 'cp:one', model: 'second' }]);
    expect(h.focus).toHaveBeenCalled();
    expect(h.policy.modelControls()).toContain('备用 1');
  });
  it('模型列表与添加入口分开，弹窗以独立模型名、供应商和右侧状态呈现', async () => {
    const h = modelSettingsHarness(); await h.policy.loadModels();
    const html = h.policy.modelControls();
    expect(html.match(/class="ca-model-row"/g)).toHaveLength(1);
    expect(html).toContain('<strong>First</strong>');
    expect(html).toContain('<span>One</span>');
    expect(html).toContain('data-act="nightly-model-add"');
    const opened = h.open();
    expect(h.modal().options.size).toBe('md');
    const body = h.modal().body.innerHTML;
    expect(body).toContain('ui-status-pill--success');
    expect(body).toContain('已添加');
    expect(body).toContain('class="ca-nightly-model-name">First</strong>');
    const buttons = body.match(/<button[^>]*>/g) || [];
    expect(buttons).toHaveLength(1); // Added and unavailable entries remain readable, without a disabled button wash.
    expect(buttons[0]).toContain('data-model-key=');
    expect(buttons[0]).toContain('second');
    h.modal().close(); await opened;
  });
  it('保存失败保留弹窗及原列表，重试成功；并发点击只保存一次', async () => {
    const h = modelSettingsHarness(); await h.policy.loadModels();
    h.NS.actions.updateCaptureSettings.mockRejectedValueOnce(new Error('disk unavailable'));
    const opened = h.open();
    await h.modal().choose('cp:one', 'second');
    expect(h.modal().body.innerHTML).toContain('未能保存模型列表');
    expect(h.modal().close).not.toHaveBeenCalled();
    expect(h.NS.store.captureSettings.modelCandidates).toEqual([]);
    let finish: () => void;
    h.NS.actions.updateCaptureSettings.mockImplementationOnce(async (patch: any) => {
      await new Promise<void>(resolve => { finish = resolve; });
      Object.assign(h.NS.store.captureSettings, patch);
    });
    const save = h.modal().choose('cp:one', 'second');
    await h.modal().choose('cp:one', 'second');
    expect(h.NS.actions.updateCaptureSettings).toHaveBeenCalledTimes(2);
    expect(h.modal().body.innerHTML).toContain('aria-busy="true"');
    finish!(); await save; await opened;
    expect(h.NS.store.captureSettings.modelCandidates).toHaveLength(2);
  });
  it('默认随系统首个变化，自定义顺序不被刷新覆盖，并可排序、删除及恢复', async () => {
    const h = modelSettingsHarness(); await h.policy.loadModels();
    h.setModels([...h.models()].reverse()); await h.policy.loadModels(true);
    expect(h.policy.modelControls()).toContain('<strong>Gone</strong>');
    expect(h.policy.modelControls()).toContain('系统配置中已停用或移除');
    h.NS.store.captureSettings.modelCandidates = [{ provider: 'cp:one', model: 'first' }, { provider: 'cp:one', model: 'second' }];
    await h.policy.loadModels(true);
    expect(h.policy.modelControls()).not.toContain('<strong>Gone</strong>');
    const html = h.policy.modelControls();
    expect(html).toContain('aria-label="拖动或按上下键调整 Second 顺序"');
    expect(html).not.toContain('data-act="nightly-model-up"');
    expect(html).not.toContain('data-act="nightly-model-down"');
    const handle = (model: string) => ({ dataset: { modelKey: JSON.stringify(['cp:one', model]) }, disabled: false });
    const key = (model: string, keyName: string) => ({ key: keyName, target: { closest: () => handle(model) }, preventDefault: vi.fn() });
    await h.policy.modelSortKeydown(key('second', 'ArrowUp'), h.root);
    expect(h.NS.store.captureSettings.modelCandidates[0].model).toBe('second');
    await h.policy.modelSortKeydown(key('second', 'ArrowDown'), h.root);
    expect(h.NS.store.captureSettings.modelCandidates[0].model).toBe('first');
    await h.act('nightly-model-remove', 0); await h.act('nightly-model-remove', 0);
    expect(h.NS.store.captureSettings.modelCandidates).toEqual([]);
    expect(h.policy.modelControls()).toContain('<strong>Gone</strong>');
  });
  it('拖动排序使用目标位置，保存失败和列表变化保留原顺序', async () => {
    const h = modelSettingsHarness(); await h.policy.loadModels();
    const models = ['first', 'second', 'third'].map(model => ({ provider: 'cp:one', model }));
    h.NS.store.captureSettings.modelCandidates = models;
    const rows = models.map((_model, index) => ({ dataset: { modelSortIndex: String(index) }, draggable: true,
      classList: { add: vi.fn(), remove: vi.fn() }, getBoundingClientRect: () => ({ top: index * 100, height: 100 }) }));
    const root = { contains: () => true, querySelectorAll: (selector: string) => selector === '[data-model-sort-index]' ? rows : [] };
    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    const event = (index: number, clientY: number) => ({ target: { closest: () => rows[index] }, clientY, dataTransfer: transfer, preventDefault: vi.fn() });
    h.policy.modelDragStart(event(0, 0), root);
    await h.policy.modelDrop(event(1, 150), root);
    expect(h.NS.store.captureSettings.modelCandidates.map((item: any) => item.model)).toEqual(['second', 'first', 'third']);
    h.NS.store.captureSettings.modelCandidates = models;
    h.policy.modelDragStart(event(0, 0), root);
    const over = event(2, 290); h.policy.modelDragOver(over, root);
    expect(over.preventDefault).toHaveBeenCalledOnce();
    await h.policy.modelDrop(event(2, 290), root);
    expect(h.NS.store.captureSettings.modelCandidates.map((item: any) => item.model)).toEqual(['second', 'third', 'first']);
    h.policy.modelDragStart(event(0, 0), root);
    h.NS.actions.updateCaptureSettings.mockRejectedValueOnce(new Error('disk unavailable'));
    await h.policy.modelDrop(event(2, 290), root);
    expect(h.NS.store.captureSettings.modelCandidates.map((item: any) => item.model)).toEqual(['second', 'third', 'first']);
    expect(h.NS.alertUser).toHaveBeenCalledWith('未能保存模型列表，请重试。');
    h.policy.modelDragStart(event(0, 0), root);
    h.NS.store.captureSettings.modelCandidates = [models[0], models[1]];
    h.NS.actions.updateCaptureSettings.mockClear();
    await h.policy.modelDrop(event(1, 190), root);
    expect(h.NS.actions.updateCaptureSettings).not.toHaveBeenCalled();
  });
  it('旧目录项保留可辨认状态；读取和保存失败都不丢已保存顺序', async () => {
    const h = modelSettingsHarness();
    h.NS.store.captureSettings.modelCandidates = [{ provider: 'removed', model: 'saved' }];
    await h.policy.loadModels();
    expect(h.policy.modelControls()).toContain('已不在设置列表，保留原配置');
    h.NS.actions.updateCaptureSettings.mockRejectedValueOnce(new Error('save failed'));
    await expect(h.act('nightly-model-reset')).rejects.toThrow('save failed');
    h.invoke.mockRejectedValueOnce(new Error('offline')); await h.policy.loadModels(true);
    expect(h.policy.modelControls()).toContain('模型列表读取失败');
    expect(h.NS.store.captureSettings.modelCandidates[0].model).toBe('saved');
    await h.act('nightly-model-retry');
    expect(h.policy.modelControls()).not.toContain('模型列表读取失败');
    await h.act('nightly-model-reset');
    expect(h.NS.store.captureSettings.modelCandidates).toEqual([]);
  });
  it('弹窗打开期间支持语言及模型目录变化，取消不保存', async () => {
    const h = modelSettingsHarness(); await h.policy.loadModels();
    const opened = h.open();
    h.NS.T = (key: string) => key;
    h.events['i18n-change']();
    expect(h.modal().body.innerHTML).toContain('cognition.settings_nightly_model_added');
    h.setModels(h.models().slice(0, 1)); await h.policy.loadModels(true);
    expect(h.modal().body.innerHTML).not.toContain('One · Second');
    h.modal().close(); await opened;
    expect(h.NS.actions.updateCaptureSettings).not.toHaveBeenCalled();
  });
  it('离页修改系统模型后不复用旧快照，较早的目录响应不能覆盖较新的顺序', async () => {
    const h = modelSettingsHarness();
    h.NS.store.captureModelSelection = { configured: h.models().slice(0, 1) };
    h.NS.store.route.name = 'overview';
    h.setModels([h.models()[1]]);
    h.events['cogseed:model-entries-changed']();
    h.NS.store.route.name = 'settings';
    await h.policy.loadModels();
    expect(h.policy.modelControls()).toContain('<strong>Second</strong>');
    expect(h.policy.modelControls()).not.toContain('<strong>First</strong>');
    let finishOld: (value: unknown) => void;
    h.invoke.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }) as any);
    const old = h.policy.loadModels(true);
    await h.policy.loadModels(true);
    finishOld!({ ok: true, modelSelection: { configured: [{ provider: 'stale', model: 'old', label: 'Stale', available: true }] } });
    await old;
    expect(h.policy.modelControls()).toContain('<strong>Second</strong>');
    expect(h.policy.modelControls()).not.toContain('Stale');
  });
  it('无配置时保留真实运行来源，模型列表未确认保存不得冒充成功', async () => {
    const h = modelSettingsHarness(); h.setModels([]); await h.policy.loadModels();
    h.NS.store.captureModel = { channel: 'cli' };
    expect(h.policy.modelControls()).toContain('将使用可用的本地助手');
    h.NS.store.captureModel = { channel: 'api', apiConfigured: true };
    expect(h.policy.modelControls()).toContain('将使用环境变量配置的模型');
    const { loadCognitionAssets } = await import('./helpers/cognition-renderer');
    const invoke = vi.fn().mockResolvedValue({ ok: true, settings: { modelCandidates: [] } });
    const loaded = loadCognitionAssets({ captureSettings: { modelCandidates: [] } }, {}, { cogseed: { invoke } });
    await expect(loaded.ns.actions.updateCaptureSettings({ modelCandidates: [{ provider: 'one', model: 'first' }] })).rejects.toThrow('保存模型列表');
    expect(loaded.store.captureSettings.modelCandidates).toEqual([]);
  });
});
