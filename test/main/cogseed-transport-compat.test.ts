import { describe, expect, it } from 'vitest';

import { COGSEED_TRANSPORT, LEGACY_TRANSPORT } from '../../src/main/cogseed-transport-compat';

describe('CogSeed transport compat', () => {
  it('declares canonical and legacy transport names', () => {
    expect(COGSEED_TRANSPORT).toEqual({
      invoke: 'cogseed.invoke',
      streamStart: 'cogseed.streamStart',
      streamCancel: 'cogseed.streamCancel',
      bootI18n: 'cogseed:bootI18n',
    });
    expect(LEGACY_TRANSPORT).toEqual({
      invoke: 'orkas.invoke',
      streamStart: 'orkas.streamStart',
      streamCancel: 'orkas.streamCancel',
      bootI18n: 'orkas:bootI18n',
    });
  });
});
