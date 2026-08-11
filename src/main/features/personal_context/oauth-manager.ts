/**
 * 统一 OAuth 管理器（设计稿 §5.2）：授权码流程 + 刷新/撤销/健康检查状态机。
 *
 * - 状态机 kinds 对齐 messaging 实例状态机（disconnected/connecting/connected/error）。
 * - 凭据加密存机器私有区 `<uid>/local/config/personal-context/<provider>.json`，
 *   复用 local-secret-store（namespace 绑定 uid + providerId），不进云同步。
 * - 令牌绝不进入日志/账本/本体/提示词（§6）：本模块只落盘加密载荷，
 *   日志只记录状态转移，不打印任何令牌内容。
 *
 * TokenEndpoint 由各 provider 实现（feishu/oauth.ts 为飞书真实端点，测试注入 mock）。
 */
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Mutex } from 'async-mutex';

import { readJson, writeJson, nowIso } from '../../storage';
import { userLocalConfigDir } from '../../paths';
import * as localSecrets from '../../util/local-secret-store';
import { createLogger } from '../../logger';
import type { ConnectorStatus, ConnectorStatusKind } from './contract';
import { CONNECTOR_STATUS_KINDS } from './contract';

const log = createLogger('personal-context:oauth');

const SECRET_NAMESPACE = 'personal-context.oauth';
const CONFIG_VERSION = 1;
const CONFIG_DIR = 'personal-context';

// ── 凭据与端点接口 ────────────────────────────────────────────────────────
export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  /** ISO 时间；过期后优先走 refresh */
  expiresAt?: string;
  scopes: string[];
  issuedAt: string;
}

/** 端点错误码：invalid_grant=需要重新授权；network_error=可重试；其余为 provider 错误 */
export type TokenEndpointErrorCode = 'invalid_grant' | 'network_error' | 'provider_error' | 'state_mismatch';

export class TokenEndpointError extends Error {
  readonly code: TokenEndpointErrorCode;
  constructor(code: TokenEndpointErrorCode, message: string) {
    super(message);
    this.name = 'TokenEndpointError';
    this.code = code;
  }
}

/** 各 provider 实现的 token 端点（飞书：feishu/oauth.ts；测试注入 mock） */
export interface TokenEndpoint {
  exchangeCode(code: string, redirectUri: string): Promise<OAuthCredential>;
  refreshToken(refreshToken: string, scopes: string[]): Promise<OAuthCredential>;
  revokeToken(refreshToken: string): Promise<void>;
  /** 用当前 access token 做轻量健康检查（如 user_info）；ok=false 时附原因。
   *  identity 为可选的用户身份解析（unionId/tenantKey/name），供 provider 构建使用 */
  healthCheck?: (accessToken: string) => Promise<{
    ok: boolean;
    error?: string;
    code?: string;
    identity?: { unionId?: string; tenantKey?: string; name?: string };
  }>;
}

// ── 落盘结构 ──────────────────────────────────────────────────────────────
export interface OAuthStoreFile {
  version: number;
  providerId: string;
  status: ConnectorStatus;
  /** 最近一次失败的错误码（决定 needsReauth / 可重试） */
  lastErrorCode?: TokenEndpointErrorCode;
  /** 授权流程中的一次性 state（CSRF 防护）；完成回调后清空 */
  pendingState?: string;
  scopes: string[];
  connectedAt?: string;
  /** 授权账号的展示名（user_info.name，授权完成后写入一次） */
  identityLabel?: string;
  /** 加密后的 OAuthCredential JSON（local-secret-store 加密），仅已授权时存在 */
  secretsEnc?: string;
}

export interface OAuthConnectionStatus extends ConnectorStatus {
  /** true 表示令牌已失效、必须重新授权（invalid_grant） */
  needsReauth: boolean;
  connectedAt?: string;
  /** 授权账号的展示名（user_info.name） */
  identityLabel?: string;
}

// ── 路径与锁 ──────────────────────────────────────────────────────────────
function storeFile(uid: string, providerId: string): string {
  // 机器私有：userLocalConfigDir(uid)/personal-context/<provider>.json
  return path.join(userLocalConfigDir(uid), CONFIG_DIR, `${providerId}.json`);
}

const locks = new Map<string, Mutex>();

function lockFor(uid: string, providerId: string): Mutex {
  const key = `${uid}\0${providerId}`;
  let lock = locks.get(key);
  if (!lock) {
    lock = new Mutex();
    locks.set(key, lock);
  }
  return lock;
}

function secretContext(uid: string, providerId: string): localSecrets.LocalSecretContext {
  return { namespace: SECRET_NAMESPACE, ownerId: uid, recordId: providerId };
}

function status(kind: ConnectorStatusKind, error?: string): ConnectorStatus {
  return { kind, checkedAt: nowIso(), ...(error ? { error } : {}) };
}

function emptyStore(providerId: string): OAuthStoreFile {
  return {
    version: CONFIG_VERSION,
    providerId,
    status: status('disconnected'),
    scopes: [],
  };
}

