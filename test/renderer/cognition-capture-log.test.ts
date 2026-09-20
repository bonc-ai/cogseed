/**
 * 认知资产重构后（2026-09-15 全模块收敛为 3 tab）的页面级用例。
 *
 * 新信息架构：待我处理（决策中心：候选+来源异常下钻+整理失败入口）/
 * 我的认知（树+资产明细，详情含使用记录）/整理（任务流+策略抽屉）。
 * 这里把**真实的 views.js + vocabulary.js + ui-button.js** require 进来跑
 * （与 cognition-pages.test.ts 同一模式）：stub 只负责 window 契约，断言
 * 落在渲染产出的 HTML 上。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(__dirname, '../..');
const viewsSource = readFileSync(resolve(rootDir, 'src/renderer/modules/cognition-assets/views.js'), 'utf8');
const appSource = readFileSync(resolve(rootDir, 'src/renderer/modules/cognition-assets/app.js'), 'utf8');
const coreSource = readFileSync(resolve(rootDir, 'src/renderer/modules/cognition-assets/core.js'), 'utf8');

const esc = (value: string) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const T = (key: string, fallback: string, vars?: Record<string, string>) => {
  let text = fallback != null ? fallback : key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v));
  return text;
};

const globalScope = globalThis as unknown as Record<string, unknown>;

/** 模块级装配：views.js 是 IIFE，require 只执行一次并把 render 挂在
 *  window.CogAssets 上；此后每次断言只改 store 再重画（与真实页面同构）。 */
let cogAssets: Record<string, unknown> | null = null;
let domRoot: { innerHTML: string } | null = null;
function ensureModule(): { cogAssets: Record<string, unknown>; domRoot: { innerHTML: string } } {
  if (cogAssets && domRoot) return { cogAssets, domRoot };
  cogAssets = {
    T, esc, fmtDate: () => '2026/09/15 10:00',
    TABS: [
      { id: 'review', titleKey: 'cognition.tab_review', title: '待我处理' },
      { id: 'overview', titleKey: 'cognition.tab_overview', title: '我的认知' },
      { id: 'organize', titleKey: 'cognition.tab_organize', title: '整理' },
    ],
    // stats 从 store 动态算（口径同 core.js）：attention 行的断言依赖它。
    stats: () => {
      const store = (cogAssets as Record<string, unknown>).store as Record<string, unknown>;
      const sourceIssues = ((store.sources as Array<{ items?: Array<{ kind?: string; status?: string; statusReason?: string }> }> | undefined) || [])
        .flatMap((group) => (Array.isArray(group.items) ? group.items : []))
        .filter((item) => String(item.kind || '') !== 'execution_evaluation'
          && (item.status === 'failed'
            || (item.status === 'paused' && String(item.statusReason || '') !== 'source_paused'))).length;
      const failedTasks = Number(((store.captureCounts as { failed?: number } | undefined) || {}).failed || 0);
      return {
        confirmed: 0, pending: 0, validated: 0, transferOk: 0,
        sourceIssues, failedTasks, coveredAssets: 0, proofCount: 0, attention: 0,
      };
    },
    store: {
      loaded: true, loading: false, errors: [],
      route: { name: 'overview', category: '', assetId: '', candidateId: '', proofEventId: '', captureBucket: '', captureId: '', sourceIssueOpen: '' },
      captures: [], captureSettings: null,
      sources: [], proofs: [], assets: [], candidates: [],
      organizeSettingsOpen: false, organizeListExpanded: true,
    },
  };
  domRoot = { innerHTML: '' };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { uiInput, uiSwitch, uiTextarea } = require('../../src/renderer/modules/ui-form.js');
  const { uiEmptyState } = require('../../src/renderer/modules/ui-empty.js');
  globalScope.window = {
    CogAssets: cogAssets,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    uiButton: require('../../src/renderer/modules/ui-button.js').uiButton,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    uiIconButton: require('../../src/renderer/modules/ui-button.js').uiIconButton,
    // icons.js 是 IIFE 挂全局（无 CJS 导出）：先 require 触发挂载到 globalThis，
    // 再取引用给 window stub（views.js 运行时读 window.uiIconHtml）。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    uiIconHtml: (() => { require('../../src/renderer/modules/icons.js'); return (globalThis as unknown as Record<string, unknown>).uiIconHtml; })(),
    uiInput,
    uiSwitch,
    uiTextarea,
    uiEmptyState,
  };
  globalScope.document = { getElementById: () => domRoot };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/vocabulary.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/views.js');
  return { cogAssets, domRoot };
}

function renderPage(routeName: string, storePatch: Record<string, unknown>, routePatch: Record<string, unknown> = {}): string {
  const { cogAssets: NS, domRoot: rootEl } = ensureModule();
  const store = NS.store as Record<string, unknown>;
  Object.assign(store, storePatch);
  store.route = { name: routeName, category: '', assetId: '', candidateId: '', proofEventId: '', captureBucket: '', captureId: '', sourceIssueOpen: '', ...routePatch };
  rootEl.innerHTML = '';
  (NS.render as () => void)();
  return rootEl.innerHTML;
}

const conversationSources = [{
  kind: 'conversation',
  items: [
    { id: 'conv-1', kind: 'conversation', title: 'Saying hello', updatedAt: '2026-09-15T02:00:00.000Z' },
    { id: 'conv-2', kind: 'conversation', title: 'design-review 技能用途', updatedAt: '2026-09-14T02:00:00.000Z' },
    { id: 'conv-3', kind: 'conversation', title: '查询可用的skills列表', updatedAt: '2026-09-13T02:00:00.000Z' },
    { id: 'conv-4', kind: 'conversation', title: '会议纪要模板讨论', updatedAt: '2026-09-12T02:00:00.000Z' },
    { id: 'conv-5', kind: 'conversation', title: '季度目标对齐', updatedAt: '2026-09-11T02:00:00.000Z' },
  ],
}];

const organizingCapture = {
  id: 'rcap-org', conversationId: 'conv-2', visibility: 'visible',
  conversationTitle: 'design-review 技能用途',
  status: 'extracting', bucket: 'active', displayStatus: 'extracting',
  displayReason: 'extracting', stage: 'model_extraction',
  actions: ['pause', 'cancel', 'open_conversation'],
  reviewSummary: { total: 0, pending: 0, deferred: 0, promoted: 0, rejected: 0, missing: 0 },
  updatedAt: '2026-09-15T03:00:00.000Z',
};
const failedCapture = {
  ...organizingCapture,
  id: 'rcap-fail', conversationId: 'conv-3', conversationTitle: '查询可用的skills列表',
  status: 'failed', bucket: 'attention', displayStatus: 'failed',
  displayReason: 'capture_failed', actions: ['retry', 'cancel', 'open_conversation'],
};
const silentCapture = {
  ...organizingCapture,
  id: 'rcap-silent', conversationId: 'conv-1', visibility: 'internal',
  conversationTitle: 'Saying hello',
  status: 'no_candidate', bucket: 'done', displayStatus: 'completed',
  displayReason: 'no_candidate', actions: ['open_conversation'],
};
const waitingCapture = {
  ...organizingCapture,
  id: 'rcap-wait', conversationId: 'conv-4', conversationTitle: '会议纪要模板讨论',
  status: 'waiting_manual', bucket: 'attention', displayStatus: 'waiting',
  displayReason: 'manual_start_required', actions: ['run_now', 'pause', 'cancel', 'open_conversation'],
};

const detailCapture = {
  ...organizingCapture,
  id: 'rcap-x', conversationId: 'conv-1', conversationTitle: 'Saying hello',
  attempt: 2, durationMs: 65_000,
  modelUsage: { totalTokens: 1234 },
  createdAt: '2026-09-15T01:00:00.000Z',
  startedAt: '2026-09-15T01:00:05.000Z',
  reviewSummary: { total: 3, pending: 2, deferred: 0, promoted: 1, rejected: 0, missing: 0 },
  confirmedAssetReceipts: [{ assetId: 'aa-1', assetType: 'rule', version: '1', scope: 'general', sourceRefCount: 2, reviewDecisionId: 'rd_1' }],
};

describe('信息架构：3 tab 收敛', () => {
  it('旧六视图已删净，新视图 + 设置页 + 异常下钻组件存在', () => {
    expect(coreSource).toContain("{ id: 'organize', titleKey: 'cognition.tab_organize'");
    // 两线不拆 tab（2026-09-17 二次定调）：TABS 回三 tab，KSTAR 以徽章+筛选档出现。
    expect(coreSource).not.toContain("id: 'kstar-assets'");
    expect(coreSource.match(/id: '(evidence|experiences|organize-history|capture-log|manage)'/g)).toBeNull();
    for (const gone of ['function viewManage', 'function viewSourcesOverview', 'function viewSourceDetail', 'function viewExperiences', 'function viewOrganizeHistory', 'function viewCaptureLog', 'function organizeSettingsDrawer']) {
      expect(viewsSource, gone).not.toContain(gone);
    }
    expect(viewsSource).toContain('function viewOrganizeTasks');
    expect(viewsSource).toContain('function viewOrganizeSettingsPage');
    expect(viewsSource).toContain('function sourceIssuesSection');
  });

  it('旧路由/委托 case 已收敛，齿轮入口与设置页分流存在', () => {
    expect(appSource).not.toContain("case 'manage-tab'");
    expect(appSource).not.toContain("case 'go-sources'");
    expect(appSource).not.toContain("case 'open-evidence'");
    expect(appSource).not.toContain("case 'toggle-organize-settings'");
    expect(appSource).toContain("case 'toggle-source-issues'");
    expect(appSource).toContain("case 'go-organize-settings'");
    expect(appSource).toContain("router.go({ name: 'organize-settings' })");
    expect(viewsSource).toContain('data-cognition-page-link="captures"');
  });

  it('树：经验块移除、土壤落点为待我处理、冠回资产明细', () => {
    expect(viewsSource).not.toContain('go-experiences');
    expect(viewsSource).not.toContain('tree_soil_experience');
    const html = renderPage('overview', { sources: [], assets: [], proofs: [], candidates: [], captures: [] });
    expect(html).toContain('data-act="go-review"');
    expect(html).toContain('data-act="open-ontology"');
    expect(html).toContain('data-act="open-overview"');
  });
});

