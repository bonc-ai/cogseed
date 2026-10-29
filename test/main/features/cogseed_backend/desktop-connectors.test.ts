import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as paths from '../../../../src/main/paths';
import { _resetActionApprovalForTest, _setActionApprovalBroadcastForTest, respondActionApproval } from '../../../../src/main/features/action_approval';
import { runDesktopConnectorTool } from '../../../../src/main/features/cogseed_backend/desktop-connectors';

const { visible, desktopCall, nativeCall, autoApprove } = vi.hoisted(() => ({
  visible: vi.fn(), desktopCall: vi.fn(), nativeCall: vi.fn(), autoApprove: vi.fn(),
}));
vi.mock('../../../../src/main/features/connectors/tools-adapter', () => ({
  resolveVisibleConnectors: visible, stringifyMcpResult: JSON.stringify,
}));
vi.mock('../../../../src/main/features/connectors/manager', () => ({
  listInstances: () => [{ id: 'tencent-meeting' }], callTool: desktopCall,
}));
vi.mock('../../../../src/main/features/connectors/catalog', () => ({ findCatalogEntry: () => undefined }));
vi.mock('../../../../src/main/features/cogseed_backend/connector-manager', () => ({
  cogseedConnectorManager: { callTool: nativeCall },
}));
vi.mock('../../../../src/main/features/cogseed_backend/runtime-tool-policy', () => ({ shouldAutoApproveRuntimeAction: autoApprove }));
const request: any = { user_id: 'connector-policy-user', request_id: 'req-connect', runtime_session_id: 'mruntime-connect',
  agent_id: 'meeting-agent', tool_policy: { connectors: 'enabled' } };
const input = { connector_id: 'tencent-meeting', tool_name: 'get_transcript_paragraphs', arguments: { record_file_id: '71' } };

beforeEach(() => {
  vi.clearAllMocks();
  visible.mockResolvedValue([{ instance: { id: 'tencent-meeting' }, tools: [{ name: 'get_transcript_paragraphs' }, { name: 'create_meeting' }] }]);
  desktopCall.mockResolvedValue({ content: 'transcript' });
  nativeCall.mockResolvedValue({ content: 'native-result' });
  autoApprove.mockResolvedValue(false);
});
afterEach(() => {
  _resetActionApprovalForTest();
  fs.rmSync(paths.userRoot('connector-policy-user'), { recursive: true, force: true });
});

describe('desktop connector permission boundary', () => {
  it('preserves the complete normalized transcript and pagination without the duplicate provider payload', async () => {
    const normalized = { record_file_id: '71', text: '完整转写', paragraphs: [{ pid: '0', text: '完整转写', start_time: '00:00', speaker: 'speaker' }], more: true, truncated: false, raw: { enormous: 'x'.repeat(50000) } };
    desktopCall.mockResolvedValue(normalized);
    const result = await runDesktopConnectorTool('connector-policy-user', 'desktop_connector_call_tool', input, request);
    const { raw, ...expected } = normalized;
    expect(JSON.parse(result.content)).toEqual(expected);
    expect(result.content.length).toBeLessThan(1000);
  });

  it('reads a visible transcript through the standard manager without an additional approval', async () => {
    const popups: unknown[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload) => { popups.push(payload); });
    const result = await runDesktopConnectorTool(request.user_id, 'desktop_connector_call_tool', input, request);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('transcript');
    expect(popups).toEqual([]);
  });
  it('retains the manager-owned mutation gate and rejects tools outside the live actor scope', async () => {
    desktopCall.mockResolvedValueOnce({ isError: true, content: 'E_ACTION_APPROVAL_DENIED' });
    const result = await runDesktopConnectorTool(request.user_id, 'desktop_connector_call_tool', { ...input, tool_name: 'create_meeting' }, request);
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('E_ACTION_APPROVAL_DENIED') });
    const denied = await runDesktopConnectorTool(request.user_id, 'desktop_connector_call_tool', { ...input, tool_name: 'hidden_tool' }, request);
    expect(denied).toMatchObject({ isError: true, content: expect.stringContaining('E_RUNTIME_CONNECTOR_SCOPE') });
    expect(desktopCall).toHaveBeenCalledTimes(1);
  });
  it('keeps approval on native-store calls when the persisted permission mode requires it', async () => {
    const popups: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload) => { popups.push(payload); });
    const pending = runDesktopConnectorTool(request.user_id, 'desktop_connector_call_tool', { ...input, connector_id: 'native-connector' }, { ...request, agent_id: undefined });
    await vi.waitFor(() => expect(popups).toHaveLength(1));
    expect(nativeCall).not.toHaveBeenCalled();
    await respondActionApproval(popups[0].request_id, 'deny');
    expect(await pending).toMatchObject({ isError: true, content: expect.stringContaining('E_ACTION_APPROVAL_DENIED') });
    expect(nativeCall).not.toHaveBeenCalled();
  });
  it('does not treat an unfamiliar Tencent tool as a read or bypass its required approval', async () => {
    visible.mockResolvedValue([{ instance: { id: 'tencent-meeting' }, tools: [{ name: 'get_and_delete_recording' }] }]);
    const popups: any[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload) => { popups.push(payload); });
    const pending = runDesktopConnectorTool(request.user_id, 'desktop_connector_call_tool', { ...input, tool_name: 'get_and_delete_recording' }, request);
    await vi.waitFor(() => expect(popups).toHaveLength(1));
    expect(desktopCall).not.toHaveBeenCalled();
    await respondActionApproval(popups[0].request_id, 'deny');
    expect(await pending).toMatchObject({ isError: true, content: expect.stringContaining('E_ACTION_APPROVAL_DENIED') });
    expect(desktopCall).not.toHaveBeenCalled();
  });
  it('honors automatic approval for native calls and does not widen an Agent to the native store', async () => {
    autoApprove.mockResolvedValue(true);
    const popups: unknown[] = [];
    _setActionApprovalBroadcastForTest((_channel, payload) => { popups.push(payload); });
    const nativeInput = { ...input, connector_id: 'native-connector' };
    expect(await runDesktopConnectorTool(request.user_id, 'desktop_connector_call_tool', nativeInput, request)).toMatchObject({ isError: true });
    expect(nativeCall).not.toHaveBeenCalled();
    expect(await runDesktopConnectorTool(request.user_id, 'desktop_connector_call_tool', nativeInput, { ...request, agent_id: undefined })).toMatchObject({ content: expect.stringContaining('native-result') });
    expect(popups).toEqual([]);
  });
});
