import { describe, expect, it } from 'vitest';
import { deriveOverall } from '../../../src/main/features/personal_context/application/dashboard-model';
import type { PersonalContextDashboard } from '../../../src/main/features/personal_context/application/types';

function dashboard(overrides: Partial<PersonalContextDashboard> = {}): PersonalContextDashboard {
  return {
    mode: 'real',
    messaging: { instanceId: null, botConnected: false, ownerConfigured: false },
    authorization: { kind: 'ready_to_authorize', providerId: 'feishu' },
    resources: { discovered: 0, selected: 0, ready: 0, failed: 0, unsupported: 0 },
    sync: { state: 'idle', lastRunAt: null, nextRunAt: null, processed: 0, failed: 0 },
    review: { pending: 0, confirmed: 0, rejected: 0, sourceInvalidated: 0 },
    briefing: { state: 'not_configured', destination: null, lastDelivery: null, pendingCandidateCount: 0 },
    actions: [],
    overall: { status: 'off', chain: { connection: 'missing', authorization: 'missing', delivery: 'missing' }, issues: [] },
    ...overrides,
  } as PersonalContextDashboard;
}

describe('deriveOverall', () => {
  it('never configured → off, 三环节 missing，一条连接待办', () => {
    const overall = deriveOverall(dashboard());
    expect(overall.status).toBe('off');
    expect(overall.chain).toEqual({ connection: 'missing', authorization: 'missing', delivery: 'missing' });
    expect(overall.issues).toEqual([
      { severity: 'warning', step: 'connection', reason: 'not_configured', actionId: 'connection.connect' },
    ]);
  });

  it('已连机器人未授权 → attention，授权待办', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true, ownerLabel: '本人' },
    }));
    expect(overall.status).toBe('attention');
    expect(overall.chain.connection).toBe('ok');
    expect(overall.chain.authorization).toBe('missing');
    expect(overall.issues[0]).toMatchObject({ step: 'authorization', reason: 'not_configured', actionId: 'authorize.begin' });
  });

  it('已连+已授权未选资源 → attention，选择资源待办', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu' },
    }));
    expect(overall.status).toBe('attention');
    expect(overall.chain.delivery).toBe('missing');
    expect(overall.issues[0]).toMatchObject({ step: 'delivery', reason: 'no_resources', actionId: 'resources.discover' });
  });

  it('令牌过期 → authorization broken + 重新授权待办（error 级）', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'needs_reauth', providerId: 'feishu' },
    }));
    expect(overall.chain.authorization).toBe('broken');
    expect(overall.status).toBe('attention');
    expect(overall.issues).toContainEqual(
      { severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' },
    );
  });

  it('同步失败 → delivery broken + sync.retry 待办', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu' },
      resources: { discovered: 2, selected: 2, ready: 1, failed: 1, unsupported: 0 },
      sync: { state: 'partial_failure', lastRunAt: '2026-08-12T00:00:00.000Z', nextRunAt: null, processed: 2, failed: 1 },
    }));
    expect(overall.chain.delivery).toBe('broken');
    expect(overall.issues).toContainEqual(
      { severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' },
    );
  });

  it('全部就绪 → ready 且无待办（不变量）', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true, ownerLabel: '本人' },
      authorization: { kind: 'connected', providerId: 'feishu', identityLabel: '本人' },
      resources: { discovered: 2, selected: 2, ready: 2, failed: 0, unsupported: 0 },
      sync: { state: 'ready', lastRunAt: '2026-08-12T00:00:00.000Z', nextRunAt: null, processed: 2, failed: 0 },
      briefing: { state: 'preview_ready', destination: { instanceId: 'feishu-1', configured: true, schedule: { hour: 8, minute: 0 } }, lastDelivery: null, pendingCandidateCount: 0 },
    }));
    expect(overall.status).toBe('ready');
    expect(overall.chain).toEqual({ connection: 'ok', authorization: 'ok', delivery: 'ok' });
    expect(overall.issues).toEqual([]);
  });

  it('不变量：ready ⇔ chain 全 ok ⇔ issues 空', () => {
    const fixture = dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu' },
      resources: { discovered: 1, selected: 1, ready: 1, failed: 0, unsupported: 0 },
      sync: { state: 'ready', lastRunAt: null, nextRunAt: null, processed: 1, failed: 0 },
    });
    const overall = deriveOverall(fixture);
    const allOk = Object.values(overall.chain).every((state) => state === 'ok');
    expect(overall.status === 'ready').toBe(allOk);
    expect(allOk).toBe(overall.issues.length === 0);
  });
});
