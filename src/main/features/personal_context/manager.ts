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
import { PersonalContextRegistry } from './registry';
import { buildFeishuAuthorizeUrl, createFeishuTokenEndpoint, FEISHU_READ_SCOPES } from './feishu/oauth';
import { startOAuthCallbackServer, type OAuthCallbackServerHandle } from './callback-server';

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
  // 已有进行中的授权流：先关闭旧回调服务器（端口释放 + wait reject），
  // 防止用户连点「连接」导致回调服务器泄漏与状态混乱。
  const existing = flows.get(flowKey(uid, PROVIDER_ID));
  if (existing) {
    await existing.handle.close().catch(() => undefined);
    flows.delete(flowKey(uid, PROVIDER_ID));
  }
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

/** 撤销授权：远端 revoke + 本地凭据清除（用户意图优先，远端失败也清本地），
 *  资源注册表级联失效（来源失效、资源保留——设计稿 §6）。 */
export async function revoke(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
  const { appId, appSecret } = await resolveFeishuApp(uid);
  const status = await createManager(appId, appSecret).revoke(uid, providerId);
  try {
    const registry = new PersonalContextRegistry();
    await registry.invalidateProvider(uid, providerId, 'oauth revoked');
  } catch (error) {
    log.warn('personal context registry invalidation failed', { error: (error as Error).message });
  }
  return status;
}

/** 健康检查：令牌失效时置 needsReauth（UI 引导重新授权） */
export async function healthCheck(uid: string, providerId: string): Promise<OAuthConnectionStatus> {
  const { appId, appSecret } = await resolveFeishuApp(uid);
  return createManager(appId, appSecret).healthCheck(uid, providerId);
}
