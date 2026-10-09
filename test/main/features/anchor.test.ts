/**
 * `cogseed.anchor.resolve` IPC 边界（features/anchor.ts）。
 *
 * 真机反馈：「很多文件打开都有返回引用，并且前几行都有橙色高亮」。根因在这一层：
 * 调用方（知识库文件列表 / 发现页 / 摘要与脑图的来源跳转）本来只是想"打开整篇"，
 * 却传了占位 chunk 号；IPC 又给缺省值补 0，于是每一份文件都被当成"定位到某个
 * 引用片段"解析 → 渲染层照着 charStart/charEnd 高亮正文前几行，按钮判据也把
 * 有限的 chunkIdx 当成"从引用进来的"。
 *
 * 契约：**chunkIdx 只在调用方真的给了数字时才是引用定位**；省略 = 打开整篇，
 * 不查 chunk、不返回区间。引用意图也可以只由 quote 表达。
 *
 * 解析器本体在 anchor-resolver.test.ts 里用真实临时库验证；这里只锁 IPC 的
 * 参数整形（用 mock 隔离，连 sqlite 都不需要）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/main/model/core-agent/anchor-resolver', () => ({
  resolveAnchor: vi.fn(async () => ({ resolved: true, text: 'body' })),
}));

import { anchorResolveIpc } from '../../../src/main/features/anchor';
import { resolveAnchor } from '../../../src/main/model/core-agent/anchor-resolver';

const resolveMock = vi.mocked(resolveAnchor);

/** 最近一次交给解析器的 AnchorTarget。 */
function lastTarget(): Record<string, unknown> {
  expect(resolveMock).toHaveBeenCalled();
  return resolveMock.mock.calls[resolveMock.mock.calls.length - 1][0] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  resolveMock.mockClear();
});

describe('anchor.resolve：整篇打开 vs 引用定位', () => {
  it('不带 chunkIdx/quote（打开整篇）不补 chunkIdx，解析器因此不会定位', async () => {
    const res = await anchorResolveIpc('u1', {
      source: 'library', scope: 'global', path: 'notes/plan.md', view: 'document',
    });

    expect(res).toMatchObject({ resolved: true });
    const target = lastTarget();
    expect(target).not.toHaveProperty('chunkIdx');
    expect(target).not.toHaveProperty('quote');
  });

  it('带 chunkIdx（引用）原样传下去，语义不变', async () => {
    await anchorResolveIpc('u1', {
      source: 'library', scope: 'global', path: 'notes/plan.md', chunkIdx: 2, view: 'document',
    });

    expect(lastTarget().chunkIdx).toBe(2);
  });

  it('只给 quote 也算引用（测验「原文依据」就是这条）', async () => {
    await anchorResolveIpc('u1', {
      path: 'notes/plan.md', quote: '这段是题目依据的原文。', view: 'document',
    });

    expect(lastTarget()).toMatchObject({ quote: '这段是题目依据的原文。' });
    expect(lastTarget()).not.toHaveProperty('chunkIdx');
  });

  it('片段视图没有任何定位依据 → bad_input，不惊动解析器', async () => {
    // 不带 view ⇒ 片段视图；既没有 chunk 也没有 quote，给不出"跳到哪"
    const res = await anchorResolveIpc('u1', { path: 'notes/plan.md' });

    expect(res).toEqual({ resolved: false, reason: 'bad_input' });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('片段视图只给 quote 也成立（依据由 quote 提供）', async () => {
    const res = await anchorResolveIpc('u1', { path: 'notes/plan.md', quote: '一句原文' });

    expect(res).toMatchObject({ resolved: true });
    expect(lastTarget()).toMatchObject({ view: 'anchor' });
  });

  it('缺 path 仍然 bad_input', async () => {
    const res = await anchorResolveIpc('u1', { view: 'document' });

    expect(res).toEqual({ resolved: false, reason: 'bad_input' });
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
