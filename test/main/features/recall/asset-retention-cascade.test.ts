/**
 * 保留期清理链（specs/008 T005/T006 · US-306 交付项，验收归 specs/010）。
 *
 * 口径：删除后 30 天内可恢复；保留期内可在「已删除」列表立即彻底删除；
 * 到期系统自动彻底删除（内容与记录一并清除、搜索不可见、不可恢复）。
 *
 * 这里守四条：
 *   ① 级联完整性 —— 正文记录 / 版本流 / 使用记录与回执 / 投影冻结副本，四类残留归零，
 *      **且只清本条**（兄弟资产的同类痕迹必须原样活着）；
 *   ② 到期边界 —— <30 天不删、≥30 天删；
 *   ③ 重复执行幂等 —— 第二轮无对象、不重复记账；
 *   ④ 彻底删除后 restore 拒绝；时间戳损坏的"已删除"不被自动清除（时间不明≠已到期）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };
const userAction = (reason: string) => ({ actor: 'user' as const, reason });

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-retention-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, store, usage, injections, receipts, retention, paths] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/store'),
    import('../../../../src/main/features/recall/usage-service'),
    import('../../../../src/main/features/recall/injection-receipt'),
    import('../../../../src/main/features/recall/asset-usage-receipt'),
    import('../../../../src/main/features/recall/asset-retention-service'),
    import('../../../../src/main/features/recall/paths'),
  ]);
  return { candidates, assets, store, usage, injections, receipts, retention, paths };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** 每条的判断文本必须彼此不同：晋升通道有相似度闸门（>0.9 视为重复候选），
 *  同一句话换个括号标记会被合理地拦下来。 */
const JUDGMENTS: Record<string, string> = {
  cascade: 'Keep decision records with evidence in the architecture review archive.',
  sibling: 'Escalate unresolved security findings to the on-call reviewer.',
  empty: 'Pin the toolchain version in every reproducible build.',
  restore: 'Name database migrations by their effect, not their number.',
  fresh: 'Rotate the staging credentials every quarter.',
  stale: 'Archive the completed migration checklist for reference.',
  idem: 'Label every exported report with its generation timestamp.',
  ambiguous: 'Summarize long meetings into three actionable bullets.',
  active: 'Verify the deployment rollback plan before each release.',
  archived: 'Prefer small pull requests over large ones.',
};

