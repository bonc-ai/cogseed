import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
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
  const [adapter, candidates, assets, inspection, store, approval, capabilities] = await Promise.all([
    import('../../../../src/main/features/cognition/inbox-adapter'),
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/asset-inspection-service'),
    import('../../../../src/main/features/recall/store'),
    import('../../../../src/main/features/recall/asset-approval-service'),
    import('../../../../src/main/features/recall/candidate-capabilities'),
  ]);
  return { adapter, candidates, assets, inspection, store, approval, capabilities };
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
  const candidate = await createNightlyCandidateFixture(UID, {
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
    const candidate = await createNightlyCandidateFixture(UID, {
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
    const ruleSide = await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'rule' });
    const factSide = await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'fact' });
    const { found } = await findItem(`conflict:${ruleSide.id}`);

    const result = await adapter.resolveCognitionInboxItem(UID, { id: found.id, action: 'claim' });
    expect(result).toEqual({ ok: true, target: 'recall_candidate', status: 'claimed' });
    // 选边后冲突组只剩一边：另一边被 reject。
    const rejected = await candidates.readRecallCandidate(UID, factSide.id);
    expect(String(rejected?.status || '')).toBe('rejected');
    const items = await adapter.listCognitionInbox(UID);
    expect(items.some((item) => item.id.startsWith('conflict:'))).toBe(false);
  });

  it('标点变体的同判断冲突（2026-09-30 质检 r1）：待办、选边与冲突表同口径，claim 能收口', async () => {
    const { adapter, candidates } = await modules();
    seedSeq += 1;
    // 两条候选只在标点上不同（冒号 vs 空格）：剥标点的严口径判同文本，
    // 只归一空白的宽口径判不同文本——三处（冲突表 / 待办分组 / claim 选边）
    // 必须同用严口径，否则待办出不来、claim 拒不掉 sibling，永不收口。
    const base = {
      summary: `标点冲突样本${seedSeq}`, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-punct' }],
      ...BOUNDARY,
    };
    const ruleSide = await createNightlyCandidateFixture(UID, {
      ...base, judgment: `周报要在周五下班前提交：附风险清单${seedSeq}`, suggestedType: 'rule',
    });
    const factSide = await createNightlyCandidateFixture(UID, {
      ...base, judgment: `周报要在周五下班前提交 附风险清单${seedSeq}`, suggestedType: 'fact',
    });
    // ① 待办分组也是严口径：标点变体照样产出 conflict 待办。
    const { found } = await findItem(`conflict:${ruleSide.id}`);

    // ② claim 的 sibling 匹配同口径：标点变体被拒，不是漏网。
    const result = await adapter.resolveCognitionInboxItem(UID, { id: found.id, action: 'claim' });
    expect(result).toEqual({ ok: true, target: 'recall_candidate', status: 'claimed' });
    expect(String((await candidates.readRecallCandidate(UID, factSide.id))?.status || '')).toBe('rejected');
    // ③ 收口：冲突待办不再出现。
    expect((await adapter.listCognitionInbox(UID)).some((item) => item.id.startsWith('conflict:'))).toBe(false);
  });

  it('同类型同文本的兄弟不在 claim 的拒绝面（2026-09-30 质检 r2）：冲突表按类型口径', async () => {
    const { adapter, candidates } = await modules();
    seedSeq += 1;
    // 三方并存：A(rule) / B(fact) / C(rule)。判重 fingerprint 用**原始文本**
    // （差一个标点即不同条），冲突表用剥标点严口径——所以 A/C 要双存必须
    // 是标点变体（冒号 vs 空格），B 类型不同天然可达。冲突表与晋升闸门的
    // 口径都是「同文本**且类型不同**才算冲突」——A/C 互为同类型兄弟，不在
    // 冲突面里。claim A 只应拒 B；把 C 也终态拒绝会剥夺它 forceCreateSimilar
    // 的出路（rejected 无出弧，永久出局）。
    const base = {
      summary: `三方冲突样本${seedSeq}`, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-r2-type' }],
      ...BOUNDARY,
    };
    const ruleA = await createNightlyCandidateFixture(UID, {
      ...base, judgment: `跨团队依赖要在排期前书面确认接口归属：第${seedSeq}版`, suggestedType: 'rule',
    });
    const factB = await createNightlyCandidateFixture(UID, {
      ...base, judgment: `跨团队依赖要在排期前书面确认接口归属：第${seedSeq}版`, suggestedType: 'fact',
    });
    const ruleC = await createNightlyCandidateFixture(UID, {
      ...base, judgment: `跨团队依赖要在排期前书面确认接口归属 第${seedSeq}版`, suggestedType: 'rule',
    });
    const { found } = await findItem(`conflict:${ruleA.id}`);

    const result = await adapter.resolveCognitionInboxItem(UID, { id: found.id, action: 'claim' });
    expect(result).toEqual({ ok: true, target: 'recall_candidate', status: 'claimed' });
    // 类型不同的一边被拒（冲突面的本义）。
    expect(String((await candidates.readRecallCandidate(UID, factB.id))?.status || '')).toBe('rejected');
    // 同类型兄弟不被连带终态拒绝——它不是这条冲突的当事人。
    const sibling = await candidates.readRecallCandidate(UID, ruleC.id);
    expect(String(sibling?.status || '')).not.toBe('rejected');
    // 冲突照样收口：有效同文本组只剩一种类型，不再产 conflict 待办。
    expect((await adapter.listCognitionInbox(UID)).some((item) => item.id.startsWith('conflict:'))).toBe(false);
  });

  it('claim 撞终态候选：按「已处置」口径拒绝，不伪装成晋升检查失败（2026-09-30 质检 r3）', async () => {
    const { adapter, candidates } = await modules();
    seedSeq += 1;
    // 竞态：用户读清单后、点 claim 前，保留侧已被别处处置成终态——终态候选
    // needsUserAction=false 不再出现在待办，但 id 仍可能被直接提交。
    const base = {
      judgment: `过期内容要归档到只读区，批次${seedSeq}`,
      summary: `终态竞态样本${seedSeq}`, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-r3-terminal' }],
      ...BOUNDARY,
    };
    const ruleSide = await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'rule' });
    const factSide = await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'fact' });
    await candidates.rejectRecallCandidate(UID, ruleSide.id, '别处先处置了');

    await expect(adapter.resolveCognitionInboxItem(UID, { id: `conflict:${ruleSide.id}`, action: 'claim' }))
      .rejects.toMatchObject({ code: 'unsupported_item_kind', message: expect.stringContaining('刚被处置过') });
    // 保留侧已终态时选边无效：另一边不得被无主处置连带拒绝。
    expect(String((await candidates.readRecallCandidate(UID, factSide.id))?.status || '')).not.toBe('rejected');
  });

  it('claim 的 promote 锁内撞终态（竞态兜底）：unsupported_item_kind 且不外漏英文 message（2026-09-30 质检 r3）', async () => {
    const { adapter, candidates, capabilities } = await modules();
    seedSeq += 1;
    const base = {
      judgment: `巡检发现要在 24 小时内认领，批次${seedSeq}`,
      summary: `锁内竞态样本${seedSeq}`, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-r3-lock' }],
      ...BOUNDARY,
    };
    const ruleSide = await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'rule' });
    await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'fact' });
    // 读后写前的窗口：主进程读到的 mine 还非终态，promote 进锁才发现已被
    // 处置——一次性 spy 模拟锁内 RecallCandidateStateError（T021 同款手法）。
    const spy = vi.spyOn(candidates, 'promoteRecallCandidate').mockRejectedValueOnce(
      new capabilities.RecallCandidateStateError(
        capabilities.RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', 'rejected',
      ) as never,
    );
    const rejection = await adapter.resolveCognitionInboxItem(UID, { id: `conflict:${ruleSide.id}`, action: 'claim' })
      .then(() => undefined, (error: unknown) => error);
    spy.mockRestore();
    expect(rejection).toMatchObject({ code: 'unsupported_item_kind', message: expect.stringContaining('刚被处置过') });
    // 契约（candidate-capabilities）：UI 靠 code 翻译，不拼英文内部 message。
    expect(String((rejection as Error).message)).not.toContain('terminal');
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
      // Synthetic clone: no copied source refs, so the read-only inspection pool
      // admits it instead of treating the old candidate proof as missing.
      evidenceRefs: [],
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
      evidenceRefs: [],
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
    const factCandidate = await createNightlyCandidateFixture(UID, {
      judgment: '值班表要在每月 25 号前排定下月轮值并抄送全员。',
      summary: '轮值排定纪律',
      suggestedType: 'fact', suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-merge-x' }],
    });
    const { asset: factAsset } = await (await modules()).candidates.promoteRecallCandidate(UID, factCandidate.id, { actor: 'user' });
    // 目标必须是仍活跃的 rule；上一段 merge 的归档侧随巡检方向而定，不能拿它当靶子。
    const activeRule = await seedRule();
    await expect(assets.mergeAbilityAssets(UID, factAsset.id, activeRule.id, { actor: 'user', reason: 'x' }))
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

  it('proposal 待办：已处置过的提议不再伪装成功（2026-09-30 质检 r1）', async () => {
    const { adapter, approval } = await modules();
    const asset = await seedRule();
    const { proposal } = await approval.createAssetChangeProposal(UID, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['statement'],
      payload: { statement: '发布前必须核对回滚方案并演练一次。' },
      before: 'statement=12 字',
      after: 'statement=16 字',
      reason: '质检样本：已处置提议的重复点击',
    });
    // 先在别处（审批卡通道）处置成终态，再从待办通道点 accept——
    // 服务层回 ok:false，adapter 必须如实失败，不能回 ok:true。
    await approval.decideAssetChangeProposal(UID, proposal.id, 'reject');
    await expect(adapter.resolveCognitionInboxItem(UID, { id: `proposal:${proposal.id}`, action: 'accept' }))
      .rejects.toMatchObject({ code: 'unsupported_item_kind', message: expect.stringContaining('已经处置过') });
  });

  it('proposal 待办：确认撞版本时如实抛 version_conflict，不再伪装成功（2026-09-30 质检 r1）', async () => {
    const { adapter, assets, approval } = await modules();
    const asset = await seedRule();
    const { proposal } = await approval.createAssetChangeProposal(UID, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['statement'],
      payload: { statement: '发布前必须核对回滚方案并演练一次。' },
      before: 'statement=12 字',
      after: 'statement=16 字',
      reason: '质检样本：确认撞版本',
    });
    // 资产在用户看卡片期间被别的改动更新（版本前进）——confirm 撞
    // expectedVersion，服务层回 ok:false+versionConflict 且卡片保持 pending；
    // adapter 必须抛 version_conflict，渲染层才不会 toast+删行（刷新复活）。
    await assets.updateAbilityAsset(UID, asset.id, {
      statement: '发布前必须核对回滚方案，并把回滚入口写进发布单。',
      expectedVersion: asset.version,
      actor: 'user',
      reason: '别的改动：正文更新',
    });
    await expect(adapter.resolveCognitionInboxItem(UID, { id: `proposal:${proposal.id}`, action: 'accept' }))
      .rejects.toMatchObject({ code: 'version_conflict' });
    // 提议已按 P-r1-74「冲突即作废重提」置 superseded：baseline 被顶掉后
    // confirm 永久不可达，作废关闭等待 AI 基于最新版本重提（2026-10-01 前批
    // 行为变更，本断言随之对齐；旧断言「保持 pending」是 superseded 引入前的
    // 行为）。
    const still = await approval.readAssetChangeProposal(UID, proposal.id);
    expect(String((still as unknown as { state?: string })?.state || '')).toBe('superseded');
  });

  it('proposal 待办：标签在期间被改过时抛 tags_conflict，不伪装成功', async () => {
    const { adapter, assets, approval } = await modules();
    const asset = await seedRule();
    const { proposal } = await approval.createAssetChangeProposal(UID, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['tags'],
      payload: { tags: ['模板'] },
      beforeValues: { tags: [] },
      before: 'tags=0', after: 'tags=1',
      reason: '质检样本：标签冲突',
    });
    // 标签更新不 bump 版本：待办里的 accept 只能靠写锁内的标签 CAS 拦住覆盖。
    await assets.updateAbilityAsset(UID, asset.id, { tags: ['重要'], reason: '别的改动：打标', actor: 'user' });
    await expect(adapter.resolveCognitionInboxItem(UID, { id: `proposal:${proposal.id}`, action: 'accept' }))
      .rejects.toMatchObject({ code: 'tags_conflict' });
    expect((await approval.readAssetChangeProposal(UID, proposal.id))!.state).toBe('superseded');
    expect((await assets.readAbilityAsset(UID, asset.id)).tags).toEqual(['重要']);
  });

  it('巡检 merge 撞已并成员（治理通道外合并后重试，2026-10-01 质检 P-r2-5/P-r1-11）：预检跳过，finding 照常收口', async () => {
    const { adapter, assets, inspection, store } = await modules();
    const original = await seedRule();
    const cloneId = `aa-dup${String(seedSeq).padStart(4, '0')}`;
    const similarText = String((await assets.readAbilityAsset(UID, original.id)).statement).replace(/。$/, '') + '。';
    await store.updateRecallJsonRecord(UID, 'ability-assets', cloneId, async () => ({
      ...(await assets.readAbilityAsset(UID, original.id)) as unknown as Record<string, unknown>,
      id: cloneId,
      statement: similarText.slice(0, -1) + '样。', title: '很像的一条',
      // Synthetic clone: no copied source refs, so the read-only inspection pool
      // admits it instead of treating the old candidate proof as missing.
      evidenceRefs: [],
    }));
    await inspection.runAssetInspection(UID, { trigger: 'manual' });
    const { found } = await findItem('inspection:');
    expect(String(found.findingCategory)).toMatch(/duplicate|conflict/);

    // 模拟「部分成功」：另一边已在治理待办通道之外、以同一方向被合并（如
    // 资产详情手动合并，或上一轮 merge 在记 dismissed 前中断）——finding 仍挂起。
    const targetId = String(found.assetId);
    const otherId = String((found.assetIds || []).find((id) => id !== found.assetId) || '');
    await assets.mergeAbilityAssets(UID, otherId, targetId, { actor: 'user', reason: '通道外先合并了' });
    const mergedOutside = await assets.readAbilityAsset(UID, otherId);
    expect(String(mergedOutside.status)).toBe('archived');
    expect(String((mergedOutside as unknown as { mergedIntoAssetId?: string }).mergedIntoAssetId || '')).toBe(targetId);

    // 修复前：重试 merge 撞「ability asset has already been merged」原样透出，
    // finding 永远关不掉；修复后：预检跳过已并成员，收口成功。
    const result = await adapter.resolveCognitionInboxItem(UID, {
      id: found.id, action: 'merge', targetAssetId: targetId,
    });
    expect(result).toEqual({ ok: true, target: 'inspection_finding', status: 'merged' });
    expect((await adapter.listCognitionInbox(UID)).some((item) => item.id === found.id)).toBe(false);
  });

  it('巡检 merge 预检后并发撞「已并」（TOCTOU 兜底，P-r2-5/P-r1-11 第②层）：视为达成，不卡死', async () => {
    const { adapter, assets, inspection, store } = await modules();
    const original = await seedRule();
    const cloneId = `aa-dup${String(seedSeq).padStart(4, '0')}`;
    const similarText = String((await assets.readAbilityAsset(UID, original.id)).statement).replace(/。$/, '') + '。';
    await store.updateRecallJsonRecord(UID, 'ability-assets', cloneId, async () => ({
      ...(await assets.readAbilityAsset(UID, original.id)) as unknown as Record<string, unknown>,
      id: cloneId,
      statement: similarText.slice(0, -1) + '样。', title: '很像的一条',
      // Synthetic clone: no copied source refs, so the read-only inspection pool
      // admits it instead of treating the old candidate proof as missing.
      evidenceRefs: [],
    }));
    await inspection.runAssetInspection(UID, { trigger: 'manual' });
    const { found } = await findItem('inspection:');

    // 预检读到的是未并资产（通过预检），进 merge 时却在窗口内已被别处并掉：
    // 一次性 spy 模拟该竞态（T021 同款手法）。
    const spy = vi.spyOn(assets, 'mergeAbilityAssets')
      .mockRejectedValueOnce(new Error('ability asset has already been merged') as never);
    const result = await adapter.resolveCognitionInboxItem(UID, {
      id: found.id, action: 'merge', targetAssetId: String(found.assetId),
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    // 已并视为达成：finding 收口，不再原样透出卡死。
    expect(result).toEqual({ ok: true, target: 'inspection_finding', status: 'merged' });
    expect((await adapter.listCognitionInbox(UID)).some((item) => item.id === found.id)).toBe(false);
  });

  it('巡检名单资产已终态（2026-10-01 质检 P-r1-76 预检）：处置开始前如实拒绝，不半途归档、不外漏英文守卫错误', async () => {
    const { adapter, assets, inspection, store } = await modules();
    const original = await seedRule();
    const cloneId = `aa-dup${String(seedSeq).padStart(4, '0')}`;
    const similarText = String((await assets.readAbilityAsset(UID, original.id)).statement).replace(/。$/, '') + '。';
    await store.updateRecallJsonRecord(UID, 'ability-assets', cloneId, async () => ({
      ...(await assets.readAbilityAsset(UID, original.id)) as unknown as Record<string, unknown>,
      id: cloneId,
      statement: similarText.slice(0, -1) + '样。', title: '很像的一条',
      // Synthetic clone: no copied source refs, so the read-only inspection pool
      // admits it instead of treating the old candidate proof as missing.
      evidenceRefs: [],
    }));
    await inspection.runAssetInspection(UID, { trigger: 'manual' });
    const { found } = await findItem('inspection:');

    // 名单里的一条在用户看着待办期间被撤回（终态）——修复前 keep/merge 走到
    // 该成员才撞英文终态守卫错误（revoked ability asset cannot be changed）
    // 直上屏且重试必再失败；keep 还会先把其余成员归档掉一半。
    const targetId = String(found.assetId);
    const otherId = String((found.assetIds || []).find((id) => id !== found.assetId) || '');
    await assets.revokeAbilityAsset(UID, otherId, { actor: 'user', reason: '别处先撤回了' });

    const rejection = await adapter.resolveCognitionInboxItem(UID, {
      id: found.id, action: 'keep', targetAssetId: targetId,
    }).then(() => undefined, (error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'unsupported_item_kind' });
    const message = String((rejection as Error).message);
    expect(message).toContain('已是终态');
    expect(message).not.toContain('cannot be changed');
    // 预检在归档循环开始前就拒绝：target 不被半途处置。
    expect((await assets.readAbilityAsset(UID, targetId)).status).toBe('active');
    // merge 同一预检：同样提前如实拒绝。
    await expect(adapter.resolveCognitionInboxItem(UID, {
      id: found.id, action: 'merge', targetAssetId: targetId,
    })).rejects.toMatchObject({ code: 'unsupported_item_kind' });
  });

  it('巡检 keep 预检后窗口内撞终态守卫（P-r1-76 映射兜底，TOCTOU）：稳定化翻译，不再英文上屏', async () => {
    const { adapter, assets, inspection, store } = await modules();
    const original = await seedRule();
    const cloneId = `aa-dup${String(seedSeq).padStart(4, '0')}`;
    const similarText = String((await assets.readAbilityAsset(UID, original.id)).statement).replace(/。$/, '') + '。';
    await store.updateRecallJsonRecord(UID, 'ability-assets', cloneId, async () => ({
      ...(await assets.readAbilityAsset(UID, original.id)) as unknown as Record<string, unknown>,
      id: cloneId,
      statement: similarText.slice(0, -1) + '样。', title: '很像的一条',
      // Synthetic clone: no copied source refs, so the read-only inspection pool
      // admits it instead of treating the old candidate proof as missing.
      evidenceRefs: [],
    }));
    await inspection.runAssetInspection(UID, { trigger: 'manual' });
    const { found } = await findItem('inspection:');

    // 预检时全部活着；进归档循环时成员刚在窗口内被撤回——一次性 spy 模拟该
    // 竞态（T021 同款手法），验证 settle() 的终态映射兜底。
    const spy = vi.spyOn(assets, 'archiveAbilityAsset')
      .mockRejectedValueOnce(new Error('revoked ability asset cannot be changed') as never);
    const rejection = await adapter.resolveCognitionInboxItem(UID, {
      id: found.id, action: 'keep', targetAssetId: String(found.assetId),
    }).then(() => undefined, (error: unknown) => error);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(rejection).toMatchObject({ code: 'unsupported_item_kind' });
    const message = String((rejection as Error).message);
    expect(message).toContain('已是终态');
    expect(message).not.toContain('cannot be changed');
  });

  it('claim 的 promote 抛候选服务结构化错误（2026-10-01 质检 P-r1-10）：按类型映射原样透出，不包成晋升检查失败', async () => {
    const { adapter, candidates, capabilities } = await modules();
    seedSeq += 1;
    const base = {
      judgment: `评审结论文档要与决议同步更新，批次${seedSeq}`,
      summary: `错误映射样本${seedSeq}`, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-r1-10-map' }],
      ...BOUNDARY,
    };
    const ruleSide = await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'rule' });
    await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'fact' });
    // promote 抛的不是晋升闸门（PromotionBlockedError）而是候选服务自己的
    // 结构化错误码（高风险未独立确认）——修复前被一刀切包成
    // promotion_gate_rejected「没通过晋升检查」，误导用户去改内容。
    const spy = vi.spyOn(candidates, 'promoteRecallCandidate').mockRejectedValueOnce(
      capabilities.recallCandidateError('recall_candidate_risk_gate', 'high-risk candidate requires an independent risk gate') as never,
    );
    const rejection = await adapter.resolveCognitionInboxItem(UID, { id: `conflict:${ruleSide.id}`, action: 'claim' })
      .then(() => undefined, (error: unknown) => error);
    spy.mockRestore();
    // 结构化码原样透出：渲染层码表（recallErrorText）据此翻成「高风险需单独
    // 确认」，而不是笼统的「没通过晋升检查」。
    expect(rejection).toMatchObject({ code: 'recall_candidate_risk_gate' });
  });

  it('claim sibling 全拒掉但保留侧被闸门拦（P-r2-1 计数分支）：回执「另一条已出局」成立——计数与事实一致', async () => {
    const { adapter, candidates } = await modules();
    seedSeq += 1;
    // judgment 用纯元评价短语（「值得保留」只评价候选本身、不是可复用内容）：
    // user 线晋升也拦（judgment_is_meta_commentary），而 sibling（fact）证据
    // 齐全拒得掉——「另一条已出局」此时是事实，回执成立。
    const judgment = '值得保留';
    const base = {
      judgment, summary: `全拒分支样本${seedSeq}`, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-gov-r2-1-count' }],
    };
    const ruleSide = await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'rule' });
    const factSide = await createNightlyCandidateFixture(UID, { ...base, suggestedType: 'fact' });
    const { found } = await findItem(`conflict:${ruleSide.id}`);

    const rejection = await adapter.resolveCognitionInboxItem(UID, { id: found.id, action: 'claim' })
      .then(() => undefined, (error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'promotion_gate_rejected' });
    const message = String((rejection as Error).message);
    expect(message).toContain('另一条已出局');
    expect(message).not.toContain('没拒掉');
    // sibling 确实全部出局（计数与事实一致）。
    expect(String((await candidates.readRecallCandidate(UID, factSide.id))?.status || '')).toBe('rejected');
    expect(String((await candidates.readRecallCandidate(UID, ruleSide.id))?.status || '')).toBe('pending_review');
  });
});
