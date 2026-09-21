import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/anchored-source-view.js'),
  'utf8',
);

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: (...names: string[]) => names.forEach((name) => values.add(name)),
    remove: (...names: string[]) => names.forEach((name) => values.delete(name)),
    contains: (name: string) => values.has(name),
    toggle: (name: string, force?: boolean) => {
      const enabled = force == null ? !values.has(name) : force;
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
  };
}

interface LoadOpts {
  /** 主进程 anchor.resolve 返回的正文（决定"普通文档 / 逐字稿"）。 */
  text?: string;
  /** 注入的富查看器桥；省略 = 桥不存在。 */
  richBridge?: (anchor: any) => any;
  /** 注入 loadRendererFeature（按需加载 KB 功能）。 */
  loadFeature?: (name: string) => Promise<void>;
  /** 注入统一 markdown 管线（真实环境由 utils.js 提供）；省略 = 管线缺席。 */
  markdown?: (md: string) => string;
  /** 注入 MathJax 再排版入口（真实环境由 math.js 提供）。 */
  typesetMath?: (el: any) => void;
}

function loadViewer(opts: LoadOpts = {}) {
  let toggleHandler: (() => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let mdSourceHandler: (() => void) | null = null;
  const buttonLabels: string[] = [];
  const richCalls: any[] = [];
  const loadedFeatures: string[] = [];
  const makeElement = () => ({
    textContent: '',
    hidden: false,
    dataset: {} as Record<string, string>,
    innerHTML: '',
    classList: fakeClassList(),
    appendChild: vi.fn(),
    addEventListener: vi.fn((name: string, handler: () => void) => {
      if (name === 'click') toggleHandler = handler;
    }),
    // 真实元素一定有 querySelectorAll（工具栏用它挂多档字号按钮的监听）
    querySelectorAll: vi.fn(() => []),
    querySelector: vi.fn((selector: string) => {
      if (selector === '[data-anchor-view-toggle]') {
        return { addEventListener: (_name: string, handler: () => void) => { toggleHandler = handler; } };
      }
      if (selector === '[data-anchor-view-md-source]') {
        return { addEventListener: (_name: string, handler: () => void) => { mdSourceHandler = handler; } };
      }
      return selector === 'mark' ? { scrollIntoView: vi.fn() } : null;
    }),
  });
  const elements: Record<string, any> = {
    '[data-anchor-view-meta]': makeElement(),
    '[data-anchor-view-actions]': makeElement(),
    '[data-anchor-view-status]': makeElement(),
    '[data-anchor-view-text]': makeElement(),
    '[data-anchor-view-note]': makeElement(),
    '.ui-modal__title': makeElement(),
    '.ui-modal__description': makeElement(),
    '[data-ui-modal-close]': {
      addEventListener: vi.fn((name: string, handler: () => void) => {
        if (name === 'click') closeHandler = handler;
      }),
    },
  };
  const dialog = {
    classList: fakeClassList(),
    querySelector: vi.fn((selector: string) => elements[selector] || null),
  };
  const overlay = {};
  const modal = Object.assign(new Promise(() => {}), { dialog, overlay, close: vi.fn() });
  const text = opts.text ?? 'prefix cited passage suffix';
  // 与主进程同一份契约：**只有真给了 chunkIdx/quote 才算引用**（才会返回
  // charStart/charEnd）。"打开整篇"的请求拿不到区间，渲染层自然没有 <mark>，
  // 按钮判据也不会把有限 chunkIdx 当"从引用进来的"。
  const invoke = vi.fn(async (_channel: string, payload: any) => {
    const anchorRequested = Number.isFinite(Number(payload.chunkIdx))
      || Boolean(String(payload.quote || '').trim());
    return {
      resolved: true,
      displayPath: payload.path,
      textStart: 0,
      text,
      ...(anchorRequested ? { charStart: 0, charEnd: Math.min(20, text.length) } : {}),
      totalChars: text.length,
    };
  });
  const uiModal = vi.fn(() => modal);
  // 属性照实落到假 HTML 上：工具栏用 data-* 打钩子（视图切换 / md 源码切换 /
  // 字号），钩子对不上就等于界面上没有这个按钮——mock 不能替它兜底。
  const uiButton = vi.fn(({ label, attrs }: { label: string; attrs?: Record<string, string> }) => {
    buttonLabels.push(label);
    const attrHtml = Object.entries(attrs || {})
      .map(([name, value]) => ` ${name}="${value}"`)
      .join('');
    return `<span${attrHtml}>${label}</span>`;
  });
  const windowMock: any = {
    addEventListener: vi.fn(),
    cogseed: { invoke },
    uiModal,
    uiButton,
    uiToast: vi.fn(),
    t: (key: string) => key,
    // 纠错面板模块（宿主 A 的 mount 入口）——存在与否本身就是准入条件之一
    KbTranscriptCorrect: { mount: vi.fn(() => ({ destroy: vi.fn() })) },
    localStorage: { getItem: () => null, setItem: () => {} },
    loadRendererFeature: (name: string) => {
      loadedFeatures.push(name);
      if (!opts.loadFeature) return Promise.resolve();
      return opts.loadFeature(name);
    },
  };
  if (opts.richBridge) {
    windowMock.__openKbRichFile = (anchor: any) => {
      richCalls.push(anchor);
      return Promise.resolve(opts.richBridge!(anchor));
    };
  }
  const documentMock: any = {
    body: { contains: vi.fn(() => true) },
    createTextNode: vi.fn((t: string) => ({ textContent: t })),
    createElement: vi.fn(() => makeElement()),
    // 高亮落点会真开 Range：`mdMarkRange` 首先看环境有没有 createRange。
    // 这里给一个假 Range（只记区间，不建 DOM），断言的是"涂了原文的哪一段"。
    createRange: vi.fn(() => ({
      setStart: vi.fn(),
      setEnd: vi.fn(),
      surroundContents: vi.fn(),
    })),
  };
  /** 正文里真的插了几个 `<mark>`（橙色高亮）——"打开整篇不该自带高亮"用它断言。 */
  const markCount = () => (documentMock.createElement as any).mock.calls
    .filter(([tag]: string[]) => tag === 'mark').length;
  const context: any = {
    window: windowMock,
    document: documentMock,
    globalThis: windowMock,
    module: { exports: {} },
    Promise,
    requestAnimationFrame: (callback: () => void) => callback(),
    createLogger: () => ({ warn: vi.fn() }),
  };
  // 统一 markdown 管线 / MathJax 再排版：真实环境是 utils.js、math.js 提供的
  // 全局函数（classic script 的顶层 const，不在 window 上，只能按裸标识符注入）。
  if (opts.markdown) context.renderMarkdown = opts.markdown;
  if (opts.typesetMath) context.typesetMath = opts.typesetMath;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'anchored-source-view.js' });
  return {
    windowMock,
    uiModal,
    uiButton,
    modal,
    invoke,
    richCalls,
    loadedFeatures,
    elements,
    markCount,
    resetLabels: () => { buttonLabels.length = 0; },
    labels: () => buttonLabels.slice(),
    getToggleHandler: () => toggleHandler,
    getMdSourceHandler: () => mdSourceHandler,
    getCloseHandler: () => closeHandler,
  };
}

