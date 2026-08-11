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

  it('moves to resource authorization after a real bot and owner are connected', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true, ownerLabel: '本人' },
    }), [{ id: 'feishu-1', platform: 'feishu_lark', enabled: true, status: { kind: 'connected' }, ownerConfigured: true }]);
    expect(model.primaryAction).toBe('authorization.begin');
    expect(model.currentStep).toBe('authorization');
    expect(model.steps.map((step: { state: string }) => step.state)).toEqual(['complete', 'current', 'waiting', 'waiting']);
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
});
