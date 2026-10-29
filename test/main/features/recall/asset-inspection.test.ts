import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
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
  const candidate = await createNightlyCandidateFixture(uid, {
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
    ...base, id, candidateId: `cand-${id}`, version: '1', activeVersion: '1',
    evidenceRefs: [], sourceCandidateIds: [], sourceSessionIds: [], origin: 'manual', ...overrides,
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
    expect(entry.detail).toContain('建议复核');

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

describe('旧开关与夜间并入（T049 迁移口径）', () => {
  it('旧开关默认关；只作为迁移和整理报告来源，不再决定巡检是否运行', async () => {
    const uid = 'user-inspect-switch';
    const { inspection, store } = await modules();
    await seedAsset(uid, '开关测试的基线资产。');
    expect((await inspection.readInspectionSettings(uid)).enabled).toBe(false);

    // 历史记录缺 enabled 字段仍视为关。
    await store.writeRecallJsonRecord(uid, 'inspection-settings', 'settings', {
      schemaVersion: 1, ownerId: uid, id: 'settings', updatedAt: new Date().toISOString(),
    } as never);
    expect((await inspection.readInspectionSettings(uid)).enabled).toBe(false);

    // The nightly sweep calls runAssetInspection directly; the retired switch
    // no longer gates whether inspection runs.
    const nightly = await inspection.runAssetInspection(uid, { trigger: 'nightly' });
    expect(nightly.trigger).toBe('nightly');
    expect(nightly.evaluatedAssetIds?.length).toBeGreaterThan(0);

    await inspection.setInspectionEnabled(uid, true);
    const enabled = await inspection.readInspectionSettings(uid);
    expect(enabled.enabled).toBe(true);
    // 手动触发与开关无关（那是用户自己要的）。
    const manual = await inspection.runAssetInspection(uid, { trigger: 'manual' });
    expect(manual.trigger).toBe('manual');
  });

  it('夜间巡检跳过已认领资产，其余照常评估', async () => {
    const uid = 'user-inspect-claims';
    const { inspection } = await modules();
    const claimed = await seedAsset(uid, '本轮已由新对话更新的资产。');
    const remaining = await seedAsset(uid, '本轮仍需巡检的资产。');
    const run = await inspection.runAssetInspection(uid, {
      trigger: 'nightly', excludeAssetIds: new Set([claimed.id]),
    });
    expect(run.evaluatedAssetIds).not.toContain(claimed.id);
    expect(run.evaluatedAssetIds).toContain(remaining.id);
    expect(run.skippedAssetIds).toEqual([claimed.id]);
    expect(run.findings.some((finding) => finding.assetIds.includes(claimed.id))).toBe(false);
  });

  it('因认领没复查的旧发现保留，复查过且消失的才收口', async () => {
    const uid = 'user-inspect-retain';
    const { inspection } = await modules();
    const { dup } = await seedMessyLibrary(uid);
    const first = await inspection.runAssetInspection(uid, { trigger: 'nightly' });
    expect(first.findings.some((finding) => finding.category === 'duplicate')).toBe(true);
    const second = await inspection.runAssetInspection(uid, {
      trigger: 'nightly', excludeAssetIds: new Set([dup.id]),
    });
    const pending = inspection.pendingInspectionFindings([second, first]);
    expect(pending.some((finding) => finding.key.startsWith('duplicate:'))).toBe(true);
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

describe('分批巡检与续做', () => {
  it('每个目标与全部资产比较，后续批次保留早先发现', async () => {
    const uid = 'user-inspect-batches';
    const { inspection } = await modules();
    const base = await seedAsset(uid, '独立主题需要保存适用条件。');
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'a0-batch-0001', {
      statement: '上线之前必须核对回滚方案与灰度范围。',
    });
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'zz-batch-0001', {
      statement: '上线之前必须核对回滚方案与灰度。',
    });
    const first = await inspection.runAssetInspection(uid, { trigger: 'manual', batchSize: 1 });
    const duplicate = first.findings.find(finding => finding.category === 'duplicate')!;
    expect(duplicate.assetIds.sort()).toEqual(['a0-batch-0001', 'zz-batch-0001']);
    expect(first.currentFindingKeys).toContain(duplicate.key);
    expect(first.coverage).toEqual({ total: 3, evaluated: 1, remaining: 2 });
    expect(first.coveredAssetIds).toEqual(['a0-batch-0001']);
    const second = await inspection.runAssetInspection(uid, { trigger: 'manual', batchSize: 1 });
    expect(second.coverage).toEqual({ total: 3, evaluated: 2, remaining: 1 });
    expect(second.coveredAssetIds).toEqual(['a0-batch-0001', base.id]);
    expect(second.evaluatedAssetIds).toEqual([base.id]);
    expect(second.findings.some(finding => finding.key === duplicate.key)).toBe(true);
    const third = await inspection.runAssetInspection(uid, { trigger: 'manual', batchSize: 1 });
    expect(third.coverage).toEqual({ total: 3, evaluated: 3, remaining: 0 });
    expect(third.coveredAssetIds).toEqual(['a0-batch-0001', base.id, 'zz-batch-0001']);
  });

  it('已检查内容发生变化后重新检查，不继续显示已消失的相似发现', async () => {
    const uid = 'user-inspect-changed';
    const { inspection, store } = await modules();
    const base = await seedAsset(uid, '独立主题需要保存适用条件。');
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'a0-change-0001', {
      statement: '上线之前必须核对回滚方案与灰度范围。',
    });
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'zz-change-0001', {
      statement: '上线之前必须核对回滚方案与灰度。',
    });
    const first = await inspection.runAssetInspection(uid, { batchSize: 1 });
    const duplicate = first.findings.find(finding => finding.category === 'duplicate')!;
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'a0-change-0001', raw => ({
      ...raw!, statement: '年度预算由财务负责人审批。', version: '2', activeVersion: '2',
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    }));
    const second = await inspection.runAssetInspection(uid, { batchSize: 1 });
    expect(second.evaluatedAssetIds).toEqual(['a0-change-0001']);
    expect(second.findings.some(finding => finding.key === duplicate.key)).toBe(false);
    expect(second.coverage?.remaining).toBe(2);
  });

  it('超过 20 个批次后仍保留尚未复查的旧发现', async () => {
    const uid = 'user-inspect-many-batches';
    const { inspection } = await modules();
    const base = await seedAsset(uid, '独立主题需要保存适用条件。');
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'a0-long-0001', {
      statement: '上线之前必须核对回滚方案与灰度范围。',
    });
    for (let index = 0; index < 22; index++) {
      await cloneAsset(uid, base as unknown as Record<string, unknown>, `b${String(index).padStart(2, '0')}-long-0001`, {
        statement: `样本 ${index} 的独立讨论。`,
      });
    }
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'zz-long-0001', {
      statement: '上线之前必须核对回滚方案与灰度。',
    });
    const first = await inspection.runAssetInspection(uid, { batchSize: 1 });
    const duplicate = first.findings.find(finding => finding.key.includes('a0-long-0001') && finding.key.includes('zz-long-0001'))!;
    expect(duplicate).toBeDefined();
    let latest = first;
    for (let index = 0; index < 21; index++) latest = await inspection.runAssetInspection(uid, { batchSize: 1 });
    expect(latest.coverage?.remaining).toBeGreaterThan(0);
    expect(latest.findings.some(finding => finding.key === duplicate.key)).toBe(true);
    expect(inspection.pendingInspectionFindings(await inspection.listInspectionRuns(uid, 1))
      .some(finding => finding.key === duplicate.key)).toBe(true);
  });

  it('受限资产计入未检查，不进入发现正文', async () => {
    const uid = 'user-inspect-inaccessible';
    const { inspection } = await modules();
    const base = await seedAsset(uid, '公开的参考内容。');
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'restricted-asset-01', {
      statement: '不应透露的受限内容。', scopePolicy: { projectIds: ['another-project'] },
    });
    const run = await inspection.runAssetInspection(uid);
    expect(run.coverage).toMatchObject({ total: 2, evaluated: 1, remaining: 1, unavailable: 1 });
    expect(JSON.stringify(run)).not.toContain('不应透露的受限内容');
    expect(run.evaluatedAssetIds).not.toContain('restricted-asset-01');
    expect(run.coveredAssetIds).toEqual([base.id]);
  });

  it('比较后资产发生变化时不保存旧发现，也不推进检查进度', async () => {
    const uid = 'user-inspect-stale-baseline';
    const { inspection, store } = await modules();
    const base = await seedAsset(uid, '独立主题需要保存适用条件。');
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'a0-race-0001', {
      statement: '上线之前必须核对回滚方案与灰度范围。',
    });
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'zz-race-0001', {
      statement: '上线之前必须核对回滚方案与灰度。',
    });
    await inspection.runAssetInspection(uid, { batchSize: 1 });
    const before = await store.readRecallJsonRecord(uid, 'inspection-progress', 'coverage');
    const runsBefore = await inspection.listInspectionRuns(uid);
    const loader = await import('../../../../src/main/features/recall/capture-existing-assets');
    const load = loader.loadCaptureExistingAssetPool;
    const gate = vi.spyOn(loader, 'loadCaptureExistingAssetPool').mockImplementationOnce(async (...args) => {
      const snapshot = await load(...args);
      await store.updateRecallJsonRecord(uid, 'ability-assets', 'zz-race-0001', raw => ({
        ...raw!, version: '2', activeVersion: '2', statement: '年度预算由负责人审批。',
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      }));
      return snapshot;
    });
    try {
      await expect(inspection.runAssetInspection(uid, { batchSize: 1 })).rejects.toMatchObject({ code: 'inspection_baseline_stale' });
      expect(await store.readRecallJsonRecord(uid, 'inspection-progress', 'coverage')).toEqual(before);
      expect((await inspection.listInspectionRuns(uid)).map(run => run.id)).toEqual(runsBefore.map(run => run.id));
    } finally { gate.mockRestore(); }
    await inspection.runAssetInspection(uid, { batchSize: 1 });
    const retry = await inspection.runAssetInspection(uid, { batchSize: 1 });
    expect(retry.findings.some(finding => finding.key.includes('a0-race-0001') && finding.key.includes('zz-race-0001'))).toBe(false);
  });

  it('被跳过的目标保留旧发现，不将其当作已经复查', async () => {
    const uid = 'user-inspect-skip-coverage';
    const { inspection, store } = await modules();
    const base = await seedAsset(uid, '独立主题需要保存适用条件。');
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'a0-skip-0001', {
      statement: '上线之前必须核对回滚方案与灰度范围。',
    });
    await cloneAsset(uid, base as unknown as Record<string, unknown>, 'zz-skip-0001', {
      statement: '上线之前必须核对回滚方案与灰度。',
    });
    const first = await inspection.runAssetInspection(uid, { batchSize: 1 });
    expect(first.coverage).toEqual({ total: 3, evaluated: 1, remaining: 2 });
    expect(first.evaluatedAssetIds).toEqual(['a0-skip-0001']);
    const duplicate = first.findings.find(finding => finding.category === 'duplicate');
    expect(duplicate).toBeDefined();
    if (!duplicate) throw new Error('missing expected duplicate');
    const saved = await store.readRecallJsonRecord(uid, 'inspection-progress', 'coverage');
    expect((saved?.findings as Array<{ key: string }>).map(finding => finding.key)).toContain(duplicate.key);
    const next = await inspection.runAssetInspection(uid, { batchSize: 1, excludeAssetIds: new Set(['zz-skip-0001']) });
    expect(next.evaluatedAssetIds).not.toContain('a0-skip-0001');
    expect(next.findings.map(finding => finding.key)).toContain(duplicate.key);
    expect(next.coverage?.remaining).toBeGreaterThan(0);
  });
});

