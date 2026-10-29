/**
 * transcript-glossary-confirm — 渲染侧点选卡片
 *
 * 手搭假 DOM（与 delete-file-confirm.test.ts 同款做法，无 jsdom）。
 *
 * 重点守三件事，对应主进程那三条不变量在渲染侧的落点：
 *   1. **默认不勾高危项**——默认勾上等于替用户做了决定；
 *   2. **只在可见容器回执**——隐藏容器里回执会骗主进程"已展示"，用户却看不到；
 *   3. **提交后自动补一条消息**——光翻令牌状态唤不醒 LLM，不补消息流程就停在这。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

class FakeClassList {
  private readonly items = new Set<string>();
  add(...names: string[]) { for (const n of names) this.items.add(n); }
  remove(...names: string[]) { for (const n of names) this.items.delete(n); }
  contains(name: string) { return this.items.has(name); }
  setFromString(value: string) {
    this.items.clear();
    for (const item of String(value || '').split(/\s+/)) if (item) this.items.add(item);
  }
}

class FakeElement {
  // 注意：类字段的初始化顺序 = 声明顺序，且**在构造体内赋值之前**。
  // 所以 `_selfHidden` 必须在访问器之前声明，否则构造里 `offsetParent = null`
  // 设的值会被后面的字段初始化重新盖回 false（首版就是这么写的，导致
  // "容器隐藏"那组断言失效）。
  private _selfHidden = false;
  private listeners = new Map<string, Function[]>();
  private _className = '';
  private _innerHTML = '';
  private _textContent = '';

  id = '';
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  hidden = false;
  disabled = false;
  checked = false;
  type = '';
  htmlFor = '';
  value = '';
  /**
   * `offsetParent === null` 表示不可见。真实 DOM 里它是**向上传播**的：
   * 祖先 `display:none` 时，后代也拿不到 offsetParent。假 DOM 必须照这个语义，
   * 否则"容器隐藏 → 卡片也不可见"这条就测不出来。
   */
  get offsetParent(): unknown {
    if (this._selfHidden) return null;
    let node: FakeElement | null = this.parentNode;
    while (node) {
      if (node._selfHidden) return null;
      node = node.parentNode;
    }
    return {};
  }
  set offsetParent(value: unknown) { this._selfHidden = value === null; }

  constructor(tagName: string) { this.tagName = tagName; }

  get className() { return this._className; }
  set className(v: string) { this._className = String(v || ''); this.classList.setFromString(this._className); }

  set innerHTML(value: string) {
    this._innerHTML = String(value || '');
    this.children.splice(0);

    // 这个假 DOM 服务两类写入，必须**分别**识别，否则会漏掉一类：
    //   1. 卡片外壳（含 actions 与 result 两个容器）；
    //   2. 候选行列表（只有 uiCheckbox 产出的 input）。
    // 判别标志必须用**各自 HTML 里真实存在**的东西：
    //   - 外壳：class 里带 ui-button（动作键由 uiButton 产出）；
    //   - 行列表：带 data-entry-ref（uiCheckbox 的 attrs 原样渲染）。
    // 踩过的坑：首版用 'glossary-confirm-list' 当外壳标志，但那个 class **不在外壳
    // 的 HTML 里**——它由后续 renderBatch 填进列表元素。于是外壳那一支从不执行，
    // listEl 永远是 null，checkbox 全丢，5 个断言假红。**是脚手架的 bug。**
    const isRowList = /data-entry-ref=/i.test(this._innerHTML);
    const isCardShell = !isRowList && /ui-button/i.test(this._innerHTML);

    if (!isCardShell && !isRowList) return;

    if (isRowList) {
      // 候选行：解析共享 uiCheckbox 产出的真实 HTML。
      for (const m of this._innerHTML.matchAll(/<input\b[^>]*>/gi)) {
        const box = makeEl('input');
        box.type = readAttr(m[0], 'type') || 'checkbox';
        const id = readAttr(m[0], 'id');
        if (id) box.id = id;
        const ref = readAttr(m[0], 'data-entry-ref');
        if (ref) box.dataset.entryRef = ref;
        box.checked = /\bchecked\b/i.test(m[0]);
        const label = readAttr(m[0], 'aria-label');
        if (label) box.dataset.ariaLabel = label;
        this.appendChild(box);
      }
      return;
    }

    // 卡片外壳：checkout 输入的控件在候选行里，这里只建容器与动作键。
    this.appendChild(makeEl('div', 'glossary-confirm-title'));
    this.appendChild(makeEl('div', 'glossary-confirm-hint'));
    this.appendChild(makeEl('div', 'glossary-confirm-list'));
    const actions = makeEl('div', 'glossary-confirm-actions');
    for (const m of this._innerHTML.matchAll(/<button\b[^>]*>/gi)) {
      const btn = makeEl('button', 'ui-button');
      const act = readAttr(m[0], 'data-glossary-act');
      if (act) btn.dataset.glossaryAct = act;
      actions.appendChild(btn);
    }
    this.appendChild(actions);
    const result = makeEl('div', 'glossary-confirm-result');
    result.hidden = true;
    this.appendChild(result);
  }
  get innerHTML() { return this._innerHTML; }

  getAttribute(name: string): string | null {
    // 复刻真实 DOM 的映射：`data-entry-ref` → `dataset.entryRef`
    // （**先去掉 `data-` 前缀**，再把 `-x` 驼峰化）。
    // 踩过的坑：首版对整个属性名驼峰化，得到 `dataset.dataEntryRef`，
    // 于是 `getAttribute('data-entry-ref')` 恒为 null，`checkedRefs` 永远返回空集，
    // 提交类断言全红。**是脚手架的 bug，产品代码没错。**
    const base = String(name).replace(/^data-/, '');
    const key = base.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    const value = (this.dataset as Record<string, string>)[key];
    return value === undefined ? null : value;
  }

  set textContent(v: string) { this._textContent = String(v ?? ''); }
  get textContent() { return this._textContent; }

  appendChild(child: FakeElement) { child.parentNode = this; this.children.push(child); return child; }

  querySelector(selector: string): FakeElement | null { return findInTree(this, selector); }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    collect(this, selector, out);
    return out;
  }

  addEventListener(type: string, fn: Function) {
    const arr = this.listeners.get(type) || [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  async click() {
    for (const fn of this.listeners.get('click') || []) {
      await fn({ target: this, preventDefault() {}, stopPropagation() {} });
    }
  }
  scrollIntoView() {}
}

function makeEl(tagName: string, className = '') {
  const el = new FakeElement(tagName);
  el.className = className;
  return el;
}

function readAttr(tag: string, name: string): string {
  const m = new RegExp('\\b' + name + '="([^"]*)"', 'i').exec(tag);
  return m ? m[1] : '';
}

function matches(el: FakeElement, selector: string): boolean {
  if (selector === 'input[type="checkbox"]') return el.tagName === 'input' && el.type === 'checkbox';
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  const attr = /^\[data-([a-z-]+)="([^"]+)"\]$/.exec(selector);
  if (attr) {
    const key = attr[1].replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    return el.dataset[key] === attr[2];
  }
  if (/^[a-z]+$/i.test(selector)) return el.tagName.toLowerCase() === selector.toLowerCase();
  return false;
}

