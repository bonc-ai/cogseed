import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Mate workbench renderer IPC contract', () => {
  it('uses the allow-listed window.orkas IPC bridge and does not reference an undeclared invoke global', () => {
    const file = path.resolve(process.cwd(), 'src/renderer/modules/mate-workbench.js');
    const source = fs.readFileSync(file, 'utf8');
    expect(source).toContain('window.orkas.invoke(\'desktop_workbench.get\'');
    expect(source).toContain('window.orkas.invoke(\'personal_context.sync.start\'');
    expect(source).not.toMatch(/(?<![.\w])invoke\(/);
  });

  it('has a localized detail for the visible load failure state in every renderer locale', () => {
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const file = path.resolve(process.cwd(), `src/renderer/locales/${locale}.json`);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(typeof data['mate_workbench.load_failed_detail']).toBe('string');
      expect(String(data['mate_workbench.load_failed_detail']).trim()).not.toBe('');
    }
  });
});
