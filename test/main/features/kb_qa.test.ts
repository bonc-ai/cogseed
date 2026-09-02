/**
 * kb_qa (知识库模块 S2) — grounded Q&A stream orchestration.
 *
 * mocks `ask-materials` so the evidence/threshold logic stays hermetic; the
 * retrieval internals are covered by ask-materials.test.ts itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/model/core-agent/ask-materials', () => ({
  askMaterials: vi.fn(),
  formatEvidence: (result: any) => `ask_materials (evidence: ${(result.hits || []).length})`,
}));

import { kbAskStream, _internals } from '../../../src/main/features/kb_qa';
import { askMaterials } from '../../../src/main/model/core-agent/ask-materials';

const askMaterialsMock = vi.mocked(askMaterials);

function collect(gen: AsyncGenerator<any>) {
  const events: any[] = [];
  return (async () => {
    for await (const e of gen) events.push(e);
    return events;
  })();
}

function fakeStream(...texts: string[]) {
  return vi.fn(async function* () {
    for (const t of texts) yield { type: 'delta', text: t };
  });
}

const HIT = {
  source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 2,
  snippet: 'alpha protocol handles tokens', score: 0.02,
};

beforeEach(() => {
  askMaterialsMock.mockReset();
});

describe('kb_qa kbAskStream', () => {
  it('rejects an empty question', async () => {
    const events = await collect(kbAskStream('u1', { question: '  ' }, { stream: fakeStream() } as any));
    expect(events).toEqual([{ type: 'error', text: 'empty question' }]);
    expect(askMaterialsMock).not.toHaveBeenCalled();
  });

  it('says plainly there is no material instead of fabricating', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: false, reason: 'no_material', hits: [], query: 'q', summary: [],
    } as any);
    const events = await collect(kbAskStream('u1', { question: 'q' }, { stream: fakeStream() } as any));
    const final = events[events.length - 1];
    expect(final.type).toBe('final');
    expect(final.noMaterial).toBe(true);
    expect(final.reason).toBe('no_material');
    expect(final.text).toContain('资料中未找到');
    expect(events.some((e) => e.type === 'delta')).toBe(false);
  });

  it('answers with a caveat on low-confidence evidence', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: false, reason: 'low_confidence', hits: [HIT], query: 'q', summary: [],
    } as any);
    const events = await collect(kbAskStream('u1', { question: 'q' }, { stream: fakeStream() } as any));
    const final = events[events.length - 1];
    expect(final.noMaterial).toBe(true);
    expect(final.reason).toBe('low_confidence');
    expect(final.text).toContain('很弱');
  });

  it('streams deltas grounded in evidence and returns final with citation refs', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: 'q', summary: ['evidence ready'],
    } as any);
    const stream = fakeStream('基于 ', 'notes/a.md#chunk 2，', '回答。');
    const events = await collect(kbAskStream('u1', { question: 'q' }, { stream } as any));
    // system prompt carries the evidence package; message is the question
    const streamOpts = stream.mock.calls[0][0];
    expect(streamOpts.message).toBe('q');
    expect(streamOpts.systemPrompt).toContain('ask_materials (evidence: 1)');
    expect(streamOpts.systemPrompt).toContain('path#chunk N');
    // deltas forwarded verbatim
    expect(events.filter((e) => e.type === 'delta').map((e) => e.text)).toEqual(['基于 ', 'notes/a.md#chunk 2，', '回答。']);
    const final = events[events.length - 1];
    expect(final.type).toBe('final');
    expect(final.noMaterial).toBeUndefined();
    expect(final.evidence).toEqual([
      { source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 2, snippet: HIT.snippet, score: HIT.score },
    ]);
  });

  it('forwards model errors', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: 'q', summary: [],
    } as any);
    const stream = vi.fn(async function* () {
      yield { type: 'error', text: 'provider down' };
    });
    const events = await collect(kbAskStream('u1', { question: 'q' }, { stream } as any));
    expect(events).toEqual([{ type: 'error', text: 'provider down' }]);
  });

  it('maps hits to compact evidence refs', () => {
    const refs = _internals.toEvidenceRefs([HIT as any]);
    expect(refs[0]).toEqual({
      source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 2, snippet: HIT.snippet, score: HIT.score,
    });
  });

  it('appends text attachments into the system prompt as supplementary context', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: 'q', summary: ['evidence ready'],
    } as any);
    const fsMod = await import('node:fs');
    const osMod = await import('node:os');
    const pathMod = await import('node:path');
    const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'kbqa-att-'));
    const attPath = pathMod.join(tmp, '说明.md');
    fsMod.writeFileSync(attPath, '# 附件要点\n\n本附件描述私有化部署的步骤。');
    try {
      const stream = fakeStream('基于附件回答。');
      const events = await collect(kbAskStream('u1', { question: '如何部署', attachPaths: [attPath] }, { stream } as any));
      const streamOpts = stream.mock.calls[0][0];
      expect(streamOpts.systemPrompt).toContain('附件：说明.md');
      expect(streamOpts.systemPrompt).toContain('私有化部署的步骤');
      expect(events.some((e) => e.type === 'final')).toBe(true);
    } finally {
      fsMod.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('kb_qa multi-turn history', () => {
  it('appends history into system prompt for context', async () => {
    const { askMaterials } = await import('../../../src/main/model/core-agent/ask-materials');
    vi.mocked(askMaterials).mockResolvedValue({
      hasEvidence: true, hits: [{ source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 2, snippet: 's', score: 0.02 }], query: 'q', summary: [],
    } as any);
    const { kbAskStream } = await import('../../../src/main/features/kb_qa');
    const stream = vi.fn(async function* () { yield { type: 'delta', text: 'ok' }; });
    const events: any[] = [];
    for await (const e of kbAskStream('u1', {
      question: '第二问',
      history: [{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' }],
    }, { stream } as any)) events.push(e);
    const opts = stream.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('用户：第一问');
    expect(opts.systemPrompt).toContain('助手：第一答');
  });
});