// 两段「说话人 + 时间」块头 = 逐字稿特征（纠错面板的服务对象）
const TRANSCRIPT_TEXT = [
  'SpeakerA 2026-09-05 19:31:32',
  'Hello.',
  '张磊 2026-09-05 19:31:34',
  '哈喽哈喽能听到吗？',
].join('\n');

/**
 * 真机事故夹具（2026-09-18）：腾讯会议「相对时钟」导出——整点前只给 `mm:ss`
 * （`王伟 02:45`），整点后才变成 `李强 01:00:35`。块头判定只认 `hh:mm:ss` 时，
 * 首个被识别的块头之前的内容从不进 DOM（实测一份 77 分钟的稿子丢了 77%）。
 */
const RELATIVE_CLOCK_TRANSCRIPT = [
  '王伟 02:45',
  '喂海运哥能听到吗？喂我这。',
  '刘洋 02:56',
  '我这边能听到？',
  '李强 57:59',
  '行没问题，后边就是还有两页是啥？',
  '李强 01:00:35',
  '对，然后下边就是实现的现状与缺口。',
].join('\n');

/**
 * 从假 DOM 里回收「对话块正文」文本：正文装在 `.anchored-source-block-body`
 * 里（可能含高亮 `<mark>`），块头是独立 meta 行、不算正文。
 */
