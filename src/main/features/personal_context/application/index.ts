import * as messagingRegistry from '../../messaging/registry';
import * as autoTasks from '../../auto_tasks';
import {
  confirmCandidate,
  listCandidates,
  rejectCandidate,
  type CandidateUpdate,
} from '../../personal_ontology_candidates';
import { buildDailyBriefing, type BriefingOutput } from '../briefing';
import { assembleBriefingInput, dispatchToFeishuHome } from '../feishu-dispatch';
import * as manager from '../manager';
import { PersonalContextRegistry } from '../registry';
import { ScopeManifestStore } from '../scope-manifest';
import type { ExternalResource } from '../contract';
import { createPersonalContextApplicationService, type PersonalContextApplicationService } from './service';
import type { PersonalContextDashboard } from './types';

let defaultService: PersonalContextApplicationService | null = null;

const DEMO_RESOURCES: ReadonlyArray<ExternalResource> = Object.freeze([
  {
    resourceId: 'demo:workspace:calendar:primary', resourceType: 'calendar', sourceVersion: 'demo-v1', title: '我的主日历',
    observedAt: '2026-08-10T08:00:00.000Z', accessLabel: 'personal', retentionPolicy: 'source-linked', bodyLoaded: true,
    capability: { canList: true, canReadMetadata: true, canReadContent: true, canSyncIncrementally: true, canGenerateCandidates: true },
    contentStatus: 'loaded', sourceValidity: 'active',
  },
  {
    resourceId: 'demo:workspace:document:project-plan', resourceType: 'document', sourceVersion: 'demo-v2', title: '伴侣智能体重构计划',
    observedAt: '2026-08-10T08:00:00.000Z', accessLabel: 'personal', retentionPolicy: 'source-linked', bodyLoaded: true,
    capability: { canList: true, canReadMetadata: true, canReadContent: true, canSyncIncrementally: true, canGenerateCandidates: true },
    contentStatus: 'loaded', sourceValidity: 'active',
  },
  {
    resourceId: 'demo:workspace:document:weekly-table', resourceType: 'document', sourceVersion: 'demo-v1', title: '本周重点事项',
    observedAt: '2026-08-10T08:00:00.000Z', accessLabel: 'shared', retentionPolicy: 'source-linked', bodyLoaded: true,
    capability: { canList: true, canReadMetadata: true, canReadContent: true, canSyncIncrementally: true, canGenerateCandidates: true },
    contentStatus: 'loaded', sourceValidity: 'active',
  },
]);

function mapAuthorizationStatus(status: Awaited<ReturnType<typeof manager.getStatus>>): {
  kind: 'ready_to_authorize' | 'authorizing' | 'connected' | 'needs_reauth' | 'error';
  needsReauth: boolean;
  authorizing: boolean;
  error?: string;
} {
  return {
    kind: status.needsReauth
      ? 'needs_reauth'
      : status.authorizing || status.kind === 'connecting'
        ? 'authorizing'
        : status.kind === 'connected'
          ? 'connected'
          : status.kind === 'error'
            ? 'error'
            : 'ready_to_authorize',
    needsReauth: status.needsReauth,
    authorizing: Boolean(status.authorizing),
    ...(status.error ? { error: status.error } : {}),
  };
}

