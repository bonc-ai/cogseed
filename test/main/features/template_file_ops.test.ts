import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 模板文件 ops：安装（installTemplateFile）、复合 id 读取（readContentById）、
 * 分节字段/流水写入（appendFieldValueToRef / appendFlowEntryToRef）、
 * 流水升格（promoteEntryToRef）、字段清单（listFieldsByRef）测试。
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
const UID = 'test-user-tmpl-ops';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-tmpl-ops-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import('../../../src/main/features/personal_ontology_template_files');
}

function groupsDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(groupsDir(), rel), 'utf8');
}

describe('template_file_ops › installTemplateFile', () => {
  it('creates <template_id>.md with all sections + empty pits, and a ledger row', async () => {
    const m = await loadMod();
    const res = await m.installTemplateFile(UID, 'student');
    expect(res.ok).toBe(true);
    expect(res.already_installed).toBeUndefined();
    expect(res.created).toHaveLength(1);
    expect(res.created![0].template_id).toBe('student');

    const fileText = readFile('student.md');
    expect(fileText).toContain('# 学生（模板）');
    expect(fileText).toContain('> 模板: student@0.2.0-review.1');
    // 全部分节 + 全部空坑落盘
    for (const section of ['学习背景', '目标与节奏', '时间与约束', '掌握状态', '学术诚信', '学期与课程', '任务与期限', '材料与掌握', '计划与记录', '协作关系']) expect(fileText).toContain(`## ${section}`);
    for (const field of ['教育阶段', '专业与学习方向', '学习目标', '学习风格', '学习节奏', '可用时间', '时间约束', '优势与薄弱领域', '学术诚信边界', '学期／学习周期', '课程清单', '教学要求', '作业', '考试', '截止时间', '获准学习材料', '知识掌握状态', '学习计划', '完成记录', '教师与同伴', '协作项目']) {
      expect(fileText).toContain(`### ${field}`);
    }
    expect(fileText).toContain('### 流水');

    // 台账行
    const groups = await m.readGroups(UID);
    const row = groups.find((g) => g.template_id === 'student');
    expect(row).toBeDefined();
    expect(row!.title).toBe('学生');
    expect(row!.rel_path).toBe('.personal_ontology_groups/student.md');
    expect(row!.template_version).toBe('0.2.0-review.1');
  });

  it('is idempotent: second install → already_installed, no new file overwrite', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    // 用户已填一个值
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    await m.appendFieldValueToRef(UID, m.buildContentRef(row.group_id, '课程'), '专业', '计算机科学', '手动');
    const first = readFile('student.md');
    const again = await m.installTemplateFile(UID, 'student');
    expect(again.ok).toBe(true);
    expect(again.already_installed).toBe(true);
    expect(readFile('student.md')).toBe(first); // 文件未被重置
  });

  it('reports name conflicts with plain groups (no template_id)', async () => {
    const m = await loadMod();
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    await groups.createGroup(UID, '学习背景');
    const res = await m.installTemplateFile(UID, 'student');
    expect(res.ok).toBe(true);
    expect(res.conflict_groups).toEqual([{ group_id: expect.any(String), title: '学习背景' }]);
  });

  it('unknown template → error', async () => {
    const m = await loadMod();
    const res = await m.installTemplateFile(UID, 'no-such-template');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('template not found');
  });
});

describe('template_file_ops › readContentById (复合 id 分节读取)', () => {
  let m: Awaited<ReturnType<typeof loadMod>>;
  let ref: string;

  beforeEach(async () => {
    m = await loadMod();
    const inst = await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    ref = m.buildContentRef(row.group_id, '学习背景');
  });

  it('composite ref returns the section markdown (with ## title, fields, flow)', async () => {
    const res = await m.readContentById(UID, ref);
    expect(res.ok).toBe(true);
    expect(res.section).toBe('学习背景');
    expect(res.content).toContain('## 学习背景');
    expect(res.content).toContain('### 教育阶段');
    expect(res.content).toContain('### 流水');
    expect(res.content).not.toContain('## 目标与节奏'); // 不含其他分节
  });

  it('plain group id returns the whole file (backward compat)', async () => {
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const created = await groups.createGroup(UID, '手工组');
    await groups.appendToGroup(UID, created.group!.group_id, '一条流水');
    const res = await m.readContentById(UID, created.group!.group_id);
    expect(res.ok).toBe(true);
    expect(res.section).toBeUndefined();
    expect(res.content).toContain('一条流水');
  });

  it('unknown section → error', async () => {
    const badRef = ref.replace('::学习背景', '::不存在的分节');
    const res = await m.readContentById(UID, badRef);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('section not found');
  });
});

