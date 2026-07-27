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
  async function seedApprovedExperience() {
    const run = {
      id: 'run-kb',
      conversation_id: 'gconv-kb',
      agent_id: 'writer-agent',
      turn_id: 'turn-kb',
      status: 'completed',
      actual_result: '实际交付结果：论文初稿完成',
      evidence_items: [],
      verification: { status: 'passed', notes: '验收通过', reviewed_at: '2026-07-24T00:00:00.000Z' },
      kstar_decision: {
        required: true,
        reason: 'durable deliverable',
        expectation: {
          situation: '已有研究报告',
          task: '写论文初稿',
          action_hat: '读取研究并写初稿',
          result_hat: '可审阅初稿',
        },
      },
      kstar_episode: {
        episode_id: 'ep-kb',
        bundle_id: 'bundle-kb',
        k_snapshot_ref: 'conversation:gconv-kb',
        situation: '已有研究报告',
        task: '写论文初稿',
        action_hat: '读取研究并写初稿',
        result_hat: '可审阅初稿',
        actual_action: 'writer-agent produced a draft file',
        actual_result: '实际交付结果：论文初稿完成',
        delta_r: 0,
        delta_a: 0,
        delta_a_confidence_gate: 'pass',
        timestamp: '2026-07-24T00:00:00.000Z',
        session_id: 'gconv-kb',
      },
      kstar_engine: {
        status: 'completed',
        reason: 'Meta-skill engine reported no patch action for this episode.',
        patch_status: 'not_needed',
        route_recommendation: { action: 'no_action', message: '无需操作' },
        tool_calls: [],
        updated_at: '2026-07-24T00:00:00.000Z',
      },
      experience_candidate_id: 'exp-kb',
      created_at: '2026-07-24T00:00:00.000Z',
      updated_at: '2026-07-24T00:00:00.000Z',
    };
    const candidate = {
      id: 'exp-kb',
      source_run_id: run.id,
      conversation_id: run.conversation_id,
      agent_id: run.agent_id,
      summary: run.actual_result,
      status: 'approved',
      promotion_status: 'none',
      created_at: '2026-07-24T00:00:00.000Z',
      updated_at: '2026-07-24T00:00:00.000Z',
    };
    const statePath = path.join(root, uid, 'local', 'p3394', 'kstar-state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, runs: [run], experience_candidates: [candidate], patch_candidates: [], updated_at: '2026-07-24T00:00:00.000Z' }, null, 2));
    return { run, candidate };
  }

  it('writes an approved ExperienceCandidate as a KB source markdown file and enqueues indexing', async () => {
    const kb = await import('../../../../src/main/features/p3394/kstar-kb');
    const legacy = await import('../../../../src/main/features/p3394/kstar-legacy-data');
    const paths = await import('../../../../src/main/paths');
    const { candidate: approved } = await seedApprovedExperience();

    const promoted = await kb.promoteExperienceCandidateToKnowledgeBase(uid, approved.id);

    expect(promoted.ok).toBe(true);
    if (!promoted.ok) throw new Error(promoted.error);
    expect(promoted.path).toMatch(/^kstar-experiences\/\d{4}\/\d{2}\//);
    const fullPath = path.join(paths.userContextsDir(uid), promoted.path);
    expect(fs.existsSync(fullPath)).toBe(true);
    const content = fs.readFileSync(fullPath, 'utf8');
    expect(content).toContain('# KSTAR Experience');
    expect(content).toContain(`Experience ID: ${approved.id}`);
    expect(content).toContain('已有研究报告');
    expect(content).toContain('写论文初稿');
    expect(content).toContain('实际交付结果：论文初稿完成');
    expect(content).toContain('Engine status: completed');
    expect(upsertContextMock).toHaveBeenCalledWith(uid, promoted.path);
    expect(enqueueMock).toHaveBeenCalledWith(uid, promoted.path, 'upsert');

    const persisted = await legacy.getExperienceCandidate(uid, approved.id);
    expect(persisted).toMatchObject({
      promotion_status: 'promoted',
      kb_path: promoted.path,
    });
  });
});
