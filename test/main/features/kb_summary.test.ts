/**
 * kb_summary (知识库模块 S3) — library summary generation + fingerprint cache.
 *
 * mocks kb_vector (listFiles / readFileChunks) so the LLM call / cache /
 * degrade paths are hermetic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/features/kb_vector', () => ({
  listFiles: vi.fn(() => []),
  readFileChunks: vi.fn(() => []),
}));

import { kbSummarize, parseSummaryJson, _internals } from '../../../src/main/features/kb_summary';
import * as kbVector from '../../../src/main/features/kb_vector';

const listFilesMock = vi.mocked(kbVector.listFiles);
const readChunksMock = vi.mocked(kbVector.readFileChunks);

function readyFile(rel: string, mtime = 1, chunks = 2) {
  return { id: 1, rel_path: rel, kind: 'text', bytes: 10, mtime, sha1: rel, status: 'ready', error: null, chunks, created_at: 0, updated_at: 0 };
}

function completeOk(text: string) {
  return vi.fn(async () => ({ ok: true, text, error: '' }));
}

const SAMPLE_JSON = JSON.stringify({
  docs: [
    { name: 'a.md', file: 'lib/a.md', text: 'A 要点' },
    { name: 'b.pdf', file: 'lib/b.pdf', text: 'B 要点' },
  ],
  oneLiner: '这个库围绕主题 X。',
  mindmap: { root: '主题 X', kids: ['A', 'B'] },
});

beforeEach(() => {
  listFilesMock.mockReset();
  readChunksMock.mockReset();
  _internals.clearCacheForTests();
});

describe('kb_summary', () => {
  it('degrades with no ready files', async () => {
    listFilesMock.mockReturnValue([readyFile('lib/a.md', 1, 0) /* status ready */]);
    // 无 ready：listFiles 返回非 ready
    listFilesMock.mockReturnValue([{ ...readyFile('lib/a.md'), status: 'failed' } as any]);
    const res = await kbSummarize('u1', { dir: 'lib' }, { complete: completeOk('{}') });
    expect(res.source).toBe('degraded');
    expect(res.oneLiner).toContain('还没有已索引');
    expect(res.docs).toEqual([]);
  });

  it('generates docs/oneLiner/mindmap from ready chunks', async () => {
    listFilesMock.mockReturnValue([readyFile('lib/a.md', 1, 1), readyFile('lib/b.pdf', 2, 1)]);
    readChunksMock.mockImplementation((_u: string, rel: string) => [
      { chunk_idx: 1, title: rel, content: '内容片段……' },
    ]);
    const complete = completeOk(SAMPLE_JSON);
    const res = await kbSummarize('u1', { dir: 'lib' }, { complete });
    expect(res.source).toBe('generated');
    expect(res.docs).toEqual([
      { name: 'a.md', file: 'lib/a.md', text: 'A 要点' },
      { name: 'b.pdf', file: 'lib/b.pdf', text: 'B 要点' },
    ]);
    expect(res.oneLiner).toContain('主题 X');
    expect(res.mindmap.root).toBe('主题 X');
    expect(res.mindmap.kids).toEqual(['A', 'B']);
    // LLM 收到要点 + JSON 契约
    const msg = complete.mock.calls[0][0];
    expect(msg.message).toContain('lib/a.md');
    expect(msg.message).toContain('内容片段');
    expect(msg.systemPrompt).toContain('mindmap');
  });

  it('serves cached result on the same fingerprint without a second LLM call', async () => {
    listFilesMock.mockReturnValue([readyFile('lib/a.md', 1, 1)]);
    readChunksMock.mockReturnValue([{ chunk_idx: 1, title: null, content: 'x'.repeat(50) }]);
    const complete = completeOk(SAMPLE_JSON);
    const first = await kbSummarize('u1', { dir: 'lib' }, { complete });
    expect(first.source).toBe('generated');
    const second = await kbSummarize('u1', { dir: 'lib' }, { complete });
    expect(second.source).toBe('cached');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('degrades to a file list when the model fails', async () => {
    listFilesMock.mockReturnValue([readyFile('lib/a.md', 1, 1), readyFile('lib/b.pdf', 2, 1)]);
    readChunksMock.mockReturnValue([{ chunk_idx: 1, title: null, content: 'y' }]);
    const complete = vi.fn(async () => ({ ok: false, text: '', error: 'provider down' }));
    const res = await kbSummarize('u1', { dir: 'lib' }, { complete });
    expect(res.source).toBe('degraded');
    expect(res.oneLiner).toContain('降级');
    expect(res.docs.map((d) => d.file)).toEqual(['lib/a.md', 'lib/b.pdf']);
    expect(res.docs.every((d) => d.text === '')).toBe(true);
  });

  it('parses a JSON block out of model text', () => {
    const parsed = parseSummaryJson(`前言\n${SAMPLE_JSON}\n结尾`);
    expect(parsed.docs.length).toBe(2);
    expect(parsed.mindmap.kids).toEqual(['A', 'B']);
  });

  it('fingerprint is stable and order-insensitive', () => {
    const a = _internals.fingerprint([{ path: 'b', mtime: 2, chunks: 1 }, { path: 'a', mtime: 1, chunks: 2 }]);
    const b = _internals.fingerprint([{ path: 'a', mtime: 1, chunks: 2 }, { path: 'b', mtime: 2, chunks: 1 }]);
    expect(a).toBe(b);
    const c = _internals.fingerprint([{ path: 'a', mtime: 1, chunks: 3 }, { path: 'b', mtime: 2, chunks: 1 }]);
    expect(c).not.toBe(a);
  });
});
