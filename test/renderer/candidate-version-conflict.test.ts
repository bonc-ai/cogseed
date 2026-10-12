/**
 * 确认更新撞版本冲突的**真实调用级**测试（specs/015 T022 / T023 / T028，US-702）。
 *
 * 为什么这样写：冲突处置横跨两层——core.js 的动作层（promote 返回冲突 → 落状态、
 * 重拉当前在用版、重锚只由那一次点击触发）与 views.js 的渲染层（冲突块、按当前
 * 在用版重摆的差异、三态按钮名）。只做"源码里有这一行"的断言挡不住四类真问题：
 * 冲突被吞成普通失败、差异拿旧正文糊弄、重锚悄悄自动重试、按钮名对不存在的
 * 旧版说"更新"。这里把**真的 core.js + 真的 views.js + 真的共享控件 + 真的中文
 * 词条**装进同一个窗口契约里跑（与 cognition-improvement-chain.test.ts 同一模式，
 * 区别是动作层也走真实现），断言落在真实 IPC 载荷与真实渲染出的 HTML 上。
 *
 * 词条表直接用 zh.json：渲染出的文案必须**等于**词条值；文件末尾另有四语核对。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(__dirname, '../..');
// 2026-09-29 views.js 机械拆分：候选族函数迁入 review-candidate.js / review-views.js，
// 源码级断言按加载顺序合并三源扫描（切片锚与 T() 键扫描语义不变）。
const viewsSource = [
  'views.js',
  'review-candidate.js',
  'review-views.js',
].map((file) => readFileSync(resolve(rootDir, `src/renderer/modules/cognition-assets/${file}`), 'utf8')).join('\n');
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

const globalScope = globalThis as unknown as Record<string, unknown>;

type Ns = Record<string, any>;
type Call = { channel: string; payload: Record<string, any> };

const CALLS: Call[] = [];
const TOASTS: Array<{ message: string; variant?: string }> = [];
const ALERTS: string[] = [];
const domRoot = { innerHTML: '' };
let invokeImpl: (channel: string, payload: Record<string, any>) => unknown = () => ({ ok: true });
let NS: Ns | null = null;

const callsOf = (channel: string): Call[] => CALLS.filter((entry) => entry.channel === channel);

/** 词条取法同 core.js::T：优先真词条（zh.json），缺键才用代码里的中文兜底。 */
const localized = (key: string, fallback?: string, vars?: Record<string, string>) => {
  let text = typeof zh[key] === 'string' ? zh[key] : (fallback != null ? fallback : key);
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
};
const T = (key: string, fallback?: string, vars?: Record<string, string>) => localized(key, fallback, vars);

/** 模块级装配：core.js 先挂 window.CogAssets（提供 T/esc/namespace/store/api），
 *  views.js 再挂 render——与真机 index.html 的加载顺序一致。require 只执行一次。 */
