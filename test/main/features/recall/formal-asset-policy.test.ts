import { describe, expect, it } from 'vitest';

import {
  allowsSilentDefaultInjection,
  isTransferVerified,
  isUserConfirmed,
  resolveAssetLifecycle,
  resolveAssetUsePolicy,
} from '../../../../src/main/features/recall/formal-assets/policy';

const active = { status: 'active' as const };

describe('formal asset policy: three orthogonal axes', () => {
  // 来源不决定成熟度。KStar 自进化沉淀的资产标签是 system_precipitated_*，
  // 但没人确认过就仍在 seed 档——不能因为"是 KStar 来的"就更成熟。
  it('keeps provenance independent from maturity', () => {
    const kstarSeed = { ...active, maturity: 'seed' as const, lifecycleStatus: 'system_precipitated_unverified' as const };
    expect(resolveAssetLifecycle(kstarSeed)).toBe('system_precipitated_unverified');
    expect(isUserConfirmed(kstarSeed)).toBe(false);
    expect(isTransferVerified(kstarSeed)).toBe(false);
    expect(resolveAssetUsePolicy(kstarSeed, true)).toBe('never');
  });

  // maturity 到 bud 不代表有人确认过：系统线也能到 bud 之外的档位，
  // 判断"用户确认过吗"只能看 lifecycleStatus。
  it('does not infer user confirmation from maturity', () => {
    const autoBud = { ...active, maturity: 'bud' as const, lifecycleStatus: 'automatically_extracted_unverified' as const };
    expect(isUserConfirmed(autoBud)).toBe(false);
    const userBud = { ...active, maturity: 'bud' as const, lifecycleStatus: 'user_confirmed_unverified' as const };
    expect(isUserConfirmed(userBud)).toBe(true);
    // 两者的默认使用契约相同——确认与否体现在来源轴，不改变成熟度档。
    expect(resolveAssetUsePolicy(autoBud, true)).toBe(resolveAssetUsePolicy(userBud, true));
  });

  it('defaults a missing provenance to the automatic capture line', () => {
    expect(resolveAssetLifecycle({})).toBe('automatically_extracted_unverified');
  });

  // PRD 3.6：User Confirmed / Unverified 仅在用户主动选择时使用，
  // 不得静默默认注入；Transfer Verified 起才可以。
  it('only allows silent default injection from Transfer Verified upward', () => {
    expect(allowsSilentDefaultInjection({ ...active, maturity: 'seed' }, true)).toBe(false);
    expect(allowsSilentDefaultInjection({ ...active, maturity: 'bud' }, true)).toBe(false);
    expect(allowsSilentDefaultInjection({ ...active, maturity: 'transfer_validated' }, true)).toBe(true);
    expect(allowsSilentDefaultInjection({ ...active, maturity: 'effectiveness_validated' }, true)).toBe(true);
  });

  // 治理轴一票否决：不管验证到哪一步，非 active 一律不带入。
  it('lets governance status veto any maturity', () => {
    for (const status of ['paused', 'archived', 'deleted', 'purged', 'revoked'] as const) {
      expect(resolveAssetUsePolicy({ status, maturity: 'effectiveness_validated' }, true)).toBe('never');
      expect(allowsSilentDefaultInjection({ status, maturity: 'effectiveness_validated' }, true)).toBe(false);
    }
  });

  // 跨作用域一律不比同作用域松；确认过也只放宽到 prompt，不到 auto。
  it('never makes cross-scope looser than same-scope', () => {
    const rank = { never: 0, confirm: 1, prompt: 2, auto: 3 };
    for (const maturity of ['seed', 'bud', 'transfer_validated', 'effectiveness_validated'] as const) {
      const asset = { ...active, maturity };
      expect(rank[resolveAssetUsePolicy(asset, false)])
        .toBeLessThanOrEqual(rank[resolveAssetUsePolicy(asset, true)]);
    }
    const confirmed = { ...active, maturity: 'transfer_validated' as const, crossScopeConfirmedAt: '2026-08-15T00:00:00.000Z' };
    expect(resolveAssetUsePolicy(confirmed, false)).toBe('prompt');
    expect(allowsSilentDefaultInjection(confirmed, false)).toBe(false);
  });
});
