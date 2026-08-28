import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/**
 * @ Picker「本体」tab 在 opaque ref 上的行为回归。
 *
 * 收归后渲染层拿到的是 PO contract 的 { ref, label, parentId, parentLabel }，
 * 不再有 group_id、也不再自己拼 `${group_id}::${section}`。这里锁住三件事：
 * 分组（有 parentId 的收进可折叠标题行）、搜索（分组名命中保留整组）、
 * 选中（data-id 恒等于 contract 给的 ref，原样透传给 chat-use）。
 */

const agentsSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/agents.js'),
  'utf8',
);

function extractFn(name: string): string {
  const marker = `function ${name}(`;
  const start = agentsSource.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  let depth = 0;
  let i = agentsSource.indexOf('{', start);
  const open = i;
  for (; i < agentsSource.length; i++) {
    if (agentsSource[i] === '{') depth++;
    else if (agentsSource[i] === '}') {
      depth--;
      if (depth === 0) return agentsSource.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${name} (from ${open})`);
}

function loadPicker(collapsed: string[] = []) {
  const context: any = {
    escapeHtml: (s: unknown) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    _pickerOntologyCollapsed: new Set(collapsed),
  };
  vm.createContext(context);
  vm.runInContext(extractFn('_ontologyPickerRowHtml'), context);
  vm.runInContext(extractFn('_ontologyPickerSectionsHtml'), context);
  return context;
}

const ENTRIES = [
  { ref: 'po1AAAA', label: '我的随手记' },
  { ref: 'po1BBBB', label: '学习背景', parentId: 'student', parentLabel: '学生' },
  { ref: 'po1CCCC', label: '目标与节奏', parentId: 'student', parentLabel: '学生' },
  { ref: 'po1DDDD', label: '技术专长', parentId: 'software_engineer', parentLabel: '软件工程师' },
];

describe('ontology picker › opaque ref 渲染', () => {
  it('无 parentId 平铺，有 parentId 收进按 parentLabel 命名的可折叠标题行', () => {
    const ctx = loadPicker();
    const html = ctx._ontologyPickerSectionsHtml(ENTRIES, new Set());

    expect(html).toContain('data-ontology-template-toggle="student"');
    expect(html).toContain('>学生<');
    expect(html).toContain('data-ontology-template-toggle="software_engineer"');
    expect(html).toContain('>软件工程师<');
    // 平铺条目不带子项样式，分组子项带
    expect(html).toContain('data-id="po1AAAA"');
    expect(html).toMatch(/is-template-child[^>]*data-id="po1BBBB"/);
    expect(html).not.toMatch(/is-template-child[^>]*data-id="po1AAAA"/);
  });

  it('data-id 恒等于 contract 给的 ref —— 渲染层不拼接、不出现 ::', () => {
    const ctx = loadPicker();
    const html = ctx._ontologyPickerSectionsHtml(ENTRIES, new Set());
    for (const e of ENTRIES) expect(html).toContain(`data-id="${e.ref}"`);
    expect(html).not.toContain('::');
  });

  it('选中态按 ref 命中', () => {
    const ctx = loadPicker();
    const html = ctx._ontologyPickerSectionsHtml(ENTRIES, new Set(['po1CCCC']));
    expect(html).toMatch(/is-checked[^>]*data-id="po1CCCC"/);
    expect(html).not.toMatch(/is-checked[^>]*data-id="po1BBBB"/);
  });

  it('折叠的分组只渲染标题行，不渲染子条目', () => {
    const ctx = loadPicker(['student']);
    const html = ctx._ontologyPickerSectionsHtml(ENTRIES, new Set());
    expect(html).toContain('data-ontology-template-toggle="student"');
    expect(html).not.toContain('data-id="po1BBBB"');
    expect(html).toContain('data-id="po1DDDD"'); // 未折叠的分组不受影响
  });

  it('缺 ref 的脏条目被跳过，不产生无 data-id 的空行', () => {
    const ctx = loadPicker();
    const html = ctx._ontologyPickerSectionsHtml(
      [...ENTRIES, { label: '坏条目' }, null],
      new Set(),
    );
    expect(html).not.toContain('坏条目');
  });
});

describe('ontology picker › 搜索过滤（单一路径）', () => {
  // 过滤逻辑在 _renderOntologyPickerList 里，这里按源码断言其形状：
  // 收归前是 groups 与 templates 两条独立过滤路径，收归后只剩一条。
  const source = agentsSource;

  it('分组名命中时保留该分组全部条目', () => {
    expect(source).toContain('const hitParents = new Set(');
    expect(source).toContain("_matchPickerItem(q, e.parentLabel, '', '')");
    expect(source).toContain("_matchPickerItem(q, e.label, '', '') || (e.parentId && hitParents.has(e.parentId))");
  });

  it('只有一个数据源与一条过滤路径（旧的 groups.list + templates.list 双路已删）', () => {
    expect(source).toContain("window.cogseed.invoke('personalOntology.entries.list'");
    expect(source).not.toContain('_loadOntologyPickerGroups');
    expect(source).not.toContain('_pickerOntologyTemplates');
    expect(source).not.toContain('_pickerOntologyLastQuery');
  });
});
