/**
 * specs/016 T012：冻结副本读路径加固（prompt-injection.ts，data-model §4）。
 *
 * 现状硬缺陷（research D6 实测）：命中 `projection.assetVersionSnapshots` 的
 * 已确认投影仍无条件读 live 资产（evidenceRefs / 治理门 / 字段兜底全走
 * `readAbilityAsset`），而 live 记录不存在时它**抛错**，异常被装配层 catch
 * 吞成 warn ⇒ 冻结引用**静默缺席**——「记录没了 = 断链」。
 *
 * 本文件钉住迁移后的读行为：
 *  ① live 记录缺失（已迁出资产库）且冻结副本命中 → 注入**仍可读**，内容字段
 *     与证据引用全取副本，并在注入块标注「来源已迁入经验目录」；
 *  ② live 记录存在但已带迁出标记（migratedToExperienceId）→ 同样按副本供给；
 *  ③ 无快照的既有路径行为**完全不变**：live 正常 → 照旧走 live（无标注）；
 *     live 缺失且无副本 → 维持现状的缺席（warn 吞掉，不抛出）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-exp-frozen';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-experience-frozen-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [users, assets, projections, promptInjection, store] = await Promise.all([
    import('../../../../src/main/features/users'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/prompt-injection'),
    import('../../../../src/main/features/recall/store'),
  ]);
  users.activateUser(UID);
  return { users, assets, projections, promptInjection, store };
}

async function seedAsset(spec: { id: string; statement: string }) {
  const { assets } = await modules();
  const now = new Date().toISOString();
  return assets.createSystemAbilityAsset(UID, {
    schemaVersion: 1,
    ownerId: UID,
    id: spec.id,
    candidateId: `cand-${spec.id}`,
    title: `冻结读资产-${spec.id}`,
    statement: spec.statement,
    type: 'rule',
    scope: 'project',
    evidenceRefs: [{ kind: 'execution', id: `exec-${spec.id}` }],
    reviewDecisionId: 'legacy-untracked',
    lifecycleStatus: 'system_precipitated_unverified',
    status: 'active',
    // 夹具直接以 transfer_validated 落库（explicit 投影与注入闸门对 seed 档
    // 有 maturity 硬门——prompt-injection.test.ts 的同款处理）。
    maturity: 'transfer_validated',
    version: '1',
    learningProvenance: {
      projectionId: `prj-${spec.id}`,
      episodeId: `kse-${spec.id}`,
      ruleRefs: [],
      attribution: 'execution_gap' as const,
    },
    createdAt: now,
    updatedAt: now,
  }, 'frozen read test fixture');
}

async function confirmProjectionPinnedTo(assetId: string, cid: string, taskRunId: string) {
  const { projections } = await modules();
  const preview = await projections.previewContextProjection(UID, {
    taskRunId,
    conversationId: cid,
    purpose: 'project',
    explicitAssetIds: [assetId],
  });
  return projections.confirmContextProjection(UID, preview.id);
}

/** 走真实迁移线：冻结 → 写经验 → 物理迁出资产记录（live 从此缺失）。 */
async function migrateAway(assetId: string) {
  const { migration } = {
    migration: await import('../../../../src/main/features/recall/experience-migration'),
  };
  return migration.runExperienceMigration(UID, [assetId]);
}

/** 把投影挂到会话消息流（注入装配从会话消息里检索投影 id——
 *  projectionIdsForConversation 的既有口径，照 prompt-injection.test.ts）。 */
async function attachProjectionToConversation(projectionId: string, cid: string) {
  const storage = await import('../../../../src/main/storage');
  const layout = await import('../../../../src/main/util/project-layout');
  const messageFile = layout.conversationMessageFile(UID, cid);
  await fs.promises.mkdir(path.dirname(messageFile), { recursive: true });
  await storage.appendJsonlAtomic(messageFile, {
    id: `msg-${projectionId}`,
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: 'confirm projection',
    recall_projection_card: { projectionId },
  });
}

/** 会话注入（confirmed 投影路径——正是 T016 加固的装配函数）。 */
async function promptFor(cid: string) {
  const { promptInjection } = await modules();
  return promptInjection.buildConfirmedProjectionPromptContext(UID, cid);
}

