import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

import * as paths from '../../../src/main/paths';
import { readJsonl } from '../../../src/main/storage';
import {
  _resetActionApprovalForTest,
  _setActionApprovalBroadcastForTest,
  ACTION_APPROVAL_TTL_MS,
  grantAutoActionApproval,
  recordActionApprovalExecution,
  requestActionApproval,
  respondActionApproval,
} from '../../../src/main/features/action_approval';
import {
  createRuntimeActionApprovalClient,
  runWithRuntimeActionApprovalGrant,
} from '../../../src/main/features/cogseed_runtime/kernel/tools/action-approval';

const USER = 'action-approval-user';
const SESSION = 'mruntime-approval';
const REQUEST = 'req-approval';

function input() {
  return {
    userId: USER,
    runtimeSessionId: SESSION,
    runtimeRequestId: REQUEST,
    actor: 'research-agent',
    action: 'connector_call' as const,
    target: 'gmail / send_email',
    scope: 'Only this connector tool with recipient and subject fields',
    auditTarget: 'Connector tool: gmail/send_email',
    auditScope: 'argument keys: recipient, subject',
    risk: 'high' as const,
    reasons: ['external_service_call'],
    fingerprint: 'a'.repeat(64),
  };
}

afterEach(() => {
  _resetActionApprovalForTest();
  vi.useRealTimers();
  fs.rmSync(paths.userRoot(USER), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('unified Runtime action approval', () => {
  it.each([
    ['manual', 'succeeded'], ['manual', 'failed'], ['auto', 'succeeded'], ['auto', 'failed'],
  ] as const)('grant TTL regression: %s grant retains the actual %s outcome of an execution longer than TTL', async (mode, terminal) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const approvalInput = { ...input(), action: 'bash' as const, target: 'private long-running shell command' };
    _setActionApprovalBroadcastForTest((_channel, payload: any) => {
      void respondActionApproval(payload.request_id, 'approve');
    });
    const decision = await (mode === 'auto' ? grantAutoActionApproval(approvalInput) : requestActionApproval(approvalInput));
    if (!decision.approved) throw new Error('fixture approval failed');
    const client = createRuntimeActionApprovalClient({
      requestId: REQUEST, runtimeSessionId: SESSION, actor: 'receiver',
      hostToolClient: {
        call: async (call: any) => {
          const result = await recordActionApprovalExecution({
            userId: USER, runtimeSessionId: SESSION, runtimeRequestId: REQUEST,
            requestId: call.input.approval_request_id, phase: call.input.phase, resultCode: call.input.result_code,
          });
          return { content: JSON.stringify({ ok: result.handled }), isError: !result.handled };
        },
      },
    });
    let entered!: () => void;
    let finish!: (value: { content: string; isError?: boolean }) => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const running = runWithRuntimeActionApprovalGrant(client, decision.requestId, () => {
      entered();
      return new Promise(resolve => { finish = resolve; });
    });
    await Promise.race([enteredPromise, running]);
    expect(finish).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(ACTION_APPROVAL_TTL_MS * 2);
    const outcome = { content: terminal === 'failed' ? '[E_SHELL_EXIT] private output' : 'private output', isError: terminal === 'failed' };
    finish(outcome);
    expect(await running).toEqual(outcome);
    const records = await readJsonl<any>(paths.actionApprovalAuditFile(USER), 20);
    expect(records.map(record => record.event)).toEqual([
      ...(mode === 'manual' ? ['requested'] : []), 'approved', 'execution_started', `execution_${terminal}`,
    ]);
    expect(JSON.stringify(records)).not.toContain('private');
    expect(await recordActionApprovalExecution({
      userId: USER, runtimeSessionId: SESSION, runtimeRequestId: REQUEST, requestId: decision.requestId, phase: terminal,
    })).toEqual({ handled: false });
  });

  it.each(['manual', 'auto'] as const)('grant TTL regression: unused %s grants still expire and cannot start', async mode => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    _setActionApprovalBroadcastForTest((_channel, payload: any) => {
      void respondActionApproval(payload.request_id, 'approve');
    });
    const decision = await (mode === 'auto' ? grantAutoActionApproval(input()) : requestActionApproval(input()));
    if (!decision.approved) throw new Error('fixture approval failed');
    await vi.advanceTimersByTimeAsync(ACTION_APPROVAL_TTL_MS + 1);
    expect(await recordActionApprovalExecution({
      userId: USER, runtimeSessionId: SESSION, runtimeRequestId: REQUEST, requestId: decision.requestId, phase: 'started',
    })).toEqual({ handled: false });
    await vi.waitFor(async () => {
      const records = await readJsonl<any>(paths.actionApprovalAuditFile(USER), 20);
      expect(records.map(record => record.event)).toEqual([
        ...(mode === 'manual' ? ['requested'] : []), 'approved', 'expired',
      ]);
      expect(records.at(-1).result_code).toBe('approval_not_consumed');
    });
  });

  it('rejects expired or invalid provider deadlines without showing a confirmation', async () => {
    const push = vi.fn();
    _setActionApprovalBroadcastForTest(push);
    await expect(requestActionApproval({ ...input(), expiresAt: Date.now() - 1 })).resolves.toMatchObject({ code: 'E_ACTION_APPROVAL_EXPIRED' });
    await expect(requestActionApproval({ ...input(), expiresAt: NaN })).resolves.toMatchObject({ code: 'E_ACTION_APPROVAL_INVALID' });
    expect(push).not.toHaveBeenCalled();
  });

  it('does not let a provider extend the host confirmation lifetime', async () => {
    const pushed: any[] = [];
    const before = Date.now();
    _setActionApprovalBroadcastForTest((_channel, payload) => { pushed.push(payload); });
    const pending = requestActionApproval({ ...input(), expiresAt: before + 3600_000 });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(Date.parse(pushed[0].expires_at)).toBeLessThanOrEqual(before + 600_100);
    await respondActionApproval(pushed[0].request_id, 'deny');
    await expect(pending).resolves.toMatchObject({ code: 'E_ACTION_APPROVAL_DENIED' });
  });

  it('audits request, approval, and execution outcome while keeping the approval bound to its Runtime session', async () => {
    const pushed: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload) => pushed.push(payload));
    const waiting = requestActionApproval(input());
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    const requestId = pushed[0].request_id;

    expect(pushed[0]).toMatchObject({
      actor: 'research-agent',
      action: 'connector_call',
      target: 'gmail / send_email',
      scope: 'Only this connector tool with recipient and subject fields',
      risk: 'high',
    });
    await expect(respondActionApproval(requestId, 'approve')).resolves.toEqual({ handled: true });
    await expect(waiting).resolves.toEqual(expect.objectContaining({ approved: true, requestId }));

    await expect(recordActionApprovalExecution({
      userId: USER,
      runtimeSessionId: 'mruntime-other',
      runtimeRequestId: REQUEST,
      requestId,
      phase: 'started',
    })).resolves.toEqual({ handled: false });
    await expect(recordActionApprovalExecution({
      userId: USER,
      runtimeSessionId: SESSION,
      runtimeRequestId: REQUEST,
      requestId,
      phase: 'started',
    })).resolves.toEqual({ handled: true });
    await expect(recordActionApprovalExecution({
      userId: USER,
      runtimeSessionId: SESSION,
      runtimeRequestId: REQUEST,
      requestId,
      phase: 'succeeded',
    })).resolves.toEqual({ handled: true });

    const records = await readJsonl<any>(paths.actionApprovalAuditFile(USER), 20);
    expect(records.map((record) => record.event)).toEqual([
      'requested', 'approved', 'execution_started', 'execution_succeeded',
    ]);
    expect(records[0]).toMatchObject({
      target_summary: 'Connector tool: gmail/send_email',
      scope_summary: 'argument keys: recipient, subject',
      fingerprint_prefix: 'a'.repeat(16),
    });
    expect(JSON.stringify(records)).not.toContain('Only this connector tool with recipient and subject fields');
  });

  it('fails closed when no renderer approval channel is available', async () => {
    _setActionApprovalBroadcastForTest(() => false);
    await expect(requestActionApproval(input())).resolves.toEqual({
      approved: false,
      code: 'E_ACTION_APPROVAL_UNAVAILABLE',
    });
  });

  it('does not accept duplicate or stale responses', async () => {
    const pushed: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload) => pushed.push(payload));
    const waiting = requestActionApproval(input());
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    const requestId = pushed[0].request_id;
    await expect(respondActionApproval(requestId, 'deny')).resolves.toEqual({ handled: true });
    await expect(waiting).resolves.toEqual({ approved: false, code: 'E_ACTION_APPROVAL_DENIED' });
    await expect(respondActionApproval(requestId, 'approve')).resolves.toEqual({ handled: false });
  });
});
