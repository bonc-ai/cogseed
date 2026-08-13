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

const hubAccountMock = vi.hoisted(() => ({
  handleAccountCallbackUrl: vi.fn(async () => ({ ok: true })),
  accountCallbackUrl: vi.fn((rawUrl: string) => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.host.toLowerCase() !== 'account') return null;
      if ((parsed.pathname.replace(/\/+$/, '') || '/') !== '/callback') return null;
      return parsed.href;
    } catch {
      return null;
    }
  }),
}));

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: { getAllWindows: () => [electronMock.window] },
}));

vi.mock('../../../../src/main/features/connectors/index', () => connectorMock);
vi.mock('../../../../src/main/features/hub_account', () => hubAccountMock);

describe('connector callback protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMock.listeners.clear();
    electronMock.app.isReady.mockReturnValue(true);
  });

  it('accepts only connector OAuth callbacks', async () => {
    const { _test } = await import('../../../../src/main/features/connectors/protocol');

    expect(_test.connectorCallbackKind('cogseed://connectors/oauth/callback?exchange_code=x')).toBe('server');
    expect(_test.connectorCallbackKind('mateagent://connectors/oauth/callback?exchange_code=x')).toBe('server');
    expect(_test.connectorCallbackKind('mateagent://connectors/oauth/dcr-callback?exchange_code=x')).toBe('dcr');
    expect(_test.connectorCallbackKind('orkas://connectors/oauth/callback?exchange_code=x')).toBe('server');
    expect(_test.connectorCallbackKind('orkas://connectors/oauth/dcr-callback?exchange_code=x')).toBe('dcr');
    expect(_test.connectorCallbackKind('orkas://account/login?token=x')).toBeNull();
    expect(_test.connectorCallbackKind('mateagent://shell/run?command=rm')).toBeNull();
    expect(_test.connectorCallbackKind('https://connectors/oauth/callback')).toBeNull();
  });

  it('registers before readiness and dispatches both callback kinds to the running app', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');
    expect(protocol.registerConnectorProtocol({ owner: true })).toBe(true);

    expect(electronMock.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('cogseed');
    expect(electronMock.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('mateagent');
    expect(electronMock.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('orkas');
    const openUrl = electronMock.listeners.get('open-url');
    expect(openUrl).toBeTypeOf('function');
    const preventDefault = vi.fn();

    await openUrl?.({ preventDefault }, 'mateagent://connectors/oauth/callback?exchange_code=one');
    await vi.waitFor(() => expect(connectorMock.handleCallbackUrl).toHaveBeenCalledTimes(1));
    expect(connectorMock.handleCallbackUrl).toHaveBeenLastCalledWith('cogseed://connectors/oauth/callback?exchange_code=one');
    await openUrl?.({ preventDefault }, 'orkas://connectors/oauth/dcr-callback?exchange_code=two');
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

    await openUrl?.({ preventDefault }, 'mateagent://account/login?exchange_code=account');

    expect(preventDefault).not.toHaveBeenCalled();
    expect(connectorMock.handleCallbackUrl).not.toHaveBeenCalled();
    expect(connectorMock.handleDcrCallbackUrl).not.toHaveBeenCalled();
    expect(hubAccountMock.handleAccountCallbackUrl).not.toHaveBeenCalled();
  });

  it('dispatches the Hub account callback deep link to the hub account handler', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');
    protocol.registerConnectorProtocol({ owner: true });
    const openUrl = electronMock.listeners.get('open-url');
    const preventDefault = vi.fn();

    await openUrl?.({ preventDefault }, 'cogseed://account/callback?code=abc&state=def');

    expect(preventDefault).toHaveBeenCalled();
    expect(hubAccountMock.handleAccountCallbackUrl).toHaveBeenCalledTimes(1);
    expect(hubAccountMock.handleAccountCallbackUrl).toHaveBeenCalledWith('cogseed://account/callback?code=abc&state=def');
    expect(connectorMock.handleCallbackUrl).not.toHaveBeenCalled();
    expect(electronMock.window.focus).toHaveBeenCalled();
  });

  it('extracts an account callback from argv for cold launch', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');
    protocol.registerConnectorProtocol({ owner: true });
    // second-instance argv carrying the account deep link must be picked up
    const secondInstance = electronMock.listeners.get('second-instance');
    await secondInstance?.({}, ['--', 'cogseed://account/callback?code=xyz&state=sts']);
    await vi.waitFor(() => expect(hubAccountMock.handleAccountCallbackUrl).toHaveBeenCalledTimes(1));
    expect(hubAccountMock.handleAccountCallbackUrl).toHaveBeenCalledWith('cogseed://account/callback?code=xyz&state=sts');
  });

  it('focuses the existing window without registering or dispatching protocols when not the owner', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');

    expect(protocol.registerConnectorProtocol({ owner: false })).toBe(false);
    expect(electronMock.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(electronMock.listeners.has('open-url')).toBe(false);
    const secondInstance = electronMock.listeners.get('second-instance');
    expect(secondInstance).toBeTypeOf('function');

    await secondInstance?.({}, ['mateagent://connectors/oauth/callback?exchange_code=ignored']);

    expect(electronMock.window.restore).toHaveBeenCalledOnce();
    expect(electronMock.window.show).toHaveBeenCalledOnce();
    expect(electronMock.window.focus).toHaveBeenCalledOnce();
    expect(connectorMock.handleCallbackUrl).not.toHaveBeenCalled();
    expect(connectorMock.handleDcrCallbackUrl).not.toHaveBeenCalled();
  });
});
