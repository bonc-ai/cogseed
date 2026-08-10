import * as fs from 'node:fs';
import * as path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

describe('renderer stylesheet contract', () => {
  it('parses the complete stylesheet so late feature rules are not discarded', () => {
    const file = path.resolve(process.cwd(), 'src/renderer/style.css');
    const source = fs.readFileSync(file, 'utf8');
    expect(() => postcss.parse(source, { from: file })).not.toThrow();
  });

  it('contains top-level Mate workbench rules after parsing', () => {
    const file = path.resolve(process.cwd(), 'src/renderer/style.css');
    const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
    const selectors = new Set<string>();
    root.walkRules((rule) => {
      for (const selector of rule.selectors || []) selectors.add(selector.trim());
    });
    expect(selectors.has('.mate-workbench')).toBe(true);
    expect(selectors.has('.mate-workbench-grid')).toBe(true);
    expect(selectors.has('.mate-workbench-section')).toBe(true);
    expect(selectors.has('.mate-workbench-card')).toBe(true);
  });
});
