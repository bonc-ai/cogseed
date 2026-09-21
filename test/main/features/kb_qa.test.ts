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

vi.mock('../../../src/main/features/kb_vector', () => ({
  listFiles: vi.fn(() => []),
  readFileChunks: vi.fn(() => []),
}));

vi.mock('../../../src/main/features/kb_summary', () => ({
  kbSummarize: vi.fn(),
}));

import { kbAskStream, _internals } from '../../../src/main/features/kb_qa';
import { askMaterials } from '../../../src/main/model/core-agent/ask-materials';
import * as kbVector from '../../../src/main/features/kb_vector';
import { kbSummarize } from '../../../src/main/features/kb_summary';

const askMaterialsMock = vi.mocked(askMaterials);
const kbSummarizeMock = vi.mocked(kbSummarize);
const listFilesMock = vi.mocked(kbVector.listFiles);
const readChunksMock = vi.mocked(kbVector.readFileChunks);

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
  listFilesMock.mockReset();
  readChunksMock.mockReset();
  kbSummarizeMock.mockReset();
  kbSummarizeMock.mockResolvedValue({ docs: [], oneLiner: '', source: 'degraded', fingerprint: 'fp' });
});

describe('kb_qa kbAskStream', () => {
  it('rejects an empty question', async () => {
    const events = await collect(kbAskStream('u1', { question: '  ' }, { stream: fakeStream() } as any));
    expect(events).toEqual([{ type: 'error', text: 'empty question' }]);
    expect(askMaterialsMock).not.toHaveBeenCalled();
  });

  it('answers meta questions about the assistant itself without retrieval', async () => {
    const events = await collect(kbAskStream('u1', { question: '你会干什么？' }, { stream: fakeStream() } as any));
    const final = events[events.length - 1];
    expect(final.type).toBe('final');
    expect(final.text).toContain('知识库问答助手');
    expect(final.notFound).toBeFalsy();
    expect(askMaterialsMock).not.toHaveBeenCalled();
    const events2 = await collect(kbAskStream('u1', { question: '你能做什么' }, { stream: fakeStream() } as any));
    expect(events2[events2.length - 1].text).toContain('知识库问答助手');
  });

  it('answers library-overview questions via kb.summary instead of retrieval', async () => {
    kbSummarizeMock.mockResolvedValue({
      docs: [
        { name: 'a.pdf', file: 'a.pdf', text: '班级建设要点' },
        { name: 'b.md', file: 'b.md', text: '复盘记录' },
      ],
      oneLiner: '这个库主要沉淀班级建设与复盘资料。',
      source: 'generated',
      fingerprint: 'fp',
    } as any);
    const stream = fakeStream('x');
    const events = await collect(kbAskStream('u1', { question: '这个知识库讲的什么', dir: '班级建设资料' }, { stream } as any));
    const final = events[events.length - 1];
    expect(final.type).toBe('final');
    expect(final.sysNote).toBe('已读取知识库信息');
    // 知识库助手式模板：总览 → 📚 文档内容（编号+加粗文件名+——）→ 💡 一句话总结
    expect(final.text).toContain('「班级建设资料」共收录 2 份已解析文档');
    expect(final.text).toContain('📚 文档内容');
    expect(final.text).toContain('1. **a.pdf** —— 班级建设要点');
    expect(final.text).toContain('2. **b.md** —— 复盘记录');
    expect(final.text).toContain('💡 一句话总结');
    expect(final.text).toContain('这个库主要沉淀班级建设与复盘资料。');
    expect(askMaterialsMock).not.toHaveBeenCalled();
    expect(kbSummarizeMock).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ dir: '班级建设资料' }),
      expect.any(Object),
    );
    // 概览回答也要可溯源：此前恒返回 evidence: []，渲染层因此不挂底部「资料来源」，
    // 用户看到"a.pdf：班级建设要点"却无从点开原文。
    expect(final.evidence).toEqual([
      {
        source: 'library',
        scope: 'global',
        path: 'a.pdf',
        chunkIdx: 1,
        snippet: '班级建设要点',
        score: 1,
      },
      {
        source: 'library',
        scope: 'global',
        path: 'b.md',
        chunkIdx: 1,
        snippet: '复盘记录',
        score: 1,
      },
    ]);
  });

  it('carries spaceId on overview evidence so shared-library citations can open', async () => {
    kbSummarizeMock.mockResolvedValue({
      docs: [{ name: 'a.pdf', file: 'a.pdf', text: '要点' }],
      oneLiner: '共享库概览。',
      source: 'generated',
      fingerprint: 'fp',
    } as any);
    const events = await collect(
      kbAskStream('u1', { question: '这个知识库讲的什么', spaceId: 'sp1' }, { stream: fakeStream('x') } as any),
    );
    const final = events[events.length - 1];
    expect(final.evidence).toEqual([
      expect.objectContaining({ scope: 'space', path: 'a.pdf', chunkIdx: 1, spaceId: 'sp1' }),
    ]);
  });

  it('says plainly there is no material instead of fabricating', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: false, reason: 'no_material', hits: [], query: 'q', summary: [],
    } as any);
    const events = await collect(kbAskStream('u1', { question: 'q' }, { stream: fakeStream() } as any));
    const final = events[events.length - 1];
    expect(final.type).toBe('final');
    expect(final.noMaterial).toBe(true);    expect(final.reason).toBe('no_material');
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

  it('scopes retrieval to the current personal-library dir', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: 'q', summary: ['evidence ready'],
    } as any);
    const stream = fakeStream('ok');
    await collect(kbAskStream('u1', { question: 'q', dir: '归档测试/子目录' }, { stream } as any));
    expect(askMaterialsMock).toHaveBeenCalledWith(expect.objectContaining({
      dir: '归档测试/子目录',
      scope: 'global',
    }));
    // 候选集放宽：至少 finalK*3，供每文件封顶后裁回 k 条
    expect(askMaterialsMock).toHaveBeenCalledWith(expect.objectContaining({ k: 24 }));
  });

  it('caps evidence at two chunks per file and spans sources', async () => {
    const mk = (file: string, chunkIdx: number, score: number) => ({
      source: 'library', scope: 'global', path: file, chunkIdx, snippet: 's', score,
    });
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true,
      hits: [
        mk('a.md', 1, 0.05), mk('a.md', 2, 0.04), mk('a.md', 3, 0.03),
        mk('b.md', 1, 0.02), mk('c.md', 1, 0.01),
      ],
      query: 'q', summary: ['evidence ready'],
    } as any);
    const stream = fakeStream('ok');
    const events = await collect(kbAskStream('u1', { question: 'q' }, { stream } as any));
    const final = events[events.length - 1];
    const files = final.evidence.map((e: { path: string }) => e.path);
    expect(files.filter((f: string) => f === 'a.md')).toHaveLength(2); // 每文件 ≤2
    expect(files).toContain('b.md');
    expect(files).toContain('c.md');
  });

  it('keeps only anchors that actually appear in the answer text', async () => {
    const bHit = { ...HIT, path: 'notes/b.md', chunkIdx: 1, score: 0.03 };
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT, bHit], query: 'q', summary: ['evidence ready'],
    } as any);
    // 回答只引用 b.md 的锚点 → 引用只显示 b，a 被剔除
    const stream = fakeStream('根据 ', 'notes/b.md#chunk 1', ' 的回答。');
    const events = await collect(kbAskStream('u1', { question: 'q' }, { stream } as any));
    const final = events[events.length - 1];
    expect(final.evidence.map((e: { path: string }) => e.path)).toEqual(['notes/b.md']);
  });

  it('falls back to full retrieval evidence when the answer cites nothing', async () => {
    const bHit = { ...HIT, path: 'notes/b.md', chunkIdx: 1, score: 0.03 };
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT, bHit], query: 'q', summary: ['evidence ready'],
    } as any);
    const stream = fakeStream('回答里一个锚点都没标。');
    const events = await collect(kbAskStream('u1', { question: 'q' }, { stream } as any));
    const final = events[events.length - 1];
    expect(final.evidence.map((e: { path: string }) => e.path)).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('suppresses citation chips when the answer says nothing was found', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: 'q', summary: ['evidence ready'],
    } as any);
    // 目录内只检索到无关弱命中：模型如实说“未找到”，不应把该命中当“引用”展示
    const stream = fakeStream('资料中未找到任何与 AST.pdf 相关的内容，仅检索到 notes/a.md，但无关。');
    const events = await collect(kbAskStream('u1', { question: 'AST.pdf 讲了什么' }, { stream } as any));
    const final = events[events.length - 1];
    expect(final.evidence).toEqual([]);
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