describe('template_file_ops › appendFieldValueToRef (分节字段写入)', () => {
  let m: Awaited<ReturnType<typeof loadMod>>;
  let ref: string;

  beforeEach(async () => {
    m = await loadMod();
    const inst = await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    ref = m.buildContentRef(row.group_id, '学习背景');
  });

  it('writes a value into an empty pit with source marker', async () => {
    const res = await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能');
    expect(res.ok).toBe(true);
    expect(readFile('student.md')).toContain('### 教育阶段\n- 硕士 [智能]');
  });

  it('dedupes exact same value+source, appends different values', async () => {
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能');
    const dup = await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能');
    expect(dup.ok).toBe(true);
    const fileText = readFile('student.md');
    expect(fileText.match(/- 硕士 \[智能\]/g)).toHaveLength(1); // 去重
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '博士', '智能');
    expect(readFile('student.md')).toContain('- 硕士 [智能]\n- 博士 [智能]');
  });

  it('creates a user-defined field section on the fly', async () => {
    const res = await m.appendFieldValueToRef(UID, ref, '我的自定义字段', '值甲', '手动');
    expect(res.ok).toBe(true);
    expect(readFile('student.md')).toContain('### 我的自定义字段\n- 值甲 [手动]');
  });

  it('unknown section → error', async () => {
    const res = await m.appendFieldValueToRef(UID, `${ref}::不存在`, '教育阶段', 'x', '手动');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('section not found');
  });

  it('plain group ref forwards to dual-zone appendFieldValue', async () => {
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const created = await groups.createGroup(UID, '手工组');
    const res = await m.appendFieldValueToRef(UID, created.group!.group_id, '偏好', '喜欢大白话', '候选');
    expect(res.ok).toBe(true);
    expect(readFile(`${created.group!.group_id}.md`)).toContain('## 字段区');
    expect(readFile(`${created.group!.group_id}.md`)).toContain('- 喜欢大白话 [候选]');
  });
});

describe('template_file_ops › appendFlowEntryToRef (分节流水) & promoteEntryToRef (升格)', () => {
  let m: Awaited<ReturnType<typeof loadMod>>;
  let ref: string;

  beforeEach(async () => {
    m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    ref = m.buildContentRef(row.group_id, '学习背景');
  });

  it('appends flow entry to the section flow (not file-level)', async () => {
    const res = await m.appendFlowEntryToRef(UID, ref, '参加了数学建模竞赛');
    expect(res.ok).toBe(true);
    expect(readFile('student.md')).toContain('### 流水\n\n参加了数学建模竞赛');
  });

  it('promotes a section flow entry into the same section field (source 手动)', async () => {
    await m.appendFlowEntryToRef(UID, ref, '参加了数学建模竞赛');
    const res = await m.promoteEntryToRef(UID, ref, '参加了数学建模竞赛', '教育阶段');
    expect(res.ok).toBe(true);
    const fileText = readFile('student.md');
    expect(fileText).toContain('### 教育阶段\n- 参加了数学建模竞赛 [手动]');
    expect(fileText).not.toContain('参加了数学建模竞赛\n'); // 流水条目已移除（流水区不再含）
    expect(fileText).toContain('### 流水'); // 空流水小节仍在
  });

  it('promote unknown entry → error', async () => {
    const res = await m.promoteEntryToRef(UID, ref, '不存在的条目', '教育阶段');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('entry not found');
  });
});

