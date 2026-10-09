import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('agent detail shared UI adoption', () => {
  it('routes detail icons and item actions through shared renderer primitives', () => {
    const source = read('src/renderer/modules/agents.js');
    const icons = read('src/renderer/modules/icons.js');
    const iconHelper = source.match(/function _agentDetailListIconHtml[\s\S]*?\n}/)?.[0] || '';

    expect(iconHelper).toContain("uiIconHtml(iconName, 'ui-icon')");
    expect(iconHelper).not.toContain('<svg');
    expect(icons).toContain("bookmark: '<path");
    expect(source).toContain("className: 'agents-memory-add'");
    expect(source).toContain("className: 'agents-memory-chip-remove'");
    expect(source).toContain("icon: 'x'");
    expect(source).not.toContain("document.createElement('button')");
  });

  it('routes agent card and supporting actions through shared buttons', () => {
    const source = read('src/renderer/modules/agents.js');

    expect(source).toContain("icon: 'more-horizontal',\n      className: 'agent-card-more'");
    expect(source).toContain("role: 'primary',\n            size: 'sm',\n            className: 'agent-card-use'");
    expect(source).toContain("icon: 'folder-open',\n            disabled: !canEdit");
    expect(source).toContain("icon: 'undo',\n            disabled: !canEdit");
    expect(source).toContain("attrs: { id: 'agent-ext-peers-open-dashboard' }");
    expect(source).toContain("variant: 'danger',\n        className: 'chat-taskref-remove'");
    expect(source).not.toContain('>⋯</button>');
    expect(source).not.toContain('>×</button>');
  });

  it('uses shared form and empty-state seams in the real capability toolbar', () => {
    const source = read('src/renderer/modules/agents.js');
    const html = read('src/renderer/index.html');
    const css = read('src/renderer/style.css');

    expect(html).toContain('class="agents-resource-toolbar"');
    expect(html).toContain('id="agents-search-field"');
    expect(source).toContain("throw new Error('agents require uiInput')");
    expect(source).toContain("throw new Error('agents require uiEmptyState')");
    expect(source).toContain("id: 'agents-search-input'");
    expect(source).toContain("kind: 'actionable'");
    expect(css).toMatch(/\.agents-resource-toolbar\s*{[^}]*display:\s*flex;[^}]*margin-bottom:\s*var\(--space-4\);/);
    expect(css).toMatch(/\.agent-card\s*{[^}]*min-height:\s*176px;/);
  });

  it('composes the shared button sizing with agent detail layout', () => {
    const css = read('src/renderer/style.css');
    const tokens = read('src/renderer/tokens.css');

    expect(tokens).toContain('--layout-resource-detail-width: 880px;');
    expect(css).toContain('max-width: var(--layout-resource-detail-width);');
    expect(css).toMatch(/\.agents-detail-label\s*{[^}]*color:\s*var\(--text-heading\);[^}]*font-weight:\s*var\(--font-weight-medium\);/);
    expect(css).toMatch(/\.agents-detail-list-item\s*{[^}]*grid-template-columns:\s*18px minmax\(0, 1fr\) auto;/);
    expect(css).not.toMatch(/(?:^|\n)\.agents-detail-body \.agents-detail-list-item\s*\{/);
    expect(css).toContain('.spaces-view .agents-detail-body .agents-detail-list-item {');
    expect(css).toMatch(/\.agents-detail-workflow\s*{[^}]*border:\s*1px solid var\(--line-default\);[^}]*border-radius:\s*var\(--radius-card\);/);
    expect(css).toMatch(/\.agents-memory-add\.ui-button\s*{[^}]*min-height:\s*var\(--control-height-sm\);/);
    expect(css).toMatch(/\.agents-memory-chip-remove\.ui-icon-button\s*{[^}]*width:\s*var\(--control-height-sm\);[^}]*height:\s*var\(--control-height-sm\);/);
    expect(css).toContain('.agent-card-more.ui-icon-button {');
    expect(css).toContain('.agent-card-use.ui-button { flex-shrink: 0; }');
    expect(css).toContain('.chat-taskref-remove.ui-icon-button {');
  });
});
