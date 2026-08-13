/**
 * Touchpoint IPC.
 *
 * This layer validates renderer payloads, injects userId, and delegates every
 * workflow to features/touchpoints. It does not touch ledger, adapters, or
 * messaging internals directly.
 */
import { safeId } from '../storage';
import * as testDelivery from '../features/touchpoints/test-delivery';
import * as config from '../features/touchpoints/config';
import * as messaging from '../features/messaging/manager';
import { TOUCHPOINT_TEMPLATES, type TouchpointTemplate } from '../features/touchpoints/types';

interface TouchpointContext {
  userId: string;
}

type Handler = (payload: Record<string, unknown>, ctx: TouchpointContext) => Promise<unknown> | unknown;

function optionalInstanceId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() && safeId(value.trim())) return value.trim();
  return undefined;
}

function configuredInstanceId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !safeId(value.trim())) throw new Error('invalid messaging instance id');
  return value.trim();
}

function template(value: unknown): TouchpointTemplate {
  if (typeof value !== 'string' || !(TOUCHPOINT_TEMPLATES as readonly string[]).includes(value)) throw new Error('invalid touchpoint template');
  return value as TouchpointTemplate;
}

function configPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid touchpoint config');
  return value as Record<string, unknown>;
}

async function validateInstance(userId: string, instanceId: string | undefined): Promise<string | null> {
  if (!instanceId) return null;
  const instance = (await messaging.listInstances(userId)).find((item) => item.id === instanceId);
  if (!instance || instance.platform !== 'feishu_lark') throw new Error('消息实例不存在或不是飞书/Lark 实例');
  return instance.id;
}

export const invokeHandlers: Record<string, Handler> = {
  'touchpoints.test_card_delivery': async (payload, ctx) => testDelivery.testApprovalCardDelivery(
    ctx.userId,
    optionalInstanceId(payload?.instanceId),
  ),
  'touchpoints.config.get': async (_payload, ctx) => ({
    config: await config.getTouchpointConfig(ctx.userId),
    instances: (await messaging.listInstances(ctx.userId)).filter((instance) => instance.platform === 'feishu_lark'),
  }),
  'touchpoints.config.save': async (payload, ctx) => {
    const input = configPayload(payload.config);
    const defaultInstanceId = await validateInstance(ctx.userId, configuredInstanceId(input.defaultInstanceId));
    const routes = input.routes && typeof input.routes === 'object' && !Array.isArray(input.routes) ? input.routes as Record<string, unknown> : {};
    const normalizedRoutes: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(routes)) {
      const scene = template(key);
      normalizedRoutes[scene] = await validateInstance(ctx.userId, configuredInstanceId(value));
    }
    const saved = await config.saveTouchpointConfig(ctx.userId, {
      version: 1,
      defaultInstanceId,
      templates: input.templates || {},
      routes: normalizedRoutes,
    });
    return { config: saved };
  },
};
