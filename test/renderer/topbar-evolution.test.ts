import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('topbar evolution toggle', () => {
  it('index.html 聊天顶栏含进化控制台切换入口', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
    expect(html).toContain('id="topbar-evolution-toggle"');
  });
  it('state.js 顶栏切换绑定到 setView(evolution)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf-8');
    expect(src).toContain("getElementById('topbar-evolution-toggle')");
  });
});
