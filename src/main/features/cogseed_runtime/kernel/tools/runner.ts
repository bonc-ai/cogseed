import { capToolResult, DEFAULT_INLINE_RESULT_TOKENS } from '../../../../util/tool-result-cap';
import type { RuntimeToolPolicy } from '../types';
import { TOOL_CATALOG, type RuntimeToolCatalogEntry, type RuntimeToolName, getRuntimeToolCatalog, filterRuntimeToolCatalogByCapabilities, filterRuntimeToolCatalogByPolicy } from './catalog';
import { RUNTIME_FILE_TOOLS, runRuntimeFileTool, type RuntimeToolCallContext, type RuntimeToolResult } from './file-tools';
import { normalizeRuntimeRoots } from './permissions';
import { runRuntimeBashTool } from './shell-tools';
import { runRuntimeSkillTool } from './skill-tools';
import { createRuntimeActionApprovalClient, runWithRuntimeActionApproval } from './action-approval';
import type { CogSeedConnectorManager } from '../../../cogseed_backend/connector-manager';
import type { CogSeedKbManager } from '../../../cogseed_backend/cogseed-kb-store';
import { cogseedRuntimeSessionToolResultsDir } from '../../../../paths';
import type { RuntimeHostToolName } from '../../protocol';
import type { RuntimeSkillVersionPin } from '../../protocol';
import type { RuntimeHostToolClient } from './host-tools';

export interface RuntimeToolRunnerOptions {
  userId: string;
  runtimeSessionId: string;
  requestId?: string;
  agentId?: string;
  allowedRoots: readonly string[];
  writableRoots?: readonly string[];
  /** Canonical workspace root; default cwd for shell/skill when absent. */
  workspaceRoot?: string;
  pcDir?: string;
  toolPolicy: RuntimeToolPolicy;
  /** Main-process-derived capability grants; gates Commander-only tools. */
  capabilities?: readonly string[];
  allowedSkillIds?: readonly string[];
  skillVersionPins?: readonly RuntimeSkillVersionPin[];
  maxInlineToolResultTokens?: number;
  connectorManager?: CogSeedConnectorManager;
  kbManager?: CogSeedKbManager;
  hostToolClient?: RuntimeHostToolClient;
}

export interface RuntimeToolRunner {
  readonly catalog: readonly RuntimeToolCatalogEntry[];
  run(name: string, input: Record<string, unknown>, opts?: { signal?: AbortSignal | null }): Promise<RuntimeToolResult>;
}

function isRuntimeFileTool(name: string): name is RuntimeToolName {
  return RUNTIME_FILE_TOOLS.some((tool) => tool.name === name);
}