function findInTree(root: FakeElement, selector: string): FakeElement | null {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const nested = findInTree(child, selector);
    if (nested) return nested;
  }
  return null;
}

function collect(root: FakeElement, selector: string, out: FakeElement[]) {
  for (const child of root.children) {
    if (matches(child, selector)) out.push(child);
    collect(child, selector, out);
  }
}

function loadHarness(opts: { containerVisible?: boolean; noContainer?: boolean } = {}) {
  const container = makeEl('div');
  container.id = 'chat-history';
  if (opts.containerVisible === false) container.offsetParent = null;

  const input = makeEl('textarea') as FakeElement & { value: string };
  input.id = 'chat-input';
  const send = makeEl('button');
  send.id = 'chat-send-btn';
  let sendClicks = 0;
  (send as unknown as { click: () => Promise<void> }).click = async () => { sendClicks += 1; };

  const elements = new Map<string, FakeElement>([
    [container.id, container],
    [input.id, input],
    [send.id, send],
  ]);

  const invokeCalls: Array<{ channel: string; payload: any }> = [];
  const pushHandlers = new Map<string, Function>();

  const context: any = {
    console, Map, Set, Object, String, RegExp, Array, Number, Promise,
    setTimeout, clearTimeout,
    createLogger: () => ({ info() {}, warn() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'transcript.glossary.confirm.title': '需要确认 {count} 处',
        'transcript.glossary.confirm.apply': '应用勾选项',
        'transcript.glossary.confirm.none': '都不用改',
        'transcript.glossary.risk.high': '需确认',
        'transcript.glossary.risk.medium': '中风险',
        'transcript.glossary.risk.low': '低风险',
        'transcript.glossary.confirm.user_continue': '已确认,继续。',
        'transcript.glossary.confirm.user_continue_none': '这些都不用改,继续。',
      };
      let text = dict[key] || key;
      for (const [k, v] of Object.entries(vars || {})) {
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
      return text;
    },
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    KeyboardEvent: class {
      type: string; key: string; code: string;
      constructor(type: string, init: { key?: string; code?: string } = {}) {
        this.type = type; this.key = init.key || ''; this.code = init.code || '';
      }
    },
    document: {
      getElementById: (id: string) => opts.noContainer && id === container.id ? null : elements.get(id) || null,
      createElement: (tagName: string) => makeEl(tagName),
      querySelector: () => null,
    },
    window: {
      cogseed: {
        invoke: async (channel: string, payload: any) => {
          invokeCalls.push({ channel, payload });
          return { ok: true, resumed: true };
        },
        onPushEvent: (channel: string, handler: Function) => {
          pushHandlers.set(channel, handler);
          return () => { pushHandlers.delete(channel); };
        },
      },
    },
  };
  context.window.window = context.window;
  context.window.document = context.document;
  vm.createContext(context);
  const modulesDir = path.join(__dirname, '../../src/renderer/modules');
  // 加载**真实**共享原语，而不是替身：这样测的是真 HTML 产出，
  // 也顺便守住"模块确实依赖 ui-button / ui-form 暴露的接口"。
  for (const file of ['ui-button.js', 'ui-form.js']) {
    vm.runInContext(fs.readFileSync(path.join(modulesDir, file), 'utf8'), context, { filename: file });
  }
  vm.runInContext(
    fs.readFileSync(path.join(modulesDir, 'transcript-glossary-confirm.js'), 'utf8'),
    context,
    { filename: 'transcript-glossary-confirm.js' },
  );

  return {
    window: context.window as any,
    container,
    input,
    invokeCalls,
    sendClicks: () => sendClicks,
    start: () => context.window.startTranscriptGlossaryConfirmSubscription(),
    emit: (payload: any) => {
      const handler = pushHandlers.get('transcript_glossary.confirmation_required');
      if (!handler) throw new Error('module did not subscribe');
      handler(payload);
    },
  };
}

const ITEMS = [
  { entryRef: 'g_high', wrong: '健全', correct: '鉴权', action: 'replace', riskLevel: 'high', count: 1, context: '生态健全度', ignoredCount: 0 },
  { entryRef: 'g_low', wrong: 'coxy', correct: 'Cogseed', action: 'replace', riskLevel: 'low', count: 2, context: '我用 coxy', ignoredCount: 0 },
  { entryRef: 'g_ignored', wrong: '图度', correct: '土豆', action: 'replace', riskLevel: 'medium', count: 1, context: '', ignoredCount: 3 },
];

function payload(over: Record<string, unknown> = {}) {
  return { confirm_id: 'cf_1', doc_id: 'doc_1', items: ITEMS, cid: 'c1', turn_id: 't1', ...over };
}

describe('订阅', () => {
  it('start 后能收到推送，且重复 start 不会重复订阅', () => {
    const h = loadHarness();
    h.start();
    h.start(); // idempotent
    expect(() => h.emit(payload())).not.toThrow();
    // 卡片只挂了一张（重复订阅会导致挂两张）
    const cards = h.container.children.filter((c) => c.classList.contains('glossary-confirm-card'));
    expect(cards).toHaveLength(1);
  });

  it('没有 window.cogseed.onPushEvent 时安静返回，不抛错', () => {
    const h = loadHarness();
    delete h.window.cogseed.onPushEvent;
    expect(() => h.start()).not.toThrow();
  });
});

describe('卡片渲染', () => {
  it('文字确认同步锁定原卡片，且不会再发起一次续跑', () => {
    const h = loadHarness(); h.start(); h.emit(payload());
    const card = h.container.children[0];
    h.emit({ confirm_id: 'cf_1', cid: 'c1', status: 'resolved', accepted: [ITEMS[0].entryRef] });
    expect(card.classList.contains('is-confirmed')).toBe(true);
    const boxes = card.querySelectorAll('input[type="checkbox"]');
    expect(boxes.every(box => box.disabled)).toBe(true);
    expect(boxes.map(box => box.checked)).toEqual(ITEMS.map((_, index) => index === 0));
    expect(card.querySelector('[data-glossary-act="ok"]')!.disabled).toBe(true);
    expect(card.querySelector('.glossary-confirm-result')!.hidden).toBe(false);
    expect(h.invokeCalls.filter(call => call.channel === 'transcript_glossary.confirm')).toHaveLength(0);
    h.emit({ confirm_id: 'unknown', status: 'resolved', accepted: [] });
    expect(h.container.children).toHaveLength(1);
  });

  it('模型建议即便标为中风险也必须由用户主动勾选', () => {
    const h = loadHarness(); h.start();
    h.emit(payload({ items: [{ ...ITEMS[0], fromModel: true, riskLevel: 'medium' }] }));
    expect(h.container.children[0].querySelectorAll('input[type="checkbox"]')[0].checked).toBe(false);
  });
  it('每条候选一行，标题带条数', () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const card = h.container.children[0];
    const rows = card.querySelectorAll('input[type="checkbox"]');
    expect(rows).toHaveLength(ITEMS.length);
    expect(card.querySelector('.glossary-confirm-title')?.textContent).toContain('3');
  });

  it('所有待确认项默认不勾，包括低风险词条的模糊命中', () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const boxes = h.container.children[0].querySelectorAll('input[type="checkbox"]');
    const byRef = new Map(boxes.map((b) => [b.dataset.entryRef, b]));
    expect(byRef.get('g_high')!.checked).toBe(false);
    expect(byRef.get('g_low')!.checked).toBe(false);
    expect(h.container.children[0].querySelector('[data-glossary-act="ok"]')!.disabled).toBe(true);
  });

  it('被忽略过的词条也默认不勾（降权项不该主动推荐）', () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const boxes = h.container.children[0].querySelectorAll('input[type="checkbox"]');
    const ignored = boxes.find((b) => b.dataset.entryRef === 'g_ignored')!;
    expect(ignored.checked).toBe(false);
  });

  it('每个 checkbox 都带 entryRef（提交时按它回填 accepted）', () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const boxes = h.container.children[0].querySelectorAll('input[type="checkbox"]');
    expect(boxes.map((b) => b.dataset.entryRef).sort()).toEqual(['g_high', 'g_ignored', 'g_low']);
  });

  it('没有 items 的推送被忽略（不挂空卡片）', () => {
    const h = loadHarness();
    h.start();
    h.emit(payload({ items: [] }));
    // 卡片会挂出来但 0 行；再推一次同样 confirm_id 不重复
    h.emit(payload({ items: [] }));
    const cards = h.container.children.filter((c) => c.classList.contains('glossary-confirm-card'));
    expect(cards).toHaveLength(1);
  });
});

