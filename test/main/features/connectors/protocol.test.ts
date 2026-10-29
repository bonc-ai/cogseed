import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, (...args: any[]) => unknown>();
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  return {
    listeners,
    window,
    app: {
      isPackaged: true,
      isReady: vi.fn(() => true),
      setAsDefaultProtocolClient: vi.fn(() => true),
      isDefaultProtocolClient: vi.fn(() => true),
      on: vi.fn((event: string, listener: (...args: any[]) => unknown) => listeners.set(event, listener)),
    },
  };
});

const connectorMock = vi.hoisted(() => ({
  handleCallbackUrl: vi.fn(async () => undefined),
  handleDcrCallbackUrl: vi.fn(async () => undefined),
}));

// 插件授权回调与连接器/账号是三个独立命名空间， dispatcher 只做路由。
// 这里把插件流程整体替换成桩，既隔离它的依赖（hub/用户/包注册表），
// 也让"到底路由到哪一条"成为可断言的事实。
const pluginMock = vi.hoisted(() => ({
  handlePluginAuthorizeCallbackUrl: vi.fn(async () => ({ ok: true })),
  pluginAuthorizeCallbackUrl: (raw: string) => {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'cogseed:') return null;
      if (u.host.toLowerCase() !== 'plugin') return null;
      const pathname = u.pathname.replace(/\/+$/, '') || '/';
      return pathname === '/authorize/callback' ? u.toString() : null;
    } catch {
      return null;
    }
  },
}));

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: { getAllWindows: () => [electronMock.window] },
}));

vi.mock('../../../../src/main/features/connectors/index', () => connectorMock);
vi.mock('../../../../src/main/features/plugin_oauth_flow', () => pluginMock);

