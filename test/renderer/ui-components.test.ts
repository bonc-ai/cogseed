import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function loadFactories() {
  const context: any = { window: {}, document: undefined };
  vm.createContext(context);
  for (const file of [
    'src/renderer/modules/icons.js',
    'src/renderer/modules/ui-button.js',
    'src/renderer/modules/ui-form.js',
    'src/renderer/modules/ui-empty.js',
    'src/renderer/modules/ui-page-header.js',
  ]) {
    vm.runInContext(read(file), context, { filename: file });
  }
  return context.window;
}

describe('first-version renderer components', () => {
  it('keeps Button roles and sizes enumerable while escaping product copy', () => {
    const { uiButton } = loadFactories();

    const primary = uiButton({ label: '<创建>', role: 'primary', size: 'sm', icon: 'plus' });
    expect(primary).toContain('ui-button--primary');
    expect(primary).toContain('ui-button--sm');
    expect(primary).toContain('&lt;创建&gt;');
    expect(primary).toContain('is-plus');

    const fallback = uiButton({ label: '保存', role: 'invented', size: 'xl' });
    expect(fallback).toContain('ui-button--secondary');
    expect(fallback).toContain('ui-button--md');
  });

  it('makes loading observable and prevents duplicate activation', () => {
    const { uiButton } = loadFactories();
    const html = uiButton({ label: '创建', role: 'primary', loading: true });

    expect(html).toContain('is-loading');
    expect(html).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
  });

  it('requires an accessible name for every IconButton', () => {
    const { uiIconButton } = loadFactories();

    expect(() => uiIconButton({ icon: 'x' })).toThrow(/accessible label/);
    expect(uiIconButton({ icon: 'x', label: '关闭弹窗' })).toContain('aria-label="关闭弹窗"');
  });

  it('enforces the three EmptyState contracts and one-action boundary', () => {
    const { uiEmptyState } = loadFactories();

    expect(uiEmptyState({ kind: 'quiet', title: '没有匹配的任务' })).toContain('ui-empty-state--quiet');
    expect(uiEmptyState({ kind: 'explained', title: '暂无记录', hint: '首次运行后显示。', icon: 'clock' }))
      .toContain('ui-empty-state--explained');
    const actionable = uiEmptyState({
      kind: 'actionable',
      title: '还没有自动化任务',
      hint: '创建后按计划运行。',
      icon: 'sparkles',
      action: { label: '新建自动化任务' },
    });
    expect(actionable).toContain('ui-empty-state--actionable');
    expect(actionable.match(/<button/g)).toHaveLength(1);
    expect(() => uiEmptyState({ kind: 'explained', title: '暂无记录', action: { label: '新增' } }))
      .toThrow(/only actionable/);
  });

  it('owns one PageHeader action appearance and caps actions at three', () => {
    const { uiPageHeader } = loadFactories();
    const html = uiPageHeader({
      title: '自动化',
      subtitle: '旧调用方传入的副标题不再渲染。',
      meta: '3 项任务',
      actions: [
        { label: '一', role: 'primary', size: 'md' },
        { label: '二', role: 'danger', size: 'md' },
        { label: '三', role: 'ghost', size: 'md' },
        { label: '四' },
      ],
    });

    expect(html).toContain('<h1 class="ui-page-header__title">自动化</h1>');
    expect(html).not.toContain('ui-page-header__subtitle');
    expect(html).not.toContain('旧调用方传入的副标题');
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html.match(/ui-button--secondary/g)).toHaveLength(3);
    expect(html.match(/ui-button--sm/g)).toHaveLength(3);
    expect(html).not.toContain('ui-button--primary');
    expect(html).not.toContain('ui-button--danger');
    expect(html).not.toContain('ui-button--ghost');
    expect(html).not.toContain('ui-button--md');
    expect(html).not.toContain('>四<');
  });

  it('renders Input, Textarea, and the unified AiSelect host from one field contract', () => {
    const { uiField, hydrateUiFormSelects } = loadFactories();

    const input = uiField({
      id: 'task-name',
      label: '任务名称',
      required: true,
      hint: '用于任务列表展示。',
      control: { kind: 'input', placeholder: '<输入名称>' },
    });
    expect(input).toContain('for="task-name"');
    expect(input).toContain('aria-describedby="task-name-hint"');
    expect(input).toContain('&lt;输入名称&gt;');
    expect(input).toContain('>必填<');

    const textarea = uiField({ id: 'task-content', label: '任务内容', control: { kind: 'textarea' } });
    expect(textarea).toContain('ui-textarea');

    const select = uiField({
      id: 'frequency',
      label: '频率',
      control: { kind: 'select', options: [{ value: 'daily', label: '每天' }] },
    });
    expect(select).toContain('data-ui-select');
    expect(select).toContain('data-ui-select-config');
    expect(select).toContain('frequency-label');
    expect(select).not.toContain('<select');
    expect(typeof hydrateUiFormSelects).toBe('function');
  });

  it('makes field errors and composed form structure observable', () => {
    const { uiField, uiForm } = loadFactories();
    const field = uiField({
      id: 'api-url',
      label: '服务地址',
      error: '请输入有效地址',
      control: { kind: 'input', type: 'url' },
    });
    const form = uiForm({
      columns: 2,
      fields: [{ html: field, wide: true }],
      actions: [{ label: '取消', role: 'secondary' }, { label: '保存', role: 'primary' }],
    });
    expect(field).toContain('aria-invalid="true"');
    expect(field).toContain('aria-describedby="api-url-error"');
    expect(form).toContain('ui-form--two-column');
    expect(form).toContain('ui-form__item--wide');
    expect(form.match(/<button/g)).toHaveLength(2);
  });
});

