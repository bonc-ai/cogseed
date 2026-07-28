import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('evolution lazy feature registration', () => {
  it('lazy-features.js 注册了 evolution 的 pages+console 脚本', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/lazy-features.js'), 'utf-8');
    expect(src).toContain('evolution/pages.js');
    expect(src).toContain('evolution/console.js');
  });
  it('index.html 含 panel-evolution 与 evolution-btn 与控制台容器', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
    expect(html).toContain('id="panel-evolution"');
    expect(html).toContain('id="evolution-btn"');
    expect(html).toContain('id="evo-console-nav"');
    expect(html).toContain('id="evo-console-body"');
  });
});
