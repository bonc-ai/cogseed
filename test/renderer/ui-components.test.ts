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
    'src/renderer/modules/ui-sidebar-tools.js',
    'src/renderer/modules/ui-segmented-control.js',
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

    const large = uiButton({ label: '继续', role: 'primary', size: 'lg' });
    expect(large).toContain('ui-button--lg');

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

  it('keeps shell search before collapse and exposes one recovery entry', () => {
    const { uiSidebarTools } = loadFactories();
    const expanded = uiSidebarTools({ collapsed: false });
    const collapsed = uiSidebarTools({ collapsed: true });

    expect(expanded.indexOf('is-search')).toBeLessThan(expanded.indexOf('is-panel'));
    expect(expanded).toContain('data-i18n-title="sidebar.search_title"');
    expect(expanded).toContain('aria-expanded="true"');
    expect(collapsed).not.toContain('is-search');
    expect(collapsed).toContain('data-i18n-title="sidebar.expand_title"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed.match(/<button/g)).toHaveLength(1);
  });

  it('renders SegmentedControl as pressed native buttons with inline counts', () => {
    const { uiSegmentedControl } = loadFactories();
    const html = uiSegmentedControl({
      ariaLabel: '证明记录筛选',
      value: 'used',
      items: [
        { value: 'all', label: '全部', count: 12 },
        { value: 'used', label: '已引用', count: 4, attrs: { 'data-filter': 'used' } },
      ],
    });

    expect(html).toContain('class="ui-segmented-control" role="group" aria-label="证明记录筛选"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-pressed="true" data-filter="used"');
    expect(html).toContain('class="ui-segmented-control__count">4</span>');
    expect(() => uiSegmentedControl({ items: ['全部'] })).toThrow(/accessible label/);
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
    const { uiField, uiSelect, hydrateUiFormSelects, uiDateRangePicker } = loadFactories();

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
    expect(loadFactories().uiInput({ id: 'search', className: 'asset-search' })).toContain('ui-input asset-search');
    expect(loadFactories().uiInput({ id: 'title', attrs: { title: '双击修改标题' } }))
      .toContain('title="双击修改标题"');

    const textarea = uiField({ id: 'task-content', label: '任务内容', control: { kind: 'textarea' } });
    expect(textarea).toContain('ui-textarea');
    expect(loadFactories().uiTextarea({ id: 'details', className: 'space-details', attrs: { rows: 4, spellcheck: 'false' } }))
      .toContain('ui-textarea space-details');
    expect(loadFactories().uiTextarea({ id: 'details', attrs: { rows: 4, spellcheck: 'false' } }))
      .toContain('rows="4" spellcheck="false"');

    const select = uiField({
      id: 'frequency',
      label: '频率',
      control: { kind: 'select', options: [{ value: 'daily', label: '每天' }] },
    });
    expect(select).toContain('data-ui-select');
    expect(select).toContain('data-ui-select-config');
    expect(select).toContain('frequency-label');
    expect(select).not.toContain('<select');
    expect(uiSelect({ id: 'sort', ariaLabel: '排序方式', options: [] })).toContain('&quot;ariaLabel&quot;:&quot;排序方式&quot;');
    expect(uiSelect({ id: 'model', searchable: true, loading: true, total: 47 }))
      .toContain('&quot;searchable&quot;:true');
    expect(uiSelect({ id: 'model', searchable: true, loading: true, total: 47 }))
      .toContain('&quot;loading&quot;:true');
    expect(uiSelect({ id: 'model', searchable: true, loading: true, total: 47 }))
      .toContain('&quot;total&quot;:47');
    expect(typeof hydrateUiFormSelects).toBe('function');

    const range = uiDateRangePicker({
      id: 'report-range',
      ariaLabel: '报告日期范围',
      startLabel: '开始日期',
      endLabel: '结束日期',
      start: '2026-09-01',
      end: '2026-09-14',
      invalidEnd: true,
    });
    expect(range).toContain('class="date-range-picker"');
    expect(range).toContain('type="date"');
    expect(range).toContain('id="report-range-start"');
    expect(range).toContain('id="report-range-end"');
    expect(range).toContain('aria-label="报告日期范围"');
    expect(range).toContain('aria-invalid="true"');
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
  const rendererCss = read('src/renderer/style.css');
  const workspaceCss = read('src/renderer/workspace.css');
  const recallCss = read('src/renderer/recall-local.css');
  const modal = read('src/renderer/modules/ui-modal.js');
  const tokens = read('src/renderer/tokens.css');

  it('loads tokens before legacy styles and shared component CSS after them', () => {
    expect(index.indexOf('./tokens.css')).toBeLessThan(index.indexOf('./style.css'));
    expect(index.indexOf('./ui-components.css')).toBeGreaterThan(index.indexOf('./style.css'));
  });

  it('renders the gallery from the same production component files', () => {
    for (const asset of [
      './tokens.css',
      './ui-components.css',
      './shell-navigation.css',
      './modules/ui-button.js',
      './modules/ui-sidebar-tools.js',
      './modules/ui-segmented-control.js',
      './modules/ui-form.js',
      './modules/ui-empty.js',
      './modules/ui-page-header.js',
      './modules/ui-modal.js',
    ]) {
      expect(gallery).toContain(asset);
    }
  });

  it('maps the open-source design system into production tokens and shared chrome', () => {
    expect(tokens).toContain('--layout-sidebar-width: 280px;');
    expect(tokens).toContain('--layout-titlebar-height: 52px;');
    expect(tokens).toContain('--control-height-sm: 28px;');
    expect(tokens).toContain('--control-height: 32px;');
    expect(tokens).toContain('--control-height-lg: 36px;');
    expect(tokens).toContain('--icon-size: 16px;');
    expect(tokens).toContain('--font-size-body: 15px;');
    expect(tokens).toContain('--font-size-heading: 22px;');
    expect(tokens).toContain('--radius-xs: 4px;');
    expect(tokens).toContain('--radius-window: 14px;');
    expect(tokens).toContain('--line-subtle: var(--color-line-subtle);');
    expect(tokens).toContain('--color-accent-gradient: linear-gradient(135deg, #0A7A55, #086545);');
    expect(css).toContain('height: var(--control-height);');
    expect(css).toContain('.ui-button--lg { height: var(--control-height-lg); }');
    expect(css).toContain('.ui-segmented-control > button[aria-pressed="true"]');
    expect(css).toContain('min-height: var(--layout-titlebar-height);');
    expect(css).toContain('border-radius: var(--radius-dialog);');
  });

  it('documents the production mapping instead of the retired spike contract', () => {
    const galleryCss = read('src/renderer/component-gallery.css');

    expect(gallery).toContain('OPEN SOURCE DESIGN SYSTEM / PRODUCTION MAPPING');
    expect(gallery).toContain('4 个角色 × 3 个尺寸 × 6 个可核对状态');
    expect(gallery).toContain('id="segmented-controls"');
    expect(gallery).toContain('正文基线 15px');
    expect(gallery).toContain('4/7/8/9/11/12/14/∞');
    expect(gallery).not.toContain('首版范围');
    expect(gallery).not.toContain('UX Quality Spike');
    expect(galleryCss).toContain('grid-template-columns: var(--layout-sidebar-width) minmax(0, 1fr);');
    expect(galleryCss).toContain('.gallery-radius-scale .rw { border-radius: var(--radius-window); }');
    expect(gallery).toContain('id="search-selection-components"');
    expect(gallery).toContain('17 / 17 已定义');
  });

  it('integrates the open-source shell into real high-frequency pages', () => {
    expect(rendererCss).toContain('font-family: var(--font-sans);');
    expect(rendererCss).toContain('min-height: var(--row-height-nav);');
    expect(rendererCss).toContain('max-width: var(--layout-thread-home-width);');
    expect(rendererCss).toContain('flex: 0 0 var(--layout-settings-nav-width);');
    expect(rendererCss).toContain('max-width: var(--layout-card-grid-width);');
    expect(rendererCss).toContain('box-shadow: var(--shadow-composer), 0 0 0 3px var(--color-focus-halo);');
    expect(rendererCss).toContain('.auto-row:hover { border-color: var(--line-strong); box-shadow: var(--shadow-card-hover); }');
    expect(rendererCss).toContain('.skill-card.is-menu-open');
    expect(rendererCss).toContain('max-width: var(--layout-card-grid-width);');
    expect(workspaceCss).toContain('--ws-accent: var(--color-brand);');
    expect(workspaceCss).toContain('background: var(--surface-app);');
    expect(workspaceCss).toContain('border-radius: var(--radius-card); background: var(--ws-surface);');
    expect(workspaceCss).toContain('max-width: var(--layout-card-grid-width);');
    expect(recallCss).toContain('background: var(--surface-app);');
    expect(recallCss).toContain('border-bottom-color: var(--color-ink);');
    expect(recallCss).toContain('max-width: var(--layout-card-grid-width);');
    expect(rendererCss).toContain('flex: 0 0 var(--layout-info-panel-width);');
    expect(rendererCss).toContain('calc((100% - var(--layout-thread-width)) / 2)');
    expect(rendererCss).toContain('#panel-conversation .chat-message.user > .chat-bubble');
  });

  it('lets PageHeader own every gallery action appearance', () => {
    const galleryScript = read('src/renderer/component-gallery.js');
    const pageHeaderCases = galleryScript.slice(
      galleryScript.indexOf('function renderPageHeaders'),
      galleryScript.indexOf('function renderTabs'),
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
    expect(galleryScript).toContain('searchable: true');
    expect(galleryScript).toContain('uiDateRangePicker({');
    expect(css).toContain('.ai-select-search-input');
    expect(css).toContain('.date-range-picker');
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
