const _skillsLog = createLogger('skills');
// ─── Skills ───

let _skillsCache = null;
// Read-only open-tier entries. External packages render as package cards,
// while machine-global folders still render their individual skills. Package
// SKILL.md files remain available to the agent layer, but are not expanded into
// a wall of user-facing recipe cards.
let _openSkillsCache = [];
let _packagesCache = [];
let _skillsLoadInFlight = null;
let _skillsCognitionRefreshTimer = null;
let _skillsCognitionCaptureRequestId = 0;
let _skillsCognitionCaptureRequestsInFlight = 0;
let _recallSkillDraftAutoQueue = Promise.resolve();
const _recallSkillDraftAutoPending = new Set();
let _selectedSkill = null;    // { source, id }
let _expandedGlobalSkillGroups = new Set();
const _GLOBAL_SKILL_GROUP_MIN = 2;


const _skillsCognitionState = {
  page: 'inbox',
  /** 「待我处理」的服务端读模型（cognition.inbox.list）。渲染层不自己判断
   *  什么算待办——判断在 formal-assets/inbox.ts，与 gate 同源。 */
  inboxItems: [],
  /** 「使用与证明」右侧回执面板对应的那条使用事件。 */
  selectedProofEventId: '',
  /** 「使用与证明」当前看的是哪一层结论：全部 / 已引用 / 传递已证明 /
   *  效果已验证 / Evidence 不足。纯前端过滤，事实本身不变。 */
  proofFilter: 'all',
  /** 「使用与证明」已取到的事实链与回执。缓存它是为了让展开/切筛选这类纯本地
   *  状态变化只重画、不重新走 IPC——否则每点一次都要把整页清成 loading 再等
   *  两次往返，看起来就是闪。 */
  proofData: null,
  proofLoadFailed: false,
  /** 正在取证的那条效果评价：`{ eventId }`。只有「更好了」这一档需要——它是
   *  唯一能把成熟度推到 effectiveness_validated 的结论，按 PRD 3.6 必须先给出
   *  可追溯依据，不能一个赞就算证明。其余三档直接落账，不进这个状态。 */
  proofRatingDraft: null,
  /** 「管理来源」中已展开条目列表的来源类型。首屏是五类概览卡，条目按需展开。 */
  expandedSourceKinds: [],
  /** 「从历史会话沉淀」的搜索词。只过滤已取到的列表，不发请求。 */
  manualSearchQuery: '',
  recallCandidates: [],
  sources: [],
  teachingSignals: [],
  captures: [],
  recentCaptures: [],
  captureCounts: { waiting: 0, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0 },
  captureNextCursor: null,
  captureFilter: 'all',
  captureSettings: null,
  captureModel: null,
  captureSettingsExpanded: false,
  selectedCaptureId: '',
  // Candidate review is a cross-capture work queue. Keep selection in the
  // renderer so users can review several settled conversations together.
  selectedRecallCandidateIds: [],
  candidatePoolSelectionInitialized: false,
  loadErrors: [],
  editingRecallCandidateId: '',
  writingRecallCandidateId: '',
  assets: [],
  selectedAssetId: '',
  assetCategoryFilter: '',
  assetSearchQuery: '',
  assetHistoryById: {},
  visibleAssetHistoryId: '',
  assetChainById: {},
  visibleAssetChainId: '',
  /** 「候选详情」当前打开的那一条。列表页仍用 selectedCaptureId 选沉淀任务，
   *  两者是不同维度，不能共用一个字段。 */
  selectedCandidateId: '',
  /** 认知树（recall.tree.read）。按需加载：进树页才拉，不进快照的九路并行——
   *  它只服务一个入口，放进快照会让每次刷新都多付一次读盘。 */
  tree: null,
  /** 「Skill 更新候选」当前打开的那一条的读模型（cognition.skills.summary
   *  + recall.workspaceRefs.list）。同样按需加载。 */
  skillUpdate: null,
  /** 三个读口返回的**真实**总数（items + total 契约）。与 `assets.length` /
   *  `teachingSignals.length` 分开存：后者是本次取回了几条，前者是一共有几条，
   *  把截断后的长度当总数正是 G-2/G-3 的病根。 */
  totals: { assets: null, teachingSignals: null, inboxItems: null },
  /** 「已处理历史」（cognition.reviewDecisions.list）。按需加载。 */
  reviewHistory: null,
  /** 「非资产分流」的接续快照（recall.continuation.list）。同样按需加载：
   *  它只服务一个入口，扫全部会话找快照文件的代价不该摊到每次刷新上。 */
  continuation: null,
  /** 「非资产分流」当前展开的那一条会话 id。展开时用 `recall.continuation.read`
   *  取一次完整快照回填——列表口和单读口取的是同一份文件，展开不是二次编造。 */
  selectedContinuationId: '',
  dashboard: null,
  loadedAt: 0,
  loading: false,
};

function _cognitionText(key, fallback) {
  const value = typeof t === 'function' ? t(key) : key;
  return value && value !== key ? value : fallback;
}

/**
 * 四个任务页共用的内容层页头。顶层标题回答“这是什么模块”，这里回答
 * “来到这一页要完成什么”；数字只接收调用方从现有读模型算出的真实值。
 *
 * 辅助页（管理来源 / 沉淀活动 / 候选详情 / 认知树 / 非资产分流 / Skill 更新
 * 候选）用同一个页头，并额外传 `backPage`：它们不在 tab 条里占位，四个 tab
 * 全部处于未选中态，用户没有可依赖的返回路径。
 */
function _renderCognitionTaskHero({ eyebrowKey, eyebrow, titleKey, title, hintKey, hint, metrics = [], backPage = '', backKey = '', back = '' }) {
  const metricHtml = metrics.length
    ? `<div class="cognition-task-metrics">${metrics.map((metric) => `<div class="cognition-task-metric"><strong>${escapeHtml(String(metric.value))}</strong><span>${escapeHtml(_cognitionText(metric.key, metric.label))}</span></div>`).join('')}</div>`
    : '';
  const backHtml = backPage
    ? `<div class="cognition-task-hero-aside"><button type="button" class="btn btn-sm" data-cognition-page-link="${escapeHtml(backPage)}">${escapeHtml(_cognitionText(backKey || 'cognition.back_to_inbox', back || '返回待处理'))}</button></div>`
    : '';
  return `<header class="cognition-task-hero">
    <span class="cognition-task-eyebrow">${escapeHtml(_cognitionText(eyebrowKey, eyebrow))}</span>
    <div class="cognition-task-hero-row"><div><h2>${escapeHtml(_cognitionText(titleKey, title))}</h2><p>${escapeHtml(_cognitionText(hintKey, hint))}</p></div>${metricHtml}${backHtml}</div>
  </header>`;
}

/**
 * 候选能力由主进程随 DTO 下发（features/recall/candidate-capabilities.ts）。
 * 渲染层不再自己解释 raw status——实机候选多数是 weak_observation，旧的
 * `status === 'pending_review'` 判据会让待办、批量勾选、计数同时归零。
 */
const RECALL_CANDIDATE_READ_ONLY_CAPABILITIES = Object.freeze({
  canView: true, canEdit: false, canConfirm: false, canPromote: false,
  canReject: false, canDefer: false, canRetry: false, canBatchSelect: false,
  needsUserAction: false, countsAsPending: false, isSnoozed: false, isTerminal: false,
  displayState: 'unknown', disabledReason: 'candidate_state_unknown',
});

/** 拿不到能力（旧快照 / 降级读）时按只读处理，绝不猜成可操作。 */
function _recallCandidateCapabilities(candidate) {
  const capability = candidate && candidate.capabilities;
  return capability && typeof capability === 'object' ? capability : RECALL_CANDIDATE_READ_ONLY_CAPABILITIES;
}

/** 产品态文案。后端枚举不进 UI。 */
function _recallCandidateStateLabel(capability) {
  const labels = {
    needs_review: _cognitionText('cognition.candidate_state_needs_review', '待确认'),
    weak_evidence: _cognitionText('cognition.candidate_state_weak_evidence', '证据较弱'),
    deferred: _cognitionText('cognition.candidate_state_deferred', '稍后处理'),
    confirmed: _cognitionText('cognition.candidate_state_confirmed', '已确认并沉淀'),
    rejected: _cognitionText('cognition.candidate_state_rejected', '已拒绝'),
    ignored: _cognitionText('cognition.candidate_state_ignored', '已忽略'),
    expired: _cognitionText('cognition.candidate_state_expired', '已失效'),
    failed: _cognitionText('cognition.candidate_state_failed', '处理失败'),
    superseded: _cognitionText('cognition.candidate_state_superseded', '已被更新版本替代'),
    unknown: _cognitionText('cognition.candidate_state_unknown', '状态未知'),
  };
  return labels[capability.displayState] || labels.unknown;
}

/** disabled 的真实原因。tooltip / 说明文案都取这里，不再各自猜。 */
function _recallCandidateBlockedText(reason) {
  const texts = {
    candidate_confirmed: _cognitionText('cognition.candidate_blocked_confirmed', '已确认并沉淀为资产，后续修改请在正式资产里进行'),
    candidate_rejected: _cognitionText('cognition.candidate_blocked_rejected', '已拒绝，不再进入待办'),
    candidate_ignored: _cognitionText('cognition.candidate_blocked_ignored', '已忽略，不再进入待办'),
    candidate_expired: _cognitionText('cognition.candidate_blocked_expired', '已失效，无法继续处理'),
    candidate_superseded: _cognitionText('cognition.candidate_blocked_superseded', '已被更新版本替代'),
    candidate_evidence_insufficient: _cognitionText('cognition.candidate_blocked_evidence', '证据不足，补充证据后才能确认'),
    candidate_high_risk_needs_single_review: _cognitionText('cognition.candidate_blocked_high_risk', '高风险候选需要单独确认，不能批量入库'),
    candidate_state_unknown: _cognitionText('cognition.candidate_blocked_unknown', '状态未知，暂时无法处理'),
  };
  return texts[reason] || '';
}

function _cognitionStatusLabel(status) {
  const labels = {
    prepared: _cognitionText('cognition.status_prepared', '准备中'),
    succeeded: _cognitionText('cognition.status_success', '成功'),
    degraded: _cognitionText('cognition.status_degraded', '降级'),
    rejected: _cognitionText('cognition.status_rejected', '拒绝'),
    pending: _cognitionText('cognition.status_pending', '待确认'),
    pending_review: _cognitionText('cognition.status_pending', '待确认'),
    observed: _cognitionText('cognition.status_observed', '观察中'),
    weak_observation: _cognitionText('cognition.status_observed', '待补证'),
    deferred: _cognitionText('cognition.status_deferred', '稍后处理'),
    ignored: _cognitionText('cognition.status_ignored', '已忽略'),
    accepted: _cognitionText('cognition.status_accepted', '已确认'),
    preview: _cognitionText('cognition.status_preview', '预览'),
    confirmed: _cognitionText('cognition.status_confirmed', '已确认'),
    expired: _cognitionText('cognition.status_expired', '已失效'),
    revoked: _cognitionText('cognition.status_revoked', '已撤销'),
    ready: _cognitionText('cognition.source_ready', '可用'),
    empty: _cognitionText('cognition.source_empty', '暂无数据'),
    waiting: _cognitionText('cognition.capture_waiting', '等待中'),
    waiting_quiet: _cognitionText('cognition.capture_waiting_quiet', '等待会话静默'),
    waiting_completion: _cognitionText('cognition.capture_waiting_completion', '等待会话完成'),
    waiting_manual: _cognitionText('cognition.capture_waiting_manual', '等待手动执行'),
    scheduled: _cognitionText('cognition.capture_scheduled', '等待计划时间'),
    queued: _cognitionText('cognition.capture_queued', '等待提炼'),
    extracting: _cognitionText('cognition.capture_extracting', '正在整理'),
    writing: _cognitionText('cognition.capture_writing', '写入中'),
    paused: _cognitionText('cognition.capture_paused', '已暂停'),
    review_ready: _cognitionText('cognition.capture_review_ready', '等待审核'),
    no_candidate: _cognitionText('cognition.capture_no_candidate', '已提取，未形成候选'),
    configuration_required: _cognitionText('cognition.capture_configuration_required', '需要配置模型'),
    failed: _cognitionText('cognition.capture_failed', '提炼失败'),
    cancelled: _cognitionText('cognition.capture_cancelled', '已取消'),
    completed: _cognitionText('cognition.capture_completed', '已完成'),
  };
  return labels[status] || status || _cognitionText('cognition.unknown', '未知');
}

function _captureWorkflowStatus(capture) {
  if (_skillsCognitionState.writingRecallCandidateId
    && Array.isArray(capture?.candidateIds)
    && capture.candidateIds.includes(_skillsCognitionState.writingRecallCandidateId)) return 'writing';
  return capture?.displayStatus || capture?.workflowStatus || capture?.status || '';
}

function _captureReviewSummary(capture) {
  const summary = capture?.reviewSummary || {};
  const hasSummary = !!capture?.reviewSummary && typeof capture.reviewSummary === 'object';
  const total = Number.isFinite(Number(summary.total)) ? Number(summary.total) : (capture?.candidateIds || []).length;
  return {
    total,
    pending: Number(summary.pending) || (!hasSummary && _captureWorkflowStatus(capture) === 'review_ready' ? total : 0),
    deferred: Number(summary.deferred) || 0,
    promoted: Number(summary.promoted) || 0,
    rejected: Number(summary.rejected) || 0,
    missing: Number(summary.missing) || 0,
  };
}

// Capture records created before the review-handoff receipt existed only carry
// linkedAssetIds. Keep those readable while preferring the persisted receipt
// supplied by the current capture workflow.
function _captureConfirmedAssetReceipts(capture) {
  const values = Array.isArray(capture?.confirmedAssetReceipts) ? capture.confirmedAssetReceipts : [];
  const byReceipt = new Map();
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const assetId = String(value.assetId || '').trim();
    if (!assetId) continue;
    const candidateId = String(value.candidateId || '').trim();
    const reviewDecisionId = String(value.reviewDecisionId || '').trim();
    const sourceRefCount = Number(value.sourceRefCount);
    const receipt = {
      candidateId,
      assetId,
      assetType: String(value.assetType || '').trim(),
      version: String(value.version || '').trim(),
      scope: String(value.scope || '').trim(),
      sourceRefCount: Number.isFinite(sourceRefCount) && sourceRefCount >= 0 ? sourceRefCount : 0,
      reviewDecisionId,
    };
    const key = `${receipt.candidateId}\u0000${receipt.assetId}\u0000${receipt.reviewDecisionId}`;
    if (!byReceipt.has(key)) byReceipt.set(key, receipt);
  }
  return Array.from(byReceipt.values());
}

function _captureLinkedAssetIds(capture) {
  const ids = [
    ..._captureConfirmedAssetReceipts(capture).map((receipt) => receipt.assetId),
    ...(Array.isArray(capture?.linkedAssetIds) ? capture.linkedAssetIds : []),
  ].map((id) => String(id || '').trim()).filter(Boolean);
  return [...new Set(ids)];
}

function _cognitionDate(value) {
  if (!value) return '';
  try {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  } catch (_) {
    return '';
  }
}

function _cognitionSetPageVisibility(page) {
  document.querySelectorAll('[data-cognition-page-body]').forEach((el) => {
    el.hidden = el.dataset.cognitionPageBody !== page;
  });
  document.querySelectorAll('[data-cognition-page]').forEach((el) => {
    const active = el.dataset.cognitionPage === page;
    el.classList.toggle('is-active', active);
    // 「管理来源」「沉淀活动」是页头辅助入口，不在 tablist 里：给它们套
    // aria-selected / roving tabindex 会对屏幕阅读器谎报成第 N 个标签页。
    if (el.getAttribute('role') !== 'tab') return;
    el.setAttribute('aria-selected', active ? 'true' : 'false');
    el.tabIndex = active ? 0 : -1;
  });
}

function switchSkillsCognitionPage(page) {
  // 旧 IA 的六页语义在这里收敛，而不是靠留幽灵页面兼容：
  //   overview 不再是独立任务视图，深链落到「待我处理」；
  //   brain / context / ontology 讲的都是"我拥有什么"，落到「我的资产」
  //   （「关于我」已是 personal 分类，不再是独立页）。
  const aliases = {
    candidates: 'captures',
    receipts: 'assets',
    overview: 'inbox',
    brain: 'assets',
    context: 'assets',
    ontology: 'assets',
  };
  const requested = aliases[page] || page;
  // 四个任务视图 + 两个页头辅助入口 + 四个从它们进入的详情页。详情页不进
  // tab 条：它们都是"从某一条记录点进去"的下一层，占了 tab 位反而会让用户
  // 以为那是第五、第六个并列的任务。
  const allowed = new Set([
    'inbox', 'captures', 'assets', 'sources', 'proofs', 'governance',
    'candidate', 'tree', 'nonasset', 'skillupdate',
  ]);
  const next = allowed.has(requested) ? requested : 'inbox';
  _skillsCognitionState.page = next;
  if (next === 'assets' && !_skillsCognitionState.assetCategoryFilter && !_skillsCognitionState.selectedAssetId) {
    _skillsCognitionState.assetCategoryFilter = 'personal';
  }
  _cognitionSetPageVisibility(next);
  // 切页回到顶部。滚动容器是共享的 .skills-cognition-main（develop 的滚动模型），
  // 不重置的话从别的页滚一段再切过来会直接落在半中间——页头、指标、筛选条全在
  // 视口上方，用户以为这一页就是从中间开始的。
  const cognitionMain = document.getElementById('skills-cognition-main');
  if (cognitionMain) cognitionMain.scrollTop = 0;
  _cognitionRenderCurrentPage({ enter: true });
}

/**
 * 画当前页。`enter` 表示这是一次"进入这一页"，只有这时才触发该页的按需加载
 * （树重投、接续快照、证明链）——否则首屏预渲染也会顺手打三个请求。
 */
function _cognitionRenderCurrentPage(options = {}) {
  const page = _skillsCognitionState.page;
  if (page === 'inbox') {
    renderSkillsCognitionInbox();
    if (options.enter) void loadCognitionReviewHistory();
  }
  if (page === 'sources') renderSkillsCognitionSources();
  if (page === 'proofs') {
    if (options.enter) void loadCognitionProofs();
    else renderSkillsCognitionProofs();
  }
  if (page === 'captures') renderSkillsCognitionCaptures();
  if (page === 'assets') renderSkillsCognitionAssets();
  if (page === 'governance') renderSkillsCognitionGovernance();
  if (page === 'candidate') renderSkillsCognitionCandidateDetail();
  if (page === 'nonasset') {
    renderSkillsCognitionNonAsset();
    if (options.enter) void loadCognitionContinuation();
  }
  if (page === 'skillupdate') renderSkillsCognitionSkillUpdate();
  if (page === 'tree') {
    // 每次进树都重投一次：树是资产关系的投影，资产在别的页改过之后不重投就是
    // 一棵停在上次的树，而用户正是带着"我刚确认的那条长出来没有"进来的。
    renderSkillsCognitionTree();
    if (options.enter) void loadCognitionTree({ rebuild: true });
  }
}

function _renderCognitionLoading(host) {
  if (host) host.innerHTML = `<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;
}

/**
 * 共享快照是否还没落地过——五个吃 `loadSkillsCognitionSnapshot` 的页面据此
 * 显示"正在加载"而不是空态。
 *
 * **为什么不是单看 `loading`**：动作回流和轮询也会把 `loading` 置真，那时页面
 * 已经有真实内容，再切回骨架会让内容闪一下，比不显示更糟。只有"从未加载过 +
 * 正在加载"这一种情况才需要说正在加载。
 *
 * **为什么必须有**：`initSkillsCognitionConsole` 先让面板可见、再异步取数，
 * 中间这段时间 body 是空的；用户在取数完成前切 tab，渲染出来的是空态——
 * 「还没有资产」和「还没加载完」在界面上长得一模一样，用户无从判断是系统
 * 坏了还是自己真的没有资产。
 */
function _cognitionSnapshotPending() {
  return !_skillsCognitionState.loadedAt && !!_skillsCognitionState.loading;
}

function _renderCognitionError(host) {
  if (host) host.innerHTML = `<div class="skills-cognition-error">${escapeHtml(_cognitionText('cognition.load_failed', '认知资产数据加载失败'))}</div>`;
}

function _renderCognitionEmpty(text) {
  return `<div class="skills-cognition-empty">${escapeHtml(text)}</div>`;
}

function _cognitionRefText(ref) {
  if (ref && typeof ref === 'object') {
    const title = ref.title || ref.name || '';
    const id = ref.id || ref.ref || '';
    const type = ref.type || '';
    if (title && id) return `${title} (${type ? `${type}:` : ''}${id})`;
    if (title) return title;
    if (id) return type ? `${type}:${id}` : String(id);
  }
  return String(ref || '');
}

function _renderCognitionInlineRefs(refs) {
  const items = Array.isArray(refs) ? refs.map(_cognitionRefText).filter(Boolean) : [];
  return items.length ? items.map((item) => `<span>${escapeHtml(item)}</span>`).join('') : `<span>${escapeHtml(_cognitionText('cognition.no_refs', '未记录引用'))}</span>`;
}


function _abilityAssetCategoryLabel(category) {
  const labels = {
    personal: _cognitionText('cognition.asset_category_personal', '关于我'),
    rule: _cognitionText('cognition.asset_category_rule', '规则与偏好'),
    template: _cognitionText('cognition.asset_category_template', '模板与范例'),
    skill_method: _cognitionText('cognition.asset_category_skill_method', '技能与方法'),
  };
  return labels[category] || category || _cognitionText('cognition.unknown', '未知');
}

// 作用域中文标签（交互规范 §17.3：作用域要"看得懂"，不暴露英文检索 token）。
function _abilityAssetScopeLabel(scope) {
  const labels = {
    report: '报告类任务',
    code: '代码类任务',
    review: '审查类任务',
    product: '产品类任务',
    general: '通用',
  };
  return labels[String(scope || '')] || String(scope || '');
}

// 候选/资产的展示标题（交互规范附录 A：标题体现内容）。
// - 旧候选可能带英文模板 summary（'Reusable experience lesson...' 等），
//   渲染层从 judgment 提炼中文标题，避免用户看到英文；
// - 其余情况返回原 summary/title。
function _abilityCandidateDisplayTitle(candidate) {
  const summary = String(candidate.summary || '').trim();
  const judgment = String(candidate.judgment || '').trim();
  const isLegacyEnglish = /^(Reusable experience lesson|KSTAR rule gap candidate|Verified multi-tool workflow|Reusable workflow lesson)/.test(summary);
  if (isLegacyEnglish && judgment) return _abilityTitleFromContent(judgment);
  // 旧模板标题（'可复用经验：XX（通用）'）剥离前缀与 scope 后缀——存量
  // 候选的 summary 是模板时代生成的，剥离后标题=内容，消除列表雷同。
  const stripped = summary
    .replace(/^(?:可复用经验|待修正经验|已验证的工作流程)[：:]\s*/, '')
    .replace(/（[^）]*）$/, '')
    .trim();
  if (stripped && stripped !== summary) return stripped;
  return summary || _abilityTitleFromContent(judgment) || candidate.id || '';
}

// 从经验内容提炼标题核心：去掉引导前缀，取第一句主干，限 40 字。
// 与主进程 lessonTitleCore 同规则（渲染层是兜底路径）。
function _abilityTitleFromContent(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:遇到同类情况时，)?(?:应|须|要)?注意修正[:：]/, '')
    .replace(/^(?:当|对于|遇到|处理|在处理|在)[^，。；,.;:：]*?(?:时|后|中|之前|以后)?[，,。；;]/, '')
    .replace(/^(?:可|应|须|要|建议|务必|注意)[^，。；,.;:：]{0,2}/, '')
    .replace(/^(?:“|『|「)/, '')
    .replace(/([，。；,.;:：])[\s\S]*$/, '$1')
    .trim();
  if (!t) return '通用经验';
  return t.length <= 40 ? t : `${t.slice(0, 40)}…`;
}

// 成熟度的用户侧表达按 PRD 3.6「资产成熟度与默认使用契约」的五档写法。
// 内部枚举仍是 seed/bud/transfer_validated/effectiveness_validated（收敛枚举
// 涉及 28 处源码 + 23 个测试文件 + 数据迁移，另开一批做），这里只在展示边界
// 统一口径：seed 与 bud 都属于「已确认，尚未验证」——它们的差别是"谁写进来的"，
// 由 lifecycleStatus 表达，不该在成熟度轴上再分一档。
function _abilityAssetMaturityLabel(maturity, status) {
  if (status === 'paused') return _cognitionText('cognition.asset_status_paused', '已暂停');

  if (status === 'revoked') return _cognitionText('cognition.maturity_revoked', '已撤销');
  if (status === 'candidate') return _cognitionText('cognition.maturity_candidate', '待确认');
  if (maturity === 'effectiveness_validated' || maturity === 'stable') {
    return _cognitionText('cognition.maturity_effectiveness_validated', '已验证有效');
  }
  if (maturity === 'transfer_validated') return _cognitionText('cognition.maturity_transfer_verified', '已成功带入');
  if (maturity === 'seed' || maturity === 'bud') {
    return _cognitionText('cognition.maturity_confirmed_unverified', '已确认，尚未验证');
  }
  return maturity || status || _cognitionText('cognition.unknown', '未知');
}

/**
 * 「默认使用」：这条资产在下一个匹配任务里会不会被自动带入。
 *
 * 措辞必须跟着 `resolveDefaultUsePolicy`（asset-semantics.ts）的同作用域档位
 * 走，不能自己另立一套说法——用户读到"自动带入"就会据此安排工作，说法和真实
 * 策略分叉一次，他就再也不会信这一行。
 *
 * 这里只描述**同作用域**的行为：跨作用域一律要确认，那是范围问题，不是这条
 * 资产的属性，写进来只会让这一格永远显示"要确认"。
 */
function _abilityAssetDefaultUseLabel(asset) {
  if (!asset || asset.status !== 'active') {
    return _cognitionText('cognition.asset_default_use_never', '不会带入');
  }
  if (asset.maturity === 'transfer_validated' || asset.maturity === 'effectiveness_validated') {
    return _cognitionText('cognition.asset_default_use_auto', '任务匹配时自动带入');
  }
  if (asset.maturity === 'bud') {
    return _cognitionText('cognition.asset_default_use_prompt', '任务匹配时建议带入');
  }
  return _cognitionText('cognition.asset_default_use_never', '不会带入');
}

// lifecycleStatus 有三个值，只有 user_confirmed_unverified 代表真实用户确认。
// 其余两个（会话自动抽取 / KStar 自进化沉淀）都不得显示成「确认入库」。
function _abilityAssetWriteOriginLabel(lifecycleStatus) {
  if (lifecycleStatus === 'automatically_extracted_unverified') {
    return _cognitionText('cognition.asset_write_origin_auto', '自动入库');
  }
  if (lifecycleStatus === 'system_precipitated_unverified') {
    return _cognitionText('cognition.asset_write_origin_system', '系统沉淀');
  }
  return _cognitionText('cognition.asset_write_origin_user', '确认入库');

}

function _abilityAssetSummary(items, category) {
  return items.filter((item) => (item.category || item.type) === category).length;
}

function _abilityAssetRecommendationLabel(action) {
  if (action === 'pause') return _cognitionText('cognition.recall_recommend_pause', '建议暂停');
  if (action === 'rework') return _cognitionText('cognition.recall_recommend_rework', '建议重做');
  return action || '';
}

function _abilityAssetScopePolicyLines(policy) {
  if (!policy || typeof policy !== 'object') return [];
  const fields = [
    ['purposeTags', _cognitionText('cognition.scope_policy_purpose_tags', 'Purpose tags')],
    ['agentIds', _cognitionText('cognition.scope_policy_agent_ids', 'Agents')],
    ['roleIds', _cognitionText('cognition.scope_policy_role_ids', 'Roles')],
    ['projectIds', _cognitionText('cognition.scope_policy_project_ids', 'Projects')],
    ['workspaceIds', _cognitionText('cognition.scope_policy_workspace_ids', 'Workspaces')],
    ['conversationKinds', _cognitionText('cognition.scope_policy_conversation_kinds', 'Conversation kinds')],
    ['fileKinds', _cognitionText('cognition.scope_policy_file_kinds', 'File kinds')],
  ];
  return fields.map(([field, label]) => {
    const values = Array.isArray(policy[field]) ? policy[field].filter(Boolean).map(String) : [];
    return values.length ? `${label}: ${values.join(', ')}` : '';
  }).filter(Boolean);
}

function _renderAbilityAssetGovernance(selected) {
  const policyLines = _abilityAssetScopePolicyLines(selected.scopePolicy);
  const policyHtml = policyLines.length
    ? `<div class="reference-strip ability-asset-scope-policy"><strong>${escapeHtml(_cognitionText('cognition.scope_policy', '结构化作用域'))}</strong><p>${escapeHtml(policyLines.join(' · '))}</p></div>`
    : '';
  const recommendationHtml = selected.recommendedAction
    ? `<div class="reference-strip ability-asset-recommendation is-${escapeHtml(selected.recommendedAction)}"><strong>${escapeHtml(_abilityAssetRecommendationLabel(selected.recommendedAction))}</strong><p>${escapeHtml(selected.recommendationReason || _cognitionText('cognition.recall_recommendation_needs_review', '该资产需要用户复核。'))}</p>${selected.recommendationAt ? `<small>${escapeHtml(_cognitionDate(selected.recommendationAt))}</small>` : ''}</div>`
    : '';
  const actions = [];
  if (selected.status === 'active') {
    actions.push(`<button class="btn btn-sm" data-ability-asset-action="pause" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_pause', '暂停'))}</button>`);
    actions.push(`<button class="btn btn-sm btn-danger" data-ability-asset-action="revoke" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_revoke', '撤销'))}</button>`);
  } else if (selected.status === 'paused') {
    actions.push(`<button class="btn btn-sm btn-primary" data-ability-asset-action="resume" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_resume', '恢复'))}</button>`);
    actions.push(`<button class="btn btn-sm btn-danger" data-ability-asset-action="revoke" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_revoke', '撤销'))}</button>`);
  }
  if (selected.recommendedAction && selected.status !== 'revoked') {
    actions.push(`<button class="btn btn-sm btn-primary" data-ability-asset-action="acknowledge-recommendation" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_acknowledge_recommendation', '确认建议'))}</button>`);
  }
  const actionHtml = actions.length
    ? `<div class="asset-controls ability-asset-governance-actions">${actions.join('')}</div>`
    : `<div class="skills-cognition-muted">${escapeHtml(_cognitionText('cognition.asset_no_governance_actions', '该资产当前无可用治理动作。'))}</div>`;
  return `<div class="ability-asset-governance"><div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.asset_governance', '治理状态'))}</strong><p>${escapeHtml(selected.status || 'active')}${selected.recommendedAction ? ` · ${escapeHtml(_abilityAssetRecommendationLabel(selected.recommendedAction))}` : ''}</p></div>${policyHtml}${recommendationHtml}${actionHtml}</div>`;
}

function _abilityAssetDisplayTitle(asset) {
  const title = String(asset?.title || asset?.id || '').trim();
  const scope = String(asset?.scope || '').trim();
  const category = asset?.category || asset?.type;
  if (category === 'skill_method' && title.length > 56 && scope.length >= 8 && scope.length <= 60) return _abilityAssetScopeLabel(scope);
  return title || _abilityAssetScopeLabel(scope);
}

function _abilityAssetContentSummary(asset) {
  const summary = String(asset?.summary || asset?.statement || '').trim();
  if (summary) return summary;
  const title = String(asset?.title || '').trim();
  return title && title !== _abilityAssetDisplayTitle(asset) ? title : '';
}

async function generateRecallSkillFromAsset(assetId) {
  const id = String(assetId || '').trim();
  if (!id) return null;
  const prepared = await window.cogseed.invoke('recall.skills.prepare', { assetId: id });
  if (!prepared?.ok || !prepared.draft) throw new Error(prepared?.error || _cognitionText('cognition.skill_draft_failed', 'Skill 生成失败'));
  const draft = prepared.draft;
  const asset = (_skillsCognitionState.assets || []).find((item) => item.id === id);
  if (draft.status === 'failed') {
    if (asset) {
      asset.recallSkillDraftStatus = 'failed';
      asset.recallSkillDraftErrorCode = draft.errorCode || 'model_failed';
      delete asset.recallSkillDraft;
    }
    renderSkillsCognitionAssets();
    return prepared;
  }
  if (draft.installedSkillId) {
    if (asset) {
      asset.generatedSkillId = draft.installedSkillId;
      delete asset.recallSkillDraftStatus;
      delete asset.recallSkillDraftErrorCode;
      delete asset.recallSkillDraft;
      renderSkillsCognitionAssets();
    }
    return prepared;
  }
  if (asset) {
    asset.recallSkillDraftStatus = 'draft';
    delete asset.recallSkillDraftErrorCode;
    asset.recallSkillDraft = {
      draftHash: draft.draftHash,
      fileCount: Number(draft.fileCount) || 0,
      workflowSteps: Array.isArray(draft.workflowSteps) ? draft.workflowSteps : [],
      validationOk: draft.validation?.ok === true,
      ...(draft.mode ? { mode: draft.mode } : {}),
      ...(draft.reviewDecision ? { reviewDecision: draft.reviewDecision } : {}),
      ...(draft.targetSkillId ? { targetSkillId: draft.targetSkillId } : {}),
      ...(draft.baseRevisionId ? { baseRevisionId: draft.baseRevisionId } : {}),
      ...(draft.baseManifestHash ? { baseManifestHash: draft.baseManifestHash } : {}),
      ...(draft.diff ? {
        diffSummary: {
          added: Number(draft.diff.added) || 0,
          modified: Number(draft.diff.modified) || 0,
          deleted: Number(draft.diff.deleted) || 0,
          unchanged: Number(draft.diff.unchanged) || 0,
        },
      } : {}),
      ...(draft.recallContext ? {
        recallContext: {
          assetCount: Number(draft.recallContext.assetCount) || 0,
          sourceCount: Number(draft.recallContext.sourceCount) || 0,
        },
      } : {}),
    };
    renderSkillsCognitionAssets();
  }
  return prepared;
}

async function importRecallSkillFromAsset(assetId) {
  const id = String(assetId || '').trim();
  if (!id) return null;
  let asset = (_skillsCognitionState.assets || []).find((item) => item.id === id);
  if (!asset?.recallSkillDraft?.draftHash) {
    const prepared = await generateRecallSkillFromAsset(id);
    if (prepared?.draft?.status !== 'draft') return prepared;
    asset = (_skillsCognitionState.assets || []).find((item) => item.id === id);
  }
  const draftHash = asset?.recallSkillDraft?.draftHash;
  if (!draftHash) throw new Error(_cognitionText('cognition.skill_draft_failed', 'Skill 生成失败'));
  const confirmed = await window.cogseed.invoke('recall.skills.confirm', { assetId: id, draftHash });
  if (!confirmed?.ok || !confirmed.skill?.id) throw new Error(confirmed?.error || _cognitionText('cognition.skill_draft_failed', 'Skill 生成失败'));
  if (asset) {
    asset.generatedSkillId = confirmed.skill.id;
    delete asset.recallSkillDraftStatus;
    delete asset.recallSkillDraftErrorCode;
    delete asset.recallSkillDraft;
  }
  renderSkillsCognitionAssets();
  if (typeof uiToast === 'function') uiToast(_cognitionText('cognition.skill_created', '已加入技能库'), { variant: 'success' });
  return confirmed;
}

function openRecallSkillModelSettings() {
  _setViewFromSidebar('settings');
  if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
  setTimeout(() => document.getElementById('settings-model-authorizations')?.scrollIntoView({ block: 'start' }), 0);
}

function queueMissingRecallSkillDrafts() {
  // 不再判断"这条是不是真资产"：后端 canonical layer 保证列表里只有四类
  // 正式资产（formal-assets/repository.ts），支撑对象根本进不来。
  const targets = (_skillsCognitionState.assets || []).filter((asset) => (
    asset.category === 'skill_method'
    && asset.status === 'active'
    && !asset.generatedSkillId
    && !asset.recallSkillDraftStatus
    && !_recallSkillDraftAutoPending.has(asset.id)
  ));
  if (!targets.length) return;
  for (const asset of targets) {
    asset.recallSkillDraftStatus = 'generating';
    _recallSkillDraftAutoPending.add(asset.id);
  }
  _recallSkillDraftAutoQueue = _recallSkillDraftAutoQueue.then(async () => {
    for (const asset of targets) {
      try { await generateRecallSkillFromAsset(asset.id); }
      catch (error) {
        const current = (_skillsCognitionState.assets || []).find((item) => item.id === asset.id);
        if (current) {
          current.recallSkillDraftStatus = 'failed';
          current.recallSkillDraftErrorCode = 'model_failed';
          delete current.recallSkillDraft;
        }
        _skillsLog.warn('automatic Recall skill draft request failed', error);
      } finally {
        _recallSkillDraftAutoPending.delete(asset.id);
        renderSkillsCognitionAssets();
      }
    }
  });
}

function _recallSkillDraftErrorLabel(code) {
  const labels = {
    model_not_configured: _cognitionText('cognition.skill_draft_error_model_not_configured', '尚未配置可用模型。'),
    model_auth_required: _cognitionText('cognition.skill_draft_error_model_auth_required', '模型授权已失效，请重新授权。'),
    model_failed: _cognitionText('cognition.skill_draft_error_model_failed', '模型未能完成 Skill 生成。'),
    model_timeout: _cognitionText('cognition.skill_draft_error_model_timeout', 'Skill 生成超时。'),
    invalid_model_output: _cognitionText('cognition.skill_draft_error_invalid_output', '模型返回内容不符合 Skill 提案结构。'),
    level_a_validation_failed: _cognitionText('cognition.skill_draft_error_level_a', '生成结果未通过 Level A 校验。'),
  };
  return labels[code] || _cognitionText('cognition.skill_draft_failed', 'Skill 生成失败');
}

function _cognitionSourceLabel(kind) {
  return _cognitionText(`cognition.source_${kind}`, kind || _cognitionText('cognition.unknown', '未知'));
}

function _cognitionSourceItemLabel(item) {
  if (!item) return _cognitionText('cognition.unknown', '未知');
  if (item.title) return item.title;
  const subtype = _cognitionText(`cognition.source_subtype_${item.subtype}`, item.subtype || 'source');
  return subtype;
}

function _cognitionSourceItemMeta(item, groupKind) {
  if (!item) return '';
  const parts = [];
  const subtype = item.title && item.subtype ? _cognitionText(`cognition.source_subtype_${item.subtype}`, '') : '';
  if (subtype && subtype !== _cognitionSourceLabel(groupKind)) parts.push(subtype);
  // `sourceVersion` 是**来源自身的版本时间**（会话的 updatedAt 之类），不是
  // "系统最近一次读取它"的时间——后端没有 lastReadAt 这种字段。这里过去把它
  // 裸着当日期摆出来，紧挨在状态旁边，读起来就成了「最近读取」。加上标签，
  // 让它只声称自己确实是的那件事。
  if (item.sourceVersion) {
    parts.push(`${_cognitionText('cognition.source_version_at', '来源更新于')} ${_cognitionDate(item.sourceVersion)}`);
  }
  return parts.join(' · ');
}

/**
 * 某一类来源为空时说清**什么会产生它**，而不是统一一句「当前没有可显示的数据」。
 *
 * 五类采集端在 source-catalog 里都已接好（conversation / artifact_file /
 * execution_evaluation / user_teaching_signal / authorized_external_system 各有
 * 自己的 collector），所以空=确实还没有内容，不是没接入。但"没有内容"的原因
 * 各不相同：会话要先聊、文件要先选、外部系统要先连——一句通用空话会让用户以为
 * 这一类坏了或者还没做。
 */
function _cognitionSourceEmptyHint(kind) {
  const hints = {
    conversation: ['cognition.source_empty_conversation', '还没有已完成的会话。完成一轮问答后，它会出现在这里。'],
    artifact_file: ['cognition.source_empty_artifact_file', '还没有被选入的文件或会话产物。在会话里选用文件后，它会出现在这里。'],
    execution_evaluation: ['cognition.source_empty_execution', '还没有任务执行记录。跑过任务后，执行与评价会出现在这里。'],
    user_teaching_signal: ['cognition.source_empty_teaching', '还没有教学信号。你明确说「记住」「以后这样做」时，会在这里留下可撤销的回执。'],
    authorized_external_system: ['cognition.source_empty_external', '还没有已连接的外部系统。在「连接」里接入后，它才会作为来源出现。'],
  };
  const entry = hints[kind];
  return entry ? _cognitionText(entry[0], entry[1]) : _cognitionText('cognition.source_no_items', '当前没有可显示的数据');
}

function _cognitionSourceStatusLabel(status) {
  const labels = {
    pending: _cognitionText('cognition.source_pending', '待处理'),
    processing: _cognitionText('cognition.source_processing', '处理中'),
    ready: _cognitionText('cognition.source_ready', '可用'),
    failed: _cognitionText('cognition.source_failed', '失败'),
    paused: _cognitionText('cognition.source_paused', '已暂停'),
    empty: _cognitionText('cognition.source_empty', '暂无数据'),
  };
  return labels[status] || status || _cognitionText('cognition.unknown', '未知');
}

function _cognitionSourceItemStatus(item) {
  if (item?.statusReason === 'execution_cancelled') {
    return {
      status: 'paused',
      label: _cognitionText('cognition.source_cancelled', '已取消'),
    };
  }
  if (item?.statusReason === 'execution_timed_out') {
    return {
      status: 'failed',
      label: _cognitionText('cognition.source_timed_out', '已超时'),
    };
  }
  return {
    status: item?.status || 'ready',
    label: _cognitionSourceStatusLabel(item?.status),
  };
}

function _cognitionSourceGroupStatus(group, items) {
  if (group?.kind !== 'execution_evaluation') {
    return {
      status: group?.status || 'empty',
      label: `${items.length} · ${_cognitionSourceStatusLabel(group?.status)}`,
    };
  }
  const failed = items.filter((item) => item.status === 'failed'
    && item.statusReason !== 'execution_cancelled'
    && item.statusReason !== 'execution_timed_out').length;
  const cancelled = items.filter((item) => item.statusReason === 'execution_cancelled').length;
  const timedOut = items.filter((item) => item.statusReason === 'execution_timed_out').length;
  const countText = (key, fallback, count) => _cognitionText(key, fallback).replace('{count}', String(count));
  const parts = [countText('cognition.source_execution_total', '{count} 条记录', items.length)];
  if (failed) parts.push(countText('cognition.source_execution_failed_count', '{count} 条失败', failed));
  if (timedOut) parts.push(countText('cognition.source_execution_timed_out_count', '{count} 条超时', timedOut));
  if (cancelled) parts.push(countText('cognition.source_execution_cancelled_count', '{count} 条已取消', cancelled));
  if (!failed && !timedOut && !cancelled) parts.push(_cognitionSourceStatusLabel(group?.status));
  const status = failed || timedOut
    ? 'failed'
    : group?.status === 'failed'
      ? (items.some((item) => item.status === 'ready') ? 'ready' : 'paused')
      : group?.status || 'empty';
  return { status, label: parts.join(' · ') };
}

function _cognitionSourceReason(reason) {
  if (!reason) return '';
  const fallbacks = {
    conversation_processing: '会话仍在进行，结束后会继续处理',
    file_index_pending: '文件正在等待建立索引',
    file_index_failed: '文件处理失败，可以重试',
    execution_queued: '执行正在等待开始',
    execution_running: '执行仍在进行',
    execution_failed: '执行失败',
    execution_cancelled: '执行已取消',
    execution_timed_out: '执行超时',
    degraded_execution: '执行结果暂时不可用',
    connector_connecting: '连接器正在连接',
    connector_disconnected: '连接器尚未连接',
    connector_degraded: '连接器当前异常，请检查连接',
    connector_error: '连接器连接失败，请重新授权或连接',
    teaching_revoked: '这条教学信号已撤销',
    source_paused: '已暂停后续处理，已有记忆不受影响',
    source_removed: '已从 Recall 移除，原始数据仍然保留',
    source_retry_failed: '重试未成功，请检查来源后再试',
    asset_revoke_partial: '部分关联记忆未能撤销，请重试',
    source_unavailable: '来源暂时无法读取',
  };
  return _cognitionText(`cognition.source_reason_${reason}`, fallbacks[reason] || reason);
}

function _cognitionSourceNextAction(nextAction) {
  const labels = {
    wait: _cognitionText('cognition.source_next_wait', '下一步：等待处理完成'),
    use_source: '',
    retry: _cognitionText('cognition.source_next_retry', '下一步：重试处理'),
    resume: _cognitionText('cognition.source_next_resume', '下一步：恢复来源'),
    reconnect: _cognitionText('cognition.source_next_reconnect', '下一步：重新接入来源'),
    manage_connector: _cognitionText('cognition.source_next_connector', '下一步：检查连接器状态'),
    none: '',
  };
  return labels[nextAction] || '';
}

function _cognitionSourceActionLabel(action) {
  const labels = {
    pause: _cognitionText('cognition.source_action_pause', '暂停'),
    resume: _cognitionText('cognition.source_action_resume', '恢复'),
    retry: _cognitionText('cognition.source_action_retry', '重试'),
    remove: _cognitionText('cognition.source_action_remove', '从 Recall 移除'),
    reconnect: _cognitionText('cognition.source_action_reconnect', '重新接入'),
    manage_connector: _cognitionText('cognition.manage_connectors', '管理连接器'),
  };
  return labels[action] || action;
}

/**
 * 每一类来源的图标与主动作。
 *
 * 管理来源的首屏要回答的是"系统能从哪五类地方发现认知、各自什么状态、我该管
 * 哪一个"，而不是"我有多少条来源"。所以五类做成并列概览卡，条目收进卡片的
 * 展开态——直接铺条目时，光「会话」一类就能占满一屏，另外四类被挤到屏幕外，
 * 这一页最该回答的问题反而看不见。
 *
 * 主动作里只有「管理连接」是真的跳走（连接器页本来就存在）；其余都是就地
 * 展开，不为对齐原型的一个按钮样式新增二级页。
 */
function _cognitionSourceKindPresentation(kind) {
  const table = {
    conversation: ['message-square', 'cognition.source_action_view_scope', '查看范围'],
    artifact_file: ['file-text', 'cognition.source_action_manage_files', '管理目录'],
    execution_evaluation: ['zap', 'cognition.source_action_view_scope', '查看范围'],
    user_teaching_signal: ['sparkles', 'cognition.source_action_view_receipts', '查看回执'],
    authorized_external_system: ['database', 'cognition.manage_connectors', '管理连接器'],
  };
  const entry = table[kind] || ['folder', 'cognition.source_action_view_scope', '查看范围'];
  return { icon: entry[0], actionKey: entry[1], actionFallback: entry[2] };
}

function _cognitionPrimarySourceItems(group) {
  const items = Array.isArray(group?.items) ? group.items : [];
  return items.filter((item) => item.subtype !== 'message' && item.subtype !== 'evaluation');
}

function _cognitionSourceActionButton(action, group, item) {
  if (action === 'manage_connector') {
    return `<button type="button" class="btn btn-sm" data-cognition-open-connectors>${escapeHtml(_cognitionSourceActionLabel(action))}</button>`;
  }
  return `<button type="button" class="btn btn-sm" data-cognition-source-action="${escapeHtml(action)}" data-cognition-source-kind="${escapeHtml(group.kind)}" data-cognition-source-id="${escapeHtml(item.id)}">${escapeHtml(_cognitionSourceActionLabel(action))}</button>`;
}

function _cognitionSourceMoreButton(actions, group, item) {
  if (!actions.length) return '';
  const label = _cognitionText('common.more', '更多');
  const icon = typeof uiIconHtml === 'function' ? uiIconHtml('more-horizontal') : '<span aria-hidden="true">...</span>';
  return `<button type="button" class="btn btn-sm recall-source-more" data-cognition-source-more data-cognition-source-actions="${escapeHtml(actions.join(','))}" data-cognition-source-kind="${escapeHtml(group.kind)}" data-cognition-source-id="${escapeHtml(item.id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
}

function _cognitionRelationRefText(ref) {
  const title = ref && typeof ref === 'object' ? String(ref.title || ref.name || '').trim() : '';
  if (title) return title;
  const rawId = ref && typeof ref === 'object' ? String(ref.id || ref.ref || '') : String(ref || '');
  const normalizedId = rawId.includes(':') ? rawId.slice(rawId.indexOf(':') + 1) : rawId;
  const sourceItem = (Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .flatMap((group) => group.items || [])
    .find((item) => item.id === rawId || item.id === normalizedId);
  if (sourceItem?.title) return sourceItem.title;
  const kind = ref && typeof ref === 'object' ? String(ref.kind || ref.type || '') : String(ref || '').split(':')[0];
  const sourceKinds = new Set(['conversation', 'artifact_file', 'execution_evaluation', 'user_teaching_signal', 'authorized_external_system']);
  return sourceKinds.has(kind) ? _cognitionSourceLabel(kind) : _cognitionText('cognition.relation_refs', '关联引用');
}

function _cognitionVisibleSourceCount(groups) {
  return (Array.isArray(groups) ? groups : [])
    .reduce((sum, group) => sum + _cognitionPrimarySourceItems(group).length, 0);
}

function _cognitionLoadFailed(section) {
  return Array.isArray(_skillsCognitionState.loadErrors) && _skillsCognitionState.loadErrors.includes(section);
}

function _conversationCapturePipelineStatus(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const capturesById = new Map();
  for (const capture of [
    ...(Array.isArray(_skillsCognitionState.captures) ? _skillsCognitionState.captures : []),
    ...(Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : []),
  ]) {
    if (capture?.id && capture.conversationId === id) capturesById.set(capture.id, capture);
  }
  const capture = [...capturesById.values()].sort((left, right) => String(
    right.updatedAt || right.finishedAt || right.createdAt || '',
  ).localeCompare(String(left.updatedAt || left.finishedAt || left.createdAt || '')))[0];
  if (!capture) {
    return { status: 'empty', label: _cognitionText('cognition.source_capture_none', '未沉淀') };
  }
  const status = _captureWorkflowStatus(capture);
  if (['waiting', 'waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'paused'].includes(status)) {
    return { status: 'waiting', label: _cognitionText('cognition.source_capture_waiting', '等待中') };
  }
  if (status === 'extracting' || status === 'writing') {
    return { status: 'processing', label: _cognitionText('cognition.source_capture_processing', '处理中') };
  }
  if (status === 'review_ready') {
    return { status: 'review_ready', label: _cognitionText('cognition.source_capture_review', '待审核') };
  }
  if (status === 'no_candidate') {
    return { status: 'completed', label: _cognitionText('cognition.capture_no_candidate', '已提取，未形成候选') };
  }
  if (status === 'completed') {
    const count = _captureLinkedAssetIds(capture).length;
    return {
      status: 'completed',
      label: _cognitionText('cognition.source_capture_completed', '已形成 {count} 条记忆').replace('{count}', String(count)),
    };
  }
  if (status === 'failed' || status === 'configuration_required') {
    return { status: 'failed', label: _cognitionText('cognition.source_capture_failed', '沉淀失败') };
  }
  return { status: 'empty', label: _cognitionText('cognition.source_capture_none', '未沉淀') };
}

function renderSkillsCognitionSources() {
  const host = document.getElementById('skills-cognition-sources-body');
  if (!host) return;
  if (_cognitionLoadFailed('sources')) {
    host.innerHTML = `<div class="skills-cognition-warning"><span>${escapeHtml(_cognitionText('cognition.sources_load_failed', '数据来源读取失败'))}</span><button class="btn btn-sm" data-cognition-reload>${escapeHtml(_cognitionText('common.retry', '重试'))}</button></div>`;
    return;
  }
  if (_cognitionSnapshotPending()) { _renderCognitionLoading(host); return; }
  const groups = Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [];
  // 五类来源全部保留，空的也列出来。它们是后端明确定义的 kind（source-catalog
  // 里各有自己的 collector），不是"有数据才存在的东西"——把空的那几类藏掉，
  // 用户就不知道系统还能从哪里发现认知，也无从判断"我该去接一个连接器"。
  // 每一类的空态由 `_cognitionSourceEmptyHint` 说清什么会产生它。
  const visibleGroups = groups;
  const sourceItems = visibleGroups.flatMap(_cognitionPrimarySourceItems);
  const total = sourceItems.length;
  const ready = sourceItems.filter((item) => item.status === 'ready').length;
  // 「需授权」和「失败」拆开：合成一个"需关注"时，用户看到数字也不知道该去
  // 重新授权还是去重试——这是两条完全不同的修复路径。授权失效由服务端已经
  // 给出的 nextAction / statusReason 判断，渲染层不自己猜。
  const needsAuthorization = sourceItems.filter((item) => item.nextAction === 'reconnect'
    || item.statusReason === 'connector_error'
    || item.statusReason === 'connector_disconnected').length;
  const failedItems = sourceItems.filter((item) => item.status === 'failed'
    && item.nextAction !== 'reconnect').length;
  // 「需授权」和「失败记录」不是只读数字：数出问题却点不进去，用户就得自己
  // 从五组来源里逐条翻找那一条坏的。这两格计数 > 0 时是按钮，点了把对应的
  // 来源组滚进视野并高亮。其余三格是纯统计，保持不可点——让不可点的东西看
  // 起来可点，比不能点更糟。
  const statCell = ([key, fallback, value, filter]) => {
    const label = escapeHtml(_cognitionText(key, fallback));
    const count = escapeHtml(String(value));
    if (!filter || !value) return `<div><strong>${count}</strong><span>${label}</span></div>`;
    return `<button type="button" class="recall-workbench-summary-action" data-cognition-source-locate="${escapeHtml(filter)}"><strong>${count}</strong><span>${label}</span></button>`;
  };
  // 一条内容都没有时不摆一排 0：全零统计条只是噪音，此时该说的是下一步。
  const summary = sourceItems.length ? [
    ['cognition.source_kind_count', '来源类型', groups.length, ''],
    ['cognition.source_visible_items', '当前可见', total, ''],
    ['cognition.source_ready_groups', '可用', ready, ''],
    // 后端没有 authorizationStatus 字段，这一格是从 nextAction/statusReason
    // 推出来的。所以说的是**操作**（要重新连接）而不是**状态**（授权失效）——
    // 推断值不该被说成事实。
    ['cognition.source_needs_reconnect', '需重新连接', needsAuthorization, 'auth'],
    ['cognition.source_failed_records', '失败记录', failedItems, 'failed'],
  ].map(statCell).join('') : '';
  const body = visibleGroups.length ? visibleGroups.map((group) => {
    const items = _cognitionPrimarySourceItems(group);
    const rows = items.length ? items.map((item) => {
      const openConversation = group.kind === 'conversation' && item.subtype === 'session'
        ? `<button type="button" class="btn btn-sm" data-cognition-source-conversation="${escapeHtml(item.id)}">${escapeHtml(_cognitionText('cognition.open_conversation', '打开会话'))}</button>` : '';
      const itemActions = Array.isArray(item.actions) ? item.actions : [];
      const menuActions = itemActions.filter((action) => action === 'pause' || action === 'remove');
      const directActions = itemActions.filter((action) => !menuActions.includes(action)).map((action) => _cognitionSourceActionButton(action, group, item)).join('');
      const actions = `${directActions}${_cognitionSourceMoreButton(menuActions, group, item)}`;
      const reason = _cognitionSourceReason(item.statusReason);
      const next = _cognitionSourceNextAction(item.nextAction);
      const meta = _cognitionSourceItemMeta(item, group.kind);
      const pipelineStatus = group.kind === 'conversation' && item.subtype === 'session'
        ? _conversationCapturePipelineStatus(item.id)
        : null;
      const itemStatus = _cognitionSourceItemStatus(item);
      const visibleStatus = pipelineStatus?.status || itemStatus.status;
      const visibleStatusLabel = pipelineStatus?.label || itemStatus.label;
      return `<article class="recall-source-item">
        <div class="recall-source-item-main"><strong>${escapeHtml(_cognitionSourceItemLabel(item))}</strong>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}${reason ? `<small>${escapeHtml(reason)}</small>` : ''}${next ? `<small class="recall-source-next">${escapeHtml(next)}</small>` : ''}</div>
        <span class="skills-cognition-status is-${escapeHtml(visibleStatus)}">${escapeHtml(visibleStatusLabel)}</span>
        ${openConversation || actions ? `<div class="recall-source-item-actions">${openConversation}${actions}</div>` : ''}
      </article>`;
    }).join('') : `<div class="recall-workbench-empty">${escapeHtml(_cognitionSourceEmptyHint(group.kind))}</div>`;
    const groupReason = _cognitionSourceReason(group.reason);
    // 「需要重新连接」提为卡片主动作：它是这一类唯一能让数据重新流动的操作，
    // 藏在某一条目行里用户找不到。这是从 nextAction/statusReason 推出来的操作
    // 建议，不是"授权失效"的断言——后端没有 authorizationStatus 字段。
    const groupNeedsReconnect = items.some((item) => item.nextAction === 'reconnect'
      || item.statusReason === 'connector_error'
      || item.statusReason === 'connector_disconnected');
    const reconnectItemId = items.find((item) => item.nextAction === 'reconnect'
      || item.statusReason === 'connector_error'
      || item.statusReason === 'connector_disconnected')?.id || '';
    // 组状态用 _cognitionSourceGroupStatus 统一推导（它会把执行与评价的失败/
    // 超时/已取消分开计数），只有"需要重新连接"这一种由本地判断覆盖：它对应
    // 的修复动作和其它失败不同，必须单独说出来。
    const groupStatus = _cognitionSourceGroupStatus(group, items);
    const headStatus = groupNeedsReconnect ? 'failed' : groupStatus.status;
    const headLabel = groupNeedsReconnect
      ? `${items.length} · ${_cognitionText('cognition.source_reconnect_required', '需要重新连接')}`
      : groupStatus.label;
    const presentation = _cognitionSourceKindPresentation(group.kind);
    const expanded = (_skillsCognitionState.expandedSourceKinds || []).includes(group.kind);
    // 主动作：外部系统跳连接器页（那个页面本来就有），需要重连时给重连，其余
    // 都是就地展开条目——不为对齐原型的一个按钮样式新增二级页。
    const primaryAction = groupNeedsReconnect
      ? `<button type="button" class="btn btn-sm btn-primary" data-cognition-source-action="reconnect" data-cognition-source-kind="${escapeHtml(group.kind)}" data-cognition-source-id="${escapeHtml(reconnectItemId)}">${escapeHtml(_cognitionText('cognition.source_action_reconnect_now', '重新连接'))}</button>`
      : group.kind === 'authorized_external_system'
        ? `<button type="button" class="btn btn-sm" data-cognition-open-connectors>${escapeHtml(_cognitionText(presentation.actionKey, presentation.actionFallback))}</button>`
        : `<button type="button" class="btn btn-sm" data-cognition-source-expand="${escapeHtml(group.kind)}">${escapeHtml(expanded ? _cognitionText('common.close', '收起') : _cognitionText(presentation.actionKey, presentation.actionFallback))}</button>`;
    // 统计条要能把用户送到出问题的那一类，所以卡片上标出它属于哪一类异常。
    const groupHasFailure = items.some((item) => item.status === 'failed' && item.nextAction !== 'reconnect');
    const locate = `${groupNeedsReconnect ? ' data-cognition-source-group="auth"' : ''}${groupHasFailure ? ' data-cognition-source-group-failed="1"' : ''}`;
    const icon = _skillUiIconHtml(presentation.icon, 'recall-source-card-icon-glyph');
    return `<section class="recall-source-group recall-source-card${expanded ? ' is-expanded' : ''}"${locate}>
      <button type="button" class="recall-source-card-head" data-cognition-source-expand="${escapeHtml(group.kind)}" aria-expanded="${expanded ? 'true' : 'false'}">
        <span class="recall-source-card-icon" aria-hidden="true">${icon}</span>
        <span class="recall-source-card-copy"><strong>${escapeHtml(_cognitionSourceLabel(group.kind))}</strong><small>${escapeHtml(groupReason || _cognitionText(`cognition.source_hint_${group.kind}`, ''))}</small></span>
        <span class="skills-cognition-status is-${escapeHtml(headStatus)}">${escapeHtml(headLabel)}</span>
      </button>
      <div class="recall-source-card-action">${primaryAction}</div>
      ${expanded ? `<div class="recall-source-items">${rows}</div>` : ''}
    </section>`;
  }).join('') : ''; 
  // 五类一条内容都没有时，除了每一类各自的空态，还要给一句整页的下一步。
  // 五段"还没有…"排在一起只说明了现状，没告诉用户先做哪件事。
  const nothingAtAll = !sourceItems.length;
  const pageEmptyState = nothingAtAll ? `<div class="recall-workbench-empty-state">
    <strong>${escapeHtml(_cognitionText('cognition.sources_empty', '尚未发现可接入的数据来源'))}</strong>
    <span>${escapeHtml(_cognitionText('cognition.pipeline_next_conversation', '下一步：完成一轮会话，系统会自动整理内容'))}</span>
    <button type="button" class="btn btn-sm" data-cognition-page-link="captures">${escapeHtml(_cognitionText('cognition.capture_tasks', '沉淀任务'))}</button>
  </div>` : '';
  const hero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.sources_eyebrow', eyebrow: 'SOURCES',
    titleKey: 'cognition.sources_title', title: '只从你授权的范围中发现认知',
    hintKey: 'cognition.sources_page_hint', hint: '五类来源分别管理授权、可用性和最近读取；来源不是正式认知资产。',
    backPage: 'inbox',
  });
  // 页底这句是这一页的边界声明：来源可读不等于内容会进资产。少了它，用户会
  // 把「授权一个目录」理解成「把整个目录写进记忆」。
  const boundary = `<div class="recall-overview-attention cognition-source-boundary"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.source_boundary', '来源内容不会直接写入正式资产'))}</h2><span>${escapeHtml(_cognitionText('cognition.source_boundary_hint', '普通内容先成为候选；只有用户教学信号可在限定范围内形成可撤销回执。'))}</span></div></div>`;
  host.innerHTML = `${hero}${summary ? `<div class="recall-workbench-summary">${summary}</div>` : ''}<div class="recall-source-groups">${body}</div>${pageEmptyState}${boundary}`;
}

const _CAPTURE_FILTERS = ['all', 'review', 'processing', 'completed', 'failed'];

function _captureNextActionText(capture) {
  const actions = {
    wait_quiet: _cognitionText('cognition.capture_next_wait_quiet', '下一步：等待静默期结束'),
    complete_conversation: _cognitionText('cognition.capture_next_complete_conversation', '下一步：完成当前会话'),
    run_now: _cognitionText('cognition.capture_next_run_now', '下一步：等待手动执行'),
    wait_nightly: _cognitionText('cognition.capture_next_wait_nightly', '下一步：等待夜间窗口'),
    wait_processing: _cognitionText('cognition.capture_next_wait_processing', '下一步：等待提炼完成'),
    resume: _cognitionText('cognition.capture_next_resume', '下一步：继续已暂停的任务'),
    review_candidates: _cognitionText('cognition.capture_next_review_candidates', '下一步：审核候选'),
    no_candidate: _cognitionText('cognition.capture_no_candidate_detail', '已提取，未形成候选'),
    configure_model: _cognitionText('cognition.capture_next_configure_model', '下一步：配置模型后重试'),
    retry: _cognitionText('cognition.capture_next_retry', '下一步：重试本次沉淀'),
    view_assets: _cognitionText('cognition.capture_next_view_assets', '已完成：查看写入的记忆'),
    none: _cognitionText('cognition.capture_next_none', '已完成：无需后续操作'),
  };
  if (capture?.nextAction && actions[capture.nextAction]) return actions[capture.nextAction];
  const status = _captureWorkflowStatus(capture);
  if (status === 'no_candidate') return actions.no_candidate;
  if (status === 'completed') return _captureLinkedAssetIds(capture).length ? actions.view_assets : actions.none;
  if (status === 'review_ready') return actions.review_candidates;
  if (status === 'failed') return actions.retry;
  if (capture?.status === 'configuration_required') return actions.configure_model;
  if (status === 'paused') return actions.resume;
  if (status === 'waiting_completion') return actions.complete_conversation;
  if (status === 'waiting_quiet') return actions.wait_quiet;
  return actions.wait_processing;
}

function _captureCompletionDetail(capture) {
  const summary = _captureReviewSummary(capture);
  if (!summary.total) return _cognitionText('cognition.capture_no_candidate_detail', '已提取，未形成候选');
  if (capture?.autoWrite) {
    return _cognitionText('cognition.capture_auto_completed_detail', '已写入记忆：{promoted} 条，{rejected} 条未写入')
      .replace('{promoted}', String(summary.promoted))
      .replace('{rejected}', String(summary.rejected));
  }
  return _cognitionText('cognition.capture_review_completed_detail', '候选审核已完成：{promoted} 个已入库，{rejected} 个已拒绝')
    .replace('{promoted}', String(summary.promoted))
    .replace('{rejected}', String(summary.rejected));
}

function _captureAssetReceiptDetail(capture) {
  const receipts = _captureConfirmedAssetReceipts(capture);
  if (!receipts.length) return '';
  const notRecorded = _cognitionText('cognition.not_recorded', '未记录');
  const rows = receipts.map((receipt) => {
    const type = receipt.assetType ? _abilityAssetCategoryLabel(receipt.assetType) : notRecorded;
    const version = receipt.version || notRecorded;
    const scope = receipt.scope ? _abilityAssetScopeLabel(receipt.scope) : notRecorded;
    // 标题主位放**用户读得懂的资产名**，不放 id。资产列表这一页已经加载过，
    // 按 assetId 查得到就用它的显示名；查不到才退回 id——那说明这条资产已被
    // 清除或还没同步过来，此时 id 是仅剩的可核对信息。
    // `reviewDecisionId` 不再上屏：它是晋升的幂等键（主进程用它和 candidateId
    // 一起哈希出 assetId / handoff 回执 id），对用户既不可点也不可查。字段仍要
    // 读——`_captureConfirmedAssetReceipts` 的去重键依赖它——只是不展示。
    const known = (Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [])
      .find((item) => item && item.id === receipt.assetId);
    const displayTitle = known ? _abilityAssetDisplayTitle(known) : receipt.assetId;
    return `<article class="recall-capture-asset-receipt">
      <div class="recall-capture-asset-receipt-head"><span><b>${escapeHtml(displayTitle)}</b>${known ? `<code>${escapeHtml(receipt.assetId)}</code>` : ''}</span><em>${escapeHtml(type)}</em></div>
      <dl>
        <div><dt>${escapeHtml(_cognitionText('cognition.version', '版本'))}</dt><dd>${escapeHtml(version)}</dd></div>
        <div><dt>${escapeHtml(_cognitionText('cognition.scope', '作用域'))}</dt><dd>${escapeHtml(scope)}</dd></div>
        <div><dt>${escapeHtml(_cognitionText('cognition.source_refs', '来源引用'))}</dt><dd>${escapeHtml(String(receipt.sourceRefCount))}</dd></div>
      </dl>
      <button type="button" class="btn btn-sm" data-recall-open-asset="${escapeHtml(receipt.assetId)}">${escapeHtml(_cognitionText('cognition.capture_view_this_asset', '查看这条资产'))}</button>
    </article>`;
  }).join('');
  return `<section class="recall-capture-asset-receipts" aria-label="${escapeHtml(_cognitionText('cognition.formal_assets', '正式资产'))}">
    <div class="recall-capture-asset-receipts-head"><strong>${escapeHtml(_cognitionText('cognition.formal_assets', '正式资产'))}</strong><span>${escapeHtml(String(receipts.length))}</span></div>
    <div class="recall-capture-asset-receipts-list">${rows}</div>
  </section>`;
}

/**
 * 沉淀记录的筛选：按**用户处境**分，不按内部状态机分。
 *
 * 用户来这一页不是管理 capture 对象，而是处理"沉淀这件事"，所以只问四个问题：
 * 有什么等我确认、有什么正在跑、有什么做完了、有什么出错了。等待静默、排队、
 * 提取中、写入中在用户眼里都是"正在处理"，没必要让他分辨。
 * `cancelled` 是用户自己取消的，不算异常，只在「全部」里出现。
 */
function _captureStatusesForFilter(filter) {
  const groups = {
    review: ['review_ready'],
    processing: ['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'extracting', 'writing'],
    completed: ['completed'],
    failed: ['failed'],
  };
  return groups[filter] || [];
}

/** 筛选格上的计数：由服务端 counts 组合，不自己数本地列表（本地只有当前页）。 */
function _captureFilterCount(filter, counts) {
  const value = (key) => Number(counts?.[key] || 0);
  if (filter === 'all') return Object.values(counts || {}).reduce((sum, item) => sum + Number(item || 0), 0);
  if (filter === 'review') return value('review');
  if (filter === 'processing') return value('processing') + value('waiting');
  if (filter === 'completed') return value('completed');
  if (filter === 'failed') return value('failed');
  return 0;
}

function _captureFilterLabel(filter) {
  const labels = {
    all: _cognitionText('cognition.capture_filter_all', '全部'),
    review: _cognitionText('cognition.capture_filter_review_mine', '待我确认'),
    processing: _cognitionText('cognition.capture_filter_processing', '处理中'),
    completed: _cognitionText('cognition.capture_filter_completed', '已完成'),
    failed: _cognitionText('cognition.capture_filter_abnormal', '异常'),
  };
  return labels[filter] || filter;
}

function _capturePolicyLabel(policy) {
  const labels = {
    smart: _cognitionText('cognition.capture_policy_smart', '智能静默'),
    immediate: _cognitionText('cognition.capture_policy_immediate', '立即'),
    nightly: _cognitionText('cognition.capture_policy_nightly', '夜间'),
    manual: _cognitionText('cognition.capture_policy_manual', '手动'),
  };
  return labels[policy] || policy || labels.smart;
}

function _captureStageLabel(stage) {
  const labels = {
    model_check: _cognitionText('cognition.capture_stage_model_check', '检查模型'),
    recall_view: _cognitionText('cognition.capture_stage_recall_view', '构建 RecallView'),
    model_extraction: _cognitionText('cognition.capture_stage_model_extraction', '提取内容'),
    candidate_save: _cognitionText('cognition.capture_stage_candidate_save', '保存 Candidate'),
    asset_write: _cognitionText('cognition.capture_stage_asset_write', '写入 Recall'),
  };
  return labels[stage] || '';
}

function _captureErrorLabel(code, capture) {
  const labels = {
    model_not_configured: _cognitionText('cognition.capture_error_model_not_configured', '尚未配置可用模型'),
    model_auth_required: _cognitionText('cognition.capture_error_model_auth_required', '模型授权已失效，请重新授权'),
    source_paused: _cognitionText('cognition.capture_error_source_paused', '数据来源已暂停，请恢复后重试'),
    source_removed: _cognitionText('cognition.capture_error_source_removed', '数据来源已移除，无法继续读取'),
    source_unavailable: _cognitionText('cognition.capture_error_source_unavailable', '原会话内容暂时无法读取'),
    recall_view_failed: _cognitionText('cognition.capture_error_recall_view_failed', 'RecallView 构建失败'),
    model_timeout: _cognitionText('cognition.capture_error_model_timeout', '模型提取超时，请重试'),
    model_failed: _cognitionText('cognition.capture_error_model_failed', '模型提取未成功完成'),
    invalid_model_output: _cognitionText('cognition.capture_error_invalid_model_output', '模型返回内容无法解析'),
    candidate_save_failed: _cognitionText('cognition.capture_error_candidate_save_failed', 'Candidate 保存失败'),
    asset_write_failed: capture?.autoWrite
      ? _cognitionText('cognition.capture_error_auto_write_failed', '自动写入记忆失败，请重试本次沉淀')
      : _cognitionText('cognition.capture_error_asset_write_failed', '审核内容写入 Recall 失败，请重试审核'),
    asset_write_interrupted: _cognitionText('cognition.capture_error_asset_write_interrupted', '写入被应用重启中断，已恢复到待审核'),
    conversation_failed: _cognitionText('cognition.capture_error_conversation_failed', '会话未成功完成，请手动决定是否沉淀'),
    conversation_cancelled: _cognitionText('cognition.capture_error_conversation_cancelled', '会话已取消，请手动决定是否沉淀'),
    capture_failed: _cognitionText('cognition.capture_error_unknown', '沉淀任务发生未知错误'),
  };
  return labels[code] || labels.capture_failed;
}

function _captureActionButton(capture, action, key, fallback, primary = false, danger = false) {
  const cls = danger ? 'btn-danger' : primary ? 'btn-primary' : '';
  return `<button type="button" class="btn btn-sm ${cls}" data-recall-capture-action="${escapeHtml(action)}" data-recall-capture-id="${escapeHtml(capture.id)}">${escapeHtml(_cognitionText(key, fallback))}</button>`;
}

function _captureTaskActions(capture) {
  const actions = [];
  const workflowStatus = _captureWorkflowStatus(capture);
  const linkedAssetIds = _captureLinkedAssetIds(capture);
  const finalizing = capture.status === 'extracting' && capture.stage === 'candidate_save';
  const actionContract = Array.isArray(capture.actions) ? new Set(capture.actions) : null;
  const allows = (action, fallback) => actionContract ? actionContract.has(action) : fallback;
  if (allows('run_now', ['waiting_quiet', 'waiting_manual', 'scheduled', 'paused'].includes(capture.status))) {
    actions.push(_captureActionButton(capture, 'run-now', 'cognition.capture_run_now', '立即执行', true));
  }
  if (allows('configure_model', capture.status === 'configuration_required')) {
    actions.push(`<button type="button" class="btn btn-sm" data-recall-capture-settings>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</button>`);
  }
  if (allows('retry', workflowStatus === 'failed' || workflowStatus === 'configuration_required')) {
    actions.push(_captureActionButton(capture, 'retry', 'common.retry', '重试', true));
  }
  if (allows('pause', false)) {
    actions.push(_captureActionButton(capture, 'pause', 'cognition.capture_pause', '暂停'));
  }
  if (allows('resume', capture.status === 'paused')) {
    actions.push(_captureActionButton(capture, 'resume', 'cognition.capture_resume', '继续', true));
  }
  if (allows('cancel', ['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'paused'].includes(capture.status) && !finalizing)) {
    actions.push(_captureActionButton(capture, 'cancel', 'cognition.capture_cancel', '取消', false, true));
  }
  if (allows('view_assets', workflowStatus === 'completed' && linkedAssetIds.length > 0)) {
    actions.push(_captureActionButton(capture, 'view-assets', 'cognition.capture_view_assets', '查看产出的资产', true));
  } else {
    if (allows('review_candidates', (capture.candidateIds || []).length > 0)) {
      actions.push(_captureActionButton(capture, 'view-candidates', 'cognition.capture_view_candidates', '查看候选', workflowStatus === 'review_ready'));
    }
    if (!actionContract && linkedAssetIds.length) {
      actions.push(_captureActionButton(capture, 'view-assets', 'cognition.capture_view_assets', '查看产出的资产'));
    }
  }
  if (allows('open_conversation', workflowStatus !== 'completed')) {
    actions.push(_captureActionButton(capture, 'open-conversation', 'cognition.capture_open_conversation', '打开会话'));
  }
  return actions.join('');
}

function _captureTaskDetail(capture) {
  if (_skillsCognitionState.selectedCaptureId !== capture.id) return '';
  const reviewSummary = _captureReviewSummary(capture);
  const taskMeta = `<div class="recall-capture-task-meta"><span><b>${escapeHtml(_cognitionText('cognition.capture_execution_policy', '执行时机'))}</b>${escapeHtml(_capturePolicyLabel(capture.executionPolicy))}${capture.stage ? ` · ${escapeHtml(_captureStageLabel(capture.stage))}` : ''}</span><span><b>${escapeHtml(_cognitionText('cognition.candidate_count', '候选'))}</b>${escapeHtml(String(reviewSummary.total))}</span></div>`;
  const timeline = [
    [_cognitionText('cognition.capture_scheduled_for', '计划执行'), capture.scheduledFor],
    [_cognitionText('cognition.capture_started_at', '开始'), capture.startedAt],
    [_cognitionText('cognition.capture_finished_at', '结束'), capture.finishedAt],
  ].filter((item) => item[1]).map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(_cognitionDate(value))}</span>`).join('');
  const error = capture.errorCode
    ? `<div class="recall-capture-task-error"><b>${escapeHtml(_cognitionText('cognition.capture_error', '失败原因'))}</b><span>${escapeHtml(_captureErrorLabel(capture.errorCode, capture))}</span></div>`
    : '';
  const workflowStatus = _captureWorkflowStatus(capture);
  const reviewMetrics = workflowStatus !== 'completed' && reviewSummary.total ? `<div class="recall-capture-review-summary">
    ${reviewSummary.promoted ? `<span><b>${escapeHtml(_cognitionText('cognition.candidate_status_promoted', '已确认入库'))}</b>${escapeHtml(String(reviewSummary.promoted))}</span>` : ''}
    ${reviewSummary.pending + reviewSummary.deferred ? `<span><b>${escapeHtml(_cognitionText('cognition.candidate_status_pending', '需要确认'))}</b>${escapeHtml(String(reviewSummary.pending + reviewSummary.deferred))}</span>` : ''}
    ${reviewSummary.rejected ? `<span><b>${escapeHtml(_cognitionText('cognition.candidate_status_rejected', '已忽略'))}</b>${escapeHtml(String(reviewSummary.rejected))}</span>` : ''}
  </div>` : '';
  const recovered = capture.recoveredAt
    ? `<div class="recall-capture-task-feedback is-recovered">${escapeHtml(_cognitionText('cognition.capture_recovered_detail', '应用重启后已恢复该任务，将继续原流程。'))}</div>`
    : '';
  const completion = workflowStatus === 'completed'
    ? `<div class="recall-capture-task-feedback is-completed">${escapeHtml(_captureCompletionDetail(capture))}</div>`
    : '';
  const receipts = _captureAssetReceiptDetail(capture);
  return `<div class="recall-capture-task-detail">
    ${taskMeta}
    <div class="recall-capture-task-timeline">${timeline}</div>
    ${reviewMetrics}
    ${recovered}
    ${completion}
    ${receipts}
    ${error}
    ${workflowStatus === 'completed' ? '' : `<div class="recall-capture-next-action"><span>${escapeHtml(_captureNextActionText(capture))}</span></div>`}
    <div class="skills-cognition-actions">${_captureTaskActions(capture)}</div>
    <div id="skills-cognition-capture-review-body" class="recall-capture-inline-review"></div>
  </div>`;
}

function _renderCaptureSettings() {
  const settings = _skillsCognitionState.captureSettings || {
    enabled: true, executionPolicy: 'smart', reviewPolicy: 'auto', quietMinutes: 10, nightlyStart: '02:00', nightlyEnd: '06:00', catchUpMissed: true,
  };
  const model = _skillsCognitionState.captureModel || {};
  const modelReady = !!model.configured && !model.authorizationRequired;
  const modelName = [model.provider, model.model].filter(Boolean).join(' · ')
    || (model.configured
      ? _cognitionText('cognition.capture_model_default', '默认模型')
      : _cognitionText('cognition.capture_model_unconfigured', '尚未配置模型'));
  // 执行时机的选择归页面上方的三张模式卡（`_renderCaptureModeCards`），这里
  // 只留参数：同一个选择出现在两处，用户改完一处会怀疑另一处没跟上。
  const reviewPolicy = settings.reviewPolicy === 'manual' ? 'manual' : 'auto';
  const reviewPolicies = ['auto', 'manual'].map((policy) => `<button type="button" class="recall-capture-policy${reviewPolicy === policy ? ' is-active' : ''}" data-recall-review-policy="${policy}" aria-pressed="${reviewPolicy === policy ? 'true' : 'false'}" ${settings.enabled ? '' : 'disabled'}>${escapeHtml(_cognitionText(`cognition.capture_review_policy_${policy}`, policy === 'auto' ? '自动入库' : '手动入库'))}</button>`).join('');
  const quietMinutes = Number.isInteger(settings.quietMinutes) ? settings.quietMinutes : 10;
  const quietOptions = [...new Set([5, 10, 30, quietMinutes])].sort((left, right) => left - right)
    .map((minutes) => `<option value="${minutes}" ${quietMinutes === minutes ? 'selected' : ''}>${escapeHtml(_cognitionText('cognition.capture_quiet_minutes_option', '{count} 分钟').replace('{count}', String(minutes)))}</option>`).join('');
  const expanded = _skillsCognitionState.captureSettingsExpanded === true;
  const enabledLabel = settings.enabled
    ? _cognitionText('common.enabled', '已开启')
    : _cognitionText('common.disabled', '已关闭');
  const reviewLabel = _cognitionText(
    `cognition.capture_review_policy_${reviewPolicy}`,
    reviewPolicy === 'auto' ? '自动入库' : '手动入库',
  );
  const modelWarning = modelReady ? '' : `<div class="recall-capture-model-state is-compact"><div><label>${escapeHtml(_cognitionText('cognition.capture_model', '沉淀模型'))}</label><strong>${escapeHtml(modelName)}</strong><span class="skills-cognition-status is-configuration_required">${escapeHtml(_cognitionText('cognition.capture_configuration_required', '需要配置模型'))}</span></div><button type="button" class="btn btn-sm" data-recall-capture-settings>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</button></div>`;
  return `<section class="recall-capture-control-panel${expanded ? ' is-expanded' : ''}">
    <div class="recall-capture-control-summary">
      <div><h2>${escapeHtml(_cognitionText('cognition.capture_control_title', '沉淀控制'))}</h2><span>${escapeHtml([enabledLabel, _capturePolicyLabel(settings.executionPolicy), reviewLabel].join(' · '))}</span></div>
      <button type="button" class="btn btn-sm recall-capture-settings-toggle" data-recall-capture-settings-toggle aria-expanded="${expanded ? 'true' : 'false'}">${escapeHtml(expanded ? _cognitionText('common.close', '收起') : _cognitionText('cognition.capture_settings_action', '设置'))}</button>
    </div>
    ${modelWarning}
    <div class="recall-capture-control-expanded" ${expanded ? '' : 'hidden'}>
      <div class="recall-capture-control-head">
        <span>${escapeHtml(_cognitionText('cognition.capture_trigger_fixed', '会话完成后先等待静默；继续对话会自动顺延'))}</span>
        <label class="recall-capture-master"><input type="checkbox" data-recall-capture-enabled ${settings.enabled ? 'checked' : ''}><span>${escapeHtml(enabledLabel)}</span></label>
      </div>
      <div class="recall-capture-control-grid">
      <div class="recall-capture-control-field"><label>${escapeHtml(_cognitionText('cognition.capture_review_policy', '写入方式'))}</label><div class="recall-capture-policy-group is-review" role="group">${reviewPolicies}</div><span>${escapeHtml(_cognitionText(`cognition.capture_review_policy_${reviewPolicy}_hint`, reviewPolicy === 'auto' ? '提取完成后，合格内容会自动写入记忆，可在记忆内容中查看或撤回。' : '候选会先进入候选池，等你确认后再手动入库。'))}</span></div>
      <div class="recall-capture-control-field recall-capture-quiet-window" ${settings.executionPolicy === 'smart' ? '' : 'hidden'}><label>${escapeHtml(_cognitionText('cognition.capture_quiet_period', '静默等待'))}</label><select data-recall-capture-quiet-minutes ${settings.enabled ? '' : 'disabled'}>${quietOptions}</select><span>${escapeHtml(_cognitionText('cognition.capture_quiet_hint', '期间继续对话会重新计时'))}</span></div>
      <div class="recall-capture-control-field recall-capture-night-window" ${settings.executionPolicy === 'nightly' ? '' : 'hidden'}><label>${escapeHtml(_cognitionText('cognition.capture_nightly_window', '夜间窗口'))}</label><div><input type="time" data-recall-capture-night-start value="${escapeHtml(settings.nightlyStart)}" ${settings.enabled ? '' : 'disabled'}><span>–</span><input type="time" data-recall-capture-night-end value="${escapeHtml(settings.nightlyEnd)}" ${settings.enabled ? '' : 'disabled'}></div><label class="recall-capture-check"><input type="checkbox" data-recall-capture-catch-up ${settings.catchUpMissed ? 'checked' : ''} ${settings.enabled ? '' : 'disabled'}>${escapeHtml(_cognitionText('cognition.capture_catch_up', '错过后空闲补跑'))}</label></div>
      </div>
    </div>
  </section>`;
}

/**
 * 三种沉淀时机的并列呈现：任务结束后发现 / 本地夜间整理 / 主动整理。
 *
 * 它们**互斥**——`executionPolicy` 同时只有一个值，所以这里不用开关（switch）
 * 的样子：开关会让用户以为可以同时开两种，然后发现点了夜间就把智能关掉了。
 * 卡片仍复用 `data-recall-capture-policy`，与设置面板同一套 data 属性，事件
 * 绑定不需要再写一遍。
 *
 * 「主动整理」选中后由 `_renderManualConversationPicker` 展开会话圈选，不在
 * 卡片里再实现一次。
 */
/**
 * 沉淀活动三个区块共用的段头。统一成一个组件是为了消除此前三种并存的标题样式
 * （裸标题+右说明 / 标题+状态摘要+按钮 / 带图标标题），那让页面看起来像三个
 * 不同时期拼起来的东西。
 */
function _renderCaptureSectionHead(titleKey, title, hintKey, hint) {
  return `<div class="recall-capture-section-head">
    <strong>${escapeHtml(_cognitionText(titleKey, title))}</strong>
    <span>${escapeHtml(_cognitionText(hintKey, hint))}</span>
  </div>`;
}

function _renderCaptureModeCards() {
  const settings = _skillsCognitionState.captureSettings || {};
  const active = settings.executionPolicy || 'smart';
  const modes = [
    ['smart', 'cognition.capture_mode_smart', '任务结束后发现',
      'cognition.capture_mode_smart_desc', '任务完成或出现用户纠正时，在本机分析有意义的变化。'],
    ['nightly', 'cognition.capture_mode_nightly', '本地夜间整理',
      'cognition.capture_mode_nightly_desc', '仅在你启用后运行；设备休眠时延迟到下一个可运行的窗口。'],
    ['manual', 'cognition.capture_mode_manual', '主动整理',
      'cognition.capture_mode_manual_desc', '按会话圈选历史记录，读取前会再次确认范围。'],
  ];
  const cards = modes.map(([policy, titleKey, title, descKey, desc]) => {
    const isActive = active === policy;
    const control = policy === 'manual'
      ? `<button type="button" class="btn btn-sm${isActive ? ' btn-primary' : ''}" data-recall-capture-policy="manual" ${settings.enabled === false ? 'disabled' : ''}>${escapeHtml(_cognitionText('cognition.capture_mode_pick_sessions', '选择会话'))}</button>`
      : `<button type="button" class="btn btn-sm${isActive ? ' btn-primary' : ''}" data-recall-capture-policy="${policy}" aria-pressed="${isActive ? 'true' : 'false'}" ${settings.enabled === false ? 'disabled' : ''}>${escapeHtml(isActive ? _cognitionText('cognition.capture_mode_on', '使用中') : _cognitionText('cognition.capture_mode_use', '改用这种'))}</button>`;
    return `<section class="skills-cognition-card cognition-capture-mode${isActive ? ' is-active' : ''}">
      <div class="cognition-capture-mode-top"><strong>${escapeHtml(_cognitionText(titleKey, title))}</strong>${control}</div>
      <p class="panel-sub">${escapeHtml(_cognitionText(descKey, desc))}</p>
    </section>`;
  }).join('');
  return `<section class="cognition-capture-modes">
    <div class="cognition-inbox-band-head"><div><strong>${escapeHtml(_cognitionText('cognition.capture_execution_policy', '执行时机'))}</strong></div><span>${escapeHtml(_cognitionText('cognition.capture_mode_exclusive', '三种时机同时只有一种生效'))}</span></div>
    <div class="cognition-capture-mode-grid">${cards}</div>
  </section>`;
}

function _renderManualConversationPicker() {
  const settings = _skillsCognitionState.captureSettings || {};
  // 常驻，不再按 executionPolicy 显隐。「我要主动从哪里沉淀」是这一页三个问题
  // 之一，它和"系统什么时候自动跑"是并列关系，不是自动模式的替代品。

  const conversations = (Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .filter((source) => source.kind === 'conversation')
    .flatMap((source) => source.items || [])
    .filter((item) => item.subtype === 'session')
    .sort((left, right) => String(right.sourceVersion || '').localeCompare(String(left.sourceVersion || '')));
  const visibleCaptures = [...(Array.isArray(_skillsCognitionState.captures) ? _skillsCognitionState.captures : []), ...(Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : [])];
  const latestCaptureByConversation = new Map();
  for (const capture of visibleCaptures) {
    const current = latestCaptureByConversation.get(capture.conversationId);
    if (!current || String(capture.updatedAt || '').localeCompare(String(current.updatedAt || '')) > 0) {
      latestCaptureByConversation.set(capture.conversationId, capture);
    }
  }
  // 实机会话有 60+ 条，没有搜索就只能靠滚。搜索只过滤本地已取到的列表，不发
  // 请求——这里的目的是"找到我记得的那一段"，不是全库检索。
  const manualQuery = String(_skillsCognitionState.manualSearchQuery || '').trim().toLocaleLowerCase();
  const visibleConversations = manualQuery
    ? conversations.filter((item) => String(item.title || item.id || '').toLocaleLowerCase().includes(manualQuery))
    : conversations;
  const rows = visibleConversations.length ? visibleConversations.map((conversation) => {
    const capture = latestCaptureByConversation.get(conversation.id);
    const sourceVersion = Date.parse(conversation.sourceVersion || '');
    const captureVersion = Date.parse(capture?.lastActivityAt || capture?.finishedAt || capture?.updatedAt || '');
    const currentSnapshot = Boolean(capture && (
      !Number.isFinite(sourceVersion)
      || !Number.isFinite(captureVersion)
      || captureVersion >= sourceVersion
    ));
    const conversationBusy = conversation.status === 'processing';
    const status = currentSnapshot ? String(capture?.status || '') : '';
    const workflowStatus = currentSnapshot ? _captureWorkflowStatus(capture) : '';
    const processing = Boolean(currentSnapshot && (
      ['queued', 'extracting', 'writing'].includes(status)
      || ['queued', 'extracting', 'writing'].includes(workflowStatus)
    ));
    const processingStatus = status || workflowStatus;
    const processingLabel = processingStatus === 'queued'
      ? _cognitionText('cognition.capture_queued', '等待提炼')
      : processingStatus === 'writing'
        ? _cognitionText('cognition.capture_writing', '写入中')
        : _cognitionText('cognition.capture_extracting', '提取中');
    const processingClass = processingStatus === 'queued' ? 'is-waiting' : 'is-processing';
    const noCandidate = Boolean(currentSnapshot && status === 'no_candidate');
    const completed = Boolean(currentSnapshot && !noCandidate && (status === 'completed' || workflowStatus === 'completed'));
    const existingActionLabels = {
      waiting_manual: _cognitionText('cognition.capture_run_now', '去执行'),
      waiting_quiet: _cognitionText('cognition.capture_manual_history_view_waiting', '查看等待任务'),
      waiting_completion: _cognitionText('cognition.capture_manual_history_view_waiting', '查看等待任务'),
      scheduled: _cognitionText('cognition.capture_manual_history_view_waiting', '查看等待任务'),
      review_ready: _cognitionText('cognition.capture_review_action', '去审核'),
      configuration_required: _cognitionText('cognition.capture_configure_action', '去配置'),
      failed: _cognitionText('common.retry', '去重试'),
      paused: _cognitionText('cognition.capture_resume', '去恢复'),
    };
    const existingStatus = existingActionLabels[status] ? status : workflowStatus;
    const existingActionLabel = currentSnapshot && status !== 'cancelled'
      ? existingActionLabels[existingStatus] || _cognitionText('cognition.capture_manual_history_view_task', '查看任务')
      : '';
    const linkedAssetCount = currentSnapshot ? _captureLinkedAssetIds(capture).length : 0;
    const openExisting = Boolean(currentSnapshot && existingActionLabel && !processing && !completed && !noCandidate);
    const createNew = !currentSnapshot || status === 'cancelled';
    // Readiness belongs to the conversation, not to whether a previous
    // capture already exists. A completed conversation can be extracted
    // again after a no-candidate or completed result.
    const conversationIncomplete = conversation.captureReady === false;
    const sourceUnavailable = createNew && (
      conversation.availability === 'paused'
      || conversation.availability === 'removed'
      || conversation.status === 'paused'
    );
    const canReextract = currentSnapshot && (noCandidate || completed);
    const reextractAction = canReextract
      ? `<span class="recall-manual-conversation-action">${escapeHtml(_cognitionText('cognition.capture_manual_history_reextract', '再次提取'))}</span>`
      : '';
    const state = processing
      ? `<span class="skills-cognition-status ${processingClass}" aria-live="polite">${escapeHtml(processingLabel)}</span>`
      : noCandidate
        ? `<span class="skills-cognition-status is-completed">${escapeHtml(_cognitionText('cognition.capture_manual_history_no_write', '已提取，未形成候选'))}</span>${reextractAction}`
        : completed
          ? linkedAssetCount
            ? `<span class="skills-cognition-status is-completed">${escapeHtml(_cognitionText('cognition.capture_manual_history_written', '已入库'))}</span>${reextractAction}`
            : `<span class="skills-cognition-status is-completed">${escapeHtml(_cognitionText('cognition.capture_manual_history_no_write', '已提取，未形成候选'))}</span>${reextractAction}`
          : openExisting
            ? `<span class="recall-manual-conversation-action">${escapeHtml(existingActionLabel)}</span>`
            : sourceUnavailable
              ? `<span class="skills-cognition-status is-paused">${escapeHtml(_cognitionText('cognition.source_paused', '已暂停'))}</span>`
              : conversationIncomplete
                ? `<span class="skills-cognition-status is-waiting">${escapeHtml(_cognitionText('cognition.capture_manual_history_unavailable', '暂不可提取'))}</span>`
            : conversationBusy
              ? `<span class="skills-cognition-status is-waiting">${escapeHtml(_cognitionText('cognition.capture_waiting_completion', '等待会话完成'))}</span>`
      : `<span class="recall-manual-conversation-action">${escapeHtml(_cognitionText('cognition.capture_manual_history_create', '开始提取'))}</span>`;
    const actionAttribute = openExisting
      ? `data-recall-manual-open="${escapeHtml(capture.id)}"`
      : `data-recall-manual-add="${escapeHtml(conversation.id)}"`;
    const disabled = processing || sourceUnavailable || conversationIncomplete
      || (conversationBusy && !openExisting) || (createNew && !settings.enabled);
    const disabledReason = sourceUnavailable
      ? _cognitionText('cognition.capture_error_source_unavailable', '原会话内容暂时无法读取')
      : conversationIncomplete
        ? _cognitionText('cognition.capture_manual_history_unavailable', '未完成一轮问答，暂不可提取')
        : '';
    // 动作收在右侧的真按钮上，整行不再是按钮。这个列表是个 280px 的滚动框，
    // 行即按钮时触控板在框里滑动，任何一次落点都会立刻发起一次提取——没有安全
    // 的抓取区。现在行只是容器，左侧大片区域可以随便按住滑。
    return `<div class="recall-manual-conversation${currentSnapshot && status !== 'cancelled' ? ' is-added' : ''}${disabled ? ' is-disabled' : ''}"${disabledReason ? ` title="${escapeHtml(disabledReason)}"` : ''}>
      <span class="recall-manual-conversation-main"><strong>${escapeHtml(conversation.title || conversation.id)}</strong><small>${escapeHtml(_cognitionDate(conversation.sourceVersion))}</small></span>
      <button type="button" class="btn btn-sm recall-manual-conversation-trigger" ${actionAttribute} ${disabled ? 'disabled' : ''}>${state}</button>
    </div>`;
  }).join('') : _renderCognitionEmpty(manualQuery
    ? _cognitionText('cognition.capture_manual_search_empty', '没有匹配的历史会话')
    : _cognitionText('cognition.capture_manual_history_empty', '暂无可选择的历史会话'));
  return `<section class="recall-manual-history">
    <input class="input recall-manual-search" data-recall-manual-search value="${escapeHtml(_skillsCognitionState.manualSearchQuery || '')}" placeholder="${escapeHtml(_cognitionText('cognition.capture_manual_search', '搜索历史会话…'))}" aria-label="${escapeHtml(_cognitionText('cognition.capture_manual_search', '搜索历史会话…'))}">
    <div class="recall-manual-conversation-list">${rows}</div>
  </section>`;
}

function renderSkillsCognitionCaptures() {
  const host = document.getElementById('skills-cognition-captures-body');
  if (!host) return;
  if (_cognitionSnapshotPending()) { _renderCognitionLoading(host); return; }
  const captures = Array.isArray(_skillsCognitionState.captures) ? _skillsCognitionState.captures : [];
  const conversationTitles = new Map((Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .filter((source) => source.kind === 'conversation')
    .flatMap((source) => source.items || [])
    .map((item) => [item.id, item.title || item.id]));
  const counts = _skillsCognitionState.captureCounts || {};
  // 五格常显，不按计数隐藏：它们是固定的处境分类（全部/待我确认/处理中/已完成/
  // 异常），按计数增减会让筛选条跳来跳去，用户也无从知道"异常"这一格存在过。
  const filters = _CAPTURE_FILTERS
    .map((filter) => `<button type="button" class="recall-capture-filter${_skillsCognitionState.captureFilter === filter ? ' is-active' : ''}" data-recall-capture-filter="${filter}" aria-pressed="${_skillsCognitionState.captureFilter === filter ? 'true' : 'false'}"><span>${escapeHtml(_captureFilterLabel(filter))}</span><b>${escapeHtml(String(_captureFilterCount(filter, counts)))}</b></button>`).join('');
  const rows = captures.length ? captures.map((capture) => {
    const workflowStatus = _captureWorkflowStatus(capture);
    const title = capture.conversationTitle || conversationTitles.get(capture.conversationId) || capture.conversationId;
    const selected = _skillsCognitionState.selectedCaptureId === capture.id ? ' is-selected' : '';
    return `<article class="recall-capture-task${selected}" data-recall-capture-task="${escapeHtml(capture.id)}">
      <button type="button" class="recall-capture-task-summary" data-recall-capture-select="${escapeHtml(capture.id)}" aria-expanded="${selected ? 'true' : 'false'}">
        <span class="recall-capture-task-main"><strong>${escapeHtml(title)}</strong></span>
        <span class="skills-cognition-status is-${escapeHtml(workflowStatus)}">${escapeHtml(_cognitionStatusLabel(workflowStatus))}</span>
        <span class="recall-capture-task-time">${escapeHtml(_cognitionDate(capture.updatedAt))}</span>
      </button>${_captureTaskDetail(capture)}
    </article>`;
  }).join('') : `<div class="recall-capture-empty"><strong>${escapeHtml(
    // 空态要区分"真的一条都没有"和"这个筛选下没有"：同一句"暂无沉淀任务"会让
    // 用户以为筛选没生效，然后反复点回全部确认。
    _skillsCognitionState.captureFilter === 'all'
      ? _cognitionText('cognition.capture_tasks_empty', '暂无沉淀任务')
      : _cognitionText('cognition.capture_tasks_filter_empty', '当前筛选下没有沉淀活动'),
  )}</strong><span>${escapeHtml(
    _skillsCognitionState.captureFilter === 'all'
      ? _cognitionText('cognition.capture_tasks_empty_hint', '完成一轮会话后，系统会在静默期结束后创建沉淀任务。')
      : _cognitionText('cognition.capture_tasks_filter_empty_hint', '换一个筛选，或回到「全部」查看所有沉淀活动。'),
  )}</span></div>`;
  const more = _skillsCognitionState.captureNextCursor
    ? `<button type="button" class="btn btn-sm recall-capture-load-more" data-recall-capture-load-more>${escapeHtml(_cognitionText('common.load_more', '加载更多'))}</button>`
    : '';
  // Hero 的三个指标只放"要处理的事"，不放"已完成多少"——这一页首先是任务处理
  // 页，不是统计报表。
  const hero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.capture_eyebrow', eyebrow: 'CAPTURE ACTIVITY',
    titleKey: 'cognition.capture_activity_title', title: '沉淀活动',
    hintKey: 'cognition.capture_activity_hint', hint: '自动发现值得沉淀的内容；只有需要你判断时才打扰你。',
    metrics: [
      { value: _captureFilterCount('review', counts), key: 'cognition.capture_metric_review', label: '待确认' },
      { value: _captureFilterCount('processing', counts), key: 'cognition.capture_metric_processing', label: '处理中' },
      { value: _captureFilterCount('failed', counts), key: 'cognition.capture_metric_abnormal', label: '异常' },
    ],
    backPage: 'inbox',
  });
  // 一句话说清"我看到的这些东西最后会去哪"。刻意不编号：编号会和下面的段落
  // 标题抢层级，用户以为要照着 1234 操作，而这只是去向说明。
  const chain = `<div class="recall-capture-chain">${[
    _cognitionText('cognition.capture_chain_source', '会话 / 执行结果'),
    _cognitionText('cognition.capture_chain_candidate', '提取候选'),
    _cognitionText('cognition.capture_chain_confirm', '你确认'),
    _cognitionText('cognition.capture_chain_asset', '我的资产'),
  ].map((step, index) => `${index ? '<i aria-hidden="true">→</i>' : ''}<span>${escapeHtml(step)}</span>`).join('')}</div>`;
  // 「执行时机」与「自动沉淀设置」合成一块：它们回答的是同一个问题——什么时候
  // 开始找值得沉淀的东西。拆成两个区域只会让用户去理解一个不存在的区别。
  const autoBlock = `<section class="recall-capture-block">
    ${_renderCaptureSectionHead('cognition.capture_auto_title', '自动沉淀', 'cognition.capture_auto_hint', '决定系统什么时候帮你发现值得沉淀的内容。')}
    ${_renderCaptureModeCards()}${_renderCaptureSettings()}
  </section>`;
  const manualBlock = `<section class="recall-capture-block">
    ${_renderCaptureSectionHead('cognition.capture_manual_title', '从历史会话沉淀', 'cognition.capture_manual_hint', '挑一段以前的会话，让系统重新看看里面有没有值得留下的内容。')}
    ${_renderManualConversationPicker()}
  </section>`;
  // 「任务记录」与「候选池」合成「沉淀记录」：候选不是和任务平级的产品概念，
  // 而是任务走到某一步产生的待确认结果。点开某条记录就地展开它的候选，与
  // 管理来源、使用与证明的"先总览、原地展开"是同一套语言。
  const recordBlock = `<section class="recall-capture-block recall-capture-task-workbench">
    ${_renderCaptureSectionHead('cognition.capture_record_title', '沉淀记录', 'cognition.capture_record_hint', '看看系统发现了什么，以及哪些地方需要你决定。')}
    <div class="recall-capture-filter-bar">${filters}</div>
    <div class="recall-capture-task-list">${rows}</div>${more}
  </section>`;
  host.innerHTML = `${hero}${chain}${_renderCognitionOverviewAttention({ includeProcessing: true })}${autoBlock}${manualBlock}${recordBlock}`;
  // 候选就地展开在被选中的那条记录底下——宿主容器由 _captureTaskDetail 生成，
  // 所以必须在 innerHTML 之后调。没有展开任何记录时它找不到宿主，自然不渲染。
  renderSkillsCognitionCandidates();
}

async function loadRecallCaptureTasks(options = {}) {
  const append = options.append === true;
  const filter = _skillsCognitionState.captureFilter || 'all';
  const requestId = ++_skillsCognitionCaptureRequestId;
  _skillsCognitionCaptureRequestsInFlight += 1;
  const statuses = _captureStatusesForFilter(filter);
  const payload = { limit: 25 };
  if (statuses.length) payload.statuses = statuses;
  if (append && _skillsCognitionState.captureNextCursor) payload.cursor = _skillsCognitionState.captureNextCursor;
  try {
    const result = await window.cogseed.invoke('recall.captures.list', payload);
    if (!result?.ok) throw new Error(result?.error || 'recall capture list failed');
    if (requestId !== _skillsCognitionCaptureRequestId || filter !== _skillsCognitionState.captureFilter) return false;
    if (append) {
      const byId = new Map((_skillsCognitionState.captures || []).map((capture) => [capture.id, capture]));
      for (const capture of result.captures || []) byId.set(capture.id, capture);
      _skillsCognitionState.captures = Array.from(byId.values());
    } else {
      _skillsCognitionState.captures = result.captures || [];
    }
    _skillsCognitionState.captureCounts = result.counts || _skillsCognitionState.captureCounts;
    _skillsCognitionState.captureNextCursor = result.nextCursor || null;
    renderSkillsCognitionCaptures();
    return true;
  } finally {
    _skillsCognitionCaptureRequestsInFlight = Math.max(0, _skillsCognitionCaptureRequestsInFlight - 1);
  }
}

async function updateRecallCaptureSettings(patch) {
  const result = await window.cogseed.invoke('recall.captures.settings.update', patch);
  if (!result?.ok) throw new Error(result?.error || 'recall capture settings update failed');
  _skillsCognitionState.captureSettings = result.settings;
  renderSkillsCognitionCaptures();
}

/**
 * 认知树按需加载。
 *
 * 不并进 `loadSkillsCognitionSnapshot` 的九路读：树只服务一个入口，放进快照
 * 会让每次进认知资产都多付一次读盘，而绝大多数进入根本不看树。
 *
 * `options.rebuild` 走 `recall.tree.rebuild`——树是资产关系的投影，资产变过
 * 之后需要重投一次，否则用户会看到一棵停在昨天的树。
 */
async function loadCognitionTree(options = {}) {
  _skillsCognitionState.tree = { loading: true };
  if (_skillsCognitionState.page === 'tree') renderSkillsCognitionTree();
  try {
    const channel = options.rebuild ? 'recall.tree.rebuild' : 'recall.tree.read';
    const result = await window.cogseed.invoke(channel, {});
    if (!result?.ok) throw new Error(result?.error || 'cognition tree read failed');
    const tree = result.tree || {};
    _skillsCognitionState.tree = {
      nodes: Array.isArray(tree.nodes) ? tree.nodes : [],
      edges: Array.isArray(tree.edges) ? tree.edges : [],
      updatedAt: tree.updatedAt || '',
    };
  } catch (error) {
    _skillsCognitionState.tree = { error: (error && error.message) || String(error) };
  }
  if (_skillsCognitionState.page === 'tree') renderSkillsCognitionTree();
}

/**
 * 「非资产分流」按需加载。
 *
 * `total` 与 `items.length` 分开存：limit 截断的是显示条数，不是事实条数。
 * 页面要能说清"还有多少条没显示"，把截断后的长度当总数正是这一页最不该犯的
 * 错——它整页的意义就是"任务状态确实被记下来了"。
 */
async function loadCognitionContinuation() {
  _skillsCognitionState.continuation = { loading: true };
  if (_skillsCognitionState.page === 'nonasset') renderSkillsCognitionNonAsset();
  try {
    const result = await window.cogseed.invoke('recall.continuation.list', { limit: 50 });
    if (!result?.ok) throw new Error(result?.error || 'continuation snapshot read failed');
    _skillsCognitionState.continuation = {
      items: Array.isArray(result.items) ? result.items : [],
      total: Number.isFinite(result.total) ? result.total : (Array.isArray(result.items) ? result.items.length : 0),
    };
  } catch (error) {
    _skillsCognitionState.continuation = { error: (error && error.message) || String(error) };
  }
  if (_skillsCognitionState.page === 'nonasset') renderSkillsCognitionNonAsset();
}

/**
 * 展开一条接续快照：用 `recall.continuation.read` 取权威版本回填列表项。
 *
 * 列表口已经带了完整 snapshot，单独再读一次是为了展开时拿到的是磁盘当前值而
 * 不是进页那一刻的缓存——快照会被 `ensureProjectBrief` 在后台蒸馏改写。读失败
 * 时保留列表里那份并照常展开：有一份旧的真数据，好过把这一条变成错误态。
 */
async function openCognitionContinuation(conversationId) {
  const state = _skillsCognitionState.continuation;
  if (!state || !Array.isArray(state.items)) return;
  if (_skillsCognitionState.selectedContinuationId === conversationId) {
    _skillsCognitionState.selectedContinuationId = '';
    renderSkillsCognitionNonAsset();
    return;
  }
  _skillsCognitionState.selectedContinuationId = conversationId;
  renderSkillsCognitionNonAsset();
  const ref = state.items.find((item) => item.conversationId === conversationId);
  if (!ref) return;
  try {
    const result = await window.cogseed.invoke('recall.continuation.read', {
      conversationId,
      ...(ref.projectId ? { projectId: ref.projectId } : {}),
    });
    if (!result?.ok || !result.snapshot) return;
    state.items = state.items.map((item) => item.conversationId === conversationId
      ? { ...item, snapshot: result.snapshot }
      : item);
  } catch {
    // 保留列表里那份快照——见上。
  }
  if (_skillsCognitionState.page === 'nonasset') renderSkillsCognitionNonAsset();
}

/**
 * 「Skill 更新候选」按需加载：版本与回滚点来自 `cognition.skills.summary`，
 * 影响到的空间来自 `recall.workspaceRefs.list`。
 *
 * 两路都可能失败，但失败方式不同：summary 拿不到这一页就没有主体，属于错误；
 * workspaceRefs 拿不到只是影响面数不出来，降级成 0 比整页报错更有用。
 */
async function loadCognitionSkillUpdate(assetId, skillId) {
  _skillsCognitionState.skillUpdate = { loading: true, assetId, skillId };
  if (_skillsCognitionState.page === 'skillupdate') renderSkillsCognitionSkillUpdate();
  try {
    const summary = await window.cogseed.invoke('cognition.skills.summary', { skillId });
    if (!summary?.ok) throw new Error(summary?.error || 'skill cognition summary failed');
    let draft;
    if (assetId) {
      try {
        const prepared = await window.cogseed.invoke('recall.skills.prepare', { assetId });
        if (prepared?.ok && prepared.draft && prepared.draft.status === 'draft' && prepared.draft.mode === 'upgrade') draft = prepared.draft;
      } catch (error) {
        _skillsLog.warn('skill upgrade draft read degraded', { error: (error && error.message) || String(error) });
      }
    }
    let workspaceRefs = [];
    if (assetId) {
      try {
        const refs = await window.cogseed.invoke('recall.workspaceRefs.list', { assetId });
        if (refs?.ok) workspaceRefs = Array.isArray(refs.references) ? refs.references : [];
      } catch (error) {
        _skillsLog.warn('workspace refs read degraded', { error: (error && error.message) || String(error) });
      }
    }
    _skillsCognitionState.skillUpdate = { ...(summary.summary || {}), assetId, skillId, workspaceRefs, ...(draft ? { draft } : {}) };
  } catch (error) {
    _skillsCognitionState.skillUpdate = { error: (error && error.message) || String(error), assetId, skillId };
  }
  if (_skillsCognitionState.page === 'skillupdate') renderSkillsCognitionSkillUpdate();
}

function _renderSkillTreeDiff(diff) {
  if (!diff || !Array.isArray(diff.files)) {
    return `<div class="skills-cognition-empty">${escapeHtml(_cognitionText('cognition.skillupdate_diff_empty', '当前没有可显示的文件差异。'))}</div>`;
  }
  const summary = `${diff.added || 0} ${_cognitionText('cognition.skillupdate_diff_added', '新增')} · ${diff.modified || 0} ${_cognitionText('cognition.skillupdate_diff_modified', '修改')} · ${diff.deleted || 0} ${_cognitionText('cognition.skillupdate_diff_deleted', '删除')}`;
  const files = diff.files.map((file) => {
    const lines = Array.isArray(file.lines) ? file.lines.map((line) => `<div class="skill-diff-line is-${escapeHtml(line.type)}"><span>${line.type === 'added' ? '+' : line.type === 'deleted' ? '-' : ' '}</span><code>${escapeHtml(line.text || '')}</code></div>`).join('') : '';
    return `<details class="skill-diff-file"><summary><strong>${escapeHtml(file.path || '')}</strong><span>${escapeHtml(file.status || '')}</span></summary>${file.truncated ? `<p class="skills-cognition-meta">${escapeHtml(_cognitionText('cognition.skillupdate_diff_truncated', '文件较大，仅显示摘要。'))}</p>` : ''}${lines}</details>`;
  }).join('');
  return `<div class="skill-diff-summary">${escapeHtml(summary)}</div><div class="skill-diff-files">${files || `<div class="skills-cognition-empty">${escapeHtml(_cognitionText('cognition.skillupdate_diff_unchanged', '文件树没有变化。'))}</div>`}</div>`;
}

/** 每一类待办的用户可读标题。服务端只给 kind，措辞归渲染层。 */
function _cognitionInboxKindLabel(kind) {
  const labels = {
    skill_creation_suggested: ['cognition.inbox_skill_suggestions', 'Skill 创建建议'],
    skill_upgrade_suggested: ['cognition.inbox_skill_upgrade', 'Skill 可以升版'],
    rule_scope_changed: ['cognition.inbox_rule_scope_changed', '规则的作用范围变了'],
    template_updated: ['cognition.inbox_template_updated', '模板正文被更新'],
    sensitivity_escalated: ['cognition.inbox_sensitivity_escalated', '敏感级被升高'],
    rule_boundary_missing: ['cognition.inbox_rule_boundary', '规则缺少作用边界'],
    classification_conflict: ['cognition.inbox_classification_conflict', '同一条判断被归成了两类'],
    evidence_insufficient: ['cognition.inbox_evidence_insufficient', 'Evidence 不足，需要补证'],
    source_unavailable: ['cognition.inbox_source_unavailable', '来源失效，影响了已有资产'],
    sensitivity_unclassified: ['cognition.inbox_sensitivity_unclassified', '尚未分级的敏感信息'],
    candidate_pending_review: ['cognition.pending_review', '待确认认知候选'],
  };
  const entry = labels[kind];
  return entry ? _cognitionText(entry[0], entry[1]) : String(kind || '');
}

function _cognitionInboxKindHint(kind) {
  const hints = {
    skill_creation_suggested: ['cognition.inbox_skill_suggestions_hint', '这些方法已是你的正式资产，确认后可生成为可执行 Skill。'],
    skill_upgrade_suggested: ['cognition.inbox_skill_upgrade_hint', '方法在生成 Skill 之后又改过，已装的 Skill 落后于资产。'],
    rule_scope_changed: ['cognition.inbox_rule_scope_changed_hint', '系统改动了它的适用/禁止范围，它从此会进出一批不同的任务。'],
    template_updated: ['cognition.inbox_template_updated_hint', '系统改写了模板内容，确认后继续使用。'],
    sensitivity_escalated: ['cognition.inbox_sensitivity_escalated_hint', '这条资产能带往的目的地变多了，请确认这次扩权。'],
    rule_boundary_missing: ['cognition.inbox_rule_boundary_hint', '没有作用边界的规则不会被自动带入任何任务，补齐后才会生效。'],
    classification_conflict: ['cognition.inbox_classification_conflict_hint', '同一句话被归到两个类型，两边都不会晋升，需要你裁定。'],
    evidence_insufficient: ['cognition.inbox_evidence_insufficient_hint', '没有可追溯的证据，无法确认为正式资产。'],
    source_unavailable: ['cognition.inbox_source_unavailable_hint', '这些资产的证据来源已不可读，请决定继续保留还是撤销。'],
    sensitivity_unclassified: ['cognition.inbox_sensitivity_unclassified_hint', '未分级不等于 L0：分级前不会被带往声明了敏感上限的目的地。'],
    candidate_pending_review: ['cognition.inbox_candidate_hint', '确认后才会成为正式资产。'],
  };
  const entry = hints[kind];
  return entry ? _cognitionText(entry[0], entry[1]) : '';
}

/**
 * 这一条待办到底要你做什么——写成一句祈使句，放在行的主位。
 *
 * 与 `_cognitionInboxKindAction`（按钮上的动作词）分工：那个是"点下去会发生
 * 什么"，这个是"这一行在问你什么"。两者都要有，因为同一条资产可能同时挂着
 * 几件不同的事，只有资产标题的话它们长得一模一样。
 */
function _cognitionInboxKindAsk(kind) {
  const asks = {
    sensitivity_unclassified: ['cognition.inbox_ask_classify', '补充敏感级分类'],
    sensitivity_escalated: ['cognition.inbox_ask_sensitivity', '确认这次敏感级提升'],
    rule_boundary_missing: ['cognition.inbox_ask_boundary', '为这条规则补充适用边界'],
    rule_scope_changed: ['cognition.inbox_ask_scope', '确认作用范围的改动'],
    classification_conflict: ['cognition.inbox_ask_conflict', '裁定它属于哪一类'],
    evidence_insufficient: ['cognition.inbox_ask_evidence', '补充可追溯的证据'],
    source_unavailable: ['cognition.inbox_ask_source', '处理失效的证据来源'],
    template_updated: ['cognition.inbox_ask_template', '确认模板正文的改动'],
    skill_creation_suggested: ['cognition.inbox_ask_skill_create', '决定是否生成为 Skill'],
    skill_upgrade_suggested: ['cognition.inbox_ask_skill_upgrade', '决定是否更新已装的 Skill'],
    candidate_pending_review: ['cognition.inbox_ask_candidate', '确认是否成为正式资产'],
  };
  const entry = asks[kind];
  return entry ? _cognitionText(entry[0], entry[1]) : _cognitionInboxKindLabel(kind);
}

/**
 * 每一类待办的主动作措辞。
 *
 * 「查看」对需要裁决的事项是错的说法——用户点进去是要做决定，不是去围观。
 * 措辞按 kind 给，取不到就退回「查看」。
 */
function _cognitionInboxKindAction(kind) {
  const labels = {
    rule_boundary_missing: ['cognition.inbox_action_set_scope', '确认范围'],
    rule_scope_changed: ['cognition.inbox_action_review_scope', '确认范围'],
    classification_conflict: ['cognition.inbox_action_resolve', '裁定分类'],
    sensitivity_escalated: ['cognition.inbox_action_review_sensitivity', '确认扩权'],
    sensitivity_unclassified: ['cognition.inbox_action_classify', '分级'],
    evidence_insufficient: ['cognition.inbox_action_add_evidence', '补证据'],
    source_unavailable: ['cognition.inbox_action_handle_source', '处理来源'],
    template_updated: ['cognition.inbox_action_review_change', '确认改动'],
    skill_creation_suggested: ['cognition.inbox_action_review_suggestion', '查看建议'],
    skill_upgrade_suggested: ['cognition.inbox_action_review_upgrade', '查看更新'],
    candidate_pending_review: ['cognition.inbox_action_review_candidate', '查看候选'],
  };
  const entry = labels[kind];
  return entry ? _cognitionText(entry[0], entry[1]) : _cognitionText('common.view', '查看');
}

/**
 * 一条待办右侧的决策动作。
 *
 * 候选类待办直接给「稍后 / 拒绝」，用的是 `data-recall-candidate-action`——
 * 与沉淀活动页的候选行同一套 data 属性，所以事件绑定不需要再写一遍。资产类
 * 待办只给打开入口：暂停、撤销这类资产级动作有影响面，必须在「版本与治理」
 * 里看过影响再执行，不能在收件箱一键触发。
 */
function _renderCognitionInboxRowActions(entry) {
  const primaryLabel = _cognitionInboxKindAction(entry.kind);
  const open = entry.assetId
    ? `<button type="button" class="btn btn-sm btn-primary" data-cognition-open-asset="${escapeHtml(entry.assetId)}">${escapeHtml(primaryLabel)}</button>`
    : entry.candidateId
      ? `<button type="button" class="btn btn-sm btn-primary" data-cognition-open-candidate="${escapeHtml(entry.candidateId)}">${escapeHtml(primaryLabel)}</button>`
      : '';
  if (!entry.candidateId) return open;
  const candidateId = escapeHtml(entry.candidateId);
  return `${open}<button type="button" class="btn btn-sm" data-recall-candidate-action="defer" data-recall-candidate-id="${candidateId}">${escapeHtml(_cognitionText('cognition.status_deferred', '稍后'))}</button><button type="button" class="btn btn-sm" data-recall-candidate-action="reject" data-recall-candidate-id="${candidateId}">${escapeHtml(_cognitionText('cognition.candidate_reject', '拒绝'))}</button>`;
}

/**
 * 按 kind 分组渲染待办。同一类事情合成一个面板，用户一次处理一类，而不是
 * 面对一条一条互不相干的行。
 *
 * 行本身不再是一整块按钮：决策动作摆在行右侧，标题区只负责说清这是什么事。
 * 整行可点时用户无法在"打开"和"拒绝"之间做区分，只能先进详情页再退回来。
 */
function _renderCognitionInboxGroups(urgency) {
  const items = (Array.isArray(_skillsCognitionState.inboxItems) ? _skillsCognitionState.inboxItems : [])
    .filter((entry) => entry && entry.urgency === urgency);
  if (!items.length) return '';
  const grouped = new Map();
  for (const entry of items) {
    const bucket = grouped.get(entry.kind) || [];
    bucket.push(entry);
    grouped.set(entry.kind, bucket);
  }
  return [...grouped.entries()].map(([kind, bucket]) => {
    const rows = bucket.slice(0, 8).map((entry) => {
      const meta = [entry.assetType ? _abilityAssetCategoryLabel(entry.assetType) : '', entry.detail || '']
        .filter(Boolean).join(' · ');
      const actions = _renderCognitionInboxRowActions(entry);
      // 行内必须说清**这一条要你做什么**。同一条资产可以同时挂几个待办（比如
      // 既缺敏感分级、又缺作用边界），它们紧急度不同、会落在不同的分组带里。
      // 若行上只有资产标题，用户看到同一个标题出现两次，读到的是"系统重复了
      // 一条"，而不是"同一条资产有两件事没处理"。
      const ask = _cognitionInboxKindAsk(entry.kind);
      return `<div class="cognition-inbox-row"><div class="cognition-inbox-row-main"><strong>${escapeHtml(ask)}</strong><span class="cognition-inbox-row-subject">${escapeHtml(entry.title || entry.id)}</span>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}</div>${actions ? `<div class="cognition-inbox-row-actions">${actions}</div>` : ''}</div>`;
    }).join('');
    const more = bucket.length > 8
      ? `<div class="skills-cognition-muted">${escapeHtml(_cognitionText('cognition.inbox_more', '另有 {n} 项未显示').replace('{n}', String(bucket.length - 8)))}</div>`
      : '';
    return `<section class="skills-cognition-card recall-overview-panel cognition-inbox-group is-${escapeHtml(urgency)}"><div class="skills-cognition-card-head"><h2>${escapeHtml(_cognitionInboxKindLabel(kind))}</h2><b>${escapeHtml(String(bucket.length))}</b></div><p class="cognition-inbox-hint">${escapeHtml(_cognitionInboxKindHint(kind))}</p>${rows}${more}</section>`;
  }).join('');
}

/**
 * 待办的三条分组带：需要确认 / 可以稍后 / 教学回执。
 *
 * 分组本身要自解释——同一个收件箱里，"系统认为必须打扰你"和"顺手告诉你一声"
 * 是两种承诺，不给组头用户就只能靠卡片颜色猜。徽标说的是这一组的性质，副说明
 * 说的是这一组的打扰规则。
 */
function _renderCognitionInboxBand(band) {
  if (!band.body) return '';
  return `<section class="cognition-inbox-band is-${escapeHtml(band.tone)}">
    <div class="cognition-inbox-band-head">
      <div><strong>${escapeHtml(_cognitionText(band.titleKey, band.title))}</strong><span class="skills-cognition-status is-${escapeHtml(band.tone)}">${escapeHtml(_cognitionText(band.badgeKey, band.badge))}</span></div>
      <span>${escapeHtml(_cognitionText(band.hintKey, band.hint))}</span>
    </div>
    <div class="recall-overview-activity-grid">${band.body}</div>
  </section>`;
}

/**
 * 「待我处理」里的阻塞项。
 *
 * 只收"用户不决定就走不下去"的三类：沉淀模型没配（整条链停摆）、来源失效
 * （已有资产的证据来源断了）、以及失败的沉淀任务。第三类默认不在这里显示——
 * 它是后台加工进度，归「沉淀活动」；`includeProcessing` 让沉淀活动页复用同一
 * 段渲染，不用再写一份。
 */
function _renderCognitionOverviewAttention(options) {
  const includeProcessing = options?.includeProcessing === true;
  const captures = _skillsCognitionState.captureCounts || {};
  const recentCaptures = Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : [];
  const sourceItems = (Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .flatMap((source) => _cognitionPrimarySourceItems(source));
  const captureModel = _skillsCognitionState.captureModel;
  const failedTasks = includeProcessing ? Number(captures.failed || 0) : 0;
  const sourceIssues = sourceItems.filter((item) => item.status === 'failed' || item.status === 'paused').length;
  const modelAuthorizationRequired = !!captureModel?.authorizationRequired;
  const modelRequired = (!!captureModel && (!captureModel.configured || modelAuthorizationRequired))
    || recentCaptures.some((capture) => capture.status === 'configuration_required');
  const modelIssue = modelAuthorizationRequired
    ? _captureErrorLabel('model_auth_required')
    : _cognitionText('cognition.overview_model_required', '沉淀模型尚未配置');
  if (!failedTasks && !sourceIssues && !modelRequired) return '';
  const issues = [
    modelRequired ? `<button type="button" class="recall-overview-attention-row" data-recall-capture-settings><span>${escapeHtml(modelIssue)}</span><b>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</b></button>` : '',
    // 这两行都是"去修"，不是"去看"：说「查看」会让用户以为点进去只是读一份
    // 报告，于是把真正需要动手的事一直搁着。
    failedTasks ? `<button type="button" class="recall-overview-attention-row" data-cognition-page-link="captures"><span>${escapeHtml(_cognitionText('cognition.overview_failed_tasks', '{count} 个沉淀任务需要重试').replace('{count}', String(failedTasks)))}</span><b>${escapeHtml(_cognitionText('common.handle', '处理'))}</b></button>` : '',
    sourceIssues ? `<button type="button" class="recall-overview-attention-row" data-cognition-page-link="sources"><span>${escapeHtml(_cognitionText('cognition.overview_source_issues', '{count} 个数据来源需要处理').replace('{count}', String(sourceIssues)))}</span><b>${escapeHtml(_cognitionText('common.handle', '处理'))}</b></button>` : '',
  ].filter(Boolean).join('');
  return `<section class="recall-overview-attention"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.overview_attention', '需要处理'))}</h2><span>${escapeHtml(_cognitionText('cognition.overview_attention_hint', '解决后沉淀链路会自动继续'))}</span></div><div>${issues}</div></section>`;
}

function _renderCognitionRecentActivity() {
  const captures = Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : [];
  const assets = Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [];
  const conversationTitles = new Map((Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .filter((source) => source.kind === 'conversation')
    .flatMap((source) => source.items || [])
    .map((item) => [item.id, item.title || item.id]));
  const activity = [
    ...captures.map((capture) => ({
      kind: 'capture', id: capture.id, at: capture.updatedAt || capture.createdAt || '',
      title: conversationTitles.get(capture.conversationId) || capture.conversationTitle || capture.conversationId,
      status: _cognitionStatusLabel(_captureWorkflowStatus(capture)),
      detail: _captureNextActionText(capture),
    })),
    ...assets.map((asset) => ({
      kind: 'asset', id: asset.id, at: asset.updatedAt || asset.createdAt || '',
      title: _abilityAssetDisplayTitle(asset),
      status: _abilityAssetCategoryLabel(asset.category || asset.type),
      detail: _cognitionText('cognition.overview_activity_asset', '记忆已入库'),
    })),
  ].sort((left, right) => {
    const leftTime = Date.parse(left.at) || 0;
    const rightTime = Date.parse(right.at) || 0;
    return rightTime - leftTime;
  }).slice(0, 5);
  const rows = activity.length ? activity.map((item) => {
    const action = item.kind === 'asset'
      ? `data-cognition-open-asset="${escapeHtml(item.id)}"`
      : 'data-cognition-page-link="captures"';
    const kind = item.kind === 'asset'
      ? _cognitionText('cognition.overview_activity_memory', '能力资产')
      : _cognitionText('cognition.overview_activity_capture', '会话沉淀');
    return `<button type="button" class="recall-overview-activity-row" ${action}><span class="recall-overview-activity-main"><strong>${escapeHtml(item.title || item.id)}</strong><small>${escapeHtml(kind)} · ${escapeHtml(item.detail)}</small></span><span class="recall-overview-activity-meta"><b>${escapeHtml(item.status)}</b>${item.at ? `<small>${escapeHtml(_cognitionDate(item.at))}</small>` : ''}</span></button>`;
  }).join('') : _renderCognitionEmpty(_cognitionText('cognition.overview_activity_empty', '完成会话沉淀后，最近变化会显示在这里'));
  return `<section class="skills-cognition-card recall-overview-panel recall-overview-activity"><div class="skills-cognition-card-head"><h2>${escapeHtml(_cognitionText('cognition.overview_recent_activity', '最近动态'))}</h2></div><div class="recall-overview-activity-list">${rows}</div></section>`;
}

function _renderTeachingSignalStatus() {
  const signals = Array.isArray(_skillsCognitionState.teachingSignals) ? _skillsCognitionState.teachingSignals : [];
  const rows = signals.length ? signals.slice(0, 5).map((signal) => {
    const status = signal.status === 'revoked'
      ? _cognitionText('cognition.teaching_revoked', '已撤销')
      : _cognitionText('cognition.teaching_pending', '已记住 · 待审核');
    const action = signal.status === 'active'
      ? `<button class="btn btn-sm" data-recall-teaching-revoke="${escapeHtml(signal.id)}">${escapeHtml(_cognitionText('cognition.teaching_revoke', '撤销'))}</button>`
      : '';
    return `<div class="skills-cognition-capture-row"><div><strong>${escapeHtml(signal.summary || signal.id)}</strong><span>${escapeHtml(signal.scope || '')} · ${escapeHtml(_cognitionDate(signal.createdAt))}</span></div><span class="skills-cognition-status is-${escapeHtml(signal.status || '')}">${escapeHtml(status)}</span>${action}</div>`;
  }).join('') : _renderCognitionEmpty(_cognitionText('cognition.teaching_empty', '明确的记住、偏好、避免或纠正会在这里留下可撤销回执'));
  // 组头归外层的「教学回执」分组带，这里不再自带一个——两层标题会让用户以为
  // 这是收件箱之外的另一块内容。
  return `<section class="skills-cognition-card recall-overview-panel recall-overview-teaching"><div class="skills-cognition-capture-list">${rows}</div></section>`;
}

/**
 * 「待我处理」有没有内容。落地页规则要用它：有待决策项就停在这里，没有就
 * 直接进「我的资产」——用户不该为了看资产先穿过一个空页。
 */
function _cognitionInboxIsEmpty() {
  // A failed read is not an empty inbox. Keep the user on this page so the
  // visible warning and retry action remain available.
  if (_cognitionLoadFailed('inboxItems')) return false;
  const items = Array.isArray(_skillsCognitionState.inboxItems) ? _skillsCognitionState.inboxItems : [];
  if (items.length) return false;
  // 失败候选不在服务端待办里（那是加工失败，不是分类问题），但用户仍然要
  // 处理，所以单独算一笔。
  const failedCandidates = (Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [])
    .filter((candidate) => candidate.status === 'failed');
  if (failedCandidates.length) return false;
  const teachingSignals = Array.isArray(_skillsCognitionState.teachingSignals) ? _skillsCognitionState.teachingSignals : [];
  if (teachingSignals.some((signal) => signal.status === 'active')) return false;
  return _renderCognitionOverviewAttention() === '';
}

/**
 * 「待我处理」：回答"现在有什么事情真的需要我决定"。
 *
 * 刻意不放的东西：沉淀任务进度、来源连接状态面板、指标卡。它们是后台加工
 * 与配置，分别归右上角「沉淀活动」「管理来源」——放进来会让"需要我决定"
 * 这件事被进度噪音淹没，用户就不再信任这个红点。
 */
/**
 * 「已处理历史」按需加载（cognition.reviewDecisions.list）。
 *
 * 不进快照九路并行：它只服务待我处理页里一个可折叠的带，进页才拉。
 * `total` 与 `items.length` 分开存——limit 截断的是显示条数，不是处理过的条数。
 */
async function loadCognitionReviewHistory() {
  _skillsCognitionState.reviewHistory = { loading: true };
  if (_skillsCognitionState.page === 'inbox') renderSkillsCognitionInbox();
  try {
    const result = await window.cogseed.invoke('cognition.reviewDecisions.list', { limit: 20 });
    if (!result?.ok) throw new Error(result?.error || 'review decision history read failed');
    _skillsCognitionState.reviewHistory = {
      items: Array.isArray(result.items) ? result.items : [],
      total: Number.isFinite(result.total) ? result.total : (Array.isArray(result.items) ? result.items.length : 0),
    };
  } catch (error) {
    _skillsCognitionState.reviewHistory = { error: (error && error.message) || String(error) };
  }
  if (_skillsCognitionState.page === 'inbox') renderSkillsCognitionInbox();
}

/** 决定类型的人话。契约里的七种全部覆盖，未知值原样显示——出现新类型时
 *  露出它，好过悄悄归到"其它"里看不见。 */
function _reviewDecisionLabel(type) {
  return _cognitionText(`cognition.review_decision_${type}`, ({
    accept: '已确认', modify: '修改后确认', defer: '稍后处理',
    reject: '已拒绝', ignore: '已忽略', keep_current: '保持当前版本', trial: '试用',
  })[type] || String(type || ''));
}

/**
 * 「已处理历史」带。只渲染账本里真有的字段：决定类型、时间、被处理对象、
 * 来源信号、结果（outcome）。**没有的不补**——账本里没有候选标题，就显示
 * target_ref 本身，不去别处凑一个可能已经不存在的名字。
 */
function _renderCognitionReviewHistory() {
  const state = _skillsCognitionState.reviewHistory;
  if (!state || state.loading) {
    return `<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;
  }
  if (state.error) {
    return `<div class="skills-cognition-warning"><span>${escapeHtml(state.error)}</span><button type="button" class="btn btn-sm" data-cognition-review-history-reload>${escapeHtml(_cognitionText('common.retry', '重试'))}</button></div>`;
  }
  if (!state.items.length) {
    return `<div class="skills-cognition-empty"><strong>${escapeHtml(_cognitionText('cognition.review_history_empty', '还没有处理记录'))}</strong><span>${escapeHtml(_cognitionText('cognition.review_history_empty_hint', '你确认、拒绝或稍后处理过的候选会按时间倒序出现在这里。'))}</span></div>`;
  }
  const rows = state.items.map((entry) => {
    const outcome = entry.outcome === 'asset_created'
      ? _cognitionText('cognition.review_outcome_asset', '已生成正式资产')
      : entry.outcome === 'asset_failed'
        ? _cognitionText('cognition.review_outcome_failed', '资产写入失败')
        : '';
    const meta = [
      _cognitionDate(entry.timestamp),
      entry.scope ? _cognitionText('cognition.review_scope', '作用域 {s}').replace('{s}', entry.scope) : '',
      entry.actor === 'system' ? _cognitionText('cognition.review_actor_system', '系统自动') : '',
      outcome,
    ].filter(Boolean).join(' · ');
    return `<div class="cognition-review-history-row">
      <div><strong>${escapeHtml(entry.target_ref || entry.decision_id || '')}</strong><span class="skills-cognition-meta">${escapeHtml(meta)}</span></div>
      <span class="skills-cognition-status is-completed">${escapeHtml(_reviewDecisionLabel(entry.decision_type))}</span>
    </div>`;
  }).join('');
  const truncated = state.total > state.items.length
    ? `<p class="skills-cognition-meta">${escapeHtml(_cognitionText('cognition.review_history_truncated', '共 {total} 条，显示最近 {shown} 条。')
      .replace('{total}', String(state.total)).replace('{shown}', String(state.items.length)))}</p>`
    : '';
  return `<div class="cognition-review-history">${rows}</div>${truncated}`;
}

function renderSkillsCognitionInbox() {
  const host = document.getElementById('skills-cognition-inbox-body');
  if (!host) return;
  if (_cognitionSnapshotPending()) { _renderCognitionLoading(host); return; }
  const d = _skillsCognitionState.dashboard || {};
  const candidates = (Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [])
    .filter((candidate) => _recallCandidateCapabilities(candidate).countsAsPending);
  const warnings = Array.isArray(d.warnings) ? d.warnings : [];
  const primarySections = new Set(['dashboard', 'recallCandidates', 'assets', 'sources', 'captures', 'recentCaptures', 'captureSettings', 'inboxItems']);
  const loadErrors = (Array.isArray(_skillsCognitionState.loadErrors) ? _skillsCognitionState.loadErrors : [])
    .filter((section) => primarySections.has(section));
  const warningHtml = d.degraded || warnings.length
    ? `<div class="skills-cognition-warning">${escapeHtml(_cognitionText('cognition.degraded', '部分认知数据处于降级状态'))}</div>`
    : '';
  const loadFailureHtml = loadErrors.length
    ? `<div class="skills-cognition-warning"><span>${escapeHtml(_cognitionText('cognition.load_failed', '认知资产数据加载失败'))}</span><button class="btn btn-sm" data-cognition-reload>${escapeHtml(_cognitionText('common.retry', '重试'))}</button></div>`
    : '';
  // 沉淀失败的候选不在服务端待办里——那是加工失败，不是分类问题——但用户
  // 仍然要处理，所以单独列一段。
  const failedCandidates = candidates.filter((candidate) => candidate.status === 'failed');
  const failedHtml = failedCandidates.length
    ? `<section class="skills-cognition-card recall-overview-panel cognition-inbox-group is-confirm"><div class="skills-cognition-card-head"><h2>${escapeHtml(_cognitionText('cognition.inbox_failed_candidates', '沉淀失败的候选'))}</h2><b>${escapeHtml(String(failedCandidates.length))}</b></div>${failedCandidates.slice(0, 5).map((c) => `<button type="button" class="skills-cognition-list-card" data-cognition-open-candidate="${escapeHtml(c.id)}"><strong>${escapeHtml(c.title || c.summary || c.judgment || c.id)}</strong><span>${escapeHtml(_cognitionStatusLabel(c.status))} · ${escapeHtml(_abilityAssetCategoryLabel(c.suggestedType || c.type))}</span></button>`).join('')}</section>`
    : '';
  const teachingSignals = Array.isArray(_skillsCognitionState.teachingSignals) ? _skillsCognitionState.teachingSignals : [];
  const inboxItems = Array.isArray(_skillsCognitionState.inboxItems) ? _skillsCognitionState.inboxItems : [];
  const confirmCount = inboxItems.filter((entry) => entry?.urgency === 'confirm').length + failedCandidates.length;
  const laterCount = inboxItems.filter((entry) => entry?.urgency === 'low_disturbance').length;
  // 教学回执用后端真实 total，不用本次取回的条数——`recall.teaching.list` 有
  // limit（默认 20、上限 100），拿 `.length` 当总数超过 limit 就是错的。
  // 注意 total 是"全部教学回执"，这里要的是"生效中的"：所以只有在这一页没被
  // 截断（取回条数 < total 说明截断了）时才敢按 active 过滤计数，否则如实用
  // total 并在 label 上说清它是全部条数。
  const teachingTruncated = Number.isFinite(_skillsCognitionState.totals?.teachingSignals)
    && _skillsCognitionState.totals.teachingSignals > teachingSignals.length;
  const activeTeachingCount = teachingTruncated
    ? _skillsCognitionState.totals.teachingSignals
    : teachingSignals.filter((signal) => signal?.status === 'active').length;
  const hero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.inbox_eyebrow', eyebrow: 'TO REVIEW',
    titleKey: 'cognition.inbox_title', title: '只把需要你决定的事放在这里',
    hintKey: 'cognition.inbox_page_hint', hint: '先处理会阻塞沉淀或资产使用的事项，其余候选保持低打扰。',
    metrics: [
      { value: confirmCount, key: 'cognition.inbox_confirm_now', label: '需要确认' },
      { value: laterCount, key: 'cognition.inbox_can_wait', label: '可以稍后' },
      teachingTruncated
        ? { value: activeTeachingCount, key: 'cognition.inbox_teaching_all', label: '教学回执（全部）' }
        : { value: activeTeachingCount, key: 'cognition.inbox_teaching_receipts', label: '教学回执' },
    ],
  });
  // 需要主动确认的排在前面；普通候选低打扰地跟在后面。分级来自服务端 gate，
  // 渲染层不自己判断哪件事更急。教学回执是第三条独立带：它已经按用户的明确
  // 表达生效了，混在「可以稍后」里会让人以为它还等着自己拍板。
  const confirmBand = _renderCognitionInboxBand({
    tone: 'confirm',
    titleKey: 'cognition.inbox_confirm_now', title: '需要确认',
    badgeKey: 'cognition.inbox_confirm_badge', badge: '会影响后续使用',
    hintKey: 'cognition.inbox_confirm_hint', hint: '只在冲突、扩权或高影响变化时打扰你',
    body: `${_renderCognitionInboxGroups('confirm')}${failedHtml}`,
  });
  const laterBand = _renderCognitionInboxBand({
    tone: 'later',
    titleKey: 'cognition.inbox_can_wait', title: '可以稍后',
    badgeKey: 'cognition.inbox_later_badge', badge: '不阻塞工作',
    hintKey: 'cognition.inbox_later_hint', hint: '普通候选不会弹窗',
    body: _renderCognitionInboxGroups('low_disturbance'),
  });
  // 「已处理历史」：原型 03 的第三个页签。做成带而不是页签——它和上面两条带
  // 是同一个问题的两面（还需要我决定的 / 我已经决定过的），拆成页签会让用户
  // 以为要切走才能看。
  const historyBand = _renderCognitionInboxBand({
    tone: 'history',
    titleKey: 'cognition.inbox_processed', title: '已处理',
    badgeKey: 'cognition.inbox_processed_badge', badge: '真实落账记录',
    hintKey: 'cognition.inbox_processed_hint', hint: '按处理时间倒序，只显示已经落账的决定',
    body: _renderCognitionReviewHistory(),
  });
  const teachingBand = _renderCognitionInboxBand({
    tone: 'teaching',
    titleKey: 'cognition.inbox_teaching_receipts', title: '教学回执',
    badgeKey: 'cognition.inbox_teaching_badge', badge: '已按你的明确表达处理',
    hintKey: 'cognition.inbox_teaching_hint', hint: '可撤销，不需要重复确认',
    body: teachingSignals.length ? _renderTeachingSignalStatus() : '',
  });
  const attention = _renderCognitionOverviewAttention();
  const notices = `${loadFailureHtml}${warningHtml}`;
  // 空态只看"还需要我决定的"三条带；已处理历史不参与——有历史不代表有待办，
  // 把它算进去会让「当前无需处理」永远不出现。
  //
  // 两种空是两件事，给的下一步也不同：
  //   一件东西都没有 → 首启引导（该从哪儿开始）
  //   有资产但没待办 → 「当前无需处理」+ 一个**显式**去我的资产的入口
  // 后者以前是静默跳页，现在把这一跳交还给用户。
  const inboxIsEmpty = !attention && !confirmBand && !laterBand && !teachingBand;
  const emptyHtml = !inboxIsEmpty
    ? ''
    : _cognitionIsFirstRun()
      ? _cognitionSeedMarkup()
      : `<div class="skills-cognition-empty cognition-inbox-empty"><strong>${escapeHtml(_cognitionText('cognition.inbox_empty', '当前无需处理'))}</strong><span>${escapeHtml(_cognitionText('cognition.inbox_empty_hint', '需要你决定的事项会出现在这里；系统自动整理的进度在「沉淀活动」里查看。'))}</span><div class="skills-cognition-actions"><button type="button" class="btn btn-sm btn-primary" data-cognition-page-link="assets">${escapeHtml(_cognitionText('cognition.inbox_empty_go_assets', '去看我的资产'))}</button></div></div>`;
  host.innerHTML = `
    <div class="skills-cognition-overview">
      ${hero}
      ${notices ? `<div class="recall-overview-notices">${notices}</div>` : ''}
      ${attention}
      ${confirmBand}
      ${laterBand}
      ${teachingBand}
      ${historyBand}
      ${emptyHtml}
    </div>`;
}

// 「使用与证明」：回答"这些资产究竟在哪里用过、真的起作用了吗"。
// 事实全部来自 timeline-service 已聚合的一条链（usage / transfer proof /
// effectiveness proof / receipt），这里只翻译成用户能理解的说法，不造事实。
const _COGNITION_PROOF_KINDS = new Set([
  'usage_recorded', 'transfer_prepared', 'transfer_completed', 'effectiveness_recorded', 'projection_confirmed',
]);

// 结果状态用用户能读懂的话，不露出内部枚举。
function _cognitionProofOutcomeLabel(item) {
  const status = String(item && item.status || '');
  if (item.kind === 'transfer_completed') {
    if (status === 'succeeded') return _cognitionText('cognition.proof_carried_in', '已正确带入');
    if (status === 'degraded') return _cognitionText('cognition.proof_degraded', 'Evidence 不足');
    return _cognitionText('cognition.proof_rejected', '未能带入');
  }
  if (item.kind === 'effectiveness_recorded') {
    // 结论在 `outcome` 上，不在 `status` 上。效果证明记录里 `status` 是
    // `outcome !== 'invalid'` 的派生量（proof-service.ts:180），没有独立语义，
    // 因此不能拿它当结论词表的键——早先这里读 status，永远拿到 'valid'，
    // 匹配全部落空，整行退回英文原文（"Effectiveness recorded"）。
    const outcome = String(item.outcome || '');
    if (outcome === 'better') return _cognitionText('cognition.proof_effective', '使用结果有效');
    if (outcome === 'no_improvement') return _cognitionText('cognition.proof_no_diff', '未产生明显差异');
    if (outcome === 'worse') return _cognitionText('cognition.proof_negative', '出现负面影响');
    if (outcome === 'rework') return _cognitionText('cognition.proof_rework', '需要修正');
    // `invalid` 与 `insufficient_evidence` 在产品里是同一句话「Evidence 不足」
    // （评价按钮 invalid 的标签就是它），区别只在于前者是用户明说、后者是
    // 系统在"点了有效却没有可追溯对比"时自动降级。不要在这里发明第三种说法。
    if (outcome === 'insufficient_evidence' || outcome === 'invalid') {
      return _cognitionText('cognition.proof_degraded', 'Evidence 不足');
    }
    return '';
  }
  if (item.kind === 'usage_recorded') return _cognitionText('cognition.proof_used', '被引用');
  if (item.kind === 'projection_confirmed') return _cognitionText('cognition.proof_projected', '已带入本次任务');
  return '';
}

/**
 * 效果证明里**用户真正写下的观察**。没有就返回空。
 *
 * `observedResult` 是个双关字段（effectiveness-feedback.ts:34）：用户写了备注就
 * 存备注，没写就存一句合成的 `User feedback: <feedback>`。而当前评价入口（四个
 * 按钮）根本不收备注，所以实机落盘的几乎全是那句合成串。
 *
 * 把它印在「这次复用的效果结论」下面会有两个问题：它是英文的内部占位串，且它
 * 表达的信息和上面那行结论词完全重复。这里识别出合成串并丢掉——宁可只显示结论，
 * 也不要拿系统自己生成的回声冒充用户的观察。
 */
function _cognitionProofUserObservation(event) {
  const summary = String(event && event.summary || '').trim();
  if (!summary) return '';
  return /^user feedback:\s*\S+$/i.test(summary) ? '' : summary;
}

/**
 * 一条记录的色调按**结果**给，不按事件种类给。
 *
 * 之前标记点是按 kind 上色的：只要是 effectiveness_recorded 就画成绿色。于是
 * 用户点了「需要修正」「出现负面影响」，时间线上照样是一个绿点——视觉上在说
 * 「这次有效」，正好和这一页"不把被使用说成已验证"的立意相反。
 */
function _cognitionProofOutcomeTone(item) {
  const status = String(item && item.status || '');
  if (item.kind === 'transfer_completed') {
    if (status === 'succeeded') return 'good';
    if (status === 'degraded') return 'warn';
    return 'bad';
  }
  if (item.kind === 'effectiveness_recorded') {
    const outcome = String(item.outcome || '');
    if (outcome === 'better') return 'good';
    if (outcome === 'worse') return 'bad';
    if (outcome === 'rework' || outcome === 'no_improvement') return 'warn';
    // Evidence 不足（invalid / insufficient_evidence）：既不是好也不是坏，
    // 上中性色，不要用绿色替这次复用背书。
    return 'neutral';
  }
  return 'neutral';
}

/**
 * 这一行到底能不能评价，以及不能的话是卡在哪一步。
 *
 * **为什么要有这个函数**：评价按钮原来的显示条件是
 * `refs.transferProofId || refs.taskRunId`，四种行都会命中；而后端两条通道
 * （`recall.proofs.effectiveness.feedback` / `feedbackForTask`）都要求存在
 * **status='succeeded' 且已绑定回执**的迁移证明。于是用户在「已带入本次任务」
 * 底下点评价，直接吃到 `no successful transfer proof for task run`（实机复现）。
 * 控件渲染在 4 种行上，实际只有 1 种行的 1 种状态能成功。
 *
 * 这里把闸门收到与后端一致的那一格，并且**说清为什么**——不是把按钮藏掉。
 * 藏掉最省事，但同时藏掉了「这条证明链现在走到哪一步」这个信息：用户会以为
 * 功能坏了，我们也看不出「几乎没有一行能评价」背后的回执覆盖率问题。
 *
 * 判定与后端一一对应：
 *   kind !== transfer_completed        → 还没走到产生结论的那一步
 *   status !== succeeded               → 这次带入失败或降级，没有可评价的复用
 *   缺 usageReceiptId(=proof.receiptId) → 证明没绑回执，后端 findValidTransferReceipt 会拒
 *   回执已读到但边界不是 real / 已 rejected → 同上，拿降级回执当证据比没证据更危险
 */
function _proofRatingEligibility(event, receipt) {
  const refs = (event && event.refs) || {};
  const kind = String((event && event.kind) || '');
  if (kind === 'effectiveness_recorded') return { ok: false, reason: 'rated' };
  if (kind === 'projection_confirmed' || kind === 'usage_recorded') {
    return { ok: false, reason: 'no_transfer_yet' };
  }
  if (kind === 'transfer_prepared') return { ok: false, reason: 'transfer_pending' };
  if (kind !== 'transfer_completed') return { ok: false, reason: 'not_a_use' };
  const status = String((event && event.status) || '');
  if (status === 'degraded') return { ok: false, reason: 'transfer_degraded' };
  if (status !== 'succeeded') return { ok: false, reason: 'transfer_rejected' };
  if (!refs.transferProofId) return { ok: false, reason: 'no_transfer_yet' };
  // 回执号取自证明记录本身，恒准；回执**正文**受列表窗口限制可能没取到，
  // 所以只在真取到、且明确不合格时才据此否决，取不到不算否决。
  if (!refs.usageReceiptId) return { ok: false, reason: 'no_receipt' };
  if (receipt && (receipt.boundary && receipt.boundary !== 'real')) {
    return { ok: false, reason: 'receipt_not_real', boundary: String(receipt.boundary) };
  }
  if (receipt && receipt.status === 'rejected') return { ok: false, reason: 'receipt_not_real', boundary: 'rejected' };
  return { ok: true, proofId: String(refs.transferProofId) };
}

/**
 * 「更好了」这条结论可以引用哪些**可追溯**的东西。
 *
 * PRD 3.6 给 Effectiveness Validated 的成立条件是「存在可比 Baseline/Treatment、
 * Behavior Diff、Evaluation」——一个赞不算证明。后端据此把无引用的 `better`
 * 降级成 `insufficient_evidence`（proof-service.ts），所以正向评价必须让用户
 * 指出**凭什么**。这里给出这一格能提供的引用项。
 *
 * 只给系统真的握有 id 的东西，不编造：回执背后的那次执行、以及资产被带进去的
 * 那个目标会话。回执正文没取到时返回空——那种情况下如实告诉用户这条评价会被
 * 记成 Evidence 不足，而不是替他凑一条引用。
 */
function _proofEvidenceOptions(receipt) {
  const options = [];
  if (receipt && receipt.executionId) {
    options.push({
      kind: 'execution_evaluation',
      subtype: 'evaluation',
      id: String(receipt.executionId),
      label: _cognitionText('cognition.proof_evidence_execution', '这次执行的结果'),
    });
  }
  if (receipt && receipt.targetSessionId) {
    options.push({
      kind: 'conversation',
      subtype: 'session',
      id: String(receipt.targetSessionId),
      label: _cognitionText('cognition.proof_evidence_session', '资产被带入的那个会话'),
    });
  }
  return options;
}

/** 不能评价时给用户的那句话。每一条都要说清**卡在哪**和**接下来会怎样**，
 *  否则用户只知道点不了，不知道是等一等还是这次就没戏了。 */
function _proofRatingBlockedText(eligibility) {
  const reason = (eligibility && eligibility.reason) || '';
  if (reason === 'no_transfer_yet') {
    return _cognitionText('cognition.proof_rating_blocked_no_transfer',
      '这次复用还没有形成迁移证明，暂时不能评价。任务结束并留下复用回执后，这里会出现评价入口。');
  }
  if (reason === 'transfer_pending') {
    return _cognitionText('cognition.proof_rating_blocked_pending',
      '迁移证明还没完成。任务结束后才会给出「是否正确带入」的结论，那时才能评价效果。');
  }
  if (reason === 'transfer_degraded') {
    return _cognitionText('cognition.proof_rating_blocked_degraded',
      '这次带入被判定为 Evidence 不足，不能作为效果评价的依据。');
  }
  if (reason === 'transfer_rejected') {
    return _cognitionText('cognition.proof_rating_blocked_rejected',
      '这次没能把资产带入目标会话，没有可评价的复用。');
  }
  if (reason === 'no_receipt') {
    return _cognitionText('cognition.proof_rating_blocked_no_receipt',
      '这次迁移证明没有绑定复用回执，无法核对究竟带入了什么，因此不开放效果评价。');
  }
  if (reason === 'receipt_not_real') {
    return _cognitionText('cognition.proof_rating_blocked_receipt_not_real',
      '这次的回执不是真实边界（{b}），不能作为效果评价的依据。')
      .replace('{b}', String((eligibility && eligibility.boundary) || ''));
  }
  return '';
}

/**
 * 一次复用的六段链条：正式资产 → 引用空间 → 目标 Session → 实际注入 →
 * 结果 → 评价。
 *
 * 这是「使用与证明」区别于普通使用日志的地方——它把一次复用摊开成一条可核
 * 对的链，每一段都指向一个具体事实，而不是只说"用过 3 次"。取不到的那一段
 * 显示 `—`，不猜、也不用相邻信息顶替。
 */
function _renderProofChainStrip(asset, event, receipt) {
  const refs = (event && event.refs) || {};
  const workspaceRefs = Array.isArray(asset?.workspaceRefs) ? asset.workspaceRefs.filter(Boolean) : [];
  const injected = receipt && Array.isArray(receipt.reusedRefs) && receipt.reusedRefs.length
    ? _cognitionText('cognition.proof_chain_injected_n', '{n} 项').replace('{n}', String(receipt.reusedRefs.length))
    : '';
  const stages = [
    ['cognition.proof_chain_asset', '正式资产', asset ? `${_abilityAssetDisplayTitle(asset)}${asset.version ? ` v${asset.version}` : ''}` : ''],
    ['cognition.proof_chain_space', '引用空间', workspaceRefs.join('、')],
    ['cognition.proof_chain_session', '目标 Session', receipt?.targetSessionId || refs.taskRunId || ''],
    ['cognition.proof_chain_injected', '实际注入', injected],
    ['cognition.proof_chain_result', '结果', _cognitionProofOutcomeLabel(event || {})],
    // 「可评价」必须和评价控件用同一个闸门。两处各判各的，就会出现链条上写着
    // 可评价、底下却没有按钮（或有按钮但点了报错）。
    ['cognition.proof_chain_rating', '评价', (() => {
      const eligibility = _proofRatingEligibility(event || {}, receipt);
      if (eligibility.ok) return _cognitionText('cognition.proof_chain_rating_open', '可评价');
      if (eligibility.reason === 'rated') return _cognitionProofOutcomeLabel(event || {});
      return '';
    })()],
  ];
  return `<div class="recall-proof-chain" role="group" aria-label="${escapeHtml(_cognitionText('cognition.proof_chain', '这次复用的链条'))}">${stages.map(([key, fallback, value], index) => `
    <div class="recall-proof-chain-stage${value ? '' : ' is-empty'}">
      <span>${escapeHtml(_cognitionText(key, fallback))}</span>
      <strong>${escapeHtml(value || '—')}</strong>
    </div>${index < stages.length - 1 ? '<i class="recall-proof-chain-arrow" aria-hidden="true">→</i>' : ''}`).join('')}</div>`;
}

/**
 * 一次使用展开后的全部字段。
 *
 * 交互与「版本与治理」一致：点哪一条就在那一条底下原地展开，而不是把详情
 * 甩到另一栏。证明这件事要求视线不离开被证明的那一行——左右分栏会让用户
 * 反复确认"右边这张回执是不是左边选中那条的"。
 *
 * 回执与事件之间走**显式 id**：transfer_completed 事件的 refs.usageReceiptId
 * 就是回执 id。不做时间窗反查——靠时间猜出来的"这两条大概是同一次"在证明
 * 面板里是最不该出现的东西。
 */
function _renderProofEventDetail(asset, event, receipt) {
  if (!event) return '';
  const refs = event.refs || {};
  // 效果评价这一行**本身就是评价结果**，不再挂首次评价控件。挂了会出现两个
  // 后果：一是"给一条评价再评一次价"在语义上说不通；二是每点一次就再落一条
  // 效果证明，同一次复用能攒出几条互相矛盾的结论（实机观测：4 秒内
  // positive / positive / rework 三条并存，全部留在链上）。
  // 首次评价只从 transfer_completed（以及尚未评价的使用记录）进入。
  // 将来要支持改评价，另做「修改评价」语义，而不是复用这套首次评价控件。
  const alreadyRated = event.kind === 'effectiveness_recorded';
  // 闸门与后端一致（见 _proofRatingEligibility）：只有 transfer_completed +
  // succeeded + 已绑回执这一格能真的写进去。其余情况**照样渲染这一区**，但
  // 换成一句说明为什么现在不能评价——不是把控件藏掉。
  const ratingEligibility = _proofRatingEligibility(event, receipt);
  const feedbackTarget = ratingEligibility.ok
    ? `data-recall-proof-feedback-proof="${escapeHtml(ratingEligibility.proofId)}"`
    : '';
  const blockedText = ratingEligibility.ok ? '' : _proofRatingBlockedText(ratingEligibility);
  const ratingQuestion = escapeHtml(_cognitionText('cognition.proof_rating_question', '这次复用是否有用？'));
  // 「更好了」要走取证步骤，其余三档直接落账——只有正向结论会推动成熟度升到
  // effectiveness_validated，后端也只对它要求可追溯引用。
  const evidenceDraftOpen = ratingEligibility.ok
    && _skillsCognitionState.proofRatingDraft
    && _skillsCognitionState.proofRatingDraft.eventId === event.id;
  let rating = '';
  if (feedbackTarget && evidenceDraftOpen) {
    const options = _proofEvidenceOptions(receipt);
    const optionsHtml = options.length
      ? options.map((option, index) => `<label class="recall-proof-evidence-option"><input type="checkbox" data-recall-proof-evidence="${index}" data-evidence-kind="${escapeHtml(option.kind)}" data-evidence-subtype="${escapeHtml(option.subtype)}" data-evidence-id="${escapeHtml(option.id)}" checked><span>${escapeHtml(option.label)}</span><code>${escapeHtml(option.id)}</code></label>`).join('')
      : `<p class="recall-proof-evidence-none">${escapeHtml(_cognitionText('cognition.proof_evidence_none', '这次没有可引用的执行记录，评价会如实记成「Evidence 不足」——结论保留，但不会把成熟度推到「效果已验证」。'))}</p>`;
    rating = `<div class="recall-proof-rating is-evidence">
      <strong>${escapeHtml(_cognitionText('cognition.proof_evidence_title', '凭什么说它让结果更好了？'))}</strong>
      <p class="recall-proof-evidence-hint">${escapeHtml(_cognitionText('cognition.proof_evidence_hint', '写下你观察到的变化，并勾选能回查的依据。没有可追溯的依据时，系统不会把「更好」当成已验证。'))}</p>
      <textarea class="recall-proof-evidence-note" data-recall-proof-evidence-note rows="3" placeholder="${escapeHtml(_cognitionText('cognition.proof_evidence_placeholder', '例如：这次直接按资产里的结构出了初稿，没有再返工。'))}"></textarea>
      <div class="recall-proof-evidence-options">${optionsHtml}</div>
      <div class="recall-proof-rating-actions">
        <button type="button" class="btn btn-sm btn-primary" data-recall-proof-evidence-submit="${escapeHtml(ratingEligibility.proofId)}">${escapeHtml(_cognitionText('cognition.proof_evidence_submit', '记下这次评价'))}</button>
        <button type="button" class="btn btn-sm" data-recall-proof-evidence-cancel>${escapeHtml(_cognitionText('cognition.action.cancel', '取消'))}</button>
      </div>
    </div>`;
  } else if (feedbackTarget) {
    rating = `<div class="recall-proof-rating"><strong>${ratingQuestion}</strong><div class="recall-proof-rating-actions">${[
      // 正向这一档不直接提交：它是唯一能推动 effectiveness_validated 的结论，
      // 必须先问「凭什么」。
      ['positive', 'cognition.proof_carried_in', '带入正确', true],
      ['rework', 'cognition.proof_rework', '需要修正', false],
      ['neutral', 'cognition.proof_no_diff', '未产生明显差异', false],
      ['invalid', 'cognition.proof_degraded', 'Evidence 不足', false],
    ].map(([value, key, fallback, needsEvidence]) => (needsEvidence
      ? `<button type="button" class="btn btn-sm" data-recall-proof-evidence-open="${escapeHtml(event.id)}">${escapeHtml(_cognitionText(key, fallback))}</button>`
      : `<button type="button" class="btn btn-sm" ${feedbackTarget} data-recall-proof-feedback="${value}">${escapeHtml(_cognitionText(key, fallback))}</button>`)).join('')}</div></div>`;
  } else if (blockedText) {
    rating = `<div class="recall-proof-rating is-blocked"><strong>${ratingQuestion}</strong><p class="recall-proof-rating-blocked">${escapeHtml(blockedText)}</p></div>`;
  }
  // 已评价的那一行改为**只陈述已形成的结论**：结论词 + 用户当时写下的观察。
  // 这一段替代原来的评价控件，让"这条已经有结论了"本身成为可读信息，而不是
  // 留一块空白让人以为详情没渲染出来。
  const ratedSummary = alreadyRated
    ? `<div class="recall-proof-rating is-rated"><strong>${escapeHtml(_cognitionText('cognition.proof_rating_result', '这次复用的效果结论'))}</strong><div class="recall-proof-rating-conclusion"><span class="recall-proof-outcome">${escapeHtml(_cognitionProofOutcomeLabel(event) || _cognitionText('cognition.not_recorded', '未记录'))}</span>${_cognitionProofUserObservation(event) ? `<p>${escapeHtml(_cognitionProofUserObservation(event))}</p>` : ''}</div></div>`
    : '';

  const receiptTitle = _cognitionText('cognition.proof_receipt_title', 'Context Reuse Receipt');
  let receiptBlock;
  if (!receipt) {
    const why = refs.usageReceiptId
      ? _cognitionText('cognition.proof_receipt_unreadable', '这一次记录了回执号，但回执内容当前读不到。')
      : _cognitionText('cognition.proof_receipt_absent', '这一次没有留下复用回执，因此无法逐项核对带入内容。');
    receiptBlock = `<div class="recall-proof-receipt"><div class="recall-proof-receipt-head"><strong>${escapeHtml(receiptTitle)}</strong></div><p class="recall-proof-receipt-note">${escapeHtml(why)}</p></div>`;
  } else {
    const rows = [
      ['cognition.proof_receipt_carried', '带入内容', (receipt.reusedRefs || []).join('、')],
      ['cognition.proof_receipt_omitted', '未带入', (receipt.omittedRefs || []).join('、')],
      ['cognition.proof_chain_session', '目标 Session', receipt.targetSessionId || ''],
      ['cognition.proof_receipt_permission', '权限范围', [receipt.permissionMode, ...(receipt.allowedScopes || [])].filter(Boolean).join(' · ')],
    ].filter(([, , value]) => value)
      .map(([key, fallback, value]) => `<div class="recall-proof-receipt-row"><dt>${escapeHtml(_cognitionText(key, fallback))}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
    // boundary 不是 real 时必须说出来：拿一次降级或测试替身的回执当真实证据，
    // 比没有证据更危险。
    const boundary = receipt.boundary && receipt.boundary !== 'real'
      ? `<span class="skills-cognition-status is-degraded">${escapeHtml(_cognitionText('cognition.proof_receipt_not_real', '非真实边界：{b}').replace('{b}', String(receipt.boundary)))}</span>`
      : `<span class="skills-cognition-status">${escapeHtml(_cognitionText('cognition.proof_receipt_traceable', '可追溯'))}</span>`;
    receiptBlock = `<div class="recall-proof-receipt">
      <div class="recall-proof-receipt-head"><strong>${escapeHtml(receiptTitle)}</strong><span class="recall-proof-receipt-id">${escapeHtml(receipt.receiptId || '')}</span>${boundary}</div>
      <dl class="recall-proof-receipt-body">${rows}</dl>
    </div>`;
  }

  return `<div class="recall-proof-detail">${_renderProofChainStrip(asset, event, receipt)}${receiptBlock}${rating}${ratedSummary}</div>`;
}

/**
 * 取「使用与证明」这一页的数据。**取数与重画分开**：展开一条记录、切一层筛选
 * 都只是本地状态变化，不该把整页清成 loading 再等两次 IPC 往返——那正是点开
 * 一条 Evidence 不足看到的闪动。只有进入本页、以及写入过评价（成熟度会变）时
 * 才重取。
 */
async function loadCognitionProofs() {
  const host = document.getElementById('skills-cognition-proofs-body');
  if (!_skillsCognitionState.proofData && host) _renderCognitionLoading(host);
  try {
    // 回执与时间线一起取。回执取不到不该让整页打不开——它是逐项核对用的补充，
    // 缺了仍能看见"在哪里用过、结果如何"。
    const [timelineResult, receiptResult] = await Promise.all([
      window.cogseed.invoke('recall.timeline.list', { limit: 500 }),
      window.cogseed.invoke('cognition.receipts.list', { limit: 200 }).catch(() => null),
    ]);
    _skillsCognitionState.proofData = {
      items: Array.isArray(timelineResult && timelineResult.items) ? timelineResult.items : [],
      receipts: Array.isArray(receiptResult && receiptResult.receipts) ? receiptResult.receipts : [],
    };
    _skillsCognitionState.proofLoadFailed = false;
  } catch (error) {
    _skillsLog.warn('recall timeline load failed', { error: (error && error.message) || String(error) });
    // 取数失败时保留上一份数据：把已经看到的证明链换成一句错误，比让用户
    // 盯着一页空白更糟——他会以为记录没了。
    _skillsCognitionState.proofLoadFailed = !_skillsCognitionState.proofData;
  }
  renderSkillsCognitionProofs();
}

function renderSkillsCognitionProofs() {
  const host = document.getElementById('skills-cognition-proofs-body');
  if (!host) return;
  if (_skillsCognitionState.proofLoadFailed) {
    _renderCognitionError(host);
    return;
  }
  const cached = _skillsCognitionState.proofData;
  if (!cached) {
    _renderCognitionLoading(host);
    return;
  }
  const items = cached.items;
  const receipts = cached.receipts;
  // 回执按 receiptId 索引：事件的 refs.usageReceiptId 就是它，属于显式关联，
  // 不做时间窗反查。
  const receiptById = new Map(receipts.filter((entry) => entry && entry.receiptId).map((entry) => [String(entry.receiptId), entry]));
  const assets = Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [];
  const titleById = new Map(assets.map((asset) => [asset.id, _abilityAssetDisplayTitle(asset)]));

  // 只保留"用过/证明过"的事实；治理事件属于「版本与治理」，不在这一页。
  const proofItems = items.filter((item) => _COGNITION_PROOF_KINDS.has(item.kind)
    && item.refs && item.refs.assetId);
  // 筛选是这一页的分层表达：「被引用」「传递已证明」「效果已验证」「Evidence
  // 不足」不是四种标签，而是四层不同强度的结论。用户来这一页往往只想回答其中
  // 一层——"到底哪几条真的验证过"——把四层混在一条时间线里他就得自己数。
  //
  // 分层直接由既有的 kind + status 推出，不新增字段：Evidence 不足这一层横跨
  // 两种事件（带入降级、效果无法归因），所以它按 status 判定而不是按 kind。
  const proofFilters = [
    ['all', 'cognition.proofs_filter_all', '全部', () => true],
    ['used', 'cognition.proofs_filter_used', '已引用',
      (item) => item.kind === 'usage_recorded' || item.kind === 'projection_confirmed'],
    ['transferred', 'cognition.proofs_filter_transferred', '传递已证明',
      (item) => item.kind === 'transfer_completed' && item.status === 'succeeded'],
    // 效果层读 `outcome` 而不是 `status`：效果证明的 status 是
    // `outcome !== 'invalid'` 的派生量，恒为 'valid'/'invalid'，拿它比 'better'
    // 永远为假——这一格因此在用户已经点过「带入正确」之后仍然显示 0。
    ['effective', 'cognition.proofs_filter_effective', '效果已验证',
      (item) => item.kind === 'effectiveness_recorded' && item.outcome === 'better'],
    ['insufficient', 'cognition.proofs_filter_insufficient', 'Evidence 不足',
      (item) => (item.kind === 'transfer_completed' && item.status === 'degraded')
        || (item.kind === 'effectiveness_recorded'
          && (item.outcome === 'insufficient_evidence' || item.outcome === 'invalid'))],
  ];
  const activeFilter = proofFilters.some(([id]) => id === _skillsCognitionState.proofFilter)
    ? _skillsCognitionState.proofFilter : 'all';
  const matches = proofFilters.find(([id]) => id === activeFilter)[3];
  const byAsset = new Map();
  for (const item of proofItems) {
    if (!matches(item)) continue;
    const assetId = item.refs.assetId;
    if (!byAsset.has(assetId)) byAsset.set(assetId, []);
    byAsset.get(assetId).push(item);
  }
  const proofEvents = [...byAsset.values()].flat();
  // 计数用未筛选的全量：指标卡说的是"这一页总共有多少事实"，跟着筛选一起变
  // 会让用户以为记录被删了。
  const allProofEvents = proofItems;
  const allAssetIds = new Set(proofItems.map((item) => item.refs.assetId));
  const filterBar = `<div class="recall-capture-filter-bar cognition-proof-filters">${proofFilters
    .map(([id, key, fallback, test]) => {
      const count = id === 'all' ? proofItems.length : proofItems.filter(test).length;
      return `<button type="button" class="recall-capture-filter${activeFilter === id ? ' is-active' : ''}" data-cognition-proof-filter="${id}" aria-pressed="${activeFilter === id ? 'true' : 'false'}"><span>${escapeHtml(_cognitionText(key, fallback))}</span><b>${escapeHtml(String(count))}</b></button>`;
    }).join('')}</div>`;
  // 两张说明卡回答"这两种证明各自能说明什么"。它们不是装饰：用户最容易犯的
  // 错就是把「被正确带入」读成「有效」，这一页的全部意义就是把这两件事分开。
  const proofNotes = `<div class="cognition-proof-notes">
    <section class="skills-cognition-card"><h3>${escapeHtml(_cognitionText('cognition.proofs_note_transfer', '传递证明回答什么'))}</h3><p class="panel-sub">${escapeHtml(_cognitionText('cognition.proofs_note_transfer_body', '目标会话是否正确收到、理解并开始使用指定资产。它不说明结果好坏。'))}</p></section>
    <section class="skills-cognition-card"><h3>${escapeHtml(_cognitionText('cognition.proofs_note_effect', '效果证明回答什么'))}</h3><p class="panel-sub">${escapeHtml(_cognitionText('cognition.proofs_note_effect_body', '在可归因的条件下，资产是否改善了任务结果；没有评价时保持“尚未验证”。'))}</p></section>
  </div>`;
  const hero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.proofs_eyebrow', eyebrow: 'USE & EVIDENCE',
    titleKey: 'cognition.proofs_title', title: '先看在哪里用，再看是否真的有效',
    hintKey: 'cognition.proofs_page_hint', hint: '使用、迁移与效果分层展示；没有效果证明时，不会把“被使用”说成“已验证”。',
    metrics: [
      { value: allAssetIds.size, key: 'cognition.proofs_assets_covered', label: '涉及资产' },
      { value: allProofEvents.length, key: 'cognition.proofs_event_count', label: '使用与证明记录' },
      { value: allProofEvents.filter((item) => item.kind === 'effectiveness_recorded').length, key: 'cognition.proofs_effect_count', label: '效果评价' },
    ],
  });
  if (!allProofEvents.length) {
    host.innerHTML = `${hero}<div class="skills-cognition-empty cognition-task-empty">${escapeHtml(_cognitionText('cognition.proofs_empty', '还没有资产被真正带入过任务。资产被使用后，这里会显示它在哪里用过、结果如何。'))}</div>`;
    return;
  }
  // 全量非空但当前筛选为空是另一回事：说「还没有资产被带入过」会让用户以为
  // 记录不见了，实际只是这一层证明还没有。
  if (!byAsset.size) {
    host.innerHTML = `${hero}${filterBar}<div class="skills-cognition-empty cognition-task-empty"><strong>${escapeHtml(_cognitionText('cognition.proofs_filter_empty', '这一层还没有记录'))}</strong><span>${escapeHtml(_cognitionText('cognition.proofs_filter_empty_hint', '换一个筛选，或回到「全部」查看这条资产的完整使用链。'))}</span></div>${proofNotes}`;
    return;
  }

  // 默认全部收起，与「版本与治理」一致：详情要用户主动点开。自动展开一条会
  // 让页面一进来就被一大块字段占住，反而看不清"总共用过哪些地方"。
  const allEvents = [...byAsset.values()].flat();
  const selectedId = _skillsCognitionState.selectedProofEventId;
  const selected = allEvents.find((item) => item.id === selectedId);
  if (selectedId && !selected) _skillsCognitionState.selectedProofEventId = '';

  const sections = [...byAsset.entries()].map(([assetId, entries]) => {
    entries.sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')));
    const title = titleById.get(assetId) || assetId;
    // 效果证明不直接持有回执号——回执挂在它指向的那条迁移证明上。这里按
    // transferProofId 走一跳把回执解析出来，而不是让 timeline 把 receiptId 抄
    // 到效果证明里：抄过去就等于断言"效果证明直接持有一张回执"，Receipt →
    // Transfer → Effectiveness 三段关系会被拍平成一段，之后谁都说不清这张回执
    // 到底证明的是"带入"还是"有用"。
    const receiptIdByTransferProof = new Map(entries
      .filter((item) => item.kind === 'transfer_completed' && item.refs?.transferProofId && item.refs?.usageReceiptId)
      .map((item) => [String(item.refs.transferProofId), String(item.refs.usageReceiptId)]));
    const receiptIdForItem = (item) => {
      const refs = item.refs || {};
      if (refs.usageReceiptId) return String(refs.usageReceiptId);
      if (item.kind !== 'effectiveness_recorded' || !refs.transferProofId) return '';
      return receiptIdByTransferProof.get(String(refs.transferProofId)) || '';
    };
    const rows = entries.slice(0, 20).map((item) => {
      const outcome = _cognitionProofOutcomeLabel(item);
      const refs = item.refs || {};
      const receiptId = receiptIdForItem(item);
      const hasReceipt = receiptById.has(receiptId);
      // 效果证明的 summary 多半是合成的 `User feedback: <feedback>`——英文内部
      // 占位串，且和左边的结论词重复。只在它确实是用户写下的观察时才显示。
      const rowSummary = item.kind === 'effectiveness_recorded'
        ? _cognitionProofUserObservation(item)
        : (item.summary || item.title || '');
      const meta = [
        refs.taskRunId ? `${escapeHtml(_cognitionText('cognition.proof_task', '任务'))} ${escapeHtml(refs.taskRunId)}` : '',
        refs.version ? `v${escapeHtml(refs.version)}` : '',
        hasReceipt ? escapeHtml(_cognitionText('cognition.proof_receipt', '有回执')) : '',
      ].filter(Boolean).join(' · ');
      const isOpen = selected && item.id === selected.id;
      // 展开区就挂在这一行下面——证明这件事要求视线不离开被证明的那一行。
      const detail = isOpen
        ? _renderProofEventDetail(assets.find((asset) => asset.id === assetId), item, receiptById.get(receiptId))
        : '';
      return `<div class="recall-proof-entry${isOpen ? ' is-open' : ''}">
        <button type="button" class="recall-proof-event is-${escapeHtml(item.kind || 'event')} is-tone-${escapeHtml(_cognitionProofOutcomeTone(item))}" data-recall-proof-event="${escapeHtml(item.id)}" aria-expanded="${isOpen ? 'true' : 'false'}">
          <span class="recall-proof-marker" aria-hidden="true"></span>
          <span class="recall-proof-event-body"><strong class="recall-proof-outcome">${escapeHtml(outcome || item.title || item.kind)}</strong>${rowSummary ? `<span class="recall-proof-summary">${escapeHtml(rowSummary)}</span>` : ''}${meta ? `<span class="recall-proof-meta">${meta}</span>` : ''}</span>
          <time class="recall-proof-time">${escapeHtml(_cognitionDate(item.occurredAt))}</time>
        </button>${detail}
      </div>`;
    }).join('');
    return `<section class="skills-cognition-card recall-proof-asset">
      <div class="skills-cognition-card-head">
        <div><h2>${escapeHtml(title)}</h2><span class="recall-proof-count">${escapeHtml(_cognitionText('cognition.proofs_asset_events', '{n} 条记录').replace('{n}', String(entries.length)))}</span></div>
        <button type="button" class="btn btn-sm" data-ability-asset-id="${escapeHtml(assetId)}" data-cognition-page-link="assets">${escapeHtml(_cognitionText('cognition.proof_open_asset', '查看资产'))}</button>
      </div>
      <div class="recall-proof-timeline">${rows}</div>
    </section>`;
  }).join('');
  host.innerHTML = `${hero}${filterBar}<div class="recall-proof-list">${sections}</div>${proofNotes}`;
}

function renderSkillsCognitionCandidates() {
  const host = document.getElementById('skills-cognition-capture-review-body')
    || document.getElementById('skills-cognition-candidates-body');
  if (!host) return;
  const allCandidates = Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [];
  // 候选**归属于具体的沉淀任务**，展开某条记录时只能显示这条任务自己的候选。
  //
  // 这段过去不收窄是对的：那时候选是页面级的「候选池」，池子里显示全部待确认
  // 候选名副其实。现在它被内联到某条沉淀记录的展开态里，不收窄就等于让 UI
  // 宣称"这些候选属于这条任务"，而渲染并不保证——展开任务 A 会看到任务 B 的
  // 候选，capture ↔ candidate 的归属关系在展示层被抹平。
  //
  // 归属以任务自己的 `candidateIds` 为准；没有选中任务（独立候选池宿主）时才
  // 回到全量。
  const selectedCapture = [
    ...(Array.isArray(_skillsCognitionState.captures) ? _skillsCognitionState.captures : []),
    ...(Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : []),
  ].find((capture) => capture && capture.id === _skillsCognitionState.selectedCaptureId);
  const ownedIds = selectedCapture && Array.isArray(selectedCapture.candidateIds)
    ? new Set(selectedCapture.candidateIds)
    : null;
  const recallItems = allCandidates.filter((candidate) => (
    _recallCandidateCapabilities(candidate).countsAsPending
    && (!ownedIds || ownedIds.has(candidate.id))
  ));
  if (!recallItems.length) {
    _skillsCognitionState.selectedRecallCandidateIds = [];
    _skillsCognitionState.candidatePoolSelectionInitialized = false;
    host.innerHTML = `<section class="recall-capture-review recall-candidate-pool"><div class="recall-workbench-section-head"><div><h2>${escapeHtml(_cognitionText('cognition.capture_candidate_pool_title', '③ 候选池'))}</h2><p>${escapeHtml(_cognitionText('cognition.capture_candidate_pool_hint', '这里汇总所有沉淀任务的待确认候选，可统一选择后一次性入库。'))}</p></div><span class="skills-cognition-status is-completed">0</span></div><div class="recall-candidate-pool-empty">${escapeHtml(_cognitionText('cognition.capture_candidate_pool_empty', '当前没有待确认候选。完成沉淀后，候选会集中显示在这里。'))}</div></section>`;
    return;
  }
  const bulkItems = recallItems.filter((candidate) => _recallCandidateCapabilities(candidate).canBatchSelect);
  const bulkIds = new Set(bulkItems.map((candidate) => candidate.id));
  if (!_skillsCognitionState.candidatePoolSelectionInitialized) {
    _skillsCognitionState.selectedRecallCandidateIds = bulkItems.map((candidate) => candidate.id);
    _skillsCognitionState.candidatePoolSelectionInitialized = true;
  } else {
    _skillsCognitionState.selectedRecallCandidateIds = (Array.isArray(_skillsCognitionState.selectedRecallCandidateIds)
      ? _skillsCognitionState.selectedRecallCandidateIds : []).filter((id) => bulkIds.has(id));
  }
  const selectedIds = new Set(_skillsCognitionState.selectedRecallCandidateIds || []);
  const selectedCount = [...selectedIds].filter((id) => bulkIds.has(id)).length;
  const conversationTitles = new Map((Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .filter((source) => source?.kind === 'conversation')
    .flatMap((source) => source.items || [])
    .map((item) => [item.id, item.title || item.id]));
  const captureLabels = new Map();
  for (const capture of [...(_skillsCognitionState.captures || []), ...(_skillsCognitionState.recentCaptures || [])]) {
    const label = capture?.conversationTitle || conversationTitles.get(capture?.conversationId) || capture?.conversationId || capture?.id || '';
    for (const candidateId of (Array.isArray(capture?.candidateIds) ? capture.candidateIds : [])) {
      if (label && !captureLabels.has(candidateId)) captureLabels.set(candidateId, label);
    }
  }
  const allSelected = bulkItems.length > 0 && selectedCount === bulkItems.length;
  const reviewActions = `<div class="recall-capture-review-head-actions"><span class="skills-cognition-status is-review_ready">${escapeHtml(String(recallItems.length))}</span><span class="recall-candidate-selection-count">${escapeHtml(_cognitionText('cognition.capture_candidate_selection', '{selected}/{total} 条可批量入库').replace('{selected}', String(selectedCount)).replace('{total}', String(bulkItems.length)))}</span>${bulkItems.length ? `<button type="button" class="btn btn-sm btn-primary" data-recall-candidate-promote-all ${selectedCount ? '' : 'disabled'}>${escapeHtml(_cognitionText('cognition.capture_save_selected_to_recall', '一键入库（全部保存）'))}</button>` : ''}</div>`;
  host.innerHTML = `<section class="recall-capture-review recall-candidate-pool"><div class="recall-workbench-section-head"><div><h2>${escapeHtml(_cognitionText('cognition.capture_candidate_pool_title', '③ 候选池'))}</h2><p>${escapeHtml(_cognitionText('cognition.capture_candidate_pool_hint', '这里汇总所有沉淀任务的待确认候选，可统一选择后一次性入库。'))}</p></div>${reviewActions}</div>${bulkItems.length ? `<div class="recall-candidate-pool-toolbar"><label><input type="checkbox" data-recall-candidate-select-all ${allSelected ? 'checked' : ''}> <span>${escapeHtml(_cognitionText('cognition.capture_candidate_select_all', '全选可批量入库项'))}</span></label><span>${escapeHtml(_cognitionText('cognition.capture_candidate_risk_hint', '高风险候选需单独确认；失败候选请单独重试。'))}</span></div>` : ''}<div class="skills-cognition-record-list recall-candidate-list">${recallItems.map((candidate) => {
    const primaryAction = candidate.suggestedAction === 'keep_current'
      ? 'keep-current'
      : candidate.suggestedAction === 'reject' ? 'reject' : 'promote';
    const capability = _recallCandidateCapabilities(candidate);
    // keep-current / reject 走非资产决定链（canReject），promote 走晋升链（canPromote）。
    const primaryAllowed = primaryAction === 'promote' ? capability.canPromote : capability.canReject;
    const actions = [
      ...(primaryAllowed ? [primaryAction] : []),
      ...(capability.canEdit ? ['edit'] : []),
      ...(capability.canDefer ? ['defer'] : []),
      ...(capability.canReject && primaryAction !== 'reject' ? ['reject'] : []),
      ...(capability.canReject ? ['ignore'] : []),
    ];
    const editing = _skillsCognitionState.editingRecallCandidateId === candidate.id;
    const canBulkSelect = capability.canBatchSelect;
    const captureLabel = captureLabels.get(candidate.id);
    const selection = canBulkSelect
      ? `<label class="recall-candidate-select"><input type="checkbox" data-recall-candidate-select="${escapeHtml(candidate.id)}" ${selectedIds.has(candidate.id) ? 'checked' : ''}><span>${escapeHtml(_cognitionText('cognition.capture_candidate_select', '选择'))}</span></label>`
      : `<span class="recall-candidate-select-placeholder" title="${escapeHtml(_recallCandidateBlockedText(capability.batchBlockedReason || capability.disabledReason) || _cognitionText('cognition.capture_candidate_failed_hint', '失败候选需单独重试'))}">${escapeHtml(capability.batchBlockedReason === 'candidate_high_risk_needs_single_review' ? '!' : '·')}</span>`;
    const editForm = editing ? `<div class="skills-cognition-detail-block recall-candidate-editor">
      <label>${escapeHtml(_cognitionText('cognition.judgment', '我的判断'))}<textarea data-recall-edit-judgment>${escapeHtml(candidate.judgment || '')}</textarea></label>
      <label>${escapeHtml(_cognitionText('cognition.summary', '摘要'))}<input data-recall-edit-summary value="${escapeHtml(candidate.summary || '')}"></label>
      <label>${escapeHtml(_cognitionText('cognition.scope', '作用域'))}<input data-recall-edit-scope value="${escapeHtml(candidate.suggestedScope || '')}"></label>
      <label>${escapeHtml(_cognitionText('cognition.type', '类型'))}<select data-recall-edit-type>${['personal','rule','template','skill_method'].map((type) => `<option value="${type}" ${candidate.suggestedType === type ? 'selected' : ''}>${escapeHtml(_abilityAssetCategoryLabel(type))}</option>`).join('')}</select></label>
      <label>${escapeHtml(_cognitionText('cognition.applicable_when', '适用场景（一行一条）'))}<textarea data-recall-edit-applicable>${escapeHtml((candidate.applicableWhen || []).join('\n'))}</textarea></label>
      <label>${escapeHtml(_cognitionText('cognition.forbidden_when', '禁止场景（一行一条）'))}<textarea data-recall-edit-forbidden>${escapeHtml((candidate.forbiddenWhen || []).join('\n'))}</textarea></label>
      <label class="recall-candidate-editor-wide">${escapeHtml(_cognitionText('cognition.evidence_refs', '证据引用'))}<textarea data-recall-edit-evidence>${escapeHtml((candidate.sourceRefs || []).map((ref) => `${ref.kind}:${ref.id}`).join('\n'))}</textarea></label>
      <div class="skills-cognition-actions recall-candidate-editor-wide"><button class="btn btn-sm btn-primary" data-recall-candidate-action="save-and-promote" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('cognition.candidate_modify_and_save', '修改后保存'))}</button><button class="btn btn-sm" data-recall-candidate-action="cancel-edit" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('common.cancel', '取消'))}</button></div>
    </div>` : '';
    return `<article class="skills-cognition-record cognition-candidate-row recall-collapsible${selectedIds.has(candidate.id) ? ' is-bulk-selected' : ''}" data-recall-candidate-id="${escapeHtml(candidate.id)}"><div class="recall-candidate-pool-row"><div>${selection}</div><span class="recall-candidate-source">${escapeHtml(captureLabel ? `${_cognitionText('cognition.capture_candidate_source', '来源')}：${captureLabel}` : _cognitionText('cognition.capture_candidate_source_unknown', '来源：沉淀候选'))}</span></div><details class="recall-collapsible-body"><summary class="skills-cognition-record-head recall-collapsible-summary"><span class="recall-collapsible-title"><h2>${escapeHtml(_abilityCandidateDisplayTitle(candidate))}</h2><span class="skills-cognition-meta">${escapeHtml(_abilityAssetCategoryLabel(candidate.suggestedType))} · ${escapeHtml(_abilityAssetScopeLabel(candidate.suggestedScope))}</span></span><span class="skills-cognition-status is-${escapeHtml(capability.displayState)}">${escapeHtml(_recallCandidateStateLabel(capability))}</span></summary><p>${escapeHtml(candidate.judgment || '')}</p>${candidate.value ? `<p class="skills-cognition-meta">${escapeHtml(candidate.value)}</p>` : ''}<div class="skills-cognition-meta">${escapeHtml(_abilityAssetCategoryLabel(candidate.suggestedType))} · ${escapeHtml(_abilityAssetScopeLabel(candidate.suggestedScope))}</div>${candidate.failureMessage ? `<div class="skills-cognition-error">${escapeHtml(candidate.failureMessage)}</div>` : ''}<div class="skills-cognition-detail-block"><strong>${escapeHtml(_cognitionText('cognition.evidence_refs', '证据引用'))}</strong><div class="skills-cognition-ref-row">${_renderCognitionInlineRefs(candidate.evidenceRefs || candidate.sourceRefs)}</div></div>${editForm}<div class="skills-cognition-actions">${actions.map((action) => `<button class="btn btn-sm ${action === primaryAction ? 'btn-primary' : ''}" data-recall-candidate-action="${escapeHtml(action)}" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(action === 'promote' ? _cognitionText('cognition.capture_save_to_recall', '沉淀为能力资产') : action === 'keep-current' ? _cognitionText('cognition.candidate_keep_current', '保持当前版本') : action === 'reject' ? _cognitionText('cognition.candidate_reject', '拒绝') : action === 'ignore' ? _cognitionText('cognition.capture_ignore', '忽略') : action === 'defer' ? _cognitionText('cognition.status_deferred', '稍后') : _cognitionText('skills.edit', '编辑'))}</button>`).join('')}</div></details></article>`;
  }).join('')}</div></section>`;
}

/**
 * 「候选详情」：一条候选的整页决定面。
 *
 * 为什么值得单独一页而不是继续用折叠行：作用范围冲突这类事项要用户同时看清
 * 三件事——内容是什么、它该在什么范围生效、为什么轮到我决定。折叠行里第三件
 * 事没有位置，用户只能凭标题猜，于是要么全盘接受要么全盘拒绝。
 *
 * 表单字段沿用编辑态的 `data-recall-edit-*` 与 `data-recall-candidate-action`，
 * 所以「确认并限域」直接走既有的 save-and-promote（先落范围与类型，再晋升），
 * 事件绑定一行都不用加。
 */
function renderSkillsCognitionCandidateDetail() {
  const host = document.getElementById('skills-cognition-candidate-body');
  if (!host) return;
  const candidates = Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [];
  const candidate = candidates.find((item) => item.id === _skillsCognitionState.selectedCandidateId);
  const hero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.candidate_eyebrow', eyebrow: 'CANDIDATE',
    titleKey: 'cognition.candidate_detail_title', title: '确认内容，也确认它该在什么范围生效',
    hintKey: 'cognition.candidate_detail_hint', hint: '确认后会创建正式资产的第一个版本，并保留来源与撤销入口。',
    backPage: 'inbox',
  });
  if (!candidate) {
    host.innerHTML = `${hero}<div class="skills-cognition-empty cognition-task-empty"><strong>${escapeHtml(_cognitionText('cognition.candidate_detail_missing', '这条候选已不在待处理列表中'))}</strong><span>${escapeHtml(_cognitionText('cognition.candidate_detail_missing_hint', '它可能已经被确认、拒绝或过期。回到「待我处理」查看当前待办。'))}</span></div>`;
    return;
  }
  const typeOptions = ['personal', 'rule', 'template', 'skill_method']
    .map((type) => `<option value="${type}" ${candidate.suggestedType === type ? 'selected' : ''}>${escapeHtml(_abilityAssetCategoryLabel(type))}</option>`).join('');
  // 「为什么需要你确认」只列这条候选真实具备的理由，不铺满四条通用说辞——
  // 每条都对得上一个字段，用户才可能相信这不是模板话术。
  const reasons = [
    candidate.risk === 'high'
      ? _cognitionText('cognition.candidate_reason_high_risk', '这条被判为高风险变更，确认前不会自动生效。')
      : '',
    !String(candidate.suggestedScope || '').trim()
      ? _cognitionText('cognition.candidate_reason_no_scope', '它还没有作用范围；没有范围的规则不会被带入任何任务。')
      : '',
    Array.isArray(candidate.applicableWhen) && candidate.applicableWhen.length
      ? _cognitionText('cognition.candidate_reason_applicable', '它提出了适用条件，确认后会按这些条件匹配任务。')
      : '',
    Array.isArray(candidate.forbiddenWhen) && candidate.forbiddenWhen.length
      ? _cognitionText('cognition.candidate_reason_forbidden', '它提出了禁止条件，确认后这些场景会被排除。')
      : '',
    candidate.targetAssetId
      ? _cognitionText('cognition.candidate_reason_target', '它会改动一条已有资产，而不是新建。')
      : _cognitionText('cognition.candidate_reason_new_asset', '确认后会创建 v1，并保留来源与撤销入口。'),
  ].filter(Boolean);
  // 详情页的可编辑/可操作面同样来自能力，不看 raw status——confirmed 候选
  // 在这里再开编辑就是假的：它已经是资产了，改动要走正式资产版本链。
  const detailCapability = _recallCandidateCapabilities(candidate);
  const evidenceRefs = Array.isArray(candidate.evidenceRefs) && candidate.evidenceRefs.length
    ? candidate.evidenceRefs : (candidate.sourceRefs || []);
  const uncertainty = String(candidate.uncertainty || '').trim();
  host.innerHTML = `${hero}<div class="cognition-candidate-layout" data-recall-candidate-id="${escapeHtml(candidate.id)}">
    <article class="skills-cognition-card cognition-candidate-main">
      <div class="meta-line skills-cognition-meta">
        <span class="skills-cognition-status is-${escapeHtml(detailCapability.displayState)}">${escapeHtml(_recallCandidateStateLabel(detailCapability))}</span>
        <span>${escapeHtml(_abilityAssetCategoryLabel(candidate.suggestedType))}</span>
        ${candidate.risk ? `<span>${escapeHtml(_cognitionText(`cognition.candidate_risk_${candidate.risk}`, `风险：${candidate.risk}`))}</span>` : ''}
      </div>
      <h2>${escapeHtml(_abilityCandidateDisplayTitle(candidate))}</h2>
      <blockquote class="cognition-candidate-quote">${escapeHtml(candidate.judgment || '')}</blockquote>
      ${candidate.value ? `<p class="skills-cognition-meta">${escapeHtml(candidate.value)}</p>` : ''}
      ${detailCapability.canEdit ? `<label class="cognition-candidate-field"><span>${escapeHtml(_cognitionText('cognition.type', '类型'))}</span><select data-recall-edit-type>${typeOptions}</select></label>
      <label class="cognition-candidate-field"><span>${escapeHtml(_cognitionText('cognition.candidate_scope_label', '作用范围'))}</span><input data-recall-edit-scope value="${escapeHtml(candidate.suggestedScope || '')}" placeholder="${escapeHtml(_cognitionText('cognition.candidate_scope_placeholder', '例如：仅产品工作空间'))}"></label>
      <label class="cognition-candidate-field"><span>${escapeHtml(_cognitionText('cognition.summary', '摘要'))}</span><input data-recall-edit-summary value="${escapeHtml(candidate.summary || '')}"></label>
      <label class="cognition-candidate-field is-wide"><span>${escapeHtml(_cognitionText('cognition.judgment', '我的判断'))}</span><textarea data-recall-edit-judgment>${escapeHtml(candidate.judgment || '')}</textarea></label>
      <label class="cognition-candidate-field is-wide"><span>${escapeHtml(_cognitionText('cognition.evidence_refs', '证据引用'))}</span><textarea data-recall-edit-evidence>${escapeHtml((candidate.sourceRefs || []).map((ref) => `${ref.kind}:${ref.id}`).join('\n'))}</textarea></label>` : `<div class="cognition-candidate-field is-wide skills-cognition-meta"><span>${escapeHtml(_cognitionText('cognition.candidate_scope_label', '作用范围'))}</span><span>${escapeHtml(candidate.suggestedScope || '')}</span></div>
      ${candidate.summary ? `<div class="cognition-candidate-field is-wide skills-cognition-meta"><span>${escapeHtml(_cognitionText('cognition.summary', '摘要'))}</span><span>${escapeHtml(candidate.summary)}</span></div>` : ''}`}
      ${detailCapability.disabledReason ? `<p class="skills-cognition-meta cognition-candidate-blocked">${escapeHtml(_recallCandidateBlockedText(detailCapability.disabledReason))}</p>` : ''}
      <div class="skills-cognition-actions cognition-candidate-actions">
        ${detailCapability.canPromote ? `<button type="button" class="btn btn-sm btn-primary" data-recall-candidate-action="save-and-promote" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('cognition.candidate_confirm_scoped', '确认并限域'))}</button>` : ''}
        ${detailCapability.canDefer ? `<button type="button" class="btn btn-sm" data-recall-candidate-action="defer" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('cognition.status_deferred', '稍后'))}</button>` : ''}
        ${detailCapability.canReject ? `<button type="button" class="btn btn-sm btn-danger" data-recall-candidate-action="reject" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('cognition.candidate_reject', '拒绝'))}</button>` : ''}
        <button type="button" class="btn btn-sm btn-subtle" data-cognition-locate-candidate-capture="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('cognition.candidate_locate_capture', '这条是哪次沉淀产生的'))}</button>
      </div>
    </article>
    <aside class="skills-cognition-card cognition-candidate-side">
      <h3>${escapeHtml(_cognitionText('cognition.candidate_why_confirm', '为什么需要你确认'))}</h3>
      <ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>
      <h3>${escapeHtml(_cognitionText('cognition.candidate_evidence_basis', '来源依据'))}</h3>
      ${evidenceRefs.length
    ? `<div class="skills-cognition-ref-row">${_renderCognitionInlineRefs(evidenceRefs)}</div>`
    : `<p class="skills-cognition-meta">${escapeHtml(_cognitionText('cognition.candidate_no_evidence', '没有可追溯的证据引用；确认前建议先补证。'))}</p>`}
      ${uncertainty ? `<h3>${escapeHtml(_cognitionText('cognition.candidate_uncertainty', '尚不确定的部分'))}</h3><p class="skills-cognition-meta">${escapeHtml(uncertainty)}</p>` : ''}
    </aside>
  </div>`;
}

/**
 * 「认知树」：正式资产的成长投影，数据来自 `recall.tree.read`。
 *
 * 树只呈现资产节点——任务接续快照、Session、运行记录属于支撑对象，不长叶片。
 * 这条契约在 tree-service 就成立（节点类型只有 asset），渲染层不再另作判断，
 * 也不按会话量或 Token 数造出"成长"。
 *
 * 叶片深浅直接映射 `maturity`，不自己发明分级：
 *   seed / bud                → 已确认，效果尚未验证（浅）
 *   transfer_validated        → 已证明能被正确带走（浅，但已迈出一步）
 *   effectiveness_validated   → 真实复用并形成有效 Evidence（深）
 */
/**
 * 认知树的有机可视化（v0.9.1 原型 01）。
 *
 * **只画契约里真有的东西**（`CognitionTreeNode`：assetType / label / maturity /
 * version / status），三处刻意没有照搬原型：
 *
 *  1. **树上不画"芽"。** 原型在枝头画了 3 个橙色候选点，但候选不是资产，
 *     `CognitionTreeNodeId` 是 `asset:${string}`、`type` 恒为 `'asset'`，树里
 *     根本没有候选节点。要画就得让渲染层自己把候选摆上去——那是在图上编造一个
 *     后端不认的状态。候选的位置由图例说明（这是 G-8，等树契约 v2 的产品决策）。
 *  2. **树干不画版本年轮。** 原型树干上有个 "v3"。版本是**每个资产各自**的
 *     （`node.version`），不存在"这棵树的版本"，画一个就是凭空造一个聚合量。
 *     版本落在每片叶子的 tooltip 里。
 *  3. **空枝照画。** 四类是后端固定的 assetType，不是"有数据才存在的东西"。
 *     一根光秃的枝条如实表达"这一类你还没有"，藏掉则会让用户以为系统只有三类。
 *
 * 布局是**确定性**的：位置只由 assetType 和该类内的下标算出，不用随机、不用
 * 时间戳。否则每次重画叶子都会跳位置，用户会以为树变了。
 */
function _renderCognitionTreeCanvas(nodes) {
  // 四根主枝：起点挂在树干上，终点是枝尖。角度写死是为了确定性布局。
  const BRANCHES = [
    { type: 'personal', x1: 356, y1: 300, x2: 150, y2: 196, anchor: 'end' },
    { type: 'rule', x1: 364, y1: 306, x2: 574, y2: 208, anchor: 'start' },
    { type: 'template', x1: 356, y1: 232, x2: 198, y2: 96, anchor: 'end' },
    { type: 'skill_method', x1: 366, y1: 222, x2: 546, y2: 88, anchor: 'start' },
  ];
  const MAX_LEAVES = 9;
  const branches = BRANCHES.map((branch) => {
    const branchNodes = nodes.filter((node) => node.assetType === branch.type);
    const shown = branchNodes.slice(0, MAX_LEAVES);
    const limb = `<path d="M${branch.x1} ${branch.y1} Q${(branch.x1 + branch.x2) / 2} ${branch.y1 - 34} ${branch.x2} ${branch.y2}" stroke="#8a6547" stroke-width="9" fill="none" stroke-linecap="round"/>`;
    const leaves = shown.map((node, index) => {
      // 沿枝条 0.42→0.98 均匀分布，垂直方向交替偏移，避免叠在一条线上。
      const t = shown.length === 1 ? 0.72 : 0.42 + (0.56 * index) / (shown.length - 1);
      const cx = branch.x1 + (branch.x2 - branch.x1) * t;
      const cy = branch.y1 + (branch.y2 - branch.y1) * t - 12 * Math.sin(Math.PI * t);
      const offset = index % 2 === 0 ? -13 : 13;
      const deep = node.maturity === 'effectiveness_validated';
      const dimmed = node.status && node.status !== 'active';
      const assetId = String(node.id || '').replace(/^asset:/, '');
      const tip = [node.label || assetId, _abilityAssetMaturityLabel(node.maturity, node.status), node.version ? `v${node.version}` : '']
        .filter(Boolean).join(' · ');
      // 叶子可点（走既有 data-cognition-open-asset 委托），但**不可聚焦**：
      // SVG <g> 加 tabindex 会做出一个能 Tab 到、却按 Enter 没反应的焦点陷阱。
      // 键盘与读屏的完整入口是下面那组分类卡（真 <button>），信息不缺。
      return `<g class="cognition-tree-svg-leaf${deep ? ' is-deep' : ' is-light'}${dimmed ? ' is-dimmed' : ''}" data-cognition-open-asset="${escapeHtml(assetId)}">`
        + `<title>${escapeHtml(tip)}</title>`
        + `<ellipse cx="${cx.toFixed(1)}" cy="${(cy + offset).toFixed(1)}" rx="15" ry="8.5" transform="rotate(${offset < 0 ? -22 : 16} ${cx.toFixed(1)} ${(cy + offset).toFixed(1)})"/>`
        + '</g>';
    }).join('');
    // 超出的不省略计数：说"还有 N 片"比默默截断诚实，完整列表在下面的分类卡里。
    const overflow = branchNodes.length > MAX_LEAVES
      ? `<text x="${branch.x2}" y="${branch.y2 + 30}" text-anchor="${branch.anchor === 'end' ? 'start' : 'end'}" class="cognition-tree-svg-overflow">+${branchNodes.length - MAX_LEAVES}</text>`
      : '';
    const label = `<text x="${branch.x2 + (branch.anchor === 'end' ? -6 : 6)}" y="${branch.y2 - 14}" text-anchor="${branch.anchor}" class="cognition-tree-svg-label">${escapeHtml(_abilityAssetCategoryLabel(branch.type))} · ${branchNodes.length}</text>`;
    return limb + leaves + label + overflow;
  }).join('');
  return `<svg class="cognition-tree-svg" viewBox="0 0 720 400" role="img" aria-label="${escapeHtml(_cognitionText('cognition.tree_canvas_label', '认知树'))}">
    <ellipse cx="360" cy="372" rx="150" ry="15" class="cognition-tree-svg-ground"/>
    <path d="M352 366c10-62 6-104 12-152 6-42 16-72 32-106" stroke="#8a6547" stroke-width="26" fill="none" stroke-linecap="round"/>
    <path d="M350 366c-30 4-54 12-76 26M362 366c24 4 47 12 70 26" stroke="#a07c60" stroke-width="7" fill="none" stroke-linecap="round"/>
    ${branches}
  </svg>`;
}

function renderSkillsCognitionTree() {
  const host = document.getElementById('skills-cognition-tree-body');
  if (!host) return;
  const hero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.tree_eyebrow', eyebrow: 'COGNITION TREE',
    titleKey: 'cognition.tree_title', title: '一棵树，显示属于你的认知如何成长',
    hintKey: 'cognition.tree_page_hint', hint: '树只呈现正式资产的真实状态，不按会话量或 Token 数虚假生长。',
    backPage: 'assets', backKey: 'cognition.back_to_assets', back: '返回我的资产',
  });
  const tree = _skillsCognitionState.tree;
  if (tree?.error) {
    host.innerHTML = `${hero}<div class="skills-cognition-warning"><span>${escapeHtml(tree.error)}</span><button class="btn btn-sm" data-cognition-tree-reload>${escapeHtml(_cognitionText('common.retry', '重试'))}</button></div>`;
    return;
  }
  if (!tree || tree.loading) {
    host.innerHTML = `${hero}<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;
    return;
  }
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const edges = Array.isArray(tree.edges) ? tree.edges : [];
  // 候选是"芽"：它们还不是资产，所以不在树的节点里，但图例要说清它们的位置，
  // 否则用户会以为待确认的东西凭空消失了。
  const budCount = (Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [])
    .filter((candidate) => _recallCandidateCapabilities(candidate).countsAsPending).length;
  if (!nodes.length) {
    host.innerHTML = `${hero}<div class="skills-cognition-empty cognition-task-empty"><strong>${escapeHtml(_cognitionText('cognition.tree_empty', '树上还没有叶片'))}</strong><span>${escapeHtml(_cognitionText('cognition.tree_empty_hint', '候选被确认为正式资产后才会长出叶片；当前还没有已确认的资产。'))}</span></div>`;
    return;
  }
  const deep = nodes.filter((node) => node.maturity === 'effectiveness_validated');
  const light = nodes.filter((node) => node.maturity !== 'effectiveness_validated');
  const relationLabel = (kind) => _cognitionText(`cognition.tree_relation_${kind}`, ({
    refines: '细化自', depends_on: '依赖', replaces: '取代', conflicts_with: '与之冲突', related_to: '相关',
  })[kind] || kind);
  const labelById = new Map(nodes.map((node) => [node.id, node.label]));
  const branches = ['personal', 'rule', 'template', 'skill_method'].map((assetType) => {
    const branchNodes = nodes.filter((node) => node.assetType === assetType);
    if (!branchNodes.length) return '';
    const leaves = branchNodes.map((node) => {
      const isDeep = node.maturity === 'effectiveness_validated';
      const assetId = String(node.id || '').replace(/^asset:/, '');
      return `<button type="button" class="cognition-tree-leaf${isDeep ? ' is-deep' : ' is-light'}" data-cognition-open-asset="${escapeHtml(assetId)}" title="${escapeHtml(_abilityAssetMaturityLabel(node.maturity, node.status))}">
        <span class="cognition-tree-dot" aria-hidden="true"></span>
        <span class="cognition-tree-leaf-body"><strong>${escapeHtml(node.label || assetId)}</strong><small>${escapeHtml([_abilityAssetMaturityLabel(node.maturity, node.status), node.version ? `v${node.version}` : ''].filter(Boolean).join(' · '))}</small></span>
      </button>`;
    }).join('');
    return `<section class="skills-cognition-card cognition-tree-branch">
      <div class="cognition-tree-branch-head"><strong>${escapeHtml(_abilityAssetCategoryLabel(assetType))}</strong><b>${escapeHtml(String(branchNodes.length))}</b></div>
      <div class="cognition-tree-leaves">${leaves}</div>
    </section>`;
  }).join('');
  // 关系只在有边时才出现。空的关系区会让用户以为系统还没算完。
  const relations = edges.length
    ? `<section class="skills-cognition-card cognition-tree-relations">
        <div class="cognition-tree-branch-head"><strong>${escapeHtml(_cognitionText('cognition.tree_relations', '资产之间的关系'))}</strong><b>${escapeHtml(String(edges.length))}</b></div>
        ${edges.slice(0, 30).map((edge) => `<div class="cognition-tree-relation"><span>${escapeHtml(labelById.get(edge.from) || edge.from)}</span><i aria-hidden="true">→</i><em>${escapeHtml(relationLabel(edge.kind))}</em><i aria-hidden="true">→</i><span>${escapeHtml(labelById.get(edge.to) || edge.to)}</span></div>`).join('')}
      </section>`
    : '';
  const legend = `<aside class="skills-cognition-card cognition-tree-legend">
    <div><strong>${escapeHtml(_cognitionText('cognition.tree_growth', '当前成长'))}</strong><p class="panel-sub">${escapeHtml(_cognitionText('cognition.tree_growth_hint', '{deep} 片叶已完成效果验证，{light} 片仍在等待真实复用。')
    .replace('{deep}', String(deep.length)).replace('{light}', String(light.length)))}</p></div>
    <div class="cognition-tree-legend-row"><span class="cognition-tree-dot is-bud" aria-hidden="true"></span><div><strong>${escapeHtml(_cognitionText('cognition.tree_legend_bud', '待确认芽点'))}</strong><span>${escapeHtml(_cognitionText('cognition.tree_legend_bud_hint', '候选尚未成为正式资产，因此不在树上。').concat(budCount ? ` (${budCount})` : ''))}</span></div></div>
    <div class="cognition-tree-legend-row"><span class="cognition-tree-dot is-light" aria-hidden="true"></span><div><strong>${escapeHtml(_cognitionText('cognition.tree_legend_light', '浅色叶片'))}</strong><span>${escapeHtml(_cognitionText('cognition.tree_legend_light_hint', '你已确认，但使用效果尚未验证。'))}</span></div></div>
    <div class="cognition-tree-legend-row"><span class="cognition-tree-dot is-deep" aria-hidden="true"></span><div><strong>${escapeHtml(_cognitionText('cognition.tree_legend_deep', '深色叶片'))}</strong><span>${escapeHtml(_cognitionText('cognition.tree_legend_deep_hint', '已在真实任务中复用并形成有效 Evidence。'))}</span></div></div>
    <div class="cognition-tree-legend-row"><span class="cognition-tree-dot is-none" aria-hidden="true"></span><div><strong>${escapeHtml(_cognitionText('cognition.tree_legend_nonasset', '任务状态不长叶'))}</strong><span>${escapeHtml(_cognitionText('cognition.tree_legend_nonasset_hint', '接续快照、Session 与运行记录属于支撑对象。'))}</span></div></div>
    <button type="button" class="btn btn-sm" data-cognition-page-link="nonasset">${escapeHtml(_cognitionText('cognition.tree_open_nonasset', '查看非资产分流'))}</button>
  </aside>`;
  // SVG 是概览，下面的分类卡是完整可点列表——两者都保留。只留图的话，叶子多了
  // 就点不准也读不全；只留卡片则回不到"这是一棵树"的整体感。
  const canvas = `<section class="skills-cognition-card cognition-tree-figure">${_renderCognitionTreeCanvas(nodes)}</section>`;
  host.innerHTML = `${hero}<div class="cognition-tree-layout"><div class="cognition-tree-canvas">${canvas}${branches}${relations}</div>${legend}</div>`;
}

/**
 * 是否处于「一件东西都没有」的首启状态。
 *
 * 判据取全部五类真实读模型：正式资产、候选、沉淀任务、教学信号、待办。任何一类
 * 非空都不是首启——用户已经在系统里留下过东西，该看到的是那一类自己的空态
 * （「本页暂无待确认」和「你还没开始用」是两句不同的话）。
 *
 * **读取失败不算空账户**，与 `_cognitionInboxIsEmpty` 同一条纪律：把一次读盘
 * 失败显示成"你什么都没有"，用户会以为资产丢了。快照还没落地时同理不算。
 */
function _cognitionIsFirstRun() {
  if (!_skillsCognitionState.loadedAt) return false;
  if ((Array.isArray(_skillsCognitionState.loadErrors) ? _skillsCognitionState.loadErrors : []).length) return false;
  const nonEmpty = (value) => Array.isArray(value) && value.length > 0;
  if (nonEmpty(_skillsCognitionState.assets)) return false;
  if (nonEmpty(_skillsCognitionState.recallCandidates)) return false;
  if (nonEmpty(_skillsCognitionState.captures)) return false;
  if (nonEmpty(_skillsCognitionState.recentCaptures)) return false;
  if (nonEmpty(_skillsCognitionState.teachingSignals)) return false;
  if (nonEmpty(_skillsCognitionState.inboxItems)) return false;
  // 处理过东西就不是首启——哪怕现在手里是空的。用户可能把候选全拒了、或把
  // 资产都删了，那也是"用过"，再给一句"你的认知种子已经准备好"是错的。
  // 历史还没读回来时（null / loading）不据此判断，避免首屏闪一下引导页。
  const history = _skillsCognitionState.reviewHistory;
  if (history && !history.loading && !history.error && Number(history.total) > 0) return false;
  return true;
}

/**
 * 「空种子」首启引导（原型 02）。
 *
 * **不是独立页**：G-9 定下"默认永远停在待我处理、不自动跳页"之后，它作为
 * 「待我处理」空态的首启变体渲染（一件东西都没有时）。曾短暂存在过一个独立的
 * `seed` 页，落地不再跳转后它就没有入口了——留着就是死路由，已删除。
 *
 * 两个入口都落在**真实能力**上，不照搬原型的措辞：
 *   - 「选择历史会话」→ 沉淀活动页的历史会话选择器，真实通道
 *     `recall.captures.historicalAutoStart`。
 *   - 「去开始一次任务」→ 侧栏既有的新建任务入口。
 *
 * 原型 02 的主按钮写的是「继续最近任务」。**没有做**：认知资产侧没有"最近任务"
 * 这个读模型，要么去翻会话列表（跨模块），要么编一个。给一个指不准地方的按钮
 * 比少一个按钮更糟。
 */
function _cognitionSeedMarkup() {
  return `<div class="cognition-seed-wrap">
    <div class="cognition-seed-art" aria-hidden="true"><span class="cognition-seed-soil"></span><span class="cognition-seed-core"></span><span class="cognition-seed-sprout"></span></div>
    <span class="cognition-task-eyebrow">${escapeHtml(_cognitionText('cognition.seed_eyebrow', 'YOUR FIRST SEED'))}</span>
    <h2>${escapeHtml(_cognitionText('cognition.seed_title', '你的认知种子已经准备好'))}</h2>
    <p>${escapeHtml(_cognitionText('cognition.seed_hint', '从一次真实工作开始。系统会先带着当前任务状态接续工作，再把真正稳定、值得复用的内容整理成候选；未经你确认，不会写入正式资产。'))}</p>
    <div class="skills-cognition-actions cognition-seed-actions">
      <button type="button" class="btn btn-primary" data-cognition-page-link="captures">${escapeHtml(_cognitionText('cognition.seed_pick_history', '选择历史会话'))}</button>
      <button type="button" class="btn" data-cognition-seed-new-task>${escapeHtml(_cognitionText('cognition.seed_new_task', '去开始一次任务'))}</button>
    </div>
    <p class="skills-cognition-meta">${escapeHtml(_cognitionText('cognition.seed_note', '无需先创建角色或理解本体。第一片叶子只在你确认一项正式资产之后出现。'))}</p>
  </div>`;
}


/**
 * 「非资产分流」：任务状态被带走，但不会被误当成长期能力。
 *
 * 分流链路是产品契约；快照本体（goal / stage / constraints / latestArtifact /
 * nextStep）来自 `recall.continuation.list`，一条不编。
 *
 * `usable=false` 的快照照样列出来并标注：那是导入摘要还没被蒸馏成真正的任务
 * 理解，属于既成事实。藏掉它会让用户以为这次导入压根没生成接续状态。
 */
function renderSkillsCognitionNonAsset() {
  const host = document.getElementById('skills-cognition-nonasset-body');
  if (!host) return;
  const hero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.nonasset_eyebrow', eyebrow: 'NON-ASSET ROUTING',
    titleKey: 'cognition.nonasset_title', title: '任务状态被带走，但不会被误当成长期能力',
    hintKey: 'cognition.nonasset_hint', hint: '当前进度、待办、临时约束和最新产物进入任务接续快照，不进入四类资产和认知树。',
    backPage: 'tree', backKey: 'cognition.back_to_tree', back: '返回认知树',
  });
  const steps = [
    ['cognition.nonasset_step_source', '来源', 'cognition.nonasset_step_source_desc', '会话、文件与执行记录'],
    ['cognition.nonasset_step_detect', '识别', 'cognition.nonasset_step_detect_desc', '发现内容属于当前任务状态'],
    ['cognition.nonasset_step_route', '分流', 'cognition.nonasset_step_route_desc', '生成任务接续快照'],
    ['cognition.nonasset_step_ref', '空间引用', 'cognition.nonasset_step_ref_desc', '保存目标、阶段与下一步'],
    ['cognition.nonasset_step_resume', '新会话接续', 'cognition.nonasset_step_resume_desc', '按最小上下文投影使用'],
  ].map(([key, title, descKey, desc], index) => `<div class="cognition-nonasset-step"><strong>${escapeHtml(_cognitionText(key, title))}</strong><span>${escapeHtml(_cognitionText(descKey, desc))}</span></div>${index < 4 ? '<i class="cognition-pipeline-arrow" aria-hidden="true">→</i>' : ''}`).join('');
  const outcomes = [
    ['cognition.nonasset_outcome_count', '不增加四类资产数量。'],
    ['cognition.nonasset_outcome_leaf', '不生成认知树叶片。'],
    ['cognition.nonasset_outcome_scope', '只在目标空间和已授权会话中使用。'],
    ['cognition.nonasset_outcome_expiry', '到期后可更新或失效。'],
  ].map(([key, text]) => `<li>${escapeHtml(_cognitionText(key, text))}</li>`).join('');
  const state = _skillsCognitionState.continuation;
  const selectedId = _skillsCognitionState.selectedContinuationId || '';
  let snapshotBody;
  if (!state || state.loading) {
    snapshotBody = `<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;
  } else if (state.error) {
    snapshotBody = `<div class="skills-cognition-warning"><span>${escapeHtml(state.error)}</span><button type="button" class="btn btn-sm" data-cognition-continuation-reload>${escapeHtml(_cognitionText('common.retry', '重试'))}</button></div>`;
  } else if (!state.items.length) {
    snapshotBody = `<div class="skills-cognition-empty"><strong>${escapeHtml(_cognitionText('cognition.nonasset_empty', '还没有任务接续快照'))}</strong><span>${escapeHtml(_cognitionText('cognition.nonasset_empty_hint', '导入一次历史会话后，它的目标、阶段与下一步会在这里出现，并可被新会话接续。'))}</span></div>`;
  } else {
    // 截断说明单独一行：`total` 是事实条数，`items.length` 只是这次显示了几条。
    const truncated = state.total > state.items.length
      ? `<p class="skills-cognition-meta">${escapeHtml(_cognitionText('cognition.nonasset_truncated', '共 {total} 条，显示最近 {shown} 条。')
        .replace('{total}', String(state.total)).replace('{shown}', String(state.items.length)))}</p>`
      : '';
    snapshotBody = state.items.map((ref) => {
      const snapshot = ref.snapshot || {};
      const open = ref.conversationId === selectedId;
      // 只渲染快照真实握有的字段。没有 updatedAt 就说"生成于"，不拿 createdAt
      // 冒充更新时间。
      const facts = [
        ['cognition.nonasset_field_stage', '当前阶段', snapshot.stage],
        ['cognition.nonasset_field_next', '下一步', snapshot.nextStep],
        ['cognition.nonasset_field_artifact', '最新产物', snapshot.latestArtifact],
      ].filter(([, , value]) => value)
        .map(([key, fallback, value]) => `<div><dt>${escapeHtml(_cognitionText(key, fallback))}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join('');
      const constraints = Array.isArray(snapshot.constraints) && snapshot.constraints.length
        ? `<div class="skills-cognition-detail-block"><strong>${escapeHtml(_cognitionText('cognition.nonasset_field_constraints', '临时约束'))}</strong><ul>${snapshot.constraints.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('')}</ul></div>`
        : '';
      const scope = [
        ref.projectId ? _cognitionText('cognition.nonasset_scope_project', '项目 {id}').replace('{id}', ref.projectId) : '',
        ref.spaceId ? _cognitionText('cognition.nonasset_scope_space', '空间 {id}').replace('{id}', ref.spaceId) : '',
      ].filter(Boolean).join(' · ');
      return `<article class="skills-cognition-card cognition-nonasset-snapshot${open ? ' is-open' : ''}">
        <button type="button" class="cognition-tree-branch-head" data-cognition-continuation-open="${escapeHtml(ref.conversationId)}" aria-expanded="${open ? 'true' : 'false'}">
          <strong>${escapeHtml(ref.conversationTitle || ref.conversationId)}</strong>
          <span class="skills-cognition-status is-pending">${escapeHtml(_cognitionText('cognition.nonasset_badge', '非资产'))}</span>
        </button>
        <p class="skills-cognition-meta">${escapeHtml([
        _cognitionText('cognition.nonasset_created_at', '生成于 {at}').replace('{at}', _cognitionDate(snapshot.createdAt)),
        scope,
        ref.usable ? '' : _cognitionText('cognition.nonasset_not_distilled', '目标尚未蒸馏，接续时会退回原始摘要'),
      ].filter(Boolean).join(' · '))}</p>
        ${snapshot.goal ? `<p>${escapeHtml(String(snapshot.goal))}</p>` : ''}
        ${open ? `<dl class="cognition-governance-facts">${facts}</dl>${constraints}` : ''}
      </article>`;
    }).join('') + truncated;
  }
  host.innerHTML = `${hero}
    <section class="skills-cognition-flow-band cognition-nonasset-route"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.nonasset_route', '分流链路'))}</h2><span>${escapeHtml(_cognitionText('cognition.nonasset_route_hint', '这条链路不经过四类资产，也不写认知树'))}</span></div><div class="cognition-nonasset-steps">${steps}</div></section>
    <div class="cognition-nonasset-layout">
      <article class="skills-cognition-card">
        <div class="cognition-tree-branch-head"><strong>${escapeHtml(_cognitionText('cognition.nonasset_snapshots', '任务接续快照'))}</strong>${state && !state.loading && !state.error ? `<b>${escapeHtml(String(state.total))}</b>` : ''}</div>
        ${snapshotBody}
      </article>
      <aside class="skills-cognition-card cognition-candidate-side">
        <h3>${escapeHtml(_cognitionText('cognition.nonasset_outcomes', '分流结果'))}</h3>
        <ul>${outcomes}</ul>
      </aside>
    </div>`;
}

/**
 * 「Skill 更新候选」：系统主动提出更新，用户只决定是否接受。
 *
 * 能给真事实的部分照给：当前版本、回滚点、影响到的空间数、待决候选数，全部
 * 来自 `cognition.skills.summary` 与 `recall.workspaceRefs.list`。
 *
 * The Recall draft owns the real diff and the explicit accept/defer/reject
 * decisions. Candidate projections remain read-only here, so the page never
 * fabricates an update body or mutates a Skill outside the versioned flow.
 */
function renderSkillsCognitionSkillUpdate() {
  const host = document.getElementById('skills-cognition-skillupdate-body');
  if (!host) return;
  const hero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.skillupdate_eyebrow', eyebrow: 'SKILL UPDATE',
    titleKey: 'cognition.skillupdate_title', title: '系统提出更新，你只决定是否接受',
    hintKey: 'cognition.skillupdate_hint', hint: '显示版本、依据、影响与回滚点；不会因为一次异常静默改写 Skill。',
    backPage: 'governance', backKey: 'cognition.back_to_governance', back: '返回版本与治理',
  });
  const summary = _skillsCognitionState.skillUpdate;
  if (summary?.error) {
    host.innerHTML = `${hero}<div class="skills-cognition-warning"><span>${escapeHtml(summary.error)}</span></div>`;
    return;
  }
  if (!summary || summary.loading) {
    host.innerHTML = `${hero}<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;
    return;
  }
  const asset = (Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [])
    .find((item) => item.id === summary.assetId);
  const versions = Array.isArray(summary.versions) ? summary.versions : [];
  const rollbackPoints = versions.filter((version) => version.canRollback).map((version) => `v${version.version}`);
  const workspaceRefs = Array.isArray(summary.workspaceRefs) ? summary.workspaceRefs : [];
  const facts = [
    ['cognition.skillupdate_current', '当前版本', summary.version ? `v${summary.version}` : '—'],
    ['cognition.skillupdate_pending', '待决候选', String(summary.pendingCandidateCount ?? 0)],
    ['cognition.skillupdate_spaces', '影响空间', String(workspaceRefs.length)],
  ].map(([key, fallback, value]) => `<div><dt>${escapeHtml(_cognitionText(key, fallback))}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  // 回滚点不只是一行说明：`cognition.skills.rollback` 是真实通道，所以每个可
  // 回滚的版本直接给按钮。列出退路却不能走，等于告诉用户"你有退路"然后让他
  // 自己去别处找门。
  const rollbackCandidates = versions.filter((version) => version.canRollback && String(version.version || '') !== String(summary.version || ''));
  const rollbackHtml = rollbackCandidates.length
    ? rollbackCandidates.map((version) => `<button type="button" class="btn btn-sm" data-cognition-skill-rollback="${escapeHtml(summary.skillId || '')}" data-cognition-skill-version="${escapeHtml(String(version.version || ''))}">${escapeHtml(_cognitionText('cognition.skillupdate_rollback_to', '回滚到 v{v}').replace('{v}', String(version.version || '')))}</button>`).join('')
    : `<span class="skills-cognition-meta">${escapeHtml(_cognitionText('cognition.skillupdate_impact_no_rollback', '当前没有可回滚的历史版本。'))}</span>`;
  const draft = summary.draft && summary.draft.status !== 'failed' ? summary.draft : null;
  const diff = draft?.diff;
  const pendingNote = _cognitionText('cognition.skillupdate_diff_pending', '升级草稿尚未生成，稍后重试即可。');
  const acceptNote = draft?.draftHash ? '' : _cognitionText('cognition.skillupdate_accept_pending', '需要先生成升级草稿。');
  const decision = draft?.reviewDecision || 'pending';
  const decisionButtons = draft?.draftHash
    ? `<button type="button" class="btn btn-sm btn-primary" data-cognition-skill-decision="accept" data-cognition-skill-asset="${escapeHtml(summary.assetId || '')}" data-cognition-skill-draft-hash="${escapeHtml(draft.draftHash)}">${escapeHtml(_cognitionText('cognition.skillupdate_accept', '接受升级'))}</button><button type="button" class="btn btn-sm" data-cognition-skill-decision="defer" data-cognition-skill-asset="${escapeHtml(summary.assetId || '')}" data-cognition-skill-draft-hash="${escapeHtml(draft.draftHash)}">${escapeHtml(_cognitionText('cognition.skillupdate_defer', '暂缓'))}</button><button type="button" class="btn btn-sm" data-cognition-skill-decision="reject" data-cognition-skill-asset="${escapeHtml(summary.assetId || '')}" data-cognition-skill-draft-hash="${escapeHtml(draft.draftHash)}">${escapeHtml(_cognitionText('cognition.skillupdate_reject', '拒绝本次升级'))}</button>`
    : '';
  host.innerHTML = `${hero}<div class="cognition-candidate-layout">
    <article class="skills-cognition-card cognition-candidate-main">
      <div class="cognition-tree-branch-head"><strong>${escapeHtml(asset ? _abilityAssetDisplayTitle(asset) : (summary.skillId || ''))}</strong><span class="skills-cognition-status is-pending">${escapeHtml(_cognitionText('cognition.skillupdate_awaiting', '待决定'))}</span></div>
      <dl class="cognition-governance-facts">${facts}</dl>
      <div class="skills-cognition-detail-block"><strong>${escapeHtml(_cognitionText('cognition.skillupdate_changes', '本次改动'))}</strong>${diff ? _renderSkillTreeDiff(diff) : `<div class="skills-cognition-empty">${escapeHtml(pendingNote)}</div>`}</div>
      <div class="skills-cognition-detail-block">
        <strong>${escapeHtml(_cognitionText('cognition.skillupdate_rollback', '回滚点'))}</strong>
        <div class="skills-cognition-actions">${rollbackHtml}</div>
      </div>
      <div class="skills-cognition-actions">
        ${decisionButtons || `<span class="skills-cognition-meta">${escapeHtml(acceptNote)}</span>`}
        <button type="button" class="btn btn-sm" data-cognition-page-link="governance">${escapeHtml(_cognitionText('cognition.candidate_keep_current', '保持当前版本'))}</button>
      </div>
      <p class="skills-cognition-meta">${escapeHtml(decision === 'pending' ? _cognitionText('cognition.skillupdate_awaiting', '待决定') : decision)}</p>
    </article>
    <aside class="skills-cognition-card cognition-candidate-side">
      <h3>${escapeHtml(_cognitionText('cognition.skillupdate_impact', '影响预览'))}</h3>
      <ul>
        <li>${escapeHtml(_cognitionText('cognition.skillupdate_impact_spaces', '影响 {n} 个引用空间。').replace('{n}', String(workspaceRefs.length)))}</li>
        <li>${escapeHtml(_cognitionText('cognition.skillupdate_impact_next', '接受后，下次匹配任务默认使用新版本。'))}</li>
        <li>${escapeHtml(rollbackPoints.length
    ? _cognitionText('cognition.skillupdate_impact_rollback', '旧版本 {v} 保留为回滚点。').replace('{v}', rollbackPoints.join('、'))
    : _cognitionText('cognition.skillupdate_impact_no_rollback', '当前没有可回滚的历史版本。'))}</li>
        <li>${escapeHtml(_cognitionText('cognition.skillupdate_impact_history', '不会修改历史结果。'))}</li>
      </ul>
    </aside>
  </div>`;
}

/**
 * 当前状态下允许的治理动作（规范 22.1）。
 *
 * 按状态生成而不是全部列出再逐个禁用：一个点不动的「恢复」不会告诉用户为什么
 * 点不动，不如不给。彻底清除后只剩版本入口——墓碑没有内容可治理，其余动作在
 * 服务端也会被 assertNotPurged 挡掉，摆出来只会让人以为还能操作。
 */
function _recallAssetActions(status) {
  // 彻底清除后仍留「使用与证明」：墓碑没有内容可治理，但它过去被谁带走过、
  // 用过几次是既成事实，回执还在，不该跟着内容一起消失。
  if (status === 'purged') return ['versions', 'chain'];
  const actions = [];
  if (status === 'active') actions.push('pause');
  if (status === 'paused') actions.push('resume');
  if (status === 'active' || status === 'paused') actions.push('archive');
  if (status === 'archived' || status === 'deleted') actions.push('restore');
  if (status !== 'deleted' && status !== 'revoked') actions.push('delete');
  if (status !== 'revoked') actions.push('revoke');
  actions.push('purge', 'versions', 'chain');
  return actions;
}

function _recallAssetActionLabel(action) {
  const labels = {
    pause: _cognitionText('cognition.asset_action_pause', '暂停使用'),
    resume: _cognitionText('cognition.asset_action_resume', '恢复使用'),
    archive: _cognitionText('cognition.asset_action_archive', '归档'),
    restore: _cognitionText('cognition.asset_action_restore', '恢复'),
    delete: _cognitionText('cognition.asset_action_delete', '删除'),
    purge: _cognitionText('cognition.asset_action_purge', '彻底清除'),
    revoke: _cognitionText('cognition.asset_action_revoke', '撤回使用'),
    versions: _cognitionText('cognition.asset_action_versions', '查看版本'),
    chain: _cognitionText('cognition.asset_action_chain', '使用与证明'),
  };
  return labels[action] || action;
}

/** 履历五段的用户层命名。刻意不叫 pack / receipt——那是实现名。 */
function _cognitionChainStageLabel(stage) {
  const labels = {
    formation: _cognitionText('cognition.chain_stage_formation', '从哪来'),
    settling: _cognitionText('cognition.chain_stage_settling', '成了什么'),
    inheritance: _cognitionText('cognition.chain_stage_inheritance', '谁带着它'),
    use: _cognitionText('cognition.chain_stage_use', '真用过几次'),
    evidence: _cognitionText('cognition.chain_stage_evidence', '哪几次没用上'),
  };
  return labels[stage] || stage;
}

/** 某次没带上的原因。后端给的是机器码，这里翻成人话。
 *
 *  取值来自 WithheldReason（选择层）加上渲染侧的两个：needs_confirmation、
 *  truncated。注意与 Agent 详情页那套 InheritanceExclusionReason 不是一回事——
 *  那个说的是「出生时没带走」，这个说的是「某一次运行没带上」。 */
function _cognitionWithheldReasonLabel(reason) {
  const labels = {
    scope_agent_not_allowed: _cognitionText('cognition.withheld_scope_agent', '这个智能体不在允许范围内'),
    scope_role_not_allowed: _cognitionText('cognition.withheld_scope_role', '这个角色不在允许范围内'),
    scope_project_not_allowed: _cognitionText('cognition.withheld_scope_project', '这个项目不在允许范围内'),
    scope_workspace_not_allowed: _cognitionText('cognition.withheld_scope_workspace', '这个空间不在允许范围内'),
    sensitivity_above_destination: _cognitionText('cognition.withheld_sensitivity_high', '敏感级高于这次允许的上限'),
    sensitivity_unclassified: _cognitionText('cognition.withheld_sensitivity_unknown', '还没分过敏感级，这次不敢默认放行'),
    asset_paused: _cognitionText('cognition.withheld_paused', '当时已暂停'),
    asset_archived: _cognitionText('cognition.withheld_archived', '当时已归档'),
    asset_revoked: _cognitionText('cognition.withheld_revoked', '当时已撤销'),
    asset_deleted: _cognitionText('cognition.withheld_deleted', '当时已删除'),
    asset_purged: _cognitionText('cognition.withheld_purged', '当时已彻底清除'),
    use_policy_never: _cognitionText('cognition.withheld_maturity', '成熟度还不够默认带入'),
    asset_missing: _cognitionText('cognition.withheld_missing', '当时读不到这条资产'),
    content_changed: _cognitionText('cognition.withheld_content_changed', '内容和继承时那份对不上了'),
    version_changed: _cognitionText('cognition.withheld_version_changed', '版本和继承时那版对不上了'),
    needs_confirmation: _cognitionText('cognition.withheld_needs_confirmation', '跨作用域，等你确认'),
    truncated: _cognitionText('cognition.withheld_truncated', '这次篇幅放不下'),
    unknown: _cognitionText('cognition.withheld_unknown', '没有记录原因'),
  };
  return labels[reason] || reason;
}

/** 迁移证明的状态：它只说明「有没有真的被带过去用上」，不说明用了好不好。 */
function _transferProofLabel(status) {
  const labels = {
    prepared: _cognitionText('cognition.proof_transfer_prepared', '已准备，还没回执'),
    succeeded: _cognitionText('cognition.proof_transfer_succeeded', '确实被带过去用了'),
    degraded: _cognitionText('cognition.proof_transfer_degraded', '带过去了，但过程降级'),
    rejected: _cognitionText('cognition.proof_transfer_rejected', '这次迁移被拒'),
  };
  return labels[status] || status;
}

/** 效果结论。**worse 与 no_improvement 也是证明**——证明它没帮上忙。
 *  只显示 better 会把「证明」变成宣传：一条被证明有害的资产会和一条从没被
 *  评价过的资产在界面上长得一样。 */
function _effectivenessProofLabel(outcome) {
  const labels = {
    better: _cognitionText('cognition.proof_outcome_better', '用了之后确实更好'),
    no_improvement: _cognitionText('cognition.proof_outcome_no_improvement', '用了没什么差别'),
    worse: _cognitionText('cognition.proof_outcome_worse', '用了反而更差'),
    insufficient_evidence: _cognitionText('cognition.proof_outcome_insufficient', '证据不足，下不了结论'),
    invalid: _cognitionText('cognition.proof_outcome_invalid', '这次评价本身作废'),
    rework: _cognitionText('cognition.proof_outcome_rework', '需要返工'),
  };
  return labels[outcome] || outcome;
}

/**
 * 「使用与证明」：这条认知从哪来、进过哪些智能体、真用过几次、哪几次没用上为什么。
 *
 * **这是履历，不是进度条。** 五段里 `not_yet` 表示「还没发生」，不是「欠着一步」
 * ——所以它渲染成中性的 is-not-yet，不能是红色或警告色。一条只在两个智能体里
 * 躺着、还没被任务带入的认知，不是「五步只走了三步」，它就是一条还没被用过的
 * 认知。这两种说法给用户的暗示完全不同。
 */
function _renderRecallAssetChain(assetId) {
  if (_skillsCognitionState.visibleAssetChainId !== assetId) return '';
  const state = _skillsCognitionState.assetChainById?.[assetId];
  const closeLabel = _cognitionText('common.close', '关闭');
  const closeIcon = typeof uiIconHtml === 'function' ? uiIconHtml('x') : '<span aria-hidden="true">×</span>';
  let body = `<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;

  if (state?.error) {
    body = `<div class="skills-cognition-error">${escapeHtml(state.error)}</div>`;
  } else if (state && !state.loading) {
    const chain = state.chain || {};
    const segments = Array.isArray(chain.segments) ? chain.segments : [];
    const withheld = Array.isArray(chain.withheld) ? chain.withheld : [];
    const usage = Array.isArray(state.usage) ? state.usage : [];

    const segmentsHtml = segments.map((segment) => {
      const happened = segment.status === 'happened';
      return `<div class="cognition-chain-segment is-${happened ? 'happened' : 'not-yet'}">
        <span class="cognition-chain-stage">${escapeHtml(_cognitionChainStageLabel(segment.stage))}</span>
        <p class="cognition-chain-detail">${escapeHtml(segment.detail || '')}</p>
        ${segment.at ? `<small>${escapeHtml(_cognitionDate(segment.at))}</small>` : ''}
      </div>`;
    }).join('');

    const agents = Array.isArray(chain.carriedByAgentIds) ? chain.carriedByAgentIds : [];
    const carriedHtml = agents.length
      ? `<div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.chain_carried_by', '带着它的智能体'))}</strong><p>${escapeHtml(agents.join('、'))}</p></div>`
      : '';

    // 未带入原因单独成块：用户问「为什么这次没用我这条」时，答案必须是具体原因。
    const withheldHtml = withheld.length
      ? `<div class="cognition-chain-withheld"><strong>${escapeHtml(_cognitionText('cognition.chain_withheld', '没带上的那几次'))}</strong>${
        withheld.map((entry) => `<div class="cognition-chain-withheld-row"><span>${escapeHtml(_cognitionWithheldReasonLabel(entry.reason))}</span><small>${escapeHtml(_cognitionDate(entry.at))}</small></div>`).join('')
      }</div>`
      : '';

    // 跨作用域授权：用户在履历上看到「等你确认」，确认的按钮就该在这里。
    // 没有这个入口，confirm 档等于承诺了一个不存在的动作。
    const asset = _skillsCognitionState.assets?.find((item) => item.id === assetId);
    const crossScopeConfirmed = !!asset?.crossScopeConfirmedAt;
    const waitingConfirmation = withheld.some((entry) => entry.reason === 'needs_confirmation');
    const crossScopeHtml = (crossScopeConfirmed || waitingConfirmation)
      ? `<div class="reference-strip cognition-chain-cross-scope"><div><strong>${escapeHtml(_cognitionText('cognition.cross_scope', '跨作用域使用'))}</strong><p>${escapeHtml(crossScopeConfirmed
        ? _cognitionText('cognition.cross_scope_confirmed', '你已允许这条认知在其他作用域使用。')
        : _cognitionText('cognition.cross_scope_waiting', '这条认知被带到了它作用域之外，需要你确认才会带入。'))}</p></div><button type="button" class="btn btn-sm${crossScopeConfirmed ? '' : ' btn-primary'}" data-recall-cross-scope="${escapeHtml(assetId)}" data-recall-cross-scope-next="${crossScopeConfirmed ? '0' : '1'}">${escapeHtml(crossScopeConfirmed
        ? _cognitionText('cognition.cross_scope_withdraw', '撤回许可')
        : _cognitionText('cognition.cross_scope_confirm', '允许跨作用域使用'))}</button></div>`
      : '';

    const usageHtml = usage.length
      ? `<div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.chain_usage', '使用记录'))}</strong><p>${escapeHtml(
        _cognitionText('cognition.chain_usage_count', '共 {n} 条').replace('{n}', String(usage.length)),
      )}</p></div>`
      : '';

    // 证明：迁移与效果分两层显示，不合并成一个「已验证」。没有证明就说没有，
    // 不留空白——「还没被证明过」本身是个结论，比什么都不说清楚。
    const proofs = Array.isArray(state.proofs) ? state.proofs : [];
    const proofRows = proofs.map((entry) => {
      const effects = (entry.effectiveness || []).map((e) => (
        `<div class="cognition-proof-outcome is-${escapeHtml(e.outcome)}"><span>${escapeHtml(_effectivenessProofLabel(e.outcome))}</span><small>${escapeHtml(_cognitionDate(e.createdAt))}</small></div>`
      )).join('') || `<div class="cognition-proof-outcome is-none"><span>${escapeHtml(_cognitionText('cognition.proof_not_evaluated', '这次迁移还没有人评价效果'))}</span></div>`;
      return `<div class="cognition-proof-row"><div class="cognition-proof-transfer"><span>${escapeHtml(_transferProofLabel(entry.transfer?.status))}</span><small>v${escapeHtml(String(entry.version || ''))} · ${escapeHtml(_cognitionDate(entry.transfer?.createdAt))}</small></div>${effects}</div>`;
    }).join('');
    const proofHtml = `<div class="cognition-chain-proofs"><strong>${escapeHtml(_cognitionText('cognition.proofs', '证明'))}</strong>${
      proofs.length ? proofRows : `<div class="skills-cognition-muted">${escapeHtml(_cognitionText('cognition.proofs_empty', '还没有人证明过这条认知有没有用。'))}</div>`
    }</div>`;

    body = `<div class="cognition-chain-body">
      <div class="cognition-chain-segments">${segmentsHtml}</div>
      ${crossScopeHtml}${carriedHtml}${usageHtml}${proofHtml}${withheldHtml}
    </div>`;
  }

  return `<section class="recall-asset-chain-panel"><div class="recall-asset-version-head"><strong>${escapeHtml(_cognitionText('cognition.chain_title', '使用与证明'))}</strong><button type="button" class="btn btn-sm recall-asset-version-close" data-recall-asset-chain-close title="${escapeHtml(closeLabel)}" aria-label="${escapeHtml(closeLabel)}">${closeIcon}</button></div>${body}</section>`;
}

/** 变更分类 → 用户读得懂的字段名。服务端只给 kind/field，措辞归渲染层。 */
function _assetChangeFieldLabel(change) {
  const labels = {
    applicableWhen: _cognitionText('cognition.applicable_when', '适用范围'),
    forbiddenWhen: _cognitionText('cognition.forbidden_when', '禁止范围'),
    statement: _cognitionText('cognition.deposited_content', '沉淀内容'),
    title: _cognitionText('cognition.asset_title', '标题'),
    scope: _cognitionText('cognition.governance_scope', '作用范围'),
    sensitivity: _cognitionText('cognition.sensitivity', '敏感级'),
    evidenceRefs: _cognitionText('cognition.evidence_refs', '证据'),
    maturity: _cognitionText('cognition.maturity', '成熟度'),
    status: _cognitionText('cognition.asset_governance', '治理状态'),
  };
  return labels[change.field] || String(change.field || '');
}

/**
 * 某个版本相对上一版改了什么。
 *
 * 最早那一版不显示"没有变化"而是显示"首个版本"——两者是不同的事实，混为
 * 一谈会让用户以为系统没算出来。
 */
function _renderAssetVersionChanges(diff, version, versions) {
  const isFirst = Array.isArray(versions) && versions.length > 0
    && String(versions[versions.length - 1]?.version || '') === String(version || '');
  if (!diff) {
    const text = isFirst
      ? _cognitionText('cognition.governance_first_version', '首个版本，没有可对比的前一版')
      : _cognitionText('cognition.governance_no_changes', '这一版没有内容变化');
    return `<div class="recall-asset-version-changes is-empty">${escapeHtml(text)}</div>`;
  }
  const rows = (diff.changes || []).map((change) => `<div class="recall-asset-version-change is-${escapeHtml(change.kind || '')}"><b>${escapeHtml(_assetChangeFieldLabel(change))}</b><span>${escapeHtml(change.before)}</span><i aria-hidden="true">→</i><span>${escapeHtml(change.after)}</span></div>`).join('');
  return `<div class="recall-asset-version-changes"><strong>${escapeHtml(_cognitionText('cognition.governance_changes', '本次改动'))}</strong>${rows}</div>`;
}

function _renderRecallAssetHistory(assetId) {
  if (_skillsCognitionState.visibleAssetHistoryId !== assetId) return '';
  const history = _skillsCognitionState.assetHistoryById?.[assetId];
  const closeLabel = _cognitionText('common.close', '关闭');
  const closeIcon = typeof uiIconHtml === 'function' ? uiIconHtml('x') : '<span aria-hidden="true">×</span>';
  let body = `<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;
  if (history?.error) {
    body = `<div class="skills-cognition-error">${escapeHtml(history.error)}</div>`;
  } else if (history && !history.loading) {
    const versions = Array.isArray(history.versions) ? history.versions : [];
    // 回滚按钮挂在版本行上：要回到哪一版是选择题，放进「更多」菜单就没地方选。
    // 当前版本不给回滚按钮——回滚到自己没有意义，服务端也会拒。
    const currentVersion = String(_skillsCognitionState.assets?.find((item) => item.id === assetId)?.version || '');
    const rollbackLabel = _cognitionText('cognition.asset_action_rollback', '回滚到此版本');
    // diff 按 toVersion 索引：每个版本行下面挂它相对上一版改了什么。没有这个，
    // "回滚到此版本"就只能靠时间戳猜。
    const diffsByVersion = new Map((Array.isArray(history.diffs) ? history.diffs : [])
      .map((diff) => [String(diff.toVersion || ''), diff]));
    body = versions.length ? versions.map((version) => {
      const value = String(version.version || '');
      const rollback = value && value !== currentVersion
        ? `<button type="button" class="btn btn-sm recall-asset-rollback" data-recall-asset-rollback="${escapeHtml(assetId)}" data-recall-asset-version="${escapeHtml(value)}">${escapeHtml(rollbackLabel)}</button>`
        : '';
      return `<div class="recall-asset-version-row"><span><strong>v${escapeHtml(value)}</strong><small>${escapeHtml(_cognitionDate(version.at))}</small></span><p>${escapeHtml(version.snapshot?.title || '')}</p>${rollback}</div>${_renderAssetVersionChanges(diffsByVersion.get(value), value, versions)}`;
    }).join('') : `<div class="skills-cognition-empty">${escapeHtml(_cognitionText('cognition.asset_versions_empty', '暂无版本记录'))}</div>`;
  }
  return `<section class="recall-asset-version-panel"><div class="recall-asset-version-head"><strong>${escapeHtml(_cognitionText('cognition.version_history', '版本历史'))}</strong><button type="button" class="btn btn-sm recall-asset-version-close" data-recall-asset-history-close title="${escapeHtml(closeLabel)}" aria-label="${escapeHtml(closeLabel)}">${closeIcon}</button></div>${body}</section>`;
}

function renderSkillsCognitionAssets() {
  const host = document.getElementById('skills-cognition-assets-body');
  if (!host) return;
  if (_cognitionSnapshotPending()) { _renderCognitionLoading(host); return; }
  const summaryHost = document.getElementById('skills-cognition-assets-summary');
  const personalMemoryHead = document.getElementById('skills-cognition-formal-assets')
    ?.querySelector?.('.recall-personal-memory-head');
  const items = _skillsCognitionState.assets;
  const assetsHero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.assets_eyebrow', eyebrow: 'MY COGNITION',
    titleKey: 'cognition.assets_title', title: '把拥有的认知按四类整理清楚',
    hintKey: 'cognition.assets_page_hint', hint: '四类资产是“我拥有什么”，不是新的任务入口；选择分类后继续使用现有资产页与个人本体。',
  });
  const categories = [
    ['personal', 'cognition.asset_category_personal', '关于我', 'cognition.asset_category_personal_desc', '长期角色与个人边界'],
    ['rule', 'cognition.asset_category_rule', '规则与偏好', 'cognition.asset_category_rule_desc', '可复用的决策约束'],
    ['template', 'cognition.asset_category_template', '模板与范例', 'cognition.asset_category_template_desc', '结构与参考样例'],
    ['skill_method', 'cognition.asset_category_skill_method', '技能与方法', 'cognition.asset_category_skill_method_desc', '流程、工具与评价方法'],
  ];
  const summary = categories.map(([category, key, fallback, descKey, descFallback]) => {
    const active = _skillsCognitionState.assetCategoryFilter === category ? ' is-active' : '';
    return `
    <button type="button" class="ability-asset-summary-card${active}" data-ability-asset-category="${escapeHtml(category)}"><span>${escapeHtml(_cognitionText(key, fallback))}</span><strong>${escapeHtml(String(_abilityAssetSummary(items, category)))}</strong><small>${escapeHtml(_cognitionText(descKey, descFallback))}</small></button>
  `;
  }).join('');
  // 认知树入口挂在四类卡片旁边：树回答的是"这些资产长成什么样了"，它是
  // 「我拥有什么」的另一种看法，不是第五个任务。
  const treeEntry = `<div class="ability-asset-tree-entry"><div><strong>${escapeHtml(_cognitionText('cognition.tree_entry_title', '一棵树展示所有已确认资产的成长状态'))}</strong><p class="panel-sub">${escapeHtml(_cognitionText('cognition.tree_entry_hint', '候选是芽，已确认是浅叶，真实验证后成为深叶；任务接续快照不会长成叶片。'))}</p></div><button type="button" class="btn btn-sm" data-cognition-page-link="tree">${escapeHtml(_cognitionText('cognition.tree_open', '打开认知树'))}</button></div>`;
  const summaryMarkup = `<div class="ability-asset-summary-grid">${summary}</div>`;
  const summaryContent = `${assetsHero}${summaryMarkup}${treeEntry}`;
  if (summaryHost) summaryHost.innerHTML = summaryContent;
  const isPersonalCategory = _skillsCognitionState.assetCategoryFilter === 'personal';
  // 「关于我」是四类资产之一，不再是独立任务页：选中 personal 分类时在本页
  // 展开个人本体。骨架全仓只有这一处，渲染函数按 id 定位即可命中。
  const personalOntologyHost = document.getElementById('skills-cognition-personal-ontology');
  const shouldRenderPersonalOntology = Boolean(personalOntologyHost && isPersonalCategory && personalOntologyHost.hidden);
  if (personalOntologyHost) personalOntologyHost.hidden = !isPersonalCategory;
  if (personalMemoryHead) personalMemoryHead.hidden = !isPersonalCategory;
  if (shouldRenderPersonalOntology) {
    const renderOntology = typeof window.refreshPersonalOntology === 'function'
      ? window.refreshPersonalOntology
      : window.renderPersonalOntology;
    if (typeof renderOntology === 'function') {
      Promise.resolve(renderOntology()).catch((error) => {
        _skillsLog.warn('personal ontology render failed', { error: (error && error.message) || String(error) });
      });
    }
  }
  // 这里不再补救过滤 personal_ontology 代理项：后端 assets-adapter 已不再把
  // 个人本体分组合成为资产，列表与上方分类计数因此天然一致。过去列表过滤、
  // 计数不过滤，卡片数字会大于实际可见条数。
  const categoryItems = _skillsCognitionState.assetCategoryFilter
    ? items.filter((item) => (item.category || item.type) === _skillsCognitionState.assetCategoryFilter)
    : items;
  // 搜索时不再挂「最近变化」：搜索是一次明确的查询，下面再列一串没被搜到的
  // 资产只会让人以为过滤没生效。分类切换不算——那是导航，不是查询。
  const searchQuery = String(_skillsCognitionState.assetSearchQuery || '').trim().toLocaleLowerCase();
  const filteredItems = searchQuery
    ? categoryItems.filter((item) => [item.title, item.summary, item.statement, item.id, item.scope, item.category, item.type]
      .some((value) => String(value || '').toLocaleLowerCase().includes(searchQuery)))
    : categoryItems;
  const searchInput = `<input class="asset-search" value="${escapeHtml(_skillsCognitionState.assetSearchQuery || '')}" placeholder="${escapeHtml(_cognitionText('cognition.search_ability_assets', '搜索能力资产'))}" aria-label="${escapeHtml(_cognitionText('cognition.search_ability_assets', '搜索能力资产'))}">`;
  if (!items.length) {
    host.innerHTML = `${summaryHost ? '' : summaryContent}<div class="ability-assets-workbench is-asset-management-only">
      <div class="ability-assets-empty">${escapeHtml(_cognitionText('cognition.no_ability_assets', '尚无正式资产。完成复用证明、确认带入正确并保存后，资产才会出现在这里。'))}</div>
    </div>`;
    return;
  }
  if (!filteredItems.length) {
    const selectedCategory = _abilityAssetCategoryLabel(_skillsCognitionState.assetCategoryFilter);
    host.innerHTML = `${summaryHost ? '' : summaryContent}<div class="ability-assets-workbench is-asset-management-only">
      <div class="ability-assets-management">
        <section class="ability-asset-list"><div class="ability-asset-list-head">${searchInput}</div><div class="ability-assets-empty">${escapeHtml(searchQuery ? _cognitionText('cognition.asset_search_empty', '未找到匹配的能力资产') : _cognitionText('cognition.empty_asset_category', '该分类暂无能力资产'))}</div></section>
        <section class="ability-asset-detail"><div class="ability-assets-empty"><strong>${escapeHtml(selectedCategory)}</strong><br>${escapeHtml(_cognitionText('cognition.empty_asset_category_hint', '当候选被确认并保存为正式资产后，会出现在这里。'))}</div></section>
      </div>
    </div>`;
    return;
  }
  const selected = filteredItems.find((item) => item.id === _skillsCognitionState.selectedAssetId) || filteredItems.find((item) => item.status === 'active') || filteredItems[0];
  _skillsCognitionState.selectedAssetId = selected.id;
  const rows = filteredItems.map((a) => {
    const category = a.category || a.type;
    const selectedClass = a.id === selected.id ? ' is-selected' : '';
    const displayTitle = _abilityAssetDisplayTitle(a);
    const contentSummary = _abilityAssetContentSummary(a);
    return `<button type="button" class="skills-cognition-record cognition-asset-row ability-asset-list-row${selectedClass}" data-ability-asset-id="${escapeHtml(a.id)}">
      <span class="ability-asset-row-main"><strong>${escapeHtml(displayTitle)}</strong><small>${escapeHtml(_abilityAssetCategoryLabel(category))}${a.version ? ` · ${escapeHtml(a.version)}` : ''} · ${escapeHtml(_abilityAssetScopeLabel(a.scope || 'general'))}</small>${contentSummary ? `<details class="recall-collapsible-body ability-asset-row-details" onclick="event.stopPropagation()"><summary>${escapeHtml(_cognitionText('cognition.asset_view_content', '查看内容'))}</summary><span class="ability-asset-row-summary">${escapeHtml(contentSummary)}</span></details>` : ''}</span>
      <span class="skills-cognition-status">${escapeHtml(_abilityAssetMaturityLabel(a.maturity, a.status))}</span>
    </button>`;
  }).join('');
  const selectedCategory = selected.category || selected.type;
  const selectedDisplayTitle = _abilityAssetDisplayTitle(selected);
  const selectedContentSummary = _abilityAssetContentSummary(selected);
  const selectedContentSummaryBlock = selectedContentSummary
    ? `<div class="asset-content-summary"><strong>${escapeHtml(_cognitionText('cognition.deposited_content', '沉淀内容'))}</strong><p>${escapeHtml(selectedContentSummary)}</p></div>`
    : '';
  const workspaceRefs = Array.isArray(selected.workspaceRefs) ? selected.workspaceRefs.filter(Boolean) : [];
  const relationRefs = Array.isArray(selected.relationRefs) ? selected.relationRefs : [];
  const relationText = relationRefs.length ? [...new Set(relationRefs.map(_cognitionRelationRefText).filter(Boolean))].join('、') : _cognitionText('cognition.no_refs', '未记录引用');
  // 列表里的每一条都是正式资产，治理动作与写入来源一律可显示。
  const writeOrigin = _abilityAssetWriteOriginLabel(selected.lifecycleStatus);
  const assetManagementActions = _recallAssetActions(selected.status);
  const assetMoreLabel = _cognitionText('common.more', '更多');
  const assetMoreIcon = typeof uiIconHtml === 'function' ? uiIconHtml('more-horizontal') : '<span aria-hidden="true">...</span>';
  const assetMore = assetManagementActions.length
    ? `<button type="button" class="btn btn-sm recall-asset-more" data-recall-asset-more="${escapeHtml(selected.id)}" data-recall-asset-actions="${escapeHtml(assetManagementActions.join(','))}" title="${escapeHtml(assetMoreLabel)}" aria-label="${escapeHtml(assetMoreLabel)}">${assetMoreIcon}</button>`
    : '';
  const skillDraftFailed = selected.recallSkillDraftStatus === 'failed';
  const skillDraftNeedsModel = skillDraftFailed && (selected.recallSkillDraftErrorCode === 'model_not_configured' || selected.recallSkillDraftErrorCode === 'model_auth_required');
  const skillDraftReady = selected.recallSkillDraftStatus === 'draft';
  const isRecallSkillAsset = selectedCategory === 'skill_method' && selected.status === 'active';
  const skillInstalled = isRecallSkillAsset && Boolean(selected.generatedSkillId);
  const skillDraftGenerating = isRecallSkillAsset && (selected.recallSkillDraftStatus === 'generating' || (!selected.recallSkillDraftStatus && !selected.generatedSkillId));
  const skillDraftRecallContext = selected.recallSkillDraft?.recallContext;
  const skillDraftRecallSummary = Number(skillDraftRecallContext?.assetCount) > 0
    ? _cognitionText('cognition.skill_draft_recall_context', '依据：{assets} 条记忆 · {sources} 个来源')
      .replace('{assets}', String(skillDraftRecallContext.assetCount))
      .replace('{sources}', String(skillDraftRecallContext.sourceCount || 0))
    : '';
  const skillAction = isRecallSkillAsset
    ? selected.generatedSkillId
      ? `<button type="button" class="btn btn-sm btn-primary" data-cognition-open-skill="${escapeHtml(selected.generatedSkillId)}">${escapeHtml(_cognitionText('cognition.open_skill', '查看技能'))}</button><button type="button" class="btn btn-sm" data-cognition-open-skill-update="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.governance_open_skill_versions', '版本与回退'))}</button>`
      : skillDraftReady
        ? `<button type="button" class="btn btn-sm btn-primary" data-recall-skill-import="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.add_to_skill_library', '加入技能库'))}</button>`
        : skillDraftNeedsModel
          ? `<button type="button" class="btn btn-sm btn-primary" data-recall-skill-configure>${escapeHtml(_cognitionText('cognition.configure_model', '配置模型'))}</button>`
          : skillDraftFailed
          ? `<button type="button" class="btn btn-sm btn-primary" data-recall-skill-generate="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.retry_skill_draft', '重试生成'))}</button>`
          : `<button type="button" class="btn btn-sm btn-primary" disabled>${escapeHtml(_cognitionText('cognition.skill_draft_auto_generating', '正在生成 Skill…'))}</button>`
    : '';
  const skillDraftFeedback = skillInstalled
    ? `<div class="reference-strip recall-skill-draft-state"><div><strong>${escapeHtml(_cognitionText('cognition.skill_installed_status', '已加入技能库'))}</strong><p>${escapeHtml(_cognitionText('cognition.skill_installed_hint', '现在可在技能库中查看和使用。'))}</p></div>${skillAction}</div>`
    : skillDraftFailed
    ? `<div class="recall-capture-task-error recall-skill-draft-state"><div><b>${escapeHtml(_cognitionText('cognition.skill_draft_failed', 'Skill 生成失败'))}</b><span>${escapeHtml(_recallSkillDraftErrorLabel(selected.recallSkillDraftErrorCode))}</span></div>${skillAction}</div>`
    : skillDraftReady
      ? `<div class="reference-strip recall-skill-draft-state"><div><strong>${escapeHtml(_cognitionText('cognition.skill_draft_ready', 'Skill 已生成'))}</strong><p>${escapeHtml([skillDraftRecallSummary, _cognitionText('cognition.skill_draft_ready_hint', '已通过校验，等待加入技能库。')].filter(Boolean).join(' · '))}</p></div>${skillAction}</div>`
      : skillDraftGenerating
        ? `<div class="reference-strip recall-skill-draft-state"><div><strong>${escapeHtml(_cognitionText('cognition.skill_draft_auto_generating', '正在生成 Skill…'))}</strong><p>${escapeHtml(_cognitionText('cognition.skill_draft_auto_hint', '正在整理相关记忆与来源。'))}</p></div>${skillAction}</div>`
        : '';
  host.innerHTML = `${summaryHost ? '' : summaryContent}<div class="ability-assets-workbench is-asset-management-only">
    <div class="ability-assets-management">
      <section class="ability-asset-list">
        <div class="ability-asset-list-head">${searchInput}</div>
        <div class="skills-cognition-record-list ability-asset-list-body">${rows}</div>
      </section>
      <section class="ability-asset-detail">
        <div class="asset-detail-head"><div><h2>${escapeHtml(selectedDisplayTitle)}</h2><p>${escapeHtml(_abilityAssetCategoryLabel(selectedCategory))}</p></div><div class="asset-detail-head-actions"><span class="skills-cognition-status is-${escapeHtml(selected.status || '')}">${escapeHtml(_abilityAssetMaturityLabel(selected.maturity, selected.status))}</span>${assetMore}</div></div>
        <div class="asset-detail-body">
          ${skillDraftFeedback}
          <dl class="cognition-governance-facts cognition-asset-facts">
            <div><dt>${escapeHtml(_cognitionText('cognition.governance_scope', '作用范围'))}</dt><dd>${escapeHtml(_abilityAssetScopeLabel(selected.scope || 'general'))}</dd></div>
            <div><dt>${escapeHtml(_cognitionText('cognition.asset_default_use', '默认使用'))}</dt><dd>${escapeHtml(_abilityAssetDefaultUseLabel(selected))}</dd></div>
            <div><dt>${escapeHtml(_cognitionText('cognition.governance_version', '版本'))}</dt><dd>${selected.version ? `v${escapeHtml(selected.version)}` : '—'}</dd></div>
          </dl>
          ${selectedContentSummaryBlock}
          ${writeOrigin ? `<div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.asset_write_origin', '写入来源'))}</strong><p>${escapeHtml(writeOrigin)}</p></div>` : ''}
          <div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.relation_refs', '关联引用'))}</strong><p>${escapeHtml(relationText)}</p></div>
          ${workspaceRefs.length ? `<div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.workspace_refs', 'Workspace引用'))}</strong><p>${escapeHtml(workspaceRefs.join('、'))}</p></div>` : ''}
          ${_renderAbilityAssetGovernance(selected)}
          ${_renderRecallAssetHistory(selected.id)}
          ${_renderRecallAssetChain(selected.id)}
        </div>
      </section>
    </div>
  </div>${searchQuery ? '' : _renderCognitionRecentActivity()}`;
}

/**
 * 「版本与治理」：回答"我的资产发生过什么变化、我怎样保持控制"。
 *
 * 这里刻意不引入新的治理语义——每一个动作都落在既有 IPC 上（pause / resume /
 * archive / restore / delete / purge / revoke / versions / rollback），复用
 * 「更多」菜单与版本面板的同一套 data 属性，所以事件绑定不需要再写一遍。
 *
 * 与「我的资产」的分工：那边按四类看"我拥有什么"，只展示 active 的正常视图；
 * 这里按变更看"发生过什么、怎么收回"，因此暂停、归档、已撤销的资产也必须
 * 列出来——否则用户暂停之后就再也找不到它了。
 */
/** 资产真实总数：后端 `cognition.assets.list` 的 `total`，取不到才退回本次条数。 */
function _cognitionAssetTotal(items) {
  const total = _skillsCognitionState.totals?.assets;
  return Number.isFinite(total) ? total : (Array.isArray(items) ? items.length : 0);
}

/** 本次是否只取回了一部分。截断时不能拿手里这批算派生统计（按状态、按分类）
 *  ——那些数字会随 limit 变化，用户看不出它们只统计了前 N 条。 */
function _cognitionAssetsTruncated(items) {
  const total = _skillsCognitionState.totals?.assets;
  return Number.isFinite(total) && total > (Array.isArray(items) ? items.length : 0);
}

function renderSkillsCognitionGovernance() {
  const host = document.getElementById('skills-cognition-governance-body');
  if (!host) return;
  if (_cognitionSnapshotPending()) { _renderCognitionLoading(host); return; }
  const items = Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [];
  const hero = _renderCognitionTaskHero({
    eyebrowKey: 'cognition.governance_eyebrow', eyebrow: 'VERSION & GOVERNANCE',
    titleKey: 'cognition.governance_title', title: '每次变化都有版本，也有退路',
    hintKey: 'cognition.governance_page_hint', hint: '暂停、停止默认使用、撤销引用、删除资产与清除历史是不同动作；先看影响，再执行。',
    // 「全部资产」用后端真实 total；两个分状态计数只能按本次取回的条目算，
    // 后端不按状态分组返回。所以截断时不显示它们——给一个只统计了前 N 条的
    // 「正常使用」，比不给更容易让人做错判断。
    metrics: [
      { value: _cognitionAssetTotal(items), key: 'cognition.governance_total', label: '全部资产' },
      ...(_cognitionAssetsTruncated(items) ? [] : [
        { value: items.filter((asset) => asset.status === 'active').length, key: 'cognition.governance_active', label: '正常使用' },
        { value: items.filter((asset) => asset.status !== 'active').length, key: 'cognition.governance_attention', label: '需要关注' },
      ]),
    ],
  });
  if (!items.length) {
    host.innerHTML = `${hero}<div class="skills-cognition-empty cognition-task-empty"><strong>${escapeHtml(_cognitionText('cognition.governance_empty', '尚无可治理的资产'))}</strong><span>${escapeHtml(_cognitionText('cognition.governance_empty_hint', '资产被确认为正式资产后，它的版本与治理入口会出现在这里。'))}</span></div>`;
    return;
  }
  const selected = items.find((asset) => asset.id === _skillsCognitionState.selectedAssetId)
    || items.find((asset) => asset.status === 'active')
    || items[0];
  _skillsCognitionState.selectedAssetId = selected.id;
  // 「有候选」不是一种资产状态，而是"这条资产还有一个没决定的更新"。它由待办
  // 读模型给出（与 gate 同源），不在这里从 assets 自行推算。
  const upgradeAssetIds = new Set((Array.isArray(_skillsCognitionState.inboxItems) ? _skillsCognitionState.inboxItems : [])
    .filter((entry) => entry?.kind === 'skill_upgrade_suggested' && entry.assetId)
    .map((entry) => entry.assetId));
  const rows = items.map((asset) => {
    const category = asset.category || asset.type;
    const selectedClass = asset.id === selected.id ? ' is-selected' : '';
    // 「有候选」在行上只做标识，不做入口：整行已经是一个选择按钮，往里再嵌
    // 一个可点元素既是无效 HTML，也会被外层的行选择处理器先吃掉。真正的入口
    // 放在右侧详情面板里——那里才是看清影响之后再决定的地方。
    const statusHtml = upgradeAssetIds.has(asset.id)
      ? `<span class="skills-cognition-status is-pending">${escapeHtml(_cognitionText('cognition.governance_has_candidate', '有候选'))}</span>`
      : `<span class="skills-cognition-status is-${escapeHtml(asset.status || '')}">${escapeHtml(_abilityAssetMaturityLabel(asset.maturity, asset.status))}</span>`;
    return `<button type="button" class="cognition-governance-asset-row${selectedClass}" data-cognition-governance-select="${escapeHtml(asset.id)}">
      <span><strong>${escapeHtml(_abilityAssetDisplayTitle(asset))}</strong><small>${escapeHtml(_abilityAssetCategoryLabel(category))} · ${escapeHtml(_abilityAssetScopeLabel(asset.scope || 'general'))}</small></span>
      <span class="cognition-governance-version">${asset.version ? `v${escapeHtml(asset.version)}` : '—'}</span>
      ${statusHtml}
    </button>`;
  }).join('');
  const actions = _recallAssetActions(selected.status);
  const renderAction = (action, dangerous = false) => `<button type="button" class="btn btn-sm${dangerous ? ' btn-danger' : ''}" data-cognition-governance-action="${escapeHtml(action)}" data-cognition-governance-asset="${escapeHtml(selected.id)}">${escapeHtml(_recallAssetActionLabel(action))}</button>`;
  const usageActions = actions.filter((action) => ['pause', 'resume', 'archive', 'restore'].includes(action)).map((action) => renderAction(action)).join('');
  const recordActions = actions.filter((action) => ['versions', 'chain'].includes(action)).map((action) => renderAction(action)).join('');
  const destructiveActions = actions.filter((action) => ['delete', 'revoke', 'purge'].includes(action)).map((action) => renderAction(action, true)).join('');
  const workspaceRefs = Array.isArray(selected.workspaceRefs) ? selected.workspaceRefs.filter(Boolean) : [];
  const writeOrigin = _abilityAssetWriteOriginLabel(selected.lifecycleStatus);
  // 已绑定 Skill 的资产始终显示版本入口；有待决更新时把措辞升级为「查看更新候选」。
  // 之前只在 inbox 有待办时显示，导致没有待决更新的 Skill 无法查看历史和回退。
  const upgradeEntry = selected.generatedSkillId
    ? `<button type="button" class="btn btn-sm" data-cognition-open-skill-update="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText(upgradeAssetIds.has(selected.id) ? 'cognition.governance_open_update' : 'cognition.governance_open_skill_versions', upgradeAssetIds.has(selected.id) ? '查看更新候选' : '版本与回退'))}</button>`
    : '';
  // 回滚点：用户问"我还能退回到哪一版"。版本历史是按需加载的，没展开过就还
  // 不知道——那时显示「展开版本历史后可见」并给出口，而不是显示「—」让人
  // 以为无路可退。历史已在手时列出真实可回滚的版本号。
  const history = _skillsCognitionState.assetHistoryById?.[selected.id];
  const knownVersions = Array.isArray(history?.versions) ? history.versions : null;
  const rollbackPoints = knownVersions
    ? (knownVersions
      .map((version) => String(version.version || ''))
      .filter((version) => version && version !== String(selected.version || ''))
      .map((version) => `v${escapeHtml(version)}`).join('、')
      || escapeHtml(_cognitionText('cognition.governance_no_rollback', '没有可回滚的历史版本')))
    : `<button type="button" class="btn btn-sm" data-cognition-governance-action="versions" data-cognition-governance-asset="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.governance_show_rollback', '展开版本历史'))}</button>`;
  host.innerHTML = `${hero}<div class="cognition-governance-workbench">
    <section class="skills-cognition-card cognition-governance-history-card">
      <div class="cognition-governance-panel-head"><div><h2>${escapeHtml(_cognitionText('cognition.governance_assets_versions', '资产与当前版本'))}</h2><p>${escapeHtml(_cognitionText('cognition.governance_assets_versions_hint', '选择一项，查看它的状态、版本与可执行动作。'))}</p></div><span>${escapeHtml(String(items.length))}</span></div>
      <div class="cognition-governance-asset-list">${rows}</div>
    </section>
    <section class="skills-cognition-card cognition-governance-control-card">
      <div class="cognition-governance-selected-head"><div><h2>${escapeHtml(_abilityAssetDisplayTitle(selected))}</h2><p>${escapeHtml(_abilityAssetCategoryLabel(selected.category || selected.type))} · ${escapeHtml(_cognitionText('cognition.governance_version', '版本'))} ${selected.version ? `v${escapeHtml(selected.version)}` : '—'}</p></div><span class="skills-cognition-status is-${escapeHtml(selected.status || '')}">${escapeHtml(_abilityAssetMaturityLabel(selected.maturity, selected.status))}</span></div>
      <dl class="cognition-governance-facts"><div><dt>${escapeHtml(_cognitionText('cognition.governance_scope', '作用范围'))}</dt><dd>${escapeHtml(_abilityAssetScopeLabel(selected.scope || 'general'))}</dd></div><div><dt>${escapeHtml(_cognitionText('cognition.asset_write_origin', '写入来源'))}</dt><dd>${escapeHtml(writeOrigin || '—')}</dd></div><div><dt>${escapeHtml(_cognitionText('cognition.workspace_refs', 'Workspace引用'))}</dt><dd>${escapeHtml(workspaceRefs.length ? workspaceRefs.join('、') : _cognitionText('cognition.no_refs', '未记录引用'))}</dd></div><div><dt>${escapeHtml(_cognitionText('cognition.governance_rollback_points', '回滚点'))}</dt><dd>${rollbackPoints}</dd></div></dl>
      ${usageActions ? `<section class="cognition-governance-action-group"><h3>${escapeHtml(_cognitionText('cognition.governance_impact_preview', '影响预览'))}</h3><p>${escapeHtml(_cognitionText('cognition.governance_impact_preview_hint', '暂停后，新任务不再默认带入；已完成任务、版本和 Evidence 均保留。归档后仍可检索，但不出现在常用资产中。'))}</p><div>${usageActions}</div></section>` : ''}
      ${recordActions ? `<section class="cognition-governance-action-group"><h3>${escapeHtml(_cognitionText('cognition.governance_history_control', '版本与证明'))}</h3><p>${escapeHtml(_cognitionText('cognition.governance_history_control_hint', '查看历史版本、回滚入口，以及这条资产的使用履历。'))}</p><div>${recordActions}${upgradeEntry}</div></section>` : ''}
      ${destructiveActions ? `<section class="cognition-governance-action-group is-danger"><h3>${escapeHtml(_cognitionText('cognition.governance_asset_body', '资产本体'))}</h3><p>${escapeHtml(_cognitionText('cognition.governance_asset_body_hint', '删除、撤回使用与彻底清除影响不同，执行前会再次确认。'))}</p><div>${destructiveActions}</div></section>` : ''}
      ${_renderRecallAssetHistory(selected.id)}
      ${_renderRecallAssetChain(selected.id)}
    </section>
  </div>`;
}

function openRecallPersonalOntology() {
  _skillsCognitionState.assetCategoryFilter = 'personal';
  _skillsCognitionState.selectedAssetId = '';
  switchSkillsCognitionPage('assets');
}

window.openRecallPersonalOntology = openRecallPersonalOntology;

async function loadSkillsCognitionSnapshot() {
  if (_skillsCognitionState.loading) return;
  _skillsCognitionState.loading = true;
  const snapshotCaptureFilter = _skillsCognitionState.captureFilter;
  const snapshotCaptureRequestId = _skillsCognitionCaptureRequestId;
  const captureRequestWasInFlight = _skillsCognitionCaptureRequestsInFlight > 0;
  const capturePayload = { limit: 25 };
  const captureStatuses = _captureStatusesForFilter(snapshotCaptureFilter);
  if (captureStatuses.length) capturePayload.statuses = captureStatuses;
  const [dashboard, recallCandidates, assets, sources, captures, recentCaptures, teachingSignals, captureSettings, inbox] = await Promise.allSettled([
    Promise.resolve().then(() => window.cogseed.invoke('cognition.dashboard.read')),
    Promise.resolve().then(() => window.cogseed.invoke('recall.candidates.list')),
    Promise.resolve().then(() => window.cogseed.invoke('cognition.assets.list', { limit: 500 })),
    Promise.resolve().then(() => window.cogseed.invoke('recall.sources.list', { limit: 100 })),
    Promise.resolve().then(() => window.cogseed.invoke('recall.captures.list', capturePayload)),
    Promise.resolve().then(() => window.cogseed.invoke('recall.captures.list', { limit: 5 })),
    Promise.resolve().then(() => window.cogseed.invoke('recall.teaching.list', { limit: 20 })),
    Promise.resolve().then(() => window.cogseed.invoke('recall.captures.settings.get')),
    Promise.resolve().then(() => window.cogseed.invoke('cognition.inbox.list')),
  ]);
  const captureResultIsCurrent = !captureRequestWasInFlight
    && snapshotCaptureRequestId === _skillsCognitionCaptureRequestId
    && snapshotCaptureFilter === _skillsCognitionState.captureFilter;
  if (dashboard.status === 'fulfilled' && dashboard.value?.ok) _skillsCognitionState.dashboard = dashboard.value.dashboard;
  // total 只在这次读成功时更新；读失败保留上一次的真值，不要退回 null 让界面
  // 把"没读到"显示成"没有"。
  const readTotal = (result, fallback) => (result.status === 'fulfilled' && result.value?.ok
    && Number.isFinite(result.value.total) ? result.value.total : fallback);
  _skillsCognitionState.totals = {
    assets: readTotal(assets, _skillsCognitionState.totals?.assets ?? null),
    teachingSignals: readTotal(teachingSignals, _skillsCognitionState.totals?.teachingSignals ?? null),
    inboxItems: readTotal(inbox, _skillsCognitionState.totals?.inboxItems ?? null),
  };
  if (recallCandidates.status === 'fulfilled' && recallCandidates.value?.ok) _skillsCognitionState.recallCandidates = recallCandidates.value.candidates || [];
  if (assets.status === 'fulfilled' && assets.value?.ok) {
    _skillsCognitionState.assets = assets.value.assets || [];
    queueMissingRecallSkillDrafts();
  }
  if (sources.status === 'fulfilled' && sources.value?.ok) _skillsCognitionState.sources = sources.value.sources || [];
  if (captureResultIsCurrent && captures.status === 'fulfilled' && captures.value?.ok) {
    const nextCaptures = captures.value.captures || [];
    const existingCaptures = _skillsCognitionState.captures || [];
    if (existingCaptures.length > 25) {
      const merged = new Map(nextCaptures.map((capture) => [capture.id, capture]));
      for (const capture of existingCaptures) if (!merged.has(capture.id)) merged.set(capture.id, capture);
      _skillsCognitionState.captures = Array.from(merged.values());
    } else {
      _skillsCognitionState.captures = nextCaptures;
      _skillsCognitionState.captureNextCursor = captures.value.nextCursor || null;
    }
    _skillsCognitionState.captureCounts = captures.value.counts || _skillsCognitionState.captureCounts;
  }
  if (recentCaptures.status === 'fulfilled' && recentCaptures.value?.ok) _skillsCognitionState.recentCaptures = recentCaptures.value.captures || [];
  if (teachingSignals.status === 'fulfilled' && teachingSignals.value?.ok) _skillsCognitionState.teachingSignals = teachingSignals.value.signals || [];
  if (inbox.status === 'fulfilled' && inbox.value?.ok) _skillsCognitionState.inboxItems = inbox.value.items || [];
  _skillsCognitionState.captureSettings = captureSettings.status === 'fulfilled' && captureSettings.value?.ok ? captureSettings.value.settings : _skillsCognitionState.captureSettings;
  _skillsCognitionState.captureModel = captureSettings.status === 'fulfilled' && captureSettings.value?.ok ? captureSettings.value.model : _skillsCognitionState.captureModel;
  _skillsCognitionState.loadErrors = [
    ['dashboard', dashboard],
    ['recallCandidates', recallCandidates],
    ['assets', assets],
    ['sources', sources],
    ...(captureResultIsCurrent ? [['captures', captures]] : []),
    ['recentCaptures', recentCaptures],
    ['teachingSignals', teachingSignals],
    ['inboxItems', inbox],
    ['captureSettings', captureSettings],
  ].filter(([, result]) => result.status !== 'fulfilled' || !result.value?.ok).map(([name]) => name);
  _skillsCognitionState.loadedAt = Date.now();
  _skillsCognitionState.loading = false;
  renderSkillsCognitionInbox();
  if (_skillsCognitionState.page === 'sources') renderSkillsCognitionSources();
  if (_skillsCognitionState.page === 'captures') renderSkillsCognitionCaptures();
  if (_skillsCognitionState.page === 'assets') renderSkillsCognitionAssets();
  if (_skillsCognitionState.page === 'governance') renderSkillsCognitionGovernance();
  if (_skillsCognitionRefreshTimer) clearTimeout(_skillsCognitionRefreshTimer);
  const visibleCaptures = [...(_skillsCognitionState.captures || []), ...(_skillsCognitionState.recentCaptures || [])];
  const captureInProgress = Number(_skillsCognitionState.captureCounts?.processing || 0) > 0
    || visibleCaptures.some((capture) => capture.status === 'queued' || capture.status === 'extracting' || capture.status === 'writing');
  if (captureInProgress) {
    _skillsCognitionRefreshTimer = setTimeout(() => {
      _skillsCognitionRefreshTimer = null;
      if (typeof currentView !== 'undefined' && currentView === 'recall') {
        loadSkillsCognitionSnapshot().catch(() => {});
      }
    }, 3000);
  }
}

function initSkillsCognitionConsole() {
  const panel = document.getElementById('panel-recall');
  if (!panel || panel.dataset.cognitionInitialized === '1') return;
  panel.dataset.cognitionInitialized = '1';
  _cognitionSetPageVisibility(_skillsCognitionState.page);
  // 先起取数、再画首屏。**顺序不能反**：`loading` 是 loadSkillsCognitionSnapshot
  // 自己的重入锁，外部先把它置真，那个函数一进门就 `if (loading) return`，快照
  // 永远不会加载、loadedAt 永远是 0，页面就永久停在「加载中」。
  //
  // loadSkillsCognitionSnapshot 在第一个 await 之前是同步的，会自己把 loading
  // 置真；所以先调用它拿到 promise，再渲染，首屏拿到的就已经是 loading 态。
  const snapshotLoad = loadSkillsCognitionSnapshot();
  _cognitionRenderCurrentPage();
  snapshotLoad
    .then(() => {
      if (_skillsCognitionState.page !== 'inbox') return;
      // G-9 产品决策：**默认永远停在「待我处理」，不自动跳页。**
      //
      // 认知资产首页要先回答"现在有什么需要我判断"。此前待办为空会静默切到
      // 「我的资产」、一件东西都没有会静默切到空种子——用户点进来看到的不是
      // 自己点的那一页，也不知道是被跳走了还是本来就在这儿。
      //
      // 现在两种空都由「待我处理」自己的空态承担并给出显式入口（首启引导 /
      // 去我的资产），跳不跳由用户点。历史带在这里自己拉：留在本页不会走
      // switchSkillsCognitionPage，不拉它就永远停在 loading。
      void loadCognitionReviewHistory();
    })
    .catch(() => {});
}

function _skillSource(source) {
  return (typeof normalizeCatalogSource === 'function')
    ? normalizeCatalogSource(source)
    : String(source || '');
}

function _isSkillPlatformSource(source) {
  return (typeof isMarketplaceCatalogSource === 'function')
    ? isMarketplaceCatalogSource(source)
    : _skillSource(source) === 'marketplace';
}

function _skillUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

function _skillCardChipsHtml(s) {
  const lang = getLang();
  const parts = [];
  const isPlatform = _isSkillPlatformSource(s && s.source);
  if (isPlatform && s.version) {
    const versionLabel = t('marketplace.version').replace('{version}', String(s.version));
    parts.push(`<span class="skill-card-chip is-version">${escapeHtml(versionLabel)}</span>`);
  }
  const catLabel = _resolveCategoryLabel(s && s.category, lang);
  if (catLabel) parts.push(`<span class="skill-card-chip">${escapeHtml(catLabel)}</span>`);
  // Withheld state leads the chip row: it explains why the card is inert, so it
  // has to be readable before the version/category chips.
  if (_isSkillWithheld(s)) {
    parts.unshift(
      `<span class="skill-card-chip is-withheld" title="${escapeHtml(t('skills.security_withheld_hint'))}">`
      + `${escapeHtml(t('skills.security_withheld'))}</span>`,
    );
  }
  return parts.join('');
}

/** True when the main process reported this skill as held back by the
 *  security-receipt check. Absent field = nothing to report (NOT "verified"). */
function _isSkillWithheld(s) {
  return !!(s && s.security && s.security.status === 'withheld');
}

/** "3 天前" for a scan timestamp. '' when absent, so callers can omit the clause
 *  rather than print a fake time. Mirrors connectors.js::_formatLastVerified. */
function _formatScannedAgo(iso) {
  const at = iso ? Date.parse(iso) : 0;
  if (!at || Number.isNaN(at)) return '';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return t('skills.security_scanned_just_now');
  if (mins < 60) return t('skills.security_scanned_minutes_ago', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('skills.security_scanned_hours_ago', { n: hours });
  return t('skills.security_scanned_days_ago', { n: Math.floor(hours / 24) });
}

/**
 * Shield badge for a marketplace skill's security state.
 *
 * Deliberately quiet for the healthy case: a filled shield with no text, so the
 * row reads as "checked" at a glance without competing with the skill's own
 * metadata. Only `withheld` gets a worded chip (see `_skillCardChipsHtml`),
 * because that is the one state the user has to act on.
 *
 * The tooltip carries the audit detail — verdict, when it was scanned, and the
 * validator build — so "was this actually checked, and when" is answerable
 * without a separate panel.
 */
function _skillSecurityBadgeHtml(s) {
  const sec = s && s.security;
  if (!sec || !sec.status) return '';
  const status = String(sec.status);
  // Withheld already renders as a worded chip; a second marker would be noise.
  if (status === 'withheld') return '';

  const ago = _formatScannedAgo(sec.scannedAt);
  const lines = [];
  if (status === 'verified') lines.push(t('skills.security_verified'));
  else if (status === 'risk') lines.push(t('skills.security_risk'));
  else lines.push(t('skills.security_unchecked'));
  if (ago) lines.push(ago);
  if (status === 'risk' && sec.findingCount) {
    lines.push(t('skills.security_findings', { n: sec.findingCount }));
  }
  // Deep-scan score, when a deep scan produced this verdict. Shown before the
  // version lines because it is the part a user can actually judge.
  if (typeof sec.securityScore === 'number') {
    lines.push(t('skills.security_score', { n: sec.securityScore }));
  }
  // Disclosures, not decorations. A verdict from fallback rules or a
  // non-isolated run has weaker standing than a clean isolated pass, and the
  // spec forbids presenting a degraded check as an unqualified one — so both
  // caveats are stated on the badge rather than left to a details pane the user
  // may never open.
  if (sec.rulesDegraded) lines.push(t('skills.security_rules_degraded'));
  if (sec.isolated === false) lines.push(t('skills.security_not_isolated'));
  // Which rule set stood behind the verdict. Stated because a `local` pass and a
  // `deep` pass are not equivalent — the local subset is regex-only and passes
  // payloads the full scanner blocks — so a badge that looked identical for both
  // would overstate the weaker one. Absent on older receipts, which record no
  // depth; those simply omit the line rather than claiming either.
  if (sec.scanner === 'deep') lines.push(t('skills.security_scanner_deep'));
  else if (sec.scanner === 'local') lines.push(t('skills.security_scanner_local'));
  if (sec.rulesetVersion) {
    lines.push(t('skills.security_ruleset', { version: sec.rulesetVersion }));
  } else if (sec.validatorVersion) {
    lines.push(t('skills.security_validator', { version: sec.validatorVersion }));
  }
  // A degraded-rules pass gets the risk styling rather than the clean one: the
  // colour is the only part most users read, so it must not say "fine" when the
  // check behind it was weakened. A `local`-only pass is the same situation by a
  // different route — the deep scanner never ran, and that subset clears content
  // the full ruleset blocks — so it is toned down too. `deep` and older receipts
  // with no recorded depth keep the plain verdict colour.
  const weakened = sec.rulesDegraded || sec.scanner === 'local';
  const tone = weakened && status === 'verified' ? 'risk' : status;
  // A button, not a decorative span: the same disclosures are available on hover
  // as a tooltip, but hover is unreachable by keyboard and by touch, and the
  // attack-surface breakdown is too long for a title attribute. Clicking opens
  // the full panel.
  return `<button type="button" class="skill-card-shield is-${escapeHtml(tone)}"`
    + ` data-skill-security="${escapeHtml(String(s.id || ''))}"`
    + ` title="${escapeHtml(lines.join(' · '))}" aria-label="${escapeHtml(lines.join(' · '))}">🛡</button>`;
}

/**
 * Compose the security detail panel for one skill.
 *
 * Text rather than markup: it goes through `uiAlert`, which escapes its input —
 * so this inherits the existing modal's focus trap, Escape handling and IME
 * guard instead of hand-rolling another dialog.
 *
 * Every line is omitted when its datum is absent. A panel that printed
 * "score —" or "egress 0" for a receipt that never recorded either would assert
 * a measurement that was not taken; absent and zero are different claims.
 */
function _skillSecurityPanelText(s) {
  const sec = (s && s.security) || {};
  const L = [];

  const verdict = sec.status === 'withheld' ? t('skills.security_withheld')
    : sec.status === 'risk' ? t('skills.security_risk')
      : sec.status === 'verified' ? t('skills.security_verified')
        : t('skills.security_unchecked');
  L.push(verdict);
  if (typeof sec.securityScore === 'number') {
    L.push(`${t('skills.secpanel_score')}: ${sec.securityScore}/100`);
  }
  // Why a previously-good verdict stopped applying, e.g. the payload changed
  // after install. Only withheld receipts carry it.
  if (sec.status === 'withheld') L.push(t('skills.security_withheld_hint'));
  L.push('');

  if (sec.scanner === 'deep') L.push(`${t('skills.secpanel_method')}: ${t('skills.security_scanner_deep')}`);
  else if (sec.scanner === 'local') L.push(`${t('skills.secpanel_method')}: ${t('skills.security_scanner_local')}`);
  if (sec.rulesDegraded) L.push(t('skills.security_rules_degraded'));
  if (sec.rulesetVersion) L.push(`${t('skills.secpanel_ruleset')}: ${sec.rulesetVersion}`);
  if (sec.scannerVersion) L.push(`${t('skills.secpanel_scanner')}: ${sec.scannerVersion}`);
  else if (sec.validatorVersion) L.push(`${t('skills.secpanel_scanner')}: ${sec.validatorVersion}`);
  if (typeof sec.isolated === 'boolean') {
    L.push(`${t('skills.secpanel_isolation')}: `
      + (sec.isolated ? t('skills.secpanel_isolated_yes') : t('skills.secpanel_isolated_no')));
  }
  const ago = _formatScannedAgo(sec.scannedAt);
  if (ago) L.push(`${t('skills.secpanel_checked_at')}: ${ago}`);

  const surf = sec.attackSurface;
  if (surf) {
    L.push('');
    L.push(t('skills.secpanel_surface'));
    const rows = [
      [t('skills.secpanel_egress'), surf.egressPoints],
      [t('skills.secpanel_dynexec'), surf.dynamicExecPoints],
      [t('skills.secpanel_persist'), surf.persistencePoints],
    ];
    const anyFound = rows.some(([, n]) => n > 0) || surf.hasBinaries;
    if (!anyFound) {
      L.push(`  ${t('skills.secpanel_surface_clean')}`);
    } else {
      for (const [label, n] of rows) L.push(`  ${label}: ${n}`);
      // Boolean upstream, so it is listed as a present/absent fact rather than a
      // count — printing "1" would invent a number the scanner did not report.
      if (surf.hasBinaries) L.push(`  ${t('skills.secpanel_binaries')}`);
      // The engine truncates each category at 20, so a displayed count can
      // understate reality. Say so rather than presenting it as exact.
      L.push(`  ${t('skills.secpanel_surface_floor')}`);
    }
    L.push(`  ${t('skills.secpanel_surface_note')}`);
  }

  // A user override outranks everything else in this panel: it is the one fact
  // that explains why a skill is present at all despite the gate refusing it.
  // Shown first so it is not buried under the surface counts.
  if (sec.userOverride) {
    L.push('');
    L.push(t('skills.secpanel_user_override'));
  }

  // Instruction-type risk. Shown separately from the attack surface because the
  // two measure different things and fail independently: the code rules can
  // return a clean 100 while the instruction layer has a finding, which is
  // exactly what a credential-harvesting skill written entirely in prose does.
  const instr = sec.instructionRisk;
  if (instr && instr.status !== 'clean') {
    L.push('');
    L.push(t('skills.secpanel_instruction'));
    if (instr.status === 'unavailable') {
      // Not "nothing found": passages were flagged and nobody read them. Saying
      // otherwise would repeat the mistake of rendering "not checked" as clean.
      L.push(`  ${t('skills.secpanel_instruction_unavailable')}`);
    } else {
      L.push(`  ${t('skills.secpanel_instruction_suspicious')}`);
    }
    // The passage itself, verbatim. This verdict is fuzzier than the code rules,
    // so the user gets the evidence rather than only a label — for most of these
    // one glance beats any threshold we could pick.
    for (const seg of (instr.segments || []).slice(0, 3)) {
      const where = `${seg.file}:${seg.line}`;
      const quote = String(seg.text || '').replace(/\s+/g, ' ').slice(0, 160);
      L.push(`  · ${where} — "${quote}"`);
    }
    if ((instr.segments || []).length > 3) {
      L.push(`  ${t('skills.secpanel_instruction_more')
        .replace('{n}', String(instr.segments.length - 3))}`);
    }
    L.push(`  ${t('skills.secpanel_instruction_note')}`);
  }

  // NSEAP declaration check: what the skill's security manifest claims versus
  // what its tree contains. Last in the panel, and deliberately quieter than the
  // blocks above: those report what the skill might DO, this reports whether its
  // paperwork is complete. A mismatch is an authoring defect, so it must not be
  // dressed up in the same language as a finding.
  //
  // `absent` and `pass` both render nothing, for opposite reasons. No shipped
  // skill carries a security manifest today, so printing `absent` would add a
  // line to every skill in the library that reads as a defect while describing
  // one that does not exist. `pass` is silent because a panel that says "nothing
  // wrong" for each check that passed buries the one line that matters.
  const nseap = sec.nseapDeclaration;
  if (nseap && nseap.status !== 'absent' && nseap.status !== 'pass') {
    L.push('');
    L.push(t('skills.secpanel_nseap'));
    if (nseap.status === 'unavailable') {
      // The engine could not run. Distinct from "checked and found nothing":
      // reporting infrastructure failure as a clean result is the same error as
      // rendering "not checked" as safe.
      L.push(`  ${t('skills.secpanel_nseap_unavailable')}`);
    } else if (nseap.status === 'mismatch') {
      L.push(`  ${t('skills.secpanel_nseap_mismatch')}`);
    } else if (nseap.status === 'needs_input') {
      L.push(`  ${t('skills.secpanel_nseap_needs_input')}`);
    } else {
      L.push(`  ${t('skills.secpanel_nseap_warnings')}`);
    }
    // Rule id plus message, capped. The id is what makes a gap actionable — the
    // author can look it up — while the message alone often is not.
    for (const f of (nseap.findings || []).slice(0, 3)) {
      const msg = String(f.message || '').replace(/\s+/g, ' ').slice(0, 160);
      L.push(`  · ${f.ruleId}${msg ? ` — ${msg}` : ''}`);
    }
    if ((nseap.findings || []).length > 3) {
      L.push(`  ${t('skills.secpanel_nseap_more')
        .replace('{n}', String(nseap.findings.length - 3))}`);
    }
    L.push(`  ${t('skills.secpanel_nseap_note')}`);
  }

  if (!sec.status || sec.status === 'unchecked') {
    L.push('');
    L.push(t('skills.secpanel_no_record'));
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * One-line rollup above the grid: how many installed skills are verified, and
 * whether any need attention.
 *
 * Exists so the mechanism is visible when nothing is wrong. Without it the only
 * evidence the checks run at all is a card going amber, which means the feature
 * looks like it does nothing right up until it blocks something.
 *
 * Returns '' when there are no marketplace skills — nothing to summarize, and an
 * empty "0 verified" line would just be clutter.
 */
function _skillsSecuritySummaryHtml(skills) {
  const rows = (skills || []).filter((s) => s && s.security && s.security.status);
  if (!rows.length) return '';
  const counts = { verified: 0, risk: 0, withheld: 0, unchecked: 0 };
  for (const s of rows) {
    const k = String(s.security.status);
    if (counts[k] !== undefined) counts[k] += 1;
  }
  const parts = [t('skills.security_summary_verified', { n: counts.verified })];
  if (counts.risk) parts.push(t('skills.security_summary_risk', { n: counts.risk }));
  if (counts.withheld) parts.push(t('skills.security_summary_withheld', { n: counts.withheld }));
  if (counts.unchecked) parts.push(t('skills.security_summary_unchecked', { n: counts.unchecked }));
  const attention = counts.withheld > 0;
  return `<div class="skills-security-summary${attention ? ' needs-attention' : ''}">`
    + `<span class="skills-security-summary-text">${escapeHtml(parts.join(' · '))}</span>`
    + `<button type="button" class="skills-security-recheck" data-skills-recheck>`
    + `${escapeHtml(t('skills.security_recheck'))}</button>`
    + `</div>`;
}

// Re-render the skill grid + currently selected detail page when the UI
// language changes — descriptions are bilingual now and `pickDesc` returns
// a different string after the locale flip. Detail re-render goes through
// `selectSkillFile` so the SKILL.md frontmatter re-parses and the description picks the
// right locale via `_renderSkillSections`.
window.addEventListener('i18n-change', () => {
  refreshChatUseChips();
  if (_skillsCache) renderSkillsGrid(_skillsCache);
  if (_selectedSkill?.id && _selectedSkill?.source) {
    // Re-read the same file the user was viewing; null nodeEl preserves
    // the current tree highlight (selectSkillFile is tolerant of null).
    selectSkillFile(_selectedSkill.source, _selectedSkill.id, 'SKILL.md', null)
      .catch(() => { /* ignore */ });
  }
});
let _expandedDirs = new Set(); // keys like "source:id" or "source:id/subdir"
let _skillTreeCache = new Map(); // key: "source:id" → tree array

// Cross-module hook (renderer is classic scripts — top-level let/const are
// visible across files per PC/CLAUDE.md §8). Called from
// `conversation.js::_mountCreatedSkillChip` whenever the commander writes
// `<<<skill-file>>>` blocks into a skill the user might be viewing in the
// detail panel. Without this, the file tree on the detail page keeps showing
// the pre-edit set of files until the user navigates away and back.
// `id` matches any source (custom + marketplace) — commander writes flow
// through `updateAgentSpec` / `_applySkillContainerEdit` for both sources,
// so we don't filter by source here. If the user is currently viewing the
// affected skill AND the source panel is expanded, also re-fetch the tree
// so the new files appear without a manual refresh.
async function invalidateSkillTreeCacheFor(skillId) {
  if (!skillId) { _skillTreeCache.clear(); return; }
  for (const key of Array.from(_skillTreeCache.keys())) {
    if (key.endsWith(`:${skillId}`)) _skillTreeCache.delete(key);
  }
  if (_selectedSkill?.id !== skillId) return;
  const toggle = document.getElementById('skills-source-toggle');
  const treeEl = document.getElementById('skills-source-tree');
  if (toggle?.getAttribute('aria-expanded') === 'true' && treeEl) {
    await expandSkillTree(_selectedSkill.source, _selectedSkill.id, treeEl);
    _markActiveSkillFileInTree(_selectedSkill.filepath || 'SKILL.md');
  }
}

async function refreshSkillsAfterMarketplaceReconcile() {
  _skillTreeCache.clear();
  await loadSkills(true);
  if (_skillEditMode) return;
  if (_selectedSkill?.id && _isSkillPlatformSource(_selectedSkill.source)) {
    const source = _selectedSkill.source;
    const id = _selectedSkill.id;
    const filepath = _selectedSkill.filepath || 'SKILL.md';
    await selectSkillFile(source, id, filepath, null);
    const toggle = document.getElementById('skills-source-toggle');
    const treeEl = document.getElementById('skills-source-tree');
    if (toggle?.getAttribute('aria-expanded') === 'true' && treeEl) {
      await expandSkillTree(source, id, treeEl);
      _markActiveSkillFileInTree(filepath);
    }
  }
}

async function _refreshOpenSkillsCache() {
  try {
    const openRes = await window.cogseed.invoke('skills.listOpen');
    _openSkillsCache = (openRes && openRes.ok && Array.isArray(openRes.skills)) ? openRes.skills : [];
  } catch { _openSkillsCache = []; }
}

async function _refreshPackagesCache() {
  try {
    const res = await window.cogseed.invoke('packages.list');
    _packagesCache = (res && res.ok && Array.isArray(res.packages)) ? res.packages : [];
  } catch (err) {
    _skillsLog.warn('packages load failed', err);
    _packagesCache = [];
  }
}

// Dev-only: agent-private (`ownerAgent`) skills are hidden from the normal
// list. In dev mode fetch them and merge into the cache (deduped by id+source)
// so the panel can show a separate inspection section grouped by owning agent.
// No-op in production — the IPC is dev-gated and returns nothing there.
async function _mergeAgentPrivateSkills() {
  if (typeof isDevMode !== 'function' || !false || !Array.isArray(_skillsCache)) return;
  try {
    const res = await window.cogseed.invoke('skills.listPrivate');
    const priv = (res && res.ok && Array.isArray(res.skills)) ? res.skills : [];
    if (!priv.length) return;
    const key = (s) => `${s.id} ${s.source}`;
    const seen = new Set(_skillsCache.map(key));
    const merged = priv
      .map((s) => ({ ...s, source: _skillSource(s.source) }))
      .filter((s) => !seen.has(key(s)));
    if (merged.length) _skillsCache = _skillsCache.concat(merged);
  } catch { /* dev-only tab; ignore */ }
}

async function loadSkills(forceRefresh) {
  if (_skillsLoadInFlight) {
    if (!forceRefresh) return _skillsLoadInFlight;
    await _skillsLoadInFlight.catch(() => {});
  }
  if (_skillsCache && !forceRefresh) {
    // External packages are installed by an out-of-process CLI, so the
    // trusted skills cache can still be current while the open-tier list has
    // changed underneath us. Refresh it whenever the Skills page is revisited.
    await _refreshOpenSkillsCache();
    await _refreshPackagesCache();
    renderSkillsList(_skillsCache);
    return;
  }
  _skillsLoadInFlight = (async () => {
    try {
      const res = await apiFetch(forceRefresh ? '/api/skills/list?force=1' : '/api/skills/list');
      const data = await res.json();
      // Open-tier skills (from external packages + global folders) are
      // read-only and live in a separate listing; fetched alongside so the
      // panel can show them under their own group with a source badge.
      await _refreshOpenSkillsCache();
      await _refreshPackagesCache();
      if (data.ok) {
        _skillsCache = (data.skills || []).map((s) => ({
          ...s,
          source: _skillSource(s.source),
        })).sort((a, b) => {
          const ka = _skillNameSortKey(a);
          const kb = _skillNameSortKey(b);
          if (ka < kb) return -1;
          if (ka > kb) return 1;
          return String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true, sensitivity: 'base' });
        });
        await _mergeAgentPrivateSkills();
        renderSkillsList(_skillsCache);
      }
    } catch (e) {
      _skillsLog.error('load skills failed', e);
    } finally {
      _skillsLoadInFlight = null;
    }
  })();
  return _skillsLoadInFlight;
}

function _skillNameSortKey(skill) {
  const name = String(skill?.name || skill?.id || '');
  return (typeof pinyinSortKey === 'function') ? pinyinSortKey(name) : name.toLowerCase();
}

function renderSkillsList(skills) { renderSkillsGrid(skills); }

// Active category-chip selection for the Skills page. Empty string = "All";
// matches `_mpState.category` semantics in marketplace.js.
let _skillsActiveCategory = '';

function renderSkillsGrid(skills) {
  const emptyEl = document.getElementById('skills-empty');
  const chipsHost = document.getElementById('skills-categories');
  const gridEl = document.getElementById('skills-grid');
  if (!gridEl) return;

  if (!skills.length) {
    if (chipsHost) chipsHost.innerHTML = '';
    // Even with no editable skills, open-tier skills (packages/global) may
    // exist — render them so they're visible + togglable.
    const openHtml = _openSkillsSectionHtml();
    if (openHtml) {
      gridEl.classList.add('is-sectioned');
      gridEl.innerHTML = openHtml;
      _wireOpenSkillCards(gridEl);
      if (emptyEl) emptyEl.style.display = 'none';
      return;
    }
    gridEl.classList.remove('is-sectioned');
    gridEl.innerHTML = '';
    if (emptyEl) {
      if (typeof _mpUpdateInstallingEmptyStates === 'function') _mpUpdateInstallingEmptyStates();
      else emptyEl.textContent = t('skills.empty');
      emptyEl.style.display = '';
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const useTitle = escapeHtml(t('skills.use_tooltip'));
  const moreTitle = escapeHtml(t('skills.more_actions'));
  const lang = getLang();
  const customChipLabel = t('skills.custom_group');
  const marketplaceGroupLabel = (() => {
    const raw = t('skills.builtin_group');
    return (raw && raw !== 'skills.builtin_group') ? raw : t('skills.source_marketplace');
  })();
  const allLabel = (() => {
    const raw = t('marketplace.all');
    return (raw && raw !== 'marketplace.all') ? raw : 'All';
  })();

  // Chip strip — `_mpCategoriesCache` is defined in marketplace.js (flat top-level scope).
  // Missing categories and non-registry category codes are treated as General.
  const canonicalCategoryCode = (code) => {
    return typeof _mpCanonicalCategoryCode === 'function'
      ? _mpCanonicalCategoryCode(code)
      : String(code || '').trim();
  };
  const cats = (typeof _mpCategoriesCache !== 'undefined' && _mpCategoriesCache) || [];
  const knownCodes = _knownCategoryCodes(cats);
  const rawCodesPresent = new Set(skills.map((s) => canonicalCategoryCode(s && s.category)));
  const unknownCodes = [...rawCodesPresent].filter((c) => c && !knownCodes.has(c)).sort();
  if (unknownCodes.length && typeof _mpMaybeRefreshCategoriesForCodes === 'function') {
    _mpMaybeRefreshCategoriesForCodes(unknownCodes);
  }
  const codesPresent = new Set([...rawCodesPresent].map((c) => _effectiveCategoryCode(c, knownCodes)));
  const chipCodes = [];
  const chipCodeSeen = new Set();
  for (const c of cats) {
    const code = canonicalCategoryCode(c && c.code);
    if (!code || !codesPresent.has(code) || chipCodeSeen.has(code)) continue;
    chipCodes.push({ code, label: pickLocalizedName(c, lang) || code });
    chipCodeSeen.add(code);
  }
  if (codesPresent.has('general') && !chipCodeSeen.has('general')) {
    chipCodes.push({ code: 'general', label: _generalCategoryLabel(lang) });
    chipCodeSeen.add('general');
  }
  if (_skillsActiveCategory === '__uncategorized__' || _skillsActiveCategory === '__unknown__') {
    _skillsActiveCategory = codesPresent.has('general') ? 'general' : '';
  }
  if (_skillsActiveCategory && !chipCodes.some((c) => c.code === _skillsActiveCategory)) {
    _skillsActiveCategory = '';
  }

  if (chipsHost) {
    const allActive = _skillsActiveCategory === '' ? ' is-active' : '';
    const chipsHtml = [
      `<button type="button" class="marketplace-chip${allActive}" data-skills-cat="">${escapeHtml(allLabel)}</button>`,
      ...chipCodes.map((c) => {
        const active = _skillsActiveCategory === c.code ? ' is-active' : '';
        return `<button type="button" class="marketplace-chip${active}" data-skills-cat="${escapeHtml(c.code)}">${escapeHtml(c.label)}</button>`;
      }),
    ].join('');
    chipsHost.innerHTML = chipsHtml;
    chipsHost.querySelectorAll('[data-skills-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _skillsActiveCategory = btn.dataset.skillsCat || '';
        if (_skillsCache) renderSkillsGrid(_skillsCache);
      });
    });
  }

  const filtered = skills.filter((s) => {
    if (_skillsActiveCategory === '') return true;
    return _effectiveCategoryCode(s && s.category, knownCodes) === _skillsActiveCategory;
  });

  const cardHtml = (s) => {
    const desc = pickDesc(s, lang).trim();
    const descClass = desc ? 'skill-card-desc' : 'skill-card-desc is-empty';
    const descText = desc || t('skills.no_desc');
    const moreBtn = `<button type="button" class="skill-card-more" data-skill-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const enabled = s.enabled !== false;
    const cardChips = _skillCardChipsHtml(s);
    const withheld = _isSkillWithheld(s);
    const usable = enabled && !withheld;
    const thisUseTitle = withheld ? escapeHtml(t('skills.security_withheld_hint')) : useTitle;
    return `
      <div class="skill-card${enabled ? '' : ' is-disabled'}${withheld ? ' is-withheld' : ''}" data-id="${escapeHtml(s.id)}" data-source="${escapeHtml(s.source || '')}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(s.name)}</span>
          ${_skillSecurityBadgeHtml(s)}
          ${moreBtn}
        </div>
        <div class="${descClass}">${escapeHtml(descText)}</div>
        <div class="skill-card-actions">
          ${cardChips}
          <button type="button" class="skill-card-use" data-skill-use title="${thisUseTitle}" aria-label="${thisUseTitle}" ${usable ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>
            ${escapeHtml(t('skills.use'))}
          </button>
        </div>
      </div>
    `;
  };

  const groups = { custom: [], marketplace: [], private: [] };
  for (const s of filtered) {
    // Agent-private skills (dev-only, merged in `_mergeAgentPrivateSkills`)
    // get their own per-owner sections below; never folded into custom.
    if (s.ownerAgent) { groups.private.push(s); continue; }
    const source = _skillSource(s?.source);
    if (source === 'marketplace') groups.marketplace.push(s);
    else groups.custom.push(s);
  }
  const sectionHtml = (label, list) => {
    if (!list.length) return '';
    return `
      <section class="skills-source-section">
        <div class="skills-source-section-head">
          <span>${escapeHtml(label)}</span>
          <span class="skills-source-section-count">${list.length}</span>
        </div>
        <div class="skills-source-section-grid">
          ${list.map(cardHtml).join('')}
        </div>
      </section>
    `;
  };
  // Dev-only inspection sections — one per owning agent, reusing the same card
  // and section markup. Empty (so absent) in production: the source IPC is
  // dev-gated, so `groups.private` is always empty there.
  let privateHtml = '';
  if (groups.private.length) {
    const baseLabel = t('skills.agent_private_group');
    const byOwner = new Map();
    for (const s of groups.private) {
      const owner = s.ownerAgent || '?';
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(s);
    }
    for (const [owner, list] of byOwner) privateHtml += sectionHtml(`${baseLabel} · ${owner}`, list);
  }
  gridEl.classList.add('is-sectioned');
  gridEl.innerHTML = _skillsSecuritySummaryHtml(filtered)
    + sectionHtml(customChipLabel, groups.custom)
    + sectionHtml(marketplaceGroupLabel, groups.marketplace)
    + privateHtml
    + _openSkillsSectionHtml();
  _wireOpenSkillCards(gridEl);
  _wireSkillsSecurityRecheck(gridEl);
  _wireSkillSecurityPanels(gridEl);

  // Wire card / ▶ / ⋯ click handlers. (Enable/disable lives in the ⋯ menu now.)
  // Scope to editable-tier cards (`data-id`): open-tier cards (`data-open-id`,
  // external/global) are read-only and intentionally not navigable to a detail
  // view — they only carry an enable/disable toggle, wired by
  // `_wireOpenSkillCards`. Binding them here would open a broken detail page
  // (no `data-id`/`data-source` → `invalid source` read).
  for (const card of gridEl.querySelectorAll('.skill-card[data-id]')) {
    const id = card.dataset.id;
    const source = card.dataset.source;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-skill-use]')) {
        e.stopPropagation();
        if (!card.classList.contains('is-disabled') && !card.classList.contains('is-withheld')) {
          const skill = _skillsCache?.find(s => s.id === id && s.source === source);
          useSkill(id, skill?.name || id);
        }
        return;
      }
      if (e.target.closest('[data-skill-more]')) {
        e.stopPropagation();
        _openSkillRowMenu(e.target.closest('[data-skill-more]'), id, source);
        return;
      }
      _showSkillsDetailView(source, id);
    });
  }
}

function _externalPackageRows(openRows) {
  const byName = new Map();
  for (const p of (_packagesCache || [])) {
    if (!p || !p.name) continue;
    byName.set(String(p.name), {
      ...p,
      display_name: String(p.display_name || p.name),
      enabled: p.enabled !== false,
      bin_names: Array.isArray(p.bin_names) ? p.bin_names : [],
    });
  }
  const fallbackCounts = new Map();
  for (const s of (openRows || [])) {
    if (!s || s.source !== 'external' || !s.package_name) continue;
    const packageName = String(s.package_name);
    fallbackCounts.set(packageName, (fallbackCounts.get(packageName) || 0) + 1);
    if (!byName.has(packageName)) {
      byName.set(packageName, {
        name: packageName,
        display_name: packageName,
        kind: s.package_kind || 'skill',
        enabled: s.package_enabled !== false,
        skill_count: 0,
        bin_names: [],
      });
    }
  }
  for (const [name, count] of fallbackCounts.entries()) {
    const row = byName.get(name);
    if (row && !row.skill_count) row.skill_count = count;
  }
  return Array.from(byName.values());
}

function _globalSkillNamespace(row) {
  const id = String(row && row.id || '').trim().toLowerCase();
  if (!id) return '';
  const m = /^([a-z0-9]+)-[a-z0-9]/.exec(id);
  return m ? m[1] : id;
}

function _globalSkillGroupLabel(key) {
  return key || t('skills.global_group');
}

function _globalSkillGroupRows(key) {
  return (_openSkillsCache || []).filter((row) => (
    row
    && row.source === 'global'
    && _globalSkillNamespace(row) === key
  ));
}

function _globalSkillGroupSummary(group) {
  const rows = Array.isArray(group?.rows) ? group.rows : [];
  const names = rows
    .map((row) => String(row?.name || row?.id || '').trim())
    .filter(Boolean)
    .sort((a, b) => _skillNameSortKey({ name: a }).localeCompare(_skillNameSortKey({ name: b })));
  const lang = String(typeof getLang === 'function' ? getLang() : '').toLowerCase();
  const cjk = lang.startsWith('zh') || lang.startsWith('ja');
  const countLabel = t('settings.packages.skills_count', { count: rows.length });
  const separator = cjk ? '、' : ', ';
  const colon = cjk ? '：' : ': ';
  return names.length ? `${countLabel}${colon}${names.join(separator)}` : countLabel;
}

function _groupGlobalSkills(rows) {
  const buckets = new Map();
  for (const row of (rows || [])) {
    const key = _globalSkillNamespace(row);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const entries = [];
  const groupedKeys = new Set();
  for (const [key, list] of buckets) {
    if (list.length >= _GLOBAL_SKILL_GROUP_MIN) {
      groupedKeys.add(key);
      entries.push({ kind: 'group', key, rows: list });
    }
  }
  for (const row of (rows || [])) {
    if (!groupedKeys.has(_globalSkillNamespace(row))) entries.push({ kind: 'skill', row });
  }
  entries.sort((a, b) => {
    const an = a.kind === 'group' ? _globalSkillGroupLabel(a.key) : (a.row.name || a.row.id || '');
    const bn = b.kind === 'group' ? _globalSkillGroupLabel(b.key) : (b.row.name || b.row.id || '');
    return _skillNameSortKey({ name: an }).localeCompare(_skillNameSortKey({ name: bn }));
  });
  return entries;
}

/** Read-only section for open-tier entries. External packages are package
 *  cards. Global folders auto-aggregate skills by the prefix before the first
 *  dash (`lark-*` → `lark`) so machine-shared roots don't become a wall of
 *  one-card-per-recipe rows. Management lives in per-card menus. Returns ''
 *  when none. */
function _openSkillsSectionHtml() {
  const rows = _openSkillsCache || [];
  const externalPackageRows = _externalPackageRows(rows);
  const globalSkillRows = rows.filter((s) => s.source === 'global');
  if (!externalPackageRows.length && !globalSkillRows.length) return '';
  const card = (s) => {
    // Same desc treatment as trusted/platform cards (flex:1, 3-line clamp,
    // empty placeholder) so open-tier cards match them in size and pin the
    // play button to the bottom regardless of description length.
    const descText = String(s.description || '').trim();
    const desc = `<div class="skill-card-desc${descText ? '' : ' is-empty'}">${escapeHtml(descText || t('skills.no_desc'))}</div>`;
    const packageName = s.source === 'external' ? String(s.package_name || '') : '';
    const displayName = String(s.name || s.id || '');
    const kindLabel = packageName ? _packageKindLabel(s.package_kind) : '';
    const packageMetaBits = [];
    if (packageName && packageName !== displayName) packageMetaBits.push(packageName);
    if (kindLabel) packageMetaBits.push(kindLabel);
    const packageMeta = packageMetaBits.length
      ? `<div class="skill-card-meta">${escapeHtml(packageMetaBits.join(' · '))}</div>`
      : '';
    const moreTitle = escapeHtml(t('skills.more_actions'));
    const useTitle = escapeHtml(t('skills.use_tooltip'));
    const enabled = s.enabled !== false;
    const moreAttr = packageName ? 'data-open-more data-open-package-more' : 'data-open-more';
    const moreBtn = `<button type="button" class="skill-card-more" ${moreAttr} title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const packageAttr = packageName ? ` data-open-package-name="${escapeHtml(packageName)}"` : '';
    const sourceAttr = ` data-open-source="${escapeHtml(s.source || '')}"`;
    // "Use" selects the skill in the Commander composer. Disabled when the
    // skill is turned off, mirroring trusted cards.
    const useBtn = `<button type="button" class="skill-card-use" data-open-use title="${useTitle}" aria-label="${useTitle}" ${enabled ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>${escapeHtml(t('skills.use'))}</button>`;
    return `
      <div class="skill-card is-readonly${enabled ? '' : ' is-disabled'}" data-open-id="${escapeHtml(s.id)}"${sourceAttr}${packageAttr}>
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(displayName)}</span>
          ${moreBtn}
        </div>
        ${packageMeta}
        ${desc}
        <div class="skill-card-actions">
          ${useBtn}
        </div>
      </div>`;
  };
  const packageCard = (p) => {
    const packageName = String(p.name || '');
    const packageDisplayName = String(p.display_name || packageName);
    const kindLabel = _packageKindLabel(p.kind);
    const metaBits = [];
    if (kindLabel) metaBits.push(kindLabel);
    if (p.skill_count) metaBits.push(t('settings.packages.skills_count', { count: p.skill_count }));
    if (p.bin_names && p.bin_names.length) metaBits.push(p.bin_names.map((b) => `\`${b}\``).join(' '));
    const meta = metaBits.length
      ? `<div class="skill-card-meta">${escapeHtml(metaBits.join(' · '))}</div>`
      : '';
    const moreTitle = escapeHtml(t('skills.more_actions'));
    return `
      <div class="skill-card is-readonly${p.enabled ? '' : ' is-disabled'}" data-open-package-card="1" data-open-package-name="${escapeHtml(packageName)}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(packageDisplayName)}</span>
          <button type="button" class="skill-card-more" data-open-package-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
        </div>
        ${meta}
      </div>`;
  };
  const globalGroupCard = (group) => {
    const name = _globalSkillGroupLabel(group.key);
    const expanded = _expandedGlobalSkillGroups.has(group.key);
    const enabled = (group.rows || []).some((row) => row.enabled !== false);
    const label = expanded ? t('skills.global_group_collapse') : t('skills.global_group_expand');
    const icon = _skillUiIconHtml(expanded ? 'chevron-down' : 'chevron-right', 'skill-card-disclosure-icon');
    const moreTitle = escapeHtml(t('skills.more_actions'));
    const summary = _globalSkillGroupSummary(group);
    return `
      <div class="skill-card is-readonly${enabled ? '' : ' is-disabled'} skill-card--global-group" data-global-skill-group="${escapeHtml(group.key)}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(name)}</span>
          <button type="button" class="skill-card-more" data-global-skill-group-more="${escapeHtml(group.key)}" title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
        </div>
        <div class="skill-card-desc skill-card-desc--global-summary">${escapeHtml(summary)}</div>
        <div class="skill-card-actions">
          <button type="button" class="skill-card-disclosure" data-global-skill-group-toggle="${escapeHtml(group.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
            ${icon}
            <span>${escapeHtml(label)}</span>
          </button>
        </div>
      </div>`;
  };
  // Split external packages and global folders into their own sections so
  // user-installed packages read distinctly from machine-global skill dirs
  // (both are open-tier, but they have different provenance/management). A
  // short hint next to each title explains the provenance to the user.
  const globalSection = (list) => {
    if (!list.length) return '';
    const hint = t('skills.global_group_hint');
    const hintHtml = hint ? `<span class="skills-source-section-hint">${escapeHtml(hint)}</span>` : '';
    const grouped = _groupGlobalSkills(list);
    const tiles = [];
    for (const item of grouped) {
      if (item.kind === 'skill') {
        tiles.push(card(item.row));
        continue;
      }
      tiles.push(globalGroupCard(item));
      if (_expandedGlobalSkillGroups.has(item.key)) {
        for (const row of item.rows) tiles.push(card(row));
      }
    }
    return `
    <section class="skills-source-section skills-source-section--global">
      <div class="skills-source-section-head">
        <span>${escapeHtml(t('skills.global_group'))}</span>
        <span class="skills-source-section-count">${list.length}</span>
        ${hintHtml}
      </div>
      <div class="skills-source-section-grid">${tiles.join('')}</div>
    </section>`;
  };
  const externalHtml = externalPackageRows.length
    ? `
    <section class="skills-source-section">
      <div class="skills-source-section-head">
        <span>${escapeHtml(t('skills.external_group'))}</span>
        <span class="skills-source-section-count">${externalPackageRows.length}</span>
        <span class="skills-source-section-hint">${escapeHtml(t('skills.external_group_hint'))}</span>
      </div>
      <div class="skills-source-section-grid">${externalPackageRows.map(packageCard).join('')}</div>
    </section>`
    : '';
  return externalHtml
    + globalSection(globalSkillRows);
}

/** Re-run trust verification without spawning one scanner per skill at once. */
function _wireSkillsSecurityRecheck(gridEl) {
  const btn = gridEl.querySelector('[data-skills-recheck]');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const original = btn.textContent;
    btn.textContent = t('skills.security_rechecking');
    try {
      const ids = (_skillsCache || [])
        .filter((s) => s && s.security && s.security.status)
        .map((s) => s.id);
      for (const id of ids) {
        try {
          await window.cogseed.invoke('skills.trust.reverify', { skillId: id });
        } catch { /* one unreadable skill must not abort the sweep */ }
      }
      await loadSkills(true);
    } catch {
      btn.textContent = original;
    } finally {
      btn.dataset.busy = '';
    }
  });
}

function _wireSkillSecurityPanels(gridEl) {
  for (const btn of gridEl.querySelectorAll('[data-skill-security]')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = btn.dataset.skillSecurity || '';
      const skill = (_skillsCache || []).find((s) => s && String(s.id) === id);
      if (!skill) return;
      const heading = `${skill.name || id} · ${t('skills.secpanel_title')}`;
      await uiAlert(`${heading}\n\n${_skillSecurityPanelText(skill)}`);
    });
  }
}

function _wireOpenSkillCards(gridEl) {
  for (const btn of gridEl.querySelectorAll('[data-global-skill-group-toggle]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.globalSkillGroupToggle || '';
      if (!key) return;
      if (_expandedGlobalSkillGroups.has(key)) _expandedGlobalSkillGroups.delete(key);
      else _expandedGlobalSkillGroups.add(key);
      renderSkillsList(_skillsCache || []);
    });
  }
  for (const btn of gridEl.querySelectorAll('[data-global-skill-group-more]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.globalSkillGroupMore || '';
      if (key) _openGlobalSkillGroupMenu(btn, key);
    });
  }
  for (const card of gridEl.querySelectorAll('.skill-card[data-open-id], .skill-card[data-open-package-card]')) {
    const id = card.dataset.openId;
    const source = card.dataset.openSource || '';
    const useBtn = card.querySelector('[data-open-use]');
    if (useBtn) {
      useBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (card.classList.contains('is-disabled')) return;
        const packageName = card.dataset.openPackageName || '';
        const row = _openSkillsCache.find((s) => (
          s.id === id
          && (s.source || '') === source
          && (source !== 'external' || String(s.package_name || '') === packageName)
        ));
        useSkill(id, (row && row.name) || id);
      });
    }
    const menuBtn = card.querySelector('[data-open-more]');
    const packageOnlyMenuBtn = card.querySelector('[data-open-package-more]');
    if (packageOnlyMenuBtn && card.dataset.openPackageCard === '1') {
      packageOnlyMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const packageName = card.dataset.openPackageName || '';
        const pkg = (_packagesCache || []).find((p) => String(p.name || '') === packageName);
        if (pkg) {
          const packageDisplayName = String(pkg.display_name || packageName);
          _openExternalPackageMenu(packageOnlyMenuBtn, {
            id: packageName,
            package_name: packageName,
            package_display_name: packageDisplayName,
            package_kind: pkg.kind,
            package_enabled: pkg.enabled !== false,
            enabled: pkg.enabled !== false,
          });
        }
      });
    } else if (menuBtn) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (source === 'external') {
          const packageName = card.dataset.openPackageName || '';
          const row = _openSkillsCache.find((s) => (
            s.id === id
            && s.source === 'external'
            && String(s.package_name || '') === packageName
          ));
          if (row) _openExternalPackageMenu(menuBtn, row);
          return;
        }
        if (source === 'global') _openSkillRowMenu(menuBtn, id, source);
      });
    }
  }
}

async function _setOpenSkillEnabled(id, nextEnabled) {
  try {
    const res = await window.cogseed.invoke('skills.setEnabled', { id, enabled: nextEnabled });
    if (!res || !res.ok) { await uiAlert(t('component.toggle_failed')); return false; }
    // enable/disable is keyed by id; the same skill can appear under both
    // external and global, so flip every matching row's optimistic state.
    for (const r of _openSkillsCache) if (r.id === id) r.enabled = nextEnabled;
    renderSkillsList(_skillsCache || []);
    return true;
  } catch {
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

async function _setGlobalSkillGroupEnabled(key, nextEnabled) {
  const rows = _globalSkillGroupRows(key);
  const targetIds = new Set(rows
    .filter((row) => (row.enabled !== false) !== nextEnabled)
    .map((row) => row.id));
  if (!targetIds.size) return true;
  try {
    const results = await Promise.allSettled(Array.from(targetIds).map((id) => (
      window.cogseed.invoke('skills.setEnabled', { id, enabled: nextEnabled })
    )));
    if (results.some((res) => res.status === 'rejected' || !res.value || !res.value.ok)) {
      await loadSkills(true);
      await uiAlert(t('component.toggle_failed'));
      return false;
    }
    for (const row of (_openSkillsCache || [])) {
      if (targetIds.has(row.id)) row.enabled = nextEnabled;
    }
    renderSkillsList(_skillsCache || []);
    return true;
  } catch {
    await loadSkills(true);
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

function _packageKindLabel(kind) {
  if (kind === 'skill' || kind === 'cli' || kind === 'both') {
    const label = t(`settings.packages.kind_${kind}`);
    return label && label !== `settings.packages.kind_${kind}` ? label : kind;
  }
  return '';
}

function _packageActionBusyLabel(command) {
  if (command === 'update') return t('settings.packages.updating');
  if (command === 'enable') return t('settings.packages.enabling');
  if (command === 'disable') return t('settings.packages.disabling');
  if (command === 'remove') return t('settings.packages.removing');
  return t('common.loading');
}

// Per-card busy overlay shown while an external-package action (update /
// enable / disable / remove) runs — these spawn orkas-pkg.cjs (git pull +
// optional dep install) and can take several seconds. Without it the card
// sits inert with no feedback. Cleared by the post-action re-render on
// success, or in `_runOpenPackageAction`'s finally on the error path.
function _setSkillCardBusy(card, command) {
  if (!card) return;
  card.classList.add('is-busy');
  card.setAttribute('aria-busy', 'true');
  if (card.querySelector('.skill-card-busy')) return;
  const overlay = document.createElement('div');
  overlay.className = 'skill-card-busy';
  overlay.innerHTML = `<span class="skill-card-busy-spinner" aria-hidden="true"></span>`
    + `<span class="skill-card-busy-label">${escapeHtml(_packageActionBusyLabel(command))}</span>`;
  card.appendChild(overlay);
}

function _clearSkillCardBusy(card) {
  if (!card) return;
  card.classList.remove('is-busy');
  card.removeAttribute('aria-busy');
  card.querySelector('.skill-card-busy')?.remove();
}

function _openExternalPackageMenu(anchorBtn, row) {
  const packageName = String(row?.package_name || '');
  if (!packageName) return;
  const packageDisplayName = String(row?.package_display_name || packageName);
  const card = anchorBtn.closest('.skill-card');
  let menu = document.getElementById('skill-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skill-row-menu';
    menu.className = 'skill-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.packageName === packageName
    && menu.dataset.openSkillId === row.id
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeSkillRowMenu(); return; }
  _closeSkillRowMenu();
  menu.dataset.packageName = packageName;
  menu.dataset.openSkillId = row.id;
  menu.dataset.source = 'external';
  const packageEnabled = row.package_enabled !== false;
  const toggleLabel = packageEnabled ? t('component.disable') : t('component.enable');
  menu.innerHTML = [
    `<div class="skill-row-menu-item" data-action="update-package">${escapeHtml(t('settings.packages.update'))}</div>`,
    `<div class="skill-row-menu-item" data-action="toggle-package">${escapeHtml(toggleLabel)}</div>`,
    `<div class="skill-row-menu-item is-danger" data-action="remove-package">${escapeHtml(t('settings.packages.remove'))}</div>`,
  ].join('');
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
  anchorBtn.closest('.skill-card')?.classList.add('is-menu-open');
  _positionSkillRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.skill-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeSkillRowMenu();
      if (action === 'update-package') {
        await _runOpenPackageAction('update', packageName, card, packageDisplayName);
      } else if (action === 'toggle-package') {
        await _runOpenPackageAction(packageEnabled ? 'disable' : 'enable', packageName, card, packageDisplayName);
      } else if (action === 'remove-package') {
        const ok = await uiConfirmDanger({
          title: t('settings.packages.remove_title', { name: packageDisplayName }),
          message: t('settings.packages.remove_msg'),
          dangerLabel: t('settings.packages.remove'),
        });
        if (ok) await _runOpenPackageAction('remove', packageName, card, packageDisplayName);
      }
    });
  }
}

function _openGlobalSkillGroupMenu(anchorBtn, key) {
  const rows = _globalSkillGroupRows(key);
  if (!rows.length) return;
  let menu = document.getElementById('skill-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skill-row-menu';
    menu.className = 'skill-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.globalSkillGroup === key
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeSkillRowMenu(); return; }
  _closeSkillRowMenu();
  menu.dataset.globalSkillGroup = key;
  menu.dataset.source = 'global-group';
  const enabled = rows.some((row) => row.enabled !== false);
  const toggleLabel = enabled ? t('component.disable') : t('component.enable');
  menu.innerHTML = `<div class="skill-row-menu-item" data-action="toggle-global-group">${escapeHtml(toggleLabel)}</div>`;
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
  anchorBtn.closest('.skill-card')?.classList.add('is-menu-open');
  _positionSkillRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.skill-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeSkillRowMenu();
      if (action === 'toggle-global-group') {
        await _setGlobalSkillGroupEnabled(key, !enabled);
      }
    });
  }
}

async function _runOpenPackageAction(command, packageName, cardEl, packageDisplayName) {
  const card = cardEl && cardEl.isConnected ? cardEl : null;
  const displayName = String(packageDisplayName || packageName);
  if (card) _setSkillCardBusy(card, command);
  const startedAt = Date.now();
  if (window.Monitor) (() => {})('package_action', { surface: 'skills', command });
  try {
    const res = await window.cogseed.invoke('packages.action', { command, name: packageName });
    if (!res || res.ok === false) {
      const errorMessage = (res && res.error) || t('settings.packages.action_failed');
      if (window.Monitor) {
        (() => {})('package_action_result', {
          surface: 'skills',
          command,
          result: 'failure',
          duration_ms: Date.now() - startedAt,
        });
        (() => {})('package_action', {
          surface: 'skills',
          command,
          error_type: 'runtime',
          error_message: errorMessage,
        });
      }
      await uiAlert((res && res.error) || t('settings.packages.action_failed'));
      return;
    }
    if (window.Monitor) {
      (() => {})('package_action_result', {
        surface: 'skills',
        command,
        result: 'success',
        duration_ms: Date.now() - startedAt,
      });
    }
    if (command === 'update' && typeof uiToast === 'function') {
      uiToast(t('settings.packages.updated', { name: displayName }), { variant: 'success' });
    }
    await loadSkills(true);
  } catch (err) {
    if (window.Monitor) {
      (() => {})('package_action_result', {
        surface: 'skills',
        command,
        result: 'failure',
        duration_ms: Date.now() - startedAt,
      });
      (() => {})('package_action', {
        surface: 'skills',
        command,
        error_type: 'ipc',
        error_message: (err && err.message) || String(err || 'unknown'),
      });
    }
    _skillsLog.warn('package action failed', err);
    await uiAlert(t('settings.packages.action_failed'));
  } finally {
    // Success re-renders the grid (card replaced), so this only fires on the
    // failure path where the original card is still mounted.
    if (card && card.isConnected) _clearSkillCardBusy(card);
  }
}

async function _flipOpenSkillEnabled(id) {
  const row = (_openSkillsCache || []).find((s) => s.id === id);
  return _setOpenSkillEnabled(id, !(row && row.enabled));
}

/** Flip a skill's enabled override (used by both the ⋯ menu's toggle item
 *  and the detail-page enable/disable button). On failure, alerts and does
 *  not mutate UI state; on success, refreshes the grid + detail page. */
async function _flipSkillEnabled(skillId, nextEnabled) {
  try {
    const res = await window.cogseed.invoke('skills.setEnabled', { id: skillId, enabled: nextEnabled });
    if (!res || !res.ok) {
      await uiAlert(t('component.toggle_failed'));
      return false;
    }
    const cached = _skillsCache?.find((s) => s.id === skillId);
    if (cached) cached.enabled = nextEnabled;
    await loadSkills();
    if (_selectedSkill?.id === skillId) {
      _renderSkillEnabledButton({ id: skillId, enabled: nextEnabled });
    }
    return true;
  } catch (err) {
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

// ─── View switching: grid ↔ detail ─────────────────────────────────────

// Back from the skill detail/edit view. An unconfirmed URL-import draft (a
// placeholder that was never authored — set in `_saveSkillFromUrl`, cleared
// once real content is written or the user clicks Done) prompts before
// leaving: the user explicitly chooses to discard the half-finished import or
// keep working. Authored/committed skills and ordinary edits just leave.
async function _onSkillsBack() {
  if (_importDraftId) {
    const discard = await uiConfirm({
      message: t('skills.import.back_confirm'),
      okLabel: t('skills.import.back_discard'),
      cancelLabel: t('skills.import.back_continue'),
    });
    if (!discard) return; // "keep editing" — stay in the edit chat
    const draftId = _importDraftId;
    _importDraftId = null;
    try {
      const r = await window.cogseed.invoke('skills.discardImportDraft', { id: draftId });
      if (r && r.discarded) { _skillsCache = null; await loadSkills(); }
    } catch (_) { /* best effort — a leftover empty draft is non-fatal */ }
  }
  _showSkillsGridView();
}

function _showSkillsGridView() {
  const grid = document.getElementById('skills-grid-view');
  const detail = document.getElementById('skills-detail-view');
  // Exit edit mode if active so chat panel is hidden too.
  if (_skillEditMode) {
    // Abort any in-flight reply (same reason as toggleSkillEditMode exit
    // branch — singleton controller, leaving pending leaks streaming UI).
    try { _skillChatCtrl?.abort(); } catch (_) { /* ignore */ }
    _skillEditMode = false;
    _skillEditSkillId = null;
    const chatCol = document.getElementById('skills-chat-col');
    if (chatCol) chatCol.style.display = 'none';
    _updateEditButtonLabel();
  }
  if (grid) grid.style.display = 'flex';
  if (detail) detail.style.display = 'none';
  // Collapse source tree so next detail open starts clean.
  const panel = document.getElementById('skills-source-panel');
  const toggle = document.getElementById('skills-source-toggle');
  if (panel) panel.style.display = 'none';
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  // Drop any pinned body min-height from the previous session.
  const body = document.getElementById('skills-detail-body');
  if (body) body.style.minHeight = '';
  _selectedSkill = null;
  _closeSkillRowMenu();
}

async function _showSkillsDetailView(source, id, opts = {}) {
  source = _skillSource(source);
  const grid = document.getElementById('skills-grid-view');
  const detail = document.getElementById('skills-detail-view');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'flex';
  await loadSkills(true);
  _dropSkillTreeCache(source, id);
  // Reset scroll only on initial detail entry — file switching inside the
  // tree (handled by selectSkillFile) preserves position.
  const detailContent = document.getElementById('skills-detail-content');
  if (detailContent) detailContent.scrollTop = 0;
  // Clear stale body min-height pin from a previous detail session so the
  // body can shrink/grow naturally for the fresh skill.
  const body = document.getElementById('skills-detail-body');
  if (body) body.style.minHeight = '';
  await selectSkillFile(source, id, 'SKILL.md', null);
  // Every fresh detail entry starts with source visible; the toggle's
  // collapsed state is local to the current view and is not remembered.
  if (opts.expandSource !== false) await _ensureSkillsSourceExpanded();
}

// Switch the detail pane to the "installed as an external package" state.
// A URL import can resolve to a verbatim package (in the per-user packages
// tree) rather than an editable skill; main already removed the placeholder
// skill, so there is no skill content to render. Point the user to package
// management instead.
function _showSkillAsPackageState(name) {
  _skillEditMode = false;
  _skillEditSkillId = null;
  _selectedSkill = null;
  _skillsCache = null;
  const grid = document.getElementById('skills-grid-view');
  const detail = document.getElementById('skills-detail-view');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'flex';
  const detailCol = document.getElementById('skills-detail-col');
  if (detailCol) detailCol.style.display = 'none';
  const chatCol = document.getElementById('skills-chat-col');
  if (chatCol) chatCol.style.display = 'none';
  const panel = document.getElementById('skills-as-package');
  if (panel) panel.style.display = '';
  const nameEl = document.getElementById('skills-as-package-name');
  if (nameEl) nameEl.textContent = name || t('skills.as_package.title');
  const descEl = document.getElementById('skills-as-package-desc');
  if (descEl) descEl.textContent = t('skills.as_package.desc');
  const manageBtn = document.getElementById('skills-as-package-manage');
  if (manageBtn) manageBtn.onclick = () => {
    _showSkillsGridView();
    Promise.resolve(loadSkills(true)).finally(() => {
      _scrollPackageCardIntoView(name);
    });
  };
  const backBtn = document.getElementById('skills-as-package-back');
  if (backBtn) backBtn.onclick = () => _onSkillsBack();
  // Placeholder skill is gone and a package may now contribute skills —
  // refresh the grid in the background so a later "Back" shows fresh state.
  Promise.resolve().then(() => loadSkills()).catch(() => {});
}

function _scrollPackageCardIntoView(packageName) {
  const wanted = String(packageName || '');
  const cards = document.querySelectorAll('.skill-card[data-open-package-name]');
  for (const card of cards) {
    if (String(card.dataset.openPackageName || '') !== wanted) continue;
    card.scrollIntoView({ block: 'center' });
    card.classList.add('is-menu-open');
    setTimeout(() => card.classList.remove('is-menu-open'), 1200);
    return;
  }
  document.querySelector('.skills-source-section')?.scrollIntoView({ block: 'start' });
}

function _dropSkillTreeCache(source, id) {
  const key = `${_skillSource(source)}:${id}`;
  _skillTreeCache.delete(key);
}

async function refreshSelectedSkillDetail() {
  if (_skillEditMode || !_selectedSkill?.id || !_selectedSkill?.source) return;
  const detail = document.getElementById('skills-detail-view');
  if (!detail || detail.style.display === 'none') return;
  const source = _selectedSkill.source;
  const id = _selectedSkill.id;
  const filepath = _selectedSkill.filepath || 'SKILL.md';
  _dropSkillTreeCache(source, id);
  await selectSkillFile(source, id, filepath, null);
  const toggle = document.getElementById('skills-source-toggle');
  if (toggle?.getAttribute('aria-expanded') === 'true') {
    await _ensureSkillsSourceExpanded();
  }
}

async function _ensureSkillsSourceExpanded() {
  const toggle = document.getElementById('skills-source-toggle');
  const panel = document.getElementById('skills-source-panel');
  const treeEl = document.getElementById('skills-source-tree');
  if (!toggle || !panel || !treeEl || !_selectedSkill) return;
  panel.style.display = '';
  toggle.setAttribute('aria-expanded', 'true');
  treeEl.innerHTML = `<div style="color:#94a3b8;padding:8px 12px">${escapeHtml(t('skills.loading'))}</div>`;
  await expandSkillTree(_selectedSkill.source, _selectedSkill.id, treeEl);
  _markActiveSkillFileInTree(_selectedSkill.filepath || 'SKILL.md');
}

// Highlight whichever file row in the source tree corresponds to the file
// currently rendered in the body — initial load points at SKILL.md, later
// changes track user clicks via `selectSkillFile`'s nodeEl path.
function _markActiveSkillFileInTree(filepath) {
  const treeEl = document.getElementById('skills-source-tree');
  if (!treeEl) return;
  treeEl.querySelectorAll('.skill-tree-node').forEach(n => n.classList.remove('active'));
  // Use attribute selector with quoted value — file paths can contain `.`,
  // `/` etc. that confuse class-based selectors.
  const safe = String(filepath).replace(/(["\\])/g, '\\$1');
  const target = treeEl.querySelector(`.skill-tree-file[data-path="${safe}"]`);
  if (target) target.classList.add('active');
}

// ─── Per-card ⋯ popover menu (custom / platform / open-tier) ──────────

function _openSkillRowMenu(anchorBtn, id, source) {
  let menu = document.getElementById('skill-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skill-row-menu';
    menu.className = 'skill-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.skillId === id
    && menu.dataset.source === source
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeSkillRowMenu(); return; }
  _closeSkillRowMenu();
  menu.dataset.skillId = id;
  menu.dataset.source = source;
  // Edit/delete are gated: custom always allowed; built-in only in dev mode.
  // Enable/disable is always shown (lives in this menu now since cards no
  // longer carry a toggle).
  // Open-tier (external package / global folder): package/filesystem managed —
  // enable/disable only, no edit/delete/upload. Its rows live in a separate
  // cache.
  const isOpenTier = source === 'external' || source === 'global';
  const cached = isOpenTier
    ? (_openSkillsCache || []).find((s) => s.id === id)
    : _skillsCache?.find((s) => s.id === id && s.source === source);
  const enabled = cached ? cached.enabled !== false : true;
  const canEdit = !isOpenTier && (source === 'custom' || (_isSkillPlatformSource(source) && false));
  // Dev-only entry on marketplace items: tag the label so the user knows this isn't a
  // normal user capability (mirrors marketplace.upload's "(dev)" treatment).
  const editLabelSuffix = (_isSkillPlatformSource(source) && false) ? t('common.dev_suffix') : '';
  const items = [];
  if (canEdit) {
    items.push(`<div class="skill-row-menu-item" data-action="edit">${escapeHtml(t('skills.edit') + editLabelSuffix)}</div>`);
  }
  items.push(
    `<div class="skill-row-menu-item" data-action="toggle-enabled">${escapeHtml(enabled ? t('component.disable') : t('component.enable'))}</div>`,
  );
  if (canEdit) {
    items.push(`<div class="skill-row-menu-item is-danger" data-action="delete">${escapeHtml(t('skills.delete'))}</div>`);
  }
  menu.innerHTML = items.join('');
  // While menu open, force the source card's ⋯ visible.
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
  anchorBtn.closest('.skill-card')?.classList.add('is-menu-open');
  _positionSkillRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.skill-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeSkillRowMenu();
      if (action === 'edit') {
        await _showSkillsDetailView(source, id);
        if (_selectedSkill && _selectedSkill.id === id && _selectedSkill.source === source) {
          await toggleSkillEditMode();
        }
      } else if (action === 'delete') {
        // Mimic the existing delete flow (from detail page) but for any card.
        _selectedSkill = { source, id, filepath: 'SKILL.md', name: '' };
        await deleteSelectedSkill();
      } else if (action === 'toggle-enabled') {
        if (isOpenTier) {
          await _flipOpenSkillEnabled(id);
        } else {
          const cur = _skillsCache?.find((s) => s.id === id && s.source === source);
          const nextEnabled = !(cur ? cur.enabled !== false : true);
          await _flipSkillEnabled(id, nextEnabled);
        }
      }
    });
  }
}

function _closeSkillRowMenu() {
  const menu = document.getElementById('skill-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.skillId;
    delete menu.dataset.openSkillId;
    delete menu.dataset.packageName;
    delete menu.dataset.globalSkillGroup;
    delete menu.dataset.source;
  }
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
}

function _positionSkillRowMenu(menuEl, anchorEl) {
  menuEl.style.display = 'block';
  menuEl.style.left = '-9999px';
  menuEl.style.top = '-9999px';
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

// ─── "View source" collapsible (detail page bottom) ─────────────────

async function _toggleSkillsSource() {
  const toggle = document.getElementById('skills-source-toggle');
  const panel = document.getElementById('skills-source-panel');
  if (!toggle || !panel || !_selectedSkill) return;
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  if (expanded) {
    panel.style.display = 'none';
    toggle.setAttribute('aria-expanded', 'false');
    return;
  }
  await _ensureSkillsSourceExpanded();
}

async function expandSkillTree(source, id, childrenEl) {
  source = _skillSource(source);
  const key = `${source}:${id}`;
  let tree = _skillTreeCache.get(key);
  if (!tree) {
    try {
      const res = await apiFetch(`/api/skills/tree?source=${source}&id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.ok) return;
      tree = data.tree || [];
      _skillTreeCache.set(key, tree);
    } catch (e) {
      _skillsLog.error('skill tree failed', e);
      return;
    }
  }
  childrenEl.innerHTML = renderTreeNodes(tree, source, id, 1);
  bindTreeNodes(childrenEl, source, id);
}

// Tree icons are centralized in modules/icons.js; classes here only control sizing/color.
const ICON_FOLDER_CLOSED = _skillUiIconHtml('folder', 'skill-tree-node-svg');
const ICON_FOLDER_OPEN = _skillUiIconHtml('folder-open', 'skill-tree-node-svg');
const ICON_FILE = _skillUiIconHtml('file', 'skill-tree-node-svg');

function fileIconSvg(ext) {
  // Generic file icon; color is differentiated via data-ext
  return ICON_FILE;
}

function _setDirIcon(nodeEl, open) {
  const caret = nodeEl.querySelector('.skill-tree-caret');
  if (caret) {
    caret.classList.toggle('collapsed', !open);
  }
  const icon = nodeEl.querySelector('.skill-tree-icon');
  if (icon) icon.innerHTML = open ? ICON_FOLDER_OPEN : ICON_FOLDER_CLOSED;
}

function renderTreeNodes(nodes, source, id, depth) {
  const indent = depth * 18;
  return nodes.map(n => {
    if (n.type === 'dir') {
      const childrenHtml = `<div class="skill-tree-children" data-dir-path="${escapeHtml(n.path)}" style="display:none"></div>`;
      return `
        <div class="skill-tree-node skill-tree-dir" data-type="dir" data-path="${escapeHtml(n.path)}" style="padding-left:${indent}px">
          <span class="skill-tree-caret collapsed"></span>
          <span class="skill-tree-icon icon-folder">${ICON_FOLDER_CLOSED}</span>
          <span class="skill-tree-label">${escapeHtml(n.name)}</span>
        </div>
        ${childrenHtml}
      `;
    }
    return `
      <div class="skill-tree-node skill-tree-file" data-type="file" data-path="${escapeHtml(n.path)}" data-ext="${n.ext || ''}" style="padding-left:${indent}px">
        <span class="skill-tree-caret skill-tree-caret-empty"></span>
        <span class="skill-tree-icon icon-file" data-ext="${n.ext || ''}">${fileIconSvg(n.ext)}</span>
        <span class="skill-tree-label">${escapeHtml(n.name)}</span>
      </div>
    `;
  }).join('');
}

function bindTreeNodes(containerEl, source, id) {
  // File nodes
  containerEl.querySelectorAll(':scope > .skill-tree-file').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSkillFile(source, id, el.dataset.path, el);
    });
  });
  // Directory nodes (direct children)
  const dirs = containerEl.querySelectorAll(':scope > .skill-tree-dir');
  dirs.forEach(dirEl => {
    const dirPath = dirEl.dataset.path;
    const childrenEl = dirEl.nextElementSibling;
    if (!childrenEl || !childrenEl.classList.contains('skill-tree-children')) return;
    dirEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = `${source}:${id}/${dirPath}`;
      const isExpanded = _expandedDirs.has(key);
      if (isExpanded) {
        _expandedDirs.delete(key);
        childrenEl.style.display = 'none';
        _setDirIcon(dirEl, false);
      } else {
        _expandedDirs.add(key);
        const tree = _skillTreeCache.get(`${source}:${id}`);
        if (tree) {
          const dirNode = findDirInTree(tree, dirPath);
          if (dirNode && dirNode.children) {
            const depth = dirPath.split('/').length + 1;
            childrenEl.innerHTML = renderTreeNodes(dirNode.children, source, id, depth);
            bindTreeNodes(childrenEl, source, id);
          }
        }
        childrenEl.style.display = '';
        _setDirIcon(dirEl, true);
      }
    });
    if (_expandedDirs.has(`${source}:${id}/${dirPath}`)) {
      const tree = _skillTreeCache.get(`${source}:${id}`);
      if (tree) {
        const dirNode = findDirInTree(tree, dirPath);
        if (dirNode && dirNode.children) {
          const depth = dirPath.split('/').length + 1;
          childrenEl.innerHTML = renderTreeNodes(dirNode.children, source, id, depth);
          bindTreeNodes(childrenEl, source, id);
          childrenEl.style.display = '';
          _setDirIcon(dirEl, true);
        }
      }
    }
  });
}

function findDirInTree(tree, targetPath) {
  for (const n of tree) {
    if (n.type === 'dir' && n.path === targetPath) return n;
    if (n.type === 'dir' && n.children) {
      const found = findDirInTree(n.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

async function selectSkillFile(source, id, filepath, nodeEl) {
  source = _skillSource(source);
  const skill = _skillsCache?.find(s => s.id === id && s.source === source);
  // Detect "same-skill file switch" vs initial / cross-skill load — only the
  // former needs scroll preservation (user is mid-page browsing source files).
  // Capture this BEFORE _selectedSkill is overwritten.
  const sameSkill = _selectedSkill?.id === id && _selectedSkill?.source === source;
  _selectedSkill = { source, id, filepath, name: skill?.name || id };
  // Clear previous active state across all tree nodes (in source-wrap)
  document.querySelectorAll('.skill-tree-node').forEach(n => n.classList.remove('active'));
  if (nodeEl) nodeEl.classList.add('active');
  const content = document.getElementById('skills-detail-content');
  // Defer to CSS — was 'flex' from the old 3-column layout, which now
  // overrides `display: block` and forces sections into horizontal flex.
  if (content) content.style.display = '';
  // Leaving any external-package result state: restore the normal columns.
  const asPkgPanel = document.getElementById('skills-as-package');
  if (asPkgPanel) asPkgPanel.style.display = 'none';
  const detailCol = document.getElementById('skills-detail-col');
  if (detailCol) detailCol.style.display = '';

  const nameEl = document.getElementById('skills-detail-name');
  nameEl.textContent = skill?.name || id;
  nameEl.dataset.skillId = id;
  nameEl.dataset.source = source;
  // Name is editable ONLY in edit mode (req: "非编辑状态不能修改名称").
  // Editability is wired below alongside the description-section toggle —
  // both depend on `editingThis` which is computed a few lines down.
  nameEl.classList.remove('editable');
  nameEl.removeAttribute('title');

  // Header chips: custom = "自定义"; marketplace-installed = category only.
  // Same `_renderSourceMetaHtml` helper as the agent detail page (defined in agents.js,
  // shared via the renderer's flat top-level scope per CLAUDE.md §8).
  const sourceEl = document.getElementById('skills-detail-source');
  sourceEl.className = 'skills-doc-source-row';
  sourceEl.innerHTML = _renderSourceMetaHtml({
    source,
    version: skill?.version || '',
    category: skill?.category || '',
  });
  _renderSkillDetailCategory(skill, source);

  // Doc sections (description / external dependencies / dependent
  // skills / other attributes) — seed with the cached description so
  // the page isn't blank on first paint; refined once SKILL.md
  // frontmatter parses.
  const seedDesc = pickDesc(skill, getLang()).trim();
  _renderSkillSections(seedDesc ? [['description', seedDesc]] : []);

  // Actions bar: visible when a skill is selected.
  // Order: use (icon) / edit / enable-disable / delete.
  // In edit mode only the "done" button (the relabeled "edit") is
  // shown; everything else hides.
  const canEditThisSkill = source === 'custom' || (_isSkillPlatformSource(source) && false);
  const editingThis = _skillEditMode && _skillEditSkillId === id && canEditThisSkill;
  const actions = document.getElementById('skills-detail-actions');
  if (actions) {
    actions.classList.remove('is-hidden');
    const useBtn = document.getElementById('skill-use-btn');
    const editBtn = document.getElementById('skill-edit-btn');
    const enableBtn = document.getElementById('skill-enabled-btn');
    const uploadBtn = document.getElementById('skill-upload-marketplace-btn');
    const delBtn = document.getElementById('skill-delete-btn');
    if (useBtn) {
      useBtn.style.display = editingThis ? 'none' : '';
      useBtn.disabled = skill?.enabled === false;
      useBtn.setAttribute('aria-disabled', skill?.enabled === false ? 'true' : 'false');
    }
    if (editBtn) editBtn.style.display = canEditThisSkill ? '' : 'none';
    if (enableBtn) enableBtn.style.display = editingThis ? 'none' : '';
    // Marketplace publishing is not part of the open-source build.
    if (uploadBtn) uploadBtn.style.display = 'none';
    if (delBtn) delBtn.style.display = (canEditThisSkill && !editingThis) ? '' : 'none';
  }

  // Wire name editability and hide the
  // description section while editing (req #3: edit description by editing
  // the `description_*:` frontmatter in SKILL.md, not via a separate UI
  // block). In dev mode, marketplace skill names are display metadata only:
  // saving writes SKILL.md frontmatter without renaming the marketplace id dir.
  const nameEditable = editingThis && (source === 'custom' || (_isSkillPlatformSource(source) && false));
  _toggleSkillNameEditable(nameEl, nameEditable);
  const summarySection = document.getElementById('skills-section-summary');
  if (summarySection) summarySection.style.display = editingThis ? 'none' : '';

  // Refresh the per-skill enable/disable button label + click handler.
  _renderSkillEnabledButton({ id, enabled: skill?.enabled !== false });

  const body = document.getElementById('skills-detail-body');
  // Don't show a loading placeholder — it would collapse body height
  // before the new content arrives. Keep the previous content visible.
  // For same-skill file switches, pin body's min-height to its current
  // rendered height ONLY for the duration of the fetch + render so the
  // body doesn't visibly collapse while the network call is in flight.
  // The pin is cleared right after render so the body resettles to the
  // new file's natural height — otherwise switching from a long source
  // (e.g. SKILL.md) back to a short script leaves the body padded to
  // the previous height and a large blank area appears below the new
  // content. `_showSkillsGridView` / `_showSkillsDetailView` also reset
  // minHeight on grid return / skill switch as a defensive backstop.
  const detailContent = document.getElementById('skills-detail-content');
  const savedScroll = detailContent ? detailContent.scrollTop : 0;
  if (sameSkill) {
    const oldBodyHeight = body.offsetHeight || 0;
    if (oldBodyHeight) body.style.minHeight = oldBodyHeight + 'px';
  }

  // Kick off the current-file read and (if we aren't already reading it) a
  // parallel SKILL.md read to populate header metadata. The extra fetch is
  // ~1 round-trip on a sub-KB file, and lets the header stay accurate when
  // the user is browsing `scripts/*.ts` inside a skill.
  const mainPromise = apiFetch(`/api/skills/read?source=${source}&id=${encodeURIComponent(id)}&file=${encodeURIComponent(filepath)}`)
    .then((r) => r.json());
  const skillMdPromise = filepath === 'SKILL.md'
    ? mainPromise
    : apiFetch(`/api/skills/read?source=${source}&id=${encodeURIComponent(id)}&file=SKILL.md`)
        .then((r) => r.json())
        .catch(() => null);

  // Render the doc sections as soon as SKILL.md comes back — don't block
  // on the main file body.
  skillMdPromise.then((md) => {
    // Guard: selection may have changed while we were awaiting.
    if (_selectedSkill?.id !== id || _selectedSkill?.source !== source) return;
    const content = md && md.ok ? (md.content || '') : '';
    const pairs = _parseSkillFrontmatterPairs(content);
    const fallbackDesc = pickDesc(skill, getLang()).trim();
    _renderSkillSections(pairs.length
      ? pairs
      : (fallbackDesc ? [['description', fallbackDesc]] : []));
  });

  try {
    const data = await mainPromise;
    if (data.ok) {
      const editable = _skillEditMode && _skillEditSkillId === id && canEditThisSkill;
      if (editable) _renderSkillFileEditor(body, data.content || '', data.ext);
      else _renderSkillFileView(body, data.content || '', data.ext);
    } else {
      body.innerHTML = `<span style="color:var(--danger)">${escapeHtml(data.error)}</span>`;
    }
  } catch (e) {
    body.innerHTML = `<span style="color:var(--danger)">${escapeHtml(t('skills.load_failed'))}</span>`;
  }
  // Release the loading-time minHeight pin so the body collapses to the
  // new file's natural height. Without this, switching from a long file
  // back to a short one leaves a blank area below the new content (the
  // pin was kept monotonically across same-skill file switches).
  if (sameSkill) body.style.minHeight = '';
  // Restore scroll defensively. innerHTML swaps + section re-renders can
  // shift scrollHeight before the new content settles; clamping pulls
  // scrollTop unexpectedly. Setting it back is cheap and idempotent — the
  // browser will clamp scrollTop to the new (possibly smaller) scrollHeight
  // when the new file is shorter, which is the right outcome now that the
  // body height honestly reflects the new content.
  if (detailContent) detailContent.scrollTop = savedScroll;

  // Chat column visibility is driven by edit-mode toggle.
  // Selecting a different skill resets edit mode off.
  const chatCol = document.getElementById('skills-chat-col');
  if (_skillEditMode && _skillEditSkillId === id && canEditThisSkill) {
    chatCol.style.display = 'flex';
  } else {
    // Switching skill mid-stream needs to abort, otherwise the singleton
    // controller's pending state bleeds into the next skill's edit panel
    // (the send button shows streaming for a fresh chat).
    if (_skillEditMode) {
      try { _skillChatCtrl?.abort(); } catch (_) { /* ignore */ }
    }
    _skillEditMode = false;
    _skillEditSkillId = null;
    chatCol.style.display = 'none';
  }
  _updateEditButtonLabel();
}

// Parse SKILL.md YAML frontmatter into ordered [key, value] pairs.
// Mirrors the server-side parser in `core-agent/src/skills/frontmatter.ts`
// but also collects indented block values (`key:` followed by `  - item`
// or `  text`) so multi-line fields like `read_when:` render correctly.
function _normalizeSkillFrontmatterDisplayValue(value) {
  if (typeof normalizeDisplayText === 'function') return normalizeDisplayText(value);
  return String(value || '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\{2,}/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

function _parseSkillFrontmatterPairs(content) {
  if (!content) return [];
  const first = content.indexOf('\n');
  const head = (first >= 0 ? content.slice(0, first) : content).trim();
  if (head !== '---') return [];
  const lines = content.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close < 0) return [];

  const pairs = [];
  let i = 1;
  while (i < close) {
    const line = lines[i];
    const trimmed = line.trim();
    i++;
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    value = _normalizeSkillFrontmatterDisplayValue(value);
    if (!value) {
      // Collect indented continuation (block list or folded scalar).
      const block = [];
      while (i < close) {
        const next = lines[i];
        if (!next.trim() || /^\s+\S/.test(next)) {
          if (next.trim()) block.push(next.replace(/^\s+/, '').replace(/^-\s*/, ''));
          i++;
        } else break;
      }
      value = block.join('\n');
    }
    pairs.push([key, value]);
  }
  return pairs;
}

function _renderSkillDetailCategory(skill, source) {
  const section = document.getElementById('skills-section-category');
  const slot = document.getElementById('skills-detail-category');
  if (section) section.style.display = 'none';
  if (slot) slot.innerHTML = '';
  const isCustom = source === 'custom';
  if (!isCustom) return;
  const sourceEl = document.getElementById('skills-detail-source');
  if (!sourceEl) return;
  const skillId = skill?.id || _selectedSkill?.id;
  _mountDetailCategorySelect(sourceEl, {
    value: skill?.category || 'general',
    onChange: async (category, api) => {
      try {
        const res = await window.cogseed.invoke('skills.update', {
          id: skillId,
          updates: { category: category || 'general' },
          skipRename: true,
        });
        if (!res || res.ok === false || !res.skill) {
          api.setValue(skill?.category || 'general');
          uiAlert((res && res.error) || t('skills.save_failed'));
          return;
        }
        skill.category = res.skill.category || category || 'general';
        _skillsCache = null;
        await loadSkills(true);
        if (_selectedSkill?.id === skillId) {
          await selectSkillFile('custom', skillId, _selectedSkill.filepath || 'SKILL.md', null);
        }
      } catch (err) {
        api.setValue(skill?.category || 'general');
        uiAlert((err && err.message) || t('skills.save_failed'));
      }
    },
  }).catch((err) => _skillsLog.warn('render category select failed', err));
}

// Single source of truth for rendering frontmatter fields into the
// document. Splits known fields into their own dedicated sections (with
// labels) and tucks any unknown leftover keys under "other
// attributes". Hides any section whose content is empty (except the
// description, which always renders so the reader sees a placeholder
// when missing).
function _renderSkillSections(pairs) {
  const map = new Map();
  for (const [k, v] of (pairs || [])) {
    if (k && k !== 'name') map.set(k, v);
  }
  // — Description — pick by current UI language with cross-language fallback (so a
  // single-language skill still shows something instead of going blank).
  const summaryEl = document.getElementById('skills-detail-summary');
  if (summaryEl) {
    const desc = pickDesc({
      description_zh: map.get('description_zh'),
      description_en: map.get('description_en'),
    }, getLang()).trim() || (map.get('description') || '').trim();
    if (desc) {
      summaryEl.classList.remove('is-empty');
      summaryEl.textContent = desc;
    } else {
      summaryEl.classList.add('is-empty');
      summaryEl.textContent = _selectedSkill?.source === 'custom'
        ? t('skills.no_desc') : '';
    }
  }

  // — Other attributes —
  // CogSeed skill frontmatter is intentionally tiny: name, bilingual
  // description, and category. Unknown/external metadata has no runtime
  // effect, so authoring writes strip it and the read-only view hides any
  // legacy leftovers instead of presenting them as meaningful properties.
  const extraSection = document.getElementById('skills-section-extra');
  const extraBody = document.getElementById('skills-detail-extra');
  if (extraSection && extraBody) {
    extraSection.style.display = 'none';
    extraBody.innerHTML = '';
  }
}

// Read-only view of a skill file. Markdown renders, other formats get a
// code block. Stores the raw content on the element so the editor variant
// can reset on "discard changes" without re-fetching.
function _renderSkillFileView(body, content, ext) {
  body.className = 'skills-detail-body';
  body.dataset.rawContent = content;
  if (ext === 'md') {
    body.classList.add('markdown-body');
    body.innerHTML = renderMarkdownFull(content);
  } else {
    body.innerHTML = `<pre class="code-view"><code>${escapeHtml(content)}</code></pre>`;
  }
}

// Editable textarea view with debounced auto-save. Shown when _skillEditMode
// is on for a custom skill. No explicit save button — edits flush to disk
// ~600ms after the user pauses typing. Target id/file are captured in the
// closure so a save in flight always targets the file it was scheduled for,
// even if the user navigates to another file meanwhile.
function _renderSkillFileEditor(body, content, _ext) {
  body.className = 'skills-detail-body skills-detail-editing';
  body.dataset.rawContent = content;
  body.innerHTML = `
    <div class="skill-file-toolbar">
      <span class="skill-file-status" data-role="status"></span>
    </div>
    <textarea class="skill-file-editor" spellcheck="false"></textarea>
  `;

  const ta = body.querySelector('.skill-file-editor');
  const statusEl = body.querySelector('[data-role="status"]');
  ta.value = content;

  const skillId = _selectedSkill?.id || '';
  const filepath = _selectedSkill?.filepath || 'SKILL.md';

  const setStatus = (text, kind = '') => {
    statusEl.textContent = text;
    statusEl.className = 'skill-file-status' + (kind ? ' is-' + kind : '');
  };

  let saveTimer = null;
  let saving = false;
  let queuedValue = null;

  const performSave = async (value) => {
    saving = true;
    setStatus(t('skills.saving'), 'saving');
    try {
      const res = await apiFetch('/api/skills/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skillId, file: filepath, content: value }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || t('skills.unknown_error'));
      body.dataset.rawContent = value;
      setStatus(t('skills.saved'), 'ok');
      // SKILL.md edits change name/description/frontmatter — refresh side list.
      if (filepath === 'SKILL.md') {
        _skillsCache = null;
        await loadSkills();
      }
    } catch (e) {
      setStatus(t('skills.save_failed_with', { reason: e.message || e }), 'err');
    } finally {
      saving = false;
      if (queuedValue !== null) {
        const next = queuedValue;
        queuedValue = null;
        performSave(next);
      }
    }
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    setStatus(t('skills.editing'));
    saveTimer = setTimeout(() => {
      const value = ta.value;
      if (value === body.dataset.rawContent) { setStatus(''); return; }
      if (saving) { queuedValue = value; return; }
      performSave(value);
    }, 600);
  };

  ta.addEventListener('input', scheduleSave);
}

// ─── Skill name inline edit (mirrors agents.js's name editor) ───
//
// Replaces the older click-to-prompt rename path. The name field is now
// only editable inside Skill detail's edit mode (req: 非编辑状态不能修改名称).
// Wire-up:
//   - Enter edit  → contenteditable + bind input/blur (one-time per element)
//   - Type        → debounce 800ms → save SKILL.md frontmatter `name:`
//                   via `skipRename:true` (no dir rename mid-typing)
//   - Blur        → flush pending save
//   - Done click  → flush + validate; if invalid alert + revert DOM;
//                   if valid AND name actually changed, fire one final
//                   `skipRename:false` to commit the directory rename.

const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
function _isValidSkillNameCharset(name) {
  if (typeof name !== 'string' || name.length <= 0) return false;
  if (typeof window.nameDisplayWidth === 'function' && window.nameDisplayWidth(name) > window.NAME_DISPLAY_MAX_UNITS) return false;
  return SKILL_NAME_RE.test(name);
}

function _isEditablePlatformSkill(skill) {
  return !!skill && _isSkillPlatformSource(skill.source) && false;
}

function _canEditSelectedSkillName() {
  return !!_selectedSkill && (_selectedSkill.source === 'custom' || _isEditablePlatformSkill(_selectedSkill));
}

function _selectedSkillNameFallback() {
  if (!_selectedSkill) return '';
  return String(_selectedSkill.source === 'custom'
    ? _selectedSkill.id
    : (_selectedSkill.name || _selectedSkill.id || '')).trim();
}

function _isValidSkillDisplayName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return false;
  if (typeof window.nameDisplayWidth === 'function' && window.nameDisplayWidth(trimmed) > window.NAME_DISPLAY_MAX_UNITS) return false;
  return true;
}

function _isValidSkillNameForSelected(name) {
  return _isEditablePlatformSkill(_selectedSkill)
    ? _isValidSkillDisplayName(name)
    : _isValidSkillNameCharset(name);
}

function _toggleSkillNameEditable(nameEl, on) {
  if (!nameEl) return;
  nameEl.setAttribute('contenteditable', on ? 'plaintext-only' : 'false');
  nameEl.classList.toggle('is-editing', !!on);
  if (on) _bindSkillNameSave(nameEl);
}

function _bindSkillNameSave(nameEl) {
  if (nameEl.dataset.bound === '1') return;
  nameEl.dataset.bound = '1';
  if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(nameEl);
  nameEl.addEventListener('input', () => _scheduleSkillFieldSave('name', nameEl.innerText));
  nameEl.addEventListener('blur', () => _flushSkillFieldSave());
}

let _pendingSkillField = null;
let _skillFieldSaveTimer = null;
function _scheduleSkillFieldSave(field, value) {
  if (!_canEditSelectedSkillName()) return;
  _pendingSkillField = { field, value };
  clearTimeout(_skillFieldSaveTimer);
  _skillFieldSaveTimer = setTimeout(_flushSkillFieldSave, 800);
}

// `validate` is true ONLY when the user explicitly commits (clicks 完成);
// typing-debounced and blur-triggered flushes pass false — bad names
// silently skip the save (DOM keeps the in-progress text) instead of
// popping a uiAlert mid-keystroke. Mirrors agents.js::_flushAgentFieldSave.
//
// During typing we use `skipRename:true` so the directory id stays as the
// original until Done; that keeps the URL / cache keyed by the same id and
// avoids a flurry of dir renames per keystroke. The Done branch fires a
// final `skipRename:false` update to commit the directory rename when the
// new name passed validation and actually differs from the original id.
async function _flushSkillFieldSave({ validate = false } = {}) {
  clearTimeout(_skillFieldSaveTimer);
  _skillFieldSaveTimer = null;
  // Clicking Done blurs the contenteditable title before the click handler
  // runs. That blur autosave can clear `_pendingSkillField`; recover the
  // current DOM value so the explicit commit still performs the dir rename.
  if (!_pendingSkillField && validate && _canEditSelectedSkillName()) {
    const nameEl = document.getElementById('skills-detail-name');
    if (nameEl && String(nameEl.innerText || '').trim() !== _selectedSkillNameFallback()) {
      _pendingSkillField = { field: 'name', value: nameEl.innerText };
    }
  }
  if (!_pendingSkillField || !_selectedSkill) return true;
  const { field, value } = _pendingSkillField;
  if (field === 'name') {
    const invalid = !_isValidSkillNameForSelected(String(value || ''));
    if (invalid) {
      if (!validate) return false;
      _pendingSkillField = null;
      await uiAlert(t('skills.name_invalid'));
      const nameEl = document.getElementById('skills-detail-name');
      if (nameEl) nameEl.innerText = _selectedSkillNameFallback();
      if (_selectedSkill.source === 'custom') {
        // Roll the SKILL.md frontmatter back to the original id too — the
        // skipRename:true writes during typing left a possibly-invalid name
        // on disk; revert so the next listSkills auto-heal doesn't misfire.
        try {
          await apiFetch(`/api/skills/${encodeURIComponent(_selectedSkill.id)}/update?skipRename=1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: _selectedSkill.id }),
          });
        } catch (_) { /* best-effort revert */ }
      }
      return false;
    }
  }
  _pendingSkillField = null;
  const currentId = _selectedSkill.id;
  const newName = String(value || '').trim();
  if (_isEditablePlatformSkill(_selectedSkill)) {
    try {
      const data = await window.cogseed.invoke('skills.updateForEdit', {
        id: currentId,
        updates: { [field]: value },
      });
      if (!data || data.ok === false) {
        throw new Error(data?.error || 'save failed');
      }
      if (field === 'name') {
        const nextName = data.skill?.name || newName || currentId;
        _skillsCache = null;
        _skillTreeCache.clear();
        await loadSkills();
        _selectedSkill = { ..._selectedSkill, name: nextName };
        const nameEl = document.getElementById('skills-detail-name');
        if (nameEl) nameEl.innerText = nextName;
      }
      return true;
    } catch (e) {
      if (validate && field === 'name') {
        await uiAlert(t('skills.rename_failed', { reason: e.message || e }));
        const nameEl = document.getElementById('skills-detail-name');
        if (nameEl) nameEl.innerText = _selectedSkillNameFallback();
      }
      return false;
    }
  }
  const skipRename = !validate || newName === currentId;
  // ipc-shim's `wrapAsUpdates` wraps the body under `updates`, so the
  // request body holds only field values; `skipRename` rides on the URL
  // query string so it lands as a sibling of `updates` in the IPC payload.
  const url = `/api/skills/${encodeURIComponent(currentId)}/update${skipRename ? '?skipRename=1' : ''}`;
  try {
    const res = await apiFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || 'save failed');
    }
    if (validate && field === 'name' && !skipRename) {
      // Directory was renamed — refresh caches + update _selectedSkill.id
      // so subsequent calls (selectSkillFile / chat dir lookup) hit the
      // new id, not the stale one.
      const resultId = data.skill?.id || newName;
      _skillsCache = null;
      _skillTreeCache.clear();
      _expandedDirs.delete(`custom:${currentId}`);
      await loadSkills();
      _selectedSkill = { ..._selectedSkill, id: resultId };
      _skillEditSkillId = resultId;
    }
    return true;
  } catch (e) {
    if (validate && field === 'name') {
      await uiAlert(t('skills.rename_failed', { reason: e.message || e }));
      const nameEl = document.getElementById('skills-detail-name');
      if (nameEl) nameEl.innerText = _selectedSkill.id;
    }
    return false;
  }
}

// ─── Inline skill chat (edit-mode only, per-skill storage) ───

let _skillEditMode = false;
let _skillEditSkillId = null;
// Id of an unconfirmed URL-import placeholder skill. While set, leaving the
// import chat discards the draft if it was never authored (e.g. the source was
// installed as an external package, or the install failed). Cleared once the
// import produces real content or finalizes as a package.
let _importDraftId = null;
// W5: 刚展示过统一导入检查弹窗的技能 id——其编辑会话的 Done 预检跳过一次，
// 避免"导入弹窗确认后，Done 又弹一次 NSEAP 预检"的双弹窗。
let _importCheckPopupShownFor = null;

function _updateEditButtonLabel() {
  const btn = document.getElementById('skill-edit-btn');
  if (!btn) return;
  if (_skillEditMode) {
    btn.textContent = t('skills.edit_btn_done');
    return;
  }
  // Tag the "Edit" label on marketplace skills (dev-only entry); the "Done"
  // branch above stays bare — in edit mode the marker is redundant.
  const suffix = (_isSkillPlatformSource(_selectedSkill?.source) && false) ? t('common.dev_suffix') : '';
  btn.textContent = t('skills.edit_btn_edit') + suffix;
}

function _skillImportAutoSeedFromResponse(data) {
  if (data?.seedModelText === false || data?.seedMessage === false) return false;
  const modelText = typeof data?.seedModelText === 'string' && data.seedModelText.trim()
    ? data.seedModelText.trim()
    : (typeof data?.seedMessage === 'string' ? data.seedMessage.trim() : '');
  if (!modelText) return true;
  const displayText = typeof data?.seedDisplayText === 'string' && data.seedDisplayText.trim()
    ? data.seedDisplayText.trim()
    : t('skills.import_seed_display');
  return { displayText, modelText, force: true };
}

function _skillAutoSeedHasModelText(autoSeed) {
  if (typeof autoSeed === 'string') return !!autoSeed.trim();
  return !!(autoSeed && typeof autoSeed === 'object' && typeof autoSeed.modelText === 'string' && autoSeed.modelText.trim());
}

function _nseapDeclarationLines(nseap) {
  if (!nseap) return [];
  const out = [];
  if (nseap.status === 'unavailable') out.push(`• ${t('skills.secpanel_nseap_unavailable')}`);
  else if (nseap.status === 'mismatch') out.push(`• ${t('skills.secpanel_nseap_mismatch')}`);
  else if (nseap.status === 'needs_input') out.push(`• ${t('skills.secpanel_nseap_needs_input')}`);
  else if (nseap.status === 'pass_with_warnings') out.push(`• ${t('skills.secpanel_nseap_warnings')}`);
  for (const f of (nseap.findings || []).slice(0, 6)) {
    out.push(`• ${f.ruleId}${f.message ? ` — ${f.message}` : ''}`);
  }
  return out;
}

// When called with {autoSeed: true} (e.g. right after skill creation), sends
// a short "help me refine this skill" message to kick off the LLM. Import
// flows pass {displayText, modelText}: the chat bubble stays concise, while
// model_text carries the full source-inspection instructions. In plain edit
// mode (user clicks "edit" on an existing skill) no message is sent
// automatically — the user drives the conversation from a blank input.
async function toggleSkillEditMode(opts = {}) {
  if (!_selectedSkill) return;
  // Marketplace editing is dev-only; lift the source guard accordingly.
  if (_selectedSkill.source !== 'custom'
      && !(_isSkillPlatformSource(_selectedSkill.source) && false)) return;
  if (_skillEditMode && _skillEditSkillId === _selectedSkill.id) {
    // Abort any in-flight reply so "done" means "stop + exit", not
    // "exit but keep streaming". The chat controller is a singleton;
    // leaving it pending also leaks the streaming-button state into
    // the next skill's edit panel when the user clicks "edit"
    // elsewhere.
    try { _skillChatCtrl?.abort(); } catch (_) { /* ignore */ }
    // Done click is the explicit commit point: flush any pending name
    // edit + validate. Invalid name → alert + revert DOM (and roll the
    // SKILL.md frontmatter back to the original id, see the validate
    // branch in `_flushSkillFieldSave`). Valid + actually-changed name
    // → fires a `skipRename:false` update which commits the directory
    // rename + refreshes caches before we re-render readonly view.
    const committed = await _flushSkillFieldSave({ validate: true });
    if (committed === false) return;

    try {
      const precheck = await window.cogseed.invoke('skills.checkNseapDeclaration', {
        id: _skillEditSkillId,
      });
      const lines = _importCheckPopupShownFor === _skillEditSkillId
        ? [] // 刚在统一导入弹窗里展示过——不再重复弹预检
        : _nseapDeclarationLines(precheck?.nseapDeclaration);
      _importCheckPopupShownFor = null;
      if (lines.length) {
        const choice = typeof uiChoice === 'function'
          ? await uiChoice({
            title: t('skills.edit_nseap_precheck_title'),
            message: `${t('skills.edit_nseap_precheck_body')}\n\n${lines.join('\n')}`,
            choices: [
              { id: 'continue', label: t('skills.edit_nseap_precheck_continue'), style: 'primary' },
              { id: 'back', label: t('skills.edit_nseap_precheck_back'), style: '' },
            ],
          })
          : 'continue';
        if (choice !== 'continue') return;
      }
    } catch (_) { /* precheck is advisory */ }

    // Explicit "Done" is a commit: keep the skill (even an empty import draft
    // the user chose to finalize) and stop the back-prompt from firing.
    _importDraftId = null;
    _skillEditMode = false;
    _skillEditSkillId = null;
    document.getElementById('skills-chat-col').style.display = 'none';
    _updateEditButtonLabel();
    // Swap the body back to read-only view of the current file. Use the
    // _selectedSkill.id snapshot — flush may have rotated it if the
    // directory got renamed.
    await selectSkillFile(_selectedSkill.source, _selectedSkill.id,
      _selectedSkill.filepath || 'SKILL.md', null);
    return;
  }
  _skillEditMode = true;
  _skillEditSkillId = _selectedSkill.id;
  document.getElementById('skills-chat-col').style.display = 'flex';
  _updateEditButtonLabel();
  // Re-render the currently selected file as an editor.
  await selectSkillFile(_selectedSkill.source, _selectedSkill.id,
    _selectedSkill.filepath || 'SKILL.md', null);
  _ensureSkillChatController();
  await _skillChatCtrl.loadHistory();
  await _chatAttachRefreshFromServer(_skillEditAttachmentCid(_skillEditSkillId));
  if (opts.autoSeed) {
    const existing = document.querySelectorAll('#skills-chat-messages .chat-message');
    const forceAutoSeed = !!(opts.autoSeed && typeof opts.autoSeed === 'object' && opts.autoSeed.force === true);
    if (forceAutoSeed || existing.length === 0) {
      const baseSeed = t('skills.help_finish_seed_model');
      const importSeed = typeof opts.autoSeed === 'string'
        ? opts.autoSeed.trim()
        : (opts.autoSeed && typeof opts.autoSeed === 'object' && typeof opts.autoSeed.modelText === 'string'
            ? opts.autoSeed.modelText.trim()
            : '');
      const seed = importSeed
        ? [baseSeed, importSeed].filter(Boolean).join('\n\n')
        : baseSeed;
      const displayText = importSeed
        ? (opts.autoSeed && typeof opts.autoSeed === 'object' && typeof opts.autoSeed.displayText === 'string' && opts.autoSeed.displayText.trim()
            ? opts.autoSeed.displayText.trim()
            : t('skills.import_seed_display'))
        : t('skills.help_finish_seed');
      await _skillChatCtrl.send(displayText, { model_text: seed });
    }
  }
}

// Lazy singleton — created once, driven by `_skillEditSkillId` via the id
// resolver so it follows the currently active skill.
let _skillChatCtrl = null;
let _skillEditAttachmentsBound = false;
let _pendingSkillImportReplacementId = null;

function _skillEditAttachmentCid(skillId) {
  return skillId ? `skill-edit-${skillId}` : '';
}

function _bindSkillEditAttachments() {
  if (_skillEditAttachmentsBound) return;
  _skillEditAttachmentsBound = true;
  const btn = document.getElementById('skills-chat-attach-btn');
  const area = document.querySelector('.skills-chat-input-area');
  const input = document.getElementById('skills-chat-input');
  const currentCid = () => _skillEditAttachmentCid(_skillEditSkillId || '');
  if (btn) {
    btn.addEventListener('click', async () => {
      const cid = currentCid();
      if (cid) await _chatAttachPickAndUpload(cid, 'picker');
    });
  }
  if (area) {
    area.addEventListener('dragover', (e) => {
      const hasFiles = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length;
      const hasInternal = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(ORKAS_FILE_DRAG_MIME);
      if (!hasFiles && !hasInternal) return;
      e.preventDefault();
      area.classList.add('drag-over');
    });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', async (e) => {
      const cid = currentCid();
      if (!cid) return;
      const internal = _chatAttachInternalDragItems(e.dataTransfer);
      if (internal.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachImportPaths(cid, internal, 'internal_drop');
        return;
      }
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachUpload(cid, e.dataTransfer.files, 'drop');
      }
    });
  }
  if (input) {
    input.addEventListener('paste', async (e) => {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      const cid = currentCid();
      if (!cid) return;
      e.preventDefault();
      await _chatAttachUpload(cid, e.clipboardData.files, 'paste');
    });
  }
}

async function _buildSkillEditChatExtraBody(_content, skillId, state) {
  const cid = _skillEditAttachmentCid(skillId);
  const items = _chatAttachList(cid);
  if (!items.length) return undefined;
  if (items.some((a) => a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return null;
  }
  const attachments = items.filter((a) => a.status !== 'error').map((a) => a.name);
  if (!attachments.length) return undefined;
  if (state && (state.pending || state.hasQueue)) {
    await uiAlert(t('chat.attach_queue_blocked'));
    return null;
  }
  _chatAttachClear(cid);
  return { attachments, attachment_cid: cid };
}

function _ensureSkillChatController() {
  if (_skillChatCtrl) return _skillChatCtrl;
  _bindSkillEditAttachments();
  _skillChatCtrl = createChatController({
    historyEl: 'skills-chat-messages',
    inputEl: 'skills-chat-input',
    sendBtnEl: 'skills-chat-send-btn',
    getCurrentId: () => _skillEditSkillId,
    historyEndpoint: (id) => `/api/skills/${encodeURIComponent(id)}/chat`,
    streamEndpoint: (id) => `/api/skills/${encodeURIComponent(id)}/chat/send/stream`,
    clearEndpoint: (id) => `/api/skills/${encodeURIComponent(id)}/chat`,
    features: { archive: false, scrollPin: true, queue: true },
    queue: {
      keyPrefix: 'skill',
      panelId: 'skills-chat-queue',
      listId: 'skills-chat-queue-list',
      countId: 'skills-chat-queue-count',
    },
    hooks: {
      buildExtraBody: _buildSkillEditChatExtraBody,
      async onFinal(ev, msgEl, id) {
        // Authoring wrote real files → this import produced a genuine custom
        // skill; commit it so backing out no longer prompts/discards.
        const committedImport = !!_importDraftId && (!!(ev?.written?.length) || !!(ev?.created?.length));
        if (ev?.written?.length || ev?.created?.length) _importDraftId = null;
        // W5: URL 导入首次落盘 → 跑准入并弹统一的"导入检查结果"弹窗（仅一次）。
        if (committedImport) {
          _showUrlImportCheckResult(_skillEditSkillId || id).catch(() => {});
        }
        if (_pendingSkillImportReplacementId) {
          const nextId = _pendingSkillImportReplacementId;
          _pendingSkillImportReplacementId = null;
          _importDraftId = null;
          _skillEditSkillId = nextId;
          _selectedSkill = { source: 'custom', id: nextId, filepath: 'SKILL.md' };
          _skillsCache = null;
          await _showSkillsDetailView('custom', nextId);
          await _skillChatCtrl.loadHistory();
          return;
        }
        // Skill chat may rewrite files on disk; refresh the detail pane so
        // the tree and SKILL.md display reflect the new state.
        await _refreshSkillView();
      },
      onStreamEvent(ev, msgEl, id) {
        const inner = ev?.event;
        if (!inner) return;
        // `skill_as_package`: the URL import was installed as an external
        // package and main deleted the placeholder skill. Switch the detail
        // pane to the package result state (no skill content to show).
        if (inner.stream === 'skill_as_package') {
          // Placeholder already deleted by main; clear the draft guard so the
          // grid-view exit doesn't try to re-discard a gone id.
          _importDraftId = null;
          _showSkillAsPackageState(inner.data?.name || '');
          return;
        }
        if (inner.stream === 'skill_import_replaced') {
          const nextId = inner.data?.skillId || inner.data?.skills?.[0]?.skill_id || '';
          if (nextId) {
            _pendingSkillImportReplacementId = nextId;
            _importDraftId = null;
            _skillsCache = null;
          }
          return;
        }
        // Auto-rename on `skill_renamed` event from main: the skill's
        // SKILL.md `name:` differs from its dir id, so main moved the dir
        // (and its chat dir + session id) to the new id. Switch the
        // active edit chat to the new id transparently.
        if (inner.stream !== 'skill_renamed') return;
        const { oldId, newId } = inner.data || {};
        if (!oldId || !newId || oldId === newId) return;
        if (id !== oldId && _skillEditSkillId !== oldId) return;
        // A rename means real content was authored — commit the import draft.
        _importDraftId = null;
        // Update active selection / id-resolver target
        _skillEditSkillId = newId;
        if (_selectedSkill && _selectedSkill.id === oldId) {
          _selectedSkill = { ..._selectedSkill, id: newId };
        }
        _skillsCache = null;
        // Refresh list + detail pane lazily — avoid blocking the stream
        // reader. If the user is mid-stream we can't reload mid-flight, so
        // fire-and-forget; the stream reader will keep yielding into the
        // (still attached) msgEl.
        Promise.resolve().then(() => loadSkills()).catch(() => {});
      },
    },
  });
  return _skillChatCtrl;
}

async function clearSkillChat() {
  if (!_skillEditSkillId) return;
  if (!(await uiConfirm(t('skills.clear_confirm')))) return;
  _ensureSkillChatController();
  await _skillChatCtrl.clear();
}

async function _refreshSkillView() {
  if (!_skillEditSkillId) return;
  const sid = _skillEditSkillId;
  // Source must come from the active selection, not be hardcoded — dev-mode
  // built-in editing reuses this same path and was previously bailing here
  // because of a 'custom'-only equality check.
  const source = _selectedSkill?.source || 'custom';

  // Refresh the skill list cache (in case name/description in SKILL.md changed)
  _skillsCache = null;
  await loadSkills();

  // Refresh the tree cache so subsequent expansion sees the latest files
  const treeKey = `${source}:${sid}`;
  _skillTreeCache.delete(treeKey);

  // Bail if user navigated away while we were awaiting above.
  if (!_selectedSkill || _selectedSkill.id !== sid || _selectedSkill.source !== source) return;

  // Re-render the whole detail page via selectSkillFile so the header
  // (name) and the doc sections (description / external deps /
  // dependent skills / ...) pick up SKILL.md frontmatter changes the
  // LLM just made — without this, the description chip stayed on the
  // pre-edit value until the user clicked "done". selectSkillFile
  // also re-reads the body, so we
  // don't need a separate body refetch here.
  const filepath = _selectedSkill.filepath || 'SKILL.md';
  await selectSkillFile(source, sid, filepath, null);

  // selectSkillFile clears tree active state. If the source panel is
  // expanded, refresh it in case files were added/removed (e.g. the LLM
  // wrote a new script) and re-mark the active file.
  const sourceToggle = document.getElementById('skills-source-toggle');
  const sourcePanel = document.getElementById('skills-source-panel');
  const sourceTreeEl = document.getElementById('skills-source-tree');
  const expanded = sourceToggle?.getAttribute('aria-expanded') === 'true';
  if (expanded && sourcePanel && sourceTreeEl) {
    await expandSkillTree(source, sid, sourceTreeEl);
  }
  _markActiveSkillFileInTree(filepath);
}

// ─── Custom skill CRUD ───

let _skillModalBusy = false;

function _setSkillModalBusy(busy) {
  _skillModalBusy = !!busy;
  const modal = document.getElementById('skill-modal');
  if (modal) modal.setAttribute('aria-busy', _skillModalBusy ? 'true' : 'false');
  const ids = [
    'skill-save-btn',
    'skill-dir-pick-btn',
    'skill-url-input',
    'skill-name',
    'skill-description',
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = _skillModalBusy;
  }
  document.querySelectorAll('#skill-modal .modal-actions .btn, #skill-modal .skill-modal-tab')
    .forEach((el) => { el.disabled = _skillModalBusy; });
}

function _waitForSkillModalBusyPaint() {
  return new Promise((resolve) => {
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 0);
    raf(() => resolve());
  });
}

function _switchSkillTab(tab) {
  if (_skillModalBusy) return;
  const tabs = document.querySelectorAll('.skill-modal-tab');
  tabs.forEach((el) => el.classList.toggle('is-active', el.dataset.skillTab === tab));
  const panels = document.querySelectorAll('.skill-modal-panel');
  panels.forEach((el) => el.classList.toggle('is-active', el.dataset.skillPanel === tab));
  // Clear error msg when switching tabs
  const msgEl = document.getElementById('skill-form-msg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'form-msg'; }
  // Focus primary input of the new tab
  setTimeout(() => {
    const focusId = tab === 'url' ? 'skill-url-input'
                  : tab === 'dir' ? 'skill-dir-pick-btn'
                  : 'skill-name';
    const el = document.getElementById(focusId);
    if (el) el.focus();
  }, 30);
}
window._switchSkillTab = _switchSkillTab;

async function openSkillModal(editId) {
  const modal = document.getElementById('skill-modal');
  const title = document.getElementById('skill-modal-title');
  const editIdInput = document.getElementById('skill-edit-id');
  const msgEl = document.getElementById('skill-form-msg');
  const saveBtn = document.getElementById('skill-save-btn');
  const tabBar = document.getElementById('skill-modal-tabs');
  _setSkillModalBusy(false);
  msgEl.textContent = '';
  msgEl.className = 'form-msg';

  // Reset all inputs across all panels
  for (const id of [
    'skill-name', 'skill-description',
    'skill-url-input',
    'skill-dir-path',
  ]) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  const sel = document.getElementById('skill-dir-selected');
  if (sel) sel.textContent = t('skill_modal.dir_none');

  if (editId) {
    title.textContent = t('skills.modal_edit_title');
    saveBtn.textContent = t('common.confirm');
    editIdInput.value = editId;
    if (tabBar) tabBar.style.display = 'none'; // edit mode: no tabs, manual only
    _switchSkillTab('manual');
    const cached = _skillsCache?.find(s => s.id === editId && s.source === 'custom');
    if (cached) {
      document.getElementById('skill-name').value = cached.name || '';
      // Edit modal keeps a single description field for now (UX kept simple);
      // form input is merely a seed — the full bilingual pair is authored
      // through the inline edit-chat. Show whichever locale matches the
      // active UI language with cross-fallback.
      document.getElementById('skill-description').value = pickDesc(cached, getLang()) || '';
    }
  } else {
    title.textContent = t('skills.modal_new_title');
    saveBtn.textContent = t('common.confirm');
    editIdInput.value = '';
    if (tabBar) tabBar.style.display = '';
    _switchSkillTab('manual');
  }

  // Wire tab buttons (idempotent — checks a flag)
  if (tabBar && !tabBar.dataset.wired) {
    tabBar.querySelectorAll('.skill-modal-tab').forEach((btn) => {
      btn.addEventListener('click', () => _switchSkillTab(btn.dataset.skillTab));
    });
    tabBar.dataset.wired = '1';
  }

  modal.classList.add('open');
  if (typeof window.bindNameLimitControl === 'function') {
    window.bindNameLimitControl(document.getElementById('skill-name'));
  }
}
window.openSkillModal = openSkillModal;

function closeSkillModal() {
  document.getElementById('skill-modal').classList.remove('open');
}
window.closeSkillModal = closeSkillModal;

async function pickSkillImportDir() {
  const msgEl = document.getElementById('skill-form-msg');
  msgEl.textContent = '';
  try {
    const res = await apiFetch('/api/skills/pick-import-dir', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      msgEl.textContent = data.error || t('skill_modal.dir_pick_failed');
      msgEl.className = 'form-msg err';
      return;
    }
    if (data.cancelled) return;
    const p = String(data.path || '');
    document.getElementById('skill-dir-path').value = p;
    document.getElementById('skill-dir-selected').textContent = p;
  } catch (_) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
  }
}
window.pickSkillImportDir = pickSkillImportDir;

function _skillCreateNow() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function _skillCreateDuration(startedAt) {
  return Math.max(0, Math.round(_skillCreateNow() - Number(startedAt || 0)));
}

function _skillCreatePayload(creationMethod, data) {
  return Object.assign({ creation_method: creationMethod }, data || {});
}

function _skillCreateTrackClick(creationMethod, data) {
  try {
    const monitor = (typeof window !== 'undefined') ? window.Monitor : null;
    if (monitor && typeof monitor.click === 'function') {
      monitor.click('skill_create_submit', _skillCreatePayload(creationMethod, data));
    }
  } catch (_) {}
}

function _skillCreateTrackResult(tracking, result, data) {
  try {
    const monitor = (typeof window !== 'undefined') ? window.Monitor : null;
    if (monitor && typeof monitor.event === 'function') {
      monitor.event('skill_create_result', _skillCreatePayload(tracking.creationMethod, Object.assign({
        result,
        duration_ms: _skillCreateDuration(tracking.startedAt),
      }, data || {})));
    }
  } catch (_) {}
}

function _skillCreateTrackError(tracking, data) {
  try {
    const monitor = (typeof window !== 'undefined') ? window.Monitor : null;
    if (monitor && typeof monitor.error === 'function') {
      monitor.error('skill_create', _skillCreatePayload(tracking.creationMethod, data || {}));
    }
  } catch (_) {}
}

function _skillCreateTracking(creationMethod, clickData) {
  const tracking = {
    creationMethod,
    startedAt: _skillCreateNow(),
  };
  _skillCreateTrackClick(creationMethod, clickData);
  return tracking;
}

function _skillCreateIdFromResponse(data) {
  return data?.skill?.id || data?.skills?.[0]?.id || '';
}

function _skillCreateCountFromResponse(data) {
  if (Array.isArray(data?.skills)) return data.skills.length;
  return data?.skill ? 1 : 0;
}

function _skillCreateResourceFromResponse(data, fallbackName = '') {
  const skill = data?.skill || data?.skills?.[0] || {};
  const id = String(skill.id || '').trim().slice(0, 128);
  const name = String(skill.name || fallbackName || id).replace(/\s+/g, ' ').trim().slice(0, 128);
  return {
    resource_kind: 'skill',
    resource_id: id,
    resource_name: name,
  };
}

async function saveSkill() {
  if (_skillModalBusy) return;
  const editId = document.getElementById('skill-edit-id').value;
  const msgEl = document.getElementById('skill-form-msg');

  // Edit mode: always manual path.
  if (editId) {
    return _saveSkillManual({ editId, msgEl });
  }

  const activeTab = document.querySelector('.skill-modal-tab.is-active')?.dataset.skillTab || 'manual';
  if (activeTab === 'url') return _saveSkillFromUrl({ msgEl });
  if (activeTab === 'dir') return _saveSkillFromDir({ msgEl });
  return _saveSkillManual({ editId: '', msgEl });
}
window.saveSkill = saveSkill;

async function _saveSkillManual({ editId, msgEl }) {
  const rawName = document.getElementById('skill-name').value;
  const name = rawName.trim();
  const description = document.getElementById('skill-description').value.trim();
  if (!name) {
    msgEl.textContent = t('skills.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-name').focus();
    return;
  }
  if (!_isValidSkillNameCharset(rawName)) {
    msgEl.textContent = t('skills.name_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-name').focus();
    return;
  }
  if (!description) {
    msgEl.textContent = t('skills.input_desc_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-description').focus();
    return;
  }
  const tracking = editId ? null : _skillCreateTracking('manual', { category: 'general' });
  try {
    // Create: stamp the marketplace default since the modal has no category picker.
    // Edit: omit category so the on-disk frontmatter value is preserved (LLM-authored
    // edits via `skill-creator` are the only source of category mutation).
    const body = editId ? { name, description } : { name, description, category: 'general' };
    const res = editId
      ? await apiFetch(`/api/skills/${editId}/update`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await apiFetch('/api/skills/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
    const data = await res.json();
    if (!data.ok) {
      msgEl.textContent = data.error || t('skills.save_failed');
      msgEl.className = 'form-msg err';
      if (tracking) {
        _skillCreateTrackResult(tracking, 'failure', {
          category: 'general',
          error_code: data.code || '',
        });
        _skillCreateTrackError(tracking, {
          category: 'general',
          error_type: 'api',
          error_code: data.code || '',
          error_message: data.error || 'unknown',
        });
      }
      return;
    }
    if (tracking) {
      _skillCreateTrackResult(tracking, 'success', {
        skill_id: _skillCreateIdFromResponse(data),
        ..._skillCreateResourceFromResponse(data, name),
        skill_count: _skillCreateCountFromResponse(data),
        category: 'general',
      });
    }
    await _afterSkillCreated(data.skill?.id || editId, !editId, null);
  } catch (e) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
    if (tracking) {
      _skillCreateTrackResult(tracking, 'failure', { category: 'general' });
      _skillCreateTrackError(tracking, {
        category: 'general',
        error_type: 'network',
        error_message: e && e.message ? e.message : String(e),
      });
    }
  }
}

async function _saveSkillFromUrl({ msgEl }) {
  const url = document.getElementById('skill-url-input').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    msgEl.textContent = t('skill_modal.err_url_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-url-input').focus();
    return;
  }
  const tracking = _skillCreateTracking('url');
  try {
    msgEl.textContent = t('skills.saving');
    msgEl.className = 'form-msg';
    _setSkillModalBusy(true);
    await _waitForSkillModalBusyPaint();
    const res = await apiFetch('/api/skills/create-from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null, description: null, url }),
    });
    const data = await res.json();
    if (!data.ok) {
      msgEl.textContent = data.error || t('skills.save_failed');
      msgEl.className = 'form-msg err';
      _setSkillModalBusy(false);
      _skillCreateTrackResult(tracking, 'failure', {
        error_code: data.code || '',
      });
      _skillCreateTrackError(tracking, {
        error_type: 'api',
        error_code: data.code || '',
        error_message: data.error || 'unknown',
      });
      return;
    }
    const createdId = _skillCreateIdFromResponse(data);
    const autoSeed = _skillImportAutoSeedFromResponse(data);
    // URL imports start as empty placeholders. If the user backs out before
    // the edit chat authors real content, offer to discard that placeholder.
    _importDraftId = data.skill?.id && _skillAutoSeedHasModelText(autoSeed) ? data.skill.id : null;
    _skillCreateTrackResult(tracking, 'success', {
      skill_id: createdId,
      ..._skillCreateResourceFromResponse(data),
      skill_count: _skillCreateCountFromResponse(data),
    });
    await _afterSkillCreated(createdId, true, autoSeed);
  } catch (e) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
    _skillCreateTrackResult(tracking, 'failure');
    _skillCreateTrackError(tracking, {
      error_type: 'network',
      error_message: e && e.message ? e.message : String(e),
    });
  } finally {
    _setSkillModalBusy(false);
  }
}

async function _saveSkillFromDir({ msgEl }) {
  const srcDir = document.getElementById('skill-dir-path').value.trim();
  if (!srcDir) {
    msgEl.textContent = t('skill_modal.err_dir_missing');
    msgEl.className = 'form-msg err';
    return;
  }
  return _saveSkillFromDirWithQuality({
    msgEl,
    srcDir,
    force: false,
    tracking: _skillCreateTracking('dir', { forced: false }),
  });
}

function _qualityImportRejectedTitle(name) {
  const tmpl = t('quality.import_rejected_title');
  const fallback = `Import rejected by quality validator: ${name}`;
  return tmpl === 'quality.import_rejected_title'
    ? fallback
    : tmpl.replace('{name}', name);
}

async function _saveSkillFromDirWithQuality({ msgEl, srcDir, force, tracking }) {
  tracking = tracking || _skillCreateTracking('dir', { forced: !!force });
  try {
    msgEl.textContent = t('skills.saving');
    msgEl.className = 'form-msg';
    _setSkillModalBusy(true);
    await _waitForSkillModalBusyPaint();
    const res = await apiFetch('/api/skills/create-from-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null, description: null, srcDir, ...(force ? { force: true } : {}) }),
    });
    const data = await res.json();
    if (!data.ok) {
      _setSkillModalBusy(false);
      if (data.report && typeof window.showImportCheckResult === 'function') {
        const titleName = data.skillId || srcDir.split(/[\\/]/).filter(Boolean).pop() || srcDir;
        // W5: 统一弹窗——拒绝时用"已拦截/不可用"状态，发现列表来自质量报告，
        // 无强制安装动作（EXTREME 不可覆盖，与主进程一致）。
        const findings = (data.report.violations || []).map((v) => ({
          level: v && v.level ? v.level : 'LOW',
          text: (typeof window.importCheckFindingText === 'function'
            ? window.importCheckFindingText(v.rule)
            : '') || (v && v.suggested_fix) || (v && v.rule) || '',
          loc: (v && v.field) || '',
        }));
        await window.showImportCheckResult({
          skillName: titleName,
          source: 'folder',
          state: data.securityUnavailable ? 'unavailable' : 'blocked',
          ...(data.securityScan && typeof data.securityScan.score === 'number'
            ? { score: data.securityScan.score } : {}),
          surface: _importCheckSurface(data.securityScan),
          findings,
        });
        _skillCreateTrackResult(tracking, 'blocked', {
          forced: false,
          error_code: data.code || 'quality_validation',
        });
        _skillCreateTrackError(tracking, {
          forced: false,
          error_type: 'validation',
          error_code: data.code || 'quality_validation',
          error_message: data.error || 'quality validation failed',
        });
        msgEl.textContent = data.error || t('skills.save_failed');
        msgEl.className = 'form-msg err';
        return;
      }
      msgEl.textContent = data.error || t('skills.save_failed');
      msgEl.className = 'form-msg err';
      _skillCreateTrackResult(tracking, 'failure', {
        forced: !!force,
        error_code: data.code || '',
      });
      _skillCreateTrackError(tracking, {
        forced: !!force,
        error_type: data.report ? 'validation' : 'api',
        error_code: data.code || '',
        error_message: data.error || 'unknown',
      });
      return;
    }
    const createdId = _skillCreateIdFromResponse(data);
    _skillCreateTrackResult(tracking, 'success', {
      skill_id: createdId,
      ..._skillCreateResourceFromResponse(data),
      skill_count: _skillCreateCountFromResponse(data),
      forced: !!force,
    });
    // W5: 统一弹窗——通过/有提示/不可用三态；删除则不再进入详情页。
    const importAction = await _showImportCheckModal({
      skillName: createdId,
      source: 'folder',
      skillId: createdId,
      scan: data.securityPass || data.securityScan || null,
      unavailable: !!data.securityUnavailable,
    });
    if (importAction !== 'delete') {
      await _afterSkillCreated(createdId, true, _skillImportAutoSeedFromResponse(data));
    }
  } catch (e) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
    _skillCreateTrackResult(tracking, 'failure', { forced: !!force });
    _skillCreateTrackError(tracking, {
      forced: !!force,
      error_type: 'network',
      error_message: e && e.message ? e.message : String(e),
    });
  } finally {
    _setSkillModalBusy(false);
  }
}

// Shared "after create" tail: close modal, refresh list, jump to edit view.
// `autoSeed` — optional first message descriptor for the skill edit chat.
//              Pass null to let toggleSkillEditMode use its default seed
//              ("help me refine this skill"). Pass false to skip entering
//              edit chat. Ignored in edit mode (isNew=false).
async function _afterSkillCreated(sid, isNew, autoSeed) {
  closeSkillModal();
  _skillsCache = null;
  await loadSkills();
  if (!sid) return;
  setView('skills');
  // Jump straight into detail view for the new skill (skipping the grid
  // landing) so the user can see what they just created and start editing.
  // This must finish before entering edit chat: selectSkillFile() owns the
  // detail/chat visibility state, so racing it against toggleSkillEditMode()
  // can leave imports on the readonly detail page.
  await _showSkillsDetailView('custom', sid, { expandSource: false });
  if (isNew) {
    if (!_selectedSkill || _selectedSkill.source !== 'custom' || _selectedSkill.id !== sid) {
      _selectedSkill = { source: 'custom', id: sid, filepath: 'SKILL.md' };
    }
    if (autoSeed === false) return;
    await toggleSkillEditMode({ autoSeed: autoSeed || true });
    Promise.resolve().then(() => {
      if (_selectedSkill?.source === 'custom' && _selectedSkill?.id === sid) {
        return _ensureSkillsSourceExpanded();
      }
    }).catch(() => {});
  }
}

// ─── 导入检查结果弹窗（W5：文件夹 / URL 统一）───────────────────────────
async function _importCheckQualityFindings(skillId) {
  if (typeof readQualityReport !== 'function') return [];
  try {
    const report = await readQualityReport('skill', skillId);
    const violations = Array.isArray(report?.violations) ? report.violations : [];
    return violations.map((v) => ({
      level: v && v.level ? v.level : 'LOW',
      text: (typeof window.importCheckFindingText === 'function'
        ? window.importCheckFindingText(v.rule)
        : '') || (v && v.suggested_fix) || (v && v.rule) || '',
      loc: (v && v.field) || '',
    }));
  } catch (_) { return []; }
}

function _importCheckSurface(scan) {
  const s = scan && scan.attackSurface;
  if (!s) return null;
  return {
    egressPoints: s.egressPoints ?? 0,
    dynamicExecPoints: s.dynamicExecPoints ?? 0,
    persistencePoints: s.persistencePoints ?? 0,
  };
}

function _importCheckStateFrom(scan, unavailable) {
  if (unavailable) return 'unavailable';
  const o = scan && scan.outcome;
  if (o === 'restricted') return 'risk';
  if (o === 'blocked') return 'blocked';
  if (o === 'pass') return 'pass';
  return 'unavailable';
}

/**
 * 展示统一的导入检查弹窗并处理动作。
 * 返回最终动作（'done'/'keep'/'draft'/'view'/'close'/'delete'）；recheck 在内部
 * 循环（重跑准入并原地更新），export 在内部下载脱敏 JSON 后保持弹窗打开。
 */
async function _showImportCheckModal({ skillName, source, skillId, scan, unavailable }) {
  if (typeof window.showImportCheckResult !== 'function') return 'close';
  const findings = await _importCheckQualityFindings(skillId);
  // NSEAP 声明预检并入统一弹窗（low 级发现行），编辑会话的 Done 预检随后跳过一次。
  try {
    const precheck = await window.cogseed.invoke('skills.checkNseapDeclaration', { id: skillId });
    for (const line of _nseapDeclarationLines(precheck?.nseapDeclaration)) {
      findings.push({ level: 'LOW', text: line.replace(/^•\s*/, ''), loc: 'NSEAP' });
    }
  } catch (_) { /* advisory only */ }
  _importCheckPopupShownFor = skillId;
  for (;;) {
    const action = await window.showImportCheckResult({
      skillName,
      source,
      state: _importCheckStateFrom(scan, unavailable),
      ...(scan && typeof scan.score === 'number' ? { score: scan.score } : {}),
      surface: _importCheckSurface(scan),
      findings,
    });
    if (action === 'recheck') {
      try {
        const r = await window.cogseed.invoke('skills.admit', { skillId });
        const a = r && r.admission;
        scan = a && a.scan ? a.scan : scan;
        unavailable = !a || a.outcome === 'unknown';
      } catch (_) { unavailable = true; }
      continue;
    }
    if (action === 'delete') {
      try {
        await apiFetch(`/api/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' });
      } catch (_) { /* best effort */ }
      _skillsCache = null;
      await loadSkills();
      return 'delete';
    }
    if (action === 'export') {
      const blob = new Blob([JSON.stringify({
        skillName, source,
        outcome: scan && scan.outcome,
        score: scan && scan.score,
        attackSurface: scan && scan.attackSurface,
        findings,
      }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `import-check-${String(skillName || 'skill').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      continue;
    }
    return action;
  }
}

async function _showUrlImportCheckResult(skillId) {
  try {
    const r = await window.cogseed.invoke('skills.admit', { skillId });
    const a = r && r.admission;
    await _showImportCheckModal({
      skillName: skillId, source: 'url', skillId,
      scan: a && a.scan, unavailable: !a || a.outcome === 'unknown',
    });
  } catch (_) {
    await _showImportCheckModal({ skillName: skillId, source: 'url', skillId, scan: null, unavailable: true });
  }
}

async function _afterImportedSkill(data) {
  closeSkillModal();
  _skillsCache = null;
  await loadSkills();
  setView('skills');

  const skills = Array.isArray(data?.skills) ? data.skills : (data?.skill ? [data.skill] : []);
  const ids = skills.map((s) => String(s?.id || '')).filter(Boolean);
  const names = skills.map((s) => String(s?.name || s?.id || '')).filter(Boolean).join('、');

  const warnings = [];
  if (typeof readQualityReport === 'function') {
    for (const id of ids) {
      try {
        const report = await readQualityReport('skill', id);
        const violations = Array.isArray(report?.violations) ? report.violations : [];
        for (const v of violations) {
          if (!v) continue;
          warnings.push(`• ${String(v.rule || '')}${v.field ? ` · ${String(v.field)}` : ''}`);
        }
      } catch (_) { /* report is best-effort */ }
    }
  }

  const nseapWarnings = ids.flatMap((id) => {
    const cached = (_skillsCache || []).find((s) => String(s?.id || '') === id);
    return _nseapDeclarationLines(cached?.security?.nseapDeclaration);
  });

  const seen = new Set();
  const uniqueWarnings = warnings
    .filter((w) => {
      if (seen.has(w)) return false;
      seen.add(w);
      return true;
    })
    .slice(0, 8);
  const seenNseap = new Set();
  const uniqueNseapWarnings = nseapWarnings
    .filter((w) => {
      if (seenNseap.has(w)) return false;
      seenNseap.add(w);
      return true;
    })
    .slice(0, 8);

  const lines = [t('skills.import_review_body', { count: ids.length })];
  if (names) lines.push(`\n${names}`);
  // W5: surface the deep-scan verdict the import already produced. The copy
  // existed since the security-import work but had no consumer; a restricted
  // or degraded scan is exactly the one thing the author should know before
  // keeping the import, and it stays one quiet line — never a second dialog.
  const scanOutcome = data && (data.securityPass?.outcome || data.securityScan?.outcome);
  const scanDegraded = !!(data && (data.securityPass?.rulesDegraded || data.securityScan?.rulesDegraded));
  if (scanOutcome === 'restricted') {
    lines.push(`\n${scanDegraded ? t('skills.security_import_degraded') : t('skills.security_import_restricted')}`);
  }
  if (uniqueWarnings.length) {
    lines.push(`\n${t('skills.import_review_issues')}\n${uniqueWarnings.join('\n')}`);
  }
  if (uniqueNseapWarnings.length) {
    lines.push(`\n${t('skills.import_review_nseap_issues')}\n${uniqueNseapWarnings.join('\n')}`);
  }
  if (!uniqueWarnings.length && !uniqueNseapWarnings.length) {
    lines.push(`\n${t('skills.import_review_no_issues')}`);
  }

  const choice = typeof uiChoice === 'function'
    ? await uiChoice({
      title: t('skills.import_review_title'),
      message: lines.join('\n'),
      choices: [
        { id: 'keep', label: t('skills.import_review_keep'), style: 'primary' },
        { id: 'discard', label: t('skills.import_review_discard'), style: 'danger' },
      ],
    })
    : 'keep';

  if (choice !== 'discard') return;

  await Promise.allSettled(ids.map((id) => apiFetch(`/api/skills/${id}`, { method: 'DELETE' })));
  _skillsCache = null;
  await loadSkills();
}

function editSelectedSkill() {
  if (!_selectedSkill || _selectedSkill.source !== 'custom') return;
  // Custom skills are edited via the inline AI chat (already visible on the right)
  const input = document.getElementById('skills-chat-input');
  if (input) {
    input.focus();
    // Scroll chat into view if needed
    input.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
}

async function deleteSelectedSkill() {
  if (!_selectedSkill) return;
  const src = _selectedSkill.source;
  if (src !== 'custom' && !(_isSkillPlatformSource(src) && false)) return;
  const sid = _selectedSkill.id;
  const cached = _skillsCache?.find(s => s.id === sid && s.source === src);
  if (!(await uiConfirm(t('skills.delete_confirm', { name: cached?.name || sid })))) return;
  try {
    const result = _isSkillPlatformSource(src)
      ? await window.cogseed.invoke('skills.builtin.delete', { id: sid })
      : await (await apiFetch(`/api/skills/${sid}`, { method: 'DELETE' })).json();
    if (!result.ok) {
      await uiAlert(t('skills.delete_failed_with', { reason: result.error || '' }));
      return;
    }
    _selectedSkill = null;
    _skillsCache = null;
    _skillTreeCache.clear();
    await loadSkills();
    // Snap back to grid view (detail panel is for whole skills, the one
    // we just deleted no longer exists).
    _showSkillsGridView();
  } catch (e) {
    await uiAlert(t('skills.delete_failed_with', { reason: e.message || e }));
  }
}

/**
 * Per-skill enable / disable button in the detail header.
 * Clone-replace the node each render to drop any prior click handler
 * bound to a stale skill id. The button label flips between "enable"
 * and "disable" (whichever the click would do).
 */
function _renderSkillEnabledButton(skill) {
  const oldBtn = document.getElementById('skill-enabled-btn');
  if (!oldBtn) return;
  const enabled = skill.enabled !== false;
  const btn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(btn, oldBtn);
  btn.textContent = enabled ? t('component.disable') : t('component.enable');
  btn.title = enabled ? t('component.toggle_disable_hint') : t('component.toggle_enable_hint');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await _flipSkillEnabled(skill.id, !enabled); }
    finally { btn.disabled = false; }
  });
}
