/**
 * 整理记录页（cognition-assets/views.js::viewCaptureLog）页面级用例。
 *
 * 背景：后端 summarize 早就算好了每条记录的 displayStatus / displayReason /
 * actions（capture-service.ts），旧渲染只硬编码 failed/paused 两个状态，把
 * run_now / pause / cancel 全丢——14 行等待记录既没有标题也没有动作。2026-09-15
 * 重构后行渲染完全由 actions 驱动。
 *
 * 这里把**真实的 views.js + vocabulary.js** require 进来跑（与
 * cognition-pages.test.ts 同一模式，模块是挂在 window.CogAssets 上的 IIFE）：
 * stub 只负责 window 契约（CogAssets 的 T/esc/store/TABS 与 uiButton 工厂），
 * 断言落在渲染产出的 HTML 上——按钮 data-action 与后端语义 id 一字不差、
 * chip 计数、批量入口写死条数、筛选生效。
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

/** 极简 uiButton：attrs 序列化进 HTML，让 data-act / data-action 可断言。 */
const uiButton = ({ label, className, attrs }: { label: string; className?: string; attrs?: Record<string, string> }) =>
  `<button class="${className || ''}"${Object.entries(attrs || {}).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join('')}>${label}</button>`;

const globalScope = globalThis as unknown as Record<string, unknown>;

/** 装配 window 契约 → require 真实模块（含真 uiButton 工厂，钉住它的 attrs
 *  白名单与 btn() 的 data- 前缀协作）→ 渲染 → 返回 #ca-root 的 HTML。 */
