/** 旧内容方案文案必须在四份语言包里成套存在。界面当前可选中文和英文，
 *  日/葡语保持词条一致，避免后续启用时出现半套文案。 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('旧内容整理方案语言包', () => {
  it('四份语言包保持同一组旧内容方案词条', () => {
    const dir = path.resolve(__dirname, '../../src/renderer/locales');
    const keys = (lang: string) => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8')))
      .filter(key => key.startsWith('cognition.old_content_plan')).sort();
    const base = keys('zh');
    expect(base.length).toBeGreaterThanOrEqual(80);
    for (const lang of ['en', 'ja', 'pt']) expect(keys(lang), lang).toEqual(base);
  });
});