describe('整理页（任务流 + 策略抽屉）', () => {
  const baseStore = {
    sources: conversationSources,
    captures: [organizingCapture, failedCapture, silentCapture, waitingCapture],
    captureSettings: { enabled: true, executionPolicy: 'smart', reviewPolicy: 'auto' },
  };

  it('页首只留齿轮入口（共享 uiIconButton），抽屉退役', () => {
    const html = renderPage('organize', baseStore);
    // 走共享组件体系（2026-09-15 团队规范）：ui-icon-button + icons.js 的
    // settings 图标，不再有手写 SVG 孤例。
    expect(html).toContain('ui-icon-button');
    expect(html).toContain('data-act="go-organize-settings"');
    expect(html).toContain('is-settings');
    expect(html).not.toContain('<svg width="18"');
    expect(html).not.toContain('ca-drawer');
    expect(html).not.toContain('toggle-organize-settings');
    // 位置：齿轮在 hero 区、位于筛选行之前。
    expect(html.indexOf('go-organize-settings')).toBeLessThan(html.indexOf('data-act="capture-filter"'));
  });

  it('共享图标统一：chevron-right 替代 › 字符、circle 替代 ◎（icons.js 真渲染）', () => {
    const list = renderPage('overview', { assets: [{ id: 'aa-1', title: '上线前确认', type: 'rule', status: 'active' }], sources: [], proofs: [] });
    expect(list).toContain('is-chevron-right');
    const emptyHtml = renderPage('overview', { assets: [], sources: [], proofs: [], candidates: [] });
    expect(emptyHtml).toContain('is-circle');
  });

  it('认知树骨架说明：浅灰一行（先骨架后打磨 + 因现阶段仅内部学员使用故展示，对外版本不出现）', () => {
    const html = renderPage('overview', { assets: [], sources: [], proofs: [], candidates: [] });
    expect(html).toContain('ca-tree-wip');
    expect(html).toContain('开发中的骨架');
    expect(html).toContain('先搭出可点的骨架');
    expect(html).toContain('现阶段仅内部学员使用');
    expect(html).toContain('正式对外版本中不会出现');
    // cap 修正：候选圆点在树根（不再是与图形脱节的"枝头小点"）。
    expect(html).toContain('树根上的圆点');
    expect(html).not.toContain('枝头的小点');
  });

  it('沉淀设置页：夜间自动沉淀条状卡（左说明/中时间/右开关）与迁入的设置卡', () => {
    const off = renderPage('organize-settings', { captureSettings: { enabled: true, executionPolicy: 'manual', reviewPolicy: 'manual', nightlyStart: '02:00' } });
    expect(off).toContain('沉淀设置');
    expect(off).toContain('夜间自动沉淀');
    expect(off).toContain('等你批准或调整');
    // 关闭态：开关未亮、无时间选择器。
    expect(off).toContain('data-act="nightly-toggle"');
    expect(off).toContain('class="ui-switch" role="switch" aria-checked="false"');
    expect(off).not.toContain('type="time"');

    const on = renderPage('organize-settings', { captureSettings: { enabled: true, executionPolicy: 'nightly', reviewPolicy: 'manual', nightlyStart: '02:30' } });
    // 开启态：开关亮、时间选择器出现且带当前值。
    expect(on).toContain('class="ui-switch is-on" role="switch" aria-checked="true"');
    expect(on).toContain('type="time"');
    expect(on).toContain('value="02:30"');
    expect(on).toContain('开始时间');
    // 迁入的整理功能开关与候选确认方式。
    expect(on).toContain('data-act="capture-toggle"');
    expect(on).toContain('data-act="capture-review-toggle"');
  });

  it('整理中的条目置顶、按钮变「整理中」且禁用；失败出状态 chip', () => {
    const html = renderPage('organize', baseStore);
    const top = html.indexOf('design-review 技能用途');
    const plain = html.indexOf('季度目标对齐');
    expect(top).toBeGreaterThan(-1);
    expect(plain).toBeGreaterThan(top);
    expect(html).toContain('整理中');
    expect(html).toContain('is-disabled');
    expect(html).toContain('>失败</span>');
  });

  it('等待手动开始不再是「整理中」：显示等待 chip + 行内直达「立即整理」按钮', () => {
    const html = renderPage('organize', baseStore);
    // waiting_manual 行（conv-4）：等待态 chip + run_now 按钮，且该行无禁用钮。
    const waitAt = html.indexOf('rcap-wait');
    expect(waitAt).toBeGreaterThan(-1);
    expect(html).toContain('data-id="rcap-wait" data-action="run_now"');
    expect(html).toContain('等你手动开始整理');
    // 行内不再有两个「整理中」：只有 extracting 的那一条显示整理中。
    expect((html.match(/is-disabled/g) || []).length).toBe(1);
  });

  it('有任务条目点标题进详情；无任务条目保留「开始整理」', () => {
    const html = renderPage('organize', baseStore);
    expect(html).toContain('data-act="open-capture-detail" data-id="rcap-org"');
    expect(html).toContain('data-act="organize-conv" data-id="conv-5"');
  });

  it('筛选 chip 四枚带计数；attention 只留需要处理、done 命中无留存内容（口径与行一致）', () => {
    const html = renderPage('organize', baseStore);
    const chips = [...html.matchAll(/data-act="capture-filter"/g)].length;
    expect(chips).toBe(4);
    // 「全部」= 列表行数（4 个有任务会话 + conv-5 无任务行），2026-09-16 起与行同口径。
    expect(html).toContain('全部 5');

    const filtered = renderPage('organize', baseStore, { captureBucket: 'attention' });
    expect(filtered).toContain('rcap-fail');
    expect(filtered).not.toContain('data-id="conv-1"');
    expect(filtered).not.toContain('data-id="conv-5"');

    // 2026-09-15 口径修复：无留存内容的行显示「已完成」，必须能在
    // 「已完成」筛选下出现（此前 bucket=silent 导致筛选恒空）。
    const doneFiltered = renderPage('organize', baseStore, { captureBucket: 'done' });
    expect(doneFiltered).toContain('rcap-silent');
    expect(doneFiltered).toContain('整理过，没有发现值得留存的内容');
  });

  it('chip 计数与列表行同口径：同一会话多条整理记录只计 1 行（2026-09-16 修复）', () => {
    // 真实事故形态：会话被整理过多次（失败重试/夜间多轮），后端 buckets 按
    // 记录数计数，列表却每会话只显示最相关一条——修复前 chip 显示「需要我
    // 处理 4」而列表只有 2 行，数字与内容对不上。
    const store = {
      sources: [{
        kind: 'conversation',
        items: [
          { id: 'conv-a', kind: 'conversation', title: '关于我的了解程度', updatedAt: '2026-09-15T02:00:00.000Z' },
          { id: 'conv-b', kind: 'conversation', title: '别的会话', updatedAt: '2026-09-14T02:00:00.000Z' },
        ],
      }],
      captures: [
        { ...waitingCapture, id: 'w1', conversationId: 'conv-a', conversationTitle: '关于我的了解程度', updatedAt: '2026-09-15T04:00:00.000Z' },
        { ...waitingCapture, id: 'w2', conversationId: 'conv-a', conversationTitle: '关于我的了解程度', updatedAt: '2026-09-15T03:00:00.000Z' },
        { ...waitingCapture, id: 'w3', conversationId: 'conv-a', conversationTitle: '关于我的了解程度', updatedAt: '2026-09-15T02:00:00.000Z' },
        { ...failedCapture, id: 'f1', conversationId: 'conv-b', conversationTitle: '别的会话' },
      ],
      captureSettings: baseStore.captureSettings,
    };
    const html = renderPage('organize', store);
    // 行口径：conv-a 三条记录去重成 1 行 + conv-b 1 行 = 2。
    expect(html).toContain('需要我处理 2');
    expect(html).not.toContain('需要我处理 4');
    // 「全部」数列表行数（含无任务行），不再是四桶记录之和。
    expect(html).toContain('全部 2');
    // 筛选后可见行数与 chip 一致。
    const filtered = renderPage('organize', store, { captureBucket: 'attention' });
    expect((filtered.match(/data-act="open-capture-detail"/g) || []).length).toBe(2);
  });

  it('筛选态行数超过收拢上限也出「查看全部」按钮（2026-09-16：chip 数字必须能被看到）', () => {
    // 真实数据形态：已完成 8 行 > 收拢上限 5。此前展开按钮被
    // `!route.captureBucket` 排除在筛选态外——chip 显示 8、列表只铺 5 行
    // 且无法展开，数字与可见内容对不上。
    const manyDone = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      ...silentCapture,
      id: `done-${n}`,
      conversationId: `conv-done-${n}`,
      conversationTitle: `已完成的会话 ${n}`,
      updatedAt: `2026-09-${String(10 + n).padStart(2, '0')}T02:00:00.000Z`,
    }));
    const store = {
      sources: [{
        kind: 'conversation',
        items: manyDone.map((c) => ({ id: c.conversationId, kind: 'conversation', title: c.conversationTitle, updatedAt: c.updatedAt })),
      }],
      captures: manyDone,
      organizeListExpanded: false,
      captureSettings: baseStore.captureSettings,
    };
    const html = renderPage('organize', store, { captureBucket: 'done' });
    expect(html).toContain('已完成 8');
    // 收拢只铺 5 行，但必须有出口看到剩下 3 行（数字用筛选后行数）。
    expect(html).toContain('查看全部 8 个会话');
    expect(html.match(/ca-row is-flat/g)?.length).toBe(5);
    // 展开后 8 行全铺。
    const expanded = renderPage('organize', { ...store, organizeListExpanded: true }, { captureBucket: 'done' });
    expect(expanded.match(/ca-row is-flat/g)?.length).toBe(8);
    expect(expanded).toContain('收起');
  });

  it('「无需沉淀」分类：寒暄优先归类（含整理过的），全部含低价值行，行可点开内容（2026-09-16）', () => {
    const store = {
      sources: [{
        kind: 'conversation',
        items: [
          { id: 'conv-failed', kind: 'conversation', title: '没等到回复的会话', updatedAt: '2026-09-15T04:00:00.000Z', lastTurnFailed: true },
          { id: 'conv-chat', kind: 'conversation', title: '打个招呼', updatedAt: '2026-09-15T03:00:00.000Z', chatLike: true },
          { id: 'conv-real', kind: 'conversation', title: '正经工作', updatedAt: '2026-09-15T02:00:00.000Z' },
          { id: 'conv-chat-tasked', kind: 'conversation', title: '整理过的寒暄', updatedAt: '2026-09-15T01:00:00.000Z', chatLike: true },
        ],
      }],
      captures: [{ ...silentCapture, id: 'rcap-chatted', conversationId: 'conv-chat-tasked', conversationTitle: '整理过的寒暄' }],
      captureSettings: baseStore.captureSettings,
    };
    // 「全部」含低价值行（2026-09-16 子安口径）：默认视图展示所有会话。
    const html = renderPage('organize', store);
    expect(html).toContain('全部 4');
    expect(html).toContain('无需沉淀 3');
    expect(html).toContain('没等到回复的会话');
    expect(html).toContain('正经工作');
    // 任务三桶只数正常行：寒暄任务行（原本进已完成）移入无需沉淀。
    expect(html).toContain('已完成 0');

    // 低价值无任务行：标题可点回看内容，「开始整理」位置提示「无需整理」。
    expect(html).toContain('data-act="open-conversation" data-id="conv-failed"');
    expect(html).toContain('data-act="open-conversation" data-id="conv-chat"');
    expect(html).toContain('未得到回复');
    expect(html).toContain('纯寒暄');
    expect(html).toContain('无需整理');
    expect(html).not.toContain('data-act="organize-conv" data-id="conv-failed"');
    expect(html).not.toContain('data-act="organize-conv" data-id="conv-chat"');
    // 正常无任务行保留「开始整理」（捞回通道在正常行上）。
    expect(html).toContain('data-act="organize-conv" data-id="conv-real"');

    // 筛选视图：寒暄优先——整理过的寒暄行也从「已完成」移到这里。
    const excluded = renderPage('organize', store, { captureBucket: 'excluded' });
    expect((excluded.match(/ca-row is-flat/g) || []).length).toBe(3);
    expect(excluded).toContain('整理过的寒暄');
    expect(excluded).not.toContain('正经工作');
    const doneFiltered = renderPage('organize', store, { captureBucket: 'done' });
    expect(doneFiltered).not.toContain('整理过的寒暄');
  });

  it('消息级溯源项（subtype:message）不混进整理任务流（2026-09-16 真机抓出 msg- 哈希行）', () => {
    // sources 组里除会话级（subtype:session）项外还有消息级溯源项——它的 id
    // 是 msg- 哈希、没有会话标题，只供证据 chip 解析；混进任务流会显示成
    // 「msg-xxx + 开始整理」且不属于任何筛选桶。真机形态：后端 limit 默认
    // 25，会话不足时用消息项补足（14 会话 + 11 消息项 = 25 行）。
    const store = {
      ...baseStore,
      sources: [{
        kind: 'conversation',
        items: [
          { id: 'conv-a', kind: 'conversation', subtype: 'session', title: '真实会话', updatedAt: '2026-09-15T02:00:00.000Z' },
          { id: 'msg-de01145145dc9f9b355a73b6', kind: 'conversation', subtype: 'message', sourceVersion: '2026-09-15T01:00:00.000Z' },
          { id: 'msg-5dfab3464124da9847ab5cff', kind: 'conversation', subtype: 'message', sourceVersion: '2026-09-15T00:00:00.000Z' },
        ],
      }],
      captures: [],
    };
    const html = renderPage('organize', store);
    expect(html).toContain('真实会话');
    expect(html).not.toContain('msg-de0114');
    expect(html).not.toContain('msg-5dfab3');
    // 计数只数会话行。
    expect(html).toContain('全部 1');
    expect((html.match(/data-act="organize-conv"/g) || []).length).toBe(1);
  });

  it('来源拉满上限时提示「仅显示最近 100 个会话」（2026-09-16 C1：静默丢行不可接受）', () => {
    // 审计 C1：渲染层此前不传 limit（后端默认 25），第 26 个会话起静默丢失。
    // 修复=显式传 limit:100（IPC 上限）+ 满额时提示，不再无声截断。
    expect(coreSource).toContain("'recall.sources.list', { limit: 100 }");
    const full = {
      kind: 'conversation',
      items: Array.from({ length: 100 }, (_, n) => ({
        id: `conv-${n}`, kind: 'conversation', subtype: 'session',
        title: `会话 ${n}`, updatedAt: `2026-09-01T00:00:00.000Z`,
      })),
    };
    const html = renderPage('organize', { ...baseStore, sources: [full] });
    expect(html).toContain('仅显示最近 100 个会话');
    // 未满额不提示。
    const partial = renderPage('organize', {
      ...baseStore,
      sources: [{ kind: 'conversation', items: full.items.slice(0, 99) }],
    });
    expect(partial).not.toContain('仅显示最近 100 个会话');
  });

  it('「等待确认」口径统一（2026-09-16 B1）：deferred 可见但不占数，带「已稍后处理」标注', () => {
    // 审计 B1：三套口径曾同时给出 7/5/0。统一为「需要判断且未被稍后处理
    // 静音」——统计卡/全局 stats 同函数；deferred 行留在列表（子安口径）。
    expect(coreSource).toContain('countsAsPending && !');
    expect(coreSource).toContain('isSnoozed');
    const mk = (id, status, snoozed) => ({
      id, status, suggestedType: 'rule',
      judgment: '一条足够长的候选判断正文内容。', summary: `标题-${id}`,
      capabilities: { canEdit: true, canPromote: true, countsAsPending: true, isSnoozed: snoozed },
    });
    const html = renderPage('review', {
      sources: [conversationSources[0]],
      candidates: [mk('p1', 'pending_review', false), mk('d1', 'deferred', true)],
    });
    expect(html).toContain('<b>1</b><span>等待确认');
    expect(html).toContain('标题-d1');
    expect(html).toContain('已稍后处理');
    expect(html).not.toContain('<b>2</b><span>等待确认');
  });

  it('批量入口写死条数：重试失败（1）与立即整理（1）', () => {
    const html = renderPage('organize', baseStore);
    expect(html).toContain('重试失败（1）');
    expect(html).toContain('立即整理（1）');
    expect(html).toContain('data-batch="retry"');
    expect(html).toContain('data-batch="run_now"');
  });

  it('静默任务也如实显示（无留存内容）', () => {
    const html = renderPage('organize', baseStore);
    expect(html).toContain('整理过，没有发现值得留存的内容');
  });

  it('旧主进程字段缺席时兜底：无 bucket 字段的行仍按状态显示「整理中」，计数走前端现算', () => {
    // 版本错配场景（2026-09-15 实测事故）：主进程旧代码不返回 bucket/buckets，
    // 前端不能因此显示全 0 计数或把「整理中」退化成「等待中」。
    const legacyCapture = {
      ...organizingCapture,
      bucket: undefined,
      // 旧的 displayStatus 语义保留，行仍有态。
      displayStatus: 'extracting',
    };
    const html = renderPage('organize', {
      sources: conversationSources,
      captures: [legacyCapture],
      captureSettings: { enabled: true, executionPolicy: 'smart', reviewPolicy: 'auto' },
    });
    expect(html).toContain('整理中');
    // 计数恒为行口径现算（2026-09-16 起不读后端 buckets，版本错配天然免疫）：
    // 1 行 active。
    expect(html).toContain('进行中 1');
    // 列表行 = 5 个会话（1 有任务 + 4 无任务行）。
    expect(html).toContain('全部 5');
  });

  it('简单对话不再被隐藏：带寒暄标记的进「无需沉淀」，无标记的留在主列表（宁漏勿误伤）', () => {
    // 2026-09-16 起 messageCount 前端隐藏过滤退役：低价值判定由后端
    // chatLike/lastTurnFailed 打标（见 source-catalog），前端不猜。
    const store = {
      ...baseStore,
      sources: [{
        kind: 'conversation',
        items: [
          { id: 'conv-full', kind: 'conversation', title: '完整的多轮会话', updatedAt: '2026-09-15T02:00:00.000Z', messageCount: 8 },
          { id: 'conv-tiny', kind: 'conversation', title: '打个招呼而已', updatedAt: '2026-09-14T02:00:00.000Z', messageCount: 2, chatLike: true },
          { id: 'conv-none', kind: 'conversation', title: '还没得到回复', updatedAt: '2026-09-13T02:00:00.000Z', messageCount: 1 },
        ],
      }],
      captures: [silentCapture],
    };
    // silentCapture 属 conv-1——不在本组数据里，无干扰。
    const html = renderPage('organize', store);
    expect(html).toContain('完整的多轮会话');
    // 无标记的简单对话留在主列表：判定信号来自后端，不由 messageCount 猜。
    expect(html).toContain('还没得到回复');
    // 「全部」含低价值行（2026-09-16 口径）：3 个会话全展示。
    expect(html).toContain('全部 3');
    expect(html).toContain('无需沉淀 1');
    expect(html).toContain('打个招呼而已');
    const excluded = renderPage('organize', store, { captureBucket: 'excluded' });
    expect(excluded).toContain('打个招呼而已');
    expect(excluded).not.toContain('完整的多轮会话');

    // 有任务的简单对话照常显示（整理中的条目不能凭空消失）。
    const tinyWithTask = {
      sources: [{
        kind: 'conversation',
        items: [
          { id: 'conv-tiny', kind: 'conversation', title: '打个招呼而已', updatedAt: '2026-09-15T02:00:00.000Z', messageCount: 2 },
        ],
      }],
      captures: [{ ...organizingCapture, conversationId: 'conv-tiny', conversationTitle: '打个招呼而已' }],
      captureSettings: baseStore.captureSettings,
    };
    const withTask = renderPage('organize', tinyWithTask);
    expect(withTask).toContain('打个招呼而已');
    expect(withTask).toContain('整理中');
  });
});

