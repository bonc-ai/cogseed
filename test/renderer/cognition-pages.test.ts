import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../src/renderer/modules/icons.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../src/renderer/modules/ui-button.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../src/renderer/modules/ui-form.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../src/renderer/modules/ui-empty.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../src/renderer/modules/ui-page-header.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pages = require('../../src/renderer/modules/cognition/pages.js') as {
  renderCognitionPage: (input: {
    assets?: Array<Record<string, unknown>>;
    activeId?: string;
    activeAsset?: Record<string, unknown> | null;
    detailLoading?: boolean;
    pagination?: { page: number; pageSize: number; total: number; totalPages: number };
    view?: string;
  }) => string;
  renderCognitionCapture: (input: {
    state?: 'loading' | 'ready' | 'error';
    title: string;
    summary: string;
    evidence?: string;
    sourceLabel: string;
    suggestedType?: string;
    conversationId: string;
    messageId?: string;
    error?: string;
  }) => string;
  escapeHtml: (value: string) => string;
};

const summary = {
  id: 'cog_1',
  title: '复杂任务拆解',
  summary: '先澄清边界、拆分依赖，再安排执行顺序',
  stage: 'sprout',
  reviewState: 'pending',
  evidenceCount: 1,
  reuseCount: 0,
  updatedAt: '2026-08-03T19:00:00.000Z',
};

const asset = {
  ...summary,
  evidence: [{ summary: '用户要求先调研，再确认方案', sourceLabel: '当前会话' }],
  reuseEvents: [],
};

