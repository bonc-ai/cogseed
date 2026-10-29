import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const before = { id: 'definition-synthetic', kind: 'definition', name: '检查周期', version: 1, description: '',
  definitionKind: 'attribute', subjectTypes: ['type-synthetic'], objectTypes: [], valueType: 'text', cardinality: 'one',
  cardinalityAnchor: 'subject', status: 'active', access: 'task', source: { label: '合成检查规范' } };
const after = { ...before, version: 2, description: '记录设备检查的周期，按维护计划填写。' };
const plan = { schemaVersion: 1, reason: '为 definition-synthetic 补充说明。', evidence: ['stored-version'], refs: [], blockedReasons: [],
  previewChanges: [{ before, after, intent: 'update', box: 'T' }], actions: [] };
const candidate = { id: 'ontology-review-synthetic', origin: 'stock_organization', proposalTarget: 'ontology', status: 'pending_review',
  summary: before.name, judgment: '补充检查周期的说明，不改变取值和权限。', suggestedType: 'cognition', suggestedAction: 'create', suggestedScope: 'general',
  stockOrganizationProvenance: { jobId: 'synthetic-job', checkedAt: '2026-01-01T00:00:00Z' }, ontologyFormation: plan,
  sourceRefs: [], evidenceRefs: [], capabilities: { countsAsPending: true, canPromote: true, canEdit: true, canReject: true } };
function setup(patch = {}) {
  return loadCognitionAssets({ candidates: [{ ...candidate, ...patch }], ontologySnapshot: { records: { [before.id]: before, 'type-synthetic': { name: '设备' } } } }, { name: 'activity', candidateId: candidate.id });
}
const action = (act: string) => ({ dataset: { act, id: candidate.id }, getAttribute: () => null });