describe('template_file_ops › listFieldsByRef (分节字段清单，含空坑)', () => {
  it('returns section fields including empty pits, in file order', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能');

    const res = await m.listFieldsByRef(UID, ref);
    expect(res.ok).toBe(true);
    const names = res.fields!.map((f) => f.name);
    expect(names).toEqual(['教育阶段', '专业与学习方向']);
    expect(res.fields![0].values).toEqual([{ value: '硕士', source: '智能' }]);
    expect(res.fields![1].values).toEqual([]); // 空坑
  });
});

// ── 二期 D5：模板分节字段来源项目标记（@proj:<pid>）────────────────────────

describe('template_file_ops › project source marker on template sections', () => {
  it('appendFieldValueToRef with project persists @proj:<pid> into the section file', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    const r = await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能', 'p_abc');
    expect(r.ok).toBe(true);
    expect(readFile('student.md')).toContain('- 硕士 [智能] @proj:p_abc');
  });

  it('listFieldsByRef returns the project field on values', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能', 'p_abc');

    const res = await m.listFieldsByRef(UID, ref);
    expect(res.ok).toBe(true);
    expect(res.fields![0].values).toEqual([{ value: '硕士', source: '智能', project: 'p_abc' }]);
  });

  it('same value+source+project dedupes on template sections too', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能', 'p_abc');
    const r2 = await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能', 'p_abc');
    expect(r2.ok).toBe(true);
    const res = await m.listFieldsByRef(UID, ref);
    expect(res.fields![0].values).toHaveLength(1);
  });

  it('round-trips a section value with project through serialize/parse', async () => {
    const m = await loadMod();
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const fv = { value: '机器学习', source: '智能', project: 'p_abc' };
    const line = groups.serializeFieldValueLine(fv);
    expect(line).toBe('- 机器学习 [智能] @proj:p_abc');
    expect(groups.parseFieldValueLine(line)).toEqual(fv);
  });
});

