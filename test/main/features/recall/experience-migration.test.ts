/**
 * specs/016 T011：存量 KSTAR 经验类资产迁移（契约 E7/E8，data-model §7）。
 *
 * 断言与状态机一一对应：
 *  - scanned ──(learningProvenance 存在且 status ∈ {active,paused,archived})──→ 迁移成功；
 *  - scanned ──(不命中判据)──→ skipped（写明稳定理由码：capture 线 / preference_scan /
 *    无 provenance / 终态）；
 *  - frozen ──(经验写入失败)──→ failed（资产**保持原状**，无半迁；冻结先于写经验，
 *    所以失败时投影里副本已在——这正是「先冻后迁」的顺序证据）；
 *  - 幂等：同一资产重复 run → 第二次落 skipped，不产生重复经验条目；
 *  - 迁移后原已确认投影取到的内容与迁移前**逐字一致**（SC-002）。
 *
 * 另含 T017 的 IPC 层断言（不传 assetIds 报错 / preview 不改盘 / reason 码稳定）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../../helpers/trusted-ipc-sender';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-exp-migration';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-experience-migration-'));
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
  const [users, assets, projections, promptInjection, experiences, store] = await Promise.all([
    import('../../../../src/main/features/users'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/prompt-injection'),
    import('../../../../src/main/features/recall/experience-service'),
    import('../../../../src/main/features/recall/store'),
  ]);
  users.activateUser(UID);
  const migration = await import('../../../../src/main/features/recall/experience-migration');
  return { users, assets, projections, promptInjection, experiences, store, migration };
}

/** KSTAR 经验类资产夹具：默认带 learningProvenance（判据正例的硬标记）。
 *  走 createSystemAbilityAsset 真实写入（主记录 + 版本流 v1 快照 + 审计）。 */
async function seedAsset(spec: {
  id: string;
  statement?: string;
  title?: string;
  status?: 'active' | 'paused' | 'archived' | 'deleted';
  lifecycleStatus?: 'user_confirmed_unverified' | 'automatically_extracted_unverified' | 'system_precipitated_unverified';
  withProvenance?: boolean;
  learningSignalSource?: 'review' | 'preference_scan';
  applicableWhen?: string[];
}) {
  const { assets } = await modules();
  const now = new Date().toISOString();
  const withProvenance = spec.withProvenance !== false;
  return assets.createSystemAbilityAsset(UID, {
    schemaVersion: 1,
    ownerId: UID,
    id: spec.id,
    candidateId: `cand-${spec.id}`,
    title: spec.title ?? `经验资产-${spec.id}`,
    statement: spec.statement ?? `发布前必须核对回滚方案（${spec.id}）`,
    type: 'rule',
    scope: 'project',
    evidenceRefs: [{ kind: 'execution', id: `exec-${spec.id}` }],
    reviewDecisionId: 'legacy-untracked',
    lifecycleStatus: spec.lifecycleStatus ?? 'system_precipitated_unverified',
    status: spec.status ?? 'active',
    // 夹具直接以 transfer_validated 落库（explicit 投影与注入闸门对 seed 档
    // 有 maturity 硬门——prompt-injection.test.ts 的同款处理）：这里考的是
    // 迁移与冻结语义，不是成熟度闸门。
    maturity: 'transfer_validated',
    version: '1',
    ...(withProvenance ? {
      learningProvenance: {
        projectionId: `prj-${spec.id}`,
        episodeId: `kse-${spec.id}`,
        ruleRefs: [],
        attribution: 'execution_gap' as const,
      },
    } : {}),
    ...(spec.learningSignalSource ? {
      learningSignal: {
        deltaR: 'unknown' as const,
        deltaA: 'unknown' as const,
        outcome: 'met_expected' as const,
        confidence: 0.8,
        source: spec.learningSignalSource,
      },
    } : {}),
    ...(spec.applicableWhen ? { applicableWhen: spec.applicableWhen } : {}),
    createdAt: now,
    updatedAt: now,
  }, 'experience migration test fixture');
}

/** 已确认投影（真实 preview→confirm 路径，版本指针在确认时冻结）。 */
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

