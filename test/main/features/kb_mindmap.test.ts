/**
 * kb_mindmap (知识库多级脑图，本地化 notebooklm mind-map 协议) — 层级树生成。
 *
 * mocks kb_summary.collectReadyDocLines + deps.complete，验证多级 JSON 解析 /
 * 缓存 / 降级路径。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// kb_mindmap 现在读 collectReadyDocs（返回 {path,text}[]，供作用域回执用）。
// 测试仍按"要点行字符串"写，由 here 的适配层从 `## <path>` 头里推出 path。
const { rawCollectMock } = vi.hoisted(() => ({ rawCollectMock: vi.fn(() => [] as string[]) }));
vi.mock('../../../src/main/features/kb_summary', () => ({
  collectReadyDocs: (uid: string, opts: unknown) =>
    rawCollectMock(uid as never, opts as never).map((text: string) => {
      const m = /^##\s+(\S+)/.exec(String(text || ''));
      return { path: m ? m[1] : '', text: String(text || '') };
    }),
}));

const { TMP_ROOT } = vi.hoisted(() => {
  const fsMod = { mkdtempSync: (p: string) => `${p}kb-mind-test-${Date.now()}` };
  const dir = fsMod.mkdtempSync(require('node:os').tmpdir() + '/');
  return { TMP_ROOT: dir };
});

vi.mock('../../../src/main/paths', () => ({ WS_ROOT: TMP_ROOT }));

import {
  kbMindmap,
  parseMindJson,
  _internals,
  saveMindmap,
  listMindmaps,
  loadMindmap,
  deleteMindmap,
  mindKey,
} from '../../../src/main/features/kb_mindmap';

const SAMPLE = JSON.stringify({
  root: {
    label: '软件工程与AI',
    children: [
      { label: 'AI数学推理与修复', children: [{ label: 'AST-Surgery', children: [] }] },
      { label: 'AI编程工具', children: [{ label: 'Claude Code', children: [] }, { label: 'Copilot', children: [] }] },
    ],
  },
});

function completeOk(text: string) {
  return vi.fn(async () => ({ ok: true, text, error: '' }));
}

beforeEach(() => {
  rawCollectMock.mockReset();
  _internals.clearCacheForTests();
});

describe('kb_mindmap', () => {
  it('generates a multi-level tree from library doc lines', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.pdf\n要点……', '## lib/b.docx\n要点……']);
    const complete = completeOk(SAMPLE);
    const res = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(res.source).toBe('generated');
    expect(res.root.label).toBe('软件工程与AI');
    expect(res.root.children.length).toBe(2);
    expect(res.root.children[0].children[0].label).toBe('AST-Surgery');
    expect(res.root.children[1].children.length).toBe(2);
    // LLM 收到要点 + 层级协议
    const msg = complete.mock.calls[0][0];
    expect(msg.message).toContain('lib/a.pdf');
    expect(msg.systemPrompt).toContain('children');
  });

  /**
   * 作用域回执（2026-09-16 真机事故回归面）。
   *
   * 渲染层已更新为传 `doc`、主进程还是旧代码（不认识 doc，静默退回"整库前 10 个
   * 文件"）时，界面会拿整库脑图冒充"本文档脑图"（事故里那份 ECS 早会转写的脑图
   * 全是 1/、11/16/、from-tasks/ 里别的文件的内容）。回执就是为了让渲染层能识别
   * 这种错配并丢弃结果。
   */
  it('回执 scope=doc 且 files 恰好是请求的那一份', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.docx\n正文要点']);
    const res = await kbMindmap('u1', { doc: 'lib/a.docx' }, { complete: completeOk(SAMPLE) });
    expect(res.source).toBe('generated');
    expect(res.scope).toBe('doc');
    expect(res.files).toEqual(['lib/a.docx']);
  });

  it('spaceId 残留时兜底查个人库（仍然锁定这一份 doc，不回退整库）', async () => {
    // 第一次（带 spaceId）空 → 第二次（个人库）命中
    rawCollectMock.mockReturnValueOnce([]).mockReturnValueOnce(['## lib/a.docx\n正文']);
    const res = await kbMindmap('u1', { spaceId: 'sp1', doc: 'lib/a.docx' }, { complete: completeOk(SAMPLE) });
    expect(res.source).toBe('generated');
    expect(res.scope).toBe('doc');
    expect(res.files).toEqual(['lib/a.docx']);
    // 两次调用的作用域参数：先带 spaceId，再不带
    expect(rawCollectMock.mock.calls[0][1]).toMatchObject({ spaceId: 'sp1', doc: 'lib/a.docx' });
    expect(rawCollectMock.mock.calls[1][1]).toMatchObject({ spaceId: null, doc: 'lib/a.docx' });
  });

  it('两处都找不到才算 not-found（且不会去读整库）', async () => {
    rawCollectMock.mockReturnValue([]);
    const res = await kbMindmap('u1', { spaceId: 'sp1', doc: 'lib/gone.txt' }, { complete: completeOk('{}') });
    expect(res.source).toBe('degraded');
    expect(res.reason).toBe('not-found');
    expect(rawCollectMock.mock.calls.every((c) => (c[1] as { doc?: string }).doc === 'lib/gone.txt')).toBe(true);
  });

  it('回执 scope=dir 且列出实际纳入的文件（整库脑图）', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.docx\nA', '## lib/b.pdf\nB']);
    const res = await kbMindmap('u1', { dir: 'lib' }, { complete: completeOk(SAMPLE) });
    expect(res.scope).toBe('dir');
    expect(res.files).toEqual(['lib/a.docx', 'lib/b.pdf']);
  });

  it('回执 scope=text（基于对话回答生成，无文件）', async () => {
    rawCollectMock.mockReturnValue([]);
    const res = await kbMindmap('u1', { text: '一段回答文本' }, { complete: completeOk(SAMPLE) });
    expect(res.scope).toBe('text');
    expect(res.files).toEqual([]);
  });

  it('指定 doc 但库里读不到 → degraded/not-found（不再含糊成"空库"）', async () => {
    rawCollectMock.mockReturnValue([]);
    const res = await kbMindmap('u1', { doc: 'lib/gone.txt' }, { complete: completeOk('{}') });
    expect(res.source).toBe('degraded');
    expect(res.reason).toBe('not-found');
    expect(res.scope).toBe('doc');
  });

  it('降级/缓存路径也带作用域回执（渲染层任何时候都能校验）', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.docx\nx']);
    const cached = await kbMindmap('u1', { doc: 'lib/a.docx' }, { complete: completeOk(SAMPLE) });
    expect(cached.source).toBe('generated');
    const second = await kbMindmap('u1', { doc: 'lib/a.docx' }, { complete: completeOk(SAMPLE) });
    expect(second.source).toBe('cached');
    expect(second.scope).toBe('doc');
    expect(second.files).toEqual(['lib/a.docx']);

    // 降级路径：清缓存后换一份文档，确保走真实调用而不是缓存
    _internals.clearCacheForTests();
    rawCollectMock.mockReturnValue(['## lib/b.docx\ny']);
    const failed = await kbMindmap('u1', { doc: 'lib/b.docx' }, {
      complete: async () => ({ ok: false, text: '', error: 'provider down' }),
    });
    expect(failed.source).toBe('degraded');
    expect(failed.scope).toBe('doc');
    expect(failed.files).toEqual(['lib/b.docx']);
  });

  it('serves cached result on the same fingerprint', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.pdf\nx']);
    const complete = completeOk(SAMPLE);
    const first = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(first.source).toBe('generated');
    const second = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(second.source).toBe('cached');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('degrades to a single node when there are no ready docs', async () => {
    rawCollectMock.mockReturnValue([]);
    const res = await kbMindmap('u1', { dir: 'lib' }, { complete: completeOk('{}') });
    expect(res.source).toBe('degraded');
    expect(res.reason).toBe('empty');
    expect(res.root.label).toBe('知识库');
    expect(res.root.children).toEqual([]);
  });

  it('degrades when the model fails', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.pdf\nx']);
    const complete = vi.fn(async () => ({ ok: false, text: '', error: 'provider down' }));
    const res = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(res.source).toBe('degraded');
    expect(res.reason).toBe('model-failed');
  });

  it('parses the tree out of model text with code fences', () => {
    const root = parseMindJson(`输出：\n\`\`\`json\n${SAMPLE}\n\`\`\``);
    expect(root.label).toBe('软件工程与AI');
    expect(root.children[1].children[0].label).toBe('Claude Code');
  });

  it('extracts optional source field for traceability', () => {
    const root = parseMindJson(JSON.stringify({
      root: { label: 'R', children: [{ label: 'A', source: 'AST-Surgery.pdf', children: [{ label: 'A1', children: [] }] }] },
    }));
    expect(root.children[0].source).toBe('AST-Surgery.pdf');
    expect(root.children[0].children[0].source).toBeUndefined();
  });

  it('force regenerates instead of serving the cache', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.pdf\nx']);
    const complete = completeOk(SAMPLE);
    const first = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(first.source).toBe('generated');
    const cached = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(cached.source).toBe('cached');
    const forced = await kbMindmap('u1', { dir: 'lib', force: true }, { complete });
    expect(forced.source).toBe('generated');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent duplicate requests into one LLM call (single-flight)', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.pdf\nx']);
    type CompleteRes = { ok: boolean; text: string; error: string };
    let release!: (v: CompleteRes) => void;
    const gate = new Promise<CompleteRes>((r) => { release = r; });
    const complete = vi.fn(() => gate);
    // 未 await 即发起第二次：应复用同一在途 Promise，不重复调 LLM
    const p1 = kbMindmap('u1', { dir: 'lib' }, { complete });
    const p2 = kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(complete).toHaveBeenCalledTimes(1);
    release({ ok: true, text: SAMPLE, error: '' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.source).toBe('generated');
    expect(r2.source).toBe('generated');
    expect(r2.root.children.length).toBe(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('degrades on LLM timeout and caches the late-arriving success for instant retry', async () => {
    vi.useFakeTimers();
    try {
      rawCollectMock.mockReturnValue(['## lib/a.pdf\nx']);
      type CompleteRes = { ok: boolean; text: string; error: string };
      let release!: (v: CompleteRes) => void;
      const gate = new Promise<CompleteRes>((r) => { release = r; });
      const complete = vi.fn(() => gate);
      const firstP = kbMindmap('u1', { dir: 'lib' }, { complete });
      await vi.advanceTimersByTimeAsync(181_000); // 超过 180s 上限
      const first = await firstP;
      expect(first.source).toBe('degraded');
      expect(first.reason).toBe('timeout');
      expect(first.root).toEqual({ label: '知识库', children: [] });
      // 迟到的成功结果到达 → 兜底写入缓存；随即重试（同指纹）应秒出且不再调 LLM
      release({ ok: true, text: SAMPLE, error: '' });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      const second = await kbMindmap('u1', { dir: 'lib' }, { complete });
      expect(second.source).toBe('cached');
      expect(second.root.label).toBe('软件工程与AI');
      expect(second.root.children.length).toBe(2);
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('kb_mindmap store', () => {
  it('saves / lists / loads mind maps by key in the user data dir', () => {
    const key = mindKey('spc1');
    expect(mindKey('spc1')).toBe('space:spc1');
    expect(mindKey(null, 'lib')).toBe('dir:lib');
    // 文档级脑图走独立 key（同一目录下不同文档互不覆盖）
    expect(mindKey(null, 'lib', 'lib/a.docx')).toBe('doc:lib/a.docx');
    expect(mindKey('spc1', null, 'lib/a.docx')).toBe('doc:lib/a.docx');
    expect(listMindmaps()).toEqual([]);

    const root = { label: '根', children: [{ label: '分支', children: [] }] };
    saveMindmap(key, root);
    const listed = listMindmaps();
    expect(listed.length).toBe(1);
    expect(listed[0].key).toBe('space:spc1');
    expect(listed[0].savedAt).toBeGreaterThan(0);

    const loaded = loadMindmap(key);
    expect(loaded).toEqual(root);
    expect(loadMindmap('space:nope')).toBeNull();
  });

  it('overwrites the same key and persists across re-reads', () => {
    const key = mindKey(null, 'lib');
    saveMindmap(key, { label: '旧', children: [] });
    saveMindmap(key, { label: '新', children: [] });
    expect(loadMindmap(key)?.label).toBe('新');
    expect(listMindmaps().length).toBe(2); // space:spc1 (上一用例) + dir:lib
  });

  it('generates a mind map from provided conversation text (text param)', async () => {
    rawCollectMock.mockReturnValue([]); // text 模式不读库
    const complete = completeOk(SAMPLE);
    const res = await kbMindmap('u1', { dir: null, spaceId: null, text: '中国文明与西方文明交流互鉴，丝绸之路…' }, { complete });
    expect(res.source).toBe('generated');
    expect(res.root.label).toBe('软件工程与AI');
    // LLM prompt 应包含对话文本而非库要点
    const call = complete.mock.calls[0][0] as { message: string };
    expect(call.message).toContain('中国文明与西方文明交流互鉴');
    expect(call.message).not.toContain('## lib/');
  });

  it('prompts for a radial root theme and parallel top branches (not a single chain)', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.pdf\n要点']);
    const complete = completeOk(SAMPLE);
    await kbMindmap('u1', { dir: 'lib' }, { complete });
    const sys = complete.mock.calls[0][0] as { systemPrompt: string };
    // 中心根主题要求
    expect(sys.systemPrompt).toContain('必须有中心根主题');
    expect(sys.systemPrompt).toContain('2–8');
    expect(sys.systemPrompt).toContain('严禁串成单链');
    // 短语 + source 备注要求
    expect(sys.systemPrompt).toContain('中文短语');
    expect(sys.systemPrompt).toContain('source');
  });

  it('demands full coverage of every section and 3–4 levels (regression: 只整理开头)', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.pdf\n要点']);
    const complete = completeOk(SAMPLE);
    await kbMindmap('u1', { dir: 'lib' }, { complete });
    const sys = complete.mock.calls[0][0] as { systemPrompt: string };
    // 覆盖约束：一级分支必须对应要点里的每一个章节，不能只整理开头
    expect(sys.systemPrompt).toContain('必须覆盖材料的全部内容');
    expect(sys.systemPrompt).toContain('不能漏');
    // 层级展开到 3–4 层（旧协议 2–3 层封顶，天然出不来 4 层结构）
    expect(sys.systemPrompt).toContain('3–4 层');
    // 节点总量上限与指标保留要求
    expect(sys.systemPrompt).toContain('120');
    expect(sys.systemPrompt).toContain('数字、指标、专业名词');
  });

  it('scopes generation to a single doc when `doc` is given (文档级脑图)', async () => {
    rawCollectMock.mockReturnValue(['## lib/a.docx\n要点']);
    const complete = completeOk(SAMPLE);
    await kbMindmap('u1', { dir: 'lib', doc: 'lib/a.docx' }, { complete });
    // `doc` 必须透传给采集层，否则仍是整库作用域
    expect(rawCollectMock).toHaveBeenCalledWith('u1', expect.objectContaining({ doc: 'lib/a.docx' }));
  });

  it('deletes a saved mind map by key (returns false for missing keys)', () => {
    const key = mindKey('sp-del');
    saveMindmap(key, { label: '待删', children: [] });
    expect(loadMindmap(key)?.label).toBe('待删');
    expect(deleteMindmap(key)).toBe(true);
    expect(loadMindmap(key)).toBeNull();
    expect(deleteMindmap('space:nope')).toBe(false);
  });
});
