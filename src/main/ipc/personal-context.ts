/**
 * Personal Context Center IPC.
 *
 * This layer validates renderer payloads, injects userId, and delegates every
 * workflow to features/personal_context/application. It does not access
 * provider, registry, storage, OAuth, candidates, or delivery services.
 */
import { safeId } from '../storage';
import * as application from '../features/personal_context/application';
import * as manager from '../features/personal_context/manager';
import { parseResourceKey, RESOURCE_TYPES, type ExternalResource } from '../features/personal_context/contract';

interface PersonalContextContext { userId: string }
type Handler = (payload: Record<string, unknown>, ctx: PersonalContextContext) => Promise<unknown> | unknown;

const MAX_SCOPE_RESOURCES = 200;

function optionalInstanceId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !safeId(value)) throw new Error('invalid messaging instance id');
  return value;
}

function dashboardMode(value: unknown): 'real' | 'demo' {
  if (value !== 'real' && value !== 'demo') throw new Error('invalid personal context mode');
  return value;
}

function candidateId(value: unknown): string {
  if (typeof value !== 'string' || !safeId(value)) throw new Error('invalid candidate id');
  return value;
}

function integerInRange(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function isResourceType(value: string): value is ExternalResource['resourceType'] {
  return (RESOURCE_TYPES as readonly string[]).includes(value);
}

function scopeResources(value: unknown): ExternalResource[] {
  if (!Array.isArray(value)) throw new Error('resources must be an array');
  if (value.length > MAX_SCOPE_RESOURCES) throw new Error(`too many resources (max ${MAX_SCOPE_RESOURCES})`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`invalid resource at index ${index}`);
    const row = item as Record<string, unknown>;
    if (typeof row.resourceId !== 'string') throw new Error(`invalid resourceId at index ${index}`);
    const parsed = parseResourceKey(row.resourceId);
    if (!parsed || (parsed.provider !== 'feishu' && parsed.provider !== 'demo')) throw new Error(`invalid resource provider at index ${index}`);
    if (typeof row.resourceType !== 'string' || !isResourceType(row.resourceType)) throw new Error(`invalid resourceType at index ${index}`);
    if (typeof row.title !== 'string' || !row.title.trim()) throw new Error(`invalid resource title at index ${index}`);
    if (typeof row.observedAt !== 'string' || Number.isNaN(Date.parse(row.observedAt))) throw new Error(`invalid observedAt at index ${index}`);
    if (row.accessLabel !== 'personal' && row.accessLabel !== 'shared' && row.accessLabel !== 'public') throw new Error(`invalid accessLabel at index ${index}`);
    if (row.retentionPolicy !== 'source-linked' && row.retentionPolicy !== 'fixed') throw new Error(`invalid retentionPolicy at index ${index}`);
    return {
      resourceId: row.resourceId,
      resourceType: row.resourceType,
      title: row.title.trim(),
      observedAt: row.observedAt,
      accessLabel: row.accessLabel,
      retentionPolicy: row.retentionPolicy,
      ...(typeof row.sourceVersion === 'string' ? { sourceVersion: row.sourceVersion } : {}),
      ...(typeof row.ownerRef === 'string' ? { ownerRef: row.ownerRef } : {}),
      ...(typeof row.containerRef === 'string' ? { containerRef: row.containerRef } : {}),
      ...(typeof row.sourceUrl === 'string' ? { sourceUrl: row.sourceUrl } : {}),
      ...(typeof row.bodyLoaded === 'boolean' ? { bodyLoaded: row.bodyLoaded } : {}),
    };
  });
}

export const invokeHandlers: Record<string, Handler> = {
  'personal_context.dashboard.get': async (_payload, ctx) => ({ dashboard: await application.getDashboard(ctx.userId) }),
  'personal_context.setup_guide': async (payload, ctx) => ({ guide: await manager.getSetupGuide(ctx.userId, optionalInstanceId(payload.instanceId)) }),
  'personal_context.setup_guide.confirm': async (_payload, ctx) => { await manager.confirmRedirectConfigured(ctx.userId); return { ok: true }; },
  'personal_context.mode.set': async (payload, ctx) => ({ dashboard: await application.setMode(ctx.userId, dashboardMode(payload.mode)) }),
  'personal_context.authorize.begin': async (payload, ctx) => ({ dashboard: await application.beginAuthorization(ctx.userId, optionalInstanceId(payload.instanceId)) }),
  'personal_context.authorize.cancel': async (_payload, ctx) => ({ dashboard: await application.cancelAuthorization(ctx.userId) }),
  'personal_context.authorize.revoke': async (_payload, ctx) => ({ dashboard: await application.revokeAuthorization(ctx.userId) }),
  'personal_context.resources.discover': async (_payload, ctx) => application.discoverResources(ctx.userId),
  'personal_context.resources.select': async (payload, ctx) => ({ dashboard: await application.selectResources(ctx.userId, scopeResources(payload.resources)) }),
  'personal_context.sync.start': async (_payload, ctx) => ({ dashboard: await application.startSync(ctx.userId) }),
  'personal_context.review.list': async (_payload, ctx) => application.listReviewItems(ctx.userId),
  'personal_context.review.approve': async (payload, ctx) => ({ dashboard: await application.approveReviewItem(ctx.userId, candidateId(payload.candidateId)) }),
  'personal_context.review.reject': async (payload, ctx) => ({ dashboard: await application.rejectReviewItem(ctx.userId, candidateId(payload.candidateId)) }),
  'personal_context.briefing.preview': async (_payload, ctx) => application.previewBriefing(ctx.userId),
  'personal_context.briefing.test_delivery': async (payload, ctx) => application.testBriefingDelivery(ctx.userId, optionalInstanceId(payload.instanceId)),
  'personal_context.briefing.schedule': async (payload, ctx) => application.scheduleBriefing(ctx.userId, {
    instanceId: optionalInstanceId(payload.instanceId),
    hour: integerInRange(payload.hour, 'hour', 0, 23),
    minute: integerInRange(payload.minute, 'minute', 0, 59),
  }),
  'personal_context.briefing.unschedule': async (_payload, ctx) => application.unscheduleBriefing(ctx.userId),
};
