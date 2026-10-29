/** 标签库前端退役契约：旧双态加载竞态不再有可触发入口。 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const core = readFileSync(resolve(root, 'src/renderer/modules/cognition-assets/core.js'), 'utf8');
const app = readFileSync(resolve(root, 'src/renderer/modules/cognition-assets/app.js'), 'utf8');
const views = readFileSync(resolve(root, 'src/renderer/modules/cognition-assets/views.js'), 'utf8');

describe('retired tag library frontend', () => {
  it('has no active or retired tag loader, so responses cannot race to overwrite UI state', () => {
    expect(core).not.toContain('NS.loadTags =');
    expect(core).not.toContain("api.call('recall.tags.list'");
    expect(app).not.toContain('NS.loadTags(');
    expect(app).not.toContain("case 'tag-manage'");
  });

  it('has no tag management control while legacy tag routes are stripped during navigation', () => {
    expect(views).not.toContain('data-act="tag-manage"');
    expect(views).not.toContain('data-act="tag-batch-run"');
    expect(core).toContain("for (const key of ['tagFilter', 'tagMode', 'tagUntagged', 'tagSelect', 'tagOverlay']) delete target[key]");
  });
});
