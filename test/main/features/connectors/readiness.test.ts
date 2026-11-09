import { describe, it, expect } from 'vitest';

import { connectorStateOf } from '../../../../src/main/features/connectors/readiness';
import type { ConnectorInstance } from '../../../../src/main/features/connectors/types';

/** S5：模板连接器类型 → 本机实例状态（research R9）。 */

function inst(over: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: 'tencent-meeting',
    display_name: '腾讯会议',
    transport: { kind: 'stdio', command: 'x', args: [] } as never,
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connected', since: 1 },
    created_at: '2026-10-26T00:00:00Z',
    updated_at: '2026-10-26T00:00:00Z',
    ...over,
  };
}

describe('connector readiness for a template connector type', () => {
  it('matches the catalog instance whose id is the type (origin missing counts as catalog)', () => {
    expect(connectorStateOf('tencent-meeting', inst(), true)).toBe('ready');
    expect(connectorStateOf('tencent-meeting', inst({ origin: 'catalog' }), true)).toBe('ready');
  });

  it('custom instances never satisfy a template type', () => {
    expect(connectorStateOf('tencent-meeting', inst({ origin: 'custom' }), true)).toBe('missing');
  });

  it('no instance, or an instance with another id → missing', () => {
    expect(connectorStateOf('tencent-meeting', null, true)).toBe('missing');
    expect(connectorStateOf('tencent-meeting', inst({ id: 'feishu' }), true)).toBe('missing');
  });

  it('runtime-disabled → disabled', () => {
    expect(connectorStateOf('tencent-meeting', inst(), false)).toBe('disabled');
  });

  it('auth_error wins over a stale connected status', () => {
    expect(connectorStateOf('tencent-meeting', inst({ auth_error: { code: 'invalid_grant', message: 'x', at: 1 } as never }), true))
      .toBe('auth_error');
  });

  it('not usable → disconnected; degraded still counts as usable', () => {
    expect(connectorStateOf('tencent-meeting', inst({ status: { kind: 'disconnected' } }), true)).toBe('disconnected');
    expect(connectorStateOf('tencent-meeting', inst({ status: { kind: 'connecting' } }), true)).toBe('disconnected');
    expect(connectorStateOf('tencent-meeting', inst({ status: { kind: 'degraded' } as never }), true)).toBe('ready');
  });
});
