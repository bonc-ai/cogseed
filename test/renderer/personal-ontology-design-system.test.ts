import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(__dirname, '../../src/renderer');
const source = readFileSync(resolve(rendererRoot, 'modules/personal-ontology.js'), 'utf8');
const cognitionAssetsCss = readFileSync(resolve(rendererRoot, 'cognition-assets.css'), 'utf8');

describe('personal ontology design-system integration', () => {
  it('routes ordinary actions and form controls through shared primitives', () => {
    for (const seam of ['_button({', '_iconButton({', '_input({', '_textarea({', '_emptyState({']) {
      expect(source).toContain(seam);
    }
    expect(source).toContain("'data-poc-group-action': 'field-add-value'");
    expect(source).toContain("'data-poc-group-action': 'save-content'");
    expect(source).toContain("className: 'personal-onto-library-install'");
    expect(source).toContain("attrs: { id: 'personal-onto-load-retry' }");
  });

  it('keeps native controls styled and scarce', () => {
    // 2026-09-29 v2 重构：原生控件只剩 ①模板编辑器 tab/原文行 ②库弹窗行
    // ③导航行 ④模板行/库按钮 ⑤v2 的分组筛选下拉 / 搜索框 / 关系复选框 /
    // 候选去向。文本输入与按钮一律走 _input/_textarea/_button 共享原语；
    // 原生 select/checkbox/search 必须带 po2- 样式类（在 cognition-assets.css
    // 里有统一定义），不允许出现无类裸控件。
    const selects = source.match(/<select\b[^>]*>/gi) || [];
    expect(selects.length).toBeGreaterThan(0);
    for (const tag of selects) expect(tag).toContain('po2-select');
    for (const tag of source.match(/<input\b[^>]*>/gi) || []) {
      expect(tag.includes('po2-input') || tag.includes('po2-checkbox')).toBe(true);
    }
    // 文本域只经 _textarea 原语（不含裸 <textarea>）。
    expect((source.match(/<textarea\b/gi) || []).length).toBe(0);
    expect(source).toContain('class="personal-onto-library-row');
    expect(source).toContain('class="personal-onto-nav-row is-file"'); // 分组与模板页模板行
    expect(source).toContain('personal-onto-nav-row${active'); // 三页 nav 行（active 拼接）
    expect(source).toContain("className: 'o personal-onto-template-library-btn'");
  });

  it('uses shared destructive icon semantics for removal actions', () => {
    expect(source).toContain("variant: 'danger', className: 'personal-onto-library-uninstall'");
    expect(source).toContain("variant: 'danger', className: 'personal-onto-template-uninstall'");
  });

  it('keeps ontology navigation and category chips readable on hover, press, and selection', () => {
    expect(cognitionAssetsCss).toContain('.personal-onto-hub-nav-item:hover');
    expect(cognitionAssetsCss).toContain('.personal-onto-hub-nav-item:active');
    expect(cognitionAssetsCss).toContain('.personal-onto-filter-chip:hover');
    expect(cognitionAssetsCss).toContain('background: var(--color-brand-soft); color: var(--color-ink);');
    // v2 专属控件样式存在（下拉/菜单/值行）。
    expect(cognitionAssetsCss).toContain('.po2-select');
    expect(cognitionAssetsCss).toContain('.po2-menu-list');
    expect(cognitionAssetsCss).toContain('.po2-value-row');
  });
});
