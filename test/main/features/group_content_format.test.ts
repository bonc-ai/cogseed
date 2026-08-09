import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 组内容文件双区格式（`## 字段区` / `## 流水区`）的 parse/serialize 纯函数
 * 与字段操作（appendFieldValue / setFieldValue / removeFieldValue / removeField
 * / removeEntry / promoteEntryToField）测试。
 *
 * 裁决说明（任务书 §2.1 与 §1.5 冲突的处理）：
 * - 无字段区的旧纯文本文件：append 保持行为等价（纯文本、§ 追加），
 *   由现有 personal_ontology_groups.test.ts 断言锁定；
 * - 首次“写字段”时才升级为双区格式（自动补标题，内容无损）。
 */

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-format';

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-onto-format-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadGroups() {
  return import('../../../src/main/features/personal_ontology_groups');
}

function groupsDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}

function groupFile(groupId: string): string {
  return path.join(groupsDir(), `${groupId}.md`);
}

async function createGroupWith(title: string) {
  const g = await loadGroups();
  const res = await g.createGroup(UID, title);
  if (!res.ok || !res.group) throw new Error('createGroup failed: ' + res.error);
  return { groups: g, groupId: res.group.group_id };
}

// ── parse / serialize 纯函数 ────────────────────────────────────────────────

describe('group_content_format › parseGroupContent', () => {
  it('parses a dual-zone file: fields with sources + flow entries', async () => {
    const g = await loadGroups();
    const text = [
      '## 字段区',
      '',
      '### 偏好',
      '- 沟通风格：喜欢大白话，先讲原理再举例 [候选]',
      '- 工具偏好：功能互补工具倾向探索整合 [候选]',
      '',
      '### 课程',
      '- 《知识工程》 [手动]',
      '',
      '---',
      '',
      '## 流水区',
      '',
      'KSTAR 核心实现在 mate-agent 项目',
      '§',
      'KSTAR 源码分布在多个位置',
    ].join('\n');

    const c = g.parseGroupContent(text);
    expect(c.fields['偏好']).toEqual([
      { value: '沟通风格：喜欢大白话，先讲原理再举例', source: '候选' },
      { value: '工具偏好：功能互补工具倾向探索整合', source: '候选' },
    ]);
    expect(c.fields['课程']).toEqual([{ value: '《知识工程》', source: '手动' }]);
    expect(c.entries).toEqual(['KSTAR 核心实现在 mate-agent 项目', 'KSTAR 源码分布在多个位置']);
  });

  it('old plain-text file (no zone headers) → fields empty, entries intact', async () => {
    const g = await loadGroups();
    const text = '第一行\n§\n第二行';
    const c = g.parseGroupContent(text);
    expect(c.fields).toEqual({});
    expect(c.entries).toEqual(['第一行', '第二行']);
  });

  it('missing [source] defaults to 手动', async () => {
    const g = await loadGroups();
    const text = '## 字段区\n\n### 偏好\n- 无来源标记的值\n\n## 流水区\n\n内容';
    const c = g.parseGroupContent(text);
    expect(c.fields['偏好']).toEqual([{ value: '无来源标记的值', source: '手动' }]);
    expect(c.entries).toEqual(['内容']);
  });

  it('escaped [ inside a value is restored (\\[ → [)', async () => {
    const g = await loadGroups();
    const text = '## 字段区\n\n### 项目\n- 项目「晚风」 \\[已归档] [手动]\n\n## 流水区\n\n';
    const c = g.parseGroupContent(text);
    expect(c.fields['项目']).toEqual([{ value: '项目「晚风」 [已归档]', source: '手动' }]);
  });

  it('relation value A → B is preserved as-is', async () => {
    const g = await loadGroups();
    const text = '## 字段区\n\n### 项目\n- 项目「晚风」 → Flutter [手动]\n\n## 流水区\n\n';
    const c = g.parseGroupContent(text);
    expect(c.fields['项目']).toEqual([{ value: '项目「晚风」 → Flutter', source: '手动' }]);
  });

  it('flow entries stay order-preserved, separator inside text is not split', async () => {
    const g = await loadGroups();
    const text = '## 字段区\n\n## 流水区\n\n第一条\n§\n第二条\n§\n第三条';
    const c = g.parseGroupContent(text);
    expect(c.entries).toEqual(['第一条', '第二条', '第三条']);
  });
});