describe('整理详情页', () => {
  it('展示状态、当前步骤、时间与用量，动作与打开会话/返回齐备', () => {
    const html = renderPage('organize', { captures: [detailCapture], sources: [] }, { captureId: 'rcap-x' });
    expect(html).toContain('Saying hello');
    expect(html).toContain('正在提炼候选');
    expect(html).toContain('模型提炼中');
    expect(html).toContain('1 分 5 秒');
    expect(html).toContain('1234 tokens');
    expect(html).toContain('data-action="pause"');
    expect(html).toContain('data-act="open-conversation" data-id="conv-1"');
    expect(html).toContain('data-act="go-back"');
  });

  it('整理过程五步进度条：stage 高亮当前步、已过步打勾', () => {
    const html = renderPage('organize', { captures: [detailCapture], sources: [] }, { captureId: 'rcap-x' });
    expect(html).toContain('ca-steps-bar');
    expect(html).toContain('ca-step is-current">模型提炼中');
    expect(html).toContain('ca-step is-done">读取会话内容');
    expect((html.match(/ca-step(?!s)/g) || []).length).toBeGreaterThanOrEqual(5);
    // 非提炼期（无 stage）不显示进度条。
    const idle = renderPage('organize', {
      captures: [{ ...detailCapture, stage: undefined, status: 'waiting_manual', displayStatus: 'waiting' }],
      sources: [],
    }, { captureId: 'rcap-x' });
    expect(idle).not.toContain('ca-steps-bar');
  });

  it('已沉淀资产并入整合卡并内联完整正文：不靠跳转就能看到沉淀了什么', () => {
    const html = renderPage(
      'organize',
      { captures: [detailCapture], sources: [], assets: [{ id: 'aa-1', title: '上线前必须确认影响范围', type: 'rule', status: 'active', statement: '上线前必须确认影响范围：用真实日志分层归因，不允许拍脑袋给结论。' }] },
      { captureId: 'rcap-x' },
    );
    expect(html).toContain('已沉淀资产');
    expect(html).toContain('上线前必须确认影响范围');
    // 沉淀的具体内容直接展示（statement 内联），而非只有跳转按钮。
    expect(html).toContain('用真实日志分层归因，不允许拍脑袋给结论。');
    expect(html).toContain('data-act="open-asset" data-id="aa-1"');
    // 合并：资产区随整合卡渲染，页面卡片数从 4 降为 3（结果/上下文/整合卡），
    // 不再有独立的资产卡。
    expect((html.match(/class="ca-card[ ">]/g) || []).length).toBe(3);
    // 卡头不再出「查看资产」主按钮（明细已在卡内，与 review_candidates 同规则过滤）。
    expect(html).not.toContain('data-action="view_assets"');
  });

  it('快照缺该资产（已删除）时退回类型·版本，不裸出内部 id', () => {
    const html = renderPage('organize', { captures: [detailCapture], sources: [], assets: [] }, { captureId: 'rcap-x' });
    expect(html).toContain('规则与偏好 · v1');
  });

  it('任务不存在时给兜底文案，不白屏', () => {
    const html = renderPage('organize', { captures: [], sources: [] }, { captureId: 'rcap-gone' });
    expect(html).toContain('这条整理任务不存在或已被清理');
  });

  // ── 2026-09-15 详情页改造：结果三态 + 对话上下文 + 证据映射 ──

  const contextData = {
    captureId: 'rcap-x',
    conversationId: 'conv-1',
    conversationTitle: 'Saying hello',
    participants: [
      { id: 'user', name: 'user', kind: 'user' },
      { id: 'commander', name: 'commander', kind: 'commander' },
      { id: 'worker-a', name: '代码评审员', kind: 'agent' },
    ],
    messages: [
      { id: 'msg-1', label: 'm1', ts: '2026-09-15T01:00:00.000Z', role: 'user', from: 'user', to: [], text: '帮我把上线前的检查做成清单。', truncated: false, artifacts: [], sourceId: 'msg-aaa' },
      { id: 'msg-2', label: 'm2', ts: '2026-09-15T01:01:00.000Z', role: 'assistant', from: 'commander', to: ['user'], text: '已生成上线检查清单，包含 12 项。', truncated: false, artifacts: [{ id: 'art-1', title: '上线检查清单' }], sourceId: 'msg-bbb' },
      { id: 'msg-3', label: 'm3', ts: '2026-09-15T01:02:00.000Z', role: 'assistant', from: 'worker-a', to: ['user'], text: '第二条也补上了。', truncated: false, artifacts: [], sourceId: 'msg-ccc' },
    ],
  };
  const contextStore = { captureContext: { captureId: 'rcap-x', data: contextData } };

  it('未保存候选：完整内容块（判断全文 + 类型/作用域 + 证据映射），不再只剩一行标题', () => {
    const candidate = {
      id: 'rcand-1', status: 'rejected',
      judgment: '上线前必须确认影响范围再发布。', value: '', summary: '上线前确认影响范围',
      suggestedType: 'rule', suggestedScope: 'general',
      evidenceRefs: [{ id: 'msg-aaa' }, { id: 'msg-bbb' }],
    };
    const html = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: ['rcand-1'], status: 'completed', displayStatus: 'completed', displayReason: 'review_completed', confirmedAssetReceipts: [], reviewSummary: { total: 1, pending: 0, deferred: 0, promoted: 0, rejected: 1, missing: 0 } }],
      sources: [], candidates: [candidate],
      ...contextStore,
    }, { captureId: 'rcap-x' });
    expect(html).toContain('整理结果');
    // 完整内容块：判断全文（非截断标题）+ 类型 + 作用域 + 未保存标记。
    expect(html).toContain('ca-result-item');
    expect(html).toContain('上线前必须确认影响范围再发布。');
    expect(html).toContain('规则与偏好');
    expect(html).toContain('未保存');
    expect(html).toContain('来自消息 m1');
    // 卡头三态：已完成 · 未保存。
    expect(html).toContain('已完成 · 未保存');
    // 内容已内联，行级跳转入口移除。
    expect(html).not.toContain('data-act="open-candidate"');
  });

  it('已保存：卡头「已完成 · 已保存」，成果由已沉淀资产区代表', () => {
    const confirmed = {
      id: 'rcand-4', status: 'confirmed', promotedAssetId: 'aa-1',
      judgment: '接口变更要同步更新文档。', value: '', summary: '',
      suggestedType: 'template', suggestedScope: 'general',
      capabilities: { canEdit: false, canPromote: false, countsAsPending: false, isTerminal: true },
    };
    const html = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: ['rcand-4'], status: 'completed', displayStatus: 'completed', displayReason: 'review_completed', reviewSummary: { total: 1, pending: 0, deferred: 0, promoted: 1, rejected: 0, missing: 0 } }],
      sources: [], candidates: [confirmed],
      assets: [{ id: 'aa-1', title: '接口变更文档同步', type: 'template', status: 'active', statement: '接口变更后必须同步更新对应文档。' }],
      ...contextStore,
    }, { captureId: 'rcap-x' });
    expect(html).toContain('已完成 · 已保存');
    // 成果在已沉淀资产区（完整 statement 内联）。
    expect(html).toContain('已沉淀资产');
    expect(html).toContain('接口变更后必须同步更新对应文档。');
    // 结果区不重复列已保存候选。
    expect(html).not.toContain('接口变更要同步更新文档。');
  });

  it('待确认候选内嵌完整确认表单：类型/判断编辑/证据/保存并使用，不必跳「待我处理」', () => {
    const pending = {
      id: 'rcand-2', status: 'pending_review',
      judgment: '发布前先跑一遍冒烟清单。', value: '', summary: '发布前冒烟',
      suggestedType: 'skill_method', suggestedScope: 'general',
      evidenceRefs: [{ id: 'msg-aaa' }],
      capabilities: { canEdit: true, canPromote: true, canReject: true, countsAsPending: true, isSnoozed: false },
    };
    const html = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: ['rcand-2'], status: 'review_ready', displayStatus: 'review_ready', displayReason: 'review_pending' }],
      sources: [], candidates: [pending],
      ...contextStore,
    }, { captureId: 'rcap-x' });
    // 合并卡：表单块嵌在执行信息卡内部（ca-pending-embed），不是独立的卡。
    expect(html).toContain('ca-pending-embed');
    expect(html).not.toContain('ca-card ca-candidate-detail');
    expect(html).toContain('data-f="judgment"');
    expect(html).toContain('data-act="cand-type"');
    expect(html).toContain('data-act="cand-adopt-with-form" data-id="rcand-2"');
    expect(html).toContain('data-act="cand-decide"');
    expect(html).toContain('保存并使用');
    // 控件 id 带候选后缀（一页多卡不撞 id）。
    expect(html).toContain('ca-cand-judgment-rcand-2');
    // 整合排版（2026-09-15 重排）：状态/元信息/动作收进一行卡头（ca-capture-head
    // 内同层），表单作为主体在其下；不再是两块上下拼接。
    const headAt = html.indexOf('ca-capture-head');
    expect(headAt).toBeGreaterThan(-1);
    const headSection = html.slice(headAt, html.indexOf('ca-pending-embed'));
    expect(headSection).toContain('模型用量');
    expect(headSection).toContain('data-act="open-conversation"');
    expect(headSection).toContain('ca-meta-row');
    expect(headSection).toContain('ca-head-actions');
    // 元信息流式呈现（标签+值同 span），不再用 kv 网格。
    expect(html).toContain('ca-meta-item');
    expect(html).not.toContain('ca-kv');
    // 表单仍在卡头下方。
    expect(html.indexOf('ca-cand-judgment-rcand-2')).toBeGreaterThan(html.indexOf('模型用量'));
    expect(html.indexOf('ca-cand-judgment-rcand-2')).toBeGreaterThan(html.indexOf('data-act="open-conversation"'));
    // 去重：待确认候选不再在「整理结果」区重复列出，改为一行指引。
    expect(html).toContain('发现 1 条待确认内容');
    expect((html.match(/发布前先跑一遍冒烟清单。/g) || []).length).toBe(1);
    // 内嵌后详情页动作行不再出「去确认」跳转。
    expect(html).not.toContain('data-act="go-review"');
  });

  it('混合候选：待确认出表单块、未保存出完整内容块，两卡控件 id 不重复', () => {
    const pending = {
      id: 'rcand-2', status: 'pending_review',
      judgment: '发布前先跑一遍冒烟清单。', value: '', summary: '',
      suggestedType: 'rule', suggestedScope: 'general',
      capabilities: { canEdit: true, canPromote: true, countsAsPending: true, isSnoozed: false },
    };
    const rejected = {
      id: 'rcand-3', status: 'rejected',
      judgment: '接口变更要同步更新文档。', value: '', summary: '',
      suggestedType: 'template', suggestedScope: 'general',
      capabilities: { canEdit: false, canPromote: false, countsAsPending: false, isTerminal: true },
    };
    const html = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: ['rcand-2', 'rcand-3'], status: 'review_ready', displayStatus: 'review_ready' }],
      sources: [], candidates: [pending, rejected],
      ...contextStore,
    }, { captureId: 'rcap-x' });
    expect(html).toContain('ca-cand-judgment-rcand-2');
    expect(html).toContain('发现 1 条待确认内容');
    // 未保存候选：完整内容块（全文可见），没有第二份表单控件。
    expect(html).toContain('接口变更要同步更新文档。');
    expect(html).toContain('ca-result-item');
    expect(html).not.toContain('ca-cand-judgment-rcand-3');
    expect((html.match(/data-f="judgment"/g) || []).length).toBe(1);
  });

  it('确认表单三枚动作：保存并使用 / 稍后处理 / 拒绝（2026-09-16 补 defer 入口）', () => {
    // defer 链路（IPC/状态机/7 天冷却唤醒）早已存在，此前只缺表单按钮——
    // 用户在整理详情页看到内容后无法选"稍后处理"。
    const pending = {
      id: 'rcand-d', status: 'pending_review',
      judgment: '发布前先跑一遍冒烟清单。', value: '', summary: '发布前冒烟',
      suggestedType: 'skill_method', suggestedScope: 'general',
      capabilities: { canEdit: true, canPromote: true, canReject: true, canDefer: true, countsAsPending: true, isSnoozed: false },
    };
    const html = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: ['rcand-d'], status: 'review_ready', displayStatus: 'review_ready', displayReason: 'review_pending' }],
      sources: [], candidates: [pending],
      ...contextStore,
    }, { captureId: 'rcap-x' });
    expect(html).toContain('保存并使用');
    expect(html).toContain('data-id="rcand-d" data-action="defer"');
    expect(html).toContain('稍后处理');
    expect(html).toContain('data-id="rcand-d" data-action="reject"');
    // 顺序：保存在前、拒绝在后，稍后处理居中。
    expect(html.indexOf('data-action="defer"')).toBeGreaterThan(html.indexOf('cand-adopt-with-form'));
    expect(html.indexOf('data-action="reject"')).toBeGreaterThan(html.indexOf('data-action="defer"'));
  });

  it('候选卡标题优先用模型生成的 summary（2026-09-16：此前 judgment 截断优先，名字成了内容前缀）', () => {
    const mk = (over) => ({
      id: 'rcand-t', status: 'pending_review', suggestedType: 'rule', suggestedScope: 'general',
      capabilities: { canEdit: true, canPromote: true, countsAsPending: true, isSnoozed: false },
      ...over,
    });
    const review = (cands) => renderPage('review', { sources: [conversationSources[0]], candidates: cands });
    // summary 优先：列表行标题=模型短标题。
    const withSummary = review([mk({ judgment: '接口变更后必须同步更新文档，并在群里同步告知，同时留档到 wiki。', summary: '接口变更同步文档' })]);
    expect(withSummary).toContain('接口变更同步文档');
    // 无 summary 的存量候选：类别 + 判断前 12 字的克制兜底，不再裸截 60 字。
    const noSummary = review([mk({ judgment: '发布前先跑一遍冒烟清单，确认核心链路无回归再上线。', summary: '' })]);
    expect(noSummary).toContain('规则与偏好 · 发布前先跑一遍冒烟清');
    // 标题行不再包含判断的后半段（旧口径截 60 字会整段露出；内容区全文属正常）。
    expect(noSummary).not.toMatch(/ca-row-title[^>]*>[^<]*确认核心链路无回归/);
    // 两者皆空：未命名兜底。
    const empty = review([mk({ judgment: '', summary: '' })]);
    expect(empty).toContain('未命名候选');
  });

  it('「稍后处理」随界面语境分流（2026-09-16）：待我处理页静默回列表，整理页提示去向', () => {
    // 子安口径：人已在「待我处理」页时"已进入待处理"没有信息量，处理完
    // 这条直接回列表；整理详情页（内容确实被送走）才提示去向。
    expect(coreSource).toContain("if (action === 'defer')");
    expect(coreSource).toContain("=== 'review'");
    expect(coreSource).toContain("router.go({ name: 'review' })");
    expect(coreSource).toContain("cognition.candidate_deferred", '已进入待处理');
    expect(coreSource).not.toContain("defer: T('cognition.candidate_deferred'");
  });

  it('更新候选的差异确认卡：旧版对照 + 版本核对提示（2026-09-16 版本组）', () => {
    const target = {
      id: 'aa-t1', title: '接口变更同步文档', type: 'rule', status: 'active',
      scope: 'general', statement: '接口变更后必须同步更新对应文档，并在群里告知。', version: '2', activeVersion: '2',
    };
    const update = {
      id: 'rcand-u', status: 'pending_review',
      judgment: '接口变更后必须同步更新对应文档与 wiki，并在群里告知；紧急变更可先口头同步。', value: '', summary: '接口变更同步文档修订',
      suggestedType: 'rule', suggestedScope: 'general',
      suggestedAction: 'update', targetAssetId: 'aa-t1', targetVersionUsed: '1',
      capabilities: { canEdit: true, canPromote: true, countsAsPending: true, isSnoozed: false },
    };
    const review = renderPage('review', { sources: [conversationSources[0]], candidates: [update], assets: [target] }, { candidateId: 'rcand-u' });
    // 差异卡：旧版全文可见（对照新内容可编辑区）。
    expect(review).toContain('当前版本（v2）');
    expect(review).toContain('接口变更后必须同步更新对应文档，并在群里告知。');
    // 版本核对：任务用的是 v1、当前在用 v2 → 提示核对改进对象。
    expect(review).toContain('任务当时使用的是 v1');
    expect(review).toContain('当前在用 v2');
    // 版本一致时不出核对提示。
    const aligned = { ...update, targetVersionUsed: '2' };
    const reviewAligned = renderPage('review', { sources: [conversationSources[0]], candidates: [aligned], assets: [target] }, { candidateId: 'rcand-u' });
    expect(reviewAligned).not.toContain('任务当时使用的是');
  });

  it('来源徽章与复盘信号块（2026-09-16 KSTAR 前端融合）：KSTAR 复盘/KSTAR 偏好/会话整理', () => {
    const mk = (over) => ({
      id: 'rcand-k', status: 'pending_review', suggestedType: 'rule', suggestedScope: 'general',
      judgment: '性能类提问需用真实日志做分层归因。', summary: '性能归因',
      capabilities: { canEdit: true, canPromote: true, countsAsPending: true, isSnoozed: false },
      ...over,
    });
    const review = (cands) => renderPage('review', { sources: [conversationSources[0]], candidates: cands });
    // KSTAR 复盘候选（B 档两线分开）：在 KSTAR 侧「待确认提案」列出，
    // 列表行带「KSTAR 复盘」徽章；详情展开复盘信号块。
    const kstar = mk({ learningSignal: { deltaR: -1, deltaA: 'unknown', outcome: 'worse_than_expected', confidence: 0.95, source: 'review', expectedResult: '给出技术结论', actualResult: '模型调用失败' } });
    const listHtml = review([kstar]);
    expect(listHtml).toContain('KSTAR 复盘');
    const detailHtml = renderPage('review', { sources: [conversationSources[0]], candidates: [kstar] }, { candidateId: 'rcand-k' });
    expect(detailHtml).toContain('复盘依据');
    expect(detailHtml).toContain('给出技术结论');
    expect(detailHtml).toContain('模型调用失败');
    expect(detailHtml).toContain('比预期差');
    // 偏好扫描候选：徽章「KSTAR 偏好」。
    const pref = mk({ suggestedType: 'personal', learningSignal: { deltaR: 'unknown', deltaA: 'unknown', outcome: 'met_expected', confidence: 0.9, source: 'preference_scan' } });
    expect(review([pref])).toContain('KSTAR 偏好');
    // capture 候选：徽章「会话整理」。
    expect(review([mk({})])).toContain('会话整理');
  });

  it('版本块溯源行（2026-09-16/17 下沉改）：快照带 learningProvenance 时标来源，无信号不出该行', () => {
    const asset = {
      id: 'aa-src', title: '性能类提问需用真实日志做分层归因', type: 'rule', status: 'active',
      scope: 'general', version: '2', activeVersion: '1', updatedAt: '2026-09-15T00:00:00.000Z',
    };
    const versions = {
      assetId: 'aa-src', usage: [],
      versions: [
        { assetId: 'aa-src', version: '1', at: '2026-09-14T01:00:00.000Z', snapshot: { title: 'T', statement: 'S', evidenceRefs: [], learningProvenance: { projectionId: 'proj-x', episodeId: 'kse-y', attribution: 'execution_gap' } } },
        { assetId: 'aa-src', version: '2', at: '2026-09-15T01:00:00.000Z', snapshot: { title: 'T', statement: 'S', evidenceRefs: [] } },
      ],
    };
    // 有 provenance 的 v1 展开：来源行在版本块内。
    const open = renderPage('overview', { assets: [asset], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-src', assetVersionId: '1' });
    expect(open).toContain('来自 KSTAR 复盘');
    // 无信号快照（v2）展开：不出该行。
    const plain = renderPage('overview', { assets: [asset], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-src', assetVersionId: '2' });
    expect(plain).not.toContain('来自 KSTAR 复盘');
  });

  it('KSTAR 证据与来源按版本显示（2026-09-17 下沉）：版本展开块内出证据 chips、KSTAR 来源行，点开「这次任务的经过」', () => {
    // 快照级的证据与信号：evidenceRefs/learningSignal 都冻在版本快照里——
    // 顶部不再显示资产级副本，全部进版本展开块。
    const asset = {
      id: 'aa-k1', title: '不用比喻回答', type: 'personal', status: 'active',
      scope: 'general', version: '2', activeVersion: '1', updatedAt: '2026-09-16T00:00:00.000Z',
    };
    const versions = {
      assetId: 'aa-k1', usage: [],
      versions: [
        { assetId: 'aa-k1', version: '1', at: '2026-09-10T01:00:00.000Z', reason: 'review_decision:rd_x', snapshot: { title: '不用比喻回答', statement: 'S1', scope: 'general', evidenceRefs: [{ id: 'kse-abc123', kind: 'execution', title: 'KSTAR requirement episode' }], learningSignal: { deltaR: 'unknown', deltaA: 'unknown', outcome: 'met_expected', confidence: 0.9, source: 'preference_scan' } } },
        { assetId: 'aa-k1', version: '2', at: '2026-09-15T01:00:00.000Z', reason: 'user manual edit', snapshot: { title: '不用比喻回答', statement: 'S2', scope: 'general', evidenceRefs: [] } },
      ],
    };
    // ① 展开带 KSTAR 信号的 v1：证据 chips + 来源行都在版本块里；顶部无两折叠区。
    const open = renderPage('overview', {
      assets: [asset], proofs: [], sources: [], assetVersions: versions,
      kstarSummaries: { 'kse-abc123': { id: 'kse-abc123', goal: '我想知道你的认知资产是怎么存的？', status: 'completed', at: '' } },
    }, { assetId: 'aa-k1', assetVersionId: '1' });
    expect(open).not.toContain('详细信息');
    expect(open).toContain('来自 KSTAR 偏好');
    expect(open).toContain('data-act="open-kstar-episode" data-id="kse-abc123"');
    expect(open).toContain('任务复盘：我想知道你的认知资产是怎么存的');
    // ② 点开态（route.kstarEpisodeId）：「这次任务的经过」就地出现在版本块内，
    // 白话化（标题/行标签/归因枚举翻译）。
    const episode = renderPage('overview', {
      assets: [asset], proofs: [], sources: [], assetVersions: versions, kstarSummaries: null,
      kstarEpisode: { episodeId: 'kse-abc123', episode: { id: 'kse-abc123', goal: '我想知道你的认知资产是怎么存的？' }, review: { expectedResult: '给出技术结论', actualResult: '调用失败', outcome: 'worse_than_expected', attribution: 'execution_gap', lesson: '查模型配置类问题时，应从运行日志交叉验证，不要依赖模型自述。' } },
    }, { assetId: 'aa-k1', assetVersionId: '1', kstarEpisodeId: 'kse-abc123' });
    expect(episode).toContain('这次任务的经过');
    expect(episode).toContain('当时的任务');
    expect(episode).toContain('给出技术结论');
    expect(episode).toContain('比预期差');
    expect(episode).toContain('执行环节没做到位');
    expect(episode).not.toContain('execution_gap');
    expect(episode).toContain('沉淀的经验');
    expect(episode).toContain('查模型配置类问题时，应从运行日志交叉验证');
    expect(episode).toContain('ca-episode-detail');
    // ③ 展开无证据的 v2：不渲染证据 chips，也无来源行。
    const openV2 = renderPage('overview', {
      assets: [asset], proofs: [], sources: [], assetVersions: versions,
    }, { assetId: 'aa-k1', assetVersionId: '2' });
    expect(openV2).not.toContain('open-kstar-episode');
    expect(openV2).not.toContain('来自 KSTAR');
  });

  it('两线顶级分开（2026-09-17 B 档）：归边判定 + 源切换条 + KSTAR 侧独立 tab 与互斥列表', () => {
    const { cogAssets: NS } = ensureModule();
    const isKstarAsset = NS.isKstarAsset as (a: Record<string, unknown>) => boolean;
    const isKstarCandidate = NS.isKstarCandidate as (c: Record<string, unknown>) => boolean;
    // 归边口径=证据法：kse- 执行证据或 KSTAR 学习信号；reason=review_decision
    // 不是判据（对话线确认也写它，两线共用确认队列）。
    expect(isKstarAsset({ evidenceRefs: [{ kind: 'execution', id: 'kse-1' }] })).toBe(true);
    expect(isKstarAsset({ learningSignal: { source: 'preference_scan' } })).toBe(true);
    expect(isKstarAsset({ learningProvenance: { episodeId: 'kse-1' } })).toBe(true);
    expect(isKstarAsset({ evidenceRefs: [{ kind: 'conversation', id: 'conv-1', subtype: 'session' }] })).toBe(false);
    // kse- id 但 kind 非 execution（防误判）。
    expect(isKstarAsset({ evidenceRefs: [{ kind: 'conversation', id: 'kse-1' }] })).toBe(false);
    expect(isKstarCandidate({ learningSignal: { source: 'review' } })).toBe(true);
    expect(isKstarCandidate({ sourceRefs: [{ id: 'kse-1' }] })).toBe(true);
    expect(isKstarCandidate({ sourceRefs: [{ id: 'msg-1' }] })).toBe(false);

    const chatAsset = { id: 'aa-chat', title: '对话沉淀资产', type: 'rule', status: 'active', version: '1', updatedAt: '2026-09-15T00:00:00.000Z', evidenceRefs: [{ kind: 'conversation', id: 'conv-1', subtype: 'session' }] };
    const kstarAsset = { id: 'aa-kstar', title: 'KSTAR 沉淀资产', type: 'personal', status: 'active', version: '1', updatedAt: '2026-09-16T00:00:00.000Z', evidenceRefs: [{ kind: 'execution', id: 'kse-9' }] };
    // 单列表两线混排（2026-09-17 二次定调）：不分区，出身靠徽章。
    const html = renderPage('overview', { assets: [chatAsset, kstarAsset], proofs: [], sources: [], kstarEpisodes: [] });
    expect(html).toContain('对话沉淀资产');
    expect(html).toContain('KSTAR 沉淀资产');
    // KSTAR 资产行带「KSTAR」徽章（子安口径：出身标记直接带 KSTAR 字样）。
    expect(html).toContain('>KSTAR</span>');
    // chips 给「KSTAR」筛选档。
    expect(html).toContain('data-act="filter-cat" data-id="kstar"');
    // 筛选档只留 KSTAR 血统。
    const only = renderPage('overview', { assets: [chatAsset, kstarAsset], proofs: [], sources: [], kstarEpisodes: [] }, { category: 'kstar' });
    expect(only).toContain('KSTAR 沉淀资产');
    expect(only).not.toContain('对话沉淀资产');
  });

  it('列表行版本号显示在用版（2026-09-17 子安实测）：删掉 v3-v5 后游标停在 v5，行上该显示在用的 v2', () => {
    const html = renderPage('overview', {
      assets: [{ id: 'aa-v', title: '版本号显示', type: 'rule', status: 'active', version: '5', activeVersion: '2', updatedAt: '2026-09-16T00:00:00.000Z' }], proofs: [], sources: [], kstarEpisodes: [],
    });
    expect(html).toContain('v2 ·');
    expect(html).not.toContain('v5 ·');
  });

  it('KSTAR 任务复盘折叠区（我的认知页底部）：行带目标可点开，空态不裸白', () => {
    const rows = renderPage('overview', {
      assets: [], proofs: [], sources: [],
      // 与 kstar.episodes.list 真实返回同构：goal 平铺（此前只读 t.userGoal
      // 全显示"（未记录目标）"，2026-09-17 子安实测抓出）；kse-2 留完整
      // 记录形态验证兼容。
      kstarEpisodes: [
        { id: 'kse-1', goal: '查认知资产是怎么存的', createdAt: '2026-09-17T10:00:00.000Z' },
        { id: 'kse-2', t: { userGoal: '命中既有候选是怎么一个逻辑' }, createdAt: '2026-09-16T09:00:00.000Z' },
        { id: 'kse-3', t: {}, createdAt: '2026-09-16T08:00:00.000Z' },
      ],
    });
    expect(rows).toContain('KSTAR 任务复盘');
    expect(rows).toContain('查认知资产是怎么存的');
    expect(rows).toContain('命中既有候选是怎么一个逻辑');
    expect(rows).toContain('data-act="open-kstar-episode" data-id="kse-1"');
    expect(rows).toContain('（未记录目标）');
    const empty = renderPage('overview', { assets: [], proofs: [], sources: [], kstarEpisodes: [] });
    expect(empty).toContain('还没有被 KSTAR 复盘过的任务');
  });

  it('证据分组（2026-09-17 B 档）：版本块内 KSTAR 任务复盘 / 对话与表态 两组分开带说明', () => {
    const asset = { id: 'aa-mix', title: '混两线证据', type: 'rule', status: 'active', version: '2', activeVersion: '2', updatedAt: '2026-09-16T00:00:00.000Z' };
    const html = renderPage('overview', {
      assets: [asset], proofs: [], sources: [],
      assetVersions: {
        assetId: 'aa-mix', usage: [],
        versions: [
          { assetId: 'aa-mix', version: '1', at: '2026-09-14T01:00:00.000Z', snapshot: { title: 'T', statement: 'S' } },
          { assetId: 'aa-mix', version: '2', at: '2026-09-15T01:00:00.000Z', reason: 'review_decision:rd_z', snapshot: { title: 'T', statement: 'S', scope: 'personal', evidenceRefs: [
            { kind: 'execution', id: 'kse-1', title: 'KSTAR requirement episode' },
            { kind: 'conversation', id: 'conv-1', subtype: 'session', title: '某场对话' },
            { kind: 'user_teaching_signal', id: 'teach-1' },
          ] } },
        ],
      },
    }, { assetId: 'aa-mix', assetVersionId: '2' });
    expect(html).toContain('ca-evgroup');
    expect(html).toContain('KSTAR 任务复盘');
    expect(html).toContain('对话与你的表态');
    // bug1：scope=personal 不再裸英文。
    expect(html).toContain('个人对话');
    expect(html).not.toContain('>personal<');
    // bug2：review_decision 版本的来源标签是"确认沉淀"，不再裸内部值。
    expect(html).toContain('确认沉淀');
    expect(html).not.toContain('review_decision');
  });

  it('候选详情点复盘 chip 就地展开（2026-09-17 修）：不跳页、块出现在证据区下方', () => {
    const cand = {
      id: 'rcand-ep', status: 'pending_review', suggestedType: 'rule', suggestedScope: 'general',
      judgment: '解释机制先给线性主线。', summary: '线性主线',
      capabilities: { canEdit: true, canPromote: true, countsAsPending: true, isSnoozed: false },
      sourceRefs: [{ kind: 'execution', id: 'kse-1' }],
    };
    // 点开态（route 带 candidateId+kstarEpisodeId）：复盘块渲染在候选详情内，
    // 页面仍是 review（此前处理器硬编码 overview，点 chip 整页跳回"我的认知"）。
    const html = renderPage('review', {
      sources: [], candidates: [cand],
      kstarEpisode: { episodeId: 'kse-1', episode: { id: 'kse-1', goal: '命中既有候选是怎么一个逻辑' }, review: { outcome: 'met_expected', attribution: 'execution_gap', lesson: '先给主线再补分支。' } },
    }, { candidateId: 'rcand-ep', kstarEpisodeId: 'kse-1' });
    expect(html).toContain('ca-episode-detail');
    expect(html).toContain('这次任务的经过');
    expect(html).toContain('命中既有候选是怎么一个逻辑');
  });

  it('使用记录引用已删版本（bug3）：标注"当时的版本后来已删除"', () => {
    const asset = { id: 'aa-del', title: '有历史使用的资产', type: 'rule', status: 'active', version: '2', activeVersion: '2', updatedAt: '2026-09-16T00:00:00.000Z' };
    const html = renderPage('overview', {
      assets: [asset], proofs: [], sources: [],
      assetVersions: { assetId: 'aa-del', usage: [], versions: [{ assetId: 'aa-del', version: '2', at: '2026-09-15T01:00:00.000Z', snapshot: { title: 'T', statement: 'S' } }] },
      // 使用记录引用 v5：版本链只有 v2（v3-v5 已被真删），须标注而非裸 v5。
    }, { assetId: 'aa-del' });
    expect(html).toContain('还没有被真实使用过');
    const used = renderPage('overview', {
      assets: [asset], sources: [],
      proofs: [{ id: 'p1', kind: 'usage_recorded', occurredAt: '2026-09-17T11:00:00.000Z', refs: { assetId: 'aa-del', version: '5' } }],
      assetVersions: { assetId: 'aa-del', usage: [], versions: [{ assetId: 'aa-del', version: '2', at: '2026-09-15T01:00:00.000Z', snapshot: { title: 'T', statement: 'S' } }] },
    }, { assetId: 'aa-del' });
    expect(used).toContain('该版本后来已删除');
    expect(used).toContain('v5');
  });

  it('无候选：显示模型给出的理由与筛选原因白话', () => {
    const html = renderPage('organize', {
      captures: [{
        ...detailCapture, candidateIds: [], status: 'completed', displayStatus: 'completed',
        displayReason: 'no_candidate', noCandidateReason: '这轮只是复述已知信息，没有新的可沉淀内容。',
        filterReason: 'model_no_candidate',
      }],
      sources: [], ...contextStore,
    }, { captureId: 'rcap-x' });
    expect(html).toContain('没有发现值得留存的内容');
    expect(html).toContain('这轮只是复述已知信息');
    expect(html).toContain('模型判断这轮没有可沉淀的内容');
  });

  it('进行中：结果区给出占位说明', () => {
    const html = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: [] }], sources: [], ...contextStore,
    }, { captureId: 'rcap-x' });
    expect(html).toContain('整理还在进行');
  });

  it('对话上下文：参与角色 chips + 消息时间线（角色名/标签/折叠/产物）', () => {
    const html = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: [], screeningSignals: ['preference', 'decision'] }],
      sources: [], ...contextStore,
    }, { captureId: 'rcap-x' });
    expect(html).toContain('对话上下文');
    expect(html).toContain('参与角色');
    expect(html).toContain('消息时间线');
    expect(html).toContain('你');
    expect(html).toContain('指挥官');
    expect(html).toContain('代码评审员');
    expect(html).toContain('帮我把上线前的检查做成清单。');
    expect(html).toContain('m1 ·');
    expect(html).toContain('上线检查清单');
    expect((html.match(/ca-tl-row/g) || []).length).toBeGreaterThanOrEqual(3);
    // 价值信号白话化（manual_selection 被过滤不显示）
    expect(html).toContain('用户偏好');
    expect(html).toContain('决策');
    expect(html).not.toContain('手动选择');
  });

  it('长消息折叠为 details，短消息直出', () => {
    const longText = `${'深度内容。'.repeat(80)}\n第二段也很长。`;
    const html = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: [] }], sources: [],
      captureContext: {
        captureId: 'rcap-x',
        data: { ...contextData, messages: [{ ...contextData.messages[0], text: longText, truncated: true }] },
      },
    }, { captureId: 'rcap-x' });
    expect(html).toContain('ca-tl-body');
    expect(html).toContain('内容过长，已截断');
  });

  it('上下文不可用/加载中降级文案', () => {
    const unavailable = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: [] }], sources: [],
      captureContext: { captureId: 'rcap-x', data: null },
    }, { captureId: 'rcap-x' });
    expect(unavailable).toContain('消息内容不可用');

    const loading = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: [] }], sources: [],
      captureContext: { captureId: 'rcap-x', loading: true, data: null },
    }, { captureId: 'rcap-x' });
    expect(loading).toContain('正在读取对话上下文');
  });

  it('上下文缓存与当前任务不符时不串用', () => {
    const html = renderPage('organize', {
      captures: [{ ...detailCapture, candidateIds: [] }], sources: [],
      captureContext: { captureId: 'rcap-other', data: contextData },
    }, { captureId: 'rcap-x' });
    expect(html).toContain('消息内容不可用');
    expect(html).not.toContain('帮我把上线前的检查做成清单。');
  });
});

