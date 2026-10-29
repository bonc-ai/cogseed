/**
 * transcript_glossary_import — CSV / JSON 导入解析 + 清空前备份
 *
 * 守的不变量：
 *   - CSV 的引号/转义/表头/CRLF 不会把字段切错（否则会导入一堆错词）；
 *   - 单行不合法只跳过，不拖垮整次导入；
 *   - JSON 兼容裸数组、`{entries}` 和旧版 `{payload:{entries}}`；
 *   - 清空必先备份，且备份含人名（导出默认排除人名，备份不能也排除）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { parseGlossaryImportText, splitCsvRows } from '../../../src/main/features/transcript_glossary_import';
import {
  backupGlossary,
  clearGlossary,
  listEntries,
  upsertEntry,
} from '../../../src/main/features/transcript_glossary';

let uid = '';
beforeEach(() => {
  uid = `u_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe('CSV 解析', () => {
  it('带表头、引号、逗号和 CRLF 也能正确切分', () => {
    const text = 'wrong,correct,kind,riskLevel\r\n'
      + '"hello, world",Hello World,term,low\r\n'
      + 'coxy,Cogseed,product,low\r\n';
    expect(splitCsvRows(text)[1]).toEqual(['hello, world', 'Hello World', 'term', 'low']);
    const parsed = parseGlossaryImportText(text);
    expect(parsed.format).toBe('csv');
    expect(parsed.entries).toEqual([
      { wrong: 'hello, world', correct: 'Hello World', kind: 'term', riskLevel: 'low' },
      { wrong: 'coxy', correct: 'Cogseed', kind: 'product', riskLevel: 'low' },
    ]);
    expect(parsed.skipped).toBe(0);
  });

  it('没有表头时按 wrong,correct[,kind[,risk]] 读取', () => {
    const parsed = parseGlossaryImportText('foo,Foo\nbar,Bar,term,high');
    expect(parsed.entries).toEqual([
      { wrong: 'foo', correct: 'Foo' },
      { wrong: 'bar', correct: 'Bar', kind: 'term', riskLevel: 'high' },
    ]);
  });

  it('空 wrong/correct 跳过该行；未知 kind/risk 只忽略该字段', () => {
    const parsed = parseGlossaryImportText('wrong,correct,kind,riskLevel\nfoo,,term,low\n,,,\nbar,Bar,nope,urgent\nbaz,Baz,product,low');
    // 未知 kind/risk 不丢整行：只忽略该字段，让引擎自己派生风险（不能靠导入降风险）。
    expect(parsed.entries).toEqual([
      { wrong: 'bar', correct: 'Bar' },
      { wrong: 'baz', correct: 'Baz', kind: 'product', riskLevel: 'low' },
    ]);
    expect(parsed.skipped).toBe(1);
  });

  it('转义引号按 RFC4180 还原', () => {
    const parsed = parseGlossaryImportText('wrong,correct\n"say ""hi""",Say Hi');
    expect(parsed.entries).toEqual([{ wrong: 'say "hi"', correct: 'Say Hi' }]);
  });
});

describe('JSON 解析', () => {
  it('支持 {entries} 与裸数组', () => {
    expect(parseGlossaryImportText('{"entries":[{"wrong":"foo","correct":"Foo"}]}').entries)
      .toEqual([{ wrong: 'foo', correct: 'Foo' }]);
    expect(parseGlossaryImportText('[{"wrong":"bar","correct":"Bar"}]').entries)
      .toEqual([{ wrong: 'bar', correct: 'Bar' }]);
  });

  it('兼容旧版 {payload:{entries}}', () => {
    const parsed = parseGlossaryImportText('{"payload":{"entries":[{"wrong":"baz","correct":"Baz","kind":"term"}]}}');
    expect(parsed.entries).toEqual([{ wrong: 'baz', correct: 'Baz', kind: 'term' }]);
  });

  it('形状不对或不是合法 JSON 会抛错', () => {
    expect(() => parseGlossaryImportText('{"foo":1}')).toThrow();
    expect(() => parseGlossaryImportText('{"entries": [')).toThrow();
  });

  it('空文本返回空结果，不抛错', () => {
    expect(parseGlossaryImportText('  \n ')).toEqual({ format: 'csv', entries: [], skipped: 0 });
  });
});

describe('清空前备份', () => {
  it('备份文件包含当前词条（含人名），清空后词表为空', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    upsertEntry(uid, { wrong: '张示例', correct: '张示例', kind: 'people' });
    expect(listEntries(uid)).toHaveLength(2);

    const backup = backupGlossary(uid);
    expect(backup.entries).toBe(2);
    expect(fs.existsSync(backup.backupPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(backup.backupPath, 'utf8'));
    expect(saved.entries).toHaveLength(2);
    expect(saved.entries.some((entry: { kind?: string }) => entry.kind === 'people')).toBe(true);

    const cleared = clearGlossary(uid);
    expect(cleared.cleared).toBe(2);
    expect(fs.existsSync(cleared.backupPath)).toBe(true);
    expect(listEntries(uid)).toHaveLength(0);
  });

  it('空词表也能清空（仍先落一份空备份）', () => {
    const cleared = clearGlossary(uid);
    expect(cleared.cleared).toBe(0);
    expect(fs.existsSync(cleared.backupPath)).toBe(true);
    expect(listEntries(uid)).toHaveLength(0);
  });
});
