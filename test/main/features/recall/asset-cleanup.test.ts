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

// 标题重起轮的模型链 mock（与 asset-title-suggestion.test.ts 同款：mock auth
// 预检 + runner 出题，走真实 suggestAbilityAssetTitle 链路）。outputs 按
// 「正文片段 → 模型输出」配对，不依赖资产处理顺序。
const titleRegenModel = vi.hoisted(() => ({
  configured: true,
  oauthExpired: null as string | null,
  outputs: [] as Array<{ match: string; text: string }>,
  runCalls: [] as Array<{ message: string }>,
}));
vi.mock('../../../../src/main/features/auth', () => ({
  hasConfiguredModelForUser: () => ({ configured: titleRegenModel.configured }),
  hasConfiguredModel: () => ({ configured: titleRegenModel.configured }),
  getConfiguredModelOAuthExpiredMessage: () => titleRegenModel.oauthExpired,
}));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({
  buildRunner: vi.fn(async () => ({
    providerId: 'anthropic',
    modelId: 'claude-test',
    turnEphemeral: '',
    runner: {
      run: async (runInput: { message: string }) => {
        titleRegenModel.runCalls.push(runInput);
        const hit = titleRegenModel.outputs.find((row) => runInput.message.includes(row.match));
        return {
          text: hit ? hit.text : '',
          content: [],
          meta: {
            durationMs: 1,
            model: 'claude-test',
            provider: 'anthropic',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            toolLoops: 0,
            compactionCount: 0,
          },
        };
      },
    },
  })),
}));

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cleanup-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  titleRegenModel.configured = true;
  titleRegenModel.oauthExpired = null;
  titleRegenModel.outputs = [];
  titleRegenModel.runCalls = [];
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, cleanup, store, inbox, adapter] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/cleanup-report-service'),
    import('../../../../src/main/features/recall/store'),
    import('../../../../src/main/features/recall/formal-assets/inbox'),
    import('../../../../src/main/features/cognition/inbox-adapter'),
  ]);
  return { candidates, assets, cleanup, store, inbox, adapter };
}

