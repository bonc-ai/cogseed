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
  const selectorNodes = new Map<string, { html: string; nodes: any[] }>();
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
    append: vi.fn(),
    appendChild: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn((selector: string) => {
      const attrMatch = /^\[data-([a-z-]+)\]$/.exec(selector);
      if (!attrMatch) return [];
      const cached = selectorNodes.get(selector);
      if (cached && cached.html === el.innerHTML) return cached.nodes;
      const attrName = attrMatch[1];
      const datasetKey = attrName.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      const pattern = new RegExp(`data-${attrName}="([^"]+)"`, 'g');
      const nodes = Array.from(String(el.innerHTML).matchAll(pattern)).map((match) => {
        const node = fakeEl('');
        node.dataset[datasetKey] = match[1];
        return node;
      });
      selectorNodes.set(selector, { html: el.innerHTML, nodes });
      return nodes;
    }),
    focus: vi.fn(),
    click: vi.fn(),
    remove: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    _listeners: listeners,
  };
  Object.defineProperty(el, 'firstElementChild', {
    get: () => {
      if (!String(el.innerHTML || '').trim()) return null;
      const child = fakeEl('');
      child.innerHTML = el.innerHTML;
      return child;
    },
  });
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
  {
    name: 'external', path: 'external', type: 'dir', children: [
      {
        name: 'feishu-wiki', path: 'external/feishu-wiki', type: 'dir', children: [
          { name: 'SM 的交接.md', path: 'external/feishu-wiki/SM 的交接.md', type: 'file', bytes: 10, mtime: 1 },
        ],
      },
    ],
  },
];

const KB_FILES = [
  { path: '班级建设资料/a.pdf', status: 'ready', chunks: 2, kind: 'pdf' },
  { path: '班级建设资料/b.xlsx', status: 'processing', chunks: 0, kind: 'excel' },
  { path: '挑战资料/c.docx', status: 'ready', chunks: 1, kind: 'word' },
  { path: 'external/feishu-wiki/SM 的交接.md', status: 'ready', chunks: 4, kind: 'word' },
];

