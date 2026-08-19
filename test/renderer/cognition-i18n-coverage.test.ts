/**
 * 认知资产域的词条必须四语齐全。
 *
 * `_cognitionText(key, fallback)` / `_t(key, fallback)` 取不到译文时退回**代码里
 * 的中文兜底**，所以缺词条在中文界面上完全看不出来——英文 / 日文 / 葡文界面才
 * 会突然冒出一句中文，而那时改动早就合并了。审计一次补齐 74 条之后，用这条
 * 机械门禁钉住：认知资产、Recall、个人本体这三域的键，四个语言文件都要有。
 * 扫描覆盖 `_cognitionText / _t / _tv / t / _label` 调用式与 `titleKey /
 * descriptionKey` 属性式；间接变量写法（先赋值再传给 `_cognitionText`）扫不到，
 * 代码应内联成直接调用。
 *
 * 只管这三域的前缀。全库别处曾经的 ja/pt 缺口（357 条，已随本轮补完）
 * 不在这里连坐。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const LOCALES = ['zh', 'en', 'ja', 'pt'] as const;
const PREFIXES = ['cognition.', 'recall.', 'personalOntology.'];

const tables = Object.fromEntries(LOCALES.map((name) => [
  name,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${name}.json`), 'utf8')) as Record<string, unknown>,
])) as Record<typeof LOCALES[number], Record<string, unknown>>;

/** 渲染层里所有取词形式的键。取词家族包含四类写法，漏一类就放走一批缺口：
 * - 函数调用：`_cognitionText('k'` / `_t('k'` / `_tv('k'` / `t('k'` / `_label('k'`
 * - 属性式：`titleKey: 'k'` / `descriptionKey: 'k'`（渲染层把标题/说明键挂在对象上）
 *
 * 间接写法（`const key = ... ? 'k' : ...` 再传给 `_cognitionText(key)`）扫不到，
 * 代码里应直接内联成 `_cognitionText('k', ...)` 调用，让这条扫描能看见。 */
function referencedKeys(): string[] {
  const callPattern = /(?:_cognitionText|_t|_tv|_label|\bt)\(\s*['"]([A-Za-z0-9_.]+)['"]/g;
  const propPattern = /(?:titleKey|descriptionKey)\s*:\s*['"]([A-Za-z0-9_.]+)['"]/g;
  const keys = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(callPattern)) {
        if (PREFIXES.some((prefix) => match[1].startsWith(prefix))) keys.add(match[1]);
      }
      for (const match of source.matchAll(propPattern)) {
        if (PREFIXES.some((prefix) => match[1].startsWith(prefix))) keys.add(match[1]);
      }
    }
  };
  walk(path.join(root, 'src/renderer/modules'));
  return [...keys].sort();
}

const placeholders = (value: unknown) => (typeof value === 'string'
  ? [...new Set(value.match(/\{\w+\}/g) || [])].sort()
  : []);

describe('认知域词条覆盖', () => {
  const keys = referencedKeys();

  it('扫到了真实的取词点——解析失败会让下面两条变成空断言', () => {
    expect(keys.length).toBeGreaterThan(600);
    expect(keys).toContain('cognition.candidate_confirm_scoped');
    // 新扫进来的两种写法也要真的有键被扫到，否则同样会退化成空断言：
    // `_label('recall.projection...')`（卡片组件）与 `titleKey: 'personalOntology...'`（属性式）。
    expect(keys).toContain('recall.projection.title');
    expect(keys).toContain('personalOntology.ontology_identity');
  });

  it('四语都有，缺一门就会退回代码里的中文兜底', () => {
    const gaps = keys.flatMap((key) => LOCALES
      .filter((locale) => !(key in tables[locale]))
      .map((locale) => `${locale}:${key}`));
    expect(gaps).toEqual([]);
  });

  it('占位符跟着一起翻译，不被丢掉', () => {
    // `{count}` 掉了不会报错，只会让那句话少掉一个数字——静默且难查。
    const mismatches = keys.flatMap((key) => LOCALES
      .filter((locale) => locale !== 'zh' && key in tables[locale] && key in tables.zh)
      .filter((locale) => placeholders(tables[locale][key]).join() !== placeholders(tables.zh[key]).join())
      .map((locale) => `${locale}:${key}`));
    expect(mismatches).toEqual([]);
  });
});