describe('独立本体建议的阅读与编辑', () => {
  it('以拟保存内容开头，不用说明文字或认知空表单代替结果', () => {
    const html = setup().render();
    const body = html.slice(html.indexOf('class="ca-activity-detail-body ca-detail-body"'));
    expect(body.indexOf(after.description)).toBeLessThan(body.indexOf('依据与来源'));
    expect(body).toContain('修改前'); expect(body).toContain('未记录');
    expect(html).toContain('基于 v1'); expect(body).toContain('设备');
    expect(body).toContain('为 检查周期 补充说明。'); expect(body).toContain('保存的本体版本');
    for (const absent of ['data-f=', '用途', '适用条件', '完整变更说明', 'stored-version', before.id, '普通候选', '建议新增']) expect(body).not.toContain(absent);
    expect(html).toContain('本体记录'); expect(html).toContain('建议更新');
    const footer = body.slice(body.indexOf('<footer'));
    for (const label of ['确认保存', '修改要求', '稍后处理', '拒绝']) expect(footer).toContain(label);
    expect(footer).not.toContain('保存修改并校验'); expect(footer).not.toContain('下一项');
  });
  it('缺预览不能确认，不伪造正文，保留稍后和拒绝', () => {
    const html = setup({ ontologyFormation: { ...plan, previewChanges: [] } }).render();
    expect(html).toContain('未读到拟保存内容');
    expect(html).toMatch(/disabled[^>]*data-act="cand-adopt-with-form"/);
    expect(html).toContain('data-act="activity-defer"'); expect(html).toContain('data-act="cand-decide"');
  });
  it('修改是显式状态，取消遵循草稿保护且不调用保存', async () => {
    const loaded = setup(); loaded.render();
    loaded.ns.api.call = vi.fn();
    await loaded.ns.activityController.handleClick(action('activity-edit'));
    let html = loaded.render(); expect(html).toContain('data-f="judgment"');
    expect(html).toContain('不会作为本体正文保存'); expect(html).not.toContain('data-act="cand-adopt-with-form"');
    const card = { dataset: { candId: candidate.id, candType: 'cognition' } };
    loaded.ns.activityController.handleInput({ target: { dataset: { f: 'judgment' }, value: '保留周期，不补充示例。', closest: () => card } });
    loaded.ns.confirmUser = vi.fn(async () => false);
    await loaded.ns.activityController.handleClick(action('activity-edit-cancel'));
    expect(loaded.render()).toContain('保留周期，不补充示例。');
    loaded.ns.confirmUser = vi.fn(async () => true);
    await loaded.ns.activityController.handleClick(action('activity-edit-cancel'));
    expect(loaded.render()).not.toContain('data-f="judgment"'); expect(loaded.ns.api.call).not.toHaveBeenCalled();
  });
  it('重命名显示新旧标题，编辑期间收到终态更新时移除编辑出口', async () => {
    const loaded = setup({ ontologyFormation: { ...plan, previewChanges: [{ before, after: { ...after, name: '维护检查周期' }, intent: 'update' }] } });
    expect(loaded.render()).toContain('维护检查周期');
    await loaded.ns.activityController.handleClick(action('activity-edit'));
    loaded.store.candidates[0].status = 'integrated'; loaded.store.route.activityView = 'done';
    const html = loaded.render(); expect(html).not.toContain('data-f=');
    expect(html).not.toContain('data-act="activity-save-draft"'); expect(html).toContain('维护检查周期');
  });
  it('拒绝记录显示原提议内容，不把终态当作保存成功', () => {
    const loaded = setup({ status: 'rejected', capabilities: { isTerminal: true } }); loaded.store.route.activityView = 'done';
    const html = loaded.render(); expect(html).toContain('拟保存内容'); expect(html).toContain(after.description);
    expect(html).not.toContain('本次保存内容'); expect(html).not.toContain('确认后保存所列本体变化');
  });
  it('改要求后的旧方案保持阻断，重核入口说明费用，终态只读', () => {
    const blocked = setup({ ontologyFormation: { ...plan, blockedReasons: ['candidate_edited_requires_ontology_review'] } }).render();
    expect(blocked).toContain('修改要求尚未应用'); expect(blocked).toContain('会调用模型');
    expect(blocked).toContain('按要求生成建议'); expect(blocked).toMatch(/disabled[^>]*data-act="cand-adopt-with-form"/);
    const failed = setup({ ontologyFormation: { ...plan, blockedReasons: ['stock_recheck_failed'] } }).render();
    expect(failed).toContain('重新核对未完成'); expect(failed).not.toContain('stock_recheck_failed');
    expect(failed).toMatch(/disabled[^>]*data-act="cand-adopt-with-form"/);
    const done = setup({ status: 'integrated', capabilities: { isTerminal: true } }); done.store.route.activityView = 'done';
    const html = done.render(); expect(html).toContain(after.description); expect(html).toContain('本次保存内容');
    expect(html).not.toContain('data-act="activity-edit"'); expect(html).not.toContain('data-act="formation-recheck"');
  });
});


it('本体的正文、变化、来源展开，结构与关联折叠，阻断不藏入折叠区', () => {
  const html = setup({ ontologyFormation: { ...plan, refs: [{ recordId: before.id, moduleId: 'synthetic-module' }] } }).render();
  const body = html.slice(html.indexOf('class="ca-activity-detail-body ca-detail-body"'));
  const order = ['拟保存内容', '本次变化', '依据与来源', '结构、范围与使用权限', '关联已有与本次形成的对象'].map(text => body.indexOf(text));
  expect(order.every(n=>n>=0)).toBe(true); expect(order).toEqual([...order].sort((a,b)=>a-b));
  expect(body).toContain('<summary>结构、范围与使用权限</summary>');
  expect(body.indexOf('版本与使用记录')).toBeLessThan(body.indexOf('确认后保存所列本体变化'));
  expect(body.indexOf('确认后保存所列本体变化')).toBeLessThan(body.indexOf('<footer'));
  expect(body).not.toContain('ca-detail-after'); expect(body).not.toContain('ca-detail-before');
  const blocked = setup({ ontologyFormation: { ...plan, blockedReasons: ['baseline_changed'] } }).render();
  expect(blocked.indexOf('role="alert"')).toBeLessThan(blocked.indexOf('<summary>结构、范围与使用权限'));
});


