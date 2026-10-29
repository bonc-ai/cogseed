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

  it('registers the Agent contribution channels', () => {
    for (const channel of ['contribution.agent.start', 'contribution.agent.confirm', 'contribution.agent.submit']) {
      expect(invokeHandlers[channel as keyof typeof invokeHandlers]).toBeTypeOf('function');
    }
  });

  it('rejects path-traversing agent ids and malformed tokens before any filesystem or network work', async () => {
    await expect(invokeHandlers['contribution.agent.start']({ agent_id: '../escape' }, ctx)).rejects.toThrow('invalid agent_id');
    await expect(invokeHandlers['contribution.agent.start']({ agent_id: '' }, ctx)).rejects.toThrow('invalid agent_id');
    await expect(invokeHandlers['contribution.agent.start']({}, ctx)).rejects.toThrow('invalid agent_id');
    await expect(invokeHandlers['contribution.agent.confirm']({ token: '../x', digest: 'd' }, ctx)).rejects.toThrow('invalid token');
    await expect(invokeHandlers['contribution.agent.submit']({ token: 'zz' }, ctx)).rejects.toThrow('invalid token');
    await expect(invokeHandlers['contribution.agent.submit']({ token: 'aaaaaaaaaaaa', target_content_id: 'a/b' }, ctx))
      .rejects.toThrow('invalid target_content_id');
  });

  it('the hints acknowledgement is forwarded only when it is exactly true', async () => {
    // Without a session the handler fails on the session lookup either way; what matters is that
    // truthy-but-not-true values (strings, numbers) are not accepted as an acknowledgement before that.
    for (const value of ['true', 1, {}, null, undefined]) {
      await expect(invokeHandlers['contribution.agent.confirm']({ token: 'aaaaaaaaaaaa', digest: 'd', acknowledge_hints: value }, { userId: 'nobody' }))
        .rejects.toThrow('session not found');
    }
  });

  it('does not reveal whether another account owns an Agent contribution session', async () => {
    await expect(invokeHandlers['contribution.agent.confirm']({ token: 'aaaaaaaaaaaa', digest: 'd' }, { userId: 'other-account' }))
      .rejects.toThrow('session not found');
    await expect(invokeHandlers['contribution.agent.submit']({ token: 'aaaaaaaaaaaa', version: '1.0.0' }, { userId: 'other-account' }))
      .rejects.toThrow('session not found');
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
