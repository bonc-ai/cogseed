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

// 生成脑图（kb.mindmap）返回的最小层级树：够触发弹窗预览与画布渲染
const MINDMAP_ROOT = {
  label: '班级建设',
  children: [
    { label: '分支一', children: [{ label: '子项 A' }, { label: '子项 B' }] },
    { label: '分支二', children: [{ label: '子项 C' }] },
  ],
};

function loadScript(options: { narrow?: boolean; width?: number; height?: number; storage?: Record<string, string>; mindmapRoot?: unknown } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
  const els: Record<string, any> = {};
  const created: any[] = [];
  // localStorage：窗口尺寸/位置记忆的真实读写路径（此前 VM 里没有 localStorage，
  // try/catch 一律静默降级，测不到"记忆被污染"这类回归）
  const store = new Map<string, string>(Object.entries(options.storage || {}));
  const localStorageMock = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  };
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
    innerWidth: options.width ?? 1440,
    innerHeight: options.height ?? 900,
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
        if (ch === 'kb.mindmap') {
          return { root: options.mindmapRoot || MINDMAP_ROOT };
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
    localStorage: localStorageMock,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'kb-workbench.js' });
  return { context, els, windowMock, created, localStorage: localStorageMock };
}

describe('KB workbench (S1 skeleton)', () => {
  it('opens file rows in the real source viewer instead of the S2 placeholder toast', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');

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

  it('生成脑图 / 生成测验不依赖 AI 解析：首屏（未解析）就可用', () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    // 首屏的按钮必须当场绑上 listener：只把 disabled 拿掉的话点了没反应
    expect(els['kb-wb-analysis-card']).toBeTruthy();
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/_refreshQaModelChipLabel\(\);[\s\S]{0,400}_bindAnalysisActions\(analysisCard\)/);
    const html = els['kb-workbench'].innerHTML;
    const mmIdx = html.indexOf('id="kb-wb-gen-mm"');
    const quizIdx = html.indexOf('id="kb-wb-gen-quiz"');
    expect(mmIdx).toBeGreaterThan(0);
    expect(quizIdx).toBeGreaterThan(0);
    // 两个按钮的标记里没有 disabled，也没有"请先生成 AI 解析"这个禁用理由
    expect(html.slice(mmIdx - 400, mmIdx)).not.toContain('disabled');
    expect(html.slice(quizIdx - 400, quizIdx)).not.toContain('disabled');
    expect(html).not.toContain('请先生成 AI 解析');
  });

  it('两个入口的可用性只看"库是否为空"，并把解析裁掉的门槛去掉', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('function _bindAnalysisActions');
    expect(src).toMatch(/_bindAnalysisActions[\s\S]{0,600}_libFileCount\(\) === 0/);
    // 解析结果不再决定按钮可用性（此前 disabled: !(ok && hasMm) / disabled: !ok）
    expect(src).not.toMatch(/disabled: !\(ok && hasMm\)/);
    expect(src).toContain('function _bindAnalysisActions');
    expect(src).not.toContain('请先生成 AI 解析');
  });

  it('生成测验有真实实现：调 kb.quiz、渲染缩略卡并打开答题面板', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    // 这个入口此前只有调用点、没有实现（点击直接 ReferenceError）
    expect(src).not.toMatch(/_renderQuiz\b/);
    expect(src).toContain('function _genQuiz()');
    expect(src).toContain("invoke('kb.quiz'");
    // 答题/结果工作面移到 window.KbQuizPanel（逐题作答、提示、结果页、再测/新测），
    // 会话流里只留一张缩略卡（入口 + 事实），生成完直接进入答题
    expect(src).toContain('function _quizLauncherHtml(payload)');
    expect(src).toMatch(/function _bindQuizLauncher[\s\S]{0,400}_openQuizPanel/);
    expect(src).toMatch(/function _openQuizPanel[\s\S]{0,400}panel\.open\(/);
    expect(src).toMatch(/_bindQuizLauncher\(nb, entry\);[\s\S]{0,200}_openQuizPanel\(entry\)/);
    // 会话恢复：quiz 消息按存下来的题目重建缩略卡
    expect(src).toMatch(/m\.kind === 'quiz'[\s\S]{0,200}_appendQuizMessage/);
    expect(src).toMatch(/kind: 'quiz', \.\.\.payload/);
  });

  it('测验进会话历史：写入 + 持久化 + 载入不被丢', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    // ① 生成后 push 进 qaHistory 并立刻保存会话（此前只 push → 切库/重开就没了）
    expect(src).toMatch(/kind: 'quiz', \.\.\.payload[\s\S]{0,300}_qaSaveCurrentSession\('测验'\)/);
    expect(src).toMatch(/const entry = \{ role: 'assistant', kind: 'quiz', \.\.\.payload, ts: Date\.now\(\) \};[\s\S]{0,200}_state\.qaHistory\.push\(entry\)/);
    // ② 载入会话时保留 quiz 消息与题目（此前非脑图消息一律被重建成 {role,content}）
    expect(src).toMatch(/m\.kind === 'quiz'[\s\S]{0,300}questions/);
    expect(src).toMatch(/Array\.isArray\(m\.questions\) \? m\.questions\.slice\(0, 20\)/);
    // 来源与指纹一并存下来：面板的"查看 N 个来源"与「生成后续测验」的缓存键都靠它
    expect(src).toMatch(/function _appendQuizMessage[\s\S]{0,400}m\.sources/);
    // ③ 产物消息没有 content，不进模型多轮上下文
    expect(src).toMatch(/filter\(\(m\) => m\.kind !== 'mindmap' && m\.kind !== 'quiz'\)/);
  });

  it('参考答案/解析分块显示，多要点自动列点（纯函数仍由 __kbFvUtils 暴露给测验面板）', () => {
    const { windowMock } = loadScript();
    const clauses = windowMock.__kbFvUtils.quizAnswerClauses;
    // 真机反馈里的原句：一个分号隔开的两个要点 → 拆成两条，而不是糊成一整段
    const two = clauses('匹配角色只需要一个API Key；发版清理时应以CSV文件为准（提示词内是速览，以CSV为准）。');
    expect(two).toHaveLength(2);
    expect(two[0]).toBe('匹配角色只需要一个API Key'); // 列表项不带分隔符
    expect(two[1]).toContain('发版清理时应以CSV文件为准');
    // 单句不拆（不把一句话切碎）
    expect(clauses('一句话参考答案。')).toEqual(['一句话参考答案。']);
    // 编号式要点也认
    expect(clauses('1. 先纠错 2. 再检索')).toEqual(['先纠错', '再检索']);
    expect(clauses('')).toEqual([]);
    // 渲染层：答案与解析各占一块（标签 + 文本/列表），不再用 ' · ' 拼句子
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    // 纯函数留在 kb-workbench（__kbFvUtils 导出给面板复用），答案块渲染已在测验面板里
    expect(src).toContain('quizAnswerClauses: _quizAnswerClauses');
    expect(src).not.toContain('function _quizAnswerBlock');
    const panel = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-quiz.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(panel).toContain("_answerBlock(_tr('kb.quiz.reference'");
    expect(panel).toContain("_answerBlock(_tr('kb.quiz.explain'");
    expect(panel).toContain("_answerBlock(_tr('kb.quiz.correct_answer'");
    expect(panel).toMatch(/function _clauses\(text\)[\s\S]{0,300}quizAnswerClauses/);
    // 仍然不用 ' · ' 把答案与解析拼成一句话
    expect(panel).not.toMatch(/q\.explain \? ' · ' \+ q\.explain/);
  });

  it('共享库的分享显示为待开发（不再弹出"像能用"的分享弹窗）', () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbWorkbench();
    const html = els['kb-workbench'].innerHTML;
    expect(html).toContain('kb-wb-soon-chip');
    expect(html).toContain('待开发');
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    // 开关 + 点击走说明弹层；真弹窗实现保留（翻开关即可恢复）
    expect(src).toContain('const KB_SHARE_READY = false');
    expect(src).toMatch(/if \(!KB_SHARE_READY\) \{ _kbShareSoonOpen\(\); return; \}/);
    expect(src).toContain('function _kbShareSoonOpen');
    expect(src).toContain('function _kbShareDialogOpen');
  });

  it('生成脑图仍走 kb.mindmap（本来就是独立能力）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/mmBtn\.addEventListener\('click', \(\) => _genMindmap\(\)\)/);
    expect(src).toMatch(/quizBtn\.addEventListener\('click', \(\) => _genQuiz\(\)\)/);
    expect(src).toContain("invoke('kb.mindmap'");
  });

  it('文档级脑图：文件菜单给入口，且 doc 作用域下沉到 kb.mindmap', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    // 两个入口：个人库文件行右键/… + 共享库文件菜单
    const entries = src.match(/生成脑图（本文档）/g) || [];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain('function _kbMindmapForDoc');
    expect(src).toMatch(/if \(act === 'mind'\) _kbMindmapForDoc\(path\)/);
    // 有 doc 时不再传 dir：作用域必须下沉到单文档，否则根主题还是"这个库是什么"。
    // spaceId 仍要带上——共享库的文件得去共享库索引里找。
    expect(src).toContain('? { doc, spaceId: _state.spaceId || null }');
    expect(src).not.toMatch(/invoke\('kb\.mindmap', doc[\s\S]{0,200}?\? \{ doc \}/);
    // 快照 key 以主进程回执的真实作用域为准，避免"请求本文档、实际整库"的错误脑图也顶着 doc: 存档
    expect(src).toMatch(/function _mmSnapshotKey\(doc, scope\)/);
    expect(src).toMatch(/const base = \(doc && \(!scope \|\| scope === 'doc'\)\)/);
    // 降级提示按作用域区分（文档级别说成"当前知识库没有文档"）
    expect(src).toMatch(/function _mmDegradedHtml\(reason, doc\)/);
  });

  it('作用域回执校验：主进程没按「本文档」生成时必须丢弃结果并提示重启', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    // 请求了 doc 就必须拿到 scope==='doc'；否则不渲染、不存档
    expect(src).toMatch(/const scopeMismatch = Boolean\(doc\) && res\.scope !== 'doc';/);
    expect(src).toMatch(/if \(doc && !_mmSameDoc\(res\.files, doc\)\)/);
    // 顺序契约：**降级提示必须排在"文件是否同一份"校验之前**。
    // not-found 的降级响应 files 是空的，若先判 files 就会把"这份文档没索引到"
    // 误报成"作用域不匹配，请重启"（2026-09-16 真机就此误报，用户以为功能坏了）。
    const guardIdx = src.indexOf("const scopeMismatch = Boolean(doc)");
    const degradedIdx = src.indexOf("if (res.source === 'degraded')", guardIdx);
    const filesIdx = src.indexOf('if (doc && !_mmSameDoc(res.files, doc))', guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(degradedIdx).toBeGreaterThan(guardIdx);
    expect(filesIdx).toBeGreaterThan(degradedIdx);
    const anchor = src.indexOf('主进程没有按「本文档」作用域生成');
    expect(anchor).toBeGreaterThan(-1);
    expect(src).toContain('完全退出 CogSeed 后重新启动');
    // 该分支必须 return，不能继续走渲染/写历史
    expect(src.slice(anchor, anchor + 900)).toMatch(/return;/);
    // 刷新(⟳)与保存(💾)沿用同一作用域，不能把本文档脑图换成整库脑图/存到库档位
    expect(src).toMatch(/function _mmRefreshMindmap\(\)[\s\S]{0,1200}\(s && s\.doc\)/);
    expect(src).toMatch(/function _mmCurrentKey\(\)[\s\S]{0,400}scope === 'doc'\) return `doc:\$\{s\.doc\}`/);
    expect(src).toContain('mmScope: null');
  });

  it('脑图作用域全程不串味：生成/回答/历史恢复三条路径都带上作用域', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    // 存档 key ←→ 作用域 双向可逆
    expect(src).toMatch(/function _mmScopeFromKey\(key\)/);
    expect(src).toMatch(/if \(k\.startsWith\('doc:'\)\) return \{ doc: k\.slice\(4\)\.split\('#'\)\[0\], scope: 'doc' \}/);
    // 三条渲染路径都把作用域挂到画布上
    expect(src).toMatch(/canvas\._mmScope = _state\.mmScope/); // 文件/整库生成 + 回答生成
    expect(src).toMatch(/canvas\._mmScope = _mmScopeFromKey\(m\.key\)/); // 会话历史里的脑图消息
    expect(src).toMatch(/canvas\._mmScope = _mmScopeFromKey\(key\)/); // 答案内的脑图快照
    // 打开弹窗前同步到全局：⟳/💾 作用在这张图真正的作用域上
    expect(src).toMatch(/if \(canvas\._mmScope\) _state\.mmScope = canvas\._mmScope;/);
    // 「回答 → 脑图」必须显式归位 text，否则会沿用上一次的 doc 作用域
    expect(src).toMatch(/_state\.mmScope = \{ doc: null, scope: 'text' \};/);
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
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain("typeof window.uiIconButton === 'function'");
    expect(source).toContain("window.matchMedia('(max-width: 1100px)')");
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.kb-wb\.right-panel-open \.kb-wb-right/);
    expect(css).toContain('width: min(420px, calc(100% - 44px));');
  });

  it('routes every import-menu glyph through the shared icon registry', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');

    for (const icon of ['file', 'folder', 'book-open', 'link', 'file-text', 'document-pencil', 'upload', 'mic']) {
      expect(source).toContain(`_icon('${icon}', 'kb-wb-import-icon')`);
    }
    expect(source).not.toMatch(/data-imp="(?:file|dir|kblib|url|note|note-new|note-import|audio|folder)">[📄📁📚🔗🗒✏️📥🎙🗂]/u);
  });

  it('renders knowledge-base file row actions through shared icon buttons', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
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
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
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
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toMatch(/noteToggle\.addEventListener\('click',[\s\S]*?importNoteSub\.hidden = false;/);
    expect(source).not.toMatch(/noteToggle\.addEventListener\('click',[\s\S]*?importNoteSub\.hidden = !importNoteSub\.hidden;/);
  });

  it('opens the note submenu toward the available left side', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain("_icon('chevron-left', 'kb-import-caret-icon')");
    const submenuRule = css.match(/\.kb-wb-import-sub\s*\{([^}]*)\}/)?.[1] || '';
    expect(submenuRule).toContain('right: calc(100% - 4px);');
    expect(submenuRule).not.toContain('left: calc(100% - 4px);');
  });

  it('renders mindmap window actions through shared buttons and registered icons', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
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
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
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
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
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
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
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
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8').replace(/\r\n/g, '\n');
    const historyRule = css.match(/\.kb-qa-history-panel\s*\{([^}]*)\}/)?.[1] || '';
    expect(historyRule).toContain('z-index: var(--z-modal-popover);');
  });

  it('renders the library import dialog with shared controls and recoverable loading state', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
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
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
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
  const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
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
  const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');

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

// ── 脑图「窗口 / 图」居中（真机反馈：无论窗口还是图都不在正中央）──
describe('KB mindmap centering', () => {
  const RECT_KEY = 'cogseed.kb-mm.rect';
  const VIEW = { width: 1440, height: 900 };
  // 1440×900 视口下 1123×720 窗口的居中位（.kb-mm-overlay 的 flex 居中结果）
  const CENTERED = { x: 158, y: 90, w: 1123, h: 720 };

  function source(): string {
    return fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
  }

  // 预置窗口几何 + 生成脑图按钮的绑定，返回可断言的 harness
  function prepare(options: Parameters<typeof loadScript>[0] = {}) {
    const h = loadScript({ ...VIEW, ...options } as any);
    const dlg = fakeEl('kb-mm-dlg');
    Object.assign(dlg, {
      offsetLeft: CENTERED.x, offsetTop: CENTERED.y,
      offsetWidth: CENTERED.w, offsetHeight: CENTERED.h,
    });
    h.els['kb-mm-dlg'] = dlg;
    // 弹窗初始为关闭态（fakeEl 的 hidden 默认 false，不置真会被"已打开"分支直接 return）
    const overlay = fakeEl('kb-mm-overlay');
    overlay.hidden = true;
    h.els['kb-mm-overlay'] = overlay;
    const mmBtn = fakeEl('kb-wb-gen-mm');
    h.els['kb-wb-gen-mm'] = mmBtn;
    const card = fakeEl('kb-wb-analysis-card');
    card.querySelector = vi.fn((sel: string) => (sel === '#kb-wb-gen-mm' ? mmBtn : null));
    h.els['kb-wb-analysis-card'] = card;
    return { h, dlg, mmBtn };
  }

  // 点「生成脑图」→ 等画布渲染 → 点缩略脑图卡打开弹窗（真实路径，不直接调内部函数）
  async function openOverlay(h: ReturnType<typeof loadScript>, mmBtn: any) {
    h.windowMock.renderKbWorkbench();
    mmBtn._listeners.click();
    await vi.waitFor(() => {
      expect(h.created.some((c) => String(c.child && c.child.innerHTML).includes('kb-mm-svg'))).toBe(true);
    });
    const canvas = h.created.find((c) => String(c.child && c.child.innerHTML).includes('kb-mm-svg'))!.child;
    canvas._listeners.click();
    expect(h.els['kb-mm-overlay'].hidden).toBe(false);
  }

  function offsetOf(dlg: any): { x: number; y: number } {
    const m = /^(-?\d+(?:\.\d+)?)px (-?\d+(?:\.\d+)?)px$/.exec(String(dlg.style.translate || ''));
    expect(m).toBeTruthy();
    return { x: Number(m![1]), y: Number(m![2]) };
  }

  it('无位置记忆时窗口落在屏幕正中（居中由 overlay 的 flex 布局给出，偏移为 0）', async () => {
    const { h, dlg, mmBtn } = prepare();
    await openOverlay(h, mmBtn);
    expect(offsetOf(dlg)).toEqual({ x: 0, y: 0 });
    expect(dlg.style.left).toBe('');
    expect(dlg.style.top).toBe('');
  });

  it('被污染的 v1 位置记忆一律作废：窗口回正中，脏值被清掉', async () => {
    // v1 写的是"视口坐标"，读的时候却当成 position:relative 的 left/top 叠加到居中位上，
    // 每开一次就再往右下推一次（此前"窗口不在正中央"的根因）
    const { h, dlg, mmBtn } = prepare({ storage: { [RECT_KEY]: JSON.stringify({ w: 1123, h: 720, x: 1240, y: 780 }) } });
    await openOverlay(h, mmBtn);
    expect(offsetOf(dlg)).toEqual({ x: 0, y: 0 });
    expect(dlg.style.left).toBe('');
    expect(h.localStorage.getItem(RECT_KEY)).toBeNull();
  });

  it('有效的 v2 位置记忆按"居中位 + 偏移"还原成原来那个绝对位置', async () => {
    // 1123×720 的窗口在 1440×900 视口里，可落位区间是 x∈[0,317]、y∈[0,180]
    const { h, dlg, mmBtn } = prepare({
      storage: { [RECT_KEY]: JSON.stringify({ v: 2, w: 1123, h: 720, x: 300, y: 150 }) },
    });
    await openOverlay(h, mmBtn);
    const off = offsetOf(dlg);
    expect(CENTERED.x + off.x).toBe(300);
    expect(CENTERED.y + off.y).toBe(150);
  });

  it('越界的记忆被夹取成"窗口完整可见"，不会只露一角或跑到屏幕外', async () => {
    const { h, dlg, mmBtn } = prepare({
      storage: { [RECT_KEY]: JSON.stringify({ v: 2, w: 1123, h: 720, x: 9999, y: 9999 }) },
    });
    await openOverlay(h, mmBtn);
    const off = offsetOf(dlg);
    const left = CENTERED.x + off.x;
    const top = CENTERED.y + off.y;
    expect(left).toBe(VIEW.width - CENTERED.w);
    expect(top).toBe(VIEW.height - CENTERED.h);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('先显示弹窗再套用记忆（display:none 时量不到居中位）', () => {
    const src = source();
    const start = src.indexOf('function _openMindPreview');
    const iShow = src.indexOf('overlay.hidden = false;', start);
    const iApply = src.indexOf('_mmApplyWindowRect();', start);
    expect(iShow).toBeGreaterThan(-1);
    expect(iApply).toBeGreaterThan(iShow);
  });

  it('画布图按 viewBox 固定像素尺寸并归中：scale 以画布内容盒算，平移归零', async () => {
    const { h, mmBtn } = prepare();
    const wrap = fakeEl('kb-mm-overlay-wrap');
    wrap.clientWidth = 1440;
    wrap.clientHeight = 640;
    const svg: any = { style: {}, viewBox: { baseVal: { x: -260, y: 0, width: 2000, height: 800 } } };
    wrap.querySelector = vi.fn(() => svg);
    h.els['kb-mm-overlay-wrap'] = wrap;
    await openOverlay(h, mmBtn);
    // 固定成 viewBox 像素：否则重渲染后回落到 .kb-mm-svg{width:100%;height:auto}，缩放基准漂移
    expect(svg.style.width).toBe('2000px');
    expect(svg.style.height).toBe('800px');
    const m = /^translate\((-?\d+)px, (-?\d+)px\) scale\(([\d.]+)\)$/.exec(String(wrap.style.transform));
    expect(m).toBeTruthy();
    expect(Number(m![3])).toBeCloseTo(Math.min(1440 / 2000, 640 / 800) * 0.92, 4);
    expect([m![1], m![2]]).toEqual(['0', '0']);
  });

  it('画布容器跟随 stage 铺满（不再把左上角钉在 stage 中心，图才会真居中）', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8').replace(/\r\n/g, '\n');
    const rules = [...css.matchAll(/\.kb-mm-overlay-wrap \{[\s\S]*?\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThan(0);
    // 基础规则：铺满 + flex 居中
    expect(rules[0]).toContain('width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;');
    // 末条覆盖规则不得再引入绝对定位 + top/left 50% + max-content（左上角钉在 stage 中心 → 图整体偏右下）
    const last = rules[rules.length - 1];
    expect(last).not.toContain('position: absolute');
    expect(last).not.toContain('top: 50%');
    expect(last).not.toContain('width: max-content');
  });

  it('平移写在缩放外面（拖拽 1:1 跟手，缩放不会把平移量再乘一次）', () => {
    const src = source();
    expect(src).toContain('wrap.style.transform = `translate(${_mmPanX}px, ${_mmPanY}px) scale(${_mmZoom})`');
  });

  it('「居中根节点」补偿 viewBox 原点（minX≠0 时才算真居中）', () => {
    const src = source();
    expect(src).toMatch(/_mmPanX = -\(\(sx - vbX\) - svgW \/ 2\) \* _mmZoom;/);
    expect(src).toMatch(/_mmPanY = -\(\(sy - vbY\) - svgH \/ 2\) \* _mmZoom;/);
    expect(src).toMatch(/const vbX = vb && Number\.isFinite\(vb\.x\) \? vb\.x : 0;/);
  });

  it('脑图 viewBox 左右留白等宽（整图不被推向画布中线一侧）', () => {
    const src = source();
    expect(src).toContain('const KB_MM_PAD_X = 56;');
    // 左右两侧必须引用同一个常量，否则整图会被推向一侧
    expect(src).toMatch(/const minX = Math\.min\([^\n]*\)\s*-\s*KB_MM_PAD_X;/);
    expect(src).toMatch(/const maxX = Math\.max\([^\n]*\)\s*\+\s*KB_MM_PAD_X \+ 12;/);
  });

  it('「适应画布」按画布内容盒算缩放（不吃 stage 的 12px 内边距）', () => {
    const src = source();
    expect(src).toMatch(/const stW = wrap\.clientWidth \|\| stage\.clientWidth \|\| 800;/);
    expect(src).toMatch(/const stH = wrap\.clientHeight \|\| stage\.clientHeight \|\| 600;/);
  });

  it('独立窗口：SVG 撑满内容盒 + 24px 内边距，靠 preserveAspectRatio 居中缩放（不再裁掉左上角）', () => {
    const src = source();
    const tpl = /const html = `<!doctype html>[\s\S]*?`;/.exec(src);
    expect(tpl).toBeTruthy();
    expect(tpl![0]).toContain('body{margin:0;box-sizing:border-box;padding:24px;background:#fff}');
    expect(tpl![0]).toContain('svg{display:block;width:100%;height:100%}');
    // 旧的 flex 居中 + min-height:100vh：图比窗口大时裁掉左上角且滚不到
    expect(tpl![0]).not.toContain('min-height:100vh');
    expect(tpl![0]).not.toContain('align-items:center');
  });

  it('主进程独立窗口按鼠标所在显示器的工作区居中（不是系统默认角落）', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '../../src/main/ipc/index.ts'), 'utf8').replace(/\r\n/g, '\n');
    const start = mainSrc.indexOf("'kb.mindmap.popout'");
    expect(start).toBeGreaterThan(-1);
    const block = mainSrc.slice(start, start + 1400);
    expect(block).toContain('screen.getDisplayNearestPoint(screen.getCursorScreenPoint())');
    expect(block).toContain('area.x + (area.width - width) / 2');
    expect(block).toContain('area.y + (area.height - height) / 2');
    expect(block).toContain('center: true');
  });

  it('更多菜单提供「窗口居中」，一键把窗口拉回正中', () => {
    const src = source();
    expect(src).toContain("{ k: 'center-window', label: '窗口居中'");
    expect(src).toMatch(/function _mmCenterWindow\(\) \{\n\s*_mmSetWindowOffset\(0, 0\);/);
  });
});

// ── 脑图排版与视觉（紧凑列布局 / 文字不折叠 / 卡片式节点）──
describe('KB mindmap layout & typography', () => {
  const VIS_ROOT = {
    label: '班级建设资料库',
    children: [
      { label: '真实项目征集与筛选', source: 'a.pdf', children: [
        { label: '面向全校本科生与研究生' },                     // 11 个汉字：必须单行
        { label: '按挑战名建目录，不使用裸 ID' },                 // 含半角 ID
        { label: 'Project-based learning roadmap', source: 'b.md' }, // 拉丁长句
        { label: '成果归属与知识产权说明以及跨学院组队的认定口径需要逐条写清楚', source: 'c.docx' }, // 30 字：恰好两行、不丢字
        { label: '跨学院组队的认定口径需要在评审细则里逐条写清楚并附上往届案例的判定结论与例外情形的处理办法', source: 'd.docx' }, // 50 字：两行 + 省略号
      ] },
      { label: '执行手册', children: [{ label: '资料归档要求' }] },
    ],
  };

  function source(): string {
    return fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
  }

  // 走真实路径渲染一份脑图 SVG（生成 → 缩略卡 innerHTML）
  //
  // 注意：界面首屏现在是**骨架态**（默认只展开到一级分支，渐进展开），
  // 而下面这些断言考的是"整图排版"（折行/列宽/层距）。整图语义 = 导出与独立窗口
  // 的全展开渲染，所以这里先真跑生成路径（保证链路有效），再用全展开基准取值。
  async function renderSvg(root: unknown = VIS_ROOT) {
    const h = loadScript({ width: 1440, height: 900, mindmapRoot: root });
    // 先预置按钮与卡片（绑定发生在 render 时），再渲染一次
    const btn = fakeEl('kb-wb-gen-mm');
    h.els['kb-wb-gen-mm'] = btn;
    const card = fakeEl('kb-wb-analysis-card');
    card.querySelector = vi.fn((sel: string) => (sel === '#kb-wb-gen-mm' ? btn : null));
    h.els['kb-wb-analysis-card'] = card;
    h.windowMock.renderKbWorkbench();
    btn._listeners.click();
    await vi.waitFor(() => {
      expect(h.created.some((c) => String(c.child && c.child.innerHTML).includes('kb-mm-svg'))).toBe(true);
    });
    return String(h.windowMock.__kbMindmapTest.svgExpanded(root));
  }

  type NodeBox = { idx: number; depth: number; dir: number; x: number; y: number; w: number; h: number; lines: string[] };

  function parseNodes(svg: string): NodeBox[] {
    return [...svg.matchAll(/<g class="kb-mm-node[^"]*"([^>]*)>([\s\S]*?)<\/g>/g)].map((m) => {
      const attrs = m[1];
      const body = m[2];
      const rect = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(body);
      const tspans = [...body.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((t) => t[1]);
      const attr = (name: string) => {
        const mm = new RegExp(`${name}="([^"]*)"`).exec(attrs);
        return mm ? mm[1] : '';
      };
      const x = Number(rect![1]), y = Number(rect![2]), w = Number(rect![3]), h = Number(rect![4]);
      return { idx: Number(attr('data-mm-idx')), depth: Number(attr('data-depth')), dir: Number(attr('data-dir')), x, y, w, h, lines: tspans };
    });
  }

  it('长中文标签不再被无谓折行：11 个汉字单行显示', async () => {
    const nodes = parseNodes(await renderSvg());
    const eleven = nodes.find((n) => n.lines.join('') === '面向全校本科生与研究生');
    expect(eleven).toBeTruthy();
    expect(eleven!.lines).toHaveLength(1);
  });

  it('超长标签最多两行并以省略号收尾（不再堆成三行以上）', async () => {
    const svg = await renderSvg();
    const nodes = parseNodes(svg);
    const twoLines = nodes.find((n) => n.lines.join('').startsWith('成果归属与知识产权说明'));
    expect(twoLines).toBeTruthy();
    expect(twoLines!.lines).toHaveLength(2);
    // 恰好放下就完整显示，不该丢字也不该加省略号
    expect(twoLines!.lines.join('')).toBe('成果归属与知识产权说明以及跨学院组队的认定口径需要逐条写清楚');
    const long = nodes.find((n) => n.lines.join('').startsWith('跨学院组队的认定口径需要'));
    expect(long).toBeTruthy();
    expect(long!.lines).toHaveLength(2);
    expect(long!.lines[1].endsWith('…')).toBe(true);
    // 所有节点都不超过两行
    expect(Math.max(...nodes.map((n) => n.lines.length))).toBeLessThanOrEqual(2);
  });

  it('拉丁标签在词/断点处换行，不把单词拦腰截断', async () => {
    const nodes = parseNodes(await renderSvg());
    const latin = nodes.find((n) => n.lines.join(' ').includes('Project-based'));
    expect(latin).toBeTruthy();
    if (latin!.lines.length > 1) {
      const first = latin!.lines[0];
      const rest = 'Project-based learning roadmap'.slice(first.length, first.length + 1);
      expect([' ', '-', '', '…'].includes(rest)).toBe(true);
    }
  });

  it('列中心按各层最宽节点累加：同级节点等宽对齐，层间距为固定连线空间', async () => {
    const nodes = parseNodes(await renderSvg());
    const depth1 = nodes.filter((n) => n.depth === 1);
    const depth2 = nodes.filter((n) => n.depth === 2);
    // 同一层同侧的所有节点中心 x 必须完全一致（列对齐）
    const xs1 = new Set(depth1.map((n) => n.x + n.w / 2));
    const xs2 = new Set(depth2.map((n) => n.x + n.w / 2));
    expect(xs1.size).toBe(1);
    expect(xs2.size).toBe(1);
    const root = nodes.find((n) => n.depth === 0)!;
    const gapToL1 = (depth1[0].x + depth1[0].w / 2) - (root.x + root.w / 2);
    const gapToL2 = (depth2[0].x + depth2[0].w / 2) - (depth1[0].x + depth1[0].w / 2);
    expect(gapToL1).toBeGreaterThanOrEqual(68);
    expect(gapToL2).toBeGreaterThanOrEqual(68);
    // 紧凑：原实现固定 300 列距，这里必须显著更小
    expect(gapToL1).toBeLessThan(240);
  });

  it('行距均匀：同一侧的叶子节点中心 y 等间隔（固定行高）', async () => {
    const nodes = parseNodes(await renderSvg());
    const leaves = nodes.filter((n) => n.depth === 3).map((n) => n.y + n.h / 2).sort((a, b) => a - b);
    const deltas = leaves.slice(1).map((v, i) => Math.round(v - leaves[i]));
    expect(deltas.every((d) => d === 54)).toBe(true);
  });

  it('卡片式视觉：根节点实心品牌绿、一级分支浅底 + 色条、二三级白卡片带阴影、不再用 📄 emoji', async () => {
    const svg = await renderSvg();
    expect(svg).toContain('id="kb-mm-card-shadow"');
    expect(svg).toContain('filter="url(#kb-mm-card-shadow)"');
    expect(svg).toMatch(/<rect[^>]*fill="#0B7A52"/);
    expect(svg).not.toContain('📄');
    // 一级分支：浅底色 + 前缘 3px 色条
    const depth1 = parseNodes(svg).filter((n) => n.depth === 1);
    expect(depth1.length).toBeGreaterThan(0);
    expect(svg).toMatch(/<rect x="[\d.]+" y="[\d.]+" width="3" height="[\d.]+" rx="1.5" fill="#/);
  });

  it('折叠分支不占位（收拢后画布收紧，不留大片空白）', () => {
    const src = source();
    expect(src).toMatch(/const kids = n\.kids\.filter\(\(c\) => !hidden\.has\(c\.idx\)\);/);
    // 收拢后重新适应画布
    expect(src).toMatch(/function _mmToggleFold[\s\S]{0,240}?_mmFitToStage\(\);/);
  });

  it('字号与行高成体系：根 16 / 一级 13 / 二级 12.5 / 叶子 12，节点高度 = 行数×行高 + 18', () => {
    const src = source();
    expect(src).toContain('if (depth === 0) return 16;');
    expect(src).toContain('if (depth === 1) return 13;');
    expect(src).toContain('if (depth === 2) return 12.5;');
    expect(src).toContain('return 12;');
    expect(src).toContain('const h = lines.length * lineH + 18;');
  });

  it('文本宽度按字形估算（中文 1em / 大写数字 0.64em），不再用"字符数×字号"一刀切', () => {
    const src = source();
    expect(src).toContain('function _mmCharW(ch, size) {');
    expect(src).toMatch(/if \(wide\) return size;/);
    expect(src).toMatch(/if \(\/\[A-Z0-9\]\/\.test\(ch\)\) return size \* 0\.64;/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 库列表不落后于磁盘（真机反馈 2026-09-16）
//
// 现场：在「转写纠错」里把清理版另存到知识库 → 磁盘/向量库/检索索引都有这份
// `…-清理版.txt`，但个人知识库列表里找不到，用户以为"另存没生效"。
// 原因：文件列表渲染的是**进入视图时拍的 `contexts.tree` 快照**，kb.events 只
// 报"某个路径的索引进度"，此前只更新「已索引」徽标、从不重拉树。
// ─────────────────────────────────────────────────────────────────────────────

const TREE_WITH_CLEANED = TREE.map((node) => (node.name !== '班级建设资料' ? node : {
  ...node,
  children: [
    ...(node.children || []),
    { name: '站会-清理版.txt', path: '班级建设资料/站会-清理版.txt', type: 'file', bytes: 9, mtime: 2 },
  ],
}));

describe('库列表不落后于磁盘（另存到知识库后找不到文件）', () => {
  /**
   * 装一份"库真的变了"的现场：第二次拉 contexts.tree 时多出一个刚另存的文件，
   * 并把 kb.events 的回调握在手里，好手动推一个索引事件进去。
   */
  function loadWithLiveKbStream() {
    const harness = loadScript();
    const { windowMock } = harness;
    const baseInvoke = windowMock.cogseed.invoke;
    let treeServed = 0;
    windowMock.cogseed.invoke = vi.fn(async (channel: string) => {
      if (channel === 'contexts.tree') {
        treeServed += 1;
        return { tree: treeServed > 1 ? TREE_WITH_CLEANED : TREE };
      }
      return baseInvoke(channel);
    });
    let kbEvent: ((ev: unknown) => void) | null = null;
    windowMock.cogseed.stream = vi.fn((_channel: string, _payload: unknown, cb: (ev: unknown) => void) => {
      kbEvent = cb;
      return { promise: new Promise(() => { /* 长连接：测试期间不结束 */ }) };
    });
    return {
      ...harness,
      pushKbEvent: (ev: unknown) => { kbEvent?.(ev); },
      treeCalls: () => treeServed,
    };
  }

  it('索引事件带来快照里没有的新文件时重拉库树，文件随即出现在列表里', async () => {
    const h = loadWithLiveKbStream();
    h.windowMock.renderKbWorkbench();
    await vi.waitFor(() => expect(h.els['kb-wb-files'].innerHTML).toContain('a.pdf'));
    expect(h.els['kb-wb-files'].innerHTML).not.toContain('站会-清理版.txt');
    expect(h.treeCalls()).toBe(1);

    // main 写盘后会推一条该路径的索引事件（另存/导入/AI 落库都是这条路）
    h.pushKbEvent({ event: { relPath: '班级建设资料/站会-清理版.txt', status: 'ready', chunks: 3, kind: 'text' } });

    await vi.waitFor(
      () => expect(h.els['kb-wb-files'].innerHTML).toContain('站会-清理版.txt'),
      { timeout: 3000 },
    );
    expect(h.treeCalls()).toBe(2);
  });

  it('已知路径的索引进度只更新徽标，不重拉库树（不做无谓的整树刷新）', async () => {
    const h = loadWithLiveKbStream();
    h.windowMock.renderKbWorkbench();
    await vi.waitFor(() => expect(h.els['kb-wb-files'].innerHTML).toContain('a.pdf'));

    h.pushKbEvent({ event: { relPath: '班级建设资料/a.pdf', status: 'ready', chunks: 2, kind: 'pdf' } });
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(h.treeCalls()).toBe(1);
  });

  it('文件在别处被删掉（快照里还在）时也重拉库树，让幽灵行消失', async () => {
    const h = loadWithLiveKbStream();
    h.windowMock.renderKbWorkbench();
    await vi.waitFor(() => expect(h.els['kb-wb-files'].innerHTML).toContain('a.pdf'));

    h.pushKbEvent({ event: { relPath: '班级建设资料/a.pdf', status: 'deleted' } });

    await vi.waitFor(() => expect(h.treeCalls()).toBe(2), { timeout: 3000 });
  });
});

// ── 脑图渐进展开 + 画布自适应（像 NotebookLM：先给骨架，点一层开一层）──
describe('KB mindmap progressive disclosure', () => {
  // 规模刻意接近真实脑图（一支 5 个叶子 + 一支两层），否则 SVG 的
  // svgW≥360 / svgH≥280 下限会把两态尺寸都抬平，"自适应"就测不出来了。
  const DEEP_ROOT = {
    label: 'ECS 早会',
    children: [
      {
        label: '产品与租户管理',
        children: [
          { label: '租户管理需求调整', children: [] },
          { label: '宁夏项目配合', children: [] },
          { label: '官网 Roadmap 对齐', children: [] },
          { label: '白皮书框架评审', children: [] },
          { label: '演示环境配置', children: [] },
        ],
      },
      {
        label: '会议行动项',
        children: [
          { label: '产品线跟进', children: [{ label: '租户隔离口径', children: [] }, { label: '配额与计费', children: [] }] },
        ],
      },
    ],
  };
  // pre-order 索引：0=root 1=产品与租户管理 2-6=它的 5 个叶子 7=会议行动项 8=产品线跟进 9/10=三级叶子

  // 生成是异步的：必须等它落地再断言折叠态，否则拿到的是"还没跑"的全展开图。
  async function hooks() {
    const h = loadScript({ width: 1440, height: 900, mindmapRoot: DEEP_ROOT });
    const btn = fakeEl('kb-wb-gen-mm');
    h.els['kb-wb-gen-mm'] = btn;
    const card = fakeEl('kb-wb-analysis-card');
    card.querySelector = vi.fn((sel: string) => (sel === '#kb-wb-gen-mm' ? btn : null));
    h.els['kb-wb-analysis-card'] = card;
    h.windowMock.renderKbWorkbench();
    btn._listeners.click();
    await vi.waitFor(() => {
      expect(h.created.some((c) => String(c.child && c.child.innerHTML).includes('kb-mm-svg'))).toBe(true);
    });
    return { h, M: h.windowMock.__kbMindmapTest as any };
  }

  function depths(svg: string): number[] {
    return [...svg.matchAll(/data-depth="(\d+)"/g)].map((m) => Number(m[1]));
  }
  /** 可见节点真实包围盒（不比 viewBox：那里有 360/280 下限，小图会被抬平）。 */
  function contentBox(svg: string) {
    const boxes = [...svg.matchAll(/data-depth="(\d+)"[^>]*>\s*<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
      .map((m) => ({ d: Number(m[1]), x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) }));
    const minX = Math.min(...boxes.map((b) => b.x));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    return { n: boxes.length, w: maxX - minX, h: maxY - minY, maxDepth: Math.max(...boxes.map((b) => b.d)) };
  }

  it('首屏是骨架：真跑生成路径后只到一级分支（不是全展开）', async () => {
    const { h } = await hooks();
    const canvas = h.created.find((c) => String(c.child && c.child.innerHTML).includes('kb-mm-svg'))!.child;
    const d = depths(String(canvas.innerHTML));
    expect(d.length).toBeGreaterThan(0);
    expect(Math.max(...d)).toBe(1); // 只有 root + 一级分支
  });

  it('默认折叠集 = 全部非叶子节点（根除外），所以每层都能"点一层开一层"', async () => {
    const { M } = await hooks();
    const def = [...M.defaultCollapsed(DEEP_ROOT)].sort((a: number, b: number) => a - b);
    expect(def).toEqual([1, 7, 8]);
    expect(def).not.toContain(0); // 根永不折叠（否则首屏只剩一个孤点）
    expect(def).not.toContain(2); // 叶子不参与折叠
  });

  it('展开一层只多出一层：点开一级分支 → 出现二级，且二级仍带 +N 徽章', async () => {
    const { M } = await hooks();
    expect(Math.max(...depths(M.svg(DEEP_ROOT)))).toBe(1);

    M.toggleFold(1);
    const svg1 = M.svg(DEEP_ROOT);
    expect(Math.max(...depths(svg1))).toBe(2);
    expect(svg1).toContain('租户管理需求调整');
    expect(svg1).toContain('data-folded="1"'); // 另一支仍是折叠节点
    expect(svg1).toMatch(/>\+\d+</); // +N 徽章：告诉用户"这里还有一层"
    expect(svg1).not.toContain('租户隔离口径'); // 三级没出来：不是整支炸开
  });

  it('逐层打开：一级 → 二级 → 三级', async () => {
    const { M } = await hooks();
    M.toggleFold(7);
    expect(Math.max(...depths(M.svg(DEEP_ROOT)))).toBe(2);
    expect(M.svg(DEEP_ROOT)).not.toContain('租户隔离口径');
    M.toggleFold(8);
    expect(Math.max(...depths(M.svg(DEEP_ROOT)))).toBe(3);
    expect(M.svg(DEEP_ROOT)).toContain('租户隔离口径');
  });

  it('再点一次收回去（折叠任意层级都隐藏整棵子树）', async () => {
    const { M } = await hooks();
    M.toggleFold(7);
    M.toggleFold(8);
    expect(Math.max(...depths(M.svg(DEEP_ROOT)))).toBe(3);
    M.toggleFold(8);
    expect(Math.max(...depths(M.svg(DEEP_ROOT)))).toBe(2);
    expect(M.svg(DEEP_ROOT)).not.toContain('租户隔离口径');
    M.toggleFold(7);
    expect(Math.max(...depths(M.svg(DEEP_ROOT)))).toBe(1);
    expect(M.svg(DEEP_ROOT)).not.toContain('产品线跟进');
  });

  it('画布随结构自适应：展开后可见节点与包围盒都变大，收起后回到原尺寸', async () => {
    const { M } = await hooks();
    const folded = contentBox(M.svg(DEEP_ROOT));
    expect(folded.maxDepth).toBe(1);

    M.toggleFold(1);
    const expanded = contentBox(M.svg(DEEP_ROOT));
    expect(expanded.n).toBeGreaterThan(folded.n); // 节点变多
    expect(expanded.h).toBeGreaterThan(folded.h); // 纵向跟着长
    expect(expanded.w).toBeGreaterThan(folded.w); // 横向多了二级列

    M.toggleFold(1);
    expect(contentBox(M.svg(DEEP_ROOT))).toEqual(folded); // 收起即收回
  });

  it('定位类操作会先展开路径（否则默认骨架态下"搜到了却看不到"）', async () => {
    const { M } = await hooks();
    expect(M.svg(DEEP_ROOT)).not.toContain('租户隔离口径'); // 三级，默认被两层折叠藏住
    expect(M.expandPathTo(9)).toBe(true);
    const svg = M.svg(DEEP_ROOT);
    expect(svg).toContain('租户隔离口径');
    expect(svg).toContain('会议行动项'); // 祖先链都展开了
    expect(svg).toContain('产品线跟进');
  });

  it('「收拢」幂等（默认就是收拢态，再按一次应维持，而不是反向全部展开）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).not.toContain('if (_state.mmCollapsed.size >= idxs.length) _state.mmCollapsed.clear();');
    expect(src).toMatch(/function _mmCollapseAll\(\)[\s\S]{0,700}_mmResetFoldToDefault\(root\)/);
  });

  it('结构变化后都重新适应画布（展开/收拢/折叠三处都要 fit）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    const body = (name: string) => {
      const i = src.indexOf(`function ${name}(`);
      return src.slice(i, i + 900);
    };
    expect(body('_mmToggleFold')).toContain('_mmFitToStage()');
    expect(body('_mmExpandAll')).toContain('_mmFitToStage()');
    expect(body('_mmCollapseAll')).toContain('_mmFitToStage()');
  });

  it('折叠态点节点主体 = 展开（不是聚焦/跳原文），且截断后续监听', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    const i = src.indexOf('function _bindPreviewNodes');
    const block = src.slice(i, i + 1200);
    expect(block).toContain("closest('.kb-mm-fold-badge')");
    expect(block).toContain('_state.mmCollapsed.has(idx)');
    expect(block).toContain('e.stopImmediatePropagation()');
    expect(block).toContain('_mmToggleFold(idx)');
  });

  it('回执文件判定：恰好一份 + NFC/NFD 等价（不因 Unicode 形式差异误弃合法结果）', async () => {
    const { M } = await hooks();
    expect(M.sameDoc(['文字转写/a.txt'], '文字转写/a.txt')).toBe(true);
    // 带重音的拉丁字符（如 Café）在 NFC/NFD 下字节不同，但指向同一个文件
    const nfc = '会议纪要-Café.pdf'.normalize('NFC');
    const nfd = '会议纪要-Café.pdf'.normalize('NFD');
    expect(nfc).not.toBe(nfd); // 前提：两种形式确实是不同字节
    expect(M.sameDoc([nfd], nfc)).toBe(true);
    expect(M.sameDoc([nfc], nfd)).toBe(true);
    // 数量不对 → 一律不认（这条才是"别把整库图冒充本文档图"的真正防线）
    expect(M.sameDoc([nfc, nfc], nfc)).toBe(false);
    expect(M.sameDoc([], nfc)).toBe(false);
    expect(M.sameDoc(null, nfc)).toBe(false);
    // 不同文件 → 不认
    expect(M.sameDoc(['文字转写/b.txt'], '文字转写/a.txt')).toBe(false);
  });

  it('大纲视图沿用折叠态（任意层级折叠都不展开），提示文案同步', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('if ((n.children || []).length && _state.mmCollapsed.has(cur)) return;');
    expect(src).toContain('折叠的分支不展开');
  });
});
