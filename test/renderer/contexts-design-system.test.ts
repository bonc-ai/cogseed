import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/contexts.js'), 'utf8');

describe('contexts design-system integration', () => {
  it('routes all visible controls through shared Renderer primitives', () => {
    expect((source.match(/<(?:button|input|textarea|select)\b/gi) || [])).toHaveLength(0);
    expect(source).toContain('function _ctxButton(options)');
    expect(source).toContain('function _ctxIconButton(options)');
    expect(source).toContain('function _ctxInput(options)');
  });

  it('uses shared roles for tree actions, batch actions, and destructive viewer actions', () => {
    expect(source).toContain("className: 'ctx-row-menu-btn'");
    expect(source).toContain("'data-library-batch-organize': ''");
    expect(source).toContain("className: 'library-batch-clear'");
    expect(source).toContain("role: 'danger', size: 'sm', attrs: { id: 'ctx-viewer-del' }");
    expect(source).toContain("role: 'primary', attrs: { id: 'ctx-viewer-reveal-big' }");
  });

  it('keeps inline rename fields on the shared input contract', () => {
    expect(source).toContain("className: 'ctx-tree-rename-input'");
    expect(source).toContain("attrs: { autocomplete: 'off', spellcheck: 'false' }");
  });
});
