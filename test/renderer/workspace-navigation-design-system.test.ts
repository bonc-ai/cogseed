import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const workspaceSource = fs.readFileSync(path.join(root, 'src/renderer/modules/workspace.js'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(root, 'src/renderer/workspace.css'), 'utf8');
const componentsCss = fs.readFileSync(path.join(root, 'src/renderer/ui-components.css'), 'utf8');
const tokensCss = fs.readFileSync(path.join(root, 'src/renderer/tokens.css'), 'utf8');

describe('workspace navigation design-system integration', () => {
  it('renders detail navigation as accessible underline tabs', () => {
    expect(workspaceSource).toContain('class="ws-space-tabs" role="tablist" aria-orientation="horizontal"');
    expect(workspaceSource).toContain('role="tab" aria-controls="ws-space-panel" aria-selected="${_spaceTab === k ? \'true\' : \'false\'}"');
    expect(workspaceSource).toContain('role="tabpanel" aria-labelledby="ws-space-tab-${_spaceTab}"');
    expect(workspaceSource).toContain("if (event.isComposing || event.keyCode === 229) return;");
    expect(workspaceSource).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End']");
    expect(workspaceSource).toContain("next.scrollIntoView({ block: 'nearest', inline: 'nearest' });");
    expect(workspaceCss).toMatch(/\.ws-space-tabs button\[aria-selected="true"\]::after\s*{[^}]*height:\s*1\.5px;[^}]*background:\s*var\(--color-ink\);/s);
    const countStyle = workspaceCss.match(/\.ws-space-tabs span\s*{([^}]*)}/)?.[1] || '';
    expect(countStyle).not.toContain('background:');
    expect(countStyle).not.toContain('border-radius:');
  });

  it('uses the shared SegmentedControl for mutually exclusive filters', () => {
    expect(workspaceSource).toContain("className: 'ws-ref-tabs'");
    expect(workspaceSource).toContain("attrs: { 'data-ws': 'ref-tab', 'data-kind': 'artifact' }");
    expect(workspaceSource).toContain("className: 'ws-asset-filters'");
    expect(workspaceSource).toContain("attrs: { 'data-ws': 'asset-filter', 'data-type': id }");
    expect(componentsCss).toMatch(/\.ui-segmented-control\s*\{[^}]*background:\s*var\(--color-overlay-fill\);/s);
    expect(componentsCss).toMatch(/\.ui-segmented-control > button\[aria-pressed="true"\],\s*\.ui-segmented-control > button\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--surface-card\);[^}]*box-shadow:\s*var\(--shadow-sm\);/s);
    expect(workspaceCss).toContain('.ws-ref-tabs { flex: none; }');
    expect(workspaceCss).toContain('.ws-asset-filters { margin-bottom: var(--space-3); }');
    expect(tokensCss).toMatch(/--shadow-sm:\s*0 1px 2px rgba\(20, 40, 30, 0\.06\);/);
    expect(workspaceSource).toContain("throw new Error('workspace requires uiSegmentedControl')");
    expect(workspaceSource).not.toContain('const buttons = (options.items || [])');
  });

  it('uses shared controls and empty state in the reference picker', () => {
    expect(workspaceSource).toContain("id: 'ws-ref-search'");
    expect(workspaceSource).toContain("className: 'ws-ref-close'");
    expect(workspaceSource).toContain("window.uiEmptyState({ kind: 'quiet', title: _t('ws.ref_empty'");
    expect(workspaceSource).toContain("label: _t('ws.save_ref', '保存引用'), role: 'primary'");
    expect(workspaceSource).not.toContain('<input data-ws="ref-search"');
    expect(workspaceSource).not.toContain('<button class="ws-ref-close"');
    expect(workspaceCss).toContain('.ws-ref-head .ui-input');
    expect(workspaceCss).toContain('border-radius: var(--radius-dialog);');
    expect(workspaceCss).toContain('box-shadow: var(--shadow-dialog);');
    expect(workspaceSource).toContain("throw new Error('workspace requires uiInput')");
    expect(workspaceSource).toContain("throw new Error('workspace requires uiTextarea')");
    expect(workspaceSource).toContain("throw new Error('workspace requires uiSelect')");
    expect(workspaceSource).not.toContain('class="ws-empty"');
    expect(workspaceSource).toContain("title: _t('ws.assets_empty_title', '暂无沉淀资产')");
    expect(workspaceCss).not.toContain('.ws-empty {');
  });

  it('uses shared buttons for workspace detail header actions', () => {
    expect(workspaceSource).toContain("label: _t('ws.back_to_center', '返回空间中心'), icon: 'chevron-left', className: 'ws-back'");
    expect(workspaceSource).toContain("label: _t('ws.space_settings', '空间设置'), size: 'sm'");
    expect(workspaceSource).toContain("label: _t('ws.new_task', '新建任务'), role: 'primary', size: 'sm', icon: 'plus'");
    expect(workspaceSource).not.toContain('<button class="ws-back"');
    expect(workspaceSource).not.toContain('<button class="ws-secondary" data-ws="space-settings"');
    expect(workspaceSource).not.toContain('<button class="ws-primary" data-ws="new-task"');
  });

  it('uses shared form and button primitives in workspace settings', () => {
    expect(workspaceSource).toContain("id: 'ws-config-instructions'");
    expect(workspaceSource).toContain("className: 'ws-drawer-close'");
    expect(workspaceSource).toContain("'data-ws': 'save-instructions'");
    expect(workspaceSource).toContain("'data-ws': 'edit-base-agent'");
    expect(workspaceSource).toContain("'data-ws': k === 'role' ? 'edit-role' : 'edit-ability'");
    expect(workspaceSource).toContain("'data-ws': 'pick-main-skill'");
    expect(workspaceSource).toContain("'data-ws': 'prune-invalid'");
    expect(workspaceSource).not.toContain('<textarea data-ws="config-instructions"');
    expect(workspaceSource).not.toContain('<button class="ws-drawer-close"');
    expect(workspaceCss).toContain('.ws-config-body #ws-config-instructions');
    expect(workspaceCss).toMatch(/\.ws-config-panel\s*\{[^}]*border-left:\s*1px solid var\(--line-default\);[^}]*background:\s*var\(--surface-card\);[^}]*box-shadow:\s*var\(--shadow-dialog\);/s);
    expect(workspaceCss).toMatch(/\.ws-config-ability-card\s*\{[^}]*border:\s*1px solid var\(--line-default\);[^}]*border-radius:\s*var\(--radius-card\);[^}]*background:\s*var\(--surface-card\);/s);
  });

  it('uses shared controls throughout workspace creation and capability dialogs', () => {
    expect(workspaceSource).toContain("id: 'ws-create-name'");
    expect(workspaceSource).toContain("id: 'ws-create-instruction'");
    expect(workspaceSource).toContain("'data-ws': 'open-ability', 'data-kind': k");
    expect(workspaceSource).toContain("className: 'ws-role-primary-btn'");
    for (const action of ['close-create', 'close-create-agent', 'close-ability', 'close-edit-ability', 'close-main-skill', 'close-base-agent', 'close-role']) {
      expect(workspaceSource).toContain(`'data-ws': '${action}'`);
    }
    expect(workspaceSource).not.toContain('<input data-ws="create-name"');
    expect(workspaceSource).not.toContain('<textarea data-ws="create-instruction"');
    expect(workspaceSource).not.toContain('<button data-ws="close-create"');
    expect(workspaceSource).not.toContain('<button class="ws-secondary" data-ws="close-ability"');
    expect(workspaceSource).toContain('class="ui-modal-overlay ws-scrim"');
    expect(workspaceSource).toContain('class="ui-modal ui-modal--lg ws-dialog"');
    expect(workspaceSource).toContain('class="ui-modal ws-ability-dialog"');
    expect(workspaceSource).toContain('class="ui-modal__header ws-ability-head"');
    expect(workspaceSource).toContain('class="ui-modal__body ws-ability-main');
    expect(workspaceSource).toContain('class="ui-modal__footer ws-ability-foot"');
    expect(workspaceCss).not.toMatch(/\.ws-dialog\s*\{[^}]*(?:border|background|box-shadow):/s);
    expect(workspaceCss).not.toMatch(/\.ws-ability-dialog\s*\{[^}]*(?:border|background|box-shadow):/s);
    expect(workspaceCss).toContain('.ws-form-grid .ui-input, .ws-form-grid .ui-textarea');
    expect(workspaceCss).toContain('.ws-role-primary-btn.ui-button');
  });

  it('keeps collaborating Agent tool selection and keyboard focus visually observable', () => {
    expect(workspaceSource).toContain('aria-pressed="${selected ? \'true\' : \'false\'}"');
    expect(workspaceCss).toMatch(/\.ws-view \.ws-tool-row > button\.ws-tool-tile\s*\{[^}]*border:\s*1px solid transparent;/s);
    expect(workspaceCss).toMatch(/\.ws-view \.ws-tool-row > button\.ws-tool-tile\.selected\s*\{[^}]*border-color:\s*#79c49e;/s);
    expect(workspaceCss).toMatch(/\.ws-view \.ws-tool-row > button\.ws-tool-tile:focus-visible\s*\{[^}]*outline:/s);
  });

  it('uses shared buttons for workspace card menus and artifact actions', () => {
    expect(workspaceSource).toContain("className: 'ws-more-action'");
    expect(workspaceSource).toContain("className: 'ws-more-danger'");
    expect(workspaceSource).toContain("className: 'ws-art-open'");
    expect(workspaceSource).toContain("className: 'ws-art-more'");
    expect(workspaceSource).toContain("className: 'ws-art-drawer-close'");
    expect(workspaceSource).toContain('window.uiDrawerController({');
    expect(workspaceSource).toContain("initialFocus: '.ws-art-drawer-close'");
    expect(workspaceSource).toContain('fallbackFocus: () => _artifactEntry(_artDrawerId)');
    expect(workspaceSource).toContain('const returnTarget = _artifactEntry(closedArtifactId)');
    expect(workspaceSource).toContain("_artDrawerController.close('business-action')");
    expect(workspaceSource).toContain('<aside class="ws-art-drawer" data-ws="noop" role="dialog" aria-modal="true"');
    expect(workspaceSource).not.toContain('data-ws="art-drawer-close" role="dialog"');
    expect(workspaceSource).toContain("label: _t('ws.art_open_full', '打开完整文件'), role: 'primary'");
    expect(workspaceSource).not.toContain('<button class="ws-more-action"');
    expect(workspaceSource).not.toContain('<button type="button" class="ws-art-open"');
    expect(workspaceSource).not.toContain('<button type="button" class="ws-art-drawer-close"');
    expect(workspaceCss).toContain('.ws-more-actions .ui-button');
    expect(workspaceSource).toContain("className: 'ws-art-menu-action'");
    expect(workspaceSource).toContain("className: 'ws-art-menu-action ws-art-danger'");
    expect(workspaceSource).toContain("variant: 'danger', className: 'ws-unbind'");
    expect(workspaceSource).not.toContain('<button type="button" role="menuitem" data-ws="art-action"');
    expect(workspaceSource).not.toContain('<button class="ws-unbind"');
    expect(workspaceCss).toContain('.ws-art-more-menu .ws-art-menu-action.ui-button');
    expect(workspaceCss).toContain('.ws-asset-card .ws-unbind.ui-icon-button');
  });

  it('keeps task rows valid and uses shared controls for row actions and empty state', () => {
    expect(workspaceSource).toContain('class="ws-session-open" data-ws="open-task"');
    expect(workspaceSource).toContain("label: _t('ws.task_unbind_btn', '移出空间'), role: 'ghost', size: 'sm', className: 'ws-task-remove'");
    expect(workspaceSource).toContain("kind: 'actionable', title: _t('ws.tasks_empty'");
    expect(workspaceSource).toContain("_icon('file-text', 'ui-icon')");
    expect(workspaceSource).not.toContain("className: 'ws-row-more-btn'");
    expect(workspaceCss).toContain('.ws-session-list { border-top: 1px solid var(--line-hairline); }');
    expect(workspaceCss).toContain('.ws-session-open { display: block;');
    expect(workspaceCss).toContain('.ws-task-remove.ui-button');
  });

  it('matches the reference workspace hub and compact detail titlebar composition', () => {
    expect(workspaceSource).not.toContain('<p class="ws-tagline">');
    expect(workspaceSource).toContain('<div class="ws-space-titlebar">');
    expect(workspaceSource).toContain('<div class="ws-space-head-actions">');
    expect(workspaceSource).not.toContain('<div class="ws-space-heading">');
    expect(workspaceSource).not.toContain("<span>· ${_scenarios.length + _templates.length}</span>");
    expect(workspaceCss).toMatch(/\.ws-space-head-row\s*{[^}]*min-height:\s*var\(--layout-titlebar-height\);/s);
    expect(workspaceCss).toMatch(/\.ws-space-titlebar h1\s*{[^}]*font-size:\s*var\(--font-size-title\);/s);
  });

  it('uses the shared resource grid geometry and empty state on the workspace hub', () => {
    expect(workspaceCss).toMatch(/\.ws-space-grid\s*\{[^}]*repeat\(auto-fit, minmax\(min\(100%, 300px\), 1fr\)\)[^}]*gap:\s*var\(--space-4\)/s);
    expect(workspaceCss).toMatch(/\.ws-template-grid\s*\{[^}]*repeat\(auto-fit, minmax\(min\(100%, 300px\), 1fr\)\)[^}]*gap:\s*var\(--space-4\)/s);
    expect(workspaceCss).toMatch(/\.ws-space-card\s*\{[^}]*max-width:\s*400px[^}]*border-radius:\s*var\(--radius-card\)[^}]*box-shadow:\s*var\(--shadow-card\)/s);
    expect(workspaceCss).toMatch(/\.ws-template-card\s*\{[^}]*max-width:\s*400px[^}]*border-radius:\s*var\(--radius-card\)[^}]*box-shadow:\s*var\(--shadow-card\)/s);
    expect(workspaceSource).toContain("window.uiEmptyState(_spaces.length ? {");
    expect(workspaceSource).toContain("attrs: { 'data-ws': 'clear-center-search' }");
    expect(workspaceSource).not.toContain('class="ws-count"');
    expect(workspaceSource).toContain("window.uiIconButton({ label: _t('ws.more_actions_for'");
    expect(workspaceSource).toContain('<p class="ws-space-roles">');
    expect(workspaceSource.match(/window\.uiButton\(\{ label: _t\('ws\.(enter_space|use_template|use_scene)'/g)).toHaveLength(3);
    expect(workspaceSource).toContain("education: 'book-open'");
    expect(workspaceSource).toContain("writing: 'document-pencil'");
    expect(workspaceSource).toContain("workplace: 'layout-grid'");
    expect(workspaceSource).toContain("custom: 'puzzle'");
    expect(workspaceSource).not.toContain('escapeHtml(sc.icon');
  });

  it('uses shared input and AiSelect controls for workspace search and sorting', () => {
    expect(workspaceSource).toContain("id: 'ws-center-search'");
    expect(workspaceSource).toContain("attrs: { 'data-ws': 'center-search'");
    expect(workspaceSource).toContain("id: 'ws-center-sort'");
    expect(workspaceSource).toContain("window.hydrateUiFormSelects(root");
    expect(workspaceSource).not.toContain('<select class="ws-sort"');
    expect(workspaceCss).toContain('.ws-search .ui-input');
    expect(workspaceCss).toContain('.ws-sort .ai-select-trigger');
    expect(workspaceCss).toMatch(/\.ws-center\s*\{[^}]*padding:\s*var\(--space-4\) var\(--space-6\) var\(--space-page\);/s);
    expect(workspaceCss).toMatch(/\.ws-refresh-notice\s*\{[^}]*min-height:\s*var\(--control-height-lg\);/s);
  });

  it('uses shared controls and icon primitives in the artifact toolbar', () => {
    expect(workspaceSource).toContain("id: 'ws-art-search'");
    expect(workspaceSource).toContain("id: 'ws-art-source-filter'");
    expect(workspaceSource).toContain("id: 'ws-art-group-mode'");
    expect(workspaceSource).toContain("id: 'ws-art-sort-mode'");
    expect(workspaceSource).toContain("className: 'ws-art-chips'");
    expect(workspaceSource).toContain("icon: 'list'");
    expect(workspaceSource).toContain("icon: 'layout-grid'");
    expect(workspaceSource).not.toContain('>☷</button>');
    expect(workspaceSource).not.toContain('>▦</button>');
    expect(workspaceCss).toContain('.ws-art-search-wrap .ui-input');
    expect(workspaceCss).toContain('.ws-art-select .ai-select-trigger');
    expect(workspaceCss).toContain('.ws-space-pane--artifacts { max-width: var(--layout-card-grid-width); }');
  });
});
