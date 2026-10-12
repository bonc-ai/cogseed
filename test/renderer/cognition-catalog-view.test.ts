import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCognition } from './helpers/cognition-renderer';

/* 计量词条（2026-09-28 词表统一）文本随 locale 同步更新——按 zh.json 派生，
 * 断言钉「用了哪个键 + 数字」，词条改文前后都成立。 */
const zh = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/zh.json'), 'utf8')) as Record<string, string>;
const zhPhrase = (key: string, vars: Record<string, string> = {}) => {
  let text = zh[key] ?? key;
  for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, value);
  return text;
};

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
        // 2026-09-25 US-602：目录行的次数与列表/详情同口径（「被带入任务」）——
        // 一次带入在数据层是 projection_confirmed + 同投影 usage 两条记录，按投影
        // 去重后算 1 次（没有投影关联的 usage 行不重复计数）。
        proofs: [
          { kind: 'projection_confirmed', occurredAt: '2026-09-18T01:00:00.000Z', refs: { assetId: 'aa-cat0001', projectionId: 'proj-cat' } },
          { kind: 'usage_recorded', occurredAt: '2026-09-18T01:00:00.000Z', refs: { assetId: 'aa-cat0001', projectionId: 'proj-cat' } },
        ],
      },
    );
    expect(html).toContain('资产目录（模型视角）');
    expect(html).toContain('性能归因规则');
    // 一句话 = 正文首句压到 22 字（2026-09-28 与主进程 catalogOneLine 同口径，
    // 两边同一句；不是全文，全文点进去看）
    expect(html).toContain('性能类提问需用真实日志做分层归因，先给链路再');
    expect(html).not.toContain('再给瓶颈');
    expect(html).not.toContain('后半句是看不到的正文');
    // 元信息：类型白话 + 范围白话 + 在用版 + 被带入次数
    expect(html).toContain('规则与偏好');
    expect(html).toContain('所有对话');
    expect(html).toContain('v2');
    expect(html).toContain(zhPhrase('cognition.catalog_used_times', { n: '1' }));
    // 切换回列表视图
    expect(html).toContain('列表视图');
    // 行仍可点进详情
    expect(html).toContain('data-go-asset="aa-cat0001"');
  });

  it('从来没被任务用过的资产如实标注', () => {
    const html = renderCognition({ name: 'overview', assetView: 'catalog' }, { assets: [asset], proofs: [] });
    expect(html).toContain(zhPhrase('cognition.catalog_never_used'));
  });

  it('默认仍是列表视图（目录是切换项，不是默认）', () => {
    const html = renderCognition({ name: 'overview' }, { assets: [asset], proofs: [] });
    expect(html).toContain('资产明细');
    expect(html).not.toContain('资产目录（模型视角）');
    // specs/018 T031：目录视图收进「管理」模式——默认视图只有管理小切换入口。
    expect(html).toContain('管理');
    expect(html).not.toContain('data-go-asset="aa-cat0001" data-act="asset-view"');
    const managed = renderCognition({ name: 'overview', manage: '1' }, { assets: [asset], proofs: [] });
    expect(managed).toContain('目录视图');
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
    expect(catalog).toContain('chip on');
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
// 无血缘合并；目录视图（模型视角）保持平铺。组头话术 2026-09-25 随 specs/012
// T008 降级为「同源」口径（族名 = 同源血缘，不是主题分类；分组行为不变）。
describe('family-grouped asset list', () => {
  it('groups same_family assets under one head with a count, others under unsorted', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    // specs/018 T031：同源血缘分组只在「管理」模式出现。
    const html = renderCognition({ name: 'overview', manage: '1' }, {
      assets: [
        { id: 'aa-1', type: 'personal', title: '不用比喻', statement: '内容一。', status: 'active', version: '1', updatedAt: '2026-09-22T01:00:00Z', relations: [{ kind: 'same_family', assetId: 'aa-2' }] },
        { id: 'aa-2', type: 'personal', title: '标识符括号解释', statement: '内容二。', status: 'active', version: '1', updatedAt: '2026-09-22T02:00:00Z', relations: [{ kind: 'same_family', assetId: 'aa-1' }] },
        { id: 'aa-3', type: 'rule', title: '接口变更同步文档', statement: '内容三。', status: 'active', version: '1', updatedAt: '2026-09-22T03:00:00Z' },
      ],
    });
    expect(html).toContain('fam-hd');
    expect(html).toContain('标识符括号解释'); // 组名取组内最新
    expect(html).toContain('2 条同源');
    expect(html).toContain('无同源血缘');
    // 旧话术不再指称族（与标签的「未分类」撞车，specs/012 T008）。
    expect(html).not.toContain('条同类');
    expect(html).not.toContain('未归类');
  });

  it('catalog view stays flat (model perspective)', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview', assetView: 'catalog' }, {
      assets: [
        { id: 'aa-1', type: 'personal', title: 'A', statement: '一。', status: 'active', version: '1', relations: [{ kind: 'same_family', assetId: 'aa-2' }] },
        { id: 'aa-2', type: 'personal', title: 'B', statement: '二。', status: 'active', version: '1', relations: [{ kind: 'same_family', assetId: 'aa-1' }] },
      ],
    });
    expect(html).not.toContain('fam-hd');
  });
});


describe('origin chip on the detail header', () => {
  it('shows the model-written chip and a confirm button for an unverified origin', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview', assetId: 'aa-origin-1' }, {
      assets: [{
        id: 'aa-origin-1', type: 'personal', title: '模型记的偏好', statement: '内容。',
        status: 'active', version: '1', lifecycleStatus: 'user_confirmed_unverified',
        updatedAt: '2026-09-19T00:00:00Z',
      }],
    });
    // 出身收敛（2026-09-20）：出身章与转正按钮整体退役——转正不再出现
    // （「模型记的」四字由该测试资产标题自带，不作反断言）。
    expect(html).not.toContain('转正');
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


describe('asset status chip wording (2026-09-22 快赢)', () => {
  it('active reads 生效中 and the old 已确认 wording is gone from rows', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview' }, {
      assets: [{
        id: 'aa-wording-1', type: 'personal', title: '偏好条目', statement: '内容。',
        status: 'active', version: '1', updatedAt: '2026-09-22T00:00:00Z',
      }],
    });
    expect(html).toContain('生效中');
    expect(html).not.toContain('已确认');
  });
});

});
