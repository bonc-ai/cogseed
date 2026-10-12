import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 标题闸门（设计 3.2）后晋升链对不合规 summary 走 LLM 起标题；本文件走的是
// 内生写入路径（summary＝正文首句/模板拼接），单测无模型，mock 出确定性
// 合规标题（与 asset-title-suggestion.test.ts 同一边界口径）。
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({
  suggestAbilityAssetTitle: async () => ({ title: '模型重起的样本标题' }),
}))

// 存量记忆迁移（清单 #6）：dryRun 盘点、真实迁移+备份+清空、幂等重跑。

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-mem-mig-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  // paths.ts 在模块加载时固化工作区根：换 tmpDir 必须重置模块缓存。
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loaded() {
  const migration = await import('../../../../src/main/features/recall/memory-migration');
  // paths 的工作区根在模块加载时固化，vitest 的模块图让它不可靠——测试经
  // files 注入直接控制迁移源文件。
  const userFile = path.join(tmpDir, 'USER.md');
  const sharedFile = path.join(tmpDir, 'MEMORY.md');
  const preview = (uid: string) => migration.previewLegacyMemoryMigration(uid, { files: { user: userFile, shared: sharedFile } });
  const run = (uid: string, opts: {
    selectedEntries: Array<{ scope: 'user' | 'shared'; contentHash: string }>;
    expectedFingerprints: { user?: string; shared?: string };
  }) => migration.migrateLegacyMemoryToAssets(uid, { ...opts, files: { user: userFile, shared: sharedFile } });
  return { userFile, sharedFile, run, preview, migration };
}

