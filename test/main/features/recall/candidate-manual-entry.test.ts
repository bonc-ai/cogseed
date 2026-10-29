import { seedStoredAbilityAsset } from '../../../helpers/stored-ability-asset';
/** Manual creation is retired; historical manual data remains readable. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-candidate-manual-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, capabilities] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/candidate-capabilities'),
  ]);
  return { candidates, assets, capabilities };
}

describe('手工候选新建入口退役，历史内容保留', () => {
  it.each([true, false])('无夜间凭据的新建拒绝（manual=%s）', async manual => {
    const { candidates, assets } = await modules();
    await expect(candidates.saveRecallCandidate('user-manual-save', {
      judgment: '发布会前必须过一遍演示清单。', summary: '发布前核对', suggestedType: 'rule',
      suggestedScope: 'product', suggestedAction: 'create', sourceRefs: [], manual,
    })).rejects.toThrow(manual ? 'retired candidate producer cannot create a nightly suggestion' : /nightly capture formation evidence/);
    expect(await candidates.listRecallCandidates('user-manual-save')).toEqual([]);
    expect(await assets.listAbilityAssets('user-manual-save')).toEqual([]);
  });

  it('历史人工资产的空证据和origin仍读回；不借历史数据重新形成', async () => {
    const uid = 'user-manual-history';
    const { candidates, assets } = await modules();
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    const now = '2026-09-28T00:00:00.000Z';
    const historical = { schemaVersion: 1, taxonomyVersion: 2, contentFormatVersion: 1, ownerId: uid,
      id: 'manual-history', judgment: '对外汇报一律结论先行。', summary: '结论先行', value: '减少读者核对成本',
      suggestedType: 'rule', suggestedScope: 'report', suggestedAction: 'create', status: 'pending_review', origin: 'manual',
      sourceRefs: [], evidenceRefs: [], createdAt: now, updatedAt: now };
    await writeRecallJsonRecord(uid, 'candidates', historical.id, historical);
    expect(await candidates.readRecallCandidate(uid, historical.id)).toMatchObject({ origin: 'manual', sourceRefs: [] });
    await expect(candidates.promoteRecallCandidate(uid, historical.id, { actor: 'user' })).rejects.toThrow(/nightly capture formation evidence/);
    const asset = await seedStoredAbilityAsset(uid, { schemaVersion: 1, taxonomyVersion: 2, ownerId: uid,
      id: 'manual-history-asset', candidateId: 'old-confirmed-manual', title: '结论先行', statement: historical.judgment,
      type: 'rule', scope: 'report', status: 'active', version: '1', activeVersion: '1', origin: 'manual',
      evidenceRefs: [], lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', createdAt: now, updatedAt: now } as never);
    expect((await assets.listAbilityAssets(uid)).find(row => row.id === asset.id)).toMatchObject({ evidenceRefs: [], origin: 'manual' });
  });
});
