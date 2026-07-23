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
