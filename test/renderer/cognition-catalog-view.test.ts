import { describe, expect, it } from 'vitest';
import { renderCognition } from './helpers/cognition-renderer';

/**
 * 资产目录视图（2026-09-18）：面板上多一个"模型视角"的目录——模型挑资产时
 * 看的就是这份（`search_ability_assets` 目录模式），用户在同一份目录上核对
 * 模型的选择。不新增 tab：同一个列表页换行形态（route.assetView）。
 */
const asset = {
  id: 'aa-cat0001',
  title: '性能归因规则',
  type: 'rule',
  scope: 'general',
  status: 'active',
  version: '3',
  activeVersion: '2',
  maturity: 'transfer_validated',
  statement: '性能类提问需用真实日志做分层归因，先给链路再给瓶颈。后半句是看不到的正文。',
  updatedAt: '2026-09-18T00:00:00.000Z',
};

describe('资产目录视图', () => {
  it('目录视图：一行一条（标题 / 一句话 / 类型·范围·版本·使用次数），并给回列表的入口', () => {
    const html = renderCognition(
      { name: 'overview', assetView: 'catalog' },
      {
        assets: [asset],
        proofs: [{ kind: 'usage_recorded', occurredAt: '2026-09-18T01:00:00.000Z', refs: { assetId: 'aa-cat0001' } }],
      },
    );
    expect(html).toContain('资产目录（模型视角）');
    expect(html).toContain('性能归因规则');
    // 一句话 = 正文首句（不是全文，全文点进去看）
    expect(html).toContain('性能类提问需用真实日志做分层归因，先给链路再给瓶颈');
    expect(html).not.toContain('后半句是看不到的正文');
    // 元信息：类型白话 + 范围白话 + 在用版 + 使用次数
    expect(html).toContain('规则与偏好');
    expect(html).toContain('所有对话');
    expect(html).toContain('v2');
    expect(html).toContain('用过 1 次');
    // 切换回列表视图
    expect(html).toContain('列表视图');
    // 行仍可点进详情
    expect(html).toContain('data-go-asset="aa-cat0001"');
  });

  it('从来没被用过的资产如实标"还没用过"', () => {
    const html = renderCognition({ name: 'overview', assetView: 'catalog' }, { assets: [asset], proofs: [] });
    expect(html).toContain('还没用过');
  });

  it('默认仍是列表视图（目录是切换项，不是默认）', () => {
    const html = renderCognition({ name: 'overview' }, { assets: [asset], proofs: [] });
    expect(html).toContain('资产明细');
    expect(html).not.toContain('资产目录（模型视角）');
    expect(html).toContain('目录视图');
  });

  it('模型挂着标记（2026-09-18）：被模型自选的资产在目录行上可辨认', () => {
    const other = { ...asset, id: 'aa-cat0003', title: '没被挂的资产' };
    const html = renderCognition(
      { name: 'overview', assetView: 'catalog' },
      { assets: [asset, other], proofs: [], modelSelectedAssetIds: ['aa-cat0001'] },
    );
    const marked = html.split('模型挂着').length - 1;
    expect(marked).toBe(1);
    const [rowWith, rowWithout] = html.split('data-go-asset=').slice(1);
    expect(rowWith).toContain('模型挂着');
    expect(rowWithout).not.toContain('模型挂着');
  });

  it('空态（可用性）：没有资产时目录视图给明确空态，而不是空白表头', () => {
    const html = renderCognition({ name: 'overview', assetView: 'catalog' }, { assets: [], proofs: [] });
    expect(html).toContain('资产目录（模型视角）');
    expect(html).toContain('还没有正式资产');
    expect(html).not.toContain('data-go-asset=');
  });

  it('长列表（可用性）：35 条资产全部渲染，计数与实际条目一致', () => {
    const many = Array.from({ length: 35 }, (_, index) => ({
      ...asset,
      id: `aa-many${String(index).padStart(4, '0')}`,
      title: `批量资产 ${index + 1}`,
    }));
    const html = renderCognition({ name: 'overview', assetView: 'catalog' }, { assets: many, proofs: [] });
    const rows = html.split('data-go-asset=').length - 1;
    expect(rows).toBe(35);
    expect(html).toContain('全部 35');
  });

  it('视图切换与分类筛选互不打扰（O7）：目录视图下仍带分类 chips，筛选态在切换后保持', () => {
    const template = { ...asset, id: 'aa-cat0002', title: '复盘模板', type: 'template' };
    const catalog = renderCognition(
      { name: 'overview', assetView: 'catalog', category: 'rule' },
      { assets: [asset, template], proofs: [] },
    );
    // 目录视图照样有分类 chips，且当前分类高亮（筛选未被视图切换清掉）。
    expect(catalog).toContain('data-act="filter-cat"');
    expect(catalog).toContain('is-green');
    // 筛选生效：只出 rule，不出 template。
    expect(catalog).toContain('性能归因规则');
    expect(catalog).not.toContain('复盘模板');

    const list = renderCognition(
      { name: 'overview', assetView: '', category: 'rule' },
      { assets: [asset, template], proofs: [] },
    );
    expect(list).toContain('资产明细');
    expect(list).not.toContain('复盘模板');
  });

// 大类分组视图（2026-09-22 清单 #2）：same_family 连通分量成组、组头带计数、
// 未归类合并；目录视图（模型视角）保持平铺。
describe('family-grouped asset list', () => {
  it('groups same_family assets under one head with a count, others under unsorted', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview' }, {
      assets: [
        { id: 'aa-1', type: 'personal', title: '不用比喻', statement: '内容一。', status: 'active', version: '1', updatedAt: '2026-09-22T01:00:00Z', relations: [{ kind: 'same_family', assetId: 'aa-2' }] },
        { id: 'aa-2', type: 'personal', title: '标识符括号解释', statement: '内容二。', status: 'active', version: '1', updatedAt: '2026-09-22T02:00:00Z', relations: [{ kind: 'same_family', assetId: 'aa-1' }] },
        { id: 'aa-3', type: 'rule', title: '接口变更同步文档', statement: '内容三。', status: 'active', version: '1', updatedAt: '2026-09-22T03:00:00Z' },
      ],
    });
    expect(html).toContain('ca-family-group');
    expect(html).toContain('标识符括号解释'); // 组名取组内最新
    expect(html).toContain('2 条同类');
    expect(html).toContain('未归类');
  });

  it('catalog view stays flat (model perspective)', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview', assetView: 'catalog' }, {
      assets: [
        { id: 'aa-1', type: 'personal', title: 'A', statement: '一。', status: 'active', version: '1', relations: [{ kind: 'same_family', assetId: 'aa-2' }] },
        { id: 'aa-2', type: 'personal', title: 'B', statement: '二。', status: 'active', version: '1', relations: [{ kind: 'same_family', assetId: 'aa-1' }] },
      ],
    });
    expect(html).not.toContain('ca-family-group');
  });
});


describe('origin chip on the detail header', () => {
  it('shows the model-written chip and a confirm button for an unverified origin', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview', assetId: 'aa-origin-1' }, {
      assets: [{
        id: 'aa-origin-1', type: 'personal', title: '模型记的偏好', statement: '内容。',
        status: 'active', version: '1', lifecycleStatus: 'automatically_extracted_unverified',
        updatedAt: '2026-09-19T00:00:00Z',
      }],
    });
    expect(html).toContain('模型记的');
    expect(html).toContain('转正');
  });

  it('shows no origin chip for a user-confirmed asset', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview', assetId: 'aa-origin-2' }, {
      assets: [{
        id: 'aa-origin-2', type: 'personal', title: '你确认过的偏好', statement: '内容。',
        status: 'active', version: '1', lifecycleStatus: 'user_confirmed_unverified',
        updatedAt: '2026-09-19T00:00:00Z',
      }],
    });
    expect(html).not.toContain('模型记的');
    expect(html).not.toContain('>转正<');
  });
});

});