describe('connector callback protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMock.listeners.clear();
    electronMock.app.isReady.mockReturnValue(true);
  });

  it('accepts only connector OAuth callbacks', async () => {
    const { _test } = await import('../../../../src/main/features/connectors/protocol');

    expect(_test.connectorCallbackKind('cogseed://connectors/oauth/callback?exchange_code=x')).toBe('server');
    expect(_test.connectorCallbackKind('cogseed://connectors/oauth/callback?exchange_code=x')).toBe('server');
    expect(_test.connectorCallbackKind('cogseed://connectors/oauth/dcr-callback?exchange_code=x')).toBe('dcr');
    expect(_test.connectorCallbackKind('cogseed://connectors/oauth/callback?exchange_code=x')).toBe('server');
    expect(_test.connectorCallbackKind('cogseed://connectors/oauth/dcr-callback?exchange_code=x')).toBe('dcr');
    expect(_test.connectorCallbackKind('cogseed://account/login?token=x')).toBeNull();
    expect(_test.connectorCallbackKind('cogseed://shell/run?command=rm')).toBeNull();
    expect(_test.connectorCallbackKind('https://connectors/oauth/callback')).toBeNull();
  });

  it('🔴 冷启动 argv 里能认出换账号深链（应用没在运行时也必须能接住）', async () => {
    const { _test } = await import('../../../../src/main/features/connectors/protocol');

    // 规范形状应被 _extractCallback 收下（否则冷启动时这条深链会被直接丢弃）
    expect(_test.extractCallback(['CogSeed', 'cogseed://account/switch']))
      .toBe('cogseed://account/switch');
    // 带参数的变体不属于本流程，必须继续被忽略
    expect(_test.extractCallback(['CogSeed', 'cogseed://account/switch?account_id=x'])).toBeNull();
    // 既有登录回调不受影响
    expect(_test.extractCallback(['CogSeed', 'cogseed://account/callback?code=a&state=b']))
      .toBe('cogseed://account/callback?code=a&state=b');
  });

  it('recognizes plugin authorization callbacks without swallowing other flows', async () => {
    const { _test } = await import('../../../../src/main/features/connectors/protocol');

    expect(_test.isPluginCallback('cogseed://plugin/authorize/callback?code=a&state=b')).toBe(true);
    expect(_test.isPluginCallback('cogseed://plugin/authorize/callback/?code=a&state=b')).toBe(true);
    // 账号与连接器的深链不能被插件分支吞掉（命名空间隔离的另一面）。
    expect(_test.isPluginCallback('cogseed://account/callback?code=a&state=b')).toBe(false);
    expect(_test.isPluginCallback('cogseed://connectors/oauth/callback?code=a')).toBe(false);
    expect(_test.isPluginCallback('cogseed://plugin/other?code=a')).toBe(false);
    expect(_test.isPluginCallback('https://plugin/authorize/callback?code=a')).toBe(false);
    expect(_test.isPluginCallback('not a url')).toBe(false);
  });

  it('dispatches a plugin callback to the plugin flow only', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');
    protocol.registerConnectorProtocol({ owner: true });
    const openUrl = electronMock.listeners.get('open-url');
    const preventDefault = vi.fn();

    await openUrl?.({ preventDefault }, 'cogseed://plugin/authorize/callback?code=abc&state=xyz');
    await vi.waitFor(() => expect(pluginMock.handlePluginAuthorizeCallbackUrl).toHaveBeenCalledTimes(1));
    expect(pluginMock.handlePluginAuthorizeCallbackUrl).toHaveBeenLastCalledWith('cogseed://plugin/authorize/callback?code=abc&state=xyz');
    // 路由互斥：插件回调不得同时触发连接器处理。
    expect(connectorMock.handleCallbackUrl).not.toHaveBeenCalled();
    expect(connectorMock.handleDcrCallbackUrl).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('🔴 冷启动 argv 里能认出插件回调（应用没在运行时也必须能接住）', async () => {
    const { _test } = await import('../../../../src/main/features/connectors/protocol');
    expect(_test.extractCallback(['/path/to/electron', 'cogseed://plugin/authorize/callback?code=a&state=b']))
      .toBe('cogseed://plugin/authorize/callback?code=a&state=b');
    // 非本流程的参数照旧忽略。
    expect(_test.extractCallback(['/path/to/electron', '--some-flag', 'cogseed://shell/run?command=rm'])).toBeNull();
  });

  it('🔴 非 owner 运行时不得消费插件回调（避免双实例重复兑换授权码）', async () => {
    pluginMock.handlePluginAuthorizeCallbackUrl.mockClear();
    const protocol = await import('../../../../src/main/features/connectors/protocol');
    protocol.registerConnectorProtocol({ owner: false });
    const secondInstance = electronMock.listeners.get('second-instance');

    await secondInstance?.({}, ['/path', 'cogseed://plugin/authorize/callback?code=abc&state=xyz']);

    expect(pluginMock.handlePluginAuthorizeCallbackUrl).not.toHaveBeenCalled();
  });

  it('registers before readiness and dispatches both callback kinds to the running app', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');
    expect(protocol.registerConnectorProtocol({ owner: true })).toBe(true);

    expect(electronMock.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('cogseed');
    expect(electronMock.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('cogseed');
    expect(electronMock.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('cogseed');
    const openUrl = electronMock.listeners.get('open-url');
    expect(openUrl).toBeTypeOf('function');
    const preventDefault = vi.fn();

    await openUrl?.({ preventDefault }, 'cogseed://connectors/oauth/callback?exchange_code=one');
    await vi.waitFor(() => expect(connectorMock.handleCallbackUrl).toHaveBeenCalledTimes(1));
    expect(connectorMock.handleCallbackUrl).toHaveBeenLastCalledWith('cogseed://connectors/oauth/callback?exchange_code=one');
    await openUrl?.({ preventDefault }, 'cogseed://connectors/oauth/dcr-callback?exchange_code=two');
    await vi.waitFor(() => expect(connectorMock.handleDcrCallbackUrl).toHaveBeenCalledTimes(1));
    expect(connectorMock.handleDcrCallbackUrl).toHaveBeenLastCalledWith('cogseed://connectors/oauth/dcr-callback?exchange_code=two');

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(electronMock.window.restore).toHaveBeenCalled();
    expect(electronMock.window.focus).toHaveBeenCalled();
  });

  it('does not intercept stripped account-login links', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');
    protocol.registerConnectorProtocol({ owner: true });
    const openUrl = electronMock.listeners.get('open-url');
    const preventDefault = vi.fn();

    await openUrl?.({ preventDefault }, 'cogseed://account/login?exchange_code=account');

    expect(preventDefault).not.toHaveBeenCalled();
    expect(connectorMock.handleCallbackUrl).not.toHaveBeenCalled();
    expect(connectorMock.handleDcrCallbackUrl).not.toHaveBeenCalled();
  });

  it('focuses the existing window without registering or dispatching protocols when not the owner', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');

    expect(protocol.registerConnectorProtocol({ owner: false })).toBe(false);
    expect(electronMock.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(electronMock.listeners.has('open-url')).toBe(false);
    const secondInstance = electronMock.listeners.get('second-instance');
    expect(secondInstance).toBeTypeOf('function');

    await secondInstance?.({}, ['cogseed://connectors/oauth/callback?exchange_code=ignored']);

    expect(electronMock.window.restore).toHaveBeenCalledOnce();
    expect(electronMock.window.show).toHaveBeenCalledOnce();
    expect(electronMock.window.focus).toHaveBeenCalledOnce();
    expect(connectorMock.handleCallbackUrl).not.toHaveBeenCalled();
    expect(connectorMock.handleDcrCallbackUrl).not.toHaveBeenCalled();
  });
});
