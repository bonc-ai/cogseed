import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('connectors shared UI adoption', () => {
  it('integrates the shared resource toolbar into the production MCP page', () => {
    const html = read('src/renderer/index.html');
    const source = read('src/renderer/modules/connectors.js');
    const css = read('src/renderer/style.css');

    expect(html).toContain('class="connectors-page-header-title ui-visually-hidden"');
    expect(html).toContain('id="connectors-search-field"');
    expect(html).toContain('id="connectors-page-header-actions"');
    expect(source).toContain("id: 'connectors-search-input'");
    expect(source).toContain("placeholder: t('connectors.search_placeholder')");
    expect(source).toContain("attrs: { id: 'connectors-add-custom-btn' }");
    expect(source).toContain("title: t('connectors.no_match')");
    expect(css).toMatch(/\.connectors-page-header\s*{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/);
    expect(css).toMatch(/\.connectors-group-label-row\s*{[^}]*border-bottom:\s*1px solid var\(--line-hairline\);/);
  });

  it('filters real connector names and descriptions without changing connection actions', () => {
    const source = read('src/renderer/modules/connectors.js');

    expect(source).toContain("throw new Error('connectors require uiInput')");
    expect(source).toContain("throw new Error('connectors require uiEmptyState')");
    expect(source).toContain('pickDesc(entry, lang)');
    expect(source).toContain('visibleConnectedItems');
    expect(source).toContain('visibleAvailableItems');
    expect(source).toContain("window.cogseed.invoke('connectors.start_oauth'");
    expect(source).toContain("window.cogseed.invoke('connectors.add_custom'");
  });

  it('uses a shared actionable empty state and restores the full list', () => {
    const source = read('src/renderer/modules/connectors.js');

    expect(source).toContain("kind: 'actionable'");
    expect(source).toContain("attrs: { 'data-connectors-clear-search': true }");
    expect(source).toContain("empty.querySelector('[data-connectors-clear-search]')");
    expect(source).toContain("_connectorsSearchQuery = '';");
  });

  it('uses the shared modal shell for the custom connector form', () => {
    const source = read('src/renderer/modules/connectors.js');

    expect(source).toContain("overlay.className = 'ui-modal-overlay'");
    expect(source).toContain('class="ui-modal connector-custom-dialog"');
    expect(source).toContain('class="ui-modal__header"');
    expect(source).toContain('class="ui-modal__body"');
    expect(source).not.toContain("overlay.className = 'modal-overlay ui-dialog-overlay'");
  });
});
