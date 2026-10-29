import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const asset = { id: 'detail-reviewed-preference', type: 'cognition', contentCategory: 'preference', title: '回答偏好',
  statement: '先给结论，再说明原因。', applicableWhen: ['复杂问题'], forbiddenWhen: ['日常问候'], scope: 'general',
  scopePolicy: { projectIds: ['project-a'], purposeTags: ['review'], workspaceIds: ['workspace-a'] },
  status: 'active', version: '3', activeVersion: '2' };
function setup(currentAsset = asset) {
  const call = vi.fn(async (channel: string) => channel === 'recall.assets.update'
    ? { ok: true, asset: { id: asset.id, version: '4' } } : channel === 'recall.assets.list' ? [asset] : { ok: true });
  const loaded = loadCognitionAssets({ assets: [currentAsset], assetScopeOptions: { status: 'ready', agents: [], spaces: [] } },
    { name: 'overview', assetId: asset.id, assetEdit: '1' }, { cogseed: { invoke: call } });
  const initialHtml = loaded.ns.renderLibraryAssetDetail(currentAsset, { assetEdit: '1' });
  const fields: Record<string, string> = { title: currentAsset.title, statement: currentAsset.statement, contentCategory: currentAsset.contentCategory,
    applicable: currentAsset.applicableWhen.join('、'), forbidden: currentAsset.forbiddenWhen.join('、') };
  const missing = new Set<string>();
  loaded.context.document.querySelector = (selector: string) => selector === '.ca-asset-edit' ? {
    querySelector(selector: string) {
      const field = selector.match(/\[data-f="([^"]+)"\]/)?.[1];
      return field && Object.hasOwn(fields, field) && !missing.has(field) ? { value: fields[field] } : null;
    },
  } : null;
  return { ...loaded, call, fields, missing, initialHtml,
    update: () => call.mock.calls.find(([channel]) => channel === 'recall.assets.update') as unknown as [string, Record<string, unknown>] | undefined };
}

