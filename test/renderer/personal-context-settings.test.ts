/**
 * 个人上下文连接器设置 UI 测试（renderer）。
 * 用 vm + mock DOM 加载经典脚本，验证状态行与动作按钮的状态分派：
 * connected → 撤销；connecting → 取消；disconnected → 连接；error → 连接 + 撤销。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const ZH_LABELS: Record<string, string> = {
  'personal_context.title': '个人上下文连接器',
  'personal_context.subtitle': '连接飞书日历/云空间/文档，作为个人上下文底座（默认只读，写入需确认）。',
  'personal_context.status.connected': '已连接',
  'personal_context.status.disconnected': '未连接',
  'personal_context.status.connecting': '授权中：请在浏览器中完成飞书授权',
  'personal_context.status.error': '连接异常：{error}',
  'personal_context.status.needs_reauth': '授权已失效，请重新连接',
  'personal_context.connect': '连接飞书',
  'personal_context.cancel': '取消授权',
  'personal_context.revoke': '撤销连接',
  'personal_context.revoke_confirm': '确定撤销飞书连接？数据同步将停止。',
  'personal_context.connect_failed': '发起授权失败：{error}',
  'personal_context.revoke_failed': '撤销失败：{error}',
  'personal_context.setup_toggle': '首次使用需配置飞书应用（点此打开向导）',
  'personal_context.setup.step0_title': '第 1 步 · 应用凭据',
  'personal_context.setup.step0_ready': '✓ 已检测到飞书机器人凭据',
  'personal_context.setup.step0_missing': '未检测到飞书机器人凭据：请先在上方「消息平台」中创建飞书机器人并扫码绑定。',
  'personal_context.setup.step1_title': '第 2 步 · 配置回调地址',
  'personal_context.setup.step1_desc': '打开开发者后台，在「安全设置 → 重定向 URL」中粘贴下面的地址并保存：',
  'personal_context.setup.step2_title': '第 3 步 · 开通只读权限',
  'personal_context.setup.step2_desc': '在开发者后台「权限管理」中搜索并开通以下权限，然后保存：',
  'personal_context.setup.step3_title': '第 4 步 · 发布版本',
  'personal_context.setup.step4_title': '配置完成',
  'personal_context.setup.done': '我已完成',
  'personal_context.setup.copy': '复制地址',
  'personal_context.setup.copied': '已复制',
  'personal_context.setup.open_console': '打开开发者后台',
  'personal_context.setup.finish': '完成',
};

class ElementMock {
  tagName: string;
  className = '';
  private ownText = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  type = '';
  disabled = false;
  placeholder = '';
  autocomplete = '';
  spellcheck = false;
  children: ElementMock[] = [];
  listeners: Record<string, () => void> = {};

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  /** 真实 DOM 语义：包含自身文本与所有后代文本。 */
  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
  }

  append(...nodes: ElementMock[]) {
    this.children.push(...nodes);
  }

  appendChild(node: ElementMock) {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes: ElementMock[]) {
    this.children = nodes;
  }

  setAttribute(name: string, value: string) {
    if (name === 'aria-label' || name === 'role') {
      this.dataset[name] = value;
    } else {
      this.dataset[name] = value;
    }
  }

  addEventListener(event: string, listener: () => void) {
    this.listeners[event] = listener;
  }

  querySelector(_selector: string): ElementMock | null {
    return this.children.find((child) => child.className.includes('messaging-notice')) ?? null;
  }

  focus() {}
}

interface LoadedModule {
  state: {
    status: { kind: string; error?: string; needsReauth?: boolean; redirectUri?: string } | null;
    authorizing: boolean;
    setupOpen: boolean;
    setupStep: number;
    guide: { credentialReady: boolean; redirectUri?: string; appId?: string } | null;
  };
  statusLine(): ElementMock;
  actions(): ElementMock;
  renderCurrent(): void;
  refreshStatus(): Promise<void>;
  stopPolling(): void;
  refreshGuide(): Promise<void>;
  toggleSetup(): void;
  advanceSetup(): void;
  renderSetupGuide(): ElementMock;
}

function loadModule(overrides: { invokeResult?: unknown } = {}): { module: LoadedModule; page: ElementMock } {
  const page = new ElementMock('div');
  const moduleBox = { exports: {} };
  const context: any = {
    Map,
    Set,
    Promise,
    Error,
    Object,
    String,
    Boolean,
    Array,
    Date,
    setTimeout,
    clearTimeout,
    module: moduleBox,
    window: { orkas: { invoke: async () => overrides.invokeResult ?? { status: { kind: 'disconnected' } } } },
    document: {
      getElementById: (id: string) => (id === 'personal-context-page' ? page : null),
      createElement: (tag: string) => new ElementMock(tag),
    },
    t: (key: string) => ZH_LABELS[key] ?? key,
    confirm: () => true,
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/personal-context-settings.js'),
    'utf8',
  );
  vm.runInContext(source, context, { filename: 'personal-context-settings.js' });
  const module = moduleBox.exports as { __test: LoadedModule };
  return { module: module.__test, page };
}

