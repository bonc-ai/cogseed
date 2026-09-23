/**
 * 库列表不落后于磁盘（真机反馈 2026-09-16）
 *
 * 现场：在「转写纠错」里把清理版另存到知识库 → 磁盘、向量库（kb_files=ready）、
 * 检索索引里都有那份 `…-清理版.txt`，可个人知识库列表里就是找不到，用户以为
 * "另存没生效"，于是重跑了一遍纠错、再点一次另存（这次被 sha1 去重拦下）。
 *
 * 机制原因：两个视图渲染的都是**各自进入视图时拍的树快照**
 * （contexts.js 的 `_ctxTree`、kb-workbench.js 的 `_state.tree`）；main 侧写盘后
 * 只推一条 kb.events 「索引进度」事件，此前只更新「已索引」徽标、从不重拉树。
 *
 * 本文件锁两条不变量：
 *   1. 索引事件指向快照里没有（或快照里还留着）的路径 → 去抖后重拉树；
 *      已知路径的进度只更新徽标，不做无谓的整树刷新。
 *   2. 写入方（另存清理版 / 另存附记 / 词表导出）保存后必须显式请求重载。
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const ROOT = path.resolve(__dirname, '../..');
const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 现场等价物：个人库里「文字转写」目录下已有原文，`-清理版.txt` 还没进快照。
const TREE = [
  {
    name: '文字转写',
    path: '文字转写',
    type: 'dir',
    children: [
      { name: '文字转写_ECS9点30早会.txt', path: '文字转写/文字转写_ECS9点30早会.txt', type: 'file', bytes: 32114, mtime: 1 },
    ],
  },
];
const KB_STATUS = [
  { path: '文字转写/文字转写_ECS9点30早会.txt', status: 'ready', chunks: 45, kind: 'text' },
];
const CLEANED = '文字转写/文字转写_ECS9点30早会-清理版.txt';

function loadContextsHarness() {
  const context: any = {
    AbortController,
    TextDecoder,
    clearTimeout,
    performance,
    setTimeout,
    console,
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    addEventListener: vi.fn(),
    // 三个接口：树、索引状态、事件流（流永不结束，避免订阅重连额外拉树）
    apiFetch: vi.fn(async (url: string) => {
      if (url.includes('/api/kb/events/stream')) {
        return { ok: true, body: { getReader: () => ({ read: () => new Promise(() => { /* 长连接 */ }) }) } };
      }
      if (url.includes('/api/contexts/tree')) return { json: async () => ({ ok: true, tree: TREE }) };
      if (url.includes('/api/kb/status')) return { json: async () => ({ ok: true, files: KB_STATUS }) };
      return { ok: false, json: async () => ({ ok: false }) };
    }),
    document: {
      addEventListener: vi.fn(),
      body: {},
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['icons.js', 'ui-button.js', 'ui-form.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(ROOT, 'src/renderer/modules', file), 'utf8'),
      context,
      { filename: file },
    );
  }
  vm.runInContext(readSrc('src/renderer/modules/contexts.js'), context, { filename: 'contexts.js' });
  return context;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 资源树（contexts.js）一侧：进入过视图 → 快照已拍下。 */
async function enteredContextsView() {
  const context = loadContextsHarness();
  const treeCalls = () => (context.apiFetch as any).mock.calls
    .filter(([url]: [string]) => String(url).includes('/api/contexts/tree')).length;
  await context.loadContexts();
  expect(treeCalls()).toBe(1);
  return { context, treeCalls };
}

describe('资源树：索引事件说明库变了就重拉快照', () => {
  it('快照里没有的新文件（典型：另存清理版）→ 去抖后重拉树', async () => {
    const { context, treeCalls } = await enteredContextsView();

    context._applyKbEvent({ relPath: CLEANED, status: 'ready', chunks: 40, kind: 'text' });

    // 去抖：不逐条事件打接口
    expect(treeCalls()).toBe(1);
    await sleep(600);
    expect(treeCalls()).toBe(2);
  });

  it('pending → processing → ready 三条事件合并成一次重拉', async () => {
    const { context, treeCalls } = await enteredContextsView();

    context._applyKbEvent({ relPath: CLEANED, status: 'pending', kind: 'text' });
    context._applyKbEvent({ relPath: CLEANED, status: 'processing', kind: 'text' });
    context._applyKbEvent({ relPath: CLEANED, status: 'ready', chunks: 40, kind: 'text' });

    await sleep(600);
    expect(treeCalls()).toBe(2);
  });

  it('已知路径的索引进度只更新徽标，不重拉树（不做无谓的整树刷新）', async () => {
    const { context, treeCalls } = await enteredContextsView();

    context._applyKbEvent({ relPath: '文字转写/文字转写_ECS9点30早会.txt', status: 'ready', chunks: 45, kind: 'text' });

    await sleep(600);
    expect(treeCalls()).toBe(1);
  });

  it('文件在别处被删掉（快照里还在）→ 重拉，让幽灵行消失', async () => {
    const { context, treeCalls } = await enteredContextsView();

    context._applyKbEvent({ relPath: '文字转写/文字转写_ECS9点30早会.txt', status: 'deleted' });

    await sleep(600);
    expect(treeCalls()).toBe(2);
  });
});

describe('写入方通知契约：另存之后必须请库视图重载', () => {
  const WRITERS = [
    'src/renderer/modules/kb-transcript-correct.js', // 另存清理版 / 另存附记
    'src/renderer/modules/kb-glossary-manager.js',   // 词表导出另存
  ];

  it.each(WRITERS)('%s 定义 notifyLibraryChanged 并在保存后调用', (file) => {
    const source = readSrc(file);
    expect(source).toContain('function notifyLibraryChanged()');
    // 两个库视图的刷新入口（未加载时静默跳过）
    expect(source).toMatch(/notifyLibraryChanged\(\)[\s\S]{0,400}root\.loadContexts/);
    expect(source).toContain('root.renderKbWorkbench');
    const calls = source.match(/notifyLibraryChanged\(\);/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('kb-workbench 自己的写库路径（新建文本）本来就会重载，不依赖事件兜底', () => {
    const source = readSrc('src/renderer/modules/kb-workbench.js');
    expect(source).toMatch(/invoke\('contexts\.write'[\s\S]{0,400}_loadAll\(\)/);
  });

  it('兜底重载有去抖与"正在加载则顺延"，不丢刷新也不打爆接口', () => {
    const source = readSrc('src/renderer/modules/kb-workbench.js');
    expect(source).toMatch(/function _scheduleTreeReload\(\)[\s\S]{0,400}if \(_treeReloadTimer\) return;/);
    expect(source).toMatch(/if \(_state\.loading\) \{ _scheduleTreeReload\(\); return; \}/);
    const contexts = readSrc('src/renderer/modules/contexts.js');
    expect(contexts).toMatch(/function _scheduleContextsReload\(\)[\s\S]{0,300}if \(_ctxTreeReloadTimer\) return;/);
  });
});