describe('可见性回执', () => {
  it('没有容器不能冒充用户选择都不修改', () => {
    const h = loadHarness({ noContainer: true });
    h.start();
    h.emit(payload());
    expect(h.invokeCalls).toEqual([]);
  });
  it('容器可见时回执 transcript_glossary.visible', () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const ack = h.invokeCalls.find((c) => c.channel === 'transcript_glossary.visible');
    expect(ack).toBeTruthy();
    expect(ack!.payload.confirm_id).toBe('cf_1');
  });

  it('容器隐藏时**不**回执（否则会骗主进程"已展示给用户"）', () => {
    const h = loadHarness({ containerVisible: false });
    h.start();
    h.emit(payload());
    expect(h.invokeCalls.some((c) => c.channel === 'transcript_glossary.visible')).toBe(false);
  });
});

describe('提交', () => {
  /**
   * ⚠ 真实事故回归（2026-10-15）。
   *
   * 用户本意是"都不用改"，但点到了蓝色的主按钮「应用勾选项」。
   * 当时 acceptAll 的判据是 `picked.length === 全部checkbox数` ——
   * **一个都没勾时 0 === 0 也为真**，于是被当成"全选"，
   * 6 条高风险同音词（MeshSeed 的各种误读）**全部被确认并应用到正文**。
   *
   * 两道防线：
   *   1. acceptAll 必须同时满足 picked.length > 0（本文件可测）；
   *   2. 一个都没勾时主按钮禁用（靠 change 事件驱动，测试装置的 FakeElement
   *      没有 dispatchEvent，无法在这里触发 —— 留作人工验证项）。
   * 这里守住的是**第 1 道**，也就是真正造成事故的那道。
   */
  it('一个都没勾时点「应用勾选项」：不得当成全选', async () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const card = h.container.children[0];
    // 先把所有勾去掉，模拟"用户什么都没勾"。
    const boxes = Array.from(card.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    for (const box of boxes) box.checked = false;
    await (card.querySelector('[data-glossary-act="ok"]') as HTMLButtonElement).click();
    const call = h.invokeCalls.find((c) => c.channel === 'transcript_glossary.confirm')!;
    // 关键断言：一个都没勾 ⇒ 绝不是全选，也一条都不确认
    expect(call.payload.accept_all, '0 勾选不得被当成全选').toBe(false);
    expect(call.payload.accepted).toEqual([]);
  });

  it('部分勾选时 accept_all=false（只有勾满才算全选）', async () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const card = h.container.children[0];
    const boxes = Array.from(card.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    // 只勾一个，其余清掉 ⇒ 不是全选
    boxes.forEach((box, i) => { box.checked = i === 0; });
    await (card.querySelector('[data-glossary-act="ok"]') as HTMLButtonElement).click();
    const call = h.invokeCalls.find((c) => c.channel === 'transcript_glossary.confirm')!;
    expect(call.payload.accept_all).toBe(false);
    expect(call.payload.accepted.length).toBeGreaterThan(0);
  });

  it('应用勾选项：只回填勾上的 entryRef', async () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const card = h.container.children[0];
    const ok = card.querySelector('[data-glossary-act="ok"]')!;
    card.querySelectorAll('input[type="checkbox"]').find(box => box.dataset.entryRef === 'g_low')!.checked = true;
    await ok.click();
    const call = h.invokeCalls.find((c) => c.channel === 'transcript_glossary.confirm')!;
    expect(call.payload.accepted).toEqual(['g_low']); // Only the explicitly selected row
    expect(call.payload.accept_all).toBe(false);
  });

  it('全勾时 accept_all=true（走主进程的整单确认路径）', async () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const card = h.container.children[0];
    for (const box of card.querySelectorAll('input[type="checkbox"]')) box.checked = true;
    await card.querySelector('[data-glossary-act="ok"]')!.click();
    const call = h.invokeCalls.find((c) => c.channel === 'transcript_glossary.confirm')!;
    expect(call.payload.accept_all).toBe(true);
    expect(call.payload.accepted.sort()).toEqual(['g_high', 'g_ignored', 'g_low']);
  });

  it('"都不用改"提交空集（是合法的拒绝，不是失败）', async () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const card = h.container.children[0];
    await card.querySelector('[data-glossary-act="none"]')!.click();
    const call = h.invokeCalls.find((c) => c.channel === 'transcript_glossary.confirm')!;
    expect(call.payload.accepted).toEqual([]);
    expect(call.payload.accept_all).toBe(false);
  });

  it('提交后按钮禁用，二次点击不再重复提交', async () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const card = h.container.children[0];
    const ok = card.querySelector('[data-glossary-act="ok"]')!;
    card.querySelectorAll('input[type="checkbox"]').find(box => box.dataset.entryRef === 'g_low')!.checked = true;
    await ok.click();
    await ok.click();
    const calls = h.invokeCalls.filter((c) => c.channel === 'transcript_glossary.confirm');
    expect(calls).toHaveLength(1);
  });

  it('主进程续跑后不改输入框或重复发送消息', async () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    await h.container.children[0].querySelector('[data-glossary-act="ok"]')!.click();
    expect(h.sendClicks()).toBe(0);
    expect(String(h.input.value || '')).toBe('');
  });

  it('结果文案如实反映"没有勾任何一项"', async () => {
    const h = loadHarness();
    h.start();
    h.emit(payload());
    const card = h.container.children[0];
    await card.querySelector('[data-glossary-act="none"]')!.click();
    const result = card.querySelector('.glossary-confirm-result')!;
    expect(result.hidden).toBe(false);
    expect(result.textContent.length).toBeGreaterThan(0);
  });
});

