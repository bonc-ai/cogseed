import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const pluginsCss = fs.readFileSync(path.join(root, 'src/renderer/plugins.css'), 'utf8');
const pluginsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/plugins.js'), 'utf8');

describe('plugins design-system integration', () => {
  it('uses the shared resource-card grid and card shell', () => {
    expect(pluginsCss).toMatch(/\.plugins-grid\s*{[^}]*repeat\(auto-fit, minmax\(min\(100%, 300px\), 1fr\)\)[^}]*gap:\s*var\(--space-4\)/s);
    expect(pluginsCss).toMatch(/\.plugins-card\s*{[^}]*max-width:\s*400px[^}]*border-radius:\s*var\(--radius-card\)[^}]*box-shadow:\s*var\(--shadow-card\)/s);
    expect(pluginsCss).toMatch(/\.plugins-card:focus-visible\s*{[^}]*var\(--color-focus-halo\)/s);
  });

  it('maps plugin state and metadata to the shared tag geometry', () => {
    expect(pluginsCss).toMatch(/\.plugins-badge,\s*\.plugins-license\s*{[^}]*height:\s*22px[^}]*border-radius:\s*var\(--radius-xs\)/s);
    expect(pluginsCss).toMatch(/\.plugins-card-meta-item\s*{[^}]*height:\s*20px[^}]*border-radius:\s*var\(--radius-xs\)/s);
    expect(pluginsCss).toMatch(/\.plugins-version-dot\s*{[^}]*background:\s*var\(--color-danger-soft\)[^}]*color:\s*var\(--color-danger\)/s);
    expect(pluginsSource).toContain('class="plugins-badge is-on"');
    expect(pluginsSource).toContain('class="plugins-license is-unconfigured"');
  });
});