describe('详情保存的真实正文审阅意图', () => {
  it('完整条件在正文旁可见，提示保存含义，不增加确认弹窗', () => {
    const loaded = setup();
    const advancedAt = loaded.initialHtml.indexOf('ca-asset-edit-advanced');
    for (const field of ['statement', 'applicable', 'forbidden']) expect(loaded.initialHtml.indexOf(`data-f="${field}"`)).toBeLessThan(advancedAt);
    expect(loaded.initialHtml).toContain('修改正文或条件后保存');
    expect(loaded.initialHtml).toContain('只改标题或分类不代表再次审阅正文');
    expect(loaded.initialHtml).toContain('data-act="asset-edit-save"');
  });

  it.each([
    ['statement', '先列关键假设，再说明结论。'], ['applicable', '复杂问题、方案解释'], ['forbidden', ''],
  ])('用户实际修改 %s 才明确审阅完整三字段，保留双CAS', async (field, value) => {
    const loaded = setup(); loaded.fields[field] = value;
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.update()?.[1]).toMatchObject({ assetId: asset.id, reviewedDetails: true, expectedVersion: '3', expectedActiveVersion: '2',
      statement: loaded.fields.statement, applicableWhen: loaded.fields.applicable.split('、'), forbiddenWhen: loaded.fields.forbidden ? loaded.fields.forbidden.split('、') : [] });
    expect(loaded.update()?.[1]).not.toHaveProperty('scope');
    expect(loaded.update()?.[1]).not.toHaveProperty('scopePolicy');
  });

  it.each([['title', '新的标题'], ['contentCategory', 'method']])('仅改 %s 不把全字段payload误算成正文审阅', async (field, value) => {
    const loaded = setup(); loaded.fields[field] = value;
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.update()?.[1]).toMatchObject({ statement: asset.statement, applicableWhen: asset.applicableWhen, forbiddenWhen: asset.forbiddenWhen });
    expect(loaded.update()?.[1]).not.toHaveProperty('reviewedDetails');
  });

  it('只改可见对象范围不审阅正文，隐藏项目和用途维度原样保留', async () => {
    const loaded = setup(); loaded.store.assetEditDrafts[asset.id].scopeSelection = { agentIds: ['commander'] };
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.update()?.[1]).toMatchObject({ scopePolicy: { ...asset.scopePolicy, agentIds: ['commander'] } });
    expect(loaded.update()?.[1]).not.toHaveProperty('reviewedDetails');
  });

  it('后台更新不替换正在展示的完整草稿，也不洗成一次新的正文审阅', async () => {
    const loaded = setup();
    const updated = { ...asset, version: '4', activeVersion: '4', statement: '后台未经用户审阅的新正文', applicableWhen: ['新的条件'], forbiddenWhen: [] };
    loaded.store.assets = [updated];
    const html = loaded.ns.renderLibraryAssetDetail(updated, { assetEdit: '1' });
    expect(html).toContain(asset.statement); expect(html).not.toContain(updated.statement);
    expect(html).toContain(asset.applicableWhen[0]); expect(html).toContain(asset.forbiddenWhen[0]);
    loaded.fields.title = '我只改标题';
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.update()?.[1]).toMatchObject({ statement: asset.statement, expectedVersion: '3', expectedActiveVersion: '2' });
    expect(loaded.update()?.[1]).not.toHaveProperty('reviewedDetails');
  });

  it('缺少真实打开基线或完整条件控件时，不宣称完整审阅', async () => {
    const loaded = setup(); delete loaded.store.assetEditDrafts[asset.id].baseReviewDetails;
    loaded.fields.statement = '用户改正文但没有合法打开基线';
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.update()?.[1]).not.toHaveProperty('reviewedDetails');
    const partial = setup(); partial.missing.add('forbidden'); partial.fields.statement = '缺少禁用场景控件';
    await partial.ns.actions.editAsset(asset.id);
    expect(partial.update()?.[1]).not.toHaveProperty('reviewedDetails');
  });

  it('冲突保留初始审阅基线和输入，重试不采用后台替换的文字', async () => {
    const loaded = setup(); loaded.fields.statement = '我的完整修改';
    loaded.call.mockRejectedValueOnce(new Error('ability asset active version conflict'));
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.store.assetEditDrafts[asset.id]).toMatchObject({ statement: '我的完整修改', baseVersion: '3', baseActiveVersion: '2',
      baseReviewDetails: { statement: asset.statement, applicableWhen: asset.applicableWhen, forbiddenWhen: asset.forbiddenWhen }, saveConflict: true });
    expect(loaded.update()?.[1].reviewedDetails).toBe(true);
  });

  it('确认重绑定CAS也保留原始实际编辑基线，标题改动不能借此升级正文授权', async () => {
    const loaded = setup(); const draft = loaded.store.assetEditDrafts[asset.id];
    const originalBase = draft.baseReviewDetails;
    const updated = { ...asset, version: '4', activeVersion: '4', statement: '后台未经用户审阅的相反要求' };
    loaded.ns.reload = async () => { loaded.store.assets = [updated]; };
    loaded.ns.confirmUser = async () => true;
    loaded.ns.notify = () => undefined;
    await loaded.ns.library.handleClick({ dataset: { act: 'library-review-conflict' }, disabled: false });
    expect(loaded.store.assetEditDrafts[asset.id]).toMatchObject({ baseVersion: '4', baseActiveVersion: '4', baseReviewDetails: originalBase, statement: asset.statement });
    loaded.fields.title = '只改标题';
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.update()?.[1]).toMatchObject({ expectedVersion: '4', expectedActiveVersion: '4' });
    expect(loaded.update()?.[1]).not.toHaveProperty('reviewedDetails');
  });

  it.each(['复杂技术问题，且没有临时要求', '分析、判断或解释方案时', '完成初步诊断；尚未验证根因', '核对事实,保留出处', '允许解释;禁止外发'])('原条件含分隔符仍完整保存：%s，不把标题修改洗成正文审阅', async condition => {
    // This is the body already changed by an agent before the user opens the
    // editor. Merely editing its title must not review that new body via parsing.
    const unreviewed = { ...asset, statement: '后台AI修改但未被用户审阅的新正文', applicableWhen: [condition], forbiddenWhen: ['来源缺失，或者权限已撤回'] };
    const loaded = setup(unreviewed); loaded.fields.title = '用户只修改标题';
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.update()?.[1]).toMatchObject({ statement: unreviewed.statement, applicableWhen: unreviewed.applicableWhen, forbiddenWhen: unreviewed.forbiddenWhen });
    expect(loaded.update()?.[1]).not.toHaveProperty('reviewedDetails');
  });

  it('条件排序或重复的展示编辑不产生新的语义审阅证明', async () => {
    const loaded = setup({ ...asset, applicableWhen: ['复杂问题', '方案解释'] });
    loaded.fields.applicable = '方案解释、复杂问题、复杂问题'; loaded.fields.title = '顺带改标题';
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.update()?.[1]).not.toHaveProperty('reviewedDetails');
  });

  it('冲突重绑定后仍对原始完整条件做无损回环，标题修改不变成审阅', async () => {
    const initial = { ...asset, applicableWhen: ['复杂技术问题，且没有临时要求'], forbiddenWhen: ['来源缺失、权限撤回时'] };
    const loaded = setup(initial);
    loaded.ns.reload = async () => { loaded.store.assets = [{ ...initial, version: '4', activeVersion: '4', statement: '后台新正文' }]; };
    loaded.ns.confirmUser = async () => true; loaded.ns.notify = () => undefined;
    await loaded.ns.library.handleClick({ dataset: { act: 'library-review-conflict' }, disabled: false });
    loaded.fields.title = '仅改标题';
    await loaded.ns.actions.editAsset(asset.id);
    expect(loaded.update()?.[1]).toMatchObject({ expectedVersion: '4', expectedActiveVersion: '4', statement: initial.statement, applicableWhen: initial.applicableWhen, forbiddenWhen: initial.forbiddenWhen });
    expect(loaded.update()?.[1]).not.toHaveProperty('reviewedDetails');
  });

});
