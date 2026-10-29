/**
 * 依据链与「改进分析」只读分区的**真实渲染**测试（specs/015 T014 / T016 / T019）。
 *
 * 为什么这样写：这两块都长在 `cognition-assets/views.js` 的页内函数里，只做
 * "源码里出现过这一行"的断言挡不住三类真问题——词条没接上（四语退回中文兜底）、
 * 字段读错（版本/任务/证据对不上）、受限正文漏上屏。这里把**真的 views.js +
 * 真的共享控件 + 真的中文词条** require 进来跑（与 cognition-capture-log.test.ts
 * 同一模式），断言落在真实渲染出的 HTML 与可见文本上；源码级断言只用来钉
 * "唯一解析器""不渲染内部字段"这类结构性口径。
 *
 * 词条表直接用 zh.json：渲染出的文案必须**等于**词条值，缺键会退回代码里的中文
 * 兜底——那样这两条"四语齐全"的断言就会响（本文件末尾另有四语/占位符核对）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(__dirname, '../..');
// 2026-09-29 第 4 批拆分：候选族函数（improvementChainBlock/reviewSignalBlock 等）
// 已迁 review-candidate.js。切片断言的区间端点（improvementFailureDetail 留在
// views.js）要求 review-candidate 源在前——保持「链块 → 失败详情」的原文顺序。
const viewsSource = readFileSync(resolve(rootDir, 'src/renderer/modules/cognition-assets/review-candidate.js'), 'utf8')
  + '\n' + readFileSync(resolve(rootDir, 'src/renderer/modules/cognition-assets/views.js'), 'utf8');
const coreSource = readFileSync(resolve(rootDir, 'src/renderer/modules/cognition-assets/core.js'), 'utf8');
const LOCALES = ['zh', 'en', 'ja', 'pt'] as const;
const tables = Object.fromEntries(LOCALES.map((name) => [
  name,
  JSON.parse(readFileSync(resolve(rootDir, `src/renderer/locales/${name}.json`), 'utf8')) as Record<string, string>,
])) as Record<typeof LOCALES[number], Record<string, string>>;
const zh = tables.zh;

const esc = (value: string) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 取词：优先真词条（zh.json），缺键才用代码里的兜底——与真机 core.js::T 同序。 */
const T = (key: string, fallback: string, vars?: Record<string, string>) => {
  let text = typeof zh[key] === 'string' ? zh[key] : (fallback != null ? fallback : key);
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
};

const globalScope = globalThis as unknown as Record<string, unknown>;