function buttonsOf(container: ElementMock): ElementMock[] {
  return container.children.filter((child) => child.tagName === 'button');
}

/** 递归收集：向导 body 里的按钮嵌套在子容器中 */
function buttonsDeep(node: ElementMock): ElementMock[] {
  return node.children.flatMap((child) =>
    child.tagName === 'button' ? [child, ...buttonsDeep(child)] : buttonsDeep(child),
  );
}

describe('personal context settings UI', () => {
  it('shows connected status and a revoke action when connected', () => {
    const { module } = loadModule();
    module.state.status = { kind: 'connected' };
    const status = module.statusLine();
    expect(status.textContent).toContain('已连接');
    const actions = module.actions();
    const buttons = buttonsOf(actions);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('撤销连接');
  });

  it('shows authorizing status and a cancel action while connecting', () => {
    const { module } = loadModule();
    module.state.status = { kind: 'connecting' };
    module.state.authorizing = true;
    const status = module.statusLine();
    expect(status.textContent).toContain('授权中');
    const buttons = buttonsOf(module.actions());
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('取消授权');
  });

  it('shows disconnected status and a connect action when not connected', () => {
    const { module } = loadModule();
    module.state.status = { kind: 'disconnected' };
    expect(module.statusLine().textContent).toContain('未连接');
    const buttons = buttonsOf(module.actions());
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('连接飞书');
  });

  it('shows error status with connect and revoke actions; needsReauth has its own label', () => {
    const { module } = loadModule();
    module.state.status = { kind: 'error', error: 'network down' };
    const status = module.statusLine();
    expect(status.textContent).toContain('连接异常：network down');
    const buttons = buttonsOf(module.actions());
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.textContent)).toEqual(['连接飞书', '撤销连接']);

    module.state.status = { kind: 'error', error: 'invalid_grant', needsReauth: true };
    expect(module.statusLine().textContent).toContain('授权已失效');
  });

  it('refreshStatus pulls status through the personal_context.get_status channel', async () => {
    const { module } = loadModule({
      invokeResult: { status: { kind: 'connected', checkedAt: new Date().toISOString() } },
    });
    await module.refreshStatus();
    expect(module.state.status?.kind).toBe('connected');
  });

  it('renderCurrent renders the card into the page container', () => {
    const { module, page } = loadModule();
    module.state.status = { kind: 'disconnected' };
    module.renderCurrent();
    expect(page.children.length).toBeGreaterThan(0);
    const section = page.children[0];
    expect(section.className).toContain('messaging-config-card');
  });

  it('wizard step 0 shows ready state and can advance when credentials exist', () => {
    const { module } = loadModule();
    module.state.guide = { credentialReady: true, redirectUri: 'http://127.0.0.1:36415/oauth/feishu/callback' };
    const box = module.renderSetupGuide();
    expect(box.textContent).toContain('已检测到飞书机器人凭据');
    const buttons = buttonsOf(box);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('我已完成');
    module.advanceSetup();
    expect(module.state.setupStep).toBe(1);
  });

  it('wizard step 0 blocks advancing without credentials', () => {
    const { module } = loadModule();
    module.state.guide = { credentialReady: false };
    const box = module.renderSetupGuide();
    expect(box.textContent).toContain('未检测到飞书机器人凭据');
    expect(buttonsOf(box)).toHaveLength(0);
  });

  it('wizard step 1 shows the redirect url with copy and console actions', () => {
    const { module } = loadModule();
    module.state.guide = {
      credentialReady: true,
      redirectUri: 'http://127.0.0.1:36415/oauth/feishu/callback',
      appId: 'cli_1111111111111111',
    };
    module.state.setupStep = 1;
    const box = module.renderSetupGuide();
    expect(box.textContent).toContain('配置回调地址');
    expect(box.textContent).toContain('http://127.0.0.1:36415/oauth/feishu/callback');
    const buttons = buttonsDeep(box);
    expect(buttons.map((b) => b.textContent)).toContain('复制地址');
    expect(buttons.map((b) => b.textContent)).toContain('打开开发者后台');
  });

  it('advancing past the final wizard step collapses the guide', () => {
    const { module } = loadModule();
    module.state.guide = { credentialReady: true };
    module.state.setupStep = 4;
    module.state.setupOpen = true;
    module.advanceSetup();
    expect(module.state.setupOpen).toBe(false);
  });

  it('toggleSetup opens and closes the guide panel', () => {
    const { module } = loadModule();
    expect(module.state.setupOpen).toBe(false);
    module.toggleSetup();
    expect(module.state.setupOpen).toBe(true);
    module.toggleSetup();
    expect(module.state.setupOpen).toBe(false);
  });
});
