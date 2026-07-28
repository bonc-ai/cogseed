import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function load(name: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales', name), 'utf-8'));
}

describe('evolution i18n keys', () => {
  it('中英文都含 evolution 控制台键（扁平点键）', () => {
    for (const f of ['zh.json', 'en.json']) {
      const j = load(f);
      expect(j['sidebar.evolution']).toBeTypeOf('string');
      expect(j['evolution.title']).toBeTypeOf('string');
      expect(j['evolution.enter_title']).toBeTypeOf('string');
    }
  });
});