/** 模块级装配：views.js 是 IIFE，require 只执行一次；此后每次断言只改 store 再重画。 */
let cogAssets: Record<string, unknown> | null = null;
let domRoot: { innerHTML: string } | null = null;
function ensureModule(): { cogAssets: Record<string, unknown>; domRoot: { innerHTML: string } } {
  if (cogAssets && domRoot) return { cogAssets, domRoot };
  cogAssets = {
    T, esc, fmtDate: (value: unknown) => {
      if (!value) return '';
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) return String(value);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    },
    TABS: [
      { id: 'tree', titleKey: 'cognition.tab_tree', title: '认知树' },
      { id: 'ontology', titleKey: 'cognition.tab_ontology', title: '个人本体' },
      { id: 'overview', titleKey: 'cognition.tab_overview', title: '我的认知' },
      { id: 'review', titleKey: 'cognition.tab_review', title: '待我处理' },
      { id: 'organize', titleKey: 'cognition.tab_organize', title: '整理' },
    ],
    // 与 core.js::NS.stats 同口径的待确认计数（countsAsPending && !isSnoozed）：
    // "结论不进待办"这条断言要靠它才有意义。
    stats: () => {
      const store = (cogAssets as Record<string, unknown>).store as Record<string, unknown>;
      const candidates = (store.candidates as Array<{ capabilities?: Record<string, unknown> }> | undefined) || [];
      const pending = candidates.filter((c) => c.capabilities && c.capabilities.countsAsPending
        && !(c.capabilities && c.capabilities.isSnoozed)).length;
      return {
        confirmed: 0, pending, validated: 0, transferOk: 0,
        sourceIssues: 0, failedTasks: 0, coveredAssets: 0, proofCount: 0, attention: 0,
      };
    },
    // views.js 的骨架门控；本文件只关心候选详情，直接视为已加载。
    isRouteLoading: () => false,
    store: { loaded: true, loading: false, errors: [], route: { name: 'activity' } },
  };
  domRoot = { innerHTML: '' };
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { uiInput, uiSwitch, uiTextarea, uiSelect } = require('../../src/renderer/modules/ui-form.js');
  const { uiEmptyState } = require('../../src/renderer/modules/ui-empty.js');
  globalScope.window = {
    CogAssets: cogAssets,
    uiButton: require('../../src/renderer/modules/ui-button.js').uiButton,
    uiCard: require('../../src/renderer/modules/ui-card.js').uiCard,
    uiField: require('../../src/renderer/modules/ui-form.js').uiField,
    uiIconButton: require('../../src/renderer/modules/ui-button.js').uiIconButton,
    uiIconHtml: (() => {
      require('../../src/renderer/modules/icons.js');
      return (globalThis as unknown as Record<string, unknown>).uiIconHtml;
    })(),
    uiInput,
    uiSwitch,
    uiSelect,
    uiTextarea,
    uiEmptyState,
  };
  globalScope.document = { getElementById: () => domRoot };
  // ui-status.js / ui-page-header.js 是 index.html 里的静态共享层（真机在 lazy 加载
  // cognition-assets 之前就绪）：夹具的 window 必须和真机一样有这一层。
  require('../../src/renderer/modules/ui-status.js');
  require('../../src/renderer/modules/ui-page-header.js');
  require('../../src/renderer/modules/cognition-assets/vocabulary.js');
  require('../../src/renderer/modules/cognition-assets/views.js');
  require('../../src/renderer/modules/cognition-assets/review-candidate.js');
  require('../../src/renderer/modules/cognition-assets/review-views.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { cogAssets, domRoot };
}

/** 每帧都把与这两块相关的 store 键显式归零，避免用例之间互相串味。 */
function renderPage(
  routeName: string,
  storePatch: Record<string, unknown> = {},
  routePatch: Record<string, unknown> = {},
): string {
  const { cogAssets: NS, domRoot: rootEl } = ensureModule();
  const store = NS.store as Record<string, unknown>;
  Object.assign(store, {
    loaded: true, loading: false, errors: [],
    captures: [], captureSettings: null, sources: [], proofs: [], assets: [], candidates: [], inbox: [],
    kstarSummaries: null, kstarSummariesSettled: [], kstarEpisode: null,
    adoptionReceipts: null, improvementOutcomes: null, kstarFailures: null,
    assetVersions: null, conversationTitles: {}, conversationTitlesSettled: [],
    deletedAssets: null, cleanupReports: null, inspection: null,
    realUsageKinds: ['usage_recorded', 'projection_confirmed'],
  }, storePatch);
  store.route = {
    name: routeName, category: '', assetId: '', candidateId: '', proofEventId: '',
    captureBucket: '', captureId: '', sourceIssueOpen: '', kstarEpisodeId: '',
    assetVersionId: '', assetEdit: '', assetVersionDiff: '', assetVersionsExpanded: '',
    assetView: '',
    ...routePatch,
  };
  rootEl.innerHTML = '';
  (NS.render as () => void)();
  return rootEl.innerHTML;
}

/** 可见文本（去标签）：rawId 只允许出现在 data-id 这类属性里，绝不作为显示名。 */
const visibleText = (html: string): string => html.replace(/<[^>]*>/g, ' ');

/** 「改进分析」分区是本页最后一块：从它的类名起切到结尾即可（外壳只剩闭合标签）。 */
function improvementTail(html: string): string {
  const at = html.indexOf('ca-improvement');
  return at < 0 ? '' : html.slice(at);
}