function getDefaultService(): PersonalContextApplicationService {
  if (defaultService) return defaultService;
  defaultService = createPersonalContextApplicationService({
    async listMessagingInstances(userId) {
      const instances = await messagingRegistry.listInstances(userId);
      return instances.map((instance) => ({
        id: instance.id,
        platform: instance.platform,
        enabled: instance.enabled,
        ownerConfigured: instance.ownerConfigured,
        ...(instance.ownerLabel ? { ownerLabel: instance.ownerLabel } : {}),
        statusKind: instance.status.kind,
      }));
    },
    async getAuthorizationStatus(userId) {
      try {
        return mapAuthorizationStatus(await manager.getStatus(userId, 'feishu'));
      } catch (error) {
        return {
          kind: 'ready_to_authorize',
          needsReauth: false,
          authorizing: false,
          error: error instanceof Error ? error.message : 'personal context authorization is not configured',
        };
      }
    },
    async listRegistryEntries(userId) {
      const entries = await new PersonalContextRegistry().list(userId, { providerId: 'feishu', includeInvalid: true });
      return entries.map((entry) => ({
        selected: entry.selected,
        valid: !entry.invalidatedAt && entry.resource.sourceValidity !== 'invalidated' && entry.resource.sourceValidity !== 'deleted',
        ...(entry.resource.contentStatus ? { contentStatus: entry.resource.contentStatus } : {}),
      }));
    },
    async listCandidates(userId) {
      const data = await listCandidates(userId);
      return data.candidate_updates.map((candidate) => ({ candidateId: candidate.candidate_id }));
    },
    async buildBriefingPreview(userId) {
      const data = await listCandidates(userId);
      return { state: 'preview_ready', pendingCandidateCount: data.candidate_updates.length };
    },
  });
  return defaultService;
}

export function getPersonalContextApplicationService(): PersonalContextApplicationService {
  return getDefaultService();
}

export async function getDashboard(userId: string): Promise<PersonalContextDashboard> {
  return getDefaultService().getDashboard(userId);
}

export async function setMode(userId: string, mode: 'real' | 'demo'): Promise<PersonalContextDashboard> {
  return getDefaultService().setMode(userId, mode);
}

export async function beginAuthorization(userId: string, instanceId?: string): Promise<PersonalContextDashboard> {
  await manager.beginAuthorize(userId, { ...(instanceId ? { instanceId } : {}) });
  return getDashboard(userId);
}

export async function cancelAuthorization(userId: string): Promise<PersonalContextDashboard> {
  await manager.cancelAuthorize(userId, 'feishu');
  return getDashboard(userId);
}

export async function revokeAuthorization(userId: string): Promise<PersonalContextDashboard> {
  await manager.revoke(userId, 'feishu');
  return getDashboard(userId);
}

export async function discoverResources(userId: string): Promise<{ dashboard: PersonalContextDashboard; resources: ExternalResource[] }> {
  const dashboard = await getDashboard(userId);
  if (dashboard.mode === 'demo') return { dashboard, resources: [...DEMO_RESOURCES] };
  const built = await manager.buildFeishuProvider(userId);
  const resources = await built.provider.discoverResources({ uid: userId, providerId: 'feishu' });
  for (const resource of resources) await built.registry.upsert(userId, resource);
  return { dashboard: await getDashboard(userId), resources };
}

export async function selectResources(userId: string, resources: ExternalResource[]): Promise<PersonalContextDashboard> {
  const dashboard = await getDashboard(userId);
  if (dashboard.mode === 'demo') return dashboard;
  await new ScopeManifestStore(new PersonalContextRegistry()).save(userId, resources);
  return getDashboard(userId);
}

export async function startSync(userId: string): Promise<PersonalContextDashboard> {
  const dashboard = await getDashboard(userId);
  if (dashboard.mode === 'demo') return dashboard;
  await manager.syncNow(userId);
  return getDashboard(userId);
}

export async function previewBriefing(userId: string): Promise<{ dashboard: PersonalContextDashboard; preview: BriefingOutput }> {
  const dashboard = await getDashboard(userId);
  if (dashboard.mode === 'demo') {
    return {
      dashboard,
      preview: buildDailyBriefing({
        now: '2026-08-10T08:00:00+08:00',
        facts: [
          { id: 'demo-fact-1', kind: 'deadline', summary: '完成个人伴侣数据中心第一版', date: '2026-08-12' },
          { id: 'demo-fact-2', kind: 'project', summary: '整理真实飞书连接与文档同步验收' },
        ],
        events: [{ id: 'demo-event-1', title: '产品方案评审', startAt: '2026-08-10T10:00:00+08:00', endAt: '2026-08-10T11:00:00+08:00' }],
      }),
    };
  }
  const input = await assembleBriefingInput(userId);
  return { dashboard, preview: buildDailyBriefing(input) };
}

