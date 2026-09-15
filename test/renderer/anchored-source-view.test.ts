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
}

function loadViewer(opts: LoadOpts = {}) {
  let toggleHandler: (() => void) | null = null;
  let closeHandler: (() => void) | null = null;
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
    querySelector: vi.fn((selector: string) => selector === '[data-anchor-view-toggle]'
      ? { addEventListener: (_name: string, handler: () => void) => { toggleHandler = handler; } }
      : selector === 'mark'
        ? { scrollIntoView: vi.fn() }
        : null),
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
  const invoke = vi.fn(async (_channel: string, payload: any) => ({
    resolved: true,
    displayPath: payload.path,
    textStart: 0,
    text,
    charStart: 0,
    charEnd: Math.min(20, text.length),
    totalChars: text.length,
  }));
  const uiModal = vi.fn(() => modal);
  const uiButton = vi.fn(({ label }: { label: string }) => {
    buttonLabels.push(label);
    return `<span data-anchor-view-toggle>${label}</span>`;
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
  };
  const context: any = {
    window: windowMock,
    document: documentMock,
    globalThis: windowMock,
    module: { exports: {} },
    Promise,
    requestAnimationFrame: (callback: () => void) => callback(),
    createLogger: () => ({ warn: vi.fn() }),
  };
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
    resetLabels: () => { buttonLabels.length = 0; },
    labels: () => buttonLabels.slice(),
    getToggleHandler: () => toggleHandler,
    getCloseHandler: () => closeHandler,
  };
}

// 两段「说话人 + 时间」块头 = 逐字稿特征（纠错面板的服务对象）
const TRANSCRIPT_TEXT = [
  'Richard 2026-09-05 19:31:32',
  'Hello.',
  '张浩 2026-09-05 19:31:34',
  '哈喽哈喽能听到吗？',
].join('\n');

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

  it('closes the document reader from its corner close control', async () => {
    const viewer = loadViewer();
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