async function readStore(uid: string, providerId: string): Promise<OAuthStoreFile> {
  try {
    const raw = await readJson<Partial<OAuthStoreFile>>(storeFile(uid, providerId));
    const base = emptyStore(providerId);
    return {
      ...base,
      ...raw,
      status: raw.status && CONNECTOR_STATUS_KINDS.includes(raw.status.kind)
        ? raw.status
        : base.status,
      scopes: Array.isArray(raw.scopes) ? raw.scopes : [],
    };
  } catch {
    return emptyStore(providerId);
  }
}

// ── 管理器 ────────────────────────────────────────────────────────────────
export interface AuthorizeRequest {
  /** 完整授权页 URL（由 provider 的 buildAuthorizeUrl 拼接，含 state） */
  authUrl: string;
  state: string;
}

export class OAuthManager {
  private readonly endpoint: TokenEndpoint;

  constructor(endpoint: TokenEndpoint) {
    this.endpoint = endpoint;
  }

  /**
   * 开始授权：状态 → connecting，保存一次性 state（CSRF 防护）。
   * buildAuthUrl 由 provider 提供（feishu/oauth.ts::buildFeishuAuthorizeUrl），
   * 接收管理器生成的 state，返回完整授权页 URL。
   */
  async beginAuthorize(
    uid: string,
    providerId: string,
    scopes: string[],
    buildAuthUrl: (state: string) => string,
  ): Promise<AuthorizeRequest> {
    const release = await lockFor(uid, providerId).acquire();
    try {
      const store = await readStore(uid, providerId);
      const state = `pc_${providerId}_${crypto.randomBytes(16).toString('hex')}`;
      store.status = status('connecting');
      store.pendingState = state;
      store.scopes = scopes;
      store.lastErrorCode = undefined;
      await writeStore(uid, providerId, store);
      log.info('oauth beginAuthorize', { providerId, uid: redactUid(uid) });
      return { authUrl: buildAuthUrl(state), state };
    } finally {
      release();
    }
  }

  /**
   * 授权回调：校验 state → 兑换 token → 加密落盘 → connected。
   * state 不匹配：置 error（state_mismatch），不落凭据。
   */
  async completeAuthorize(
    uid: string,
    providerId: string,
    code: string,
    state: string,
    redirectUri: string,
  ): Promise<OAuthConnectionStatus> {
    const release = await lockFor(uid, providerId).acquire();
    try {
      const store = await readStore(uid, providerId);
      if (!store.pendingState || store.pendingState !== state) {
        store.status = status('error', '授权回调 state 不匹配，请重新发起授权');
        store.lastErrorCode = 'state_mismatch';
        store.pendingState = undefined;
        await writeStore(uid, providerId, store);
        log.warn('oauth state mismatch', { providerId });
        return toConnectionStatus(store);
      }
      try {
        const credential = await this.endpoint.exchangeCode(code, redirectUri);
        store.secretsEnc = encryptCredential(uid, providerId, credential);
        store.status = status('connected');
        store.connectedAt = nowIso();
        store.pendingState = undefined;
        store.lastErrorCode = undefined;
        await writeStore(uid, providerId, store);
        log.info('oauth connected', { providerId });
      } catch (err) {
        store.pendingState = undefined;
        store.status = status('error', errorMessage(err));
        store.lastErrorCode = errorCode(err);
        await writeStore(uid, providerId, store);
        log.error('oauth exchange failed', { providerId, code: errorCode(err) });
      }
      return toConnectionStatus(store);
    } finally {
      release();
    }
  }

  /** 刷新令牌：成功 → connected；invalid_grant → error（needsReauth）；网络错误 → error（可重试） */
  async refresh(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
    const release = await lockFor(uid, providerId).acquire();
    try {
      const store = await readStore(uid, providerId);
      const credential = this.decryptCredential(uid, store);
      if (!credential?.refreshToken) {
        store.status = status('error', '缺少刷新令牌，需要重新授权');
        store.lastErrorCode = 'invalid_grant';
        await writeStore(uid, providerId, store);
        return toConnectionStatus(store);
      }
      try {
        const next = await this.endpoint.refreshToken(credential.refreshToken, store.scopes);
        store.secretsEnc = encryptCredential(uid, providerId, next);
        store.status = status('connected');
        store.connectedAt = nowIso();
        store.lastErrorCode = undefined;
        await writeStore(uid, providerId, store);
        log.info('oauth refreshed', { providerId });
      } catch (err) {
        store.status = status('error', errorMessage(err));
        store.lastErrorCode = errorCode(err);
        await writeStore(uid, providerId, store);
        log.error('oauth refresh failed', { providerId, code: errorCode(err) });
      }
      return toConnectionStatus(store);
    } finally {
      release();
    }
  }

