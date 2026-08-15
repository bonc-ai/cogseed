import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ enabled: true }));

vi.mock('../../../../src/main/features/hub_account/gate', () => ({
  assertHubAccountReleaseEnabled: () => {
    if (!mocks.enabled) {
      const error = new Error('closed') as Error & { code: string };
      error.code = 'HUB_RELEASE_GATE_CLOSED';
      throw error;
    }
  },
}));

import { _test, handleAccountCallbackUrl } from '../../../../src/main/features/hub_account';

describe('Hub account deep-link parsing', () => {
  it('accepts only the canonical callback route', () => {
    expect(_test.accountCallbackUrl('cogseed://account/callback?code=a&state=b')).toBeTruthy();
    expect(_test.accountCallbackUrl('https://account/callback?code=a&state=b')).toBeNull();
    expect(_test.accountCallbackUrl('cogseed://ACCOUNT/callback/?code=a&state=b')).toBeTruthy();
    expect(_test.accountCallbackUrl('cogseed://account/other?code=a&state=b')).toBeNull();
  });

  it('rejects duplicate, empty, or oversized security parameters', () => {
    expect(_test.parseAccountCallback('cogseed://account/callback?code=a&code=b&state=c')).toEqual({ ok: false, error: 'duplicate_code' });
    expect(_test.parseAccountCallback('cogseed://account/callback?code=a&state=b&state=c')).toEqual({ ok: false, error: 'duplicate_state' });
    expect(_test.parseAccountCallback('cogseed://account/callback?code=&state=b')).toEqual({ ok: false, error: 'missing_code' });
    expect(_test.parseAccountCallback(`cogseed://account/callback?code=${'a'.repeat(4097)}&state=b`)).toEqual({ ok: false, error: 'invalid_code' });
  });

  it('does not consume authorization parameters while the release Gate is closed', async () => {
    mocks.enabled = false;
    await expect(handleAccountCallbackUrl('cogseed://account/callback?code=secret-code&state=secret-state'))
      .resolves.toEqual({ ok: false, error: 'HUB_RELEASE_GATE_CLOSED' });
  });
});
