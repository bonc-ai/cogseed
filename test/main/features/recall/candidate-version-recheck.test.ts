/**
 * 候选确认的**版本重检**（specs/015 · US-702 · T026，口径来自 plan.md D6/D7 与
 * `contracts/ipc.md` §二）。
 *
 * 守四条：
 *   ① 候选锚定的版本与当前在用版一致 → 正常生效为下一版，版本流与台账留痕；
 *   ② 不一致 → **结构化冲突**（字段名对齐 specs/008）+ 候选非终态 + 资产零改动
 *      + 无静默覆盖（把候选内容套到用户后来改的版本上就是静默覆盖）；
 *   ③ `targetVersionUsed` 缺省（存量候选）→ 不重检、照常确认，但如实回
 *      `versionCheckSkipped: true`（渲染层据此提示"无法核对改进对象"）；
 *   ④ 比对只有一处：`updateAbilityAsset` 锁内（`asset-service.ts` 的
 *      `expectedVersion`）——所以"确认前他处改了资产"在**任何时序**下都不会被越过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import { trustedIpcSender } from '../../../helpers/trusted-ipc-sender';

// 语义查重不依赖真实 embedding 模型（与 candidate-service.test.ts 同款：
// 不同文本向量不同 → 查重走 no_match，晋升不被相似闸门挡住）。
vi.mock('../../../../src/main/features/kb_embed', () => ({
  closeEmbedder: vi.fn(),
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

// 只有 IPC 契约那一条用例需要 Electron；其余用例走真实 feature 模块（不 mock
// electron 也一样跑），这里给出最小替身，仅为把 `cogseed.invoke` 处理器接出来。
type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
  screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 100, height: 100 } })) },
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-candidate-version-recheck-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(async () => {
  try {
    await drainMainRuntimeForTest('user-a');
  } finally {
    if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
    else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function service() {
  const [candidates, assets, reviewDecisions] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/cognition/review-decision'),
  ]);
  return { candidates, assets, reviewDecisions };
}

/** 用户确认一条 create 候选 → 得到 v1 资产（这就是"任务 A 用过的 v1"）。 */
async function seedAsset(uid: string, judgment: string) {
  const { candidates } = await service();
  const candidate = await candidates.saveRecallCandidate(uid, {
    judgment,
    // 标题闸门（设计 3.2）：无 summary 兜底＝正文首句，过不了闸门。
    summary: '版本重检基线',
    suggestedType: 'rule',
    suggestedScope: 'project',
    sourceRefs: [{ kind: 'execution', id: `exec-${uid}` }],
  });
  return (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
}

/** 更新型候选（KStar 改进提案的落点）：锚定"任务实际用过的版本"。 */
async function saveUpdateCandidate(
  uid: string,
  target: { id: string; type: string },
  input: { judgment: string; sourceId: string; targetVersionUsed?: string; action?: 'update' | 'limit_scope'; summary?: string },
) {
  const { candidates } = await service();
  return candidates.saveRecallCandidate(uid, {
    judgment: input.judgment,
    summary: input.summary || '更新型候选样本',
    suggestedType: target.type as 'rule',
    suggestedScope: 'project',
    suggestedAction: input.action || 'update',
    targetAssetId: target.id,
    ...(input.targetVersionUsed ? { targetVersionUsed: input.targetVersionUsed } : {}),
    sourceRefs: [{ kind: 'execution_evaluation', id: input.sourceId }],
  });
}

async function catchPromotion(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promotion to be rejected');
}

/** 决定账本里的重锚痕（`rebasedFrom` 是锁内比对通过后才追加的字段，
 *  `ReviewDecision` 的公共类型里没有它——账本按追加写，不为一个审计附加信息
 *  去改所有读口的类型）。 */
function rebasedTraces(rows: readonly unknown[]): Array<{ rebasedFrom?: string; asset_id?: string; outcome?: string }> {
  return rows
    .map((row) => row as { rebasedFrom?: string; asset_id?: string; outcome?: string })
    .filter((row) => row.rebasedFrom !== undefined);
}

/** 重锚用例的"当前正文"（用户在候选生成之后自己改出来的 v2）。
 *  两句都刻意与 v1/候选判断错开，好把"融合主体是哪一版"钉死。 */
const V1_BODY = '发布前必须核对回滚方案。';
const EDITED_BODY = '发布前必须核对灰度名单。\n灰度发布前先跑一次冒烟用例。';

/** 历史引用载体（手法沿用 candidate-version-semantics.test.ts：已确认投影的
 *  冻结指针 + KSTAR episode 的版本锚），只在 T027 的重锚用例里用。 */
async function historyModules() {
  const [assets, projections, episodeBuilder, episodeStore] = await Promise.all([
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/kstar/episode-builder'),
    import('../../../../src/main/features/kstar/episode-store'),
  ]);
  return { assets, projections, episodeBuilder, episodeStore };
}

async function pinReferencesToVersionOne(uid: string, assetId: string) {
  const { projections, episodeBuilder, episodeStore } = await historyModules();
  const preview = await projections.previewContextProjection(uid, {
    taskRunId: 'run-rebase-refs',
    conversationId: 'cid-rebase-refs',
    purpose: 'project',
    explicitAssetIds: [assetId],
  });
  const projection = await projections.confirmContextProjection(uid, preview.id);
  const startedAtMs = Date.parse('2026-09-21T00:00:00.000Z');
  const episode = episodeBuilder.buildGroupKstarEpisode({
    userId: uid,
    runId: 'run-rebase-refs',
    conversationId: 'cid-rebase-refs',
    status: 'completed',
    startedAtMs,
    finishedAtMs: startedAtMs + 60_000,
    projectionId: projection.id,
    messages: [
      { id: 'msg-rebase-user', ts: '2026-09-21T00:00:01.000Z', from: 'user', to: [], text: '按这条规则做一次发布前检查。' },
      {
        id: 'msg-rebase-agent', ts: '2026-09-21T00:00:30.000Z', from: 'commander', to: [], text: '检查完成。',
        recall_citations: [{ asset_id: assetId, version: '1', projection_id: projection.id }],
      },
    ],
  });
  await episodeStore.writeKstarEpisode(uid, episode);
  return { projection, episode };
}

describe('候选确认版本重检（T020/T021）', () => {
  it('锚定版本一致：锁内重检通过 → 生效为 v2，版本流与台账留痕', async () => {
    const uid = 'user-a';
    const { candidates, assets } = await service();
    const asset = await seedAsset(uid, '发布前必须核对回滚方案。');
    const update = await saveUpdateCandidate(uid, asset, {
      judgment: '发布前必须核对回滚方案与回滚演练记录。',
      sourceId: 'run-recheck-match',
      targetVersionUsed: '1',
    });
    // 确认前：候选待处理，资产仍在 v1（没有任何"预生效"）。
    expect(update.status).toBe('pending_review');
    expect(update.targetVersionUsed).toBe('1');
    expect((await assets.readAbilityAsset(uid, asset.id)).version).toBe('1');

    const promoted = await candidates.promoteRecallCandidate(uid, update.id, { actor: 'user' });

    expect(promoted.asset).toMatchObject({ id: asset.id, version: '2', activeVersion: '2' });
    expect(promoted.candidate.status).toBe('confirmed');
    // 核对过就不是"跳过"——不出现 versionCheckSkipped。
    expect(promoted.versionCheckSkipped).toBeUndefined();
    // 台账留痕：版本流有 v1/v2 两行，审计有这次更新（actor=user）。
    expect((await assets.listAbilityAssetVersions(uid, asset.id)).map((row) => row.version)).toEqual(['1', '2']);
    const audit = await assets.listAbilityAssetAudit(uid, asset.id);
    expect(audit.filter((row) => row.action === 'updated')).toHaveLength(1);
    expect(audit.find((row) => row.action === 'updated')!.actor).toBe('user');
  });

  it('锚定版本不一致：结构化冲突 + 候选仍 pending_review + 资产零改动 + 无静默覆盖', async () => {
    const uid = 'user-a';
    const { candidates, assets, reviewDecisions } = await service();
    const asset = await seedAsset(uid, '发布前必须核对回滚方案。');
    const update = await saveUpdateCandidate(uid, asset, {
      judgment: '发布前必须核对回滚方案与回滚演练记录。',
      sourceId: 'run-recheck-conflict',
      targetVersionUsed: '1',
    });
    // 别处（用户手改 / 另一条线）先动了这条资产。
    await assets.updateAbilityAsset(uid, asset.id, {
      statement: '用户自己改过的正文。', reason: 'user edit', actor: 'user',
    });
    const userEdited = await assets.readAbilityAsset(uid, asset.id);
    expect(userEdited).toMatchObject({ version: '2', activeVersion: '2' });
    const auditBefore = (await assets.listAbilityAssetAudit(uid, asset.id)).length;
    const versionsBefore = await assets.listAbilityAssetVersions(uid, asset.id);

    const error = await catchPromotion(candidates.promoteRecallCandidate(uid, update.id, { actor: 'user' }));

    // 结构化冲突：字段名与 specs/008 的 versionConflict 逐字一致（+ 本链路的
    // targetVersionUsed），两边是同一个形状。
    expect((error as { code?: string }).code).toBe('recall_candidate_version_conflict');
    expect((error as { versionConflict?: unknown }).versionConflict).toEqual({
      baselineVersion: '1',
      currentVersion: '2',
      targetVersionUsed: '1',
    });
    // IPC 层用的就是同一个提取口（不靠 instanceof，也不在第二处重判版本）。
    expect(candidates.recallCandidateVersionConflictOf(error)).toEqual({
      baselineVersion: '1', currentVersion: '2', targetVersionUsed: '1',
    });
    // 不是版本冲突的错误不能被误认成冲突。
    expect(candidates.recallCandidateVersionConflictOf(new Error('ability asset version conflict: expected v1, current v2'))).toBeUndefined();

    // 候选非终态：仍待处理、没有失败码/失败时间（用户没做错什么，可以再确认）。
    const after = await candidates.readRecallCandidate(uid, update.id);
    expect(after.status).toBe('pending_review');
    expect(after.failureCode).toBeUndefined();
    expect(after.failedAt).toBeUndefined();
    // 资产零改动：还是用户改后的 v2 内容，候选的正文没有套上去。
    const assetAfter = await assets.readAbilityAsset(uid, asset.id);
    expect(assetAfter.statement).toBe('用户自己改过的正文。');
    expect(assetAfter.version).toBe('2');
    expect(assetAfter.statement).not.toContain('回滚演练记录');
    // 零改动是"盘上没写"，不是"看不出来"：版本流没多一行、台账没多一行。
    expect(await assets.listAbilityAssetVersions(uid, asset.id)).toEqual(versionsBefore);
    expect((await assets.listAbilityAssetAudit(uid, asset.id)).length).toBe(auditBefore);
    // 未生效的确认尝试要留痕（对齐 specs/008 的「未生效」一行）。
    const decisions = await reviewDecisions.listReviewDecisions(uid, `recall_candidate:${update.id}`);
    expect(decisions.some((row) => row.failure_code === 'version_conflict')).toBe(true);
  });

  it('冲突后再次确认仍然冲突（不自动重试、不追认）：候选与资产都不动', async () => {
    const uid = 'user-a';
    const { candidates, assets } = await service();
    const asset = await seedAsset(uid, '导出报表一律带上生成时间戳。');
    const update = await saveUpdateCandidate(uid, asset, {
      judgment: '导出报表一律带上生成时间戳与导出人。',
      sourceId: 'run-recheck-twice',
      targetVersionUsed: '1',
    });
    await assets.updateAbilityAsset(uid, asset.id, { statement: '别处改过的正文。', reason: 'elsewhere', actor: 'user' });

    const first = await catchPromotion(candidates.promoteRecallCandidate(uid, update.id, { actor: 'user' }));
    const second = await catchPromotion(candidates.promoteRecallCandidate(uid, update.id, { actor: 'user' }));

    expect((first as { versionConflict?: unknown }).versionConflict).toEqual({
      baselineVersion: '1', currentVersion: '2', targetVersionUsed: '1',
    });
    expect((second as { versionConflict?: unknown }).versionConflict).toEqual({
      baselineVersion: '1', currentVersion: '2', targetVersionUsed: '1',
    });
    expect((await candidates.readRecallCandidate(uid, update.id)).status).toBe('pending_review');
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe('别处改过的正文。');
  });

  it('targetVersionUsed 缺省（存量候选）：不重检、照常确认，并如实回 versionCheckSkipped', async () => {
    const uid = 'user-a';
    const { candidates, assets } = await service();
    const asset = await seedAsset(uid, '先写结论再写理由。');
    // 存量候选：锚定字段从来没有（KStar 之前的改进提案就是这样）。
    const legacy = await saveUpdateCandidate(uid, asset, {
      judgment: '先写结论再写理由，最后给可执行动作。',
      sourceId: 'run-recheck-legacy',
    });
    expect(legacy.targetVersionUsed).toBeUndefined();
    // 即便如此，资产在他处被改过也照样确认（不重检 = 不拦），但要如实标注。
    await assets.updateAbilityAsset(uid, asset.id, { statement: '别处改过的正文。', reason: 'elsewhere', actor: 'user' });

    const promoted = await candidates.promoteRecallCandidate(uid, legacy.id, { actor: 'user' });

    expect(promoted.versionCheckSkipped).toBe(true);
    expect(promoted.candidate.status).toBe('confirmed');
    expect(promoted.asset).toMatchObject({ id: asset.id, version: '3' });
    expect(promoted.asset.statement).toContain('可执行动作');
  });

  it('limit_scope 同款：一致则在锁定版本上生效，不一致则结构化冲突', async () => {
    const uid = 'user-a';
    const { candidates, assets } = await service();
    const matched = await seedAsset(uid, '只在正式评审里核对回滚方案。');
    const matchedCandidate = await saveUpdateCandidate(uid, matched, {
      judgment: '只在正式评审与上线评审里核对回滚方案。',
      sourceId: 'run-recheck-limit-match',
      targetVersionUsed: '1',
      action: 'limit_scope',
    });
    const narrowed = await candidates.promoteRecallCandidate(uid, matchedCandidate.id, { actor: 'user' });
    expect(narrowed.asset).toMatchObject({ id: matched.id, version: '2', activeVersion: '2' });
    expect(narrowed.versionCheckSkipped).toBeUndefined();

    const conflicted = await seedAsset(uid, '只在内部对齐里使用这套模板。');
    const conflictedCandidate = await saveUpdateCandidate(uid, conflicted, {
      judgment: '只在内部对齐与小型发布里使用这套模板。',
      sourceId: 'run-recheck-limit-conflict',
      targetVersionUsed: '1',
      action: 'limit_scope',
    });
    await assets.updateAbilityAsset(uid, conflicted.id, { statement: '别处改过的正文。', reason: 'elsewhere', actor: 'user' });

    const error = await catchPromotion(candidates.promoteRecallCandidate(uid, conflictedCandidate.id, { actor: 'user' }));
    expect((error as { versionConflict?: unknown }).versionConflict).toEqual({
      baselineVersion: '1', currentVersion: '2', targetVersionUsed: '1',
    });
    expect((await candidates.readRecallCandidate(uid, conflictedCandidate.id)).status).toBe('pending_review');
    expect((await assets.readAbilityAsset(uid, conflicted.id)).statement).toBe('别处改过的正文。');
  });

  it('并发确认同一目标的候选：先落地的赢，后到的撞冲突——没有静默覆盖', async () => {
    const uid = 'user-a';
    const { candidates, assets } = await service();
    const asset = await seedAsset(uid, '重构前先补齐回归用例。');
    // 两条改进候选都锚定 v1（真实场景：同一轮里两个任务各自提出改进）。
    const first = await saveUpdateCandidate(uid, asset, {
      judgment: '重构前先补齐回归用例并跑通一次。',
      sourceId: 'run-race-first',
      targetVersionUsed: '1',
    });
    const second = await saveUpdateCandidate(uid, asset, {
      judgment: '重构前先补齐回归用例并留一份基线快照。',
      sourceId: 'run-race-second',
      targetVersionUsed: '1',
    });

    const settled = await Promise.allSettled([
      candidates.promoteRecallCandidate(uid, first.id, { actor: 'user' }),
      candidates.promoteRecallCandidate(uid, second.id, { actor: 'user' }),
    ]);
    const ok = settled.filter((row) => row.status === 'fulfilled');
    const failed = settled.filter((row) => row.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // 输的那条是结构化冲突，不是"写了一半"。
    expect(candidates.recallCandidateVersionConflictOf((failed[0] as PromiseRejectedResult).reason)).toMatchObject({
      baselineVersion: '1', currentVersion: '2', targetVersionUsed: '1',
    });
    // 资产落在赢家的内容上，且只有 v2（没有把两条候选串成 v3）。
    const finalAsset = await assets.readAbilityAsset(uid, asset.id);
    expect(finalAsset.version).toBe('2');
    expect(finalAsset.statement).toContain('回归用例');
    expect((await assets.listAbilityAssetVersions(uid, asset.id)).map((row) => row.version)).toEqual(['1', '2']);
    // 输的那条候选仍可再次处置（非终态），用户不会被"卡死"。
    const loser = settled[0].status === 'rejected' ? first : second;
    const winner = settled[0].status === 'fulfilled' ? first : second;
    expect((await candidates.readRecallCandidate(uid, loser.id)).status).toBe('pending_review');
    expect((await candidates.readRecallCandidate(uid, winner.id)).status).toBe('confirmed');
  });
});

describe('promote 通道的 IPC 契约（T021 / contracts/ipc.md §二）', () => {
  it('冲突回 ok:false + state:pending + versionConflict（候选仍待处理、资产零改动）；缺省回 versionCheckSkipped', async () => {
    const uid = 'user-a';
    vi.doMock('../../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
    const users = await import('../../../../src/main/features/users');
    users.activateUser(uid);
    // 真链路：ipc handler → capture-service → candidate-service → asset-service。
    (await import('../../../../src/main/ipc/index')).register();
    if (!invokeHandler) throw new Error('missing cogseed.invoke handler');
    const call = (channel: string, payload: unknown = {}) =>
      invokeHandler!({ sender: trustedIpcSender() }, { channel, payload });

    const { candidates, assets } = await service();
    const asset = await seedAsset(uid, '上线前先跑一次冒烟。');
    const update = await saveUpdateCandidate(uid, asset, {
      judgment: '上线前先跑一次冒烟并留下结果。',
      sourceId: 'run-ipc-contract',
      targetVersionUsed: '1',
    });
    await assets.updateAbilityAsset(uid, asset.id, { statement: '别处改过的正文。', reason: 'elsewhere', actor: 'user' });

    const conflict = await call('recall.candidates.promote', { candidateId: update.id });
    expect(conflict).toEqual({
      ok: false,
      state: 'pending',
      versionConflict: { baselineVersion: '1', currentVersion: '2', targetVersionUsed: '1' },
      message: expect.stringContaining('没有生效'),
    });
    expect((await candidates.readRecallCandidate(uid, update.id)).status).toBe('pending_review');
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe('别处改过的正文。');

    // 缺省分支：存量候选（没有 targetVersionUsed）照常确认，并如实带
    // versionCheckSkipped——渲染层据此提示"无法核对改进对象"。
    const legacyAsset = await seedAsset(uid, '先对齐范围再动手。');
    const legacyUpdate = await saveUpdateCandidate(uid, legacyAsset, {
      judgment: '先对齐范围再动手，范围外先记下来。',
      sourceId: 'run-ipc-contract-legacy',
    });
    const confirmed = await call('recall.candidates.promote', { candidateId: legacyUpdate.id });
    expect(confirmed).toMatchObject({ ok: true, versionCheckSkipped: true, asset: { version: '2' } });
  });
});

/**
 * 版本冲突后的**显式重锚**（T027，`contracts/ipc.md` §二「实现期补充」，
 * `待总控确认.md` 2026-09-25 19:0x 按默认 A 推进）。
 *
 * 没有这条路径，用户"再次确认"会永远撞同一个冲突：冲突后他能做的只有看差异，
 * 看完了却没有任何方式把"我认可当前版"表达出来。重锚就是这句话的载体。
 *
 * 守五条：
 *   ① 不传 `confirmBaselineVersion` → 行为与重锚机制落地前**逐字一致**
 *      （仍比候选原锚，不一致即结构化冲突）；
 *   ② 传了且等于当前在用版 → 用**当前正文**重新融合落库为下一版，原锚进决定
 *      账本（`rebasedFrom`）并随返回体回传；
 *   ③ 传了但已不是当前在用版（确认前又被改过）→ 仍结构化冲突、资产零改动、
 *      候选非终态，且账本**不留**重锚痕（没生效就谈不上重锚）；
 *   ④ 重锚不静默改基线：候选自身的 `targetVersionUsed` 一个字不改，别的候选
 *      与未传参的调用照样按各自的原锚撞冲突；
 *   ⑤ 重锚不抹历史：v1 内容逐字可读，钉在 v1 的两条引用载体都不动。
 */
describe('版本冲突后的显式重锚（T027）', () => {
  it('未传 confirmBaselineVersion：仍是原口径的冲突（回归不变），账本不出现重锚痕', async () => {
    const uid = 'user-a';
    const { candidates, assets, reviewDecisions } = await service();
    const asset = await seedAsset(uid, V1_BODY);
    const update = await saveUpdateCandidate(uid, asset, {
      judgment: '发布前必须核对回滚方案与灰度名单。',
      sourceId: 'run-rebase-default',
      targetVersionUsed: '1',
    });
    await assets.updateAbilityAsset(uid, asset.id, {
      statement: '用户自己改过的正文。', reason: 'user edit', actor: 'user',
    });
    const versionsBefore = await assets.listAbilityAssetVersions(uid, asset.id);

    const error = await catchPromotion(candidates.promoteRecallCandidate(uid, update.id, { actor: 'user' }));

    expect((error as { versionConflict?: unknown }).versionConflict).toEqual({
      baselineVersion: '1', currentVersion: '2', targetVersionUsed: '1',
    });
    expect((await candidates.readRecallCandidate(uid, update.id)).status).toBe('pending_review');
    expect(await assets.listAbilityAssetVersions(uid, asset.id)).toEqual(versionsBefore);
    const decisions = await reviewDecisions.listReviewDecisions(uid, `recall_candidate:${update.id}`);
    expect(decisions.some((row) => row.failure_code === 'version_conflict')).toBe(true);
    // 没生效的尝试只有"未生效"记录，不能留下"重锚过"的痕迹。
    expect(rebasedTraces(decisions)).toHaveLength(0);
  });

  it('传了且等于当前在用版：用当前正文重新融合落库为下一版，账本记原锚、返回体带 rebasedFrom', async () => {
    const uid = 'user-a';
    const { candidates, assets, reviewDecisions } = await service();
    const asset = await seedAsset(uid, V1_BODY);
    const update = await saveUpdateCandidate(uid, asset, {
      judgment: '发布前必须核对灰度名单与演练记录。',
      sourceId: 'run-rebase-fuse',
      targetVersionUsed: '1',
    });
    // 用户在候选生成之后自己改过正文（v2）：这就是重锚要融合的"当前正文"。
    await assets.updateAbilityAsset(uid, asset.id, {
      statement: EDITED_BODY, reason: 'user edit', actor: 'user',
    });

    const promoted = await candidates.promoteRecallCandidate(uid, update.id, {
      actor: 'user',
      confirmBaselineVersion: '2',
    });

    expect(promoted.asset).toMatchObject({ id: asset.id, version: '3', activeVersion: '3' });
    // 融合主体是**当前正文**（v2），不是候选原锚那一版（v1）：
    //   · v2 独有的句子被保留 → 证明"当前正文"真的参与了融合；
    //   · v1 独有的句子一个字都不许进来 → 证明没有拿旧正文糊当前版。
    expect(promoted.asset.statement).toContain('灰度发布前先跑一次冒烟用例');
    expect(promoted.asset.statement).toContain('演练记录');
    expect(promoted.asset.statement).not.toContain('回滚方案');
    // 重锚是把基线显式换到当前版，不是"跳过核对"。
    expect(promoted.rebasedFrom).toBe('1');
    expect(promoted.versionCheckSkipped).toBeUndefined();
    // 决定账本：同一 decision 上追加原锚，且没有把终态顶掉（asset_id/outcome 都在）。
    const decisions = await reviewDecisions.listReviewDecisions(uid, `recall_candidate:${update.id}`);
    const traces = rebasedTraces(decisions);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ rebasedFrom: '1', asset_id: asset.id, outcome: 'asset_created' });
    expect(decisions.find((row) => row.asset_id === asset.id)?.failure_code).toBeUndefined();
    // 版本流如实：v1/v2/v3 都在（重锚没有回退或抹掉任何一版）。
    expect((await assets.listAbilityAssetVersions(uid, asset.id)).map((row) => row.version)).toEqual(['1', '2', '3']);
  });

  it('确认前资产又被改到 v3：带 v2 重锚仍是结构化冲突、零改动、候选非终态、不留重锚痕', async () => {
    const uid = 'user-a';
    const { candidates, assets, reviewDecisions } = await service();
    const asset = await seedAsset(uid, V1_BODY);
    const update = await saveUpdateCandidate(uid, asset, {
      judgment: '发布前必须核对灰度名单与演练记录。',
      sourceId: 'run-rebase-stale',
      targetVersionUsed: '1',
    });
    // 两条改线：用户手改 → v2，另一条线又改 → v3（用户看差异时看到的是 v2）。
    await assets.updateAbilityAsset(uid, asset.id, { statement: EDITED_BODY, reason: 'user edit', actor: 'user' });
    await assets.updateAbilityAsset(uid, asset.id, { statement: '第三版正文。', reason: 'another edit', actor: 'user' });
    const versionsBefore = await assets.listAbilityAssetVersions(uid, asset.id);
    const auditBefore = (await assets.listAbilityAssetAudit(uid, asset.id)).length;

    const error = await catchPromotion(candidates.promoteRecallCandidate(uid, update.id, {
      actor: 'user',
      confirmBaselineVersion: '2',
    }));

    // 冲突里说的仍是"候选基于 v1"，当前在用 v3：字段含义不因重锚而变形，
    // 渲染层按同一套字段名处理第二次冲突（再取一次当前正文重新展示差异）。
    expect((error as { versionConflict?: unknown }).versionConflict).toEqual({
      baselineVersion: '1', currentVersion: '3', targetVersionUsed: '1',
    });
    expect((error as { code?: string }).code).toBe('recall_candidate_version_conflict');
    // 候选非终态 + 资产零改动（不是"半生效"）。
    const after = await candidates.readRecallCandidate(uid, update.id);
    expect(after.status).toBe('pending_review');
    expect(after.failureCode).toBeUndefined();
    const assetAfter = await assets.readAbilityAsset(uid, asset.id);
    expect(assetAfter).toMatchObject({ version: '3', statement: '第三版正文。' });
    expect(await assets.listAbilityAssetVersions(uid, asset.id)).toEqual(versionsBefore);
    expect((await assets.listAbilityAssetAudit(uid, asset.id)).length).toBe(auditBefore);
    // 未生效的尝试照旧留"未生效"痕，但没有重锚痕。
    const decisions = await reviewDecisions.listReviewDecisions(uid, `recall_candidate:${update.id}`);
    expect(decisions.some((row) => row.failure_code === 'version_conflict')).toBe(true);
    expect(rebasedTraces(decisions)).toHaveLength(0);
  });

  it('重锚不静默改基线：候选原锚不被改写，未传参的调用照样按原锚撞冲突', async () => {
    const uid = 'user-a';
    const { candidates, assets } = await service();
    const asset = await seedAsset(uid, V1_BODY);
    await assets.updateAbilityAsset(uid, asset.id, { statement: EDITED_BODY, reason: 'user edit', actor: 'user' });
    // 两条候选都在"资产还是 v1"时提出（真实场景：同一轮里两个任务各自提改进）。
    const rebased = await saveUpdateCandidate(uid, asset, {
      judgment: '发布前必须核对灰度名单与演练记录。',
      sourceId: 'run-rebase-explicit',
      targetVersionUsed: '1',
    });
    const waiting = await saveUpdateCandidate(uid, asset, {
      judgment: '发布前必须核对灰度名单并标出负责人。',
      sourceId: 'run-rebase-untouched',
      targetVersionUsed: '1',
    });

    // 只有显式传参的那一条被重锚。
    const promoted = await candidates.promoteRecallCandidate(uid, rebased.id, {
      actor: 'user', confirmBaselineVersion: '2',
    });
    expect(promoted.rebasedFrom).toBe('1');
    expect(promoted.asset.version).toBe('3');

    // 候选自身的锚是"提议时用的是哪一版"这一历史事实，不因重锚被改写——
    // 否则下一次比对就会拿被改过的锚去撞，静默漂移失去意义。
    expect((await candidates.readRecallCandidate(uid, rebased.id)).targetVersionUsed).toBe('1');
    // 另一条候选没被顺带重锚：它没传参，就照原锚撞冲突（重锚只在显式传参时发生）。
    const error = await catchPromotion(candidates.promoteRecallCandidate(uid, waiting.id, { actor: 'user' }));
    expect((error as { versionConflict?: unknown }).versionConflict).toEqual({
      baselineVersion: '1', currentVersion: '3', targetVersionUsed: '1',
    });
    expect((await candidates.readRecallCandidate(uid, waiting.id)).status).toBe('pending_review');
    expect((await candidates.readRecallCandidate(uid, waiting.id)).targetVersionUsed).toBe('1');
    // 撞冲突不会动资产：还是重锚后的 v3。
    const finalAsset = await assets.readAbilityAsset(uid, asset.id);
    expect(finalAsset.version).toBe('3');
    expect(finalAsset.statement).toContain('冒烟用例');
  });

  it('重锚不抹历史：v1 内容逐字可读，钉在 v1 的已确认投影与任务 episode 都不被改写', async () => {
    const uid = 'user-a';
    const { candidates, assets } = await service();
    const { projections, episodeStore } = await historyModules();
    const asset = await seedAsset(uid, V1_BODY);
    const { projection, episode } = await pinReferencesToVersionOne(uid, asset.id);
    expect(projection.assetVersions?.[asset.id]).toBe('1');
    expect(episode.k.abilityAssetVersions?.[asset.id]).toBe('1');

    const update = await saveUpdateCandidate(uid, asset, {
      judgment: '发布前必须核对灰度名单与演练记录。',
      // 该用例钉「重锚不刷新已确认投影」：summary 与种子标题一致 → 晋升
      // update 不改 title → 不触发「改 title 必刷新投影」（设计 3.3）。
      summary: '版本重检基线',
      sourceId: 'run-rebase-refs',
      targetVersionUsed: '1',
    });
    await assets.updateAbilityAsset(uid, asset.id, { statement: EDITED_BODY, reason: 'user edit', actor: 'user' });

    const promoted = await candidates.promoteRecallCandidate(uid, update.id, {
      actor: 'user', confirmBaselineVersion: '2',
    });
    expect(promoted.rebasedFrom).toBe('1');
    expect(promoted.asset.version).toBe('3');

    // v1 的内容一字不差地躺在版本流里——重锚只是把改动落到新的一版。
    const v1Snapshot = await assets.readAbilityAssetVersionSnapshot(uid, asset.id, '1');
    expect(v1Snapshot!.statement).toBe(V1_BODY);
    expect(v1Snapshot!.version).toBe('1');
    // 两条独立载体各断一次：重锚不会把已确认的历史引用"顺手刷新"成新版本。
    expect((await projections.readContextProjection(uid, projection.id)).assetVersions?.[asset.id]).toBe('1');
    expect((await episodeStore.readKstarEpisode(uid, episode.id))!.k.abilityAssetVersions).toEqual({ [asset.id]: '1' });
  });
});

describe('promote 通道的显式重锚 IPC 契约（T027 / contracts/ipc.md §二）', () => {
  it('非法 confirmBaselineVersion 抛 invalid 且零落盘；合法重锚走通并在返回体带 rebasedFrom', async () => {
    const uid = 'user-a';
    vi.doMock('../../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
    const users = await import('../../../../src/main/features/users');
    users.activateUser(uid);
    (await import('../../../../src/main/ipc/index')).register();
    if (!invokeHandler) throw new Error('missing cogseed.invoke handler');
    const call = (channel: string, payload: unknown = {}) =>
      invokeHandler!({ sender: trustedIpcSender() }, { channel, payload });

    const { candidates, assets, reviewDecisions } = await service();
    const asset = await seedAsset(uid, V1_BODY);
    const update = await saveUpdateCandidate(uid, asset, {
      judgment: '发布前必须核对灰度名单与演练记录。',
      sourceId: 'run-ipc-rebase',
      targetVersionUsed: '1',
    });

    // 非法形状（非数字串 / 超长 / 不是字符串）→ invalid，且零落盘：
    // 候选没动、资产没动、连一条审查决定都没写（校验在落盘之前）。
    // （协议分发层把 handler 的 throw 统一转成 {ok:false, code:'E_UNKNOWN'}，
    // 与全库 ipc 断言风格一致用 resolves 断言，见 test/main/ipc/recall.test.ts 先例。）
    await expect(call('recall.candidates.promote', { candidateId: update.id, confirmBaselineVersion: 'v2' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid confirm baseline version' });
    await expect(call('recall.candidates.promote', { candidateId: update.id, confirmBaselineVersion: '1'.repeat(10) }))
      .resolves.toMatchObject({ ok: false, error: 'invalid confirm baseline version' });
    await expect(call('recall.candidates.promote', { candidateId: update.id, confirmBaselineVersion: 2 }))
      .resolves.toMatchObject({ ok: false, error: 'invalid confirm baseline version' });
    expect((await candidates.readRecallCandidate(uid, update.id)).status).toBe('pending_review');
    expect((await assets.readAbilityAsset(uid, asset.id)).version).toBe('1');
    expect(await reviewDecisions.listReviewDecisions(uid, `recall_candidate:${update.id}`)).toEqual([]);

    // 用户手改了资产 → 第一次确认撞冲突（渲染层据此提示 + 按当前版重新展示差异）。
    await assets.updateAbilityAsset(uid, asset.id, { statement: EDITED_BODY, reason: 'user edit', actor: 'user' });
    const conflict = await call('recall.candidates.promote', { candidateId: update.id });
    expect(conflict).toMatchObject({
      ok: false,
      state: 'pending',
      versionConflict: { baselineVersion: '1', currentVersion: '2', targetVersionUsed: '1' },
    });

    // 「按当前版本重新确认」：带上当前在用版 → 这次生效，且返回体如实带原锚，
    // 让渲染层能告诉用户"这一条是从 v1 重锚过来的"。
    const rebased = await call('recall.candidates.promote', { candidateId: update.id, confirmBaselineVersion: '2' });
    expect(rebased).toMatchObject({
      ok: true,
      rebasedFrom: '1',
      asset: { id: asset.id, version: '3', activeVersion: '3' },
    });
    expect((rebased as { asset: { statement: string } }).asset.statement).toContain('灰度发布前先跑一次冒烟用例');
    expect((await candidates.readRecallCandidate(uid, update.id)).status).toBe('confirmed');
  });
});
