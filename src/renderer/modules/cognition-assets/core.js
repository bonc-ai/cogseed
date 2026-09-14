/* ============================================================================
 * 认知资产 · 核心层（cognition-assets/core.js）
 *
 * 从零重写的认知资产前端。与旧实现（skills.js 里 4600 行 + skills-bindings
 * 分散绑定 + 175 行面板标记）的三点结构差异：
 *
 *  1. 单一命名空间 `window.CogAssets`：api / store / router / ui / actions
 *     各司其职，视图只依赖这一份契约；
 *  2. 状态驱动渲染：所有数据进 store，动作完成后 `reload()` 重取 + `render()` 
 *     重画，不存在"哪个 DOM 谁负责"的隐性分工；
 *  3. 事件全在一个委托层（app.js）：所有交互走 `data-go` / `data-act`，
 *     不再有散落各处的 addEventListener。
 *
 * 后端契约（IPC）不变：本文件是唯一调用窗口。
 * ========================================================================== */
(function () {
  'use strict';

  const NS = window.CogAssets = window.CogAssets || {};
  NS.version = '2.0.0';

  /* ────────────────────────── i18n ────────────────────────── */

  /** 取文案：优先 locale，缺键时用内联回退。与渲染层全局 t() 同源。 */
  function T(key, fallback, vars) {
    let text = key;
    try {
      if (typeof window.t === 'function') text = window.t(key, vars);
    } catch (_) { /* locale 未就绪时退回 key */ }
    if (!text || text === key) text = fallback != null ? fallback : key;
    if (vars) {
      // 命中 locale 与回退两条路径都做占位替换：回退文案同样带 {n} 占位，
      // 不替换的话缺键语言下数字会原样显示成 "{n}"。
      for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v));
    }
    return text;
  }
  NS.T = T;

  /* ────────────────────────── 基础工具 ────────────────────────── */

  const esc = (value) => (typeof window.escapeHtml === 'function'
    ? window.escapeHtml(value == null ? '' : String(value))
    : String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  NS.esc = esc;

  const toArr = (value, keys) => {
    if (Array.isArray(value)) return value;
    for (const key of keys || []) {
      if (value && Array.isArray(value[key])) return value[key];
    }
    return [];
  };

  const fmtDate = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  NS.fmtDate = fmtDate;

  const toast = (message, variant) => {
    if (typeof window.uiToast === 'function') window.uiToast(message, { variant: variant || 'success' });
  };
  NS.toast = toast;

  const alertUser = async (message) => {
    if (typeof window.uiAlert === 'function') await window.uiAlert(message);
  };
  NS.alertUser = alertUser;

  const confirmUser = async (message, danger) => {
    if (danger && typeof window.uiConfirmDanger === 'function') {
      return !!(await window.uiConfirmDanger({ message, dangerLabel: T('common.confirm', '确认'), cancelLabel: T('common.cancel', '取消') }));
    }
    if (typeof window.uiConfirm === 'function') return !!(await window.uiConfirm(message));
    return false;
  };
  NS.confirmUser = confirmUser;

  /* ────────────────────────── API 客户端 ────────────────────────── */

  const api = {
    /** 唯一 IPC 出口。错误统一抛 Error（带 code），调用方 try/catch 兜底。 */
    async call(channel, payload) {
      const result = await window.cogseed.invoke(channel, payload || {});
      if (result && result.ok === false) {
        const error = new Error(result.error || result.message || `ipc failed: ${channel}`);
        error.code = result.code || '';
        throw error;
      }
      return result == null ? {} : result;
    },
    /** 容错读：失败返回 fallback 并记录到 store.errors，页面照常渲染。 */
    async soft(channel, payload, fallback) {
      try {
        return await api.call(channel, payload);
      } catch (error) {
        store.errors.push({ channel, message: String(error && error.message || error) });
        return fallback;
      }
    },
  };
  NS.api = api;

  /* ────────────────────────── 状态仓库 ────────────────────────── */

  const store = {
    loaded: false,
    loading: false,
    errors: [],
    assets: [],
    candidates: [],
    captures: [],
    captureCounts: {},
    captureSettings: null,
    sources: [],
    teaching: [],
    inboxItems: [],
    experiences: [],
    experienceTotal: 0,
    tree: null,
    proofs: [],
    /** 使用记录页：哪些资产卡片被展开（assetId 集合；重画后保留）。 */
    expandedProofs: new Set(),
    continuationCount: 0,
    loadedAt: 0,
    /** 路由：{name, category, assetId, candidateId, manageTab, proofEventId} */
    route: { name: 'overview', category: '', assetId: '', candidateId: '', manageTab: 'sources', proofEventId: '' },
    backStack: [],
  };
  NS.store = store;

  /** 派生统计：全部从这里取，视图不自己算口径。 */
  NS.stats = function stats() {
    const s = store;
    const confirmed = s.assets.filter((a) => String(a.status || 'active') !== 'archived').length;
    const pending = s.candidates.filter((c) => (c.capabilities && c.capabilities.countsAsPending) || false).length;
    const validated = s.assets.filter((a) => a.maturity === 'effectiveness_validated').length;
    const transferOk = s.assets.filter((a) => a.maturity === 'transfer_validated' || a.maturity === 'effectiveness_validated').length;
    const sourceIssues = s.sources
      .flatMap((group) => (Array.isArray(group.items) ? group.items : []))
      .filter((item) => item.status === 'failed' || item.status === 'paused').length;
    const failedTasks = Number(s.captureCounts && s.captureCounts.failed || 0);
    const coveredAssets = new Set(s.proofs.map((p) => String((p.refs || {}).assetId || '')).filter(Boolean)).size;
    const attention = s.assets.filter((a) => String(a.status || 'active') === 'paused' || String(a.status || '') === 'archived').length;
    return { confirmed, pending, validated, transferOk, sourceIssues, failedTasks, coveredAssets, proofCount: s.proofs.length, attention };
  };

  /* ────────────────────────── 数据加载 ────────────────────────── */

  const LOADERS = {
    async snapshot() {
      store.errors = [];
      const [assets, candidates, captures, settings, sources, teaching, inbox, experiences] = await Promise.all([
        api.soft('recall.assets.list', {}, {}),
        api.soft('recall.candidates.list', {}, {}),
        api.soft('recall.captures.list', { limit: 40 }, {}),
        api.soft('recall.captures.settings.get', {}, {}),
        api.soft('recall.sources.list', {}, {}),
        api.soft('recall.teaching.list', {}, {}),
        api.soft('cognition.inbox.list', {}, {}),
        api.soft('kstar.experiences.list', {}, {}),
      ]);
      store.assets = toArr(assets, ['assets', 'items']);
      store.candidates = toArr(candidates, ['candidates', 'items']);
      store.captures = toArr(captures, ['items', 'captures', 'tasks']);
      store.captureCounts = (captures && captures.counts) || {};
      store.captureSettings = (settings && settings.settings) || settings || null;
      store.sources = toArr(sources, ['groups', 'sources']);
      store.teaching = toArr(teaching, ['signals', 'items']);
      store.inboxItems = toArr(inbox, ['items']);
      // 提炼出的经验（KSTAR review 里 lesson 非空的记录，含沉淀状态）；失败不阻塞主快照。
      store.experiences = toArr(experiences, ['experiences', 'items']);
      store.experienceTotal = Number((experiences && experiences.total) || store.experiences.length) || 0;
      // 来源条目被包在分组里；补一层拍平给统计与详情用。
      store.sources.forEach((group) => {
        (Array.isArray(group.items) ? group.items : []).forEach((item) => { item.__groupKind = group.kind || ''; });
      });
      // 证明链只服务「使用与证明」与成熟度展示，失败不阻塞主快照。
      // 通道是语义化的时间线（recall.timeline.list）：每条事件带 refs
      // （assetId / transferProofId / usageReceiptId / version），与旧实现同源。
      const proofs = await api.soft('recall.timeline.list', { limit: 500 }, {});
      store.proofs = toArr(proofs, ['items', 'events']);
      store.loadedAt = Date.now();
      store.loaded = true;
    },
    async tree() {
      const result = await api.soft('recall.tree.read', { rebuild: true }, {});
      const tree = result && result.tree ? result.tree : result;
      if (tree && (tree.nodes || tree.edges || tree.error)) store.tree = tree;
    },
  };
  NS.loaders = LOADERS;

  const listeners = new Set();
  NS.onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  NS.reload = async function reload(options) {
    const opts = options || {};
    if (opts.tree) { await LOADERS.tree(); listeners.forEach((fn) => fn()); return; }
    if (store.loading) return;
    store.loading = true;
    listeners.forEach((fn) => fn());
    try {
      await LOADERS.snapshot();
    } finally {
      store.loading = false;
      listeners.forEach((fn) => fn());
    }
  };
  NS.notify = () => listeners.forEach((fn) => fn());

  /* ────────────────────────── 路由 ────────────────────────── */

  const TABS = [
    { id: 'overview', titleKey: 'cognition.tab_overview', title: '我的认知', descKey: 'cognition.tab_overview_desc', desc: '我拥有什么' },
    { id: 'review', titleKey: 'cognition.tab_review', title: '待我处理', descKey: 'cognition.tab_review_desc', desc: '需要我决定什么' },
    { id: 'evidence', titleKey: 'cognition.tab_evidence', title: '使用记录', descKey: 'cognition.tab_evidence_desc', desc: '资产用得怎么样' },
    { id: 'manage', titleKey: 'cognition.tab_manage', title: '设置与管理', descKey: 'cognition.tab_manage_desc', desc: '来源与整理' },
  ];
  NS.TABS = TABS;

  /** 旧页面名 → 新路由（兼容 boot.js 深链与老入口）。 */
  const LEGACY = {
    assets: { name: 'overview' }, brain: { name: 'overview' }, context: { name: 'overview' },
    ontology: { name: 'overview', category: 'personal' }, tree: { name: 'overview' },
    inbox: { name: 'review' }, overview: { name: 'review' }, candidates: { name: 'manage', manageTab: 'organize' },
    captures: { name: 'manage', manageTab: 'organize' }, deposition: { name: 'manage', manageTab: 'organize' },
    sources: { name: 'manage', manageTab: 'sources' }, proofs: { name: 'evidence' }, receipts: { name: 'evidence' },
    governance: { name: 'overview' }, candidate: { name: 'review' },
    nonasset: { name: 'overview' }, skillupdate: { name: 'overview' },
  };
  NS.LEGACY = LEGACY;

  const router = {
    go(next, options) {
      const opts = options || {};
      const current = store.route;
      const same = JSON.stringify(current) === JSON.stringify(next);
      if (!opts.replace && !same) store.backStack.push(Object.assign({}, current));
      store.route = Object.assign({ name: 'overview', category: '', assetId: '', candidateId: '', manageTab: 'sources', proofEventId: '' }, next);
      NS.notify();
      const main = document.getElementById('ca-scroll');
      if (main) main.scrollTop = 0;
    },
    back() {
      const prev = store.backStack.pop();
      if (prev) router.go(prev, { replace: true });
    },
    legacy(page) {
      const mapped = LEGACY[page] || { name: 'overview' };
      router.go(Object.assign({ name: 'overview', category: '', assetId: '', candidateId: '', manageTab: 'sources', proofEventId: '' }, mapped));
    },
  };
  NS.router = router;

  /* ────────────────────────── 错误文案（自 skills-bindings.js 迁入） ────────────────────────── */
  /* 后端抛的 message 是内部契约语言（`no successful transfer proof for task
   * run`、`recall candidate is terminal` 等），不能原样给用户看：按 result.code
   * 翻译；取不到已知码时退回原始 error——宁可露出英文也不吞掉失败。
   * 码表：proof-service.ts::recallProofError / candidate-capabilities.ts /
   * promotion.ts::PromotionBlockReason。 */

  const RECALL_CANDIDATE_ERROR_TEXTS = {
    recall_candidate_terminal: ['cognition.candidate_error_terminal',
      '这条候选已经处理过了（已确认、已拒绝或已失效），不能再改。回「待我处理」看当前待办。'],
    recall_candidate_not_promotable: ['cognition.candidate_error_not_promotable',
      '这条候选现在不能确认为正式资产。'],
    recall_candidate_not_found: ['cognition.candidate_error_not_found',
      '这条候选已经不在了，可能已被处理或已过期。'],
    recall_candidate_duplicate: ['cognition.candidate_error_duplicate',
      '已经有一条内容相同的候选，先去处理那一条。'],
    recall_candidate_handoff_incomplete: ['cognition.candidate_error_handoff_incomplete',
      '上一次确认没有走完，资产还没落定。先重试确认，再修改内容。'],
    recall_candidate_evidence_insufficient: ['cognition.candidate_error_evidence_insufficient',
      '证据不足：补上可追溯的证据引用后才能确认。'],
    recall_candidate_risk_gate: ['cognition.candidate_error_risk_gate',
      '这是高风险变更，需要你单独确认后才能保存。'],
    recall_candidate_non_asset_decision: ['cognition.candidate_error_non_asset_decision',
      '这条候选的结论是「保持当前版本」或「拒绝」，不走确认为资产这条路。'],
    recall_candidate_security_blocked: ['cognition.candidate_error_security_blocked',
      '内容被认知安全闸门拦下，不能沉淀为资产。'],
    recall_candidate_unknown_source: ['cognition.candidate_error_unknown_source',
      '有一条证据引用在来源列表里找不到，不能保存。证据只能从真实来源中选取。'],
    recall_capture_not_review_ready: ['cognition.candidate_error_capture_not_review_ready',
      '它所属的沉淀任务还没到可复核状态，稍后再确认。'],
    recall_capture_writing: ['cognition.candidate_error_capture_writing',
      '它所属的沉淀任务正在写入，等这一次写完再试。'],
  };

  /** 晋升闸门的拦截原因。与 promotion.ts::PromotionBlockReason 一一对应。 */
  const RECALL_PROMOTION_BLOCK_TEXTS = {
    personal_is_project_fact: ['cognition.candidate_block_personal_is_project_fact',
      '这是项目或任务事实，它属于项目，不属于「关于我」。'],
    template_not_reusable_structure: ['cognition.candidate_block_template_not_reusable_structure',
      '模板要的是从来源里抽出来的可复用结构，指向原文件本身不算。'],
    skill_not_executable: ['cognition.candidate_block_skill_not_executable',
      '方法要写成可执行、可检验的样子，能力自述不算。'],
    rule_boundary_required: ['cognition.candidate_block_rule_boundary_required',
      '规则要先确认适用与禁止范围。'],
    judgment_is_meta_commentary: ['cognition.candidate_block_judgment_is_meta_commentary',
      '这段判断是在评价这条候选本身，不是可复用的内容。'],
    type_conflicts_with_existing: ['cognition.candidate_block_type_conflicts_with_existing',
      '同一句话已经以另一种类型存在，分类不可信；先裁定它到底属于哪一类。'],
  };

  /** 把 IPC 失败体（{code, error, promotionReasons}）翻成给用户看的话。 */
  NS.recallErrorText = function recallErrorText(result) {
    const code = String((result && result.code) || '');
    if (code === 'promotion_blocked') {
      const reasons = Array.isArray(result && result.promotionReasons) ? result.promotionReasons : [];
      const lines = reasons
        .map((reason) => RECALL_PROMOTION_BLOCK_TEXTS[reason])
        .filter(Boolean)
        .map((entry) => `· ${T(entry[0], entry[1])}`);
      const head = T('cognition.candidate_error_promotion_blocked', '这条候选还不够格成为正式资产：');
      return lines.length
        ? `${head}\n${lines.join('\n')}`
        : `${head}${T('cognition.candidate_error_promotion_blocked_unknown', '请检查内容、类型与作用范围。')}`;
    }
    const entry = RECALL_CANDIDATE_ERROR_TEXTS[code];
    if (entry) return T(entry[0], entry[1]);
    return (result && result.error) || T('cognition.candidate_error_generic', '这次操作没有完成，请稍后重试。');
  };

  /** 手动沉淀（整理会话）失败的错误文案：已知内部消息翻成人话，
   *  未知错误原样透出（不吞失败）。自 skills-bindings.js 迁入。 */
  NS.captureErrorText = function captureErrorText(error) {
    const raw = String(error && error.message ? error.message : error || '').trim();
    const messages = {
      'conversation has no completed exchange': ['cognition.capture_error_no_completed_exchange', '当前会话还没有完成一轮问答，暂时无法沉淀。'],
      'conversation is still waiting for a response': ['cognition.capture_error_waiting_response', '当前会话仍在等待回复，完成后才能沉淀。'],
      'recall capture is disabled': ['cognition.capture_error_disabled', '沉淀功能已关闭，请先在沉淀设置中开启。'],
      'conversation not found': ['cognition.capture_error_conversation_not_found', '找不到这个会话，暂时无法沉淀。'],
    };
    const localized = messages[raw];
    if (localized) return T(localized[0], localized[1]);
    return raw || T('cognition.capture_error_unknown', '沉淀任务发生未知错误');
  };

  /* ────────────────────────── 动作层 ────────────────────────── */
  /* 所有写操作收口在这里：调用 IPC → toast → reload。视图里不允许直接 invoke。 */

  const CANDIDATE_CHANNELS = {
    reject: 'recall.candidates.reject',
    ignore: 'recall.candidates.ignore',
    'keep-current': 'recall.candidates.keepCurrent',
    defer: 'recall.candidates.defer',
    resume: 'recall.candidates.resume',
  };

  const actions = {
    /** 采纳：可选携带编辑后的字段（adjust=true 时从表单读取）。 */
    async adoptCandidate(candidateId, formValues) {
      const candidate = store.candidates.find((c) => c.id === candidateId);
      if (!candidate) return;
      if (candidate.risk === 'high') {
        const ok = await confirmUser(T('cognition.candidate_high_risk_confirm', '这是高风险资产变更。确认继续保存吗？'));
        if (!ok) return;
      }
      if (formValues) {
        await api.call('recall.candidates.update', Object.assign({
          candidateId,
          value: candidate.value || '',
          suggestedAction: candidate.suggestedAction || 'create',
          risk: candidate.risk || 'low',
          expiresAt: candidate.expiresAt,
          taskRunId: candidate.taskRunId,
          targetAssetId: candidate.targetAssetId,
          // 证据与适用/禁止边界不在表单里编辑：原样带回，防止一次"调整后采纳"
          // 把候选原有的证据链与边界静默清空。
          sourceRefs: candidate.evidenceRefs || candidate.sourceRefs || [],
          evidenceRefs: candidate.evidenceRefs || candidate.sourceRefs || [],
          applicableWhen: candidate.applicableWhen || [],
          forbiddenWhen: candidate.forbiddenWhen || [],
        }, formValues));
      } else if (!String(candidate.suggestedScope || '').trim()) {
        await alertUser(T('cognition.candidate_scope_required', '先填写作用范围：没有范围的资产不会被带入任何任务。'));
        return;
      }
      const result = await api.call('recall.candidates.promote', { candidateId, ...(candidate.risk === 'high' ? { riskAcknowledged: true } : {}) });
      // 晋升可能改变个人画像投影：异步刷新本体，失败只提醒不阻断（资产已落库）。
      void (async () => {
        if (typeof window.refreshPersonalOntology !== 'function') return;
        try {
          await window.refreshPersonalOntology();
        } catch (error) {
          toast(T('personalOntology.profile_sync_warning', '资产已保存，个人画像自动更新未完成，稍后可重试。'), 'warning');
        }
      })();
      if (result && result.assetId) {
        toast(T('cognition.candidate_promoted', '已成为正式资产'), 'success');
        router.go({ name: 'overview', assetId: result.assetId });
      } else {
        toast(T('cognition.candidate_promoted', '已成为正式资产'), 'success');
        router.go({ name: 'review' });
      }
      await NS.reload();
    },
    async decideCandidate(candidateId, action) {
      const channel = CANDIDATE_CHANNELS[action];
      if (!channel) return;
      await api.call(channel, { candidateId });
      toast({ reject: T('cognition.candidate_rejected', '已拒绝'), defer: T('cognition.candidate_deferred', '已稍后处理'), ignore: T('cognition.candidate_ignored', '已忽略') }[action] || T('common.done', '已完成'));
      await NS.reload();
    },
    async rateProof(proofId, feedback, extra) {
      await api.call('recall.proofs.effectiveness.feedback', Object.assign({ transferProofId: proofId, feedback }, extra || {}));
      toast(T('cognition.proof_rating_done', '已记下这次评价'));
      await NS.reload();
    },
    async assetAction(assetId, action) {
      const channels = {
        pause: 'recall.assets.pause', resume: 'recall.assets.resume', revoke: 'recall.assets.revoke',
        archive: 'recall.assets.archive', restore: 'recall.assets.restore',
        delete: 'recall.assets.delete', purge: 'recall.assets.purge',
      };
      const channel = channels[action];
      if (!channel) return;
      const dangerCopy = {
        delete: T('cognition.asset_delete_confirm', '删除会从资产列表移除该资产，但保留历史；确认删除？'),
        purge: T('cognition.asset_purge_confirm', '彻底清除会删除全部历史与证据，且不可恢复。确认清除？'),
        revoke: T('cognition.asset_revoke_confirm', '撤回使用只影响未来的任务，历史记录保留。确认撤回？'),
      };
      if (dangerCopy[action]) {
        const ok = await confirmUser(dangerCopy[action], true);
        if (!ok) return;
      }
      await api.call(channel, { assetId });
      toast(T('cognition.asset_action_done', '已完成'));
      if (action === 'delete' || action === 'purge') router.go({ name: 'overview' });
      await NS.reload();
    },
    async sourceAction(kind, sourceId, action) {
      const channels = {
        pause: 'recall.sources.pause', resume: 'recall.sources.resume',
        retry: 'recall.sources.retry', reconnect: 'recall.sources.reconnect',
      };
      const channel = channels[action];
      if (!channel) return;
      await api.call(channel, { kind, sourceId });
      toast(T('common.done', '已完成'));
      await NS.reload();
    },
    async teachingRevoke(signalId) {
      await api.call('recall.teaching.revoke', { signalId });
      toast(T('cognition.teaching_revoke_done', '已撤销这条教学记录'));
      await NS.reload();
    },
    async captureAction(captureId, action) {
      const channels = {
        pause: 'recall.captures.pause', resume: 'recall.captures.resume', cancel: 'recall.captures.cancel',
        retry: 'recall.captures.retry', 'run-now': 'recall.captures.runNow',
      };
      const channel = channels[action];
      if (!channel) return;
      if (action === 'cancel') {
        const ok = await confirmUser(T('cognition.capture_cancel_confirm', '确认取消这个整理任务？'));
        if (!ok) return;
      }
      await api.call(channel, { captureId });
      toast(T('common.done', '已完成'));
      await NS.reload();
    },
    async organizeConversation(conversationId) {
      await api.call('recall.captures.historicalAutoStart', { conversationId });
      toast(T('cognition.capture_started', '已加入整理任务'));
      await NS.reload();
    },
    async updateCaptureSettings(patch) {
      const result = await api.call('recall.captures.settings.update', patch);
      store.captureSettings = (result && result.settings) || store.captureSettings;
      toast(T('common.saved', '已保存'));
      await NS.reload();
    },
  };
  NS.actions = actions;

  /** 旧全局入口兼容（boot.js 的深链调用它）。 */
  window.switchSkillsCognitionPage = function switchSkillsCognitionPage(page) {
    showRecallPanel();
    router.legacy(page);
  };

  /** 从会话消息的 [asset:<id>] 引用卡跳转到认知资产详情页。
   *  conversation.js 调用；不依赖调用方已在认知资产页。
   *  （旧定义在 skills-bindings.js，其词法依赖随 skills.js 瘦身删除，迁到这里。） */
  window.openCognitionAssetById = function openCognitionAssetById(assetId) {
    if (!assetId) return false;
    showRecallPanel();
    router.go({ name: 'overview', category: '', assetId: String(assetId) });
    return true;
  };

  /* ────────────────────────── 个人本体（内嵌工作台） ────────────────────────── */
  /* #panel-personal-ontology 整体内嵌在 #panel-recall（index.html，含骨架与
   * 「返回认知树」按钮），渲染函数来自 personal-ontology.js（随 recall 特性组
   * 加载）。旧实现的显隐控制在 skills.js 被删的 4549 行里；此处接管：
   * overview 常驻入口（views.js）+ boot.js 深链 + 面板内返回按钮。 */

  function showRecallPanel() {
    try {
      if (typeof window._setViewFromSidebar === 'function') window._setViewFromSidebar('recall');
      else document.getElementById('recall-btn')?.click();
    } catch (_) { /* 面板切换失败也要完成路由 */ }
  }

  function wireOntologyBackButton(section) {
    const back = section.querySelector('[data-cognition-subview-tree]');
    if (!back || back.dataset.ontologyBackWired === '1') return;
    back.dataset.ontologyBackWired = '1';
    back.addEventListener('click', () => { NS.closePersonalOntology(); });
  }

  NS.openPersonalOntology = async function openPersonalOntology() {
    showRecallPanel();
    const section = document.getElementById('skills-cognition-personal-ontology');
    if (!section) return;
    // 深链可能早于 recall 特性组加载完成：渲染函数不在时按需补载再画。
    if (typeof window.renderPersonalOntology !== 'function') {
      const load = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
      if (typeof load === 'function') {
        try { await load('personal-ontology'); } catch (_) { /* 渲染函数缺席时下面跳过 */ }
      }
    }
    // 独立界面（2026-09-14）：本体工作台独占内容区——收起新 UI 主体
    // （认知树/资产列表），不再以"树下方半页卡片"的形式共存。
    const appRoot = document.getElementById('ca-root');
    if (appRoot) appRoot.hidden = true;
    section.hidden = false;
    section.classList.add('is-standalone');
    wireOntologyBackButton(section);
    if (typeof window.renderPersonalOntology === 'function') {
      try { await window.renderPersonalOntology(); } catch (_) { /* 本体渲染失败不阻塞主 UI */ }
    }
  };

  NS.closePersonalOntology = function closePersonalOntology() {
    const section = document.getElementById('skills-cognition-personal-ontology');
    if (section) {
      section.hidden = true;
      section.classList.remove('is-standalone');
    }
    const appRoot = document.getElementById('ca-root');
    if (appRoot) appRoot.hidden = false;
    const main = document.getElementById('ca-scroll');
    if (main) main.scrollTop = 0;
  };
})();
