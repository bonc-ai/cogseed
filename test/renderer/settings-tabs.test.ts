import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');

class FakeClassList {
  classes = new Set<string>();

  constructor(initial: string[] = []) {
    initial.forEach((cls) => this.classes.add(cls));
  }

  contains(cls: string) {
    return this.classes.has(cls);
  }

  toggle(cls: string, force?: boolean) {
    const next = force === undefined ? !this.classes.has(cls) : force;
    if (next) this.classes.add(cls);
    else this.classes.delete(cls);
    return next;
  }
}

class FakeElement {
  dataset: Record<string, string>;
  classList: FakeClassList;
  hidden = false;
  listeners = new Map<string, Array<() => void>>();

  constructor(dataset: Record<string, string>, classes: string[] = []) {
    this.dataset = dataset;
    this.classList = new FakeClassList(classes);
  }

  addEventListener(type: string, handler: () => void) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  click() {
    for (const handler of this.listeners.get('click') || []) handler();
  }
}

function loadSettingsTabsModule() {
  const tabs = [
    new FakeElement({ settingsTab: 'data' }, ['settings-tab', 'is-active']),
    new FakeElement({ settingsTab: 'credentials' }, ['settings-tab']),
    new FakeElement({ settingsTab: 'general' }, ['settings-tab']),
  ];
  const panes = [
    new FakeElement({ settingsPane: 'data' }, ['settings-tab-pane']),
    new FakeElement({ settingsPane: 'credentials' }, ['settings-tab-pane']),
    new FakeElement({ settingsPane: 'general' }, ['settings-tab-pane']),
  ];
  panes[1].hidden = true;
  panes[2].hidden = true;

  const document = {
    querySelectorAll(selector: string) {
      if (selector === '.settings-tab') return tabs;
      if (selector === '.settings-tab-pane') return panes;
      return [];
    },
    querySelector(selector: string) {
      if (selector === '.settings-tab.is-active') {
        return tabs.find((tab) => tab.classList.contains('is-active')) || null;
      }
      return null;
    },
  };
  const context: any = { document, window: {} };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(root, 'src/renderer/modules/settings_tabs.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'settings_tabs.js' });
  return { window: context.window, tabs, panes };
}

function loadMessagingSettingsTestHooks() {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const context: any = {
    Array,
    Object,
    URL,
    clearInterval,
    clearTimeout,
    module: { exports: {} },
    window: { addEventListener, removeEventListener },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'messaging-settings.js' });
  return { hooks: context.module.exports, removeEventListener };
}

