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
import {
  TOUCHPOINT_ROUTE_SCENES,
  type TouchpointRouteScene,
} from '../features/touchpoints/types';
import type { MessagingInstanceClient } from '../features/messaging/types';

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

function routeScene(value: unknown): TouchpointRouteScene {
  if (typeof value !== 'string' || !(TOUCHPOINT_ROUTE_SCENES as readonly string[]).includes(value)) throw new Error('invalid touchpoint route scene');
  return value as TouchpointRouteScene;
}

function configPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid touchpoint config');
  return value as Record<string, unknown>;
}

function isTouchpointRoutingInstance(
  instance: MessagingInstanceClient,
): instance is MessagingInstanceClient & { platform: 'feishu_lark' | 'wechat_personal' } {
  return instance.platform === 'feishu_lark' || instance.platform === 'wechat_personal';
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
    const defaultInstanceId = configuredInstanceId(input.defaultInstanceId) || null;
    const routes = input.routes && typeof input.routes === 'object' && !Array.isArray(input.routes) ? input.routes as Record<string, unknown> : {};
    const normalizedRoutes: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(routes)) {
      const scene = routeScene(key);
      normalizedRoutes[scene] = configuredInstanceId(value) || null;
    }
    const routingInstances = (await messaging.listInstances(ctx.userId))
      .filter(isTouchpointRoutingInstance)
      .map((instance) => ({ id: instance.id, platform: instance.platform }));
    const saved = await config.saveTouchpointConfig(ctx.userId, {
      version: 1,
      defaultInstanceId,
      templates: input.templates || {},
      routes: normalizedRoutes,
    }, routingInstances);
    return { config: saved };
  },
};
