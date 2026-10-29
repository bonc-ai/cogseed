/** The persisted-content contract is shared by candidate and asset boundaries. */
import { describe, expect, it } from 'vitest';
import {
  ContentContractError,
  RECALL_TEXT_LIMITS,
  assertContentWithinContract,
  contentExceedsContract,
  normalizeSingleLineText,
  normalizeStatementText,
  normalizeValueText,
} from '../../../../src/main/features/recall/content-contract';

describe('recall content contract', () => {
  it('normalizes line endings for bodies but preserves paragraph layout', () => {
    expect(normalizeStatementText('第一段\r\n\r\n第二段  \r\n')).toBe('第一段\n\n第二段');
    expect(normalizeValueText('  保留  内部空格  \n')).toBe('保留  内部空格');
    expect(normalizeSingleLineText('  a \n\t b  ')).toBe('a b');
  });

  it('accepts exactly 4000 characters and rejects 4001 with field metadata', () => {
    expect(assertContentWithinContract('甲'.repeat(4_000), 'statement')).toHaveLength(4_000);
    expect(contentExceedsContract('甲'.repeat(4_000), 'statement')).toBe(false);
    expect(contentExceedsContract('甲'.repeat(4_001), 'statement')).toBe(true);
    let caught: unknown;
    try {
      assertContentWithinContract('甲'.repeat(4_001), 'statement');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContentContractError);
    expect(caught).toMatchObject({
      field: 'statement',
      limit: RECALL_TEXT_LIMITS.statement,
      actual: 4_001,
    });
  });

  it('rejects empty required content and allows empty optional value', () => {
    expect(() => assertContentWithinContract('   ', 'statement')).toThrow('statement is empty');
    expect(assertContentWithinContract('', 'value', { allowEmpty: true })).toBe('');
  });
});