describe('settings tabs module', () => {
  it('loads tabs eagerly and loads the focused messaging settings page on demand', () => {
    const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const lazyFeatures = fs.readFileSync(path.join(root, 'src/renderer/modules/lazy-features.js'), 'utf8');
    const messagingSettings = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    const style = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');
    const modulePath = path.join(root, 'src/renderer/modules/settings_tabs.js');
    const tabsScript = '<script src="./modules/settings_tabs.js"></script>';
    const settingsScript = '<script src="./modules/settings.js"></script>';

    expect(fs.existsSync(modulePath)).toBe(true);
    expect(indexHtml).toContain('data-i18n="settings.tab.credentials">Model Providers</button>');
    expect(indexHtml).toContain('data-i18n="settings.tab.messaging">消息平台</button>');
    expect(lazyFeatures).toContain("{ src: './modules/messaging-settings.js' }");
    expect(indexHtml).toContain('id="messaging-page"');
    expect(indexHtml).not.toContain('id="messaging-catalog"');
    expect(style).toContain('.messaging-preferences-card');
    expect(style).toContain('.messaging-layout');
    expect(style).toContain('.messaging-menu');
    expect(style).toContain('.messaging-menu-group-label');
    expect(style).toContain('.messaging-menu-item.is-disabled');
    expect(style).toContain('.messaging-instance-row');
    expect(style).toContain('.messaging-instance-row.is-selected');
    expect(messagingSettings).toContain("view: 'panel'");
    expect(messagingSettings).not.toContain("view: 'catalog'");
    expect(messagingSettings).toContain('messaging.feishu_draft.create');
    expect(messagingSettings).toContain("messaging.feishu_qr.start");
    expect(messagingSettings).toContain("messaging.feishu_qr.status");
    expect(messagingSettings).toContain("messaging.feishu_qr.cancel");
    expect(lazyFeatures).toContain("./vendor/qrcode-generator/qrcode.js");
    expect(messagingSettings).toContain("instanceId: instance.id");
    expect(messagingSettings).toContain("responseMode: responseSelect.value");
    expect(messagingSettings).toContain("workspace: { type: 'all' }");
    expect(messagingSettings).not.toContain('messaging.feishu_app_id');
    expect(messagingSettings).not.toContain('messaging.feishu_app_secret');
    expect(messagingSettings).not.toContain('messaging.allow_users');
    expect(messagingSettings).not.toContain('messaging.allow_groups');
    expect(indexHtml).not.toContain('Model Authorization');
    expect(indexHtml.indexOf(tabsScript)).toBeGreaterThanOrEqual(0);
    expect(indexHtml.indexOf(settingsScript)).toBe(-1);
    expect(lazyFeatures).toContain("{ src: './modules/settings.js' }");
  });

  it('keeps the messaging layout card-based with a narrower menu and theme background', () => {
    const style = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

    expect(style).toMatch(/\.messaging-layout\s*\{[^{}]*grid-template-columns:\s*232px\s+minmax\(0,\s*1fr\);/);
    expect(style).toMatch(/\.messaging-panel-body\s*\{[^{}]*display:\s*flex;[^{}]*flex-direction:\s*column;[^{}]*gap:\s*8px;/);
    expect(style).toMatch(/\.messaging-settings-shell\s*\{[^{}]*background:\s*var\(--bg\);/);
    expect(style).toMatch(/\.messaging-page\s*\{[^{}]*background:\s*var\(--bg\);/);
    expect(style).toMatch(/\.messaging-page\s*\{[^{}]*overflow:\s*auto;/);
    expect(style).toMatch(/\.messaging-config-card\s*\{[^{}]*background:\s*var\(--surface\);/);
  });

  it('cancels an in-flight feishu QR flow when switching channels', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain('cancelQr({ silent: true, render: false })');
    expect(source).toContain('state.selectedChannel = key');
  });

  it('removes the manual App ID/Secret binding path from the Feishu panel', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).not.toContain('manualLinkSection');
    expect(source).not.toContain('linkWithCredentials');
    expect(source).not.toContain('messaging.use_existing');
    expect(source).not.toContain('renderPanelPlaceholder');
    expect(source).toContain('renderFeishuPanel');
    expect(source).toContain('renderInstanceList');
  });

  it('binds clicks and toggles the matching settings pane', () => {
    const { window, tabs, panes } = loadSettingsTabsModule();

    window.initSettingsTabs();
    tabs[1].click();

    expect(tabs[0].classList.contains('is-active')).toBe(false);
    expect(tabs[1].classList.contains('is-active')).toBe(true);
    expect(tabs[2].classList.contains('is-active')).toBe(false);
    expect(panes[0].hidden).toBe(true);
    expect(panes[1].hidden).toBe(false);
    expect(panes[2].hidden).toBe(true);
  });

  it('falls back to the first surviving tab when asked for a stripped tab', () => {
    const { window, tabs, panes } = loadSettingsTabsModule();

    window.activateSettingsTab('account');

    expect(tabs[0].classList.contains('is-active')).toBe(true);
    expect(panes[0].hidden).toBe(false);
    expect(panes[1].hidden).toBe(true);
    expect(panes[2].hidden).toBe(true);
  });

  it('keeps Feishu China and Lark Global as distinct supported channels', () => {
    const { hooks } = loadMessagingSettingsTestHooks();

    const feishu = hooks.CHANNELS.find((channel: { key: string }) => channel.key === 'feishu');
    const lark = hooks.CHANNELS.find((channel: { key: string }) => channel.key === 'lark');
    expect(feishu).toMatchObject({ platform: 'feishu_lark', feishuTenantBrand: 'feishu', group: 'open' });
    expect(lark).toMatchObject({ platform: 'feishu_lark', feishuTenantBrand: 'lark', group: 'open' });
    expect(hooks.channelForInstance({ platform: 'feishu_lark', feishuTenantBrand: 'feishu' })).toBe('feishu');
    expect(hooks.channelForInstance({ platform: 'feishu_lark', feishuTenantBrand: 'lark' })).toBe('lark');
  });

  it('exposes the full grouped channel catalog and maps every platform instance', () => {
    const { hooks } = loadMessagingSettingsTestHooks();

    expect(hooks.CHANNELS.map((channel: any) => channel.key)).toEqual([
      'feishu', 'lark', 'wecom', 'telegram', 'wechat', 'qq', 'dingtalk', 'discord',
    ]);
    const open = hooks.CHANNELS.filter((channel: any) => channel.group === 'open').map((channel: any) => channel.key);
    const soon = hooks.CHANNELS.filter((channel: any) => channel.group === 'soon').map((channel: any) => channel.key);
    expect(open).toEqual(['feishu', 'lark', 'wecom', 'telegram', 'wechat']);
    expect(soon).toEqual(['qq', 'dingtalk', 'discord']);
    for (const channel of hooks.CHANNELS) expect(typeof channel.icon).toBe('string');

    expect(hooks.channelForInstance({ id: 'a', platform: 'wecom' })).toBe('wecom');
    expect(hooks.channelForInstance({ id: 'b', platform: 'telegram' })).toBe('telegram');
    expect(hooks.channelForInstance({ id: 'c', platform: 'feishu_lark', feishuTenantBrand: 'lark' })).toBe('lark');
    expect(hooks.channelForInstance({ id: 'd', platform: 'feishu_lark', feishuTenantBrand: 'feishu' })).toBe('feishu');
    expect(hooks.channelForInstance({ id: 'e', platform: 'wechat_personal' })).toBe('wechat');
  });

  it('lists every instance of a channel instead of hiding older ones', () => {
    const { hooks } = loadMessagingSettingsTestHooks();
    hooks.__test.state.instances = [
      { id: 'old', platform: 'feishu_lark', feishuTenantBrand: 'feishu', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'new', platform: 'feishu_lark', feishuTenantBrand: 'feishu', updatedAt: '2026-08-02T00:00:00.000Z' },
    ];
    const list = hooks.__test.instancesForChannel(hooks.CHANNELS[0]);
    expect(list.map((instance: any) => instance.id)).toEqual(['new', 'old']);
  });

  it('shows the QR panel only after scan state starts and rejects lookalike QR states', () => {
    const { hooks } = loadMessagingSettingsTestHooks();
    const instance = { id: 'feishu-draft-1' };
    const qr = hooks.__test.state.qr;

    hooks.__test.resetQrState();
    expect(hooks.__test.qrIsVisibleFor(instance)).toBe(false);
    qr.instanceId = instance.id;
    expect(hooks.__test.qrIsVisibleFor(instance)).toBe(false);
    qr.starting = true;
    expect(hooks.__test.qrIsVisibleFor(instance)).toBe(true);
    expect(hooks.normalizeFeishuQrStatus({ state: 'awaiting_scan', qrUrl: 'https://example.test/qr' })).toMatchObject({
      state: 'awaiting_scan',
      qrUrl: 'https://example.test/qr',
    });
    expect(hooks.normalizeFeishuQrStatus({ state: 'completed-but-not-really' })).toMatchObject({ state: 'failed' });
    hooks.__test.resetQrState();
  });

  it('validates telegram bot tokens with the IPC token shape', () => {
    const { hooks } = loadMessagingSettingsTestHooks();
    expect(hooks.__test.validateBotToken('123456:ABCdefGHIJKLMNOPQRSTuvwxyz_9')).toBe(true);
    expect(hooks.__test.validateBotToken('nope')).toBe(false);
    expect(hooks.__test.validateBotToken('123:short')).toBe(false);
  });

  it('saves telegram tokens through create + set_enabled with rollback', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("invoke('messaging.create', {");
    expect(source).toContain("platform: 'telegram',");
    expect(source).toContain("invoke('messaging.set_enabled', { instanceId: created.instance.id, enabled: true })");
    expect(source).toContain("invoke('messaging.delete', { instanceId: created.instance.id })");
    expect(source).toContain("enabled: true }");
  });

  it('stores the enabled instance returned by set_enabled after telegram create', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain('state.instances = [...state.instances, enabled.instance || created.instance];');
    expect(source).toContain('state.selectedInstanceId = (enabled.instance && enabled.instance.id) || created.instance.id;');
    expect(source).toContain("await invoke('messaging.set_enabled', { instanceId: created.instance.id, enabled: true })");
  });

  it('maps wecom terminal states through localized labels instead of raw backend codes', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain('labelFor(`messaging.wecom_qr.status_${statusState}`, errorCode || statusState)');
    expect(source).toContain('wecomStatusLabel(nextState, registration.errorCode)');
    expect(source).toContain('wecomStatusLabel(registration.state, registration.errorCode)');
    expect(source).not.toContain("setNotice(registration.errorCode || nextState, 'error')");
    expect(source).not.toContain("setNotice(registration.errorCode || registration.state, 'error')");
  });

  it('guards in-flight wecom poll/complete responses against a concurrent cancel', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain('const revision = ++state.wecom.revision;');
    expect(source).toContain('state.wecom.cancelling = true;');
    expect(source).toContain('if (state.wecom.revision !== revision) return;');
    expect(source).toContain("state.wecom.state === 'completed' || state.wecom.state === 'activating'");
  });

  it('clears the wecom flow when the auth popup is blocked', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("labelFor('messaging.wecom_qr.popup_blocked', ''), 'error')");
    expect(source).toContain(`setNotice(labelFor('messaging.wecom_qr.popup_blocked', ''), 'error');
        await cancelWecomFlow({ silent: true, render: false });`);
  });

  it('keeps an add-binding entry for open channels after the first instance', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("labelFor('messaging.instance.add', '')");
    expect(source).toContain('state.telegramCreatingNew = true;');
    expect(source).toContain('void startQrForChannel(channel)');
  });

  it('creates a fresh Feishu draft when adding a second instance', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain('void startQrForChannel(channel, { createNew: true })');
    expect(source).toContain('async function startQrForChannel(channel)');
    // Always mint a fresh draft: re-running QR against an already-bound bot is
    // refused by main (it would overwrite existing credentials).
    expect(source).not.toContain('instancesForChannel(channel)[0] || null');
  });

  it('accepts only verified wecom auth messages from the official popup', () => {
    const { hooks } = loadMessagingSettingsTestHooks();
    const origin = 'https://work.weixin.qq.com';
    const popup = { closed: false };
    const make = (overrides: any) => ({ origin, source: popup, data: { type: 'AUTH_SUCCESS', wecomBotId: 'wb_abc', wecomBotSecret: 'secret-value' }, ...overrides });

    expect(hooks.__test.parseWecomAuthMessage(make({}), popup)).toMatchObject({
      ok: true,
      wecomBotId: 'wb_abc',
      wecomBotSecret: 'secret-value',
    });
    expect(hooks.__test.parseWecomAuthMessage(make({ origin: 'https://evil.example' }), popup).ok).toBe(false);
    expect(hooks.__test.parseWecomAuthMessage(make({ source: {} }), popup).ok).toBe(false);
    expect(hooks.__test.parseWecomAuthMessage(make({ data: { type: 'AUTH_SUCCESS' } }), popup).ok).toBe(false);
    expect(hooks.__test.parseWecomAuthMessage(make({ data: { type: 'AUTH_SUCCESS', wecomBotId: 'wb_abc', wecomBotSecret: '' } }), popup).ok).toBe(false);
  });

  it('wires the wecom panel to start/complete/cancel IPC and popup cleanup', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain('messaging.wecom_qr.start');
    expect(source).toContain('messaging.wecom_qr.complete');
    expect(source).toContain('messaging.wecom_qr.cancel');
    expect(source).toContain('window.open');
    expect(source).toContain('event.origin');
    expect(source).toContain('event.source !== popup');
    expect(source).toContain('closeWecomPopup');
    expect(source).toContain('await cancelWecomFlow({ silent: true, render: false })');
  });

  it('wires the wechat channel to start/status/cancel IPC without an instance draft', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("invoke('messaging.wechat_qr.start', {})");
    expect(source).toContain("invoke('messaging.wechat_qr.status', { flowId })");
    expect(source).toContain("invoke('messaging.wechat_qr.cancel', { flowId })");
    expect(source).toContain('renderWechatPanel');
    expect(source).toContain("channel.platform === 'wechat_personal'");
    expect(source).toContain('wechatFlowActive()');
  });

  it('renders the wechat QR from qrUrl with qrCode fallback and localizes through wechat_qr keys', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("state.wechat.qrSource = registration.qrUrl.trim()");
    expect(source).toContain("state.wechat.qrSource = registration.qrCode.trim()");
    expect(source).toContain("renderQrCode(host, state.wechat.qrSource, 'messaging.wechat_qr')");
    expect(source).toContain("labelFor(`messaging.wechat_qr.status_${statusState}`, errorCode || statusState)");
    expect(source).toContain("labelFor('messaging.wechat_qr.completed', '')");
    expect(source).not.toContain('messaging.wechat_qr.status_scanned_confirm');
  });

  it('treats a start response without qrUrl/qrCode as start-failed and renders the error in the QR area', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    // 启动响应既无 qrUrl 也无 qrCode → 按启动失败处理，绝不展示空二维码区域
    expect(source).toContain("if (!state.wechat.qrSource && !WECHAT_TERMINAL_STATES.has(state.wechat.state))");
    expect(source).toContain("state.wechat.error = labelFor('messaging.wechat_qr.start_failed', '')");
    // 终态错误时在二维码区域渲染错误文案，而不是 qr_pending 空占位
    expect(source).toContain("host.appendChild(el('span', 'messaging-qr-pending', status))");
    expect(source).toContain("} else {\n      renderQrCode(host, state.wechat.qrSource, 'messaging.wechat_qr');\n    }");
  });

  it('treats wechat blocked/expired/failed as terminal and cancels the server flow', () => {
    const { hooks } = loadMessagingSettingsTestHooks();
    const wechat = hooks.__test.state.wechat;

    hooks.__test.resetWechatFlow();
    expect(hooks.__test.wechatFlowActive()).toBe(false);
    wechat.flowId = 'flow-1';
    wechat.state = 'awaiting_scan';
    expect(hooks.__test.wechatFlowActive()).toBe(true);
    for (const terminal of ['completed', 'cancelled', 'expired', 'blocked', 'failed']) {
      wechat.state = terminal;
      expect(hooks.__test.wechatFlowActive()).toBe(false);
    }
    hooks.__test.resetWechatFlow();

    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("await cancelWechatFlow({ silent: true, render: false })");
    expect(source).toContain("WECHAT_TERMINAL_STATES.has(nextState)");
  });

  it('renders the wechat card with iLink copy and toggles the scan button to cancel while active', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("labelFor('messaging.wechat_qr.title', '')");
    expect(source).toContain("labelFor('messaging.wechat_qr.subtitle', '')");
    expect(source).toContain("flowActive ? 'messaging.wechat_qr.cancel' : 'messaging.wechat_qr.start'");
    expect(source).toContain('if (flowActive) void cancelWechatFlow();');
    expect(source).toContain("void startWechatFlow();\n    });\n    row.appendChild(scan);");
  });

  it('routes an immediate-terminal start response through notice + cancel + reset', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("await completeWechatFlow(registration, flowId, revision);");
    expect(source).toContain("setNotice(wechatStatusLabel(state.wechat.state, state.wechat.errorCode), 'error');");
    expect(source).toContain("await cancelWechatFlow({ silent: true, render: false });");
    expect(source).toContain('scheduleWechatPoll(flowId);');
  });

  it('cancels an in-flight wechat QR flow when switching channels', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain('await cancelWechatFlow({ silent: true, render: false })');
    expect(source).toContain('state.selectedChannel = key');
  });

  it('keeps the add-binding entry for wechat and starts the QR flow directly', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("else if (channel.platform === 'wechat_personal')");
    expect(source).toContain('void startWechatFlow()');
  });

  it('provides every visible catalog and detail label in each renderer locale', () => {
    const keys = [
      'messaging.group.open',
      'messaging.group.soon',
      'messaging.status.bound',
      'messaging.channel.feishu.title',
      'messaging.channel.feishu.badge',
      'messaging.channel.lark.title',
      'messaging.channel.lark.badge',
      'messaging.channel.qq.title',
      'messaging.association_title',
      'messaging.association_sub',
      'messaging.scan',
      'messaging.response_title',
      'messaging.response_subtitle',
      'messaging.response_streaming_card',
      'messaging.workspace_all',
      'messaging.workspace_subtitle',
      'messaging.instance.empty',
      'messaging.instance.add',
      'messaging.instance.title',
      'messaging.wecom_qr.start',
      'messaging.wecom_qr.open_hint',
      'messaging.wecom_qr.cancel',
      'messaging.wecom_qr.invalid_message',
      'messaging.wecom_qr.popup_blocked',
      'messaging.wecom_qr.status_expired',
      'messaging.wecom_qr.status_cancelled',
      'messaging.wecom_qr.status_failed',
      'messaging.wecom_qr.status_denied',
      'messaging.channel.wechat.title',
      'messaging.channel.wechat.description',
      'messaging.wechat_qr.start',
      'messaging.wechat_qr.retry',
      'messaging.wechat_qr.cancel',
      'messaging.wechat_qr.cancel_failed',
      'messaging.wechat_qr.start_failed',
      'messaging.wechat_qr.poll_failed',
      'messaging.wechat_qr.completed',
      'messaging.wechat_qr.status_starting',
      'messaging.wechat_qr.status_awaiting_scan',
      'messaging.wechat_qr.status_scanned',
      'messaging.wechat_qr.status_redirecting',
      'messaging.wechat_qr.status_verification_required',
      'messaging.wechat_qr.status_completed',
      'messaging.wechat_qr.status_expired',
      'messaging.wechat_qr.status_blocked',
      'messaging.wechat_qr.status_cancelled',
      'messaging.wechat_qr.status_failed',
      'messaging.telegram.token_label',
      'messaging.telegram.token_placeholder',
      'messaging.telegram.connect',
      'messaging.telegram.reconnect',
      'messaging.telegram.token_invalid',
      'messaging.telegram.enable_failed',
      'messaging.delete_subtitle',
      'messaging.updated',
      'messaging.update_failed',
      'messaging.open_failed',
    ];
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const messages = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${locale}.json`), 'utf8')) as Record<string, string>;
      for (const key of keys) expect(messages[key]).toEqual(expect.any(String));
    }
    for (const locale of ['zh', 'en']) {
      const messages = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${locale}.json`), 'utf8')) as Record<string, string>;
      expect(messages['messaging.feishu_qr.subtitle']).not.toMatch(/已有应用|existing/i);
    }
  });
});
