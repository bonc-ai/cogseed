/** Real approval-card rendering and disposition tests. Load shared controls
 * and locale strings so invalid component arguments fail visibly; assert the
 * complete current/proposed content, typed edits and terminal states. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rendererRoot = path.join(__dirname, '../../src/renderer');
const locale: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(rendererRoot, 'locales/zh.json'), 'utf8'),
);

const root = globalThis as any;
root.t = (key: string, vars?: Record<string, unknown>): string => {
  const raw = typeof locale[key] === 'string' ? locale[key] : key;
  return Object.entries(vars || {}).reduce(
    (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
    raw,
  );
};
root.uiIconHtml = () => '';
// 模块在加载时就把 logger 抓走了，所以这里必须先于 require 装好，再断言调用记录。
const warnCalls: unknown[][] = [];
root.createLogger = () => ({ warn: (...args: unknown[]) => { warnCalls.push(args); } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loadRendererModule = (name: string): any => require(path.join(rendererRoot, 'modules', name));
loadRendererModule('ui-button.js');
loadRendererModule('ui-status.js');
loadRendererModule('ui-form.js');
const card = loadRendererModule('chat-asset-approval.js') as {
  cardHtml: (payload: any, view: any) => string;
  render: (el: any, payload: any, view: any) => void;
  resolve: (el: any, payload: any, action: string, port?: any) => Promise<void>;
  mount: (host: any, payload: any) => any;
  collectEdits: (payload: any, controls: any[]) => Record<string, unknown>;
  editableKeysOf: (payload: any) => string[];
  applyChipEdit: (values: string[], edit: any, options?: any) => string[];
};

const LONG_TEXT = '合成批处理说明：同一并行组内保留每条输入与输出的绑定；读取图片、文字或其他结果时，不得把不同工具的响应归到同一条记录。'.repeat(14);
const PROPOSAL_ID = 'ap-0123456789abcdef01234567';

function payloadFixture(over: Record<string, unknown> = {}) {
  return {
    kind: 'asset_change_approval',
    proposalId: PROPOSAL_ID,
    assetId: 'aa-fixture-1',
    assetTitle: '合成并行结果绑定规则',
    baselineVersion: '3',
    diff: { before: 'statement=1014 字:…', after: 'statement=1117 字:…', fields: ['statement', 'applicableWhen'] },
    reason: 'AI 自主判断发起：正文全挤在一段，没有可扫读的结论。',
    actions: ['confirm', 'defer', 'reject'],
    ...over,
  };
}

const proposalFixture = {
  state: 'pending',
  payload: { statement: LONG_TEXT, applicableWhen: ['整理合成并行结果时', '核对响应绑定时'] },
  beforeValues: { statement: `旧正文：${'原始段落。'.repeat(60)}`, applicableWhen: ['旧场景'] },
};

/** 提议记录（IPC `recall.assets.approval.read` 的返回形状）。 */
function recordFixture(over: Record<string, unknown> = {}) {
  return { id: PROPOSAL_ID, assetId: 'aa-fixture-1', baselineVersion: '3', state: proposalFixture.state, payload: proposalFixture.payload, beforeValues: proposalFixture.beforeValues, ...over };
}

/** 卡片视图 = 从提议记录映射出来的渲染输入（proposed/current），不是消息载荷的 diff 摘要。 */
function viewFixture(over: Record<string, unknown> = {}) {
  return {
    state: proposalFixture.state,
    readState: 'ready',
    proposed: proposalFixture.payload,
    current: proposalFixture.beforeValues,
    ...over,
  };
}

function fakeCard(controls: any[] = []) {
  return {
    dataset: {} as Record<string, string>,
    className: '',
    innerHTML: '',
    _assetApprovalProposed: null as unknown,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    querySelector() { return null; },
    querySelectorAll(selector: string) {
      if (controls.length && selector.includes('data-asset-approval-field')) return controls;
      return [];
    },
  };
}

function fakePort(result: unknown) {
  return { invoke: vi.fn(async () => result), alert: vi.fn(async () => {}) };
}

