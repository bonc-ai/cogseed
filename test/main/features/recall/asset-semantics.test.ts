import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-asset-semantics-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function modules() {
  const [candidates, assets, semantics] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/asset-semantics'),
  ]);
  return { candidates, assets, semantics };
}

async function seedAsset(userId: string, judgment: string) {
  const { candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate(userId, {
    judgment,
    suggestedType: 'rule',
    suggestedScope: 'delivery',
    sourceRefs: [{ kind: 'execution', id: `exec-${judgment.length}` }],
  });
  return candidates.promoteRecallCandidate(userId, candidate.id, { actor: 'user' });
}

describe('ability asset semantics normalization', () => {
  it('deduplicates conditions case-insensitively and collapses whitespace', async () => {
    const { semantics } = await modules();
    const conditions = semantics.normalizeAbilityAssetConditions(
      ['  Reviewing   a PR  ', 'reviewing a pr', 'Writing a design doc'],
      'applicableWhen',
    );
    expect(conditions).toEqual(['Reviewing a PR', 'Writing a design doc']);
  });

  it('rejects non-string, empty and over-long conditions', async () => {
    const { semantics } = await modules();
    expect(() => semantics.normalizeAbilityAssetConditions([42], 'applicableWhen'))
      .toThrow('malformed ability asset applicableWhen');
    expect(() => semantics.normalizeAbilityAssetConditions(['   '], 'forbiddenWhen'))
      .toThrow('malformed ability asset forbiddenWhen');
    expect(() => semantics.normalizeAbilityAssetConditions(['x'.repeat(501)], 'applicableWhen'))
      .toThrow('too long');
  });

  it('leaves absent fields absent rather than defaulting to empty arrays', async () => {
    const { semantics } = await modules();
    expect(semantics.readAbilityAssetSemantics({})).toEqual({});
    // 空数组要原样保留：「写过、但一条也没有」和「没写过」不是一回事。
    expect(semantics.readAbilityAssetSemantics({ forbiddenWhen: [] })).toEqual({ forbiddenWhen: [] });
  });

  it('only admits L0..L2 — L3 can never be an asset', async () => {
    const { semantics } = await modules();
    expect(semantics.normalizeAbilityAssetSensitivity('L2')).toBe('L2');
    expect(() => semantics.normalizeAbilityAssetSensitivity('L3'))
      .toThrow('malformed ability asset sensitivity');
  });
});

describe('规范 10.2 默认使用矩阵', () => {
  it('跨作用域一律不比同作用域松', async () => {
    const { semantics } = await modules();
    const maturities = ['seed', 'bud', 'transfer_validated', 'effectiveness_validated'] as const;
    const rank = { never: 0, confirm: 1, prompt: 2, auto: 3 };
    for (const maturity of maturities) {
      const same = semantics.resolveDefaultUsePolicy({ status: 'active', maturity }, true);
      const cross = semantics.resolveDefaultUsePolicy({ status: 'active', maturity }, false);
      expect(rank[cross]).toBeLessThanOrEqual(rank[same]);
    }
  });

  it('seed 档任何作用域都不默认带入', async () => {
    const { semantics } = await modules();
    expect(semantics.resolveDefaultUsePolicy({ status: 'active', maturity: 'seed' }, true)).toBe('never');
    expect(semantics.resolveDefaultUsePolicy({ status: 'active', maturity: 'seed' }, false)).toBe('never');
  });

  it('非 active 状态一律不带入', async () => {
    const { semantics } = await modules();
    for (const status of ['paused', 'archived', 'deleted', 'purged', 'revoked'] as const) {
      expect(semantics.resolveDefaultUsePolicy({ status, maturity: 'effectiveness_validated' }, true)).toBe('never');
    }
  });
});

describe('ability asset semantics persistence', () => {
  it('carries semantics from promotion through read-back', async () => {
    const { candidates } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-s', {
      judgment: 'Prefer append-only audit records for asset changes.',
      suggestedType: 'rule',
      suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-seed' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-s', candidate.id, {
      actor: 'user',
      applicableWhen: ['Designing a store module'],
      forbiddenWhen: ['Hot paths where an extra write costs latency'],
    });

    expect(asset.applicableWhen).toEqual(['Designing a store module']);
    expect(asset.forbiddenWhen).toEqual(['Hot paths where an extra write costs latency']);
    // 没传过的字段不该被凭空补上。
    expect(asset.sensitivity).toBeUndefined();
    expect(asset.relations).toBeUndefined();
  });

  it('records semantics in the version snapshot and bumps the version', async () => {
    const { assets } = await modules();
    const base = await seedAsset('user-v', 'Baseline judgment for versioning.');

    const updated = await assets.updateAbilityAsset('user-v', base.asset.id, {
      applicableWhen: ['Onboarding a new teammate'],
      sensitivity: 'L1',
      actor: 'user',
      reason: '补齐适用条件',
    });

    expect(updated.version).toBe('2');
    expect(updated.applicableWhen).toEqual(['Onboarding a new teammate']);
    expect(updated.sensitivity).toBe('L1');

    const versions = await assets.listAbilityAssetVersions('user-v', base.asset.id);
    expect(versions.map((entry) => entry.version)).toEqual(['1', '2']);
    // v1 predates the semantics, so the snapshot must not invent them.
    expect(versions[0].snapshot.applicableWhen).toBeUndefined();
    expect(versions[1].snapshot.applicableWhen).toEqual(['Onboarding a new teammate']);
    expect(versions[1].snapshot.sensitivity).toBe('L1');
  });

  it('runs conditions through the L3 gate on both write paths', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-l3', {
      judgment: 'A perfectly ordinary judgment.',
      suggestedType: 'rule',
      suggestedScope: 'ops',
      sourceRefs: [{ kind: 'execution', id: 'exec-l3' }],
    });
    await expect(candidates.promoteRecallCandidate('user-l3', candidate.id, {
      actor: 'user',
      applicableWhen: ['api_key = sk_live_9f8e7d6c5b4a3210 时适用'],
    })).rejects.toThrow('forbidden to persist');

    const base = await seedAsset('user-l3b', 'Another ordinary judgment.');
    await expect(assets.updateAbilityAsset('user-l3b', base.asset.id, {
      forbiddenWhen: ['Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
      actor: 'user',
      reason: '试图写入凭证',
    })).rejects.toThrow('forbidden to persist');
    // 被拒的编辑不该动版本
    expect((await assets.readAbilityAsset('user-l3b', base.asset.id)).version).toBe('1');
  });

  it('purge clears the semantics along with the body', async () => {
    const { assets } = await modules();
    const base = await seedAsset('user-p', 'Judgment that will be purged.');
    await assets.updateAbilityAsset('user-p', base.asset.id, {
      applicableWhen: ['Only while onboarding'],
      forbiddenWhen: ['Never in production reviews'],
      sensitivity: 'L2',
      actor: 'user',
      reason: '补语义',
    });

    const purged = await assets.purgeAbilityAsset('user-p', base.asset.id, { actor: 'user', reason: '用户要求彻底清除' });
    expect(purged.applicableWhen).toBeUndefined();
    expect(purged.forbiddenWhen).toBeUndefined();
    expect(purged.sensitivity).toBeUndefined();
  });
});
