/**
 * v1/v2 语义与历史引用冻结（specs/015 · US-702 · T025）。
 *
 * 确认更新是**新增一版**，不是抹掉旧版：
 *   ① 确认前 v1 不变；确认后同 assetId 得 v2 且 `activeVersion='2'`；
 *   ② 历史引用仍读 v1——两条**独立载体**各断一次：已确认投影（`assetVersions`
 *      冻结指针 + 版本真删时冻结的内容副本 `assetVersionSnapshots`）与 KSTAR
 *      episode 的 `k.abilityAssetVersions`；
 *   ③ `readAbilityAssetVersionSnapshot` 读回 v1 内容**一字不差**（逐字相等，
 *      不是"包含"）；
 *   ④ 新任务按 `activeVersion` 读 v2（新投影钉住 v2，注入的是 v2 正文）；
 *   ⑤ 已冻结的引用在后续 v3 编辑之后仍然不变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  closeEmbedder: vi.fn(),
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-a';

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-candidate-version-semantics-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(async () => {
  try {
    await drainMainRuntimeForTest(UID);
  } finally {
    if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
    else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function modules() {
  const [candidates, assets, projections, promptInjection, episodeBuilder, episodeStore] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/prompt-injection'),
    import('../../../../src/main/features/kstar/episode-builder'),
    import('../../../../src/main/features/kstar/episode-store'),
  ]);
  return { candidates, assets, projections, promptInjection, episodeBuilder, episodeStore };
}

const V1_STATEMENT = '发布前必须核对回滚方案，并把它写在发布单里。';

/** 任务 A：用户确认一条 create 候选 → v1 资产（这是"任务实际用过的 v1"）。 */
async function seedVersionOne() {
  const { candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate(UID, {
    judgment: V1_STATEMENT,
    // 标题闸门（设计 3.2）：无 summary 兜底＝正文首句，过不了闸门。
    summary: '语义基线样本',
    suggestedType: 'rule',
    suggestedScope: 'project',
    sourceRefs: [{ kind: 'execution', id: 'exec-version-semantics' }],
  });
  return (await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' })).asset;
}

/** 任务 B：改进候选锚定"任务实际用过的 v1"。 */
async function proposeUpdate(assetId: string, input: { judgment: string; sourceId: string; targetVersionUsed?: string; action?: 'update' | 'limit_scope' }) {
  const { candidates } = await modules();
  return candidates.saveRecallCandidate(UID, {
    judgment: input.judgment,
    // 与种子标题同值：确认 update 不改 title，也就不触发「改 title 必刷新
    // 已确认投影」（设计 3.3）——本组用例钉的是「历史引用不被顺手刷新」。
    summary: '语义基线样本',
    suggestedType: 'rule',
    suggestedScope: 'project',
    suggestedAction: input.action || 'update',
    targetAssetId: assetId,
    ...(input.targetVersionUsed ? { targetVersionUsed: input.targetVersionUsed } : {}),
    sourceRefs: [{ kind: 'execution_evaluation', id: input.sourceId }],
  });
}

/** 载体一：已确认投影（真实路径 preview → confirm，版本指针在确认时冻结）。 */
async function confirmProjectionPinnedTo(assetId: string, conversationId: string, taskRunId: string) {
  const { projections } = await modules();
  const preview = await projections.previewContextProjection(UID, {
    taskRunId,
    conversationId,
    purpose: 'project',
    explicitAssetIds: [assetId],
  });
  const confirmed = await projections.confirmContextProjection(UID, preview.id);
  return confirmed;
}

/** 载体二：KSTAR episode（用生产构建器写下"任务用了资产@v1"）。 */
async function persistEpisodeUsingVersion(assetId: string, version: string, projectionId: string) {
  const { episodeBuilder, episodeStore } = await modules();
  const startedAtMs = Date.parse('2026-09-20T00:00:00.000Z');
  const episode = episodeBuilder.buildGroupKstarEpisode({
    userId: UID,
    runId: 'run-version-semantics',
    conversationId: 'cid-version-semantics',
    status: 'completed',
    startedAtMs,
    finishedAtMs: startedAtMs + 60_000,
    projectionId,
    messages: [
      { id: 'msg-vs-user', ts: '2026-09-20T00:00:01.000Z', from: 'user', to: [], text: '按这条规则做一次发布前检查。' },
      {
        id: 'msg-vs-agent', ts: '2026-09-20T00:00:30.000Z', from: 'commander', to: [], text: '检查完成。',
        recall_citations: [{ asset_id: assetId, version, projection_id: projectionId }],
      },
    ],
  });
  await episodeStore.writeKstarEpisode(UID, episode);
  return episode;
}

describe('v1/v2 语义与历史引用冻结（T025）', () => {
  it('确认前 v1 不变；确认后同 assetId 得 v2 + activeVersion=2，v1 内容逐字留在版本流里', async () => {
    const { candidates, assets } = await modules();
    const v1 = await seedVersionOne();
    // 新建资产时 activeVersion 缺省 = 跟随最新（v1），不是显式写 '1'。
    expect(v1.version).toBe('1');
    expect(v1.activeVersion ?? v1.version).toBe('1');

    const update = await proposeUpdate(v1.id, {
      judgment: '发布前必须核对回滚方案，并把它写在发布单里；回滚演练也要留记录。',
      sourceId: 'run-semantics-basic',
      targetVersionUsed: '1',
    });
    // 确认前：候选只是待处理，资产分毫不动（没有"预生效"）。
    expect(update.status).toBe('pending_review');
    const before = await assets.readAbilityAsset(UID, v1.id);
    expect(before).toMatchObject({ version: '1', statement: V1_STATEMENT });
    expect((await assets.listAbilityAssetVersions(UID, v1.id)).map((row) => row.version)).toEqual(['1']);

    const promoted = await candidates.promoteRecallCandidate(UID, update.id, { actor: 'user' });

    // 确认后：同一 assetId 上的新版本（不是新资产）。
    expect(promoted.asset.id).toBe(v1.id);
    expect(promoted.asset).toMatchObject({ version: '2', activeVersion: '2' });
    expect(promoted.asset.statement).toContain('回滚演练也要留记录');
    expect((await assets.listAbilityAssetVersions(UID, v1.id)).map((row) => row.version)).toEqual(['1', '2']);
    // v1 的内容快照一字不差（旧的引用随时能读回原样）。
    const v1Snapshot = await assets.readAbilityAssetVersionSnapshot(UID, v1.id, '1');
    expect(v1Snapshot!.statement).toBe(V1_STATEMENT);
    expect(v1Snapshot!.version).toBe('1');
    // 台账留痕：这次更新有审计行（actor=user）。
    expect((await assets.listAbilityAssetAudit(UID, v1.id)).some((row) => row.action === 'updated' && row.actor === 'user')).toBe(true);
  });

  it('历史引用仍读 v1：已确认投影的冻结指针与 content 副本、episode 的 abilityAssetVersions 都不被改写', async () => {
    const { candidates, assets, projections, episodeStore } = await modules();
    const v1 = await seedVersionOne();
    // 任务 A 的引用：一条钉在 v1 的已确认投影 + 一条 episode 版本锚。
    const projection = await confirmProjectionPinnedTo(v1.id, 'cid-semantics-refs', 'run-semantics-refs');
    expect(projection.assetVersions?.[v1.id]).toBe('1');
    const episode = await persistEpisodeUsingVersion(v1.id, '1', projection.id);
    expect(episode.k.abilityAssetVersions?.[v1.id]).toBe('1');

    const update = await proposeUpdate(v1.id, {
      judgment: '发布前必须核对回滚方案，并把它写在发布单里；回滚演练也要留记录。',
      sourceId: 'run-semantics-refs',
      targetVersionUsed: '1',
    });
    await candidates.promoteRecallCandidate(UID, update.id, { actor: 'user' });
    expect((await assets.readAbilityAsset(UID, v1.id)).version).toBe('2');

    // 载体一：投影仍写 v1——更新不会把已确认的历史引用"顺手刷新"成 v2。
    const storedProjection = await projections.readContextProjection(UID, projection.id);
    expect(storedProjection.assetVersions?.[v1.id]).toBe('1');
    // 老引用不会被悄悄跟到新版：committed 校验照旧按 v1 核，核不上就如实报错
    // （而不是把指针改成 v2 假装一直有效）。
    await expect(projections.validateCommittedProjectionAssetVersions(UID, storedProjection))
      .rejects.toThrow(/projection asset version changed/);
    // 载体二：episode 的版本锚仍是 v1（KStar 改进提案据此知道"改的是哪一版"）。
    const storedEpisode = await episodeStore.readKstarEpisode(UID, episode.id);
    expect(storedEpisode!.k.abilityAssetVersions).toEqual({ [v1.id]: '1' });
    // 两条载体各自独立地指向 v1，且 v1 的内容读得回来、一字不差。
    expect((await assets.readAbilityAssetVersionSnapshot(UID, v1.id, '1'))!.statement).toBe(V1_STATEMENT);
  });

  it('新任务按 activeVersion 读 v2；后续 v3 编辑后已冻结的引用（含版本真删时的投影副本）不变', async () => {
    const { candidates, assets, projections, promptInjection, episodeStore } = await modules();
    const v1 = await seedVersionOne();
    const projection = await confirmProjectionPinnedTo(v1.id, 'cid-semantics-refs', 'run-semantics-refs');
    const episode = await persistEpisodeUsingVersion(v1.id, '1', projection.id);
    // limit_scope（范围收窄）不融合旧正文：正文整段替换，新旧两版能一眼分清。
    const NARROWED_STATEMENT = '只在正式发布评审里核对回滚方案；日常发布不需要这条。';
    const update = await proposeUpdate(v1.id, {
      judgment: NARROWED_STATEMENT,
      sourceId: 'run-semantics-new-task',
      targetVersionUsed: '1',
      action: 'limit_scope',
    });
    const promoted = await candidates.promoteRecallCandidate(UID, update.id, { actor: 'user' });
    const v2Statement = promoted.asset.statement;
    expect(v2Statement).toBe(NARROWED_STATEMENT);

    // 新任务：新投影按 activeVersion 钉住 v2，注入的是 v2 正文（不是 v1）。
    const fresh = await projections.previewContextProjection(UID, {
      taskRunId: 'run-semantics-fresh',
      conversationId: 'cid-semantics-fresh',
      purpose: 'project',
      explicitAssetIds: [v1.id],
    });
    expect(fresh.assetVersions?.[v1.id]).toBe('2');
    await projections.confirmContextProjection(UID, fresh.id);
    expect((await assets.readAbilityAssetVersionSnapshot(UID, v1.id, '2'))!.statement).toBe(v2Statement);
    const promptContext = await promptInjection.buildRecallTurnPromptContext(UID, {
      cid: 'cid-semantics-fresh',
      taskRunId: 'run-semantics-fresh',
      taskText: '做一次发布前检查。',
      committedProjectionId: fresh.id,
    });
    expect(promptContext.promptBlock).toContain(v2Statement);
    expect(promptContext.promptBlock).not.toContain(V1_STATEMENT);

    // 后来又改了一版（v3）：已冻结的引用必须一动不动。
    const v3 = await assets.updateAbilityAsset(UID, v1.id, {
      statement: '第三版正文。', reason: 'later edit', actor: 'user',
    });
    expect(v3).toMatchObject({ version: '3', activeVersion: '3' });
    expect((await assets.listAbilityAssetVersions(UID, v1.id)).map((row) => row.version)).toEqual(['1', '2', '3']);
    expect((await assets.readAbilityAssetVersionSnapshot(UID, v1.id, '1'))!.statement).toBe(V1_STATEMENT);
    expect((await projections.readContextProjection(UID, projection.id)).assetVersions?.[v1.id]).toBe('1');
    expect((await episodeStore.readKstarEpisode(UID, episode.id))!.k.abilityAssetVersions).toEqual({ [v1.id]: '1' });

    // 版本真删兜底：删掉 v1 之前，系统把它冻结进仍引用它的已确认投影——
    // 这就是"投影 assetVersionSnapshots"这条独立载体，内容是 v1 原文。
    await assets.deleteAbilityAssetVersion(UID, v1.id, '1', { actor: 'user', reason: 'test: freeze then delete v1' });
    expect(await assets.readAbilityAssetVersionSnapshot(UID, v1.id, '1')).toBeNull();
    const frozen = (await projections.readContextProjection(UID, projection.id)).assetVersionSnapshots?.[v1.id];
    expect(frozen!.version).toBe('1');
    expect(frozen!.snapshot.statement).toBe(V1_STATEMENT);
    // 删除只动版本流，不动在用内容。
    expect((await assets.readAbilityAsset(UID, v1.id)).statement).toBe('第三版正文。');
  });
});
