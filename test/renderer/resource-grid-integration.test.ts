import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rendererRoot = resolve(__dirname, '../../src/renderer');
const read = (file: string) => readFileSync(resolve(rendererRoot, file), 'utf8');

describe('shared resource grid integration', () => {
  it('uses the shared grid in the gallery and every requested real page', () => {
    expect(read('component-gallery.html')).toContain('class="gallery-resource-grid ui-resource-grid"');
    const gallery = read('component-gallery.js');
    for (const action of ['继续工作', '使用模板', '使用智能体', '使用技能', '连接账户', '查看记录']) {
      expect(gallery).toContain(`action: '${action}'`);
    }

    const index = read('index.html');
    expect(index).toContain('class="agents-grid ui-resource-grid"');
    expect(index).toContain('class="skills-grid ui-resource-grid"');
    expect(index.match(/class="connectors-grid ui-resource-grid"/g)).toHaveLength(2);

    const workspace = read('modules/workspace.js');
    expect(workspace).toContain('ws-space-grid ui-resource-grid');
    expect(workspace.match(/ws-template-grid[^"`]*ui-resource-grid/g)).toHaveLength(2);
    expect(read('modules/auto.js')).toContain('auto-tpl-grid ui-resource-grid');
    expect(read('modules/agents.js')).toContain('agents-source-section-grid ui-resource-grid');
    expect(read('modules/skills.js').match(/skills-source-section-grid ui-resource-grid/g)).toHaveLength(3);
  });

  it('keeps the responsive layout contract in shared production CSS', () => {
    const css = read('ui-components.css');
    const rule = css.slice(css.indexOf('.ui-resource-grid {'), css.indexOf('.ui-resource-card {'));
    expect(rule).toContain('repeat(auto-fill');
    expect(rule).toContain('var(--card-width-min)');
    expect(rule).toContain('var(--card-grid-gap)');
    expect(rule).toContain('max-width: var(--card-grid-width-max)');
    expect(rule).toContain('align-items: stretch');
    expect(rule).toContain('.ui-resource-grid[class] > *');
    expect(rule).toContain('max-width: none');
  });
});
