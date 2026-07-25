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
    const runtime = await import('../../../../src/main/features/p3394/kstar-runtime');
    const kb = await import('../../../../src/main/features/p3394/kstar-kb');
    const run = await runtime.finalizeAgentTurn(uid, {
      conversationId: 'gconv-notion', agentId: 'writer-agent', turnId: 'turn-notion',
      messageId: 'msg-notion', actualResult: '交付结果',
      kstarDecision: {
        required: true,
        reason: 'durable deliverable',
        expectation: {
          situation: '已有研究报告',
          task: '写论文初稿',
          action_hat: '写初稿',
          result_hat: '初稿',
        },
      },
      actualAction: 'writer-agent wrote a draft',
    });
    const reviewed = await runtime.reviewKStarRun(uid, run.id, { decision: 'pass' });
    const approved = await runtime.decideExperienceCandidate(uid, reviewed.experience_candidate!.id, 'approve');
    const promoted = await kb.promoteExperienceCandidateToKnowledgeBase(uid, approved.id);
    if (!promoted.ok) throw new Error(promoted.error);
    return approved.id;
  }

  it('records a failed sync when Notion target is not configured', async () => {
    const candidateId = await createPromotedCandidate();
    const notion = await import('../../../../src/main/features/p3394/kstar-notion');
    const result = await notion.syncExperienceCandidateToNotion(uid, candidateId);

    expect(result.ok).toBe(false);
    expect(callToolMock).not.toHaveBeenCalled();
    const runtime = await import('../../../../src/main/features/p3394/kstar-runtime');
    const candidate = await runtime.getExperienceCandidate(uid, candidateId);
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
    expect(JSON.stringify(callToolMock.mock.calls[0][3])).toContain('写论文初稿');

    const runtime = await import('../../../../src/main/features/p3394/kstar-runtime');
    const candidate = await runtime.getExperienceCandidate(uid, candidateId);
    expect(candidate?.notion_sync).toMatchObject({
      status: 'synced',
      page_id: 'notion-page-1',
      url: 'https://notion.test/page',
    });
  });
});
