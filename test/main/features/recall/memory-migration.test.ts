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
  const run = (opts: { dryRun?: boolean } = {}) => migration.migrateLegacyMemoryToAssets('user-mig', { ...opts, files: { user: userFile, shared: sharedFile } });
  return { userFile, sharedFile, run, migration };
}

describe('migrateLegacyMemoryToAssets', () => {
  it('dry run inventories without touching the files', async () => {
    const { userFile, run } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '第一条画像。\n§\n第二条画像。', 'utf8');
    const report = await run({ dryRun: true });
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

    const report = await run();
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
    expect(migrated.every((asset) => asset.type === 'personal' && asset.lifecycleStatus === 'automatically_extracted_unverified')).toBe(true);
  });

  it('re-running after a successful migration is a no-op (idempotent)', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-mig3');
    const { userFile, run } = await loaded();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '唯一一条。', 'utf8');
    await run();
    const again = await run();
    expect(again.scannedUser).toBe(0);
    expect(again.migrated).toBe(0);
  });
});
