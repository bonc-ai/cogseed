import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 启动期迁移的统一结果上报：分类 + 落盘 + 一条摘要。
// 详见 src/main/util/migration-report.ts。

let tmpDir: string;
let prevWs: string | undefined;

const TEST_UID = 'u1';

function reportFile(uid: string): string {
  return path.join(tmpDir, uid, 'local', 'migrations-report.json');
}

async function load() {
  return import('../../../src/main/util/migration-report');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-migration-report-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration-report', () => {
  it('classifies each migration result without requiring migrations to change', async () => {
    const { classifyMigrationResult } = await load();
    expect(classifyMigrationResult(undefined).status).toBe('applied');
    expect(classifyMigrationResult({ moved: 3 }).status).toBe('applied');
    expect(classifyMigrationResult({ moved: 3 }).detail).toContain('moved=3');
    // v5 的形状：跑完了但留下失败项 → partial，且失败项要能点名
    expect(classifyMigrationResult({ warnings: ['p1', 'p2'] })).toMatchObject({
      status: 'partial',
      failedItems: ['p1', 'p2'],
    });
    // 已做过/无事可做
    expect(classifyMigrationResult({ skipped: true }).status).toBe('skipped');
    expect(classifyMigrationResult({ migrated: false }).status).toBe('skipped');
    expect(classifyMigrationResult({ applied: false }).status).toBe('skipped');
    // 空 warnings 不等于 partial
    expect(classifyMigrationResult({ warnings: [] }).status).toBe('applied');
  });

  it('records a throwing migration as failed and keeps going', async () => {
    const { runBootMigration, finishBootMigrationRun } = await load();
    const failed = runBootMigration(TEST_UID, 'boom', () => {
      throw new Error('disk on fire');
    });
    expect(failed).toMatchObject({ id: 'boom', status: 'failed', error: 'disk on fire' });
    const after = runBootMigration(TEST_UID, 'fine', () => ({ moved: 1 }));
    expect(after.status).toBe('applied');
    const report = finishBootMigrationRun(TEST_UID);
    expect(report.outcomes.map((o) => o.id)).toEqual(['boom', 'fine']);
  });

  it('writes the report under local/ (machine-private), not cloud/', async () => {
    const { runBootMigration, finishBootMigrationRun, readMigrationReport } = await load();
    runBootMigration(TEST_UID, 'project-layout-v5', () => ({ warnings: ['proj-9'] }));
    finishBootMigrationRun(TEST_UID);

    expect(fs.existsSync(reportFile(TEST_UID))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, TEST_UID, 'cloud', 'migrations-report.json'))).toBe(false);
    const read = readMigrationReport(TEST_UID);
    expect(read?.version).toBe(1);
    expect(read?.uid).toBe(TEST_UID);
    expect(read?.outcomes[0]).toMatchObject({ id: 'project-layout-v5', status: 'partial', failedItems: ['proj-9'] });
  });

  it('summarizes ids per status so one log line answers what ran', async () => {
    const { runBootMigration, summarizeMigrationReport } = await load();
    runBootMigration(TEST_UID, 'agent-layout', () => ({}));
    runBootMigration(TEST_UID, 'kb-to-local', () => ({ skipped: true }));
    runBootMigration(TEST_UID, 'project-layout-v5', () => ({ warnings: ['p1'] }));
    runBootMigration(TEST_UID, 'chats-ghost-cleanup', () => {
      throw new Error('nope');
    });
    // summarize 需要同一批 outcomes → 用 finish 的返回值取
    const { finishBootMigrationRun } = await load();
    const report = finishBootMigrationRun(TEST_UID);
    const line = summarizeMigrationReport(report.outcomes);
    expect(line).toContain('4 migrations');
    expect(line).toContain('applied=1 [agent-layout]');
    expect(line).toContain('skipped=1 [kb-to-local]');
    expect(line).toContain('partial=1 [project-layout-v5]');
    expect(line).toContain('failed=1 [chats-ghost-cleanup]');
  });

  it('resets between runs and tolerates a missing or corrupt report file', async () => {
    const { runBootMigration, finishBootMigrationRun, readMigrationReport } = await load();
    runBootMigration(TEST_UID, 'first-boot', () => ({}));
    expect(finishBootMigrationRun(TEST_UID).outcomes).toHaveLength(1);
    // 第二次启动：不带上一轮的条目
    runBootMigration(TEST_UID, 'second-boot', () => ({}));
    expect(finishBootMigrationRun(TEST_UID).outcomes.map((o) => o.id)).toEqual(['second-boot']);

    fs.writeFileSync(reportFile(TEST_UID), '{not json');
    expect(readMigrationReport(TEST_UID)).toBeNull();
    expect(readMigrationReport('nobody')).toBeNull();
  });
});
