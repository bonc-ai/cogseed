import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('composer popover coordination', () => {
  it('closes every registered chooser except the one being opened', () => {
    const { createComposerPopoverCoordinator } = require('../../src/renderer/modules/composer-popovers.js');
    const coordinator = createComposerPopoverCoordinator();
    const closed: string[] = [];
    coordinator.register('agent', () => closed.push('agent'));
    coordinator.register('workspace', () => closed.push('workspace'));
    coordinator.register('permission', () => closed.push('permission'));

    coordinator.closeAll('workspace');

    expect(closed).toEqual(['agent', 'permission']);
  });

  it('coordinates every chooser opener without owning its business action', () => {
    const agents = read('src/renderer/modules/agents.js');
    const workspace = read('src/renderer/modules/user-workspace.js');
    const conversation = read('src/renderer/modules/conversation.js');
    const model = read('src/renderer/modules/model-chip.js');

    expect(agents).toMatch(/async function _openAgentPicker[\s\S]*?closeComposerPopovers\('agent'\)/);
    expect(workspace).toMatch(/function _showWorkspaceDropdown[\s\S]*?closeComposerPopovers\('workspace'\)/);
    expect(workspace).toContain('if (openSeq !== _workspaceMenuOpenSeq) return;');
    expect(conversation).toContain("closeComposerPopovers('permission')");
    expect(model).toMatch(/function _toggleExecConfigMenu[\s\S]*?closeComposerPopovers\('model'\)/);
  });

  it('uses the shared AiSelect popover for conversation permissions', () => {
    const html = read('src/renderer/index.html');
    const conversation = read('src/renderer/modules/conversation.js');
    const css = read('src/renderer/ui-components.css');

    expect(html).toContain('<div class="chat-permission-select" id="chat-permission-mode-select"></div>');
    expect(html).not.toContain('<select class="chat-permission-select"');
    expect(conversation).toContain("window._aiSelectMount(host, {");
    expect(conversation).toContain("popover?.classList.add('composer-popover', 'chat-permission-popover')");
    expect(css).toMatch(/\.composer-popover\s*\{[\s\S]*?border:\s*1px solid var\(--line-field\);[\s\S]*?box-shadow:\s*var\(--shadow-card\);/);
  });

  it('anchors workspace menus through the shared fixed-position helper and restores focus on Escape', () => {
    const agents = read('src/renderer/modules/agents.js');
    const workspace = read('src/renderer/modules/user-workspace.js');

    expect(agents).toMatch(/function _positionPopoverAboveOrBelow[\s\S]*?popover\.style\.position = 'fixed';/);
    expect(workspace).toContain("window.positionPickerPopover(menu, anchor, { anchorToButton: true, display: 'block' });");
    expect(workspace).toMatch(/function _onKey[\s\S]*?e\.key === 'Escape'[\s\S]*?_closeMenu\(true\)/);
    expect(agents).toContain("_closeAgentPicker({ returnFocus: true })");
  });
});