export interface ReviewItemView {
  candidateId: string;
  summary: string;
  kind: CandidateUpdate['kind'];
  confidence: CandidateUpdate['confidence'];
  sourceRefs: string[];
}

export async function listReviewItems(userId: string): Promise<{ dashboard: PersonalContextDashboard; items: ReviewItemView[] }> {
  const dashboard = await getDashboard(userId);
  if (dashboard.mode === 'demo') {
    return {
      dashboard,
      items: [
        { candidateId: 'demo-candidate-1', summary: '本周三完成真实飞书 OAuth 验证', kind: 'instance', confidence: 'high', sourceRefs: ['伴侣智能体重构计划'] },
        { candidateId: 'demo-candidate-2', summary: '每天上午查看今日简报', kind: 'preference', confidence: 'medium', sourceRefs: ['本周重点事项'] },
      ],
    };
  }
  const data = await listCandidates(userId);
  return {
    dashboard,
    items: data.candidate_updates.map((candidate) => ({
      candidateId: candidate.candidate_id,
      summary: candidate.summary || candidate.memory_text || candidate.candidate_id,
      kind: candidate.kind,
      confidence: candidate.confidence,
      sourceRefs: candidate.source_memory_refs || [],
    })),
  };
}

export async function approveReviewItem(userId: string, candidateId: string): Promise<PersonalContextDashboard> {
  const dashboard = await getDashboard(userId);
  if (dashboard.mode === 'demo') return dashboard;
  await confirmCandidate(userId, candidateId, { toGlobalMemory: true });
  return getDashboard(userId);
}

export async function rejectReviewItem(userId: string, candidateId: string): Promise<PersonalContextDashboard> {
  const dashboard = await getDashboard(userId);
  if (dashboard.mode === 'demo') return dashboard;
  await rejectCandidate(userId, candidateId, 'rejected in personal context review');
  return getDashboard(userId);
}


export async function testBriefingDelivery(userId: string, instanceId?: string): Promise<{ dashboard: PersonalContextDashboard; result: { ok: boolean; code?: string; error?: string } }> {
  const { dashboard, preview } = await previewBriefing(userId);
  if (dashboard.mode === 'demo') return { dashboard, result: { ok: true, code: 'demo_delivery' } };
  const instances = await messagingRegistry.listInstances(userId);
  const target = instanceId || instances.find((instance) => instance.platform === 'feishu_lark' && instance.enabled)?.id;
  if (!target) return { dashboard, result: { ok: false, code: 'instance_unknown', error: '没有可用的飞书消息实例' } };
  const result = await dispatchToFeishuHome(userId, { instanceId: target, text: preview.text, sourceKey: `briefing:test:${new Date().toISOString().slice(0, 10)}` });
  if ('code' in result) return { dashboard: await getDashboard(userId), result: { ok: false, code: result.code, error: result.error } };
  return { dashboard: await getDashboard(userId), result: { ok: true } };
}

export async function scheduleBriefing(userId: string, input: { instanceId?: string; hour: number; minute: number }): Promise<{ dashboard: PersonalContextDashboard; taskId?: string; error?: string }> {
  const dashboard = await getDashboard(userId);
  if (dashboard.mode === 'demo') return { dashboard, taskId: 'demo-briefing' };
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23 || !Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59) {
    return { dashboard, error: '简报时间必须是有效的小时和分钟' };
  }
  const instances = await messagingRegistry.listInstances(userId);
  const target = input.instanceId || instances.find((instance) => instance.platform === 'feishu_lark' && instance.enabled)?.id;
  if (!target) return { dashboard, error: '没有可用的飞书消息实例' };
  const created = await autoTasks.createTask(userId, {
    title: '每日飞书简报',
    content: '生成并投递今日个人简报',
    briefing: true,
    enabled: true,
    recipient: { kind: 'messaging', instanceId: target, recipient: 'owner' },
    schedule: { type: 'daily', hour: input.hour, minute: input.minute },
  });
  if ('error' in created) return { dashboard, error: created.error };
  return { dashboard: await getDashboard(userId), taskId: created.task.id };
}

export function resetPersonalContextApplicationServiceForTest(): void {
  defaultService = null;
}
