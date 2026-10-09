import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const style = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');
const tokens = fs.readFileSync(path.join(root, 'src/renderer/tokens.css'), 'utf8');
const galleryHtml = fs.readFileSync(path.join(root, 'src/renderer/component-gallery.html'), 'utf8');
const gallerySource = fs.readFileSync(path.join(root, 'src/renderer/component-gallery.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8')) as Record<string, string>;
const en = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/en.json'), 'utf8')) as Record<string, string>;

 describe('sidebar navigation contract', () => {
  it('keeps internal navigation ids while exposing the requested product labels', () => {
    expect(html).toContain('id="new-chat-btn"');
    expect(html).toContain('id="new-chat-btn"><span data-ui-icon="plus"');
    expect(html).toContain('data-i18n="sidebar.new_chat"');
    expect(html).not.toContain('id="new-task-btn"');
    expect(html).toContain('id="recall-btn"');
    expect(html).toContain('data-i18n="sidebar.recall"');
    expect(html).toContain('id="kb-btn"');
    expect(html).not.toContain('sidebar.kb_new');
    expect(html).not.toContain('kb-new-chip');
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
    expect(zh['sidebar.connections']).toBe('智能体 / 技能 / 连接');
    expect(en['sidebar.new_chat']).toBe('New task');
    expect(en['sidebar.recall']).toBe('Cognition Assets');
    expect(en['sidebar.connections']).toBe('Agents / Skills / Connections');
    expect(zh['sidebar.time_minutes']).toBe('{n}分');
    expect(zh['sidebar.time_hours']).toBe('{n}小时');
    expect(zh['sidebar.time_days']).toBe('{n}天');
  });

  it('uses one vertical conversation surface without spaces/recent mode tabs', () => {
    expect(html.match(/id="conversation-list"/g)).toHaveLength(1);
    expect(html).not.toContain('id="sidebar-conv-tabs"');
    expect(html).not.toContain('data-conv-tab=');
  });

  it('keeps sidebar navigation and task rows compact', () => {
    const actionsCss = style.slice(style.indexOf('.sidebar-actions {'), style.indexOf('/* Sidebar search trigger'));
    const conversationNavCss = style.slice(style.indexOf('.sidebar-conversation-nav {'), style.indexOf('.sidebar-conversation-nav::-webkit-scrollbar'));
    const taskCss = style.slice(style.indexOf('.conv-item {'), style.indexOf('.conv-item-row {'));

    expect(actionsCss).toContain('gap: 0;');
    expect(conversationNavCss).toContain('margin-top: var(--space-3);');
    expect(conversationNavCss).toContain('border-top: 0;');
    expect(style).toContain('min-height: var(--control-height);');
    expect(taskCss).toContain('min-height: 32px;');
    expect(taskCss).toContain('margin: 0;');
    expect(taskCss).toContain('padding: 6px var(--space-2);');
  });

  it('maps the sidebar palette and typography to the open-source design tokens', () => {
    expect(tokens).toContain('--color-sidebar-top: #F4F8F5;');
    expect(tokens).toContain('--color-sidebar-bottom: #EDF3EF;');
    expect(tokens).toContain('--color-accent-wash: rgba(14, 159, 110, 0.09);');
    expect(style).toMatch(/\.sidebar\s*\{[\s\S]*?background:\s*var\(--color-sidebar-top\);/);
    expect(style).toMatch(/\.logo-text\s*\{[\s\S]*?font-weight:\s*var\(--font-weight-semibold\);[\s\S]*?font-size:\s*var\(--font-size-title\);/);
    expect(style).toMatch(/\.sidebar-btn-icon\s*\{[\s\S]*?color:\s*currentColor;/);
    expect(style).toMatch(/\.sidebar-btn > span:not\(\[data-ui-icon\]\):not\(\.sidebar-btn-icon\):not\(\.sidebar-btn-running-chip\)\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
    expect(style).toMatch(/\.sidebar-btn\.active\s*\{[\s\S]*?background:\s*var\(--color-accent-wash\);[\s\S]*?font-weight:\s*var\(--font-weight-regular\);/);
    expect(style).toMatch(/\.conv-list-section-header\.conv-list-space-title\s*\{[\s\S]*?font-size:\s*var\(--font-size-caption\);[\s\S]*?font-weight:\s*var\(--font-weight-regular\);/);
    expect(style).toMatch(/\.hub-chip-name\s*\{[\s\S]*?font-weight:\s*var\(--font-weight-medium\);/);
  });

  it('renders sidebar appearance states in the production component gallery', () => {
    expect(galleryHtml).toContain('id="sidebar-appearance-specimens"');
    expect(gallerySource).toContain('function renderSidebarAppearance()');
    expect(gallerySource).toContain('class="sidebar-btn${active');
    expect(gallerySource).toContain('class="conv-item${active');
    expect(gallerySource).toContain('renderSidebarAppearance();');
  });
});
