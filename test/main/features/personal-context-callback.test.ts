/**
 * OAuth 回调服务器测试：一次性回环服务器（AGENTS.md 受控例外）的核心不变式。
 *
 * - 有效回调（GET 目标路径 + code + state）→ wait resolve，响应 200；
 * - 非目标路径 404、非 GET 405、缺参 400——不做任何其他路由；
 * - 超时/关闭 reject 并释放端口（可立即复用）；
 * - redirectUri 恒为 127.0.0.1 + OS 分配端口 + 默认路径。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startOAuthCallbackServer } from '../../../src/main/features/personal_context/callback-server';

const handles: Array<Awaited<ReturnType<typeof startOAuthCallbackServer>>> = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
});

describe('personal context oauth callback server', () => {
  it('resolves with code and state on a valid callback and answers 200', async () => {
    const handle = await startOAuthCallbackServer();
    handles.push(handle);
    expect(handle.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/feishu\/callback$/);

    const waiting = handle.wait();
    const response = await fetch(`${handle.redirectUri}?code=abc123&state=pc_feishu_xyz`);
    expect(response.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'abc123', state: 'pc_feishu_xyz' });
  });

  it('binds a fixed port when requested and surfaces it in redirectUri', async () => {
    // 真实授权必须固定端口（飞书要求 redirect_uri 与后台配置精确一致）；
    // 选一个高位端口避免与常见开发端口冲突。
    const fixed = await startOAuthCallbackServer({ port: 36415 });
    handles.push(fixed);
    expect(fixed.redirectUri).toBe('http://127.0.0.1:36415/oauth/feishu/callback');
  });

  it('rejects with a clear error when the fixed port is already taken', async () => {
    const first = await startOAuthCallbackServer({ port: 36416 });
    handles.push(first);
    await expect(startOAuthCallbackServer({ port: 36416 })).rejects.toThrow(/EADDRINUSE|address already in use/);
  });

  it('answers 404 for any path outside the callback route', async () => {
    const handle = await startOAuthCallbackServer();
    handles.push(handle);
    const origin = handle.redirectUri.replace(/\/oauth\/feishu\/callback$/, '');
    const response = await fetch(`${origin}/other?code=x&state=y`);
    expect(response.status).toBe(404);
  });

  it('answers 405 for non-GET methods', async () => {
    const handle = await startOAuthCallbackServer();
    handles.push(handle);
    const response = await fetch(handle.redirectUri, { method: 'POST', body: 'code=x&state=y' });
    expect(response.status).toBe(405);
  });

  it('answers 400 when code or state is missing', async () => {
    const handle = await startOAuthCallbackServer();
    handles.push(handle);
    const missingState = await fetch(`${handle.redirectUri}?code=abc`);
    expect(missingState.status).toBe(400);
    const missingCode = await fetch(`${handle.redirectUri}?state=pc_feishu_xyz`);
    expect(missingCode.status).toBe(400);
  });

  it('rejects on timeout and remains able to start a fresh server', async () => {
    const handle = await startOAuthCallbackServer({ timeoutMs: 80 });
    handles.push(handle);
    await expect(handle.wait()).rejects.toThrow('timed out');
    // 超时后端口已释放：可以立刻再启动一个新回调服务器（端口由 OS 重新分配）。
    const second = await startOAuthCallbackServer({ timeoutMs: 60_000 });
    handles.push(second);
    expect(second.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/feishu\/callback$/);
  });

  it('rejects on explicit close and close() is idempotent', async () => {
    const handle = await startOAuthCallbackServer({ timeoutMs: 60_000 });
    handles.push(handle);
    const waiting = handle.wait();
    await handle.close();
    await expect(waiting).rejects.toThrow();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('rejects when aborted via AbortSignal', async () => {
    const controller = new AbortController();
    const handle = await startOAuthCallbackServer({ signal: controller.signal });
    handles.push(handle);
    const waiting = handle.wait();
    controller.abort();
    await expect(waiting).rejects.toThrow('aborted');
  });
});
