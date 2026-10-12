import { describe, expect, it } from 'vitest';

import {
  ABILITY_ASSET_TITLE_MAX_HAN,
  ABILITY_ASSET_TITLE_MAX_OTHER,
  abilityAssetTitleLimit,
  assertCompliantAbilityAssetTitle,
  recallTitleIssue,
} from '../../../../src/main/features/recall/title-policy';

const STATEMENT = '遇到同类任务时，先列出已知与未知，再补齐缺口。';

describe('recallTitleIssue（标题规范 3.1 机器可判四项，全模块唯一判定）', () => {
  it('合规标题返回 undefined', () => {
    expect(recallTitleIssue('清单先行', STATEMENT)).toBeUndefined();
    expect(recallTitleIssue('Evidence-backed decisions', 'Keep decision records with evidence.')).toBeUndefined();
  });

  it('第 1 项：空标题（含纯空白）不合规', () => {
    expect(recallTitleIssue('', STATEMENT)).toBe('empty');
    expect(recallTitleIssue('   ', STATEMENT)).toBe('empty');
  });

  it('第 2 项：中文 ≤16 字、其他语言 ≤60 字符（含任一汉字即按中文口径）', () => {
    expect('标'.repeat(ABILITY_ASSET_TITLE_MAX_HAN)).toHaveLength(16);
    expect(recallTitleIssue('标'.repeat(16), STATEMENT)).toBeUndefined();
    expect(recallTitleIssue('标'.repeat(17), STATEMENT)).toBe('too_long');
    // 其他语言 60 字符：上限内合规、61 不合规。
    expect(recallTitleIssue('a'.repeat(ABILITY_ASSET_TITLE_MAX_OTHER), 'Statement body.')).toBeUndefined();
    expect(recallTitleIssue('a'.repeat(ABILITY_ASSET_TITLE_MAX_OTHER + 1), 'Statement body.')).toBe('too_long');
    // 混合文本含汉字 → 按中文 16 字口径（与 candidate-service fallbackCandidateTitle 同判据）。
    expect(abilityAssetTitleLimit('结论先行 Conclusion')).toBe(16);
    expect(abilityAssetTitleLimit('Conclusion only')).toBe(60);
    expect(recallTitleIssue('结论先行 Conclusion', STATEMENT)).toBeUndefined();
  });

  it('第 3 项：与正文公共前缀 ≥1 字即不合规（正文首句标题正是老病形态）', () => {
    expect(recallTitleIssue('遇到同类任务时先列清单', STATEMENT)).toBe('prefix_overlap');
    // 只有第一个字相同也算（判定口径是 ≥1 字，不是「大段重复」）。
    expect(recallTitleIssue('遇事不慌', STATEMENT)).toBe('prefix_overlap');
    // 正文为空/缺失时无从重复，不触发本项。
    expect(recallTitleIssue('遇事不慌', '')).toBeUndefined();
    expect(recallTitleIssue('遇事不慌', undefined)).toBeUndefined();
  });

  it('第 4 项：以标点结尾不合规（含句号、逗号、省略号、括号收边）', () => {
    expect(recallTitleIssue('清单先行。', STATEMENT)).toBe('punctuation_suffix');
    expect(recallTitleIssue('清单先行，', STATEMENT)).toBe('punctuation_suffix');
    expect(recallTitleIssue('清单先行;', STATEMENT)).toBe('punctuation_suffix');
    expect(recallTitleIssue('清单先行?', STATEMENT)).toBe('punctuation_suffix');
    // makeDisplayTitle 的截断省略号是实测高频形态，必须命中。
    expect(recallTitleIssue('很长的一段标题被截断之后…', STATEMENT)).toBe('punctuation_suffix');
    expect(recallTitleIssue('可复用经验（通用）', STATEMENT)).toBe('punctuation_suffix');
    expect(recallTitleIssue('结论"冻结"', STATEMENT)).toBe('punctuation_suffix');
  });

  it('判定顺序：空 → 超长 → 前缀重复 → 标点结尾（返回首个命中）', () => {
    // 同时超长且以标点结尾：先报超长。
    expect(recallTitleIssue(`${'标'.repeat(20)}。`, STATEMENT)).toBe('too_long');
    // 同时前缀重复且标点结尾：先报前缀重复。
    expect(recallTitleIssue('遇到同类任务时的处理，', STATEMENT)).toBe('prefix_overlap');
  });

  it('空白按落盘形态归一后判定（与写入口 bounded 同款折叠）', () => {
    expect(recallTitleIssue('  清单   先行  ', STATEMENT)).toBeUndefined();
    // 两端空白不占长度：17 字 + 空白仍超长；16 字带空白不超长。
    expect(recallTitleIssue(`  ${'标'.repeat(17)}  `, STATEMENT)).toBe('too_long');
    expect(recallTitleIssue(` ${'标'.repeat(16)} `, STATEMENT)).toBeUndefined();
  });
});

describe('assertCompliantAbilityAssetTitle（收口闸门用的可读错误）', () => {
  it('合规时不抛', () => {
    expect(() => assertCompliantAbilityAssetTitle('清单先行', STATEMENT)).not.toThrow();
  });

  it('不合规时抛 invalid ability asset title 前缀错误（classifyAbilityAssetWriteFailure 归 schema）', () => {
    expect(() => assertCompliantAbilityAssetTitle('', STATEMENT)).toThrow(/invalid ability asset title/);
    expect(() => assertCompliantAbilityAssetTitle('标'.repeat(17), STATEMENT)).toThrow(/invalid ability asset title/);
    expect(() => assertCompliantAbilityAssetTitle('遇到同类', STATEMENT)).toThrow(/invalid ability asset title/);
    expect(() => assertCompliantAbilityAssetTitle('清单先行。', STATEMENT)).toThrow(/invalid ability asset title/);
  });
});
