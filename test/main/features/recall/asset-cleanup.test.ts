import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
/**
 * 大扫除与整理报告（specs/008 US-403 / T041–T046；标题重起轮＝四病整改设计 3.3）。
 *
 * 守五条：
 *   ① 报告与台账**一一对应**（每项都有 ledgerRef 与回滚锚点），逐项可单独回滚；
 *   ② 只做**不改变含义**的整理：近重复（正文不同）不自动合并，进 `uncertain[]` 且**不动它**；
 *   ③ 补标签已接线（specs/012 T025）：同源组多数标签机械传播直接写入，含义判断
 *      进 `uncertain[]`；`skippedSteps` 不再有"待 Epic 2 / 012"；
 *   ④ 中断/失败后：已执行项全部有台账、可逐项回滚，失败项如实记录，未执行项保持原状；
 *   ⑤ **标题重起轮（kind='title_regen'）＝含义生成，与 ② 分列**：只对统一口径
 *      （title-policy 3.1 判定）不合规的资产让 LLM 重新拟题，actor='ai' 走
 *      updateAbilityAsset 正门升版；模型不可用＝整轮失败上报（抛错、不落报告、
 *      不写任何资产，绝不静默跳过）；写前整库备份到 records/ 之外；不提供逐项
 *      回滚（拍板项 #7），报告项只留 before→after 与版本锚点。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };

// 只检查流程不应依赖模型；调用记录用于守住旧专项入口的退役边界。
const titleRegenModel = vi.hoisted(() => ({ configured: true, runCalls: [] as unknown[] }));
vi.mock('../../../../src/main/features/auth', () => ({
  hasConfiguredModelForUser: () => ({ configured: titleRegenModel.configured }),
  hasConfiguredModel: () => ({ configured: titleRegenModel.configured }),
  getConfiguredModelOAuthExpiredMessage: () => null,
}));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({
  buildRunner: vi.fn(async () => {
    titleRegenModel.runCalls.push('model');
    throw new Error('只检查维护不能调用模型');
  }),
}));

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cleanup-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  titleRegenModel.configured = true;
  titleRegenModel.runCalls = [];
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, cleanup, store] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/cleanup-report-service'),
    import('../../../../src/main/features/recall/store'),
  ]);
  return { candidates, assets, cleanup, store };
}

let seedSeq = 0;
async function seedAsset(uid: string, judgment: string, title?: string) {
  const { candidates, store } = await modules();
  seedSeq += 1;
  const candidate = await createNightlyCandidateFixture(uid, {
    judgment,
    // 标题闸门（设计 3.2）后晋升 title 必须合规：给一份与正文开头不同的合规
    // summary，不再吃「正文首句」兜底；需要"不规范标题"夹具的用例用第三个
    // 参数 raw 直写（闸门只拦收口写入，不拦测试布置的存量形态）。
    summary: `整理样本${seedSeq}`,
    suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
    sourceRefs: [{ kind: 'execution', id: `exec-cleanup-${seedSeq}` }],
  });
  const asset = (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
  if (title !== undefined) {
    await store.updateRecallJsonRecord(uid, 'ability-assets', asset.id, (raw) => ({ ...raw!, title }));
    return { ...asset, title, seededTitle: asset.title };
  }
  return { ...asset, seededTitle: asset.title };
}

/** 克隆一条合法记录（绕开相似度闸门，用于造"重复资产"这类本来就该存在的状态）。 */
async function cloneAsset(uid: string, base: Record<string, unknown>, id: string, overrides: Record<string, unknown> = {}) {
  const { store } = await modules();
  await store.writeRecallJsonRecord(uid, 'ability-assets', id, {
    ...base, id, candidateId: `cand-${id}`, version: '1', activeVersion: '1', ...overrides,
  });
}


