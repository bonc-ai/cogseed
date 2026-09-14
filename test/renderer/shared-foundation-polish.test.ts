import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} must exist`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf('{', start);
  const bodyEnd = css.indexOf('}', bodyStart);
  return css.slice(bodyStart + 1, bodyEnd);
}

describe('open-source shared foundation polish', () => {
  const sharedCss = read('src/renderer/ui-components.css');
  const rendererCss = read('src/renderer/style.css');
  const index = read('src/renderer/index.html');

  it('keeps PageHeader, Tabs, EmptyState, ResourceCard, and SettingsSection in shared CSS', () => {
    for (const selector of [
      '.ui-page-header',
      '.ui-tabs',
      '.ui-tab',
      '.ui-empty-state',
      '.ui-resource-card',
      '.ui-settings-section',
    ]) {
      expect(sharedCss).toContain(selector);
    }
    expect(rule(sharedCss, '.ui-page-header')).toContain('box-shadow: none;');
    expect(rule(sharedCss, '.ui-empty-state')).toContain('box-shadow: none;');
    expect(rule(sharedCss, '.ui-settings-section')).toContain('box-shadow: none;');
    expect(rule(sharedCss, '.ui-resource-card')).toContain('box-shadow: var(--shadow-card);');
    expect(rule(sharedCss, '.ui-tab')).toContain('border-bottom: 1.5px solid transparent;');
    expect(rule(sharedCss, '.ui-settings-section > .settings-group-head')).not.toContain('display: flex;');
    expect(rule(sharedCss, '.ui-settings-section__header')).toContain('display: flex;');
  });

  it('removes legacy purple focus halos from interactive fields and controls', () => {
    for (const selector of [
      '.conv-list-section-header.is-collapsible:focus-visible',
      '.conv-item-title-input',
      '.new-chat-external-agent-btn:focus-visible',
      '.chat-header-title-input',
      '.settings-row input:focus',
      '.form-input:focus',
      '#auto-date-input:focus',
      '#auto-title-input:focus',
    ]) {
      const block = rule(rendererCss, selector);
      expect(block).toContain('var(--color-focus-halo)');
      expect(block).not.toMatch(/91\s*,\s*87\s*,\s*214/);
    }
  });

  it('marks real page tabs and settings groups without changing their routing hooks', () => {
    expect(index).toContain('class="connections-tabs ui-tabs"');
    expect(index).toContain('class="connections-tab ui-tab is-active"');
    expect(index).toContain('class="skills-cognition-tab ui-tab is-active"');
    expect(index).toContain('class="settings-group ui-settings-section"');
    for (const hook of [
      'data-connections-tab="agents"',
      'data-connections-tab="mcp"',
      'data-cognition-page="assets"',
      'data-settings-tab="data"',
    ]) {
      expect(index).toContain(hook);
    }
  });

  it('marks every high-frequency resource page card with the shared shell', () => {
    const sources = {
      workspace: read('src/renderer/modules/workspace.js'),
      automation: read('src/renderer/modules/auto.js'),
      agents: read('src/renderer/modules/agents.js'),
      skills: read('src/renderer/modules/skills.js'),
      marketplace: read('src/renderer/modules/marketplace.js'),
      connectors: read('src/renderer/modules/connectors.js'),
      plugins: read('src/renderer/modules/plugins.js'),
    };

    expect(sources.workspace).toContain('ws-space-card ui-resource-card');
    expect(sources.automation).toContain('auto-row ui-resource-card ui-resource-card--row');
    expect(sources.automation).toContain('auto-tpl-card ui-resource-card');
    expect(sources.agents).toContain('agent-card ui-resource-card');
    expect(sources.skills).toContain('skill-card ui-resource-card');
    expect(sources.marketplace).toContain('marketplace-card ui-resource-card');
    expect(sources.connectors).toContain('connector-card ui-resource-card');
    expect(sources.plugins).toContain('plugins-card ui-resource-card');
  });

  it('keeps settings compositions on the shared flat section surface', () => {
    const messaging = read('src/renderer/modules/messaging-settings.js');
    expect(messaging).toContain('messaging-config-card ui-settings-section');
    expect(messaging).toContain('messaging-settings-section ui-settings-section');
    expect(rendererCss).toContain('text-transform: none;');
  });

  it('lets narrow settings panes shrink and truncates the data path in place', () => {
    const settingsBody = rule(rendererCss, '.settings-body');
    expect(settingsBody).toContain('min-width: 0;');
    expect(settingsBody).toContain('width: auto;');
    expect(rule(rendererCss, '#settings-data-root-btn')).toContain('max-width: 100%;');
    expect(rule(rendererCss, '#settings-data-root-path')).toContain('text-overflow: ellipsis;');
  });

  it('shows the shared foundations and shell chrome in the production component gallery', () => {
    const gallery = read('src/renderer/component-gallery.html');
    const galleryScript = read('src/renderer/component-gallery.js');
    for (const id of ['page-header', 'tabs', 'resource-cards', 'settings-sections', 'empty-states']) {
      expect(gallery).toContain(`id="${id}"`);
    }
    expect(gallery).toContain('id="window-chrome"');
    expect(gallery).toContain('17 / 17 已定义');
    expect(galleryScript).toContain('function renderSidebarTools()');
    expect(galleryScript).toContain('function renderTabs()');
    expect(galleryScript).toContain('function renderResourceCards()');
    expect(galleryScript).toContain('function renderSettingsSections()');
    expect(galleryScript).toContain('event.isComposing || event.keyCode === 229');
  });

  it('integrates retrieval and selection components without changing their business seams', () => {
    const settings = read('src/renderer/modules/settings.js');
    const search = read('src/renderer/modules/search.js');
    const gallery = read('src/renderer/component-gallery.js');

    const providerMount = settings.slice(
      settings.indexOf('_settingsState.pickerProviderSel = _aiSelectMount'),
      settings.indexOf('_settingsState.pickerProviderSel.onChange'),
    );
    const modelMount = settings.slice(
      settings.indexOf('_settingsState.pickerModelSel = _aiSelectMount'),
      settings.indexOf('_settingsState.pickerModelSel.onChange'),
    );
    expect(providerMount).toContain('searchable: true');
    expect(providerMount).toContain("labelledBy: 'settings-picker-provider-label'");
    expect(modelMount).toContain('searchable: true');
    expect(modelMount).toContain("labelledBy: 'settings-picker-model-label'");
    expect(settings).toContain('sel.setLoading?.(Boolean(providerId));');
    expect(search).toContain('if (e.isComposing || e.keyCode === 229) return;');
    expect(search).toContain('_trapSearchFocus(e, overlay);');
    expect(search).toContain('_renderSearchLoading(query);');
    expect(search).toContain("apiFetch('/api/search/global'");
    expect(search).toContain("setView('conversation', r.cid");
    expect(index).toContain('class="form-input ui-control ui-input ui-date-control" type="date" id="auto-date-input"');
    expect(gallery).toContain("['loading', '搜索中']");
    expect(gallery).toContain("['keyboard', '键盘 / IME']");
  });
});
