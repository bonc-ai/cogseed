import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('topbar evolution toggle removal', () => {
  it('index.html no longer contains the evolution console topbar shortcut', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
    expect(html).not.toContain('id="topbar-evolution-toggle"');
  });
  it('state.js no longer binds the topbar shortcut to setView(evolution)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf-8');
    expect(src).not.toContain("getElementById('topbar-evolution-toggle')");
    expect(src).not.toContain("_setViewFromSidebar('evolution')");
  });
});
