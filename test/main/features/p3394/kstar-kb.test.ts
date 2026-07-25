import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const upsertContextMock = vi.hoisted(() => vi.fn());
const enqueueMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: upsertContextMock,
  dropContext: vi.fn(),
}));

vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: enqueueMock,
}));

vi.mock('../../../../src/main/features/kb_vector', () => ({
  findBySha1: vi.fn(() => null),
}));

let root: string;
const uid = 'kstar-kb-user';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-p3394-kb-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  upsertContextMock.mockClear();
  enqueueMock.mockClear();
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.ORKAS_WORKSPACE_ROOT;
  vi.resetModules();
});

describe('P3394 KSTAR Knowledge Base promotion', () => {
  it('writes an approved ExperienceCandidate as a KB source markdown file and enqueues indexing', async () => {
    const runtime = await import('../../../../src/main/features/p3394/kstar-runtime');
    const kb = await import('../../../../src/main/features/p3394/kstar-kb');
    const paths = await import('../../../../src/main/paths');

    const run = await runtime.finalizeAgentTurn(uid, {
      conversationId: 'gconv-kb', agentId: 'writer-agent', turnId: 'turn-kb',
      messageId: 'msg-kb', actualResult: '实际交付结果：论文初稿完成',
      kstarDecision: {
        required: true,
        reason: 'durable deliverable',
        expectation: {
          situation: '已有研究报告',
          task: '写论文初稿',
          action_hat: '读取研究并写初稿',
          result_hat: '可审阅初稿',
        },
      },
      actualAction: 'writer-agent produced a draft file',
    });
    await runtime.updateKStarEngineRun(uid, run.id, {
      status: 'completed',
      reason: 'Meta-skill engine reported no patch action for this episode.',
      patch_status: 'not_needed',
      route_recommendation: { action: 'no_action', message: '无需操作' },
      tool_calls: [],
      updated_at: '2026-07-24T00:00:00.000Z',
    });
    const reviewed = await runtime.reviewKStarRun(uid, run.id, { decision: 'pass', notes: '验收通过' });
    const approved = await runtime.decideExperienceCandidate(uid, reviewed.experience_candidate!.id, 'approve');

    const promoted = await kb.promoteExperienceCandidateToKnowledgeBase(uid, approved.id);

    expect(promoted.ok).toBe(true);
    if (!promoted.ok) throw new Error(promoted.error);
    expect(promoted.path).toMatch(/^kstar-experiences\/\d{4}\/\d{2}\//);
    const fullPath = path.join(paths.userContextsDir(uid), promoted.path);
    expect(fs.existsSync(fullPath)).toBe(true);
    const content = fs.readFileSync(fullPath, 'utf8');
    expect(content).toContain('# KSTAR Experience');
    expect(content).toContain('已有研究报告');
    expect(content).toContain('写论文初稿');
    expect(content).toContain('实际交付结果：论文初稿完成');
    expect(content).toContain('Engine status: completed');
    expect(upsertContextMock).toHaveBeenCalledWith(uid, promoted.path);
    expect(enqueueMock).toHaveBeenCalledWith(uid, promoted.path, 'upsert');

    const persisted = await runtime.getExperienceCandidate(uid, approved.id);
    expect(persisted).toMatchObject({
      promotion_status: 'promoted',
      kb_path: promoted.path,
    });
  });
});
