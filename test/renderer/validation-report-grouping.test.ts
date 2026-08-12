/**
 * Grouping in the quality report modal.
 *
 * The validator emits one violation per match, which is right for a machine and
 * wrong for a person. Measured on the skill-sentry self-scan (a skill whose own
 * rule files contain the patterns it detects): 13 violations rendered as 13
 * cards, with `no_download_then_execute` appearing 4 times and its remediation
 * sentence repeated verbatim each time. Grouping by rule brings that to 8 cards
 * with the fix text stated once.
 *
 * The invariant that matters is not the count, though — it is that grouping
 * cannot soften a verdict. A rule seen at two levels keeps the more severe one,
 * or a display change would silently downgrade a security finding.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

interface Violation {
  rule?: string;
  level?: string;
  field?: string;
  snippet?: string;
  suggested_fix?: string;
}

interface Group {
  rule: string;
  level: string;
  occurrences: Array<{ field: string; snippet: string; suggested_fix: string }>;
}

/**
 * Load the classic script into a vm context, as the other renderer tests do.
 *
 * Only `function` declarations bind to the context — a top-level `const` does
 * not — so the display cap is asserted through rendered output rather than by
 * reading the constant.
 */
function loadReportView(): {
  _groupViolationsByRule: (v: Violation[]) => Group[];
  _renderViolationGroup: (g: Group) => string;
} {
  const context: Record<string, unknown> = {
    console,
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;'),
    window: {},
    document: {},
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  const code = fs.readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'modules', 'validation-report-view.js'),
    'utf8',
  );
  vm.runInContext(code, context, { filename: 'validation-report-view.js' });
  return context as never;
}

const v = (rule: string, level: string, field: string): Violation => ({
  rule, level, field, snippet: `snippet ${field}`, suggested_fix: `fix ${rule}`,
});

describe('validation report › grouping', () => {
  it('collapses repeats of one rule into a single group', () => {
    const { _groupViolationsByRule } = loadReportView();
    const groups = _groupViolationsByRule([
      v('no_credential_path_read', 'EXTREME', 'a.py:1'),
      v('no_credential_path_read', 'EXTREME', 'b.py:2'),
      v('no_credential_path_read', 'EXTREME', 'c.py:3'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].occurrences).toHaveLength(3);
  });

  it('keeps every location in the data even when rendering caps the list', () => {
    const { _groupViolationsByRule } = loadReportView();
    const groups = _groupViolationsByRule([
      v('r1', 'EXTREME', 'a:1'), v('r1', 'EXTREME', 'b:2'),
      v('r1', 'EXTREME', 'c:3'), v('r1', 'EXTREME', 'd:4'),
      v('r1', 'EXTREME', 'e:5'),
    ]);

    // All five retained, so the count and the "+N more" line are both truthful.
    expect(groups[0].occurrences.map((o) => o.field))
      .toEqual(['a:1', 'b:2', 'c:3', 'd:4', 'e:5']);
  });

  it('does not merge distinct rules', () => {
    const { _groupViolationsByRule } = loadReportView();
    const groups = _groupViolationsByRule([
      v('no_credential_path_read', 'EXTREME', 'a:1'),
      v('no_download_then_execute', 'EXTREME', 'b:2'),
    ]);

    expect(groups.map((g) => g.rule))
      .toEqual(['no_credential_path_read', 'no_download_then_execute']);
  });

  // The load-bearing case: grouping must never render an EXTREME finding under a
  // softer badge.
  it('keeps the most severe level when one rule spans levels', () => {
    const { _groupViolationsByRule } = loadReportView();
    const groups = _groupViolationsByRule([
      v('r1', 'LOW', 'a:1'),
      v('r1', 'EXTREME', 'b:2'),
    ]);

    expect(groups.some((g) => g.level === 'EXTREME')).toBe(true);
    expect(groups.some((g) => g.rule === 'r1' && g.level === 'LOW')).toBe(false);
  });

  it('states the fix once per rule rather than once per match', () => {
    const { _groupViolationsByRule, _renderViolationGroup } = loadReportView();
    const [group] = _groupViolationsByRule([
      v('no_credential_path_read', 'EXTREME', 'a:1'),
      v('no_credential_path_read', 'EXTREME', 'b:2'),
      v('no_credential_path_read', 'EXTREME', 'c:3'),
    ]);

    const html = _renderViolationGroup(group);
    const fixCount = html.split('fix no_credential_path_read').length - 1;
    expect(fixCount).toBe(1);
  });

  it('shows a count and a remainder line when locations exceed the cap', () => {
    const { _groupViolationsByRule, _renderViolationGroup } = loadReportView();
    const [group] = _groupViolationsByRule([
      v('r1', 'EXTREME', 'a:1'), v('r1', 'EXTREME', 'b:2'),
      v('r1', 'EXTREME', 'c:3'), v('r1', 'EXTREME', 'd:4'),
    ]);

    const html = _renderViolationGroup(group);
    // Fourth location is not printed, but its existence is disclosed. Asserted
    // on the rendered text rather than the i18n key: with `t` echoing keys the
    // helper takes its English fallback, and pinning the key would pass for the
    // wrong reason.
    expect(html).not.toContain('d:4');
    expect(html).toContain('1');
    expect(html.toLowerCase()).toContain('more');
  });

  it('handles an empty list', () => {
    const { _groupViolationsByRule } = loadReportView();
    expect(_groupViolationsByRule([])).toEqual([]);
  });

  // The validator does not always populate every field.
  it('tolerates violations missing rule or field', () => {
    const { _groupViolationsByRule, _renderViolationGroup } = loadReportView();
    const groups = _groupViolationsByRule([{ level: 'LOW' }, { rule: 'r1', level: 'LOW' }]);

    expect(groups.length).toBeGreaterThan(0);
    expect(() => groups.map(_renderViolationGroup).join('')).not.toThrow();
  });
});
