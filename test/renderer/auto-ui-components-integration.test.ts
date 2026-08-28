import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('automation page shared-component integration', () => {
  const html = read('src/renderer/index.html');
  const auto = read('src/renderer/modules/auto.js');
  const modal = read('src/renderer/modules/ui-modal.js');
  const css = read('src/renderer/ui-components.css');
  const zh = JSON.parse(read('src/renderer/locales/zh.json'));
  const en = JSON.parse(read('src/renderer/locales/en.json'));

  it('renders the real page header through the shared single-row contract', () => {
    const renderPageHeader = auto.slice(
      auto.indexOf('function _autoRenderPageHeader'),
      auto.indexOf('function _autoRenderPageState'),
    );
    expect(html).toContain('id="auto-page-header"');
    expect(html).not.toContain('class="auto-title-text"');
    expect(renderPageHeader).toContain('uiPageHeader({');
    expect(renderPageHeader).toContain("'data-auto-page-action': 'create'");
    expect(renderPageHeader).toContain("title: t('auto.title')");
    expect(renderPageHeader).not.toContain('role:');
    expect(renderPageHeader).not.toContain('size:');
  });

  it('keeps loading, failure, empty, and list as explicit page states', () => {
    expect(html).toContain('id="auto-page-state"');
    expect(auto).toContain("_autoRenderPageState('loading')");
    expect(auto).toContain("_autoRenderPageState('error')");
    expect(auto).toContain("_autoRenderPageState('empty')");
    expect(auto).toContain("_autoRenderPageState('list')");
    expect(auto).toContain('uiEmptyState({');
    expect(auto).toContain("'data-auto-page-action': 'retry'");
  });

  it('hydrates the existing business form with the shared modal runtime', () => {
    expect(html).toContain('ui-modal ui-modal--lg auto-task-dialog');
    expect(html).toContain('id="auto-dialog-close-slot"');
    expect(html).toContain('id="auto-dialog-error"');
    expect(auto).toContain('uiModalController({');
    expect(auto).toContain("initialFocus: '#auto-task-input'");
    expect(auto).toContain('_autoSetSubmitBusy(true)');
    expect(auto).toContain('_autoSetFormError(');
    expect(html).toContain('id="auto-hour-label"');
    expect(html).toContain('id="auto-minute-label"');
    expect(auto).toContain("`${api.el.id}-selected-value`");
    expect(modal).toContain('function uiModalController(options)');
    expect(modal).toContain('closeTopPopover()');
    expect(modal).toContain('previousFocus.focus()');
  });

  it('uses shared visual tokens and localized state copy', () => {
    expect(css).toContain('.auto-page-state--loading');
    expect(css).toContain('.auto-dialog-error');
    for (const locale of [zh, en]) {
      for (const key of [
        'auto.loading',
        'auto.load_failed_title',
        'auto.load_failed_hint',
        'auto.creating',
        'auto.saving',
      ]) {
        expect(locale[key], key).toBeTruthy();
      }
    }
  });
});