describe('template_file_ops › uninstall / archive / reinstall-restore', () => {
  it('uninstall archives the template file and removes the ledger row', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    // 写入一条字段值，验证归档时数据保留
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');

    const res = await m.uninstallTemplateFile(UID, 'student');
    expect(res.ok).toBe(true);
    expect(res.archive_dir).toBeTruthy();
    // 台账移除
    expect(m.readGroups(UID).some((g) => g.template_id === 'student')).toBe(false);
    // 原文件已移走
    expect(fs.existsSync(path.join(groupsDir(), 'student.md'))).toBe(false);
    // 归档目录有旧文件
    expect(fs.existsSync(path.join(res.archive_dir!, 'student.md'))).toBe(true);
  });

  it('reinstall with restoreData restores archived field values', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    await m.uninstallTemplateFile(UID, 'student');

    const again = await m.installTemplateFile(UID, 'student', true);
    expect(again.ok).toBe(true);
    expect(again.restored_from_archive).toBe(true);
    // 数据恢复
    const row2 = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref2 = m.buildContentRef(row2.group_id, '学习背景');
    const fields = await m.listFieldsByRef(UID, ref2);
    const edu = fields.fields!.find((f) => f.name === '教育阶段');
    expect(edu && edu.values).toEqual([{ value: '本科', source: '手动' }]);
  });

  it('reinstall without restoreData builds a fresh empty template', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    await m.uninstallTemplateFile(UID, 'student');

    const again = await m.installTemplateFile(UID, 'student', false);
    expect(again.ok).toBe(true);
    expect(again.restored_from_archive).toBeFalsy();
    const row2 = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref2 = m.buildContentRef(row2.group_id, '学习背景');
    const fields = await m.listFieldsByRef(UID, ref2);
    const edu = fields.fields!.find((f) => f.name === '教育阶段');
    expect(!edu || !edu.values || edu.values.length === 0).toBe(true);
  });

  it('uninstall is idempotent for a template that is not installed', async () => {
    const m = await loadMod();
    const res = await m.uninstallTemplateFile(UID, 'student');
    expect(res.ok).toBe(true);
    expect(res.archive_dir).toBeUndefined();
  });

  it('uninstall with archiveMemory archives role-tagged global memory and removes it from USER.md', async () => {
    const m = await loadMod();
    const mem = await import('../../../src/main/features/memory');
    await m.installTemplateFile(UID, 'student');
    // 写入一条带角色标签的全局记忆
    await mem.addRoleTemplateMemoryEntry(UID, 'user', 'student', '会主动核查工具执行过程');
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(1);

    const res = await m.uninstallTemplateFile(UID, 'student', true);
    expect(res.ok).toBe(true);
    expect(res.archived_memory_count).toBe(1);
    // 归档文件存在
    expect(fs.existsSync(path.join(res.archive_dir!, 'student.memory.md'))).toBe(true);
    // 全局记忆已移除
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(0);
    const userMd = fs.readFileSync(path.join(tmpDir, UID, 'cloud', 'memory', 'USER.md'), 'utf8');
    expect(userMd).not.toContain('会主动核查工具执行过程');
  });

  it('reinstall with restoreData restores archived global memory', async () => {
    const m = await loadMod();
    const mem = await import('../../../src/main/features/memory');
    await m.installTemplateFile(UID, 'student');
    await mem.addRoleTemplateMemoryEntry(UID, 'user', 'student', '会主动核查工具执行过程');
    await m.uninstallTemplateFile(UID, 'student', true);

    const again = await m.installTemplateFile(UID, 'student', true);
    expect(again.ok).toBe(true);
    expect(again.restored_memory_count).toBe(1);
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(1);
    const userMd = fs.readFileSync(path.join(tmpDir, UID, 'cloud', 'memory', 'USER.md'), 'utf8');
    expect(userMd).toContain('会主动核查工具执行过程');
    expect(userMd).toContain('role_template');
  });

  it('reinstall without restoreData does not restore archived memory', async () => {
    const m = await loadMod();
    const mem = await import('../../../src/main/features/memory');
    await m.installTemplateFile(UID, 'student');
    await mem.addRoleTemplateMemoryEntry(UID, 'user', 'student', '会主动核查工具执行过程');
    await m.uninstallTemplateFile(UID, 'student', true);

    const again = await m.installTemplateFile(UID, 'student', false);
    expect(again.ok).toBe(true);
    expect(again.restored_memory_count).toBeFalsy();
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(0);
  });

  it('B-1: archive writes the memory file BEFORE removing live data (crash-safe order)', async () => {
    const m = await loadMod();
    const mem = await import('../../../src/main/features/memory');
    await m.installTemplateFile(UID, 'student');
    await mem.addRoleTemplateMemoryEntry(UID, 'user', 'student', '崩溃窗口保护条目');
    const un = await m.uninstallTemplateFile(UID, 'student', true);
    expect(un.ok).toBe(true);
    expect(un.archived_memory_count).toBe(1);
    // 归档文件先于活数据删除存在：模拟归档已写但活数据未删的窗口
    // （重试卸载应基于"已归档文本"而非重新收集活数据 —— 本实现顺序保证归档先写）
    const archivedText = fs.readFileSync(path.join(un.archive_dir!, 'student.memory.md'), 'utf8');
    expect(archivedText).toContain('崩溃窗口保护条目');
  });

  it('B-2: readTemplateArchive picks the NEWEST backup when multiple exist', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    // 手工造两个归档目录（旧 + 新），内容不同
    const base = groupsDir();
    const oldDir = path.join(base, '_backup_1000000000000');
    const newDir = path.join(base, '_backup_2000000000000');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'student.md'), '# 旧数据');
    fs.writeFileSync(path.join(newDir, 'student.md'), '# 新数据');
    expect(m.readTemplateArchive(UID, 'student')).toContain('新数据');
  });

  it('B-2: reinstall with restoreData clears the archives afterwards', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const un = await m.uninstallTemplateFile(UID, 'student', true);
    expect(fs.existsSync(path.join(un.archive_dir!, 'student.md'))).toBe(true);
    const again = await m.installTemplateFile(UID, 'student', true);
    expect(again.ok).toBe(true);
    // 归档已清理（数据已回活）
    expect(m.templateHasArchive(UID, 'student')).toBe(false);
    expect(m.templateHasMemoryArchive(UID, 'student')).toBe(false);
  });
});
