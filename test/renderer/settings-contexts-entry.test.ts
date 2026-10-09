import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
const stateSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf-8');
const settingsSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/settings.js'), 'utf-8');
const bootSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf-8');

describe('settings contexts entry', () => {
  it('removes the Library entry from the primary sidebar', () => {
    expect(html).not.toContain('id="contexts-btn"');
    expect(stateSrc).not.toContain("getElementById('contexts-btn')");
    expect(bootSrc).not.toContain("getElementById('contexts-btn')?.classList.toggle");
  });

  it('adds a Settings data-tab button that opens the Library view', () => {
    expect(html).toContain('id="settings-contexts-open-btn"');
    expect(html).toContain('data-i18n="settings.contexts.open"');
    expect(settingsSrc).toContain("getElementById('settings-contexts-open-btn')");
    expect(settingsSrc).toContain("setView('contexts')");
  });
});