const TARGET_STATEMENT = '接口变更后必须同步更新对应文档，并在群里告知。';
const targetAsset = {
  id: 'aa-t1', title: '接口变更同步文档', type: 'rule', status: 'active',
  scope: 'general', statement: TARGET_STATEMENT, version: '2', activeVersion: '2',
};

/** 更新型候选（依据链的目标形态）：任务当时用 v1、当前在用 v2，证据齐。 */
function updateCandidate(over: Record<string, unknown> = {}) {
  return {
    id: 'rcand-u', status: 'pending_review',
    judgment: '接口变更后必须同步更新对应文档与 wiki，并在群里告知；紧急变更可先口头同步。',
    value: '少一次漏更新文档的返工。',
    uncertainty: '紧急变更能否先口头同步还没定。',
    summary: '接口变更同步文档修订',
    suggestedType: 'rule', suggestedScope: 'general',
    suggestedAction: 'update', targetAssetId: 'aa-t1', targetVersionUsed: '1', taskRunId: 'taskrun-1',
    applicableWhen: ['写并行批次工具时'], forbiddenWhen: ['涉及外部合规文档时'],
    evidenceRefs: [{ kind: 'execution', id: 'kse-ep1' }],
    learningProvenance: { episodeId: 'kse-ep1', attribution: 'execution_gap' },
    learningSignal: {
      deltaR: -1, deltaA: 'unknown', outcome: 'worse_than_expected', confidence: 0.95, source: 'review',
      expectedResult: '给出技术结论', actualResult: '模型调用失败',
    },
    capabilities: { canEdit: true, canPromote: true, canDefer: true, canReject: true, countsAsPending: true, isSnoozed: false },
    ...over,
  };
}

/** 同次任务的实际采用回执（只读通道 `recall.assets.adoptionReceipts` 的返回形状）。 */
const appliedReceipt = {
  id: 'aur-1', assetVersion: '1', taskRunId: 'taskrun-1', status: 'applied', evidenceKind: 'tool_call',
  evidence: [{ kind: 'artifact', id: 'art-1', title: 'smoke.md' }], boundary: 'real',
  createdAt: '2026-09-20T02:00:00.000Z',
};

const kstarStore = {
  kstarSummaries: { 'kse-ep1': { id: 'kse-ep1', goal: '把接口变更同步到文档' } },
  kstarSummariesSettled: ['kse-ep1'],
};

function renderUpdateDetail(over: Record<string, unknown> = {}, storeOver: Record<string, unknown> = {}): string {
  const candidate = updateCandidate(over);
  return renderPage('review', {
    assets: [targetAsset], candidates: [candidate], sources: [], ...kstarStore,
    adoptionReceipts: { assetId: 'aa-t1', items: [appliedReceipt] },
    ...storeOver,
  }, { candidateId: String(candidate.id) });
}

/* ────────────────────────── 依据链（T014） ────────────────────────── */

