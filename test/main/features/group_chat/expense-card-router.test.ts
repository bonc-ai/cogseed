import { describe, expect, it } from 'vitest';

import { extractExpenseCardFromFinal } from '../../../../src/main/features/group_chat/router';

describe('reimbursement chat-card protocol', () => {
  it('extracts a secure setup card without carrying credentials in the message', () => {
    const result = extractExpenseCardFromFinal('Set up Feishu first.\n<expense-setup-form />', 'c045605cb916');
    expect(result).toEqual({
      cleanText: 'Set up Feishu first.',
      setup: { agent_id: 'c045605cb916' },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('extracts only one well-formed submit card and scopes it to the emitting agent', () => {
    const result = extractExpenseCardFromFinal('Ready.\n<expense-submit-form case_id="exp_abc123" />', 'c045605cb916');
    expect(result).toEqual({
      cleanText: 'Ready.',
      submit: { agent_id: 'c045605cb916', case_id: 'exp_abc123' },
    });
  });

  it('does not turn duplicate, malformed, or fenced examples into host controls', () => {
    expect(extractExpenseCardFromFinal('<expense-setup-form />\n<expense-setup-form />', 'c045605cb916').setup).toBeUndefined();
    expect(extractExpenseCardFromFinal('<expense-submit-form case_id="bad/path" />', 'c045605cb916').submit).toBeUndefined();
    expect(extractExpenseCardFromFinal('```xml\n<expense-setup-form />\n```', 'c045605cb916').setup).toBeUndefined();
  });
});
