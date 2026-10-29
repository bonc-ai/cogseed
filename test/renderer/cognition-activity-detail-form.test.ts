import { nightlyFormation } from './helpers/nightly-candidate';
import { describe, expect, it } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

function renderCandidate(extra: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
  const candidate = {
    id: 'detail-a', summary: '周报模板', judgment: '周报包含进展、风险和计划，每项行动说明负责人。',
    value: '减少重复整理', suggestedType: 'template', suggestedScope: 'general',
    status: 'pending_review', ...nightlyFormation(), createdAt: '2026-10-11T08:00:00Z',
    capabilities: { countsAsPending: true, canEdit: true, canPromote: true, canReject: true }, ...extra,
  };
  return loadCognitionAssets({ candidates: [candidate], ...state }, { name: 'activity', candidateId: 'detail-a', ...(extra.status === 'confirmed' ? { activityView: 'done' } : {}) }).render();
}

describe('建议详情的内容与适用任务表单', () => {
  it('以中文解释任务范围，编辑选择内容分类而已处理详情只读', () => {
    const html = renderCandidate();
    expect(html).not.toContain('data-f=');
    expect(html).toContain('data-act="activity-edit"');
    expect(html).not.toContain('认知类型');
    expect(html).not.toContain('data-f="type"');
    expect(html).not.toContain('模板与范例');
    expect(renderCandidate({ suggestedType: 'cognition' })).toContain('<h3>内容</h3>');
    expect(renderCandidate({ status: 'confirmed', capabilities: { isTerminal: true } })).not.toContain('认知类型');
    expect(html).toContain('使用边界');
    expect(html).toContain('跨任务通用');
    expect(html).not.toContain('type="text" value="general"');
    expect(html).not.toContain('作用域');
    expect(html).not.toContain('ca-cand-type-');
  });

  it('缺范围不进入关注；完整建议的旧多值范围不静默改成通用', () => {
    const missingScope = renderCandidate({ suggestedScope: '' });
    expect(missingScope).not.toContain('data-act="activity-select"');
    expect(missingScope).toContain('当前筛选下无其他条目');
    expect(missingScope).not.toContain('前往整理');
    const legacy = renderCandidate({ suggestedScope: 'review,code' });
    expect(legacy).toContain('review,code');
    expect(legacy).not.toContain('<option value="general" selected>');
    expect(renderCandidate({ suggestedScope: '<私有范围>' })).toContain('&lt;私有范围&gt;');
  });

  it('正文先于来源，来源先于使用边界，权限与任务类别分开展示', () => {
    const html = renderCandidate({ scopePolicy: { workspaceIds: ['space-a'] } });
    const content = html.indexOf('ca-library-content');
    const usage = html.indexOf('ca-prototype-boundaries');
    const evidence = html.indexOf('ca-review-evidence');
    expect(content).toBeLessThan(evidence);
    expect(evidence).toBeLessThan(usage);
    expect(html).toContain('查看使用权限');
    expect(html).toContain('space-a');
    expect(html).not.toContain('data-f="uncertainty"');
    expect(html).toContain('保存的影响');
    expect(html).toContain('<h2>周报模板</h2>');
    expect(html).not.toContain('<h2 class="cand-title">周报模板</h2>');
  });
});