let cogAssets: Record<string, unknown> | null = null;
let domRoot: { innerHTML: string } | null = null;
function ensureModule(): { cogAssets: Record<string, unknown>; domRoot: { innerHTML: string } } {
  if (cogAssets && domRoot) return { cogAssets, domRoot };
  cogAssets = {
    T, esc, fmtDate: () => '2026/09/15 10:00',
    TABS: [],
    stats: () => ({}),
    store: {
      loaded: true, loading: false, errors: [],
      route: { name: 'capture-log', captureBucket: '' },
      captures: [], captureBuckets: undefined,
      sources: [], proofs: [], assets: [], candidates: [],
      experienceTotal: 0, organizeListExpanded: false, expandedProofs: new Set(),
    },
  };
  domRoot = { innerHTML: '' };
  globalScope.window = {
    CogAssets: cogAssets,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    uiButton: require('../../src/renderer/modules/ui-button.js').uiButton,
    uiTextarea: () => '<textarea></textarea>',
    uiInput: () => '<input/>',
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
  store.route = { name: routeName, captureBucket: '', captureId: '', ...routePatch };
  rootEl.innerHTML = '';
  (NS.render as () => void)();
  return rootEl.innerHTML;
}

function renderCaptureLog(input: {
  captures: Array<Record<string, unknown>>;
  captureBuckets?: Record<string, number>;
  captureBucket?: string;
}): string {
  return renderPage(
    'capture-log',
    { captures: input.captures, captureBuckets: input.captureBuckets },
    { captureBucket: input.captureBucket || '' },
  );
}

function renderOrganizeHistory(input: {
  sources: Array<Record<string, unknown>>;
  captures: Array<Record<string, unknown>>;
}): string {
  return renderPage('organize-history', { sources: input.sources, captures: input.captures, organizeListExpanded: true });
}

function renderCaptureDetail(input: {
  captures: Array<Record<string, unknown>>;
  captureId: string;
  assets?: Array<Record<string, unknown>>;
}): string {
  return renderPage('capture-detail', { captures: input.captures, assets: input.assets || [] }, { captureId: input.captureId });
}

const baseCapture = {
  id: 'rcap-a',
  conversationId: 'conv-1',
  status: 'waiting_manual',
  visibility: 'visible',
  bucket: 'active',
  displayStatus: 'waiting',
  displayReason: 'manual_start_required',
  actions: ['run_now', 'pause', 'cancel', 'open_conversation'],
  reviewSummary: { total: 0, pending: 0, deferred: 0, promoted: 0, rejected: 0, missing: 0 },
  updatedAt: '2026-09-15T01:00:00.000Z',
};

const failedCapture = {
  ...baseCapture,
  id: 'rcap-b', conversationId: 'conv-2',
  status: 'failed', bucket: 'attention', displayStatus: 'failed',
  displayReason: 'capture_failed', actions: ['retry', 'cancel', 'open_conversation'],
};

const reviewReadyCapture = {
  ...baseCapture,
  id: 'rcap-c', conversationId: 'conv-3',
  status: 'review_ready', bucket: 'attention', displayStatus: 'review_ready',
  displayReason: 'review_pending', actions: ['review_candidates', 'pause', 'cancel', 'open_conversation'],
  reviewSummary: { total: 2, pending: 2, deferred: 0, promoted: 0, rejected: 0, missing: 0 },
};

const silentCapture = {
  ...baseCapture,
  id: 'rcap-d', conversationId: 'conv-4',
  status: 'no_candidate', visibility: 'internal', bucket: 'silent',
  displayStatus: 'completed', displayReason: 'no_candidate', actions: ['open_conversation'],
};

describe('整理记录页渲染', () => {
  it('行内动作由后端 actions 驱动：run_now/pause/cancel 全部出现，语义 id 一字不差', () => {
    const html = renderCaptureLog({ captures: [baseCapture] });
    expect(html).toContain('data-action="run_now"');
    expect(html).toContain('data-action="pause"');
    expect(html).toContain('data-action="cancel"');
    expect(html).toContain('立即整理');
    // 旧实现的硬编码只剩语义字典驱动，不再有裸 status 判断
    expect(viewsSource).not.toContain("capture.status === 'failed' ?");
    expect(viewsSource).not.toContain("capture.status === 'paused' ?");
  });

  it('失败行主按钮=重试；待确认行主按钮=去确认（导航分流，不走 capture-action）', () => {
    const html = renderCaptureLog({ captures: [failedCapture, reviewReadyCapture] });
    expect(html).toContain('data-action="retry"');
    expect(html).toContain('data-act="go-review"');
    expect(html).toContain('去确认');
    // 待确认计数跟在 meta 里
    expect(html).toContain('2 条待确认');
  });

  it('标题即「打开会话」入口，携带 conversationId', () => {
    const html = renderCaptureLog({ captures: [baseCapture] });
    expect(html).toContain('data-act="open-conversation"');
    expect(html).toContain('data-id="conv-1"');
  });

  it('筛选 chip 四枚带计数；attention 筛选只留需要处理的行', () => {
    const captures = [baseCapture, failedCapture, silentCapture];
    const buckets = { attention: 1, active: 1, silent: 1, done: 0 };
    const html = renderCaptureLog({ captures, captureBuckets: buckets });
    const chips = [...html.matchAll(/data-act="capture-filter"/g)].length;
    expect(chips).toBe(4);
    expect(html).toContain('全部 3');
    expect(html).toContain('需要我处理 1');

    const filtered = renderCaptureLog({ captures, captureBuckets: buckets, captureBucket: 'attention' });
    expect(filtered).toContain('rcap-b');
    expect(filtered).not.toContain('data-id="conv-1"');
    expect(filtered).not.toContain('data-id="conv-4"');

    const emptyDone = renderCaptureLog({ captures, captureBuckets: buckets, captureBucket: 'done' });
    expect(emptyDone).toContain('这个筛选下没有整理记录');
  });

  it('批量入口写死条数：重试失败（1）与立即整理（1），data-batch 指明动作', () => {
    const html = renderCaptureLog({
      captures: [baseCapture, failedCapture],
      captureBuckets: { attention: 1, active: 1, silent: 0, done: 0 },
    });
    expect(html).toContain('重试失败（1）');
    expect(html).toContain('立即整理（1）');
    expect(html).toContain('data-batch="retry"');
    expect(html).toContain('data-batch="run_now"');
  });

  it('无可批量行时不出现批量按钮', () => {
    const html = renderCaptureLog({
      captures: [silentCapture],
      captureBuckets: { attention: 0, active: 0, silent: 1, done: 0 },
    });
    expect(html).not.toContain('data-batch=');
  });

  it('静默行按 displayReason 出人话文案；「待我处理」失败入口落点是整理记录页', () => {
    const html = renderCaptureLog({
      captures: [silentCapture],
      captureBuckets: { attention: 0, active: 0, silent: 1, done: 0 },
    });
    expect(html).toContain('整理过，没有发现值得留存的内容');
    // 落点修复（2026-09-15）：此前「N 个整理任务需要重试」跳设置页的整理方式 tab
    expect(viewsSource).toContain('data-act="go-capture-log"');
    expect(viewsSource).not.toContain('data-act="go-organize"');
  });
});

describe('整理记录页引导层（app.js）', () => {
  it('批量动作有确认弹窗（写死条数）并从 store 收敛可执行行', () => {
    expect(appSource).toContain("case 'capture-batch'");
    expect(appSource).toContain('capture_batch_retry_confirm');
    expect(appSource).toContain('capture_batch_run_confirm');
    expect(appSource).toContain('actions.includes(el.dataset.batch');
    expect(appSource).toContain('A.captureBatch');
  });

  it('configure_model 的处理出口是应用设置页（模型配置所在地）', () => {
    expect(appSource).toContain("case 'go-configure-model'");
    expect(appSource).toContain("setView('settings')");
  });

  it('详情入口分流存在；整理进行中有 4s 轮询且限定在两个活页', () => {
    expect(appSource).toContain("case 'open-capture-detail'");
    expect(appSource).toContain('scheduleCapturePoll');
    expect(appSource).toContain("S.route.name === 'organize-history' || S.route.name === 'capture-detail'");
    expect(appSource).toContain("capture.bucket === 'active'");
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
});

describe('从历史会话整理页（整理中置顶/按钮态/可点进详情）', () => {
  const sources = [{
    kind: 'conversation',
    items: [
      { id: 'conv-1', kind: 'conversation', title: 'Saying hello', updatedAt: '2026-09-15T02:00:00.000Z' },
      { id: 'conv-2', kind: 'conversation', title: 'design-review 技能用途', updatedAt: '2026-09-14T02:00:00.000Z' },
      { id: 'conv-3', kind: 'conversation', title: '查询可用的skills列表', updatedAt: '2026-09-13T02:00:00.000Z' },
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

  it('整理中的条目排到最顶，按钮变「整理中」且禁用', () => {
    const html = renderOrganizeHistory({ sources, captures: [organizingCapture] });
    const top = html.indexOf('design-review 技能用途');
    const plain = html.indexOf('Saying hello');
    expect(top).toBeGreaterThan(-1);
    expect(plain).toBeGreaterThan(top);
    expect(html).toContain('整理中');
    expect(html).toContain('is-disabled');
    expect(html).toContain('正在提炼候选');
  });

  it('整理中条目可点进详情（open-capture-detail）；无任务条目保留「开始整理」', () => {
    const html = renderOrganizeHistory({ sources, captures: [organizingCapture] });
    expect(html).toContain('data-act="open-capture-detail" data-id="rcap-org"');
    expect(html).toContain('data-act="organize-conv" data-id="conv-1"');
    expect(html).toContain('开始整理');
  });

  it('失败/待确认的条目出状态 chip 且同样可进详情；不重复出「开始整理」', () => {
    const failedCapture = {
      ...organizingCapture,
      id: 'rcap-fail', conversationId: 'conv-3', conversationTitle: '查询可用的skills列表',
      status: 'failed', bucket: 'attention', displayStatus: 'failed',
      displayReason: 'capture_failed', actions: ['retry', 'cancel', 'open_conversation'],
    };
    const html = renderOrganizeHistory({ sources, captures: [failedCapture] });
    expect(html).toContain('data-act="open-capture-detail" data-id="rcap-fail"');
    expect(html).toContain('>失败</span>');
    expect(html).not.toContain('data-act="organize-conv" data-id="conv-3"');
  });
});

describe('整理详情页', () => {
  const detailCapture = {
    id: 'rcap-x', conversationId: 'conv-1', visibility: 'visible',
    conversationTitle: 'Saying hello',
    status: 'extracting', bucket: 'active', displayStatus: 'extracting',
    displayReason: 'extracting', stage: 'model_extraction',
    attempt: 2, durationMs: 65_000,
    modelUsage: { totalTokens: 1234 },
    createdAt: '2026-09-15T01:00:00.000Z',
    startedAt: '2026-09-15T01:00:05.000Z',
    actions: ['pause', 'cancel', 'open_conversation'],
    reviewSummary: { total: 3, pending: 2, deferred: 0, promoted: 1, rejected: 0, missing: 0 },
    confirmedAssetReceipts: [{ assetId: 'aa-1', assetType: 'rule', version: '1', scope: 'general', sourceRefCount: 2, reviewDecisionId: 'rd_1' }],
    updatedAt: '2026-09-15T01:02:00.000Z',
  };

  it('展示状态、当前步骤、时间与用量，动作与打开会话/返回齐备', () => {
    const html = renderCaptureDetail({ captures: [detailCapture], captureId: 'rcap-x' });
    expect(html).toContain('Saying hello');
    expect(html).toContain('正在提炼候选');
    expect(html).toContain('模型提炼中');
    expect(html).toContain('1 分 5 秒');
    expect(html).toContain('1234 tokens');
    expect(html).toContain('data-action="pause"');
    expect(html).toContain('data-act="open-conversation" data-id="conv-1"');
    expect(html).toContain('data-act="go-back"');
  });

  it('已沉淀资产逐条可跳资产详情，标题取资产自身（缺资产时退回类型·版本）', () => {
    const html = renderCaptureDetail({
      captures: [detailCapture],
      captureId: 'rcap-x',
      assets: [
        { id: 'aa-1', title: '上线前必须确认影响范围', type: 'rule', status: 'active' },
      ],
    });
    expect(html).toContain('已沉淀资产');
    expect(html).toContain('上线前必须确认影响范围');
    expect(html).toContain('data-act="open-asset" data-id="aa-1"');

    const noAsset = renderCaptureDetail({ captures: [detailCapture], captureId: 'rcap-x' });
    expect(noAsset).toContain('规则与偏好 · v1');
    expect(noAsset).not.toContain('aa-1</div>');
  });

  it('任务不存在时给兜底文案，不白屏', () => {
    const html = renderCaptureDetail({ captures: [], captureId: 'rcap-gone' });
    expect(html).toContain('这条整理任务不存在或已被清理');
  });
});