describe('migrateLegacyMemoryToAssets', () => {
  it('read-only preview groups entries and leaves both legacy files byte-for-byte unchanged', async () => {
    const { userFile, sharedFile, preview } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '第一条画像。\n§\n第一条画像。\n§\n第二条画像。', 'utf8');
    fs.writeFileSync(sharedFile, '接口变更必须同步文档。', 'utf8');
    const userBefore = fs.readFileSync(userFile);
    const sharedBefore = fs.readFileSync(sharedFile);

    const result = preview('user-mig');

    expect(result.sources.user).toMatchObject({ status: 'ready', eligibleEntries: 2, eligibleRecords: 3 });
    expect(result.sources.shared).toMatchObject({ status: 'ready', eligibleEntries: 1, eligibleRecords: 1 });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'user', text: '第一条画像。', occurrences: 2 }),
      expect.objectContaining({ scope: 'user', text: '第二条画像。', occurrences: 1 }),
      expect.objectContaining({ scope: 'shared', text: '接口变更必须同步文档。', occurrences: 1 }),
    ]));
    expect(fs.readFileSync(userFile)).toEqual(userBefore);
    expect(fs.readFileSync(sharedFile)).toEqual(sharedBefore);
  });

  it('keeps source-less projection records out of the migration choices', async () => {
    const { userFile, preview } = await loaded();
    const records = await import('../../../../src/main/features/memory-records');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    const orphanText = '来源关系不完整的旧投影。';
    const orphan = {
      recordId: 'mem_0000000000000001',
      text: orphanText,
      contentSha256: records.memoryContentHash(orphanText),
      independent: false,
      sources: [],
    };
    fs.writeFileSync(userFile, `${records.serializeMemoryRecords([orphan])}\n§\n用户独立保存的内容。`, 'utf8');
    const before = fs.readFileSync(userFile);

    const result = preview('user-mig-orphan');

    expect(result.items).toEqual([
      expect.objectContaining({ scope: 'user', text: '用户独立保存的内容。', occurrences: 1 }),
    ]);
    expect(result.sources.user.retainedNonIndependentRecords).toBe(1);
    expect(fs.readFileSync(userFile)).toEqual(before);
  });

  it('migrates only the selected entry, preserves unselected text, and keeps its legacy source evidence', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-mig2');
    const { userFile, sharedFile, preview, run } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '用户是开发者。\n§\n保留在旧文件中的另一条。', 'utf8');
    fs.writeFileSync(sharedFile, '接口变更必须同步文档。', 'utf8');

    const reviewed = preview('user-mig2');
    const selected = reviewed.items.find((item) => item.scope === 'user' && item.text === '用户是开发者。');
    expect(selected).toBeTruthy();
    const report = await run('user-mig2', {
      selectedEntries: [{ scope: 'user', contentHash: selected!.contentHash }],
      expectedFingerprints: reviewed.fingerprints,
    });
    expect(report.migrated).toBe(1);
    expect(report.failed).toBe(0);
    expect(fs.readFileSync(userFile, 'utf8')).toContain('保留在旧文件中的另一条。');
    expect(fs.readFileSync(userFile, 'utf8')).not.toContain('用户是开发者。');
    expect(fs.readFileSync(sharedFile, 'utf8')).toBe('接口变更必须同步文档。');
    // 备份可读、内容等于迁移前。
    expect(report.backupDir).toBeDefined();
    const backedUp = fs.readFileSync(path.join(report.backupDir!, 'USER.md'), 'utf8');
    expect(backedUp).toBe('用户是开发者。\n§\n保留在旧文件中的另一条。');
    // 条目真的进了资产库（personal 类、模型记的出身）。
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const migrated = (await assets.listAbilityAssets('user-mig2'))
      .filter((asset) => asset.statement.includes('用户是开发者'));
    expect(migrated.length).toBe(1);
    expect(migrated.every((asset) => asset.type === 'personal' && asset.lifecycleStatus === 'user_confirmed_unverified')).toBe(true);
    expect(migrated[0].evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'memory', title: '旧 USER.md 个人记忆', degraded: true }),
    ]));
  });

  it('preview after a successful migration no longer offers the migrated entry', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-mig3');
    const { userFile, run, preview } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '唯一一条。', 'utf8');
    const reviewed = preview('user-mig3');
    await run('user-mig3', {
      selectedEntries: reviewed.items.map(({ scope, contentHash }) => ({ scope, contentHash })),
      expectedFingerprints: reviewed.fingerprints,
    });
    expect(preview('user-mig3').items).toEqual([]);
  });

  // ── 审查修复回归（2026-09-21）：pending 口径 + 清空竞态 ──────────────────
  it('does not clear the file when entries only reach the candidate pool', async () => {
    // 修复前：pending-review（embedding 硬阻塞）也计入成功 → 文件被清空，
    // 画像其实停在「待我处理」候选池里，用户不看候选池就等于丢失。
    vi.doMock('../../../../src/main/features/recall/candidate-service', () => ({
      ingestLegacyMemoryKnowledge: async () => ({ mode: 'pending-review', candidateId: 'cand-pending' }),
    }));
    try {
      const { userFile, run, preview } = await loaded();
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, '停在候选池的一条。', 'utf8');
      const reviewed = preview('user-mig-pending');
      const report = await run('user-mig-pending', {
        selectedEntries: reviewed.items.map(({ scope, contentHash }) => ({ scope, contentHash })),
        expectedFingerprints: reviewed.fingerprints,
      });
      expect(report.migrated).toBe(0);
      expect(report.pendingReview).toBe(1);
      expect(fs.readFileSync(userFile, 'utf8')).toContain('停在候选池的一条。');
    } finally {
      vi.doUnmock('../../../../src/main/features/recall/candidate-service');
      vi.resetModules();
    }
  });

  it('keeps entries written into the file while the migration is running', async () => {
    const userFile = path.join(tmpDir, 'USER.md');
    let injected = false;
    vi.doMock('../../../../src/main/features/recall/candidate-service', () => ({
      ingestLegacyMemoryKnowledge: async () => {
        if (!injected) {
          injected = true;
          // 模拟运行期写手（memory replace / 直投失败回退）在扫描之后、清空
          // 之前追加了一条新记忆。
          fs.appendFileSync(userFile, '\n§\n迁移期间新写入的一条。', 'utf8');
        }
        return { mode: 'created', assetId: 'asset-race' };
      },
    }));
    try {
      const { run } = await loaded();
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, '扫描时已有的一条。', 'utf8');
      const migration = await import('../../../../src/main/features/recall/memory-migration');
      const reviewed = migration.previewLegacyMemoryMigration('user-mig-race', { files: { user: userFile, shared: path.join(tmpDir, 'MEMORY.md') } });
      const report = await run('user-mig-race', {
        selectedEntries: reviewed.items.map(({ scope, contentHash }) => ({ scope, contentHash })),
        expectedFingerprints: reviewed.fingerprints,
      });
      expect(report.migrated).toBe(1);
      // 修复前：清空无守卫，新写入（从未迁移过）的条目被连带抹掉。
      expect(fs.readFileSync(userFile, 'utf8')).toContain('迁移期间新写入的一条。');
    } finally {
      vi.doUnmock('../../../../src/main/features/recall/candidate-service');
      vi.resetModules();
    }
  });

  it('rejects an empty selection and refuses a source changed after review', async () => {
    const { userFile, run, preview } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '用户明确选择的原文。', 'utf8');
    const reviewed = preview('user-mig-stale');
    await expect(run('user-mig-stale', { selectedEntries: [], expectedFingerprints: reviewed.fingerprints }))
      .rejects.toThrow(/explicit migration selection/);

    fs.writeFileSync(userFile, '用户明确选择的原文。\n§\n后来追加的新内容。', 'utf8');
    const report = await run('user-mig-stale', {
      selectedEntries: reviewed.items.map(({ scope, contentHash }) => ({ scope, contentHash })),
      expectedFingerprints: reviewed.fingerprints,
    });
    expect(report.sourceChangedFiles).toBe(1);
    expect(report.staleSelections).toBe(1);
    expect(fs.readFileSync(userFile, 'utf8')).toContain('后来追加的新内容。');
  });

  it('does not offer role-template or already asset-linked records for legacy migration', async () => {
    const { userFile, preview } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    const { newIndependentRecord, writeMemoryRecords } = await import('../../../../src/main/features/memory-records');
    const template = newIndependentRecord('角色模板自己管理的偏好。');
    template.independent = false;
    template.sources = [{ kind: 'role_template', sourceId: 'template-a' }];
    const linked = newIndependentRecord('已有正式资产来源的条目。');
    linked.independent = false;
    linked.sources = [{ kind: 'cognition_asset', sourceId: 'asset-a' }];
    writeMemoryRecords(userFile, [newIndependentRecord('可迁移旧条目。'), template, linked], 5000);

    const result = preview('user-mig-owned');

    expect(result.sources.user).toMatchObject({ eligibleRecords: 1, retainedTemplateRecords: 1, retainedAssetRecords: 1 });
    expect(result.items.map((item) => item.text)).toEqual(['可迁移旧条目。']);
  });
});
