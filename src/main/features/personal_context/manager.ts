/**
 * 个人上下文连接器业务入口（IPC 层调用）。
 *
 * 飞书用户 OAuth 编排：
 * 1. 复用 messaging 已配置的飞书机器人凭据（同一应用的 appId/appSecret——
 *    机器人用 tenant_access_token，此处用同一凭据换 user_access_token，双身份分离指令牌类型而非 appId）；
 * 2. 启动一次性本地回调服务器（AGENTS.md 受控例外，仅授权瞬间存在）；
 * 3. 打开系统浏览器授权页，回调落地后兑换 token 并加密落盘。
 *
 * ⚠️ 真实租户验证点：飞书开放平台可能要求重定向 URL 精确匹配配置值（固定端口）。
 * 当前按 OS 分配动态端口实现；验证时若不支持，改为固定端口并在应用配置中写死。
 */
import { shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { nowIso, readJson, writeJson } from '../../storage';
import { userLocalConfigDir } from '../../paths';
import * as messagingRegistry from '../messaging/registry';
import { OAuthManager, OAuthConnectionStatus } from './oauth-manager';
import { buildFeishuAuthorizeUrl, createFeishuTokenEndpoint, FEISHU_READ_SCOPES, FEISHU_SHARE_SCOPES } from './feishu/oauth';
import { startOAuthCallbackServer, type OAuthCallbackServerHandle } from './callback-server';
import { HttpFeishuApiClient } from './feishu/api-client';
import { createFeishuProvider } from './feishu/provider';
import { PersonalContextCursorStore, PersonalContextRegistry } from './registry';
import { ScopeManifestStore } from './scope-manifest';
import { PersonalContextSyncScheduler, type SyncRunner } from './sync-scheduler';
import type { ConnectorProvider, SyncResult } from './contract';

const log = createLogger('personal-context:manager');

const PROVIDER_ID = 'feishu';
/** 仅 exchangeCode 会用到真实 redirectUri；其余端点调用以占位即可 */
const PLACEHOLDER_REDIRECT = 'http://127.0.0.1/oauth/feishu/callback';

/**
 * OAuth 回调固定端口（实测验证点：飞书要求 redirect_uri 与开发者后台配置
 * 精确一致，动态端口报 20029）。修改端口必须同步更新开发者后台的
 * 重定向 URL 配置：http://127.0.0.1:36415/oauth/feishu/callback
 */
export const FEISHU_OAUTH_CALLBACK_PORT = 36415;
const FEISHU_OAUTH_CALLBACK_PATH = '/oauth/feishu/callback';

interface AuthorizeFlow {
  providerId: string;
  handle: OAuthCallbackServerHandle;
}

const flows = new Map<string, AuthorizeFlow>();

function flowKey(uid: string, providerId: string): string {
  return `${uid}:${providerId}`;
}

/** 授权状态变化广播给渲染层（OAuth 完成/取消/撤销时）。channel 在 preload
 * 的 `personal-context:` 推送前缀白名单内。推送是尽力而为，失败不影响流程。 */
function broadcastAuthorizationStatus(uid: string, status: OAuthConnectionStatus): void {
  try {
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    if (typeof ipc.broadcastToRenderer !== 'function') return;
    ipc.broadcastToRenderer('personal-context:authorization', { uid, status: { ...status, authorizing: false } });
  } catch {
    /* push is best-effort */
  }
}

export interface BeginAuthorizeResult {
  redirectUri: string;
  status: OAuthConnectionStatus & { authorizing?: boolean };
}

function createManager(appId: string, appSecret: string): OAuthManager {
  return new OAuthManager(createFeishuTokenEndpoint({
    app: { appId, appSecret, redirectUri: PLACEHOLDER_REDIRECT },
  }));
}

/**
 * 从候选飞书实例中挑一个用于 OAuth 授权。
 * 优先级：feishu（中国版）品牌 > 已连接实例 > 第一个已配置实例。
 * 授权页域名固定 open.feishu.cn（MVP 只做中国版飞书），Lark 实例的
 * appId 在飞书域无法授权，必须优先 brand=feishu，避免用户同时配了
 * 飞书 + Lark 应用时自动选到 Lark。
 */
export function pickFeishuInstance(candidates: Array<{ id: string; feishuTenantBrand?: string; status: { kind: string } }>): string | undefined {
  return (
    candidates.find((item) => item.feishuTenantBrand === 'feishu')?.id
    ?? candidates.find((item) => item.status.kind === 'connected')?.id
    ?? candidates[0]?.id
  );
}

/**
 * 从 messaging 配置中解析飞书应用凭据。优先显式 instanceId；
 * 未指定时用 pickFeishuInstance 选择（飞书品牌优先，其次 connected，再任意）。
 */
async function resolveFeishuApp(uid: string, instanceId?: string): Promise<{ appId: string; appSecret: string }> {
  const instances = await messagingRegistry.listInstances(uid);
  const candidates = instances.filter((item) => item.platform === 'feishu_lark');
  const chosenId = instanceId ?? pickFeishuInstance(candidates);
  if (!chosenId) {
    throw new Error('未配置飞书机器人：请先在「设置 → 消息平台」完成飞书绑定');
  }
  const loaded = await messagingRegistry.getInstanceWithSecret(uid, chosenId);
  if (!loaded) {
    throw new Error('飞书机器人凭据不可用，请重新绑定');
  }
  return { appId: loaded.secret.appId, appSecret: loaded.secret.appSecret };
}

/**
 * 发起飞书授权：启动回调服务器 → 打开授权页 → 后台等待回调并兑换。
 * 非阻塞：立即返回；授权结果通过 getStatus 轮询获取。
 * scopes 缺省为只读（个人上下文同步用）；分享场景传 FEISHU_SHARE_SCOPES
 * （方案 A/B：创建 docx/wiki + 写内容 + 设权限，需用户重新授权一次）。
 */
export async function beginAuthorize(
  uid: string,
  opts: { instanceId?: string; scopes?: readonly string[] } = {},
): Promise<BeginAuthorizeResult> {
  const scopes = opts.scopes && opts.scopes.length > 0 ? [...opts.scopes] : [...FEISHU_READ_SCOPES];
  // 已有进行中的授权流：先关闭旧回调服务器（端口释放 + wait reject），
  // 防止用户连点「连接」导致回调服务器泄漏与状态混乱。
  const existing = flows.get(flowKey(uid, PROVIDER_ID));
  if (existing) {
    await existing.handle.close().catch(() => undefined);
    flows.delete(flowKey(uid, PROVIDER_ID));
  }
  const { appId, appSecret } = await resolveFeishuApp(uid, opts.instanceId);
  let handle: OAuthCallbackServerHandle;
  try {
    handle = await startOAuthCallbackServer({ port: FEISHU_OAUTH_CALLBACK_PORT });
  } catch (error) {
    throw new Error(
      `回调端口 ${FEISHU_OAUTH_CALLBACK_PORT} 启动失败：${(error as Error).message}。` +
      `请关闭占用该端口的程序后重试（飞书要求回调地址固定，无法自动换端口）。`,
    );
  }
  const endpoint = createFeishuTokenEndpoint({ app: { appId, appSecret, redirectUri: PLACEHOLDER_REDIRECT } });
  const oauth = new OAuthManager(endpoint);
  try {
    const request = await oauth.beginAuthorize(uid, PROVIDER_ID, scopes, (state) =>
      buildFeishuAuthorizeUrl({ appId, appSecret, redirectUri: handle.redirectUri }, state, scopes));
    flows.set(flowKey(uid, PROVIDER_ID), { providerId: PROVIDER_ID, handle });
    void shell.openExternal(request.authUrl).catch((error) => {
      log.warn('open feishu authorize url failed', { error: (error as Error).message });
    });
    void handle.wait()
      .then(async ({ code, state }) => {
        const result = await oauth.completeAuthorize(uid, PROVIDER_ID, code, state, handle.redirectUri);
        log.info('feishu oauth completed', { status: result.kind });
        broadcastAuthorizationStatus(uid, result);
        if (result.kind === 'connected') {
          // 授权账号展示名：user_info.name 写入 store，供 dashboard「授权账号」展示。
          // 异步执行，不阻塞首次回填启动（一次网络往返没必要排在同步前面）。
          void (async () => {
            try {
              const credential = await oauth.getCredential(uid, PROVIDER_ID);
              if (!credential) return;
              const health = await endpoint.healthCheck(credential.accessToken);
              if (health.ok && health.identity?.name) {
                await oauth.setIdentityLabel(uid, PROVIDER_ID, health.identity.name).catch((error) => {
                  log.warn('oauth identity label write failed', { uid, error: (error as Error).message });
                });
              }
            } catch (error) {
              log.warn('feishu identity resolution failed', { uid, error: (error as Error).message });
            }
          })();
          // 首次连接：启动定时增量同步，并立即 tick 做有限回填（30 天/90 天）
          ensureSyncScheduler(uid).start(uid);
          void syncNow(uid).catch((error) => {
            log.warn('feishu initial backfill failed, retried by scheduler', { uid, error: (error as Error).message });
          });
        }
      })
      .catch(async (error) => {
        // 超时/取消：收敛挂起的 connecting 状态为可重试的 disconnected。
        log.warn('feishu oauth callback not completed', { error: (error as Error).message });
        const status = await oauth.cancelAuthorize(uid, PROVIDER_ID).catch(() => undefined);
        if (status) broadcastAuthorizationStatus(uid, status);
      })
      .finally(() => {
        flows.delete(flowKey(uid, PROVIDER_ID));
      });
    return { redirectUri: handle.redirectUri, status: await oauth.getStatus(uid, PROVIDER_ID) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * 分享场景授权：与 beginAuthorize 流程一致，但凭据源用分享专用应用配置
 * （feishu-share-app.json，可独立于消息机器人配置），scope 固定为写权限集合。
 * 未配置分享应用时抛错（渲染层应先用 kb.share.appConfig.set 保存凭据）。
 */
export async function beginShareAuthorize(uid: string): Promise<BeginAuthorizeResult> {
  const existing = flows.get(flowKey(uid, PROVIDER_ID));
  if (existing) {
    await existing.handle.close().catch(() => undefined);
    flows.delete(flowKey(uid, PROVIDER_ID));
  }
  const { appId, appSecret } = await resolveShareApp(uid); // 分享专用配置优先
  let handle: OAuthCallbackServerHandle;
  try {
    handle = await startOAuthCallbackServer({ port: FEISHU_OAUTH_CALLBACK_PORT });
  } catch (error) {
    throw new Error(
      `回调端口 ${FEISHU_OAUTH_CALLBACK_PORT} 启动失败：${(error as Error).message}。` +
      `请关闭占用该端口的程序后重试（飞书要求回调地址固定，无法自动换端口）。`,
    );
  }
  const endpoint = createFeishuTokenEndpoint({ app: { appId, appSecret, redirectUri: PLACEHOLDER_REDIRECT } });
  const oauth = new OAuthManager(endpoint);
  const scopes = [...FEISHU_SHARE_SCOPES];
  try {
    const request = await oauth.beginAuthorize(uid, PROVIDER_ID, scopes, (state) =>
      buildFeishuAuthorizeUrl({ appId, appSecret, redirectUri: handle.redirectUri }, state, scopes));
    flows.set(flowKey(uid, PROVIDER_ID), { providerId: PROVIDER_ID, handle });
    void shell.openExternal(request.authUrl).catch((error) => {
      log.warn('open feishu share authorize url failed', { error: (error as Error).message });
    });
    void handle.wait()
      .then(async ({ code, state }) => {
        const result = await oauth.completeAuthorize(uid, PROVIDER_ID, code, state, handle.redirectUri);
        log.info('feishu share oauth completed', { status: result.kind });
        broadcastAuthorizationStatus(uid, result);
        if (result.kind === 'connected') {
          void (async () => {
            try {
              const credential = await oauth.getCredential(uid, PROVIDER_ID);
              if (!credential) return;
              const health = await endpoint.healthCheck(credential.accessToken);
              if (health.ok && health.identity?.name) {
                await oauth.setIdentityLabel(uid, PROVIDER_ID, health.identity.name).catch((error) => {
                  log.warn('oauth identity label write failed', { uid, error: (error as Error).message });
                });
              }
            } catch (error) {
              log.warn('feishu share identity resolution failed', { uid, error: (error as Error).message });
            }
          })();
        }
      })
      .catch(async (error) => {
        log.warn('feishu share oauth callback not completed', { error: (error as Error).message });
        const status = await oauth.cancelAuthorize(uid, PROVIDER_ID).catch(() => undefined);
        if (status) broadcastAuthorizationStatus(uid, status);
      })
      .finally(() => {
        flows.delete(flowKey(uid, PROVIDER_ID));
      });
    return { redirectUri: handle.redirectUri, status: await oauth.getStatus(uid, PROVIDER_ID) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * 组装飞书 provider（同步/发现用）：凭据 → 身份解析（user_info 的
 * tenant_key + union_id）→ HttpFeishuApiClient → ConnectorProvider。
 * 返回 registry/cursors 引用供 IPC 层联动（发现即登记、scope 联动）。
 */
export interface BuiltFeishuProvider {
  provider: ConnectorProvider;
  registry: PersonalContextRegistry;
  cursors: PersonalContextCursorStore;
  identity: { tenant: string; unionId: string };
}

export async function buildFeishuProvider(uid: string): Promise<BuiltFeishuProvider> {
  const { appId, appSecret } = await resolveFeishuApp(uid);
  const endpoint = createFeishuTokenEndpoint({ app: { appId, appSecret, redirectUri: PLACEHOLDER_REDIRECT } });
  const oauth = new OAuthManager(endpoint);
  const credential = await oauth.getCredential(uid, PROVIDER_ID);
  if (!credential) {
    throw new Error('飞书尚未连接，请先完成授权');
  }
  const health = await endpoint.healthCheck(credential.accessToken);
  if (!health.ok || !health.identity?.unionId || !health.identity.tenantKey) {
    throw new Error('飞书身份解析失败，请重新授权');
  }
  const registry = new PersonalContextRegistry();
  const cursors = new PersonalContextCursorStore();
  const provider = createFeishuProvider(new HttpFeishuApiClient({ accessToken: credential.accessToken }), {
    tenant: health.identity.tenantKey,
    unionId: health.identity.unionId,
    registry,
    cursors,
  });
  return {
    provider,
    registry,
    cursors,
    identity: { tenant: health.identity.tenantKey, unionId: health.identity.unionId },
  };
}

// ── 同步调度器 ─────────────────────────────────────────────────────────────
const schedulers = new Map<string, PersonalContextSyncScheduler>();

/** 单轮同步：未连接/需重新授权 → null（调度器跳过）；否则 provider.sync（游标 CAS 内建） */
const syncRunner: SyncRunner = {
  async runSync(uid: string): Promise<SyncResult | null> {
    const status = await getStatus(uid, PROVIDER_ID);
    if (status.kind !== 'connected' || status.needsReauth) return null;
    const built = await buildFeishuProvider(uid);
    return built.provider.sync({ uid, providerId: PROVIDER_ID });
  },
};

/** 获取/创建该用户的同步调度器（per-uid 单例，start 幂等） */
export function ensureSyncScheduler(uid: string): PersonalContextSyncScheduler {
  let scheduler = schedulers.get(uid);
  if (!scheduler) {
    scheduler = new PersonalContextSyncScheduler({ runner: syncRunner });
    schedulers.set(uid, scheduler);
  }
  return scheduler;
}

/** 立即执行一轮同步（OAuth 完成回调触发首次回填 / IPC 手动触发）；返回 tick 结果 */
export async function syncNow(uid: string): Promise<ReturnType<PersonalContextSyncScheduler['tick']>> {
  return ensureSyncScheduler(uid).tick(uid);
}

/** 撤销/失效时停止该用户的定时同步 */
export function stopSyncScheduler(uid: string): void {
  schedulers.get(uid)?.stop(uid);
}

/** 当前连接状态；授权窗口进行中时附 authorizing 标记 */
export async function getStatus(uid: string, providerId: string): Promise<OAuthConnectionStatus & { authorizing?: boolean; redirectUri?: string }> {
  const { appId, appSecret } = await resolveFeishuApp(uid);
  const oauth = createManager(appId, appSecret);
  const status = await oauth.getStatus(uid, providerId);
  const active = flows.has(flowKey(uid, providerId));
  const withAuthorizing = active ? { ...status, authorizing: true } : status;
  // 回调地址固定（飞书要求与开发者后台配置精确一致），供 UI 引导用户配置。
  return { ...withAuthorizing, redirectUri: `http://127.0.0.1:${FEISHU_OAUTH_CALLBACK_PORT}${FEISHU_OAUTH_CALLBACK_PATH}` };
}

export interface SetupGuide {
  /** messaging 是否已配置飞书机器人凭据（向导第 0 步） */
  credentialReady: boolean;
  /** 应用 appId（拼开发者后台 URL 用，非机密标识） */
  appId?: string;
  /** 回调地址（必须在开发者后台精确配置） */
  redirectUri: string;
  /** 用户是否已确认配置过回调地址（本机标记，飞书无查询 API） */
  redirectConfigured: boolean;
}

/** 本机标记：用户确认已完成重定向 URL 配置（一次性，防每次授权都拦截） */
function setupGuideStateFile(uid: string): string {
  return path.join(userLocalConfigDir(uid), 'personal-context', 'setup-guide.json');
}

async function isRedirectConfigured(uid: string): Promise<boolean> {
  try {
    const state = await readJson<{ redirectConfigured?: boolean }>(setupGuideStateFile(uid));
    return state.redirectConfigured === true;
  } catch {
    return false;
  }
}

export async function confirmRedirectConfigured(uid: string): Promise<void> {
  await writeJson(setupGuideStateFile(uid), { redirectConfigured: true, confirmedAt: nowIso() });
}

/**
 * 配置向导数据：能自动检测的（凭据）自动检测；回调地址/权限无法检测
 * （飞书不提供修改应用配置的 API），由 UI 按步骤引导用户完成。
 * instanceId 可选：扫码刚绑定的新实例优先（返回该实例的 appId），
 * 否则按 pickFeishuInstance 优先级挑选。
 */
export async function getSetupGuide(uid: string, instanceId?: string): Promise<SetupGuide> {
  let appId: string | undefined;
  let credentialReady = false;
  try {
    const app = await resolveFeishuApp(uid, instanceId);
    appId = app.appId;
    credentialReady = true;
  } catch {
    // 未配置凭据：向导第 0 步引导去消息平台绑定。
  }
  return {
    credentialReady,
    ...(appId ? { appId } : {}),
    redirectUri: `http://127.0.0.1:${FEISHU_OAUTH_CALLBACK_PORT}${FEISHU_OAUTH_CALLBACK_PATH}`,
    redirectConfigured: await isRedirectConfigured(uid),
  };
}

/** 取消进行中的授权（关闭回调服务器、收敛状态）。
 *  若凭据已被删除（resolveFeishuApp 抛出），仍强制广播 disconnected，
 *  防止渲染层一直停在 authorizing 状态无法恢复。 */
export async function cancelAuthorize(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
  const flow = flows.get(flowKey(uid, providerId));
  if (flow) {
    await flow.handle.close().catch(() => undefined);
    flows.delete(flowKey(uid, providerId));
  }
  let appId: string;
  let appSecret: string;
  try {
    ({ appId, appSecret } = await resolveFeishuApp(uid));
  } catch (error) {
    // 机器人凭据已被删除或不可用：无法走正常取消流程，
    // 直接广播 disconnected，让渲染层收敛到可重试状态。
    log.warn('cancelAuthorize: resolveFeishuApp failed, broadcasting disconnected', {
      uid, error: (error as Error).message,
    });
    const fallback: OAuthConnectionStatus = {
      kind: 'disconnected',
      needsReauth: false,
      checkedAt: new Date().toISOString(),
      error: (error as Error).message,
    };
    broadcastAuthorizationStatus(uid, fallback);
    return fallback;
  }
  const status = await createManager(appId, appSecret).cancelAuthorize(uid, providerId);
  broadcastAuthorizationStatus(uid, status);
  return status;
}

/** 撤销授权：远端 revoke + 本地凭据清除（用户意图优先，远端失败也清本地）；
 *  同时停止定时同步、级联失效注册表资源、清空接入范围（设计稿 §6 撤销语义） */
export async function revoke(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
  const { appId, appSecret } = await resolveFeishuApp(uid);
  const status = await createManager(appId, appSecret).revoke(uid, providerId);
  stopSyncScheduler(uid);
  try {
    const registry = new PersonalContextRegistry();
    await registry.invalidateProvider(uid, providerId, 'oauth revoked');
    await new ScopeManifestStore(registry).clear(uid);
  } catch (error) {
    // 撤销主流程不因清理失败而中断；资源失效可在下次同步/遗忘命令重试
    log.warn('revoke cleanup failed', { uid, error: (error as Error).message });
  }
  broadcastAuthorizationStatus(uid, status);
  return status;
}

/** 健康检查：令牌失效时置 needsReauth（UI 引导重新授权） */
export async function healthCheck(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
  const { appId, appSecret } = await resolveFeishuApp(uid);
  return createManager(appId, appSecret).healthCheck(uid, providerId);
}

// ── 分享场景凭据（方案 A/B：feishu-share 复用）───────────────────────────
export interface FeishuShareCredential {
  accessToken: string;
  scopes: string[];
  tenantKey: string;
  unionId: string;
  tenantDomain?: string;
}

/** 分享专用飞书应用配置（独立于消息机器人，存 <uid>/local/config/…） */
export interface FeishuShareAppConfig {
  appId: string;
  appSecret: string;
}

const SHARE_APP_CONFIG_FILE = 'feishu-share-app.json';

function shareAppConfigFile(uid: string): string {
  return path.join(userLocalConfigDir(uid), 'personal-context', SHARE_APP_CONFIG_FILE);
}

/** 读取分享专用应用配置；未配置返回 null */
export async function getFeishuShareAppConfig(uid: string): Promise<FeishuShareAppConfig | null> {
  try {
    const raw = await readJson<{ appId?: unknown; appSecret?: unknown }>(shareAppConfigFile(uid));
    if (typeof raw.appId === 'string' && raw.appId.trim() && typeof raw.appSecret === 'string' && raw.appSecret.trim()) {
      return { appId: raw.appId.trim(), appSecret: raw.appSecret.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

/** 保存分享专用应用配置（空值 = 清除） */
export async function setFeishuShareAppConfig(uid: string, config: FeishuShareAppConfig | null): Promise<void> {
  const file = shareAppConfigFile(uid);
  if (!config || !config.appId.trim() || !config.appSecret.trim()) {
    try { fs.unlinkSync(file); } catch { /* noop */ }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeJson(file, { appId: config.appId.trim(), appSecret: config.appSecret.trim() });
}

/**
 * 解析分享场景的飞书应用凭据。
 * 优先级：分享专用配置（feishu-share-app.json）→ 消息机器人凭据（兼容已绑定用户）。
 * 与 resolveFeishuApp 的区别：分享不要求绑定消息机器人，独立配置即可用。
 */
async function resolveShareApp(uid: string): Promise<{ appId: string; appSecret: string }> {
  const own = await getFeishuShareAppConfig(uid);
  if (own) return own;
  return resolveFeishuApp(uid); // 回退：已绑定机器人用户无需重复配置
}

/**
 * 获取用于「分享到飞书」的凭据。
 * - 未配置分享应用且未绑定机器人 / 未授权 → 返回 null（调用方引导配置/授权）；
 * - 返回 accessToken + scopes（调用方用 hasFeishuShareScopes 判断是否需重授权）
 *   + 身份（tenantKey/unionId）。
 * 注意：分享需要写权限，若 scopes 只含只读集合，调用方应引导用户用
 * FEISHU_SHARE_SCOPES 重新授权（beginAuthorize({ scopes: FEISHU_SHARE_SCOPES })）。
 */
export async function getFeishuShareCredential(uid: string): Promise<FeishuShareCredential | null> {
  let appId: string;
  let appSecret: string;
  try {
    ({ appId, appSecret } = await resolveShareApp(uid));
  } catch {
    return null; // 未配置分享应用 / 未绑定机器人
  }
  const endpoint = createFeishuTokenEndpoint({ app: { appId, appSecret, redirectUri: PLACEHOLDER_REDIRECT } });
  const oauth = new OAuthManager(endpoint);
  const credential = await oauth.getCredential(uid, PROVIDER_ID);
  if (!credential) return null; // 未授权
  let tenantKey = '';
  let unionId = '';
  try {
    const health = await endpoint.healthCheck(credential.accessToken);
    if (health.ok) {
      tenantKey = health.identity?.tenantKey ?? '';
      unionId = health.identity?.unionId ?? '';
    }
  } catch (error) {
    log.warn('feishu share credential identity check failed', { uid, error: (error as Error).message });
  }
  return {
    accessToken: credential.accessToken,
    scopes: credential.scopes ?? [],
    tenantKey,
    unionId,
  };
}
