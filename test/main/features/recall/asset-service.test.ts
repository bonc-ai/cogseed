import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-assets-')); previousRoot = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function modules() {
  const [candidates, assets] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
  ]);
  return { candidates, assets };
}

describe('Recall ability assets', () => {
  it('updates immutable-id assets with append-only snapshots and lifecycle audit events', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Keep decision records with evidence.', suggestedType: 'rule', suggestedScope: 'architecture', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);

    const updated = await assets.updateAbilityAsset('user-a', asset.id, { statement: 'Keep architecture decision records with source evidence.', scope: 'architecture-review' });
    expect(updated.id).toBe(asset.id);
    expect(updated.version).toBe('2');
    expect(updated.statement).toContain('architecture decision');

    const paused = await assets.pauseAbilityAsset('user-a', asset.id, 'needs review');
    expect(paused.status).toBe('paused');
    const revoked = await assets.revokeAbilityAsset('user-a', asset.id, 'unsafe');
    expect(revoked.status).toBe('revoked');

    const versions = await assets.listAbilityAssetVersions('user-a', asset.id);
    expect(versions.map((entry) => entry.version)).toEqual(['1', '2']);
    expect(versions[0].snapshot.statement).toBe(asset.statement);
    expect(versions[1].snapshot.scope).toBe('architecture-review');

    const audit = await assets.listAbilityAssetAudit('user-a', asset.id);
    expect(audit.map((entry) => entry.action)).toEqual(['created', 'updated', 'paused', 'revoked']);
  });

  it('never changes asset ownership or accepts mutable identity fields', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Prefer local evidence.', suggestedType: 'personal', suggestedScope: 'personal', sourceRefs: [{ kind: 'memory', id: 'mem-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);

    await expect(assets.updateAbilityAsset('user-a', asset.id, { id: 'aa-other' } as never)).rejects.toThrow(/identity/i);
    await expect(assets.readAbilityAsset('user-b', asset.id)).rejects.toThrow(/not found/i);
  });

  it('preserves legacy kinds while normalizing evidence metadata at asset boundaries', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep source compatibility explicit.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-a' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('user-a', 'ability-assets', asset.id, (current) => ({
      ...current!,
      evidenceRefs: [
        { kind: 'message', id: 'msg-a' },
        { kind: 'context', id: 'context-a' },
        { kind: 'memory', id: 'memory-a' },
      ],
    }));

    const legacy = await assets.readAbilityAsset('user-a', asset.id);
    expect(legacy.evidenceRefs).toEqual([
      expect.objectContaining({ kind: 'message', subtype: 'message', id: 'msg-a', taxonomyVersion: 1 }),
      expect.objectContaining({ kind: 'context', subtype: 'context_file', id: 'context-a', taxonomyVersion: 1 }),
      expect.objectContaining({ kind: 'memory', subtype: 'teaching', id: 'memory-a', taxonomyVersion: 1, degraded: true, reason: 'legacy_memory_untraceable' }),
    ]);

    const updated = await assets.updateAbilityAsset('user-a', asset.id, {
      evidenceRefs: [{ kind: 'execution', id: 'exec-a' } as never],
    });
    expect(updated.evidenceRefs).toEqual([
      expect.objectContaining({ kind: 'execution', subtype: 'execution', id: 'exec-a', taxonomyVersion: 1 }),
    ]);
  });

  it('preserves legacy evidence kinds in historical asset snapshots', async () => {
    const { assets } = await modules();
    const store = await import('../../../../src/main/features/recall/store');
    await store.appendRecallJsonlRecord('user-a', 'ability-asset-versions', 'aa-legacy', {
      schemaVersion: 1,
      ownerId: 'user-a',
      id: 'aa-legacy-v1',
      assetId: 'aa-legacy',
      version: '1',
      at: '2026-01-01T00:00:00.000Z',
      snapshot: {
        title: 'Legacy asset',
        statement: 'Legacy evidence remains readable.',
        type: 'rule',
        scope: 'project',
        evidenceRefs: [
          { kind: 'message', id: 'msg-legacy' },
          { kind: 'ontology', id: 'ontology-legacy' },
        ],
        status: 'active',
        maturity: 'seed',
        version: '1',
      },
    });

    const [version] = await assets.listAbilityAssetVersions('user-a', 'aa-legacy');
    expect(version.snapshot.evidenceRefs).toEqual([
      expect.objectContaining({ kind: 'message', subtype: 'message', id: 'msg-legacy', taxonomyVersion: 1 }),
      expect.objectContaining({ kind: 'ontology', subtype: 'artifact', id: 'ontology-legacy', taxonomyVersion: 1, degraded: true, reason: 'legacy_ontology_asset_ref' }),
    ]);
  });
});

