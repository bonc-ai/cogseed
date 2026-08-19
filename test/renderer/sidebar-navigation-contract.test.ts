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
    expect(html).not.toContain('id="new-task-btn"');
    expect(html).toContain('id="recall-btn"');
    expect(html).toContain('data-i18n="sidebar.recall"');
    expect(html).toContain('id="connectors-btn"');
    expect(html).toContain('data-i18n="sidebar.connections"');
    expect(html).not.toContain('id="agents-btn"');
    expect(html).not.toContain('id="skills-btn"');
    expect(html).not.toContain('id="personal-ontology-btn"');
    expect(html).not.toContain('id="contexts-btn"');
    expect(html).not.toContain('id="evolution-btn"');
    expect(html).not.toContain('id="topbar-evolution-toggle"');
    expect(html).not.toContain('id="panel-evolution"');
  });

  it('uses the consolidated 6-entry navigation labels', () => {
    expect(zh['sidebar.new_chat']).toBe('新建任务');
    expect(zh['sidebar.recall']).toBe('认知资产');
    expect(zh['sidebar.connections']).toBe('连接');
    expect(en['sidebar.new_chat']).toBe('New task');
    expect(en['sidebar.recall']).toBe('Cognition Assets');
    expect(en['sidebar.connections']).toBe('Connections');
  });
});
