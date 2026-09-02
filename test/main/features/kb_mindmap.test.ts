/**
 * kb_mindmap (知识库多级脑图，本地化 notebooklm mind-map 协议) — 层级树生成。
 *
 * mocks kb_summary.collectReadyDocLines + deps.complete，验证多级 JSON 解析 /
 * 缓存 / 降级路径。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/features/kb_summary', () => ({
  collectReadyDocLines: vi.fn(() => []),
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
  mindKey,
} from '../../../src/main/features/kb_mindmap';
import { collectReadyDocLines } from '../../../src/main/features/kb_summary';

const collectMock = vi.mocked(collectReadyDocLines);

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
  collectMock.mockReset();
  _internals.clearCacheForTests();
});

describe('kb_mindmap', () => {
  it('generates a multi-level tree from library doc lines', async () => {
    collectMock.mockReturnValue(['## lib/a.pdf\n要点……', '## lib/b.docx\n要点……']);
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

  it('serves cached result on the same fingerprint', async () => {
    collectMock.mockReturnValue(['## lib/a.pdf\nx']);
    const complete = completeOk(SAMPLE);
    const first = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(first.source).toBe('generated');
    const second = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(second.source).toBe('cached');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('degrades to a single node when there are no ready docs', async () => {
    collectMock.mockReturnValue([]);
    const res = await kbMindmap('u1', { dir: 'lib' }, { complete: completeOk('{}') });
    expect(res.source).toBe('degraded');
    expect(res.root.label).toBe('知识库');
    expect(res.root.children).toEqual([]);
  });

  it('degrades when the model fails', async () => {
    collectMock.mockReturnValue(['## lib/a.pdf\nx']);
    const complete = vi.fn(async () => ({ ok: false, text: '', error: 'provider down' }));
    const res = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(res.source).toBe('degraded');
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
    collectMock.mockReturnValue(['## lib/a.pdf\nx']);
    const complete = completeOk(SAMPLE);
    const first = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(first.source).toBe('generated');
    const cached = await kbMindmap('u1', { dir: 'lib' }, { complete });
    expect(cached.source).toBe('cached');
    const forced = await kbMindmap('u1', { dir: 'lib', force: true }, { complete });
    expect(forced.source).toBe('generated');
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('kb_mindmap store', () => {
  it('saves / lists / loads mind maps by key in the user data dir', () => {
    const key = mindKey('spc1');
    expect(mindKey('spc1')).toBe('space:spc1');
    expect(mindKey(null, 'lib')).toBe('dir:lib');
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
    collectMock.mockReturnValue([]); // text 模式不读库
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
    collectMock.mockReturnValue(['## lib/a.pdf\n要点']);
    const complete = completeOk(SAMPLE);
    await kbMindmap('u1', { dir: 'lib' }, { complete });
    const sys = complete.mock.calls[0][0] as { systemPrompt: string };
    // 中心根主题要求
    expect(sys.systemPrompt).toContain('必须有中心根主题');
    expect(sys.systemPrompt).toContain('2–4');
    expect(sys.systemPrompt).toContain('严禁串成单链');
    // 简短短语 + source 备注要求
    expect(sys.systemPrompt).toContain('简短短语');
    expect(sys.systemPrompt).toContain('source');
  });
});