function renderedBlockBodies(pre: any): string {
  const textOf = (node: any): string => {
    const children = (node?.appendChild?.mock?.calls || []).map((call: any[]) => call[0]);
    if (!children.length) return typeof node?.textContent === 'string' ? node.textContent : '';
    return children.map(textOf).join('');
  };
  const out: string[] = [];
  const walk = (node: any) => {
    for (const child of (node?.appendChild?.mock?.calls || []).map((call: any[]) => call[0])) {
      if (child?.className === 'anchored-source-block-body') out.push(textOf(child));
      else walk(child);
    }
  };
  walk(pre);
  return out.join('');
}

describe('anchored source viewer', () => {
  it('opens files through the shared modal and reuses the active viewer', async () => {
    const viewer = loadViewer();

    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 1, view: 'document',
    });
    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/b.md', chunkIdx: 1, view: 'document',
    });

    expect(viewer.uiModal).toHaveBeenCalledOnce();
    expect(viewer.uiButton).toHaveBeenCalled();
    expect(viewer.invoke).toHaveBeenLastCalledWith('cogseed.anchor.resolve', expect.objectContaining({
      path: 'notes/b.md',
      view: 'document',
    }));
  });

  it('closes the document reader from its corner close control', async () => {    const viewer = loadViewer();
    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/feishu-wiki.md', chunkIdx: 1, view: 'document',
    });

    viewer.getCloseHandler()?.();

    expect(viewer.modal.close).toHaveBeenCalledWith(null, 'close');
  });

  it('switches from full source back to the highlighted citation', async () => {
    const viewer = loadViewer();
    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 1, view: 'document',
    });

    viewer.getToggleHandler()?.();

    await vi.waitFor(() => expect(viewer.invoke).toHaveBeenLastCalledWith(
      'cogseed.anchor.resolve',
      expect.objectContaining({ view: 'anchor' }),
    ));
  });

  it('视觉规范：对话块识别是纯函数，且不修改任何文本', () => {
    // 通过源码契约守住两条：① 有块识别；② 只用于阅读着色（不参与替换）
    expect(source).toContain('function splitDialogueBlocks');
    expect(source).toContain('anchored-source-block-body');
    expect(source).toMatch(/useBlocks = blocks\.length >= 2/);
    expect(source).not.toMatch(/splitDialogueBlocks[\s\S]{0,400}(replace|correct)\s*\(/);
  });

  it('contains no page-local raw buttons or literal z-index values', () => {
    expect(source).not.toMatch(/<button\b/i);
    expect(source).not.toMatch(/z-index\s*:/i);
    expect(source).toContain('root.uiModal');
    expect(source).toContain('root.uiButton');
  });
});

describe('纠错入口只服务「文字转写」', () => {
  const open = (viewer: any, path: string) => viewer.windowMock.__openAnchorViewer({
    source: 'library', scope: 'global', path, chunkIdx: 1, view: 'document',
  });

  it('普通文档（方案/笔记）不出现「转写纠错」', async () => {
    const viewer = loadViewer({ text: '# 知识库落地计划\n\n1. 先做词表。\n2. 再做检索改写。' });
    await open(viewer, '1/p3394-发版扫描清理-任务提示词.md');

    expect(viewer.labels()).not.toContain('转写纠错');
    // 其它能力不受影响（阅读字号照旧）
    expect(viewer.labels()).toContain('中');
  });

  it('逐字稿（说话人 + 时间块）保留「转写纠错」', async () => {
    const viewer = loadViewer({ text: TRANSCRIPT_TEXT });
    await open(viewer, '1/会议录音.txt');

    expect(viewer.labels()).toContain('转写纠错');
  });

  it('名字就是转写稿（正文被截断到没有块头）时也保留入口', async () => {
    const viewer = loadViewer({ text: '就是把 link 弄下来之后，让模型一个一个看。' });
    await open(viewer, '1/文字转写_教育智能体演示汇报_221240800.txt');

    expect(viewer.labels()).toContain('转写纠错');
  });

  it('带转写声明（"机器识别结果仅供参考"）的稿子同样算转写', async () => {
    const viewer = loadViewer({ text: '2026-09-05 19:26:04 会议已开启实时转写，机器识别结果仅供参考\n你好。' });
    await open(viewer, '1/随便什么.md');

    expect(viewer.labels()).toContain('转写纠错');
  });

  it('判定是纯函数，且在"阅读全文"之外不出入口', async () => {
    expect(source).toContain('function isTranscriptDocument');
    const viewer = loadViewer({ text: TRANSCRIPT_TEXT });
    await open(viewer, '1/转写.txt');
    viewer.resetLabels();
    // 回到引用片段视图：纠错面板只在阅读全文时给
    viewer.getToggleHandler()?.();
    await vi.waitFor(() => expect(viewer.invoke).toHaveBeenLastCalledWith(
      'cogseed.anchor.resolve',
      expect.objectContaining({ view: 'anchor' }),
    ));
    expect(viewer.labels()).not.toContain('转写纠错');
  });
});

