import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
const htmlSource = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');

describe('Settings -> Semantica', () => {
  it('provides a visible host in the configuration pane', () => {
    expect(htmlSource).toContain('id="settings-semantica-host"');
  });

  it('uses shared controls and the dedicated IPC contract', () => {
    expect(settingsSource).toContain("uiSwitch({ id: 'settings-semantica-enabled'");
    expect(settingsSource).toContain("window.cogseed.invoke('semantica.settings.save'");
    expect(settingsSource).toContain("_settingsSemanticaPayload(host)");
    expect(settingsSource).toContain("'semantica.demo.seed'");
    expect(settingsSource).toContain("'semantica.demo.clear'");
    expect(settingsSource).toContain("id: 'settings-semantica-demo-seed'");
    expect(settingsSource).toContain("id: 'settings-semantica-demo-clear'");
  });

  it('keeps Semantica local-only and disables demo writes while it is off', () => {
    expect(settingsSource).toContain('const semanticaAvailable = !!s.semanticaEnabled');
    expect(settingsSource).toContain("disabled: !semanticaAvailable || !!demo.ready");
    expect(settingsSource).not.toContain("id: 'settings-jev-enabled'");
    expect(settingsSource).not.toContain("id: 'settings-jev-api-key'");
    expect(settingsSource).not.toContain("'semantica.settings.test'");
  });
});
