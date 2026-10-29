/**
 * 旧布局首次持久化的写入失败恢复（回归态）：writeJson 失败时 v1 台账仍在
 * （先落盘再退役的顺序约束），活组不降格进回收站，重试无损结清。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const state = vi.hoisted(() => ({ failWrites: 0 }));
vi.mock('../../src/main/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/storage')>();
  return {
    ...actual,
    writeJson: async (filePath: string, data: unknown) => {
      if (state.failWrites > 0) {
        state.failWrites -= 1;
        throw new Error('probe: simulated disk full');
      }
      return actual.writeJsonSync(filePath, data);
    },
  };
});
vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, emit: () => {}, off: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r2-txn';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r2-txn-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  state.failWrites = 0;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function v1Dir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}
function ledgerFile(): string {
  return path.join(v1Dir(), 'groups.md');
}
function poDocFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json');
}

/** v1 现场：1 个活组（台账 + 内容文件 + 一版历史快照）。 */
function seedV1(): void {
  const dir = v1Dir();
  fs.mkdirSync(path.join(dir, '.history', 'grp001'), { recursive: true });
  fs.writeFileSync(ledgerFile(), [
    '# 记忆分组', '',
    '### grp001',
    '- 标题: 工作偏好',
    '- 文件: .personal_ontology_groups/grp001.md',
    '- 创建时间: 2026-09-01T10:00:00',
    '- 更新时间: 2026-09-02T10:00:00',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'grp001.md'), [
    '## 字段区', '',
    '### 常用工具',
    '- ZCode [手动]',
    '',
    '---', '',
    '## 流水区', '',
    '周五提交周报',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.history', 'grp001', '2026-09-01T10-05-00-000Z-00.md'), [
    '## 字段区', '',
    '### 常用工具',
    '- ZCode [手动]',
    '',
    '---', '',
    '## 流水区', '',
    '旧快照条目',
  ].join('\n'));
}

async function loadGroups() {
  return import('../../src/main/features/personal_ontology_groups');
}
async function loadStore() {
  return import('../../src/main/features/po/store');
}

describe('迁移结清的时序与恢复', () => {
  it('firstPersist 时 writeJson 失败：台账仍在、活组不降格，重试无损结清', async () => {
    seedV1();
    const groups = await loadGroups();

    // 迁移前正常读一次（活组可见）
    expect(groups.readGroups(UID).length).toBe(1);

    // 第一次写：writeJson 被探针模拟为失败（磁盘满等）
    state.failWrites = 1;
    await expect(groups.createGroup(UID, '新组')).rejects.toThrow('probe: simulated disk full');

    // 断言 1（顺序约束）：先落盘再退役——写失败时 v1 台账原样在场，
    // 备份尚未发生（backupV1Dir 只在落盘成功后执行）。
    expect(fs.existsSync(ledgerFile())).toBe(true);
    const localDir = path.join(tmpDir, UID, 'local');
    const backupsNow = fs.existsSync(localDir)
      ? fs.readdirSync(localDir).filter((n) => n.startsWith('ontology-v1-backup-'))
      : [];
    expect(backupsNow.length).toBe(0);

    // 断言 2：写失败后重新读——活组照常（不降格、不进 trash），
    // v2 JSON 未落盘（失败的写没有留下半成品）。
    const store = await loadStore();
    const doc = store.loadPoDocSync(UID);
    expect(doc.groups.length).toBe(1);
    expect(doc.trash.length).toBe(0);
    expect(fs.existsSync(poDocFile())).toBe(false);

    // 断言 3：再次成功写 → 结清：一份备份（不堆积）、原活组保活、
    // 新组落盘、trash 仍空。
    const created = await groups.createGroup(UID, '重试组');
    expect(created.ok).toBe(true);
    const backupsAfter = fs.readdirSync(path.join(tmpDir, UID, 'local'))
      .filter((n) => n.startsWith('ontology-v1-backup-'));
    expect(backupsAfter.length).toBe(1);
    const persisted = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(persisted.groups.map((g: any) => g.title).sort()).toEqual(['工作偏好', '重试组']);
    expect(persisted.trash.length).toBe(0);
  });
});
