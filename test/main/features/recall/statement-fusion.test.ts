import { describe, expect, it } from 'vitest';
import { diceOverlap, fuseStatements, makeDisplayTitle, overlapCoefficient } from '../../../../src/main/features/recall/statement-fusion';

// 融合生成器（查重金字塔 L1/L2 落点）：update 的正文从"覆盖"改为"合成"。
// 纯函数测试，全部离线。

describe('diceOverlap', () => {
  it('returns 1 for identical text and 0 for disjoint text', () => {
    expect(diceOverlap('周报必须按固定格式发送。', '周报必须按固定格式发送。')).toBe(1);
    expect(diceOverlap('数据库迁移前先备份。', 'The quick brown fox。')).toBe(0);
  });

  it('grows with shared content', () => {
    const a = '周报三个固定板块。';
    const b = '周报包含三个固定板块：进展、风险、计划。';
    const c = '完全不相关的一句话在这里。';
    expect(diceOverlap(a, b)).toBeGreaterThan(diceOverlap(a, c));
  });

  it('overlap coefficient is not diluted by length difference', () => {
    const short = '周报三个固定板块。';
    const expanded = '周报固定使用三个板块：本周进展、风险与依赖、下周计划。';
    expect(overlapCoefficient(short, expanded)).toBeGreaterThan(diceOverlap(short, expanded));
    expect(overlapCoefficient(short, expanded)).toBeGreaterThan(0.45);
  });
});

describe('fuseStatements', () => {
  it('empty old statement adopts the incoming text directly', () => {
    const result = fuseStatements('', '周报固定每周五发出。');
    expect(result.statement).toBe('周报固定每周五发出。');
    expect(result.added).toEqual(['周报固定每周五发出。']);
    expect(result.replaced).toEqual([]);
  });

  it('appends genuinely new sentences without touching the old body', () => {
    const result = fuseStatements(
      '接口变更后必须同步更新对应文档。',
      '数据库迁移脚本执行前必须先做全量备份。',
    );
    expect(result.statement).toBe('接口变更后必须同步更新对应文档。数据库迁移脚本执行前必须先做全量备份。');
    expect(result.added).toEqual(['数据库迁移脚本执行前必须先做全量备份。']);
    expect(result.replaced).toEqual([]);
    expect(result.keptCount).toBe(1);
  });

  it('keeps the longer restatement in place when the new sentence repeats the old one with more detail', () => {
    const result = fuseStatements(
      '周报三个固定板块。',
      '周报固定使用三个板块：本周进展、风险与依赖、下周计划。',
    );
    expect(result.statement).toContain('周报固定使用三个板块：本周进展、风险与依赖、下周计划。');
    expect(result.statement).not.toContain('周报三个固定板块。周报');
    expect(result.added).toEqual([]);
    expect(result.keptCount).toBe(1);
  });

  it('replaces an updated wording of the same topic with the new sentence', () => {
    const result = fuseStatements(
      '周报每周五晚发出。',
      '周报每周六上午发出。',
    );
    expect(result.statement).toBe('周报每周六上午发出。');
    expect(result.replaced).toHaveLength(1);
    expect(result.replaced[0].newSentence).toBe('周报每周六上午发出。');
    expect(result.added).toEqual([]);
  });

  it('fuses a mixed update: one restatement plus one increment', () => {
    const result = fuseStatements(
      '周报三个固定板块。',
      '周报固定使用三个板块：本周进展、风险与依赖、下周计划。发出前需要核对上周承诺项的完成情况。',
    );
    expect(result.statement).toContain('周报固定使用三个板块');
    expect(result.statement).toContain('发出前需要核对上周承诺项的完成情况。');
    expect(result.added).toEqual(['发出前需要核对上周承诺项的完成情况。']);
    expect(result.keptCount).toBe(1);
  });

  it('caps the fused statement at 4000 characters and reports truncation', () => {
    const longSentence = '字'.repeat(4_100) + '。';
    const result = fuseStatements(longSentence, '另一句全新的增量内容。');
    expect(result.statement.length).toBe(4_000);
    expect(result.truncated).toBe(true);
  });

describe('makeDisplayTitle', () => {
  it('uses the first complete sentence as the title', () => {
    expect(makeDisplayTitle('替用户改写其自有底稿类材料时，数字与事实必须零新增。但凡涉及口径升级，需要先确认。'))
      .toBe('替用户改写其自有底稿类材料时，数字与事实必须零新增。');
  });

  it('truncates with an ellipsis only when a single sentence exceeds the cap', () => {
    const long = '周'.repeat(100) + '。';
    expect(makeDisplayTitle(long, 60)).toBe('周'.repeat(59) + '…');
    expect(makeDisplayTitle(long, 60)).not.toContain('。');
  });
});

});