describe('系统活动沿用认知资产卡的阅读结构与真实状态', () => {
  it('完整名称、操作性质和目标版本在编辑字段前显示，保存影响与记录在证据后显示', () => {
    const name = '这是一条超过列表截断长度的完整项目周报交付认知模板';
    const html = renderCandidate({ summary: name });
    expect(html).toContain(`<h2>${name}</h2>`);
    expect(html).toContain('建议新增');
    expect(html).not.toContain('ca-review-action');
    expect(html).not.toContain('<h3>建议动作</h3>');
    const facts = html.slice(html.indexOf('class="ca-library-facts"'), html.indexOf('ca-activity-detail-body'));
    expect(facts).toContain('建议新增');
    expect(facts).toContain('待确认');
    expect(html).not.toContain('模板与范例');
    // 分类只在顶部 facts，正文不再重复「分类」只读行
    expect(html).not.toMatch(/<div class="field"><span>分类<\/span>/);
    const markers = ['ca-library-content', 'ca-review-evidence', 'ca-prototype-boundaries', 'ca-review-impact', 'ca-review-history'];
    const positions = markers.map(marker => html.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('拟新建正式资产 · 无已有资产版本');
    expect(html).toContain('确认保存');
    expect(html).toContain('修改内容');
    expect(html).not.toContain('保存修改并校验');
    expect(html).not.toContain('<h3>使用方式</h3>');
  });
  it('更新型显示真实在用版本与候选基线；缺失时不编造版本', () => {
    const loaded = loadCognitionAssets({ candidates: [{ ...nightlyFormation(), judgment: '周报按进展风险和计划组织。', suggestedType: 'template', suggestedScope: 'general', status: 'pending_review', id: 'a', summary: '更新周报', suggestedAction: 'update', targetAssetId: 'asset-a', targetVersionUsed: '2', capabilities: { canEdit: true, canPromote: true, canReject: true, countsAsPending: true } }], assets: [{ id: 'asset-a', title: '当前周报', version: '5', activeVersion: '4', statement: '当前正文' }] }, { name: 'activity', candidateId: 'a' });
    const html = loaded.render();
    expect(html).toContain('目标：当前周报 · 当前在用 v4 · 候选基于 v2');
    expect(html).toContain('原版本内容不可用');
    expect(html).toContain('保存更新');
    expect(renderCandidate({ suggestedAction: 'update', targetAssetId: 'missing' })).toContain('未读到目标资产');
    expect(renderCandidate({ suggestedAction: 'update', targetAssetId: 'missing' })).not.toContain('当前在用 v1');
  });
  it('来源摘录与真实来源入口一起显示；不可用来源不显示旧摘录或假入口', () => {
    const html = renderCandidate({ evidenceRefs: [{ kind: 'conversation', id: 'chat-a', title: '项目周报讨论', excerpt: '周报按进展、风险、计划组织。' }, { kind: 'conversation', id: 'chat-b', degraded: true, excerpt: '不应显示的旧摘录' }] });
    expect(html).toContain('项目周报讨论');
    expect(html).toContain('<blockquote class="ca-review-quote">周报按进展、风险、计划组织。</blockquote>');
    expect(html).toContain('data-act="open-review-source" data-id="chat-a"');
    expect(html).not.toContain('data-act="open-review-source" data-id="chat-b"');
    expect(html).not.toContain('不应显示的旧摘录');
    expect(html).toContain('当前无法读取此来源');
  });
  it('已处理详情保持同一阅读结构但不提供编辑，正文和处理记录保留', () => {
    const html = renderCandidate({ status: 'confirmed', capabilities: { isTerminal: true }, judgment: '正式处理前保留的正文' });
    expect(html).toContain('正式处理前保留的正文');
    expect(html).toContain('依据与来源');
    expect(html).not.toContain('data-f="uncertainty"');
    expect(html).toContain('版本与使用记录');
    expect(html).not.toContain('data-f="judgment"');
    expect(html).not.toContain('data-act="activity-save-draft"');
  });
  it('补边界建议将适用与禁用条件直接展示，不折叠关键输入', () => {
    const html = renderCandidate({ suggestedType: 'rule', suggestedAction: 'limit_scope', targetAssetId: 'asset-a', applicableWhen: ['需要评审时'], forbiddenWhen: ['来源未核对时'] }, { assets: [{ id: 'asset-a', title: '周报模板', version: '1', activeVersion: '1', statement: '周报说明' }] });
    expect(html).toContain('<section class="ca-prototype-boundaries">');
    expect(html).toContain('需要评审时');
    expect(html).not.toContain('data-f="applicable"');
    expect(html).toContain('来源未核对时');
    expect(html).toContain('不修改全局设置');
  });
  it('版本冲突的重新确认留在冲突区，正式操作固定在底部', () => {
    const loaded = loadCognitionAssets({ candidates: [{ ...nightlyFormation(), judgment: '周报按进展风险和计划组织。', suggestedType: 'template', suggestedScope: 'general', status: 'pending_review', id: 'a', summary: '更新周报', suggestedAction: 'update', targetAssetId: 'asset-a', targetVersionUsed: '2', capabilities: { canEdit: true, canPromote: true, canReject: true, countsAsPending: true } }], assets: [{ id: 'asset-a', title: '周报', activeVersion: '3', version: '3' }], candidateVersionConflict: { candidateId: 'a', baselineVersion: '2', currentVersion: '3', currentStatement: '当前正文', currentSnapshot: { statement: '当前正文' } } }, { name: 'activity', candidateId: 'a' });
    const html = loaded.render();
    const footer = html.slice(html.indexOf('<footer class="ca-activity-detail-footer ca-detail-footer">'));
    expect(footer).toContain('保存更新');
    expect(footer).toContain('修改内容');
    expect(footer).not.toContain('data-rebase="1"');
    expect(html).not.toContain('data-rebase="1"');
    expect(html).toMatch(/disabled[^>]*data-act="cand-adopt-with-form"/);
  });
});


it('显式编辑保留候选修改并返回阅读，取消不覆盖正文', async () => {
  const { vi } = await import('vitest');
  const candidate = { id: 'edit-reading', summary: '检查记录', judgment: '记录编号。', value: '核对编号。',
    suggestedType: 'cognition', suggestedScope: 'general', status: 'pending_review', ...nightlyFormation(),
    capabilities: { countsAsPending: true, canEdit: true, canPromote: true, canReject: true } };
  const loaded = loadCognitionAssets({ candidates: [candidate] }, { name: 'activity', candidateId: candidate.id });
  const control = { value: '记录编号与日期。' };
  const action = (act: string) => ({ dataset: { act, id: candidate.id }, getAttribute: () => null,
    setAttribute: vi.fn(), removeAttribute: vi.fn(), closest: () => ({ dataset: {}, querySelector: (s: string) => s==='[data-f="judgment"]' ? control : null }) });
  loaded.render(); await loaded.ns.activityController.handleClick(action('activity-edit'));
  expect(loaded.render()).toContain('data-f="contentCategory"');
  expect(loaded.render()).not.toContain('data-act="cand-adopt-with-form"');
  expect(loaded.render()).toContain('保留修改');
  loaded.ns.api.call = vi.fn(async (_channel: string, body: any) => ({ candidate: { ...candidate, judgment: body.judgment } }));
  await loaded.ns.activityController.handleClick(action('activity-save-draft'));
  expect(loaded.ns.api.call).toHaveBeenCalledWith('recall.candidates.update', expect.objectContaining({ judgment: control.value }));
  expect(loaded.render()).toContain(control.value); expect(loaded.render()).not.toContain('data-f=');
  await loaded.ns.activityController.handleClick(action('activity-edit'));
  await loaded.ns.activityController.handleClick(action('activity-edit-cancel'));
  expect(loaded.ns.api.call).toHaveBeenCalledOnce(); expect(loaded.render()).toContain(control.value);
});


it('合并拆分的旧详情入口保留原编辑及确认操作', () => {
  const loaded = loadCognitionAssets({}, { name: 'candidate' });
  const candidate = { id: 'legacy-organization', status: 'pending_review', capabilities: { canEdit: true, canPromote: true, canReject: true },
    contentOrganization: { operationId: 'legacy-group', resultIds: ['result-a'], sources: [{ head: { id: 'source-a', scope: 'general' }, content: { title: '检查要求', statement: '记录编号。', version: '1' } }],
      ontologyAfter: { records: {} }, ontologyBaseline: {}, ontologyChanges: [], draft: { operation: 'merge', reason: '合成旧入口方案', outputs: [{ title: '检查要求', statement: '记录编号。', sourceAssetIds: ['source-a'], excerpts: [], ontologyRecordIds: [] }] } } };
  const html = loaded.ns.candidate.formCard(candidate);
  expect(html).toContain('data-org-field="statement"'); expect(html).toContain('data-act="cand-adopt-with-form"');
  expect(html).toContain('data-act="activity-save-draft"'); expect(html).not.toContain('data-act="activity-edit-cancel"');
});