describe('cognition pages', () => {
  it('shows generation progress before exposing editable model output', () => {
    const loading = pages.renderCognitionCapture({
      state: 'loading', title: '', summary: '', evidence: '', sourceLabel: '', conversationId: 'conv_1',
    });
    expect(loading).toContain('data-cognition-capture-status');
    expect(loading).toContain('正在从会话中提炼可复用认知');
    expect(loading).not.toContain('data-cognition-capture-submit');

    const ready = pages.renderCognitionCapture({
      state: 'ready', title: '模型生成名称', summary: '模型生成方法', evidence: '模型生成证据',
      sourceLabel: '当前会话', conversationId: 'conv_1',
    });
    expect(ready).toContain('模型生成名称');
    expect(ready).toContain('模型生成方法');
    expect(ready).toContain('模型生成证据');
    expect(ready).toContain('data-cognition-capture-submit');
  });

  it('四类分类是必填项，模型预判只作默认值', () => {
    // 气泡沉淀产出的是 recall 候选，saveRecallCandidate 会 requireAssetType，
    // 所以分类必须在面板上收齐——不能靠后端兜底猜一个。
    const withGuess = pages.renderCognitionCapture({
      state: 'ready', title: 't', summary: 's', evidence: 'e',
      sourceLabel: '当前会话', suggestedType: 'rule',
      conversationId: 'conv_1', messageId: 'msg_1',
    });
    expect(withGuess).toContain('data-cognition-capture-type');
    expect(withGuess).toContain('<option value="rule" selected>');
    // 锚点消息 id 必须带进表单：evidenceRefs 要靠它，而不是靠用户手填的来源文本。
    expect(withGuess).toContain('data-cognition-capture-message value="msg_1"');

    // 模型给不出合法四类时留空占位，强制用户自己选,不替他猜一个默认分类。
    const noGuess = pages.renderCognitionCapture({
      state: 'ready', title: 't', summary: 's', evidence: 'e',
      sourceLabel: '当前会话', suggestedType: 'not_a_type',
      conversationId: 'conv_1', messageId: 'msg_1',
    });
    expect(noGuess).toContain('<option value="" selected>');
    expect(noGuess).not.toContain('<option value="skill_method" selected>');
  });

  it('摘要列表可渲染成长树，但完整详情未加载前不冒充零证据', () => {
    const html = pages.renderCognitionPage({ assets: [summary], activeId: summary.id, view: 'tree' });
    expect(html).toContain('data-cognition-growth-visual');
    expect(html).toContain('复杂任务拆解');
    expect(html).toContain('完整详情暂不可用');
    expect(html).not.toContain('用户要求先调研，再确认方案');
    expect(html).not.toContain('data-cognition-action="confirm"');
    expect(html).not.toContain('还没有证据');
  });

  it('完整详情加载后才渲染证据和人工确认操作', () => {
    const html = pages.renderCognitionPage({ assets: [summary], activeId: summary.id, activeAsset: asset, view: 'tree' });
    expect(html).toContain('用户要求先调研，再确认方案');
    expect(html).toContain('data-cognition-action="confirm"');
    expect(html).toContain('长期记忆');
  });

  it('成长记录页展示结构化生命周期轨迹并保留失效原因', () => {
    const html = pages.renderCognitionPage({
      assets: [{ ...summary, stage: 'growing', reviewState: 'confirmed' }],
      activeAsset: {
        ...asset,
        stage: 'growing',
        reviewState: 'confirmed',
        transitions: [
          { id: 'tr_1', kind: 'created', at: '2026-08-03T09:00:00' },
          { id: 'tr_2', kind: 'evidence_added', at: '2026-08-03T09:01:00' },
          { id: 'tr_3', kind: 'confirmed', at: '2026-08-03T09:02:00' },
          { id: 'tr_4', kind: 'invalidated', at: '2026-08-03T09:03:00', reason: 'content_changed' },
        ],
      },
      view: 'history',
    });
    expect(html).toContain('生命周期记录');
    expect(html).toContain('创建认知候选');
    expect(html).toContain('确认并写入长期记忆');
    expect(html).toContain('长期记忆内容与这项认知已不一致');
  });

  it('详情请求进行中显示加载态而不是错误态', () => {
    const html = pages.renderCognitionPage({
      assets: [summary], activeId: summary.id, detailLoading: true, view: 'tree',
    });
    expect(html).toContain('正在加载完整证据和复用记录');
    expect(html).not.toContain('data-cognition-action="retry-detail"');
  });

  it('只在确认状态展示复用操作，不跳过人工确认点', () => {
    const pending = pages.renderCognitionPage({ assets: [summary], activeAsset: asset, view: 'tree' });
    const confirmedSummary = { ...summary, stage: 'growing', reviewState: 'confirmed' };
    const confirmedAsset = { ...asset, ...confirmedSummary };
    const confirmed = pages.renderCognitionPage({
      assets: [confirmedSummary], activeAsset: confirmedAsset, view: 'tree',
    });
    expect(pending).not.toContain('data-cognition-action="reuse"');
    expect(confirmed).toContain('data-cognition-action="reuse"');
  });

  it('失效认知解释原因，只提供显式重新确认且不允许复用', () => {
    const invalidatedSummary = {
      ...summary,
      reviewState: 'invalidated',
      invalidation: { at: '2026-08-03T20:00:00.000Z', reason: 'content_changed' },
    };
    const invalidatedAsset = { ...asset, ...invalidatedSummary };
    const html = pages.renderCognitionPage({ assets: [invalidatedSummary], activeAsset: invalidatedAsset, view: 'history' });
    expect(html).toContain('需要重新确认');
    expect(html).toContain('长期记忆内容与这项认知已不一致');
    expect(html).toContain('重新确认并写入长期记忆');
    expect(html).toContain('data-cognition-action="confirm"');
    expect(html).not.toContain('data-cognition-action="reuse"');
    expect(html).not.toContain('复用记录');
  });

  it('长期记忆写入失败后显示可恢复的重试操作', () => {
    const retrySummary = { ...summary, confirmationRequestedAt: '2026-08-03T19:00:00' };
    const html = pages.renderCognitionPage({
      assets: [retrySummary], activeAsset: { ...asset, ...retrySummary }, view: 'tree',
    });
    expect(html).toContain('重试写入长期记忆');
    expect(html).toContain('data-cognition-action="confirm"');
  });

  it('非数组摘要输入安全降级为空页', () => {
    const html = pages.renderCognitionPage({ assets: undefined, view: 'tree' });
    expect(html).toContain('还没有认知资产');
  });

  it('分页展示边界正确', () => {
    const html = pages.renderCognitionPage({
      assets: [summary],
      activeAsset: asset,
      pagination: { page: 2, pageSize: 50, total: 101, totalPages: 3 },
    });
    expect(html).toContain('data-cognition-page="1"');
    expect(html).toContain('data-cognition-page="3"');
    expect(html).toContain('第 2 / 3 页');
  });

  it('从对话沉淀的候选保留可编辑摘要、证据和来源', () => {
    const html = pages.renderCognitionCapture({
      title: '先确认边界再执行',
      summary: '先确认边界，再安排执行顺序。',
      evidence: '本次对话先确认了验收标准。',
      sourceLabel: '任务：方案设计',
      conversationId: 'c_capture',
    });
    expect(html).toContain('data-cognition-capture-form');
    expect(html).toContain('任务：方案设计');
    expect(html).toContain('本次对话先确认了验收标准。');
    expect(html).toContain('c_capture');
  });

  it('转义资产和属性内容', () => {
    const hostileSummary = { ...summary, title: '<script>alert(1)</script>' };
    const html = pages.renderCognitionPage({ assets: [hostileSummary], view: 'tree' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(pages.escapeHtml('"<>&\'')).toBe('&quot;&lt;&gt;&amp;&#39;');
  });

  it('四套 renderer locale 都包含详情、失效和分页文案', () => {
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const strings = JSON.parse(readFileSync(
        resolve(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      )) as Record<string, string>;
      for (const key of [
        'cognition.detail.loading',
        'cognition.detail.unavailable',
        'cognition.action.reconfirm',
        'cognition.action.retry_detail',
        'cognition.invalidated.title',
        'cognition.invalidated.reason.removed',
        'cognition.invalidated.reason.replaced',
        'cognition.invalidated.reason.content_changed',
        'cognition.invalidated.reason.metadata_missing',
        'cognition.section.history',
        'cognition.history.empty',
        'cognition.transition.created',
        'cognition.transition.evidence_added',
        'cognition.transition.confirmation_requested',
        'cognition.transition.defer_requested',
        'cognition.transition.confirmed',
        'cognition.transition.reconfirmed',
        'cognition.transition.deferred',
        'cognition.transition.reused',
        'cognition.transition.invalidated',
        'cognition.transition.unknown',
        'cognition.pagination.previous',
        'cognition.pagination.next',
      ]) expect(strings[key]).toBeTruthy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-21 认知资产迁移:HTML 原型 v7 的五页签结构守护(源码级契约,
// 与上方旧模块 require 测试并存——旧模块仍被 personal-ontology 懒加载组使用)。
// 迁移终态:tree / ontology / overview / review / organize,默认路由 tree。
// ─────────────────────────────────────────────────────────────────────────────
describe('cognition-assets 五页签结构(迁移终态)', () => {
  const core2 = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf8');
  const views2 = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf8');
  const html2 = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');

  /** 解析 core.js 的 TABS 数组为 [{id, titleKey}]。 */
  function parseTabs(source: string): Array<{ id: string; titleKey: string }> {
    const start = source.indexOf('const TABS = [');
    const end = source.indexOf('];', start);
    const block = source.slice(start, end);
    const tabs: Array<{ id: string; titleKey: string }> = [];
    for (const m of block.matchAll(/\{ id: '([a-z-]+)', titleKey: '([A-Za-z_.]+)'/g)) {
      tabs.push({ id: m[1], titleKey: m[2] });
    }
    return tabs;
  }

  it('TABS 是五页签且顺序固定:认知树 / 个人本体 / 我的认知 / 待我处理 / 整理', () => {
    const tabs = parseTabs(core2);
    expect(tabs.map((t) => t.id)).toEqual(['tree', 'ontology', 'overview', 'review', 'organize']);
    expect(tabs.map((t) => t.titleKey)).toEqual([
      'cognition.tab_tree', 'cognition.tab_ontology', 'cognition.tab_overview',
      'cognition.tab_review', 'cognition.tab_organize',
    ]);
  });

  it('默认路由是认知树,深链归一化键保留', () => {
    expect(core2).toContain("route: { name: 'tree'");
    expect(core2).toContain("Object.assign({ name: 'tree'");
    // 深链兼容:既有详情路由键一个都不能少(资产/候选/整理/版本/KSTAR)。
    for (const key of ['assetId', 'candidateId', 'captureId', 'assetVersionId', 'kstarEpisodeId', 'assetEdit']) {
      expect(core2).toContain(`${key}: ''`);
    }
  });

  it('认知树与我的认知拆分为独立页面,overview 不再承载树图主界面', () => {
    expect(views2).toContain('function viewTree(');
    expect(views2).toContain("route.name === 'tree'");
    expect(views2).toContain('function viewOntology(');
    // viewOverview 函数体内不再调用 treeBlocks——树整卡搬去了独立页。
    const start = views2.indexOf('function viewOverview');
    const end = views2.indexOf('\n  function ', start + 10);
    const overviewBlock = views2.slice(start, end);
    expect(overviewBlock).not.toContain('treeBlocks(');
  });

  it('页面壳只建一次:持久壳 + 内容区局部重绘', () => {
    expect(views2).toContain('ca-ontology-mount');
    expect(views2).toContain('unmountPersonalOntology');
    expect(views2).toContain('ca-banner-slot');
    expect(html2).toContain('id="ca-ontology-parking"');
    expect(core2).toContain('ca-ontology-parking');
    expect(core2).toContain('renderPersonalOntology');
  });

  it('五页签标题四语齐全', () => {
    for (const locale of ['zh', 'en', 'ja', 'pt'] as const) {
      const table = JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${locale}.json`), 'utf8'));
      for (const key of ['cognition.tab_tree', 'cognition.tab_ontology', 'cognition.tab_overview', 'cognition.tab_review', 'cognition.tab_organize']) {
        expect(table[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-21 Phase 10 a11y:tab 方向键漫游与重绘焦点保持(源码级契约)。
// ─────────────────────────────────────────────────────────────────────────────
describe('cognition-assets a11y(Phase 10)', () => {
  const app3 = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/app.js'), 'utf8');

  it('tab 行支持 ←/→/Home/End 方向键漫游(委托到 root)', () => {
    expect(app3).toContain('ArrowLeft');
    expect(app3).toContain("event.target.closest('.ca-tabs')");
    expect(app3).toContain("event.target.closest('.ca-tab')");
  });

  it('内容区重绘后焦点不落 body:按特征找回或回落首个可聚焦控件', () => {
    expect(app3).toContain('#ca-scroll');
    expect(app3).toMatch(/preventScroll/);
    expect(app3).toContain('data-go-asset="${CSS.escape');
    expect(app3).toContain('scroll.querySelector(\'button, [role="button"]\')');
  });
});
