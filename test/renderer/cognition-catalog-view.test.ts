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
});
