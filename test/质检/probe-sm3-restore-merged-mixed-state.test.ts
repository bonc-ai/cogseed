import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 恢复已归并源时的 active 状态、归并去向及再次归并一致性。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-sm3b';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-sm3b-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadAssets() {
  return import('../../src/main/features/recall/asset-service');
}

async function mkAsset(id: string) {
  const assets = await loadAssets();
  const now = new Date().toISOString();
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const ACT = { actor: 'user' as const, reason: 'probe' };

describe('restore 已归并 source：解除关联而不是留下混合态', () => {
  it('归并后恢复源：active 且归并去向被清除，同对条目可再次归并（历史留台账）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-msrc1');
    await mkAsset('aa-mtgt1');
    await assets.mergeAbilityAssets(UID, 'aa-msrc1', 'aa-mtgt1', ACT);
    const mergedSource = await assets.readAbilityAsset(UID, 'aa-msrc1');
    expect(mergedSource.status).toBe('archived');
    expect(mergedSource.mergedIntoAssetId).toBe('aa-mtgt1');

    // restore 解除归并去向：不再出现「active 却声称已并入他处」的混合态。
    const restored = await assets.restoreAbilityAsset(UID, 'aa-msrc1', ACT);
    expect(restored.status).toBe('active');
    expect(restored.mergedIntoAssetId).toBeUndefined();

    // 去重通道恢复：同对条目可再次归并。
    await expect(
      assets.mergeAbilityAssets(UID, 'aa-msrc1', 'aa-mtgt1', ACT),
    ).resolves.toBeTruthy();
    const remergedSource = await assets.readAbilityAsset(UID, 'aa-msrc1');
    expect(remergedSource.status).toBe('archived');
    expect(remergedSource.mergedIntoAssetId).toBe('aa-mtgt1');

    // 两次归并的去向都留在台账里：解除的是记录上的活体指向，不是历史。
    const audit = await assets.listAbilityAssetAudit(UID, 'aa-msrc1');
    expect(audit.filter((row) => row.action === 'merged_into').length).toBe(2);
  });

  it('对照组：普通（非归并）archived 资产 restore 后可正常归并（通道在）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-msrc2');
    await mkAsset('aa-mtgt2');
    await assets.archiveAbilityAsset(UID, 'aa-msrc2', ACT);
    const restored = await assets.restoreAbilityAsset(UID, 'aa-msrc2', ACT);
    expect(restored.status).toBe('active');
    expect(restored.mergedIntoAssetId).toBeUndefined();
    await expect(
      assets.mergeAbilityAssets(UID, 'aa-msrc2', 'aa-mtgt2', ACT),
    ).resolves.toBeTruthy();
  });
});
