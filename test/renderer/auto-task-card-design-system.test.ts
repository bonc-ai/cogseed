import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const autoSource = fs.readFileSync(path.join(root, 'src/renderer/modules/auto.js'), 'utf8');
const rendererCss = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

describe('automation task-card design-system integration', () => {
  it('uses shared icon controls and Lucide metadata icons', () => {
    expect(autoSource).toContain("icon: 'chevron-down'");
    expect(autoSource).toContain("className: 'auto-row-expand'");
    expect(autoSource).toContain("icon: 'more-horizontal'");
    expect(autoSource).toContain("className: 'auto-row-more'");
    expect(autoSource).toContain("window.uiIconHtml('paperclip', 'ui-icon')");
    expect(autoSource).not.toContain('📎');
    expect(rendererCss).toContain('.auto-row-more.ui-icon-button');
    expect(rendererCss).toContain('.auto-row-expand.ui-icon-button');
  });

  it('routes dropdown actions through shared buttons without changing action ids', () => {
    expect(autoSource.match(/className: 'auto-row-menu-item'/g)).toHaveLength(3);
    for (const action of ['toggle-enabled', 'edit', 'delete']) {
      expect(autoSource).toContain(`'data-action': '${action}'`);
    }
    expect(autoSource).toContain("label: t('auto.delete_btn'), role: 'danger'");
    expect(rendererCss).toMatch(/\.auto-row-menu-item\.ui-button\s*\{[^}]*width:\s*100%;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*justify-content:\s*flex-start;/s);
  });

  it('shows explicit task status and keeps shared primitives in charge of card controls', () => {
    expect(autoSource).toContain('class="auto-row-status${task.enabled ? \' is-enabled\' : \' is-disabled\'}"');
    expect(autoSource).toContain("t(task.enabled ? 'common.enabled' : 'common.disabled')");
    expect(rendererCss).toContain('.auto-row-status-dot');
    expect(rendererCss).toContain('background: var(--color-success);');
    expect(rendererCss).toContain('.auto-row.is-disabled { background: var(--surface-subtle); }');
    expect(rendererCss).not.toContain('.auto-row.is-disabled { opacity: 0.55; }');
    expect(rendererCss).not.toContain('.auto-row-expand.ui-icon-button:hover');
    expect(rendererCss).not.toContain('.auto-row-more.ui-icon-button:hover');
  });

  it('uses shared buttons and the icon registry in the time-adjust confirmation card', () => {
    expect(autoSource).toContain("window.uiIconHtml('clock', 'auto-time-adjust-icon')");
    expect(autoSource).toContain("attrs: { 'data-act': 'dismiss' }");
    expect(autoSource).toContain("attrs: { 'data-act': 'confirm' }");
    expect(autoSource).not.toContain('<svg class="auto-time-adjust-icon"');
    expect(autoSource).not.toContain('<button class="btn" data-act="dismiss">');
    expect(autoSource).not.toContain('<button class="btn btn-primary" data-act="confirm">');
  });

  it('uses the shared Button for paginated task history', () => {
    expect(autoSource).toContain("className: 'conversation-list-load-more'");
    expect(autoSource).toContain("attrs: { 'data-auto-task-convs-more': '1' }");
    expect(autoSource).not.toContain('<button type="button" class="conversation-list-load-more" data-auto-task-convs-more="1"');
  });
});
