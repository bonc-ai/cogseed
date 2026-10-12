import { describe, expect, it } from 'vitest';

import { invokeHandlers } from '../../../src/main/ipc/contribution';

const ctx = { userId: 'contribution-ipc-user' };

describe('contribution IPC validation boundary', () => {
  it('registers the complete current client orchestration surface', () => {
    for (const channel of [
      'contribution.preflight', 'contribution.start', 'contribution.complete',
      'contribution.recheck', 'contribution.readFile', 'contribution.terms',
      'contribution.declare', 'contribution.confirm', 'contribution.submit',
      'contribution.abortUpload', 'contribution.submission', 'contribution.withdrawPending',
      'contribution.mine', 'contribution.requestWithdrawal',
      'contribution.withdrawalHistory', 'contribution.cancel', 'contribution.endAll',
    ]) expect(invokeHandlers[channel as keyof typeof invokeHandlers]).toBeTypeOf('function');
  });

  it('rejects malformed tokens and Hub identifiers before feature or network work', async () => {
    await expect(invokeHandlers['contribution.cancel']({ token: '../escape' }, ctx)).rejects.toThrow('invalid token');
    await expect(invokeHandlers['contribution.withdrawalHistory']({ content_id: '../escape' }, ctx)).rejects.toThrow('invalid content_id');
    await expect(invokeHandlers['contribution.withdrawPending']({ submission_id: 'a/b' }, ctx)).rejects.toThrow('invalid submission_id');
  });

  it('rejects empty and oversized withdrawal reasons before transport', async () => {
    await expect(invokeHandlers['contribution.requestWithdrawal']({ content_id: 'content_1', reason: '' }, ctx)).rejects.toThrow('invalid reason');
    await expect(invokeHandlers['contribution.requestWithdrawal']({ content_id: 'content_1', reason: 'x'.repeat(2001) }, ctx)).rejects.toThrow('invalid reason');
  });

  it('does not reveal whether another account owns a contribution session', async () => {
    await expect(invokeHandlers['contribution.recheck']({ token: 'aaaaaaaaaaaa' }, { userId: 'other-account' }))
      .rejects.toThrow('session not found');
  });
});
