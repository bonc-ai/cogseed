import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rendererRoot = resolve(__dirname, '../../src/renderer');
const read = (file: string) => readFileSync(resolve(rendererRoot, file), 'utf8');

describe('resource page composition integration', () => {
  it('opts in only the four resource routes', () => {
    const html = read('index.html');
    const routes = [...html.matchAll(/class="panel ui-resource-page" id="panel-([^"]+)"/g)]
      .map((match) => match[1])
      .sort();

    expect(routes).toEqual(['auto', 'connections', 'recall', 'workspace']);
    expect(html).toContain('<section class="panel" id="panel-run-center">');
    expect(html).toContain('<section class="panel" id="panel-kb">');
  });

  it('keeps navigation optional and preserves existing page hooks', () => {
    const html = read('index.html');
    const automation = html.slice(html.indexOf('id="panel-auto"'), html.indexOf('id="panel-run-center"'));
    const workspace = read('modules/workspace.js');
    const workspaceCenter = workspace.slice(
      workspace.indexOf('<div class="ws-center-header">'),
      workspace.indexOf('function _spaceCardHtml'),
    );

    expect(automation).not.toContain('role="tablist"');
    expect(workspaceCenter).not.toContain('role="tablist"');
    expect(workspaceCenter).not.toContain('ws-space-tabs');
    expect(html).toContain('data-cognition-page="governance"');
    expect(html).toContain('data-connections-tab="touchpoints"');
    expect(workspace).toContain('ws-space-tabs');
  });

  it('loads the shared composition after legacy page styles in production and gallery', () => {
    for (const file of ['index.html', 'component-gallery.html']) {
      const html = read(file);
      expect(html.indexOf('resource-pages.css')).toBeGreaterThan(html.indexOf('style.css'));
      expect(html.indexOf('resource-pages.css')).toBeGreaterThan(html.indexOf('ui-components.css'));
    }

    const production = read('index.html');
    expect(production.indexOf('resource-pages.css')).toBeGreaterThan(production.indexOf('workspace.css'));
    expect(production.indexOf('resource-pages.css')).toBeGreaterThan(production.indexOf('recall-local.css'));
  });

  it('owns one responsive gutter and one tabbed-page whitespace rhythm', () => {
    const css = read('resource-pages.css');

    expect(css).toContain('--resource-page-gutter: var(--space-6);');
    expect(css).toContain('padding-inline-end: var(--resource-page-inset);');
    expect(css).toContain('var(--shell-header-inset, var(--resource-page-gutter))');
    expect(css).toContain('padding: var(--space-6) var(--resource-page-inset) var(--space-7);');
    expect(css).toContain('padding: var(--space-3) var(--resource-page-inset) 0;');
    expect(css).toContain('@media (max-width: 1280px)');
    expect(css).toContain('--resource-page-gutter: var(--space-5);');
    expect(css).toContain('@media (max-width: 960px)');
    expect(css).toContain('--resource-page-gutter: var(--space-4);');
  });

  it('removes the cognition legacy fill while keeping the shared active underline', () => {
    const css = read('resource-pages.css');
    const tabRule = css.slice(
      css.indexOf('.ui-resource-page .skills-cognition-surface .skills-cognition-tab,'),
      css.indexOf('.ui-resource-page :is(.skills-cognition-tab, .connections-tab):focus-visible'),
    );

    expect(tabRule).toContain('background: transparent;');
    expect(tabRule).toContain('box-shadow: none;');
    expect(tabRule).toContain('border-bottom-color: var(--color-accent);');
    expect(tabRule).not.toContain('color-mix(');
  });

  it('aligns all five capability subpages to the Skill library baseline', () => {
    const html = read('index.html');
    const css = read('resource-pages.css');
    const connections = read('modules/connections.js');
    const agents = read('modules/agents.js');

    for (const pane of ['agents', 'mcp', 'skills', 'sources', 'touchpoints']) {
      expect(html).toContain(`data-connections-pane="${pane}"`);
    }
    expect(agents).toContain("className: 'agents-category-filter'");
    expect(connections).toContain("className: 'connections-tools-segments'");
    expect(html).toContain('ui-button--secondary ui-button--sm contexts-page-header-search');
    expect(css).toContain('.plugins-page-header-main');
    expect(css).toContain('.contexts-page-header-main');
    expect(css).toContain('.touchpoint-connections-header > div');
    expect(css).toContain('.contexts-layout, .messaging-settings-shell');
    expect(css).toContain('margin: 0 0 var(--space-4);');
    expect(css).toContain('@media (min-width: 761px)');
    expect(css).toContain('.connections-tools-view:not([hidden]) :is(');
    expect(css).toContain('position: absolute;');
  });

  it('renders the same composition in the component gallery', () => {
    const html = read('component-gallery.html');
    const script = read('component-gallery.js');

    expect(html).toContain('id="resource-pages"');
    expect(html).toContain('id="resource-page-specimens"');
    expect(script).toContain('function renderResourcePages()');
    expect(script).toContain('ui-resource-page gallery-resource-page-preview');
    expect(script).toContain('skills-cognition-tab ui-tab');
    expect(script).toContain('renderResourcePages();');
  });
});