describe('并发处置不丢更新（round-2）', () => {
  // fileEditLock 按 recordPath 串行化写，但处置语义必须建在锁内最新值上：
  // 锁外预读快照再整组写，会让并发写互相抹掉——已「不管它」的待办复活回清单。

  it('两个并发 dismiss 互不抹掉：两条「不管它」都留得住', async () => {
    const uid = 'user-inspect-race-decide';
    const { inspection } = await modules();
    await Promise.all([
      inspection.decideInspectionFinding(uid, 'outdated:aa-race-1', 'dismissed'),
      inspection.decideInspectionFinding(uid, 'outdated:aa-race-2', 'dismissed'),
    ]);
    const settings = await inspection.readInspectionSettings(uid);
    expect([...settings.dismissedFindingKeys].sort())
      .toEqual(['outdated:aa-race-1', 'outdated:aa-race-2']);
  });

  it('开关切换与待办处置并发：已「不管它」的键不被清空', async () => {
    const uid = 'user-inspect-race-switch';
    const { inspection } = await modules();
    await Promise.all([
      inspection.decideInspectionFinding(uid, 'outdated:aa-race-3', 'dismissed'),
      inspection.setInspectionEnabled(uid, true),
    ]);
    const settings = await inspection.readInspectionSettings(uid);
    expect(settings.enabled).toBe(true);
    expect(settings.dismissedFindingKeys).toContain('outdated:aa-race-3');
  });
});