function loadScript(options: { narrow?: boolean } = {}) {
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
    body: { appendChild: vi.fn(), append: vi.fn() },
    createElement: vi.fn(() => {
      const made = fakeCreatedEl();
      created.push(made);
      return made.el;
    }),
  };
  const windowMock: any = {
    addEventListener: vi.fn(),
    matchMedia: vi.fn(() => ({
      matches: Boolean(options.narrow),
      addEventListener: vi.fn(),
    })),
    t: vi.fn((key: string) => ({
      'kb.workbench.external_feishu': '飞书 Wiki',
      'kb.workbench.external_source': '外部来源',
      'kb.workbench.group_external': '外部来源',
      'kb.workbench.group_personal': '个人知识库',
      'kb.workbench.group_shared': '共享知识库',
    } as Record<string, string>)[key] || key),
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
            { entryId: 'e1', provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-chat', modelName: 'DeepSeek Chat', modelAvailable: true },
            { entryId: 'e2', provider: 'qwen', providerLabel: 'Qwen', model: 'qwen-plus', modelName: 'Qwen Plus', modelAvailable: true },
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
  it('opens file rows in the real source viewer instead of the S2 placeholder toast', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );

    expect(source).toMatch(/function _openFile[\s\S]*?__openAnchorViewer\(\{[\s\S]*?view: 'document'/);
    expect(source).not.toContain('原文查看器：S2 上线（anchor-resolver 已就绪）');
  });

  it('reconnects the KB event stream after a previous page stream has ended', async () => {
    const { windowMock } = loadScript();
    windowMock.renderKbWorkbench();
    await vi.waitFor(() => expect(windowMock.cogseed.stream).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    windowMock.renderKbWorkbench();

    await vi.waitFor(() => expect(windowMock.cogseed.stream).toHaveBeenCalledTimes(2));
  });

  it('renders the library tree from contexts.tree top-level dirs', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    await vi.waitFor(() => {
      expect(els['kb-wb-tree'].innerHTML).toContain('班级建设资料');
    });
    expect(els['kb-wb-tree'].innerHTML).toContain('挑战资料');
    expect(els['kb-wb-tree'].innerHTML).toContain('个人知识库');
    expect(els['kb-wb-tree'].innerHTML).toContain('共享知识库');
    expect(els['kb-wb-tree'].innerHTML).toContain('外部来源');
    expect(els['kb-wb-tree'].innerHTML).toContain('飞书 Wiki');
    expect(els['kb-wb-tree'].innerHTML).not.toContain('data-kb-lib="external"');
    expect(els['kb-wb-tree'].innerHTML).not.toContain('订阅知识库');
  });

  it('opens Feishu Wiki as a read-only top-level source and renders imported files', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    await vi.waitFor(() => {
      expect(els['kb-wb-tree'].innerHTML).toContain('data-kb-external-source="external/feishu-wiki"');
    });

    const [sourceRow] = els['kb-wb-tree'].querySelectorAll('[data-kb-external-source]');
    sourceRow._listeners.click();

    expect(els['kb-wb-files'].innerHTML).toContain('SM 的交接.md');
    expect(els['kb-wb-lib-name'].textContent).toBe('飞书 Wiki');
    expect(els['kb-wb-lib-tag'].textContent).toBe('外部来源');
    expect(els['kb-wb-owner-name'].textContent).toBe('飞书 Wiki');
    expect(els['kb-wb-share'].style.display).toBe('none');
    expect(els['kb-wb-more-btn'].style.display).toBe('none');
    expect(els['kb-wb-import'].style.display).toBe('none');
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

  it('renders the S2 QA pane with a model chip that opens the configured-model picker', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    // 右区结构（解析卡 + 消息区）在初始 DOM 一次性构建，运行期不再重建
    expect(els['kb-workbench'].innerHTML).toContain('kb-qa-messages');
    expect(els['kb-workbench'].innerHTML).toContain('kb-wb-analysis-card');
    // 模型选择：chip（默认模型）+ 点击拉取已配置模型（auth.listEntries）
    expect(els['kb-workbench'].innerHTML).toContain('kb-qa-model-chip');
    expect(els['kb-qa-model-name'].textContent).toBe('默认模型');
    els['kb-qa-tools']._listeners.click();
    await vi.waitFor(() => {
      expect(windowMock.cogseed.invoke).toHaveBeenCalledWith('auth.listEntries', {});
    });
    // 弹层构建：默认行 + 两个已配置模型 + 去设置入口（DOM 追加到 body）
    expect(windowMock.cogseed.invoke).toHaveBeenCalled();
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
    expect(streamBody.innerHTML).toContain('基于 引用回答。');
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

  it('collapses the side panel and reveals the floating expand handle (round trip)', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    const collapse = els['kb-wb-side-collapse'];
    const expand = els['kb-wb-side-expand'];
    expect(collapse).toBeTruthy();
    expect(expand).toBeTruthy();
    // 初始：收起按钮可见，展开把手隐藏
    expect(collapse.hidden).toBe(false);
    expect(expand.hidden).toBe(true);
    // 折叠 → 收起按钮隐藏、展开把手出现
    collapse._listeners.click();
    expect(collapse.hidden).toBe(true);
    expect(expand.hidden).toBe(false);
    // 点悬浮把手展开 → 恢复
    expand._listeners.click();
    expect(collapse.hidden).toBe(false);
    expect(expand.hidden).toBe(true);
    // 再折叠一次（往返稳定）
    collapse._listeners.click();
    expect(collapse.hidden).toBe(true);
    expect(expand.hidden).toBe(false);
  });

  it('collapses the AI panel at constrained width and restores it on demand', () => {
    const { windowMock, els } = loadScript({ narrow: true });
    windowMock.renderKbWorkbench();
    const expand = els['kb-wb-right-expand'];
    const collapse = els['kb-wb-right-collapse'];
    const panel = els['kb-wb-right-panel'];

    expect(expand.hidden).toBe(false);
    expect(collapse.hidden).toBe(true);
    expect(panel.setAttribute).toHaveBeenLastCalledWith('aria-hidden', 'true');

    expand._listeners.click();
    expect(expand.hidden).toBe(true);
    expect(collapse.hidden).toBe(false);
    expect(panel.setAttribute).toHaveBeenLastCalledWith('aria-hidden', 'false');

    collapse._listeners.click();
    expect(expand.hidden).toBe(false);
    expect(collapse.hidden).toBe(true);
    expect(expand.focus).toHaveBeenCalled();
  });

  it('uses the shared icon-button seam for the responsive AI panel controls', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const css = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/style.css'),
      'utf8',
    );

    expect(source).toContain("typeof window.uiIconButton === 'function'");
    expect(source).toContain("window.matchMedia('(max-width: 1100px)')");
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.kb-wb\.right-panel-open \.kb-wb-right/);
    expect(css).toContain('width: min(420px, calc(100% - 44px));');
  });

  it('routes every import-menu glyph through the shared icon registry', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );

    for (const icon of ['file', 'folder', 'book-open', 'link', 'file-text', 'document-pencil', 'upload', 'mic']) {
      expect(source).toContain(`_icon('${icon}', 'kb-wb-import-icon')`);
    }
    expect(source).not.toMatch(/data-imp="(?:file|dir|kblib|url|note|note-new|note-import|audio|folder)">[📄📁📚🔗🗒✏️📥🎙🗂]/u);
  });

  it('renders knowledge-base file row actions through shared icon buttons', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const fileRows = source.slice(
      source.indexOf('function _renderNodeRows('),
      source.indexOf('function _countFiles('),
    );

    expect(fileRows).toContain("_uiIconButton({ label: '生成思维导图（S3）', icon: 'sparkles', className: 'kb-mini-btn'");
    expect(fileRows).toContain("_uiIconButton({ label: '更多', icon: 'more-horizontal', className: 'kb-mini-btn'");
    expect(fileRows).toMatch(/_uiIconButton\(\{ label: open \? '折叠' : '展开', icon: open \? 'chevron-down' : 'chevron-right'/);
    expect(fileRows).not.toMatch(/<button\b/);
  });

  it('renders knowledge-base context menu actions through shared buttons and icons', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const menus = source.slice(
      source.indexOf('function _kbMenuShow('),
      source.indexOf('async function _kbRenameSpaceFile('),
    );

    expect(menus).toContain("role: it.danger ? 'danger' : 'ghost'");
    expect(menus).toContain("icon: 'edit-pencil'");
    expect(menus).toContain("icon: 'users'");
    expect(menus).toContain("icon: 'trash-2'");
    expect(menus).toContain("_uiButton({ label: '置顶', icon: 'pin'");
    expect(menus).toContain("_uiButton({ label: '编辑标签', icon: 'tag'");
    expect(menus).toContain("_icon('lock', 'kb-ctx-menu-icon')");
    expect(menus).not.toMatch(/[✏️🗑📂👥📌🏷🔐➡⧉▸✓]/u);
    expect(menus).not.toMatch(/<button\b/);
  });

  it('keeps the note submenu open when hover is followed by click', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );

    expect(source).toMatch(/noteToggle\.addEventListener\('click',[\s\S]*?importNoteSub\.hidden = false;/);
    expect(source).not.toMatch(/noteToggle\.addEventListener\('click',[\s\S]*?importNoteSub\.hidden = !importNoteSub\.hidden;/);
  });

  it('opens the note submenu toward the available left side', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const css = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/style.css'),
      'utf8',
    );

    expect(source).toContain("_icon('chevron-left', 'kb-import-caret-icon')");
    const submenuRule = css.match(/\.kb-wb-import-sub\s*\{([^}]*)\}/)?.[1] || '';
    expect(submenuRule).toContain('right: calc(100% - 4px);');
    expect(submenuRule).not.toContain('left: calc(100% - 4px);');
  });

  it('renders mindmap window actions through shared buttons and registered icons', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const mindmapMarkup = source.slice(
      source.indexOf('<div class="kb-mm-overlay"'),
      source.indexOf('// 右列强制 flex column'),
    );

    for (const id of [
      'kb-mm-mode-btn', 'kb-mm-popout-btn', 'kb-mm-overlay-close', 'kb-mm-undo',
      'kb-mm-refresh', 'kb-mm-save', 'kb-mm-open-btn', 'kb-mm-export-btn',
      'kb-mm-layout-btn', 'kb-mm-expand-all', 'kb-mm-collapse-all', 'kb-mm-focus-btn',
      'kb-mm-outline-btn', 'kb-mm-bg-btn', 'kb-mm-dots-btn', 'kb-mm-zoom-out',
      'kb-mm-zoom-in', 'kb-mm-reset', 'kb-mm-more-btn',
    ]) {
      expect(mindmapMarkup).toMatch(new RegExp(`_ui(?:Icon)?Button\\(\\{[\\s\\S]*?id: '${id}'`));
    }
    expect(mindmapMarkup).not.toMatch(/<button\b/);
    expect(mindmapMarkup).not.toMatch(/[🧠👁💾📂📥🖼📐📄📝📋🏢⤢⤡◎☰▦▤＋⋯✕↩⟳]/u);
    expect(source).toContain("_setUiButtonPresentation(btn, _mmPreviewMode ? '编辑' : '预览'");
  });

  it('renders analysis disclosure, citations, and retry through shared buttons', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const analysis = source.slice(
      source.indexOf('function _renderAnalysis('),
      source.indexOf('function _mmSnapshotKey('),
    );

    expect(analysis).toContain("_uiButton({ label: '展开', role: 'ghost', size: 'sm', iconEnd: 'chevron-down'");
    expect(analysis).toContain("_uiButton({ label: `${d.file}#chunk 1`, role: 'ghost', size: 'sm', className: 'kb-qa-chip'");
    expect(analysis).toContain("_setUiButtonPresentation(btn, open ? '收起' : '展开', open ? 'chevron-up' : 'chevron-down')");
    expect(analysis).toContain("_uiButton({ label: '重新生成', role: 'secondary', size: 'sm', icon: 'refresh'");
    expect(analysis).not.toMatch(/<button\b/);
    expect(analysis).not.toMatch(/[▾▴↗🔄]/u);
  });

  it('renders QA actions and removable items through shared buttons', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const qaMarkup = source.slice(
      source.indexOf('<div class="kb-qa-session">'),
      source.indexOf('<div class="kb-mm-overlay"'),
    );
    const attachments = source.slice(
      source.indexOf('function _renderQaAttachments()'),
      source.indexOf('function _clearQa()'),
    );
    const historyPanel = source.slice(
      source.indexOf('function _qaOpenHistory()'),
      source.indexOf('function _qaFmtTime('),
    );
    const askMarkup = source.slice(
      source.indexOf('function _ask(question)'),
      source.indexOf('function _streamAnswer('),
    );

    for (const id of ['kb-qa-popout', 'kb-qa-history', 'kb-qa-clear', 'kb-qa-attach', 'kb-qa-send']) {
      expect(qaMarkup).toMatch(new RegExp(`_uiIconButton\\(\\{[\\s\\S]*?id: '${id}'`));
    }
    expect((qaMarkup.match(/<button\b/g) || [])).toHaveLength(1);
    expect(qaMarkup).toContain('class="kb-qa-model-chip"');
    expect(attachments).toContain("_uiIconButton({ label: '移除附件', icon: 'x', variant: 'danger'");
    expect(historyPanel).toContain("_uiButton({ label: '新建对话'");
    expect(historyPanel).toContain("_uiIconButton({ label: '删除会话', icon: 'trash-2', variant: 'danger'");
    expect(askMarkup).toContain("_uiIconButton({ label: '更多', icon: 'more-horizontal', className: 'kb-qa-more-btn'");
    expect(askMarkup).toContain("_uiButton({ label: '重命名', icon: 'edit-pencil', role: 'ghost'");
    expect(askMarkup).toContain("_uiButton({ label: '删除', icon: 'trash-2', role: 'danger'");
    expect(`${attachments}\n${historyPanel}`).not.toMatch(/[✕🗑＋]/u);
    expect(historyPanel).toMatch(/onHistoryKeydown[\s\S]*?event\.key !== 'Escape'/);
    expect(historyPanel).toMatch(/closePanel\(restoreFocus = true\)[\s\S]*?trigger\?\.focus\(\)/);
    expect(source).toMatch(/event\.key !== 'Escape' \|\| !rightPanelNarrow[\s\S]*?getElementById\('kb-qa-history-panel'\)/);
  });

  it('renders QA sources, answer actions, and model dialog through shared UI seams', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const answerActions = source.slice(
      source.indexOf('function _qaRefsElement('),
      source.indexOf('function _decorateAnswerHtml('),
    );
    const modelPicker = source.slice(
      source.indexOf('function _openQaModelPicker('),
      source.indexOf('function _selectQaModel('),
    );

    expect(answerActions).toContain("_uiButton({\n      label: `资料来源 · ${n}`");
    expect(answerActions).toContain("_uiButton({\n        label: `${r.path}#chunk ${r.chunkIdx}`");
    expect(answerActions).toContain("_uiIconButton({\n        label: '复制引用路径',\n        icon: 'copy'");
    expect(answerActions).toContain("icon: 'brain-circuit',\n      className: 'kb-qa-mm-btn'");
    expect(answerActions).not.toMatch(/document\.createElement\('button'\)/);
    expect(answerActions).not.toMatch(/[🧠⧉▴▾]/u);

    expect(modelPicker).toContain("_uiIconButton({\n      label: '关闭模型选择弹窗',\n      icon: 'x'");
    expect(modelPicker).toContain("_uiButton({\n      label: '去设置管理模型',\n      role: 'secondary'");
    expect(modelPicker).toContain("_mountKbDialog({");
    expect(modelPicker).toContain("initialFocus: '[aria-pressed=\"true\"]'");
    expect(modelPicker).toContain("fallbackFocus: '#kb-qa-tools'");
    expect(modelPicker).toContain("pop.setAttribute('aria-modal', 'true')");
    expect((modelPicker.match(/el\('button'/g) || [])).toHaveLength(2);
    expect(modelPicker).not.toMatch(/[✕✓]/u);
  });

  it('keeps the QA history panel above the responsive AI drawer', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/style.css'),
      'utf8',
    );
    const historyRule = css.match(/\.kb-qa-history-panel\s*\{([^}]*)\}/)?.[1] || '';
    expect(historyRule).toContain('z-index: var(--z-modal-popover);');
  });

  it('renders the library import dialog with shared controls and recoverable loading state', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const importDialog = source.slice(
      source.indexOf('async function _importSpaceFromLib()'),
      source.indexOf('async function _kbNewFolder()'),
    );
    const importBinding = source.slice(
      source.indexOf('function _bindImportDlgEvents('),
      source.indexOf('function _pushImportDlgHistory('),
    );

    expect(importDialog).toContain('role="dialog" aria-modal="true" aria-labelledby="kb-import-dlg-title"');
    expect(importDialog).toContain("_uiIconButton({ label: '关闭导入弹窗', icon: 'x'");
    expect(importDialog).toContain("_uiIconButton({ label: '返回', icon: 'chevron-left'");
    expect(importDialog).toContain("_uiInput({ id: 'kb-import-dlg-search-input', type: 'search'");
    expect(importDialog).toContain("_uiButton({ label: '取消', role: 'secondary'");
    expect(importDialog).toContain("_uiButton({ label: '导入', role: 'primary'");
    expect(importDialog).not.toMatch(/<button\b/);
    expect(importDialog).not.toMatch(/<input\b/);
    expect(importDialog).not.toMatch(/[✕←→]/u);
    expect(importBinding).toMatch(/onImportDialogKeydown[\s\S]*?event\.key !== 'Escape'/);
    expect(importBinding).toMatch(/finally \{[\s\S]*?classList\.remove\('is-loading'\)[\s\S]*?okBtn\.disabled = _dlgSelected\.size === 0/);
    expect(source).toMatch(/getElementById\('kb-qa-history-panel'\) \|\| document\.querySelector\('\.kb-import-dlg-overlay'\)/);
  });

  it('adopts shared controls and modal behavior for knowledge-base sharing dialogs', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'),
      'utf8',
    );
    const createDialog = source.slice(
      source.indexOf('function _createSharedSpace()'),
      source.indexOf('async function _kbShareSubmit()'),
    );
    const membersDialog = source.slice(
      source.indexOf('function _kbMembersDialog()'),
      source.indexOf('// ── 共享知识库分享弹窗'),
    );
    const shareDialogs = source.slice(
      source.indexOf('function _kbShareDialogOpen()'),
      source.indexOf('async function _kbRenameSpace('),
    );

    expect(source).toMatch(/function _mountKbDialog[\s\S]*?uiModalController\(\{ overlay, dialog, initialFocus, fallbackFocus/);
    expect(createDialog).toContain('role="dialog" aria-modal="true" aria-labelledby="kb-share-dlg-title"');
    expect(createDialog).toContain("_uiIconButton({ label: '关闭创建共享知识库弹窗', icon: 'x'");
    expect(createDialog).toContain("_uiIconButton({ label: '上传或更换知识库封面', icon: 'edit-pencil'");
    expect(createDialog).toContain("_uiInput({ id: 'kb-share-name', className: 'kb-share-input'");
    expect(createDialog).toContain("_uiTextarea({ id: 'kb-share-desc', className: 'kb-share-input'");
    expect(createDialog).toContain("_uiTextarea({ id: 'kb-share-questions', className: 'kb-share-input'");
    expect(createDialog).toContain("_uiButton({ label: '取消', role: 'secondary'");
    expect(createDialog).toContain("_uiButton({ label: '确定', role: 'primary'");
    expect(createDialog).not.toMatch(/[✕📁✎▾✓]/u);
    expect(membersDialog).toContain('role="dialog" aria-modal="true" aria-labelledby="kb-members-title"');
    expect(membersDialog).toContain("_uiIconButton({ label: '关闭知识库成员弹窗', icon: 'x'");
    expect(membersDialog).toContain("_uiInput({ id: 'kb-members-search-input', type: 'search'");
    expect(membersDialog).toContain("_icon('users', 'kb-members-title-icon')");
    expect(membersDialog).not.toMatch(/[✕👥]/u);
    expect(shareDialogs).toContain("_uiButton({ label: '复制链接', role: 'secondary', icon: 'link'");
    expect(shareDialogs).toContain("_uiButton({ label: '生成知识码', role: 'secondary', icon: 'qr-code'");
    expect(shareDialogs).toContain("_uiButton({ label: '确定', role: 'primary', className: 'kb-share-pop-btn'");
    expect(shareDialogs).toContain("_uiIconButton({ label: '关闭 CogSeed 共享服务配置弹窗', icon: 'x'");
    expect(shareDialogs).toContain("_uiIconButton({ label: '关闭飞书分享配置弹窗', icon: 'x'");
    expect(shareDialogs).toContain("_uiInput({ id: 'kb-cogseed-baseurl', className: 'kb-share-config-input'");
    expect(shareDialogs).toContain("_uiInput({ id: 'kb-cogseed-apikey', type: 'password', className: 'kb-share-config-input'");
    expect(shareDialogs).toContain("_uiInput({ id: 'kb-share-config-appid', className: 'kb-share-config-input'");
    expect(shareDialogs).toContain("_uiInput({ id: 'kb-share-config-secret', type: 'password', className: 'kb-share-config-input'");
    expect(shareDialogs).toContain("_uiIconButton({ label: '关闭知识码弹窗', icon: 'x'");
    expect(shareDialogs).toContain("_uiIconButton({ label: '关闭分享管理弹窗', icon: 'x'");
    expect(shareDialogs).toContain("_uiButton({ label: '保存并发布', role: 'primary'");
    expect(shareDialogs).toContain("_uiButton({ label: '保存并授权', role: 'primary'");
    expect(shareDialogs).toContain("_uiButton({ label: '撤销', role: 'danger', size: 'sm'");
    expect(shareDialogs).toMatch(/_kbShareDlgClose\(\{ restoreFocus: false \}\)[\s\S]*?_kbPermDialogOpen\(\)/);
    expect(shareDialogs).toMatch(/_kbShareDlgController\.close\('close', options\)/);
    expect(shareDialogs).not.toMatch(/[✕›]/u);
    expect(source).toContain("_uiInput({ id: 'kb-wb-side-search-input', type: 'search'");
    expect(source).toContain("_uiInput({ id: 'kb-wb-search-input', type: 'search'");
    expect(source).toContain("_uiInput({ id: 'kb-mm-search', type: 'search', className: 'kb-mm-search'");
  });

  it('search finds files inside unexpanded folders (recursive)', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    // 等待初始渲染（默认库：班级建设资料，含子目录/子文件.txt 未展开）
    await vi.waitFor(() => {
      expect(els['kb-wb-files'].innerHTML).toContain('a.pdf');
    });
    // 搜索「子文件」：文件夹未展开，也应命中深层文件
    const input = els['kb-wb-search-input'];
    input.value = '子文件';
    input._listeners.input({ target: input });
    expect(els['kb-wb-files'].innerHTML).toContain('子文件.txt');
    expect(els['kb-wb-files'].innerHTML).toContain('📁 子目录');
    // 搜索根目录文件：meta 显示「库根」
    input.value = 'a.pdf';
    input._listeners.input({ target: input });
    expect(els['kb-wb-files'].innerHTML).toContain('a.pdf');
    expect(els['kb-wb-files'].innerHTML).toContain('库根');
    // 无匹配时显示「无匹配文档」而非空库引导
    input.value = '不存在的关键词xyz';
    input._listeners.input({ target: input });
    expect(els['kb-wb-files'].innerHTML).toContain('无匹配文档');
    expect(els['kb-wb-files'].innerHTML).not.toContain('＋ 添加内容');
  });
});

