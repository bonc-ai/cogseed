import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

/**
 * 引用 chip 点击的分派：排版类文件（pdf/office/html/图片）必须先交给 KB 富查看器
 * （`__openKbSourceDocument`）——否则 PDF/Word 引用点开只剩纯文本，#214 的老毛病
 * 会从引用入口再犯一次。纯文本与桥不可用时回落原文查看器。
 */
function loadCitation(sandboxWindow: Record<string, any>) {
  const listeners: Record<string, any> = {};
  const documentMock = {
    readyState: 'complete',
    addEventListener: vi.fn((name: string, fn: any) => { listeners[name] = fn; }),
    querySelectorAll: vi.fn(() => []),
    getElementById: vi.fn(() => null),
    createDocumentFragment: vi.fn(),
    createTextNode: vi.fn(),
    createElement: vi.fn(),
  };
  const context: any = {
    window: sandboxWindow,
    document: documentMock,
    Node: { ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    MutationObserver: class { observe() {} disconnect() {} },
    console,
  };
  context.window.document = documentMock;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/chat-citation.js'), context);
  return { click: listeners.click, context };
}

function chipEvent(scope: string, filePath: string, chunk: number) {
  const chip = {
    dataset: { citationScope: scope, citationPath: filePath, citationChunk: String(chunk) },
  };
  return { target: { closest: () => chip }, preventDefault: vi.fn() };
}

describe('引用 chip → 原文打开分派', () => {
  it('全局引用先走富查看器桥；桥接管后不再走文本查看器', async () => {
    const bridge = vi.fn(async () => true);
    const anchorViewer = vi.fn();
    const { click } = loadCitation({ __openKbSourceDocument: bridge, __openAnchorViewer: anchorViewer });

    click(chipEvent('global', 'report.pdf', 3));
    await new Promise((r) => setTimeout(r, 0));

    expect(bridge).toHaveBeenCalledWith({ source: 'library', scope: 'global', path: 'report.pdf', chunkIdx: 3 });
    expect(anchorViewer).not.toHaveBeenCalled();
  });

  it('桥判定不接管（文本类）时回落原文查看器', async () => {
    const bridge = vi.fn(async () => false);
    const anchorViewer = vi.fn();
    const { click } = loadCitation({ __openKbSourceDocument: bridge, __openAnchorViewer: anchorViewer });

    click(chipEvent('global', 'notes.md', 7));
    await new Promise((r) => setTimeout(r, 0));

    expect(bridge).toHaveBeenCalled();
    expect(anchorViewer).toHaveBeenCalledWith({ source: 'library', scope: 'global', path: 'notes.md', chunkIdx: 7 });
  });

  it('KB 模块还没懒加载（桥不存在）时直接回落，不报错', () => {
    const anchorViewer = vi.fn();
    const { click } = loadCitation({ __openAnchorViewer: anchorViewer });

    click(chipEvent('global', 'notes.md', 1));

    expect(anchorViewer).toHaveBeenCalledWith({ source: 'library', scope: 'global', path: 'notes.md', chunkIdx: 1 });
  });

  it('空间库引用（chip 不带 spaceId）不走桥，避免"缺少空间信息"空提示', () => {
    const bridge = vi.fn(async () => true);
    const anchorViewer = vi.fn();
    const { click } = loadCitation({ __openKbSourceDocument: bridge, __openAnchorViewer: anchorViewer });

    click(chipEvent('space', '空间库文档.pdf', 2));

    expect(bridge).not.toHaveBeenCalled();
    expect(anchorViewer).toHaveBeenCalledWith({ source: 'library', scope: 'space', path: '空间库文档.pdf', chunkIdx: 2 });
  });

  it('attachment 引用仍被跳过（需要 cid，chip 里没有）', () => {
    const bridge = vi.fn(async () => true);
    const anchorViewer = vi.fn();
    const { click } = loadCitation({ __openKbSourceDocument: bridge, __openAnchorViewer: anchorViewer });

    click(chipEvent('attachment', 'x.pdf', 1));

    expect(bridge).not.toHaveBeenCalled();
    expect(anchorViewer).not.toHaveBeenCalled();
  });
});
