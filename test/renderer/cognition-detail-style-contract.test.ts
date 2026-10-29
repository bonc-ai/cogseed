import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('uses defined design tokens and one style entry for every detail surface', () => {
  const read = (path: string) => readFileSync(resolve('src/renderer', path), 'utf8');
  const css = read('modules/cognition-assets/details.css');
  const tokens = new Set([...read('tokens.css').matchAll(/(--[\w-]+)\s*:/g), ...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  const undefinedTokens = [...css.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]).filter(name => !tokens.has(name));
  expect(undefinedTokens).toEqual([]);
  expect(read('index.html')).toContain('modules/cognition-assets/details.css');
  for (const file of ['modules/cognition-assets/library.js', 'modules/cognition-assets/review-views.js', 'modules/cognition-ontology.js']) {
    expect(read(file)).toContain('ca-detail-card');
  }
  for (const file of ['modules/cognition-assets/views.js', 'modules/cognition-assets/review-views.js', 'modules/cognition-ontology.js']) {
    for (const role of ['ca-detail-head', 'ca-detail-body', 'ca-detail-footer']) expect(read(file)).toContain(role);
  }
  expect(css).not.toMatch(/font-size:\s*\d|color:\s*#|!important/);
});


it('contains compact spacing in the two list-side details and activity styling in its own card', () => {
  const read = (path: string) => readFileSync(resolve('src/renderer', path), 'utf8');
  const view = read('modules/cognition-assets/review-views.js');
  expect(view).toContain('class="ca-library-detail-title"');
  expect(view).toContain('class="ca-library-facts"');
  const css = read('modules/cognition-assets/details.css');
  const compact = css.split('/* Compact reading spacing')[1].split('/* Native disclosure presentation')[0];
  for (const rule of compact.split('}').filter(rule => rule.includes('{'))) {
    expect(rule).toContain('.ca-detail-card:is(.ca-activity-detail,.ca-library-detail)');
  }
  expect(compact).not.toMatch(/font-size:|line-height:|width:|height:|display:|background:|color:/);
  const rules = css.split('/* System activity adopts')[1];
  expect(rules).toBeTruthy();
  for (const rule of rules.split('}').filter(rule=>rule.includes('{'))) expect(rule).toContain('.ca-activity-detail.ca-detail-card');
  expect(rules).toContain('background: transparent');
  expect(rules).not.toMatch(/font-size:\s*\d|grid-template-columns|--detail-title:/);
});

it('limits native disclosure styling to the two inspectors without changing typography', () => {
  const css = readFileSync(resolve('src/renderer/modules/cognition-assets/details.css'), 'utf8');
  const disclosure = css.split('/* Native disclosure presentation')[1].split('/* System activity adopts')[0];
  for (const rule of disclosure.split('}').filter(rule => rule.includes('{'))) {
    expect(rule).toContain('.ca-detail-card:is(.ca-activity-detail,.ca-library-detail)');
  }
  expect(disclosure).toContain('summary:focus-visible');
  expect(disclosure).toContain('summary:hover');
  expect(disclosure).toContain('summary::-webkit-details-marker');
  expect(disclosure).toContain('[open] > summary > .ca-detail-disclosure-icon');
  const relatedLinks = disclosure.match(/[^{}]*\.ca-library-related > \.ca-detail-disclosure-body > \.btn\s*\{[^}]*\}/)?.[0] || '';
  expect(relatedLinks).toContain('font-size: var(--detail-meta)');
  expect(relatedLinks).toContain('padding: var(--space-1) 0');
  expect(disclosure.replace(relatedLinks, '')).not.toMatch(/font-size:|line-height:|!important/);
});

it('展开详情覆盖 display:contents，保持单列 head/body/footer', () => {
  const css = readFileSync(resolve('src/renderer/modules/cognition-assets/prototype.css'), 'utf8');
  expect(css).toMatch(/\.ca-library-asset-detail\{display:contents\}/);
  expect(css).toMatch(/\.ca-detail-expand \.ca-library-asset-detail\{display:flex !important/);
});

it('hides expanded mirrors without removing their layout slot and styles review results', () => {
  const read = (path: string) => readFileSync(resolve('src/renderer', path), 'utf8');
  const prototype = read('modules/cognition-assets/prototype.css');
  expect(prototype).toMatch(/\.ca-detail-mirror,\s*#ca-root #ca-scroll :is\(\.ca-activity-detail,\.ca-library-detail\)\.is-mirror\{visibility:hidden;pointer-events:none\}/);
  const details = read('modules/cognition-assets/details.css');
  expect(details).toMatch(/\.ca-review-content,\.ca-review-formation,\.ca-review-result,\.ca-activity-processing/);
  expect(details).toMatch(/\.ca-review-content,\.ca-review-formation,\.ca-review-result,\.ca-prototype-boundaries/);
});

