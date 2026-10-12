/**
 * 后台巡检（specs/008 US-405 / T047–T050）。
 *
 * 守四条：
 *   ① **只报不改**——跑完巡检后资产的内容 / 版本 / 状态 / 更新时间分毫不动，
 *      台账也零新增（巡检不是写操作）；
 *   ② 发现进既有待办通道、**保持待确认**（处置的是"要不要继续提醒"，不是"这条资产怎么办"）；
 *   ③ 开关关掉后**不再自动运行**（手动触发仍可用）；
 *   ④ **跨轮不重复报**：同一条问题在两轮里是同一个 key、同一个待办 id；
 *      用户标了"不管它"之后，后续各轮都不再报。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-inspection-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, inspection, store, inbox, adapter] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/asset-inspection-service'),
    import('../../../../src/main/features/recall/store'),
    import('../../../../src/main/features/recall/formal-assets/inbox'),
    import('../../../../src/main/features/cognition/inbox-adapter'),
  ]);
  return { candidates, assets, inspection, store, inbox, adapter };
}

let seedSeq = 0;
async function seedAsset(uid: string, judgment: string) {
  const { candidates } = await modules();
  seedSeq += 1;
  const candidate = await candidates.saveRecallCandidate(uid, {
    judgment,
    // 标题闸门（设计 3.2）：无 summary 兜底＝正文首句，过不了闸门。
    summary: '巡检基线样本',
    suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
    sourceRefs: [{ kind: 'execution', id: `exec-inspect-${seedSeq}` }],
  });
  return (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
}

async function cloneAsset(uid: string, base: Record<string, unknown>, id: string, overrides: Record<string, unknown> = {}) {
  const { store } = await modules();
  await store.writeRecallJsonRecord(uid, 'ability-assets', id, {
    ...base, id, candidateId: `cand-${id}`, version: '1', activeVersion: '1', ...overrides,
  });
}

/** 造出三类发现各一条：疑似重复、过时、同句不同类型（冲突）。 */
async function seedMessyLibrary(uid: string) {
  const { store } = await modules();
  const dup = await seedAsset(uid, '发布前必须核对回滚方案与灰度范围。');
  await cloneAsset(uid, dup as unknown as Record<string, unknown>, 'aa-dup10001', {
    statement: '发布前必须核对回滚方案与灰度。', title: '很像的一条',
  });
  const stale = await seedAsset(uid, '季度评审要提前两周约时间。');
  await store.updateRecallJsonRecord(uid, 'ability-assets', stale.id, (raw) => ({
    ...raw!, updatedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
  }));
  const conflictSource = await seedAsset(uid, '变更公告要写清生效时间与影响范围。');
  await cloneAsset(uid, conflictSource as unknown as Record<string, unknown>, 'aa-conf10001', {
    statement: conflictSource.statement, type: 'template', title: '同句不同类型',
  });
  return { dup, stale, conflictSource };
}

