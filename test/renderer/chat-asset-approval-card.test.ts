/**
 * 资产审批卡片（specs/008 US-406）的真实渲染与处置测试。
 *
 * 为什么要有这个文件：卡片原先长在 `conversation.js` 里，只能做"源码里出现过这行"的
 * 断言；于是 `uiTextarea` 少传 id（共享组件强制要求 id、会抛错）没有任何测试挡住——
 * 待处理卡片的可编辑区在真机上一直是空白，异常还被 `.catch(() => {})` 吞掉
 * （2026-09-25 子安复现）。这里加载**真的共享组件 + 真的中文词条**去拼卡片：
 * 组件用错会当场抛错，渲染结果、编辑回传、三态处置都按输出断言。
 */
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
};

const LONG_TEXT = '一句话：同一并行批次里 ≥2 个工具、其中 read_file 返回图片且不是批次最后一条时，该批次会报 400。'.repeat(14);
const PROPOSAL_ID = 'ap-0123456789abcdef01234567';

function payloadFixture(over: Record<string, unknown> = {}) {
  return {
    kind: 'asset_change_approval',
    proposalId: PROPOSAL_ID,
    assetId: 'aa-fixture-1',
    assetTitle: 'CogSeed 已知缺陷（定位证据）',
    baselineVersion: '3',
    diff: { before: 'statement=1014 字:…', after: 'statement=1117 字:…', fields: ['statement', 'applicableWhen'] },
    reason: 'AI 自主判断发起：正文全挤在一段，没有可扫读的结论。',
    actions: ['confirm', 'defer', 'reject'],
    ...over,
  };
}

const proposalFixture = {
  state: 'pending',
  payload: { statement: LONG_TEXT, applicableWhen: ['写并行批次工具时', '排查 400 报错时'] },
  beforeValues: { statement: `旧正文：${'原始段落。'.repeat(60)}`, applicableWhen: ['旧场景'] },
};

/** 提议记录（IPC `recall.assets.approval.read` 的返回形状）。 */
function recordFixture(over: Record<string, unknown> = {}) {
  return { state: proposalFixture.state, payload: proposalFixture.payload, beforeValues: proposalFixture.beforeValues, ...over };
}

/** 卡片视图 = 从提议记录映射出来的渲染输入（proposed/current），不是消息载荷的 diff 摘要。 */
function viewFixture(over: Record<string, unknown> = {}) {
  return {
    state: proposalFixture.state,
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

beforeEach(() => {
  warnCalls.length = 0;
  root.cogseed = { invoke: vi.fn(async () => ({ ok: true })) };
});

describe('chat asset approval card — 渲染', () => {
  it('渲染出可编辑的拟生效内容，并把"当前"值摆在同一行（2026-09-25 空白缺陷回归）', () => {
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

  it('版本重检不一致：卡片保持待处理并说明，不静默套用', async () => {
    const el = fakeCard([]);
    card.render(el, payloadFixture(), viewFixture());
    const port = fakePort({ ok: false, versionConflict: { baselineVersion: '3', currentVersion: '5' } });
    await card.resolve(el, payloadFixture(), 'confirm', port);

    expect(el.dataset.status).toBe('pending');
    expect(el.dataset.busy).toBe('');
    expect(el.innerHTML).toContain('data-asset-approval-action="confirm"');
    expect(String(port.alert.mock.calls[0][0])).toContain('v3 → v5');
  });

  it('处置失败如实说，不吞', async () => {
    const el = fakeCard([]);
    card.render(el, payloadFixture(), viewFixture());
    const port = fakePort({ ok: false, error: 'proposal not found' });
    await card.resolve(el, payloadFixture(), 'reject', port);
    expect(String(port.alert.mock.calls[0][0])).toContain('proposal not found');
  });
});

describe('chat asset approval card — 挂载', () => {
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
    expect(el.innerHTML).toContain('AI 想改这条资产');
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
});