async function seedAsset(uid: string, marker: string) {
  const { candidates } = await modules();
  const judgment = JUDGMENTS[marker] || `Record the lesson behind ${marker} before shipping.`;
  const candidate = await candidates.saveRecallCandidate(uid, {
    judgment,
    // 标题闸门（设计 3.2）：无 summary 兜底＝正文首句，过不了闸门。
    summary: 'Cascade fixture lesson',
    suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
    sourceRefs: [{ kind: 'execution', id: `exec-${marker}` }],
  });
  return (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
}

/** 给一条资产铺满四类"含内容或可识别痕迹"的派生物，并返回它们的读取口。 */
async function seedReferences(uid: string, assetId: string, tag: string, version: string) {
  const { store, usage, injections, receipts } = await modules();
  await store.writeRecallJsonRecord(uid, 'projections', `proj-${tag}`, {
    schemaVersion: 2, ownerId: uid, id: `proj-${tag}`, taskRunId: `kst-${tag}`,
    purpose: 'review', authorization: 'workspace_policy',
    assetIds: [assetId], assetVersions: { [assetId]: version },
    sourceRefs: [], omittedRefs: [], status: 'confirmed', createdAt: new Date().toISOString(),
  });
  const injection = await injections.recordInjectionReceipt(uid, {
    taskRunId: `kst-${tag}`, projectionId: `proj-${tag}`, assetId, assetVersion: version,
    boundary: 'real', status: 'injected', channel: 'agent_read',
  });
  await receipts.recordAssetUsageReceipt(uid, {
    taskRunId: `kst-${tag}`, projectionId: `proj-${tag}`, assetId, assetVersion: version,
    injectionReceiptId: injection.id, status: 'usage_unknown', evidenceKind: 'none', boundary: 'real',
  });
  await usage.recordRecallUsage(uid, {
    assetId, assetVersion: version, taskRunId: `kst-${tag}`, boundary: 'real', outcome: 'agent_read',
  });
}

describe('彻底清除的级联完整性（四类残留归零，且不误伤兄弟资产）', () => {
  it('正文记录 / 版本流 / 使用记录与回执 / 投影冻结副本全部清空', async () => {
    const uid = 'user-cascade';
    const { assets, store, usage, injections, receipts } = await modules();
    const asset = await seedAsset(uid, 'cascade');
    // v2 用于被投影引用后真删——真删会把快照冻结进投影（内容副本），
    // 这正是"只清主记录与版本流"漏掉的那一类残留。
    await assets.updateAbilityAsset(uid, asset.id, { statement: 'v2 body', reason: 'v2', actor: 'user' });
    await assets.updateAbilityAsset(uid, asset.id, { statement: 'v3 body', reason: 'v3', actor: 'user' });
    await seedReferences(uid, asset.id, 'cascade', '2');
    await assets.deleteAbilityAssetVersion(uid, asset.id, '2', userAction('freeze the referenced version'));

    // 兄弟资产：同样铺满派生物，用来证明级联没有"一键清库"。
    const sibling = await seedAsset(uid, 'sibling');
    await seedReferences(uid, sibling.id, 'sibling', '1');

    const beforeProjection = await store.readRecallJsonRecord(uid, 'projections', 'proj-cascade');
    expect((beforeProjection as { assetVersionSnapshots?: Record<string, unknown> }).assetVersionSnapshots?.[asset.id])
      .toBeTruthy();

    await assets.deleteAbilityAsset(uid, asset.id, userAction('enter retention window'));
    await assets.purgeAbilityAsset(uid, asset.id, userAction('用户要求彻底清除'));

    // ① 正文记录：墓碑无内容。
    const tombstone = await assets.readAbilityAsset(uid, asset.id);
    expect(tombstone.status).toBe('purged');
    expect(tombstone.title).toBe('');
    expect(tombstone.statement).toBe('');
    // ② 版本流：整条流没了。
    expect(await assets.listAbilityAssetVersions(uid, asset.id)).toEqual([]);
    // ③ 使用记录与两类回执：按 assetId 归零。
    expect((await usage.listRecallUsage(uid)).filter((row) => row.assetId === asset.id)).toEqual([]);
    expect((await injections.listInjectionReceipts(uid)).filter((row) => row.assetId === asset.id)).toEqual([]);
    expect((await receipts.listAssetUsageReceipts(uid)).filter((row) => row.assetId === asset.id)).toEqual([]);
    // ④ 投影：冻结副本（正文）、版本指针、成员 id 一并摘除。
    const raw = await store.readRecallJsonRecord(uid, 'projections', 'proj-cascade') as {
      assetIds?: string[];
      assetVersions?: Record<string, string>;
      assetVersionSnapshots?: Record<string, unknown>;
    };
    expect(raw.assetVersionSnapshots?.[asset.id]).toBeUndefined();
    expect(raw.assetVersions?.[asset.id]).toBeUndefined();
    expect(raw.assetIds).toEqual([]);

    // 兄弟资产分毫未动。
    expect((await assets.readAbilityAsset(uid, sibling.id)).status).toBe('active');
    expect(await assets.listAbilityAssetVersions(uid, sibling.id)).not.toEqual([]);
    expect((await usage.listRecallUsage(uid)).filter((row) => row.assetId === sibling.id)).toHaveLength(1);
    expect((await injections.listInjectionReceipts(uid)).filter((row) => row.assetId === sibling.id)).toHaveLength(1);
    expect((await receipts.listAssetUsageReceipts(uid)).filter((row) => row.assetId === sibling.id)).toHaveLength(1);
    const siblingProjection = await store.readRecallJsonRecord(uid, 'projections', 'proj-sibling') as { assetIds?: string[] };
    expect(siblingProjection.assetIds).toEqual([sibling.id]);
  });

  it('从未产生过使用痕迹的资产也能被彻底清除（级联对空流可重入）', async () => {
    const uid = 'user-cascade-empty';
    const { assets } = await modules();
    const asset = await seedAsset(uid, 'empty');
    await assets.purgeAbilityAsset(uid, asset.id, userAction('直接彻底清除'));
    expect((await assets.readAbilityAsset(uid, asset.id)).status).toBe('purged');
  });

  it('彻底删除后 restore 被拒绝，且墓碑不携带正文与族名', async () => {
    const uid = 'user-cascade-restore';
    const { assets, store } = await modules();
    const asset = await seedAsset(uid, 'restore');
    await store.updateRecallJsonRecord(uid, 'ability-assets', asset.id, (raw) => ({ ...raw!, familyName: '用户取的大类名' }));
    await assets.purgeAbilityAsset(uid, asset.id, userAction('purge'));

    await expect(assets.restoreAbilityAsset(uid, asset.id, userAction('restore'))).rejects.toThrow(/purged/i);
    const tombstone = await assets.readAbilityAsset(uid, asset.id);
    expect(tombstone.familyName).toBeUndefined();
    expect(tombstone.purgedAt).toBeTruthy();
  });
});

describe('到期自动彻底删除', () => {
  it('保留期内不删、过期即删（30 天边界）', async () => {
    const uid = 'user-expiry';
    const { assets, store, retention } = await modules();
    const fresh = await seedAsset(uid, 'fresh');
    const stale = await seedAsset(uid, 'stale');
    await assets.deleteAbilityAsset(uid, fresh.id, userAction('delete'));
    await assets.deleteAbilityAsset(uid, stale.id, userAction('delete'));
    await store.updateRecallJsonRecord(uid, 'ability-assets', fresh.id, (raw) => ({ ...raw!, deletedAt: daysAgo(29) }));
    await store.updateRecallJsonRecord(uid, 'ability-assets', stale.id, (raw) => ({ ...raw!, deletedAt: daysAgo(31) }));

    const result = await retention.runAbilityAssetRetentionSweep(uid);
    expect(result.purged).toEqual([stale.id]);
    expect((await assets.readAbilityAsset(uid, fresh.id)).status).toBe('deleted');
    expect((await assets.readAbilityAsset(uid, stale.id)).status).toBe('purged');
    // 自动清除也必须能自证来由：台账里有 system actor + 到期依据。
    const audit = await assets.listAbilityAssetAudit(uid, stale.id);
    const purgeRow = audit.find((row) => row.action === 'purged')!;
    expect(purgeRow.actor).toBe('system');
    expect(String(purgeRow.reason)).toContain('保留期');
  });

  it('重复执行幂等：第二轮无对象、不重复记账', async () => {
    const uid = 'user-idempotent';
    const { assets, store, retention } = await modules();
    const asset = await seedAsset(uid, 'idem');
    await assets.deleteAbilityAsset(uid, asset.id, userAction('delete'));
    await store.updateRecallJsonRecord(uid, 'ability-assets', asset.id, (raw) => ({ ...raw!, deletedAt: daysAgo(40) }));

    expect((await retention.runAbilityAssetRetentionSweep(uid)).purged).toEqual([asset.id]);
    const second = await retention.runAbilityAssetRetentionSweep(uid);
    expect(second.purged).toEqual([]);
    expect(second.failed).toEqual([]);
    const purgeRows = (await assets.listAbilityAssetAudit(uid, asset.id)).filter((row) => row.action === 'purged');
    expect(purgeRows).toHaveLength(1);
  });

  it('时间戳缺失/损坏的"已删除"记录不被自动清除（时间不明 ≠ 已到期）', async () => {
    const uid = 'user-ambiguous';
    const { assets, store, retention } = await modules();
    const asset = await seedAsset(uid, 'ambiguous');
    await assets.deleteAbilityAsset(uid, asset.id, userAction('delete'));
    await store.updateRecallJsonRecord(uid, 'ability-assets', asset.id, (raw) => {
      const next = { ...raw! };
      delete next.deletedAt;
      return next;
    });

    const result = await retention.runAbilityAssetRetentionSweep(uid);
    expect(result.purged).toEqual([]);
    expect(result.ambiguous).toEqual([asset.id]);
    // 内容原样留着，等人工处置。
    expect((await assets.readAbilityAsset(uid, asset.id)).status).toBe('deleted');
    expect((await assets.listAbilityAssetVersions(uid, asset.id)).length).toBeGreaterThan(0);
  });

  it('已归档与在用资产不被扫描波及', async () => {
    const uid = 'user-untouched';
    const { assets, retention } = await modules();
    const active = await seedAsset(uid, 'active');
    const archived = await seedAsset(uid, 'archived');
    await assets.archiveAbilityAsset(uid, archived.id, userAction('archive'));

    const result = await retention.runAbilityAssetRetentionSweep(uid);
    expect(result.purged).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.scanned).toBe(2);
    expect((await assets.readAbilityAsset(uid, active.id)).status).toBe('active');
    expect((await assets.readAbilityAsset(uid, archived.id)).status).toBe('archived');
  });
});
