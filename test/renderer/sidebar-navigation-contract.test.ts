import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8')) as Record<string, string>;
const en = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/en.json'), 'utf8')) as Record<string, string>;

 describe('sidebar navigation contract', () => {
  it('keeps internal navigation ids while exposing the requested product labels', () => {
    expect(html).toContain('id="new-chat-btn"');
    expect(html).toContain('data-i18n="sidebar.new_chat"');
    expect(html).toContain('id="recall-btn"');
    expect(html).toContain('data-i18n="sidebar.recall"');
    expect(html).not.toContain('id="contexts-btn"');
    expect(html).not.toContain('id="evolution-btn"');
    expect(html).not.toContain('id="topbar-evolution-toggle"');
    expect(html).not.toContain('id="panel-evolution"');
  });

  it('uses New session and Cognitive assets as the visible navigation labels', () => {
    expect(zh['sidebar.new_chat']).toBe('新建会话');
    expect(zh['sidebar.recall']).toBe('认知资产');
    expect(en['sidebar.new_chat']).toBe('New session');
    expect(en['sidebar.recall']).toBe('Cognitive assets');
  });
});
