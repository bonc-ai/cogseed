import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const indexHtml = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
const lazyFeatures = readFileSync(resolve(root, 'src/renderer/modules/lazy-features.js'), 'utf8');

describe('settings model authorization add account entrypoint', () => {
  it('routes users through the unified add authorization button instead of the legacy provider/model picker', () => {
    expect(indexHtml).toContain('id="settings-model-authorization-add-btn"');
    expect(indexHtml).toContain('id="model-authorization-modal"');
    expect(indexHtml).not.toContain('id="settings-picker-provider"');
    expect(indexHtml).not.toContain('id="settings-picker-model"');
    expect(indexHtml).not.toContain('id="settings-add-entry-btn"');
  });

  it('loads pure authorization flow before settings so the Settings controller can bind the unified modal', () => {
    const flowIndex = lazyFeatures.indexOf("./modules/model-authorization.js");
    const settingsIndex = lazyFeatures.indexOf("./modules/settings.js");
    expect(flowIndex).toBeGreaterThan(-1);
    expect(settingsIndex).toBeGreaterThan(flowIndex);
  });
});