describe('待我处理（决策中心）', () => {
  const issueSource = {
    kind: 'artifact_file',
    items: [{
      id: 'src-1', kind: 'artifact_file', title: '架构决策记录.md',
      status: 'failed', statusReason: 'file_index_failed', actions: ['retry', 'remove'],
    }],
  };

  it('来源异常行出现且默认收起；展开后出异常明细与处理动作', () => {
    const store = { sources: [conversationSources[0], issueSource], candidates: [] };
    const collapsed = renderPage('review', store);
    expect(collapsed).toContain('1 条来源记录需要处理');
    expect(collapsed).toContain('data-act="toggle-source-issues"');
    expect(collapsed).not.toContain('data-action="retry"');

    const open = renderPage('review', store, { sourceIssueOpen: 'open' });
    expect(open).toContain('架构决策记录.md');
    expect(open).toContain('文件索引失败，可重试');
    expect(open).toContain('data-action="retry"');
    expect(open).toContain('data-kind="artifact_file"');
  });

  it('执行失败轮次不算「来源需要处理」（2026-09-16：turn-哈希行看不懂且无可用动作）', () => {
    // execution_evaluation 的 failed 项（reason=execution_failed、无标题、
    // actions 仅 remove）是 agent 执行失败的历史轮次——不是用户能修复的
    // 数据源，进异常区只显示成 turn-哈希 + 无效重试；执行失败在对话侧已
    // 可见，这里纯属噪音（真机 13 条全部如此）。
    const failedTurns = {
      kind: 'execution_evaluation',
      items: [1, 2].map((n) => ({
        id: `turn-abc${n}`, kind: 'execution_evaluation', subtype: 'execution',
        status: 'failed', statusReason: 'execution_failed', actions: ['remove'],
      })),
    };
    const store = { sources: [conversationSources[0], failedTurns, issueSource], candidates: [] };
    const collapsed = renderPage('review', store);
    // 只数 artifact_file 那条真异常。
    expect(collapsed).toContain('1 条来源记录需要处理');
    const open = renderPage('review', store, { sourceIssueOpen: 'open' });
    expect(open).not.toContain('turn-abc1');
    expect(open).toContain('架构决策记录.md');
  });

  it('重试按钮只给 actions 含 retry 的来源项（2026-09-16：无效重试误导）', () => {
    const noRetry = {
      kind: 'context_file',
      items: [{ id: 'src-x', kind: 'context_file', title: '读不了的文件.md', status: 'failed', statusReason: 'source_unavailable', actions: ['remove'] }],
    };
    const open = renderPage('review', { sources: [conversationSources[0], noRetry], candidates: [] }, { sourceIssueOpen: 'open' });
    expect(open).toContain('读不了的文件.md');
    expect(open).not.toContain('data-action="retry"');
  });

  it('健康来源不出现在待我处理（异常驱动，无常态清单）', () => {
    const html = renderPage('review', { sources: [conversationSources[0]], candidates: [] });
    expect(html).not.toContain('条来源记录需要处理');
    expect(html).not.toContain('Saying hello');
  });

  it('整理失败入口指向整理页；处理记录收进折叠', () => {
    const html = renderPage('review', {
      sources: [], candidates: [], captureCounts: { failed: 2 },
    });
    expect(html).toContain('data-act="go-organize"');
    expect(html).toContain('2 个整理任务需要重试');
  });
});