describe('处置参数校验（round-3）', () => {
  // 入口 throw 先例与 readInspectionRun 同款：非法入参宁可炸出来，也不静默
  // 走反向 filter 把已「不管它」的待办复活、或把任意超长 key 落盘。

  it('非法 decision 拒绝且不清掉已有处置（拼写错不再静默复活待办）', async () => {
    const uid = 'user-inspect-guard-decision';
    const { inspection } = await modules();
    const key = 'outdated:aa-guard-1';
    await inspection.decideInspectionFinding(uid, key, 'dismissed');

    // 修前：'dismiss' 不在两个字面量里，双三元双双走反向 filter——key 从两数组
    // 同时移除、待办复活，还不报任何错。
    await expect(inspection.decideInspectionFinding(uid, key, 'dismiss' as never))
      .rejects.toThrow(/invalid inspection decision/);
    const settings = await inspection.readInspectionSettings(uid);
    expect(settings.dismissedFindingKeys).toContain(key);
  });

  it('findingKey 空串与超长（>1024）都拒绝，不落盘', async () => {
    const uid = 'user-inspect-guard-key';
    const { inspection } = await modules();
    await expect(inspection.decideInspectionFinding(uid, '', 'dismissed'))
      .rejects.toThrow(/invalid inspection finding key/);
    await expect(inspection.decideInspectionFinding(uid, 'k'.repeat(1025), 'dismissed'))
      .rejects.toThrow(/invalid inspection finding key/);
    const settings = await inspection.readInspectionSettings(uid);
    expect(settings.dismissedFindingKeys).toEqual([]);
    expect(settings.deferredFindingKeys).toEqual([]);
  });
});
