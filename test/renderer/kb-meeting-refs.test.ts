/**
 * kb-meeting-refs — 会议引用面板骨架（specs/013 · T014）
 *
 * 覆盖：
 *   1. mount/destroy 生命周期：五个分区（资产引用/纪要条目/待办草稿/关联建议/
 *      回执）各自渲染一条空态（共享 uiEmptyState），不静默空白；
 *   2. i18n 契约：订阅 i18n-change、destroy 解绑；四语 locale 的 kb.meetingRef.*
 *      键数一致（新增键必须四语齐全，与 kb-i18n-keys 门禁同一口径）；
 *   3. 源码契约：零裸控件（shared-ui-adoption-guard 的另一面）、文案走内联键名。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.resolve(__dirname, '../..');
const readSrc = (rel: string) => fs.readFileSync(path.join(root, 'src', rel), 'utf8');
const moduleSrc = readSrc('renderer/modules/kb-meeting-refs.js');

const exports = require('../../src/renderer/modules/kb-meeting-refs.js') as {
  SECTION_KEYS: string[];
};

function fakeElement(): any {
  const el: any = {
    _text: '', children: [], innerHTML: '', hidden: false, dataset: {}, style: {}, title: '',
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false },
    appendChild: (child: any) => { el.children.push(child); return child; },
    append: (...kids: any[]) => { kids.forEach((k) => el.children.push(k)); },
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {},
    insertBefore: () => {}, insertAdjacentHTML: () => {},
    focus: () => {}, remove: () => {}, replaceWith: () => {},
  };
  Object.defineProperty(el, 'textContent', {
    get: () => el._text,
    set: (v: any) => { el._text = String(v ?? ''); el.children = []; el.innerHTML = ''; },
    configurable: true,
  });
  return el;
}

function loadModule(overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, Array<() => void>> = {};
  const windowMock: any = {
    addEventListener: (name: string, fn: () => void) => { (handlers[name] = handlers[name] || []).push(fn); },
    removeEventListener: (name: string, fn: () => void) => {
      handlers[name] = (handlers[name] || []).filter((h) => h !== fn);
    },
    t: () => '',
    cogseed: { invoke: async () => ({}) },
    uiEmptyState: (o: any) => `<div class="ui-empty-state">${String(o?.title || '')}</div>`,
    ...overrides,
  };
  const context: any = {
    console, setTimeout, clearTimeout, Map, Set, Array, Object, String, Number, JSON,
    document: { createElement: () => fakeElement(), body: fakeElement(), addEventListener: () => {}, removeEventListener: () => {} },
    window: windowMock,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(moduleSrc, context, { filename: 'kb-meeting-refs.js' });
  return { windowMock, handlers, listenerCount: () => (handlers['i18n-change'] || []).length };
}

function mountPanel(overrides: Record<string, unknown> = {}) {
  const nodes = new Map<string, any>();
  const container = fakeElement();
  container.querySelector = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, fakeElement());
    return nodes.get(selector);
  };
  const loaded = loadModule(overrides);
  const instance = loaded.windowMock.KbMeetingRefs.mount(container, {
    docId: 'meetings/9.15站会.txt',
    displayPath: 'meetings/9.15站会.txt',
  });
  return { instance, nodes, ...loaded, container };
}

describe('kb-meeting-refs 骨架（T014）', () => {
  it('暴露 window.KbMeetingRefs = { mount, destroy }（与 KbTranscriptCorrect 同款形态）', () => {
    const { windowMock } = loadModule();
    expect(typeof windowMock.KbMeetingRefs?.mount).toBe('function');
    expect(typeof windowMock.KbMeetingRefs?.destroy).toBe('undefined'); // destroy 在实例上
  });

  it('五个分区各渲染一条空态：资产引用/纪要条目/待办草稿/关联建议/回执', () => {
    const { nodes, instance } = mountPanel();
    const sectionsHost = nodes.get('[data-mrf-sections]');
    const sections = sectionsHost.children;
    expect(sections.map((s: any) => s.dataset.mrfSection))
      .toEqual(['refs', 'conclusions', 'actions', 'related', 'receipts']);

    const empties = sections.map((s: any) => s.children[1].innerHTML);
    expect(empties[0]).toContain('暂无资产引用');
    expect(empties[1]).toContain('暂无纪要条目');
    expect(empties[2]).toContain('暂无待办草稿');
    expect(empties[3]).toContain('暂无关联建议');
    expect(empties[4]).toContain('暂无回执');

    // 标题与提示也渲染（面板标题/文件名尾段）
    expect(nodes.get('[data-mrf-title]')._text).toBe('会议引用');
    expect(nodes.get('[data-mrf-meta]')._text).toBe('9.15站会.txt');
    expect(nodes.get('[data-mrf-hint]')._text).toContain('冻结版');
    instance.destroy();
  });

  it('i18n-change 重渲染取新语言；destroy 解绑并清空容器', () => {
    const env = mountPanel();
    expect(env.listenerCount()).toBe(1);
    env.instance.destroy();
    expect(env.listenerCount()).toBe(0);
    expect(env.container._text).toBe('');
    expect(env.container.children).toEqual([]);
  });

  it('mount 前置校验：容器 / IPC / 共享原语 / docId 缺一即抛', () => {
    const { windowMock } = loadModule();
    expect(() => windowMock.KbMeetingRefs.mount(null, { docId: 'd' })).toThrow();
    const noIpc = loadModule({ cogseed: undefined }).windowMock;
    expect(() => noIpc.KbMeetingRefs.mount(fakeElement(), { docId: 'd' })).toThrow(/ipc/);
    const noEmpty = loadModule({ uiEmptyState: undefined }).windowMock;
    expect(() => noEmpty.KbMeetingRefs.mount(fakeElement(), { docId: 'd' })).toThrow(/primitives/);
    expect(() => windowMock.KbMeetingRefs.mount(fakeElement(), {})).toThrow(/docId/);
  });

  it('SECTION_KEYS 导出五个分区（后续任务按分区接线数据）', () => {
    expect(exports.SECTION_KEYS).toEqual(['refs', 'conclusions', 'actions', 'related', 'receipts']);
  });
});

describe('kb-meeting-refs 源码与 i18n 契约', () => {
  it('零裸控件：不出现裸 button/input/textarea/select 与 createElement 控件', () => {
    expect(/<(?:button|input|textarea|select)\b/i.test(moduleSrc)).toBe(false);
    expect(/createElement\(\s*['"](?:button|input|textarea|select)['"]/i.test(moduleSrc)).toBe(false);
  });

  it('文案全部走内联键名（kb.meetingRef.*），订阅 i18n-change', () => {
    expect(moduleSrc).toContain("t('kb.meetingRef.");
    expect(moduleSrc).toContain('i18n-change');
  });

  it('四语 locale 的 kb.meetingRef.* 键数一致（新增键必须四语齐全）', () => {
    const counts = ['zh', 'en', 'ja', 'pt'].map((lang) => {
      const dict = JSON.parse(readSrc(`renderer/locales/${lang}.json`)) as Record<string, string>;
      return Object.keys(dict).filter((k) => k.startsWith('kb.meetingRef.')).length;
    });
    expect(counts[0]).toBeGreaterThan(40);
    expect(counts).toEqual([counts[0], counts[0], counts[0], counts[0]]);
  });

  it('zh 值与代码内联回退逐字一致（缺键回退不得给出第二套措辞）', () => {
    const zh = JSON.parse(readSrc('renderer/locales/zh.json')) as Record<string, string>;
    const re = /\bt\(\s*'(kb\.meetingRef\.[a-zA-Z0-9_.]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g;
    const drift: string[] = [];
    for (const m of moduleSrc.matchAll(re)) {
      const fallback = m[2].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      if (zh[m[1]] !== fallback) drift.push(`${m[1]}\n    代码回退: ${fallback}\n    zh.json : ${zh[m[1]]}`);
    }
    expect(drift).toEqual([]);
  });
});

// ── T038 / T039 / T043：面板数据接线（双引用 + 冻结版对比 + 草稿待办）─────────

/** 引用清单（MeetingAssetRefView 形态：a_1 漂移、a_2 已彻底删除）。 */
const REF_VIEWS = [
  {
    assetId: 'a_1', version: '2', title: '发布检查单', type: 'rule', via: 'attach', at: '2026-09-01T00:00:00.000Z',
    currentVersion: '3', currentTitle: '发布检查单', stale: true, available: true,
  },
  {
    assetId: 'a_2', version: '1', title: '旧版资产', type: 'fact', via: 'conclusion', at: '2026-09-01T00:00:00.000Z',
    currentVersion: '', currentTitle: '', stale: false, available: false,
  },
];