describe('候选依据链（T014 / US-701 AC1·AC2）', () => {
  it('更新型候选详情摊开四要素：原方法与版本 / 同次任务 / 预期→实际 / 采用证据', () => {
    const html = renderUpdateDetail();

    // ① 原方法与版本：方法名 + 任务当时用的版本 vs 当前在用版。
    expect(html).toContain(zh['cognition.improvement_chain_title']);
    expect(html).toContain(zh['cognition.chain_target_label']);
    expect(html).toContain(targetAsset.title);
    expect(html).toContain(T('cognition.chain_target_versions', '', { used: '1', active: '2' }));
    // 既有版本核对预提示原样保留（T007 之外的口径不许漂）。
    expect(html).toContain(T('cognition.candidate_version_mismatch', '', { used: '1', active: '2' }));

    // ② 同次任务：走唯一来源解析器，显示任务目标而不是 kse 内部 id。
    expect(html).toContain(zh['cognition.chain_task_label']);
    expect(html).toContain(T('cognition.evidence_task_review', '', { title: '把接口变更同步到文档' }));

    // ③ 预期 → 实际（learningSignal）。
    expect(html).toContain(zh['cognition.chain_signal_label']);
    expect(html).toContain(`${zh['cognition.review_signal_expected']}：给出技术结论`);
    expect(html).toContain(`${zh['cognition.review_signal_actual']}：模型调用失败`);
    expect(html).toContain(zh['cognition.review_outcome_worse']);

    // ④ 采用证据：只认 applied 回执，且按同次任务取；证据名走唯一解析器。
    expect(html).toContain(zh['cognition.chain_adoption_label']);
    expect(html).toContain(T('cognition.chain_adoption_line', '', { version: '1' }));
    expect(html).toContain(T('cognition.adoption_evidence_line', '', { names: 'smoke.md' }));

    // 另外三段（为什么改 / 适用范围 / 改动点）同屏可见。
    expect(html).toContain(zh['cognition.chain_reason_label']);
    expect(html).toContain(`${zh['cognition.chain_uncertainty_label']}：紧急变更能否先口头同步还没定。`);
    expect(html).toContain(`${zh['cognition.chain_value_label']}：少一次漏更新文档的返工。`);
    expect(html).toContain(zh['cognition.asset_scope_label']);
    expect(html).toContain(`${zh['cognition.asset_version_applicable']}：写并行批次工具时`);
    expect(html).toContain(`${zh['cognition.asset_version_forbidden']}：涉及外部合规文档时`);
    expect(html).toContain(zh['cognition.chain_changed_label']);
    expect(html).toContain(T('cognition.candidate_current_version', '', { n: '2' }));
    expect(html).toContain(TARGET_STATEMENT);
    expect(html).toContain(zh['cognition.chain_proposed_hint']);
    // 融合语义说明照旧（确认后是新版本，不是覆盖）。
    expect(html).toContain(zh['cognition.candidate_fusion_note']);

    // 铁律：rawId 不上屏——可见文本里只有人话名（属性里的 data-id 不算显示名）。
    const text = visibleText(html);
    expect(text).not.toContain('aa-t1');
    expect(text).not.toContain('rcand-u');
    expect(text).not.toContain('kse-ep1');
    expect(text).not.toContain('aur-1');
    expect(text).not.toContain('taskrun-1');
  });

  it('改动点：长正文折叠（复用既有折叠样式），短值直出', () => {
    const long = `${'这条正文很长，长到必须折叠。'.repeat(20)}`;
    const folded = renderUpdateDetail({}, { assets: [{ ...targetAsset, statement: long }] });
    expect(folded).toContain('<details class="ca-tl-body">');
    expect(folded).toContain('<div class="ca-tl-text">');
    // 折叠的是显示，不是内容：全文仍在 DOM 里（展开即可读）。
    expect(folded).toContain(long);

    const inline = renderUpdateDetail();
    expect(inline).not.toContain('ca-tl-body');
  });

  it('不显示 deltaR / confidence 等内部字段，也不重复摆一份「复盘依据」', () => {
    const html = renderUpdateDetail();
    expect(html).not.toContain('deltaR');
    expect(html).not.toContain('confidence');
    // 依据链已含预期→实际段，同屏不再叠加「复盘依据」。
    expect(html).not.toContain(zh['cognition.review_signal_title']);
  });

  it('存量候选没有任务版本：如实说无法核对改进对象，不伪造版本也不出预提示', () => {
    const html = renderUpdateDetail({ targetVersionUsed: '' });
    expect(html).toContain(zh['cognition.chain_target_no_version']);
    expect(html).not.toContain('任务当时使用的是');
    expect(html).toContain(T('cognition.candidate_current_version', '', { n: '2' }));
  });

  it('采用证据按同次任务取：对不上就如实说这次任务里没有；还没拉到就说正在读', () => {
    // 回执存在但属于别的任务 → 不拿别的任务凑数。
    const other = renderUpdateDetail({}, {
      adoptionReceipts: { assetId: 'aa-t1', items: [{ ...appliedReceipt, taskRunId: 'taskrun-9' }] },
    });
    expect(other).toContain(zh['cognition.chain_adoption_task_missing']);

    // 只有「带入」不算采用：非 applied 回执一律不进依据链。
    const injected = renderUpdateDetail({}, {
      adoptionReceipts: { assetId: 'aa-t1', items: [{ ...appliedReceipt, status: 'usage_unknown' }] },
    });
    expect(injected).toContain(zh['cognition.chain_adoption_task_missing']);

    // 还没读到（在读）：说"正在读"，不说"没有"。
    const loading = renderUpdateDetail({}, { adoptionReceipts: null });
    expect(loading).toContain(zh['cognition.chain_adoption_loading']);
  });

  it('新建型候选不走依据链（没有原方法可回指），「复盘依据」照旧', () => {
    const created = {
      id: 'rcand-c', status: 'pending_review', judgment: '发布前先跑一遍冒烟清单。', value: '', summary: '发布前冒烟',
      suggestedType: 'skill_method', suggestedScope: 'general', suggestedAction: 'create',
      evidenceRefs: [{ kind: 'execution', id: 'kse-ep1' }],
      learningSignal: { outcome: 'met_expected', source: 'review', expectedResult: '给出技术结论', actualResult: '调用失败' },
      capabilities: { canEdit: true, canPromote: true, countsAsPending: true, isSnoozed: false },
    };
    const html = renderPage('review', {
      assets: [targetAsset], candidates: [created], ...kstarStore,
    }, { candidateId: 'rcand-c' });
    expect(html).not.toContain(zh['cognition.chain_target_label']);
    expect(html).not.toContain(zh['cognition.improvement_chain_title']);
    expect(html).toContain(zh['cognition.review_signal_title']);
  });

  it('源码级：链块走唯一来源解析器、只用既有折叠样式、从不渲染内部字段', () => {
    const chainBlock = viewsSource.slice(
      viewsSource.indexOf('function improvementChainBlock'),
      viewsSource.indexOf('function improvementFailureDetail'),
    );
    const adoptionHelper = viewsSource.slice(
      viewsSource.indexOf('function adoptionEvidenceHtml'),
      viewsSource.indexOf('function improvementChainBlock'),
    );
    expect(chainBlock.length).toBeGreaterThan(0);
    expect(adoptionHelper.length).toBeGreaterThan(0);
    // 同次任务与采用证据都走唯一解析器出口（不许第二套来源名解析）。
    expect(chainBlock).toContain("evidenceChip({ kind: 'execution', id: episodeId })");
    expect(chainBlock).toContain('adoptionEvidenceHtml(candidate, target)');
    expect(adoptionHelper).toContain('resolveSourceRef(ref)');
    // 长值折叠复用既有样式，不新造控件。
    expect(chainBlock).toContain('foldValue(');
    // 内部字段在任何状态下都不上屏（源码级：整个文件一次都没提）。
    expect(viewsSource).not.toContain('deltaR');
    expect(viewsSource).not.toContain('confidence');
  });
});