describe('排版类文件不进纯文本阅读器（word/pdf「无法正常查看」的根因）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/anchored-source-view.js'),
    'utf8',
  );

  it('扩展名清单在这里是唯一来源，并暴露给分派层复用', () => {
    expect(src).toContain('root.__kbRichPreviewExts = RICH_PREVIEW_EXTS');
    expect(src).toContain('root.__kbIsRichPath = isRichPreviewPath');
    for (const ext of ['.pdf', '.docx', '.xlsx', '.pptx', '.html', '.mp4']) {
      expect(src).toContain(`'${ext}'`);
    }
  });

  it('PDF 交给富查看器，不再打开纯文本阅读器', async () => {
    const viewer = loadViewer({ richBridge: () => true });
    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: '归档测试/AST.pdf', chunkIdx: 1, view: 'document',
    });

    expect(viewer.richCalls).toHaveLength(1);
    expect(viewer.richCalls[0].path).toBe('归档测试/AST.pdf');
    expect(viewer.uiModal).not.toHaveBeenCalled();
  });

  it('富查看器桥缺席时按需加载 KB 功能，而不是退化成纯文本', async () => {
    let viewer: any;
    viewer = loadViewer({
      loadFeature: () => {
        // 桥随脚本加载出现（真实场景：kb-workbench.js 懒加载完成）
        viewer.windowMock.__openKbRichFile = (anchor: any) => {
          viewer.richCalls.push(anchor);
          return Promise.resolve(true);
        };
        return Promise.resolve();
      },
    });
    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: '1/招标文件.docx', chunkIdx: 1, view: 'document',
    });

    expect(viewer.loadedFeatures).toEqual(['kb']);
    expect(viewer.richCalls).toHaveLength(1);
    expect(viewer.uiModal).not.toHaveBeenCalled();
  });

  it('连富查看器都拉不起来时才回落纯文本（有正文总比打不开好）', async () => {
    const viewer = loadViewer({ loadFeature: () => Promise.reject(new Error('boom')) });
    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: '归档测试/AST.pdf', chunkIdx: 1, view: 'document',
    });

    expect(viewer.uiModal).toHaveBeenCalled();
  });

  it('纯文本仍走阅读器（纠错与引用高亮的宿主不变）', async () => {
    const viewer = loadViewer();
    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: '1/笔记.md', chunkIdx: 1, view: 'document',
    });

    expect(viewer.richCalls).toHaveLength(0);
    expect(viewer.uiModal).toHaveBeenCalled();
  });
});

/**
 * 真机反馈：「很多文件打开都有返回引用，并且前几行都有橙色高亮」。
 *
 * 两个症状同一个根：调用方把"打开整篇"的请求也塞了 chunk 号（占位值），
 * 主进程就把它当引用片段定位并返回 charStart/charEnd —— 渲染层照单高亮正文
 * 前几行，按钮判据又用"chunkIdx 是不是有限数"判断"是不是从引用进来的"。
 *
 * 现在的契约：**带的才是引用**。不带 chunkIdx/quote ⇒ 没有 `<mark>`、没有
 * 「返回引用位置」；带真实 chunk/quote ⇒ 两个都在。
 */
describe('整篇打开 ≠ 引用跳转（高亮与按钮都不该自作多情）', () => {
  it('不带 chunkIdx/quote 打开：没有「返回引用位置」，正文也没有高亮', async () => {
    const viewer = loadViewer({ text: '第一段正文\n\n第二段正文' });

    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/meeting.txt', view: 'document',
    });

    expect(viewer.labels()).not.toContain('返回引用位置');
    expect(viewer.markCount()).toBe(0);
  });

  it('带 chunkIdx 打开（真引用）：仍然给「返回引用位置」并高亮引用片段', async () => {
    const viewer = loadViewer({ text: '第一段正文\n\n第二段正文' });

    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/meeting.txt', chunkIdx: 2, view: 'document',
    });

    expect(viewer.labels()).toContain('返回引用位置');
    expect(viewer.markCount()).toBeGreaterThan(0);
  });

  it('只给 quote 打开（测验「原文依据」那条路）：高亮照旧，按钮也在', async () => {
    const viewer = loadViewer({ text: '前言\n\n这段是题目依据的原文。\n\n后记' });

    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/quiz-src.md', quote: '这段是题目依据的原文。', view: 'document',
    });

    expect(viewer.labels()).toContain('返回引用位置');
    expect(viewer.markCount()).toBeGreaterThan(0);
  });
});