/** 手控 promise：让 `recall.assets.approval.read` 想多晚回来就多晚回来，
 *  才能摆出「用户已经处置、hydrate 结果才迟到」的竞态。 */
function deferred<T = unknown>() {
  let settled!: (value: T) => void;
  let failed!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { settled = resolve; failed = reject; });
  return { promise, resolve: settled, reject: failed };
}

beforeEach(() => {
  warnCalls.length = 0;
  root.cogseed = { invoke: vi.fn(async () => ({ ok: true })) };
});

describe('chat asset approval card — 渲染', () => {
  it('渲染出可编辑的拟生效内容，并把"当前"值摆在同一行', () => {
    const el = fakeCard();
    card.render(el, payloadFixture(), viewFixture());

    // 共享组件用法：uiTextarea 强制要求 id——少给就抛错，真机上就是这么空白的。
    expect(el.innerHTML).toContain(`id="chat-asset-approval-${PROPOSAL_ID}-statement"`);
    expect(el.innerHTML).toContain('<textarea');
    expect(el.innerHTML).toContain('data-asset-approval-field="statement"');
    expect(el.innerHTML).toContain('data-asset-approval-field="applicableWhen"');
    // 拟生效内容真的在控件里（不是只有摘要）。
    expect(el.innerHTML).toContain(LONG_TEXT.slice(0, 60));
    // 当前值同屏可见，用户才判断得了要不要批。
    expect(el.innerHTML).toContain(locale['recall.asset_approval.current_label']);
    expect(el.innerHTML).toContain('旧正文：');
    // 可编辑标记（两个可编辑字段）+ 状态标签 + 基线版本。
    expect(el.innerHTML.split(locale['recall.asset_approval.editable_hint']).length - 1).toBe(2);
    expect(el.innerHTML).toContain(locale['recall.asset_approval.tag_pending']);
    expect(el.innerHTML).toContain('基于 v3');
    // 三选一按钮。
    for (const key of ['confirm', 'defer', 'reject']) {
      expect(el.innerHTML).toContain(`data-asset-approval-action="${key}"`);
    }
    // 数组字段按原值类型留在元素上：确认时切回数组靠它。
    expect(el._assetApprovalProposed).toEqual(proposalFixture.payload);
  });

  it('长值折叠、短值直出：只给真正超长的值一个「展开全部」', () => {
    const el = fakeCard();
    card.render(el, payloadFixture(), viewFixture());
    expect(el.innerHTML).toContain(`data-asset-approval-clamp="${PROPOSAL_ID}:statement:prev"`);
    expect(el.innerHTML).toContain(locale['recall.asset_approval.expand']);
    // 「旧场景」很短，不折叠、也就没有按钮。
    expect(el.innerHTML).not.toContain(`data-asset-approval-clamp="${PROPOSAL_ID}:applicableWhen:prev"`);
  });

  it('已处置的卡片不再给编辑控件，只留状态与内容', () => {
    const el = fakeCard();
    card.render(el, payloadFixture(), viewFixture({ state: 'confirmed', appliedVersion: '2' }));
    expect(el.dataset.status).toBe('confirmed');
    expect(el.innerHTML).not.toContain('data-asset-approval-field');
    expect(el.innerHTML).not.toContain('data-asset-approval-action');
    expect(el.innerHTML).toContain(locale['recall.asset_approval.tag_confirmed']);
    expect(el.innerHTML).toContain('已按你确认的内容生效（v2）');
    // 内容仍然看得到（长值折叠）。
    expect(el.innerHTML).toContain(LONG_TEXT.slice(0, 60));
    // 已经处置完的卡片不再摆一份「当前」旧值——那是待决定时给人比对的。
    expect(el.innerHTML).not.toContain(locale['recall.asset_approval.current_label']);
  });

  it('拿不到译文时用中文兜底，兜底也要把变量填上', () => {
    const saved = root.t;
    root.t = undefined;
    try {
      const el = fakeCard();
      card.render(el, payloadFixture(), viewFixture({ state: 'confirmed', appliedVersion: '9' }));
      expect(el.innerHTML).toContain('已按你保存的内容生效（v9）');
      expect(el.innerHTML).not.toContain('{n}');
    } finally {
      root.t = saved;
    }
  });

  it('取不到拟生效内容时如实说，且不假装可编辑', () => {
    const el = fakeCard();
    card.render(el, payloadFixture(), { state: 'pending', readFailed: true });
    expect(el.innerHTML).toContain(locale['recall.asset_approval.read_failed']);
    expect(el.innerHTML).not.toContain('data-asset-approval-field');
    // 不留一排只有字段名的空壳。
    expect(el.innerHTML).not.toContain('data-asset-approval-row');
    // 摘要与依据仍在：卡片没内容也不该是空白。
    expect(el.innerHTML).toContain(payloadFixture().diff.before);
    expect(el.innerHTML).toContain('AI 自主判断发起');
  });

  // tags 字段标签须使用词条，不能裸显内部键名。
  it('AI 提议改 tags 时字段标签走词条，不裸显键名', () => {
    const el = fakeCard();
    card.render(el, payloadFixture({
      diff: { before: 'tags=2 项', after: 'tags=3 项', fields: ['tags'] },
    }), viewFixture({
      proposed: { tags: ['沟通', '决策'] },
      current: { tags: ['沟通'] },
    }));
    // 四语词条存在（zh 在这里直接取用；en/ja/pt 由 cognition-i18n-coverage 门禁钉住）。
    expect(locale['cognition.asset_edit_field_tags']).toBe('标签');
    // 上屏标签与可编辑控件的 aria-label 都用译文，而不是裸键名。
    expect(el.innerHTML).toContain('chat-asset-approval-label">标签</span>');
    expect(el.innerHTML).toContain('aria-label="标签"');
    expect(el.innerHTML).not.toContain('chat-asset-approval-label">tags</span>');
    // tags 是字符串数组：照常作为可编辑字段渲染。
    expect(el.innerHTML).toContain('data-asset-approval-field="tags"');
  });

  it('加载骨架用紧凑形态，确认按钮同步渲染并禁用', () => {
    const html = card.cardHtml(payloadFixture(), { state: 'pending', readState: 'loading' });
    expect(html).toContain('ui-skeleton');
    expect(html).toContain('合成并行结果绑定规则');
    expect(html).toMatch(/disabled[^>]*data-asset-approval-action="confirm"|data-asset-approval-action="confirm"[^>]*disabled/);
    expect(html).not.toContain('data-asset-approval-field');
    expect(html).not.toContain('data-asset-approval-row');
  });

  it('短值字段用 chip 编辑，不再渲染整块文本框', () => {
    const el = fakeCard();
    card.render(el, payloadFixture({
      diff: { before: 'tags=2 项', after: 'tags=2 项', fields: ['tags'] },
    }), viewFixture({
      proposed: { tags: ['沟通', '决策'] },
      current: { tags: [] },
    }));
    expect(el.innerHTML).not.toContain('<textarea');
    expect(el.innerHTML).toContain('data-asset-approval-field="tags"');
    expect(el.innerHTML).toContain('data-asset-approval-encoding="json"');
    expect(el.innerHTML).not.toContain('value="沟通、决策"');
    expect(el.innerHTML).toContain('data-asset-approval-chip-remove="tags"');
    expect(el.innerHTML).toContain('data-asset-approval-chip-add="tags"');
    expect(el.innerHTML).not.toContain(locale['recall.asset_approval.edit_hint']);
    expect(el.innerHTML).not.toContain(locale['recall.asset_approval.pending_note']);
  });

  it('chip 增删按分隔符切分并去重，不改原数组', () => {
    const original = ['沟通'];
    expect(card.applyChipEdit(original, { kind: 'add', text: '决策；沟通\n评审' }, { caseInsensitive: true }))
      .toEqual(['沟通', '决策', '评审']);
    expect(original).toEqual(['沟通']);
    expect(card.applyChipEdit(['沟通', '决策'], { kind: 'remove', index: 0 }, { caseInsensitive: true }))
      .toEqual(['决策']);
    expect(card.applyChipEdit(['沟通'], { kind: 'remove', index: 9 }, {})).toEqual(['沟通']);
  });

  it('已处置卡收起为一行，正文仍留在 DOM 里', () => {
    const el = fakeCard();
    card.render(el, payloadFixture(), viewFixture({
      state: 'confirmed',
      appliedVersion: '4',
      decidedAt: '2026-10-22T03:48:53.397Z',
    }));
    expect(el.innerHTML).toContain('<details');
    expect(el.innerHTML).toContain('datetime="2026-10-22T03:48:53.397Z"');
    expect(el.innerHTML).toContain('合成并行结果绑定规则');
    expect(el.innerHTML).toContain(locale['recall.asset_approval.tag_confirmed']);
    expect(el.innerHTML).toContain(LONG_TEXT.slice(0, 60));
    expect(el.innerHTML).not.toContain('data-asset-approval-field');
    expect(el.innerHTML).not.toContain('data-asset-approval-action');
    expect(el.innerHTML).not.toContain(locale['recall.asset_approval.current_label']);
  });

  it('chip 文案四语齐全且占位符一致', () => {
    const keys = ['chip_add', 'chip_entry', 'chip_placeholder', 'chip_remove'];
    const locales = ['zh', 'en', 'ja', 'pt'].map(code => JSON.parse(
      fs.readFileSync(path.join(rendererRoot, 'locales', `${code}.json`), 'utf8'),
    ) as Record<string, string>);
    const placeholders = (text: string) => [...String(text).matchAll(/\{([a-zA-Z]+)\}/g)]
      .map(match => match[1]).sort().join(',');
    for (const key of keys) {
      const prefixed = `recall.asset_approval.${key}`;
      for (const table of locales) expect(typeof table[prefixed]).toBe('string');
      const expected = placeholders(locales[0][prefixed]);
      for (const table of locales.slice(1)) expect(placeholders(table[prefixed])).toBe(expected);
    }
  });
});

