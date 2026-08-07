import { capToolResult, DEFAULT_INLINE_RESULT_TOKENS } from '../../../../util/tool-result-cap';
import type { RuntimeToolPolicy } from '../types';
import { TOOL_CATALOG, type RuntimeToolCatalogEntry, type RuntimeToolName, getRuntimeToolCatalog } from './catalog';
import { RUNTIME_FILE_TOOLS, runRuntimeFileTool, type RuntimeToolCallContext, type RuntimeToolResult } from './file-tools';
import { normalizeRuntimeRoots } from './permissions';
import { runRuntimeBashTool } from './shell-tools';
import { runRuntimeSkillTool } from './skill-tools';
import type { MateConnectorManager } from '../../../mate_agent_backend/connector-manager';
import type { MateKbManager } from '../../../mate_agent_backend/mate-kb-store';
import { mateRuntimeSessionToolResultsDir } from '../../../../paths';
import type { RuntimeHostToolName } from '../../protocol';
import type { RuntimeHostToolClient } from './host-tools';

export interface RuntimeToolRunnerOptions {
  userId: string;
  runtimeSessionId: string;
  requestId?: string;
  allowedRoots: readonly string[];
  writableRoots?: readonly string[];
  pcDir?: string;
  toolPolicy: RuntimeToolPolicy;
  maxInlineToolResultTokens?: number;
  connectorManager?: MateConnectorManager;
  kbManager?: MateKbManager;
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
  const catalog = getRuntimeToolCatalog();
  const allowedRoots = normalizeRuntimeRoots(options.allowedRoots);
  const writableRoots = normalizeRuntimeRoots(options.writableRoots ?? []);
  const callContext: RuntimeToolCallContext = {
    userId: options.userId,
    runtimeSessionId: options.runtimeSessionId,
    allowedRoots,
    writableRoots,
    pcDir: options.pcDir ?? process.cwd(),
    toolPolicy: options.toolPolicy,
  };
  const capTokens = options.maxInlineToolResultTokens ?? DEFAULT_INLINE_RESULT_TOKENS;
  const toolResultsDir = mateRuntimeSessionToolResultsDir(options.userId, options.runtimeSessionId);
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
        if (!options.hostToolClient) return { content: '[E_RUNTIME_HOST_TOOL_DISABLED] Mate host tools are unavailable', isError: true };
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
        });
      }
      if (name === 'run_skill') {
        return runRuntimeSkillTool(input as { skill_id?: string; script?: string; args?: string[]; cwd?: string; agent_id?: string }, callContext, {
          userId: options.userId,
          runtimeSessionId: options.runtimeSessionId,
          maxInlineTokens: capTokens,
        });
      }
      if (name === 'list_connector_tools') {
        if (callContext.toolPolicy.connectors !== 'enabled' || !options.connectorManager) return { content: '[E_RUNTIME_CONNECTOR_DISABLED] Mate connectors are disabled', isError: true };
        const connectorId = typeof input.connector_id === 'string' ? input.connector_id : undefined;
        const tools = connectorId
          ? await options.connectorManager.listTools(options.userId, connectorId, _opts)
          : await options.connectorManager.listAllTools(options.userId, _opts);
        return capRuntimeResult('list_connector_tools', { content: JSON.stringify(tools.map((tool) => ({ connector_id: tool.connectorId, tool_name: tool.name, exposed_name: tool.exposedName, description: tool.description, input_schema: tool.input_schema }))) });
      }
      if (name === 'call_connector_tool') {
        if (callContext.toolPolicy.connectors !== 'enabled' || !options.connectorManager) return { content: '[E_RUNTIME_CONNECTOR_DISABLED] Mate connectors are disabled', isError: true };
        if (typeof input.connector_id !== 'string' || typeof input.tool_name !== 'string' || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) return { content: '[E_RUNTIME_CONNECTOR_INPUT] connector_id, tool_name, and arguments are required', isError: true };
        try {
          return capRuntimeResult('call_connector_tool', { content: JSON.stringify(await options.connectorManager.callTool(options.userId, input.connector_id, input.tool_name, input.arguments as Record<string, unknown>, _opts)) });
        } catch (error) {
          return { content: (error instanceof Error ? error.message : String(error)), isError: true };
        }
      }
      if (name === 'search_mate_kb') {
        if (!options.kbManager) return { content: '[E_RUNTIME_KB_DISABLED] Mate KB is unavailable', isError: true };
        if (typeof input.query !== 'string' || !input.query.trim()) return { content: '[E_RUNTIME_KB_INPUT] query is required', isError: true };
        try { return capRuntimeResult('search_mate_kb', { content: JSON.stringify(await options.kbManager.search(options.userId, input.query, { k: typeof input.k === 'number' ? input.k : 10 })) }); }
        catch (error) { return { content: (error instanceof Error ? error.message : String(error)), isError: true }; }
      }
      if (name === 'read_mate_kb') {
        if (!options.kbManager) return { content: '[E_RUNTIME_KB_DISABLED] Mate KB is unavailable', isError: true };
        if (typeof input.source_id !== 'string') return { content: '[E_RUNTIME_KB_INPUT] source_id is required', isError: true };
        try { return capRuntimeResult('read_mate_kb', { content: JSON.stringify(await options.kbManager.readSource(options.userId, input.source_id)) }); }
        catch (error) { return { content: (error instanceof Error ? error.message : String(error)), isError: true }; }
      }
      if (!isRuntimeFileTool(name)) {
        return { content: `[E_RUNTIME_UNKNOWN_TOOL] unknown runtime tool: ${name}`, isError: true };
      }
      return runRuntimeFileTool(name, input, callContext, {
        userId: options.userId,
        runtimeSessionId: options.runtimeSessionId,
        maxInlineTokens: capTokens,
      });
    },
  };
}

export { TOOL_CATALOG, getRuntimeToolCatalog } from './catalog';