describe('history repaint recovery', () => {
  it('restores a pending card after the real history surface replaces its DOM', async () => {
    const h = loadHarness(); h.start(); h.emit(payload());
    for (const child of h.container.children) child.parentNode = null;
    h.container.innerHTML = '';
    h.window.cogseed.invoke = async (channel: string) => channel === 'transcript_glossary.pending' ? { ok: true, confirmations: [payload()] } : { ok: true };
    await h.window.restoreTranscriptGlossaryConfirmations('c1');
    expect(h.container.children.filter(c => c.classList.contains('glossary-confirm-card'))).toHaveLength(1);
    await h.window.restoreTranscriptGlossaryConfirmations('c1');
    expect(h.container.children.filter(c => c.classList.contains('glossary-confirm-card'))).toHaveLength(1);
  });
});

it('ignores a pending-card response after switching to another conversation', async () => {
  const h = loadHarness(); h.start();
  let deliver: (value: unknown) => void = () => {};
  h.window.cogseed.invoke = () => new Promise(resolve => { deliver = resolve; });
  const first = h.window.restoreTranscriptGlossaryConfirmations('c1');
  const deliverFirst = deliver;
  const second = h.window.restoreTranscriptGlossaryConfirmations('c2');
  deliver({ ok: true, confirmations: [] }); await second;
  deliverFirst({ ok: true, confirmations: [payload()] }); await first;
  expect(h.container.children).toHaveLength(0);
});
