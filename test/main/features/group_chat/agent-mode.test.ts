import { describe, it, expect } from 'vitest';
import { extractAgentFieldBlocks } from '../../../../src/main/features/agents';

describe('extractAgentFieldBlocks mode', () => {
  it('parses <mode>governed</mode>', () => {
    const text = '<agent>\n<name>报销审核</name>\n<mode>governed</mode>\n<workflow>你是报销审核。</workflow>\n</agent>';
    const { blocks } = extractAgentFieldBlocks(text);
    expect(blocks[0]?.mode).toBe('governed');
  });
  it('parses <mode>direct</mode>', () => {
    const { blocks } = extractAgentFieldBlocks('<agent>\n<mode>direct</mode>\n<name>a</name>\n<workflow>w</workflow>\n</agent>');
    expect(blocks[0]?.mode).toBe('direct');
  });
  it('omits mode when absent (backward compatible)', () => {
    const { blocks } = extractAgentFieldBlocks('<agent>\n<name>a</name>\n<workflow>w</workflow>\n</agent>');
    expect(blocks[0]?.mode).toBeUndefined();
  });
  it('drops invalid mode values', () => {
    const { blocks } = extractAgentFieldBlocks('<agent>\n<mode>evil</mode>\n<name>a</name>\n<workflow>w</workflow>\n</agent>');
    expect(blocks[0]?.mode).toBeUndefined();
  });
});
