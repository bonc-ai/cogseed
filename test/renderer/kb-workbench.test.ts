import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: (...names: string[]) => names.forEach((name) => values.add(name)),
    remove: (...names: string[]) => names.forEach((name) => values.delete(name)),
    contains: (name: string) => values.has(name),
    toggle: (name: string, force?: boolean) => {
      const shouldAdd = force == null ? !values.has(name) : force;
      if (shouldAdd) values.add(name);
      else values.delete(name);
      return shouldAdd;
    },
  };
}

function fakeEl(id: string) {
  const listeners: Record<string, any> = {};
  const el: any = {
    id,
    innerHTML: '',
    hidden: false,
    value: '',
    textContent: '',
    dataset: {},
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    classList: fakeClassList(),
    addEventListener: vi.fn((name: string, fn: any) => { listeners[name] = fn; }),
    appendChild: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    focus: vi.fn(),
    click: vi.fn(),
    remove: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    _listeners: listeners,
  };
  return el;
}

// createElement 返回的元素带一个子节点（模拟 querySelector 命中），
// 使问答流内部（ai.querySelector('.kb-qa-stream')）可写。
function fakeCreatedEl() {
  const el = fakeEl('');
  const child = fakeEl('__child__');
  el.querySelector = vi.fn(() => child);
  return { el, child };
}

const TREE = [
  {
    name: '班级建设资料', path: '班级建设资料', type: 'dir', children: [
      { name: '子目录', path: '班级建设资料/子目录', type: 'dir', children: [
        { name: '子文件.txt', path: '班级建设资料/子目录/子文件.txt', type: 'file', bytes: 10, mtime: 1 },
      ] },
      { name: 'a.pdf', path: '班级建设资料/a.pdf', type: 'file', bytes: 5, mtime: 1 },
      { name: 'b.xlsx', path: '班级建设资料/b.xlsx', type: 'file', bytes: 5, mtime: 1 },
    ],
  },
  {
    name: '挑战资料', path: '挑战资料', type: 'dir', children: [
      { name: 'c.docx', path: '挑战资料/c.docx', type: 'file', bytes: 3, mtime: 1 },
    ],
  },
];

const KB_FILES = [
  { path: '班级建设资料/a.pdf', status: 'ready', chunks: 2, kind: 'pdf' },
  { path: '班级建设资料/b.xlsx', status: 'processing', chunks: 0, kind: 'excel' },
  { path: '挑战资料/c.docx', status: 'ready', chunks: 1, kind: 'word' },
];

function loadScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
    'utf8',
  );
  const els: Record<string, any> = {};
  const created: any[] = [];
  const documentMock: any = {
    getElementById: vi.fn((id: string) => {
      if (!els[id]) els[id] = fakeEl(id);
      return els[id];
    }),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    body: {},
    createElement: vi.fn(() => {
      const made = fakeCreatedEl();
      created.push(made);
      return made.el;
    }),
  };
  const windowMock: any = {
    addEventListener: vi.fn(),
    uiToast: vi.fn(),
    uiPrompt: vi.fn(() => Promise.resolve(null)),
    cogseed: {
      invoke: vi.fn(async (ch: string) => {
        if (ch === 'contexts.tree') return { tree: TREE };
        if (ch === 'kb.status') return { files: KB_FILES };
        if (ch === 'contexts.mkdir') return { ok: true };
        if (ch === 'contexts.pickAndUpload') return { ok: true };
        if (ch === 'auth.listEntries') {
          return { ok: true, entries: [
            { provider: 'deepseek', model: 'deepseek-chat', modelName: 'DeepSeek Chat' },
            { provider: 'qwen', model: 'qwen-plus', modelName: 'Qwen Plus' },
          ] };
        }
        if (ch === 'spaces.list') {
          return { spaces: [{ space_id: 'sp1', name: '团队空间' }] };
        }
        if (ch === 'spaces.files.status') {
          return { files: [
            { name: '白皮书.pdf', path: '白皮书.pdf', kind: 'pdf', status: 'ready', chunks: 3, bytes: 5, mtime: 1 },
          ] };
        }
        if (ch === 'kb.summary') {
          return {
            docs: [
              { name: 'a.pdf', file: '班级建设资料/a.pdf', text: 'A 要点' },
              { name: 'b.xlsx', file: '班级建设资料/b.xlsx', text: 'B 要点' },
            ],
            oneLiner: '这个库围绕班级建设。',
            mindmap: { root: '班级建设', kids: ['真实项目征集', '执行手册'] },
            source: 'generated',
            fingerprint: 'fp1',
          };
        }
        return {};
      }),
      stream: vi.fn(() => ({ promise: Promise.resolve() })),
    },
  };
  const context: any = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    performance,
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (v: unknown) => String(v ?? ''),
    uiToast: windowMock.uiToast,
    uiPrompt: windowMock.uiPrompt,
    document: documentMock,
    window: windowMock,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'kb-workbench.js' });
  return { context, els, windowMock, created };
}