describe('只报不改（T048）', () => {
  it('跑完巡检：资产内容/版本/状态/更新时间分毫不动，台账零新增', async () => {
    const uid = 'user-inspect-readonly';
    const { assets, inspection } = await modules();
    await seedMessyLibrary(uid);
    const before = (await assets.listAbilityAssets(uid)).map((asset) => ({
      id: asset.id, title: asset.title, statement: asset.statement, type: asset.type,
      status: asset.status, version: asset.version, updatedAt: asset.updatedAt,
      mergedIntoAssetId: asset.mergedIntoAssetId,
    }));
    const auditBefore = await Promise.all(before.map((asset) => assets.listAbilityAssetAudit(uid, asset.id)));

    const run = await inspection.runAssetInspection(uid, { trigger: 'manual' });
    expect(run.findings.length).toBeGreaterThan(0);

    const after = (await assets.listAbilityAssets(uid)).map((asset) => ({
      id: asset.id, title: asset.title, statement: asset.statement, type: asset.type,
      status: asset.status, version: asset.version, updatedAt: asset.updatedAt,
      mergedIntoAssetId: asset.mergedIntoAssetId,
    }));
    // 逐字段比对：巡检一个字节都不许改（这就是"只报不改"）。
    expect(after).toEqual(before);
    const auditAfter = await Promise.all(before.map((asset) => assets.listAbilityAssetAudit(uid, asset.id)));
    expect(auditAfter.map((rows) => rows.length)).toEqual(auditBefore.map((rows) => rows.length));
  });

  it('三类发现都报得出来：疑似重复 / 过时 / 冲突', async () => {
    const uid = 'user-inspect-findings';
    const { inspection } = await modules();
    await seedMessyLibrary(uid);
    const run = await inspection.runAssetInspection(uid, { trigger: 'manual' });
    const categories = new Set(run.findings.map((finding) => finding.category));
    expect(categories).toContain('duplicate');
    expect(categories).toContain('outdated');
    expect(categories).toContain('conflict');
    // 发现都带稳定的 key 与可读说明。
    for (const finding of run.findings) {
      expect(finding.key).toMatch(/^(duplicate|outdated|conflict):/);
      expect(finding.detail.length).toBeGreaterThan(0);
      expect(finding.assetIds.length).toBeGreaterThan(0);
    }
  });

  it('「缺分级」不在这里报：既有待办已经覆盖，再报就是同一件事两条待办', async () => {
    const uid = 'user-inspect-no-unclassified';
    const { inspection } = await modules();
    await seedAsset(uid, '未分级的资产不该被巡检重复报一次。');
    const run = await inspection.runAssetInspection(uid, { trigger: 'manual' });
    // 类别只有三类，且没有"缺分级"这一类（口径见服务头注释）。
    expect(new Set(run.findings.map((finding) => finding.category)))
      .toEqual(new Set(['duplicate', 'outdated', 'conflict'].filter((category) => run.findings.some((finding) => finding.category === category))));
  });
});

describe('建议保持待确认（T048 / T050）', () => {
  it('发现进既有待办通道，可处置；没有可执行动作（巡检不改资产）', async () => {
    const uid = 'user-inspect-inbox';
    const { inspection, inbox, adapter } = await modules();
    await seedMessyLibrary(uid);
    const run = await inspection.runAssetInspection(uid, { trigger: 'manual' });
    const finding = run.findings.find((row) => row.category === 'outdated')!;

    const items = inbox.buildCognitionInbox({
      assets: [], candidates: [], unavailableSourceIds: new Set(),
      pendingInspectionFindings: [{ key: finding.key, category: finding.category, assetIds: finding.assetIds, title: finding.title, detail: finding.detail }],
    });
    const entry = items.find((row) => row.kind === 'inspection_finding')!;
    expect(entry.id).toBe(`inspection:${finding.key}`);
    expect(entry.urgency).toBe('low_disturbance');
    expect(entry.detail).toContain('过时');

    await expect(adapter.resolveCognitionInboxItem(uid, { id: entry.id, action: 'accept' }))
      .rejects.toThrow(/巡检不改资产/);
    const deferred = await adapter.resolveCognitionInboxItem(uid, { id: entry.id, action: 'defer' });
    expect(deferred).toMatchObject({ ok: true, target: 'inspection_finding', status: 'deferred' });
    // "回头再看"仍然报（没让用户失去线索），只是标了状态。
    const settingsAfterDefer = await inspection.readInspectionSettings(uid);
    expect(settingsAfterDefer.deferredFindingKeys).toContain(finding.key);
    expect(settingsAfterDefer.dismissedFindingKeys).toEqual([]);
  });
});

