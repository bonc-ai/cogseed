import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { deriveTouchpointSettingsModel } = require('../../../src/renderer/modules/touchpoint-settings-model.js');

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'real',
    messaging: { instanceId: null, botConnected: false, ownerConfigured: false },
    authorization: { kind: 'ready_to_authorize', providerId: 'feishu' },
    resources: { discovered: 0, selected: 0, ready: 0, failed: 0, unsupported: 0 },
    sync: { state: 'idle', lastRunAt: null, nextRunAt: null, processed: 0, failed: 0 },
    review: { pending: 0, confirmed: 0, rejected: 0, sourceInvalidated: 0 },
    briefing: { state: 'not_configured', destination: null, lastDelivery: null, pendingCandidateCount: 0 },
    actions: [],
    ...overrides,
  };
}

describe('touchpoint settings model', () => {
  it('focuses an unconnected user on real Feishu connection without zero metric noise', () => {
    const model = deriveTouchpointSettingsModel(dashboard(), []);
    expect(model.primaryAction).toBe('connection.connect');
    expect(model.currentStep).toBe('connection');
    expect(model.showMetrics).toBe(false);
    expect(model.status).toBe('not_connected');
    expect(model.steps.map((step: { state: string }) => step.state)).toEqual(['current', 'waiting', 'waiting', 'waiting']);
  });

  it('shows connecting for a configured bot that has not connected yet (slow startup link)', () => {
    // 已配置机器人（存在实例）但连接尚未完成：启动后连接慢是常态，
    // 此时应显示「连接中…」而非误报「没配置」。
    const model = deriveTouchpointSettingsModel(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: false, ownerConfigured: true },
    }), [{ id: 'feishu-1', platform: 'feishu_lark', enabled: true, status: { kind: 'connecting' }, ownerConfigured: true }]);
    expect(model.status).toBe('connecting');
    expect(model.primaryAction).toBe('connection.connect');
  });

  it('moves to resource authorization after a real bot and owner are connected', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true, ownerLabel: '本人' },
    }), [{ id: 'feishu-1', platform: 'feishu_lark', enabled: true, status: { kind: 'connected' }, ownerConfigured: true }]);
    expect(model.primaryAction).toBe('authorization.begin');
    expect(model.currentStep).toBe('authorization');
    expect(model.botConnected).toBe(true);
    expect(model.steps.map((step: { state: string }) => step.state)).toEqual(['complete', 'current', 'waiting', 'waiting']);
  });

  it('shows owner label when both bot and owner are connected', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true, ownerLabel: '本人' },
    }), [{ id: 'feishu-1', platform: 'feishu_lark', enabled: true, status: { kind: 'connected' }, ownerConfigured: true }]);
    expect(model.botConnected).toBe(true);
    expect(model.identityLabel).toBe('本人');
    expect(model.currentStep).toBe('authorization');
  });

  it('shows resource and delivery controls only after authorization advances', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu', identityLabel: '学生账号' },
      resources: { discovered: 8, selected: 4, ready: 4, failed: 0, unsupported: 0 },
      sync: { state: 'ready', lastRunAt: '2026-08-10T12:00:00.000Z', nextRunAt: null, processed: 8, failed: 0 },
      briefing: { state: 'preview_ready', destination: { instanceId: 'feishu-1', configured: true }, lastDelivery: null, pendingCandidateCount: 0 },
    }), []);
    expect(model.primaryAction).toBe('briefing.preview');
    expect(model.currentStep).toBe('ready');
    expect(model.showMetrics).toBe(true);
    expect(model.canConfigureDelivery).toBe(true);
    expect(model.steps.every((step: { state: string }) => step.state === 'complete')).toBe(true);
  });

  it('switches the primary action to cancel while authorization is in flight', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'authorizing', providerId: 'feishu', authorizing: true },
    }), []);
    expect(model.primaryAction).toBe('authorize.cancel');
    expect(model.authorizing).toBe(true);
    expect(model.authorized).toBe(false);
  });

  it('counts only enabled Feishu instances, matching the botConnected semantics', () => {
    // 禁用实例不参与"已连接实例数"：与 botConnected（要求 enabled）对齐，
    // 避免列表显示 2 个实例但机器人实际未连接的状态不一致。
    const model = deriveTouchpointSettingsModel(dashboard(), [
      { id: 'feishu-1', platform: 'feishu_lark', enabled: true, status: { kind: 'connected' } },
      { id: 'feishu-2', platform: 'feishu_lark', enabled: false, status: { kind: 'connected' } },
      { id: 'lark-1', platform: 'feishu_lark', enabled: true, status: { kind: 'connected' } },
      { id: 'telegram-1', platform: 'telegram', enabled: true, status: { kind: 'connected' } },
    ]);
    expect(model.instanceCount).toBe(2);
  });

  it('surfaces sync failure details and configured briefing schedule', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu', identityLabel: '学生账号' },
      resources: { discovered: 8, selected: 4, ready: 3, failed: 1, unsupported: 0 },
      sync: { state: 'idle', lastRunAt: null, nextRunAt: null, processed: 8, failed: 1, message: '有 1 个资源同步失败，下次同步将自动重试' },
      briefing: {
        state: 'preview_ready',
        destination: { instanceId: 'feishu-1', configured: true, schedule: { hour: 8, minute: 30 } },
        lastDelivery: null,
        pendingCandidateCount: 0,
      },
    }), []);
    expect(model.primaryAction).toBe('sync.start');
    expect(model.syncMessage).toContain('同步失败');
    expect(model.briefingConfigured).toBe(true);
    expect(model.briefingSchedule).toEqual({ hour: 8, minute: 30 });
  });
});