const CONCLUSIONS = [
  {
    id: 'mc_1', docId: 'meetings/9.15站会.txt', summary: '发布前要过一遍检查单',
    transcriptRefs: [{ utteranceId: 'U0003', blockIndex: 2, from: 4, to: 9 }],
    assetRefs: [{ assetId: 'a_1', version: '2', title: '发布检查单', type: 'rule' }],
    status: 'draft', createdAt: '', updatedAt: '',
  },
  {
    id: 'mc_2', docId: 'meetings/9.15站会.txt', summary: '早期结论（旧记录）',
    transcriptRefs: [], assetRefs: [],
    unlinkable: 'legacy_record', status: 'draft', createdAt: '', updatedAt: '',
  },
];

const DRAFTS = [
  {
    id: 'ma_1', docId: 'meetings/9.15站会.txt', summary: '周一前补上检查单的 v3 变更',
    owner: { speaker: '子安', anchor: { utteranceId: 'U0005', blockIndex: 4, from: 0, to: 6 } },
    transcriptRefs: [{ utteranceId: 'U0005', blockIndex: 4, from: 0, to: 6 }],
    assetRefs: [{ assetId: 'a_1', version: '2', title: '发布检查单', type: 'rule' }],
    status: 'draft', createdAt: '', updatedAt: '',
  },
];

