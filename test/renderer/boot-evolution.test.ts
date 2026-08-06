import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const bootSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf-8');
const stateSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf-8');

describe('retired evolution console routing', () => {
  it('does not map or lazy-load a standalone evolution panel', () => {
    expect(bootSrc).not.toContain('panel-evolution');
    expect(bootSrc).not.toContain("_loadViewFeature('evolution'");
    expect(bootSrc).not.toContain("getElementById('evolution-btn')");
  });

  it('does not bind sidebar evolution navigation', () => {
    expect(stateSrc).not.toContain("getElementById('evolution-btn')");
    expect(stateSrc).not.toContain("_setViewFromSidebar('evolution')");
  });
});