/** 把投影挂到会话消息流并取注入（照 prompt-injection.test.ts 的既有口径：
 *  注入装配从会话消息里检索投影 id）。 */
async function promptFor(cid: string) {
  const { promptInjection } = await modules();
  return promptInjection.buildConfirmedProjectionPromptContext(UID, cid);
}

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

/** 从注入块解析资产记录数组（renderPromptBlock 的形态：prefix\n<json 数组行>\nsuffix）。 */
function parseInjectedRecords(block: string): Array<Record<string, unknown>> {
  const line = block.split('\n').find((row) => row.startsWith('['));
  if (!line) return [];
  return JSON.parse(line) as Array<Record<string, unknown>>;
}

describe('experience migration · 判据与状态机（T011 / E7）', () => {
  it('判据正例：learningProvenance 存在 → 迁移成功，资产库零残留、版本流清空、经验条目落库、台账一条', async () => {
    const { assets, experiences, migration } = await modules();
    const asset = await seedAsset({ id: 'aa-mig-0001' });

    const run = await migration.runExperienceMigration(UID, [asset.id]);
    expect(run.migrated).toBe(1);
    expect(run.details).toEqual([
      { assetId: asset.id, experienceId: 'exp-mig-aa-mig-0001', reason: 'ok' },
    ]);

    // 资产库零残留：主记录读不回（抛 not found），全量列表不含。
    await expect(assets.readAbilityAsset(UID, asset.id)).rejects.toThrow(/not found/);
    expect((await assets.listAbilityAssets(UID)).map((row) => row.id)).not.toContain(asset.id);
    // 版本流一并清（迁出资产库 = 主记录 + 版本流，E7 第③步）。
    expect(await assets.listAbilityAssetVersions(UID, asset.id)).toEqual([]);

    // 经验条目：确定性 id、正文=资产 statement、溯源 episode 与 provenance 一致。
    const exp = await experiences.readExperience(UID, 'exp-mig-aa-mig-0001');
    expect(exp).toMatchObject({
      id: 'exp-mig-aa-mig-0001',
      status: 'active',
      body: '发布前必须核对回滚方案（aa-mig-0001）',
      scope: 'project',
    });
    expect(exp!.source.episodeId).toBe('kse-aa-mig-0001');
    expect(exp!.learningProvenance.episodeId).toBe('kse-aa-mig-0001');
    expect(exp!.evidenceRefs.length).toBeGreaterThan(0);

    // 台账（E8 status）：exm- 前缀、done、明细可追。
    const status = await migration.latestExperienceMigrationStatus(UID);
    expect(status.migrationId).toMatch(/^exm-/);
    expect(status.status).toBe('done');
    expect(status.migrated).toBe(1);
    expect(status.details?.[0]).toMatchObject({ assetId: asset.id, experienceId: 'exp-mig-aa-mig-0001', reason: 'ok' });
  });

  it('反例四类全部落跳过（稳定理由码），资产原样保留、零经验产生', async () => {
    const { assets, experiences, migration } = await modules();
    const capture = await seedAsset({ id: 'aa-cap-0001', withProvenance: false, lifecycleStatus: 'automatically_extracted_unverified' });
    const preference = await seedAsset({ id: 'aa-pref-0001', withProvenance: false, learningSignalSource: 'preference_scan' });
    const plain = await seedAsset({ id: 'aa-plain-0001', withProvenance: false });
    const deleted = await seedAsset({ id: 'aa-dead-0001', status: 'deleted' });

    const preview = await migration.previewExperienceMigration(UID);
    expect(preview.scanned).toBe(4);
    expect(preview.migratable).toBe(0);
    const reasons = Object.fromEntries(preview.skippedReasons.map((row) => [row.reason, row.count]));
    expect(reasons).toEqual({
      capture_line: 1,
      preference_scan_line: 1,
      no_kstar_provenance: 1,
      terminal_status: 1,
    });
    // 稳定码两次调用一致（界面按码翻文案）。
    const again = await migration.previewExperienceMigration(UID);
    expect(again.skippedReasons).toEqual(preview.skippedReasons);

    const run = await migration.runExperienceMigration(UID, [capture.id, preference.id, plain.id, deleted.id]);
    expect(run.migrated).toBe(0);
    expect(run.details.map((row) => row.reason)).toEqual(['capture_line', 'preference_scan_line', 'no_kstar_provenance', 'terminal_status']);

    // 反例资产一个都不动、一条经验都不产生。
    const remaining = (await assets.listAbilityAssets(UID)).map((row) => row.id).sort();
    expect(remaining).toEqual([capture.id, deleted.id, plain.id, preference.id].sort());
    expect(await experiences.listExperiences(UID)).toEqual([]);
  });

  it('先冻后迁：经验写入失败 → 资产保持原状、无半迁；冻结副本已先写进投影（顺序证据）', async () => {
    const { assets, experiences, migration, projections } = await modules();
    // 真实失败路径：资产带 6 条 applicableWhen（资产侧无条数限制），经验侧
    // 上限 5 条 → createExperience 校验拒收 → 该条 failed。
    const asset = await seedAsset({
      id: 'aa-fail-0001',
      applicableWhen: ['条件一', '条件二', '条件三', '条件四', '条件五', '条件六'],
    });
    const projection = await confirmProjectionPinnedTo(asset.id, 'cid-mig-fail', 'run-mig-fail');

    const run = await migration.runExperienceMigration(UID, [asset.id]);
    expect(run.migrated).toBe(0);
    expect(run.failed).toBe(1);
    expect(run.details[0]).toMatchObject({ assetId: asset.id, reason: 'experience_write_failed' });

    // 无半迁：资产记录与版本流原样、无经验条目、无经验 id 在明细里。
    const still = await assets.readAbilityAsset(UID, asset.id);
    expect(still.title).toBe(asset.title);
    expect(still.applicableWhen).toHaveLength(6);
    expect((await assets.listAbilityAssetVersions(UID, asset.id)).map((row) => row.version)).toEqual(['1']);
    expect(await experiences.listExperiences(UID)).toEqual([]);
    expect(run.details[0].experienceId).toBeUndefined();

    // 先冻后迁的顺序证据：经验没写成，但冻结副本已经写进已确认投影——
    // 「先保引用」永远发生在「动数据」之前（照抄 deleteAbilityAssetVersion）。
    const stored = await projections.readContextProjection(UID, projection.id);
    const frozen = stored.assetVersionSnapshots?.[asset.id];
    expect(frozen?.version).toBe('1');
    expect(frozen?.snapshot.statement).toBe(asset.statement);
  });

  it('重复执行幂等：第二次 run 同一 assetIds 落 skipped（already_migrated），经验不重复', async () => {
    const { assets, experiences, migration } = await modules();
    const asset = await seedAsset({ id: 'aa-idem-0001' });

    const first = await migration.runExperienceMigration(UID, [asset.id]);
    expect(first.migrated).toBe(1);

    const second = await migration.runExperienceMigration(UID, [asset.id]);
    expect(second.migrated).toBe(0);
    expect(second.details[0]).toMatchObject({ assetId: asset.id, reason: 'already_migrated', experienceId: 'exp-mig-aa-idem-0001' });

    // 不产生第二条经验（幂等判据：资产记录已不存在 + 台账可追去向）。
    expect((await experiences.listExperiences(UID)).map((row) => row.id)).toEqual(['exp-mig-aa-idem-0001']);
    await expect(assets.readAbilityAsset(UID, asset.id)).rejects.toThrow(/not found/);
  });

  it('可重入：中断后（部分失败批）重跑只处理未迁条目', async () => {
    const { assets, experiences, migration } = await modules();
    const bad = await seedAsset({ id: 'aa-retry-bad', applicableWhen: ['一', '二', '三', '四', '五', '六'] });
    const good = await seedAsset({ id: 'aa-retry-good' });

    const first = await migration.runExperienceMigration(UID, [bad.id, good.id]);
    expect(first.migrated).toBe(1);
    expect(first.failed).toBe(1);

    // 修掉失败资产的超限条件（模拟用户处置后重跑）：坏条目迁走，好条目已迁落 skipped。
    await assets.updateAbilityAsset(UID, bad.id, { applicableWhen: ['只留一条'], reason: 'fix for retry', actor: 'user' });
    const second = await migration.runExperienceMigration(UID, [bad.id, good.id]);
    expect(second.details.map((row) => `${row.assetId}:${row.reason}`).sort()).toEqual([
      'aa-retry-bad:ok',
      'aa-retry-good:already_migrated',
    ]);
    expect((await experiences.listExperiences(UID)).map((row) => row.id).sort()).toEqual([
      'exp-mig-aa-retry-bad',
      'exp-mig-aa-retry-good',
    ]);
  });

  it('迁移后原已确认投影取到的内容与迁移前逐字一致（SC-002）', async () => {
    const { migration, projections } = await modules();
    const asset = await seedAsset({
      id: 'aa-verbatim-0001',
      statement: '发布前必须核对回滚方案，并把它写在发布单里；逐字一致专用正文 VERBATIM-7f3a。',
      applicableWhen: ['发布评审时核对'],
    });
    const projection = await confirmProjectionPinnedTo(asset.id, 'cid-mig-verbatim', 'run-mig-verbatim');
    await attachProjectionToConversation(projection.id, 'cid-mig-verbatim');
    await migration.runExperienceMigration(UID, [asset.id]);

    // 投影冻结副本与迁移前 live 内容逐字相等。
    const stored = await projections.readContextProjection(UID, projection.id);
    expect(stored.assetVersionSnapshots?.[asset.id]?.snapshot.statement)
      .toBe('发布前必须核对回滚方案，并把它写在发布单里；逐字一致专用正文 VERBATIM-7f3a。');

    // 注入块：迁移后该资产仍在（不缺席），title/statement/version/scope 逐字一致，
    // 且带「来源已迁入经验目录」标注（详见 experience-frozen-read.test.ts）。
    const context = await promptFor('cid-mig-verbatim');
    const records = parseInjectedRecords(context.promptBlock);
    const record = records.find((row) => row.asset_id === asset.id);
    expect(record).toBeDefined();
    expect(record!.statement).toBe('发布前必须核对回滚方案，并把它写在发布单里；逐字一致专用正文 VERBATIM-7f3a。');
    expect(record!.title).toBe('经验资产-aa-verbatim-0001');
    expect(record!.version).toBe('1');
    expect(record!.scope).toBe('project');
    expect(record!.applicable_when).toEqual(['发布评审时核对']);
  });

  it('paused / archived 状态如实映射（状态机可迁集），经验状态同名保留', async () => {
    const { experiences, migration } = await modules();
    await seedAsset({ id: 'aa-mig-paused', status: 'paused' });
    await seedAsset({ id: 'aa-mig-archived', status: 'archived' });

    const run = await migration.runExperienceMigration(UID, ['aa-mig-paused', 'aa-mig-archived']);
    expect(run.migrated).toBe(2);
    expect((await experiences.readExperience(UID, 'exp-mig-aa-mig-paused'))?.status).toBe('paused');
    expect((await experiences.readExperience(UID, 'exp-mig-aa-mig-archived'))?.status).toBe('archived');
  });

  it('run 入参校验：非数组 / 空数组 / 非法 id / 超过 200 条一律报错', async () => {
    const { migration } = await modules();
    await expect(migration.runExperienceMigration(UID, undefined as never)).rejects.toThrow(/invalid.*asset ids/i);
    await expect(migration.runExperienceMigration(UID, [])).rejects.toThrow(/invalid.*asset ids/i);
    await expect(migration.runExperienceMigration(UID, ['not an id'])).rejects.toThrow(/invalid.*asset ids/i);
    await expect(migration.runExperienceMigration(UID, Array.from({ length: 201 }, (_, i) => `aa-bulk-${i}`)))
      .rejects.toThrow(/invalid.*asset ids/i);
  });

  it('preview 只读不改盘：不写经验、不动资产、不落台账记录', async () => {
    const { assets, experiences, migration } = await modules();
    const asset = await seedAsset({ id: 'aa-preview-0001' });

    const before = await migration.previewExperienceMigration(UID);
    expect(before.scanned).toBe(1);
    expect(before.migratable).toBe(1);
    expect(before.items[0]).toMatchObject({
      assetId: asset.id,
      title: asset.title,
      status: 'active',
    });
    expect(typeof before.items[0].experienceTypeGuess).toBe('string');
    expect(before.items[0].frozenProjections).toBe(0);

    // 只读：再 preview 一次盘上无变化（资产在、经验零、status 无记录）。
    await migration.previewExperienceMigration(UID);
    expect((await assets.listAbilityAssets(UID)).map((row) => row.id)).toEqual([asset.id]);
    expect(await experiences.listExperiences(UID)).toEqual([]);
    expect(await migration.latestExperienceMigrationStatus(UID)).toEqual({ ok: true, migrationId: null });
  });
});