/* ─────────────────── 改进分析只读分区（T016） ─────────────────── */

const OUTCOME_ISO = '2026-09-25T03:00:00.000Z';

function outcomeFixture(over: Record<string, unknown> = {}) {
  return {
    id: 'kio-kse-1', episodeId: 'kse-1', reviewId: 'ksr-1',
    conclusion: 'insufficient_evidence',
    reason: '这条任务里方法只被带入过、没有实际采用的证据（证据不足）。',
    createdAt: OUTCOME_ISO, updatedAt: OUTCOME_ISO,
    ...over,
  };
}

const FOUR_OUTCOMES = [
  outcomeFixture({ id: 'kio-kse-1', episodeId: 'kse-1', conclusion: 'no_update', reason: '这次没有达到沉淀门槛的内容。' }),
  outcomeFixture({ id: 'kio-kse-2', episodeId: 'kse-2', conclusion: 'insufficient_evidence', reason: '只被带入、没有实际采用的证据。' }),
  outcomeFixture({ id: 'kio-kse-3', episodeId: 'kse-3', conclusion: 'analysis_failed', reason: '读取实际采用证据失败。', failureCategory: 'evidence' }),
  outcomeFixture({ id: 'kio-kse-4', episodeId: 'kse-4', conclusion: 'submit_failed', reason: '改进提议提交失败（归因：data）。', failureCategory: 'data' }),
];

