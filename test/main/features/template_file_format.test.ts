import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 模板文件格式（一个模板 = 一个 md 文件，`## 分节` + `### 字段小节`，字段挖空
 * 清单与值合一）的 parse/serialize 纯函数测试。
 *
 * 关键差异 vs 普通组双区格式：
 * - 模板文件含 `> 模板: <id>@<version>` 元信息行（文件类型标记）
 * - 空坑落盘：字段小节存在但无值行 = 空坑（合一：文件里看得到"要填哪些"）
 * - 流水在分节级（`### 流水`），不是文件级 `## 流水区`
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-tmpl-file-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import('../../../src/main/features/personal_ontology_template_files');
}

// 规范模板文件（seed 生成的格式）
const SEED_TEXT = [
  '# 学生（模板）',
  '',
  '> 模板: student@1.0.0 | 已安装: 2026-08-04T09:30:00',
  '',
  '## 课程',
  '',
  '### 课程名称',
  '- 高等数学 [智能]',
  '',
  '### 学校',
  '- 北京大学 [手动]',
  '',
  '### 专业',
  '',
  '### 流水',
  '',
  '参加了数学建模竞赛',
  '',
  '## 项目',
  '',
  '### 项目名称',
  '',
  '### 角色',
  '',
  '### 状态',
  '',
  '### 流水',
  '',
  '## 技能',
  '',
  '### 技能名',
  '- Python [智能]',
  '',
  '### 熟练度',
  '',
  '### 流水',
  '',
  '## 偏好',
  '',
  '### 沟通风格',
  '- 喜欢大白话 [智能]',
  '',
  '### 工具偏好',
  '',
  '### 流水',
  '',
].join('\n');

describe('template_file_format › parseTemplateContent', () => {
  it('parses meta line: template_id / version / installed_at', async () => {
    const m = await loadMod();
    const c = m.parseTemplateContent(SEED_TEXT);
    expect(c.template_id).toBe('student');
    expect(c.version).toBe('1.0.0');
    expect(c.installed_at).toBe('2026-08-04T09:30:00');
  });

  it('parses sections in file order with fields (values + sources) and flow', async () => {
    const m = await loadMod();
    const c = m.parseTemplateContent(SEED_TEXT);
    expect(c.sections.map((s) => s.title)).toEqual(['课程', '项目', '技能', '偏好']);
    const course = c.sections[0];
    expect(course.fields['课程名称']).toEqual([{ value: '高等数学', source: '智能' }]);
    expect(course.fields['学校']).toEqual([{ value: '北京大学', source: '手动' }]);
    expect(course.flowEntries).toEqual(['参加了数学建模竞赛']);
  });

  it('empty field section = empty pit (fields[name] is empty array, key present)', async () => {
    const m = await loadMod();
    const c = m.parseTemplateContent(SEED_TEXT);
    const course = c.sections[0];
    // 空坑：小节存在、无值行
    expect(course.fields['专业']).toEqual([]);
    expect('专业' in course.fields).toBe(true);
    // 有值字段不受影响
    expect(course.fields['课程名称'].length).toBe(1);
  });

  it('sections with no flow keep empty flowEntries', async () => {
    const m = await loadMod();
    const c = m.parseTemplateContent(SEED_TEXT);
    expect(c.sections[1].flowEntries).toEqual([]); // 项目
    expect(c.sections[2].flowEntries).toEqual([]); // 技能
  });

  it('missing [source] defaults to 手动 (shared value-line grammar)', async () => {
    const m = await loadMod();
    const text = [
      '# 学生（模板）',
      '',
      '> 模板: student@1.0.0 | 已安装: 2026-08-04T09:30:00',
      '',
      '## 课程',
      '',
      '### 课程名称',
      '- 无来源标记的值',
      '',
      '### 流水',
      '',
    ].join('\n');
    const c = m.parseTemplateContent(text);
    expect(c.sections[0].fields['课程名称']).toEqual([{ value: '无来源标记的值', source: '手动' }]);
  });

  it('escaped [ inside value is restored and relation A → B preserved', async () => {
    const m = await loadMod();
    const text = [
      '# 学生（模板）',
      '',
      '> 模板: student@1.0.0 | 已安装: 2026-08-04T09:30:00',
      '',
      '## 项目',
      '',
      '### 项目名称',
      '- 项目「晚风」 \\[已归档] [手动]',
      '',
      '### 所属课程',
      '- 数据结构 → 课程.课程名称 [智能]',
      '',
      '### 流水',
      '',
    ].join('\n');
    const c = m.parseTemplateContent(text);
    expect(c.sections[0].fields['项目名称']).toEqual([{ value: '项目「晚风」 [已归档]', source: '手动' }]);
    expect(c.sections[0].fields['所属课程']).toEqual([{ value: '数据结构 → 课程.课程名称', source: '智能' }]);
  });

  it('user-added custom field sections are parsed too', async () => {
    const m = await loadMod();
    const text = [
      '# 学生（模板）',
      '',
      '> 模板: student@1.0.0 | 已安装: 2026-08-04T09:30:00',
      '',
      '## 课程',
      '',
      '### 课程名称',
      '- 高等数学 [智能]',
      '',
      '### 我的自定义字段',
      '- 值甲 [手动]',
      '',
      '### 流水',
      '',
    ].join('\n');
    const c = m.parseTemplateContent(text);
    expect(c.sections[0].fields['我的自定义字段']).toEqual([{ value: '值甲', source: '手动' }]);
  });
});

