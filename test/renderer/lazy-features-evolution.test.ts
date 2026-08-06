import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('retired evolution console lazy feature', () => {
  it('does not register or render a standalone evolution console frontend', () => {
    const lazy = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/lazy-features.js'), 'utf-8');
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
    expect(lazy).not.toContain('evolution/pages.js');
    expect(lazy).not.toContain('evolution/console.js');
    expect(html).not.toContain('id="panel-evolution"');
    expect(html).not.toContain('id="evolution-btn"');
  });
});
