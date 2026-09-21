import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  const run = (uid: string, opts: { dryRun?: boolean } = {}) => migration.migrateLegacyMemoryToAssets(uid, { ...opts, files: { user: userFile, shared: sharedFile } });
  return { userFile, sharedFile, run, migration };
}

describe('migrateLegacyMemoryToAssets', () => {
  it('dry run inventories without touching the files', async () => {
    const { userFile, run } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '第一条画像。\n§\n第二条画像。', 'utf8');
    const report = await run('user-mig', { dryRun: true });
    expect(report.scannedUser).toBe(2);
    expect(report.migrated).toBe(0);
    expect(fs.readFileSync(userFile, 'utf8')).toContain('第一条画像。');
  });

  it('migrates entries into assets, backs up, and clears the files', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-mig2');
    const { userFile, sharedFile, run } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '用户是开发者。', 'utf8');
    fs.writeFileSync(sharedFile, '接口变更必须同步文档。', 'utf8');

    const report = await run('user-mig2');
    expect(report.migrated).toBe(2);
    expect(report.failed).toBe(0);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('');
    expect(fs.readFileSync(sharedFile, 'utf8')).toBe('');
    // 备份可读、内容等于迁移前。
    expect(report.backupDir).toBeDefined();
    const backedUp = fs.readFileSync(path.join(report.backupDir!, 'USER.md'), 'utf8');
    expect(backedUp).toBe('用户是开发者。');
    // 条目真的进了资产库（personal 类、模型记的出身）。
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const migrated = (await assets.listAbilityAssets('user-mig2'))
      .filter((asset) => asset.statement.includes('用户是开发者') || asset.statement.includes('接口变更'));
    expect(migrated.length).toBe(2);
    expect(migrated.every((asset) => asset.type === 'personal' && asset.lifecycleStatus === 'user_confirmed_unverified')).toBe(true);
  });

  it('re-running after a successful migration is a no-op (idempotent)', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-mig3');
    const { userFile, run } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '唯一一条。', 'utf8');
    await run('user-mig3');
    const again = await run('user-mig3');
    expect(again.scannedUser).toBe(0);
    expect(again.migrated).toBe(0);
  });

  // ── 审查修复回归（2026-09-21）：pending 口径 + 清空竞态 ──────────────────
  it('does not clear the file when entries only reach the candidate pool', async () => {
    // 修复前：pending-review（embedding 硬阻塞）也计入成功 → 文件被清空，
    // 画像其实停在「待我处理」候选池里，用户不看候选池就等于丢失。
    vi.doMock('../../../../src/main/features/recall/candidate-service', () => ({
      ingestImmediateKnowledge: async () => ({ mode: 'pending-review', candidateId: 'cand-pending' }),
    }));
    try {
      const { userFile, run } = await loaded();
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, '停在候选池的一条。', 'utf8');
      const report = await run('user-mig-pending');
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
      ingestImmediateKnowledge: async () => {
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
      const report = await run('user-mig-race');
      expect(report.migrated).toBe(1);
      // 修复前：清空无守卫，新写入（从未迁移过）的条目被连带抹掉。
      expect(fs.readFileSync(userFile, 'utf8')).toContain('迁移期间新写入的一条。');
    } finally {
      vi.doUnmock('../../../../src/main/features/recall/candidate-service');
      vi.resetModules();
    }
  });
});