describe('KB workbench (S1 skeleton)', () => {
  it('renders the library tree from contexts.tree top-level dirs', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    await vi.waitFor(() => {
      expect(els['kb-wb-tree'].innerHTML).toContain('班级建设资料');
    });
    expect(els['kb-wb-tree'].innerHTML).toContain('挑战资料');
    expect(els['kb-wb-tree'].innerHTML).toContain('个人知识库');
    expect(els['kb-wb-tree'].innerHTML).toContain('共享知识库');
    expect(els['kb-wb-tree'].innerHTML).toContain('订阅知识库');
  });

  it('defaults to the first library and renders files with kb status chips', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    await vi.waitFor(() => {
      expect(els['kb-wb-files'].innerHTML).toContain('a.pdf');
    });
    // 默认选中第一个库（班级建设资料）
    expect(els['kb-wb-lib-name'].textContent).toBe('班级建设资料');
    // ready → ✓ 已索引；processing → 索引中…
    expect(els['kb-wb-files'].innerHTML).toContain('✓ 已索引');
    expect(els['kb-wb-files'].innerHTML).toContain('索引中…');
    // 子目录行（可下钻）
    expect(els['kb-wb-files'].innerHTML).toContain('子目录');
  });

  it('tree markup carries per-library selectors for switching', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    await vi.waitFor(() => {
      expect(els['kb-wb-tree'].innerHTML).toContain('data-kb-lib="挑战资料"');
    });
    expect(els['kb-wb-tree'].innerHTML).toContain('data-kb-lib="班级建设资料"');
  });

  it('renders the S2 QA pane and fills the model dropdown from real config', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    // 右区结构（解析卡 + 消息区）在初始 DOM 一次性构建，运行期不再重建
    expect(els['kb-workbench'].innerHTML).toContain('kb-qa-messages');
    expect(els['kb-workbench'].innerHTML).toContain('kb-wb-analysis-card');
    await vi.waitFor(() => {
      expect(els['kb-qa-model'].innerHTML).toContain('DeepSeek Chat');
    });
    expect(els['kb-qa-model'].innerHTML).toContain('Qwen Plus');
    expect(els['kb-qa-model'].innerHTML).not.toContain('未配置模型');
  });

  it('streams a grounded answer and renders citation chips on final', async () => {
    const { windowMock, els, created } = loadScript();
    windowMock.renderKbWorkbench();
    await vi.waitFor(() => {
      expect(els['kb-wb-files'].innerHTML).toContain('a.pdf');
    });
    // 触发发送：输入问题 → click send（监听器已注册）
    els['kb-qa-input'].value = 'alpha protocol?';
    els['kb-qa-send']._listeners.click();
    const streamMock = windowMock.cogseed.stream;
    expect(streamMock).toHaveBeenCalled();
    const calls = streamMock.mock.calls;
    const kbCall = calls.find((c: any[]) => c[0] === 'kbqa.askStream');
    expect(kbCall).toBeDefined();
    expect(kbCall[1].question).toBe('alpha protocol?');
    const cb = kbCall[2];
    cb({ type: 'delta', text: '基于 ' });
    // delta 不创建元素：此时最后一个 createElement 是 AI 气泡
    // （_ask 内顺序：hint → user 气泡 → AI 气泡）
    const ai = created[created.length - 1];
    const streamBody = ai.el.querySelector('.kb-qa-stream');
    cb({ type: 'final', text: '基于 引用回答。', evidence: [
      { source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 2, snippet: 's', score: 0.02 },
    ] });
    expect(streamBody.textContent).toBe('基于 引用回答。');
    // final 追加了引用 chips（appendChild 被调用）
    expect(streamBody.appendChild).toHaveBeenCalled();
    // typing 态已移除
    expect(ai.el.classList.contains('is-typing')).toBe(false);
  });

  it('renders the S3 analysis card (docs + one-liner + mindmap action)', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    // AI 解析为手动触发：点击「✨ 生成 AI 解析」按钮后才生成（等待 _loadAll 渲染后按钮出现）
    let btn;
    await vi.waitFor(() => {
      btn = els['kb-analyze-btn'];
      expect(btn).toBeTruthy();
    });
    btn._listeners.click();
    await vi.waitFor(() => {
      expect(els['kb-wb-analysis-card'].innerHTML).toContain('A 要点');
    });
    expect(els['kb-wb-analysis-card'].innerHTML).toContain('B 要点');
    expect(els['kb-wb-analysis-card'].innerHTML).toContain('这个库围绕班级建设。');
    expect(els['kb-wb-analysis-card'].innerHTML).toContain('data-kb-anchor="班级建设资料/a.pdf"');
    expect(els['kb-wb-analysis-card'].innerHTML).toContain('生成脑图');
    expect(els['kb-wb-analysis-card'].innerHTML).toContain('生成测验');
    // 引用 chip 点击 → anchored viewer 打开（window.__openAnchorViewer 不存在时 toast）
    expect(els['kb-wb-analysis-card'].innerHTML).not.toContain('正在解析');
  });

  it('renders shared knowledge bases (space library) in the tree', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    await vi.waitFor(() => {
      expect(els['kb-wb-tree'].innerHTML).toContain('团队空间');
    });
    expect(els['kb-wb-tree'].innerHTML).toContain('data-kb-space="sp1"');
    expect(els['kb-wb-tree'].innerHTML).toContain('共享');
    expect(els['kb-wb-tree'].innerHTML).not.toContain('空间库 · S4 上线');
  });
});
