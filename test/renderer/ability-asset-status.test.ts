import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/renderer/modules/ability-asset-status.js'), 'utf8');
const lazyFeatures = fs.readFileSync(path.join(root, 'src/renderer/modules/lazy-features.js'), 'utf8');
const skillsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/skills.js'), 'utf8');
const candidateService = fs.readFileSync(
  path.join(root, 'src/main/features/recall/candidate-service.ts'),
  'utf8',
);
const assetService = fs.readFileSync(
  path.join(root, 'src/main/features/recall/asset-service.ts'),
  'utf8',
);
const zhLocale = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
const enLocale = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/en.json'), 'utf8'));

function load() {
  const context: any = {};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'ability-asset-status.js' });
  return context.OrkasAbilityAssetStatus;
}

const { DISPLAY, abilityAssetDisplayStatus, abilityAssetDisplayStatusI18nKey } = load();

const MATURITIES = ['seed', 'bud', 'transfer_validated', 'effectiveness_validated'];

describe('candidate side', () => {
  it('shows pending as candidate', () => {
    expect(abilityAssetDisplayStatus({ status: 'pending' })).toEqual({ key: 'candidate' });
    expect(abilityAssetDisplayStatus({ status: 'candidate' })).toEqual({ key: 'candidate' });
  });

  it('shows deferred as candidate, marked so it is not read as untouched', () => {
    expect(abilityAssetDisplayStatus({ status: 'deferred' })).toEqual({
      key: 'candidate',
      note: 'deferred',
    });
  });

  it('gives rejected its own value rather than folding it into deprecated', () => {
    // Rejected belongs to candidate history; deprecated describes an asset
    // that once served. Collapsing them would put never-promoted judgments in
    // the same bucket as retired capabilities.
    expect(abilityAssetDisplayStatus({ status: 'rejected' })).toEqual({ key: 'rejected' });
  });
});

describe('promoted candidate', () => {
  it('resolves through the asset maturity', () => {
    expect(abilityAssetDisplayStatus({ status: 'promoted', maturity: 'seed' })).toEqual({ key: 'confirmed' });
    expect(abilityAssetDisplayStatus({ status: 'promoted', maturity: 'bud' })).toEqual({ key: 'confirmed' });
    expect(abilityAssetDisplayStatus({ status: 'promoted', maturity: 'transfer_validated' })).toEqual({
      key: 'active',
    });
    expect(abilityAssetDisplayStatus({ status: 'promoted', maturity: 'effectiveness_validated' })).toEqual({
      key: 'active',
    });
  });

  it('reports unknown when the asset cannot be resolved', () => {
    // promoteRecallCandidate writes the asset and the candidate's
    // promotedAssetId in one update, so a promoted candidate with no readable
    // asset means the pair is inconsistent. Showing "confirmed" would claim a
    // capability exists when we cannot read one.
    expect(abilityAssetDisplayStatus({ status: 'promoted' })).toEqual({ key: 'unknown' });
    expect(abilityAssetDisplayStatus({ status: 'promoted', maturity: '' })).toEqual({ key: 'unknown' });
    expect(abilityAssetDisplayStatus({ status: 'promoted', maturity: 'sprouted' })).toEqual({ key: 'unknown' });
  });
});

describe('asset side', () => {
  it('shows an unvalidated active asset as confirmed', () => {
    expect(abilityAssetDisplayStatus({ status: 'active', maturity: 'seed' })).toEqual({ key: 'confirmed' });
    expect(abilityAssetDisplayStatus({ status: 'active', maturity: 'bud' })).toEqual({ key: 'confirmed' });
  });

  it('shows active only after a proof has validated it', () => {
    expect(abilityAssetDisplayStatus({ status: 'active', maturity: 'transfer_validated' })).toEqual({
      key: 'active',
    });
    expect(abilityAssetDisplayStatus({ status: 'active', maturity: 'effectiveness_validated' })).toEqual({
      key: 'active',
    });
  });

  it('gives paused its own value, distinct from deprecated', () => {
    // Paused is reversible; deprecated is not. Telling a user their asset is
    // deprecated when they merely paused it misstates what happened.
    expect(abilityAssetDisplayStatus({ status: 'paused', maturity: 'seed' })).toEqual({ key: 'paused' });
  });

  it('shows revoked as deprecated', () => {
    expect(abilityAssetDisplayStatus({ status: 'revoked', maturity: 'seed' })).toEqual({ key: 'deprecated' });
  });

  it('keeps paused and revoked independent of how far maturity climbed', () => {
    for (const maturity of MATURITIES) {
      expect(abilityAssetDisplayStatus({ status: 'paused', maturity })).toEqual({ key: 'paused' });
      expect(abilityAssetDisplayStatus({ status: 'revoked', maturity })).toEqual({ key: 'deprecated' });
    }
  });

  it('reports unknown for an active asset whose maturity it cannot place', () => {
    // No optimistic floor: an unrecognized rung means the ladder changed under
    // us, and guessing "confirmed" would hide that.
    expect(abilityAssetDisplayStatus({ status: 'active' })).toEqual({ key: 'unknown' });
    expect(abilityAssetDisplayStatus({ status: 'active', maturity: 'sprouted' })).toEqual({ key: 'unknown' });
    expect(abilityAssetDisplayStatus({ status: 'active', maturity: null as never })).toEqual({ key: 'unknown' });
  });
});