describe('统一只检查维护契约', () => {
  it.each(['user', 'inspection'] as const)('%s 检查保留标题、正文、版本与台账，报告明确建议模式', async (trigger) => {
    const uid = 'check-identity';
    const { assets, cleanup } = await modules();
    const asset = await seedAsset(uid, '上线前必须核对回滚方案与灰度范围', '  旧标题。  ');
    const before = await assets.readAbilityAsset(uid, asset.id);
    const audit = await assets.listAbilityAssetAudit(uid, asset.id);
    const report = await cleanup.runAssetCleanup(uid, { trigger });
    expect(report).toMatchObject({ trigger, mode: 'report_only' });
    expect(report.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'title_normalized', status: 'uncertain' })]));
    expect(report.items.some(item => item.status === 'applied')).toBe(false);
    expect(await assets.readAbilityAsset(uid, asset.id)).toEqual(before);
    expect(await assets.listAbilityAssetAudit(uid, asset.id)).toEqual(audit);
  });

  it('相同正文也只建议归并，双方身份与权限范围不变', async () => {
    const uid = 'check-duplicate';
    const { assets, cleanup } = await modules();
    const first = await seedAsset(uid, '发布前必须核对回滚方案');
    await cloneAsset(uid, first, 'aa-dup0001', { scopePolicy: { projectIds: ['project-private'] } });
    const before = await assets.listAbilityAssets(uid);
    const report = await cleanup.runAssetFullCleanup(uid);
    expect(report.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'merged_duplicate', status: 'uncertain' })]));
    expect(report.uncertain).toHaveLength(1);
    expect(await assets.listAbilityAssets(uid)).toEqual(before);
    expect(titleRegenModel.runCalls).toEqual([]);
  });

  it('多数同源标签只建议，检查不传播元数据', async () => {
    const uid = 'check-tags';
    const { assets, cleanup, store } = await modules();
    const group = await Promise.all([
      seedAsset(uid, '发布前核对回滚方案'), seedAsset(uid, '报告保留生成日期'), seedAsset(uid, '会议结论标明负责人'),
    ]);
    for (const asset of group) await store.updateRecallJsonRecord(uid, 'ability-assets', asset.id, raw => ({ ...raw!, familyName: '发布纪律' }));
    for (const asset of group.slice(0, 2)) await assets.updateAbilityAsset(uid, asset.id, { tags: ['发布'], actor: 'user', reason: '夹具' });
    const before = await assets.readAbilityAsset(uid, group[2].id);
    const report = await cleanup.runAssetCleanup(uid);
    // 报告按既有隐私口径只落标签条数，不把用户手写的标签名复制进持久化报告。
    expect(report.items).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: group[2].id, kind: 'tag_added', status: 'uncertain', after: '标签 1 条' })]));
    expect(await assets.readAbilityAsset(uid, group[2].id)).toEqual(before);
  });

  it.each(['runAssetTitleRegenCleanup', 'runAssetStatementRegenCleanup', 'runCandidateStatementRegenCleanup', 'runAssetFullCleanup'] as const)('旧入口 %s 不再调用模型或写正文，未配置模型仍可检查', async (entry) => {
    const uid = 'check-legacy-entry';
    const { assets, cleanup, candidates } = await modules();
    const asset = await seedAsset(uid, '发布前必须核对回滚方案', '  旧标题。  ');
    // Preserve an explicitly historical manual draft; the retired producer remains closed.
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    const legacyId = 'legacy-manual-cleanup';
    const timestamp = new Date().toISOString();
    await writeRecallJsonRecord(uid, 'candidates', legacyId, {
      schemaVersion: 2, ownerId: uid, id: legacyId, contentFormatVersion: 1, taxonomyVersion: 2,
      judgment: '保留用户亲写内容', value: '', summary: '亲写样本', suggestedType: 'fact', suggestedScope: 'general',
      sourceRefs: [], evidenceRefs: [], origin: 'manual', suggestedAction: 'create', risk: 'low', status: 'pending_review',
      createdAt: timestamp, updatedAt: timestamp, expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const pending = await candidates.readRecallCandidate(uid, legacyId);
    const before = await assets.readAbilityAsset(uid, asset.id);
    titleRegenModel.configured = false;
    const report = await cleanup[entry](uid);
    expect(report.mode).toBe('report_only');
    expect(report.items.some(item => item.status === 'applied')).toBe(false);
    expect(titleRegenModel.runCalls).toEqual([]);
    expect(await assets.readAbilityAsset(uid, asset.id)).toEqual(before);
    expect(await candidates.readRecallCandidate(uid, pending.id)).toEqual(pending);
  });

  it('只扫描指定空间；建议处置仅改变报告而不修改资产', async () => {
    const uid = 'check-scope';
    const { assets, cleanup, store } = await modules();
    const selected = await seedAsset(uid, '发布前核对回滚方案', '  旧标题。  ');
    const other = await seedAsset(uid, '报告保留生成日期', '  其他标题。  ');
    await store.updateRecallJsonRecord(uid, 'ability-assets', selected.id, raw => ({ ...raw!, spaceId: 'space-selected' }));
    const before = await assets.listAbilityAssets(uid);
    const report = await cleanup.runAssetCleanup(uid, { scope: { spaceId: 'space-selected' } });
    expect(report.scanned).toBe(1);
    expect(report.items.every(item => item.assetId !== other.id)).toBe(true);
    await cleanup.decideCleanupUncertainItem(uid, report.id, selected.id, 'dismissed');
    expect(cleanup.pendingCleanupUncertainItems([ (await cleanup.readCleanupReport(uid, report.id))! ])).toEqual([]);
    expect(await assets.listAbilityAssets(uid)).toEqual(before);
  });

  it('旧已执行报告仍按原事实读回；新模式不重写历史执行或恢复锚点', async () => {
    const uid = 'check-history';
    const { cleanup, store } = await modules();
    const legacy = { schemaVersion: 1, ownerId: uid, id: 'cr-history', trigger: 'user', scope: {}, round: 'full', createdAt: '2026-09-29T00:00:00.000Z', scanned: 1, items: [{ assetId: 'aa-history', kind: 'title_normalized', status: 'applied', before: 'old', after: 'new', reason: '旧操作', rollbackAnchor: '1', ledgerRef: 'audit-history' }], uncertain: [], skippedSteps: [] };
    await store.writeRecallJsonRecord(uid, 'cleanup-reports', legacy.id, legacy);
    expect(await cleanup.readCleanupReport(uid, legacy.id)).toEqual(legacy);
    expect(await cleanup.listCleanupReports(uid)).toEqual([legacy]);
  });
});
