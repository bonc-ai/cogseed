import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 旧式模板组 → 模板文件 迁移测试（migrateLegacyTemplateGroups）。
 *
 * 旧式形态（阶段 B/C）：一个模板 = 多个独立组文件（UUID 名，双区格式），
 * groups.md 里每行带 `- 模板: student@1.0.0`。新形态：一个模板 = 一个
 * `<template_id>.md`（分节式）。迁移 = 合并字段值/来源/流水 + 台账替换 +
 * 旧文件移备份目录；启动时幂等（迁移后无旧式组 → 跳过）。
 */

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
const UID = 'test-user-migrate';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-tmpl-migrate-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadTmpl() {
  return import('../../../src/main/features/personal_ontology_template_files');
}

async function loadGroups() {
  return import('../../../src/main/features/personal_ontology_groups');
}

function groupsDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}

/** 构造旧式数据：模板组（title → 内容），并给台账写 template_id。 */
async function seedLegacyTemplate(groups: Awaited<ReturnType<typeof loadGroups>>, title: string, fields: Array<[string, string, string]>, entries: string[]): Promise<string> {
  const created = await groups.createGroup(UID, title);
  const gid = created.group!.group_id;
  for (const [f, v, src] of fields) await groups.appendFieldValue(UID, gid, f, v, src);
  for (const e of entries) await groups.appendToGroup(UID, gid, e);
  const all = groups.readGroups(UID);
  const idx = all.findIndex((g) => g.group_id === gid);
  all[idx] = { ...all[idx], template_id: 'student', template_version: '1.0.0' };
  groups.writeGroups(UID, all);
  return gid;
}

describe('migrateLegacyTemplateGroups', () => {
  it('merges legacy template groups into one <template_id>.md (values + sources + flow preserved)', async () => {
    const tmpl = await loadTmpl();
    const groups = await loadGroups();
    const gid1 = await seedLegacyTemplate(groups, '学习背景', [['教育阶段', '硕士', '智能'], ['专业与学习方向', '人工智能', '手动']], ['参加了数学建模竞赛']);
    await seedLegacyTemplate(groups, '学期与课程', [['课程清单', '机器学习', '智能']], []);

    const res = await tmpl.migrateLegacyTemplateGroups(UID);
    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(1);
    expect(res.groups_moved).toBe(2);

    const fileText = fs.readFileSync(path.join(groupsDir(), 'student.md'), 'utf8');
    expect(fileText).toContain('# 学生（模板）');
    expect(fileText).toContain('> 模板: student@0.2.0-review.1');
    expect(fileText).toContain('## 学习背景');
    expect(fileText).toContain('### 教育阶段\n- 硕士 [智能]');
    expect(fileText).toContain('### 专业与学习方向\n- 人工智能 [手动]');
    expect(fileText).toContain('## 学期与课程');
    expect(fileText).toContain('### 课程清单\n- 机器学习 [智能]');
    // 流水 + 未填空坑（种子全量）
    expect(fileText).toContain('参加了数学建模竞赛');
    expect(fileText).toContain('### 学习目标');
    expect(fileText).toContain('### 作业');
    expect(fileText).toContain('### 教师与同伴');
  });

  it('keeps custom fields not declared in the seed, into the matching section', async () => {
    const tmpl = await loadTmpl();
    const groups = await loadGroups();
    await seedLegacyTemplate(groups, '课程', [['我的自定义字段', '值甲', '手动']], []);

    await tmpl.migrateLegacyTemplateGroups(UID);
    const fileText = fs.readFileSync(path.join(groupsDir(), 'student.md'), 'utf8');
    expect(fileText).toContain('### 我的自定义字段\n- 值甲 [手动]');
  });

  it('renamed group (title not in seed) becomes its own section, data preserved', async () => {
    const tmpl = await loadTmpl();
    const groups = await loadGroups();
    await seedLegacyTemplate(groups, '课题组', [['课题名', '知识图谱', '手动']], ['一条流水']);

    await tmpl.migrateLegacyTemplateGroups(UID);
    const fileText = fs.readFileSync(path.join(groupsDir(), 'student.md'), 'utf8');
    expect(fileText).toContain('## 课题组');
    expect(fileText).toContain('### 课题名\n- 知识图谱 [手动]');
    expect(fileText).toContain('一条流水');
  });

  it('replaces ledger rows: no legacy template rows remain, one template-file row added', async () => {
    const tmpl = await loadTmpl();
    const groups = await loadGroups();
    await seedLegacyTemplate(groups, '课程', [], []);
    await seedLegacyTemplate(groups, '项目', [], []);

    await tmpl.migrateLegacyTemplateGroups(UID);
    const all = groups.readGroups(UID);
    expect(all.filter((g) => g.template_id === 'student')).toHaveLength(1);
    const row = all.find((g) => g.template_id === 'student')!;
    expect(row.title).toBe('学生');
    expect(row.rel_path).toBe('.personal_ontology_groups/student.md');
    // 没有残留的旧式课程/项目组行
    expect(all.some((g) => g.title === '课程' && !g.template_id)).toBe(false);
    expect(all.some((g) => g.title === '项目' && !g.template_id)).toBe(false);
  });

  it('moves old group files into _backup_* dir (not deleted)', async () => {
    const tmpl = await loadTmpl();
    const groups = await loadGroups();
    const gid = await seedLegacyTemplate(groups, '课程', [['课程名称', '高等数学', '智能']], []);

    await tmpl.migrateLegacyTemplateGroups(UID);
    const backups = fs.readdirSync(groupsDir()).filter((f) => f.startsWith('_backup_'));
    expect(backups.length).toBe(1);
    expect(fs.readdirSync(path.join(groupsDir(), backups[0]))).toContain(`${gid}.md`);
    // 旧文件已不在原位置
    expect(fs.existsSync(path.join(groupsDir(), `${gid}.md`))).toBe(false);
  });

  it('is idempotent: second run migrates nothing', async () => {
    const tmpl = await loadTmpl();
    const groups = await loadGroups();
    await seedLegacyTemplate(groups, '课程', [], []);
    const first = await tmpl.migrateLegacyTemplateGroups(UID);
    expect(first.migrated).toBe(1);
    const again = await tmpl.migrateLegacyTemplateGroups(UID);
    expect(again.ok).toBe(true);
    expect(again.migrated).toBe(0);
    expect(again.groups_moved).toBe(0);
  });

  it('no legacy groups → migrated 0, no-op', async () => {
    const tmpl = await loadTmpl();
    const res = await tmpl.migrateLegacyTemplateGroups(UID);
    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(0);
    expect(res.groups_moved).toBe(0);
  });
});