describe('unmapped input', () => {
  it('returns unknown without guessing', () => {
    for (const input of [null, undefined, 'active', 42, [], {}, { status: 'archived' }, { maturity: 'seed' }]) {
      expect(abilityAssetDisplayStatus(input as never)).toEqual({ key: 'unknown' });
    }
  });
});

describe('full combination matrix', () => {
  it('never returns a value outside the enum', () => {
    const statuses = [
      'pending', 'deferred', 'rejected', 'promoted',
      'active', 'paused', 'revoked',
      'candidate', 'archived', '', 'ACTIVE',
    ];
    const maturities = [...MATURITIES, '', 'sprouted', undefined];
    const allowed = new Set(Object.values(DISPLAY));

    for (const status of statuses) {
      for (const maturity of maturities) {
        const result = abilityAssetDisplayStatus({ status, maturity } as never);
        expect(allowed.has(result.key), `${status}/${String(maturity)} → ${result.key}`).toBe(true);
      }
    }
  });

  it('is case sensitive rather than normalizing unexpected casings', () => {
    expect(abilityAssetDisplayStatus({ status: 'ACTIVE', maturity: 'seed' })).toEqual({ key: 'unknown' });
  });
});

describe('read-only guarantee', () => {
  it('does not mutate the record it is given', () => {
    const record = { status: 'active', maturity: 'seed' };
    const before = JSON.stringify(record);
    abilityAssetDisplayStatus(record);
    expect(JSON.stringify(record)).toBe(before);
  });

  it('introduces no persisted display-status field', () => {
    // Display state is derived per render; persisting it would let it drift
    // from the candidate/asset/maturity facts it comes from.
    for (const service of [candidateService, assetService]) {
      expect(service).not.toContain('displayStatus');
      expect(service).not.toContain('display_status');
    }
  });

  it('leaves the underlying status and maturity vocabularies untouched', () => {
    expect(candidateService).toContain("'pending' | 'deferred' | 'rejected' | 'promoted'");
    expect(candidateService).toContain("status: 'active' | 'paused' | 'revoked'");
    expect(candidateService).toContain(
      "maturity: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated'",
    );
  });
});

describe('i18n', () => {
  it('resolves every enum value in zh and en', () => {
    for (const key of Object.values(DISPLAY) as string[]) {
      const i18nKey = abilityAssetDisplayStatusI18nKey(key);
      expect(zhLocale[i18nKey], `${i18nKey} missing in zh`).toBeTruthy();
      expect(enLocale[i18nKey], `${i18nKey} missing in en`).toBeTruthy();
    }
  });

  it('resolves the deferred note', () => {
    expect(zhLocale['cognition.display_status_note_deferred']).toBeTruthy();
    expect(enLocale['cognition.display_status_note_deferred']).toBeTruthy();
  });

  it('returns keys rather than localized text', () => {
    expect(abilityAssetDisplayStatusI18nKey('active')).toBe('cognition.display_status_active');
    expect(source).not.toContain('候选');
  });
});

describe('wiring', () => {
  it('loads the mapper before skills.js, which reads it at render time', () => {
    const mapper = lazyFeatures.indexOf('./modules/ability-asset-status.js');
    const skills = lazyFeatures.indexOf('./modules/skills.js');
    expect(mapper).toBeGreaterThanOrEqual(0);
    expect(mapper).toBeLessThan(skills);
  });

  it('renders the display status on both the list row and the detail header', () => {
    expect(skillsSource).toContain('_abilityAssetDisplayStatusLabel(a)');
    expect(skillsSource).toContain('_abilityAssetDisplayStatusLabel(selected)');
  });

  // 这条原本守的是「显示状态不得吞掉成熟度信息」——当时详情页有一格独立的成熟度行。
  // develop 在重构中整体移除了资产详情的 detail grid，成熟度行随之消失。合并时不把它
  // 加回来：那是推翻对方的产品决定，不是迁移我的功能。成熟度是否仍需对用户可见，
  // 留给产品判断，见待办「资产详情成熟度是否恢复展示」。
  it('still maps maturity for surfaces that show it', () => {
    expect(skillsSource).toContain('function _abilityAssetMaturityLabel');
  });
});
