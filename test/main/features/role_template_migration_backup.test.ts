import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 两条备份生命周期的隔离。
 *
 * `_backup_<ts>/` 属于 uninstall / restore：卸载时把模板文件整体移进去，
 * 重装勾选「恢复原数据」时 `readTemplateArchive` 从中挑最新一份写回。
 * `_migration_<ts>/` 属于 schema migration：迁移前复制一份留作回退凭据。
 *
 * 如果两者共用 `_backup_` 前缀，一次「卸载 → 重装并恢复原数据」就可能捡到
 * 一份迁移中间态的旧版本文件 —— 只在特定操作序列下出现，很难复现。
 * 这组测试就是钉住「restore 的发现路径永远看不见 migration 备份」。
 */

let CATALOG: any[] = [];

vi.mock('../../../src/main/features/role_templates', () => ({
  listRoleTemplates: () => JSON.parse(JSON.stringify(CATALOG)),
  getRoleTemplate: (id: string) => {
    const found = CATALOG.find((t) => t.template_id === id);
    return found ? JSON.parse(JSON.stringify(found)) : undefined;
  },
  listScenarios: () => [],
  getScenario: () => undefined,
}));
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-migration-backup';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-mig-backup-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  CATALOG = [{
    template_id: 'probe',
    name: '探针角色',
    description: '',
    version: '1.0.0',
    preset_groups: [{ id: 'background', title: '背景', fields: [{ id: 'major', name: '专业' }] }],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const load = () => import('../../../src/main/features/personal_ontology_template_files');

describe('migration backup › 目录与内容', () => {
  it('迁移备份落在 _migration_<ts>/ 下，且是复制不是移动', async () => {
    const t = await load();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    const before = t.readTemplateFileText(UID, 'probe');

    const dir = t.backupTemplateFileForMigration(UID, 'probe');
    expect(dir).toBeTruthy();
    expect(path.basename(dir!)).toMatch(/^_migration_\d+$/);
    expect(fs.readFileSync(path.join(dir!, 'probe.md'), 'utf8')).toBe(before);

    // 复制：活文件必须还在原位（移动会在「已备份、新文件未写」的窗口里让它消失）
    expect(t.readTemplateFileText(UID, 'probe')).toBe(before);
  });

  it('源文件不存在 → 返回 null，不建空目录', async () => {
    const t = await load();
    expect(t.backupTemplateFileForMigration(UID, 'probe')).toBeNull();
    expect(t.listMigrationBackupDirs(UID)).toEqual([]);
  });
});

describe('migration backup › restore 发现路径永远看不见它', () => {
  it('只有 migration 备份时，重装恢复找不到任何归档', async () => {
    const t = await load();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    t.backupTemplateFileForMigration(UID, 'probe');

    expect(t.templateHasArchive(UID, 'probe')).toBe(false);
    expect(t.readTemplateArchive(UID, 'probe')).toBeNull();
  });

  it('migration 备份比 uninstall 归档更新时，恢复仍然取 uninstall 归档', async () => {
    const t = await load();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);

    // 写一条值，让卸载归档带上可识别内容
    const groupId = t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
    expect((await t.appendExistingTemplateFieldValueToRef(
      UID, t.buildContentRef(groupId, '背景'), '专业', '软件工程', '手动',
    )).ok).toBe(true);
    const uninstalled = t.readTemplateFileText(UID, 'probe');
    expect(uninstalled).toContain('软件工程');

    expect((await t.uninstallTemplateFile(UID, 'probe')).ok).toBe(true);

    // 之后再落一份内容完全不同的 migration 备份（时间戳更新）
    fs.mkdirSync(path.join(tmpDir, 'data', UID, 'cloud'), { recursive: true });
    const migDir = path.join(path.dirname(t.templateFileAbsPath(UID, 'probe')), `_migration_${Date.now() + 5000}`);
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(migDir, 'probe.md'), '# 迁移中间态（绝不能被 restore 捡走）\n', 'utf8');

    expect(t.templateHasArchive(UID, 'probe')).toBe(true);
    const restored = t.readTemplateArchive(UID, 'probe');
    expect(restored).toBe(uninstalled);
    expect(restored).not.toContain('迁移中间态');
  });

  it('clearTemplateArchives 不会顺手删掉 migration 备份', async () => {
    const t = await load();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    const migDir = t.backupTemplateFileForMigration(UID, 'probe')!;
    expect((await t.uninstallTemplateFile(UID, 'probe')).ok).toBe(true);

    t.clearTemplateArchives(UID, 'probe');
    expect(fs.existsSync(path.join(migDir, 'probe.md'))).toBe(true);
  });
});

describe('migration backup › 保留策略', () => {
  it('每个模板只保留最近 N 份，更老的被清理', async () => {
    const t = await load();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    const base = path.dirname(t.templateFileAbsPath(UID, 'probe'));

    // 造 5 份（时间戳递增），内容各不相同以便确认留下的是最新的
    for (let i = 1; i <= 5; i++) {
      const dir = path.join(base, `_migration_${1000 + i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'probe.md'), `backup-${i}\n`, 'utf8');
    }
    expect(t.listMigrationBackupDirs(UID).length).toBe(5);

    t.pruneMigrationBackups(UID, 'probe', 3);

    const left = t.listMigrationBackupDirs(UID);
    expect(left.length).toBe(3);
    expect(left.map((d) => fs.readFileSync(path.join(d, 'probe.md'), 'utf8').trim()))
      .toEqual(['backup-5', 'backup-4', 'backup-3']);
  });

  it('清理只动本模板的文件，目录里还有别的模板时不删目录', async () => {
    const t = await load();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    const base = path.dirname(t.templateFileAbsPath(UID, 'probe'));

    for (let i = 1; i <= 4; i++) {
      const dir = path.join(base, `_migration_${2000 + i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'probe.md'), `p-${i}\n`, 'utf8');
      fs.writeFileSync(path.join(dir, 'other.md'), `o-${i}\n`, 'utf8');
    }

    t.pruneMigrationBackups(UID, 'probe', 3);

    const oldest = path.join(base, '_migration_2001');
    expect(fs.existsSync(path.join(oldest, 'probe.md'))).toBe(false);
    expect(fs.existsSync(path.join(oldest, 'other.md'))).toBe(true);
  });
});
