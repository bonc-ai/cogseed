/**
 * 个人上下文连接器 IPC 通道（`personal_context.*`）。
 *
 * 只做参数校验与编排调用，不写业务逻辑（AGENTS.md 分层约定）。
 * 凭据/令牌不出现在任何 DTO 中；状态由 features/personal_context/manager
 * 与 oauth-manager 提供（含 needsReauth/authorizing 标记）。
 */
import { safeId } from '../storage';
import * as personalContext from '../features/personal_context/manager';
import { parseResourceKey, RESOURCE_TYPES } from '../features/personal_context/contract';
import { PersonalContextRegistry } from '../features/personal_context/registry';
import { ScopeManifestStore } from '../features/personal_context/scope-manifest';
import type { ExternalResource } from '../features/personal_context/contract';

interface PersonalContextContext {
  userId: string;
}

const PROVIDER_ID = 'feishu';
/** 单次勾选保存的资源数量上限（防滥用，正常使用远小于此） */
const MAX_SCOPE_RESOURCES = 200;

function providerId(value: unknown): string {
  if (value !== 'feishu') throw new Error('unsupported personal context provider');
  return value;
}

function instanceId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !safeId(value)) throw new Error('invalid messaging instance id');
  return value;
}

/** 校验勾选保存的资源列表：数组、每项幂等键可解析且属当前 provider、类型合法、数量受限 */
function scopeResources(value: unknown): ExternalResource[] {
  if (!Array.isArray(value)) throw new Error('resources must be an array');
  if (value.length > MAX_SCOPE_RESOURCES) throw new Error(`too many resources (max ${MAX_SCOPE_RESOURCES})`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`invalid resource at index ${index}`);
    const resource = item as Record<string, unknown>;
    if (typeof resource.resourceId !== 'string') throw new Error(`invalid resourceId at index ${index}`);
    const parsed = parseResourceKey(resource.resourceId);
    if (!parsed || parsed.provider !== PROVIDER_ID) {
      throw new Error(`resourceId must be a '${PROVIDER_ID}' scoped key: ${String(resource.resourceId).slice(0, 80)}`);
    }
    if (typeof resource.resourceType !== 'string' || !(RESOURCE_TYPES as readonly string[]).includes(resource.resourceType)) {
      throw new Error(`invalid resourceType at index ${index}`);
    }
    return resource as unknown as ExternalResource;
  });
}

export const invokeHandlers: Record<string, (payload: Record<string, unknown>, ctx: PersonalContextContext) => Promise<unknown> | unknown> = {
  /** 发起飞书授权：返回重定向地址与初始状态；结果通过 get_status 轮询 */
  'personal_context.begin_authorize': async (payload: Record<string, unknown>, ctx: PersonalContextContext) => {
    void providerId(payload?.providerId);
    return {
      flow: await personalContext.beginAuthorize(ctx.userId, { instanceId: instanceId(payload?.instanceId) }),
    };
  },

  /** 查询连接状态（含 needsReauth / authorizing 标记） */
  'personal_context.get_status': async (payload: Record<string, unknown>, ctx: PersonalContextContext) => {
    const provider = providerId(payload?.providerId);
    return {
      status: await personalContext.getStatus(ctx.userId, provider),
    };
  },

  /** 取消进行中的授权 */
  'personal_context.cancel_authorize': async (payload: Record<string, unknown>, ctx: PersonalContextContext) => {
    const provider = providerId(payload?.providerId);
    return {
      status: await personalContext.cancelAuthorize(ctx.userId, provider),
    };
  },

  /** 撤销授权（远端 revoke + 本地清除） */
  'personal_context.revoke': async (payload: Record<string, unknown>, ctx: PersonalContextContext) => {
    const provider = providerId(payload?.providerId);
    return {
      status: await personalContext.revoke(ctx.userId, provider),
    };
  },

  /** 健康检查（令牌失效 → needsReauth 引导重新授权） */
  'personal_context.health_check': async (payload: Record<string, unknown>, ctx: PersonalContextContext) => {
    const provider = providerId(payload?.providerId);
    return {
      status: await personalContext.healthCheck(ctx.userId, provider),
    };
  },

  /** 配置向导数据：凭据就绪状态 + 回调地址 + 开发者后台 appId */
  'personal_context.get_setup_guide': async (_payload: Record<string, unknown>, ctx: PersonalContextContext) => {
    return {
      guide: await personalContext.getSetupGuide(ctx.userId),
    };
  },

  /** 发现可接入资源（只读元数据，不读全文）；发现即登记进注册表供勾选联动 */
  'personal_context.discover_resources': async (payload: Record<string, unknown>, ctx: PersonalContextContext) => {
    const provider = providerId(payload?.providerId);
    const built = await personalContext.buildFeishuProvider(ctx.userId);
    const resources = await built.provider.discoverResources({ uid: ctx.userId, providerId: provider });
    // 发现即登记：后续 set_scope 联动与同步水位都基于注册表
    for (const resource of resources) {
      await built.registry.upsert(ctx.userId, resource);
    }
    return { resources };
  },

  /** 保存接入范围（整体替换）：写 scope-manifest + 联动注册表选择状态 */
  'personal_context.set_scope': async (payload: Record<string, unknown>, ctx: PersonalContextContext) => {
    void providerId(payload?.providerId);
    const resources = scopeResources(payload?.resources);
    const store = new ScopeManifestStore(new PersonalContextRegistry());
    const result = await store.save(ctx.userId, resources);
    return { changed: result.changed, scope: result.manifest };
  },

  /** 读取接入范围（可审计的勾选记录） */
  'personal_context.get_scope': async (payload: Record<string, unknown>, ctx: PersonalContextContext) => {
    void providerId(payload?.providerId);
    const store = new ScopeManifestStore(new PersonalContextRegistry());
    return { scope: await store.get(ctx.userId) };
  },
};

export { PROVIDER_ID };
