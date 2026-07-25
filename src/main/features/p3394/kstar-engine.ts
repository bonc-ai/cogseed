import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { McpConnection } from '../connectors/mcp-client';
import type { Transport } from '../connectors/types';
import type { KStarEngineRun, KStarRun } from './kstar-runtime';
import { createPatchCandidateFromEngineRun, updateKStarEngineRun } from './kstar-runtime';

const log = createLogger('p3394:kstar-engine');

const ENGINE_CALL_TIMEOUT_MS = 60_000;

type EngineToolName =
  | 'capture_interaction'
  | 'analyze_attribution'
  | 'route_recommendation'
  | 'propose_patch'
  | 'run_governance'
  | 'human_review';

interface EngineConfig {
  enabled: boolean;
  transport?: Transport;
  reason?: string;
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
    } catch { /* fall through */ }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function resolveEngineConfig(): EngineConfig {
  const command = (process.env.ORKAS_KSTAR_ENGINE_COMMAND || '').trim();
  if (!command) {
    return { enabled: false, reason: 'KSTAR engine MCP command is not configured.' };
  }
  const env: Record<string, string> = {};
  const ontologyDir = (process.env.ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR || '').trim();
  if (ontologyDir) env.NSEAP_ONTOLOGY_DIR = ontologyDir;
  return {
    enabled: true,
    transport: {
      kind: 'stdio',
      command,
      args: parseArgs(process.env.ORKAS_KSTAR_ENGINE_ARGS),
      env,
      ...(process.env.ORKAS_KSTAR_ENGINE_CWD ? { cwd: process.env.ORKAS_KSTAR_ENGINE_CWD } : {}),
    },
  };
}

function textFromMcpResult(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') {
        return String((item as { text?: unknown }).text || '');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseMcpJson(result: unknown): unknown {
  const text = textFromMcpResult(result);
  if (!text.trim()) return result;
  try { return JSON.parse(text); }
  catch { return { text }; }
}

function idFrom(obj: unknown, key: string): string {
  if (!obj || typeof obj !== 'object') return '';
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function asRecord(obj: unknown): Record<string, unknown> {
  return obj && typeof obj === 'object' ? obj as Record<string, unknown> : {};
}

async function callEngineTool(
  conn: McpConnection,
  name: EngineToolName,
  args: Record<string, unknown>,
  toolCalls: KStarEngineRun['tool_calls'],
): Promise<unknown> {
  const raw = await conn.callTool(name, args, { timeoutMs: ENGINE_CALL_TIMEOUT_MS });
  const parsed = parseMcpJson(raw);
  const parsedRecord = asRecord(parsed);
  toolCalls.push({
    name,
    status: parsedRecord.error ? 'failed' : 'completed',
    arguments: args,
    result: parsedRecord,
  });
  return parsed;
}

export async function runKStarEngineForRun(uid: string, run: KStarRun): Promise<KStarEngineRun> {
  const now = new Date().toISOString();
  if (!run.kstar_episode) {
    const skipped: KStarEngineRun = {
      status: 'skipped',
      reason: 'KSTAR run has no compatible episode payload.',
      tool_calls: [],
      updated_at: now,
    };
    await updateKStarEngineRun(uid, run.id, skipped);
    return skipped;
  }

  const config = resolveEngineConfig();
  if (!config.enabled || !config.transport) {
    const skipped: KStarEngineRun = {
      status: 'skipped',
      reason: config.reason || 'KSTAR engine MCP is disabled.',
      tool_calls: [],
      updated_at: now,
    };
    await updateKStarEngineRun(uid, run.id, skipped);
    return skipped;
  }

  const toolCalls: KStarEngineRun['tool_calls'] = [];
  const conn = new McpConnection('p3394-kstar-engine', config.transport);
  try {
    await conn.connect();
    const captured = await callEngineTool(conn, 'capture_interaction', {
      session_id: run.kstar_episode.session_id,
      user_id: uid,
      user_query: run.kstar_episode.task,
      agent_id: run.agent_id,
      matched_skill_id: null,
      matched_skill_name: null,
      ontology_refs: run.kstar_episode.k_snapshot_ref ? [run.kstar_episode.k_snapshot_ref] : [],
      predicted_action: run.kstar_episode.action_hat,
      predicted_result: run.kstar_episode.result_hat,
      actual_action: run.kstar_episode.actual_action,
      actual_result: run.kstar_episode.actual_result,
    }, toolCalls);

    const episodeId = idFrom(captured, 'episode_id') || run.kstar_episode.episode_id;
    const attribution = await callEngineTool(conn, 'analyze_attribution', { episode_id: episodeId }, toolCalls);
    const attributionId = idFrom(attribution, 'attribution_id');
    let route: unknown = null;
    if (attributionId) {
      route = await callEngineTool(conn, 'route_recommendation', { attribution_id: attributionId }, toolCalls);
    }

    const routeAction = typeof asRecord(route).action === 'string' ? String(asRecord(route).action) : 'unknown';
    const result: KStarEngineRun = {
      status: 'completed',
      tool_calls: toolCalls,
      capture_interaction: asRecord(captured),
      analyze_attribution: asRecord(attribution),
      route_recommendation: route ? asRecord(route) : undefined,
      patch_status: routeAction === 'no_action'
        ? 'not_needed'
        : 'not_attempted_without_patch_candidate',
      reason: routeAction === 'no_action'
        ? 'Meta-skill engine reported no patch action for this episode.'
        : 'Patch proposal/governance requires a concrete patch candidate and remains gated.',
      updated_at: new Date().toISOString(),
    };
    await updateKStarEngineRun(uid, run.id, result);
    await createPatchCandidateFromEngineRun(uid, run.id, result);
    return result;
  } catch (err) {
    const failed: KStarEngineRun = {
      status: 'failed',
      reason: (err as Error).message || 'KSTAR engine failed.',
      error: logErrorSummary(err),
      tool_calls: toolCalls,
      updated_at: new Date().toISOString(),
    };
    await updateKStarEngineRun(uid, run.id, failed);
    log.warn('KSTAR engine run failed', { run_id: run.id, error: logErrorSummary(err) });
    return failed;
  } finally {
    await conn.close().catch(() => {});
  }
}
