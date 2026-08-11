import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const bootSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf-8');
const stateSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf-8');

describe('boot.js + state.js evolution removal', () => {
  it('setView maps legacy evolution to skills and has no panel-evolution branch', () => {
    expect(bootSrc).toContain("if (view === 'evolution') view = 'skills'");
    expect(bootSrc).not.toContain("view === 'evolution' ? 'panel-evolution'");
  });
  it('evolution-btn active toggle is removed from boot.js', () => {
    expect(bootSrc).not.toContain("getElementById('evolution-btn')");
  });
  it('evolution view no longer lazy-loads renderEvolutionConsole', () => {
    expect(bootSrc).not.toContain("_loadViewFeature('evolution', 'evolution'");
    expect(bootSrc).not.toContain('renderEvolutionConsole');
  });
  it('sidebar evolution-btn binding is removed from state.js', () => {
    expect(stateSrc).not.toContain("getElementById('evolution-btn')");
    expect(stateSrc).not.toContain("_setViewFromSidebar('evolution')");
  });
});
