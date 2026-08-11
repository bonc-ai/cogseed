import { describe, expect, it } from 'vitest';

import {
  APP_BRAND,
  CONNECTOR_PROTOCOL_SCHEMES,
  normalizeDeepLink,
  resolveRuntimeIdentity,
} from '../../src/main/brand';

describe('CogSeed protocol identity', () => {
  it('uses canonical app and protocol identity while accepting one-version aliases', () => {
    expect(APP_BRAND.appId).toBe('com.cogseed.desktop');
    expect(APP_BRAND.protocolScheme).toBe('cogseed');
    expect(CONNECTOR_PROTOCOL_SCHEMES).toEqual(['cogseed', 'mateagent', 'orkas']);
    expect(resolveRuntimeIdentity(true, 'main').appId).toBe('com.cogseed.desktop');
    expect(resolveRuntimeIdentity(false, 'mate').appId).toBe('com.cogseed.desktop.source.mate');
  });

  it('normalizes legacy connector deep links to the canonical scheme', () => {
    expect(normalizeDeepLink('orkas://connectors/oauth/callback')?.scheme).toBe('cogseed');
    expect(normalizeDeepLink('mateagent://connectors/oauth/dcr-callback')?.scheme).toBe('cogseed');
    expect(normalizeDeepLink('cogseed://connectors/oauth/callback')?.href)
      .toBe('cogseed://connectors/oauth/callback');
    expect(normalizeDeepLink('https://connectors/oauth/callback')).toBeNull();
  });
});
