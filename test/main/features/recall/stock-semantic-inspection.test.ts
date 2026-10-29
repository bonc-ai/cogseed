import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

const model = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: model }));
const user = 'stock-semantic-user';
const statements: Record<string, string> = {
  'stock-a': '常规发布之前必须复核回滚方案。',
  'stock-b': '发布之前可以不复核回滚方案。',
};
let root: string, previous: string | undefined;

beforeEach(async () => {
  vi.resetModules(); model.mockReset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-semantic-inspection-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  const bridge = await import('../../../../src/main/features/cognition_bridge');
  await bridge.replaceCognitionSources(user, { mode: 'unified', revision: 1,
    records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false,
    migratedAt: new Date().toISOString() });
  const store = await import('../../../../src/main/features/recall/store');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  for (const [id, statement] of Object.entries(statements)) {
    const now = new Date().toISOString();
    const record = { schemaVersion: 1, ownerId: user, id, candidateId: `candidate-${id}`,
      reviewDecisionId: `review-${id}`, type: 'rule', title: '发布回滚检查', statement, origin: 'manual',
      evidenceRefs: [], scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified',
      maturity: 'bud', version: '1', createdAt: now, updatedAt: now } as any;
    await store.writeRecallJsonRecord(user, 'ability-assets', id, record);
    await assets.initializeAbilityAsset(user, record, { actor: 'user', reason: 'Synthetic manual fixture' });
  }
});
afterEach(async () => {
  await drainMainRuntimeForTest(user);
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

async function run() {
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const stock = await import('../../../../src/main/features/recall/stock-organization');
  return stock.runStockOrganization(user, await settings.readRecallCaptureSettings(user),
    new AbortController().signal, async () => {}, async () => true);
}
function respond(mode: 'valid' | 'invented' | 'changed') {
  let changed = false;
  model.mockImplementation(async (_user: string, input: any) => {
    expect(input.budget.stage).toBe('extraction');
    const source = JSON.parse(input.message);
    const primary = source.primary.cognition;
    const peer = source.related.find((row: any) => row.cognition?.id !== primary.id)?.cognition;
    const reviewIssues = primary.id === 'stock-a' && peer ? [{
      assetIds: [primary.id, peer.id], reason: '是否仅适用于紧急发布尚不明确。',
      evidence: [{ assetId: primary.id, quote: primary.statement },
        { assetId: peer.id, quote: mode === 'invented' ? '并不存在的正文' : peer.statement }],
    }] : [];
    if (mode === 'changed' && reviewIssues.length && !changed) {
      changed = true;
      const store = await import('../../../../src/main/features/recall/store');
      await store.updateRecallJsonRecord(user, 'ability-assets', peer.id, row => ({ ...row!,
        version: '2', activeVersion: '2', statement: '发布前应依据变更单检查。', updatedAt: new Date(Date.now() + 1000).toISOString() }));
    }
    return { result: { text: JSON.stringify({ outcome: 'no_change', reason: '原文保留。', reviewIssues }), meta: {} } };
  });
}

describe('旧内容语义核对', () => {
  it('复用整理调用，保存可追溯的两条内容供人工核对', async () => {
    respond('valid');
    const result = await run();
    expect(result).toMatchObject({ checked: 2, failed: 0, proposed: 0 });
    expect(model).toHaveBeenCalledTimes(2);
    const inspection = await import('../../../../src/main/features/recall/asset-inspection-service');
    const report = await inspection.runAssetInspection(user);
    const issue = report.findings.find(finding => finding.method === 'semantic');
    expect(issue).toMatchObject({ category: 'conflict', assetIds: ['stock-a', 'stock-b'],
      assetVersions: { 'stock-a': '1', 'stock-b': '1' } });
    expect(issue?.detail).toContain('时间、场景和例外');
    expect(JSON.stringify(report)).not.toContain('是否仅适用于紧急发布尚不明确');
    expect(JSON.stringify(report)).not.toContain(statements['stock-a']);
    expect(JSON.stringify(report)).not.toContain(statements['stock-b']);
    expect(report.currentFindingKeys).toContain(issue?.key);
    expect((await (await import('../../../../src/main/features/recall/asset-service')).listAbilityAssets(user))
      .map(asset => asset.status)).toEqual(['active', 'active']);
  });

  it('重新比较两条当前内容后无疑问，收口旧关系', async () => {
    const inspection = await import('../../../../src/main/features/recall/asset-inspection-service');
    const compared = ['stock-a', 'stock-b'];
    await inspection.recordSemanticInspectionFindings(user, 'stock-a', compared,
      [{ assetVersions: { 'stock-a': '1', 'stock-b': '1' } }], async () => {});
    expect((await inspection.runAssetInspection(user)).findings.some(finding => finding.method === 'semantic')).toBe(true);
    await inspection.recordSemanticInspectionFindings(user, 'stock-a', compared, [], async () => {});
    expect((await inspection.runAssetInspection(user)).findings.some(finding => finding.method === 'semantic')).toBe(false);
  });

  it('模型编造原文时不保存关系，返回失败', async () => {
    respond('invented');
    expect(await run()).toMatchObject({ failed: 1 });
    const inspection = await import('../../../../src/main/features/recall/asset-inspection-service');
    expect((await inspection.runAssetInspection(user)).findings.some(finding => finding.method === 'semantic')).toBe(false);
  });

  it('模型等待期间内容变化时不保存旧关系', async () => {
    respond('changed');
    expect((await run()).failed).toBeGreaterThan(0);
    const inspection = await import('../../../../src/main/features/recall/asset-inspection-service');
    expect((await inspection.runAssetInspection(user)).findings.some(finding => finding.method === 'semantic')).toBe(false);
  });
});
