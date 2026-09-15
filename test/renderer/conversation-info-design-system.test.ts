import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');

describe('conversation info design-system integration', () => {
  it('routes ordinary actions through shared button primitives', () => {
    expect(source).toContain('function _button(options)');
    expect(source).toContain('function _iconButton(options)');
    expect(source).toContain("role: 'danger', size: 'sm', className: 'conversation-info-cogseed-action is-danger'");
    expect(source).toContain("className: 'conversation-info-file-menu-btn'");
    expect(source).toContain("className: 'conversation-info-agent-activity-refresh'");
    expect(source).toContain("role: 'primary', size: 'sm', attrs: { 'data-candidate-promote': c.id }");
  });

  it('keeps only attachment, filter, disclosure, and tab composites native', () => {
    expect((source.match(/<(?:button|input|textarea|select)\b/gi) || [])).toHaveLength(6);
    expect(source).toContain('class="ci-attach-row"');
    expect(source).toContain('<select data-protocol-filter=');
    expect(source).toContain('class="conversation-info-carried-receipt-toggle"');
    expect((source.match(/class="conversation-info-carried-runs-toggle"/g) || [])).toHaveLength(2);
    expect(source).toContain('class="run-context-tab');
  });

  it('uses shared icon buttons instead of text glyphs for file menus and refresh', () => {
    expect(source).toContain("icon: 'more-horizontal'");
    expect(source).toContain("icon: 'refresh-cw'");
    expect(source).not.toContain('aria-label="${escapeHtml(moreTitle)}">⋯</button>');
  });
});
