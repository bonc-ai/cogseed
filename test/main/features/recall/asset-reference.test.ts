import { describe, expect, it } from 'vitest';

import {
  abilityAssetReferenceMatches,
  abilityAssetReferencesCover,
  parseAbilityAssetReference,
} from '../../../../src/main/features/recall/asset-reference';

describe('Recall ability asset references', () => {
  it('parses the supported persisted receipt forms', () => {
    expect(parseAbilityAssetReference('aa-one')).toEqual({ assetId: 'aa-one' });
    expect(parseAbilityAssetReference('asset:aa-one')).toEqual({ assetId: 'aa-one' });
    expect(parseAbilityAssetReference('asset:aa-one@v2')).toEqual({ assetId: 'aa-one', version: '2' });
    expect(parseAbilityAssetReference('asset:aa-one@v2:scope:blocked')).toEqual({
      assetId: 'aa-one', version: '2', reason: 'scope:blocked',
    });
  });

  it('does not accept a mismatched frozen version', () => {
    expect(abilityAssetReferenceMatches('asset:aa-one@v2', { assetId: 'aa-one', version: '2' })).toBe(true);
    expect(abilityAssetReferenceMatches('asset:aa-one@v1', { assetId: 'aa-one', version: '2' })).toBe(false);
  });

  it('requires a receipt to cover every frozen asset', () => {
    expect(abilityAssetReferencesCover(
      ['asset:aa-one@v1'],
      [{ assetId: 'aa-one', version: '1' }, { assetId: 'aa-two', version: '1' }],
    )).toBe(false);
    expect(abilityAssetReferencesCover(
      ['asset:aa-one@v1', 'aa-two'],
      [{ assetId: 'aa-one', version: '1' }, { assetId: 'aa-two', version: '1' }],
    )).toBe(true);
  });
});
