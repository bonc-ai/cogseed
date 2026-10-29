import { describe, it, expect, vi } from 'vitest';
import { createRuntimeToolRunner } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/runner';
import { DEFAULT_RUNTIME_TOOL_POLICY } from '../../../../../src/main/features/cogseed_runtime/kernel/config';

describe('Runtime connector host routing', () => {
 it('delegates desktop connector approvals to the existing host manager without adding a second gate', async () => {
  const call = vi.fn(async (request: any) => request.name === 'action_approval_request'
   ? { content: JSON.stringify({ approved: true, request_id: 'approved-survey' }) }
   : { content: JSON.stringify(request.name === 'desktop_connector_list_tools' ? [{ connector_id: 'tencent-survey', tool_name: 'get_survey' }] : { ok: true }) });
  const runner = createRuntimeToolRunner({ userId: 'alice', runtimeSessionId: 'mruntime-survey', requestId: 'req-survey', allowedRoots: [],
   toolPolicy: { ...DEFAULT_RUNTIME_TOOL_POLICY, connectors: 'enabled' }, hostToolClient: { call } as any });
  expect((await runner.run('list_connector_tools', {})).content).toContain('tencent-survey');
  const result = await runner.run('call_connector_tool', { connector_id: 'tencent-survey', tool_name: 'get_survey', arguments: { survey_id: 1 } });
  expect(result.isError).toBeFalsy();
  const names = call.mock.calls.map(([r]) => r.name);
  expect(names).toContain('desktop_connector_call_tool');
  expect(names).not.toContain('action_approval_request');
 });
 it('preserves host denials and does not dispatch disabled connector calls', async () => {
  const call = vi.fn(async () => ({ content: '[E_ACTION_APPROVAL_DENIED] sensitive action was not approved', isError: true }));
  const make = (enabled: boolean) => createRuntimeToolRunner({ userId: 'alice', runtimeSessionId: 'mruntime-survey', allowedRoots: [],
   toolPolicy: { ...DEFAULT_RUNTIME_TOOL_POLICY, connectors: enabled ? 'enabled' : 'none' }, hostToolClient: { call } as any });
  expect((await make(false).run('list_connector_tools', {})).isError).toBe(true); expect(call).not.toHaveBeenCalled();
  expect((await make(true).run('call_connector_tool', { connector_id: 'tencent-survey', tool_name: 'create_survey', arguments: { text: 'draft' } })).isError).toBe(true);
  expect(call.mock.calls.map(([r]: any[]) => r?.name)).toEqual(['desktop_connector_call_tool']);
 });
});
