import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const bootSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf-8');
const stateSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf-8');

describe('boot.js + state.js evolution wiring', () => {
  it('setView 有 evolution → panel-evolution 分支（两处 panelId 映射）', () => {
    const matches = bootSrc.match(/view === 'evolution'\s*\?\s*'panel-evolution'/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
  it('evolution-btn active toggle 存在于 boot.js', () => {
    expect(bootSrc).toContain("getElementById('evolution-btn')");
  });
  it('evolution 视图触发 lazy 加载并调用 renderEvolutionConsole', () => {
    expect(bootSrc).toContain("_loadViewFeature('evolution', 'evolution'");
    expect(bootSrc).toContain('renderEvolutionConsole');
  });
  it('侧栏 evolution-btn 在 state.js 绑定到 setView', () => {
    expect(stateSrc).toContain("getElementById('evolution-btn')");
    expect(stateSrc).toContain("_setViewFromSidebar('evolution')");
  });
});
