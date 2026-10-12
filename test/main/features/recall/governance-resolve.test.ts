/**
 * 治理待办就地处断（specs/010 T021 / T028 / T031 / T032）。
 *
 * 全部走**真实服务**（临时工作区），断言三件事：
 *   ① 处置真的落到了对象上（边界/候选状态/归档/合并）；
 *   ② 待办真的退场（同一读口再读不再出现；巡检发现**当轮即消失**）；
 *   ③ 拒绝路径不落库（版本与内容分毫未动，读盘比对）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-gov-resolve-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const UID = 'u-gov-resolve';
const BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };

async function modules() {
  const [adapter, candidates, assets, inspection, store] = await Promise.all([
    import('../../../../src/main/features/cognition/inbox-adapter'),
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/asset-inspection-service'),
    import('../../../../src/main/features/recall/store'),
  ]);
  return { adapter, candidates, assets, inspection, store };
}

let seedSeq = 0;
const JUDGMENTS = [
  '季度评审要提前两周约齐所有评审人并锁定议程。',
  '线上数据导出必须走审批工单并附脱敏说明。',
  '接口变更要先发公告再动实现，两者不得同一天。',
  '新人上手第一周只读不写，第二周起配对操作。',
  '跨团队依赖要在排期前书面确认接口归属。',
];

async function seedRule(overrides: Record<string, unknown> = {}) {
  const { candidates } = await modules();
  seedSeq += 1;
  const candidate = await candidates.saveRecallCandidate(UID, {
    judgment: JUDGMENTS[seedSeq % JUDGMENTS.length],
    // 标题闸门（设计 3.2）：无 summary 兜底＝正文首句，过不了闸门。
    summary: `治理样本${seedSeq}`,
    suggestedType: 'rule', ...BOUNDARY, suggestedScope: 'architecture',
    sourceRefs: [{ kind: 'execution', id: `exec-gov-${seedSeq}` }],
    ...overrides,
  });
  const { asset } = await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });
  return asset;
}

/** 找一条待办（真实读模型），没有就红——测试的前提是读口真的产出了它。 */
async function findItem(prefix: string) {
  const { adapter } = await modules();
  const items = await adapter.listCognitionInbox(UID);
  const found = items.find((item) => item.id.startsWith(prefix));
  expect(found, `待办未产出：${prefix}（现有 ${items.map((i) => i.kind).join(',')}）`).toBeTruthy();
  return { found: found!, items };
}

function readRaw(assetId: string): string {
  return fs.readFileSync(path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'ability-assets', `${assetId}.json`), 'utf8');
}