describe('template_file_format › serializeTemplateContent', () => {
  it('serializes all declared fields including empty pits (合一: 空坑落盘)', async () => {
    const m = await loadMod();
    const c = m.parseTemplateContent(SEED_TEXT);
    const out = m.serializeTemplateContent(c);
    // 空坑小节必须出现在输出里
    expect(out).toContain('### 专业');
    expect(out).toContain('### 项目名称');
    expect(out).toContain('### 熟练度');
    // 值行带来源
    expect(out).toContain('- 高等数学 [智能]');
    // 分节级流水（单条目无 § 行；§ 只作条目间分隔）
    expect(out).toContain('### 流水');
    expect(out).toContain('参加了数学建模竞赛');
  });

  it('round-trips byte-identical on canonical text', async () => {
    const m = await loadMod();
    const c = m.parseTemplateContent(SEED_TEXT);
    expect(m.serializeTemplateContent(c)).toBe(SEED_TEXT);
  });

  it('round-trips parse(serialize(parse(x))) == parse(x) for hand-edited text with extra blank lines', async () => {
    const m = await loadMod();
    const handEdited = SEED_TEXT.replace('\n### 学校\n', '\n\n\n### 学校\n') + '\n\n';
    const c1 = m.parseTemplateContent(handEdited);
    const out = m.serializeTemplateContent(c1);
    const c2 = m.parseTemplateContent(out);
    expect(c2).toEqual(c1);
  });

  it('serializes multiple flow entries with § separators (entry1 § entry2)', async () => {
    const m = await loadMod();
    const text = [
      '# 学生（模板）',
      '',
      '> 模板: student@1.0.0 | 已安装: 2026-08-04T09:30:00',
      '',
      '## 课程',
      '',
      '### 课程名称',
      '',
      '### 流水',
      '',
      '参加了数学建模竞赛',
      '§',
      '期末报告延期到下周',
      '',
    ].join('\n');
    const c = m.parseTemplateContent(text);
    expect(c.sections[0].flowEntries).toEqual(['参加了数学建模竞赛', '期末报告延期到下周']);
    const out = m.serializeTemplateContent(c);
    expect(out).toContain('参加了数学建模竞赛\n§\n期末报告延期到下周');
  });
});

describe('template_file_format › isTemplateFileText', () => {
  it('true when the file carries the `> 模板:` marker line', async () => {
    const m = await loadMod();
    expect(m.isTemplateFileText(SEED_TEXT)).toBe(true);
  });

  it('false for plain dual-zone group files and empty text', async () => {
    const m = await loadMod();
    expect(m.isTemplateFileText('## 字段区\n\n### 偏好\n- 值 [手动]\n\n## 流水区\n\n')).toBe(false);
    expect(m.isTemplateFileText('')).toBe(false);
    expect(m.isTemplateFileText('第一行\n§\n第二行')).toBe(false);
  });
});

describe('template_file_format › composite content ref (分节寻址)', () => {
  it('builds and splits `groupId::section` refs', async () => {
    const m = await loadMod();
    const ref = m.buildContentRef('abc123', '课程');
    expect(ref).toBe('abc123::课程');
    expect(m.splitContentRef(ref)).toEqual({ groupId: 'abc123', section: '课程' });
    // 普通组 id 无 `::` → section 为 null
    expect(m.splitContentRef('abc123')).toEqual({ groupId: 'abc123', section: null });
    // 分节名里带 `::` 的极端情况只切第一个
    expect(m.splitContentRef('abc123::a::b')).toEqual({ groupId: 'abc123', section: 'a::b' });
  });
});
