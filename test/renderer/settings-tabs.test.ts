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
    expect(open).toEqual(['feishu', 'lark', 'wecom', 'telegram']);
    expect(soon).toEqual(['wechat', 'qq', 'dingtalk', 'discord']);
    for (const channel of hooks.CHANNELS) expect(typeof channel.icon).toBe('string');

    expect(hooks.channelForInstance({ id: 'a', platform: 'wecom' })).toBe('wecom');
    expect(hooks.channelForInstance({ id: 'b', platform: 'telegram' })).toBe('telegram');
    expect(hooks.channelForInstance({ id: 'c', platform: 'feishu_lark', feishuTenantBrand: 'lark' })).toBe('lark');
    expect(hooks.channelForInstance({ id: 'd', platform: 'feishu_lark', feishuTenantBrand: 'feishu' })).toBe('feishu');
    expect(hooks.channelForInstance({ id: 'e', platform: 'wechat_personal' })).toBeNull();
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

  it('provides every visible catalog and detail label in each renderer locale', () => {
    const keys = [
      'messaging.group.open',
      'messaging.group.soon',
      'messaging.status.bound',
      'messaging.channel.coming_soon',
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
