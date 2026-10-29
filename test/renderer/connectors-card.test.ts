import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('connectors card surface', () => {
  it('uses the Raymond card grid sizing and compact menu styling', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/\.connectors-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 300px\), 1fr\)\);[^}]*gap:\s*var\(--space-4\);/s);
    expect(css).toMatch(/\.connector-card\s*\{[^}]*max-width:\s*var\(--card-width-max\);[^}]*padding:\s*var\(--space-4\);[^}]*border-radius:\s*var\(--radius-card\);/s);
    expect(css).toMatch(/\.connector-card-menu-btn\s*\{[^}]*width:\s*var\(--control-height-sm\);[^}]*height:\s*var\(--control-height-sm\);[^}]*visibility:\s*hidden;/s);
    expect(css).toContain('.connector-card:hover .connector-card-menu-btn');
    expect(css).toMatch(/\.connector-card-foot\s*\{[^}]*gap:\s*var\(--space-2\);[^}]*min-width:\s*0;/s);
    expect(css).toMatch(/\.connector-card-foot \.btn\s*\{[^}]*flex:\s*0 0 auto;/s);
  });

  it('renders connected cards with Use and keeps enable/disable in the card menu', () => {
    const js = read('src/renderer/modules/connectors.js');

    // 动作钩子由 _connectorUiButton() 的 attrs 对象生成，不是 HTML 属性字符串：
    // 源码（与上游逐字节一致）里是 `'data-act': 'use-connector'`。原断言写成
    // `data-act="use-connector"` 是重构前的字面量形态残留，企业版与上游都不存在。
    expect(js).toContain("'data-act': 'use-connector'");
    expect(js).toContain('connector-card-use');
    expect(js).toContain("setChatConnector('new-chat'");
    expect(js).toContain("'data-act': 'toggle-enabled'");
    expect(js).toContain('_clearConnectorCardMenuState');
    expect(js).not.toContain('authorize-sheets');
    expect(js).not.toContain('connectors.google_sheets_authorize_files');
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
});
