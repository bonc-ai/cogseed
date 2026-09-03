import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

import * as paths from '../../../src/main/paths';
import { readJsonl } from '../../../src/main/storage';
import {
  _resetActionApprovalForTest,
  _setActionApprovalBroadcastForTest,
  recordActionApprovalExecution,
  requestActionApproval,
  respondActionApproval,
} from '../../../src/main/features/action_approval';

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
  fs.rmSync(paths.userRoot(USER), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('unified Runtime action approval', () => {
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