describe('component gallery integration contract', () => {
  const index = read('src/renderer/index.html');
  const gallery = read('src/renderer/component-gallery.html');
  const css = read('src/renderer/ui-components.css');
  const modal = read('src/renderer/modules/ui-modal.js');

  it('loads tokens before legacy styles and shared component CSS after them', () => {
    expect(index.indexOf('./tokens.css')).toBeLessThan(index.indexOf('./style.css'));
    expect(index.indexOf('./ui-components.css')).toBeGreaterThan(index.indexOf('./style.css'));
  });

  it('renders the gallery from the same production component files', () => {
    for (const asset of [
      './tokens.css',
      './ui-components.css',
      './modules/ui-button.js',
      './modules/ui-form.js',
      './modules/ui-empty.js',
      './modules/ui-page-header.js',
      './modules/ui-modal.js',
    ]) {
      expect(gallery).toContain(asset);
    }
  });

  it('lets PageHeader own every gallery action appearance', () => {
    const galleryScript = read('src/renderer/component-gallery.js');
    const pageHeaderCases = galleryScript.slice(
      galleryScript.indexOf('function renderPageHeaders'),
      galleryScript.indexOf('function buttonForState'),
    );
    const automationHeader = galleryScript.slice(
      galleryScript.indexOf("byId('automation-preview').innerHTML = uiPageHeader"),
      galleryScript.indexOf('hydrateUiIcons', galleryScript.indexOf("byId('automation-preview').innerHTML = uiPageHeader")),
    );

    expect(pageHeaderCases).not.toContain('role:');
    expect(pageHeaderCases).not.toContain('size:');
    expect(automationHeader).not.toContain('role:');
    expect(automationHeader).not.toContain('size:');
  });

  it('reuses the existing AiSelect behavior instead of adding a second custom dropdown', () => {
    const galleryScript = read('src/renderer/component-gallery.js');
    const formModule = read('src/renderer/modules/ui-form.js');
    expect(gallery).toContain('./modules/utils.js');
    expect(formModule).toContain('root._aiSelectMount(');
    expect(formModule).toContain("`${host.id}-selected-value`");
    expect(formModule).toContain("[config.labelId, valueLabel && valueLabel.id]");
    expect(galleryScript).toContain('hydrateUiFormSelects(');
    expect(galleryScript).not.toContain('<select');
    expect(gallery).toContain('id="form-controls"');
    expect(css).toContain('.form-input');
    expect(css).toContain('.ai-select-trigger');
  });

  it('keeps modal, nested popover, command, and toast ordering tokenized', () => {
    expect(css).toContain('.ui-modal-overlay { z-index: var(--z-modal); }');
    expect(css).toContain('z-index: var(--z-modal-popover)');
    expect(css).toContain('.search-overlay { z-index: var(--z-command); }');
    expect(css).toContain('.ui-toast-host { z-index: var(--z-toast); }');
  });

  it('owns modal focus, Escape, scroll lock, and focus return in one runtime', () => {
    expect(modal).toContain("event.key === 'Escape'");
    expect(modal).toContain("event.key !== 'Tab'");
    expect(modal).toContain("document.body.style.overflow = 'hidden'");
    expect(modal).toContain('previousFocus.focus()');
    expect(modal).toContain('closeTopPopover()');
    expect(modal).toContain("icon: 'x'");
    expect(modal).not.toContain("icon: 'close'");
  });
});
