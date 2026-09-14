import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const skillsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/skills.js'), 'utf8');
const recallCss = fs.readFileSync(path.join(root, 'src/renderer/recall-local.css'), 'utf8');
const componentsCss = fs.readFileSync(path.join(root, 'src/renderer/ui-components.css'), 'utf8');

describe('cognition SegmentedControl design-system integration', () => {
  it('uses the shared primitive for capture and proof filters without changing action routes', () => {
    expect(skillsSource).toContain('function _skillUiSegmentedControl(options)');
    expect(skillsSource).toContain("className: 'recall-capture-filter-bar'");
    expect(skillsSource).toContain("attrs: { 'data-recall-capture-filter': filter }");
    expect(skillsSource).toContain("className: 'recall-capture-filter-bar cognition-proof-filters'");
    expect(skillsSource).toContain("attrs: { 'data-cognition-proof-filter': id }");
    expect(skillsSource).toContain("className: 'recall-capture-policy-group is-review'");
    expect(skillsSource).toContain("attrs: { 'data-recall-review-policy': policy }");
  });

  it('keeps page CSS to composition while the shared layer owns the visual contract', () => {
    expect(recallCss).toContain('.recall-capture-filter-bar { margin-bottom: var(--space-4); }');
    expect(recallCss).not.toContain('.recall-capture-filter.is-active');
    expect(recallCss).not.toContain('.recall-capture-policy.is-active');
    expect(componentsCss).toContain('.ui-segmented-control > button[aria-pressed="true"]');
    expect(componentsCss).toContain('box-shadow: var(--shadow-sm);');
    expect(componentsCss).toContain('.ui-segmented-control__count');
  });

  it('uses the shared EmptyState for proof, missing-candidate, and governance results', () => {
    expect(skillsSource).toContain('function _skillUiEmptyState(options)');
    expect(skillsSource.match(/_skillUiEmptyState\(\{/g)?.length).toBeGreaterThanOrEqual(7);
    expect(skillsSource).toContain("icon: 'shield-check'");
    expect(skillsSource).toContain("icon: 'archive'");
    expect(recallCss).not.toContain('.cognition-task-empty');
  });

  it('uses shared EmptyState contracts in the asset-management workbench', () => {
    expect(skillsSource).toContain("kind: 'explained', icon: 'archive', title: _cognitionText('cognition.no_ability_assets'");
    expect(skillsSource).toContain("kind: 'quiet', title: searchQuery ? _cognitionText('cognition.asset_search_empty'");
    expect(skillsSource).toContain("kind: 'explained', icon: 'archive', title: selectedCategory");
    expect(recallCss).toContain('.ability-assets-empty > .ui-empty-state { min-height: 220px; }');
  });

  it('uses the shared content width and metric-card geometry across cognition views', () => {
    expect(recallCss).not.toContain('max-width: 1480px');
    expect(recallCss).toMatch(/\.cognition-task-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(120px, 1fr\)\)[^}]*border-radius:\s*var\(--radius-card\);/s);
    expect(recallCss).toMatch(/\.cognition-task-metric strong\s*\{[^}]*font-size:\s*var\(--font-size-heading\);[^}]*font-weight:\s*var\(--font-weight-medium\);/s);
    expect(recallCss.match(/max-width:\s*var\(--layout-card-grid-width\)/g)?.length).toBeGreaterThanOrEqual(10);
  });

  it('uses the shared Input primitive for cognition search fields', () => {
    expect(skillsSource).toContain('function _skillUiInput(options)');
    expect(skillsSource).toContain("id: 'recall-manual-search'");
    expect(skillsSource).toContain("className: 'recall-manual-search'");
    expect(skillsSource).toContain("id: 'cognition-asset-search'");
    expect(skillsSource).toContain("className: 'asset-search'");
    expect(skillsSource).not.toContain('<input class="input recall-manual-search"');
    expect(skillsSource).not.toContain('<input class="asset-search"');
    expect(recallCss).toContain('.recall-manual-search { width: 100%; margin-bottom: var(--space-2); }');
  });

  it('uses shared buttons for asset-detail and governance actions', () => {
    expect(skillsSource).toContain("icon: 'chevron-left', attrs: { 'data-cognition-subview-tree': '' }");
    expect(skillsSource).toContain("icon: 'more-horizontal', className: 'recall-asset-more'");
    expect(skillsSource).toContain("attrs: { 'data-recall-skill-import': selected.id }");
    expect(skillsSource).toContain("attrs: { 'data-cognition-governance-action': action");
    expect(skillsSource).not.toContain('<button type="button" class="btn btn-sm recall-asset-more"');
    expect(skillsSource).not.toContain('<button type="button" class="btn btn-sm btn-primary" data-recall-skill-import');
    expect(recallCss).toContain('.recall-asset-more { flex: none; }');
  });
});
