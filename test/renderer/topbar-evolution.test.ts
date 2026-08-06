import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('retired topbar evolution toggle', () => {
  it('does not expose a topbar shortcut to a standalone evolution console', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
    const state = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf-8');
    expect(html).not.toContain('id="topbar-evolution-toggle"');
    expect(state).not.toContain('topbar-evolution-toggle');
  });
});
