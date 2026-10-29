import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';
import { nightlyFormation } from './helpers/nightly-candidate';

const asset = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'cognition', status: 'active', title: id, statement: '先核对来源，再采用内容。', scope: 'general', version: '3', activeVersion: '2', ...extra });
const categoryOption = (html: string, value: string) => html.includes(`<option value="${value}" selected>`);

describe('内容分类接入我的认知与系统活动', () => {
  it('只兼容明确旧类型，显式待分类优先，正文关键词不参与分类，也不修改记录', async () => {
    const assets = [
      asset('rule', { type: 'rule' }), asset('fact', { type: 'fact' }), asset('template', { type: 'template' }),
      asset('method', { type: 'skill_method' }), asset('personal', { type: 'personal' }),
      asset('preference', { type: 'rule', title: '偏好：简洁回答' }), asset('habit', { type: 'rule', title: '习惯：先核对来源' }),
      asset('preference-suffix', { type: 'rule', title: '机制解释表达偏好' }),
      asset('new', { title: '偏好：周报模板', statement: '规则、模板、方法、经验教训' }),
      asset('explicit', { type: 'rule', title: '明确待分类的偏好', contentCategory: 'unclassified' }),
      asset('semantic', { title: '偏好：周报模板', contentCategory: 'lesson' }),
      asset('semantic-method', { type: 'rule', title: '偏好：周报模板', contentCategory: 'method' }),
      asset('old-abstract-rule', { type: 'rule', contentCategory: 'understanding' }),
      asset('old-abstract-unknown', { contentCategory: 'understanding' }),
      asset('old-method', { type: 'skill_method', contentCategory: 'experience_method' }),
      asset('old-method-unknown', { contentCategory: 'experience_method' }),
      asset('old-fact', { type: 'fact', contentCategory: 'fact' }),
    ];
    const original = JSON.stringify(assets);
    const loaded = loadCognitionAssets({ assets }, { name: 'overview' });
    expect(loaded.ns.library.filtered()).toHaveLength(17);
    for (const [value, ids] of [['rule', ['old-abstract-rule', 'rule']], ['preference', ['habit', 'preference', 'preference-suffix']], ['template', ['template']], ['method', ['method', 'old-method', 'semantic-method']], ['lesson', ['semantic']], ['unclassified', ['explicit', 'fact', 'new', 'old-abstract-unknown', 'old-fact', 'old-method-unknown', 'personal']]] as const) {
      await loaded.ns.library.handleInput({ target: { dataset: { libraryFilter: 'contentCategory' }, value } });
      expect(loaded.ns.library.filtered().map((item: any) => item.id)).toEqual(ids);
      expect(loaded.render()).toContain('<th>分类</th>');
    }
    expect(JSON.stringify(assets)).toBe(original);
    await loaded.ns.library.handleClick({ dataset: { act: 'library-clear' } });
    expect(loaded.ns.library.state.contentCategory).toBe('');
    expect(loaded.ns.library.filtered()).toHaveLength(17);
  });

  it('分类详情、模型形成候选和草稿选项一致，终态只读且分类不改变能力', async () => {
    const candidate = { ...nightlyFormation(), id: 'model-a', suggestedType: 'cognition', contentCategory: 'template', summary: '周报模板', judgment: '先核对来源，再采用内容。', suggestedScope: 'general', status: 'pending_review', capabilities: { countsAsPending: true, canEdit: true, canPromote: false, canReject: true } };
    const loaded = loadCognitionAssets({ assets: [asset('a', { contentCategory: 'rule' })], candidates: [candidate] }, { name: 'activity', candidateId: 'model-a' });
    const readMode = loaded.render();
    expect(readMode).toContain('模板');
    expect(readMode).not.toContain('data-f="contentCategory"');
    await loaded.ns.activityController.handleClick({ dataset: { act: 'activity-edit', id: candidate.id }, getAttribute: () => null });
    const pending = loaded.render();
    expect(categoryOption(pending, 'template')).toBe(true);
    expect(pending).toContain('data-f="contentCategory"');
    for (const value of ['rule', 'preference', 'template', 'method', 'lesson', 'unclassified']) expect(pending).toContain(`<option value="${value}"`);
    for (const value of ['understanding', 'experience_method', 'fact']) expect(pending).not.toContain(`<option value="${value}"`);
    expect(readMode.match(/<button[^>]*data-act="cand-adopt-with-form"[^>]*>/)?.[0]).toContain('disabled');
    expect(pending).toContain('data-act="activity-save-draft"');
    const detail = loaded.ns.renderLibraryAssetDetail(loaded.store.assets[0], {});
    expect(detail).toContain('规则');
    expect(detail).not.toContain('理解与判断');
    const draft = loaded.ns.renderLibraryAssetDetail(loaded.store.assets[0], { assetEdit: '1' });
    expect(categoryOption(draft, 'rule')).toBe(true);
    Object.assign(loaded.store.assetEditDrafts.a, { contentCategory: 'unclassified' });
    expect(categoryOption(loaded.ns.renderLibraryAssetDetail(loaded.store.assets[0], { assetEdit: '1' }), 'unclassified')).toBe(true);
    Object.assign(candidate, { status: 'confirmed', capabilities: { isTerminal: true }, promotedAssetId: 'asset-a' });
    // 终态分类只在详情顶部 facts，compact formCard 正文不再重复分类行
    const terminalPage = loadCognitionAssets({ assets: [asset('a', { contentCategory: 'rule' })], candidates: [candidate] }, { name: 'activity', activityView: 'done', candidateId: 'model-a' }).render();
    expect(terminalPage).toContain('class="ca-library-facts"');
    expect(terminalPage.slice(terminalPage.indexOf('class="ca-library-facts"'), terminalPage.indexOf('ca-activity-detail-body'))).toContain('模板');
    const terminal = loaded.ns.candidate.formCard(candidate, { compact: true });
    expect(terminal).not.toContain('data-f="contentCategory"');
    expect(terminal).not.toMatch(/<div class="field"><span>分类<\/span>/);
  });

  it('仅分类变化也保存新版本，传现有版本锁；冲突保留分类草稿', async () => {
    const item = asset('a', { contentCategory: 'rule' });
    const loaded = loadCognitionAssets({ assets: [item], assetEditDrafts: { a: { baseVersion: '3', baseActiveVersion: '2' } } }, { name: 'overview', assetId: 'a', assetEdit: '1' });
    const controls: Record<string, string> = { title: item.title, statement: item.statement, contentCategory: 'method' };
    const card = { querySelector: (selector: string) => { const key = selector.match(/data-f="([^"]+)"/)?.[1]; return key && Object.prototype.hasOwnProperty.call(controls, key) ? { value: controls[key] } : null; } };
    loaded.context.document.querySelector = () => card;
    loaded.ns.notify = vi.fn();
    const call = vi.spyOn(loaded.ns.api, 'call').mockRejectedValue(new Error('version conflict'));
    await loaded.ns.actions.editAsset('a');
    expect(call).toHaveBeenCalledWith('recall.assets.update', expect.objectContaining({ contentCategory: 'method', expectedVersion: '3', expectedActiveVersion: '2', title: item.title, statement: item.statement }));
    expect(loaded.store.assetEditDrafts.a).toMatchObject({ contentCategory: 'method', saveConflict: true, baseVersion: '3', baseActiveVersion: '2' });
    expect(item.contentCategory).toBe('rule');
  });

  it('候选分类先保存再确认，更新失败时不能继续正式保存', async () => {
    const candidate = { ...nightlyFormation(), id: 'candidate-a', suggestedType: 'cognition', summary: '核对方法', judgment: '先核对来源，再采用内容。', suggestedScope: 'general', status: 'pending_review', risk: 'low', capabilities: { canEdit: true, canPromote: true } };
    const loaded = loadCognitionAssets({ candidates: [candidate] });
    const call = vi.spyOn(loaded.ns.api, 'call').mockRejectedValue(new Error('save failed'));
    await expect(loaded.ns.actions.adoptCandidate('candidate-a', { contentCategory: 'method', judgment: candidate.judgment, summary: candidate.summary, suggestedScope: 'general', suggestedType: 'cognition' })).rejects.toThrow('save failed');
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('recall.candidates.update', expect.objectContaining({ candidateId: 'candidate-a', contentCategory: 'method', suggestedType: 'cognition' }));
  });

  it('系统活动分类编辑进入草稿并通过既有保存修改入口传给后端', async () => {
    const candidate = { ...nightlyFormation(), id: 'candidate-a', suggestedType: 'cognition', summary: '核对方法', judgment: '先核对来源，再采用内容。', suggestedScope: 'general', status: 'pending_review', capabilities: { countsAsPending: true, canEdit: true, canPromote: true } };
    const loaded = loadCognitionAssets({ candidates: [candidate] }, { name: 'activity', candidateId: 'candidate-a' });
    await loaded.ns.activityController.handleClick({ dataset: { act: 'activity-edit', id: candidate.id }, getAttribute: () => null });
    const card = { dataset: { candId: candidate.id, candType: 'cognition' }, querySelector: (selector: string) => selector === '[data-f="contentCategory"]' ? { value: 'method' } : null };
    loaded.ns.activityController.handleInput({ target: { dataset: { f: 'contentCategory' }, value: 'method', closest: () => card } });
    expect(categoryOption(loaded.render(), 'method')).toBe(true);
    const call = vi.spyOn(loaded.ns.api, 'call').mockResolvedValue({ candidate: { ...candidate, contentCategory: 'method' } });
    loaded.ns.notify = vi.fn();
    await loaded.ns.activityController.handleClick({ dataset: { act: 'activity-save-draft', id: candidate.id }, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, closest: () => card });
    expect(call).toHaveBeenCalledWith('recall.candidates.update', expect.objectContaining({ candidateId: candidate.id, contentCategory: 'method', suggestedType: 'cognition' }));
  });
});
