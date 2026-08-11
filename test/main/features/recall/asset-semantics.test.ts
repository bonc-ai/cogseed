import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-asset-semantics-')); previousRoot = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

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
  return candidates.promoteRecallCandidate(userId, candidate.id);
}

describe('ability asset semantics normalization', () => {
  it('rejects self-referential relations and derivation', async () => {
    const { semantics } = await modules();
    expect(() => semantics.normalizeAbilityAssetRelations(
      [{ kind: 'refines', assetId: 'aa-self' }],
      'aa-self',
    )).toThrow('cannot relate to itself');
    expect(() => semantics.normalizeAbilityAssetDerivedFrom(['aa-self'], 'aa-self'))
      .toThrow('cannot derive from itself');
  });

  it('rejects unknown relation kinds and path-unsafe asset ids', async () => {
    const { semantics } = await modules();
    expect(() => semantics.normalizeAbilityAssetRelations([{ kind: 'supersedes', assetId: 'aa-1' }]))
      .toThrow('relation kind');
    expect(() => semantics.normalizeAbilityAssetRelations([{ kind: 'refines', assetId: '../escape' }]))
      .toThrow('relation asset id');
  });

  it('deduplicates relations by (kind, assetId) but keeps distinct kinds', async () => {
    const { semantics } = await modules();
    const relations = semantics.normalizeAbilityAssetRelations([
      { kind: 'refines', assetId: 'aa-1' },
      { kind: 'refines', assetId: 'aa-1', note: 'ignored duplicate' },
      { kind: 'conflicts_with', assetId: 'aa-1' },
    ]);
    expect(relations).toHaveLength(2);
    expect(relations.map((entry) => entry.kind)).toEqual(['refines', 'conflicts_with']);
  });

  it('deduplicates conditions case-insensitively and collapses whitespace', async () => {
    const { semantics } = await modules();
    const conditions = semantics.normalizeAbilityAssetConditions(
      ['  Reviewing   a PR  ', 'reviewing a pr', 'Writing a design doc'],
      'applicableWhen',
    );
    expect(conditions).toEqual(['Reviewing a PR', 'Writing a design doc']);
  });

  it('leaves absent fields absent rather than defaulting to empty arrays', async () => {
    const { semantics } = await modules();
    expect(semantics.readAbilityAssetSemantics({})).toEqual({});
    expect(semantics.readAbilityAssetSemantics({ forbiddenWhen: [] })).toEqual({ forbiddenWhen: [] });
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
      applicableWhen: ['Designing a store module'],
      forbiddenWhen: ['Hot paths where an extra write costs latency'],
    });

    expect(asset.applicableWhen).toEqual(['Designing a store module']);
    expect(asset.forbiddenWhen).toEqual(['Hot paths where an extra write costs latency']);
    expect(asset.relations).toBeUndefined();
  });

  it('records semantics in the version snapshot and bumps the version', async () => {
    const { assets } = await modules();
    const base = await seedAsset('user-v', 'Baseline judgment for versioning.');
    const other = await seedAsset('user-v', 'A second unrelated judgment.');

    const updated = await assets.updateAbilityAsset('user-v', base.asset.id, {
      relations: [{ kind: 'refines', assetId: other.asset.id }],
      derivedFrom: [other.asset.id],
      applicableWhen: ['Onboarding a new teammate'],
    });

    expect(updated.version).toBe('2');
    expect(updated.relations).toEqual([{ kind: 'refines', assetId: other.asset.id }]);
    expect(updated.derivedFrom).toEqual([other.asset.id]);

    const versions = await assets.listAbilityAssetVersions('user-v', base.asset.id);
    expect(versions.map((entry) => entry.version)).toEqual(['1', '2']);
    // v1 predates the semantics, so the snapshot must not invent them.
    expect(versions[0].snapshot.relations).toBeUndefined();
    expect(versions[1].snapshot.relations).toEqual([{ kind: 'refines', assetId: other.asset.id }]);
    expect(versions[1].snapshot.applicableWhen).toEqual(['Onboarding a new teammate']);
  });

  it('refuses an update that points an asset at itself', async () => {
    const { assets } = await modules();
    const base = await seedAsset('user-r', 'Judgment that will try to self-reference.');
    await expect(assets.updateAbilityAsset('user-r', base.asset.id, {
      relations: [{ kind: 'replaces', assetId: base.asset.id }],
    })).rejects.toThrow('cannot relate to itself');

    // The rejected update must not have bumped the version.
    const stored = await assets.readAbilityAsset('user-r', base.asset.id);
    expect(stored.version).toBe('1');
  });
});
