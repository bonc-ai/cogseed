import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('evolution lazy feature removal', () => {
  it('lazy-features.js no longer registers evolution scripts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/lazy-features.js'), 'utf-8');
    expect(src).not.toContain('evolution/pages.js');
    expect(src).not.toContain('evolution/console.js');
  });
  it('index.html no longer contains the standalone evolution console shell', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
    expect(html).not.toContain('id="panel-evolution"');
    expect(html).not.toContain('id="evolution-btn"');
    expect(html).not.toContain('id="evo-console-nav"');
    expect(html).not.toContain('id="evo-console-body"');
  });
});