function ensureModule(): Ns {
  if (NS) return NS;
  const windowStub: Record<string, unknown> = {
    cogseed: {
      invoke: async (channel: string, payload: Record<string, any>) => {
        CALLS.push({ channel, payload: payload || {} });
        return invokeImpl(channel, payload || {});
      },
    },
    uiButton: require('../../src/renderer/modules/ui-button.js').uiButton,
    uiIconButton: require('../../src/renderer/modules/ui-button.js').uiIconButton,
    uiInput: require('../../src/renderer/modules/ui-form.js').uiInput,
    uiSwitch: require('../../src/renderer/modules/ui-form.js').uiSwitch,
    uiTextarea: require('../../src/renderer/modules/ui-form.js').uiTextarea,
    uiEmptyState: require('../../src/renderer/modules/ui-empty.js').uiEmptyState,
    escapeHtml: esc,
    uiToast: (message: string, options: { variant?: string } = {}) => { TOASTS.push({ message, variant: options.variant }); },
    uiAlert: async (message: string) => { ALERTS.push(message); },
    uiConfirm: async () => true,
    uiConfirmDanger: async () => true,
    refreshPersonalOntology: async () => {},
    t: (key: string, vars?: Record<string, string>) => localized(key, undefined, vars),
  };
  globalScope.window = windowStub;
  globalScope.document = { getElementById: () => domRoot, querySelector: () => null, querySelectorAll: () => [] };
  /* eslint-disable @typescript-eslint/no-require-imports */
  require('../../src/renderer/modules/icons.js');
  windowStub.uiIconHtml = (globalThis as unknown as Record<string, unknown>).uiIconHtml;
  // ui-status.js / ui-page-header.js 是 index.html 里的静态共享层（真机先于
  // cognition-assets 就绪）：夹具的 window 必须和真机一样有这一层。
  require('../../src/renderer/modules/ui-status.js');
  require('../../src/renderer/modules/ui-page-header.js');
  require('../../src/renderer/modules/cognition-assets/core.js');
  require('../../src/renderer/modules/cognition-assets/vocabulary.js');
  require('../../src/renderer/modules/cognition-assets/views.js');
  require('../../src/renderer/modules/cognition-assets/review-candidate.js');
  require('../../src/renderer/modules/cognition-assets/review-views.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  NS = windowStub.CogAssets as Ns;
  return NS;
}

/* ────────────────────────── 夹具 ────────────────────────── */

/** 资产列表里的目标资产：**冲突前**的旧快照（v1 在用、正文 OLD_BODY）。
 *  真机撞冲突时列表缓存正是这个样子——断言"没用旧正文糊弄"就靠它。 */
const OLD_BODY = '接口变更后必须同步更新对应文档。';
const NEW_BODY = '接口变更后必须同步更新对应文档与 wiki，并在群里告知；紧急变更可先口头同步。';
const targetAsset = {
  id: 'aa-t1', title: '接口变更同步文档', type: 'rule', status: 'active',
  scope: 'general', statement: OLD_BODY, version: '1', activeVersion: '1',
};

/** 当前在用版（v3）的快照：冲突后由 recall.assets.versions.list 给出。 */
const currentVersionSnapshot = {
  version: '3', title: '接口变更同步文档（已在用版）', statement: NEW_BODY,
  scope: 'product', applicableWhen: ['写并行批次工具时'], forbiddenWhen: ['涉及外部合规文档时'],
  evidenceRefs: [],
};

/** 更新型候选：任务当时用 v1，冲突返回里当前在用版是 v3。 */
function updateCandidate(over: Record<string, unknown> = {}) {
  return {
    id: 'rcand-u', status: 'pending_review',
    judgment: '接口变更后必须同步更新对应文档与 wiki，并在群里告知。',
    value: '少一次漏更新文档的返工。',
    uncertainty: '紧急变更能否先口头同步还没定。',
    summary: '接口变更同步文档修订',
    suggestedType: 'rule', suggestedScope: 'general',
    suggestedAction: 'update', targetAssetId: 'aa-t1', targetVersionUsed: '1', taskRunId: 'taskrun-1',
    applicableWhen: ['写并行批次工具时'], forbiddenWhen: ['涉及外部合规文档时'],
    evidenceRefs: [{ kind: 'execution', id: 'kse-ep1' }],
    learningProvenance: { episodeId: 'kse-ep1', attribution: 'execution_gap' },
    capabilities: {
      canEdit: true, canPromote: true, canDefer: true, canReject: true,
      countsAsPending: true, isSnoozed: false, isTerminal: false, displayState: 'needs_review',
    },
    ...over,
  };
}

const rawConflict = {
  baselineVersion: '1', currentVersion: '3', targetVersionUsed: '1',
};

/** 默认 IPC 应答：快照类通道返回夹具数据，其余一律 ok。 */
function defaultInvoke(candidate: Record<string, unknown> = updateCandidate()) {
  return (channel: string, payload: Record<string, any>): unknown => {
    if (channel === 'recall.assets.list') return { ok: true, assets: [targetAsset] };
    if (channel === 'recall.candidates.list') return { ok: true, candidates: [candidate] };
    if (channel === 'recall.assets.versions.list') {
      return { ok: true, versions: [{ version: '3', snapshot: currentVersionSnapshot }, { version: '1', snapshot: { statement: OLD_BODY } }], usage: [], audit: [], frozen: [] };
    }
    if (channel === 'recall.assets.adoptionReceipts') return { ok: true, receipts: [] };
    return { ok: true };
  };
}

function resetWorld(candidate: Record<string, unknown> = updateCandidate()) {
  const ns = ensureModule();
  CALLS.length = 0;
  TOASTS.length = 0;
  ALERTS.length = 0;
  domRoot.innerHTML = '';
  invokeImpl = defaultInvoke(candidate);
  Object.assign(ns.store, {
    loaded: true, loading: false, errors: [],
    assets: [targetAsset], candidates: [candidate], sources: [], captures: [], captureSettings: null,
    proofs: [], inbox: [], kstarSummaries: null, kstarSummariesSettled: [], kstarEpisode: null,
    adoptionReceipts: null, improvementOutcomes: null, kstarFailures: null, assetVersions: null,
    candidateVersionConflict: null, conversationTitles: {}, conversationTitlesSettled: [],
    deletedAssets: null, cleanupReports: null, inspection: null, tree: null,
    realUsageKinds: ['usage_recorded', 'projection_confirmed'],
  });
  ns.store.route = {
    name: 'review', category: '', assetId: '', candidateId: 'rcand-u', proofEventId: '',
    captureBucket: '', captureId: '', sourceIssueOpen: '', kstarEpisodeId: '',
    assetVersionId: '', assetEdit: '', assetVersionDiff: '', assetVersionsExpanded: '',
    assetView: '', familyRename: '', ontologyBox: '',
  };
  return ns;
}

function renderDetail(): string {
  const ns = ensureModule();
  domRoot.innerHTML = '';
  (ns.render as () => void)();
  return domRoot.innerHTML;
}

/** 可见文本（去标签）：rawId 只允许出现在 data-id 这类属性里，绝不作为显示名。 */
const visibleText = (html: string): string => html.replace(/<[^>]*>/g, ' ');

/* ────────────── ① 冲突处置：不静默覆盖 + 差异按当前版重摆（T022） ────────────── */

describe('确认更新撞版本冲突的处置（T022 / US-702）', () => {
  /** 真实点击链路：actions.adoptCandidate → promote 返回结构化冲突。 */
  async function promoteIntoConflict(over: Record<string, unknown> = {}) {
    const ns = resetWorld();
    const candidate = Object.assign(updateCandidate(), over);
    ns.store.candidates = [candidate];
    invokeImpl = (channel, payload) => {
      // 重锚有记录：任何带 confirmBaselineVersion 的调用都不该出现在"撞冲突"这一步。
      if (channel === 'recall.candidates.promote') {
        const confirm = (payload as Record<string, unknown>).confirmBaselineVersion;
        if (confirm) return { ok: true, assetId: 'aa-t1' };
        return { ok: false, state: 'pending', versionConflict: rawConflict, message: '这条资产在你确认之前被改过…' };
      }
      return defaultInvoke(candidate)(channel, payload);
    };
    await ns.actions.adoptCandidate('rcand-u', undefined);
    return ns;
  }

  it('冲突：如实说"这次没有生效"，不静默、不假装成功、候选仍待确认', async () => {
    const ns = await promoteIntoConflict();
    const html = renderDetail();

    expect(html).toContain(T('cognition.candidate_version_conflict_not_applied', '', { baseline: '1', current: '3' }));
    expect(html).toContain(zh['cognition.candidate_version_conflict_title']);
    // 没有"已保存/已成为正式资产"这类成功话术，也没有离开候选详情。
    expect(html).not.toContain(zh['cognition.candidate_promoted']);
    expect(html).not.toContain(zh['cognition.candidate_status_promoted']);
    expect(TOASTS.map((t) => t.message)).not.toContain(zh['cognition.candidate_promoted']);
    expect(ns.store.route.candidateId).toBe('rcand-u');
    // 候选未被本层改写状态（它仍是待处理；真实状态由 recall.candidates.read 说）。
    expect(ns.store.candidates[0].status).toBe('pending_review');
    expect(html).toContain(zh['cognition.candidate_status_pending']);
  });

  it('差异按当前在用版重摆：正文与版本号用 versions.list 的当前版，不拿 v1 旧正文糊弄', async () => {
    const ns = await promoteIntoConflict();
    const html = renderDetail();

    // 当前在用版正文（v3 快照）在两处可见：冲突块的"当前在用（v3）的正文"
    // 与依据链的改动点；旧正文（资产列表里那份）一处都不许出现。
    expect(html).toContain(T('cognition.candidate_version_conflict_current_body', '', { n: '3' }));
    expect(html).toContain(NEW_BODY);
    expect(html).not.toContain(OLD_BODY);
    // 拟生效内容：候选判断照原样摆出来对照。
    expect(html).toContain(zh['cognition.candidate_version_conflict_proposed_body']);
    expect(html).toContain(updateCandidate().judgment as string);
    // 版本号口径：与当前在用版一致（v3），不是候选锚定的 v1。
    expect(html).toContain(T('cognition.candidate_current_version', '', { n: '3' }));
    expect(html).not.toContain(T('cognition.candidate_current_version', '', { n: '1' }));
    // 逐字段差异（当前 → 拟生效）：快照里范围 product、候选 general。
    expect(html).toContain(`${zh['cognition.asset_version_diff_scope']}`);
    expect(html).toContain(`${esc('product')} → ${esc('general')}`);
    // 状态里记的是冲突返回体的版本，而不是本地猜的。
    expect(ns.store.candidateVersionConflict).toMatchObject({
      candidateId: 'rcand-u', baselineVersion: '1', currentVersion: '3', targetVersionUsed: '1',
    });
    expect(ns.store.candidateVersionConflict.currentStatement).toBe(NEW_BODY);
    expect(ns.store.candidateVersionConflict.versionsFailed).toBe(false);
    // 反证：同一份 store 去掉冲突态后，正文就来自资产列表里那份旧快照——
    // 所以上面的 not.toContain(OLD_BODY) 不是空断言，而是"冲突后换成了 v3 正文"。
    ns.store.candidateVersionConflict = null;
    expect(renderDetail()).toContain(OLD_BODY);
    // 数据来源：强制重拉版本链（带目标资产），没有写任何东西。
    expect(callsOf('recall.assets.versions.list').map((c) => c.payload.assetId)).toContain('aa-t1');
    expect(callsOf('recall.candidates.promote')).toHaveLength(1);
    for (const write of ['recall.candidates.update', 'recall.candidates.reject', 'recall.candidates.defer', 'recall.candidates.ignore']) {
      expect(callsOf(write), write).toHaveLength(0);
    }
  });

  it('既有「核对改进对象」预提示与冲突提示并存，不互相顶替', async () => {
    await promoteIntoConflict();
    const html = renderDetail();
    expect(html).toContain(T('cognition.candidate_version_mismatch', '', { used: '1', active: '3' }));
    expect(html).toContain(T('cognition.candidate_version_conflict_not_applied', '', { baseline: '1', current: '3' }));
  });

  it('再次确认只由用户点击触发：带对的版本号，且冲突本身不自动重试', async () => {
    const ns = await promoteIntoConflict();
    // ① 撞冲突那一次：promote 只发了一次，且没有带任何重锚声明。
    const first = callsOf('recall.candidates.promote');
    expect(first).toHaveLength(1);
    expect(first[0].payload.confirmBaselineVersion).toBeUndefined();
    expect(renderDetail()).toContain('data-rebase="1"');

    // ② 用户点「按当前版本重新确认」（act 与「确认更新」同一通道，app.js 会把
    //    表单值一起带来）→ 这次点击才带 confirmBaselineVersion = 当前在用版。
    CALLS.length = 0;
    await ns.actions.adoptCandidate('rcand-u', { judgment: '接口变更后必须同步更新对应文档与 wiki，并在群里告知。', suggestedScope: 'general', suggestedType: 'rule' });
    const rebased = callsOf('recall.candidates.promote');
    expect(rebased).toHaveLength(1);
    expect(rebased[0].payload.confirmBaselineVersion).toBe('3');
    expect(rebased[0].payload.candidateId).toBe('rcand-u');
    // 表单里改过的内容照常先落候选，再做重锚确认（一次点击一个来回，不重试）。
    expect(callsOf('recall.candidates.update')).toHaveLength(1);
    // 成功落地：冲突状态清掉、按既有成功路径给反馈。
    expect(ns.store.candidateVersionConflict).toBeNull();
    expect(TOASTS.map((t) => t.message)).toContain(zh['cognition.candidate_promoted']);
  });

  it('重锚后又被改过：仍按结构化冲突重摆（新版本号），不静默、不自动重试', async () => {
    const ns = await promoteIntoConflict();
    CALLS.length = 0;
    TOASTS.length = 0;
    let promoteCount = 0;
    invokeImpl = (channel, payload) => {
      if (channel === 'recall.candidates.promote') {
        promoteCount += 1;
        return {
          ok: false, state: 'pending', message: '…',
          versionConflict: { baselineVersion: '1', currentVersion: '4', targetVersionUsed: '1' },
        };
      }
      return defaultInvoke()(channel, payload);
    };
    await ns.actions.adoptCandidate('rcand-u', { judgment: '接口变更后必须同步更新对应文档与 wiki，并在群里告知。', suggestedScope: 'general', suggestedType: 'rule' });
    expect(promoteCount).toBe(1);
    expect(TOASTS.map((t) => t.message)).not.toContain(zh['cognition.candidate_promoted']);
    expect(ns.store.candidateVersionConflict).toMatchObject({ currentVersion: '4' });
    const html = renderDetail();
    expect(html).toContain(T('cognition.candidate_version_conflict_not_applied', '', { baseline: '1', current: '4' }));
    // 版本链随新版本重取（不是拿上一次的 v3 应付）。
    expect(callsOf('recall.assets.versions.list').length).toBeGreaterThan(0);
  });

  it('读不到当前在用版正文：如实说无法核对改进对象，不给重锚按钮（稍后/拒绝仍可点）', async () => {
    const ns = await promoteIntoConflict();
    CALLS.length = 0;
    invokeImpl = (channel, payload) => {
      if (channel === 'recall.candidates.promote') return { ok: false, state: 'pending', versionConflict: rawConflict, message: '…' };
      if (channel === 'recall.assets.versions.list') return { ok: false, error: 'versions unavailable' };
      return defaultInvoke()(channel, payload);
    };
    // 再走一次真实链路：这次版本链读不到。
    await ns.actions.adoptCandidate('rcand-u', undefined);
    expect(ns.store.candidateVersionConflict.versionsFailed).toBe(true);
    const html = renderDetail();
    expect(html).toContain(zh['cognition.candidate_version_conflict_body_missing']);
    expect(html).not.toContain('data-rebase="1"');
    // 控件回到可操作态：另外两条出口还在（不是禁用死锁）。
    expect(html).toContain('data-action="defer"');
    expect(html).toContain('data-action="reject"');
  });

  it('用户改「稍后处理 / 拒绝」后，冲突提示不再挂着', async () => {
    const ns = await promoteIntoConflict();
    CALLS.length = 0;
    await ns.actions.decideCandidate('rcand-u', 'defer');
    expect(ns.store.candidateVersionConflict).toBeNull();
    expect(callsOf('recall.candidates.defer')).toHaveLength(1);
    expect(renderDetail()).not.toContain(zh['cognition.candidate_version_conflict_not_applied_plain']);
  });

  it('versionCheckSkipped：确认照常生效但如实提示无法核对改进对象（不给重锚按钮）', async () => {
    // ① 展示期（存量候选没有任务当时的版本）：依据链照实说，页面上没有重锚按钮。
    const ns = resetWorld();
    ns.store.candidates = [updateCandidate({ targetVersionUsed: '', learningProvenance: {} })];
    const detail = renderDetail();
    expect(detail).toContain(zh['cognition.chain_target_no_version']);
    expect(detail).not.toContain('data-rebase="1"');
    expect(detail).not.toContain('data-version-conflict');

    // ② 确认期：主进程返回 versionCheckSkipped → 如实提示，不假装核过。
    TOASTS.length = 0;
    invokeImpl = (channel, payload) => {
      if (channel === 'recall.candidates.promote') return { ok: true, assetId: 'aa-t1', versionCheckSkipped: true };
      return defaultInvoke()(channel, payload);
    };
    await ns.actions.adoptCandidate('rcand-u', undefined);
    const toast = TOASTS.find((t) => t.message === zh['cognition.candidate_version_check_skipped']);
    expect(toast).toBeTruthy();
    expect(toast?.variant).toBe('warning');
    // 跳过核对不是冲突：不摆冲突块、不留冲突状态（它确实生效了）。
    expect(ns.store.candidateVersionConflict).toBeNull();
  });

  it('只读（缺 capabilities）时连重锚也不给：一切动作按钮都不出现', async () => {
    const ns = await promoteIntoConflict();
    ns.store.candidates = [updateCandidate({ capabilities: undefined })];
    const html = renderDetail();
    expect(html).not.toContain('data-act="cand-adopt-with-form"');
    expect(html).not.toContain('data-act="cand-decide"');
    expect(html).not.toContain('data-rebase="1"');
    // 冲突提示本身照旧可见（只读不等于不说）。
    expect(html).toContain(T('cognition.candidate_version_conflict_not_applied', '', { baseline: '1', current: '3' }));
  });
});

/* ────────────── ② 三态与按钮名按型分支（T023） ────────────── */

describe('候选三态与按钮名按型分支（T023 / US-702）', () => {
  const labelsOf = (action: string, over: Record<string, unknown> = {}) => {
    const ns = resetWorld();
    ns.store.candidates = [updateCandidate({ suggestedAction: action, ...over })];
    return visibleText(renderDetail());
  };

  it('更新型（update / limit_scope 且有目标方法）：「保存更新 / 稍后处理 / 拒绝」，与 008 卡片同一批词条', () => {
    for (const action of ['update', 'limit_scope']) {
      const text = labelsOf(action);
      expect(text, action).toContain(zh['recall.asset_approval.confirm']);
      expect(text, action).toContain(zh['recall.asset_approval.defer']);
      expect(text, action).toContain(zh['recall.asset_approval.reject']);
      // 更新型不说新建型的旧文案「保存并使用」（2026-09-29 A6 词根统一后
      // 新建=「保存」、更新=「保存更新」，同根不同缀——按完整旧词钉，不再
      // 用子串断言：「保存更新」本身包含「保存」子串）。
      expect(text, action).not.toContain('保存并使用');
    }
  });

  it('新建型保持既有措辞：「保存并使用 / 稍后处理 / 不保存」', () => {
    const text = labelsOf('create');
    expect(text).toContain(zh['cognition.candidate_save_and_use']);
    expect(text).toContain(zh['cognition.candidate_defer_action']);
    expect(text).toContain(zh['cognition.candidate_reject']);
    expect(text).not.toContain(zh['recall.asset_approval.confirm']);
  });

  it('没有目标方法的候选不说"更新"（对不存在的旧版不许说更新）', () => {
    // update 却缺 targetAssetId：不出现「确认更新」。
    const text = labelsOf('update', { targetAssetId: '' });
    expect(text).not.toContain(zh['recall.asset_approval.confirm']);
    expect(text).toContain(zh['cognition.candidate_save_and_use']);
    expect(text).not.toContain(zh['recall.asset_approval.reject']);
  });

  it('pause 提案保持既有呈现：不走重锚路径、也没有版本冲突块', () => {
    const text = labelsOf('pause');
    expect(text).toContain(zh['cognition.candidate_save_and_use']);
    expect(text).not.toContain('data-rebase="1"');
    expect(text).not.toContain('data-version-conflict');
    // pause 没有版本比对面：依据链（按 v{n} 对当前版）也不出现。
    expect(text).not.toContain(zh['cognition.improvement_chain_title']);
  });
});

/* ────────────── ③ 结构性口径（源码级钉住） ────────────── */

/** 从 `{` 起按深度取一段（做法同 recall-candidate-decision-flow.test.ts）。 */
function sliceBlock(source: string, start: number): string {
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated block');
}
const coreFn = (marker: string) => sliceBlock(coreSource, coreSource.indexOf(marker));

describe('冲突链路的源码级不变量（T028）', () => {
  it('冲突分支在成功话术之前返回：不落终态、不自动重试', () => {
    const adopt = coreFn('async adoptCandidate');
    const conflictAt = adopt.indexOf('await openCandidateVersionConflict(candidate, error.versionConflict);');
    const promotedToastAt = adopt.indexOf("toast(T('cognition.candidate_promoted'");
    expect(conflictAt).toBeGreaterThan(-1);
    // 冲突分支紧跟 return：不会掉进下面的成功 toast / 导航 / 重放。
    expect(adopt.slice(conflictAt, conflictAt + 200)).toContain('return;');
    expect(conflictAt).toBeLessThan(promotedToastAt);
  });

  it('重锚声明由冲突状态驱动，值取冲突返回的当前在用版，且只挂在主确认调用上', () => {
    const adopt = coreFn('async adoptCandidate');
    // 冲突状态还挂在这个候选上 → 这次点击就是"看过新差异后再确认"。
    expect(adopt).toContain("const confirmBaselineVersion = String((conflictState && conflictState.currentVersion) || '');");
    expect(adopt).toContain('result = await promote(false, confirmBaselineVersion);');
    // 相似资产那条分流（promote(true)）不重锚：它是另一条路，主进程对 create
    // 落点也没有版本比对面。
    expect(adopt).toContain('result = await promote(true);');
    expect(adopt).toContain('...(baseline ? { confirmBaselineVersion: baseline } : {})');
  });

  it('冲突落状态只读不写：重拉资产与版本链，零写通道', () => {
    const handler = coreFn('async function openCandidateVersionConflict');
    expect(handler).toContain('store.assetVersions = null');
    expect(handler).toContain('NS.loadAssetVersions(targetAssetId, true)');
    for (const write of ['promote', 'candidates.update', 'candidates.reject', 'api.call']) {
      expect(handler, write).not.toContain(write);
    }
  });

  it('结构化冲突不被 IPC 客户端吞掉：versionConflict 随错误上抛', () => {
    expect(coreSource).toContain('if (result.versionConflict) error.versionConflict = result.versionConflict;');
  });

  it('冲突块只用共享控件与既有折叠件，不新增裸控件/内联 SVG', () => {
    const block = viewsSource.slice(
      viewsSource.indexOf('function candidateVersionConflictBlock'),
      viewsSource.indexOf('/** 待确认口径'),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('btn(');
    expect(block).toContain('foldValue(');
    expect(block).not.toContain('<button');
    expect(block).not.toContain('<svg');
    expect(block).not.toContain('document.');
  });
});

/* ────────────── ④ 文案种子（T009 验收点：四语齐） ────────────── */

describe('版本冲突文案键（T009 验收点）', () => {
  const NEW_KEYS = [
    'cognition.candidate_version_conflict_not_applied',
    'cognition.candidate_version_conflict_not_applied_plain',
    'cognition.candidate_version_conflict_title',
    'cognition.candidate_version_conflict_current_body',
    'cognition.candidate_version_conflict_proposed_body',
    'cognition.candidate_version_conflict_loading',
    'cognition.candidate_version_conflict_body_missing',
    'cognition.candidate_version_conflict_rebase',
    'cognition.candidate_version_check_skipped',
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
    const source = readFileSync(resolve(rootDir, 'src/renderer/locales/zh.json'), 'utf8');
    const duplicates = NEW_KEYS.filter((key) => source.split(`"${key}":`).length - 1 !== 1);
    expect(duplicates).toEqual([]);
  });

  it('调用点可被扫描器看见：内联 T()，或「键, 中文兜底」相邻的常量形态', () => {
    const sources = `${viewsSource}\n${coreSource}`;
    const literal = (key: string) => new RegExp(`'${key.replace(/\./g, '\\.')}',\\s*'[^']*[\\u4e00-\\u9fff][^']*'`).test(sources);
    const missing = NEW_KEYS.filter((key) => !sources.includes(`T('${key}'`) && !literal(key));
    expect(missing).toEqual([]);
  });
});