it.each([
  { kind: 'rule', name: '检查要求', requirement: '必须记录 3 项读数；不得省略失败。目标 {{目标}}。', condition: { kind: 'task', field: 'taskKind', equals: 'inspection' }, exception: '离线草稿例外。', strength: 'required', effect: { kind: 'note' } },
  { kind: 'assertion', subjectId: 'type-synthetic', definitionId: before.id, object: { kind: 'literal', value: 0 }, validity: { from: '2026-01-01', until: '2026-02-01', timezone: 'UTC' } },
])('规则或事实保持字段结构，不引入认知空用途 ($kind)', record => {
  const afterRecord = { ...record, id: 'structured-synthetic', version: 1, status: 'active', access: 'task' };
  const html = setup({ ontologyFormation: { ...plan, previewChanges: [{ after: afterRecord, intent: 'create' }] } }).render();
  const body = html.slice(html.indexOf('class="ca-activity-detail-body ca-detail-body"'));
  expect(body).not.toContain('data-f='); expect(body).not.toContain('<h3>用途</h3>');
  if (record.kind === 'rule') { expect(body).toContain(record.requirement); expect(body).toContain(record.exception); }
  else { expect(body).toContain('>0</dd>'); expect(body).toContain('2026-01-01 · 2026-02-01 · UTC'); }
});


it('修改前只列受影响的字段，不因来源标签变化展开整份旧结构', () => {
  const html = setup({ ontologyFormation: { ...plan, previewChanges: [{ before, after: { ...after, source: { label: '合成新依据' } }, intent: 'update' }] } }).render();
  const changes = html.slice(html.indexOf('<section class="ca-review-changes">'), html.indexOf('<details class="details ca-review-evidence"'));
  expect(changes).toContain('含义与说明'); expect(changes).toContain('未记录'); expect(changes).not.toContain('合成检查规范');
  expect(changes).not.toContain('合成新依据'); expect(changes).toContain('<details><summary>修改前内容');
  expect(changes).not.toContain('允许的主体类型'); expect(changes).not.toContain('状态与使用权限');
});

it('涉及确定程度或数值的旧正文保持展开，来源 ID 不作为名称', () => {
  const old = { ...before, description: '预计完成 3 项测试后可用，日期待确认。',
    source: { label: '会话 synthetic-chat/msg_abcdef012345 · 已确认 · 原始转写' } };
  const html = setup({ ontologyFormation: { ...plan, previewChanges: [{ before: old, after, intent: 'update' }] } }).render();
  const body = html.slice(html.indexOf('class="ca-activity-detail-body ca-detail-body"'));
  expect(body).toContain('<details open><summary>修改前内容');
  expect(body).toContain(old.description); expect(body).not.toContain('msg_abcdef012345');
  expect(body).not.toContain('原始转写');
});
it('否定变化不能藏在折叠的旧正文中', () => {
  const html = setup({ ontologyFormation: { ...plan, previewChanges: [{
    before: { ...before, description: '测试未通过。' },
    after: { ...after, description: '测试通过。' }, intent: 'update',
  }] } }).render();
  expect(html).toContain('<details open><summary>修改前内容');
});

it('来源集中展示一次，长原文、行号和附件入口来自证据读取；失效后不展示旧摘录', () => {
  const ref = { kind: 'artifact_file', id: 'att-abcdef0123456789', title: 'transcript.txt',
    locator: { conversationId: 'synthetic-chat', messageId: 'synthetic-message', attachmentName: 'transcript.txt' } };
  const loaded = setup({ sourceRefs: [ref, ref], evidenceRefs: [ref, ref] });
  const excerpt = '合成转写。'.repeat(80) + '预计可用，尚待测试。';
  loaded.store.reviewEvidence = { ['candidate:' + candidate.id]: { items: [{ ref, state: 'available', title: ref.title,
    excerpt, location: { startLine: 2, endLine: 8 }, openTarget: ref.locator }] } };
  const html = loaded.render();
  expect(html.split('class="ca-review-source"')).toHaveLength(2);
  expect(html).toContain(excerpt); expect(html).toContain('原文第 2–8 行');
  expect(html).toContain('data-act="open-review-source"');
  const visible = html.replace(/<[^>]*>/g, ' ');
  expect(visible).not.toContain(ref.id);
  loaded.store.reviewEvidence['candidate:' + candidate.id].items[0].state = 'changed';
  const changed = loaded.render();
  expect(changed).not.toContain(excerpt); expect(changed).not.toContain('data-act="open-review-source"');
  expect(changed).toContain('来源内容发生变化');
  loaded.store.reviewEvidence['candidate:' + candidate.id] = { loaded: true, loading: false, items: [], error: '合成读取失败' };
  expect(loaded.render()).toContain('合成读取失败');
  expect(loaded.render()).not.toContain('加载中…');
});