describe('kb_qa filename-target & cross-lib suggestion', () => {
  const ready = (rel: string) => ({
    id: 1, rel_path: rel, kind: 'text', bytes: 10, mtime: 1, sha1: rel,
    status: 'ready', error: null, chunks: 2, created_at: 0, updated_at: 0,
  });

  it('detects a target filename in the question', () => {
    expect(_internals.detectTargetFilename('AST.pdf 讲了什么？')).toBe('AST.pdf');
    expect(_internals.detectTargetFilename('《初中词汇-8词-真实试跑.md》内容')).toBe('初中词汇-8词-真实试跑.md');
    expect(_internals.detectTargetFilename('什么是向量检索')).toBeNull();
  });

  it('pins an in-scope file when vector search misses the filename', async () => {
    listFilesMock.mockReturnValue([ready('from-tasks/sub/AST.pdf')] as any);
    readChunksMock.mockImplementation((_u: string, rel: string) =>
      (rel.endsWith('AST.pdf') ? [{ chunk_idx: 3, title: null, content: 'AST 解析器相关内容……' }] : []) as any);
    askMaterialsMock.mockResolvedValue({
      hasEvidence: false, reason: 'no_material', hits: [], query: 'q', summary: [],
    } as any);
    const stream = fakeStream('根据 from-tasks/sub/AST.pdf#chunk 3，这是 AST 解析器的说明。');
    const events = await collect(kbAskStream('u1', { question: 'AST.pdf 讲了什么', dir: 'from-tasks' }, { stream } as any));
    const final = events[events.length - 1];
    expect(final.noMaterial).toBeUndefined();
    expect(final.evidence).toEqual([expect.objectContaining({ path: 'from-tasks/sub/AST.pdf', chunkIdx: 3 })]);
    expect(final.suggestion).toBeFalsy();
  });

  it('suggests another personal dir when the file lives there', async () => {
    listFilesMock.mockReturnValue([ready('归档测试/AST.pdf')] as any);
    readChunksMock.mockImplementation((_u: string, rel: string) =>
      (rel.endsWith('AST.pdf') ? [{ chunk_idx: 0, title: null, content: 'AST 解析器' }] : []) as any);
    askMaterialsMock.mockResolvedValue({
      hasEvidence: false, reason: 'no_material', hits: [], query: 'q', summary: [],
    } as any);
    const stream = fakeStream('ok');
    const events = await collect(kbAskStream('u1', { question: 'AST.pdf 讲了什么', dir: 'from-tasks' }, { stream } as any));
    const final = events[events.length - 1];
    expect(final.evidence).toEqual([]);
    expect(final.noMaterial).toBe(true);
    expect(final.suggestion).toMatchObject({ dir: '归档测试', path: '归档测试/AST.pdf' });
  });

  it('falls back to whole-library topic search for a non-filename question', async () => {
    listFilesMock.mockReturnValue([] as any);
    readChunksMock.mockReturnValue([] as any);
    askMaterialsMock
      .mockResolvedValueOnce({ hasEvidence: false, reason: 'no_material', hits: [], query: 'q', summary: [] } as any)
      .mockResolvedValueOnce({
        hasEvidence: true,
        hits: [{ source: 'library', scope: 'global', path: '归档测试/AST.pdf', chunkIdx: 5, snippet: 'AST 解析', title: null, score: 0.02 }],
        query: 'q', summary: ['evidence ready'],
      } as any);
    const stream = fakeStream('ok');
    const events = await collect(kbAskStream('u1', { question: '讲讲括号平衡的语义不变量', dir: 'from-tasks' }, { stream } as any));
    const final = events[events.length - 1];
    expect(final.suggestion).toMatchObject({ dir: '归档测试', path: '归档测试/AST.pdf', chunkIdx: 5 });
    expect(askMaterialsMock).toHaveBeenCalledTimes(2);
  });

  it('returns no suggestion when nothing exists anywhere', async () => {
    listFilesMock.mockReturnValue([] as any);
    readChunksMock.mockReturnValue([] as any);
    askMaterialsMock
      .mockResolvedValueOnce({ hasEvidence: false, reason: 'no_material', hits: [], query: 'q', summary: [] } as any)
      .mockResolvedValueOnce({ hasEvidence: false, reason: 'no_material', hits: [], query: 'q', summary: [] } as any);
    const stream = fakeStream('ok');
    const events = await collect(kbAskStream('u1', { question: '完全不存在的东西', dir: 'from-tasks' }, { stream } as any));
    const final = events[events.length - 1];
    expect(final.noMaterial).toBe(true);
    expect(final.suggestion).toBeNull();
  });
});

