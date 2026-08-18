import { describe, expect, it } from 'vitest';

import {
  APP_BRAND,
  CONNECTOR_PROTOCOL_SCHEMES,
  normalizeDeepLink,
  resolveRuntimeIdentity,
} from '../../src/main/brand';

describe('CogSeed-only protocol identity', () => {
  it('uses only canonical CogSeed identity', () => {
    expect(APP_BRAND.appId).toBe('com.cogseed.desktop');
    expect(APP_BRAND.protocolScheme).toBe('cogseed');
    expect(CONNECTOR_PROTOCOL_SCHEMES).toEqual(['cogseed']);
    expect(resolveRuntimeIdentity(true, 'main').appId).toBe('com.cogseed.desktop');
    expect(resolveRuntimeIdentity(false, 'cogseed').appId).toBe('com.cogseed.desktop.source.cogseed');
    expect(() => resolveRuntimeIdentity(false, 'legacy')).toThrow(/cogseed/i);
  });

  it('rejects all legacy connector deep links', () => {
    const legacyOrkas = ['or', 'kas'].join('');
    const legacyMateagent = ['mate', 'agent'].join('');
    expect(normalizeDeepLink(`${legacyOrkas}://connectors/oauth/callback`)).toBeNull();
    expect(normalizeDeepLink(`${legacyMateagent}://connectors/oauth/dcr-callback`)).toBeNull();
    expect(normalizeDeepLink('cogseed://connectors/oauth/callback')?.scheme)
      .toBe('cogseed');
    expect(normalizeDeepLink('https://connectors/oauth/callback')).toBeNull();
  });
});