it.each(['baseline_changed', 'stock_organization_baseline_changed'])('refreshes %s without losing drafts or invoking model recheck', async code => {
  const loaded = setup(); loaded.render();
  await loaded.ns.activityController.handleClick(action('activity-edit'));
  const card = { dataset: { candId: candidate.id, candType: 'cognition' } };
  loaded.ns.activityController.handleInput({ target: { dataset: { f: 'judgment' }, value: '保留合成编辑草稿。', closest: () => card } });
  const events: string[] = [];
  loaded.ns.api.call = vi.fn(async (channel: string) => {
    events.push(channel);
    if (channel === 'recall.candidates.promote') throw Object.assign(new Error('synthetic internal record id'), { code });
    if (channel === 'recall.candidates.read') return { candidate: { ...candidate, updatedAt: '2026-10-21T00:00:00Z' } };
    if (channel === 'recall.reviewEvidence.read') return { items: [] };
    throw new Error('unexpected operation ' + channel);
  });
  const alerts: string[] = [];
  loaded.window.uiAlert = vi.fn(async (text: string) => { alerts.push(text); });
  const focus = vi.spyOn(loaded.ns.activityController, 'focusFormationRecovery');
  await loaded.ns.actions.adoptCandidate(candidate.id);
  expect(events).toEqual(['recall.candidates.promote', 'recall.candidates.read', 'recall.reviewEvidence.read']);
  expect(alerts.join(' ')).toContain('本次没有保存'); expect(alerts.join(' ')).toContain('原建议保留');
  expect(alerts.join(' ')).not.toContain('稍后重试'); expect(alerts.join(' ')).not.toContain('synthetic internal');
  expect(focus).toHaveBeenCalledWith(candidate.id, expect.any(Object));
  expect(loaded.render()).toContain('保留合成编辑草稿。');
  expect(loaded.store.candidates[0].updatedAt).toBe('2026-10-21T00:00:00Z');
  expect(loaded.store.formationRechecks[candidate.id]).toMatchObject({ running: false, completed: false });
});

it('opens the containing disclosure and focuses recovery only for the selected suggestion', () => {
  const loaded = setup(); loaded.render();
  const fold = { tagName: 'DETAILS', open: false, parentElement: null };
  const button = { dataset: { id: candidate.id }, parentElement: fold, scrollIntoView: vi.fn(), focus: vi.fn() };
  loaded.context.document.querySelector = () => button;
  loaded.ns.activityController.focusFormationRecovery(candidate.id, loaded.ns.activityController.beginDecision());
  expect(fold.open).toBe(true); expect(button.focus).toHaveBeenCalledOnce();
  loaded.store.route.name = 'overview';
  loaded.ns.activityController.focusFormationRecovery(candidate.id);
  expect(button.focus).toHaveBeenCalledOnce();
});


it.each(['zh', 'en', 'ja', 'pt'])('maps confirmation conflicts in %s without internal identifiers', async locale => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const table = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/renderer/locales', locale + '.json'), 'utf8'));
  const loaded = loadCognitionAssets({}, {}, { t: (key: string) => table[key] || key });
  for (const [code, key] of [['baseline_changed', 'cognition.ontology_baseline_changed'], ['stock_organization_baseline_changed', 'cognition.stock_baseline_changed']]) {
    expect(table[key]).toBeTruthy();
    expect(loaded.ns.recallErrorText(Object.assign(new Error('internal synthetic-id'), { code }))).toBe(table[key]);
    expect(loaded.ns.recallErrorText({ code, error: 'internal synthetic-id' })).toBe(table[key]);
  }
});