// ── 库级问题路由（"为什么答不了：资料未说明"）──────────────────────────────
//
// 库级元问题（整体定位 / 覆盖范围 / 建设目的 / 主题分布）的答案不由任何单个
// chunk 承载。落到单点检索路由后，模型受证据作答契约约束（只依据证据、不编造），
// 只能逐条回「资料未说明」——用户看到的是"答非所问"。
// 修复：硬线索直接走全库概览；软线索在"检索空手"与"证据答不出"两条失败路径上兜底。
describe('kb_qa library-scope routing', () => {
  const OVERVIEW = {
    docs: [
      { name: '鲸影智流.md', file: '鲸影智流.md', text: '迭代记录' },
      { name: '发版扫描.md', file: '发版扫描.md', text: '清理任务' },
    ],
    oneLiner: '这个库沉淀海报迭代记录与发版前清理任务提示。',
    source: 'generated',
    fingerprint: 'fp',
  };

  it('routes library-composition questions to the overview without retrieval', async () => {
    kbSummarizeMock.mockResolvedValue(OVERVIEW as any);
    const events = await collect(kbAskStream(
      'u1',
      { question: '这个知识库的整体定位、覆盖范围、建设目的是什么' },
      { stream: fakeStream('x') } as any,
    ));
    const final = events[events.length - 1];
    // 新模板：正文分「📚 文档内容」与「💡 一句话总结」两段（此前是一句话概括平铺）
    expect(final.text).toContain('💡 一句话总结');
    expect(final.text).toContain('这个库沉淀海报迭代记录与发版前清理任务提示。');
    expect(final.text).toContain('共收录 2 份已解析文档');
    // 库里 2 份文档都作为可溯源证据返回
    expect(final.evidence).toHaveLength(2);
    // 关键：不再走单点检索（否则必然"资料未说明"）
    expect(askMaterialsMock).not.toHaveBeenCalled();
  });

  it('document-level questions still go to retrieval (no overview hijack)', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: 'q', summary: ['evidence ready'],
    } as any);
    const events = await collect(kbAskStream(
      'u1',
      { question: '这个知识库里的《挽救计划》讲了什么' },
      { stream: fakeStream('notes/a.md#chunk 2 说明一切') } as any,
    ));
    expect(kbSummarizeMock).not.toHaveBeenCalled();
    expect(askMaterialsMock).toHaveBeenCalled();
    expect(events[events.length - 1].evidence).toHaveLength(1);
  });

  it('falls back to the overview when retrieval finds nothing for a library question', async () => {
    kbSummarizeMock.mockResolvedValue(OVERVIEW as any);
    askMaterialsMock
      .mockResolvedValueOnce({ hasEvidence: false, reason: 'no_material', hits: [], query: 'q', summary: [] } as any)
      .mockResolvedValueOnce({ hasEvidence: false, reason: 'no_material', hits: [], query: 'q', summary: [] } as any);
    listFilesMock.mockReturnValue([] as any);
    readChunksMock.mockReturnValue([] as any);
    const events = await collect(kbAskStream(
      'u1',
      { question: '这个知识库是干什么用的' },
      { stream: fakeStream('x') } as any,
    ));
    const final = events[events.length - 1];
    expect(final.text).toContain('💡 一句话总结');
    expect(final.text).toContain('共收录 2 份已解析文档');
    expect(final.noMaterial).toBeFalsy();
  });

  it('falls back to the overview when the evidence answers nothing (资料未说明)', async () => {
    kbSummarizeMock.mockResolvedValue(OVERVIEW as any);
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: 'q', summary: ['evidence ready'],
    } as any);
    // 模型逐条回「资料未说明」——库级元问题的典型结局
    const notFoundAnswer = '「资料未说明」\n资料未说明：这个知识库的整体定位、覆盖范围、建设目的。\n知识库中没有相关文件说明。';
    const events = await collect(kbAskStream(
      'u1',
      { question: '这个知识库是否包含视频迭代、PR 清理、任务提示词' },
      { stream: fakeStream(notFoundAnswer) } as any,
    ));
    const final = events[events.length - 1];
    expect(final.text).toContain('💡 一句话总结');
    expect(final.text).toContain('共收录 2 份已解析文档');
    expect(final.notFound).toBeFalsy();
    expect(final.evidence).toHaveLength(2);
  });

  it('keeps the honest 未找到 answer for document-level questions answered as 资料未说明', async () => {
    askMaterialsMock.mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: 'q', summary: ['evidence ready'],
    } as any);
    const notFoundAnswer = '资料未说明：该文档没有提到这一点。';
    const events = await collect(kbAskStream(
      'u1',
      { question: 'notes/a.md 里有没有写部署步骤' },
      { stream: fakeStream(notFoundAnswer) } as any,
    ));
    const final = events[events.length - 1];
    expect(kbSummarizeMock).not.toHaveBeenCalled();
    expect(final.notFound).toBe(true);
    expect(final.text).toContain('资料未说明');
  });

  it('routing predicate separates library-level from document-level questions', () => {
    const { isLibraryOverviewQuestion, isLibraryScopeQuestion } = _internals;
    for (const q of [
      '这个知识库的整体定位、覆盖范围、建设目的是什么',
      '这个知识库的定位是什么',
      '这个知识库的文档主题分布',
      '这个知识库涵盖了哪些类型的文档',
      '这个知识库包含什么',
      '总结一下这个知识库',
    ]) {
      expect(isLibraryOverviewQuestion(q), `应走概览: ${q}`).toBe(true);
    }
    for (const q of [
      '这个知识库里的《挽救计划》讲了什么',
      '发版扫描清理任务提示词这份文档的定位是什么',
      'AST.pdf 讲了什么',
      '鲸影智流过程证据材料记录了哪些版本',
      '这个知识库怎么配置模型通道',
    ]) {
      expect(isLibraryOverviewQuestion(q), `不应走概览: ${q}`).toBe(false);
    }
    // 软判据更宽（覆盖自然问法），但硬判据仍不放过文档级问题
    for (const q of ['这个知识库是干什么用的', '这个知识库主要涉及什么内容']) {
      expect(isLibraryOverviewQuestion(q)).toBe(false);
      expect(isLibraryScopeQuestion(q)).toBe(true);
    }
    expect(isLibraryScopeQuestion('notes/a.md 里有没有写部署步骤')).toBe(false);
  });
});