/**
 * 真机反馈：「知识库里打开 .md 还是给机器读的格式」。根因是阅读器把正文
 * 原文直接塞进 `<pre>`（`# 标题` / `**加粗**` / `| 表 |` 原样可见）。现在
 * md 文档在「阅读全文」视图走统一 markdown 管线排版，引用定位改为在渲染
 * 结果里找摘录文本；`.txt` 等仍保持原文（它们本来就是给人读的纯文本）。
 */
describe('markdown 文档排版化（md 不再直出原文）', () => {
  // view = null → 不带 view（等价于默认的"引用片段"视图）
  const openDoc = (viewer: any, path: string, view: string | null = 'document') => (
    viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path, chunkIdx: 1, ...(view ? { view } : {}),
    })
  );

  it('阅读全文 + .md → 正文是渲染后的 HTML，且上了排版类名与形态标记', async () => {
    const markdown = vi.fn((md: string) => `<h1>${md.replace(/^#\s*/, '')}</h1>`);
    const typesetMath = vi.fn();
    const viewer = loadViewer({ markdown, typesetMath, text: '# 知识库落地计划\n\n- 词表\n- 检索改写' });

    await openDoc(viewer, 'notes/plan.md');

    const pre = viewer.elements['[data-anchor-view-text]'];
    expect(markdown).toHaveBeenCalledWith('# 知识库落地计划\n\n- 词表\n- 检索改写');
    expect(pre.innerHTML).toContain('<h1>知识库落地计划');
    expect(pre.innerHTML).not.toContain('# 知识库落地计划');
    expect(pre.dataset.md).toBe('rendered');
    expect(pre.classList.contains('markdown-body')).toBe(true);
    // $…$ 之类的数学要靠 MathJax 在渲染后补排
    expect(typesetMath).toHaveBeenCalledWith(pre);
  });

  it('.markdown 扩展名同样排版（大小写不敏感）', async () => {
    const markdown = vi.fn((md: string) => `<p>${md}</p>`);
    const viewer = loadViewer({ markdown, text: '正文' });

    await openDoc(viewer, 'notes/README.MARKDOWN');

    expect(markdown).toHaveBeenCalled();
    expect(viewer.elements['[data-anchor-view-text]'].dataset.md).toBe('rendered');
  });

  it('markdown 管线缺席时回落原文（有字可看，不打不开）', async () => {
    const viewer = loadViewer({ text: '# 标题' });

    await openDoc(viewer, 'notes/plan.md');

    const pre = viewer.elements['[data-anchor-view-text]'];
    expect(pre.dataset.md).toBeUndefined();
    expect(pre.innerHTML).toBe('');
  });

  it('纯文本（.txt）不排版：原文就是给人读的', async () => {
    const markdown = vi.fn((md: string) => `<p>${md}</p>`);
    const viewer = loadViewer({ markdown, text: '张三 2026-09-05 19:31:32' });

    await openDoc(viewer, 'notes/meeting.txt');

    expect(markdown).not.toHaveBeenCalled();
    expect(viewer.elements['[data-anchor-view-text]'].dataset.md).toBeUndefined();
  });

  it('逐字稿 .md 不排版：对话块（说话人/时间/分段底色）才是它的排版', async () => {
    const markdown = vi.fn((md: string) => `<p>${md}</p>`);
    const viewer = loadViewer({ markdown, text: TRANSCRIPT_TEXT });

    await openDoc(viewer, '1/会议录音.md');

    const pre = viewer.elements['[data-anchor-view-text]'];
    expect(markdown).not.toHaveBeenCalled();
    expect(pre.dataset.md).toBeUndefined();
    expect(pre.dataset.blocks).toBe('1');
  });

  it('引用片段视图不排版：字符偏移精确高亮才是这个视图的主职', async () => {
    const markdown = vi.fn((md: string) => `<p>${md}</p>`);
    const viewer = loadViewer({ markdown, text: '# 标题' });

    await openDoc(viewer, 'notes/plan.md', null);

    expect(markdown).not.toHaveBeenCalled();
    expect(viewer.elements['[data-anchor-view-text]'].dataset.md).toBeUndefined();
  });

  it('渲染后再切到纯文本文档时，排版类名与形态标记被清掉', async () => {
    const markdown = vi.fn((md: string) => `<h1>${md}</h1>`);
    const viewer = loadViewer({ markdown, text: '# 标题' });

    await openDoc(viewer, 'notes/plan.md');
    await openDoc(viewer, 'notes/meeting.txt');

    const pre = viewer.elements['[data-anchor-view-text]'];
    expect(pre.dataset.md).toBeUndefined();
    expect(pre.classList.contains('markdown-body')).toBe(false);
  });
});

