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
import { createLogger } from '../../logger';
import * as messagingRegistry from '../messaging/registry';
import { OAuthManager, OAuthConnectionStatus } from './oauth-manager';
import { buildFeishuAuthorizeUrl, createFeishuTokenEndpoint, FEISHU_READ_SCOPES } from './feishu/oauth';
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

interface AuthorizeFlow {
  providerId: string;
  handle: OAuthCallbackServerHandle;
}

const flows = new Map<string, AuthorizeFlow>();

function flowKey(uid: string, providerId: string): string {
  return `${uid}:${providerId}`;
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
 * 从 messaging 配置中解析飞书应用凭据。优先显式 instanceId；
 * 未指定时取第一个 connected 的飞书实例，其次任意已配置实例。
 */
async function resolveFeishuApp(uid: string, instanceId?: string): Promise<{ appId: string; appSecret: string }> {
  const instances = await messagingRegistry.listInstances(uid);
  const candidates = instances.filter((item) => item.platform === 'feishu_lark');
  let chosenId = instanceId;
  if (!chosenId) {
    const connected = candidates.find((item) => item.status.kind === 'connected');
    chosenId = connected?.id ?? candidates[0]?.id;
  }
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
 */
export async function beginAuthorize(
  uid: string,
  opts: { instanceId?: string } = {},
): Promise<BeginAuthorizeResult> {
  const { appId, appSecret } = await resolveFeishuApp(uid, opts.instanceId);
  const handle = await startOAuthCallbackServer();
  const oauth = createManager(appId, appSecret);
  try {
    const request = await oauth.beginAuthorize(uid, PROVIDER_ID, [...FEISHU_READ_SCOPES], (state) =>
      buildFeishuAuthorizeUrl({ appId, appSecret, redirectUri: handle.redirectUri }, state, [...FEISHU_READ_SCOPES]));
    flows.set(flowKey(uid, PROVIDER_ID), { providerId: PROVIDER_ID, handle });
    void shell.openExternal(request.authUrl).catch((error) => {
      log.warn('open feishu authorize url failed', { error: (error as Error).message });
    });
    void handle.wait()
      .then(async ({ code, state }) => {
        const result = await oauth.completeAuthorize(uid, PROVIDER_ID, code, state, handle.redirectUri);
        log.info('feishu oauth completed', { status: result.kind });
        if (result.kind === 'connected') {
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
        await oauth.cancelAuthorize(uid, PROVIDER_ID).catch(() => undefined);
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
export async function getStatus(uid: string, providerId: string): Promise<OAuthConnectionStatus & { authorizing?: boolean }> {
  const { appId, appSecret } = await resolveFeishuApp(uid);
  const oauth = createManager(appId, appSecret);
  const status = await oauth.getStatus(uid, providerId);
  const active = flows.has(flowKey(uid, providerId));
  return active ? { ...status, authorizing: true } : status;
}

/** 取消进行中的授权（关闭回调服务器、收敛状态） */
export async function cancelAuthorize(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
  const flow = flows.get(flowKey(uid, providerId));
  if (flow) {
    await flow.handle.close().catch(() => undefined);
    flows.delete(flowKey(uid, providerId));
  }
  const { appId, appSecret } = await resolveFeishuApp(uid);
  return createManager(appId, appSecret).cancelAuthorize(uid, providerId);
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
  return status;
}

/** 健康检查：令牌失效时置 needsReauth（UI 引导重新授权） */
export async function healthCheck(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
  const { appId, appSecret } = await resolveFeishuApp(uid);
  return createManager(appId, appSecret).healthCheck(uid, providerId);
}
