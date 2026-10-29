/** Host bridge for the connector page's registry. The isolated Runtime must not decrypt desktop
 * credentials or instantiate Electron-dependent connector managers. Keep tool discovery and
 * execution behind the existing host JSONL channel, with live actor/user/subtool checks.
 * The native Runtime connector store remains available for its own non-catalog IDs.
 */
import * as crypto from 'node:crypto';
import { resolveVisibleConnectors, stringifyMcpResult } from '../connectors/tools-adapter';
import { callTool, listInstances } from '../connectors/manager';
import { findCatalogEntry } from '../connectors/catalog';
import { cogseedConnectorManager } from './connector-manager';
import type { RuntimeRunRequest } from '../cogseed_runtime/protocol';
import type { CogSeedHostToolResult } from './office-adapter';
import { grantAutoActionApproval, recordActionApprovalExecution, requestActionApproval } from '../action_approval';
import { shouldAutoApproveRuntimeAction } from './runtime-tool-policy';
import { isTencentMeetingRead, isTencentMeetingWrite } from '../connectors/tencent-meeting-approval';

/** The meeting connector includes a normalized transcript and a duplicate raw
 * provider response. Keep all normalized source/pagination fields before the
 * shared cap; otherwise raw word/avatar metadata pushes out transcript text
 * and forces repeated partial fetches. Unknown/error shapes are unchanged. */
function meetingResultText(result: unknown, toolName: string): string {
  const text = stringifyMcpResult(result);
  if (!['get_transcript', 'get_transcript_paragraphs'].includes(toolName)) return text;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value.record_file_id !== 'string' || !Array.isArray(value.paragraphs)
      || typeof value.text !== 'string' || value.paragraphs.some((row: unknown) => !row || typeof row !== 'object' || typeof (row as { text?: unknown }).text !== 'string')) return text;
    const { raw: _raw, ...transcript } = value;
    return JSON.stringify(transcript);
  } catch { return text; }
}

export async function runDesktopConnectorTool(userId: string, name: string, input: Record<string, unknown>,
  request: RuntimeRunRequest, signal?: AbortSignal | null, beforeDispatch?: () => Promise<void>): Promise<CogSeedHostToolResult> {
  if (request.user_id !== userId || request.tool_policy?.connectors !== 'enabled') {
    return { content: '[E_RUNTIME_CONNECTOR_DISABLED] Connectors are disabled', isError: true };
  }
  const id = typeof input.connector_id === 'string' ? input.connector_id.trim() : '';
  const visible = await resolveVisibleConnectors(userId, request.agent_id);
  const desktopIds = new Set(listInstances(userId).map(i => i.id));
  const isDesktop = (value: string) => desktopIds.has(value) || !!findCatalogEntry(value);
  if (name === 'desktop_connector_list_tools') {
    const selected = id ? visible.filter(v => v.instance.id === id) : visible;
    const tools = selected.flatMap(v => v.tools.map(t => ({ connector_id: v.instance.id,
      tool_name: t.name, description: t.description, input_schema: t.input_schema })));
    // Agent workers may access only explicitly enabled desktop connectors; don't widen their
    // scope through the parallel native store. Commander keeps existing native-store access.
    if (!request.agent_id && (!id || !isDesktop(id))) {
      const native = id ? await cogseedConnectorManager.listTools(userId, id, { signal: signal ?? undefined })
        : await cogseedConnectorManager.listAllTools(userId, { signal: signal ?? undefined });
      tools.push(...native.filter(t => !isDesktop(t.connectorId)).map(t => ({ connector_id: t.connectorId,
        tool_name: t.name, description: t.description, input_schema: t.input_schema })));
    }
    return { content: JSON.stringify(tools) };
  }
  const toolName = typeof input.tool_name === 'string' ? input.tool_name.trim() : '';
  if (!id || !toolName || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    return { content: '[E_RUNTIME_CONNECTOR_INPUT] Invalid connector call', isError: true };
  }
  const args = input.arguments as Record<string, unknown>;
  if (isDesktop(id)) {
    const connector = visible.find(v => v.instance.id === id);
    if (!connector?.tools.some(t => t.name === toolName)) return { content: '[E_RUNTIME_CONNECTOR_SCOPE] Connector tool is unavailable', isError: true };
    // Reuse the standard connector path. Reads have no additional Runtime
    // approval; mutations retain the provider's existing manager-owned gate.
    // The Runtime's last-moment dispatch check must reach the manager call, not
    // just this adapter: task conditions can change while approval is pending.
    const execute = () => callTool(userId, id, toolName, args, {
      signal: signal ?? undefined,
      ...(beforeDispatch ? { beforeDispatch } : {}),
    });
    if (id !== 'tencent-meeting' || (!isTencentMeetingRead(toolName) && !isTencentMeetingWrite(toolName))) {
      return callWithConnectorApproval(userId, id, toolName, args, request, signal, execute);
    }
    const result = await execute();
    return { content: meetingResultText(result, toolName), ...((result as { isError?: boolean })?.isError ? { isError: true } : {}) };
  }
  if (request.agent_id) return { content: '[E_RUNTIME_CONNECTOR_SCOPE] Connector tool is unavailable', isError: true };
  return callWithConnectorApproval(userId, id, toolName, args, request, signal, () =>
    cogseedConnectorManager.callTool(userId, id, toolName, args, {
      signal: signal ?? undefined,
      ...(beforeDispatch ? { beforeDispatch } : {}),
    }));
}

async function callWithConnectorApproval(userId: string, id: string, toolName: string, args: Record<string, unknown>,
  request: RuntimeRunRequest, signal: AbortSignal | null | undefined, execute: () => Promise<unknown>): Promise<CogSeedHostToolResult> {
  // Unknown connector actions keep the generic gate. Only the host-owned
  // meeting read/mutation contract may omit this additional Runtime gate.
  const intent = {
    userId, runtimeSessionId: request.runtime_session_id, runtimeRequestId: request.request_id,
    actor: request.agent_id || 'commander', action: 'connector_call' as const,
    target: `${id} / ${toolName}`, scope: `仅调用该工具，参数字段：${Object.keys(args).sort().join('、')}`,
    auditTarget: `Connector tool: ${id}/${toolName}`, auditScope: `argument keys: ${Object.keys(args).sort().join(', ')}`,
    risk: 'high' as const, reasons: ['external_service_call'],
    fingerprint: crypto.createHash('sha256').update(JSON.stringify({ id, toolName, args })).digest('hex'), signal,
  };
  const auto = await shouldAutoApproveRuntimeAction(userId, request.request_id, request.runtime_session_id);
  const decision = await (auto ? grantAutoActionApproval(intent) : requestActionApproval(intent));
  if (decision.approved === false) return { content: `[${decision.code}] sensitive action was not approved`, isError: true };
  const execution = { userId, runtimeSessionId: request.runtime_session_id, runtimeRequestId: request.request_id, requestId: decision.requestId };
  const started = await recordActionApprovalExecution({ ...execution, phase: 'started' });
  if (!started.handled) return { content: '[E_ACTION_APPROVAL_NOT_ACTIVE] approval is not active', isError: true };
  try {
    const result = await execute();
    const isError = !!(result as { isError?: boolean })?.isError;
    await recordActionApprovalExecution({ ...execution, phase: isError ? 'failed' : 'succeeded' });
    return { content: stringifyMcpResult(result), ...(isError ? { isError: true } : {}) };
  } catch (error) {
    await recordActionApprovalExecution({ ...execution, phase: 'failed', resultCode: 'E_RUNTIME_CONNECTOR_FAILED' });
    throw error;
  }
}