/**
 * 不变量：**块头认不出只该影响排版，绝不能让内容消失**。
 * 真机事故（2026-09-18）：相对时钟转写稿（整点前 `王伟 02:45`）在查看器里只剩
 * 整点之后的内容，用户看到的是"原文被删了"——实际是首个被识别的块头之前的内容
 * 从不进 DOM（一份 77 分钟的稿子丢了 77%）。
 */
describe('对话块渲染不得丢内容（相对时钟转写稿）', () => {
  /** 「打开整篇」：不给 chunkIdx/quote，与用户从知识库列表点开文件一致。 */
  const openWholeDoc = (viewer: any, path: string) => viewer.windowMock.__openAnchorViewer({
    source: 'library', scope: 'global', path, view: 'document',
  });

  it('整点前的 mm:ss 发言也渲染出来，正文覆盖全文', async () => {
    const viewer = loadViewer({ text: RELATIVE_CLOCK_TRANSCRIPT });

    await openWholeDoc(viewer, '1/9.15用户故事与认知资产模块对齐转写例会-(1).txt');

    const pre = viewer.elements['[data-anchor-view-text]'];
    // 走的是对话块形态（4 个块头全部识别）
    expect(pre.dataset.blocks).toBe('1');
    // 正文 = 原文里除块头行外的全部内容，一字不少、顺序不变
    expect(renderedBlockBodies(pre)).toBe([
      '喂海运哥能听到吗？喂我这。',
      '我这边能听到？',
      '行没问题，后边就是还有两页是啥？',
      '对，然后下边就是实现的现状与缺口。',
    ].join('\n'));
  });

  it('首块之前还有无法识别的散行时，那段文字照样渲染（不静默吞）', async () => {
    const text = [
      '会议已开启实时转写，机器识别结果仅供参考',
      '（这段没人名没时间，属于块外文本）',
      '王伟 02:45',
      '喂海运哥能听到吗？',
      '刘洋 02:56',
      '我这边能听到？',
    ].join('\n');
    const viewer = loadViewer({ text });

    await openWholeDoc(viewer, '1/文字转写_站会.txt');

    const bodies = renderedBlockBodies(viewer.elements['[data-anchor-view-text]']);
    expect(bodies).toContain('会议已开启实时转写，机器识别结果仅供参考');
    expect(bodies).toContain('（这段没人名没时间，属于块外文本）');
    expect(bodies).toContain('喂海运哥能听到吗？');
    expect(bodies).toContain('我这边能听到？');
  });
});

/**
 * md 阅读器两种形态都要（不二选一）：默认排版给人读，想看 `#`/`**` 原文、
 * 或需要按字符偏移核对引用时一键切到源码。入口只在"真会排版"的时候出现
 * （判据与 renderText 共用 canRenderMarkdown），否则点了像没反应。
 */