describe('kb file-viewer highlight pure helpers', () => {
  it('strips ordered-list numbers and inline bold (regression: AAR复盘 chunk7)', () => {
    const { windowMock } = loadScript();
    const u = windowMock.__kbFvUtils;
    expect(u.cleanQuote('1. 先**选定并本地试跑**一个 skills 目录')).toBe('先选定并本地试跑一个 skills 目录');
  });

  it('strips heading/quote/bullet prefixes but keeps table rows', () => {
    const { windowMock } = loadScript();
    const u = windowMock.__kbFvUtils;
    expect(u.stripMdMarks('> 引用要点')).toBe('引用要点');
    expect(u.stripMdMarks('- 提交证据')).toBe('提交证据');
    expect(u.stripMdMarks('## 卡点与突破')).toBe('卡点与突破');
    expect(u.stripMdMarks('| A | B |')).toBe('| A | B |');
  });

  it('collapses whitespace via normSpace', () => {
    const { windowMock } = loadScript();
    expect(windowMock.__kbFvUtils.normSpace('  先 选定\n 并 ')).toBe('先 选定 并');
  });

  it('extracts significant tokens for block-level matching', () => {
    const { windowMock } = loadScript();
    const tokens = windowMock.__kbFvUtils.significantTokens('先选定并本地试跑一个 skills 目录');
    expect(tokens).toContain('skills');
    expect(tokens.length).toBeGreaterThan(0);
  });
});

