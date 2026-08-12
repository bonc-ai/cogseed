import { describe, expect, it } from 'vitest';

import { buildDesktopWorkbenchProjection } from '../../../src/main/features/desktop_workbench/dashboard';
import type { PersonalContextDashboard } from '../../../src/main/features/personal_context/application/types';
import type { TouchpointIntent } from '../../../src/main/features/touchpoints/types';

const dashboard: PersonalContextDashboard = {
  mode: 'real',
  messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true, ownerLabel: '本人' },
  authorization: { kind: 'connected', providerId: 'feishu', identityLabel: '学生账号' },
  resources: { discovered: 12, selected: 8, ready: 7, failed: 1, unsupported: 0 },
  sync: { state: 'awaiting_review', lastRunAt: '2026-08-10T12:00:00.000Z', nextRunAt: null, processed: 12, failed: 1 },
  review: { pending: 2, confirmed: 5, rejected: 1, sourceInvalidated: 0 },
  briefing: { state: 'preview_ready', destination: { instanceId: 'feishu-1', ownerLabel: '本人', configured: true }, lastDelivery: null, pendingCandidateCount: 2 },
  actions: ['sync.start', 'review.open', 'briefing.preview'],
};

function intent(overrides: Partial<TouchpointIntent>): TouchpointIntent {
  return {
    version: 1,
    intentId: 'intent-1',
    userId: 'user-1',
    eventId: 'event-1',
    subject: { type: 'task', id: 'task-1' },
    content: { title: '课程资料整理完成', body: '已生成复习提纲' },
    contextRef: 'task:task-1',
    channel: 'feishu',
    template: 'task_result',
    priority: 'normal',
    availableFrom: '2026-08-10T13:00:00.000Z',
    expiresAt: '2026-08-11T13:00:00.000Z',
    dedupeKey: 'task:task-1:result:event-1',
    requiresAction: true,
    actionContract: { version: 1, allowedActions: ['open'] },
    status: 'planned',
    createdAt: '2026-08-10T12:30:00.000Z',
    updatedAt: '2026-08-10T12:30:00.000Z',
    attempts: 0,
    ...overrides,
  };
}

describe('desktop workbench projection', () => {
  it('builds the desktop-first sections from real state without secret fields', () => {
    const projection = buildDesktopWorkbenchProjection('user-1', {
      dashboard,
      reviewItems: [
        { candidateId: 'candidate-1', summary: '数据库课程报告于 8 月 18 日提交', kind: 'instance', confidence: 'high', sourceRefs: ['数据库课程资料'] },
      ],
      intents: [
        intent({}),
        intent({ intentId: 'intent-2', eventId: 'event-2', status: 'sending', content: { title: '正在投递今日简报' } }),
      ],
      generatedAt: '2026-08-10T13:00:00.000Z',
    });

    expect(projection.sections.attention[0]).toMatchObject({ kind: 'sync_partial', severity: 'warning' });
    expect(projection.sections.timeline[0]).toMatchObject({ title: '课程资料整理完成', channel: 'feishu' });
    expect(projection.sections.decisions[0]).toMatchObject({ id: 'candidate-1', kind: 'ontology_confirmation' });
    expect(projection.sections.running[0]).toMatchObject({ id: 'intent-2', state: 'sending' });
    expect(projection.touchpoints[0]).toMatchObject({ channel: 'feishu', connected: true, ownerBound: true, realMode: true });
    expect(JSON.stringify(projection)).not.toMatch(/token|appSecret|transport/i);
  });

  it('makes missing real connection and authorization the primary attention items', () => {
    const disconnected = buildDesktopWorkbenchProjection('user-1', {
      dashboard: {
        ...dashboard,
        messaging: { instanceId: null, botConnected: false, ownerConfigured: false },
        authorization: { kind: 'ready_to_authorize', providerId: 'feishu' },
        resources: { discovered: 0, selected: 0, ready: 0, failed: 0, unsupported: 0 },
        sync: { state: 'idle', lastRunAt: null, nextRunAt: null, processed: 0, failed: 0 },
      },
      reviewItems: [],
      intents: [],
      generatedAt: '2026-08-10T13:00:00.000Z',
    });

    expect(disconnected.sections.attention.map((item) => item.kind)).toEqual([
      'feishu_not_connected',
      'resource_authorization_required',
    ]);
    expect(disconnected.touchpoints[0]).toMatchObject({ connected: false, realMode: true });
  });
});
