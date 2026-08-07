import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function read(rel: string) {
  return fs.readFileSync(path.join(__dirname, '../../', rel), 'utf-8');
}

describe('evolution console frontend removal', () => {
  it('does not expose evolution as a sidebar/topbar/panel entry', () => {
    const html = read('src/renderer/index.html');
    expect(html).not.toContain('id="evolution-btn"');
    expect(html).not.toContain('id="topbar-evolution-toggle"');
    expect(html).not.toContain('id="panel-evolution"');
  });

  it('does not route or lazy-load the retired evolution console view', () => {
    const boot = read('src/renderer/modules/boot.js');
    const state = read('src/renderer/modules/state.js');
    const lazy = read('src/renderer/modules/lazy-features.js');
    expect(boot).not.toContain('panel-evolution');
    expect(boot).not.toContain("_loadViewFeature('evolution'");
    expect(boot).not.toContain("getElementById('evolution-btn')");
    expect(state).not.toContain("_setViewFromSidebar('evolution')");
    expect(lazy).not.toContain('modules/evolution/console.js');
    expect(lazy).not.toContain('modules/evolution/pages.js');
  });
});