function parseInjectedRecords(block: string): Array<Record<string, unknown>> {
  const line = block.split('\n').find((row) => row.startsWith('['));
  if (!line) return [];
  return JSON.parse(line) as Array<Record<string, unknown>>;
}

describe('frozen read after migration (T016 / SC-002)', () => {
  it('live 记录已迁出：命中冻结副本的已确认投影仍可读，内容与证据全取副本，并标注来源已迁入经验目录', async () => {
    await modules();
    const STATEMENT = '迁移后仍按当年确认的版本供给：冻结读专用正文 FROZEN-1a2b。';
    const asset = await seedAsset({ id: 'aa-frozen-0001', statement: STATEMENT });
    const baselineProjection = await confirmProjectionPinnedTo(asset.id, 'cid-frozen-0001', 'run-frozen-0001');
    await attachProjectionToConversation(baselineProjection.id, 'cid-frozen-0001');

    // 迁移前基线：live 在，正常注入（无迁移标注）。
    const before = await promptFor('cid-frozen-0001');
    const beforeRecord = parseInjectedRecords(before.promptBlock).find((row) => row.asset_id === asset.id);
    expect(beforeRecord).toBeDefined();
    expect(beforeRecord!.source_migrated).toBeUndefined();

    await migrateAway(asset.id);

    const after = await promptFor('cid-frozen-0001');
    const afterRecord = parseInjectedRecords(after.promptBlock).find((row) => row.asset_id === asset.id);
    // 不再静默缺席：这条已确认资产仍被注入。
    expect(afterRecord).toBeDefined();
    // 内容字段与迁移前逐字一致（title/statement/version/scope/applicable_when）。
    expect(afterRecord!.statement).toBe(beforeRecord!.statement);
    expect(afterRecord!.title).toBe(beforeRecord!.title);
    expect(afterRecord!.version).toBe(beforeRecord!.version);
    expect(afterRecord!.scope).toBe(beforeRecord!.scope);
    // 证据引用全取副本（live 已删，读 live 只会抛错被吞）。
    expect(afterRecord!.source_refs).toEqual(beforeRecord!.source_refs);
    // 如实标注：来源已迁入经验目录（迁移时点已判过治理，此处不重判）。
    expect(afterRecord!.source_migrated).toBe('experience_catalog');
    // citations 同样不断链。
    expect(after.citations.some((citation) => citation.assetId === asset.id)).toBe(true);
  });

  it('手工构造（迁移中间态）：冻结副本在投影里、live 记录被物理删除 → 注入仍可读（现状会静默缺席）', async () => {
    const { promptInjection, store, assets } = await modules();
    const asset = await seedAsset({ id: 'aa-frozen-0002', statement: '手工构造的冻结正文 MANUAL-FROZEN-9c8d。' });
    const projection = await confirmProjectionPinnedTo(asset.id, 'cid-frozen-0002', 'run-frozen-0002');
    await attachProjectionToConversation(projection.id, 'cid-frozen-0002');

    // 手工把确认版本的内容副本塞进投影（等价于迁移冻结步的产物；含
    // evidenceRefs——T015 冻结时写入的加法式可选字段）。
    await store.updateRecallJsonRecord(UID, 'projections', projection.id, (raw) => ({
      ...raw,
      assetVersionSnapshots: {
        [asset.id]: {
          version: '1',
          snapshot: {
            title: asset.title,
            statement: '手工构造的冻结正文 MANUAL-FROZEN-9c8d。',
            type: 'rule',
            scope: 'project',
            version: '1',
            evidenceRefs: [{ kind: 'conversation', id: `conv-${asset.id}` }],
          },
        },
      },
    }));
    // 物理删除 live 资产记录（迁移迁出步的效果；不经 createExperience，纯读路径考察）。
    await fs.promises.rm(
      (await import('../../../../src/main/features/recall/paths')).recallJsonRecordPath(UID, 'ability-assets', asset.id),
    );
    await expect(assets.readAbilityAsset(UID, asset.id)).rejects.toThrow(/not found/);

    const context = await promptFor('cid-frozen-0002');
    const record = parseInjectedRecords(context.promptBlock).find((row) => row.asset_id === asset.id);
    expect(record).toBeDefined();
    expect(record!.statement).toBe('手工构造的冻结正文 MANUAL-FROZEN-9c8d。');
    expect(record!.source_refs).toEqual([{ kind: 'conversation', id: `conv-${asset.id}` }]);
    expect(record!.source_migrated).toBe('experience_catalog');
  });

  it('live 记录存在但已带迁出标记（migratedToExperienceId）→ 同样按副本供给并标注', async () => {
    const { promptInjection, store, assets } = await modules();
    const asset = await seedAsset({ id: 'aa-frozen-0003', statement: 'live 正文不应被注入 LIVE-SHOULD-NOT-APPEAR。' });
    const projection = await confirmProjectionPinnedTo(asset.id, 'cid-frozen-0003', 'run-frozen-0003');
    await attachProjectionToConversation(projection.id, 'cid-frozen-0003');

    // 副本内容与 live 不同：命中副本时供给的必须是副本（不是 live）。
    await store.updateRecallJsonRecord(UID, 'projections', projection.id, (raw) => ({
      ...raw,
      assetVersionSnapshots: {
        [asset.id]: {
          version: '1',
          snapshot: {
            title: asset.title,
            statement: '冻结副本正文 MARKED-MIGRATED-4e5f。',
            type: 'rule',
            scope: 'project',
            version: '1',
            evidenceRefs: [{ kind: 'conversation', id: `conv-${asset.id}` }],
          },
        },
      },
    }));
    // live 记录保留但带迁出去向标记（asAsset 归一 spread 保留未知字段）。
    await store.updateRecallJsonRecord(UID, 'ability-assets', asset.id, (raw) => ({
      ...raw,
      migratedToExperienceId: 'exp-mig-aa-frozen-0003',
    }));
    expect((await assets.readAbilityAsset(UID, asset.id) as unknown as { migratedToExperienceId?: string }).migratedToExperienceId)
      .toBe('exp-mig-aa-frozen-0003');

    const context = await promptFor('cid-frozen-0003');
    const record = parseInjectedRecords(context.promptBlock).find((row) => row.asset_id === asset.id);
    expect(record).toBeDefined();
    expect(record!.statement).toBe('冻结副本正文 MARKED-MIGRATED-4e5f。');
    expect(record!.statement).not.toContain('LIVE-SHOULD-NOT-APPEAR');
    expect(record!.source_migrated).toBe('experience_catalog');
  });

  it('无快照的既有路径行为完全不变：live 正常照旧注入（无标注）；live 缺失且无副本维持现状缺席', async () => {
    const { assets } = await modules();
    // ① live 正常、无副本：照旧走 live 路径，不出现迁移标注。
    const alive = await seedAsset({ id: 'aa-frozen-live', statement: '正常 live 注入正文 LIVE-OK-3b7c。' });
    const aliveProjection = await confirmProjectionPinnedTo(alive.id, 'cid-frozen-live', 'run-frozen-live');
    await attachProjectionToConversation(aliveProjection.id, 'cid-frozen-live');
    const liveContext = await promptFor('cid-frozen-live');
    const liveRecord = parseInjectedRecords(liveContext.promptBlock).find((row) => row.asset_id === alive.id);
    expect(liveRecord).toBeDefined();
    expect(liveRecord!.statement).toBe('正常 live 注入正文 LIVE-OK-3b7c。');
    expect(liveRecord!.source_migrated).toBeUndefined();
    expect(liveRecord!.maturity).toBe('transfer_validated');
    expect(liveRecord!.lifecycle_status).toBe('system_precipitated_unverified');

    // ② live 缺失且无冻结副本：维持现状——装配层 catch 吞错，资产缺席，不抛出。
    const doomed = await seedAsset({ id: 'aa-frozen-doomed', statement: '无副本资产正文。' });
    const doomedProjection = await confirmProjectionPinnedTo(doomed.id, 'cid-frozen-doomed', 'run-frozen-doomed');
    await attachProjectionToConversation(doomedProjection.id, 'cid-frozen-doomed');
    await fs.promises.rm(
      (await import('../../../../src/main/features/recall/paths')).recallJsonRecordPath(UID, 'ability-assets', doomed.id),
    );
    await expect(assets.readAbilityAsset(UID, doomed.id)).rejects.toThrow(/not found/);

    const doomedContext = await promptFor('cid-frozen-doomed');
    expect(parseInjectedRecords(doomedContext.promptBlock).find((row) => row.asset_id === doomed.id)).toBeUndefined();
  });
});
