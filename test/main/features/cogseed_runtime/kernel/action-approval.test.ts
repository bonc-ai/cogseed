import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeActionApprovalClient,
  runWithRuntimeActionApprovalGrant,
} from '../../../../../src/main/features/cogseed_runtime/kernel/tools/action-approval';

function clientWithHost(call?: (...args: any[]) => Promise<any>) {
  return createRuntimeActionApprovalClient({
    requestId: 'start-ack-request', runtimeSessionId: 'mruntime-start-ack', actor: 'receiver',
    ...(call ? { hostToolClient: { call } } : {}),
  });
}

describe('runtime approval start acknowledgement regression', () => {
  it.each(['expired', 'transport', 'malformed', 'unacknowledged', 'error-with-ok', 'missing-host'])(
    'does not execute without affirmative host start acknowledgement: %s', async failure => {
      const call = vi.fn(async () => {
        if (failure === 'transport') throw new Error('private transport detail');
        if (failure === 'expired') return { content: '[E_ACTION_APPROVAL_NOT_ACTIVE] expired grant', isError: true };
        if (failure === 'malformed') return { content: '{bad-json' };
        if (failure === 'error-with-ok') return { content: '{"ok":true}', isError: true };
        return { content: '{"ok":false}' };
      });
      const execute = vi.fn(async () => ({ content: 'must not execute' }));
      const result = await runWithRuntimeActionApprovalGrant(
        clientWithHost(failure === 'missing-host' ? undefined : call), 'approval-expired', execute,
      );
      expect(execute).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content).not.toContain('private transport detail');
      // A rejected start is not a started execution needing a terminal report.
      expect(call).toHaveBeenCalledTimes(failure === 'missing-host' ? 0 : 1);
    },
  );

  it('executes once only after the host acknowledges consumption, with metadata-only reports', async () => {
    const order: string[] = [];
    const call = vi.fn(async (request: any) => {
      order.push(request.input.phase);
      expect(request.input).toEqual({ approval_request_id: 'approval-active', phase: request.input.phase });
      return { content: '{"ok":true}' };
    });
    const execute = vi.fn(async () => {
      order.push('execute');
      return { content: 'private command output' };
    });
    expect(await runWithRuntimeActionApprovalGrant(clientWithHost(call), 'approval-active', execute)).toEqual({ content: 'private command output' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['started', 'execute', 'succeeded']);
  });

  it.each(['error-reply', 'transport'])('keeps completed execution successful when terminal reporting has %s', async failure => {
    const call = vi.fn(async (request: any) => {
      if (request.input.phase === 'started') return { content: '{"ok":true}' };
      if (failure === 'transport') throw new Error('private terminal transport detail');
      return { content: '[E_ACTION_APPROVAL_NOT_ACTIVE] unavailable', isError: true };
    });
    const execute = vi.fn(async () => ({ content: 'completed' }));
    expect(await runWithRuntimeActionApprovalGrant(clientWithHost(call), 'approval-active', execute)).toEqual({ content: 'completed' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