  /**
   * 撤销授权：先远端 revoke（失败仅记日志），本地凭据与 pendingState 一律清除，
   * 状态 → disconnected。用户意图优先：远端失败也保证本地令牌不可用。
   */
  async revoke(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
    const release = await lockFor(uid, providerId).acquire();
    try {
      const store = await readStore(uid, providerId);
      const credential = this.decryptCredential(uid, store);
      if (credential?.refreshToken) {
        try {
          await this.endpoint.revokeToken(credential.refreshToken);
          log.info('oauth revoked', { providerId });
        } catch (err) {
          log.warn('oauth revoke remote failed, local credential cleared', { providerId, code: errorCode(err) });
        }
      }
      store.secretsEnc = undefined;
      store.pendingState = undefined;
      store.connectedAt = undefined;
      store.lastErrorCode = undefined;
      store.status = status('disconnected');
      await writeStore(uid, providerId, store);
      return toConnectionStatus(store);
    } finally {
      release();
    }
  }

  /**
   * 取消进行中的授权：清 pendingState、收敛 connecting → disconnected。
   * 用户放弃授权/回调超时后调用，避免状态悬挂在 connecting。
   */
  async cancelAuthorize(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
    const release = await lockFor(uid, providerId).acquire();
    try {
      const store = await readStore(uid, providerId);
      if (store.pendingState || store.status.kind === 'connecting') {
        store.pendingState = undefined;
        store.status = status('disconnected');
        store.lastErrorCode = undefined;
        await writeStore(uid, providerId, store);
      }
      return toConnectionStatus(store);
    } finally {
      release();
    }
  }

  /** 健康检查：令牌有效 → connected；无效（401/invalid_grant）→ error + needsReauth；网络错误保留原状态 */
  async healthCheck(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
    const release = await lockFor(uid, providerId).acquire();
    try {
      const store = await readStore(uid, providerId);
      const credential = this.decryptCredential(uid, store);
      if (!credential) {
        store.status = status('disconnected');
        store.lastErrorCode = undefined;
        await writeStore(uid, providerId, store);
        return toConnectionStatus(store);
      }
      let result: { ok: boolean; error?: string; code?: string };
      try {
        result = await this.endpoint.healthCheck(credential.accessToken);
      } catch (err) {
        result = { ok: false, error: errorMessage(err), code: errorCode(err) };
      }
      if (result.ok) {
        store.status = status('connected');
        store.lastErrorCode = undefined;
      } else if (result.code === 'network_error') {
        // 网络抖动不判定失效，保留原状态
        store.status = { kind: store.status.kind, checkedAt: nowIso() };
      } else {
        store.status = status('error', result.error ?? '健康检查失败');
        store.lastErrorCode = result.code === 'invalid_grant' || result.code === 'network_error'
          ? result.code
          : 'provider_error';
      }
      await writeStore(uid, providerId, store);
      return toConnectionStatus(store);
    } finally {
      release();
    }
  }

  /** 读取当前连接状态（不含任何令牌内容） */
  async getStatus(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
    const store = await readStore(uid, providerId);
    return toConnectionStatus(store);
  }

  /** 授权账号展示名（user_info.name），授权完成后写入一次供 dashboard 展示 */
  async setIdentityLabel(uid: string, providerId: string, label: string): Promise<void> {
    const clean = typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : '';
    if (!clean) return;
    const release = await lockFor(uid, providerId).acquire();
    try {
      const store = await readStore(uid, providerId);
      if (store.identityLabel === clean) return;
      store.identityLabel = clean;
      await writeStore(uid, providerId, store);
    } finally {
      release();
    }
  }

  /** 供同步等内部使用：解密凭据；未授权/已撤销返回 null */
  async getCredential(uid: string, providerId: string): Promise<OAuthCredential | null> {
    const store = await readStore(uid, providerId);
    return this.decryptCredential(uid, store);
  }

  private decryptCredential(uid: string, store: OAuthStoreFile): OAuthCredential | null {
    if (!store.secretsEnc) return null;
    try {
      const plaintext = localSecrets.decryptLocalSecret(secretContext(uid, store.providerId), store.secretsEnc);
      return JSON.parse(plaintext) as OAuthCredential;
    } catch (err) {
      log.error('oauth credential decrypt failed', { providerId: store.providerId, err: errorMessage(err) });
      return null;
    }
  }
}

// ── 内部工具 ──────────────────────────────────────────────────────────────
function encryptCredential(uid: string, providerId: string, credential: OAuthCredential): string {
  return localSecrets.encryptLocalSecret(secretContext(uid, providerId), JSON.stringify(credential));
}

async function writeStore(uid: string, providerId: string, store: OAuthStoreFile): Promise<void> {
  await writeJson(storeFile(uid, providerId), store);
}

function toConnectionStatus(store: OAuthStoreFile): OAuthConnectionStatus {
  return {
    ...store.status,
    needsReauth: store.lastErrorCode === 'invalid_grant',
    connectedAt: store.connectedAt,
    ...(store.identityLabel ? { identityLabel: store.identityLabel } : {}),
  };
}

function errorCode(err: unknown): TokenEndpointErrorCode {
  return err instanceof TokenEndpointError ? err.code : 'provider_error';
}

function errorMessage(err: unknown): string {
  if (err instanceof TokenEndpointError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function redactUid(uid: string): string {
  // 日志不落完整用户目录名
  return uid.length > 6 ? `${uid.slice(0, 3)}…${uid.slice(-3)}` : '***';
}
