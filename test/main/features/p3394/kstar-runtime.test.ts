import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root: string;
const uid = 'kstar-user';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-p3394-kstar-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.ORKAS_WORKSPACE_ROOT;
  vi.resetModules();
});

describe('P3394 KSTAR runtime', () => {
  it('adapts an Orkas Agent run and final message into a needs_review KSTAR run', async () => {
    const kstar = await import('../../../../src/main/features/p3394/kstar-runtime');
    await kstar.recordAgentRunEvidence(uid, {
      conversationId: 'conv-1', agentId: 'agent-1', turnId: 'turn-1',
      data: { status: 'completed', duration_ms: 1200, provider_ms: 800 },
    });
    const run = await kstar.finalizeAgentTurn(uid, {
      conversationId: 'conv-1', agentId: 'agent-1', turnId: 'turn-1',
      messageId: 'message-1', actualResult: '实现完成并通过测试',
    });

    expect(run.status).toBe('needs_review');
    expect(run.evidence_items).toEqual([
      expect.objectContaining({ type: 'agent_run_result', source_id: 'turn-1' }),
      expect.objectContaining({ type: 'conversation_message', source_id: 'message-1' }),
    ]);

    vi.resetModules();
    const reloaded = await import('../../../../src/main/features/p3394/kstar-runtime');
    expect(await reloaded.listKStarRuns(uid, 'conv-1')).toEqual([
      expect.objectContaining({ id: run.id, status: 'needs_review' }),
    ]);
  });


  it('stores first-stage KSTAR-compatible episode data when required by Commander', async () => {
    const kstar = await import('../../../../src/main/features/p3394/kstar-runtime');
    const run = await kstar.finalizeAgentTurn(uid, {
      conversationId: 'gconv-test', agentId: 'content-writer', turnId: 'turn-kstar-required',
      messageId: 'message-kstar-required', actualResult: 'final result text',
      kstarDecision: {
        required: true,
        reason: '论文初稿需要验收和证据闭环',
        expectation: {
          situation: 'DeepResearcher 已完成研究报告',
          task: '根据研究报告写论文初稿',
          action_hat: '读取研究报告并生成论文初稿文件',
          result_hat: '得到结构完整且引用可追溯的初稿',
          k_snapshot_ref: 'conversation:gconv-test',
        },
      },
      actualAction: 'ContentWriter generated /tmp/draft.md and summarized the result',
    });

    expect(run.status).toBe('needs_review');
    expect(run.kstar_decision?.required).toBe(true);
    expect(run.kstar_decision?.reason).toBe('论文初稿需要验收和证据闭环');
    expect(run.kstar_episode?.k_snapshot_ref).toBe('conversation:gconv-test');
    expect(run.kstar_episode?.situation).toBe('DeepResearcher 已完成研究报告');
    expect(run.kstar_episode?.task).toBe('根据研究报告写论文初稿');
    expect(run.kstar_episode?.action_hat).toContain('读取研究报告');
    expect(run.kstar_episode?.result_hat).toContain('结构完整');
    expect(run.kstar_episode?.actual_action).toContain('generated');
    expect(run.kstar_episode?.actual_result).toBe('final result text');
    expect(run.kstar_episode?.delta_r).toBe(0);
    expect(run.kstar_episode?.delta_a).toBe(0);
    expect(run.kstar_episode?.delta_a_confidence_gate).toBe('pass');

    const [persisted] = await kstar.listKStarRuns(uid, 'gconv-test');
    expect(persisted.kstar_episode).toMatchObject({
      task: '根据研究报告写论文初稿',
      actual_result: 'final result text',
    });
  });

  it('records tool-level KSTAR cycles and attaches them to finalized runs', async () => {
    const kstar = await import('../../../../src/main/features/p3394/kstar-runtime');
    const cycle = await kstar.recordKStarToolCycle(uid, {
      conversationId: 'conv-tools',
      agentId: 'agent-tools',
      turnId: 'turn-tools',
      toolCallId: 'tool-1',
      toolName: 'bash',
      phase: 'end',
      argumentsShape: { command: 'npm test' },
      resultPreview: 'Error: test failed',
      isError: true,
      durationMs: 345,
    });

    expect(cycle).toMatchObject({
      conversation_id: 'conv-tools',
      agent_id: 'agent-tools',
      turn_id: 'turn-tools',
      tool_call_id: 'tool-1',
      tool_name: 'bash',
      status: 'failed',
      verifier_method: 'error_signal',
    });
    expect(cycle.r_hat).toBeGreaterThan(0);
    expect(cycle.r).toBeLessThan(cycle.r_hat);
    expect(cycle.delta_r).toBeLessThan(0);

    const listed = await kstar.listKStarToolCycles(uid, 'conv-tools');
    expect(listed).toEqual([expect.objectContaining({ id: cycle.id, result_preview: 'Error: test failed' })]);

    const run = await kstar.finalizeAgentTurn(uid, {
      conversationId: 'conv-tools', agentId: 'agent-tools', turnId: 'turn-tools',
      messageId: 'message-tools', actualResult: '工具执行失败，需要修复',
      kstarDecision: {
        required: true,
        reason: 'tool evidence should support attribution',
        expectation: { task: 'run tests', action_hat: 'execute npm test', result_hat: 'tests pass' },
      },
    });

    expect(run.evidence_items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_cycle', source_id: cycle.id }),
      expect.objectContaining({ type: 'conversation_message', source_id: 'message-tools' }),
    ]));
  });

  it('creates an ExperienceCandidate only after a passed human review', async () => {
    const kstar = await import('../../../../src/main/features/p3394/kstar-runtime');
    await kstar.recordAgentRunEvidence(uid, {
      conversationId: 'conv-1', agentId: 'agent-1', turnId: 'turn-pass',
      data: { status: 'completed' },
    });
    const run = await kstar.finalizeAgentTurn(uid, {
      conversationId: 'conv-1', agentId: 'agent-1', turnId: 'turn-pass',
      messageId: 'message-pass', actualResult: '可复用的交付结果',
    });

    const reviewed = await kstar.reviewKStarRun(uid, run.id, {
      decision: 'pass', notes: '验收通过',
    });
    expect(reviewed.run.status).toBe('completed');
    expect(reviewed.run.verification).toMatchObject({ status: 'passed', notes: '验收通过' });
    expect(reviewed.experience_candidate).toMatchObject({ status: 'pending', source_run_id: run.id });

    const promoted = await kstar.decideExperienceCandidate(uid, reviewed.experience_candidate!.id, 'approve');
    expect(promoted.status).toBe('approved');
  });

  it('lists persisted experience candidates by conversation for history hydration', async () => {
    const kstar = await import('../../../../src/main/features/p3394/kstar-runtime');
    const firstRun = await kstar.finalizeAgentTurn(uid, {
      conversationId: 'conv-1', agentId: 'agent-1', turnId: 'turn-list-1',
      messageId: 'message-list-1', actualResult: '第一条可复用经验',
    });
    const secondRun = await kstar.finalizeAgentTurn(uid, {
      conversationId: 'conv-2', agentId: 'agent-2', turnId: 'turn-list-2',
      messageId: 'message-list-2', actualResult: '第二条可复用经验',
    });
    const firstReview = await kstar.reviewKStarRun(uid, firstRun.id, { decision: 'pass' });
    await kstar.reviewKStarRun(uid, secondRun.id, { decision: 'pass' });

    expect(await kstar.listExperienceCandidates(uid, 'conv-1')).toEqual([
      expect.objectContaining({
        id: firstReview.experience_candidate?.id,
        source_run_id: firstRun.id,
        conversation_id: 'conv-1',
        status: 'pending',
      }),
    ]);
  });


  it('lists and reviews patch candidates with session-scoped state', async () => {
    const runtime = await import('../../../../src/main/features/p3394/kstar-runtime');
    const firstRun = await runtime.finalizeAgentTurn(uid, {
      conversationId: 'gconv-patch-a', agentId: 'writer-agent', turnId: 'turn-patch-a',
      messageId: 'msg-patch-a', actualResult: 'draft result',
      kstarDecision: {
        required: true,
        reason: 'durable deliverable',
        expectation: { task: 'write draft', action_hat: 'draft', result_hat: 'reviewable draft' },
      },
    });
    const secondRun = await runtime.finalizeAgentTurn(uid, {
      conversationId: 'gconv-patch-b', agentId: 'writer-agent', turnId: 'turn-patch-b',
      messageId: 'msg-patch-b', actualResult: 'other draft result',
      kstarDecision: {
        required: true,
        reason: 'other durable deliverable',
        expectation: { task: 'write other draft', action_hat: 'draft', result_hat: 'reviewable draft' },
      },
    });
    await runtime.createPatchCandidateFromEngineRun(uid, firstRun.id, {
      status: 'completed',
      tool_calls: [],
      route_recommendation: { action: 'propose_skill_patch', message: 'Add chunked writing guidance.' },
      analyze_attribution: { attribution_id: 'attr-a' },
      reason: 'Skill workflow should improve long writing.',
      updated_at: new Date().toISOString(),
    });
    await runtime.createPatchCandidateFromEngineRun(uid, secondRun.id, {
      status: 'completed',
      tool_calls: [],
      route_recommendation: { action: 'propose_memory_patch', message: 'Remember another workflow.' },
      analyze_attribution: { attribution_id: 'attr-b' },
      reason: 'Memory workflow should improve recall.',
      updated_at: new Date().toISOString(),
    });

    const candidates = await runtime.listPatchCandidates(uid, 'gconv-patch-a');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      conversation_id: 'gconv-patch-a',
      source_run_id: firstRun.id,
      status: 'needs_review',
      engine: { route_action: 'propose_skill_patch', attribution_id: 'attr-a' },
    });

    const reviewed = await runtime.reviewPatchCandidate(uid, candidates[0].id, 'approve', 'looks good');
    expect(reviewed.status).toBe('approved');
    expect(reviewed.review).toMatchObject({ decision: 'approve', notes: 'looks good' });
    const refreshed = await runtime.listPatchCandidates(uid, 'gconv-patch-a');
    expect(refreshed[0].status).toBe('approved');
  });
  it('records a failed review without promoting experience', async () => {
    const kstar = await import('../../../../src/main/features/p3394/kstar-runtime');
    const run = await kstar.finalizeAgentTurn(uid, {
      conversationId: 'conv-1', agentId: 'agent-1', turnId: 'turn-fail',
      messageId: 'message-fail', actualResult: '结果不完整',
    });
    const reviewed = await kstar.reviewKStarRun(uid, run.id, {
      decision: 'fail', notes: '缺少测试证据',
    });
    expect(reviewed.run.status).toBe('failed');
    expect(reviewed.run.verification?.status).toBe('failed');
    expect(reviewed.experience_candidate).toBeNull();
  });
});
