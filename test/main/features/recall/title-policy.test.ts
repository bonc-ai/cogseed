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

  it('第 3 项只拒完整首句复制，相同首字和有意义的共同名词不证明截断', () => {
    expect(recallTitleIssue('回答统一使用中文', '回答统一使用中文')).toBe('prefix_overlap');
    expect(recallTitleIssue('Use Chinese in replies', 'Use Chinese in replies')).toBe('prefix_overlap');
    expect(recallTitleIssue('先列已知与未知', '先列已知与未知。再补齐缺口。')).toBe('prefix_overlap');
    expect(recallTitleIssue('Prepare a checklist', 'Prepare a checklist. Then validate it.')).toBe('prefix_overlap');
    expect(recallTitleIssue('遇到同类任务时先列清单', STATEMENT)).toBeUndefined();
    expect(recallTitleIssue('遇事不慌', STATEMENT)).toBeUndefined();
    expect(recallTitleIssue('星泽项目验收', '星泽项目验收需要负责人最终签字。')).toBeUndefined();
    expect(recallTitleIssue('Ada的审查责任', 'Ada负责审查需要提交的材料。')).toBeUndefined();
    expect(recallTitleIssue('Shared evidence', 'Short written summaries explain the evidence.')).toBeUndefined();
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
    // 相同首字不再覆盖真实标点问题。
    expect(recallTitleIssue('遇到同类任务时的处理，', STATEMENT)).toBe('punctuation_suffix');
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
    expect(() => assertCompliantAbilityAssetTitle('先列已知与未知', '先列已知与未知。再补齐缺口。')).toThrow(/invalid ability asset title/);
    expect(() => assertCompliantAbilityAssetTitle('清单先行。', STATEMENT)).toThrow(/invalid ability asset title/);
  });
});

describe('HTML 人工确认标题契约', () => {
  it('保留用户确认的标题，允许与正文首字相同及 80 字名称；模型生成仍走严格规则', async () => {
    const { assertReviewedAbilityAssetTitle } = await import('../../../../src/main/features/recall/title-policy');
    expect(() => assertReviewedAbilityAssetTitle('项目周报交付模板')).not.toThrow();
    expect(() => assertReviewedAbilityAssetTitle('标'.repeat(80))).not.toThrow();
    expect(() => assertReviewedAbilityAssetTitle('标'.repeat(81))).toThrow('1 to 80');
    expect(() => assertReviewedAbilityAssetTitle('')).toThrow();
    expect(recallTitleIssue('先列已知与未知', '先列已知与未知。再补齐缺口。')).toBe('prefix_overlap');
  });
});

describe('真实模型项目事实标题回归', () => {
  it('保留真实提取的项目名标题，正文及生效范围无需为起名改写', () => {
    const title = '星泽验收需宋遥签字';
    const statement = '星泽项目每次验收需要宋遥最终签字。自2026年9月22日起，宋遥是星泽项目的验收负责人；后续准备星泽项目验收材料时应按此找宋遥签字。此规则仅适用于星泽项目，不能套用到其他项目。';
    expect(recallTitleIssue(title, statement)).toBeUndefined();
    expect(() => assertCompliantAbilityAssetTitle(title, statement)).not.toThrow();
    // Proper nouns do not exempt genuine length or punctuation defects.
    expect(recallTitleIssue('星泽验收负责人签字以及材料准备完整流程', statement)).toBe('too_long');
    expect(recallTitleIssue(`${title}…`, statement)).toBe('punctuation_suffix');
  });
});
