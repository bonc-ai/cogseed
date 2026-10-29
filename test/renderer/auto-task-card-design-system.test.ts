import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const autoSource = fs.readFileSync(path.join(root, 'src/renderer/modules/auto.js'), 'utf8');
const rendererCss = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

describe('automation task-card design-system integration', () => {
  it('uses the shared two-line resource card and anchored dropdown', () => {
    expect(autoSource).toContain("layout: 'compact-row'");
    expect(autoSource).toContain('uiResourceCard({');
    expect(autoSource).toContain('uiDropdownMenu({');
    expect(autoSource).not.toContain('function _ensureAutoMenu');
    expect(autoSource).not.toContain('toggleExpand');
    expect(rendererCss).not.toContain('.auto-row-menu');
    expect(rendererCss).not.toContain('.auto-row-head');
  });

  it('keeps all task operations in the dropdown and separates delete', () => {
    const menu = autoSource.slice(autoSource.indexOf('function _autoTaskMenuItems'), autoSource.indexOf('// ─── Empty-state templates'));
    for (const action of ['toggle-enabled', 'edit', 'delete']) expect(menu).toContain(`'data-action': '${action}'`);
    expect(menu).toContain("'data-act': 'run-now'");
    expect(menu).toContain('danger: true, separatorBefore: true');
  });

  it('keeps exceptional states in the metadata line', () => {
    expect(autoSource).toContain("parts.push(t('auto.paused'))");
    expect(autoSource).toContain("parts.push(t('auto.start_failed'))");
    expect(autoSource).toContain("parts.push(t('auto.remote_device'");
    expect(autoSource).toContain("parts.join(' · ')");
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