describe('chat asset approval card — 编辑回传', () => {
  it('把用户改过的文本按原值类型切回数组/字符串', () => {
    const controls = [
      { dataset: { assetApprovalField: 'statement' }, value: '改过的正文' },
      { dataset: { assetApprovalField: 'applicableWhen' }, value: '写工具时；排查报错时\n看日志时' },
    ];
    expect(card.collectEdits(proposalFixture.payload, controls)).toEqual({
      statement: '改过的正文',
      applicableWhen: ['写工具时', '排查报错时', '看日志时'],
    });
  });

  it('chip 的 JSON 隐藏值原样保留标签里的分隔符', () => {
    const controls = [
      {
        dataset: { assetApprovalField: 'tags' },
        value: JSON.stringify(['沟通、协作', 'A;B']),
        getAttribute: (name: string) => name === 'data-asset-approval-encoding' ? 'json' : null,
      },
      { dataset: { assetApprovalField: 'applicableWhen' }, value: '写工具时；排查报错时\n看日志时' },
    ];
    expect(card.collectEdits({ tags: ['占位'], applicableWhen: ['占位'] }, controls)).toEqual({
      tags: ['沟通、协作', 'A;B'],
      applicableWhen: ['写工具时', '排查报错时', '看日志时'],
    });
  });

  it('标签在决定期间被改过：落作废终态并说明原因', async () => {
    const el = fakeCard();
    card.render(el, payloadFixture(), viewFixture());
    const port = fakePort({
      ok: false,
      state: 'superseded',
      tagConflict: { baselineTags: [], currentTags: ['重要'] },
    });
    await card.resolve(el, payloadFixture(), 'confirm', port);
    expect(el.dataset.status).toBe('superseded');
    expect(el.innerHTML).not.toContain('data-asset-approval-action');
    expect(port.alert).toHaveBeenCalledWith(locale['recall.asset_approval.tag_conflict_superseded']);
  });

  it('确认时把编辑后的内容一起回传，并按结果落到已确认状态', async () => {
    const el = fakeCard([
      { dataset: { assetApprovalField: 'statement' }, value: '用户改过的正文' },
      { dataset: { assetApprovalField: 'applicableWhen' }, value: '写工具时\n排查报错时' },
    ]);
    card.render(el, payloadFixture(), viewFixture());
    const port = fakePort({ ok: true, state: 'confirmed', appliedVersion: '4' });
    await card.resolve(el, payloadFixture(), 'confirm', port);

    expect(port.invoke).toHaveBeenCalledTimes(1);
    const [channel, body] = port.invoke.mock.calls[0];
    expect(channel).toBe('recall.assets.approval.decide');
    expect(body).toEqual({
      proposalId: PROPOSAL_ID,
      decision: 'confirm',
      payload: { statement: '用户改过的正文', applicableWhen: ['写工具时', '排查报错时'] },
    });
    expect(el.dataset.status).toBe('confirmed');
    expect(el.innerHTML).toContain('已按你确认的内容生效（v4）');
  });

  it('版本重检不一致：冲突即作废——卡片落作废终态并说明会重提，不再可确认', async () => {
    const el = fakeCard([]);
    card.render(el, payloadFixture(), viewFixture());
    const port = fakePort({ ok: false, state: 'superseded', versionConflict: { baselineVersion: '3', currentVersion: '5' } });
    await card.resolve(el, payloadFixture(), 'confirm', port);

    // 卡片落作废终态：没有再让用户「重新看一眼再决定」的死路按钮。
    expect(el.dataset.status).toBe('superseded');
    expect(el.dataset.busy).toBe('');
    expect(el.innerHTML).not.toContain('data-asset-approval-action="confirm"');
    expect(el.innerHTML).toContain(locale['recall.asset_approval.tag_superseded']);
    expect(el.innerHTML).toContain(locale['recall.asset_approval.state_superseded']);
    expect(String(port.alert.mock.calls[0][0])).toContain('v3 → v5');
    // 弹窗文案与词条同源：把 {a}/{b} 替换成同样的版本号后应完全一致。
    const expectedAlert = locale['recall.asset_approval.version_conflict_superseded']
      .split('{a}').join('3')
      .split('{b}').join('5');
    expect(String(port.alert.mock.calls[0][0])).toContain(expectedAlert);
  });

  it('处置失败如实说，不吞', async () => {
    const el = fakeCard([]);
    card.render(el, payloadFixture(), viewFixture());
    const port = fakePort({ ok: false, error: 'proposal not found' });
    await card.resolve(el, payloadFixture(), 'reject', port);
    expect(String(port.alert.mock.calls[0][0])).toContain('proposal not found');
    // 「处置失败：」前缀只包一次——旧实现 throw 里先包
    // 一层、catch 再包一层，用户看到「处置失败：处置失败：」。
    expect(String(port.alert.mock.calls[0][0])).not.toContain('处置失败：处置失败');
  });

  it('已处置回执——卡片落终态不再可点、回执 message 不丢、提示单层', async () => {
    const el = fakeCard([]);
    card.render(el, payloadFixture(), viewFixture());
    const port = fakePort({ ok: false, state: 'rejected', message: '这条提议已经处置过了。' });
    await card.resolve(el, payloadFixture(), 'reject', port);
    // 卡片按回执终态收口：dataset.status=rejected，按钮不再渲染（可再点=反复报错）。
    expect(el.dataset.status).toBe('rejected');
    expect(el.dataset.busy).toBe('');
    expect(el.innerHTML).not.toContain('data-asset-approval-action="confirm"');
    expect(el.innerHTML).not.toContain('data-asset-approval-action="reject"');
    // message 不丢（旧实现读不存在的 result.error，弹的是「处置失败：」空尾巴），
    // 且「处置失败：」只包一层。
    const alertText = String(port.alert.mock.calls[0][0]);
    expect(alertText).toContain('这条提议已经处置过了。');
    expect(alertText).not.toContain('处置失败：处置失败');
  });

  it('并发补偿回滚回执——state 与差异化 message 都如实呈现', async () => {
    const el = fakeCard([]);
    card.render(el, payloadFixture(), viewFixture());
    const rollbackMessage = '这条提议在你确认的同时已被拒绝，刚应用的内容已按提议前的值回滚。';
    const port = fakePort({ ok: false, state: 'rejected', message: rollbackMessage });
    await card.resolve(el, payloadFixture(), 'confirm', port);
    expect(el.dataset.status).toBe('rejected');
    // 回滚说明有安全语义（内容已回滚），不能一刀切成「已经处置过了」。
    expect(String(port.alert.mock.calls[0][0])).toContain(rollbackMessage);
    expect(String(port.alert.mock.calls[0][0])).not.toContain('处置失败：处置失败');
  });

  it('弹框机制自身同步抛错不升级——留痕后正常返回，处置流程不被二次炸掉', async () => {
    const el = fakeCard([]);
    card.render(el, payloadFixture(), viewFixture());
    root.cogseed = { invoke: vi.fn(async () => ({ ok: false, error: 'decision channel down' })) };
    root.uiAlert = () => { throw new Error('alert mechanism broken'); };
    try {
      // 旧实现：alertUser 同步 throw → resolve 的 catch 再弹一次又 throw →
      // 冒到 void 调用点成 unhandled rejection。修后：机制失败只留痕。
      await expect(card.resolve(el, payloadFixture(), 'reject')).resolves.toBeUndefined();
      expect(warnCalls.some((args) => String(args[0]).includes('uiAlert threw'))).toBe(true);
    } finally {
      delete root.uiAlert;
    }
  });

  it('uiAlert 返回 rejected promise 同样兜住（.catch 全兜底半边）', async () => {
    const el = fakeCard([]);
    card.render(el, payloadFixture(), viewFixture());
    root.cogseed = { invoke: vi.fn(async () => ({ ok: false, error: 'decision channel down' })) };
    root.uiAlert = async () => { throw new Error('alert async broken'); };
    try {
      await expect(card.resolve(el, payloadFixture(), 'reject')).resolves.toBeUndefined();
      expect(warnCalls.some((args) => String(args[0]).includes('uiAlert threw'))).toBe(true);
    } finally {
      delete root.uiAlert;
    }
  });
});