describe('md 阅读器的「查看源码 / 看排版」切换', () => {
  const openDoc = (viewer: any, path: string, view: string | null = 'document') => (
    viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path, chunkIdx: 1, ...(view ? { view } : {}),
    })
  );
  /**
   * 工具栏上 md 源码切换按钮的 i18n key（最后一次渲染的那个）；
   * 界面上没有这个按钮 → null。按 key 断言，不受文案/语言影响。
   */
  const mdToggleKey = (viewer: any) => {
    const calls = viewer.windowMock.uiButton.mock.calls as any[][];
    for (let i = calls.length - 1; i >= 0; i--) {
      const opts = calls[i][0] || {};
      if (opts.attrs && opts.attrs['data-anchor-view-md-source']) return opts.attrs['data-i18n'];
    }
    return null;
  };

  it('md + 阅读全文：给「查看源码」入口，正文默认已排版', async () => {
    const markdown = vi.fn((md: string) => `<h1>${md.replace(/^#\s*/, '')}</h1>`);
    const viewer = loadViewer({ markdown, text: '# 知识库落地计划' });

    await openDoc(viewer, 'notes/plan.md');

    expect(mdToggleKey(viewer)).toBe('kb.viewer.md_source');
    expect(viewer.elements['[data-anchor-view-text]'].dataset.md).toBe('rendered');
  });

  it('点「查看源码」→ 正文回原文、按钮翻成「看排版」；再点回排版', async () => {
    const markdown = vi.fn((md: string) => `<h1>${md}</h1>`);
    const viewer = loadViewer({ markdown, text: '# 知识库落地计划' });
    const pre = viewer.elements['[data-anchor-view-text]'];

    await openDoc(viewer, 'notes/plan.md');
    viewer.getMdSourceHandler()?.();

    // 源码形态：不再走管线（正文已在手上，直接按原文渲染），排版类名撤下、
    // 形态标记切成 source（等宽 + 保留空白，缩进与表格竖线才对得齐）
    expect(markdown).toHaveBeenCalledTimes(1);
    expect(pre.dataset.md).toBe('source');
    expect(pre.classList.contains('markdown-body')).toBe(false);
    expect(mdToggleKey(viewer)).toBe('kb.viewer.md_rendered');

    viewer.getMdSourceHandler()?.();

    expect(markdown).toHaveBeenCalledTimes(2);
    expect(pre.dataset.md).toBe('rendered');
    expect(mdToggleKey(viewer)).toBe('kb.viewer.md_source');
  });

  it('纯文本、片段视图、逐字稿 md 都不给这个入口（与排版判据同一条）', async () => {
    const plain = loadViewer({ markdown: (md) => `<p>${md}</p>`, text: '会议记录正文' });
    await openDoc(plain, 'notes/meeting.txt');
    expect(mdToggleKey(plain)).toBeNull();

    const fragment = loadViewer({ markdown: (md) => `<p>${md}</p>`, text: '# 标题' });
    await openDoc(fragment, 'notes/plan.md', null);
    expect(mdToggleKey(fragment)).toBeNull();

    const transcript = loadViewer({ markdown: (md) => `<p>${md}</p>`, text: TRANSCRIPT_TEXT });
    await openDoc(transcript, '1/会议录音.md');
    expect(mdToggleKey(transcript)).toBeNull();
  });

  it('markdown 管线缺席时不给入口（点开也变不出排版）', async () => {
    const viewer = loadViewer({ text: '# 标题' });

    await openDoc(viewer, 'notes/plan.md');

    expect(mdToggleKey(viewer)).toBeNull();
  });

  it('换一份文档后回到排版默认（源码模式不粘到下一份）', async () => {
    const markdown = vi.fn((md: string) => `<h1>${md}</h1>`);
    const viewer = loadViewer({ markdown, text: '# 标题' });

    await openDoc(viewer, 'notes/plan.md');
    viewer.getMdSourceHandler()?.();
    expect(viewer.elements['[data-anchor-view-text]'].dataset.md).toBe('source');

    await openDoc(viewer, 'notes/other.md');

    expect(viewer.elements['[data-anchor-view-text]'].dataset.md).toBe('rendered');
    expect(mdToggleKey(viewer)).toBe('kb.viewer.md_source');
  });
});

describe('排版后引用定位的清洗口径（纯函数）', () => {
  const utils = (viewer: any) => viewer.windowMock.__kbMdUtils;

  it('识别 markdown 扩展名（.md/.markdown，忽略大小写与目录）', () => {
    const u = utils(loadViewer());

    expect(u.isMarkdownPath('1/方案.md')).toBe(true);
    expect(u.isMarkdownPath('归档/A/B.MARKDOWN')).toBe(true);
    expect(u.isMarkdownPath('1/方案.txt')).toBe(false);
    expect(u.isMarkdownPath('1/表格.csv')).toBe(false);
    expect(u.isMarkdownPath('')).toBe(false);
  });

  it('cleanQuote 去掉行首 md 记号与行内强调符（与渲染后正文形态一致）', () => {
    const u = utils(loadViewer());

    expect(u.cleanQuote('## 标题\n- **要点**：`code`')).toBe('标题 要点：code');
    expect(u.cleanQuote('> 引用   行\n| 表 | 头 |')).toBe('引用 行 | 表 | 头 |');
  });

  it('tokens 去重、滤掉短词（块级兜底按重合词挑块）', () => {
    const u = utils(loadViewer());

    expect(u.tokens('知识库 检索改写 知识库 ab abc')).toEqual(['知识库', '检索改写', 'abc']);
  });

  it('单节点匹配不到时退到块级标记，仍然给出可见落点', () => {
    const u = utils(loadViewer());
    const added: string[] = [];
    const block = {
      textContent: '检索改写与词表：先做词表，再做检索改写。',
      classList: { add: (name: string) => added.push(name) },
      scrollIntoView: vi.fn(),
    };
    const host = { querySelectorAll: () => [block], childNodes: undefined };

    expect(u.highlight(host, '- **检索改写**：先做词表')).toBe(true);
    expect(added).toEqual(['anchored-source-mark-block']);
    expect(block.scrollIntoView).toHaveBeenCalled();
  });

  it('整篇都对不上时返回 false（调用方据此记 warn，不静默）', () => {
    const u = utils(loadViewer());
    const host = {
      querySelectorAll: () => [{ textContent: '完全无关的段落', classList: { add: () => {} } }],
    };

    expect(u.highlight(host, '这里有一段摘录')).toBe(false);
  });
});

