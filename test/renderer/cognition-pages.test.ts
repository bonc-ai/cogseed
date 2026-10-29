import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-21 认知资产迁移:HTML 原型 v7 的页签结构守护(源码级契约)。
// 2026-10-07 旧模块 personal-ontology.js 随停驻页退役删除——同名懒加载组只余
// personal-context-review.js，手动沉淀模块已下线。
// ─────────────────────────────────────────────────────────────────────────────
describe('cognition-assets 五页签结构(迁移终态)', () => {
  const core2 = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf8');
  const views2 = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf8');
  const html2 = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');

  /** 解析 core.js 的 TABS 数组为 [{id, titleKey}]。 */
  function parseTabs(source: string): Array<{ id: string, titleKey: string }> {
    const start = source.indexOf('const TABS = [');
    const end = source.indexOf('];', start);
    const block = source.slice(start, end);
    const tabs: Array<{ id: string, titleKey: string }> = [];
    for (const m of block.matchAll(/\{ id: '([a-z-]+)', titleKey: '([A-Za-z_.]+)'/g)) {
      tabs.push({ id: m[1], titleKey: m[2] });
    }
    return tabs;
  }

  it('TABS 保留五个位置但认知树禁用，顺序固定', () => {
    // 认知树暂禁用并由旧路由归一到「我的认知」。2026-10-08 U04:独立「待我处理」页签
    // 下线,治理动作收敛到系统活动(需要关注/已处理),旧 review 路由归一。
    // 2026-09-27 子安定序:「我的认知」提到「个人本体(关于我)」之前。
    const tabs = parseTabs(core2);
    expect(tabs.map((t) => t.id)).toEqual(['tree', 'overview', 'ontology', 'activity', 'settings']);
    expect(tabs.map((t) => t.titleKey)).toEqual([
      'cognition.tab_tree', 'cognition.tab_overview', 'cognition.tab_ontology',
      'cognition.tab_activity', 'cognition.tab_settings',
    ]);
    expect(core2).toContain("{ id: 'tree', titleKey: 'cognition.tab_tree', title: '认知树', disabled: true }");
  });

  it('默认路由是我的认知，旧树深链归一且详情键保留', () => {
    expect(core2).toContain("route: { name: 'overview'");
    expect(core2).toContain("Object.assign({ name: 'overview'");
    expect(core2).toContain("if (legacyName === 'tree') target = Object.assign({}, target, { name: 'overview' })");
    // 深链兼容:既有详情路由键一个都不能少(资产/候选/整理/版本/KSTAR)。
    for (const key of ['assetId', 'candidateId', 'captureId', 'assetVersionId', 'kstarEpisodeId', 'assetEdit']) {
      expect(core2).toContain(`${key}: ''`);
    }
    // 旧路由名在 router.go 入栈前归一(organize/organize-settings/experiences)。
    expect(core2).toContain("legacyName === 'organize-settings'");
  });

  it('认知树是独立页面,overview 列表不内嵌树图', () => {
    expect(views2).toContain('function viewTree(');
    expect(views2).toContain("route.name === 'tree'");
    expect(views2).toContain('function viewOntology(');
    // viewOverview 函数体内不调用 treeBlocks——树整卡是独立页。
    const start = views2.indexOf('function viewOverview');
    const end = views2.indexOf('\n  function ', start + 10);
    const overviewBlock = views2.slice(start, end);
    expect(overviewBlock).not.toContain('treeBlocks(');
  });

  it('页面壳只建一次:持久壳 + 内容区局部重绘(旧停驻页已退役)', () => {
    expect(views2).toContain('ca-ontology-mount');
    expect(views2).toContain('unmountPersonalOntology');
    expect(views2).toContain('ca-banner-slot');
    // 2026-10-07 退役:HTML 不再有停车区壳,core 不再有归还逻辑。
    expect(html2).not.toContain('ca-ontology-parking');
    expect(html2).not.toContain('id="panel-personal-ontology"');
    expect(core2).not.toContain('ca-ontology-parking');
    expect(core2).toContain("await load('cognition-ontology')");
    expect(core2).toContain('mountCognitionOntology(mount, options)');
    expect(core2).not.toContain('renderPersonalOntology()');
    expect(core2).not.toContain('refreshPersonalOntology');
  });

  it('五页签标题四语齐全', () => {
    for (const locale of ['zh', 'en', 'ja', 'pt'] as const) {
      const table = JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${locale}.json`), 'utf8'));
      for (const key of ['cognition.tab_tree', 'cognition.tab_ontology', 'cognition.tab_overview', 'cognition.tab_review', 'cognition.tab_activity', 'cognition.tab_settings']) {
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
    // Drawer 打开时回落范围收敛到 drawer，找不到再回全域首个可聚焦控件。
    expect(app3).toContain("first('button, [role=\"button\"]')");
    expect(app3).toContain('const scope = drawer || scroll');
  });
});
