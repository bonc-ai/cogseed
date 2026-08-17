/**
 * M-01：Legacy Adapter——缺失/旧版本 spec_version 的显式、可审计适配；
 * 其余不匹配一律拒绝（不猜测、不回退 fail-closed）。
 */

import { describe, expect, it } from 'vitest';
import { adaptLegacyEnvelope } from '../../../../src/main/features/p3394_bridge/legacy-adapter';
import { validateP3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

function legacyEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 'msg-legacy-1',
    session_id: 'ses-legacy-1',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'legacy-node' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: 'legacy hello' }] },
    idempotency_key: 'idem-legacy-1',
    ...overrides,
  };
}

describe('P3394 Legacy Adapter (M-01)', () => {
  it('adapts a missing spec_version with an auditable fact', () => {
    const result = adaptLegacyEnvelope(legacyEnvelope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.spec_version).toBe('p3394/1.0');
      expect(result.audit).toMatchObject({ adapted_from: 'legacy', reason: 'missing_spec_version', applied: true });
      // 适配后的信封必须通过正式校验（其余字段 fail-closed）。
      const validated = validateP3394Envelope(result.envelope);
      expect(validated.ok).toBe(true);
    }
  });

  it('adapts an old spec_version and still passes formal validation', () => {
    const result = adaptLegacyEnvelope(legacyEnvelope({ spec_version: 'p3394/0.9' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.spec_version).toBe('p3394/1.0');
      expect(result.audit.reason).toContain('old_spec_version');
      expect(validateP3394Envelope(result.envelope).ok).toBe(true);
    }
  });

  it('does not adapt non-objects or current-version envelopes', () => {
    expect(adaptLegacyEnvelope(null)).toEqual({ ok: false, reason: 'not_an_object' });
    expect(adaptLegacyEnvelope([1, 2])).toEqual({ ok: false, reason: 'not_an_object' });
    expect(adaptLegacyEnvelope(legacyEnvelope({ spec_version: 'p3394/1.0' }))).toEqual({ ok: false, reason: 'not_legacy' });
  });

  it('adapted envelopes with other defects still fail closed on formal validation', () => {
    const result = adaptLegacyEnvelope(legacyEnvelope({ recipients: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const validated = validateP3394Envelope(result.envelope);
      expect(validated.ok).toBe(false);
      if (!validated.ok) expect(validated.error.reason).toBe('empty_recipients');
    }
  });
});