describe('governance resolve paths (specs/010)', () => {
  it('T028 set_boundary passes the same gate, retires the item, and refuses (untouched) on failure', async () => {
    const { adapter, assets, candidates } = await modules();
    // 无边界规则（user 线晋升允许缺边界，之后由待办补齐——正是这条链路）。
    const candidate = await candidates.saveRecallCandidate(UID, {
      judgment: '接口变更要先发公告再动实现，两者不得同一天。',
      summary: '公告先行纪律',
      suggestedType: 'rule', suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-boundary' }],
    });
    const { asset } = await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });
    const { found } = await findItem(`rule-boundary:${asset.id}`);

    // 非法态：空条件 → 同一道闸门拒绝，且不落库（读盘比对，分毫未动）。
    const rawBefore = readRaw(asset.id);
    await expect(adapter.resolveCognitionInboxItem(UID, {
      id: found.id, action: 'set_boundary', applicableWhen: [], forbiddenWhen: [],
    })).rejects.toMatchObject({ code: 'invalid_boundary' });
    expect(readRaw(asset.id)).toBe(rawBefore);

    // 通过态：补齐边界 → 用户版本 + 待办退场。
    const result = await adapter.resolveCognitionInboxItem(UID, {
      id: found.id, action: 'set_boundary',
      applicableWhen: ['发布窗口内做接口变更'], forbiddenWhen: ['紧急回滚时的直接修补'],
    });
    expect(result).toEqual({ ok: true, target: 'asset', status: 'boundary_set' });
    const after = await assets.readAbilityAsset(UID, asset.id);
    expect(after.applicableWhen).toEqual(['发布窗口内做接口变更']);
    expect(Number(after.version)).toBeGreaterThan(Number(asset.version));
    expect((await adapter.listCognitionInbox(UID)).some((item) => item.id === found.id)).toBe(false);
  });

  it('T031 conflict claim keeps one side and rejects the siblings', async () => {
    const { adapter, candidates } = await modules();
    const judgment = '同一句话被归成两类' + seedSeq;
    const base = {
      judgment, summary: `归类冲突样本${seedSeq}`, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-conflict' }],
      ...BOUNDARY,
    };
    const ruleSide = await candidates.saveRecallCandidate(UID, { ...base, suggestedType: 'rule' });
    const factSide = await candidates.saveRecallCandidate(UID, { ...base, suggestedType: 'fact' });
    const { found } = await findItem(`conflict:${ruleSide.id}`);

    const result = await adapter.resolveCognitionInboxItem(UID, { id: found.id, action: 'claim' });
    expect(result).toEqual({ ok: true, target: 'recall_candidate', status: 'claimed' });
    // 选边后冲突组只剩一边：另一边被 reject。
    const rejected = await candidates.readRecallCandidate(UID, factSide.id);
    expect(String(rejected?.status || '')).toBe('rejected');
    const items = await adapter.listCognitionInbox(UID);
    expect(items.some((item) => item.id.startsWith('conflict:'))).toBe(false);
  });

  it('T032 inspection keep archives the other side and closes the finding within the same turn', async () => {
    const { adapter, assets, inspection, store, candidates } = await modules();
    const original = await seedRule();
    // 克隆一条很像的（inspection 的 duplicate 判据：正文按字面相似度比）。
    const similarText = String((await assets.readAbilityAsset(UID, original.id)).statement).replace(/。$/, '') + '。';
    await store.updateRecallJsonRecord(UID, 'ability-assets', `aa-dup${String(seedSeq).padStart(4, '0')}`, async () => ({
      ...(await assets.readAbilityAsset(UID, original.id)) as unknown as Record<string, unknown>,
      id: `aa-dup${String(seedSeq).padStart(4, '0')}`,
      statement: similarText.slice(0, -1) + '样。', title: '很像的一条',
    }));
    await inspection.runAssetInspection(UID, { trigger: 'manual' });
    const { found } = await findItem('inspection:');
    expect(String(found.findingCategory)).toMatch(/duplicate|conflict/);

    const other = String((found.assetIds || []).find((id) => id !== found.assetId) || '');
    const result = await adapter.resolveCognitionInboxItem(UID, {
      id: found.id, action: 'keep', targetAssetId: String(found.assetId),
    });
    expect(result).toEqual({ ok: true, target: 'inspection_finding', status: 'kept' });
    // 另一方被归档、目标不动。
    expect((await assets.readAbilityAsset(UID, other)).status).toBe('archived');
    expect((await assets.readAbilityAsset(UID, String(found.assetId))).status).toBe('active');
    // 不等下一轮巡检：连续两次读口，第二次不含该发现。
    const second = await adapter.listCognitionInbox(UID);
    expect(second.some((item) => item.id === found.id)).toBe(false);
    // 再跑一轮也不再报。
    await inspection.runAssetInspection(UID, { trigger: 'manual' });
    expect((await adapter.listCognitionInbox(UID)).some((item) => item.id === found.id)).toBe(false);
  });

  it('T032 inspection merge folds the other side into the target; cross-type merge is refused as-is', async () => {
    const { adapter, assets, inspection, store } = await modules();
    const original = await seedRule();
    const cloneId = `aa-dup${String(seedSeq).padStart(4, '0')}`;
    const similarText2 = String((await assets.readAbilityAsset(UID, original.id)).statement).replace(/。$/, '') + '。';
    await store.updateRecallJsonRecord(UID, 'ability-assets', cloneId, async () => ({
      ...(await assets.readAbilityAsset(UID, original.id)) as unknown as Record<string, unknown>,
      id: cloneId,
      statement: similarText2.slice(0, -1) + '样。', title: '很像的一条',
    }));
    await inspection.runAssetInspection(UID, { trigger: 'manual' });
    const { found } = await findItem('inspection:');

    const result = await adapter.resolveCognitionInboxItem(UID, {
      id: found.id, action: 'merge', targetAssetId: String(found.assetId),
    });
    expect(result).toEqual({ ok: true, target: 'inspection_finding', status: 'merged' });
    // 合并方向：另一方折进目标（目标 = 本行锚定的资产）。
    const target = await assets.readAbilityAsset(UID, String(found.assetId));
    const otherId = String((found.assetIds || []).find((id) => id !== found.assetId) || '');
    const merged = await assets.readAbilityAsset(UID, otherId);
    expect(String(target.status)).toBe('active');
    expect(String(merged.status)).toBe('archived');
    expect(String((merged as unknown as { mergedIntoAssetId?: string }).mergedIntoAssetId || '')).toBe(String(found.assetId));
    expect((await adapter.listCognitionInbox(UID)).some((item) => item.id === found.id)).toBe(false);

    // 不同类型合并：既有闸门拒绝，如实转 unsupported_action（不偷偷改类型）。
    const factCandidate = await (await modules()).candidates.saveRecallCandidate(UID, {
      judgment: '值班表要在每月 25 号前排定下月轮值并抄送全员。',
      summary: '轮值排定纪律',
      suggestedType: 'fact', suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-merge-x' }],
    });
    const { asset: factAsset } = await (await modules()).candidates.promoteRecallCandidate(UID, factCandidate.id, { actor: 'user' });
    await expect(assets.mergeAbilityAssets(UID, factAsset.id, original.id, { actor: 'user', reason: 'x' }))
      .rejects.toThrow(/same type/);
  });

  it('T021 stale optimistic versions surface as the stable version_conflict code', async () => {
    const { adapter, assets } = await modules();
    const asset = await seedRule();
    // 真实链路里这一撞发生在锁内（读后写入前别人先落了版）；这里对同一个
    // 模块对象的 updateAbilityAsset 打一次性 spy，验证 settle() 的翻译。
    const spy = vi.spyOn(assets, 'updateAbilityAsset')
      .mockRejectedValueOnce(new Error('ability asset version conflict: expected v2, current v3'));
    await expect(adapter.resolveCognitionInboxItem(UID, {
      id: `rule-boundary:${asset.id}`, action: 'set_boundary',
      applicableWhen: ['发布窗口内做接口变更'], forbiddenWhen: ['紧急回滚时的直接修补'],
    })).rejects.toMatchObject({ code: 'version_conflict' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
