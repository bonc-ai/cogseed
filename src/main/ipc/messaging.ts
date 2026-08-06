import { safeId } from '../storage';
import * as messaging from '../features/messaging/manager';
import * as feishuRegistration from '../features/messaging/feishu-registration';
import * as wecomRegistration from '../features/messaging/wecom-registration';
import * as registry from '../features/messaging/registry';
import {
  isValidFeishuAppId,
  isValidWecomBotId,
  isValidWecomBotSecret,
} from '../features/messaging/types';
import type {
  FeishuTenantBrand,
  MessagingPlatform,
  MessagingPolicy,
  MessagingSecret,
  WorkspaceScope,
} from '../features/messaging/types';

interface MessagingContext {
  userId: string;
}

function text(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throw new Error(`invalid ${field}`);
  }
  const result = value.trim();
  if (required && !result) throw new Error(`${field} required`);
  if (result.length > max) throw new Error(`${field} too long`);
  return result;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid ${field}`);
  return value;
}

function platform(value: unknown): MessagingPlatform {
  const result = text(value, 'platform', 32);
  if (result !== 'telegram' && result !== 'feishu_lark' && result !== 'wecom') {
    throw new Error('unsupported messaging platform');
  }
  return result;
}

function feishuTenantBrand(value: unknown): FeishuTenantBrand | undefined {
  if (value === undefined || value === null) return undefined;
  const result = text(value, 'feishuTenantBrand', 16);
  if (result !== 'feishu' && result !== 'lark') throw new Error('invalid Feishu tenant brand');
  return result;
}

function secret(value: unknown, selectedPlatform: MessagingPlatform): MessagingSecret {
  if (!value || typeof value !== 'object') throw new Error('credentials required');
  const input = value as Record<string, unknown>;
  if (selectedPlatform === 'telegram') {
    const botToken = text(input.botToken, 'botToken', 512);
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error('invalid Telegram bot token');
    return { botToken };
  }
  if (selectedPlatform === 'wecom') {
    const wecomBotId = text(input.wecomBotId, 'wecomBotId', 128);
    const wecomBotSecret = text(input.wecomBotSecret, 'wecomBotSecret', 512);
    if (!isValidWecomBotId(wecomBotId)) throw new Error('invalid WeCom bot id');
    if (!isValidWecomBotSecret(wecomBotSecret)) throw new Error('invalid WeCom bot secret');
    return { wecomBotId, wecomBotSecret };
  }
  const tenantAccessToken = text(input.tenantAccessToken, 'tenantAccessToken', 2048, false);
  const appId = text(input.appId, 'appId', 200);
  if (!isValidFeishuAppId(appId)) throw new Error('invalid Feishu app id');
  return {
    appId,
    appSecret: text(input.appSecret, 'appSecret', 512),
    ...(tenantAccessToken ? { tenantAccessToken } : {}),
  };
}

function workspace(value: unknown): WorkspaceScope | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object') throw new Error('invalid workspace');
  const input = value as Record<string, unknown>;
  const type = input.type === 'project' ? 'project' : input.type === 'default' ? 'default' : '';
  if (!type) throw new Error('invalid workspace type');
  if (type === 'default') return { type: 'default' };
  const projectId = text(input.projectId, 'projectId', 160);
  if (!safeId(projectId)) throw new Error('invalid projectId');
  return { type: 'project', projectId };
}

function idList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`invalid ${field}`);
  if (value.length > 500) throw new Error(`${field} too long`);
  return value.map((item) => text(item, field, 160));
}

function policy(value: unknown): Partial<MessagingPolicy> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object') throw new Error('invalid policy');
  const input = value as Record<string, unknown>;
  const replyMode = input.replyMode === undefined ? undefined : text(input.replyMode, 'replyMode', 40);
  if (replyMode && replyMode !== 'every_message' && replyMode !== 'mentions_only' && replyMode !== 'commands_only') {
    throw new Error('invalid replyMode');
  }
  return {
    ...(replyMode ? { replyMode: replyMode as MessagingPolicy['replyMode'] } : {}),
    ...(input.allowUserIds !== undefined ? { allowUserIds: idList(input.allowUserIds, 'allowUserIds') || [] } : {}),
    ...(input.allowGroupIds !== undefined ? { allowGroupIds: idList(input.allowGroupIds, 'allowGroupIds') || [] } : {}),
    ...(input.requireMentionInGroups !== undefined
      ? { requireMentionInGroups: requiredBoolean(input.requireMentionInGroups, 'requireMentionInGroups') }
      : {}),
  };
}

function instanceId(value: unknown): string {
  const result = text(value, 'instanceId', 160);
  if (!registry.isValidInstanceId(result)) throw new Error('invalid instanceId');
  return result;
}

function registrationFlowId(value: unknown): string {
  const result = text(value, 'flowId', 80);
  if (!safeId(result)) throw new Error('invalid flowId');
  return result;
}

function registrationDraft(payload: Record<string, unknown>): feishuRegistration.FeishuRegistrationDraft {
  return {
    displayName: text(payload?.displayName, 'displayName', 120),
    workspace: workspace(payload?.workspace),
    policy: policy(payload?.policy),
  };
}

function wecomRegistrationDraft(payload: Record<string, unknown>): wecomRegistration.WecomRegistrationDraft {
  return {
    displayName: text(payload?.displayName, 'displayName', 120),
    workspace: workspace(payload?.workspace),
    policy: policy(payload?.policy),
  };
}

export const invokeHandlers = {
  'messaging.catalog': async () => ({ catalog: messaging.PLATFORM_CATALOG }),

  'messaging.list': async (_payload: unknown, ctx: MessagingContext) => ({
    instances: await messaging.listInstances(ctx.userId),
  }),

  'messaging.create': async (payload: Record<string, unknown>, ctx: MessagingContext) => {
    const selectedPlatform = platform(payload?.platform);
    const instance = await messaging.createInstance(ctx.userId, {
      platform: selectedPlatform,
      feishuTenantBrand: feishuTenantBrand(payload?.feishuTenantBrand),
      displayName: text(payload?.displayName, 'displayName', 120),
      workspace: workspace(payload?.workspace),
      policy: policy(payload?.policy),
      secret: secret(payload?.secret, selectedPlatform),
    });
    return { instance };
  },

  'messaging.update': async (payload: Record<string, unknown>, ctx: MessagingContext) => {
    const selectedId = instanceId(payload?.instanceId);
    const existing = await registry.getInstance(ctx.userId, selectedId);
    if (!existing) throw new Error('messaging instance not found');
    const instance = await messaging.updateInstance(ctx.userId, selectedId, {
      ...(payload?.displayName !== undefined ? { displayName: text(payload.displayName, 'displayName', 120) } : {}),
      ...(payload?.feishuTenantBrand !== undefined
        ? { feishuTenantBrand: feishuTenantBrand(payload.feishuTenantBrand) }
        : {}),
      ...(payload?.enabled !== undefined ? { enabled: requiredBoolean(payload.enabled, 'enabled') } : {}),
      ...(payload?.workspace !== undefined ? { workspace: workspace(payload.workspace) } : {}),
      ...(payload?.policy !== undefined ? { policy: policy(payload.policy) } : {}),
      ...(payload?.secret !== undefined ? { secret: secret(payload.secret, existing.platform) } : {}),
    });
    return { instance };
  },

  'messaging.set_enabled': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    instance: await messaging.setEnabled(ctx.userId, instanceId(payload?.instanceId), requiredBoolean(payload?.enabled, 'enabled')),
  }),

  'messaging.unbind': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    instance: await messaging.unbindInstance(ctx.userId, instanceId(payload?.instanceId)),
  }),

  'messaging.health': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    status: await messaging.health(ctx.userId, instanceId(payload?.instanceId)),
  }),

  'messaging.delete': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    deleted: await messaging.deleteInstance(ctx.userId, instanceId(payload?.instanceId)),
  }),

  'messaging.feishu_qr.start': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: await feishuRegistration.startFeishuQrRegistration(ctx.userId, registrationDraft(payload)),
  }),

  'messaging.feishu_qr.status': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: feishuRegistration.getFeishuQrRegistrationStatus(ctx.userId, registrationFlowId(payload?.flowId)),
  }),

  'messaging.feishu_qr.cancel': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: feishuRegistration.cancelFeishuQrRegistration(ctx.userId, registrationFlowId(payload?.flowId)),
  }),

  'messaging.wecom_qr.start': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: wecomRegistration.startWecomQrRegistration(ctx.userId, wecomRegistrationDraft(payload)),
  }),

  'messaging.wecom_qr.status': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: wecomRegistration.getWecomQrRegistrationStatus(ctx.userId, registrationFlowId(payload?.flowId)),
  }),

  'messaging.wecom_qr.complete': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: await wecomRegistration.completeWecomQrRegistration(
      ctx.userId,
      registrationFlowId(payload?.flowId),
      text(payload?.wecomBotId, 'wecomBotId', 128),
      text(payload?.wecomBotSecret, 'wecomBotSecret', 512),
    ),
  }),

  'messaging.wecom_qr.cancel': async (payload: Record<string, unknown>, ctx: MessagingContext) => ({
    registration: wecomRegistration.cancelWecomQrRegistration(ctx.userId, registrationFlowId(payload?.flowId)),
  }),
};
