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

// 共享库（space）走 project_library_indexer，同样 mock 掉，便于验证 doc+spaceId 作用域
vi.mock('../../../src/main/features/project_library_indexer', () => ({
  listFiles: vi.fn(() => []),
  readFileChunks: vi.fn(() => []),
}));

import { kbSummarize, parseSummaryJson, sampleDocLines, collectReadyDocLines, collectReadyDocs, _internals } from '../../../src/main/features/kb_summary';
import * as kbVector from '../../../src/main/features/kb_vector';
import * as spaceLibrary from '../../../src/main/features/project_library_indexer';

const listFilesMock = vi.mocked(kbVector.listFiles);
const readChunksMock = vi.mocked(kbVector.readFileChunks);
const spaceListMock = vi.mocked(spaceLibrary.listFiles);
const spaceChunksMock = vi.mocked(spaceLibrary.readFileChunks);

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

  it('dedups concurrent in-flight summary calls for the same lib (single LLM call)', async () => {
    listFilesMock.mockReturnValue([readyFile('lib/a.md'), readyFile('lib/b.md')]);
    readChunksMock.mockReturnValue([{ chunk_idx: 0, title: null, content: '要点内容' }]);
    let resolveModel: ((v: { ok: boolean; text: string; error: string }) => void) | null = null;
    const complete = vi.fn(() => new Promise((res) => { resolveModel = res; }));
    const deps = { complete: complete as never };
    // 同 key 并发两次调用
    const p1 = kbSummarize('u1', { dir: 'lib', spaceId: null }, deps as never);
    const p2 = kbSummarize('u1', { dir: 'lib', spaceId: null }, deps as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(complete).toHaveBeenCalledTimes(1); // 只触发一次 LLM
    resolveModel!({ ok: true, text: SAMPLE_JSON, error: '' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.oneLiner).toBe('这个库围绕主题 X。');
    expect(r2.oneLiner).toBe('这个库围绕主题 X。');
  });
});

/**
 * 采样（`sampleDocLines`）—— 2026-09-16 修复的回归面。
 *
 * 旧实现"取前 2 个 chunk / 每块截 300 字 / 每文件截 900 字"对长文档等于只喂封面：
 * 真机案例《软件行业的三块地基，正在被AI改写.docx》正文 5,531 字 / 24 个正文 chunk，
 * 却被 6 张内联 base64 图片切成 2871 个 chunk，正文块散落在 1,2,3,541,542,543,…；
 * 结果送进模型的只有 427 字（封面 + 开头两句），生成的脑图只剩标题句。
 */
describe('kb_summary › sampleDocLines 采样', () => {
  /** 造一篇"图片把正文挤开"的文档：正文块之间夹大量 base64 乱码块。 */
  function noisyDoc() {
    const rows: Array<{ chunk_idx: number; title: string | null; content: string }> = [];
    const headings = ['一｜政策方向', '二｜开发和交付', '三｜价值与价格', '四｜服务与竞争', '五｜产业机会', '六｜Software 4.0'];
    let idx = 1;
    rows.push({ chunk_idx: idx++, title: '标题', content: '工信部209号文：软件行业的三块地基，正在被AI改写' });
    for (let g = 0; g < headings.length; g++) {
      for (let k = 0; k < 200; k++) rows.push({ chunk_idx: idx++, title: null, content: `![IMG](data:image/jpeg;base64,${'A'.repeat(300)})` });
      rows.push({ chunk_idx: idx++, title: headings[g], content: `${headings[g]}：正文内容 ${'甲乙丙丁'.repeat(20)}` });
    }
    rows.push({ chunk_idx: idx++, title: null, content: '最后一节：代码越来越便宜，懂行越来越值钱。' });
    return rows;
  }

  it('丢弃 base64 乱码块，不被图片噪声吃光预算', () => {
    const out = sampleDocLines(noisyDoc(), 6000);
    expect(out).not.toContain('base64');
    expect(out).not.toContain('AAAAAAAA');
  });

  it('base64 续块（无 base64, 标记、无空白的乱码）也必须丢——真机老索引的主要噪声', () => {
    const rows = [
      { chunk_idx: 1, title: '标题', content: '正文第一章' },
      // 图片 base64 被切块后的"续块"形态：一整条无空白的长 token，不带任何标记
      { chunk_idx: 2, title: null, content: `LhJjQ2N0NUVWSClKLCJzVERWODo/${'aB3+'.repeat(80)}` },
      { chunk_idx: 3, title: null, content: '正文第二章，结尾。' },
    ];
    const out = sampleDocLines(rows, 6000);
    expect(out).not.toContain('LhJjQ2N0');
    expect(out).toBe('标题：正文第一章\n\n正文第二章，结尾。');
  });

  it('无 CJK 的西文正文（词间有空格/换行）不能误杀（Palantir 译本场景）', () => {
    const rows = [
      { chunk_idx: 1, title: 'p.2', content: 'La empresa secreta que domina el mundo con datos' },
      { chunk_idx: 2, title: 'p.9', content: 'Hello\nWorld' },
    ];
    const out = sampleDocLines(rows, 6000);
    expect(out).toContain('La empresa secreta que domina el mundo con datos');
    expect(out).toContain('Hello');
  });

  it('覆盖全文：六个章节标题与文末结论都在，而不是只有开头', () => {
    const out = sampleDocLines(noisyDoc(), 6000);
    for (const h of ['一｜政策方向', '二｜开发和交付', '三｜价值与价格', '四｜服务与竞争', '五｜产业机会', '六｜Software 4.0']) {
      expect(out).toContain(h);
    }
    // 文末结论也要在（旧实现只看前 2 个 chunk，永远到不了这里）
    expect(out).toContain('懂行越来越值钱');
  });

  it('预算内不超限，且保持文档原序', () => {
    const out = sampleDocLines(noisyDoc(), 6000);
    expect(out.length).toBeLessThanOrEqual(6000);
    expect(out.indexOf('一｜政策方向')).toBeLessThan(out.indexOf('六｜Software 4.0'));
  });

  it('短文档在预算内全额保留（不做无谓的抽样丢内容）', () => {
    const rows = [
      { chunk_idx: 1, title: '小标题', content: '甲内容' },
      { chunk_idx: 2, title: null, content: '乙内容' },
    ];
    expect(sampleDocLines(rows, 6000)).toBe('小标题：甲内容\n\n乙内容');
  });

  it('标题已在正文里时不重复前缀（真机出现过「标题：标题…」）', () => {
    const rows = [{ chunk_idx: 1, title: '软件行业的三块地基', content: '软件行业的三块地基，正在被AI改写' }];
    expect(sampleDocLines(rows, 6000)).toBe('软件行业的三块地基，正在被AI改写');
  });

  it('标题块超预算时也要保住开头与结尾两侧的骨架', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      chunk_idx: i + 1,
      title: `第 ${i + 1} 节`,
      content: `第 ${i + 1} 节：${'内容'.repeat(60)}`,
    }));
    const out = sampleDocLines(rows, 1500);
    expect(out).toContain('第 1 节');
    expect(out).toContain('第 40 节');
    expect(out.length).toBeLessThanOrEqual(1500);
  });

  it('总量略超预算时不从尾部砍掉（本轮实测：文末章节曾这样被静默丢弃）', () => {
    // 复刻老索引形态：每块都带 title、总字数刚过预算一点点
    const rows = Array.from({ length: 24 }, (_, i) => ({
      chunk_idx: i + 1,
      title: `小标题${i + 1}`,
      content: `第 ${i + 1} 段正文${'字'.repeat(240)}`,
    }));
    const budget = 6000;
    const total = rows.reduce((a, r) => a + r.content.length + 8, 0);
    expect(total).toBeGreaterThan(budget); // 前提：确实超预算，会走采样分支
    const out = sampleDocLines(rows, budget);
    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out).toContain('小标题1'); // 开头在
    expect(out).toContain('小标题24'); // 结尾也必须在
  });
});