/**
 * 带数据的 mount：mock invoke 按 channel 分发；uiButton/uiTag 走共享原语 mock
 * （渲染层纪律：按钮必经 uiButton、状态章必经 uiTag——这里同样不裸写控件）。
 */
function mountPanelWithData(invokeImpl?: (channel: string, payload: any) => Promise<any>) {
  const nodes = new Map<string, any>();
  const container = fakeElement();
  container.querySelector = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, fakeElement());
    return nodes.get(selector);
  };
  const clicks: Array<(event: unknown) => void> = [];
  container.addEventListener = (name: string, fn: (event: unknown) => void) => {
    if (name === 'click') clicks.push(fn);
  };
  container.removeEventListener = () => {};
  const defaultInvoke = async (channel: string) => {
    if (channel === 'meeting.assets.list') return { ok: true, refs: REF_VIEWS };
    if (channel === 'meeting.conclusions.list') return { ok: true, conclusions: CONCLUSIONS };
    if (channel === 'meeting.actions.list') return { ok: true, drafts: DRAFTS };
    return {};
  };
  const loaded = loadModule({
    cogseed: { invoke: invokeImpl || defaultInvoke },
    uiButton: (o: any) => `<button type="button" class="ui-button" data-act="${o?.attrs?.['data-act'] || ''}" data-mrf-id="${o?.attrs?.['data-mrf-id'] || ''}">${String(o?.label || '')}</button>`,
    uiTag: (o: any) => `<span class="ui-tag">${String(o?.label || '')}</span>`,
  });
  const instance = loaded.windowMock.KbMeetingRefs.mount(container, {
    docId: 'meetings/9.15站会.txt',
    displayPath: 'meetings/9.15站会.txt',
  });
  const fireClick = async (act: string, id = '') => {
    for (const handler of clicks) {
      handler({
        target: {
          closest: () => ({
            getAttribute: (key: string) => (key === 'data-act' ? act : key === 'data-mrf-id' ? id : ''),
          }),
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const sectionBody = (index: number) =>
    nodes.get('[data-mrf-sections]').children[index].children[1].innerHTML as string;
  return { instance, nodes, container, fireClick, sectionBody, ...loaded };
}

describe('T038 双引用展开与冻结版对比', () => {
  it('① 纪要条目渲染：转写锚点与资产引用都在（不含转写/资产正文）', async () => {
    const { instance, sectionBody } = mountPanelWithData();
    await instance.ready;
    const html = sectionBody(1);
    // 锚点定位（U 体系 + 段序 + 偏移——锚点不是正文）
    expect(html).toContain('data-mrf-conclusion-anchors');
    expect(html).toContain('U0003');
    expect(html).toContain('段 2');
    // 资产引用（标题 · 冻结版 vN）
    expect(html).toContain('data-mrf-conclusion-assets');
    expect(html).toContain('发布检查单 · v2');
    // 旧记录如实标注不可关联（不报错、不猜位置）
    expect(html).toContain('不可关联');
    instance.destroy();
  });

  it('② stale 时两个版本号同时可见：对比现状展开后 冻结版 v2 + 现状 v3 + stale 标记', async () => {
    const { instance, sectionBody, fireClick } = mountPanelWithData();
    await instance.ready;
    await fireClick('meeting-ref-compare', 'a_1');
    const refsHtml = sectionBody(0);
    expect(refsHtml).toContain('data-mrf-ref-compare');
    expect(refsHtml).toContain('冻结版 v2');
    expect(refsHtml).toContain('现状 v3');
    expect(refsHtml).toContain('data-mrf-ref-stale');
    // 纪要条目里的同一资产共享同一份展开（同一 assetId 一份数据）
    const conclusionHtml = sectionBody(1);
    expect(conclusionHtml).toContain('冻结版 v2');
    expect(conclusionHtml).toContain('现状 v3');
    instance.destroy();
  });

  it('③ 控件全走共享原语：按钮来自 uiButton、无裸控件（基线未上调由 guard 看守）', async () => {
    const { instance, sectionBody } = mountPanelWithData();
    await instance.ready;
    const html = [sectionBody(0), sectionBody(1), sectionBody(2)].join('');
    // 源码级「零裸控件」由上方既有断言看守；这里钉渲染产物也经共享原语
    expect(html).toContain('ui-button');
    expect(html).not.toMatch(/<button(?![^>]*ui-button)/);
    instance.destroy();
  });
});

describe('T039 版本真删的如实呈现', () => {
  it('available:false ⇒ 「被引用版本已不存在」，不显示假的现状版本', async () => {
    const { instance, sectionBody } = mountPanelWithData();
    await instance.ready;
    const html = sectionBody(0);
    expect(html).toContain('data-mrf-ref-missing');
    expect(html).toContain('被引用版本已不存在');
    // 不假装读到了那一版：现状未知就不给现状行
    expect(html).not.toContain('现状 v');
    // 现状未知（彻底删除）也无对比按钮：无对比可言
    expect((html.match(/meeting-ref-compare/g) || []).length).toBe(1);
    instance.destroy();
  });
});

describe('T043 草稿待办视图', () => {
  it('①② 草稿章可见；来源/资产引用/三动作齐；无裸英文动作名', async () => {
    const { instance, sectionBody } = mountPanelWithData();
    await instance.ready;
    const html = sectionBody(2);
    // 状态章（草稿，经 uiTag）
    expect(html).toContain('data-mrf-action-status');
    expect(html).toContain('ui-tag');
    expect(html).toContain('草稿');
    // 来源：说话人 + 段落锚点（T043 的「谁说的/哪段」）
    expect(html).toContain('data-mrf-action-source');
    expect(html).toContain('来源：子安 · 转写锚点 U0005');
    // 资产引用（标题 + 冻结版）
    expect(html).toContain('data-mrf-action-assets');
    expect(html).toContain('发布检查单 · v2');
    // 三个动作（按钮名按语境复用 recall.asset_approval.* 既有三键）
    expect(html).toContain('meeting-action-confirm');
    expect(html).toContain('meeting-action-defer');
    expect(html).toContain('meeting-action-discard');
    expect(html).toContain('确认更新');
    expect(html).toContain('稍后处理');
    expect(html).toContain('拒绝');
    // 不出现裸英文动作名（可见文本层；data-act 属性不算上屏文本）
    expect(html).not.toMatch(/>(?:confirm|defer|discard|reject)</i);
    instance.destroy();
  });

  it('③ 空态恰一处：有数据的分区无空态，无数据的分区恰一条', async () => {
    const { instance, sectionBody } = mountPanelWithData();
    await instance.ready;
    expect(sectionBody(2)).not.toContain('ui-empty-state');
    expect(sectionBody(1)).not.toContain('ui-empty-state');
    expect(sectionBody(0)).not.toContain('ui-empty-state');
    expect((sectionBody(3).match(/ui-empty-state/g) || []).length).toBe(1);
    expect((sectionBody(4).match(/ui-empty-state/g) || []).length).toBe(1);
    instance.destroy();
  });

  it('动作接线：确认/丢弃走 meeting.actions.*，「稍后处理」不动数据（SC-003）', async () => {
    const calls: Array<{ channel: string; payload: any }> = [];
    const { instance, fireClick } = mountPanelWithData(async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === 'meeting.assets.list') return { ok: true, refs: [] };
      if (channel === 'meeting.conclusions.list') return { ok: true, conclusions: [] };
      if (channel === 'meeting.actions.list') return { ok: true, drafts: DRAFTS };
      return { ok: true };
    });
    await instance.ready;
    calls.length = 0;
    // 稍后处理 = 不动数据：零通道调用、草稿保留
    await fireClick('meeting-action-defer', 'ma_1');
    expect(calls.filter((c) => c.channel.startsWith('meeting.actions'))).toHaveLength(0);
    await fireClick('meeting-action-confirm', 'ma_1');
    expect(calls.some((c) => c.channel === 'meeting.actions.confirm' && c.payload?.draftId === 'ma_1')).toBe(true);
    await fireClick('meeting-action-discard', 'ma_1');
    expect(calls.some((c) => c.channel === 'meeting.actions.discard' && c.payload?.draftId === 'ma_1')).toBe(true);
    instance.destroy();
  });
});

describe('meeting.* 通道降级（renderer-seams §5）', () => {
  it('通道返回 ok:false ⇒ 分区渲染一条带原因的空态（不静默空白、不弹错）', async () => {
    const { instance, sectionBody } = mountPanelWithData(async (channel) => {
      if (channel === 'meeting.assets.list') return { ok: false, code: 'invalid_doc_id' };
      if (channel === 'meeting.conclusions.list') return { ok: true, conclusions: CONCLUSIONS };
      if (channel === 'meeting.actions.list') return { ok: true, drafts: [] };
      return {};
    });
    await instance.ready;
    const html = sectionBody(0);
    expect((html.match(/ui-empty-state/g) || []).length).toBe(1);
    expect(html).toContain('会议文档标识不合法');
    // 其它分区不受拖累
    expect(sectionBody(1)).toContain('发布检查单 · v2');
    instance.destroy();
  });

  it('meeting.refs.related 失败 ⇒ 关联分区一条带原因空态（不拖垮其它分区）', async () => {
    const { instance, sectionBody } = mountPanelWithData(async (channel) => {
      if (channel === 'meeting.assets.list') return { ok: true, refs: REF_VIEWS };
      if (channel === 'meeting.conclusions.list') return { ok: true, conclusions: CONCLUSIONS };
      if (channel === 'meeting.actions.list') return { ok: true, drafts: DRAFTS };
      if (channel === 'meeting.refs.related') return { ok: false, code: 'invalid_asset_id' };
      return {};
    });
    await instance.ready;
    const html = sectionBody(3);
    expect((html.match(/ui-empty-state/g) || []).length).toBe(1);
    expect(html).toContain('资产标识不合法');
    expect(sectionBody(0)).toContain('发布检查单 · v2');
    instance.destroy();
  });
});

// ── T051：关联建议 + 点了才建立（specs/013 · US-505）──────────────────────────

/** 关联建议清单（contracts/ipc.md §1.5 返回体形态：只有标识与摘要，无正文）。 */
const RELATED = [
  {
    docId: 'meetings/9.01周会.txt', title: '9.01周会.txt', conclusionId: 'mc_901',
    summary: '发布流程要先过检查单', assetIds: ['a_1'], matchedBy: 'asset',
  },
  {
    docId: 'meetings/9.08周会.txt', title: '9.08周会.txt', conclusionId: 'mc_908',
    summary: '术语统一叫 Cogseed', assetIds: ['a_3'], matchedBy: 'term',
  },
];

/** 带关联建议的面板（记录全部通道调用，供「点了才建立」断言）。 */
function mountPanelWithRelated() {
  const calls: Array<{ channel: string; payload: any }> = [];
  const env = mountPanelWithData(async (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === 'meeting.assets.list') return { ok: true, refs: REF_VIEWS };
    if (channel === 'meeting.conclusions.list') return { ok: true, conclusions: CONCLUSIONS };
    if (channel === 'meeting.actions.list') return { ok: true, drafts: DRAFTS };
    if (channel === 'meeting.refs.related') return { ok: true, related: RELATED };
    return { ok: true };
  });
  return { ...env, calls };
}

describe('T051 关联建议：列表渲染 + 点了才建立', () => {
  it('① 列表渲染：哪场会/哪条结论/相关资产/命中方式；查询输入只用本会议已挂载引用', async () => {
    const { instance, sectionBody, calls } = mountPanelWithRelated();
    await instance.ready;
    // 查询 payload：docId + 本会议挂载资产的 assetIds 与标题快照 terms（确定性，无语义抽取）
    const relatedCall = calls.find((c) => c.channel === 'meeting.refs.related');
    expect(relatedCall.payload).toMatchObject({ docId: 'meetings/9.15站会.txt' });
    expect(relatedCall.payload.assetIds).toEqual(['a_1', 'a_2']);
    expect(relatedCall.payload.terms).toEqual(['发布检查单', '旧版资产']);
    // 列表内容（只有标识与摘要，不含资产正文）
    const html = sectionBody(3);
    expect((html.match(/data-mrf-related=/g) || []).length).toBe(2);
    expect(html).toContain('data-mrf-related-summary');
    expect(html).toContain('发布流程要先过检查单');
    expect(html).toContain('会议：9.01周会.txt');
    expect(html).toContain('相关资产：a_1');
    expect(html).toContain('按资产命中');
    expect(html).toContain('按术语命中');
    expect(html).toContain('引用到本会议');
    expect(html).not.toContain('ui-empty-state');
    instance.destroy();
  });

  it('② 不点按钮时零写入：全程无 meeting.assets.attach / meeting.conclusions.save 调用', async () => {
    const { instance, calls } = mountPanelWithRelated();
    await instance.ready;
    // 「上次提到」只呈现建议：加载与渲染阶段零写通道（引用包零变化）
    const writes = calls.filter((c) =>
      c.channel === 'meeting.assets.attach' || c.channel === 'meeting.conclusions.save');
    expect(writes).toHaveLength(0);
    instance.destroy();
  });

  it('③ 点了才建立：先 attach 每项相关资产，再把结论存进本会议（既有通道，不新建写口）', async () => {
    const { instance, fireClick, calls } = mountPanelWithRelated();
    await instance.ready;
    calls.length = 0;
    await fireClick('meeting-related-cite', 'meetings/9.01周会.txt::mc_901');
    const attaches = calls.filter((c) => c.channel === 'meeting.assets.attach');
    expect(attaches.map((c) => c.payload)).toEqual([
      { docId: 'meetings/9.15站会.txt', assetId: 'a_1', via: 'attach' },
    ]);
    const save = calls.find((c) => c.channel === 'meeting.conclusions.save');
    expect(save.payload.docId).toBe('meetings/9.15站会.txt');
    expect(save.payload.conclusion).toMatchObject({
      summary: '发布流程要先过检查单',
      assetRefs: ['a_1'],
    });
    instance.destroy();
  });

  it('④ 建立失败按码翻四语（不弹错误框、不静默）', async () => {
    const nodes = new Map<string, any>();
    const container = fakeElement();
    container.querySelector = (selector: string) => {
      if (!nodes.has(selector)) nodes.set(selector, fakeElement());
      return nodes.get(selector);
    };
    const clicks: Array<(event: unknown) => void> = [];
    container.addEventListener = (name: string, fn: (event: unknown) => void) => {
      if (name === 'click') clicks.push(fn);
    };
    container.removeEventListener = () => {};
    const loaded = loadModule({
      cogseed: {
        invoke: async (channel: string) => {
          if (channel === 'meeting.assets.list') return { ok: true, refs: REF_VIEWS };
          if (channel === 'meeting.conclusions.list') return { ok: true, conclusions: [] };
          if (channel === 'meeting.actions.list') return { ok: true, drafts: [] };
          if (channel === 'meeting.refs.related') return { ok: true, related: RELATED };
          if (channel === 'meeting.assets.attach') return { ok: false, code: 'asset_inactive' };
          return { ok: true };
        },
      },
      uiButton: (o: any) => `<button type="button" class="ui-button" data-act="${o?.attrs?.['data-act'] || ''}" data-mrf-id="${o?.attrs?.['data-mrf-id'] || ''}">${String(o?.label || '')}</button>`,
      uiTag: (o: any) => `<span class="ui-tag">${String(o?.label || '')}</span>`,
    });
    const instance = loaded.windowMock.KbMeetingRefs.mount(container, {
      docId: 'meetings/9.15站会.txt',
      displayPath: 'meetings/9.15站会.txt',
    });
    await instance.ready;
    for (const handler of clicks) {
      handler({
        target: {
          closest: () => ({
            getAttribute: (key: string) => (key === 'data-act' ? 'meeting-related-cite' : key === 'data-mrf-id' ? 'meetings/9.01周会.txt::mc_901' : ''),
          }),
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = nodes.get('[data-mrf-status]');
    expect(status._text).toContain('该资产已归档或暂停');
    instance.destroy();
  });
});
