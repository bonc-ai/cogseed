import { describe, expect, it, vi } from 'vitest';

import {
  hardenedWebPreferences,
  installDenyAllRemotePermissionGate,
  installExternalNavigationGuard,
  installMainRendererAudioPermissionGate,
  installWecomQuickCreatePopupGuard,
  isOfficialWecomQuickCreateUrl,
  safeExternalHttpUrl,
  safeExternalUserActionUrl,
} from '../../../src/main/util/window-security';

describe('window security baseline', () => {
  it('cannot be weakened by caller overrides', () => {
    const prefs = hardenedWebPreferences({
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      webSecurity: false,
      plugins: true,
    });
    expect(prefs).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      plugins: true,
    });
  });

  it('accepts only credential-free HTTP(S) URLs', () => {
    expect(safeExternalHttpUrl('https://example.test/docs?q=1')).toBe('https://example.test/docs?q=1');
    expect(safeExternalHttpUrl('http://example.test:9000/path')).toBe('http://example.test:9000/path');
    for (const value of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,boom',
      'chat-app://cid/a/b/index.html',
      'https://user:pass@example.test/',
      'https://example.test/\nfile:///etc/passwd',
      'https://',
      '',
    ]) {
      expect(safeExternalHttpUrl(value), value).toBeNull();
    }
  });

  it('strictly validates user-clicked mail, phone, and XMPP links', () => {
    for (const value of [
      'https://example.test/docs?q=1',
      'mailto:alice@example.com',
      'mailto:alice@example.com?subject=Hello',
      'tel:+86-13800138000',
      'sms:+8613800138000',
      'callto:+1 (555) 0100',
      'xmpp:alice@example.com',
    ]) {
      expect(safeExternalUserActionUrl(value), value).toBe(value);
    }

    for (const value of [
      'mailto:not-an-address',
      'mailto:alice@example.com?subject=Hello%0AInjected',
      'mailto:alice@example.com?attach=/etc/passwd',
      'tel:$(open evil)',
      'sms:+123?body=hello',
      'xmpp:alice@example.com?message',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'chat-app://cid/a/b/index.html',
      'kb-file://kb/private.pdf',
      'blob:https://example.test/id',
    ]) {
      expect(safeExternalUserActionUrl(value), value).toBeNull();
    }
  });

  it('recognizes only the exact official Enterprise WeCom quick-create page', () => {
    expect(isOfficialWecomQuickCreateUrl('https://work.weixin.qq.com/ai/qc/gen')).toBe(true);
    for (const value of [
      'http://work.weixin.qq.com/ai/qc/gen',
      'https://work.weixin.qq.com/ai/qc/gen?scode=temporary',
      'https://work.weixin.qq.com/ai/qc/c?s=temporary',
      'https://work.weixin.qq.com.evil.test/ai/qc/gen',
      'https://work.weixin.qq.com/ai/qc/generate',
      'https://user:pass@work.weixin.qq.com/ai/qc/gen',
    ]) {
      expect(isOfficialWecomQuickCreateUrl(value), value).toBe(false);
    }
  });

  it('denies every window.open and opens only safe URLs externally', async () => {
    let openHandler!: (details: { url: string }) => { action: 'deny' };
    let navigateHandler!: (event: { preventDefault(): void }, url: string) => void;
    const webContents = {
      setWindowOpenHandler: vi.fn((handler) => { openHandler = handler; }),
      on: vi.fn((_event, handler) => { navigateHandler = handler; }),
    };
    const openExternal = vi.fn(async () => undefined);
    installExternalNavigationGuard(webContents, openExternal);

    expect(openHandler({ url: 'https://example.test/a' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'mailto:alice@example.test' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    await Promise.resolve();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.test/a');

    const externalEvent = { preventDefault: vi.fn() };
    navigateHandler(externalEvent, 'https://example.test/b');
    const localEvent = { preventDefault: vi.fn() };
    navigateHandler(localEvent, 'file:///tmp/other.html');
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
    expect(localEvent.preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenLastCalledWith('https://example.test/b');
  });

  it('reports shell failures without allowing the navigation', async () => {
    let openHandler!: (details: { url: string }) => { action: 'deny' };
    const webContents = {
      setWindowOpenHandler: (handler: typeof openHandler) => { openHandler = handler; },
      on: vi.fn(),
    };
    const failure = new Error('shell failed');
    const warn = vi.fn();
    installExternalNavigationGuard(webContents, async () => { throw failure; }, warn);
    expect(openHandler({ url: 'https://example.test/' })).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(failure));
  });

  it('allows only an explicitly approved official authorization popup', async () => {
    let openHandler!: (details: { url: string }) => { action: 'deny' } | { action: 'allow' };
    const webContents = {
      setWindowOpenHandler: (handler: typeof openHandler) => { openHandler = handler; },
      on: vi.fn(),
    };
    const openExternal = vi.fn(async () => undefined);
    installExternalNavigationGuard(webContents, openExternal, undefined, {
      allowWindowOpen: isOfficialWecomQuickCreateUrl,
    });

    expect(openHandler({ url: 'https://work.weixin.qq.com/ai/qc/gen' })).toEqual({ action: 'allow' });
    expect(openHandler({ url: 'https://work.weixin.qq.com/ai/qc/gen?state=spoofed' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'https://example.test/authorize' })).toEqual({ action: 'deny' });
    await Promise.resolve();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledWith('https://example.test/authorize');
  });

  it('keeps the official WeCom popup from opening children or redirecting', () => {
    let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
    const navigationHandlers = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
    const popup = {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }) {
        openHandler = handler;
      },
      on(
        event: 'will-navigate' | 'will-redirect',
        handler: (navigationEvent: { preventDefault(): void }, url: string) => void,
      ) {
        navigationHandlers.set(event, handler);
      },
    };

    installWecomQuickCreatePopupGuard(popup);
    expect(openHandler?.({ url: 'https://example.test/child' })).toEqual({ action: 'deny' });

    const redirect = navigationHandlers.get('will-redirect');
    const navigate = navigationHandlers.get('will-navigate');
    if (!redirect || !navigate) throw new Error('popup navigation guards were not registered');

    const maliciousRedirect = { preventDefault: vi.fn() };
    redirect(maliciousRedirect, 'https://example.test/redirected');
    expect(maliciousRedirect.preventDefault).toHaveBeenCalledOnce();

    const officialRedirect = { preventDefault: vi.fn() };
    redirect(officialRedirect, 'https://work.weixin.qq.com/ai/qc/gen');
    expect(officialRedirect.preventDefault).not.toHaveBeenCalled();

    const maliciousNavigation = { preventDefault: vi.fn() };
    navigate(maliciousNavigation, 'https://example.test/navigate');
    expect(maliciousNavigation.preventDefault).toHaveBeenCalledOnce();
  });

  it('denies every permission in a remote authorization session', () => {
    let permissionRequestHandler: Parameters<typeof installDenyAllRemotePermissionGate>[0]['setPermissionRequestHandler'] extends (
      handler: infer Handler,
    ) => void ? Handler : never;
    let permissionCheckHandler: Parameters<typeof installDenyAllRemotePermissionGate>[0]['setPermissionCheckHandler'] extends (
      handler: infer Handler,
    ) => void ? Handler : never;
    const remoteSession: Parameters<typeof installDenyAllRemotePermissionGate>[0] = {
      setPermissionRequestHandler(handler) {
        permissionRequestHandler = handler;
      },
      setPermissionCheckHandler(handler) {
        permissionCheckHandler = handler;
      },
    };

    installDenyAllRemotePermissionGate(remoteSession);
    if (!permissionRequestHandler || !permissionCheckHandler) throw new Error('remote permission gate was not installed');

    const requestCallback = vi.fn();
    Reflect.apply(permissionRequestHandler, undefined, [null, 'clipboard-read', requestCallback, null]);
    expect(requestCallback).toHaveBeenCalledExactlyOnceWith(false);
    expect(Reflect.apply(permissionCheckHandler, undefined, [null, 'clipboard-read', 'https://work.weixin.qq.com', null])).toBe(false);
  });

  it('allows only the expected media and clipboard permissions from the main local renderer', () => {
    let requestHandler: (...args: any[]) => void = () => {};
    let checkHandler: (...args: any[]) => boolean = () => false;
    const mainWebContents = {};
    const rendererUrl = 'file:///C:/CogSeed/src/renderer/index.html';
    const targetSession = {
      setPermissionRequestHandler(handler: (...args: any[]) => void) { requestHandler = handler; },
      setPermissionCheckHandler(handler: (...args: any[]) => boolean) { checkHandler = handler; },
    };

    const observation = installMainRendererAudioPermissionGate(
      targetSession as never,
      mainWebContents as never,
      rendererUrl,
    );
    expect(observation).toEqual({ checkCount: 0, requestCount: 0 });

    expect(checkHandler(mainWebContents, 'media', 'file://', {
      isMainFrame: true,
      requestingUrl: rendererUrl,
      securityOrigin: 'file://',
      mediaType: 'audio',
    })).toBe(true);
    expect(checkHandler(mainWebContents, 'clipboard-read', 'file://', {
      isMainFrame: true,
      requestingUrl: rendererUrl,
    })).toBe(true);
    expect(checkHandler(mainWebContents, 'clipboard-sanitized-write', 'file://', {
      isMainFrame: true,
      requestingUrl: rendererUrl,
    })).toBe(true);

    const mediaCallback = vi.fn();
    requestHandler(mainWebContents, 'media', mediaCallback, {
      isMainFrame: true,
      requestingUrl: rendererUrl,
      securityOrigin: 'file://',
      mediaTypes: ['audio'],
    });
    expect(mediaCallback).toHaveBeenCalledExactlyOnceWith(true);

    for (const permission of ['clipboard-read', 'clipboard-sanitized-write']) {
      const callback = vi.fn();
      requestHandler(mainWebContents, permission, callback, {
        isMainFrame: true,
        requestingUrl: rendererUrl,
      });
      expect(callback, permission).toHaveBeenCalledExactlyOnceWith(true);
    }
    expect(observation).toEqual({ checkCount: 3, requestCount: 3 });
  });

  it('denies permission checks from inexact origins, URLs, frames, and web contents', () => {
    let requestHandler: (...args: any[]) => void = () => {};
    let checkHandler: (...args: any[]) => boolean = () => false;
    const mainWebContents = {};
    const otherWebContents = {};
    const rendererUrl = 'file:///C:/CogSeed/src/renderer/index.html';
    const targetSession = {
      setPermissionRequestHandler(handler: (...args: any[]) => void) { requestHandler = handler; },
      setPermissionCheckHandler(handler: (...args: any[]) => boolean) { checkHandler = handler; },
    };
    installMainRendererAudioPermissionGate(targetSession as never, mainWebContents as never, rendererUrl);

    for (const [webContents, permission, requestingOrigin, details] of [
      [mainWebContents, 'media', 'file://', { isMainFrame: true, requestingUrl: rendererUrl, mediaType: 'video' }],
      [mainWebContents, 'media', 'file:///', { isMainFrame: true, requestingUrl: rendererUrl, mediaType: 'audio' }],
      [mainWebContents, 'media', null, { isMainFrame: true, requestingUrl: rendererUrl, mediaType: 'audio' }],
      [mainWebContents, 'media', 'https://evil.test', { isMainFrame: true, requestingUrl: 'https://evil.test/', mediaType: 'audio' }],
      [mainWebContents, 'media', 'chat-app://cid', { isMainFrame: true, requestingUrl: 'chat-app://cid/a/index.html', mediaType: 'audio' }],
      [mainWebContents, 'media', 'file://', { isMainFrame: true, requestingUrl: `${rendererUrl}?forged`, mediaType: 'audio' }],
      [mainWebContents, 'media', 'file://', { isMainFrame: false, requestingUrl: rendererUrl, mediaType: 'audio' }],
      [otherWebContents, 'media', 'file://', { isMainFrame: true, requestingUrl: rendererUrl, mediaType: 'audio' }],
      [mainWebContents, 'geolocation', 'file://', { isMainFrame: true, requestingUrl: rendererUrl }],
    ] as const) {
      expect(checkHandler(webContents, permission, requestingOrigin, details), String(details.requestingUrl)).toBe(false);
    }
  });

  it('denies media requests without the exact file security origin or audio-only media types', () => {
    let requestHandler: (...args: any[]) => void = () => {};
    const mainWebContents = {};
    const otherWebContents = {};
    const rendererUrl = 'file:///C:/CogSeed/src/renderer/index.html';
    const targetSession = {
      setPermissionRequestHandler(handler: (...args: any[]) => void) { requestHandler = handler; },
      setPermissionCheckHandler() {},
    };
    installMainRendererAudioPermissionGate(targetSession as never, mainWebContents as never, rendererUrl);

    for (const [webContents, permission, details] of [
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: rendererUrl, securityOrigin: 'file://', mediaTypes: ['video'] }],
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: rendererUrl, securityOrigin: 'file://', mediaTypes: ['audio', 'video'] }],
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: rendererUrl, securityOrigin: 'file://', mediaTypes: [] }],
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: rendererUrl, mediaTypes: ['audio'] }],
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: rendererUrl, securityOrigin: 'file:///', mediaTypes: ['audio'] }],
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: rendererUrl, securityOrigin: null, mediaTypes: ['audio'] }],
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: rendererUrl, securityOrigin: 'https://evil.test', mediaTypes: ['audio'] }],
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: rendererUrl, securityOrigin: 'chat-app://cid', mediaTypes: ['audio'] }],
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: 'https://evil.test/', securityOrigin: 'file://', mediaTypes: ['audio'] }],
      [mainWebContents, 'media', { isMainFrame: true, requestingUrl: 'chat-app://cid/a/index.html', securityOrigin: 'file://', mediaTypes: ['audio'] }],
      [mainWebContents, 'media', { isMainFrame: false, requestingUrl: rendererUrl, securityOrigin: 'file://', mediaTypes: ['audio'] }],
      [otherWebContents, 'media', { isMainFrame: true, requestingUrl: rendererUrl, securityOrigin: 'file://', mediaTypes: ['audio'] }],
      [mainWebContents, 'display-capture', { isMainFrame: true, requestingUrl: rendererUrl }],
    ] as const) {
      const callback = vi.fn();
      requestHandler(webContents, permission, callback, details);
      expect(callback, String(details.requestingUrl)).toHaveBeenCalledExactlyOnceWith(false);
    }
  });

  it('denies clipboard requests outside the exact main renderer frame and URL', () => {
    let requestHandler: (...args: any[]) => void = () => {};
    const mainWebContents = {};
    const otherWebContents = {};
    const rendererUrl = 'file:///C:/CogSeed/src/renderer/index.html';
    const targetSession = {
      setPermissionRequestHandler(handler: (...args: any[]) => void) { requestHandler = handler; },
      setPermissionCheckHandler() {},
    };
    installMainRendererAudioPermissionGate(targetSession as never, mainWebContents as never, rendererUrl);

    for (const [webContents, permission, details] of [
      [otherWebContents, 'clipboard-read', { isMainFrame: true, requestingUrl: rendererUrl }],
      [mainWebContents, 'clipboard-read', { isMainFrame: false, requestingUrl: rendererUrl }],
      [mainWebContents, 'clipboard-read', { isMainFrame: true, requestingUrl: 'https://evil.test/' }],
      [mainWebContents, 'clipboard-read', { isMainFrame: true, requestingUrl: 'chat-app://cid/a/index.html' }],
      [mainWebContents, 'clipboard-write', { isMainFrame: true, requestingUrl: rendererUrl }],
    ] as const) {
      const callback = vi.fn();
      requestHandler(webContents, permission, callback, details);
      expect(callback, permission).toHaveBeenCalledExactlyOnceWith(false);
    }
  });
});