describe('chat asset approval card — 挂载', () => {
  it('读取未完成、失败或身份不符时，即便直接调用处理器也不能确认', async () => {
    for (const result of ['pending', 'failed', 'wrong-id'] as const) {
      const host = fakeHost();
      root.document = { createElement: () => fakeCard() };
      const gate = deferred();
      root.cogseed = { invoke: vi.fn(() => gate.promise) };
      const el = card.mount(host, payloadFixture());
      const port = fakePort({ ok: true, state: 'confirmed' });
      await card.resolve(el, payloadFixture(), 'confirm', port);
      expect(port.invoke).not.toHaveBeenCalled();
      expect(el.innerHTML).toMatch(/disabled[^>]*data-asset-approval-action="confirm"|data-asset-approval-action="confirm"[^>]*disabled/);
      if (result === 'pending') gate.resolve({ proposal: recordFixture() });
      else if (result === 'failed') gate.reject(new Error('read unavailable'));
      else gate.resolve({ proposal: recordFixture({ id: 'ap-other' }) });
      await new Promise(resolve => setTimeout(resolve, 0));
      if (result === 'pending') {
        await card.resolve(el, payloadFixture(), 'confirm', port);
        expect(port.invoke).toHaveBeenCalledOnce();
      } else {
        await card.resolve(el, payloadFixture(), 'confirm', port);
        expect(port.invoke).not.toHaveBeenCalled();
        expect(el.dataset.readState).toBe('failed');
      }
    }
  });
  function fakeHost() {
    const children: any[] = [];
    return {
      children,
      querySelector(selector: string) {
        return children.find((el) => selector.includes(String(el.dataset.proposalId))) || null;
      },
      appendChild(el: any) { children.push(el); },
    };
  }

  it('挂上之后按提议记录补齐内容，而不是停在骨架', async () => {
    const host = fakeHost();
    root.document = { createElement: () => fakeCard() };
    root.cogseed = {
      invoke: vi.fn(async () => ({ proposal: recordFixture() })),
    };
    const el = card.mount(host, payloadFixture());
    expect(el).toBeTruthy();
    expect(el.innerHTML).toContain(payloadFixture().assetTitle);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.cogseed.invoke).toHaveBeenCalledWith('recall.assets.approval.read', { proposalId: PROPOSAL_ID });
    expect(el.innerHTML).toContain('<textarea');
    expect(el.innerHTML).toContain(LONG_TEXT.slice(0, 60));
  });

  it('取内容失败不静默：留痕 + 界面上说清楚还能做什么', async () => {
    const host = fakeHost();
    root.document = { createElement: () => fakeCard() };
    root.cogseed = { invoke: vi.fn(async () => { throw new Error('ipc down'); }) };
    const el = card.mount(host, payloadFixture());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(el.innerHTML).toContain(locale['recall.asset_approval.read_failed']);
  });

  it('同一个提议只挂一张卡：重复渲染不再插第二张', async () => {
    const host = fakeHost();
    root.document = { createElement: () => fakeCard() };
    root.cogseed = { invoke: vi.fn(async () => ({ proposal: recordFixture() })) };
    const first = card.mount(host, payloadFixture());
    const second = card.mount(host, payloadFixture());
    expect(second).toBe(first);
    expect(host.children.length).toBe(1);
    expect(root.cogseed.invoke).toHaveBeenCalledTimes(1);
  });

  // 迟到读取不得把终态卡改回 pending，也不得打断进行中的处置。
  // 守卫口径与 conversation.js 的 kstar 复查卡一致：正忙或不待处理时不插手。
  it('处置进行中（busy）：迟到的 read 不把卡重渲染、还原成可点', async () => {
    const host = fakeHost();
    root.document = { createElement: () => fakeCard() };
    const readGate = deferred();
    const decideGate = deferred();
    root.cogseed = {
      invoke: vi.fn((channel: string) => (
        channel === 'recall.assets.approval.read' ? readGate.promise : decideGate.promise
      )),
    };
    const el = card.mount(host, payloadFixture());
    // An earlier complete read is ready; the outstanding request is a refresh.
    card.render(el, payloadFixture(), viewFixture());
    const readyHtml = el.innerHTML;
    // 用户点了「保存更新」，decide 还挂起：卡片处于 busy。
    const settling = card.resolve(el, payloadFixture(), 'confirm');
    expect(el.dataset.busy).toBe('1');
    // read 这时才回来（载荷齐全、状态 pending）：不许趁乱重渲染。
    readGate.resolve({ proposal: recordFixture({ state: 'pending' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.innerHTML).toBe(readyHtml);
    decideGate.resolve({ ok: true, state: 'confirmed', appliedVersion: '4' });
    await settling;
    expect(el.dataset.status).toBe('confirmed');
    expect(el.innerHTML).not.toContain('data-asset-approval-action');
  });

  it('已处置成终态（rejected）：迟到的 read 不把卡复活回 pending', async () => {
    const host = fakeHost();
    root.document = { createElement: () => fakeCard() };
    const readGate = deferred();
    root.cogseed = {
      invoke: vi.fn((channel: string) => (
        channel === 'recall.assets.approval.read' ? readGate.promise : Promise.resolve({ ok: true })
      )),
    };
    const el = card.mount(host, payloadFixture());
    // 用户已点了「拒绝」并落定：卡片是终态。
    const port = fakePort({ ok: true, state: 'rejected' });
    await card.resolve(el, payloadFixture(), 'reject', port);
    expect(el.dataset.status).toBe('rejected');
    // 迟到的 read 又回来说 pending：不许复活、按钮不许再点。
    readGate.resolve({ proposal: recordFixture({ state: 'pending' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.dataset.status).toBe('rejected');
    expect(el.innerHTML).not.toContain('data-asset-approval-action');
  });

  it('已处置成终态（confirmed）：迟到的 read 失败也不把卡打回 pending', async () => {
    const host = fakeHost();
    root.document = { createElement: () => fakeCard() };
    const readGate = deferred();
    root.cogseed = {
      invoke: vi.fn((channel: string) => (
        channel === 'recall.assets.approval.read' ? readGate.promise : Promise.resolve({ ok: true })
      )),
    };
    const el = card.mount(host, payloadFixture());
    const port = fakePort({ ok: true, state: 'confirmed', appliedVersion: '4' });
    card.render(el, payloadFixture(), viewFixture());
    await card.resolve(el, payloadFixture(), 'confirm', port);
    expect(el.dataset.status).toBe('confirmed');
    readGate.reject(new Error('late ipc failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(el.dataset.status).toBe('confirmed');
    expect(el.innerHTML).not.toContain('data-asset-approval-action');
    expect(el.innerHTML).not.toContain(locale['recall.asset_approval.read_failed']);
  });

  // busy 期间的完整读取暂存；处置失败回 pending 时回放，
  // 处置成功进入终态时丢弃，避免无内容的可操作骨架。
  it('busy 窗口内到达的 hydrate 被暂存：处置失败回 pending 后回放，卡片不再停在骨架态', async () => {
    const host = fakeHost();
    root.document = { createElement: () => fakeCard() };
    const readGate = deferred();
    const decideGate = deferred();
    root.cogseed = {
      invoke: vi.fn((channel: string) => (
        channel === 'recall.assets.approval.read' ? readGate.promise : decideGate.promise
      )),
    };
    const el = card.mount(host, payloadFixture());
    card.render(el, payloadFixture(), viewFixture());
    const readyHtml = el.innerHTML;
    // 用户点了「保存更新」，decide 挂起：卡片处于 busy。
    const settling = card.resolve(el, payloadFixture(), 'confirm');
    expect(el.dataset.busy).toBe('1');
    // read 在 busy 窗口内回来（载荷齐全、状态 pending）：不渲染但暂存。
    readGate.resolve({ proposal: recordFixture({ state: 'pending' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.innerHTML).toBe(readyHtml);
    expect(el._assetApprovalPendingHydration).toBeTruthy();
    // decide 失败：卡片回 pending，此刻回放暂存的拟生效内容。
    decideGate.resolve({ ok: false, error: 'write failed' });
    await settling;
    expect(el.dataset.busy).toBe('');
    expect(el.dataset.status).toBe('pending');
    expect(el.innerHTML).toContain('<textarea');
    expect(el.innerHTML).toContain(LONG_TEXT.slice(0, 60));
    expect(el._assetApprovalPendingHydration).toBeFalsy();
  });

  it('busy 窗口内暂存的 hydrate 在处置成功后作废：终态卡不回放', async () => {
    const host = fakeHost();
    root.document = { createElement: () => fakeCard() };
    const readGate = deferred();
    const decideGate = deferred();
    root.cogseed = {
      invoke: vi.fn((channel: string) => (
        channel === 'recall.assets.approval.read' ? readGate.promise : decideGate.promise
      )),
    };
    const el = card.mount(host, payloadFixture());
    const settling = card.resolve(el, payloadFixture(), 'reject');
    readGate.resolve({ proposal: recordFixture({ state: 'pending' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el._assetApprovalPendingHydration).toBeTruthy();
    decideGate.resolve({ ok: true, state: 'rejected' });
    await settling;
    expect(el.dataset.status).toBe('rejected');
    expect(el.innerHTML).not.toContain('data-asset-approval-action');
    expect(el._assetApprovalPendingHydration).toBeFalsy();
  });
});