describe('治理状态模型', () => {
  async function seedAsset(uid: string) {
    const { candidates } = await modules();
    const candidate = await candidates.saveRecallCandidate(uid, {
      judgment: 'Record governance decisions with their evidence.',
      suggestedType: 'rule', suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov' }],
    });
    return (await candidates.promoteRecallCandidate(uid, candidate.id)).asset;
  }

  it('接受规范 22.1 的全部治理状态，并拒绝编造的状态', async () => {
    const { assets } = await modules();
    const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    const asset = await seedAsset('user-gov');

    for (const status of ['active', 'paused', 'archived', 'deleted', 'purged', 'revoked'] as const) {
      await updateRecallJsonRecord('user-gov', 'ability-assets', asset.id, (raw) => ({
        ...raw!, status, ...(status === 'deleted' ? { deletedAt: new Date().toISOString() } : {}),
      }));
      expect((await assets.readAbilityAsset('user-gov', asset.id)).status).toBe(status);
    }

    await updateRecallJsonRecord('user-gov', 'ability-assets', asset.id, (raw) => ({ ...raw!, status: 'shredded' }));
    await expect(assets.readAbilityAsset('user-gov', asset.id)).rejects.toThrow('malformed recall ability asset');
  });

  it('旧记录不带 deletedAt 也能照常读出', async () => {
    // 向后兼容：本次只是放宽白名单，存量记录里没有任何新状态和新字段。
    const { assets } = await modules();
    const asset = await seedAsset('user-legacy');
    const loaded = await assets.readAbilityAsset('user-legacy', asset.id);
    expect(loaded.status).toBe('active');
    expect(loaded.deletedAt).toBeUndefined();
  });

  it('保留期按 deletedAt 现算，不依赖预存的到期时间', async () => {
    // 存事实不存政策：保留期天数改了也不需要迁移已有记录。
    const { assets } = await modules();
    const { ABILITY_ASSET_DELETION_RETENTION_DAYS, isWithinDeletionRetention } = assets;
    const day = 86_400_000;
    const now = new Date('2026-09-01T00:00:00.000Z');
    const justDeleted = new Date(now.getTime() - day).toISOString();
    const longGone = new Date(now.getTime() - (ABILITY_ASSET_DELETION_RETENTION_DAYS + 1) * day).toISOString();

    expect(isWithinDeletionRetention({ status: 'deleted', deletedAt: justDeleted }, now)).toBe(true);
    expect(isWithinDeletionRetention({ status: 'deleted', deletedAt: longGone }, now)).toBe(false);
    // 缺 deletedAt 的已删除记录不声称可恢复；非 deleted 状态压根不适用保留期。
    expect(isWithinDeletionRetention({ status: 'deleted' }, now)).toBe(false);
    expect(isWithinDeletionRetention({ status: 'deleted', deletedAt: 'not-a-date' }, now)).toBe(false);
    expect(isWithinDeletionRetention({ status: 'archived', deletedAt: justDeleted }, now)).toBe(false);
  });

  it('非 active 状态一律挡在投影之外', async () => {
    // 下游用 `status !== 'active'` 拒绝式判断，新增状态必须天然被排除，
    // 否则一条已删除的资产会被带进任务。
    const { assets } = await modules();
    const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    const workspaceRefs = await import('../../../../src/main/features/recall/workspace-refs');
    const asset = await seedAsset('user-gate');

    for (const status of ['paused', 'archived', 'deleted', 'purged', 'revoked'] as const) {
      await updateRecallJsonRecord('user-gate', 'ability-assets', asset.id, (raw) => ({ ...raw!, status }));
      await expect(workspaceRefs.addWorkspaceAssetReference('user-gate', {
        assetId: asset.id, workspaceId: 'ws-1', scope: 'project',
      })).rejects.toThrow('ability asset is not active');
    }
  });
});
