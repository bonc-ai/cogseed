import { describe, expect, it } from 'vitest';
import {
  getPrimaryDashboardAction,
  serializePersonalContextError,
  type PersonalContextDashboard,
} from '../../../src/main/features/personal_context/application/types';
import { PersonalContextError } from '../../../src/main/features/personal_context/application/errors';

describe('personal context application contracts', () => {
  it('selects the correct primary action for each authorization state', () => {
    expect(getPrimaryDashboardAction({ mode: 'real', authorization: { kind: 'ready_to_authorize' } })).toBe('authorize.begin');
    expect(getPrimaryDashboardAction({ mode: 'real', authorization: { kind: 'authorizing' } })).toBe('authorize.cancel');
    expect(getPrimaryDashboardAction({ mode: 'real', authorization: { kind: 'connected' } })).toBe('resources.discover');
    expect(getPrimaryDashboardAction({ mode: 'real', authorization: { kind: 'needs_reauth' } })).toBe('authorize.begin');
    expect(getPrimaryDashboardAction({ mode: 'demo', authorization: { kind: 'connected' } })).toBe('sync.start');
  });

  it('serializes a staged error without leaking secrets', () => {
    const cause = new Error('provider rejected access_token=secret-value');
    const error = new PersonalContextError('sync', 'provider_error', 'personal_context.error.sync_failed', {
      recoverable: true,
      retryAction: 'sync.retry',
      cause,
    });
    const serialized = serializePersonalContextError(error);
    expect(serialized.stage).toBe('sync');
    expect(serialized.code).toBe('provider_error');
    expect(serialized.recoverable).toBe(true);
    expect(serialized.retryAction).toBe('sync.retry');
    expect(JSON.stringify(serialized)).not.toContain('secret-value');
    expect(JSON.stringify(serialized)).not.toContain('access_token');
  });

  it('keeps dashboard snapshots serializable and does not expose credentials', () => {
    const dashboard: PersonalContextDashboard = {
      mode: 'real',
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu', identityLabel: '已授权身份' },
      resources: { discovered: 2, selected: 1, ready: 1, failed: 0 },
      sync: { state: 'ready', lastRunAt: null, nextRunAt: null },
      review: { pending: 1, confirmed: 2, rejected: 0 },
      briefing: { state: 'preview_ready', destination: null, lastDelivery: null },
      actions: ['sync.start', 'review.open', 'briefing.preview'],
    };
    expect(JSON.stringify(dashboard)).not.toContain('token');
  });
});