export function createRuntimeToolRunner(options: RuntimeToolRunnerOptions): RuntimeToolRunner {
  // 目录 = 全局目录 → capability 门控 → 有效策略过滤。第二道过滤保证模型看不到
  // 「策略必然拒绝」的工具（bash / write_file / edit_file / run_skill / 读文件）。
  const catalog = filterRuntimeToolCatalogByPolicy(
    filterRuntimeToolCatalogByCapabilities(getRuntimeToolCatalog(), options.capabilities),
    options.toolPolicy,
  );
  const allowedRoots = normalizeRuntimeRoots(options.allowedRoots);
  const writableRoots = normalizeRuntimeRoots(options.writableRoots ?? []);
  const actionApproval = createRuntimeActionApprovalClient({
    hostToolClient: options.hostToolClient,
    requestId: options.requestId ?? `req-${options.runtimeSessionId.replace(/^mruntime-/, '')}`,
    runtimeSessionId: options.runtimeSessionId,
    actor: options.agentId || 'CogSeed Agent',
  });
  const callContext: RuntimeToolCallContext = {
    userId: options.userId,
    runtimeSessionId: options.runtimeSessionId,
    allowedRoots,
    writableRoots,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    pcDir: options.pcDir ?? process.cwd(),
    toolPolicy: options.toolPolicy,
    allowedSkillIds: options.allowedSkillIds ?? [],
    skillVersionPins: options.skillVersionPins ?? [],
    actionApproval,
  };
  callContext.beforeAction = async (toolName, input, signal) => {
    if (!options.hostToolClient || !options.requestId)
      return { content: '[E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE] current host action scope unavailable', isError: true };
    try {
      const result = await options.hostToolClient.call({ requestId: options.requestId, runtimeSessionId: options.runtimeSessionId,
        name: 'ontology_operation_preflight', input: { tool_name: toolName, arguments: input }, signal });
      if (result.isError) return result;
      const decision = JSON.parse(result.content);
      if (decision?.allowed !== true)
        return { content: '[E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE] no current action decision returned', isError: true };
      if (toolName === 'bash' && typeof decision.approval_request_id === 'string' && decision.approval_request_id)
        return { content: result.content, approvalRequestId: decision.approval_request_id };
      return undefined;
    } catch { return { content: '[E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE] current required conditions unavailable', isError: true }; }
  };
  const capTokens = options.maxInlineToolResultTokens ?? DEFAULT_INLINE_RESULT_TOKENS;
  const toolResultsDir = cogseedRuntimeSessionToolResultsDir(options.userId, options.runtimeSessionId);
  const capRuntimeResult = (name: string, result: RuntimeToolResult): RuntimeToolResult => capToolResult(
    name,
    result as any,
    { state: {} } as any,
    { maxInlineTokens: capTokens, toolResultsDir },
  ) as RuntimeToolResult;

  return {
    catalog,
    async run(name: string, input: Record<string, unknown>, _opts: { signal?: AbortSignal | null } = {}): Promise<RuntimeToolResult> {
      const entry = catalog.find((item) => item.name === name);
      if (entry?.kind === 'host') {
        if (!options.hostToolClient) return { content: '[E_RUNTIME_HOST_TOOL_DISABLED] CogSeed host tools are unavailable', isError: true };
        try {
          return capRuntimeResult(name, await options.hostToolClient.call({
            requestId: options.requestId ?? `req-${options.runtimeSessionId.replace(/^mruntime-/, '')}`,
            runtimeSessionId: options.runtimeSessionId,
            name: name as RuntimeHostToolName,
            input,
            signal: _opts.signal,
          }));
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      }
      if (name === 'bash') {
        return runRuntimeBashTool(input as { command?: string; timeoutMs?: number; working_dir?: string }, callContext, {
          userId: options.userId,
          runtimeSessionId: options.runtimeSessionId,
          maxInlineTokens: capTokens,
          signal: _opts.signal,
        });
      }
      if (name === 'run_skill') {
        return runRuntimeSkillTool(input as { skill_id?: string; script?: string; args?: string[]; cwd?: string; agent_id?: string }, callContext, {
          userId: options.userId,
          runtimeSessionId: options.runtimeSessionId,
          maxInlineTokens: capTokens,
          signal: _opts.signal,
        });
      }
      if (name === 'list_connector_tools') {
        if (callContext.toolPolicy.connectors !== 'enabled' || (!options.connectorManager && !options.hostToolClient)) return { content: '[E_RUNTIME_CONNECTOR_DISABLED] CogSeed connectors are disabled', isError: true };
        if (options.hostToolClient) return capRuntimeResult(name, await options.hostToolClient.call({
          requestId: options.requestId ?? `req-${options.runtimeSessionId.replace(/^mruntime-/, '')}`,
          runtimeSessionId: options.runtimeSessionId, name: 'desktop_connector_list_tools', input, signal: _opts.signal,
        }));
        const connectorId = typeof input.connector_id === 'string' ? input.connector_id : undefined;
        const tools = connectorId
          ? await options.connectorManager!.listTools(options.userId, connectorId, _opts)
          : await options.connectorManager!.listAllTools(options.userId, _opts);
        return capRuntimeResult('list_connector_tools', { content: JSON.stringify(tools.map((tool) => ({ connector_id: tool.connectorId, tool_name: tool.name, exposed_name: tool.exposedName, description: tool.description, input_schema: tool.input_schema }))) });
      }
      if (name === 'call_connector_tool') {
        if (callContext.toolPolicy.connectors !== 'enabled' || (!options.connectorManager && !options.hostToolClient)) return { content: '[E_RUNTIME_CONNECTOR_DISABLED] CogSeed connectors are disabled', isError: true };
        if (typeof input.connector_id !== 'string' || typeof input.tool_name !== 'string' || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) return { content: '[E_RUNTIME_CONNECTOR_INPUT] connector_id, tool_name, and arguments are required', isError: true };
        const connectorId = input.connector_id.trim();
        const toolName = input.tool_name.trim();
        const args = input.arguments as Record<string, unknown>;
        // The desktop host owns connector visibility and each provider's
        // approval contract. Adding the generic external-service gate here
        // prompts on every read and double-prompts manager-approved changes.
        if (options.hostToolClient) return capRuntimeResult(name, await options.hostToolClient.call({
          requestId: options.requestId ?? `req-${options.runtimeSessionId.replace(/^mruntime-/, '')}`,
          runtimeSessionId: options.runtimeSessionId, name: 'desktop_connector_call_tool', input, signal: _opts.signal,
        }));
        const parameterKeys = Object.keys(args).sort();
        return runWithRuntimeActionApproval(callContext.actionApproval, {
          action: 'connector_call',
          target: `${connectorId} / ${toolName}`,
          scope: parameterKeys.length ? `仅调用该工具，参数字段：${parameterKeys.join('、')}` : '仅调用该工具，不携带参数字段',
          auditTarget: `Connector tool: ${connectorId}/${toolName}`,
          auditScope: parameterKeys.length ? `argument keys: ${parameterKeys.join(', ')}` : 'no argument keys',
          risk: 'high',
          reasons: ['external_service_call'],
          execution: { connector_id: connectorId, tool_name: toolName, arguments: args },
        }, async () => {
          try {
            const raw = await options.connectorManager!.callTool(options.userId, connectorId, toolName, args, _opts);
            // Meeting transcripts arrive twice (paragraph objects + flat text) and
            // quickly exceed the inline cap. Persist the flat text in the task
            // workspace and return transcript_path so the correction tools can
            // read it by path instead of the model re-reading spilled chunks.
            const { spillConnectorTranscript } = await import('../../../cogseed_backend/connector-transcript-spill');
            const spilled = spillConnectorTranscript(
              { content: JSON.stringify(raw) },
              {
                workingDir: options.workspaceRoot ?? options.allowedRoots[0] ?? '',
                writableRoots: options.writableRoots ?? options.allowedRoots,
              },
            );
            return capRuntimeResult('call_connector_tool', spilled);
          } catch (error) {
            return { content: (error instanceof Error ? error.message : String(error)), isError: true };
          }
        }, _opts.signal);
      }
      if (name === 'search_mate_kb') {
        if (!options.kbManager) return { content: '[E_RUNTIME_KB_DISABLED] CogSeed KB is unavailable', isError: true };
        if (typeof input.query !== 'string' || !input.query.trim()) return { content: '[E_RUNTIME_KB_INPUT] query is required', isError: true };
        try { return capRuntimeResult('search_mate_kb', { content: JSON.stringify(await options.kbManager.search(options.userId, input.query, { k: typeof input.k === 'number' ? input.k : 10 })) }); }
        catch (error) { return { content: (error instanceof Error ? error.message : String(error)), isError: true }; }
      }
      if (name === 'read_mate_kb') {
        if (!options.kbManager) return { content: '[E_RUNTIME_KB_DISABLED] CogSeed KB is unavailable', isError: true };
        if (typeof input.source_id !== 'string') return { content: '[E_RUNTIME_KB_INPUT] source_id is required', isError: true };
        try { return capRuntimeResult('read_mate_kb', { content: JSON.stringify(await options.kbManager.readSource(options.userId, input.source_id)) }); }
        catch (error) { return { content: (error instanceof Error ? error.message : String(error)), isError: true }; }
      }
      if (!isRuntimeFileTool(name)) {
        return { content: `[E_RUNTIME_UNKNOWN_TOOL] unknown runtime tool: ${name}`, isError: true };
      }
      return runRuntimeFileTool(name, input, { ...callContext, signal: _opts.signal }, {
        userId: options.userId,
        runtimeSessionId: options.runtimeSessionId,
        maxInlineTokens: capTokens,
      });
    },
  };
}

export { TOOL_CATALOG, getRuntimeToolCatalog } from './catalog';