describe('group_content_format › serializeGroupContent', () => {
  it('round-trips: serialize(parse(text)) === text for dual-zone files', async () => {
    const g = await loadGroups();
    const text = [
      '## 字段区',
      '',
      '### 偏好',
      '- 沟通风格：喜欢大白话 [候选]',
      '- 工具偏好：功能互补工具 [候选]',
      '',
      '### 课程',
      '- 《知识工程》 [手动]',
      '',
      '---',
      '',
      '## 流水区',
      '',
      '第一条',
      '§',
      '第二条',
    ].join('\n');
    const c = g.parseGroupContent(text);
    expect(g.serializeGroupContent(c)).toBe(text);
  });

  it('no fields → no 字段区 header, entries joined by separator', async () => {
    const g = await loadGroups();
    const out = g.serializeGroupContent({ fields: {}, entries: ['a', 'b'] });
    expect(out).toBe('a\n§\nb');
  });

  it('empty content → empty string', async () => {
    const g = await loadGroups();
    expect(g.serializeGroupContent({ fields: {}, entries: [] })).toBe('');
  });

  it('escapes [ inside values on serialize (→ \\[), round-trip safe', async () => {
    const g = await loadGroups();
    const c = { fields: { 项目: [{ value: '项目「晚风」 [已归档]', source: '手动' }] }, entries: [] };
    const out = g.serializeGroupContent(c);
    expect(out).toContain('- 项目「晚风」 \\[已归档] [手动]');
    expect(g.parseGroupContent(out)).toEqual(c);
  });
});

describe('group_content_format › parseFieldValueLine', () => {
  it('matches "- value [source]" and returns value+source', async () => {
    const g = await loadGroups();
    expect(g.parseFieldValueLine('- abc [候选]')).toEqual({ value: 'abc', source: '候选' });
    expect(g.parseFieldValueLine('- a:b:c [导入]')).toEqual({ value: 'a:b:c', source: '导入' });
    expect(g.parseFieldValueLine('- 值里有 [括号] [手动]')).toEqual({ value: '值里有 [括号]', source: '手动' });
  });

  it('returns null for non-matching lines; bare value line defaults to 手动', async () => {
    const g = await loadGroups();
    expect(g.parseFieldValueLine('### 偏好')).toBeNull();
    expect(g.parseFieldValueLine('普通文本')).toBeNull();
    expect(g.parseFieldValueLine('')).toBeNull();
    expect(g.parseFieldValueLine('- 没有来源')).toEqual({ value: '没有来源', source: '手动' });
  });
});

// ── IO 函数：双区升级 + 字段操作 ───────────────────────────────────────────

describe('group_content_format › appendToGroup dual-zone upgrade', () => {
  it('append to an old plain-text file keeps plain-text behaviour (back-compat, §-append)', async () => {
    const { groups, groupId } = await createGroupWith('旧组');
    await groups.appendToGroup(UID, groupId, 'first note');
    await groups.appendToGroup(UID, groupId, 'second note');
    expect(fs.readFileSync(groupFile(groupId), 'utf8')).toBe('first note\n§\nsecond note');
  });

  it('append to a dual-zone file keeps dual-zone format and appends to 流水区 only', async () => {
    const { groups, groupId } = await createGroupWith('双区组');
    await groups.appendFieldValue(UID, groupId, '偏好', '喜欢大白话', '候选');
    await groups.appendToGroup(UID, groupId, '流水补充');

    const content = fs.readFileSync(groupFile(groupId), 'utf8');
    expect(content).toContain('## 字段区');
    expect(content).toContain('## 流水区');
    expect(content).toContain('流水补充');
    const c = groups.parseGroupContent(content);
    expect(c.fields['偏好']).toEqual([{ value: '喜欢大白话', source: '候选' }]);
    expect(c.entries).toEqual(['流水补充']);
  });
});

