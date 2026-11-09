import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { loadCognitionAssets } from './helpers/cognition-renderer';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');

describe('Ontology navigation copy', () => {
  it.each(['zh', 'en', 'ja', 'pt'] as const)('keeps localized ontology navigation in four parallel entries plus the disabled tree entry (%s)', (locale) => {
    const translations = JSON.parse(
      fs.readFileSync(path.join(rendererRoot, 'locales', `${locale}.json`), 'utf8'),
    ) as Record<string, string>;
    const page = loadCognitionAssets({}, { name: 'overview' }, {
      t: (key: string) => translations[key] || key,
    });
    const rendered = page.render();

    expect(rendered).toContain(translations['cognition.tab_ontology']);
    expect(rendered).not.toContain('ca-tabs-group');
    for (const id of ['ontology', 'overview', 'activity', 'settings']) expect(rendered).toContain(`data-id="${id}"`);
    // 2026-11 恢复禁用态「认知树」入口（PR #216）：它仍在导航里，但不可点。
    expect(rendered).toMatch(/data-id="tree"[^>]*aria-disabled="true"/);
    expect(rendered).toMatch(/class="ca-tab is-disabled"[^>]*data-id="tree"/);
    expect(rendered).not.toContain('class="trunk-name"');
  });

  it('uses the Ontology name in the embedded workspace header', () => {
    // 2026-10-07 旧停驻页退役：工作台标题不再来自 index.html 壳，改锚
    // cognition-ontology.js 的 pageHeader 取词点（zh 兜底=本体）。
    const source = fs.readFileSync(path.join(rendererRoot, 'modules', 'cognition-ontology.js'), 'utf8');
    expect(source).toContain("text('title', '本体')");
  });

  it('keeps the selected ontology subpage during data rerenders and resets only on a new entry', () => {
    const page = loadCognitionAssets({}, { name: 'ontology' });
    const mount = vi.fn(async () => {});
    page.ns.mountPersonalOntology = mount;

    page.render();
    expect(mount).toHaveBeenLastCalledWith({ resetToOverview: true });

    page.render();
    expect(mount).toHaveBeenLastCalledWith({ resetToOverview: false });

    page.store.route.name = 'overview';
    page.render();
    page.store.route.name = 'ontology';
    page.render();
    expect(mount).toHaveBeenLastCalledWith({ resetToOverview: true });
  });
});