/* ─────────────────── 文案种子（T009 验收点） ─────────────────── */

describe('本批新增文案键（T009）', () => {
  const NEW_KEYS = [
    'cognition.improvement_chain_title',
    'cognition.chain_target_label', 'cognition.chain_target_versions', 'cognition.chain_target_no_version',
    'cognition.chain_task_label', 'cognition.chain_task_missing',
    'cognition.chain_signal_label', 'cognition.chain_signal_missing',
    'cognition.chain_adoption_label', 'cognition.chain_adoption_line', 'cognition.chain_adoption_line_bare',
    'cognition.chain_adoption_more', 'cognition.chain_adoption_loading',
    'cognition.chain_adoption_task_missing', 'cognition.chain_adoption_empty',
    'cognition.chain_uncertainty_label', 'cognition.chain_value_label',
    'cognition.chain_reason_label', 'cognition.chain_reason_missing',
    'cognition.chain_scope_missing', 'cognition.chain_changed_label', 'cognition.chain_proposed_hint',
    'cognition.improvement_section', 'cognition.improvement_section_hint', 'cognition.improvement_loading',
    'cognition.improvement_read_failed', 'cognition.improvement_empty', 'cognition.improvement_empty_hint',
    'cognition.improvement_conclusion_no_update', 'cognition.improvement_conclusion_insufficient_evidence',
    'cognition.improvement_conclusion_analysis_failed', 'cognition.improvement_conclusion_submit_failed',
    'cognition.improvement_conclusion_other', 'cognition.improvement_task_missing',
    'cognition.improvement_failure_detail', 'cognition.improvement_failure_stage_capture',
    'cognition.improvement_failure_stage_review_inference', 'cognition.improvement_failure_stage_precipitation',
    'cognition.improvement_failure_stage_control_receipt', 'cognition.improvement_failure_stage_other',
    'cognition.improvement_failure_code', 'cognition.improvement_failure_loading', 'cognition.improvement_failure_empty',
    'cognition.improvement_ref_asset_generic', 'cognition.improvement_ref_generic',
  ];
  const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g) || [])].sort().join(',');

  it('四语齐全，占位符跟着一起翻译', () => {
    const gaps = NEW_KEYS.flatMap((key) => LOCALES.filter((locale) => !(key in tables[locale])).map((locale) => `${locale}:${key}`));
    expect(gaps).toEqual([]);
    const mismatches = NEW_KEYS.flatMap((key) => LOCALES
      .filter((locale) => locale !== 'zh')
      .filter((locale) => placeholders(tables[locale][key]) !== placeholders(zh[key]))
      .map((locale) => `${locale}:${key}`));
    expect(mismatches).toEqual([]);
  });

  it('键名不与既有重复（同一个键在词条文件里只能出现一次）', () => {
    const duplicates = NEW_KEYS.filter((key) => {
      const source = readFileSync(resolve(rootDir, 'src/renderer/locales/zh.json'), 'utf8');
      return source.split(`"${key}":`).length - 1 !== 1;
    });
    expect(duplicates).toEqual([]);
  });

  it('调用点可被扫描器看见：内联 T()，或「键, 中文兜底」相邻的常量形态', () => {
    // 间接变量写法（先赋值再传 key）扫描不到，四语缺口会静默退回中文兜底——
    // 与 cognition-i18n-coverage.test.ts 的两条形状一致。
    const literal = (key: string) => new RegExp(`'${key.replace(/\./g, '\\.')}',\\s*'[^']*[\\u4e00-\\u9fff][^']*'`).test(viewsSource);
    const missing = NEW_KEYS.filter((key) => !viewsSource.includes(`T('${key}'`) && !literal(key));
    expect(missing).toEqual([]);
  });
});
