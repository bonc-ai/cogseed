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
});
