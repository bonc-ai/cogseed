import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(__dirname, '../../src/renderer');
const source = readFileSync(resolve(rendererRoot, 'modules/personal-ontology.js'), 'utf8');

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

  it('keeps only tabs and navigation selection rows as native composite controls', () => {
    // 2026-09-20 本体分组迁入：分组行加入导航选中行家族（与模板行/画像行
    // 同类），基线 5 → 6。其余控件全部走共享原语（_button/_iconButton/_input）。
    expect((source.match(/<(?:button|input|textarea|select)\b/gi) || [])).toHaveLength(6);
    expect(source).toContain('class="memory-group-editor-tab');
    expect(source).toContain('class="personal-onto-library-row');
    expect(source).toContain('class="personal-onto-nav-row is-file');
    expect(source).toContain('class="personal-onto-nav-row${profileSelected');
    expect(source).toContain('class="personal-onto-template-library-btn');
  });

  it('uses shared destructive icon semantics for removal actions', () => {
    expect(source).toContain("variant: 'danger', className: 'memory-icon-btn is-muted'");
    expect(source).toContain("variant: 'danger', className: 'personal-onto-library-uninstall'");
    expect(source).toContain("variant: 'danger', className: 'personal-onto-template-uninstall'");
  });
});
