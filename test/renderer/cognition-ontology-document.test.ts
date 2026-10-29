import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

function render(records: Record<string, any>, drafts: Record<string, any> = {}, extra: Record<string, any> = {}) {
  const window: Record<string, any> = {};
  for (const moduleName of ['icons.js', 'ui-button.js', 'ui-form.js']) {
    runInNewContext(readFileSync(resolve('src/renderer/modules', moduleName), 'utf8'), { window });
  }
  runInNewContext(readFileSync(resolve('src/renderer/modules/cognition-ontology-document.js'), 'utf8'), { window });
  return window.CogOntologyDocument.render({
    doc: { records }, moduleId: 'module', drafts,
    text: (_key: string, fallback: string, vars: Record<string, string> = {}) => String(fallback || _key).replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match),
    esc: (value: string) => value.replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]!),
    ...extra,
  });
}

const source = { kind: 'candidate', label: '会议摘录', recordId: 'candidate-1', refs: [{ kind: 'asset', id: 'asset-1' }] };
const base = { status: 'active', access: 'task', source, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
function fixture() {
  return {
    module: { ...base, id: 'module', kind: 'module', name: '项目本体', description: '模块说明', scope: { kind: 'project', id: 'project-1' } },
    type: { ...base, id: 'type', kind: 'definition', moduleId: 'module', name: '人员', description: '身份类型', definitionKind: 'type' },
    relation: { ...base, id: 'relation', kind: 'definition', moduleId: 'module', name: '协作', description: '协作关系', definitionKind: 'relation', subjectTypes: ['type'], objectTypes: ['type'], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' },
    a: { ...base, id: 'a', kind: 'entity', moduleId: 'module', name: '甲', typeId: 'type', description: '对象说明', aliases: ['甲方'], identityStatus: 'confirmed' },
    b: { ...base, id: 'b', kind: 'entity', moduleId: 'module', name: '乙', typeId: 'type', description: '', aliases: [], identityStatus: 'confirmed' },
    fact: { ...base, id: 'fact', kind: 'assertion', moduleId: 'module', subjectId: 'a', definitionId: 'relation', object: { kind: 'entity', id: 'b' }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } },
    rule: { ...base, id: 'rule', kind: 'rule', moduleId: 'module', name: '审批规则', requirement: '需要审批', condition: null, effect: { kind: 'note' }, strength: 'required', exception: '紧急情况' },
  } as Record<string, any>;
}

describe('ontology document projection', () => {
  it('renders TBox, RBox and ABox, escapes prose and groups identical provenance once', () => {
    const records = fixture();
    records.relation.description = '<script>alert(1)</script>';
    const html = render(records);
    expect(html).toContain('id="ontology-doc-tbox"');
    expect(html).toContain('id="ontology-doc-rbox"');
    expect(html).toContain('id="ontology-doc-abox"');
    expect(html).toContain('人员');
    expect(html).toContain('审批规则');
    expect(html).toContain('甲');
    expect(html).toContain('乙');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html.match(/<li id="ontology-doc-source-/g)).toHaveLength(1);
    expect(html.match(/href="#ontology-doc-source-1"/g)).toHaveLength(1);
    expect(html).toContain('class="ont-source-row"');
    expect(html).toMatch(/<summary class="ont-source-summary">[\s\S]*?ont-source-chevron/);
    expect(html).toContain('关联记录与时间');
    expect(html).not.toContain('<summary>关联记录与时间</summary>');
  });

  it('shows numeric, boolean and corrected facts while protecting historical and legacy fields', () => {
    const records = fixture();
    records.number = { ...records.fact, id: 'number', object: { kind: 'literal', valueType: 'number', value: 21 }, status: 'corrected' };
    records.boolean = { ...records.fact, id: 'boolean', object: { kind: 'literal', valueType: 'boolean', value: false } };
    records.legacy = { ...records.a, id: 'legacy', name: '旧对象', source: { kind: 'legacy', label: '旧资料' } };
    const html = render(records);
    expect(html).toContain('data-record-id="number"');
    expect(html).toContain('>21</span>');
    expect(html).toContain('ont-scan-value-entry');
    expect(html).toContain('>否</span>');
    expect(html).not.toContain('data-edit-type="boolean"');
    expect(html).toContain('已纠正');
    expect(html).toContain('旧内容只读');
    expect(html).not.toMatch(/data-ontology-edit="object.value" data-record-id="number"/);
    expect(html).not.toMatch(/data-ontology-edit="name" data-record-id="legacy"/);
    expect(html).not.toMatch(/data-ontology-action="change-fact" data-record-id="number"/);
  });

  it('keeps an unsaved draft visible for the same record without changing other fields', () => {
    const html = render(fixture(), { a: { changes: { name: '新名字' } }, relation: { changes: { description: '新说明' } } });
    expect(html).toContain('>新名字</span>');
    expect(html).toContain('>新说明</span>');
    expect(html).toContain('>乙</span>');
  });

  it('keeps a record detail slot for every record type without tables', () => {
    const html = render(fixture());
    expect(html).toMatch(/data-ontology-panel="type" hidden/);
    expect(html).toMatch(/data-ontology-panel="relation" hidden/);
    expect(html).toMatch(/data-ontology-panel="rule" hidden/);
    expect(html).toMatch(/class="ont-object-record-extra"[^>]*data-ontology-panel="a" hidden/);
    expect(html).not.toContain('<table');
    expect(html).not.toContain('colspan');
  });

  it('shared disclosure and edit controls preserve action routing, accessible names and their panel IDs', () => {
    const html = render(fixture());
    const disclosure = html.match(/<button[^>]*data-ontology-action="document-disclosure"[^>]*aria-controls="ontology-record-panel-rule"[^>]*>/)?.[0] || '';
    expect(disclosure).toContain('aria-expanded="false"');
    expect(disclosure).toContain('aria-label=');
    expect(html).toContain('id="ontology-record-panel-a"');
    const edit = html.match(/<button[^>]*data-ontology-action="selection-edit"[^>]*data-record-id="relation"[^>]*data-field="description"[^>]*>/)?.[0] || '';
    expect(edit).toContain('aria-label=');
    expect(html).toContain('is-sparkles');
    const objectEntry = html.match(/<button[^>]*data-ontology-action="document-disclosure"[^>]*data-record-id="a"[^>]*>/)?.[0] || '';
    expect(objectEntry).toContain('aria-controls="ontology-record-panel-a"');
    expect(html).not.toContain('object-description');
    expect(html).toContain('id="ontology-record-panel-a"');
  });

  it('renders curated summary points with same-module evidence and T/R/A tags', () => {
    const records = fixture();
    records.module.scopeNote = '这是项目范围的本体。';
    records.module.summaryPoints = [{ text: '甲与乙通过协作相连。', evidenceIds: ['fact', 'relation'] }];
    const html = render(records);
    expect(html).toContain('id="ontology-doc-conclusions"');
    expect(html).toContain('甲与乙通过协作相连。');
    expect(html).toContain('这是项目范围的本体。');
    expect(html).toContain('data-document-details="conclusion:0"');
    expect(html).toContain('class="ont-conclusion-summary"');
    expect(html).toContain('data-evidence-record-id="fact"');
    expect(html).toContain('data-evidence-record-id="relation"');
    expect(html).toContain('1 条事实');
    expect(html).toContain('1 个定义');
    expect(html).toMatch(/ont-evidence-tag">T</);
    expect(html).toMatch(/ont-evidence-tag">A</);
    expect(html).not.toContain('ont-document-contents');
    expect(html).not.toContain('data-document-save');
  });

  it('keeps the conclusion section honest when evidence is missing or no summary exists', () => {
    const records = fixture();
    records.module.summaryPoints = [
      { text: '一条没有依据的结论。', evidenceIds: ['missing'] },
      { text: '一条部分可用的结论。', evidenceIds: ['fact', 'missing'] },
    ];
    const html = render(records);
    expect(html).toContain('一条没有依据的结论。');
    expect(html).toContain('没有可核对的依据');
    expect(html.match(/1 条依据当前不可用/g)).toHaveLength(2);
    expect(html).toContain('有依据当前不可用；结论文字可能已过时，请核对。');
    const empty = render(fixture());
    expect(empty).toContain('还没有整理结论。');
    expect(empty).toContain('id="ontology-doc-tbox"');
    expect(empty).toContain('id="ontology-doc-rbox"');
    expect(empty).toContain('id="ontology-doc-abox"');
  });

  it('renders the structure rows as expandable titles with questions, examples and collapsed records', () => {
    const html = render(fixture());
    expect(html).toContain('<h2>结构</h2>');
    expect(html).not.toContain('三个盒子');
    expect(html).toContain('它回答');
    expect(html).toContain('例如');
    expect(html).toContain('data-document-box-details="T"');
    expect(html).toContain('data-document-box-details="R"');
    expect(html).toContain('data-document-box-details="A"');
    expect(html).toMatch(/class="ont-box-details ont-box-merged"[^>]*data-document-box-details="T"/);
    expect(html).toContain('class="ont-box-title"');
    expect(html).toContain('class="ont-box-flag"');
    expect(html).toContain('未接入写入前检查');
    expect(html).toContain('这 1 条规则未接入写入前检查，只作为任务上下文约束或说明保存。');
    expect(html).not.toContain('展开 1 个概念和 1 个关系/属性');
    expect(html).not.toContain('展开 1 条规则原文');
    expect(html).not.toContain('展开 2 个对象和 1 条事实');
    expect(html).toContain('「人员」是一个概念类型。');
    expect(html).toContain('「协作」是它们之间的一种关系。');
    expect(html).toContain('「审批规则」要求：需要审批');
    expect(html).toContain('「甲 · 协作 · 乙」是一条事实。');
    expect(html).toContain('添加概念');
    expect(html).toContain('添加对象');
  });

  it('renders records as entries and writes repeated source and start dates once', () => {
    const records = fixture();
    records.fact2 = { ...records.fact, id: 'fact2', object: { kind: 'entity', id: 'a' } };
    const html = render(records);
    expect(html).not.toContain('<table');
    expect(html).toContain('class="ont-scan-rec"');
    expect(html).toContain('来源 S1');
    expect(html).toContain('均自 2026-01-01 起');
    expect(html.match(/ont-scan-fact-pred/g)).toHaveLength(1);
    expect(html.match(/ont-scan-value-entry/g)).toHaveLength(2);
    expect(html).toContain('均为必须遵守');
    expect(html).toContain('适用所有任务');
    expect(html).toContain('未接入写入前检查');
  });

  it('describes required-section rules as write-time checks instead of notes only', () => {
    const records = fixture();
    records.rule.effect = { kind: 'required_section', name: '审批记录' };
    const html = render(records);
    expect(html).toContain('操作前检查');
    expect(html).toContain('规则已接入写入前检查');
    expect(html).toContain('这 1 条规则已接入写入前检查');
    expect(html).not.toContain('部分规则已接入写入前检查');
  });

  it('describes a mixed rule list with unconnected rules as task-context constraints or notes', () => {
    const records = fixture();
    records.rule.effect = { kind: 'required_section', name: '审批记录' };
    records.noteRule = { ...records.rule, id: 'noteRule', name: '说明规则', requirement: '说明',
      effect: { kind: 'note' } };
    const html = render(records);
    expect(html).toContain('部分规则已接入写入前检查');
    expect(html).toContain('其余 1 条未接入写入前检查，只作为任务上下文约束或说明保存');
  });

  it('opens the right box for openDetails and restores an expanded conclusion', () => {
    const openT = render(fixture(), {}, { openDetails: { 'box:T': true } });
    expect(openT).toMatch(/data-document-box-details="T"[^>]*open/);
    const openR = render(fixture(), {}, { expandedId: 'rule' });
    expect(openR).toMatch(/data-document-box-details="R"[^>]*open/);
    const openA = render(fixture(), {}, { expandedId: 'fact' });
    expect(openA).toMatch(/data-document-box-details="A"[^>]*open/);
    const records = fixture();
    records.module.summaryPoints = [
      { text: '第一条结论。', evidenceIds: ['fact'] },
      { text: '第二条结论。', evidenceIds: ['relation'] },
    ];
    const openConclusion = render(records, {}, { openDetails: { 'conclusion:1': true } });
    expect(openConclusion).toMatch(/data-document-details="conclusion:1"[^>]*open/);
    expect(openConclusion).not.toMatch(/data-document-details="conclusion:0"[^>]*open/);
  });
});