let seedSeq = 0;
async function seedAsset(uid: string, judgment: string, title?: string) {
  const { candidates, store } = await modules();
  seedSeq += 1;
  const candidate = await candidates.saveRecallCandidate(uid, {
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

describe('整理报告与执行链（T041 / T042）', () => {
  it('命名规范化：只动空白与结尾标点，报告项与台账一一对应', async () => {
    const uid = 'user-clean-title';
    const { assets, cleanup } = await modules();
    // 真机上能落盘的"标题不规范"主要是**结尾句读**：空白早被候选判断与资产写入口
    // 归一了（`boundedText` / `bounded` 都 collapse + trim），所以夹具用句点形态。
    // 标题闸门（设计 3.2）后夹具标题还须与正文开头不同字——「正文首句＋句号」
    // 的老形态现在是收口闸门直接拒绝的写入，不再是规范化轮的处理对象。
    const asset = await seedAsset(uid, '导出报表一律带上生成时间戳。', '报表时间戳纪律。');
    expect(asset.title).toBe('报表时间戳纪律。');
    const report = await cleanup.runAssetCleanup(uid);

    expect(report.finishedAt).toBeTruthy();
    const applied = report.items.filter((item) => item.status === 'applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ assetId: asset.id, kind: 'title_normalized', before: '报表时间戳纪律。', after: '报表时间戳纪律' });
    // 每项都带台账引用与回滚锚点（items[] 与台账一一对应、每项可单独回滚）。
    expect(applied[0].ledgerRef).toBeTruthy();
    expect(applied[0].rollbackAnchor).toBe('1');
    const audit = await assets.listAbilityAssetAudit(uid, asset.id);
    expect(audit.some((row) => row.id === applied[0].ledgerRef)).toBe(true);
    expect((await assets.readAbilityAsset(uid, asset.id)).title).toBe('报表时间戳纪律');
  });

  it('逐项回滚：拿报告项里的锚点回滚，内容与整理前一致', async () => {
    const uid = 'user-clean-rollback';
    const { assets, cleanup, store } = await modules();
    const asset = await seedAsset(uid, '上线前核对回滚方案。');
    // 布置一个结尾句点标题（raw 直写，模拟存量），规范化把它收干净。
    await store.updateRecallJsonRecord(uid, 'ability-assets', asset.id, (raw) => ({ ...raw!, title: '回滚方案核对。' }));
    const report = await cleanup.runAssetCleanup(uid);
    const item = report.items.find((row) => row.status === 'applied')!;

    await assets.rollbackAbilityAsset(uid, item.assetId, item.rollbackAnchor!, { actor: 'user', reason: '逐项回滚' });
    // 回滚锚点指向整理前的在用版：内容逐字回到整理前，标题回到 v1 快照的
    // 合规标题（闸门后带句点标题不再可能成为 v1 快照——拍板项 #2 保证回滚
    // 不会把不合规标题带回在用版）。
    expect((await assets.readAbilityAsset(uid, asset.id)).title).toBe(asset.seededTitle);
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe(asset.statement);
    // 回滚本身记账（报告项仍指向原来那次改动，历史不被改写）。
    expect((await assets.listAbilityAssetAudit(uid, asset.id)).some((row) => row.action === 'rolled_back')).toBe(true);
  });

  it('去重合并：只并正文一字不差的同类型资产，报告记下并入去向', async () => {
    const uid = 'user-clean-merge';
    const { assets, cleanup } = await modules();
    const keep = await seedAsset(uid, '把长会议压成三条可执行结论。');
    const duplicate = await cloneAsset(uid, keep as unknown as Record<string, unknown>, 'aa-dup0001', {
      statement: keep.statement, title: '重复的一条',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    void duplicate;

    const report = await cleanup.runAssetCleanup(uid);
    const merged = report.items.filter((item) => item.kind === 'merged_duplicate' && item.status === 'applied');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ assetId: 'aa-dup0001', mergedIntoAssetId: keep.id });
    expect(merged[0].rollbackAnchor).toBeTruthy();
    expect((await assets.readAbilityAsset(uid, 'aa-dup0001')).mergedIntoAssetId).toBe(keep.id);
    expect((await assets.readAbilityAsset(uid, keep.id)).status).toBe('active');
  });

  it('补标签已接线：机械可判定（同源组绝大多数同名标签）直接写入并进 items[]，不再有"待 Epic 2 / 012"跳过', async () => {
    const uid = 'user-clean-tags';
    const { assets, cleanup, store } = await modules();
    // 同源组：三条同族；两条已有同名标签「发布」→ 第三条机械可补（传播既有
    // 事实，不需要理解语义）。familyName 用 store 直写布置（族引擎不在此范围）。
    // 标题不带结尾句读：否则标题规范化先 bump 版本，"补标不 bump"就测不干净。
    const taggedA = await seedAsset(uid, '上线前必须核对回滚方案与灰度范围');
    const taggedB = await seedAsset(uid, '数据导出一律带生成时间戳与负责人');
    const untagged = await seedAsset(uid, '会议纪要当场记录结论与待办归属');
    for (const asset of [taggedA, taggedB, untagged]) {
      await store.updateRecallJsonRecord(uid, 'ability-assets', asset.id, (raw) => ({ ...raw!, familyName: '发布纪律' }));
    }
    await assets.updateAbilityAsset(uid, taggedA.id, { tags: ['发布'], reason: '夹具', actor: 'user' });
    await assets.updateAbilityAsset(uid, taggedB.id, { tags: ['发布'], reason: '夹具', actor: 'user' });

    const report = await cleanup.runAssetCleanup(uid);
    // 跳过项归零：不再出现"待 Epic 2 / 012"的措辞。
    expect(report.skippedSteps).toEqual([]);
    // 机械补标成为真实动作：进 items[]、带 before/after、台账引用与回滚锚点。
    const tagged = report.items.filter((item) => item.kind === 'tag_added' && item.status === 'applied');
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toMatchObject({ assetId: untagged.id, before: '（未分类）', after: '发布' });
    expect(tagged[0].ledgerRef).toBeTruthy();
    expect(tagged[0].rollbackAnchor).toBeTruthy();
    // 标签写入走元数据路径：资产 tags 更新、内容版本不动。
    const after = await assets.readAbilityAsset(uid, untagged.id);
    expect(after.tags).toEqual(['发布']);
    expect(after.version).toBe(untagged.version);
    // 台账记「标签：旧 → 新」且逐项可核（ledgerRef 指向真实台账行）。
    const audit = await assets.listAbilityAssetAudit(uid, untagged.id);
    expect(audit.some((row) => row.id === tagged[0].ledgerRef && String(row.reason || '').includes('标签：'))).toBe(true);
    // 已有标签的两条不被重复打，内容版本也不动（对照：同样没被 bump）。
    expect((await assets.readAbilityAsset(uid, taggedA.id)).tags).toEqual(['发布']);
    expect((await assets.readAbilityAsset(uid, taggedB.id)).version).toBe(taggedB.version);
  });

  it('补标签的含义判断转待确认：库里已有标签但够不上机械判据的资产零改动', async () => {
    const uid = 'user-clean-uncertain-tag';
    const { assets, cleanup } = await modules();
    // 库里已有标签体系（这条有标签、且自成一组没有同源组多数可言）。
    // 标题不带结尾句读：不让标题规范化插进来干扰"零改动"断言。
    const tagged = await seedAsset(uid, '发布前必须核对回滚方案与灰度范围');
    await assets.updateAbilityAsset(uid, tagged.id, { tags: ['发布'], reason: '夹具', actor: 'user' });
    // 无标签、无同源组：机械判据不成立 → 含义判断，进 uncertain[] 待确认。
    const lone = await seedAsset(uid, '竞品调研先明确可比维度再收集证据');

    const report = await cleanup.runAssetCleanup(uid);
    expect(report.skippedSteps).toEqual([]);
    expect(report.items.filter((item) => item.kind === 'tag_added')).toEqual([]);
    const entry = report.uncertain.find((row) => row.assetId === lone.id);
    expect(entry).toBeTruthy();
    expect(entry!.reason).toContain('含义判断');
    // uncertain 项资产零改动：tags 仍缺省、内容与版本都不动。
    const after = await assets.readAbilityAsset(uid, lone.id);
    expect(after.tags).toBeUndefined();
    expect(after.statement).toBe(lone.statement);
    expect(after.version).toBe(lone.version);
  });

  it('库里还没有任何标签时不硬问（没有参考系，不推 uncertain、不擅自打）', async () => {
    const uid = 'user-clean-no-tags';
    const { assets, cleanup } = await modules();
    await seedAsset(uid, '命名规范：动词开头、限定范围。');
    const report = await cleanup.runAssetCleanup(uid);
    expect(report.skippedSteps).toEqual([]);
    expect(report.items.every((item) => item.kind === 'title_normalized' || item.kind === 'merged_duplicate')).toBe(true);
    expect(report.uncertain.filter((row) => row.reason.includes('含义判断'))).toEqual([]);
  });
});

describe('拿不准的项：不擅自处置（T042 / T045 / T046）', () => {
  it('近重复（正文不同）不自动合并：进 uncertain 且两条都没被改动', async () => {
    const uid = 'user-clean-uncertain';
    const { assets, cleanup } = await modules();
    const left = await seedAsset(uid, '发布前必须核对回滚方案与灰度范围。');
    await cloneAsset(uid, left as unknown as Record<string, unknown>, 'aa-near0001', {
      statement: '发布前必须核对回滚方案与灰度。', title: '很像的一条',
    });

    const report = await cleanup.runAssetCleanup(uid);
    expect(report.uncertain).toHaveLength(1);
    expect(report.uncertain[0].question).toContain('很像');
    expect(report.uncertain[0].reason).toContain('需要人来判');
    // 两条都保持原状（一条都没被并掉）。
    const first = await assets.readAbilityAsset(uid, left.id);
    const second = await assets.readAbilityAsset(uid, 'aa-near0001');
    expect(first.status).toBe('active');
    expect(second.status).toBe('active');
    expect(second.mergedIntoAssetId).toBeUndefined();
    expect(second.statement).toBe('发布前必须核对回滚方案与灰度。');
  });

  it('拿不准项进待确认清单，并能就地处置（拒绝 / 稍后）；没有可执行建议动作', async () => {
    const uid = 'user-clean-inbox';
    const { assets, cleanup, inbox, adapter } = await modules();
    const left = await seedAsset(uid, '竞品调研先明确可比维度再收集证据。');
    await cloneAsset(uid, left as unknown as Record<string, unknown>, 'aa-near0002', {
      statement: '竞品调研先明确可比维度再收集证据', title: '近重复',
    });
    const report = await cleanup.runAssetCleanup(uid);
    expect(report.uncertain).toHaveLength(1);

    // 纯函数层：清单里出现这条（低打扰列出，不打断）。
    const items = inbox.buildCognitionInbox({
      assets: [], candidates: [], unavailableSourceIds: new Set(),
      pendingCleanupItems: [{ reportId: report.id, assetId: left.id, title: left.title, question: report.uncertain[0].question }],
    });
    const entry = items.find((row) => row.kind === 'cleanup_uncertain')!;
    expect(entry.id).toBe(`cleanup:${report.id}:${left.id}`);
    expect(entry.urgency).toBe('low_disturbance');

    // accept 没有对应动作：当初就是因为拿不准才没动手。
    await expect(adapter.resolveCognitionInboxItem(uid, { id: entry.id, action: 'accept' }))
      .rejects.toThrow(/没有可执行的建议动作/);

    const resolved = await adapter.resolveCognitionInboxItem(uid, { id: entry.id, action: 'reject' });
    expect(resolved).toMatchObject({ ok: true, target: 'cleanup_uncertain', status: 'dismissed' });
    // 处置后不再出现在清单里。
    const after = await cleanup.readCleanupReport(uid, report.id);
    expect(after!.uncertain[0].decision).toBe('dismissed');
    expect(cleanup.pendingCleanupUncertainItems([after!])).toEqual([]);
    // 处置是"给个意见"，不是执行动作：资产照旧没动。
    expect((await assets.readAbilityAsset(uid, left.id)).statement).toBe(left.statement);
  });
});

describe('中断与失败后的一致性（T043 / T045）', () => {
  it('单项失败如实记录、其余照常执行，已执行项仍可逐项回滚', async () => {
    const uid = 'user-clean-partial';
    const { assets, cleanup, store } = await modules();
    const ok = await seedAsset(uid, '导出报表一律带上生成时间戳。', '报表时间戳纪律。');
    // 一条已撤销的资产：标题规范化会被"撤销不可变更"挡下——单项失败不中断整轮。
    const revoked = await seedAsset(uid, '把长会议压成三条可执行结论。', '会议结论三条整。');
    await assets.revokeAbilityAsset(uid, revoked.id, { actor: 'user', reason: 'unsafe' });
    void store;

    const report = await cleanup.runAssetCleanup(uid);
    const applied = report.items.filter((item) => item.status === 'applied');
    const failed = report.items.filter((item) => item.status === 'failed');
    expect(applied.map((item) => item.assetId)).toEqual([ok.id]);
    expect(failed.map((item) => item.assetId)).toEqual([revoked.id]);
    expect(failed[0].note).toContain('revoked');
    // 失败项保持原状。
    expect((await assets.readAbilityAsset(uid, revoked.id)).title).toBe('会议结论三条整。');
    // 已执行项可逐项回滚（标题回到 v1 快照的合规标题，见拍板项 #2）。
    await assets.rollbackAbilityAsset(uid, applied[0].assetId, applied[0].rollbackAnchor!, { actor: 'user', reason: '逐项回滚' });
    expect((await assets.readAbilityAsset(uid, ok.id)).title).toBe(ok.seededTitle);
  });

  it('报告先落盘再逐项执行：中断时报告如实反映"做到哪了"', async () => {
    const uid = 'user-clean-resume';
    const { cleanup } = await modules();
    await seedAsset(uid, '命名规范：动词开头、限定范围。');
    // 报告在创建时即落盘（items 为空），所以任何时刻读到的报告都是合法的。
    const report = await cleanup.runAssetCleanup(uid);
    expect(report.createdAt).toBeTruthy();
    expect(report.scanned).toBeGreaterThan(0);
    // 逐项写回：报告里的项数与实际执行数一致（不存在"改了没记账"）。
    const reread = await cleanup.readCleanupReport(uid, report.id);
    expect(reread!.items).toHaveLength(report.items.length);
    expect((await cleanup.listCleanupReports(uid)).map((row) => row.id)).toContain(report.id);
  });

  it('作用域过滤：只扫范围内的资产', async () => {
    const uid = 'user-clean-scope';
    const { assets, cleanup, store } = await modules();
    const inSpace = await seedAsset(uid, '空间内的资产需要整理。', '范围外不动。');
    await store.updateRecallJsonRecord(uid, 'ability-assets', inSpace.id, (raw) => ({ ...raw!, spaceId: 'sp_a' }));
    const outside = await seedAsset(uid, '空间外的资产不该被动。');

    const report = await cleanup.runAssetCleanup(uid, { scope: { spaceId: 'sp_a' } });
    expect(report.scanned).toBe(1);
    expect(report.items.map((item) => item.assetId)).toEqual([inSpace.id]);
    expect((await assets.readAbilityAsset(uid, outside.id)).title).toBe(outside.seededTitle);
  });
});

describe('标题重起轮（设计 3.3 专项轮：LLM 含义生成，与规则轮"不改含义"口径分列）', () => {
  it('只对统一口径不合规的资产重起：actor=ai 走正门升版，报告项带 before→after 与版本锚点；合规资产零动', async () => {
    const uid = 'user-clean-title-regen';
    const { assets, cleanup } = await modules();
    titleRegenModel.outputs = [
      { match: '导出报表一律带上生成时间戳', text: '{"title":"报表时间戳纪律"}' },
    ];
    // 存量不合规：raw 直写「正文原句」标题（前缀重复＋句读结尾）——闸门只拦
    // 写入不拦存量形态，这正是重起轮的处理对象（规则轮的 normalize 对它无效）。
    const bad = await seedAsset(uid, '导出报表一律带上生成时间戳。', '导出报表一律带上生成时间戳。');
    const fine = await seedAsset(uid, '上线前必须核对回滚方案与灰度范围');
    const fineBefore = await assets.readAbilityAsset(uid, fine.id);

    const report = await cleanup.runAssetTitleRegenCleanup(uid);
    expect(report.round).toBe('title_regen');
    expect(report.finishedAt).toBeTruthy();
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      assetId: bad.id,
      kind: 'title_regen',
      status: 'applied',
      before: '导出报表一律带上生成时间戳。',
      after: '报表时间戳纪律',
    });
    expect(report.items[0].ledgerRef).toBeTruthy();
    expect(report.items[0].rollbackAnchor).toBe(bad.version);
    // 写入走 updateAbilityAsset 正门：升版＋台账，模型产物记在 ai 名下（勿借
    // 'user' 名义——那是规则轮"机械步骤由系统代执行"的口径，这一轮不成立）。
    const after = await assets.readAbilityAsset(uid, bad.id);
    expect(after.title).toBe('报表时间戳纪律');
    expect(Number(after.version)).toBe(Number(bad.version) + 1);
    const audit = await assets.listAbilityAssetAudit(uid, bad.id);
    expect(audit.some((row) => row.id === report.items[0].ledgerRef && row.actor === 'ai')).toBe(true);
    // 合规资产免动：不进报告、版本与标题都不动。
    expect(report.items.some((row) => row.assetId === fine.id)).toBe(false);
    const fineAfter = await assets.readAbilityAsset(uid, fine.id);
    expect(fineAfter.title).toBe(fineBefore.title);
    expect(fineAfter.version).toBe(fineBefore.version);
  });

  it('写前整库备份落在 records 之外：备份里是改前形态，不污染记录目录', async () => {
    const uid = 'user-clean-title-regen-backup';
    const { cleanup } = await modules();
    titleRegenModel.outputs = [
      { match: '把长会议压成三条可执行结论', text: '{"title":"会议结论三条整"}' },
    ];
    const bad = await seedAsset(uid, '把长会议压成三条可执行结论。', '把长会议压成三条可执行结论。');

    const report = await cleanup.runAssetTitleRegenCleanup(uid);
    expect(report.backupDir).toBeTruthy();
    // 备份目录在 records 之外（落进 records/ 会被 readdir 当记录读入污染 collection）。
    expect(path.basename(report.backupDir!)).toMatch(/^backup-title_regen-/);
    expect(report.backupDir!.split(path.sep)).not.toContain('records');
    expect(fs.existsSync(report.backupDir!)).toBe(true);
    // 备份是**写前**快照：记录文件齐全，且标题还是改前的烂标题。
    const files = fs.readdirSync(report.backupDir!);
    expect(files).toContain(`${bad.id}.json`);
    const backed = JSON.parse(fs.readFileSync(path.join(report.backupDir!, `${bad.id}.json`), 'utf8')) as { title: string };
    expect(backed.title).toBe('把长会议压成三条可执行结论。');
  });

  it('模型不可用＝整轮失败上报：抛错、不落报告、不写任何资产（不静默跳过）', async () => {
    const uid = 'user-clean-title-regen-nomodel';
    const { assets, cleanup } = await modules();
    titleRegenModel.configured = false;
    const bad = await seedAsset(uid, '导出报表一律带上生成时间戳。', '导出报表一律带上生成时间戳。');

    await expect(cleanup.runAssetTitleRegenCleanup(uid)).rejects.toThrow(/尚未配置可用模型/);
    expect(await cleanup.listCleanupReports(uid)).toEqual([]);
    expect((await assets.readAbilityAsset(uid, bad.id)).title).toBe('导出报表一律带上生成时间戳。');
    expect(titleRegenModel.runCalls).toHaveLength(0);
  });

  it('失败隔离：单条模型失败记 failed＋note、其余照常执行；终态资产不烧模型调用记 skipped', async () => {
    const uid = 'user-clean-title-regen-partial';
    const { assets, cleanup } = await modules();
    // 坏输出按正文片段配对：资产 a 三轮都拿到非 JSON（invalid_model_output），
    // 资产 b 一次拿到合规标题——顺序无关。
    titleRegenModel.outputs = [
      { match: '导出报表一律带上生成时间戳', text: '不是 JSON' },
      { match: '发布前必须核对回滚方案与灰度范围', text: '{"title":"灰度核对清单"}' },
    ];
    const a = await seedAsset(uid, '导出报表一律带上生成时间戳。', '导出报表一律带上生成时间戳。');
    const b = await seedAsset(uid, '发布前必须核对回滚方案与灰度范围。', '发布前必须核对回滚方案与灰度范围。');
    const revoked = await seedAsset(uid, '把长会议压成三条可执行结论。', '把长会议压成三条可执行结论。');
    await assets.revokeAbilityAsset(uid, revoked.id, { actor: 'user', reason: '夹具' });

    const report = await cleanup.runAssetTitleRegenCleanup(uid);
    const failed = report.items.find((row) => row.assetId === a.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.note).toBeTruthy();
    expect((await assets.readAbilityAsset(uid, a.id)).title).toBe('导出报表一律带上生成时间戳。');
    expect(report.items.find((row) => row.assetId === b.id)).toMatchObject({ status: 'applied', after: '灰度核对清单' });
    expect((await assets.readAbilityAsset(uid, b.id)).title).toBe('灰度核对清单');
    const skipped = report.items.find((row) => row.assetId === revoked.id)!;
    expect(skipped.status).toBe('skipped');
    expect(skipped.note).toContain('不可修改');
    // 模型调用：a 三轮重试＋b 一轮＝4；revoked 零调用（skipped 不烧模型）。
    expect(titleRegenModel.runCalls).toHaveLength(4);
  });

  it('没有不合规资产时是空轮：零项、零模型调用、不留备份目录', async () => {
    const uid = 'user-clean-title-regen-empty';
    const { cleanup } = await modules();
    await seedAsset(uid, '命名规范：动词开头、限定范围。');
    const report = await cleanup.runAssetTitleRegenCleanup(uid);
    expect(report.round).toBe('title_regen');
    expect(report.finishedAt).toBeTruthy();
    expect(report.items).toEqual([]);
    expect(report.backupDir).toBeUndefined();
    expect(titleRegenModel.runCalls).toHaveLength(0);
  });

  it('规则轮与新轮分列：runAssetCleanup 报告 round=rules，语义互不复用', async () => {
    const uid = 'user-clean-title-regen-rounds';
    const { cleanup } = await modules();
    await seedAsset(uid, '命名规范：动词开头、限定范围。');
    const rules = await cleanup.runAssetCleanup(uid);
    expect(rules.round).toBe('rules');
    expect(rules.items.every((item) => item.kind !== 'title_regen')).toBe(true);
  });
});

describe('完整整理轮（三轮合一 + 2026-09-29 候选正文改写轮 → 一个「整理」）', () => {
  it('合并报告 round=full 汇总分轮 items，分轮照常落盘但列表只露合并报告', async () => {
    const uid = 'user-clean-full';
    const { cleanup } = await modules();
    // 规则轮处理对象：结尾句读不规范的标题（真机上唯一能落盘的不规范形态）。
    const asset = await seedAsset(uid, '完整整理样本：导出报表带时间戳。', '完整整理样本标题。');
    const report = await cleanup.runAssetFullCleanup(uid);
    expect(report.round).toBe('full');
    // 四份子报告：规则 + 重新起标题 + 改写正文 + 候选正文改写（54ff57a3 收口新增）。
    expect(report.subReportIds).toHaveLength(4);
    expect(report.finishedAt).toBeTruthy();
    // 规则轮成果进合并报告（items 与台账一一对应的凭据逐轮保留）。
    expect(report.items.some((item) => item.assetId === asset.id && item.kind === 'title_normalized')).toBe(true);
    // 分轮被标记 supersededBy：列表只露合并报告，历史不丢（盘上仍可读）。
    const listed = await cleanup.listCleanupReports(uid, 20);
    expect(listed.map((row) => row.id)).toEqual([report.id]);
    const sub = await cleanup.readCleanupReport(uid, report.subReportIds![0]!);
    expect(sub?.supersededBy).toBe(report.id);
  });

  it('模型未配置：两个 LLM 轮整轮失败如实上报进 roundErrors，规则轮成果不陪葬', async () => {
    const uid = 'user-clean-full-nomodel';
    const { cleanup } = await modules();
    titleRegenModel.configured = false;
    try {
      await seedAsset(uid, '无模型合并样本：导出报表带时间戳。', '无模型合并样本标题。');
      const report = await cleanup.runAssetFullCleanup(uid);
      expect(report.round).toBe('full');
      expect(report.items.some((item) => item.kind === 'title_normalized')).toBe(true);
      expect(report.roundErrors?.title_regen).toContain('尚未配置可用模型');
      expect(report.roundErrors?.statement_regen).toContain('尚未配置可用模型');
    } finally {
      titleRegenModel.configured = true;
    }
  });
});