describe('查看器窗口：缩放与调整大小（真机反馈回归）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8');
  const css = src.slice(src.indexOf('function _injectFileViewerStyle'));

  it('对话框自带定位上下文 —— 否则右下角手柄会跑到屏幕角落上', () => {
    // 手柄是 position:absolute；对话框 position:static 时它相对 overlay(fixed) 定位，
    // 实测手柄落在视口右下角、窗口自己那个角上什么都没有 → "能移动但不能调整大小"
    const dialogRule = css.match(/\.kb-fv-dialog \{[\s\S]*?\n {6}\}/);
    expect(dialogRule).toBeTruthy();
    expect(dialogRule![0]).toContain('position: relative');
    expect(css).toMatch(/\.kb-fv-resize \{[\s\S]{0,200}position: absolute/);
  });

  it('嵌入 iframe 的模式打开时给足高度（不再是 280px 的矮缝）', () => {
    expect(css).toMatch(/\.kb-fv-dialog--frame \{ height: min\(86vh, 780px\); \}/);
    // 进入/退出嵌入模式时两个 class 同步（少一个就会留下错误高度）
    expect(src).toMatch(/function _fvEnterFrameMode\(overlay, body\) \{[\s\S]{0,300}kb-fv-body--frame[\s\S]{0,200}kb-fv-dialog--frame/);
    expect(src).toMatch(/classList\.remove\('kb-fv-dialog--frame'\)/);
  });

  it('PDF 缩放靠真的重新加载（只改 hash 等于没缩放）', () => {
    // 真机实测：只改 iframe.src 的 hash，PDFium 不重新排版（100%/120% 像素完全相同），
    // 必须换成带新 zoom 的新 frame 才会重新加载
    expect(src).toMatch(/function _fvApplyPdfZoom[\s\S]{0,700}cloneNode\(false\)[\s\S]{0,200}replaceWith\(frame\)/);
    expect(src).toMatch(/cur\.lastZoom === pct/);
    const { windowMock } = loadScript();
    const u = windowMock.__kbFvUtils;
    expect(u.pdfSrcAt({ src: 'kb-file://kb/a.pdf', page: 3 }, 120))
      .toBe('kb-file://kb/a.pdf#toolbar=1&navpanes=0&page=3&zoom=120');
    expect(u.pdfSrcAt({ src: 'kb-file://space/s1/b.pdf', page: null }, 80))
      .toBe('kb-file://space/s1/b.pdf#toolbar=1&navpanes=0&zoom=80');
  });

  it('拖手柄松手落在窗口外时，不会顺手把窗口关掉', () => {
    // 缩放到 200% 后拖下手柄，指针常落在遮罩上；松手那次 click 的 target 就成了遮罩
    expect(src).toMatch(/pressedOnOverlay/);
    expect(src).toMatch(/mousedown'[\s\S]{0,120}pressedOnOverlay = e\.target === overlay/);
    expect(src).toMatch(/if \(e\.target === overlay && pressedOnOverlay\) overlay\.hidden = true/);
  });

  it('拖拽期间盖事件罩 —— 否则指针划到内嵌 iframe 上就丢 mousemove', () => {
    // 真机实测：PDF 插件是独立进程，指针越到它上面后主窗口收不到 mousemove，
    // 结果是"往右下拉能变大、往左上拉没反应"（只能变大不能缩小/移动）
    expect(src).toMatch(/\.kb-fv-drag-shield \{ position: absolute; inset: 0; z-index: 40; \}/);
    expect(src).toMatch(/function _fvBeginDragShield[\s\S]{0,300}kb-fv-drag-shield/);
    // 调整大小与拖动标题栏两条拖拽都要挂罩子，并在 mouseup 收掉
    expect(src.match(/_fvBeginDragShield\(fvOverlay\)/g)?.length).toBe(2);
    expect(src.match(/_fvEndDragShield\(fvOverlay\)/g)?.length).toBe(2);
  });

  it('恢复上次窗口位置时按已算好的宽高夹取（量 offset 在 display:none 下全是 0）', () => {
    const fn = src.match(/function _fvApplyWindowRect\(dialog\) \{[\s\S]*?\n {2}\}/);
    expect(fn).toBeTruthy();
    expect(fn![0]).not.toMatch(/dialog\.offsetWidth/);
    expect(fn![0]).toMatch(/Math\.min\(x, vw - w\)/);
    // 先显示再恢复：overlay 关着时量不到真实尺寸
    expect(src).toMatch(/overlay\.hidden = false;\n {4}if \(dialog\) _fvApplyWindowRect\(dialog\);/);
  });
});

describe('文件查看：按类型分派（#214 回归防护）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8');

  it('保留富查看器（保排版/缩放）：PDF 走 PDFium iframe，Office 走排版 HTML', () => {
    // 主进程 kb.openFile 的契约 + kb-file:// 协议仍在；渲染层必须有对应实现
    expect(src).toContain('kb-file://kb/');
    expect(src).toContain('kb-file://space/');
    expect(src).toContain("toolbar=1&navpanes=0");
    expect(src).toMatch(/kind === 'pdf'/);
    expect(src).toMatch(/kind === 'office'/);
    expect(src).toContain('_fvSetZoom');
    expect(src).toContain('_fvResetZoom');
  });

  it('渲染型文件（html/图片/音视频）也走富查看器，不再退化成纯文本', () => {
    expect(src).toContain("kind === 'html' || c.kind === 'image' || c.kind === 'media'");
    expect(src).toContain('kb-fv-frame--html');
    expect(src).toContain("createElement(c.audio ? 'audio' : 'video')");
    // html 默认渲染页面，同时保留"查看源码"
    expect(src).toContain('kb-fv-source');
    expect(src).toContain('_fvToggleHtmlSource');
  });

  it('暴露 __kbWorkbenchOpenFile 供回归与自动化验证（分派本身就是被测行为）', () => {
    expect(src).toContain('window.__kbWorkbenchOpenFile');
  });

  it('点击文件按扩展名分派：排版类 → 富查看器；纯文本 → 原文查看器', () => {
    expect(src).toContain('function _isRichPreview');
    expect(src).toContain('_FV_RICH_EXTS');
    expect(src).toMatch(/if \(_isRichPreview\(relPath\)\) \{[\s\S]{0,400}?_openFileViewer\(/);
    expect(src).toMatch(/if \(typeof window\.__openAnchorViewer === 'function'\) \{[\s\S]{0,300}?__openAnchorViewer\(\{/);
    // .html 不再被当作文本类打开（否则 70 份 html 只看到源码）
    expect(src).toContain("'.html', '.htm',");
  });

  it('引用锚点：排版类带页码定位到富查看器，文本类仍走原文查看器', () => {
    expect(src).toMatch(/_openFileViewerForAnchor[\s\S]{0,900}?_isRichPreview\(anchor\.path\)/);
    // 页码定位与富查看器开在同一个函数里（_openRichForAnchor）
    expect(src).toMatch(/_openRichForAnchor[\s\S]{0,1800}?page/);
    expect(src).toMatch(/_openRichForAnchor[\s\S]{0,2200}?_openFileViewer\(/);
  });

  it('对外桥 __openKbRichFile：阅读器只问一次"这文件该不该保排版"', () => {
    // 常驻加载的 anchored-source-view 在把排版类文件丢进纯文本阅读器前会调它；
    // 桥必须：只接排版类、返回"是否接管"、且复用同一条 _openRichForAnchor。
    expect(src).toContain('window.__openKbRichFile');
    expect(src).toMatch(/__openKbRichFile[\s\S]{0,400}?_isRichPreview\(anchor\.path\)[\s\S]{0,200}?_openRichForAnchor/);
    // 扩展名清单只有一份来源（anchored-source-view 暴露），避免两处漂移
    expect(src).toContain('window.__kbRichPreviewExts');
    expect(src).toContain('window.__kbIsRichPath');
  });

  it('HTML 用渲染 iframe（sandbox 只给 allow-scripts，与 chat-file-viewer 一致）', () => {
    // 跨 origin 才能挡住父页访问；脚本保留是为了交互型 HTML 能跑
    expect(src).toMatch(/kb-fv-frame--html';\n\s*frame\.setAttribute\('sandbox', 'allow-scripts'\)/);
  });

  it('查看源码走主进程 kb.openFile(asText)，不依赖 fetch(kb-file://)', () => {
    // 非 http 方案没有 CORS 头，渲染进程 fetch 会 Failed to fetch（实测）
    expect(src).toMatch(/asText: true/);
    expect(src).not.toMatch(/fetch\(content\.src\)/);
  });

  it('工具栏提供"在系统中打开"（只读预览之外的编辑/批注出口）', () => {
    expect(src).toContain('kb-fv-external');
    expect(src).toContain("invoke('kb.openExternal'");
    // 参数由纯函数给（载荷可测），无当前文件时按钮隐藏、点了也不发请求
    expect(src).toMatch(/externalBtn\.addEventListener\('click', \(\) => \{\n\s*const payload = _fvExternalTarget\(\);/);
    expect(src).toContain('externalTarget: _fvExternalTarget');
    // 无当前文件上下文时必须隐藏，避免点了没反应
    expect(src).toMatch(/_fvCtx[\s\S]{0,400}?extBtn\.hidden/);
  });
});
