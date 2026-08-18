/**
 * OAuth 回调接收服务器（AGENTS.md「无 HTTP server、无端口占用」的受控例外）。
 *
 * 仅当用户发起飞书授权时存在：
 * - 监听 127.0.0.1（默认 OS 随机端口，授权可传固定端口——飞书要求
 *   redirect_uri 与后台配置精确一致，真实授权必须固定；绝不监听非回环地址）；
 * - 只接受一次 `GET <path>?code=&state=` 回调，收到后立即关闭；
 * - 默认 5 分钟超时，超时自动关闭并 reject；
 * - 除目标路径外一律 404，非 GET 一律 405——不做任何其他路由。
 *
 * 生命周期由调用方保证：begin 时启动，完成/超时/取消时关闭，绝不常驻。
 * state 防 CSRF 由 oauth-manager 的 pendingState 校验完成（本模块只透传）。
 */
import * as http from 'node:http';
import { createLogger } from '../../logger';

const log = createLogger('personal-context:callback');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PATH = '/oauth/feishu/callback';
const HOST = '127.0.0.1';

export interface OAuthCallback {
  code: string;
  state: string;
}

export interface OAuthCallbackServerHandle {
  /** 完整回调 URL，作为飞书 OAuth 的 redirect_uri（含随机端口） */
  redirectUri: string;
  /** 等待回调：resolve({code, state})，超时/关闭时 reject */
  wait(): Promise<OAuthCallback>;
  /** 主动关闭（幂等）：取消等待中的 promise、释放端口 */
  close(): Promise<void>;
}

export interface StartOAuthCallbackServerOptions {
  path?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 监听端口；默认 0 = OS 动态分配。飞书 OAuth 要求 redirect_uri 与开发者
   *  后台配置精确一致，真实授权必须传固定端口；测试保持 0 避免冲突。 */
  port?: number;
}

function extractQuery(url: string): URLSearchParams {
  try {
    return new URL(url, `http://${HOST}`).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export async function startOAuthCallbackServer(
  opts: StartOAuthCallbackServerOptions = {},
): Promise<OAuthCallbackServerHandle> {
  const path = opts.path ?? DEFAULT_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let resolveCallback: ((value: OAuthCallback) => void) | undefined;
  let rejectCallback: ((reason: Error) => void) | undefined;
  let closed = false;
  /** wait() 是否被调用过：没人等待时关闭/超时不应 reject（避免 unhandled rejection） */
  let waited = false;

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', `http://${HOST}`).pathname;
    } catch {
      pathname = '/';
    }
    if (pathname !== path) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const params = extractQuery(req.url ?? '');
    const code = params.get('code') ?? '';
    const state = params.get('state') ?? '';
    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('missing code or state');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><p>授权完成，请返回应用。</p>');
    if (resolveCallback) resolveCallback({ code, state });
    // 收到回调即关闭：一次性服务器，端口不再复用。
    void server.close();
    closed = true;
  });
  server.on('error', (error) => {
    if (rejectCallback) rejectCallback(new Error(`oauth callback server error: ${error.message}`));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('oauth callback server failed to allocate a port');
  }

  const promise = new Promise<OAuthCallback>((resolve, reject) => {
    const settleResolve = (value: OAuthCallback): void => { clearTimeout(timer); resolve(value); };
    const settleReject = (reason: Error): void => { clearTimeout(timer); reject(reason); };
    const timer = setTimeout(() => {
      if (!closed) {
        settleReject(new Error('oauth callback timed out'));
        void closeServer(server);
      }
    }, timeoutMs);
    resolveCallback = settleResolve;
    rejectCallback = settleReject;
    if (opts.signal?.aborted) {
      settleReject(new Error('oauth callback aborted'));
      void closeServer(server);
    } else {
      opts.signal?.addEventListener('abort', () => {
        if (!closed) {
          settleReject(new Error('oauth callback aborted'));
          void closeServer(server);
        }
      }, { once: true });
    }
  });

  const redirectUri = `http://${HOST}:${address.port}${path}`;
  log.info('oauth callback server started', { path, timeoutMs });
  return {
    redirectUri,
    wait: () => {
      waited = true;
      return promise;
    },
    close: () => {
      // 显式关闭 = 取消等待：未决的 wait() 立即 reject（幂等）。
      if (!closed) {
        closed = true;
        if (waited && rejectCallback) rejectCallback(new Error('oauth callback closed'));
      }
      return closeServer(server);
    },
  };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
    // close 可能因未 listening 而直接回调，也可能需要等连接结束；
    // closeAllConnections 兜底后 close 回调必然触发。
  });
}
