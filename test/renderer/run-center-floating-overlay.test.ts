import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

// specs/008-shell-rail-layout: the quick popover was retired; Run Center lives
// in the rail and its resident status is a badge on that rail entry.
describe('Run Center resident rail badge', () => {
  it('mounts the status badge on the rail Run Center entry, not in the shell tools', () => {
    const rail = read('src/renderer/modules/ui-app-rail.js');
    const tools = read('src/renderer/modules/ui-sidebar-tools.js');
    expect(rail).toMatch(/module: 'run-center'[^}]*badgeId: 'run-center-global-badge'/);
    expect(tools).not.toContain('run-center-global');
    expect(read('src/renderer/index.html')).not.toContain('run-center-global-entry');
  });

  it('retires the quick popover markup, styles and routing hooks', () => {
    const css = read('src/renderer/style.css');
    const shellCss = read('src/renderer/shell-navigation.css');
    const globalRunCenter = read('src/renderer/modules/run-center-global.js');
    const boot = read('src/renderer/modules/boot.js');
    expect(css).not.toContain('.run-center-quick-panel');
    expect(css).not.toContain('.run-center-global-btn');
    expect(globalRunCenter).not.toContain('run-center-quick-panel');
    expect(globalRunCenter).not.toContain('closeRunCenterGlobal');
    expect(boot).not.toContain('closeRunCenterGlobal');
    expect(shellCss).toMatch(/\.app-rail-badge\[data-state="attention"\]\s*\{[^}]*background:\s*var\(--danger\)/);
  });
});
