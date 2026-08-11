import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const callToolMock = vi.hoisted(() => vi.fn(async () => ({
  content: [{ type: 'text', text: JSON.stringify({ id: 'notion-page-1', url: 'https://notion.test/page' }) }],
})));

vi.mock('../../../../src/main/features/connectors/manager', () => ({
  callTool: callToolMock,
}));

vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: vi.fn(),
  dropContext: vi.fn(),
}));

vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(),
}));

vi.mock('../../../../src/main/features/kb_vector', () => ({
  findBySha1: vi.fn(() => null),
}));

let root: string;
const uid = 'kstar-notion-user';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-p3394-notion-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  delete process.env.ORKAS_KSTAR_NOTION_PARENT_ID;
  delete process.env.ORKAS_KSTAR_NOTION_PARENT_TYPE;
  delete process.env.ORKAS_KSTAR_NOTION_CONNECTOR_ID;
  delete process.env.ORKAS_KSTAR_NOTION_CREATE_PAGE_TOOL;
  callToolMock.mockClear();
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.ORKAS_WORKSPACE_ROOT;
  delete process.env.ORKAS_KSTAR_NOTION_PARENT_ID;
  delete process.env.ORKAS_KSTAR_NOTION_PARENT_TYPE;
  delete process.env.ORKAS_KSTAR_NOTION_CONNECTOR_ID;
  delete process.env.ORKAS_KSTAR_NOTION_CREATE_PAGE_TOOL;
  vi.resetModules();
});

describe('P3394 KSTAR Notion sync', () => {
  async function createPromotedCandidate(): Promise<string> {
    const kb = await import('../../../../src/main/features/p3394/kstar-kb');
    const run = {
      id: 'run-notion',
      conversation_id: 'gconv-notion',
      agent_id: 'writer-agent',
      turn_id: 'turn-notion',
      status: 'completed',
      actual_result: '交付结果',
      evidence_items: [],
      verification: { status: 'passed', notes: '', reviewed_at: '2026-07-24T00:00:00.000Z' },
      kstar_decision: {
        required: true,
        reason: 'durable deliverable',
        expectation: {
          situation: '已有研究报告',
          task: '写论文初稿',
          action_hat: '写初稿',
          result_hat: '初稿',
        },
      },
      kstar_episode: {
        episode_id: 'ep-notion',
        bundle_id: 'bundle-notion',
        k_snapshot_ref: 'conversation:gconv-notion',
        situation: '已有研究报告',
        task: '写论文初稿',
        action_hat: '写初稿',
        result_hat: '初稿',
        actual_action: 'writer-agent wrote a draft',
        actual_result: '交付结果',
        delta_r: 0,
        delta_a: 0,
        delta_a_confidence_gate: 'pass',
        timestamp: '2026-07-24T00:00:00.000Z',
        session_id: 'gconv-notion',
      },
      kstar_engine: { status: 'completed', tool_calls: [], updated_at: '2026-07-24T00:00:00.000Z' },
      experience_candidate_id: 'exp-notion',
      created_at: '2026-07-24T00:00:00.000Z',
      updated_at: '2026-07-24T00:00:00.000Z',
    };
    const candidate = {
      id: 'exp-notion',
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
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, runs: [run], experience_candidates: [candidate], updated_at: '2026-07-24T00:00:00.000Z' }, null, 2));
    const promoted = await kb.promoteExperienceCandidateToKnowledgeBase(uid, candidate.id);
    if (!promoted.ok) throw new Error(promoted.error);
    return candidate.id;
  }

  it('records a failed sync when Notion target is not configured', async () => {
    const candidateId = await createPromotedCandidate();
    const notion = await import('../../../../src/main/features/p3394/kstar-notion');
    const result = await notion.syncExperienceCandidateToNotion(uid, candidateId);

    expect(result.ok).toBe(false);
    expect(callToolMock).not.toHaveBeenCalled();
    const legacy = await import('../../../../src/main/features/p3394/kstar-legacy-data');
    const candidate = await legacy.getExperienceCandidate(uid, candidateId);
    expect(candidate?.notion_sync).toMatchObject({ status: 'failed' });
  });

  it('creates a Notion page through the existing Notion connector and persists page metadata', async () => {
    process.env.ORKAS_KSTAR_NOTION_PARENT_ID = 'parent-page-1';
    process.env.ORKAS_KSTAR_NOTION_PARENT_TYPE = 'page';
    const candidateId = await createPromotedCandidate();
    const notion = await import('../../../../src/main/features/p3394/kstar-notion');
    const result = await notion.syncExperienceCandidateToNotion(uid, candidateId);

    expect(result.ok).toBe(true);
    expect(callToolMock).toHaveBeenCalledOnce();
    expect(callToolMock.mock.calls[0][0]).toBe(uid);
    expect(callToolMock.mock.calls[0][1]).toBe('notion');
    expect(callToolMock.mock.calls[0][2]).toBe('API-post-page');
    expect(callToolMock.mock.calls[0][3]).toMatchObject({
      parent: { page_id: 'parent-page-1' },
    });
    const callArgs = callToolMock.mock.calls[0][3];
    expect(JSON.stringify(callArgs)).toContain('写论文初稿');
    expect(JSON.stringify(callArgs)).toContain(candidateId); // Experience ID in properties

    const legacy = await import('../../../../src/main/features/p3394/kstar-legacy-data');
    const candidate = await legacy.getExperienceCandidate(uid, candidateId);
    expect(candidate?.notion_sync).toMatchObject({
      status: 'synced',
      page_id: 'notion-page-1',
      url: 'https://notion.test/page',
    });
  });

  it('returns existing page without re-creating when already synced (idempotent by experience_id)', async () => {
    process.env.ORKAS_KSTAR_NOTION_PARENT_ID = 'parent-page-1';
    const candidateId = await createPromotedCandidate();
    const notion = await import('../../../../src/main/features/p3394/kstar-notion');

    // First sync
    const first = await notion.syncExperienceCandidateToNotion(uid, candidateId);
    expect(first.ok).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);

    // Second sync should skip without calling API
    callToolMock.mockClear();
    const second = await notion.syncExperienceCandidateToNotion(uid, candidateId);
    expect(second.ok).toBe(true);
    expect(second.page_id).toBe(first.page_id);
    expect(callToolMock).not.toHaveBeenCalled();
  });
});