describe('开关（T049）', () => {
  it('默认关（四病整改 G2 / 拍板项 #5）；缺 enabled 字段的记录也视为关；打开后定时跑，关掉后不跑，手动触发仍可用', async () => {
    const uid = 'user-inspect-switch';
    const { inspection, store } = await modules();
    await seedAsset(uid, '开关测试的基线资产。');
    // 2026-09-28 G2 拍板项 #5：巡检默认关——未经用户开启不后台自跑。
    expect((await inspection.readInspectionSettings(uid)).enabled).toBe(false);
    const skippedByDefault = await inspection.runScheduledInspectionIfEnabled(uid);
    expect(skippedByDefault).toBeUndefined();

    // 容错方向同款：历史记录缺 enabled 字段视为关（不再是"缺字段视为开"）。
    await store.writeRecallJsonRecord(uid, 'inspection-settings', 'settings', {
      schemaVersion: 1, ownerId: uid, id: 'settings', updatedAt: new Date().toISOString(),
    } as never);
    expect((await inspection.readInspectionSettings(uid)).enabled).toBe(false);

    await inspection.setInspectionEnabled(uid, true);
    const first = await inspection.runScheduledInspectionIfEnabled(uid);
    expect(first).toBeTruthy();
    expect(first!.trigger).toBe('scheduled');

    await inspection.setInspectionEnabled(uid, false);
    const runsBefore = (await inspection.listInspectionRuns(uid)).length;
    const skipped = await inspection.runScheduledInspectionIfEnabled(uid);
    expect(skipped).toBeUndefined();
    expect((await inspection.listInspectionRuns(uid)).length).toBe(runsBefore);

    // 手动触发与开关无关（那是用户自己要的）。
    const manual = await inspection.runAssetInspection(uid, { trigger: 'manual' });
    expect(manual.trigger).toBe('manual');
  });
});

describe('跨轮不重复报（T050）', () => {
  it('连续两轮：同一问题的 key 与待办 id 都稳定，不产生第二条待办', async () => {
    const uid = 'user-inspect-dedupe';
    const { inspection, inbox } = await modules();
    await seedMessyLibrary(uid);
    const first = await inspection.runAssetInspection(uid, { trigger: 'manual' });
    const second = await inspection.runAssetInspection(uid, { trigger: 'manual' });

    expect(second.findings.map((finding) => finding.key).sort())
      .toEqual(first.findings.map((finding) => finding.key).sort());

    // 呈现只取**最新一轮**：同一问题在清单里只有一条。
    const items = inbox.buildCognitionInbox({
      assets: [], candidates: [], unavailableSourceIds: new Set(),
      pendingInspectionFindings: inspection.pendingInspectionFindings(await inspection.listInspectionRuns(uid, 1)),
    }).filter((row) => row.kind === 'inspection_finding');
    expect(items).toHaveLength(second.findings.length);
    expect(new Set(items.map((row) => row.id)).size).toBe(items.length);
  });

  it('标了「不管它」之后，后续各轮都不再报', async () => {
    const uid = 'user-inspect-dismiss';
    const { inspection, adapter, inbox } = await modules();
    await seedMessyLibrary(uid);
    const run = await inspection.runAssetInspection(uid, { trigger: 'manual' });
    const target = run.findings.find((row) => row.category === 'outdated')!;

    await adapter.resolveCognitionInboxItem(uid, { id: `inspection:${target.key}`, action: 'reject' });
    const next = await inspection.runAssetInspection(uid, { trigger: 'manual' });
    expect(next.findings.some((finding) => finding.key === target.key)).toBe(false);
    // 其余发现照常报（处置的是这一条，不是整轮）。
    expect(next.findings.length).toBeGreaterThan(0);

    const items = inbox.buildCognitionInbox({
      assets: [], candidates: [], unavailableSourceIds: new Set(),
      pendingInspectionFindings: inspection.pendingInspectionFindings(
        await inspection.listInspectionRuns(uid, 1),
        (await inspection.readInspectionSettings(uid)).dismissedFindingKeys,
        (await inspection.readInspectionSettings(uid)).deferredFindingKeys,
      ),
    }).filter((row) => row.kind === 'inspection_finding');
    expect(items.some((row) => row.id === `inspection:${target.key}`)).toBe(false);
  });
});