describe('资产详情（使用记录并入）', () => {
  const asset = { id: 'aa-1', title: '上线前必须确认影响范围', type: 'rule', status: 'active', scope: 'general', updatedAt: '2026-09-15T00:00:00.000Z' };
  const proofs = [
    {
      id: 'ev-1', kind: 'usage_recorded', occurredAt: '2026-09-15T01:00:00.000Z',
      refs: { assetId: 'aa-1', conversationId: 'conv-1', transferProofId: 'tp-1', version: 2 },
    },
    {
      id: 'ev-2', kind: 'projection_confirmed', occurredAt: '2026-09-14T01:00:00.000Z',
      refs: { assetId: 'aa-1', conversationId: 'conv-1' },
    },
  ];

  it('使用记录区按时间倒序整句化，可评事件展开出评价按钮', () => {
    const html = renderPage(
      'overview',
      { assets: [asset], proofs, sources: conversationSources },
      { assetId: 'aa-1', proofEventId: 'ev-1' },
    );
    expect(html).toContain('使用记录');
    expect(html).toContain('被实际使用');
    expect(html).toContain('对话《Saying hello》里');
    expect(html).toContain('data-act="proof-toggle" data-id="ev-1"');
    expect(html).toContain('data-feedback="positive"');
    expect(html).toContain('data-act="proof-rate"');
  });

  it('使用记录只认真实引用（2026-09-17）：版本保存/选用切换/治理操作不进使用记录', () => {
    const noisy = [
      ...proofs,
      { id: 'ev-3', kind: 'asset_version', occurredAt: '2026-09-16T01:00:00.000Z', refs: { assetId: 'aa-1', version: 3 } },
      { id: 'ev-4', kind: 'asset_version_selected', occurredAt: '2026-09-16T02:00:00.000Z', refs: { assetId: 'aa-1', version: '2' } },
      { id: 'ev-5', kind: 'asset_archived', occurredAt: '2026-09-16T03:00:00.000Z', refs: { assetId: 'aa-1' } },
    ];
    const html = renderPage('overview', { assets: [asset], proofs: noisy, sources: conversationSources }, { assetId: 'aa-1' });
    expect(html).toContain('被实际使用');
    expect(html).toContain('被带入任务');
    expect(html).not.toContain('保存了新版本');
    expect(html).not.toContain('选用 v2 为在用版本');
    // 噪音事件不进计数摘要。
    expect(html).toContain('被实际使用 1 次');
    expect(html).toContain('被带入任务 1 次');
  });

  it('版本链（2026-09-16 版本组）：V1 归入同条目可展开，非在用版可「选用此版」', () => {
    const multi = {
      ...asset,
      version: '3',
      activeVersion: '2',
      title: 'Renamed in v2',
      statement: '新内容',
    };
    const html = renderPage('overview', {
      assets: [multi],
      proofs: [],
      sources: [],
      assetVersions: {
        assetId: 'aa-1',
        usage: [{ version: '1', applied: 3, contradicted: 1, total: 4 }, { version: '2', applied: 1, contradicted: 0, total: 1 }],
        versions: [
          { assetId: 'aa-1', version: '1', at: '2026-09-10T01:00:00.000Z', snapshot: { title: '上线前必须确认影响范围', statement: '旧内容', type: 'rule', evidenceRefs: [], status: 'active', maturity: 'seed', version: '1' } },
          { assetId: 'aa-1', version: '2', at: '2026-09-15T01:00:00.000Z', reason: 'Rename for v2.', snapshot: { title: 'Renamed in v2', statement: '新内容', type: 'rule', evidenceRefs: [], status: 'active', maturity: 'seed', version: '2' } },
          { assetId: 'aa-1', version: '3', at: '2026-09-16T01:00:00.000Z', reason: 'merged from aa-x', snapshot: { title: 'Renamed in v2', statement: '新内容', type: 'rule', evidenceRefs: [], status: 'active', maturity: 'seed', version: '3' } },
        ],
      },
    }, { assetId: 'aa-1' });
    // 版本链 section：标题 + 两版（各版快照标题可辨）。
    expect(html).toContain('版本记录');
    expect(html).toContain('Renamed in v2');
    expect(html).toContain('上线前必须确认影响范围');
    // 在用版（v2）标「在用」，非在用版（v1）给「选用此版」（在用版无选用按钮；
    // 2026-09-17 起每行带 data-version 供点开，判"无按钮"须带全 data-act 前缀）。
    expect(html).toContain('data-act="select-asset-version" data-id="aa-1" data-version="1"');
    expect(html).not.toContain('data-act="select-asset-version" data-id="aa-1" data-version="2"');
    expect(html).toContain('在用');
    // 按版本的使用效果列（M8）：v1 采用 3 次·被否定 1 次。
    expect(html).toContain('实际采用 3 次');
    expect(html).toContain('被否定 1 次');
    // 空版本标记（2026-09-16）：v3 与 v2 一字不差 → 标"内容未变"。
    expect(html).toContain('内容未变（系统迁移/搬运）');
  });

  it('版本行点开详情与真删入口（2026-09-17）：全文/逐项信息/删除按钮/在用版提示', () => {
    const multi = { ...asset, version: '3', activeVersion: '2', title: 'Renamed in v2', statement: '新内容' };
    const versions = {
      assetId: 'aa-1',
      usage: [{ version: '1', applied: 3, contradicted: 1, total: 4 }],
      versions: [
        { assetId: 'aa-1', version: '1', at: '2026-09-10T01:00:00.000Z', reason: 'initial', snapshot: { title: '上线前必须确认影响范围', statement: '旧内容的完整正文，超过八十字预览的部分也要在展开块里完整可见，用于区分列表预览与详情全文。'.repeat(2), type: 'rule', evidenceRefs: [{ kind: 'execution', id: 'exec-v1' }], applicableWhen: ['做发版自查'], forbiddenWhen: ['临时草稿'], status: 'active', maturity: 'seed', version: '1' } },
        { assetId: 'aa-1', version: '2', at: '2026-09-15T01:00:00.000Z', reason: 'Rename for v2.', snapshot: { title: 'Renamed in v2', statement: '新内容', type: 'rule', evidenceRefs: [], status: 'active', maturity: 'seed', version: '2' } },
      ],
    };
    // 列表行可点：每行带 open-asset-version；未展开时不出现详情块。
    const listHtml = renderPage('overview', { assets: [multi], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1' });
    expect(listHtml).toContain('data-act="open-asset-version" data-version="1"');
    expect(listHtml).not.toContain('版本详情');
    // 点开 v1（非在用）：全文可见（预览截断处之后的内容只在展开块里）、
    // 适用/禁用场景、证据条数、使用效果与「删除此版本」。
    const openHtml = renderPage('overview', { assets: [multi], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1', assetVersionId: '1' });
    expect(openHtml).toContain('版本详情 · v1');
    expect(openHtml).toContain('详情全文。');
    expect(openHtml).toContain('做发版自查');
    expect(openHtml).toContain('临时草稿');
    expect(openHtml).toContain('来源记录');
    expect(openHtml).toContain('实际采用 3 次');
    expect(openHtml).toContain('data-act="delete-asset-version" data-id="aa-1" data-version="1"');
    // 点开在用版 v2：无删除按钮，白话提示先切换再删。
    const activeHtml = renderPage('overview', { assets: [multi], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1', assetVersionId: '2' });
    expect(activeHtml).not.toContain('delete-asset-version');
    expect(activeHtml).toContain('当前在用版本不可删除');
  });

  it('资产级开关与版本级编辑入口（2026-09-17 二次重构）：顶部开关+状态说明、正文锚点、编辑只在版本行', () => {
    const list = renderPage('overview', { assets: [asset], proofs: [], sources: [] }, { assetId: 'aa-1' });
    // 顶部：总开关（pause/resume 走 asset-action）+ 一句生效说明；顶部不再有编辑/归档按钮。
    expect(list).toContain('data-action="pause"');
    expect(list).toContain('使用中：这条资产会自动带入你的新任务');
    // 开关说明贴着标题（2026-09-17 红线口径）：说明在标题区副标题位（ca-sub），不沉在正文后。
    expect(list).toContain('ca-sub">使用中：这条资产会自动带入你的新任务');
    expect(list).not.toContain('data-act="edit-asset"');
    expect(list).not.toContain('data-action="archive"');
    // 头部只留标题+正文+开关：详细信息和证据来源已按版本下沉（2026-09-17
    // 子安口径），顶部不再出现这两个折叠区。
    expect(list).not.toContain('已成功带入');
    expect(list).not.toContain('详细信息');
    expect(list).not.toContain('证据来源');
    expect(list).toContain('data-action="pause"');
    // 版本行的编辑入口：在用版与历史版的展开块都有「基于此版修改」。
    const multi = { ...asset, version: '2', activeVersion: '1' };
    const versions = { assetId: 'aa-1', versions: [
      { assetId: 'aa-1', version: '1', at: '2026-09-10T01:00:00.000Z', snapshot: { title: 'T1', statement: 'S1', evidenceRefs: [] } },
      { assetId: 'aa-1', version: '2', at: '2026-09-15T01:00:00.000Z', snapshot: { title: 'T2', statement: 'S2', evidenceRefs: [] } },
    ] };
    const openV2 = renderPage('overview', { assets: [multi], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1', assetVersionId: '2' });
    expect(openV2).toContain('data-act="edit-from-version" data-id="aa-1" data-version="2"');
    const openV1 = renderPage('overview', { assets: [multi], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1', assetVersionId: '1' });
    expect(openV1).toContain('data-act="edit-from-version" data-id="aa-1" data-version="1"');
    expect(openV1).toContain('当前在用版本不可删除');
    // 编辑态表单仍渲染（预填现值，保存/取消齐全）。
    const editable = { ...asset, applicableWhen: ['发版自查'] };
    const edit = renderPage('overview', { assets: [editable], proofs: [], sources: [] }, { assetId: 'aa-1', assetEdit: '1' });
    expect(edit).toContain('ca-asset-edit');
    expect(edit).toContain('data-f="statement"');
    expect(edit).toContain('发版自查');
    expect(edit).toContain('data-act="asset-edit-save"');
    expect(edit).toContain('data-act="asset-edit-cancel"');
    // 暂停态：开关 off（resume 即恢复入口）+ 暂停说明；已归并态：只读说明、无任何操作。
    const paused = renderPage('overview', { assets: [{ ...asset, status: 'paused' }], proofs: [], sources: [] }, { assetId: 'aa-1' });
    expect(paused).toContain('data-action="resume"');
    expect(paused).toContain('已暂停：新任务不再自动带入');
    const archived = renderPage('overview', { assets: [{ ...asset, status: 'archived' }], proofs: [], sources: [] }, { assetId: 'aa-1' });
    expect(archived).toContain('已归并');
    expect(archived).not.toContain('data-action="restore"');
  });

  it('版本来源标签与空版本折叠（2026-09-17 报告建议 E）：标签替原文，迁移空版本默认隐藏可展开', () => {
    const multi = { ...asset, version: '3', activeVersion: '1', title: 'T', statement: 'S' };
    const versions = {
      assetId: 'aa-1', usage: [],
      versions: [
        { assetId: 'aa-1', version: '1', at: '2026-09-10T01:00:00.000Z', reason: 'review_decision:rd_x', snapshot: { title: 'T', statement: 'S', evidenceRefs: [] } },
        { assetId: 'aa-1', version: '2', at: '2026-09-13T01:00:00.000Z', reason: 'legacy free-text scope "personal" → controlled term "general" (2026-09-13 scope enumeration)', snapshot: { title: 'T', statement: 'S', evidenceRefs: [] } },
        { assetId: 'aa-1', version: '3', at: '2026-09-17T01:00:00.000Z', reason: 'user manual edit', snapshot: { title: 'T2', statement: 'S2', evidenceRefs: [] } },
      ],
    };
    const html = renderPage('overview', { assets: [multi], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1' });
    // 「候选确认」→「确认沉淀」（2026-09-17 改）：review_decision 前缀两线
    // 通用，内部流程词换成用户视角的说法。
    expect(html).toContain('确认沉淀');
    expect(html).toContain('手动编辑');
    expect(html).not.toContain('legacy free-text scope');
    // 迁移空版本（v2 与 v1 同文）默认隐藏，尾部给展开入口。
    expect(html).not.toContain('data-act="open-asset-version" data-version="2"');
    expect(html).toContain('显示 1 条系统迁移产生的空版本');
    expect(html).toContain('切回此版');
    const expanded = renderPage('overview', { assets: [multi], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1', assetVersionsExpanded: '1' });
    expect(expanded).toContain('data-act="open-asset-version" data-version="2"');
    expect(expanded).toContain('系统迁移');
    expect(expanded).toContain('收起系统迁移版本');
  });

  it('版本对比（2026-09-17 报告建议 C）：展开块与在用版就地对比，字段级 旧 → 新', () => {
    const multi = { ...asset, version: '2', activeVersion: '1', title: 'T1', statement: 'S1' };
    const versions = {
      assetId: 'aa-1', usage: [],
      versions: [
        { assetId: 'aa-1', version: '1', at: '2026-09-10T01:00:00.000Z', reason: 'review_decision:rd_x', snapshot: { title: 'T1', statement: 'S1', evidenceRefs: [] } },
        { assetId: 'aa-1', version: '2', at: '2026-09-17T01:00:00.000Z', reason: 'user manual edit', snapshot: { title: 'T2', statement: 'S2', evidenceRefs: [{ kind: 'conversation', id: 'c1' }] } },
      ],
    };
    const closed = renderPage('overview', { assets: [multi], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1', assetVersionId: '2' });
    expect(closed).toContain('data-act="diff-asset-version" data-id="aa-1" data-version="2"');
    const open = renderPage('overview', { assets: [multi], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1', assetVersionId: '2', assetVersionDiff: '2' });
    expect(open).toContain('版本对比：v1（在用） → v2');
    expect(open).toContain('S1 → S2');
    expect(open).toContain('T1 → T2');
    expect(open).toContain('0 → 1');
    expect(open).toContain('与在用版合并为新版');
    // 头部下钻已随用户视角重构移除（2026-09-17）：版本信息全归版本区，
    // 头部不再出现"已有更新的版本/看最新一版改了什么"。
    const latestMulti = { ...multi, activeVersion: '1' };
    const latest = renderPage('overview', { assets: [latestMulti], proofs: [], sources: [], assetVersions: versions }, { assetId: 'aa-1' });
    expect(latest).not.toContain('已有更新的版本');
    expect(latest).not.toContain('看最新一版改了什么');
  });

  it('已删除档（2026-09-17 报告建议 G）：默认视图不含已删除；「已删除」档与详情恢复入口', () => {
    const assets = [asset, { ...asset, id: 'aa-del', title: '已删条目占位', status: 'deleted' }];
    const list = renderPage('overview', { assets, proofs: [], sources: [] });
    expect(list).not.toContain('已删条目占位');
    expect(list).toContain('已删除 1');
    const delTab = renderPage('overview', { assets, proofs: [], sources: [] }, { category: 'deleted' });
    expect(delTab).toContain('已删条目占位');
    const detail = renderPage('overview', { assets: [{ ...asset, id: 'aa-del', status: 'deleted' }], proofs: [], sources: [] }, { assetId: 'aa-del' });
    expect(detail).toContain('data-action="restore"');
  });

  it('单版本资产也出版本区（2026-09-17 下沉改：证据/详细信息的家在版本块）；头部不再有版本提示', () => {
    const single = renderPage('overview', {
      assets: [{ ...asset, version: '1' }],
      proofs: [], sources: [],
      assetVersions: { assetId: 'aa-1', versions: [{ assetId: 'aa-1', version: '1', at: '2026-09-15T01:00:00.000Z', snapshot: { title: '上线前必须确认影响范围', type: 'rule', evidenceRefs: [] } }] },
    }, { assetId: 'aa-1' });
    // 守卫 ≥2 → ≥1：单版本资产的证据只存在唯一一版里，必须给它位置可看。
    expect(single).toContain('版本记录');
    // 头部重构（2026-09-17 用户视角）：头部不再出现版本号/"已有更新的版本"
    // ——版本信息全部归版本区（"在用"绿标 + 各版本行自明）。
    const stale = renderPage('overview', {
      assets: [{ ...asset, version: '3', activeVersion: '1' }],
      proofs: [], sources: [], assetVersions: null,
    }, { assetId: 'aa-1' });
    expect(stale).not.toContain('已有更新的版本');
    expect(stale).not.toContain('看最新一版改了什么');
  });

  it('未使用资产出占位说明，不裸空白', () => {
    const html = renderPage('overview', { assets: [asset], proofs: [], sources: [] }, { assetId: 'aa-1' });
    expect(html).toContain('还没有被真实使用过');
  });
});

describe('交互反馈与响应式（2026-09-15 全面优化）', () => {
  const css = readFileSync(resolve(rootDir, 'src/renderer/cognition-assets.css'), 'utf8');

  it('写操作按钮有旋转圈、首载有骨架、静默刷新有进度条', () => {
    expect(css).toContain('ca-spin');
    expect(css).toContain('.ca-btn.is-pending::after');
    expect(css).toContain('ca-skel-row');
    expect(css).toContain('ca-shimmer');
    expect(css).toContain('ca-refresh-slide');
    // 骨架结构真的渲染（首载态）
    const html = renderPage('organize', { captures: [], sources: [] }, {});
    expect(html).not.toContain('ca-skel-row'); // loaded=true 时不显示
    const loadingHtml = renderPage('organize', { loaded: false, loading: true, captures: [], sources: [] }, {});
    expect(loadingHtml).toContain('ca-skel-row');
  });

  it('抽屉展开/收起走 grid 行高过渡，收起态不可聚焦', () => {
    expect(css).toContain('.ca-drawer');
    expect(css).toContain('grid-template-rows: 0fr');
    expect(css).toContain('.ca-drawer.is-open');
    expect(css).toContain('visibility: hidden');
  });

  it('同页重画保持滚动位置（轮询不再弹回顶部），切页仍归零', () => {
    // render 里保存并恢复 #ca-scroll 的 scrollTop，且只在路由指纹相同时恢复。
    expect(viewsSource).toContain('lastRenderKey');
    expect(viewsSource).toContain('restoreScroll');
    expect(viewsSource).toContain('main.scrollTop = restoreScroll');
  });

  it('设置项乐观更新：capture-policy 死委托已删净（2026-09-16 B3），aria-busy 反馈保留', () => {
    // 三档单选的 case 与声明随旧抽屉退役（设置页现为夜间开关两态）；
    // 乐观更新模式由 capture-toggle/nightly 等活路径承载。
    expect(appSource).not.toContain("case 'capture-policy'");
    expect(appSource).toContain("setAttribute('aria-busy', 'true')");
  });

  it('响应式两档断点 + 减少动效尊重', () => {
    expect(css).toContain('@media (max-width: 980px)');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('prefers-reduced-motion');
  });

  it('英文 kicker 与 tab 副标题已删（2026-09-15 子安要求）：hero 只有标题，tab 只留标题文字', () => {
    // 源码级：hero 无 kicker 参数/元素；TABS 无 descKey；tab 渲染无 <small>。
    expect(viewsSource).not.toContain('ca-kicker');
    expect(viewsSource).not.toContain('<small>');
    expect(coreSource).not.toContain('descKey');
    expect(css).not.toContain('.ca-kicker');
    // 页面级：三个页面（含设置页/详情页）都不再出英文标题或副标题。
    for (const page of ['organize', 'organize-settings', 'overview']) {
      const html = renderPage(page, { captures: [], sources: [], assets: [] });
      expect(html).not.toContain('ORGANIZE');
      expect(html).not.toContain('SETTINGS');
      expect(html).not.toContain('COGNITION TREE');
    }
    const detail = renderPage('organize', { captures: [detailCapture], sources: [] }, { captureId: 'rcap-x' });
    expect(detail).not.toContain('>LOG<');
  });
});

describe('引导层（app.js / core.js）', () => {
  it('表单读取就近化：readCandidateForm 从被点按钮向上找最近的表单卡（多卡不串）', () => {
    expect(appSource).toContain('function readCandidateForm(anchorEl)');
    expect(appSource).toContain("anchorEl.closest('.ca-candidate-detail')");
    expect(appSource).toContain('readCandidateForm(el)');
  });

  it('批量动作有确认弹窗（写死条数）并从 store 收敛可执行行', () => {
    expect(appSource).toContain("case 'capture-batch'");
    expect(appSource).toContain('capture_batch_retry_confirm');
    expect(appSource).toContain('A.captureBatch');
  });

  it('开始整理 = 建任务后立即 runNow（runNow 是既定的唯一额度消耗入口）', () => {
    const fnStart = coreSource.indexOf('async organizeConversation');
    const fnEnd = coreSource.indexOf('async updateCaptureSettings', fnStart);
    const block = coreSource.slice(fnStart, fnEnd);
    expect(block).toContain('historicalAutoStart');
    const autoStart = block.indexOf('historicalAutoStart');
    const runNow = block.indexOf("recall.captures.runNow'");
    expect(autoStart).toBeGreaterThan(-1);
    expect(runNow).toBeGreaterThan(autoStart);
    expect(block).toContain("capture.status === 'waiting_manual'");
  });

  it('快照不再拉 KSTAR 经验；时间线仍拉（资产详情使用记录依赖）', () => {
    expect(coreSource).not.toContain('kstar.experiences.list');
    expect(coreSource).toContain('recall.timeline.list');
  });

  it('configure_model 的处理出口是应用设置页；整理进行中轮询限定整理页', () => {
    expect(appSource).toContain("case 'go-configure-model'");
    expect(appSource).toContain("setView('settings')");
    expect(appSource).toContain("S.route.name === 'organize'");
    expect(appSource).toContain("capture.bucket === 'active'");
  });
});
