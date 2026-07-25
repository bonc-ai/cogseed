import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mcpCalls = vi.hoisted(() => [] as Array<{ name: string; args: Record<string, unknown> }>);
const connectMock = vi.hoisted(() => vi.fn(async () => {}));
const closeMock = vi.hoisted(() => vi.fn(async () => {}));
const routeActionMock = vi.hoisted(() => ({ action: 'no_action', message: '无需操作' }));
const callToolMock = vi.hoisted(() => vi.fn(async (name: string, args: Record<string, unknown>) => {
  mcpCalls.push({ name, args });
  if (name === 'capture_interaction') {
    return { content: [{ type: 'text', text: JSON.stringify({ episode_id: 'engine-episode-1', task: args.user_query }) }] };
  }
  if (name === 'analyze_attribution') {
    return { content: [{ type: 'text', text: JSON.stringify({ attribution_id: 'attr-1', episode_id: args.episode_id, recommendation: { action: 'no_action' } }) }] };
  }
  if (name === 'route_recommendation') {
    return { content: [{ type: 'text', text: JSON.stringify(routeActionMock) }] };
  }
  return { content: [{ type: 'text', text: '{}' }] };
}));

vi.mock('../../../../src/main/features/connectors/mcp-client', () => ({
  McpConnection: vi.fn().mockImplementation(function MockMcpConnection() {
    return {
      connect: connectMock,
      callTool: callToolMock,
      close: closeMock,
    };
  }),
}));

let root: string;
const uid = 'kstar-engine-user';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-p3394-engine-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  delete process.env.ORKAS_KSTAR_ENGINE_COMMAND;
  delete process.env.ORKAS_KSTAR_ENGINE_ARGS;
  delete process.env.ORKAS_KSTAR_ENGINE_CWD;
  delete process.env.ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR;
  mcpCalls.length = 0;
  connectMock.mockClear();
  closeMock.mockClear();
  callToolMock.mockClear();
  routeActionMock.action = 'no_action';
  routeActionMock.message = '无需操作';
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.ORKAS_WORKSPACE_ROOT;
  delete process.env.ORKAS_KSTAR_ENGINE_COMMAND;
  delete process.env.ORKAS_KSTAR_ENGINE_ARGS;
  delete process.env.ORKAS_KSTAR_ENGINE_CWD;
  delete process.env.ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR;
  vi.resetModules();
});

describe('P3394 KSTAR engine adapter', () => {
  async function createRequiredRun() {
    const runtime = await import('../../../../src/main/features/p3394/kstar-runtime');
    return runtime.finalizeAgentTurn(uid, {
      conversationId: 'gconv-engine',
      agentId: 'writer-agent',
      turnId: 'turn-engine',
      messageId: 'msg-engine',
      actualResult: 'actual result text',
      kstarDecision: {
        required: true,
        reason: 'durable deliverable',
        expectation: {
          situation: 'research exists',
          task: 'write draft',
          action_hat: 'read research and write draft',
          result_hat: 'reviewable draft',
          k_snapshot_ref: 'conversation:gconv-engine',
        },
      },
      actualAction: 'writer-agent completed the delegated turn',
    });
  }

  it('records skipped engine state when MCP command is not configured', async () => {
    const run = await createRequiredRun();
    const engine = await import('../../../../src/main/features/p3394/kstar-engine');
    const result = await engine.runKStarEngineForRun(uid, run);

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('not configured');
    expect(connectMock).not.toHaveBeenCalled();

    const runtime = await import('../../../../src/main/features/p3394/kstar-runtime');
    const persisted = await runtime.getKStarRun(uid, run.id);
    expect(persisted?.kstar_engine?.status).toBe('skipped');
  });

  it('calls capture_interaction, analyze_attribution, and route_recommendation through the MCP engine', async () => {
    process.env.ORKAS_KSTAR_ENGINE_COMMAND = 'node';
    process.env.ORKAS_KSTAR_ENGINE_ARGS = '["/tmp/meta-skill-engine/dist/index.js"]';
    const run = await createRequiredRun();
    const engine = await import('../../../../src/main/features/p3394/kstar-engine');
    const result = await engine.runKStarEngineForRun(uid, run);

    expect(result.status).toBe('completed');
    expect(mcpCalls.map((call) => call.name)).toEqual([
      'capture_interaction',
      'analyze_attribution',
      'route_recommendation',
    ]);
    expect(mcpCalls[0].args).toMatchObject({
      session_id: 'gconv-engine',
      user_id: uid,
      user_query: 'write draft',
      agent_id: 'writer-agent',
      predicted_action: 'read research and write draft',
      predicted_result: 'reviewable draft',
      actual_action: 'writer-agent completed the delegated turn',
      actual_result: 'actual result text',
    });
    expect(result.patch_status).toBe('not_needed');
    expect(closeMock).toHaveBeenCalled();

    const runtime = await import('../../../../src/main/features/p3394/kstar-runtime');
    const persisted = await runtime.getKStarRun(uid, run.id);
    expect(persisted?.kstar_engine).toMatchObject({
      status: 'completed',
      patch_status: 'not_needed',
    });
  });

  it('creates a reviewable PatchCandidate when the engine recommends an improvement', async () => {
    process.env.ORKAS_KSTAR_ENGINE_COMMAND = 'node';
    process.env.ORKAS_KSTAR_ENGINE_ARGS = '["/tmp/meta-skill-engine/dist/index.js"]';
    routeActionMock.action = 'propose_skill_patch';
    routeActionMock.message = 'Skill workflow should mention chunked writing.';
    const run = await createRequiredRun();
    const engine = await import('../../../../src/main/features/p3394/kstar-engine');
    await engine.runKStarEngineForRun(uid, run);

    const runtime = await import('../../../../src/main/features/p3394/kstar-runtime');
    const candidates = await runtime.listPatchCandidates(uid, 'gconv-engine');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source_run_id: run.id,
      conversation_id: 'gconv-engine',
      type: 'skill_patch',
      status: 'needs_review',
      engine: { route_action: 'propose_skill_patch' },
    });
    expect(candidates[0].proposal.summary).toContain('chunked writing');
  });
});
