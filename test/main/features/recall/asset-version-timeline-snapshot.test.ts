import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let root: string;
const uid = 'timeline-snapshot-user';
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-timeline-snapshot-'));
  vi.stubEnv('COGSEED_WORKSPACE_ROOT', root);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const journal = await import('../../../../src/main/features/recall/asset-version-journal');
  const raw = journal.withPendingAssetVersion(undefined, { schemaVersion: 2, ownerId: uid, id: 'aa-snapshot', candidateId: 'old-candidate',
    reviewDecisionId: 'old-review', type: 'cognition', contentCategory: 'method', title: '已保存的方法', statement: '先核对来源，再保存完整成果。',
    evidenceRefs: [], origin: 'manual', status: 'active', maturity: 'bud', scope: 'general', version: '1',
    createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' });
  const bridge = await import('../../../../src/main/features/cognition_bridge');
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': { [raw.id]: raw }, candidates: {} },
    po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: '2026-10-15T00:00:00.000Z' });
  const assets = await import('../../../../src/main/features/recall/asset-service');
  return { assets, head: await assets.readAbilityAsset(uid, raw.id) };
}
it('reuses a same-request head without losing a committed pending version or changing the default caller contract', async () => {
  const { assets, head } = await fixture();
  const store = await import('../../../../src/main/features/recall/store');
  const reads = vi.spyOn(store, 'readRecallJsonRecord');
  const ordinary = await assets.listAbilityAssetVersions(uid, head.id);
  expect(reads).toHaveBeenCalledTimes(1);
  reads.mockClear();
  const shared = await assets.listAbilityAssetVersions(uid, head.id, head);
  expect(reads).not.toHaveBeenCalled();
  expect(shared).toEqual(ordinary);
  expect(shared).toEqual([expect.objectContaining({ version: '1', snapshot: expect.objectContaining({ statement: head.statement }) })]);
});
it('refuses a supplied head belonging to a different user or asset', async () => {
  const { assets, head } = await fixture();
  await expect(assets.listAbilityAssetVersions(uid, head.id, { ...head, ownerId: 'other-user' })).rejects.toThrow('identity mismatch');
  await expect(assets.listAbilityAssetVersions(uid, head.id, { ...head, id: 'aa-other' })).rejects.toThrow('identity mismatch');
});
it('preserves future use through versions and restores a legacy missing field without borrowing the latest value', async () => {
  const { assets, head } = await fixture();
  expect(head.value).toBeUndefined();
  const updated = await assets.updateAbilityAsset(uid, head.id, { value: '用于核对来源。\n保留必要的例外。', actor: 'user', reason: 'synthetic future use' });
  expect(updated.value).toBe('用于核对来源。\n保留必要的例外。');
  expect(updated.scope).toBe(head.scope);
  expect((await assets.readAbilityAssetVersionSnapshot(uid, head.id, updated.version))?.value).toBe(updated.value);
  const old = await assets.selectAbilityAssetVersion(uid, head.id, '1', { actor: 'user', reason: 'synthetic legacy selection' });
  expect(old.value).toBeUndefined();
  await assets.updateAbilityAsset(uid, head.id, { value: '另一用途', actor: 'user', reason: 'synthetic selected-version edit' });
  const restored = await assets.rollbackAbilityAsset(uid, head.id, updated.version, { actor: 'user', reason: 'synthetic rollback' });
  expect(restored.value).toBe(updated.value);
  const legacy = await assets.rollbackAbilityAsset(uid, head.id, '1', { actor: 'user', reason: 'synthetic legacy rollback' });
  expect(legacy.value).toBeUndefined();
  await assets.updateAbilityAsset(uid, head.id, { value: updated.value, actor: 'user', reason: 'synthetic restore' });
  const cleared = await assets.updateAbilityAsset(uid, head.id, { value: '', actor: 'user', reason: 'synthetic clear' });
  expect(cleared.value).toBeUndefined();
  expect((await assets.readAbilityAssetVersionSnapshot(uid, head.id, cleared.version))?.value).toBeUndefined();
  await expect(assets.updateAbilityAsset(uid, head.id, { value: 'x'.repeat(4001), actor: 'user', reason: 'synthetic invalid' })).rejects.toThrow('invalid ability asset value');
  await assets.updateAbilityAsset(uid, head.id, { value: updated.value, actor: 'user', reason: 'synthetic purge setup' });
  const purged = await assets.purgeAbilityAsset(uid, head.id, { actor: 'user', reason: 'synthetic purge' });
  expect(purged.value).toBeUndefined();
});
