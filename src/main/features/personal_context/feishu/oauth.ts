/**
 * 飞书用户 OAuth（授权码 + user_access_token），与机器人应用令牌严格分离。
 *
 * - buildFeishuAuthorizeUrl：授权页 URL 构造（只读权限 scopes，MVP 默认）。
 * - createFeishuTokenEndpoint：兑换/刷新/撤销/健康检查的 TokenEndpoint 实现。
 *
 * ⚠️ 端点路径为骨架初值，接入真实测试租户时以开放平台文档校准。
 * ⚠️ 本模块只处理 user_access_token；app_access_token/机器人凭据走 messaging 体系，
 *   严禁在此复用或混用。
 */
import { TokenEndpoint, TokenEndpointError } from '../oauth-manager';

const AUTHORIZE_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const REVOKE_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v1/oidc/revoke';
const USER_INFO_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v1/user_info';

/** MVP 只读权限（设计稿 §1.3）：日历 + 云空间 + 文档/知识库 */
export const FEISHU_READ_SCOPES = [
  'calendar:calendar',
  'calendar:calendar.event',
  'drive:drive',
  'drive:file',
  'wiki:wiki',
] as const;

export interface FeishuOAuthApp {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export interface FeishuTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface HttpTransport {
  postJson(url: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<unknown>;
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
}

/** 基于 fetch 的默认传输（Electron main 进程全局 fetch） */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return {
    async postJson(url, body, headers = {}) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`http ${response.status}`);
      return response.json();
    },
    async getJson(url, headers = {}) {
      const response = await fetchImpl(url, { method: 'GET', headers });
      if (!response.ok) throw new Error(`http ${response.status}`);
      return response.json();
    },
  };
}

/**
 * 构造授权页 URL；state 由 OAuthManager.beginAuthorize 生成后传入。
 * scopes 为空时使用只读默认集。
 */
export function buildFeishuAuthorizeUrl(app: FeishuOAuthApp, state: string, scopes: string[]): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('app_id', app.appId);
  url.searchParams.set('redirect_uri', app.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', (scopes.length > 0 ? scopes : FEISHU_READ_SCOPES).join(' '));
  return url.toString();
}

export interface FeishuTokenEndpointOptions {
  app: FeishuOAuthApp;
  transport?: HttpTransport;
}

function parseTokenResponse(body: unknown): FeishuTokenResponse {
  const data = body as { code?: unknown; msg?: unknown } & FeishuTokenResponse;
  if (typeof data.code === 'number' && data.code !== 0) {
    // 10003/10642 等 = 无效授权（invalid_grant 语义）
    if (data.code === 10003 || data.code === 10642 || data.code === 99991672) {
      throw new TokenEndpointError('invalid_grant', `飞书授权已失效（${data.code}），请重新授权`);
    }
    throw new TokenEndpointError('provider_error', `飞书 token 端点错误 ${data.code}: ${data.msg ?? ''}`);
  }
  if (!data.access_token) throw new TokenEndpointError('provider_error', '飞书 token 响应缺少 access_token');
  return data;
}

function credentialFrom(body: unknown, scopes: string[]): import('../oauth-manager').OAuthCredential {
  const data = parseTokenResponse(body);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
    scopes: data.scope ? data.scope.split(' ') : scopes,
    issuedAt: new Date().toISOString(),
  };
}

/**
 * 飞书 TokenEndpoint：授权码兑换/刷新/撤销/健康检查。
 * transport 可注入（测试 mock），默认走 fetch。
 */
export function createFeishuTokenEndpoint(opts: FeishuTokenEndpointOptions): TokenEndpoint {
  const transport = opts.transport ?? createFetchTransport();
  const app = opts.app;

  return {
    async exchangeCode(code: string, redirectUri: string) {
      let body: unknown;
      try {
        body = await transport.postJson(TOKEN_ENDPOINT, {
          grant_type: 'authorization_code',
          client_id: app.appId,
          client_secret: app.appSecret,
          code,
          redirect_uri: redirectUri,
        });
      } catch (err) {
        throw new TokenEndpointError('network_error', `飞书授权兑换网络错误: ${err instanceof Error ? err.message : String(err)}`);
      }
      return credentialFrom(body, []);
    },

    async refreshToken(refreshToken: string, scopes: string[]) {
      let body: unknown;
      try {
        body = await transport.postJson(TOKEN_ENDPOINT, {
          grant_type: 'refresh_token',
          client_id: app.appId,
          client_secret: app.appSecret,
          refresh_token: refreshToken,
        });
      } catch (err) {
        throw new TokenEndpointError('network_error', `飞书令牌刷新网络错误: ${err instanceof Error ? err.message : String(err)}`);
      }
      return credentialFrom(body, scopes);
    },

    async revokeToken(refreshToken: string) {
      let body: unknown;
      try {
        body = await transport.postJson(REVOKE_ENDPOINT, {
          token: refreshToken,
          token_type_hint: 'refresh_token',
        });
      } catch (err) {
        throw new TokenEndpointError('network_error', `飞书撤销网络错误: ${err instanceof Error ? err.message : String(err)}`);
      }
      const data = body as { code?: unknown };
      if (typeof data.code === 'number' && data.code !== 0) {
        throw new TokenEndpointError('provider_error', `飞书撤销失败 ${data.code}`);
      }
    },

    async healthCheck(accessToken: string) {
      try {
        const body = (await transport.getJson(USER_INFO_ENDPOINT, {
          Authorization: `Bearer ${accessToken}`,
        })) as { code?: unknown; msg?: unknown };
        if (typeof body.code === 'number' && body.code !== 0) {
          const invalid = body.code === 10003 || body.code === 10642 || body.code === 99991672;
          return {
            ok: false,
            error: invalid ? '飞书令牌已失效' : `飞书健康检查失败（${body.code}）`,
            code: invalid ? 'invalid_grant' : 'provider_error',
          };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'network_error',
        };
      }
    },
  };
}
