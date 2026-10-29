/** Tencent mutations always require one human decision, including in auto-approve sessions.
 * The adapter retains immutable argv behind a random, single-use token. Neither the token
 * nor the host-only prepare/commit/discard actions are exposed to model callers.
 */
import * as crypto from 'node:crypto';
import { requestActionApproval, recordActionApprovalExecution } from '../action_approval';
import { getLanguageForUser } from '../config';
import { t } from '../../i18n';

const { WRITE_NAMES, INTERNAL_NAMES, normalizeAction } = require('../../../../bin/tencent-meeting-actions.cjs');
export const isTencentMeetingWrite = (name: string): boolean => WRITE_NAMES.has(name);
export const isTencentMeetingInternal = (name: string): boolean => INTERNAL_NAMES.has(name);
// Exact read actions implemented by the application-owned meeting adapter.
// Do not infer read safety from an arbitrary MCP tool name or description.
const READ_NAMES = new Set([
  'list_meetings', 'list_ended_meetings', 'get_meeting', 'list_recordings',
  'get_transcript', 'get_transcript_paragraphs', 'search_transcript',
  'get_meeting_minutes', 'preview_record_permission',
]);
export const isTencentMeetingRead = (name: string): boolean => READ_NAMES.has(name);

interface Connection {
  callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
}

function unwrap(raw: unknown): { token?: string; preview?: Record<string, string>; expires_at?: number } {
  const result = raw as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = result.content?.filter((item) => item.type === 'text').map((item) => item.text || '').join('\n') || '';
  if (result.isError) throw new Error(text || 'Meeting preparation failed');
  return JSON.parse(text);
}

export async function callApprovedTencentMeetingChange(
  userId: string, connection: Connection, name: string, input: Record<string, unknown>, signal?: AbortSignal,
  beforeDispatch?: () => Promise<void>,
): Promise<unknown> {
  const { args } = normalizeAction(name, input);
  if (signal?.aborted) throw new Error('E_ACTION_APPROVAL_CANCELLED');
  const prepared = unwrap(await connection.callTool('prepare_meeting_change', { tool_name: name, arguments: args }, { signal }));
  if (!prepared.token || !/^[a-f0-9]{64}$/.test(prepared.token)) throw new Error('Invalid meeting preparation receipt');
  const request = crypto.randomUUID();
  const context = { userId, runtimeSessionId: 'connector-tencent-meeting', runtimeRequestId: request };
  const record = async (requestId: string, phase: 'started' | 'succeeded' | 'failed') => {
    return recordActionApprovalExecution({ ...context, requestId, phase });
  };
  let approvalId: string | undefined;
  try {
    const permission = name === 'apply_record_permission';
    if (permission && (!prepared.preview || !Number.isFinite(prepared.expires_at) || prepared.expires_at! <= Date.now())) {
      throw new Error('E_ACTION_APPROVAL_EXPIRED');
    }
    const lang = getLanguageForUser(userId);
    const label = (key: string) => t(`connectors.tencent.approval.${key}`, undefined, lang);
    const summary = Object.entries({ ...args, ...(permission ? prepared.preview : {}) }).map(([key, value]) => `${label(key)}: ${value}`).join('\n');
    const target = `${label(name)}\n${summary}`;
    if (permission && target.length > 2000) throw new Error('Recording permission preview is too long to confirm safely');
    const intent = {
      ...context, actor: 'Tencent Meeting', action: 'connector_call',
      target,
      scope: label(permission ? 'permission_scope' : name === 'cancel_meeting' ? 'cancel_scope' : 'scope'),
      auditTarget: `tencent-meeting/${name}`, auditScope: `fields: ${Object.keys(args).sort().join(',')}`,
      risk: name === 'cancel_meeting' ? 'critical' : 'high',
      fingerprint: crypto.createHash('sha256').update(JSON.stringify({ name, args, preview: prepared.preview })).digest('hex'), signal,
      ...(permission ? { expiresAt: prepared.expires_at } : {}),
    } as const;
    const approval = await requestActionApproval({ ...intent, reasons: [permission ? 'external_service_call' : 'meeting_change'] });
    if ('code' in approval) throw new Error(approval.code);
    approvalId = approval.requestId;
    if (signal?.aborted) throw new Error('E_ACTION_APPROVAL_CANCELLED');
    if (permission && prepared.expires_at! <= Date.now()) throw new Error('E_ACTION_APPROVAL_EXPIRED');
    const started = await record(approvalId, 'started');
    if (!started.handled) throw new Error('E_ACTION_APPROVAL_NOT_ACTIVE');
    await beforeDispatch?.();
    if (signal?.aborted) throw new Error('E_ACTION_APPROVAL_CANCELLED');
    const result = await connection.callTool('commit_meeting_change', { token: prepared.token }, { signal });
    await record(approvalId, (result as { isError?: boolean })?.isError ? 'failed' : 'succeeded');
    return result;
  } catch (error) {
    if (approvalId) await record(approvalId, 'failed');
    throw error;
  } finally {
    // No user data or confirmation receipt survives cancellation, failure, or completion.
    try { await connection.callTool('discard_meeting_change', { token: prepared.token }); } catch { /* closed connection */ }
  }
}
