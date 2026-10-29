import type { AgentTool, ToolResult } from '#core-agent';
import { inspectCreatorRuntime } from './inspect-service';
import { getWorkspacePath } from '../user_workspace';
import {
  listCreatorPresetSummaries,
  readCreatorPresetVersion,
} from './store';
import { runCreatorSimulation, type CreatorSimulationResult } from './simulation-service';
import { verifyCreatorPreset, type CreatorVerificationReport } from './verification-service';
import type { CreatorPresetManifestV1 } from './types';
import { creatorValidationScript, runCreatorValidation } from '../../security/creator-validation-runner';

const MAX_OUTPUT = 8_000;
export const CREATOR_AGENT_TOOL_NAMES = [
  'creator_runtime_inspect', 'creator_preset_list', 'creator_preset_read',
  'creator_run_validation', 'creator_simulate_draft', 'creator_verify_draft',
] as const;

export type CreatorAgentToolName = typeof CREATOR_AGENT_TOOL_NAMES[number];
export type { CreatorValidationCheckId } from '../../security/creator-validation-runner';

type ResultValue = Record<string, unknown> | unknown[];
const result = (value: ResultValue): ToolResult => ({ content: JSON.stringify(value) });
const errorResult = (error: unknown): ToolResult => ({
  content: JSON.stringify({ ok: false, error_code: error instanceof Error ? error.message : 'creator_tool_failed' }),
  isError: true,
});

export function filterCreatorAgentTools<T extends { name: string }>(tools: readonly T[]): T[] {
  const allowed = new Set<string>([
    'read_file', 'stat_file', 'search_files', 'grep_files', 'list_files',
    'kb_list', 'kb_search', 'kb_read', 'tool_result_search', 'tool_result_read_chunk',
    ...CREATOR_AGENT_TOOL_NAMES,
  ]);
  return tools.filter((tool) => allowed.has(tool.name));
}

export { creatorValidationScript };

export interface CreatorAgentToolDependencies {
  inspect?: (userId: string) => Promise<unknown>;
  list?: (userId: string) => Promise<unknown>;
  read?: (userId: string, presetId: string, version: string) => Promise<unknown>;
  simulate?: (userId: string, input: Record<string, unknown>) => Promise<unknown>;
  verify?: (userId: string, input: Record<string, unknown>) => Promise<unknown>;
  runValidation?: (checkId: string, workingDir: string, signal?: AbortSignal) => Promise<unknown>;
}

export interface CreatorAgentToolOptions extends CreatorAgentToolDependencies {
  userId: string;
  projectId?: string;
  workingDir?: string;
}

function text(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === 'string' ? input[key] : '';
}

function bounded(value: unknown): string {
  const textValue = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return textValue.length > MAX_OUTPUT ? `${textValue.slice(0, MAX_OUTPUT)}…` : textValue;
}

async function defaultValidation(checkId: string, workingDir: string, signal?: AbortSignal): Promise<unknown> {
  void checkId;
  void workingDir;
  void signal;
  throw new Error('creator_validation_executor_unavailable');
}

function manifestInput(input: Record<string, unknown>): CreatorPresetManifestV1 {
  if (!input.manifest || typeof input.manifest !== 'object') throw new Error('creator_manifest_required');
  return input.manifest as CreatorPresetManifestV1;
}

export function createCreatorAgentTools(options: CreatorAgentToolOptions): AgentTool[] {
  const inspect = options.inspect ?? ((userId) => inspectCreatorRuntime(userId));
  const list = options.list ?? ((userId) => listCreatorPresetSummaries(userId));
  const read = options.read ?? ((userId, presetId, version) => readCreatorPresetVersion(userId, presetId, version));
  const runValidation = options.runValidation ?? defaultValidation;
  const workingDir = options.workingDir ?? getWorkspacePath(options.userId, options.projectId);
  return [
    {
      name: 'creator_runtime_inspect', description: 'Inspect the redacted Creator runtime catalog and limits.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, executionMode: 'parallel',
      async execute() { try { return result({ ok: true, inspection: await inspect(options.userId) }); } catch (e) { return errorResult(e); } },
    },
    {
      name: 'creator_preset_list', description: 'List safe summaries of available Creator presets.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, executionMode: 'parallel',
      async execute() { try { return result({ ok: true, presets: await list(options.userId) }); } catch (e) { return errorResult(e); } },
    },
    {
      name: 'creator_preset_read', description: 'Read one approved Creator preset version by identifier.',
      inputSchema: { type: 'object', properties: { preset_id: { type: 'string' }, version: { type: 'string' } }, required: ['preset_id', 'version'], additionalProperties: false }, executionMode: 'parallel',
      async execute(input) { try { const presetId = text(input, 'preset_id'); const version = text(input, 'version'); if (!presetId || !version) throw new Error('creator_preset_identifier_required'); return result({ ok: true, preset: await read(options.userId, presetId, version) }); } catch (e) { return errorResult(e); } },
    },
    {
      name: 'creator_run_validation', description: 'Run one fixed, bounded npm validation script: typecheck, test, lint, or smoke.',
      inputSchema: { type: 'object', properties: { check_id: { type: 'string', enum: ['typecheck', 'test', 'lint', 'smoke'] } }, required: ['check_id'], additionalProperties: false }, executionMode: 'sequential',
      async execute(input, ctx) { try { const checkId = text(input, 'check_id'); creatorValidationScript(checkId); return result({ ok: true, validation: await runValidation(checkId, workingDir, ctx.signal) }); } catch (e) { return errorResult(e); } },
    },
    {
      name: 'creator_simulate_draft', description: 'Simulate a draft in the disposable Creator scope without publishing or mutating live state.',
      inputSchema: { type: 'object', properties: { manifest: { type: 'object' }, catalog_snapshot: { type: 'array' }, actions: { type: 'array' } }, required: ['manifest'], additionalProperties: false },
      async execute(input, ctx) { try { const simulate = options.simulate ?? ((userId, value) => runCreatorSimulation(userId, value as any)); return result({ ok: true, simulation: await simulate(options.userId, {
          manifest: manifestInput(input),
          catalogSnapshot: Array.isArray(input.catalog_snapshot) ? input.catalog_snapshot : [],
          actions: Array.isArray(input.actions) ? input.actions : [],
          ...(typeof input.timeout_ms === 'number' ? { timeoutMs: input.timeout_ms } : {}),
          signal: ctx.signal,
        }) }); } catch (e) { return errorResult(e); } },
    },
    {
      name: 'creator_verify_draft', description: 'Verify a draft against Creator policy checks without publishing it.',
      inputSchema: { type: 'object', properties: { manifest: { type: 'object' }, catalog_snapshot: { type: 'array' } }, required: ['manifest', 'catalog_snapshot'], additionalProperties: false },
      async execute(input, ctx) { try { const verify = options.verify ?? ((userId, value) => verifyCreatorPreset(userId, { manifest: manifestInput(value), catalogSnapshot: Array.isArray(value.catalog_snapshot) ? value.catalog_snapshot as any : [], signal: ctx.signal })); return result({ ok: true, verification: await verify(options.userId, input) }); } catch (e) { return errorResult(e); } },
    },
  ];
}
