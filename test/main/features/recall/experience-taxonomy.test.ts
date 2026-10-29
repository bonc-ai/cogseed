// specs/016 T005：experienceTypeOf 把沉淀分支标签映射到经验目录类型轴。
// 未知输入必须兜底 uncategorized 而不是抛错——沉淀线的历史 kind 与未来新增
// kind 都可能出现，类型判不出不阻断沉淀。
// 2026-10-07 随 S1 下沉从 kstar/extraction-service 移入认知层（recall/experience-taxonomy）。
import { describe, expect, it } from 'vitest';
import { experienceTypeOf } from '../../../../src/main/features/recall/experience-taxonomy';

describe('experienceTypeOf（specs/016 T005）', () => {
  it('三个既有分支标签各归其类', () => {
    expect(experienceTypeOf('lesson')).toBe('lesson');
    expect(experienceTypeOf('workflow')).toBe('workflow');
    expect(experienceTypeOf('gap')).toBe('gap');
  });

  it('未知输入兜底 uncategorized，不抛错（null/undefined/未来 kind/对象都不炸）', () => {
    expect(experienceTypeOf('unknown_kind')).toBe('uncategorized');
    expect(experienceTypeOf(undefined)).toBe('uncategorized');
    expect(experienceTypeOf(null)).toBe('uncategorized');
    expect(experienceTypeOf('')).toBe('uncategorized');
    expect(experienceTypeOf({ kind: 'lesson' })).toBe('uncategorized');
  });
});