describe('group_content_format › appendFieldValue', () => {
  it('creates the field section, appends multi-values with sources, never overwrites', async () => {
    const { groups, groupId } = await createGroupWith('偏好组');
    const r1 = await groups.appendFieldValue(UID, groupId, '沟通风格', '喜欢大白话', '候选');
    expect(r1.ok).toBe(true);
    await groups.appendFieldValue(UID, groupId, '沟通风格', '先讲原理再举例', '手动');

    const content = fs.readFileSync(groupFile(groupId), 'utf8');
    expect(content).toContain('## 字段区');
    expect(content).toContain('### 沟通风格');
    expect(content).toContain('- 喜欢大白话 [候选]');
    expect(content).toContain('- 先讲原理再举例 [手动]');
  });

  it('dedupes exact (value, source) matches — same value+source skipped', async () => {
    const { groups, groupId } = await createGroupWith('去重组');
    await groups.appendFieldValue(UID, groupId, '偏好', '同一句话', '候选');
    await groups.appendFieldValue(UID, groupId, '偏好', '同一句话', '候选');
    const content = fs.readFileSync(groupFile(groupId), 'utf8');
    const c = groups.parseGroupContent(content);
    expect(c.fields['偏好']).toEqual([{ value: '同一句话', source: '候选' }]);
  });

  it('allows same value with different source (not a dupe)', async () => {
    const { groups, groupId } = await createGroupWith('来源区分');
    await groups.appendFieldValue(UID, groupId, '偏好', '同一句话', '候选');
    await groups.appendFieldValue(UID, groupId, '偏好', '同一句话', '手动');
    const c = groups.parseGroupContent(fs.readFileSync(groupFile(groupId), 'utf8'));
    expect(c.fields['偏好']).toHaveLength(2);
  });

  it('upgrades a plain-text old file to dual-zone when writing a field (content lossless)', async () => {
    const { groups, groupId } = await createGroupWith('老组');
    await groups.appendToGroup(UID, groupId, '历史条目');
    const r = await groups.appendFieldValue(UID, groupId, '偏好', '新字段值', '手动');
    expect(r.ok).toBe(true);

    const c = groups.parseGroupContent(fs.readFileSync(groupFile(groupId), 'utf8'));
    expect(c.fields['偏好']).toEqual([{ value: '新字段值', source: '手动' }]);
    expect(c.entries).toEqual(['历史条目']);
  });

  it('rejects unknown group / empty fieldName / empty value', async () => {
    const { groups, groupId } = await createGroupWith('g');
    expect((await groups.appendFieldValue(UID, 'nope', '偏好', 'v', '手动')).ok).toBe(false);
    expect((await groups.appendFieldValue(UID, groupId, '', 'v', '手动')).ok).toBe(false);
    expect((await groups.appendFieldValue(UID, groupId, '偏好', '   ', '手动')).ok).toBe(false);
  });
});

