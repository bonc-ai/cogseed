import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const requireCjs = createRequire(import.meta.url);
const gate = vi.hoisted(() => ({ request: vi.fn(), record: vi.fn() }));
vi.mock('../../../../src/main/features/action_approval', () => ({
  requestActionApproval: gate.request, recordActionApprovalExecution: gate.record,
}));
vi.mock('../../../../src/main/features/config', () => ({ getLanguageForUser: () => 'zh' }));
import { callApprovedTencentMeetingChange } from '../../../../src/main/features/connectors/tencent-meeting-approval';

const adapter = requireCjs('../../../../bin/tencent-meeting-mcp-server.cjs');
const execute = vi.fn();
const connection = {
  callTool: vi.fn(async (name: string, args: Record<string, unknown>) => ({
    content: [{ type: 'text', text: JSON.stringify(await adapter.callTool(name, args)) }],
  })),
};
beforeEach(() => {
  vi.clearAllMocks();
  gate.record.mockResolvedValue({ handled: true });
  execute.mockResolvedValue({ data: { meeting_id: '123' } });
  adapter._setExecForTest(execute);
});
afterEach(() => adapter._setExecForTest(null));

describe('Tencent Meeting human approval boundary', () => {
  it('waits for a human, shows the exact proposal and executes once', async () => {
    let answer!: (value: unknown) => void;
    gate.request.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const args = { subject: '项目评审', start: '2026-10-10T10:00+08:00', end: '2026-10-10T11:00+08:00' };
    const pending = callApprovedTencentMeetingChange('user', connection, 'create_meeting', args);
    await vi.waitFor(() => expect(gate.request).toHaveBeenCalledOnce());
    expect(execute).not.toHaveBeenCalled();
    const request = gate.request.mock.calls[0][0];
    expect(request.target).toContain('项目评审');
    expect(request.target).toContain(args.start);
    expect(request.auditTarget).not.toContain('项目评审');
    args.subject = 'changed while waiting';
    answer({ approved: true, requestId: 'approval-1' });
    await pending;
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toContain('--subject=项目评审');
    expect(gate.record.mock.calls.map(([input]) => input.phase)).toEqual(['started', 'succeeded']);
    expect(connection.callTool.mock.calls.at(-1)?.[0]).toBe('discard_meeting_change');
  });

  it.each(['E_ACTION_APPROVAL_DENIED', 'E_ACTION_APPROVAL_EXPIRED', 'E_ACTION_APPROVAL_UNAVAILABLE', 'E_ACTION_APPROVAL_CANCELLED'])('never writes after %s', async (code) => {
    gate.request.mockResolvedValue({ approved: false, code });
    await expect(callApprovedTencentMeetingChange('user', connection, 'cancel_meeting', { meeting_id: '123' })).rejects.toThrow(code);
    expect(execute).not.toHaveBeenCalled();
    expect(connection.callTool.mock.calls.map(([name]) => name)).toEqual(['prepare_meeting_change', 'discard_meeting_change']);
  });

  it('does not execute an approval that is no longer active', async () => {
    gate.request.mockResolvedValue({ approved: true, requestId: 'expired' });
    gate.record.mockResolvedValue({ handled: false });
    await expect(callApprovedTencentMeetingChange('user', connection, 'update_meeting', { meeting_id: '123', subject: 'New name' })).rejects.toThrow('NOT_ACTIVE');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks task conditions after human approval and discards a blocked prepared change', async () => {
    gate.request.mockResolvedValue({ approved: true, requestId: 'approval-recheck' });
    const beforeDispatch = vi.fn(async () => { throw new Error('E_ONTOLOGY_OPERATION_PRECONDITION'); });
    await expect(callApprovedTencentMeetingChange('user', connection, 'cancel_meeting',
      { meeting_id: '123' }, undefined, beforeDispatch)).rejects.toThrow('E_ONTOLOGY_OPERATION_PRECONDITION');
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(connection.callTool.mock.calls.map(([name]) => name)).toEqual(['prepare_meeting_change', 'discard_meeting_change']);
    expect(gate.record.mock.calls.map(([input]) => input.phase)).toEqual(['started', 'failed']);
  });

  it('honours a task abort even if an approval arrives concurrently', async () => {
    const abort = new AbortController();
    gate.request.mockImplementation(async () => { abort.abort(); return { approved: true, requestId: 'late' }; });
    await expect(callApprovedTencentMeetingChange('user', connection, 'cancel_meeting', { meeting_id: '123' }, abort.signal)).rejects.toThrow('CANCELLED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not retry a meeting write after an uncertain transport failure', async () => {
    gate.request.mockResolvedValue({ approved: true, requestId: 'approval-2' });
    execute.mockRejectedValue(new Error('response lost'));
    await expect(callApprovedTencentMeetingChange('user', connection, 'cancel_meeting', { meeting_id: '123' })).rejects.toThrow('response lost');
    expect(execute).toHaveBeenCalledOnce();
    expect(gate.record.mock.calls.map(([input]) => input.phase)).toEqual(['started', 'failed']);
  });
});