describe('kb_summary › collectReadyDocLines 作用域', () => {
  beforeEach(() => {
    listFilesMock.mockReset();
    readChunksMock.mockReset();
    _internals.clearCacheForTests();
  });

  it('doc 参数把作用域锁到单个文件（文档级脑图）', () => {
    listFilesMock.mockReturnValue([readyFile('lib/a.docx'), readyFile('lib/b.pdf')]);
    readChunksMock.mockReturnValue([{ chunk_idx: 1, title: null, content: '要点' }]);
    const lines = collectReadyDocLines('u1', { dir: 'lib', doc: 'lib/a.docx' });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('lib/a.docx');
    expect(lines.join()).not.toContain('lib/b.pdf');
  });

  it('缺省仍按目录聚合全部 ready 文档', () => {
    listFilesMock.mockReturnValue([readyFile('lib/a.docx'), readyFile('lib/b.pdf'), readyFile('other/c.pdf')]);
    readChunksMock.mockReturnValue([{ chunk_idx: 1, title: null, content: '要点' }]);
    const lines = collectReadyDocLines('u1', { dir: 'lib' });
    expect(lines.length).toBe(2);
    expect(lines.join()).not.toContain('other/c.pdf');
  });

  it('collectReadyDocs 返回文件路径（作用域回执的依据）', () => {
    listFilesMock.mockReturnValue([readyFile('lib/a.docx'), readyFile('lib/b.pdf')]);
    readChunksMock.mockReturnValue([{ chunk_idx: 1, title: null, content: '要点' }]);
    const docs = collectReadyDocs('u1', { dir: 'lib' });
    expect(docs.map((d) => d.path)).toEqual(['lib/a.docx', 'lib/b.pdf']);
    expect(docs[0].text).toContain('## lib/a.docx');
  });

  it('共享库 + doc：只在共享库索引里找这一份文件（不会误落个人库）', () => {
    // 个人库里同名文件也应被忽略：doc+spaceId 时作用域是共享库
    listFilesMock.mockReturnValue([readyFile('lib/a.docx')]);
    readChunksMock.mockReturnValue([{ chunk_idx: 1, title: null, content: '个人库内容' }]);
    spaceListMock.mockReturnValue([readyFile('lib/a.docx'), readyFile('lib/b.docx')]);
    spaceChunksMock.mockReturnValue([{ chunk_idx: 1, title: null, content: '共享库内容' }]);

    const docs = collectReadyDocs('u1', { spaceId: 'sp1', doc: 'lib/a.docx' });
    expect(docs.map((d) => d.path)).toEqual(['lib/a.docx']);
    expect(docs[0].text).toContain('共享库内容');
    expect(spaceChunksMock).toHaveBeenCalledWith('u1', 'sp1', 'lib/a.docx');
    expect(readChunksMock).not.toHaveBeenCalled();

    // 共享库里找不到 → 空（kb_mindmap 会据此回 not-found，而不是悄悄去查个人库）
    spaceListMock.mockReturnValue([readyFile('lib/b.docx')]);
    expect(collectReadyDocs('u1', { spaceId: 'sp1', doc: 'lib/a.docx' })).toEqual([]);
  });
});
