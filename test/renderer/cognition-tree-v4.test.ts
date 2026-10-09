/**
 * 认知树 v4 守护(HTML 原型 v7 的树形态契约,源码级断言)。
 *
 * 迁移后的树(对应原型 drawTree L933-1021 / 计划 Phase 4):
 * - 树冠=「已验证」聚合光斑;树干=个人本体(进 ontology 路由);
 *   根部=「待确认」聚合;土壤=来源与整理。
 * - 四主枝:技能与方法 / 事实与知识(fact) / 规则与偏好 / 模板与范例。
 * - 枝端光斑=大方向分类;叶片=细分方向(同族组名 → 标题冒号前主题 → 标题);
 *   **单条资产不再渲染成光斑**。
 * - 计数口径:分类数排除 archived/deleted/purged/revoked;待确认走
 *   capabilities countsAsPending;已验证走 maturity + active。
 * - resize 防抖重绘;树 loading 保留旧树不清空。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const views = read('src/renderer/modules/cognition-assets/views.js');
const app = read('src/renderer/modules/cognition-assets/app.js');
const core = read('src/renderer/modules/cognition-assets/core.js');

/**
 * 树主体区块:branchDirections 起(含 TREE_BRANCHES / treeViewport / spotSvg /
 * treeFigure),到「资产详情」注释止——原型 v7 drawTree 的移植段。
 * 2026-09-21 视觉移植:几何按容器实测像素画(viewBox 动态),与原型一致。
 */
function treeBlock(): string {
  const anchor = views.indexOf('function branchDirections');
  if (anchor < 0) return '';
  const end = views.indexOf('资产详情', anchor);
  return views.slice(anchor, end > 0 ? end : undefined);
}

/** viewTree 页面函数:计数口径与方向派生的消费方。 */
function viewTreeBlock(): string {
  const anchor = views.indexOf('function viewTree');
  if (anchor < 0) return '';
  const end = views.indexOf('\n  function ', anchor + 10);
  return views.slice(anchor, end > 0 ? end : undefined);
}

describe('认知树 v4', () => {
  it('四主枝齐全,含「事实与知识」(fact)', () => {
    const tree = treeBlock();
    expect(tree).not.toBe('');
    for (const key of [
      'cognition.tree_branch_skill_method', 'cognition.tree_branch_fact',
      'cognition.tree_branch_rule', 'cognition.tree_branch_template',
    ]) expect(tree).toContain(key);
  });

  it('枝端光斑走分类导航(fact 可从树进入分类列表)', () => {
    const tree = treeBlock();
    // 光斑走 spotSvg 统一挂载:data-act 由调用方传入,data-id 由 o.id 拼。
    expect(tree).toContain("act: 'filter-cat'");
    expect(tree).toContain('data-act="${esc(o.act)}"');
    expect(tree).toContain('data-id="${esc(o.id)}"');
    // 四主枝枚举含 fact,光斑导航即覆盖事实与知识。
    expect(tree).toMatch(/\{ id: 'fact',/);
  });

  it('树干进入个人本体、根部进入待处理、树冠为已验证聚合', () => {
    const tree = treeBlock();
    expect(tree).toContain('data-act="open-ontology"');
    expect(tree).toContain("act: 'go-review'");
    expect(tree).toContain('cognition.tree_crown_validated');
  });

  it('叶片=细分方向且合并计数,单条资产不渲染成光斑', () => {
    const tree = treeBlock();
    // 方向派生三阶梯:家族组名 → 标题冒号前主题 → 标题;同方向合并 ×n。
    expect(views).toContain('branchDirections');
    expect(tree).not.toMatch(/data-act="open-asset"/);
  });

  it('计数口径:分类排除终态,待确认走能力判据,已验证走成熟度', () => {
    const treePage = viewTreeBlock();
    expect(treePage).toMatch(/archived[\s\S]{0,40}deleted[\s\S]{0,40}purged/);
    expect(treePage).toContain('stats.pending');
    expect(treePage).toMatch(/transfer_validated|effectiveness_validated/);
  });

  it('viewBox 按容器实测像素自适应;树 loading 不清空旧树', () => {
    // 2026-09-21 视觉移植定调:原型 drawTree 就是按容器实测像素出图
    // (svg.clientWidth/clientHeight),移植后同样动态——首帧量不到真值时
    // 退回占位尺寸,挂载后由 render() 的收敛回环重画一次;窗口缩放走 resize。
    expect(views).toContain('viewBox="0 0 ${W} ${H}"');
    expect(views).toContain('function treeViewport');
    expect(views).toContain('ca-tree-svg');
    // 首载骨架只出现在 !S.loaded 时;有数据后重画不清树(持久壳语义)。
    expect(views).toContain('S.loading && !S.loaded');
  });

  it('树图文案四语齐全', () => {
    for (const locale of ['zh', 'en', 'ja', 'pt'] as const) {
      const table = JSON.parse(read(`src/renderer/locales/${locale}.json`));
      for (const key of [
        'cognition.tree_branch_skill_method', 'cognition.tree_branch_fact',
        'cognition.tree_branch_rule', 'cognition.tree_branch_template',
        'cognition.tree_crown_validated', 'cognition.tree_root_pending', 'cognition.tree_soil_label',
      ]) expect(table[key], `${locale}:${key}`).toBeTruthy();
    }
  });
});