/**
 * 真机事故（2026-09-21）：点「原文依据」后正文里高亮的是**半句多**——摘录 31 字，
 * 涂了 68 字，摘录末尾之后的正文跟着变色，用户以为"引的位置不对"。
 * 根因：标记长度用的是 `needle.length * 2 + 8` 估算值，而不是真实匹配长度。
 * 这里锁死"涂出来的就是摘录本身"。
 */
describe('原文依据高亮的落点口径（真机：高亮多涂半句）', () => {
  const utils = (viewer: any) => viewer.windowMock.__kbMdUtils;

  /** 用假文本节点跑真高亮分支，返回被 `<mark>` 包住的原文片段（涂错即暴露）。 */
  function highlightedText(viewer: any, raw: string, quote: string): string | null {
    let marked: string | null = null;
    const node: any = {
      nodeType: 3,
      nodeValue: raw,
      ownerDocument: {
        createRange: () => {
          const range: any = { start: 0, end: 0 };
          range.setStart = (_node: any, start: number) => { range.start = start; };
          range.setEnd = (_node: any, end: number) => { range.end = end; };
          range.surroundContents = () => { marked = raw.slice(range.start, range.end); };
          return range;
        },
      },
    };
    const host: any = { childNodes: [node], querySelectorAll: () => [] };

    utils(viewer).highlight(host, quote);
    return marked;
  }

  it('rawSpan 把归一化区间反算成原文区间（首尾空白跳过、空白连成一段只算一个位置）', () => {
    const u = utils(loadViewer());

    expect(u.rawSpan('   abc  def   ', 1, 4)).toEqual({ start: 4, end: 8 });
    // 摘录落在段首：下标 0 要落在第一个非空白字符上，不能从行首空白起涂
    expect(u.rawSpan('\n    前导空白后的正文', 0, 2)).toEqual({ start: 5, end: 7 });
  });

  it('31 字摘录只涂 31 字，不再向外多涂半句', () => {
    const viewer = loadViewer();
    const quote = '这段原文依据摘录一共三十一个字，用来验证高亮落点是否准确无误。';
    const raw = `${quote}后面还有一整句本不该变色。`;

    expect([...quote].length).toBe(31); // 夹具自检：与真机那 31 字摘录同量级
    const marked = highlightedText(viewer, raw, quote);

    expect(marked).toBe(quote);
    expect(marked).not.toContain('后面还有一整句');
  });

  it('段中摘录（前面有正文）也只涂摘录本身', () => {
    const viewer = loadViewer();
    const quote = '检索改写要先用词表兜住转写错词';
    const raw = `第三章 方案\n\n前置说明一句话。${quote}，再往下就是别的段落了。`;

    expect(highlightedText(viewer, raw, quote)).toBe(quote);
  });

  it('归一化后才匹配上时（多空白/换行）仍按归一化区间反算真实区间', () => {
    const viewer = loadViewer();
    const raw = '开头   中间    结尾';
    const marked = highlightedText(viewer, raw, '开头 中间    结尾');

    expect(marked).toBe(raw); // 摘录覆盖整段 → 涂的就是整段（含段内空白）
  });

  it('归一化后仍匹配不上时退到首个实词，只涂那个词（不猜长度）', () => {
    const viewer = loadViewer();
    const raw = '正文里出现了一处改写计划，其余内容不动。';

    expect(highlightedText(viewer, raw, '改写计划（第 2 版）')).toBe('改写计划');
  });
});
