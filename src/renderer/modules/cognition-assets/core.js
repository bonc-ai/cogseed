/* ============================================================================
 * 认知资产 · 核心层（cognition-assets/core.js）
 *
 * `window.CogAssets` 提供 api / store / router / ui / actions。
 * 数据进入 store 后驱动视图重画；app.js 统一委托 data-go / data-act 交互。
 * 本文件集中管理 IPC、路由与动作，视图只消费状态。
 * ========================================================================== */
(function () {
  'use strict';

  const NS = window.CogAssets = window.CogAssets || {};
  const loadLog = typeof createLogger === 'function' ? createLogger('cognition-assets') : null;
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

  /* ── 显示截断（对齐后端 catalogTruncate）：截断、去尾标点、省略号 ── */
  function truncateText(value, limit) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    return text.slice(0, limit).replace(/[，、；：,;:\-—\s]+$/, '') + '…';
  }
  NS.truncateText = truncateText;

  /* ── 语义融合 / 归并链跟随 / 自动采纳门禁 / 引用去重：真源在后端 ──
   * 这些判定全部发生在主进程的写入路径上，渲染层只消费结果：
   *   · 句级语义融合（重述/改写/增量三档）→ src/main/features/recall/statement-fusion.ts
   *   · 归并链跟随、自动采纳门禁、证据引用去重 → src/main/features/recall/candidate-service.ts
   * 渲染层不维护这些业务判定的镜像，避免与主进程口径分叉。 */

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
    if (typeof window.uiModal === 'function' && typeof document !== 'undefined' && document.getElementById('ca-root')) {
      const dialog = window.uiModal({ title: String(message).split('\n')[0], closeLabel: T('common.close', '关闭'), bodyHtml: `<div class="ca-prototype-source-block">${esc(message)}</div>`, size: 'md', actions: [{ id: 'cancel', label: T('common.cancel', '取消') }, { id: 'confirm', label: T('common.confirm', '确认'), role: danger ? 'danger' : 'primary' }] });
      dialog.overlay.classList.add('ca-prototype-modal'); document.getElementById('ca-root').appendChild(dialog.overlay);
      return (await dialog).value === 'confirm';
    }
    if (danger && typeof window.uiConfirmDanger === 'function') {
      return !!(await window.uiConfirmDanger({ message, dangerLabel: T('common.confirm', '确认'), cancelLabel: T('common.cancel', '取消') }));
    }
    if (typeof window.uiConfirm === 'function') return !!(await window.uiConfirm(message));
    return false;
  };
  NS.confirmUser = confirmUser;

  /** 文本输入弹窗：经验归档原因必填；返回输入串，取消返回 null。
   *  与 confirmUser 同一来源（dialogs.js 的 uiPrompt），不引入新的弹窗形态；
   *  取不到共享弹窗时返回 null（fail-closed：宁可不做，不绕道 window.prompt）。 */
  const promptUser = async (message) => {
    if (typeof window.uiPrompt === 'function') {
      try { return await window.uiPrompt(message); } catch (_) { return null; }
    }
    return null;
  };
  NS.promptUser = promptUser;

  /* ────── 拦截原因可读化──────
   * 主进程的准入判定给两样东西：code（分类）与 blockRule（具体规则标识）。
   * 此前渲染层把 Error.message 原文甩给用户——英文 + 内部 id，等于"被拦了但
   * 不知道被什么拦"。按 blockRule 翻四语规则名，code 只
   * 作兜底；任何分支都不上屏原文，未知规则走兜底文案（如实说"当前不可引用"，
   * 不替主进程编一条规则）。 */
  function blockReasonText(error) {
    const rule = String((error && error.blockRule) || '');
    if (rule === 'paused') return T('cognition.block_reason_paused', '这条内容已被你暂停，当前不能引用');
    if (rule === 'archived') return T('cognition.block_reason_archived', '这条内容已归档，当前不能引用');
    if (rule === 'revoked') return T('cognition.block_reason_revoked', '这条内容已撤回使用，当前不能引用');
    if (rule === 'deleted') return T('cognition.block_reason_deleted', '这条内容已删除（保留期内可恢复），当前不能引用');
    if (rule === 'purged') return T('cognition.block_reason_purged', '这条内容已被彻底删除，不能引用');
    if (rule === 'inactive') return T('cognition.block_reason_inactive', '这条内容当前不在生效状态，不能引用');
    if (rule === 'missing') return T('cognition.block_reason_missing', '这条内容不存在，或已被彻底删除');
    if (rule === 'source_unavailable') return T('cognition.block_reason_source_unavailable', '来源授权已撤回或来源记录已失效，不能继续引用');
    if (rule === 'agent') return T('cognition.block_reason_agent', '接收方不在这条内容允许的 Agent 范围内');
    if (rule === 'scope') return T('cognition.block_reason_scope', '这条内容声明的作用范围不包含当前场景');
    if (rule === 'maturity') return T('cognition.block_reason_maturity', '这条内容的使用契约不允许这样带入');
    if (rule === 'forbidden_context') return T('cognition.block_reason_forbidden_context', '当前任务命中了这条内容声明的禁用场景');
    if (rule === 'not_applicable_context') return T('cognition.block_reason_not_applicable_context', '当前任务与这条内容声明的适用场景不匹配');
    if (rule === 'version_changed') return T('cognition.block_reason_version_changed', '引用的版本已经变化，请重新选择');
    if (rule === 'versions_missing') return T('cognition.block_reason_versions_missing', '引用版本的内容快照缺失，本次无法带入');
    if (rule === 'expired') return T('cognition.block_reason_expired', '这次引用已过期，请重新引用');
    if (rule === 'not_committed') return T('cognition.block_reason_not_committed', '这次引用还没确认，尚未生效');
    // 兜底：没有具体规则标识时退回分类码，仍不给用户看英文原文。
    const code = String((error && error.code) || '');
    if (code === 'projection_asset_inactive') return T('cognition.block_reason_inactive', '这条内容当前不在生效状态，不能引用');
    if (code === 'projection_source_unavailable') return T('cognition.block_reason_source_unavailable', '来源授权已撤回或来源记录已失效，不能继续引用');
    if (code === 'projection_asset_missing') return T('cognition.block_reason_missing', '这条内容不存在，或已被彻底删除');
    if (code === 'projection_asset_ineligible') return T('cognition.block_reason_ineligible', '权限范围不允许这样用（作用域、适用条件或可用 Agent 不匹配）');
    return T('cognition.block_reason_unknown', '这条内容当前不可引用');
  }
  NS.blockReasonText = blockReasonText;

  /* ────── 经验目录枚举 → 人话──────
   *  口径与主进程对齐：分组措辞沿用 task-level-precipitation 的既有中文
   *  （lesson=可复用经验 / workflow=已验证的工作流程 / gap=待修正经验），
   *  任务类型对齐 userScopeLabel（SCOPE_LABELS）。未知值一律中性兜底，
   *  不裸出内部枚举、不编造结论。 */
  const EXPERIENCE_TYPE_TEXTS = {
    lesson: ['cognition.experience_group_lesson', '可复用经验'],
    workflow: ['cognition.experience_group_workflow', '已验证的工作流程'],
    gap: ['cognition.experience_group_gap', '待修正经验'],
    uncategorized: ['cognition.experience_group_uncategorized', '未分类经验'],
  };
  function experienceTypeLabel(value) {
    const entry = EXPERIENCE_TYPE_TEXTS[String(value || '')];
    return entry ? T(entry[0], entry[1]) : T('cognition.experience_group_uncategorized', '未分类经验');
  }
  /** 分组键：未知/缺失类型兜底到 uncategorized 组（Edge Case「判不出→未分类」）。 */
  function experienceGroupKey(value) {
    return EXPERIENCE_TYPE_TEXTS[String(value || '')] ? String(value) : 'uncategorized';
  }
  const EXPERIENCE_TASK_TYPE_TEXTS = {
    report: ['cognition.experience_task_type_report', '报告类任务'],
    code: ['cognition.experience_task_type_code', '代码类任务'],
    review: ['cognition.experience_task_type_review', '审查类任务'],
    product: ['cognition.experience_task_type_product', '产品类任务'],
    general: ['cognition.experience_task_type_general', '通用'],
  };
  function experienceTaskTypeLabel(value) {
    const entry = EXPERIENCE_TASK_TYPE_TEXTS[String(value || '')];
    return entry ? T(entry[0], entry[1]) : T('cognition.experience_task_type_unknown', '未知任务类型');
  }
  const EXPERIENCE_VERIFICATION_TEXTS = {
    inferred: ['cognition.experience_verification_inferred', '推断的（未经确认）'],
    needs_confirmation: ['cognition.experience_verification_needs_confirmation', '待确认'],
    confirmed: ['cognition.experience_verification_confirmed', '已确认'],
    unknown: ['cognition.experience_verification_unknown', '验证状态未知'],
  };
  function experienceVerificationLabel(value) {
    const entry = EXPERIENCE_VERIFICATION_TEXTS[String(value || '')];
    return entry ? T(entry[0], entry[1]) : T('cognition.experience_verification_unknown', '验证状态未知');
  }
  /** 迁移跳过/失败理由码 → 人话（已知码逐条映射；未知码中性兜底，
   *  不上屏主进程 message 原文）。 */
  const EXPERIENCE_MIGRATION_REASON_TEXTS = {
    no_kstar_provenance: ['cognition.experience_migration_skip_no_kstar_provenance', '无 KSTAR 沉淀标记（不是任务复盘沉淀的）'],
    capture_line: ['cognition.experience_migration_skip_capture_line', '会话整理线产出（不属于任务经验）'],
    preference_scan_line: ['cognition.experience_migration_skip_preference_scan_line', '偏好扫描线产出（不属于任务经验）'],
    ok: ['cognition.experience_migration_reason_ok', '已迁入'],
    already_migrated: ['cognition.experience_migration_reason_already_migrated', '此前已迁移过'],
    asset_not_found: ['cognition.experience_migration_reason_asset_not_found', '资产记录已不存在'],
    freeze_failed: ['cognition.experience_migration_reason_freeze_failed', '冻结历史引用失败（资产保持原状）'],
    experience_write_failed: ['cognition.experience_migration_reason_experience_write_failed', '写入经验失败（资产保持原状）'],
    asset_removal_failed: ['cognition.experience_migration_reason_asset_removal_failed', '迁出资产记录失败（经验已写入，可重试）'],
  };
  function experienceMigrationReasonText(value) {
    const entry = EXPERIENCE_MIGRATION_REASON_TEXTS[String(value || '')];
    return entry ? T(entry[0], entry[1]) : T('cognition.experience_migration_skip_unknown', '不符合迁移条件');
  }
  /** 状态章（经验自己的四态，与资产章分开——两域状态机不同，文案各自演进）。 */
  const EXPERIENCE_STATUS_TEXTS = {
    active: ['cognition.experience_status_active', '生效中'],
    paused: ['cognition.experience_status_paused', '已暂停'],
    archived: ['cognition.experience_status_archived', '已归档'],
    merged: ['cognition.experience_status_merged', '已并入'],
  };
  function experienceStatusLabel(value) {
    const entry = EXPERIENCE_STATUS_TEXTS[String(value || '')];
    return entry ? T(entry[0], entry[1]) : T('cognition.experience_status_unknown', '状态未知');
  }
  NS.experience = {
    typeLabel: experienceTypeLabel,
    groupKey: experienceGroupKey,
    taskTypeLabel: experienceTaskTypeLabel,
    verificationLabel: experienceVerificationLabel,
    migrationReasonText: experienceMigrationReasonText,
    statusLabel: experienceStatusLabel,
  };

  /** 经验管理动作的失败文案（错误是英文 message、无 code）：按已知
   *  message 片段翻四语，认不出原样透出（与候选码表同一条纪律——宁可露出
   *  英文也不吞失败）。跨类型合并给专门文案。 */
  function experienceActionErrorText(error) {
    const raw = String((error && error.message) || error || '');
    if (raw.includes('requires the same experienceType')) return T('cognition.experience_merge_same_type_required', '只能合并同类型的经验');
    if (raw.includes('is terminal and cannot be modified') || raw.includes('has already been merged')) return T('cognition.experience_error_terminal', '这条经验已是终态（已归档或已并入），不能再修改');
    if (raw.includes('experience not found')) return T('cognition.experience_error_not_found', '这条经验已经不在了，可能已被归档或并入');
    if (raw.includes('invalid') && raw.includes('experience')) return T('cognition.experience_error_invalid', '这次操作没有生效：参数不合法');
    return raw || T('cognition.experience_error_generic', '这次操作没有完成，请稍后重试。');
  }
  NS.experienceActionErrorText = experienceActionErrorText;

  /** 引用被拦/失败的统一出口：资产标题 + 规则名。只给标题（不给内部 id、
   *  不给正文——受限资产正文不得进界面）。 */
  async function reportBlocked(error, title) {
    const reason = blockReasonText(error);
    const name = String(title || '').trim();
    const message = name
      ? T('cognition.attach_blocked_named', '《{title}》没有被引用：{reason}', { title: name, reason })
      : T('cognition.attach_blocked_unnamed', '引用未生效：{reason}', { reason });
    if (typeof window.uiAlert === 'function') { await alertUser(message); return; }
    toast(message, 'warning');
  }
  NS.reportBlocked = reportBlocked;

  /* ────────────────────────── API 客户端 ────────────────────────── */

  const api = {
    /** 唯一 IPC 出口。错误统一抛 Error（带 code 与 blockRule），调用方 try/catch 兜底。 */
    async call(channel, payload) {
      const result = await window.cogseed.invoke(channel, payload || {});
      if (result && result.ok === false) {
        const error = new Error(result.error || result.message || `ipc failed: ${channel}`);
        error.code = result.code || '';
        // 具体规则标识：界面据此说明"哪条规则拦的"，
        // 而不是把主进程的英文原文甩给用户。
        error.blockRule = result.blockRule || '';
        // 结构化业务返回体不能被这一层吞掉：版本冲突
        // 是"被拒绝的一次确认"，不是普通失败——渲染层要靠 versionConflict 里
        // 的版本号才能如实提示并按当前在用版重新展示差异。只搬运字段，不做判定。
        if (result.versionConflict) error.versionConflict = result.versionConflict;
        if (result.state) error.state = result.state;
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
    blockStatus: {},
    errors: [],
    assets: [],
    assetsError: '',
    assetCapabilities: null,
    ontologySnapshot: null,
    ontologyError: '',
    candidates: [],
    assetApprovals: [],
    /** Unified suggestion read model: candidates, approvals and inspection findings. */
    inbox: [],
    inboxResolved: [],
    inboxGroups: [],
    inboxError: '',
    /** 本体候选：与资产候选同页展示，读失败单独记错。 */
    captures: [],
    capturesError: '',
    captureCounts: {},
    captureSettings: null,
    captureModelSelection: null,
    captureCapabilities: null,
    /** 模型主快照读失败标记：settings 区块失败时 captureModel
     *  为 null——视图不得把「没读到」伪装成「还没配置模型」的错误指引；
     *  此标记让设置页如实显示读取失败。 */
    captureModelError: '',
    captureStats: null,
    captureStatsError: '',
    /** 资产详情按需拉的版本链：{assetId, versions}。 */
    assetVersions: null,
    /** 单资产完整事实链：全局最近记录有数量上限，不能用来判断旧版本挂载是否仍有效。 */
    assetTimeline: null,
    /** 资产编辑器的范围目标目录（只含用户可读名称与稳定 id）。失败时只
     *  禁用范围修改；正文编辑仍可保存，并且不会覆盖原范围策略。 */
    assetScopeOptions: { status: 'idle', agents: [], spaces: [], error: '' },
    /** 确认更新撞版本冲突的就地状态：
     *  {candidateId, baselineVersion, currentVersion, targetVersionUsed,
     *   currentStatement, versionsLoading, versionsFailed} 或 null。
     *  只表达一个事实——"这次确认没有生效，资产在你确认前被改过"，并给冲突块
     *  提供**当前在用版正文**（重展示差异的数据源）。候选仍是待处理；这里不存
     *  任何"已完成"语义，处置（重锚/稍后/拒绝）后立即清空。 */
    candidateVersionConflict: null,
    /** KSTAR 溯源：{[episodeId]: {goal,status,at}} 摘要缓存；
     *  kstarEpisode 为点开中的单条详情 {episodeId, episode, review, loading, failed}。 */
    kstarSummaries: null,
    /** 已请求过且拿到响应的 kse id：区分「还没拉到」与「确实
     *  没有」——前者维持兜底文案，后者如实显示「来源记录不可用」；顺带
     *  止住缺失 id 永远进不了缓存、每次 notify 重发同一次 IPC 的循环。 */
    kstarSummariesSettled: [],
    kstarEpisode: null,
    /** 会话标题缓存：{[cid]: title}。证据来源里
     *  的 cid 要翻成用户看得懂的会话名，且候选/资产/版本/使用记录/KSTAR 五处
     *  必须同名。来源目录只有 100 条窗口，窗口外的会话此前一律退化成「一段
     *  对话」；conversationTitlesSettled 记「已请求且确认查无」的 cid——查无
     *  即来源失效，界面如实显示「来源记录不可用」，不是裸 id。 */
    conversationTitles: {},
    conversationTitlesSettled: [],
    /** 正被"模型自选"挂着的资产 id：面板目录视图据此标"模型挂着"，
     *  用户不必翻会话才知道模型给哪个任务挂了东西。 */
    modelSelectedAssetIds: [],
    /** KSTAR 任务复盘列表（kstar-episodes tab）：kstar.episodes.list 的记录。 */
    kstarEpisodes: null,
    /** 改进分析结论：{items, loading, failed, stale}，
     *  null = 还没拉过。数据源 = 只读通道 `kstar.improvement.outcomes.list`（倒序）。
     *  只读分区用；结论不是待办，不参与任何计数。 */
    improvementOutcomes: null,
    /** 失败面（`kstar.failures.list`）：{items, loading, failed}，
     *  null = 还没拉过。只有真的存在失败类结论时才拉（整集合读取，不给无失败的用户白付）。 */
    kstarFailures: null,
    /** 经验目录：{items, loading, failed, stale}，
     *  null = 还没拉过。items 是列表行（目录行，天然不含 body）；拉全量
     *  （status:'all'）再由视图过滤——列表只摆 active/paused，归档/并入的终态
     *  条目留在 store 里供详情深链与合并目标比对用。 */
    experiences: null,
    /** 经验详情（按需拉取）：{experienceId, experience, loading, failed}。 */
    experienceDetail: null,
    /** 存量迁移：{preview, previewLoading, previewFailed, lastRun}。
     *  preview 是只读扫描结果；lastRun 是最近一次 run/status 的回执（可核对
     *  「已迁/未迁/原因」）。 */
    experienceMigration: null,
    /** 旧 USER.md / MEMORY.md 归属核对：只读预览 + 用户选中的内容哈希；
     *  真正迁入必须从「待我处理」逐项勾选并确认。 */
    /** Agent / Space / 旧 Project 记忆迁移：按来源文件指纹逐项核对，保留各自权限边界。 */
    sources: [],
    proofs: [],
    /** 「真实使用」白名单：由主进程单一定义、随
     *  `recall.timeline.list/forAsset` 载荷下发；列表侧「最近使用」与详情侧使用记录共用它。
     *  缺失时按空集处理（fail-closed）——绝不回落成"不过滤"（那正是缺陷本体）。 */
    realUsageKinds: [],
    /** 资产详情的采用回执：{assetId, items, loading}。
     *  「实际采用」只认这里（回执 applied），usage_recorded 一律归「被带入任务」。 */
    adoptionReceipts: null,
    /** 整理详情页的「对话上下文」：{captureId, data}
     *  按任务缓存；data 为 null 表示上下文不可用（详情页降级渲染）。 */
    captureContext: null,
    /** 整理页：会话列表是否展开全部（默认收拢 5 条）。 */
    /** 路由：{name, category, assetId, candidateId, proofEventId, captureBucket, captureId, sourceIssueOpen} */
    route: { name: 'overview', category: '', assetId: '', candidateId: '', proofEventId: '', inboxId: '', poCandidateId: '', activityQuery: '', activityPage: '', captureBucket: '', captureId: '', sourceIssueOpen: '', kstarEpisodeId: '', assetVersionId: '', assetEdit: '', assetVersionDiff: '', assetVersionsExpanded: '', assetView: '', candCreate: '', experienceId: '', manage: '' },
    /** 资产详情异步补数会触发整页 render；编辑表单草稿留在 store，防止
     * 版本/回执/排序依据到达时替换 DOM 并丢掉用户尚未保存的输入。 */
    assetEditDrafts: {},
    backStack: [],
    /** 上一帧的路由名：渲染层据此判断「离开 ontology 页」需要先归还本体 section。 */
    prevRouteName: 'overview',
  };
  NS.store = store;

  /** 派生统计：全部从这里取，视图不自己算口径。 */
  NS.stats = function stats() {
    const s = store;
    const confirmed = s.assets.filter((a) => !['archived', 'deleted', 'purged', 'revoked'].includes(String(a.status || 'active'))).length;
    // 需要关注与活动列表共用口径；稍后不是完成，仍保留在关注清单中。
    const pending = NS.activityModel ? NS.activityModel().attention.length : s.candidates.filter((c) => !c.activityExclusionReason && !(NS.isKstarCandidate && NS.isKstarCandidate(c)) && (c.capabilities && c.capabilities.countsAsPending)).length;
    const validated = s.assets.filter((a) => a.maturity === 'effectiveness_validated').length;
    const transferOk = s.assets.filter((a) => a.maturity === 'transfer_validated' || a.maturity === 'effectiveness_validated').length;
    const sourceIssues = s.sources
      .flatMap((group) => (Array.isArray(group.items) ? group.items : []))
      // 用户主动暂停的来源（reason=source_paused）不算"需要处理"——用户
      // 自己停的，再提示他去处理自相矛盾；连接器断开等真故障的 paused
      // 仍计入。
      // 执行失败轮次同样不算：与 views.sourceItemNeedsAttention
      // 同口径，agent 执行失败不是用户可修复的来源故障。
      .filter((item) => String(item.kind || '') !== 'execution_evaluation'
        && (item.status === 'failed'
          || (item.status === 'paused' && String(item.statusReason || '') !== 'source_paused'))).length;
    const failedTasks = Number(s.captureCounts && s.captureCounts.failed || 0);
    // 任务执行失败：会话最后一回合没
    // 得到回复且没有整理记录——那是**任务**失败了（不是整理失败），反馈要与
    // 「整理任务需要重试」分开说。
    const captureConvIds = new Set((Array.isArray(s.captures) ? s.captures : [])
      .map((capture) => String((capture || {}).conversationId || '')).filter(Boolean));
    const taskFailed = (Array.isArray(s.sources) ? s.sources : [])
      .flatMap((group) => (Array.isArray(group && group.items) ? group.items : []))
      .filter((item) => item && item.lastTurnFailed === true
        && !captureConvIds.has(String(item.id || ''))).length;
    const coveredAssets = new Set(s.proofs.map((p) => String((p.refs || {}).assetId || '')).filter(Boolean)).size;
    const attention = s.assets.filter((a) => String(a.status || 'active') === 'paused' || String(a.status || '') === 'archived').length;
    return { confirmed, pending, validated, transferOk, sourceIssues, failedTasks, taskFailed, coveredAssets, proofCount: s.proofs.length, attention };
  };

  /* ────────────────────────── 数据加载 ────────────────────────── */

  const LOADERS = {
    async snapshot() {
      store.errors = [];
      // 事件驱动刷新与冷启动共用具名 BLOCK_FETCHERS，避免位置解构导致区块错配。
      await loadBlocks(['assets', 'ontology', 'candidates', 'captures', 'settings', 'captureStats', 'timeline', 'inbox'], true);
      // 跨区块联动 stale（改复盘/沉淀/打标后回来别吃旧值）：按需加载器的
      // stale 守卫会跳过从未拉过的场景，这里只标记已存在的状态。
      if (store.improvementOutcomes) store.improvementOutcomes = { ...store.improvementOutcomes, stale: true };
      if (store.experiences) store.experiences = { ...store.experiences, stale: true };
      if (store.tags) store.tags = { ...store.tags, stale: true };
      store.loaded = true;
    },
  };
  NS.loaders = LOADERS;

  const listeners = new Set();
  NS.onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  NS.loadReviewEvidence = async function loadReviewEvidence(kind, id, force) {
    if (!id || !['candidate', 'asset'].includes(kind)) return;
    const states = store.reviewEvidence || (store.reviewEvidence = {});
    const key = kind + ':' + id;
    if (!force && (states[key]?.loading || states[key]?.loaded)) return;
    const state = states[key] = { loading: true, loaded: false, items: [], error: '' };
    NS.notify();
    try {
      const result = await api.call('recall.reviewEvidence.read', { [kind + 'Id']: id });
      if (store.reviewEvidence?.[key] !== state) return;
      if (!Array.isArray(result.items)) throw new Error('invalid evidence response');
      state.items = result.items; state.loaded = true;
    } catch (_) {
      if (store.reviewEvidence?.[key] !== state) return;
      state.error = T('cognition.prototype_evidence_failed', '来源原文暂时无法读取，请重试或打开来源核对。'); state.loaded = true;
    } finally {
      if (store.reviewEvidence?.[key] === state) { state.loading = false; NS.notify(); }
    }
  };
  NS.loadAssetEvidence = (id, force) => NS.loadReviewEvidence('asset', id, force);
  function invalidateReviewEvidence(kind) {
    const entries = Object.entries(store.reviewEvidence || {});
    store.reviewEvidence = kind ? Object.fromEntries(entries.filter(([key]) => !key.startsWith(kind + ':'))) : {};
  }
  function invalidateAssetDetails() {
    store.assetVersions = null;
    invalidateAssetUsageDetails();
  }
  function invalidateAssetUsageDetails() {
    store.assetTimeline = null;
    store.adoptionReceipts = null;
    NS.rankingWhy = null;
  }
  NS.reload = async function reload() {
    invalidateReviewEvidence();
    invalidateAssetDetails();
    // loading 窗口内到达的 reload 不再静默丢弃——记一次
    // pendingReload，本次读完后立刻补拉。此前连续两次操作时第二次的刷新会
    // 直接落空，只能等写入广播自愈。
    if (store.loading) { store.pendingReload = true; return; }
    store.loading = true;
    listeners.forEach((fn) => fn());
    try {
      await LOADERS.snapshot();
    } finally {
      store.loading = false;
      listeners.forEach((fn) => fn());
      if (store.pendingReload) {
        store.pendingReload = false;
        void NS.reload();
      }
    }
  };
  NS.notify = () => listeners.forEach((fn) => fn());

  // 对话里的负反馈会把同一任务的采用回执改记为「被否定」。认知资产面板
  // 可能一直挂在内存里，因此收到反馈事件时清掉相关读缓存，让详情下一次
  // 展示时读取新回执，而不是继续显示旧的「已采用」。
  /* ────────────────────────── cognition:changed 订阅中枢 ──────────────────────────
   * 刷新机制重写：主进程每次认知资产写入（recall store / 决策账本 /
   * 本体分组 / 长期记忆）广播 {collection, generation, op?, recordId?}。
   * 面板不再轮询整理进度、不再监听 window CustomEvent：本中枢是唯一刷新入口——
   *   · collection → 区块映射：只重拉受影响的读通道（BLOCK_FETCHERS），
   *     不做无差别全量 reload；
   *   · 面板不可见（app.js 注入 NS.changeRailVisible）只记 pendingRefresh，
   *     由可见性监听在面板回到前台时 flush——后台窗口零 IPC；
   *   · 刷新永远「重读」：推送只声明哪类变了，数据仍从读通道拉。
   * generation 目前只作诊断序号；同 collection 的短窗口合并会跳过中间值，
   * 因此不能拿它推断丢包。冷启动会全量读取，收到任何后续通知都会重读对应区块。 */

  /** 每个区块一个重拉函数；冷启动 snapshot 与事件驱动刷新共用同一份，
   *  不存在"两套口径"。字段处理逻辑沿自主快照原实现。 */
  /* ── ──
   * 刷新 drain（flushPendingRefresh）与 reload/snapshot 无互斥：同一区块可能
   * 并发发起两次读取（例：drain 在资产删除前发出旧请求、广播触发的 reload
   * 拉到新数据先落地），旧响应后到会把已删资产复活显示、直到下次广播。
   * 每区块维护单调世代号：发起读取时 +1，落地前本区块又有新读取发起的，
   * 本次响应作废——数据由后发起的读取负责。 */
  const blockReadGenerations = new Map();
  function beginBlockRead(block) {
    const gen = (blockReadGenerations.get(block) || 0) + 1;
    blockReadGenerations.set(block, gen);
    return gen;
  }
  function isStaleBlockRead(block, gen) {
    return blockReadGenerations.get(block) !== gen;
  }
  const BLOCK_FETCHERS = {
    async assets() {
      const gen = beginBlockRead('assets');
      try {
        const assets = await api.call('recall.assets.list', {});
        if (isStaleBlockRead('assets', gen)) return;
        if (!Array.isArray(assets) && !Array.isArray(assets?.assets) && !Array.isArray(assets?.items)) throw new Error('invalid asset list response');
        store.assets = toArr(assets, ['assets', 'items']);
        store.assetCapabilities = assets?.capabilities || null;
        store.assetsError = '';
      } catch (error) {
        if (isStaleBlockRead('assets', gen)) return;
        // 保留最近一次成功读到的内容；读取失败不能被当成空库。
        store.assetsError = String(error?.message || error || 'load_failed');
      }
    },
    async inbox() {
      const gen = beginBlockRead('inbox');
      try {
        const result = await api.call('cognition.inbox.list', {});
        if (isStaleBlockRead('inbox', gen)) return;
        store.inbox = toArr(result, ['items']);
        store.inboxResolved = Array.isArray(result?.resolvedInspectionFindings) ? result.resolvedInspectionFindings : [];
        store.inboxGroups = Array.isArray(result?.groups) ? result.groups : [];
        store.inboxError = '';
      } catch (error) {
        if (isStaleBlockRead('inbox', gen)) return;
        // Keep the last readable list; a failed read is not an empty inbox.
        store.inboxGroups = Array.isArray(store.inboxGroups) ? store.inboxGroups : [];
        store.inboxError = String(error?.message || error || 'load_failed');
      }
    },
    async ontology() {
      const gen = beginBlockRead('ontology');
      try {
        const snapshot = await api.call('cognition.ontology.snapshot', {}, {});
        if (isStaleBlockRead('ontology', gen)) return;
        if (!snapshot.ontology?.records) throw new Error(T('ontologyWorkspace.loadFailed', '本体暂时无法加载'));
        store.ontologySnapshot = snapshot.ontology; store.ontologyError = '';      } catch (error) {
        if (isStaleBlockRead('ontology', gen)) return;
        store.ontologyError = String(error?.message || error);
      }
    },
    async candidates() {
      // 候选清单读失败不再软降级成空数组——那会把「没读到」
      // 伪装成「没有要你决定的」，用户据此误以为清净了。失败进显式错误态，
      // 视图层给重试入口；成功后清掉错误标记。
      // 改拉 review-queue 视图——服务端裁掉历史处理
      // 记录（页面只显示最近 5 条）并做字段白名单投影；细分分组仍在本层做。
      const gen = beginBlockRead('candidates');
      try {
        const candidates = await api.call('recall.candidates.list', { view: 'activity-queue' }, {});
        if (isStaleBlockRead('candidates', gen)) return;
        if (!Array.isArray(candidates) && !Array.isArray(candidates?.candidates) && !Array.isArray(candidates?.items)) throw new Error('invalid candidate list response');
        if (candidates?.assetApprovals !== undefined && !Array.isArray(candidates.assetApprovals)) throw new Error('invalid asset approval list response');
        store.candidates = toArr(candidates, ['candidates', 'items']);
        store.assetApprovals = candidates?.assetApprovals || [];
        store.candidatesError = '';
      } catch (error) {
        if (isStaleBlockRead('candidates', gen)) return;
        store.candidatesError = String((error && error.message) || error || 'load_failed');
      }
    },
    async captures() {
      const gen = beginBlockRead('captures');
      // scope:'all'：整理页要展示完整历史（含系统判定无留存内容的静默记录）。
      try {
        const captures = await api.call('recall.captures.list', { limit: 40, scope: 'all' });
        if (isStaleBlockRead('captures', gen)) return;
        if (!Array.isArray(captures) && !['items', 'captures', 'tasks'].some(key => Array.isArray(captures?.[key]))) throw new Error('invalid capture list response');
        const rows = new Map(toArr(captures, ['items', 'captures', 'tasks']).map(row => [row.id, row]));
        store.captures = Array.from(rows.values());
        store.captureCounts = (captures && captures.counts) || {};
        store.capturesError = '';
      } catch (error) {
        if (isStaleBlockRead('captures', gen)) return;
        store.capturesError = String(error?.message || error || 'load_failed');
      }
    },
    async settings() {
      // 模型主快照读失败此前被 api.soft
      // 兜成 {} → captureModel=null，视图把「没读到」伪装成「还没配置模型」
      // 并给「去应用设置」的错误指引（误导力强于同屏横幅）。settings 半边
      // 经复证实测不触发（兜底 {} truthy，整理页 warn 不出现），为保持该行为
      // 不变：失败时 store 形状照旧（captureSettings={}、captureModel=null、
      // errors 照记），只补 captureModelError 分区标记供视图区分。
      const gen = beginBlockRead('settings');
      let result = null;
      let failed = false;
      try {
        result = await api.call('recall.captures.settings.get', {});
      } catch (error) {
        result = {};
        failed = true;
        // 过期响应（含失败）不落地：错误横幅也是「本次读取的产物」，由后发起
        // 的读取负责，避免旧失败盖掉新成功。
        if (isStaleBlockRead('settings', gen)) return;
        store.errors.push({ channel: 'recall.captures.settings.get', message: String((error && error.message) || error) });
      }
      if (isStaleBlockRead('settings', gen)) return;
      store.captureSettings = (result && result.settings) || result || null;
      store.captureCapabilities = (result && result.capabilities) || null;
      store.captureModelSelection = result?.modelSelection || null;
      const model = (result && result.model) || null;
      // A renderer reload can precede the main-process restart in source mode.
      // The previous settings handler already proved API configuration and OAuth
      // status, but had no channel field. Preserve that evidence; configured:false
      // cannot rule out a CLI fallback and must remain unknown.
      const legacyApiSnapshot = model && model.runtimeStatus === undefined && model.channel === undefined
        && model.configured === true && typeof model.authorizationRequired === 'boolean';
      store.captureModel = legacyApiSnapshot ? Object.assign({}, model, {
        runtimeStatus: 'legacy', apiConfigured: true,
        channel: model.authorizationRequired ? 'unavailable' : undefined,
        available: model.authorizationRequired ? false : undefined,
      }) : model;
      store.captureModelError = failed ? 'load_failed' : '';
    },
    async captureStats() {
      const gen = beginBlockRead('captureStats');
      try {
        const result = await api.call('recall.captures.stats', {});
        if (isStaleBlockRead('captureStats', gen)) return;
        store.captureStats = result;
        store.captureStatsError = '';
      } catch (error) {
        if (isStaleBlockRead('captureStats', gen)) return;
        store.captureStatsError = String(error?.message || error || 'load_failed');
      }
    },
    async sources() {
      const gen = beginBlockRead('sources');
      // limit:100=IPC 上限：默认 25 会在会话超 25 后静默丢行。
      const sources = await api.soft('recall.sources.list', { limit: 100 }, {});
      if (isStaleBlockRead('sources', gen)) return;
      store.sources = toArr(sources, ['groups', 'sources']);
    },
    async timeline() {
      const gen = beginBlockRead('timeline');
      const proofs = await api.soft('recall.timeline.list', { limit: 500 }, {});
      if (isStaleBlockRead('timeline', gen)) return;
      store.proofs = toArr(proofs, ['items', 'events']);
      store.realUsageKinds = Array.isArray(proofs && proofs.realUsageKinds)
        ? proofs.realUsageKinds.map((kind) => String(kind || '')).filter(Boolean)
        : [];
      if (store.assetTimeline) store.assetTimeline = { ...store.assetTimeline, stale: true };
      if (store.adoptionReceipts) store.adoptionReceipts = null;
    },
  };

  // Route reads are request-local and independent. A full reload keeps its existing
  // contract; first entry/tab switches only load their own blocks, once per mount.
  const blockRequests = new Map();
  function routeBlocks() {
    const route = store.route || {};
    if (route.name === 'ontology') return ['ontology'];
    if (route.name === 'settings') return ['settings', 'captureStats'];
    // 统一收件箱只在会展示它的页面读取：认知生长，或已打开资产详情的我的认知。
    if (route.name === 'overview') return [
      'assets',
      ...(store.libraryView?.sort === 'used' ? ['timeline'] : []),
      ...(route.assetId ? ['inbox'] : []),
    ];
    return ['assets', 'candidates', 'captures', 'settings', 'captureStats', 'timeline', 'inbox'];
  }
  async function loadBlocks(names, force = false) {
    let started = false;
    const reads = names.map(name => {
      const reloadInbox = !force && name === 'inbox' && inboxNeedsReload;
      if (reloadInbox) inboxNeedsReload = false;
      const effectiveForce = force || reloadInbox;
      if (!effectiveForce && blockRequests.has(name)) return blockRequests.get(name);
      if (!effectiveForce && store.blockStatus[name]?.loaded) return Promise.resolve();
      started = true;
      pendingRefresh.delete(name);
      const startedAt = Date.now();
      store.blockStatus[name] = { loaded: Boolean(store.blockStatus[name]?.loaded), loading: true };
      const pending = Promise.resolve().then(() => BLOCK_FETCHERS[name]()).finally(() => {
        if (blockRequests.get(name) !== pending) return;
        blockRequests.delete(name);
        store.blockStatus[name] = { loaded: true, loading: false };
        store.loaded = true;
        loadLog?.info('block read completed', { block: name, ms: Date.now() - startedAt });
        NS.notify();
      });
      blockRequests.set(name, pending);
      return pending;
    });
    if (started) NS.notify();
    await Promise.all(reads);
  }
  NS.loadRoute = () => loadBlocks(routeBlocks());
  NS.loadActivityOntology = () => loadBlocks(['ontology']);
  NS.isRouteLoading = () => routeBlocks().some(name => !store.blockStatus[name]?.loaded);

  /** collection → 需要刷新的区块/动作。没列出的 collection（world-model 等）
   *  面板没有对应区块，静默忽略——主进程广播所有认知写入，订阅端自取所需。 */
  const COLLECTION_BLOCKS = {
    'ability-assets': ['assets', 'timeline', 'candidates', 'inbox'],
    'ability-asset-versions': ['assets', 'candidates', 'inbox'],
    'ability-asset-audit': ['assets', 'timeline'],
    'source-controls': ['assets', 'candidates', 'sources', 'timeline', 'inbox'],
    'candidates': ['candidates', 'captureStats', 'inbox'],
    // 旧停驻页退役：po 候选与 Recall 候选同住「待我处理」收件箱，
    // 广播改刷 candidates 区块（两个列表一并重拉），旧页面刷新入口已删除。
    'ontology-candidates': ['candidates', 'inbox'],
    'ontology': ['ontology', 'assets', 'inbox'],
    'captures': ['captures'],
    'capture-settings': ['settings', 'captureStats'],
    'capture-sweep': ['captureStats'],
    'capture-model-budgets': ['captureStats'],
    'usage-records': ['timeline'],
    'asset-usage-receipts': ['timeline'],
    'injection-receipts': ['timeline'],
    'transfer-proofs': ['timeline'],
    // 治理待办的数据源写入后，治理分区（inbox 区块）也要
    // 重拉——此前全表无 inbox 映射，事件刷新永远轮不到它，只靠动作后全量
    // reload 兜底。巡检 runs 不经 recall store 广播，其处置后的刷新由动作
    // 响应路径补。
    'cleanup-reports': ['timeline', 'inbox'],
    'effectiveness-proofs': ['timeline'],
    'validation-records': ['timeline'],
    'asset-approvals': ['assets', 'candidates', 'inbox'],
    'asset-handoff-receipts': ['timeline'],
    'workspace-refs': ['assets'],
    'workspace-ref-history': ['assets'],
    // 旧停驻页退役：ontology 区块 applier 随旧模块删除，冲突仍走 inbox。
    'ontology-conflicts': ['assets'],
    'longterm-memory': ['legacy'],
    'experiences': ['experiences'],
  };

  const pendingRefresh = new Set();
  let inboxNeedsReload = false;
  let refreshDrain = null;
  let changeRailVisible = () => true;
  let changeRailBound = false;

  /** 区块 → 动作。一次 drain 串行合并正在读取时到达的新事件；非 fetch 类（树/经验/
   *  迁移预览）走各自的失效语义（懒重建或 stale 标记，loaders 的守卫防重入）。 */
  function applyBlock(block) {
    // 其他区块的写入不替未展示收件箱的页面预读它；若它已读过，进页面时强制换新。
    if (block === 'inbox' && !(store.route?.name === 'activity'
      || (store.route?.name === 'overview' && store.route?.assetId))) {
      if (store.blockStatus.inbox?.loaded) inboxNeedsReload = true;
      return null;
    }
    if (BLOCK_FETCHERS[block]) return () => loadBlocks([block], true);
    if (block === 'experiences') return async () => {
      if (store.experiences) store.experiences = { ...store.experiences, stale: true };
    };
    if (block === 'legacy') return async () => {
    };
    if (block === 'projections') return async () => {
      await NS.loadModelSelectedAssets();
    };
    return null;
  }

  const BLOCK_APPLIERS = {};
  for (const name of [...Object.keys(BLOCK_FETCHERS), 'experiences', 'legacy', 'projections']) {
    const apply = applyBlock(name);
    if (apply) BLOCK_APPLIERS[name] = apply;
  }

  // An unvisited tab retains its invalidation without doing hidden work. Already
  // loaded blocks still refresh so counters/data stay current across tab switches.
  function readablePendingBlocks() {
    const needed = new Set(routeBlocks());
    return [...pendingRefresh].filter(name => !BLOCK_FETCHERS[name] || needed.has(name) || store.blockStatus[name]?.loaded);
  }
  function flushPendingRefresh() {
    const visible = changeRailVisible();
    if (refreshDrain || !visible || !readablePendingBlocks().length) {
      // A records dialog can have its own detail reads without ever loading the
      // global timeline. Wake that visible consumer; leave the global block lazy.
      if (visible && pendingRefresh.has('timeline')) NS.notify();
      return refreshDrain || Promise.resolve();
    }
    refreshDrain = (async () => {
      // Keep one drain in flight. Events arriving during a read stay in the set
      // and are consumed by the next pass instead of being discarded by a
      // per-block in-flight guard.
      while (pendingRefresh.size > 0 && changeRailVisible()) {
        const blocks = readablePendingBlocks();
        if (!blocks.length) break;
        blocks.forEach(name => pendingRefresh.delete(name));
        await Promise.all(blocks.map((name) => {
          const apply = BLOCK_APPLIERS[name];
          return apply ? apply() : Promise.resolve();
        }));
        NS.notify();
      }
    })().finally(() => {
      refreshDrain = null;
      // If visibility changed or another notice landed at the end of a pass,
      // schedule a new drain rather than leaving it stranded.
      if (readablePendingBlocks().length && changeRailVisible()) void flushPendingRefresh();
    });
    return refreshDrain;
  }
  NS.flushPendingRefresh = flushPendingRefresh;

  /** 订阅 cognition:changed。app.js 在 boot 时调用一次并注入可见性判定；
   *  测试/无 preload 环境静默降级（面板退化为打开时全量拉）。 */
  NS.setupChangeRail = function setupChangeRail(isVisible) {
    if (typeof isVisible === 'function') changeRailVisible = isVisible;
    if (changeRailBound) return;
    changeRailBound = true;
    const subscribe = window.cogseed && typeof window.cogseed.onPushEvent === 'function'
      ? window.cogseed.onPushEvent.bind(window.cogseed)
      : null;
    if (!subscribe) return;
    subscribe('cognition:changed', (notice) => {
      const collection = String((notice && notice.collection) || '');
      const blocks = COLLECTION_BLOCKS[collection];
      if (!blocks) return;
      // 收件箱只在展示页读取；若已读过，离开期间的变化标记为回页时补读。
      if (blocks.includes('inbox') && store.blockStatus.inbox?.loaded
        && !(store.route?.name === 'activity' || (store.route?.name === 'overview' && store.route?.assetId)))
        inboxNeedsReload = true;
      // Main coalesces notices by collection and retains only the final recordId.
      // Invalidate every loaded entry in that collection, including hidden views.
      if (collection === 'ability-assets' || collection === 'ability-asset-versions') {
        store.assetVersions = null;
        invalidateReviewEvidence('asset');
      } else if (collection === 'candidates') invalidateReviewEvidence('candidate');
      else if (collection === 'source-controls') {
        invalidateReviewEvidence();
        invalidateAssetDetails();
      }
      if (blocks.includes('timeline')) {
        invalidateAssetUsageDetails();
        // The version response includes adoption counts for each version.
        if (collection === 'asset-usage-receipts') store.assetVersions = null;
      }
      for (const block of blocks) pendingRefresh.add(block);
      if (changeRailVisible()) void flushPendingRefresh();
    });
  };
  /** 供 app.js 的可见性监听在面板回到前台时调用（隐藏期间挂起的区块此刻补拉）。 */
  NS.changeRailVisible = (visible) => { changeRailVisible = () => visible; };
  NS.isChangeRailVisible = () => changeRailVisible();

  /** 整理详情页按需拉「对话上下文」（本次整理实际读到的消息 + 参与角色）。
   *  按任务缓存；失败降级为 data:null（不进全局 errors——上下文缺席不该
   *  触发「部分数据读取失败」横幅吓人）。 */
  NS.loadCaptureContext = async function loadCaptureContext(captureId) {
    const id = String(captureId || '');
    if (!id || (store.captureContext && store.captureContext.captureId === id)) return;
    store.captureContext = { captureId: id, loading: true };
    NS.notify();
    let data = null;
    try {
      const result = await api.call('recall.captures.context', { captureId: id });
      data = (result && result.context) || null;
    } catch (error) {
      // 捕获记录不存在/会话清理：data 保持 null，详情页给降级文案。
    }
    if (!store.captureContext || store.captureContext.captureId !== id) return;
    store.captureContext = { captureId: id, data };
    NS.notify();
  };

  /** 后台巡检状态：开关 + 最近一轮的概要。
   *  失败降级为空但不冻结——失败置 stale（巡检读不到不该让
   *  整理页报"部分数据读取失败"，视图照旧；stale 让下次触发自愈重拉，
   *  「没读到」不再永久伪装「没有」）。 */
  NS.loadInspection = async function loadInspection(force) {
    if (store.inspection?.loading || (!force && store.inspection && (!store.inspection.stale || store.inspection.failed))) return;
    store.inspection = { loading: true, settings: (store.inspection && store.inspection.settings) || null, latestRun: (store.inspection && store.inspection.latestRun) || null };
    NS.notify();
    let settings = null;
    let latestRun = null;
    let stale = false;
    try {
      const [settingsResult, runsResult] = await Promise.all([
        api.call('recall.inspection.settings', {}),
        api.call('recall.inspection.list', { limit: 1 }),
      ]);
      settings = (settingsResult && settingsResult.settings) || null;
      latestRun = ((runsResult && runsResult.runs) || [])[0] || null;
    } catch (error) {
      settings = null;
      latestRun = null;
      stale = true;
    }
    store.inspection = { loading: false, settings, latestRun, stale, failed: stale };
    NS.notify();
  };

  /** 整理报告按需拉取。按次缓存；失败降级为空列表——
   *  报告读不到不该让整页报"部分数据读取失败"，它只是整理页的一块。
   *  失败置 stale（同 loadInspection，自愈重拉不冻结）。 */
  NS.loadCleanupReports = async function loadCleanupReports(force) {
    if (store.cleanupReports?.loading || (!force && store.cleanupReports && (!store.cleanupReports.stale || store.cleanupReports.failed))) return;
    store.cleanupReports = { loading: true, reports: (store.cleanupReports && store.cleanupReports.reports) || [] };
    NS.notify();
    let reports = [];
    let stale = false;
    try {
      const result = await api.call('recall.cleanup.list', { limit: 20 });
      reports = (result && result.reports) || [];
    } catch (error) {
      reports = [];
      stale = true;
    }
    store.cleanupReports = { loading: false, reports, stale, failed: stale };
    NS.notify();
  };

  /** 资产详情按需拉版本链。按资产缓存；读失败保留显式
   *  failed 标记 + 重试入口（与 loadAssetTimeline 一致）——
   *  版本链区是版本组 UI 的主入口，失败时整体消失等于把「没读到」伪装成
   *  「没有版本」，且失败态被缓存后无恢复路径。`force`：
   *  版本冲突后必须重拉——缓存里的链正是冲突前那一份，拿它重展示差异等于
   *  拿旧差异糊弄用户；重试按钮同走 force 绕过失败态缓存判重。 */
  NS.loadAssetVersions = async function loadAssetVersions(assetId, force) {
    const id = String(assetId || '');
    if (!id || (!force && store.assetVersions && store.assetVersions.assetId === id)) return;
    const state = store.assetVersions = { assetId: id, loading: true };
    NS.notify();
    let versions = [];
    let usage = [];
    let audit = [];
    let failed = false;
    try {
      const result = await api.call('recall.assets.versions.list', { assetId: id });
      versions = (result && result.versions) || [];
      usage = (result && result.usage) || [];
      audit = (result && result.audit) || [];
    } catch (error) {
      versions = [];
      usage = [];
      audit = [];
      failed = true;
    }
    if (store.assetVersions !== state) return;
    store.assetVersions = { assetId: id, versions, usage, audit, failed };
    NS.notify();
  };

  /** 按资产读取使用与管理记录；保留失败状态供记录弹窗重试。 */
  NS.loadAssetTimeline = async function loadAssetTimeline(assetId, force) {
    const id = String(assetId || '');
    if (!id || (!force && store.assetTimeline && store.assetTimeline.assetId === id && !store.assetTimeline.stale)) return;
    const cachedItems = store.assetTimeline && store.assetTimeline.assetId === id
      ? store.assetTimeline.items || []
      : [];
    const state = store.assetTimeline = { assetId: id, items: cachedItems, loading: true, failed: false };
    NS.notify();
    let items = [];
    let realUsageKinds = [];
    let failed = false;
    try {
      const result = await api.call('recall.timeline.forAsset', { assetId: id });
      items = (result && result.items) || [];
      realUsageKinds = Array.isArray(result && result.realUsageKinds)
        ? result.realUsageKinds.map((kind) => String(kind || '')).filter(Boolean)
        : [];
    } catch (error) {
      failed = true;
    }
    if (store.assetTimeline !== state) return;
    // A library-first visit may never load the global timeline. Consume the
    // same host whitelist with this detail response; missing metadata stays closed.
    if (!failed) store.realUsageKinds = realUsageKinds;
    store.assetTimeline = { assetId: id, items, loading: false, failed };
    NS.notify();
  };

  /** 资产详情按需拉采用回执。失败保留独立状态，避免把“没读到”误写成 0 次；
   *  仍不把缺失回执推断为已采用。 */
  NS.loadAdoptionReceipts = async function loadAdoptionReceipts(assetId, force) {
    const id = String(assetId || '');
    if (!id || (!force && store.adoptionReceipts && store.adoptionReceipts.assetId === id)) return;
    const cachedItems = store.adoptionReceipts && store.adoptionReceipts.assetId === id
      ? store.adoptionReceipts.items || [] : [];
    const state = store.adoptionReceipts = { assetId: id, items: cachedItems, loading: true, failed: false };
    NS.notify();
    let items = [];
    let failed = false;
    try {
      const result = await api.call('recall.assets.adoptionReceipts', { assetId: id });
      items = (result && result.receipts) || [];
    } catch (error) {
      failed = true;
    }
    if (store.adoptionReceipts !== state) return;
    store.adoptionReceipts = { assetId: id, items: failed ? cachedItems : items, loading: false, failed };
    NS.notify();
  };

  /** 批量补 kse 摘要：结果并入缓存；本次请求里
   *  响应没有的 id 记进 settled——没有就是没有，chip 据此如实显示「来源
   *  记录不可用」；失败不记（读不到 ≠ 不存在，保持兜底文案）。 */
  async function fetchKstarEpisodeSummaries(rawIds) {
    const wanted = [...new Set((rawIds || []).map(String).filter((id) => id.startsWith('kse-')))];
    if (!wanted.length) return;
    const have = store.kstarSummaries || {};
    const settled = store.kstarSummariesSettled || [];
    const missing = wanted.filter((id) => !have[id] && !settled.includes(id));
    if (!missing.length) return;
    try {
      const result = await api.call('recall.kstar.episodes.summaries', { ids: missing });
      const summaries = (result && result.summaries) || [];
      store.kstarSummaries = {
        ...(store.kstarSummaries || {}),
        ...Object.fromEntries(summaries.map((s) => [String(s.id), s])),
      };
      const returned = new Set(summaries.map((s) => String(s.id)));
      store.kstarSummariesSettled = [...new Set([...(store.kstarSummariesSettled || []), ...missing.filter((id) => !returned.has(id))])];
      NS.notify();
    } catch (error) {
      // 摘要缺席只影响 chip 文案，不阻断详情；失败不记 settled。
    }
  }

  /** KSTAR 溯源：资产详情证据含 kse 引用时批量拉任务目标
   *  摘要（chip 显示用）；失败静默（chip 退回占位标题）。
   *  修：此前只取资产级 evidenceRefs，版本块渲染读的却是
   *  snapshot.evidenceRefs——历史版本的 kse id 从没拉过摘要，永远命中不了
   *  缓存。现在把已加载版本的快照证据一并纳入（版本异步到达后，onChange
   *  会再触发一次，新 id 自然补拉）。 */
  NS.loadKstarEpisodeSummaries = async function loadKstarEpisodeSummaries(assetId) {
    const id = String(assetId || '');
    const asset = store.assets.find((a) => String(a.id) === id);
    if (!asset) return;
    const refs = [...(asset.evidenceRefs || [])];
    if (store.assetVersions && String(store.assetVersions.assetId || '') === id) {
      for (const version of store.assetVersions.versions || []) {
        refs.push(...((version.snapshot && version.snapshot.evidenceRefs) || []));
      }
    }
    await fetchKstarEpisodeSummaries(refs.map((ref) => String(ref.id || '')));
  };

  /** 批量补会话标题：与 kse 摘要同一套防循环
   *  模式——已命中的不再请求，响应里没有的 cid 记进 settled（查无 = 来源已
   *  失效，界面据此显示「来源记录不可用」）；请求失败不记 settled（读不到 ≠
   *  不存在，下次渲染再试）。只有真的拿到新数据才 notify，避免失败时无限重渲染。 */
  async function fetchConversationTitles(rawIds) {
    const wanted = [...new Set((rawIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!wanted.length) return;
    const have = store.conversationTitles || {};
    const settled = store.conversationTitlesSettled || [];
    const missing = wanted.filter((id) => !Object.prototype.hasOwnProperty.call(have, id) && !settled.includes(id));
    if (!missing.length) return;
    let changed = false;
    // IPC 单次上限 50：分批取满，不做隐式截断——截断会
    // 让"没问到"与"查无此会话"混为一谈，界面就会误报来源失效。
    for (let start = 0; start < missing.length; start += 50) {
      const batch = missing.slice(start, start + 50);
      try {
        const result = await api.call('conversations.titles', { cids: batch });
        const titles = (result && result.titles) || [];
        const returned = new Set(titles.map((row) => String(row.cid)));
        store.conversationTitles = {
          ...(store.conversationTitles || {}),
          ...Object.fromEntries(titles.map((row) => [String(row.cid), String(row.title || '')])),
        };
        const absent = batch.filter((id) => !returned.has(id));
        if (absent.length) {
          store.conversationTitlesSettled = [...new Set([...(store.conversationTitlesSettled || []), ...absent])];
        }
        changed = true;
      } catch (error) {
        // 标题缺席只影响来源文案（退回泛称或「来源记录不可用」），不阻断详情。
      }
    }
    if (changed) NS.notify();
  }

  /** 资产详情的会话类证据 + 使用记录事件的 cid 一起补标题（使用记录要「可定位
   *  会话」）。版本快照里的证据一并纳入——与 kse 摘要同一处坑：
   *  历史版本的引用此前从没拉过。 */
  NS.loadConversationTitles = async function loadConversationTitles(assetId) {
    const id = String(assetId || '');
    const ids = [];
    const asset = store.assets.find((a) => String(a.id) === id);
    if (asset) {
      for (const ref of asset.evidenceRefs || []) {
        if (String(ref && ref.kind || '') === 'conversation') ids.push(String(ref.id || ''));
      }
    }
    if (store.assetVersions && String(store.assetVersions.assetId || '') === id) {
      for (const version of store.assetVersions.versions || []) {
        for (const ref of (version.snapshot && version.snapshot.evidenceRefs) || []) {
          if (String(ref && ref.kind || '') === 'conversation') ids.push(String(ref.id || ''));
        }
      }
    }
    const timeline = store.assetTimeline;
    const proofItems = timeline && String(timeline.assetId || '') === id
      && !timeline.loading && !timeline.failed && Array.isArray(timeline.items)
      ? timeline.items : store.proofs;
    for (const proof of proofItems || []) {
      const refs = (proof && proof.refs) || {};
      if (id && String(refs.assetId || '') !== id) continue;
      if (refs.conversationId) ids.push(String(refs.conversationId));
    }
    await fetchConversationTitles(ids);
  };

  /** 按 id 批量补（候选详情/整理页用，与 loadKstarEpisodeSummariesByIds 同形）：
   *  只收会话类引用，其余 kind 由解析器各自处理。 */
  NS.loadConversationTitlesByIds = async function loadConversationTitlesByIds(refs) {
    const ids = (refs || [])
      .filter((ref) => String((ref && ref.kind) || '') === 'conversation')
      .map((ref) => String((ref && ref.id) || ''));
    await fetchConversationTitles(ids);
  };

  /** 模型自选挂载的资产：confirmed 的 model_selected 投影里
   *  出现的资产 id 集合；失败静默（标记缺席不影响目录）。 */
  NS.loadModelSelectedAssets = async function loadModelSelectedAssets() {
    try {
      const result = await api.call('recall.projections.list', { status: 'confirmed', limit: 100 });
      const projections = (result && result.projections) || [];
      const ids = [];
      for (const projection of projections) {
        if (String(projection.authorization || '') !== 'model_selected') continue;
        for (const assetId of projection.assetIds || []) ids.push(String(assetId));
      }
      const next = [...new Set(ids)];
      // 防重入：onChange 每次 notify 都会调本函数——若
      // 无条件再 notify 就成了"加载→重画→再加载"死循环，整页被拖死。集合没变
      // 就直接返回（对照 loadKstarEpisodes 的守卫）。
      const prev = Array.isArray(store.modelSelectedAssetIds) ? store.modelSelectedAssetIds : [];
      const changed = prev.length !== next.length || next.some((id) => !prev.includes(id));
      if (!changed) return;
      store.modelSelectedAssetIds = next;
      NS.notify();
    } catch (error) {
      // 标记拿不到不影响目录本身。
    }
  };

  /** 按 kse id 批量补复盘摘要（候选详情页用：候选不是资产，走不了
   *  loadKstarEpisodeSummaries 的按资产入口——候选的 kse 引用来自
   *  sourceRefs/evidenceRefs）。 */
  NS.loadKstarEpisodeSummariesByIds = async function loadKstarEpisodeSummariesByIds(ids) {
    await fetchKstarEpisodeSummaries(ids);
  };

  /** 点开单条任务复盘详情（就地展开块）。失败记 failed（读不到 ≠ 没有，
   *  与 loadExperienceDetail 同一惯例）：视图给失败文案与收起重试出口。 */
  NS.loadKstarEpisode = async function loadKstarEpisode(episodeId) {
    const id = String(episodeId || '');
    if (!id) return;
    store.kstarEpisode = { episodeId: id, loading: true, failed: false };
    NS.notify();
    let data = null;
    let failed = false;
    try {
      data = await api.call('recall.kstar.episode.read', { episodeId: id });
    } catch (error) {
      // 显式记失败：不用 !data 代替（成功但空载荷 ≠ 失败，防误报）。
      data = null;
      failed = true;
    }
    if (!store.kstarEpisode || String(store.kstarEpisode.episodeId) !== id) return;
    store.kstarEpisode = { episodeId: id, episode: data && data.episode, review: data && data.review, loading: false, failed };
    NS.notify();
  };

  /** KSTAR 任务复盘列表（kstar-episodes tab）：一次性拉最近复盘过的任务。 */
  NS.loadKstarEpisodes = async function loadKstarEpisodes(force) {
    if (!force && Array.isArray(store.kstarEpisodes)) return;
    const prev = store.kstarEpisodes;
    store.kstarEpisodes = [];
    try {
      const result = await api.soft('kstar.episodes.list', { limit: 50 }, { episodes: [] });
      const episodes = (result && (result.episodes || result.items)) || [];
      store.kstarEpisodes = [...episodes].sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')));
    } catch (error) {
      // 列表缺席只影响 tab 内容，恢复上一份避免整页空白。
      store.kstarEpisodes = prev || [];
    }
    NS.notify();
  };

  /* ────────── 经验目录数据装载───────────
   *  与改进分析同一套按需模式：不进主快照（经验通道与资产快照隔离），进
   *  「经验」页签才拉；失败记 failed（读不到 ≠ 没有，空态与失败分开呈现）。
   *  所有通道只读，动作（暂停/类型/合并/归档/迁移）在 actions 层。 */

  /** 经验列表：status:'all' 一次拉全（上限 200 条），视图侧过滤
   *  active/paused——避免为两个非终态各发一次请求；stale 由 snapshot 打、
   *  动作后 force 重拉。 */
  NS.loadExperiences = async function loadExperiences(force) {
    if (store.experiences && !force && !store.experiences.stale && !store.experiences.failed) return;
    store.experiences = { items: store.experiences && store.experiences.items || [], loading: true, failed: false, stale: false };
    NS.notify();
    let items = [];
    let failed = false;
    try {
      const result = await api.call('recall.experiences.list', { status: 'all', limit: 200 });
      items = (result && result.experiences) || [];
    } catch (error) {
      failed = true;
    }
    store.experiences = { items, loading: false, failed, stale: false };
    // 失败不 notify——app.js 钩子在
    // overview/experiences 路由每帧补拉，失败态再 notify 即成自激死循环；
    // 自愈自重试保留，成功照常 notify。
    if (!failed) NS.notify();
  };

  /** 经验详情：按条缓存；不存在（已归档仍可读，物理删除后查无）如实
   *  记 failed——详情页给「读不到」文案，不冒充空条目。 */
  NS.loadExperienceDetail = async function loadExperienceDetail(experienceId, force) {
    const id = String(experienceId || '');
    if (!id) return;
    if (!force && store.experienceDetail && store.experienceDetail.experienceId === id && !store.experienceDetail.failed) return;
    store.experienceDetail = { experienceId: id, loading: true, failed: false };
    NS.notify();
    let experience = null;
    let failed = false;
    try {
      const result = await api.call('recall.experiences.read', { experienceId: id });
      experience = (result && result.experience) || null;
      if (!experience) failed = true;
    } catch (error) {
      failed = true;
    }
    if (!store.experienceDetail || String(store.experienceDetail.experienceId) !== id) return;
    store.experienceDetail = { experienceId: id, experience, loading: false, failed };
    // 失败不 notify——app.js 钩子
    // 在详情路由每帧补拉，失败态再 notify 即成自激死循环。自愈自重试保留
    // （失败态保留按需重读，避免 notify 触发自激循环），成功照常 notify。
    if (!failed) NS.notify();
  };

  /** 迁移预览（只读）：扫描结果进 store，界面据此逐条核对后显式发起。 */
  NS.loadExperienceMigrationPreview = async function loadExperienceMigrationPreview(force) {
    // 不再整体替换——run 的 running、status 读取的 statusLoading 等瞬态照原样
    // 保留，只动 preview 一族字段，免得扫描在途的提示被另一路读取抹掉。
    const state = store.experienceMigration;
    if (state && state.previewLoading) return;
    if (!force && state && state.preview && !state.previewFailed) return;
    store.experienceMigration = { ...state, previewLoading: true, previewFailed: false };
    NS.notify();
    let preview = null;
    let previewFailed = false;
    try {
      preview = await api.call('recall.experiences.migration.preview', {});
    } catch (error) {
      previewFailed = true;
    }
    const current = store.experienceMigration;
    if (!current || current.previewLoading !== true) return;
    store.experienceMigration = { ...current, preview, previewLoading: false, previewFailed };
    NS.notify();
  };

  /** 迁移状态（只读）：最近一次 run 的回执；从未跑过时 migrationId 为
   *  null——界面如实说「还没执行过」，不把空态误报成失败。 */
  NS.loadExperienceMigrationStatus = async function loadExperienceMigrationStatus() {
    // 读取时不能整体替换 store.experienceMigration
    // 并把 lastRun 抹成 null、running/previewLoading 一并丢失——扫描/迁移在途时
    // 常驻入口的「迁移在途」提示被抹掉、界面重现旧清单；读失败还静默把旧
    // lastRun 置 null 误报「还没执行过」。改为：在途不重入；读取期间保留全部
    // 现值（只加 statusLoading 标记）；失败保留现值；落地前若已被 run 的终态
    // 写入接管（statusLoading 不再是本次置位）则不落地。
    const state = store.experienceMigration;
    if (state && state.statusLoading) return;
    store.experienceMigration = {
      preview: (state && state.preview) || null,
      previewLoading: Boolean(state && state.previewLoading),
      previewFailed: Boolean(state && state.previewFailed),
      running: Boolean(state && state.running),
      lastRun: (state && state.lastRun) || null,
      statusLoading: true,
    };
    NS.notify();
    let lastRun = null;
    let failed = false;
    try {
      const result = await api.call('recall.experiences.migration.status', {});
      lastRun = result && result.migrationId ? result : null;
    } catch (error) {
      // 读失败保留现值（旧 lastRun 不被伪装成「还没执行过」）。
      failed = true;
    }
    const current = store.experienceMigration;
    if (!current || current.statusLoading !== true) return;
    store.experienceMigration = {
      ...current,
      lastRun: failed ? (current.lastRun || null) : lastRun,
      statusLoading: false,
    };
    NS.notify();
  };

  /* ────────── 改进分析与依据链数据装载 ──────────
   * 两个只读通道都不进主快照：结论是「进待我处理页签才需要」，失败面更是整集合
   * 读取——只有真的存在失败类结论时才拉，不给没有失败的用户白付这份开销。
   * 路由副作用放在 core，与 app.js 的 onChange 编排保持一致。 */

  /** 改进分析结论（`kstar.improvement.outcomes.list`，倒序，只读）。
   *  失败记 `failed`（读不到 ≠ 没有：空态与读取失败必须分开呈现）；`force` 重拉。 */
  NS.loadImprovementOutcomes = async function loadImprovementOutcomes(force) {
    // 另半边（失败后无恢复路径）：守卫此前只认 stale，失败后
    // （failed=true、stale=false）被判重挡死——页签钩子的补拉每次都落空，
    // 只能等整页 reload。与 loadExperiences 一样：失败态放行
    // 重拉，配合上面的「失败不 notify」即得「自愈自重试且不成环」。
    if (store.improvementOutcomes && !force && !store.improvementOutcomes.stale && !store.improvementOutcomes.failed) return;
    store.improvementOutcomes = { items: [], loading: true, failed: false, stale: false };
    NS.notify();
    let items = [];
    let failed = false;
    try {
      const result = await api.call('kstar.improvement.outcomes.list', { limit: 50 });
      items = (result && result.outcomes) || [];
    } catch (error) {
      failed = true;
    }
    store.improvementOutcomes = { items, loading: false, failed, stale: false };
    // 失败不 notify——本页签的 onChange
    // 钩子看到 failed 就补拉，失败态再 notify 即成自激死循环；自愈自重试
    // 保留，成功照常 notify。
    if (!failed) NS.notify();
  };

  /** 失败面（`kstar.failures.list`，只读）：失败类结论的就地详情数据源。 */
  NS.loadKstarFailures = async function loadKstarFailures(force) {
    if (store.kstarFailures && !force && !store.kstarFailures.failed) return;
    store.kstarFailures = { items: [], loading: true, failed: false };
    NS.notify();
    let items = [];
    let failed = false;
    try {
      const result = await api.call('kstar.failures.list', {});
      items = (result && result.failures) || [];
    } catch (error) {
      failed = true;
    }
    store.kstarFailures = { items, loading: false, failed };
    // 失败不 notify。
    // 环=「下方钩子放行 failed 态」×「装载尾部无条件 notify」两件事，只掐
    // 后一半即断环；自愈自重试保留（下一次任意 notify 经钩子看到 failed
    // 仍会重拉），成功路径照常 notify 刷新失败面详情。
    if (!failed) NS.notify();
  };

  /** 进候选详情：依据链的采用证据按目标方法补拉（`recall.assets.adoptionReceipts`，
   *  与资产详情「实际采用记录」同一个只读口、同一份缓存）；同次任务的复盘摘要
   *  可能不在候选的引用里（在 learningProvenance.episodeId 上），这里补上。 */
  NS.onChange(() => {
    const candidateId = String((store.route && store.route.candidateId) || '');
    if (!candidateId) return;
    const candidate = store.candidates.find((c) => String(c.id) === candidateId);
    if (!candidate) return;
    const targetAssetId = String(candidate.targetAssetId || '');
    if (targetAssetId) void NS.loadAdoptionReceipts(targetAssetId);
    const episodeId = String((candidate.learningProvenance && candidate.learningProvenance.episodeId) || '');
    if (episodeId) void NS.loadKstarEpisodeSummariesByIds([episodeId]);
  });

  /* ────────────────────────── 路由 ────────────────────────── */

  // 认知树暂不开放，默认进入「我的认知」。
  const TABS = [
    { id: 'tree', titleKey: 'cognition.tab_tree', title: '认知树', disabled: true },
    // 「我的认知」在「本体」前。
    { id: 'overview', titleKey: 'cognition.tab_overview', title: '我的认知' },
    { id: 'ontology', titleKey: 'cognition.tab_ontology', title: '本体' },
    // 认知资产全量重构：独立「待我处理」页签下线——全部
    // 治理动作收敛到「认知生长」的需要关注/已处理；旧 review 路由在
    // router.go 归一化到 activity，深链与历史栈不断。
    { id: 'activity', titleKey: 'cognition.tab_activity', title: '认知生长' },
    { id: 'settings', titleKey: 'cognition.tab_settings', title: '资产设置' },
  ];
  NS.TABS = TABS;
  // 归边判定 NS.isKstarAsset / NS.isKstarCandidate 由 views.js 定义。

  const router = {
    go(next, options) {
      const opts = options || {};
      const current = store.route;
      // 旧路由名归一：tree 暂时回到我的认知；
      // organize→认知生长、organize-settings→设置、experiences→我的
      // 认知·经验档；review（已下线的独立待我处理页）→认知生长·需要关注。
      // 在入栈/落 store 前归一，app.js 的 onChange 钩子读到的恒为新名。
      let target = next || {};
      const legacyName = String(target.name || '');
      if (legacyName === 'tree') target = Object.assign({}, target, { name: 'overview' });
      else if (legacyName === 'organize') target = Object.assign({}, target, { name: 'activity' });
      else if (legacyName === 'organize-settings') target = Object.assign({}, target, { name: 'settings' });
      else if (legacyName === 'experiences') target = Object.assign({}, target, { name: 'overview', category: target.category || 'experiences' });
      else if (legacyName === 'review') target = Object.assign({}, target, { name: 'activity' });
      target = Object.assign({}, target);
      for (const key of ['tagFilter', 'tagMode', 'tagUntagged', 'tagSelect', 'tagOverlay']) delete target[key];
      if (target.category === 'kstar') target = Object.assign({}, target, { category: '' });
      // 先把 next 归一到同一形状再比（部分键字面量 vs 全键展开的序列化恒不等，
      // 避免连点同一 tab 堆积重复栈项）。
      const linkedCandidate = target.candidateId && store.candidates.find(candidate => String(candidate.id) === String(target.candidateId));
      if (target.name === 'activity' && linkedCandidate && ['confirmed', 'integrated', 'rejected', 'ignored', 'expired', 'superseded'].includes(String(linkedCandidate.status))) {
        target = Object.assign({}, target, { activityView: 'done', activityDone: '1' });
      }
      if (target.candCreate) target = Object.assign({}, target, { candCreate: '' });
      const merged = Object.assign({ name: 'overview', category: '', assetId: '', candidateId: '', approvalId: '', moduleId: '', recordId: '', recordVersion: '', proofEventId: '', inboxId: '', poCandidateId: '', activityQuery: '', activityPage: '', captureBucket: '', captureId: '', sourceIssueOpen: '', taskFailedOpen: '', kstarEpisodeId: '', assetVersionId: '', assetEdit: '', assetVersionDiff: '', assetVersionsExpanded: '', assetView: '', candCreate: '', experienceId: '', manage: '', activityDone: '' }, target);
      const same = JSON.stringify(current) === JSON.stringify(merged);
      if (!opts.replace && !same) store.backStack.push(Object.assign({}, current));
      store.route = merged;
      // 滚动不在这里清零：views.render 的 restoreScroll 按
      // routeKey 判定——页面级路由变了回顶，就地展开（使用记录/版本详情/
      // KSTAR 复盘）保持原位。此前无条件清零会把展开后的视口打回页面顶部。
      NS.notify();
    },
    back() {
      const prev = store.backStack.pop();
      if (prev) router.go(prev, { replace: true });
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
    recall_content_purged: ['cognition.content_purged_note',
      '关联资产的内容已清除。此记录保留处理状态，不能编辑、确认或恢复内容。'],
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
    recall_candidate_scope_policy_mismatch: ['cognition.candidate_error_scope_mismatch',
      '这条建议与目标资产的使用范围不一致，不能合并更新。请保存为新资产，或选择范围相同的目标。'],
    recall_candidate_unknown_source: ['cognition.candidate_error_unknown_source',
      '有一条证据引用在来源列表里找不到，不能保存。证据只能从真实来源中选取。'],
    recall_candidate_similar_asset: ['cognition.candidate_error_similar_asset',
      '检测到与现有资产高度相似——确认是新条目，还是同一条的修订（改为更新）。'],
    recall_candidate_changed_during_confirmation: ['cognition.candidate_error_changed_during_confirmation',
      '确认过程中这条候选被改动过，当前内容可能已更新。请重新核对后再确认。'],
    recall_candidate_content_too_long: ['cognition.candidate_error_content_too_long',
      '内容太长，先精简后再保存。'],
    ontology_meaning_unresolved: ['cognition.ontology_meaning_unresolved',
      '本体建议仍有未明确的含义，本次没有保存。请核对“价值与不确定性”，明确说明后保存修改并重新核对建议。'],
    recall_capture_not_review_ready: ['cognition.candidate_error_capture_not_review_ready',
      '它所属的沉淀任务还没到可复核状态，稍后再确认。'],
    recall_capture_writing: ['cognition.candidate_error_capture_writing',
      '它所属的沉淀任务正在写入，等这一次写完再试。'],
  };

  /** 晋升闸门的拦截原因。与 promotion.ts::PromotionBlockReason 一一对应。 */
  const RECALL_PROMOTION_BLOCK_TEXTS = {
    personal_is_project_fact: ['cognition.candidate_block_personal_is_project_fact',
      '这是项目或任务事实，它属于项目，不属于个人信息。'],
    fact_not_stable: ['cognition.candidate_block_fact_not_stable',
      'fact 只收长期稳定的事实（项目、环境、领域、工具链）；带「今天/本次/当前」这类时间限定、又没写明长期有效的叙述只是任务状态，不算可复用事实。请核对长期有效性并改写内容。'],
    template_not_reusable_structure: ['cognition.candidate_block_template_not_reusable_structure',
      '模板要的是从来源里抽出来的可复用结构，指向原文件本身不算。'],
    skill_not_executable: ['cognition.candidate_block_skill_not_executable',
      '方法要写成可执行、可检验的样子，能力自述不算。'],
    rule_boundary_required: ['cognition.candidate_block_rule_boundary_required',
      '规则要先确认适用与禁止范围。'],
    judgment_is_meta_commentary: ['cognition.candidate_block_judgment_is_meta_commentary',
      '这段判断是在评价这条候选本身，不是可复用的内容。'],
    type_conflicts_with_existing: ['cognition.candidate_block_type_conflicts_with_existing',
      '这条内容与已有认知存在冲突，请先核对已有内容和关联目标。'],
  };

  /** 单条晋升阻断原因 → 用户文案（候选确认卡内联说明用）。 */
  NS.promotionBlockText = function promotionBlockText(reason) {
    const entry = RECALL_PROMOTION_BLOCK_TEXTS[reason];
    return entry ? T(entry[0], entry[1]) : '';
  };

  /** 把 IPC 失败体（{code, error, blockRule, promotionReasons}）翻成给用户看的话。 */
  NS.recallErrorText = function recallErrorText(result) {
    const code = String((result && result.code) || '');
    if (String(result?.error || result?.message || '') === 'capture formation source is unavailable')
      return T('cognition.formation_source_changed', '原文已变化或来源暂不可用，本次没有正式保存。请核对来源后刷新；原文变化需通过夜间发现重新核对。');
    // 资产准入/挂载类失败：走规则名映射，并如实说明
    // 「这次操作没有生效」——绝不把主进程的英文原文与内部 id 甩给用户。
    if (code.startsWith('projection_') || (result && result.blockRule)) {
      return T('cognition.action_not_applied', '这次操作没有生效：{reason}', { reason: blockReasonText(result) });
    }
    // 治理处置的稳定错误码：补条件未过门禁（没落库）、
    // 版本冲突（别的改动先落了）。都如实说"这次没有生效"，不甩原文。
    if (code === 'model_not_configured') {
      return T('cognition.candidate_error_model_required', '当前没有可用模型，自动整理步骤无法完成，本次正式保存未完成。候选修改仍保留，可调整认知名称或在应用设置中配置模型后重试。');
    }
    if (code === 'baseline_changed') {
      return T('cognition.ontology_baseline_changed', '本体版本发生变化，本次没有保存，原建议保留。请核对目标记录及关联内容，再点击“重新核对关联建议”。');
    }
    if (code === 'stock_organization_baseline_changed') {
      return T('cognition.stock_baseline_changed', '整理依据发生变化，本次没有保存，原建议保留。请核对当前内容、在用版本、来源及关联记录后更新建议。');
    }
    if (code === 'ontology_meaning_unresolved') {
      return T('cognition.ontology_meaning_unresolved', '本体建议仍有未明确的含义，本次没有保存。请核对“价值与不确定性”，明确说明后保存修改并重新核对建议。');
    }
    if (code === 'invalid_boundary') {
      return T('cognition.inbox_error_boundary_invalid', '条件没有通过规则门禁——没有保存，请补齐后再试。');
    }
    // 待办处置入口区分：id 不合法 / 对象不存在或不能在这里处置 / 动作不适用。
    // 主进程 message 是中文人话但带动态插值，四语用户读不到——按码翻成固定
    // 词条；这三码的 7 条抛出路径（含 6 处旧路径）经此一处分支全部覆盖。
    if (code === 'invalid_item_id') {
      return T('cognition.inbox_error_item_id_invalid', '这条待办的标识不合法，请刷新后重试。');
    }
    if (code === 'unsupported_item_kind') {
      return T('cognition.inbox_error_item_kind_unsupported', '这条待办指向的对象已不存在或不能再在这里处置，请刷新列表查看最新状态。');
    }
    if (code === 'unsupported_action') {
      return T('cognition.inbox_error_action_unsupported', '这个操作不适用于这条待办，请刷新后查看最新状态。');
    }
    if (code === 'version_conflict') {
      return T('cognition.inbox_error_version_conflict', '这条资产刚被别的改动更新过（版本冲突），请重试。');
    }
    if (code === 'tags_conflict') {
      return T('cognition.inbox_error_tags_conflict', '这条资产的标签在你看过之后被改过，这条提议已作废；AI 会基于最新内容重新提议。');
    }
    if (code === 'promotion_gate_rejected') {
      // 冲突选边后半程——另一边已出局，保留侧没过晋升
      // 闸门。主进程 message 已是人话（含原因与去向），这里只保证兜底文案。
      return (result && result.error) || T('cognition.inbox_error_gate_rejected', '选边已生效，但保留的这一条还需要你到「待我处理」的候选详情里完成确认。');
    }
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
      'recall capture is disabled': ['cognition.capture_error_disabled', '会话整理暂不可用，请查看资产设置。'],
      'conversation not found': ['cognition.capture_error_conversation_not_found', '找不到这个会话，暂时无法沉淀。'],
      'capture formation source is unavailable': ['cognition.formation_source_changed', '原文已变化或来源暂不可用，本次没有正式保存。请核对来源后刷新；原文变化需通过夜间发现重新核对。'],
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
    defer: 'recall.candidates.defer',
    'keep-current': 'recall.candidates.keepCurrent',
  };

  // originKindOf 已随出身收敛退役：「模型记的=已确定」，
  // 出身三值不再是显示或行为维度；出身章与转正动作一并移除。

  /* ── 确认更新撞版本冲突的就地处置────────────────
   * 确认时主进程在 `updateAbilityAsset` **锁内**比对"候选锚定的版本"与"当前
   * 在用版"；不一致就返回结构化冲突（资产零改动、候选不落终态）。渲染层在这
   * 里做三件事：
   *  ① 把冲突摆成页面状态（视图据此如实说"这次没有生效"）——决不静默覆盖、
   *     决不当成成功、**决不自动重试**；
   *  ② 重取资产与**版本链**（缓存里那份正是冲突前的旧链，拿它展示差异等于拿
   *     旧差异糊弄用户），从中取当前在用版正文喂给冲突块；
   *  ③ 等用户看过"对当前版差异"后点「按当前版本重新确认」——那一次点击才带
   *     `confirmBaselineVersion`（见 actions.decideCandidate 的 rebase 分支）。
   * 候选在此之后仍是待处理（`recall.candidates.read` 的真实状态），本函数不写
   * 任何终态、不改候选。 */
  async function openCandidateVersionConflict(candidate, conflict) {
    const candidateId = String(candidate.id || '');
    const targetAssetId = String(candidate.targetAssetId || '');
    store.candidateVersionConflict = {
      candidateId,
      baselineVersion: String((conflict && conflict.baselineVersion) || ''),
      currentVersion: String((conflict && conflict.currentVersion) || ''),
      targetVersionUsed: String((conflict && conflict.targetVersionUsed) || ''),
      currentStatement: '',
      /** 当前在用版的快照（versions.list 里那一版）：冲突块按它逐字段重摆
       *  「当前 → 拟生效」的差异。读不到就是 null——界面据此如实说读不到。 */
      currentSnapshot: null,
      versionsLoading: !!targetAssetId,
      versionsFailed: false,
    };
    NS.notify();
    if (targetAssetId) store.assetVersions = null;
    // 资产列表与版本链都重取：正文与在用版号要一致（冲突正是"它们变了"）。
    await NS.reload();
    if (!targetAssetId) return;
    await NS.loadAssetVersions(targetAssetId, true);
    const state = store.candidateVersionConflict;
    if (!state || state.candidateId !== candidateId) return;
    const versions = (store.assetVersions && String(store.assetVersions.assetId || '') === targetAssetId)
      ? store.assetVersions.versions
      : [];
    const row = (versions || []).find((v) => String(v.version) === String(state.currentVersion));
    const snapshot = (row && row.snapshot) || null;
    const statement = String((snapshot && snapshot.statement) || '').trim();
    // 读不到正文（版本链没拉到/当前版号在链里找不到）如实记为失败：冲突块说
    // "没能读到当前版本正文"，不拿空的或旧的正文冒充。
    store.candidateVersionConflict = {
      ...state, currentSnapshot: snapshot, currentStatement: statement, versionsLoading: false, versionsFailed: !statement,
    };
    NS.notify();
  }

  function confirmedPromotion(result, candidateId) {
    const candidate = result?.candidate;
    if (String(candidate?.id || '') === String(candidateId) && candidate?.proposalTarget === 'ontology'
      && candidate.status === 'integrated' && !candidate.promotedAssetId) {
      const handoff = candidate.ontologyHandoff, receipt = result.ontologyHandoff;
      if (handoff?.status === 'integrated' && handoff.commandId && handoff.recordIds?.length
        && receipt?.commandId === handoff.commandId && receipt.ontologyRevision === handoff.ontologyRevision
        && JSON.stringify(receipt.recordIds) === JSON.stringify(handoff.recordIds)) return { candidate, ontologyHandoff: handoff };
      return null;
    }
    const assetId = String(candidate?.promotedAssetId || '');
    if (String(candidate?.id || '') !== String(candidateId) || candidate?.status !== 'confirmed' || !assetId) return null;
    if (String(result?.asset?.id || '') !== assetId) return null;
    return { candidate, asset: result.asset, assetId };
  }

  async function verifyPromotion(result, candidateId) {
    const direct = confirmedPromotion(result, candidateId);
    if (direct) return direct;
    // Use these exact read responses, never a shared cache whose request may
    // have been superseded by a concurrent write broadcast.
    try {
      const read = await api.call('recall.candidates.read', { candidateId });
      const candidate = read?.candidate;
      if (String(candidate?.id || '') === String(candidateId) && candidate?.proposalTarget === 'ontology' && candidate.status === 'integrated') {
        const snapshot = await api.call('cognition.ontology.snapshot');
        const handoff = candidate.ontologyHandoff;
        const receipt = snapshot?.ontology?.receipts?.[handoff?.commandId];
        if (!receipt || receipt.revision !== handoff.ontologyRevision
          || JSON.stringify(receipt.changedIds) !== JSON.stringify(handoff.recordIds)
          || receipt.changedIds.some(id => !snapshot.ontology.records?.[id])) return null;
        return confirmedPromotion({ candidate, ontologyHandoff: handoff }, candidateId);
      }
      if (String(candidate?.id || '') !== String(candidateId) || candidate.status !== 'confirmed' || !candidate.promotedAssetId) return null;
      const saved = await api.call('recall.assets.read', { assetId: candidate.promotedAssetId });
      return confirmedPromotion({ candidate, asset: saved?.asset }, candidateId);
    } catch {
      return null;
    }
  }

  function requireLibraryAsset(assetId, statuses = ['active', 'paused']) {
    if (store.assetsError) throw new Error(T('cognition.library_stale_readonly', '当前显示上次读取的内容；请刷新核对后再修改。'));
    const asset = store.assets.find(row => String(row.id || '') === String(assetId || ''));
    if (!asset || !assetId || !['cognition', 'personal', 'fact', 'rule', 'template', 'skill_method'].includes(asset.type)
      || !statuses.includes(asset.status)) {
      throw new Error(T('cognition.library_action_unavailable', '当前内容状态不允许此操作，请刷新核对后再试。'));
    }
    return asset;
  }

  const actions = {
    /** 资产编辑按需加载可读的 Agent / 工作空间名称。目录失败不阻断正文
     *  编辑；保存时省略 scopePolicy，后端就会保留原策略。 */
    async loadAssetScopeOptions() {
      const current = store.assetScopeOptions || {};
      if (current.status === 'ready' || current.status === 'loading') return;
      store.assetScopeOptions = { status: 'loading', agents: [], spaces: [], error: '' };
      NS.notify();
      try {
        const [agentResult, spaceResult] = await Promise.all([
          api.call('agents.list', { summary: true }),
          api.call('spaces.list', {}),
        ]);
        store.assetScopeOptions = {
          status: 'ready',
          agents: toArr(agentResult, ['agents']).filter((agent) => agent && typeof agent.agent_id === 'string' && agent.agent_id),
          spaces: toArr(spaceResult, ['spaces']).filter((space) => space && typeof space.space_id === 'string' && space.space_id),
          error: '',
        };
      } catch (error) {
        store.assetScopeOptions = {
          status: 'error', agents: [], spaces: [],
          error: String((error && error.message) || error || ''),
        };
      }
      NS.notify();
    },

    /** 采纳：可选携带编辑后的字段（adjust=true 时从表单读取）。 */
    async adoptCandidate(candidateId, formValues) {
      const activityRoute = store.route.name === 'activity';
      const activityOperation = activityRoute ? NS.activityController?.beginDecision() : undefined;
      const candidate = store.candidates.find((c) => c.id === candidateId);
      if (!candidate) return;
      if (candidate.contentOrganization) {
        if (formValues?.outputs) await api.call('recall.candidates.organization.update', { candidateId, outputs: formValues.outputs });
        const result = await api.call('recall.candidates.promote', { candidateId, organizationOutputs: formValues?.outputs || candidate.contentOrganization.draft.outputs });
        const receipt = result.candidate?.organizationReceipt;
        if (!receipt || receipt.assets?.length !== candidate.contentOrganization.draft.outputs.length)
          throw new Error(T('cognition.activity_draft_missing', '没有读到保存后的候选，请刷新后核对。'));
        NS.activityController?.clearDraft?.(candidateId);
        await NS.reload();
        if (activityOperation) NS.activityController.afterDecision(candidateId, false, activityOperation);
        toast(T('cognition.organization_saved', '整组内容已保存，原条目已归档。'), 'success');
        return;
      }

      // Keep the user's edits available for alternate decisions later in this
      // flow (for example, changing a similar new item into an update). The
      // store snapshot is still the pre-edit version until reload completes.
      const promotionDraft = formValues ? Object.assign({}, candidate, formValues) : candidate;
      // 版本冲突后的**再次确认**：冲突状态还挂在这个候选上
      // 时，用户这次点击就是"我已看过对当前在用版的差异，再确认一次"——把
      // `confirmBaselineVersion = 冲突返回的当前在用版` 带下去，主进程在资产锁内
      // 再校验一次。这只是把用户这一次点击的意图传下去，**不是自动重试**：撞了
      // 冲突就停下（见下面的 catch），没有任何代码会替用户重发。
      const conflictState = store.candidateVersionConflict
        && String(store.candidateVersionConflict.candidateId) === String(candidateId)
        ? store.candidateVersionConflict
        : null;
      const confirmBaselineVersion = String((conflictState && conflictState.currentVersion) || '');
      if (candidate.risk === 'high') {
        const ok = await confirmUser(T('cognition.candidate_high_risk_confirm', '这是高风险资产变更。确认继续保存吗？'));
        if (!ok) return;
      }
      if (formValues) {
        const edited = await api.call('recall.candidates.update', Object.assign({
          candidateId,
          value: candidate.value || '',
          evidenceSummary: candidate.evidenceSummary || '',
          uncertainty: candidate.uncertainty || '',
          suggestedAction: candidate.suggestedAction || 'create',
          risk: candidate.risk || 'low',
          expiresAt: candidate.expiresAt,
          taskRunId: candidate.taskRunId,
          targetAssetId: candidate.targetAssetId,
          // 证据与适用/禁止边界不在表单里编辑：原样带回，防止一次"调整后采纳"
          // 把候选原有的证据链与边界静默清空。
          sourceRefs: candidate.sourceRefs || candidate.evidenceRefs || [],
          evidenceRefs: candidate.evidenceRefs || candidate.sourceRefs || [],
          applicableWhen: candidate.applicableWhen || [],
          forbiddenWhen: candidate.forbiddenWhen || [],
        }, formValues));
        if (candidate.ontologyFormation) {
          if (edited?.candidate?.id !== candidateId) throw new Error(T('cognition.activity_draft_missing', '没有读到保存后的候选，请刷新后核对。'));
          store.candidates[store.candidates.findIndex(item => item.id === candidateId)] = edited.candidate;
          NS.activityController?.clearDraft?.(candidateId);
          if (edited.candidate.ontologyFormation?.blockedReasons?.length) {
            toast(T('cognition.formation_recheck_required', '认知修改已保存；关联本体建议需要重新核对，尚未正式生效。'));
            NS.notify();
            return;
          }
        }
      } else if (!String(candidate.suggestedScope || '').trim()) {
        await alertUser(T('cognition.candidate_scope_required', '先填写作用范围：没有范围的资产不会被带入任何任务。'));
        return;
      }
      // 版本组防分裂：create 候选与现有资产语义高度相似时后端
      // 拦下并返回专用错误码——问用户"仍存新条目"还是回来改为更新。
      // 重锚声明只挂在"主确认"这一次调用上：相似资产的二次选择（`promote(true)`）
      // 是另一条分流，主进程对 create 落点也没有版本比对面。
      const promote = (force, baseline) => api.call('recall.candidates.promote', {
        candidateId,
        forceCreateSimilar: force,
        ...(candidate.risk === 'high' ? { riskAcknowledged: true } : {}),
        ...(baseline ? { confirmBaselineVersion: baseline } : {}),
      });
      let result;
      try {
        result = await promote(false, confirmBaselineVersion);
      } catch (error) {
        // 版本冲突：这条资产在确认前被改过——**这次没有
        // 生效**（不是部分生效、更不是静默覆盖）。把结构化冲突摆到页面上，按
        // 当前在用版重新展示差异并等用户显式重新确认；不自动重试。
        if (['baseline_changed', 'stock_organization_baseline_changed'].includes(error?.code)) {
          const message = NS.recallErrorText(error);
          const states = store.formationRechecks || (store.formationRechecks = {});
          if (candidate.ontologyFormation) states[candidateId] = { running: false, error: message, completed: false };
          try {
            const read = await api.call('recall.candidates.read', { candidateId });
            if (read?.candidate?.id !== candidateId) throw new Error('candidate refresh unavailable');
            const index = store.candidates.findIndex(item => item.id === candidateId);
            if (index >= 0) store.candidates[index] = read.candidate;
          } catch (_) {
            if (candidate.ontologyFormation) states[candidateId].error += ' ' + T('cognition.activity_read_failed', '部分变化未能读取，请重试；不能据此判断没有待处理内容。');
          }
          // Refresh source warnings without clearing the detail controller's drafts.
          await NS.loadReviewEvidence('candidate', candidateId, true);
          NS.notify();
          await alertUser(message);
          if (activityRoute) NS.activityController?.focusFormationRecovery(candidateId, activityOperation);
          return;
        }
        if (error && error.versionConflict) {
          await openCandidateVersionConflict(candidate, error.versionConflict);
          return;
        }
        if (error && error.code === 'recall_candidate_similar_asset') {
          const info = String(error.message || '').replace(/^similar asset [^ ]+ /, '').replace(/ \(score [\d.]+\)$/, '');
          // 相似确认改双选：此前用「确认=新条目 /
          // 取消=改为更新」——取消不等于取消，用户凭"别乱存"的本能点取消
          // 会被推进一个没预期的流程。uiChoice 三义各归其位：存为新条目 /
          // 更新到该条 / 先不动（真取消）。
          let choice = null;
          if (typeof window.uiChoice === 'function') {
            choice = await window.uiChoice({
              title: T('cognition.candidate_similar_choice_title', '检测到与现有资产高度相似'),
              message: T('cognition.candidate_similar_choice_message', '这条候选与「{info}」高度相似。要怎么处理？', { info }),
              choices: [
                { id: 'create', label: T('cognition.candidate_similar_choice_create', '存为新条目') },
                { id: 'update', label: T('cognition.candidate_similar_choice_update', '更新到该条资产'), style: '' },
              ],
              cancelLabel: T('cognition.candidate_similar_choice_cancel', '先不动'),
            });
          } else {
            choice = await confirmUser(T('cognition.candidate_similar_asset_confirm', '检测到与现有资产高度相似（{info}）。确认 = 保存为新条目；取消 = 改为对它的更新。', { info })) ? 'create' : 'update';
          }
          if (choice === 'create') {
            result = await promote(true);
          } else if (choice === 'update') {
            const match = String(error.message || '').match(/^similar asset ([A-Za-z0-9-]+)/);
            const targetAssetId = match ? match[1] : '';
            if (targetAssetId) {
              await api.call('recall.candidates.update', {
                candidateId,
                judgment: promotionDraft.judgment,
                value: promotionDraft.value || '',
                summary: promotionDraft.summary || '',
                suggestedType: promotionDraft.suggestedType,
                ...(promotionDraft.contentCategory == null ? {} : { contentCategory: promotionDraft.contentCategory }),
                suggestedScope: promotionDraft.suggestedScope || 'general',
                suggestedAction: 'update',
                targetAssetId,
                risk: promotionDraft.risk || 'low',
                sourceRefs: candidate.sourceRefs || candidate.evidenceRefs || [],
                evidenceRefs: candidate.evidenceRefs || candidate.sourceRefs || [],
              });
              toast(T('cognition.candidate_switched_to_update', '已改为更新——请对照差异后确认'));
              await NS.reload();
            }
            return;
          } else {
            return; // 先不动：真正的取消，什么都不发生。
          }
        } else {
          throw error;
        }
      }
      const confirmed = await verifyPromotion(result, candidateId);
      if (!confirmed) {
        store.lastPromoted = null;
        toast(T('cognition.manual_save_unconfirmed', '内容已提交，暂时无法确认正式保存结果。请打开这条记录核对状态，不必重复提交。'), 'warning');
        NS.notify();
        return;
      }
      result = Object.assign({}, result, confirmed);
      // 存量候选没有记录任务当时的版本（`versionCheckSkipped`）：主进程没有可
      // 核对的对象，这次确认照常生效——但必须如实说清"无法核对改进对象"，绝不
      // 假装核过。这条只出现在确认成功的返回体上。
      if (result && result.versionCheckSkipped === true) {
        toast(T('cognition.candidate_version_check_skipped', '这条候选没有记录任务当时的版本，无法核对改进对象；本次确认按当前内容生效。'), 'warning');
      }
      // 确认已落地：冲突状态不再成立（重锚成功也走这里）。
      store.candidateVersionConflict = null;
      // promote 结果体的资产身份在 `asset.id`（顶层 `assetId` 是更早契约的读法，
      // 兼容保留）。拿得到才发去向提示并直落资产详情；拿不到不发——认知树没有
      // 资产级节点，宁可不给入口也不往树跳。
      const promotedAssetId = confirmed.assetId;
      if (confirmed.ontologyHandoff) {
        store.lastPromoted = null;
        toast(T('cognition.ontology_proposal_saved', '本体变化已保存'), 'success');
      }
      if (promotedAssetId) {
        toast(T('cognition.candidate_promoted', '已成为正式资产'), 'success');
        // 检修剪：update 候选确认会 bump 目标资产版本——曾缓存的版本链失效。
        if (candidate && candidate.targetAssetId) store.assetVersions = null;
        // 去向提示：回到「待我处理」时仍能打开刚保存的确切资产；认知树没有
        // 资产级节点，详情链接必须带 promotedAssetId。
        store.lastPromoted = {
          assetId: promotedAssetId,
          title: String(candidate.summary || candidate.judgment || ''),
          at: Date.now(),
        };
        if (!activityRoute) router.go({ name: 'overview', assetId: promotedAssetId });
      }
      // 晋升的就地消费——候选响应直接替换 store 条目
      //（confirmed + promotedAssetId），资产/树/时间线由写入广播重拉（candidates /
      //  ability-assets 两路 collection 都有映射）；不再整池 reload（此前与广播
      // 同一秒拉两遍）。响应缺候选时退回全量重读，行为不劣化。
      if (result && result.candidate && result.candidate.id) {
        const index = store.candidates.findIndex((c) => String(c.id) === String(result.candidate.id));
        if (index >= 0) store.candidates[index] = result.candidate;
        else store.candidates.push(result.candidate);
        if (activityOperation) NS.activityController.afterDecision(candidateId, false, activityOperation);
        NS.notify();
      } else {
        await NS.reload();
        if (activityOperation) NS.activityController.afterDecision(candidateId, false, activityOperation);
      }
    },
    async decideCandidate(candidateId, action) {
      const channel = CANDIDATE_CHANNELS[action];
      if (!channel) return;
      const activityOperation = store.route.name === 'activity' ? NS.activityController?.beginDecision() : undefined;
      // 处置响应携带更新后的完整候选——就地替换 store
      // 里的对应条目，不再整池重读（写入广播仍会在合并窗口后重拉 candidates
      // 区块作兜底；此前是「显式 reload + 广播重拉」同一秒拉两遍）。
      const result = await api.call(channel, { candidateId });
      // 已处置（稍后/拒绝/忽略）：冲突提示不再成立——候选已离开待确认。
      // （清理放在响应分支前：无论响应是否携带候选，动作已成功即应清掉。）
      if (store.candidateVersionConflict && String(store.candidateVersionConflict.candidateId) === String(candidateId)) {
        store.candidateVersionConflict = null;
      }
      const updated = result && result.candidate;
      if (updated && updated.id) {
        const index = store.candidates.findIndex((c) => String(c.id) === String(updated.id));
        if (index >= 0) store.candidates[index] = updated;
        else store.candidates.push(updated);
      } else {
        // 响应没带候选（老后端/通道差异）：退回全量重读，行为不劣化。
        await NS.reload();
        if (activityOperation) NS.activityController.afterDecision(candidateId, false, activityOperation);
        return;
      }
      toast({ reject: T('cognition.candidate_rejected', '已拒绝'), ignore: T('cognition.candidate_ignored', '已忽略'), defer: T('cognition.activity_deferred_saved', '已标记稍后处理，仍保留在需要关注中。') }[action] || T('common.done', '已完成'));
      if (activityOperation) NS.activityController.afterDecision(candidateId, action === 'defer', activityOperation);
      NS.notify();
    },
    async rateProof(proofId, feedback, extra) {
      const busy = store.proofRatingsBusy || (store.proofRatingsBusy = {});
      if (busy[proofId]) return;
      busy[proofId] = true;
      try {
      const details = Object.assign({}, extra || {});
      const result = await api.call('recall.proofs.effectiveness.feedback', Object.assign({ transferProofId: proofId, feedback }, details));
      toast(result?.proof?.outcome === 'insufficient_evidence'
        ? T('cognition.effect_insufficient', '评价已记录；证据不足，未提升验证程度。') : T('cognition.proof_rating_done', '已记下这次评价'));
      await NS.reload();
      return result;
      } finally { delete busy[proofId]; }
    },
    async assetAction(assetId, action) {
      const channels = {
        pause: 'recall.assets.pause', resume: 'recall.assets.resume',
        archive: 'recall.assets.archive', restore: 'recall.assets.restore',
        delete: 'recall.assets.delete', purge: 'recall.assets.purge',
      };
      const channel = channels[action];
      if (!channel) return;
      const dangerCopy = {
        delete: T('cognition.asset_delete_confirm', '删除会从资产列表移除该资产，但保留历史；确认删除？'),
        purge: T('cognition.asset_purge_confirm', '彻底清除会删除全部历史与证据，且不可恢复。确认清除？'),
      };
      if (dangerCopy[action]) {
        const ok = await confirmUser(dangerCopy[action], true);
        if (!ok) return;
      }
      requireLibraryAsset(assetId, { pause: ['active'], resume: ['paused'], restore: ['archived', 'deleted'], purge: ['deleted'] }[action] || ['active', 'paused']);
      await api.call(channel, { assetId });
      // 删除反馈说明当前保留期；恢复资格仍以服务端记录为准。
      toast(action === 'delete'
        ? T('cognition.asset_delete_done_retention', '已删除，30 天内可在「已删除」中恢复')
        : T('cognition.asset_action_done', '已完成'));
      if (action === 'delete' || action === 'purge') router.go({ name: 'overview' });
      await NS.reload();
    },
    /** 选用历史版本为在用版：切指针不产生新版本号。 */
    async selectAssetVersion(assetId, version) {
      requireLibraryAsset(assetId);
      await api.call('recall.assets.versions.select', { assetId, version });
      toast(T('cognition.asset_version_selected', '已选用 v{n}', { n: String(version) }));
      store.assetVersions = null;
      await NS.reload();
    },
    /** 维护只检查并生成建议；不改资产、候选或历史。 */
    async runMaintenance() {
      store.cleanupReports = { loading: true, reports: (store.cleanupReports && store.cleanupReports.reports) || [] };
      NS.notify();
      try {
        const result = await api.call('recall.maintenance.run', {});
        const run = (result && result.inspection) || null;
        const report = (result && result.cleanup) || null;
        toast(T('cognition.maint_run_done', '检查完成：发现 {findings} 条 · 整理建议 {uncertain} 项；没有修改内容', {
          findings: String(((run && run.findings) || []).length),
          applied: String(((report && report.items) || []).filter((item) => item.status === 'applied').length),
          uncertain: String(((report && report.uncertain) || []).length),
        }));
        store.cleanupReports = { loading: false, stale: true, reports: [] };
      } catch (error) {
        store.cleanupReports = { loading: false, stale: true, reports: [] };
        throw error;
      }
      await NS.reload();
    },
    /** 「已删除」列表按需拉：保留期剩余天数由服务端现算。 */
    async loadDeletedAssets(force = false) {
      if (!force && store.deletedAssets && !store.deletedAssets.stale) return;
      store.deletedAssets = { loading: true, items: (store.deletedAssets && store.deletedAssets.items) || [], total: (store.deletedAssets && store.deletedAssets.total) || 0, error: undefined };
      NS.notify();
      let items = [];
      let total = 0;
      let error;
      // 失败置 stale——「没读到」不得伪装成
      // 「没有」后被判重挡死；置 stale 后守卫放行，用户可点重试或下次进页自愈。
      try {
        const result = await api.call('recall.assets.deleted.list', { limit: 200 });
        items = (result && result.items) || [];
        total = Number(result && result.total) || items.length;
      } catch (failure) {
        items = [];
        total = 0;
        error = (failure && failure.message) || T('cognition.deleted_read_failed', '已删除列表读取失败，请重试。');
      }
      store.deletedAssets = { loading: false, items, total, stale: !!error, ...(error ? { error } : {}) };
      NS.notify();
    },
    /** 保留期内的「立即彻底删除」入口。 */
    async purgeDeletedAsset(assetId) {
      await api.call('recall.assets.deleted.purgeNow', { assetId: String(assetId || '') });
      toast(T('cognition.deleted_purged', '已彻底删除：内容与记录一并清除，不可恢复'));
      store.deletedAssets = { loading: false, stale: true, items: (store.deletedAssets && store.deletedAssets.items) || [], total: (store.deletedAssets && store.deletedAssets.total) || 0 };
      await NS.reload();
    },
    /** 巡检开关：关掉之后不再自动运行；
     *  手动触发不受影响（那是用户自己要的）。
     *  opts.silent：自动维护总开关联动时用——不弹自己的 toast（总开关已有
     *  统一反馈），数据照常置 stale 供「最近检查」行刷新。 */
    async setInspectionEnabled(enabled, opts = {}) {
      await api.call('recall.inspection.settings.set', { enabled: Boolean(enabled) });
      if (!opts.silent) {
        toast(enabled
          ? T('cognition.inspection_switch_on_toast', '已开启定期检查')
          : T('cognition.inspection_switch_off_toast', '已关闭定期检查'));
      }
      store.inspection = { loading: false, stale: true, settings: (store.inspection && store.inspection.settings) || null, latestRun: (store.inspection && store.inspection.latestRun) || null };
      await NS.reload();
    },
    /** 手动跑一轮巡检（与开关无关）。 */
    async runInspection() {
      await api.call('recall.inspection.run', {});
      const result = await api.call('recall.inspection.list', { limit: 1 });
      const run = ((result && result.runs) || [])[0] || null;
      toast(T('cognition.inspection_done', '巡检完成：发现 {n} 条待处理', { n: String(((run && run.findings) || []).length) }));
      store.inspection = { loading: false, stale: true, settings: (store.inspection && store.inspection.settings) || null, latestRun: run };
      await NS.reload();
    },
    /** 逐项回滚：报告项自带的锚点就是回滚入口。 */
    async rollbackCleanupItem(assetId, version) {
      await api.call('recall.assets.rollback', { assetId, version });
      toast(T('cognition.cleanup_rolled_back', '已回滚到整理前的内容（生成新版本）'));
      store.cleanupReports = { loading: false, stale: true, reports: (store.cleanupReports && store.cleanupReports.reports) || [] };
      await NS.reload();
    },
    /** 拿不准项的处置：只给意见，不执行动作（当初就是因为拿不准才没动手）。 */
    async decideCleanupItem(reportId, assetId, decision) {
      await api.call('cognition.inbox.resolve', { id: `cleanup:${reportId}:${assetId}`, action: decision });
      toast(decision === 'reject'
        ? T('cognition.cleanup_decided_dismissed', '已标记不管，从清单移走')
        : T('cognition.cleanup_decided_deferred', '已放到回头再看'));
      store.cleanupReports = { loading: false, stale: true, reports: (store.cleanupReports && store.cleanupReports.reports) || [] };
      await NS.reload();
    },
    /** 真删单个版本：物理移除该版本记录；引用它的已确认注入
     *  在服务端冻结内容副本后继续可用。危险操作，双按钮确认。 */
    async deleteAssetVersion(assetId, version) {
      const ok = await confirmUser(T('cognition.asset_version_delete_confirm',
        '永久删除 v{n}，不可恢复。引用过它的已确认注入会继续使用保留的内容副本。确认删除？', { n: String(version) }), true);
      if (!ok) return;
      requireLibraryAsset(assetId);
      await api.call('recall.assets.versions.delete', { assetId, version });
      toast(T('cognition.asset_version_deleted', '已删除 v{n}', { n: String(version) }));
      if (String(store.route.assetVersionId || '') === String(version)) {
        router.go({ name: 'overview', assetId: String(store.route.assetId || ''), assetVersionId: '' }, { replace: true });
      }
      store.assetVersions = null;
      await NS.reload();
    },
    /** 基于某一版修改：编辑入口在版本行；历史版
     *  先设为在用（select 通道，切指针不产新版本），再进入编辑——"切回+
     *  编辑"合一步，每个版本都能成为编辑起点。 */
    async editFromVersion(assetId, version) {
      const asset = requireLibraryAsset(assetId);
      if (String(asset.activeVersion || asset.version) !== String(version)) {
        await api.call('recall.assets.versions.select', { assetId, version });
        toast(T('cognition.asset_version_selected', '已选用 v{n}', { n: String(version) }));
        store.assetVersions = null;
        await NS.reload();
      }
      router.go({ name: 'overview', assetId, assetVersionId: '', assetVersionDiff: '', assetEdit: '1' }, { replace: true });
    },
    /** 手动编辑资产：改动自己写的话不该以"系统先
     *  产候选"为前提。与现值逐字段比对，无实际修改不提交——后端没有内容
     *  等价检查，相同内容也会 bump 出空版本。 */
    async editAsset(assetId) {
      const card = document.querySelector('.ca-detail-expand .ca-asset-edit') || document.querySelector('.ca-library-detail:not(.is-mirror) .ca-asset-edit') || document.querySelector('.ca-asset-edit');
      if (!card) return;
      const asset = requireLibraryAsset(assetId);
      const editDraft = (store.assetEditDrafts || {})[String(assetId)] || {};
      const raw = (name) => { const el = card.querySelector(`[data-f="${name}"]`); return el ? String(el.value || '').trim() : ''; };
      const splitList = (text) => (text ? String(text).split(/[、;；,，\n]/).map((s) => s.trim()).filter(Boolean) : []);
      const reviewBase = editDraft.baseReviewDetails;
      const originalConditionText = (field) => (Array.isArray(reviewBase?.[field]) ? reviewBase[field].join('、').trim() : undefined);
      const conditionValue = (name, field) => {
        if (!card.querySelector(`[data-f="${name}"]`)) return reviewBase?.[field] || asset[field] || [];
        // Existing prose can contain punctuation that is also the entry
        // separator. An untouched display string must preserve its exact array.
        if (originalConditionText(field) === raw(name)) return [...reviewBase[field]];
        return splitList(raw(name));
      };
      const payload = {
        ...(card.querySelector('[data-f="contentCategory"]') ? { contentCategory: raw('contentCategory') } : {}),
        title: raw('title'),
        statement: raw('statement'),
        ...(card.querySelector('[data-f="value"]') ? { value: raw('value') } : {}),
        applicableWhen: conditionValue('applicable', 'applicableWhen'),
        forbiddenWhen: conditionValue('forbidden', 'forbiddenWhen'),
      };
      // 范围编辑以可读目录作选择，持久层仍写稳定 id。只修改用户实际碰过的
      // 两个维度；角色/项目/用途等其他维度保持原样。目录不可用时不提交策略，
      // 因此用户仍可保存正文而不会意外放宽现有权限。
      const policy = asset.scopePolicy && typeof asset.scopePolicy === 'object' ? asset.scopePolicy : {};
      const scopeSelection = editDraft.scopeSelection && typeof editDraft.scopeSelection === 'object'
        ? editDraft.scopeSelection : {};
      const scopeUnrestrict = new Set(Array.isArray(editDraft.scopeUnrestrict) ? editDraft.scopeUnrestrict : []);
      const directoryReady = store.assetScopeOptions && store.assetScopeOptions.status === 'ready';
      let visibilityChanged = false;
      if (directoryReady) {
        const nextPolicy = { ...policy };
        const dimensions = [
          { kind: 'agent', field: 'agentIds' },
          { kind: 'space', field: 'workspaceIds' },
        ];
        const sameIds = (left, right) => {
          const normalize = (values) => Array.from(new Set((Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim()).filter(Boolean))).sort();
          return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
        };
        for (const dimension of dimensions) {
          const hasCurrent = Object.prototype.hasOwnProperty.call(policy, dimension.field);
          if (scopeUnrestrict.has(dimension.kind)) {
            if (hasCurrent) {
              delete nextPolicy[dimension.field];
              visibilityChanged = true;
            }
            continue;
          }
          if (!Object.prototype.hasOwnProperty.call(scopeSelection, dimension.field)) continue;
          const selected = Array.from(new Set((Array.isArray(scopeSelection[dimension.field]) ? scopeSelection[dimension.field] : [])
            .map((value) => String(value || '').trim()).filter(Boolean)));
          if (!selected.length) {
            if (editDraft.scopeSelectionModes?.[dimension.field] === 'restrict') throw new Error(T('cognition.library_scope_selection_required', '选择“仅所选对象”后，请至少选择一个仍可用的对象。'));
            // 空选择不能隐式扩大范围。已有维度只有通过显式 scopeUnrestrict
            // 动作才能删除；无现有限制时空选择仍代表不新增限制。
            continue;
          } else if (!sameIds(selected, policy[dimension.field])) {
            nextPolicy[dimension.field] = selected;
            visibilityChanged = true;
          }
        }
        if (visibilityChanged) payload.scopePolicy = nextPolicy;
      }
      // 敏感级变更检测已随敏感级机制整体删除：表单不再有该控件，
      // 保存负载也不携带 sensitivity。
      const unchanged = payload.title === String(asset.title || '')
        && (!Object.prototype.hasOwnProperty.call(payload, 'contentCategory') || payload.contentCategory === NS.ui.contentCategoryOf(asset))
        && payload.statement === String(asset.statement || '')
        && (!Object.prototype.hasOwnProperty.call(payload, 'value') || payload.value === String(asset.value || ''))
        && JSON.stringify(payload.applicableWhen) === JSON.stringify((asset.applicableWhen || []))
        && JSON.stringify(payload.forbiddenWhen) === JSON.stringify((asset.forbiddenWhen || []))
        && !visibilityChanged;
      const exitEdit = () => {
        const drafts = Object.assign({}, store.assetEditDrafts || {});
        delete drafts[String(assetId)];
        store.assetEditDrafts = drafts;
        router.go({ name: 'overview', assetId, assetEdit: '' }, { replace: true });
      };
      if (unchanged) {
        toast(T('cognition.asset_edit_unchanged', '内容没有变化，未保存'));
        exitEdit();
        return;
      }
      // 编辑基准属于草稿，不能拿广播刷新后的资产版本替代。
      const retainFailure = (message, conflict = false) => {
        store.assetEditDrafts = { ...(store.assetEditDrafts || {}), [String(assetId)]: {
          ...editDraft, ...(Object.prototype.hasOwnProperty.call(payload, 'contentCategory') ? { contentCategory: payload.contentCategory } : {}), title: raw('title'), statement: raw('statement'), applicable: raw('applicable'), forbidden: raw('forbidden'), saveError: message, saveConflict: conflict,
        } };
        toast(message, 'warning');
        NS.notify();
      };
      if (!editDraft.baseVersion || !editDraft.baseActiveVersion) {
        retainFailure(T('cognition.library_edit_baseline_missing', '编辑基准未能读取，草稿已保留。请重新核对当前版本后再保存。'));
        return;
      }
      if (store.assetCapabilities?.versionedUpdate !== true) {
        retainFailure(T('cognition.library_restart_required', '当前后台版本较旧，暂时无法保存修改。请先复制草稿，再完全退出并重新打开 CogSeed。'));
        return;
      }
      const semanticText = (value) => String(value || '').trim().replace(/\s+/g, ' ');
      const semanticConditions = (values) => JSON.stringify([...new Set((values || []).map(semanticText).filter(Boolean))].sort());
      const conditionEdited = (name, field) => semanticText(raw(name)) !== semanticText(originalConditionText(field))
        && semanticConditions(payload[field]) !== semanticConditions(reviewBase?.[field]);
      const reviewedDetails = !!reviewBase && ['statement', 'applicable', 'forbidden'].every(name => card.querySelector(`[data-f="${name}"]`))
        && (semanticText(payload.statement) !== semanticText(reviewBase.statement)
          || conditionEdited('applicable', 'applicableWhen') || conditionEdited('forbidden', 'forbiddenWhen'));
      let result;
      try {
        result = await api.call('recall.assets.update', { assetId, ...payload, ...(reviewedDetails ? { reviewedDetails: true } : {}), expectedVersion: String(editDraft.baseVersion), expectedActiveVersion: String(editDraft.baseActiveVersion), reason: 'user manual edit' });
      } catch (error) {
        const conflict = /version conflict/i.test(String(error?.message || ''));
        retainFailure(conflict ? T('cognition.library_edit_conflict', '内容或在用版本已在其他位置变化，未覆盖现有内容。草稿已保留，请核对最新版本后重试。') : T('cognition.library_edit_save_failed', '保存未完成，草稿已保留，请稍后重试。'), conflict);
        return;
      }
      const version = String((result && result.asset && result.asset.version) || '');
      if (String(result?.asset?.id || '') !== String(assetId) || !version) {
        retainFailure(T('cognition.manual_save_unconfirmed', '内容已提交，暂时无法确认正式保存结果。请打开这条记录核对状态，不必重复提交。'));
        return;
      }
      toast(T('cognition.asset_edit_saved', '已保存为新版本 v{n}', { n: version }));
      store.assetVersions = null;
      exitEdit();
      await NS.reload();
    },
    /** 推荐卡「知道了」：确认已了解系统建议
     *  （暂停/返工），后端清除 recommendedAction 并写 recommendation_cleared
     *  审计。推荐是告知不是强制——确认只清卡，不改变资产状态。 */
    async acknowledgeAssetRecommendation(assetId) {
      requireLibraryAsset(assetId);
      const result = await api.call('recall.assets.update', {
        assetId,
        acknowledgeRecommendation: true,
        reason: 'user acknowledged recommendation',
      });
      if (!result || !result.ok) return;
      toast(T('cognition.asset_recommend_cleared', '已确认，推荐卡已清除'));
      store.assetVersions = null;
      await NS.reload();
    },
    /** 两版合并为新版：把所选版正文接在在用版正文
     *  之后存为新版本（只合并正文，标题/范围取在用版）；合并后可用「编辑」
     *  整理措辞。合成结果与在用版相同则不提交（后端无内容等价检查）。 */
    async mergeAssetVersion(assetId, version) {
      const state = store.assetVersions;
      const asset = requireLibraryAsset(assetId);
      if (!state || state.assetId !== String(assetId) || !asset) return;
      const pick = (v) => (state.versions || []).find((x) => String(x.version) === String(v));
      const activeV = pick(asset.activeVersion || asset.version);
      const targetV = pick(version);
      if (!activeV || !targetV) return;
      const activeText = String((activeV.snapshot && activeV.snapshot.statement) || '').trim();
      const targetText = String((targetV.snapshot && targetV.snapshot.statement) || '').trim();
      if (!targetText || targetText === activeText) {
        toast(T('cognition.asset_version_merge_same', '所选版正文与在用版一致，无需合并'));
        return;
      }
      const ok = await confirmUser(T('cognition.asset_version_merge_confirm',
        '将把 v{n} 的正文接在在用版正文之后，保存为新版本；保存后可用「编辑」整理措辞。确认合并？', { n: String(version) }), true);
      if (!ok) return;
      const merged = `${activeText}\n\n${targetText}`;
      const result = await api.call('recall.assets.update', {
        assetId, statement: merged, reason: `merge versions v${String(asset.activeVersion || asset.version)}+v${String(version)}`,
      });
      toast(T('cognition.asset_edit_saved', '已保存为新版本 v{n}', { n: String((result && result.asset && result.asset.version) || '') }));
      store.assetVersions = null;
      await NS.reload();
    },
    /** 同义资产归并：本条并入目标条目（版本链续接、
     *  本条归档）。破坏性低但影响面大（两条合一），双重确认。 */
    async mergeAssets(sourceAssetId, targetAssetId) {
      const target = requireLibraryAsset(targetAssetId);
      const source = requireLibraryAsset(sourceAssetId);
      if (source.id === target.id || source.type !== target.type) throw new Error(T('cognition.library_action_unavailable', '当前内容状态不允许此操作，请刷新核对后再试。'));
      const ok = await confirmUser(T('cognition.asset_merge_confirm', '将把本条的全部历史版本并入「{title}」，本条归档不再单独显示。确认版本归组？', { title: (target && target.title) || targetAssetId }), true);
      if (!ok) return;
      requireLibraryAsset(sourceAssetId);
      requireLibraryAsset(targetAssetId);
      await api.call('recall.assets.merge', { sourceAssetId, targetAssetId });
      toast(T('cognition.asset_merge_done', '已合并为同一版本组'));
      // 检修剪：target 的版本链缓存必须失效（曾在本次会话打开过它的详情）。
      store.assetVersions = null;
      router.go({ name: 'overview', assetId: targetAssetId });
      await NS.reload();
    },
    /* ── 经验目录管理──────────────────────
     *  四个动作全走经验专属通道（与 recall.assets.* 零调用——隔离边界）；
     *  危险动作（归档/合并）二次确认，归档原因必填（uiPrompt 收集，进台账）。 */
    /** 动作后的统一刷新：列表 force 重拉；仍停在这条详情上时详情也重拉。 */
    async refreshExperience(experienceId) {
      await NS.loadExperiences(true);
      if (experienceId && String(store.route.experienceId || '') === String(experienceId)) {
        await NS.loadExperienceDetail(experienceId, true);
      }
    },
    async experienceStatusToggle(experienceId, action) {
      if (action !== 'pause' && action !== 'resume') return;
      try {
        await api.call('recall.experiences.setStatus', { experienceId, action });
      } catch (error) { throw new Error(experienceActionErrorText(error)); }
      toast(action === 'pause'
        ? T('cognition.experience_paused_toast', '已暂停：新任务的清单不再带入这条经验')
        : T('cognition.experience_resumed_toast', '已恢复：下一轮清单重新带入'));
      await this.refreshExperience(experienceId);
    },
    async experienceSetType(experienceId, type) {
      if (!['lesson', 'workflow', 'gap', 'uncategorized'].includes(String(type || ''))) return;
      try {
        await api.call('recall.experiences.setType', { experienceId, experienceType: type });
      } catch (error) { throw new Error(experienceActionErrorText(error)); }
      toast(T('cognition.experience_type_changed_toast', '已调整为「{type}」', { type: experienceTypeLabel(type) }));
      await this.refreshExperience(experienceId);
    },
    async experienceMerge(sourceExperienceId, targetExperienceId) {
      const target = ((store.experiences && store.experiences.items) || [])
        .find((row) => String(row.id) === String(targetExperienceId));
      // 危险动作二次确认：合并把 source 的来源与证据并入目标、
      // source 转「已并入」不再单独显示——影响的条目名必须出现在确认文案里。
      const ok = await confirmUser(T('cognition.experience_merge_confirm', '将把本条的全部来源与证据并入「{title}」，本条转为「已并入」不再单独显示。确认合并？', { title: (target && target.title) || T('cognition.experience_merge_pick_target', '所选目标') }), true);
      if (!ok) return;
      try {
        await api.call('recall.experiences.merge', { sourceExperienceId, targetExperienceId });
      } catch (error) { throw new Error(experienceActionErrorText(error)); }
      toast(T('cognition.experience_merge_done', '已合并：来源与历史并入目标条目'));
      // 合并后看目标条目（同 mergeAssets 的落点：结果在哪，人就被带到哪）。
      if (String(store.route.experienceId || '') === String(sourceExperienceId)) {
        router.go({ name: 'overview', category: 'experiences', experienceId: targetExperienceId });
      }
      await NS.loadExperiences(true);
      await NS.loadExperienceDetail(targetExperienceId, true);
    },
    async experienceArchive(experienceId) {
      // 归档原因必填：先收原因——这一步本身就是一次显式确认；
      // 再走危险确认，与资产删除的二次确认口径一致。
      const reason = await promptUser(T('cognition.experience_archive_reason_prompt', '填写这条经验过期或失效的清理原因（必填，会记录进台账）'));
      if (reason == null) return; // 取消 = 不动
      if (!String(reason).trim()) {
        toast(T('cognition.experience_archive_reason_required', '清理原因必填：没有原因的归档不会被接受。'), 'warning');
        return;
      }
      const ok = await confirmUser(T('cognition.experience_archive_confirm', '归档后这条经验不再进入任何清单；历史与已冻结的引用仍可读。确认归档？'), true);
      if (!ok) return;
      try {
        await api.call('recall.experiences.archive', { experienceId, reason: String(reason).trim() });
      } catch (error) { throw new Error(experienceActionErrorText(error)); }
      toast(T('cognition.experience_archive_done', '已归档：已记录原因与时间'));
      // 归档后回列表（详情对象已终态，继续停在详情没有管理出口）。
      if (String(store.route.experienceId || '') === String(experienceId)) {
        router.go({ name: 'overview', category: 'experiences', experienceId: '' }, { replace: true });
      }
      await this.refreshExperience(experienceId);
    },
    /* ── 存量迁移────────────────────────── */
    async experienceMigrationPreview() {
      await NS.loadExperienceMigrationPreview(true);
    },
    async experienceMigrationRun(assetIds) {
      // 判重（对齐 legacyMemoryMigrationRun 先例）：迁移执行中的写入广播会
      // drain 重画换 DOM，按钮的 pending 保护失效后可再次点击启动双跑——
      // running 必须放 store（局部变量在换 DOM 后作废），视图侧据此 disabled。
      const state = store.experienceMigration;
      if (state && state.running) return;
      const ids = [...new Set((assetIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!ids.length) return;
      const ok = await confirmUser(T('cognition.experience_migration_run_confirm', '将迁移以上 {n} 条经验类资产：先冻结历史引用，再写入经验目录并从资产库迁出；跳过与失败会如实列出。确认执行？', { n: String(ids.length) }), true);
      if (!ok) return;
      store.experienceMigration = { ...store.experienceMigration, running: true };
      NS.notify();
      let result;
      try {
        result = await api.call('recall.experiences.migration.run', { assetIds: ids });
      } catch (error) {
        // 失败显式复位 running（成功路径下方整体重建对象天然复位）：
        // 否则迁移失败一次后这个入口永久锁死。
        store.experienceMigration = { ...store.experienceMigration, running: false };
        NS.notify();
        throw new Error(experienceActionErrorText(error));
      }
      const migrated = (result && result.migrated) || 0;
      const skipped = (result && result.skipped) || 0;
      const failed = (result && result.failed) || 0;
      // 结果走 uiAlert 可核对，
      // 随后重拉预览与列表——预览清单必须反映迁出后的真实存量。
      await alertUser(T('cognition.experience_migration_result', '迁移完成：已迁 {migrated} 条，跳过 {skipped} 条，失败 {failed} 条', { migrated: String(migrated), skipped: String(skipped), failed: String(failed) }));
      // 结果同时摆进折叠区（lastRun 可核对），并重拉预览与列表——预览清单
      // 必须反映迁出后的真实存量。
      store.experienceMigration = { preview: null, previewLoading: false, previewFailed: false, lastRun: result || null };
      NS.notify();
      await NS.loadExperiences(true);
      void NS.loadExperienceMigrationPreview(true);
      return result;
    },
    async experienceMigrationStatus() {
      await NS.loadExperienceMigrationStatus();
      const lastRun = store.experienceMigration && store.experienceMigration.lastRun;
      if (!lastRun) {
        toast(T('cognition.experience_migration_none_run', '还没有执行过迁移'), 'warning');
        return;
      }
      const migrated = lastRun.migrated || 0;
      const skipped = lastRun.skipped || 0;
      const failed = lastRun.failed || 0;
      toast(T('cognition.experience_migration_last_run', '上次迁移：已迁 {migrated} 条，跳过 {skipped} 条，失败 {failed} 条', { migrated: String(migrated), skipped: String(skipped), failed: String(failed) }));
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
    async recheckCandidateFormation(candidateId) {
      const candidate = store.candidates.find(item => String(item.id) === String(candidateId));
      if (!candidate?.ontologyFormation || !NS.candidate?.attentionReady(candidate)) return;
      const states = store.formationRechecks || (store.formationRechecks = {});
      if (states[candidateId]?.running) return;
      const state = states[candidateId] = { running: true, error: '', completed: false };
      NS.notify();
      try {
        const result = await api.call('recall.candidates.recheckOntologyFormation', { candidateId });
        if (result?.candidate?.id !== candidateId || result.candidate.ontologyFormation?.schemaVersion !== 1)
          throw new Error(T('cognition.formation_recheck_failed', '重新核对未完成。原建议和已保存修改仍保留，可重试。'));
        const index = store.candidates.findIndex(item => String(item.id) === String(candidateId));
        if (index >= 0) store.candidates[index] = result.candidate;
        state.completed = true;
        if (store.activityHistory?.[candidateId]) store.activityHistory[candidateId].loaded = false;
      } catch (error) {
        state.error = T('cognition.formation_recheck_failed', '重新核对未完成。原建议和已保存修改仍保留，可重试。');
      } finally { state.running = false; NS.notify(); }
    },
    async resolveInbox(id, action, extra = {}) {
      const result = await api.call('cognition.inbox.resolve', { id, action, ...extra });
      await loadBlocks(['inbox', 'assets', 'candidates'], true);
      return result;
    },
    async updateCaptureSettings(patch, options = {}) {
      const result = await api.call('recall.captures.settings.update', patch);
      if (typeof patch.autoApproval === 'boolean' && result?.settings?.autoApproval !== patch.autoApproval) {
        throw new Error(T('cognition.settings_auto_save_unconfirmed', '未收到自动批准设置的有效保存结果，请刷新页面核对。'));
      }
      if (Array.isArray(patch.modelCandidates) && JSON.stringify(result?.settings?.modelCandidates) !== JSON.stringify(patch.modelCandidates)) {
        throw new Error(T('cognition.settings_nightly_model_save_error', '未能保存模型列表，请重试。'));
      }
      store.captureSettings = (result && result.settings) || store.captureSettings;
      if (!options?.silent) toast(T('common.saved', '已保存'));
      await NS.reload();
    },
    async stopNightlyScan() { await api.call('recall.captures.sweep.stop', {}); await NS.reload(); },
    async runNightlyScanNow() {
      await api.call('recall.captures.sweep.run', {});
    },
  };
  NS.actions = actions;

  /** 旧全局入口兼容（boot.js 的深链调用它）。 */
  /** 从会话消息的 [asset:<id>] 引用卡跳转到认知资产详情页。
   *  conversation.js 调用；不依赖调用方已在认知资产页。
   *  （旧定义在 skills-bindings.js，其词法依赖随 skills.js 瘦身删除，迁到这里。） */
  window.openCognitionAssetById = function openCognitionAssetById(assetId) {
    if (!assetId) return false;
    showRecallPanel();
    router.go({ name: 'overview', category: '', assetId: String(assetId) });
    NS.library?.revealAsset(String(assetId));
    // 面板可能早已开在内存里（对话侧写入无广播直达这里）：跳转时重拉一次，
    // 防止详情按陈旧 store 判成「已不在待处理列表」的假空态。
    void NS.reload().then(() => {
      if (store.route.name === 'overview' && store.route.assetId === String(assetId)) NS.library?.revealAsset(String(assetId));
    });
    return true;
  };

  /** 从会话消息里的 [candidate:<id>] 按钮跳转到对应的待审核候选。 */
  window.openCognitionCandidateById = function openCognitionCandidateById(candidateId) {
    if (!candidateId) return false;
    showRecallPanel();
    router.go({ name: 'activity', candidateId: String(candidateId) });
    // 同上：对话里刚保存的候选不在陈旧 store 里，必须重取后才找得到。
    void NS.reload();
    return true;
  };

  window.openCognitionApprovalById = function openCognitionApprovalById(proposalId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(proposalId || '')) return false;
    showRecallPanel();
    NS.activityController?.openLinkedDetail();
    router.go({ name: 'activity', approvalId: String(proposalId) });
    void NS.reload();
    return true;
  };

  /** 会话头部的认知衔接行落点：原「待我处理」页已
   *  下线，统一去向＝「认知生长」需要关注（本会话的候选就在那排队）。
   *  conversation-info.js 调用；不依赖调用方已在认知资产页。 */
  window.openCognitionReview = function openCognitionReview() {
    showRecallPanel();
    router.go({ name: 'activity', candidateId: '' });
    // 同 openCognitionCandidateById：对话侧写入无广播直达这里，跳转后重拉。
    void NS.reload();
    return true;
  };

  /** 最终答复中的本体依据打开确切记录版本；读取失败由正式工作台显示。 */
  window.openCognitionOntologyRecord = function openCognitionOntologyRecord(moduleId, recordId, recordVersion) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(moduleId || '') || !/^[A-Za-z0-9_-]{1,160}$/.test(recordId || '')
      || !Number.isInteger(recordVersion) || recordVersion < 1 || recordVersion > 999999999) return false;
    showRecallPanel();
    NS.openPersonalOntology({ moduleId, recordId, recordVersion });
    void NS.reload();
    return true;
  };

  /* ────────────────────────── 本体工作台挂载 ────────────────────────── */
  /* 当前路由在 cognition-assets 的 #ca-ontology-mount 内加载 cognition-ontology；
   * 旧深链 setView('personal-ontology') 在 boot.js 归一化后进入同一路由。 */

  function showRecallPanel() {
    try {
      if (typeof window._setViewFromSidebar === 'function') window._setViewFromSidebar('recall');
      else document.getElementById('recall-btn')?.click();
    } catch (_) { /* 面板切换失败也要完成路由 */ }
  }

  /** 整理记录行 → 打开来源会话：与「继续工作」「运行中心」同一条全局通道
   *  （setView('conversation', cid)），失败提示而不静默吞掉。 */
  NS.openConversation = function openConversation(conversationId) {
    const cid = String(conversationId || '').trim();
    if (!cid) return false;
    if (typeof window.setView === 'function') {
      window.setView('conversation', cid);
      return true;
    }
    toast(T('cognition.capture_open_conversation_unavailable', '当前页面无法直接打开会话，请从对话列表进入'), 'warning');
    return false;
  };

  /* ───────────── 本体工作台路由挂载 ───────────── */
  /* 本体是认知资产顶级入口下的完整工作台。此处只负责加载并挂载，不复用旧图谱
   * 写接口。旧数据以有来源的只读投影出现，整理通过共同候选入口提交。 */

  NS.unmountPersonalOntology = function unmountPersonalOntology() {
    if (typeof window.unmountCognitionOntology === 'function') window.unmountCognitionOntology();
  };

  NS.mountPersonalOntology = async function mountPersonalOntology(options = {}) {
    showRecallPanel();
    const mount = document.getElementById('ca-ontology-mount');
    if (!mount) return;
    const load = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof window.mountCognitionOntology !== 'function' && typeof load === 'function') {
      try { await load('cognition-ontology'); } catch (_) { /* visible error is rendered below */ }
    }
    if (typeof window.mountCognitionOntology === 'function') {
      await window.mountCognitionOntology(mount, options);
      return;
    }
    mount.innerHTML = `<main class="ontology-workspace"><div class="ontology-ws-error" role="alert"><h1>${T('ontologyWorkspace.loadFailed', '本体暂时无法加载')}</h1><p>${T('ontologyWorkspace.loadBundleFailed', '本体工作台加载失败，请重试。')}</p>${typeof window.uiButton === 'function' ? window.uiButton({ label: T('ontologyWorkspace.retry', '重试'), role: 'primary', attrs: { id: 'ontology-workspace-retry' } }) : ''}</div></main>`;
    const retry = mount.querySelector('#ontology-workspace-retry');
    if (retry) retry.addEventListener('click', () => { void NS.mountPersonalOntology(options); });
  };

  NS.openPersonalOntology = function openPersonalOntology(options = {}) {
    NS.router.go({ name: 'ontology',
      ...(options.candidateId ? { candidateId: String(options.candidateId) } : {}),
      ...(options.moduleId ? { moduleId: String(options.moduleId) } : {}),
      ...(options.recordId ? { recordId: String(options.recordId) } : {}),
      ...(options.recordVersion ? { recordVersion: Number(options.recordVersion) } : {}),
    });
  };

})();
