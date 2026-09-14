import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('connectors card surface', () => {
  it('keeps the shared CardGrid sizing and compact menu styling', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/\.connectors-grid\s*{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*300px\),\s*1fr\)\);[\s\S]*?max-width:\s*var\(--layout-card-grid-width\);/);
    expect(css).toMatch(/\.connectors-grid > \.connector-card\s*{[\s\S]*?max-width:\s*400px;/);
    expect(css).not.toContain('--connector-card-min: 280px;');
    expect(css).toMatch(/\.connector-card\s*{[\s\S]*?padding:\s*var\(--space-4\);[\s\S]*?border-radius:\s*var\(--radius-card\);[\s\S]*?box-shadow:\s*var\(--shadow-card\);/);
    expect(css).toMatch(/\.connector-card-name\s*{[\s\S]*?-webkit-line-clamp:\s*2;/);
    expect(css).toMatch(/\.connector-card-menu-btn\.ui-icon-button\s*{[\s\S]*?width:\s*22px;[\s\S]*?height:\s*22px;[\s\S]*?visibility:\s*hidden;/);
    expect(css).toContain('.connector-card:hover .connector-card-menu-btn');
    expect(css).toMatch(/\.connector-card-foot\s*{[\s\S]*?border-top:\s*1px solid var\(--line-hairline\);[\s\S]*?gap:\s*8px;[\s\S]*?min-width:\s*0;/);
    expect(css).toMatch(/\.connector-card-foot \.btn\s*{[\s\S]*?flex:\s*0 0 auto;/);
  });

  it('renders connected cards with Use and keeps enable/disable in the card menu', () => {
    const js = read('src/renderer/modules/connectors.js');

    expect(js).toContain("'data-act': 'use-connector'");
    expect(js).toContain('connector-card-use');
    expect(js).toContain("icon: 'more-horizontal'");
    expect(js).toContain("icon: 'refresh'");
    expect(js).toContain("role: 'danger'");
    expect(js).toContain("className: 'connector-card-menu-item'");
    expect(js).toContain("setChatConnector('new-chat'");
    expect(js).toContain("'data-act': 'toggle-enabled'");
    expect(js).toContain('_clearConnectorCardMenuState');
    expect(js).not.toContain('authorize-sheets');
    expect(js).not.toContain('connectors.google_sheets_authorize_files');
    const cardRenderer = js.slice(js.indexOf('function _renderCatalogCard('), js.indexOf('function _clearConnectorCardMenuState('));
    expect(cardRenderer).not.toMatch(/<button\b/);
  });

  it('continues filtering PC credit-gated connector UI', () => {
    const js = read('src/renderer/modules/connectors.js');
    const css = read('src/renderer/style.css');
    const locales = ['en', 'zh', 'ja', 'pt'].map((lang) => read(`src/renderer/locales/${lang}.json`)).join('\n');
    const meteringKey = ['usage', '_metering'].join('');
    const pricingKey = ['credits', '_milli_per_call'].join('');
    const copyKey = ['connectors.badge.', 'credits', '_required'].join('');

    expect(js).not.toContain(meteringKey);
    expect(js).not.toContain(pricingKey);
    expect(js).not.toContain('_connectorCreditBadge');
    expect(css).not.toContain('connector-card-credit-badge');
    expect(locales).not.toContain(copyKey);
  });

  it('uses shared form primitives for the custom MCP dialog without changing its IPC route', () => {
    const js = read('src/renderer/modules/connectors.js');
    const css = read('src/renderer/style.css');
    const dialogRenderer = js.slice(
      js.indexOf('function _openAddCustomDialog()'),
      js.indexOf('function _formatConnectError('),
    );

    expect(dialogRenderer.match(/uiField\(\{/g)).toHaveLength(7);
    expect(dialogRenderer).toContain('const formHtml = uiForm({');
    expect(dialogRenderer).toContain("hydrateUiFormSelects(overlay, { 'connector-custom-kind': syncKindSections })");
    expect(dialogRenderer).toContain('kindSelect.getValue()');
    expect(dialogRenderer).toContain("window.cogseed.invoke('connectors.add_custom'");
    expect(dialogRenderer).not.toMatch(/<(?:input|select|textarea)\b/);
    expect(css).toMatch(/\.connector-custom-section\[hidden\]\s*{\s*display:\s*none;/);
  });
});
