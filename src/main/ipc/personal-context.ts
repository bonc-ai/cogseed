/**
 * 个人上下文连接器 IPC 通道（`personal_context.*`）。
 *
 * 只做参数校验与编排调用，不写业务逻辑（AGENTS.md 分层约定）。
 * 凭据/令牌不出现在任何 DTO 中；状态由 features/personal_context/manager
 * 与 oauth-manager 提供（含 needsReauth/authorizing 标记）。
 */
import { safeId } from '../storage';
import * as personalContext from '../features/personal_context/manager';

interface PersonalContextContext {
  userId: string;
}

const PROVIDER_ID = 'feishu';

function providerId(value: unknown): string {
  if (value !== 'feishu') throw new Error('unsupported personal context provider');
  return value;
}

function instanceId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !safeId(value)) throw new Error('invalid messaging instance id');
  return value;
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
};

export { PROVIDER_ID };
