import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ visible: vi.fn(), instances: vi.fn(), call: vi.fn(), nativeList: vi.fn(), nativeCall: vi.fn(), autoApprove: vi.fn() }));
vi.mock('../../../../src/main/features/connectors/tools-adapter', () => ({ resolveVisibleConnectors: m.visible, stringifyMcpResult: (v: any) => JSON.stringify(v) }));
vi.mock('../../../../src/main/features/connectors/manager', () => ({ listInstances: m.instances, callTool: m.call }));
vi.mock('../../../../src/main/features/connectors/catalog', () => ({ findCatalogEntry: (id: string) => id === 'tencent-survey' ? { id } : null }));
vi.mock('../../../../src/main/features/cogseed_backend/connector-manager', () => ({ cogseedConnectorManager: { listTools: m.nativeList, listAllTools: m.nativeList, callTool: m.nativeCall } }));
// Non-meeting connector calls now pass the shared Runtime approval gate. This suite is about
// tool routing, not the gate itself, so it pins the gate open the same way the sibling
// `desktop-connectors.test.ts` does; the gate's own allow/deny semantics are covered there.
vi.mock('../../../../src/main/features/cogseed_backend/runtime-tool-policy', () => ({ shouldAutoApproveRuntimeAction: m.autoApprove }));
import { runDesktopConnectorTool } from '../../../../src/main/features/cogseed_backend/desktop-connectors';
// The runtime host bridge now routes non-meeting connector calls through the shared
// `callWithConnectorApproval` gate, which resolves the task from
// `request.request_id` (and needs a well-formed one: `assertCogSeedRequestId`). The
// sibling suites were updated when that gate landed; this one was missed, so the mock
// request silently lacked the identifier.
const request: any = { user_id: 'alice', request_id: 'req-survey', runtime_session_id: 'mruntime-survey', tool_policy: { connectors: 'enabled' } };
beforeEach(() => { vi.clearAllMocks(); m.autoApprove.mockResolvedValue(true); m.instances.mockReturnValue([{ id: 'tencent-survey' }]); m.visible.mockResolvedValue([{ instance: { id: 'tencent-survey' }, tools: [{ name: 'get_survey', description: 'Survey', input_schema: { type: 'object' } }] }]); m.nativeList.mockResolvedValue([]); m.call.mockResolvedValue({ content: [{ text: 'data' }] }); });
describe('new-task host bridge reaches the connector page registry', () => {
 it('lists the authorized survey tool and calls the same desktop manager', async () => {
  const listed = await runDesktopConnectorTool('alice', 'desktop_connector_list_tools', {}, request);
  expect(JSON.parse(listed.content)).toEqual([expect.objectContaining({ connector_id: 'tencent-survey', tool_name: 'get_survey' })]);
  await runDesktopConnectorTool('alice', 'desktop_connector_call_tool', { connector_id: 'tencent-survey', tool_name: 'get_survey', arguments: { survey_id: 1 } }, request);
  expect(m.call).toHaveBeenCalledWith('alice', 'tencent-survey', 'get_survey', { survey_id: 1 }, { signal: undefined }); expect(m.nativeCall).not.toHaveBeenCalled();
 });
 it('rechecks live visibility on every call and cannot bypass a disconnected catalog entry via the native store', async () => {
  m.visible.mockResolvedValue([]);
  const out = await runDesktopConnectorTool('alice', 'desktop_connector_call_tool', { connector_id: 'tencent-survey', tool_name: 'get_survey', arguments: {} }, request);
  expect(out.isError).toBe(true); expect(m.call).not.toHaveBeenCalled(); expect(m.nativeCall).not.toHaveBeenCalled();
 });
 it.each(['tencent-survey', 'native-survey'])('preserves the final dispatch gate for %s', async (id) => {
  const beforeDispatch = vi.fn(async () => { throw new Error('task conditions changed'); });
  const execute = vi.fn();
  const manager = id === 'tencent-survey' ? m.call : m.nativeCall;
  manager.mockImplementationOnce(async (_user, _id, _tool, _args, opts) => {
   await opts.beforeDispatch();
   execute();
  });
  await expect(runDesktopConnectorTool('alice', 'desktop_connector_call_tool',
   { connector_id: id, tool_name: 'get_survey', arguments: {} }, request, undefined, beforeDispatch))
   .rejects.toThrow('task conditions changed');
  expect(beforeDispatch).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
 });
 it('denies internal actions, cross-user calls and disabled run policy', async () => {
  const input = { connector_id: 'tencent-survey', tool_name: 'start_login', arguments: {} };
  expect((await runDesktopConnectorTool('alice', 'desktop_connector_call_tool', input, request)).isError).toBe(true);
  expect((await runDesktopConnectorTool('bob', 'desktop_connector_call_tool', input, request)).isError).toBe(true);
  expect((await runDesktopConnectorTool('alice', 'desktop_connector_list_tools', {}, { ...request, tool_policy: { connectors: 'none' } })).isError).toBe(true);
  expect(m.call).not.toHaveBeenCalled();
 });
 it('passes the trusted actor to visibility resolution, without broadening agent access through the native store', async () => {
  m.visible.mockResolvedValue([]);
  expect(JSON.parse((await runDesktopConnectorTool('alice', 'desktop_connector_list_tools', {}, { ...request, agent_id: 'worker-a' })).content)).toEqual([]);
  expect(m.visible).toHaveBeenCalledWith('alice', 'worker-a'); expect(m.nativeList).not.toHaveBeenCalled();
 });
});
