/** Documented tmeet 1.0.18 envelopes. Subprocesses are fixtures; the approval gate is real. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import * as paths from '../../../../src/main/paths';
import { callApprovedTencentMeetingChange } from '../../../../src/main/features/connectors/tencent-meeting-approval';
import { _resetActionApprovalForTest, _setActionApprovalBroadcastForTest, respondActionApproval } from '../../../../src/main/features/action_approval';

const requireCjs = createRequire(import.meta.url);
const uid = 'record-permission-test';
const args = { meeting_id: '123', meeting_record_id: 'record_abc' };
const preview = { meeting_record_id: args.meeting_record_id, approval_name: '查看录制', subject: '项目评审', file_owner: '会议所有者', apply_note: '', applicant: '申请人甲' };
let adapter: any;
let record: any;
let prepared: any;
let execute: any;
let popups: any[];
const result = { data: { unique_id: 'application-1', status: 'pending', approval_url: 'https://meeting.tencent.com/approval/example', share_text: '请审批' } };
const connection = { callTool: async (name: string, input: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(await adapter.callTool(name, input)) }] }) };
const apply = (signal?: AbortSignal) => callApprovedTencentMeetingChange(uid, connection, 'apply_record_permission', args, signal);
const prepare = () => adapter.callTool('prepare_meeting_change', { tool_name: 'apply_record_permission', arguments: args });
const commits = () => execute.mock.calls.filter(([argv]: [string[]]) => argv[1] === 'permission-apply-commit');

beforeEach(() => {
  const file = requireCjs.resolve('../../../../bin/tencent-meeting-mcp-server.cjs');
  delete requireCjs.cache[file];
  adapter = requireCjs(file);
  record = { meeting_record_id: args.meeting_record_id, permission_status: 'can_apply', state: '转码完成，可根据录制文件权限进行下一步' };
  prepared = { data: { preview: { ...preview }, expires_in: 60 } };
  execute = vi.fn(async (argv: string[]) => {
    if (argv[0] === 'meeting') return { data: { meeting_info_list: [{ meeting_id: args.meeting_id, records: [record] }] } };
    if (argv[1] === 'permission-apply-prepare') return prepared;
    if (argv[1] === 'permission-apply-commit') return result;
    throw new Error('Unexpected CLI command');
  });
  adapter._setExecForTest(execute);
  popups = [];
  _setActionApprovalBroadcastForTest((_channel, payload) => { popups.push(payload); });
});
afterEach(() => {
  _resetActionApprovalForTest();
  adapter._setExecForTest(null);
  vi.restoreAllMocks();
  fs.rmSync(paths.userRoot(uid), { recursive: true, force: true });
});

describe('recording access application', () => {
  it('uses the official preview, waits for a real decision, submits once and returns pending approval', async () => {
    const pending = apply();
    await vi.waitFor(() => expect(popups).toHaveLength(1));
    expect(commits()).toHaveLength(0);
    for (const value of Object.values(preview).filter(Boolean)) expect(popups[0].target).toContain(value);
    expect(Date.parse(popups[0].expires_at)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(popups[0].scope).toMatch(/审批|approval/);
    await respondActionApproval(popups[0].request_id, 'approve');
    expect(JSON.parse((await pending as any).content[0].text)).toEqual(result);
    expect(commits()).toEqual([[['record', 'permission-apply-commit', '--meeting-id=123', '--meeting-record-id=record_abc']]]);
    expect(await respondActionApproval(popups[0].request_id, 'approve')).toEqual({ handled: false });
    const audit = fs.readFileSync(paths.actionApprovalAuditFile(uid), 'utf8');
    expect(audit).not.toContain(preview.subject);
    expect(audit).not.toContain(preview.applicant);
  });

  it.each(['deny', 'abort', 'unavailable', 'expired'])('does not submit after %s', async (mode) => {
    const abort = new AbortController();
    if (mode === 'unavailable') _setActionApprovalBroadcastForTest(() => false);
    const pending = apply(abort.signal);
    const rejected = expect(pending).rejects.toThrow(/E_ACTION_APPROVAL_/);
    if (mode !== 'unavailable') {
      await vi.waitFor(() => expect(popups).toHaveLength(1));
      if (mode === 'abort') abort.abort();
      else {
        if (mode === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
        await respondActionApproval(popups[0].request_id, mode === 'deny' ? 'deny' : 'approve');
      }
    }
    await rejected;
    expect(commits()).toHaveLength(0);
  });

  it.each(['can_view', 'closed', 'deleted', 'password_required', undefined])('does not apply for permission_status=%s', async (status) => {
    record.permission_status = status;
    await expect(apply()).rejects.toThrow(/can_apply/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(popups).toHaveLength(0);
  });

  it.each(['录制中', '转码中', undefined, ''])('waits for a ready recording (%s)', async (state) => {
    record.state = state;
    await expect(apply()).rejects.toThrow(/not ready/);
    expect(popups).toHaveLength(0);
    expect(commits()).toHaveLength(0);
  });

  it.each(['mismatch', 'missing-field', 'missing-expiry', 'expired', 'oversized'])('rejects an unreviewable provider preview: %s', async (mode) => {
    if (mode === 'mismatch') prepared.data.preview.meeting_record_id = 'another-record';
    if (mode === 'missing-field') delete prepared.data.preview.applicant;
    if (mode === 'missing-expiry') delete prepared.data.expires_in;
    if (mode === 'expired') prepared.data.expires_in = 0;
    if (mode === 'oversized') prepared.data.preview.apply_note = 'x'.repeat(2001);
    await expect(apply()).rejects.toThrow(/preview/);
    expect(popups).toHaveLength(0);
    expect(commits()).toHaveLength(0);
  });

  it('uses observed list-ended evidence for recordings outside the limited meeting-get result', async () => {
    await adapter.callTool('list_ended_meetings', {});
    execute.mockImplementationOnce(async () => prepared);
    const draft = await prepare();
    expect(draft.preview).toMatchObject({ subject: preview.subject });
    expect(execute.mock.calls.map(([argv]: [string[]]) => argv[1])).toEqual(['list-ended', 'permission-apply-prepare']);
    await adapter.callTool('discard_meeting_change', { token: draft.token });
  });

  it('rejects forged consent, concurrent requests, replay, expired and discarded receipts', async () => {
    await expect(adapter.callTool('apply_record_permission', { ...args, confirmed: true })).rejects.toThrow(/human approval/);
    await expect(adapter.callTool('prepare_meeting_change', { tool_name: 'apply_record_permission', arguments: { ...args, confirmed: true } })).rejects.toThrow(/Unexpected/);
    const first = await prepare();
    await expect(prepare()).rejects.toThrow(/already pending/);
    await adapter.callTool('commit_meeting_change', { token: first.token, meeting_record_id: 'forged' });
    await expect(adapter.callTool('commit_meeting_change', { token: first.token })).rejects.toThrow(/already used/);
    const second = await prepare();
    await adapter.callTool('discard_meeting_change', { token: second.token });
    await expect(adapter.callTool('commit_meeting_change', { token: second.token })).rejects.toThrow(/missing/);
    const third = await prepare();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    await expect(adapter.callTool('commit_meeting_change', { token: third.token })).rejects.toThrow(/expired/);
    expect(commits()).toHaveLength(1);
    expect(commits()[0][0]).toContain('--meeting-record-id=record_abc');
  });

  it('never retries an uncertain submission', async () => {
    const draft = await prepare();
    execute.mockRejectedValueOnce(new Error('response lost'));
    await expect(adapter.callTool('commit_meeting_change', { token: draft.token })).rejects.toThrow('response lost');
    await expect(adapter.callTool('commit_meeting_change', { token: draft.token })).rejects.toThrow(/already used/);
    expect(commits()).toHaveLength(1);
  });
});
