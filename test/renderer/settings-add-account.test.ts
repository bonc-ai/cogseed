import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const indexHtml = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
const lazyFeatures = readFileSync(resolve(root, 'src/renderer/modules/lazy-features.js'), 'utf8');

describe('settings model authorization add account entrypoint', () => {
  it('renders the direct provider/model picker and priority list from the approved reference', () => {
    expect(indexHtml).toContain('data-i18n="settings.add_auth_title"');
    expect(indexHtml).toContain('id="settings-picker-provider"');
    expect(indexHtml).toContain('id="settings-picker-model"');
    expect(indexHtml).toContain('id="settings-add-entry-btn"');
    expect(indexHtml).toContain('data-i18n="settings.configured_title"');
    expect(indexHtml).toContain('id="settings-entries"');
  });

  it('loads settings after the authorization helpers used by credential flows', () => {
    const flowIndex = lazyFeatures.indexOf("./modules/model-authorization.js");
    const settingsIndex = lazyFeatures.indexOf("./modules/settings.js");
    expect(flowIndex).toBeGreaterThan(-1);
    expect(settingsIndex).toBeGreaterThan(flowIndex);
  });

});