// ── T017：IPC 层（recall.experiences.migration.preview / .run / .status）─────
// harness 照 experience-ipc.test.ts 先例（mock electron + 单一 map register）。
type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<{ ok: boolean } & Record<string, unknown>>;

describe('ipc › recall.experiences.migration (E7/E8, T017)', () => {
  let invokeHandler: InvokeFn | null = null;

  beforeEach(() => {
    invokeHandler = null;
    vi.doMock('electron', () => ({
      ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
      shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
      BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
      dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
      app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
    }));
    vi.doMock('../../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));
    vi.doMock('../../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  });

  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('../../../../src/main/logger');
    vi.doUnmock('../../../../src/main/ipc/local_agents');
  });

  async function call(channel: string, payload: unknown = {}) {
    if (!invokeHandler) throw new Error('missing handler');
    return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
  }

  it('run 不传 assetIds / 空数组 / 超 200 一律 invalid；run 前后 preview 通道只读', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const ipc = await import('../../../../src/main/ipc/index');
    ipc.register();

    await expect(call('recall.experiences.migration.run', {})).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid/i) });
    await expect(call('recall.experiences.migration.run', { assetIds: [] })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid/i) });
    await expect(call('recall.experiences.migration.run', { assetIds: Array.from({ length: 201 }, (_, i) => `aa-x-${i}`) }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid/i) });

    // preview 不改盘：通过之后 status 仍无记录。
    const preview = await call('recall.experiences.migration.preview', {});
    expect(preview.ok).toBe(true);
    expect(preview.scanned).toBe(0);
    expect(await call('recall.experiences.migration.status', {})).toMatchObject({ ok: true, migrationId: null });
  });

  it('run 显式传 assetIds → 迁移成功回执；status 通道回报同一 migrationId 与明细', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const now = new Date().toISOString();
    await assets.createSystemAbilityAsset(UID, {
      schemaVersion: 1, ownerId: UID, id: 'aa-ipc-mig-0001', candidateId: 'cand-aa-ipc-mig-0001',
      title: 'IPC 迁移资产', statement: 'IPC 通道迁移专用正文。', type: 'rule', scope: 'project',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-ipc-mig-1' }], reviewDecisionId: 'legacy-untracked',
      lifecycleStatus: 'system_precipitated_unverified', status: 'active', maturity: 'seed', version: '1',
      learningProvenance: { projectionId: 'prj-ipc-mig-1', episodeId: 'kse-ipc-mig-1', ruleRefs: [], attribution: 'execution_gap' },
      createdAt: now, updatedAt: now,
    }, 'ipc migration fixture');
    const ipc = await import('../../../../src/main/ipc/index');
    ipc.register();

    const run = await call('recall.experiences.migration.run', { assetIds: ['aa-ipc-mig-0001'] });
    expect(run.ok).toBe(true);
    expect(run.migrated).toBe(1);
    expect(String(run.migrationId)).toMatch(/^exm-/);
    expect(run.details).toEqual([{ assetId: 'aa-ipc-mig-0001', experienceId: 'exp-mig-aa-ipc-mig-0001', reason: 'ok' }]);

    const status = await call('recall.experiences.migration.status', {});
    expect(status).toMatchObject({ ok: true, migrationId: run.migrationId, status: 'done', migrated: 1 });
  });
});