describe('group_content_format › setFieldValue / removeFieldValue / removeField', () => {
  it('setFieldValue replaces the matching value row', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendFieldValue(UID, groupId, '偏好', '旧值', '候选');
    const r = await groups.setFieldValue(UID, groupId, '偏好', '旧值', '新值');
    expect(r.ok).toBe(true);
    const c = groups.parseGroupContent(fs.readFileSync(groupFile(groupId), 'utf8'));
    expect(c.fields['偏好']).toEqual([{ value: '新值', source: '候选' }]);
  });

  it('setFieldValue leaves file untouched when oldValue not found', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendFieldValue(UID, groupId, '偏好', '旧值', '候选');
    const before = fs.readFileSync(groupFile(groupId), 'utf8');
    const r = await groups.setFieldValue(UID, groupId, '偏好', '不存在的值', '新值');
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(groupFile(groupId), 'utf8')).toBe(before);
  });

  it('removeFieldValue deletes the row; empty section is removed entirely', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendFieldValue(UID, groupId, '偏好', '唯一值', '手动');
    await groups.appendFieldValue(UID, groupId, '课程', '《课》', '手动');
    const r = await groups.removeFieldValue(UID, groupId, '偏好', '唯一值');
    expect(r.ok).toBe(true);

    const c = groups.parseGroupContent(fs.readFileSync(groupFile(groupId), 'utf8'));
    expect(c.fields['偏好']).toBeUndefined(); // 小节空 → 整个字段小节删除
    expect(c.fields['课程']).toEqual([{ value: '《课》', source: '手动' }]);
  });

  it('removeField deletes the whole field section with all values', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendFieldValue(UID, groupId, '偏好', 'v1', '手动');
    await groups.appendFieldValue(UID, groupId, '偏好', 'v2', '手动');
    const r = await groups.removeField(UID, groupId, '偏好');
    expect(r.ok).toBe(true);
    const c = groups.parseGroupContent(fs.readFileSync(groupFile(groupId), 'utf8'));
    expect(c.fields['偏好']).toBeUndefined();
  });

  it('removeFieldValue on missing value still ok (no-op), unknown group fails', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendFieldValue(UID, groupId, '偏好', 'v1', '手动');
    expect((await groups.removeFieldValue(UID, groupId, '偏好', '不存在')).ok).toBe(true);
    expect((await groups.removeFieldValue(UID, 'nope', '偏好', 'v1')).ok).toBe(false);
    expect((await groups.removeField(UID, 'nope', '偏好')).ok).toBe(false);
  });
});

describe('group_content_format › removeEntry', () => {
  it('removes exactly the matching flow entry, keeps the rest', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendToGroup(UID, groupId, '第一条');
    await groups.appendToGroup(UID, groupId, '第二条');
    await groups.appendToGroup(UID, groupId, '第三条');

    const r = await groups.removeEntry(UID, groupId, '第二条');
    expect(r.ok).toBe(true);
    const c = groups.parseGroupContent(fs.readFileSync(groupFile(groupId), 'utf8'));
    expect(c.entries).toEqual(['第一条', '第三条']);
  });

  it('missing entry → ok:false, file untouched', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendToGroup(UID, groupId, '唯一');
    const before = fs.readFileSync(groupFile(groupId), 'utf8');
    const r = await groups.removeEntry(UID, groupId, '不存在');
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(groupFile(groupId), 'utf8')).toBe(before);
  });
});

describe('group_content_format › promoteEntryToField', () => {
  it('moves a flow entry into a field section with source 手动', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendToGroup(UID, groupId, '这条要升格');
    const r = await groups.promoteEntryToField(UID, groupId, '这条要升格', '新字段');
    expect(r.ok).toBe(true);

    const c = groups.parseGroupContent(fs.readFileSync(groupFile(groupId), 'utf8'));
    expect(c.entries).toEqual([]);
    expect(c.fields['新字段']).toEqual([{ value: '这条要升格', source: '手动' }]);
  });

  it('entry not found → { ok:false, error: entry not found }', async () => {
    const { groups, groupId } = await createGroupWith('g');
    const r = await groups.promoteEntryToField(UID, groupId, '没有这条', '字段');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it('promoting the same entry twice fails the second time (idempotent)', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendToGroup(UID, groupId, '唯一条目');
    expect((await groups.promoteEntryToField(UID, groupId, '唯一条目', '字段A')).ok).toBe(true);
    const r2 = await groups.promoteEntryToField(UID, groupId, '唯一条目', '字段A');
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/not found/);
  });
});

describe('group_content_format › strip fields (parse → drop 字段区 → serialize)', () => {
  it('a dual-zone file stripped of all fields collapses back to plain flow text', async () => {
    const { groups, groupId } = await createGroupWith('g');
    await groups.appendFieldValue(UID, groupId, '偏好', '值1', '手动');
    await groups.appendToGroup(UID, groupId, '流水');

    // 删掉唯一字段后，serialize 不再输出字段区 —— 文件回到纯流水区形态
    await groups.removeField(UID, groupId, '偏好');
    const content = fs.readFileSync(groupFile(groupId), 'utf8');
    expect(content).toBe('流水');
    expect(content).not.toContain('## 字段区');
  });
});
