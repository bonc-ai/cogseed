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
  it('loads tabs eagerly and the settings page on demand', () => {
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
    expect(indexHtml).toContain('id="messaging-catalog"');
    expect(indexHtml).toContain('data-i18n-title="messaging.add_title"');
    expect(style).toContain('max-width: none;');
    expect(style).toContain('grid-template-columns: minmax(320px, 34%) minmax(0, 1fr);');
    expect(style).toContain('.messaging-detail-form { width: 100%; margin: 0; }');
    expect(style).toContain('.messaging-catalog.is-only-section');
    expect(indexHtml).toContain('data-i18n="messaging.instances">机器人实例</div>');
    expect(messagingSettings).toContain('root.hidden = true;');
    expect(messagingSettings).toContain('messaging-status-dot is-${headerStatusKind}');
    expect(messagingSettings).toContain("details.appendChild(fieldRow(labelFor('messaging.name', '机器人名称'), nameInput));");
    expect(messagingSettings).toContain("messaging.feishu_qr.start");
    expect(messagingSettings).toContain("messaging.feishu_qr.status");
    expect(messagingSettings).toContain("messaging.feishu_qr.cancel");
    expect(messagingSettings).toContain("messaging.wecom_qr.start");
    expect(messagingSettings).toContain("messaging.wecom_qr.complete");
    expect(messagingSettings).toContain("messaging.wecom_qr.cancel");
    expect(messagingSettings).toContain("event.origin === 'https://work.weixin.qq.com'");
    expect(messagingSettings).toContain('event.source === state.wecomQr.popup');
    expect(messagingSettings).toContain("data.type !== 'AUTH_SUCCESS'");
    expect(messagingSettings).toContain("window.removeEventListener('message', handleWecomQrMessage)");
    expect(messagingSettings).toContain('wecomBotId, wecomBotSecret');
    expect(lazyFeatures).toContain("./vendor/qrcode-generator/qrcode.js");
    expect(style).toContain('.messaging-feishu-qr-layout');
    expect(style).toContain('.messaging-wecom-qr-layout');
    expect(messagingSettings).not.toContain('details.hidden = !canConfigureCredentials;');
    expect(indexHtml).not.toContain('Model Authorization');
    expect(indexHtml.indexOf(tabsScript)).toBeGreaterThanOrEqual(0);
    expect(indexHtml.indexOf(settingsScript)).toBe(-1);
    expect(lazyFeatures).toContain("{ src: './modules/settings.js' }");
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

  it('accepts only the official WeCom authorization URL and structurally valid callback payloads', () => {
    const { hooks } = loadMessagingSettingsTestHooks();

    expect(hooks.isValidWecomAuthorizationUrl('https://work.weixin.qq.com/ai/qc/gen')).toBe(true);
    expect(hooks.isValidWecomAuthorizationUrl('https://work.weixin.qq.com/ai/qc/gen?state=untrusted')).toBe(false);
    expect(hooks.isValidWecomAuthorizationUrl('https://name@work.weixin.qq.com/ai/qc/gen')).toBe(false);
    expect(hooks.isValidWecomAuthorizationUrl('https://work.weixin.qq.com/ai/qc/gen#result')).toBe(false);
    expect(hooks.isValidWecomAuthorizationUrl('https://work.weixin.qq.com/other')).toBe(false);
    expect(hooks.isValidWecomAuthorizationUrl('https://attacker.example/ai/qc/gen')).toBe(false);
    expect(hooks.validateWecomAuthPayload({
      type: 'AUTH_SUCCESS',
      payload: { botid: 'bot-123', secret: 'abcdefgh' },
    })).toEqual({ botId: 'bot-123', botSecret: 'abcdefgh' });
    expect(hooks.validateWecomAuthPayload({
      type: 'AUTH_SUCCESS',
      payload: { botid: 'bot-123', secret: 'contains space' },
    })).toBeNull();
    expect(hooks.validateWecomAuthPayload({ type: 'AUTH_SUCCESS', payload: { botid: 'bot-123' } })).toBeNull();
    expect(hooks.validateWecomAuthPayload({ type: 'OTHER', payload: { botid: 'bot-123', secret: 'abcdefgh' } })).toBeNull();

    const credentials = {
      telegramToken: { value: '' },
      feishuAppId: { value: '' },
      feishuAppSecret: { value: '' },
      feishuTenantToken: { value: '' },
      wecomBotId: { value: ' bot-123 ' },
      wecomBotSecret: { value: ' abcdefgh ' },
    };
    expect(hooks.manualSecretForPlatform('wecom', credentials, true)).toEqual({
      wecomBotId: 'bot-123',
      wecomBotSecret: 'abcdefgh',
    });
    credentials.wecomBotId.value = '';
    credentials.wecomBotSecret.value = '';
    expect(hooks.manualSecretForPlatform('wecom', credentials, false)).toBeNull();
    credentials.wecomBotId.value = 'bot-123';
    expect(() => hooks.manualSecretForPlatform('wecom', credentials, false)).toThrow();
  });

  it('detaches the WeCom popup before activating an authorized registration', () => {
    const { hooks, removeEventListener } = loadMessagingSettingsTestHooks();
    const popup = {
      closed: false,
      close() { this.closed = true; },
    };
    const qr = hooks.__test.state.wecomQr;
    qr.flowId = 'wecom-flow-1';
    qr.revision = 7;
    qr.state = 'awaiting_scan';
    qr.popup = popup;
    qr.messageListenerBound = true;
    qr.popupWatchTimer = 1;
    qr.timeoutTimer = 2;
    qr.statusTimer = 3;

    expect(hooks.__test.beginWecomQrActivation('wecom-flow-1', 7)).toBe(true);
    expect(popup.closed).toBe(true);
    expect(qr.popup).toBeNull();
    expect(qr.messageListenerBound).toBe(false);
    expect(qr.popupWatchTimer).toBeNull();
    expect(qr.timeoutTimer).toBeNull();
    expect(qr.statusTimer).toBeNull();
    expect(qr.completing).toBe(true);
    expect(qr.state).toBe('activating');
    expect(removeEventListener).toHaveBeenCalledExactlyOnceWith('message', hooks.__test.handleWecomQrMessage);
    expect(hooks.__test.beginWecomQrActivation('wecom-flow-1', 7)).toBe(false);
  });
});
