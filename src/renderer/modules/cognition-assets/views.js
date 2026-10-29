/* ============================================================================
 * 认知资产 · 视图层（cognition-assets/views.js）
 *
 * 纯函数式渲染：每个视图接收 (store, route) 产出 HTML 字符串；
 * 事件全部靠 data-go（导航）与 data-act（动作）交给 app.js 的委托层。
 * 视图之间不互相调用，共享零件只有本文件顶部的 build* 系列。
 * ========================================================================== */
(function () {
  'use strict';

  const NS = window.CogAssets;
  if (!NS) return;
  const { T, esc, fmtDate } = NS;
  const S = NS.store;

  /* ────────────────────────── 共享零件 ────────────────────────── */

  /* 按钮一律走共享 uiButton 工厂（shared-ui-adoption-guard 约束：本模块不落
   * 裸控件）。认知资产页面的 primary 用浅品牌底色+描边，secondary 用白底描边；
   * danger 保留危险色，className:'o' 用于白底低强调动作。 */
  const btn = (label, act, options) => {
    const opts = options || {};
    /* chip / rnm 自带皮肤，不叠加默认浅绿底，避免 .btn.g 的特异性覆盖选中态。 */
    const ownSkin = /(^|\s)(chip|rnm|backlink)(\s|$)/.test(opts.className || '');
    const variant = opts.danger ? 'd' : opts.primary ? '' : ownSkin ? '' : 'g';
    const classes = ['btn', variant, opts.small ? 'sm' : '', opts.className || ''].filter(Boolean).join(' ');
    // opts.data 的键统一补 data- 前缀：uiButton 的 attrs 白名单只放行
    // id/role/title/aria-*/data-*，裸键（action/batch/kind…）会被静默丢弃——
    // 前端重建起这里的行内动作属性一直没渲染出来，委托层读到
    // 的 dataset.action 恒为 undefined。
    const dataAttrs = Object.assign(
      {},
      ...Object.entries(opts.data || {}).map(([key, value]) => ({ [`data-${key}`]: value })),
    );
    return window.uiButton({
      label,
      className: classes,
      role: opts.danger ? 'danger' : opts.primary ? 'primary' : 'secondary',
      size: opts.small ? 'sm' : 'md',
      ...(opts.icon ? { icon: opts.icon } : {}),
      ...(opts.disabled ? { disabled: true } : {}),
      attrs: Object.assign(
        {},
        act ? { 'data-act': act } : {},
        opts.id != null ? { 'data-id': String(opts.id) } : {},
        dataAttrs,
        opts.title ? { title: opts.title } : {},
        opts.attrs || {},
      ),
    });
  };

  /** 行内可选块（chip 单选、tab、折叠头等富内容控件）：不用裸 button，
   *  用 div[role=button]——键盘 Enter/Space 由 app.js 委托层统一触发，
   *  与资产列表行（data-go-asset）同一交互契约。 */
  const roleBtn = (extra = '') => `role="button" tabindex="0"${extra ? ` ${extra}` : ''}`;

  /* 状态/来源章：原型 .tag（小圆角色块）。'line' 是「中性信息」档，落到
   * 原型最弱的 .tag.gray——它比绿色章弱一档，不会跟状态章抢注意力。 */
  const TAG_TONE = { green: 'green', amber: 'amber', red: 'red', blue: 'blue', line: 'gray' };
  const chip = (label, tone) => `<span class="tag ${TAG_TONE[tone] || 'gray'}">${esc(label)}</span>`;

  const stat = (value, label, tone) => `<div class="stat"><div class="v${tone ? ` ${tone}` : ''}">${esc(String(value))}</div><div class="l">${esc(label)}</div></div>`;
  const statsRow = (items) => `<div class="stats">${items.map(([v, l, tone]) => stat(v, l, tone)).join('')}</div>`;

  /* 页头：原型把统计卡与「当前任务选用」卡都收进 .hero（不是页头右侧的小块）。 */
  const hero = (title, hint, inner) => `
    <div class="hero">
      <h1>${esc(title)}</h1>
      ${hint ? `<div class="sub">${esc(hint)}</div>` : ''}
      ${inner || ''}
    </div>`;

  /* 页头 + 右侧操作（原型整理页：标题、说明、右侧「沉淀设置」入口）。 */
  const heroRow = (title, hint, right) => `
    <div class="hero hero-row">
      <div class="hero-main">
        <h1>${esc(title)}</h1>
        ${hint ? `<div class="sub">${esc(hint)}</div>` : ''}
      </div>
      ${right || ''}
    </div>`;

  /** 共享图标（icons.js）取用：缺席时用等义字符兜底（icons.js 由全局
   *  加载，认知资产模块晚于它；防御性兜底保证任何加载顺序下可用）。 */
  const uiIcon = (name, className, fallback) => (typeof window.uiIconHtml === 'function'
    ? window.uiIconHtml(name, className)
    : fallback);

  const empty = (title, hint, action) => {
    if (typeof window.uiEmptyState !== 'function') throw new Error('cognition assets require uiEmptyState');
    return window.uiEmptyState({
      kind: action ? 'actionable' : hint ? 'explained' : 'quiet',
      title,
      ...(hint ? { hint, icon: 'circle' } : {}),
      ...(action ? { action } : {}),
    });
  };

  /* 小节标题：原型 .sect = 标题 + 计数 + 撑开的细线 + 右侧操作。 */
  const sectionHead = (title, note, right) => `
    <div class="sect"><strong class="sect-t">${esc(title)}</strong>${note ? `<span class="n">${esc(note)}</span>` : ''}<span class="sp"></span>${right || ''}</div>`;

  /* ────────────── 人话术语表 + 三层披露共享件──────────────
   * 病根之二：界面词是工程词（候选/作用边界/回执），用户没有这些概念。
   * 术语表在展示层统一翻译，数据层口径一个不动；钉死口径（「模型确认采用」
   * 「被任务用过」「保留期 30 天」）只加脚注、不改写。TERM_TABLE 形态 = [词条键,
   * 界面词, 脚注键, 脚注]，相邻字符串字面量让 i18n 覆盖扫描（literalPattern）
   * 扫得到，四语缺一门即红。 */
  const TERM_TABLE = {
    candidate: ['cognition.term_candidate', '系统注意到的一件事', 'cognition.term_candidate_note', '等你点头才记入你的认知'],
    kstar: ['cognition.term_kstar', '那次任务的复盘', 'cognition.term_kstar_note', '任务收口后系统总结的得失'],
    boundary: ['cognition.term_boundary', '什么时候用、什么时候别用', 'cognition.term_boundary_note', '没写适用范围的规矩不会被自动带入任务'],
    receipt: ['cognition.term_receipt', '使用记录', 'cognition.term_receipt_note', '模型确认采用才算用过；只被带入不算'],
    family: ['cognition.term_family', '同一来源的一组', '', ''],
    projection: ['cognition.term_projection', '带进对话的内容', '', ''],
    inspection: ['cognition.term_inspection', '定期检查', 'cognition.term_inspection_note', '只报告问题，不修改资产；发现项进入「待我处理」'],
  };
  const term = (id) => {
    const row = TERM_TABLE[id];
    return row ? T(row[0], row[1]) : '';
  };
  const termNote = (id) => {
    const row = TERM_TABLE[id];
    return row && row[2] ? T(row[2], row[3]) : '';
  };
  /** 首次出现脚注：一行 note（分号连接），没有脚注的术语自动跳过。 */
  const termFootnote = (ids) => {
    const notes = (ids || []).map(termNote).filter(Boolean);
    return notes.length ? `<p class="note term-footnote">${esc(notes.join('；'))}</p>` : '';
  };

  /** 折叠区统一用法：技术细节与低频记录默认收起，内容不丢。 */
  const foldBlock = (title, count, hint, body, cls) => `<details class="details fold${cls ? ` ${cls}` : ''}"><summary>${esc(title)}${count != null ? `<span class="n">${esc(String(count))}</span>` : ''}${hint ? `<span class="note">${esc(hint)}</span>` : ''}</summary><div class="dbody">${body}</div></details>`;

  /** 「其他处理」折叠：主按钮留给推荐动作，其余动作收这里。 */
  const otherActions = (buttonsHtml) => (buttonsHtml
    ? `<details class="details ca-other-actions"><summary>${esc(T('cognition.other_actions', '其他处理'))}</summary><div class="dbody"><div class="actions actions-right">${buttonsHtml}</div></div></details>`
    : '');

  const CATEGORIES = [
    ['personal', 'cognition.asset_category_personal', '个人信息'],
    ['rule', 'cognition.asset_category_rule', '规则与偏好'],
    ['template', 'cognition.asset_category_template', '模板与范例'],
    ['skill_method', 'cognition.asset_category_skill_method', '技能与方法'],
    // 原型 v7 第四类:事实与知识(项目/环境/领域/工具链的稳定事实)。
    ['fact', 'cognition.asset_category_fact', '事实与知识'],
  ];
  const categoryLabel = (type) => {
    const hit = CATEGORIES.find(([id]) => id === type);
    return hit ? T(hit[1], hit[2]) : T('cognition.asset_category_other', '其他');
  };

  // 内容分类仅用于查找与展示；不改变资产类型、准入或使用权限。
  const CONTENT_CATEGORIES = [
    ['rule', 'cognition.content_category_rule', '规则'],
    ['preference', 'cognition.content_category_preference', '偏好'],
    ['template', 'cognition.content_category_template', '模板'],
    ['method', 'cognition.content_category_method', '方法'],
    ['lesson', 'cognition.content_category_lesson', '经验教训'],
    ['unclassified', 'cognition.content_category_unclassified', '待分类'],
  ];
  const contentCategoryOf = (item) => {
    if (CONTENT_CATEGORIES.some(([id]) => id === item?.contentCategory)) return item.contentCategory;
    // 旧抽象分类也只能按明确旧类型兼容读取，不生成新的抽象分类。
    if (item?.contentCategory != null && !['understanding', 'experience_method', 'fact'].includes(item.contentCategory)) return 'unclassified';
    const legacyType = item?.type || item?.suggestedType;
    if (legacyType === 'rule') {
      // 仅识别历史规则中明确命名的偏好/习惯；新 cognition 不参与标题推断。
      const title = String(item?.title || item?.summary || '').trim();
      return /^(?:偏好|习惯|preferences?\b|habits?\b)|(?:偏好|习惯|\bpreferences?|\bhabits?)$/i.test(title) ? 'preference' : 'rule';
    }
    return legacyType === 'template' ? 'template' : legacyType === 'skill_method' ? 'method' : 'unclassified';
  };
  const contentCategoryLabel = item => {
    const [, key, fallback] = CONTENT_CATEGORIES.find(([id]) => id === contentCategoryOf(item));
    return T(key, fallback);
  };
  const contentCategorySelect = (id, item, value) => window.uiSelect({
    id, native: true, ariaLabel: T('cognition.content_category', '分类'),
    value: value == null ? contentCategoryOf(item) : value,
    options: CONTENT_CATEGORIES.map(([value, key, fallback]) => ({ value, label: T(key, fallback) })),
    attrs: { 'data-f': 'contentCategory' },
  });

  // 状态章：active 从「已确认」改为「生效中」——与出身章
  // 「模型记的」并置时旧词读起来像"被确认过"，实际语义只是"当前在用"。
  // 顺带走 T() 补四语（此前硬编码中文，四语界面也显示中文）。
  const ASSET_STATUS = {
    active: [() => T('cognition.asset_status.active', '生效中'), 'green'],
    paused: [() => T('cognition.asset_status.paused', '已暂停'), 'amber'],
    archived: [() => T('cognition.asset_status.archived', '已归档'), ''],
    deleted: [() => T('cognition.asset_status.deleted', '已删除'), 'red'],
    purged: [() => T('cognition.asset_status.purged', '已清除'), 'red'],
    revoked: [() => T('cognition.asset_status.revoked', '已撤回'), 'red'],
  };
  const assetStatusChip = (asset) => {
    const entry = ASSET_STATUS[String(asset.status || '')];
    const [label, tone] = entry ? [entry[0](), entry[1]] : [T('cognition.asset_status_unknown', '状态未知'), ''];
    // 成功加载不等于效果得到验证，两种证据分别展示。
    const maturity = asset.maturity === 'effectiveness_validated'
      ? chip(T('cognition.maturity_effectiveness', '效果已验证'), 'green')
      : asset.maturity === 'transfer_validated'
        ? chip(T('cognition.maturity_loaded', '已跨任务加载'), '')
        : '';
    return chip(label, tone) + maturity;
  };
  // originChip（出身章「模型记的/系统沉淀」）已随出身收敛退役：
  // 模型记下来的=已确定，出身不再是显示维度；详情页转正按钮同批移除。
  /** 来源目录索引：证据解析与"多数不可用"判断共用这一份。 */
  function sourceIndex() {
    const index = new Map();
    for (const group of S.sources) {
      for (const item of (Array.isArray(group.items) ? group.items : [])) {
        if (item && item.id) index.set(String(item.id), item);
      }
    }
    return index;
  }

  /* ────────── 来源解析：唯一解析器 + 唯一呈现出口──────────
   * 修复前：候选与版本证据走 evidenceChip，资产详情的证据引用块却绕过它直接
   * esc(refId) 上屏，内部 id（immediate-* / kse-* / turn-*）就这么露给用户；
   * 来源异常行还有 `title || id` 的裸 id 兜底。现在解析规则收敛成
   * resolveSourceRef 一份、呈现收敛成 evidenceChip 一份，五处（候选 / 资产 /
   * 版本 / 使用记录 / KSTAR）共用 → 同一来源必然同名。
   * 铁律：任何状态下都不得把 rawId 当显示名。
   * 状态语义（诚实优先，且对"查无"一律 fail-closed）：
   *   available    解析出可读名（会话标题 / 复盘目标 / 文件名；含"存在但未起名"
   *                的会话，此时 name 为空由呈现层给泛称）
   *   immediate    对话中当场记（合成 id，本就没有独立出处）
   *   processing   来源整理中（目录里有，标题还没生成）
   *   unavailable  查无此来源（已删 / 无处核对 / 类型可辨但无从核对）
   *                →「来源记录不可用」，绝不回落裸 id */
  function resolveSourceRef(ref) {
    const raw = (ref && typeof ref === 'object') ? ref : {};
    const rawId = String(raw.id || raw.conversationId || raw.ref || '').trim();
    const kind = String(raw.kind || '').trim();
    const view = { kind, rawId, name: '', state: 'unavailable', openRoute: 'none', openTarget: '' };
    const asConversation = () => {
      if (!rawId || rawId.startsWith('immediate-')) return;
      view.openRoute = 'conversation';
      view.openTarget = raw.locator?.conversationId || rawId;
    };
    const inlineTitle = String(raw.title || raw.conversationTitle || raw.name || '').trim();
    const catalogItem = rawId ? sourceIndex().get(rawId) : null;
    if (raw.degraded === true || catalogItem && (['paused', 'removed'].includes(catalogItem.availability) || ['paused', 'removed', 'deleted', 'revoked'].includes(catalogItem.status))) return view;
    // KSTAR 复盘优先于来源自带 title：ref 上那个 title 是写入时的机器串
    // （"KSTAR requirement episode"），用户要看的是这次任务的目标摘要。
    // degraded（写入时就解析不到）或已结算仍无摘要 = 确实没有这条，如实说不可用
    // 且不给可点假入口；"还没拉到"不在此列（读不到 ≠ 不存在）——维持可点与泛称。
    if (rawId.startsWith('kse-')) {
      const settled = (S.kstarSummariesSettled || []).includes(rawId);
      const summary = (S.kstarSummaries && S.kstarSummaries[rawId]) || null;
      if (raw.degraded || (settled && !summary)) return view;
      view.state = 'available';
      view.name = summary && summary.goal ? String(summary.goal).slice(0, 24) : '';
      view.openRoute = 'kstar';
      view.openTarget = rawId;
      return view;
    }
    // 写入时已带可读标题的来源（数据层已解析过）。
    if (inlineTitle) {
      view.name = inlineTitle;
      view.state = 'available';
      if (kind === 'conversation') asConversation();
      return view;
    }
    if (!rawId) return view;
    // 「对话中当场记」：合成 id，没有独立出处——不是被删，诚实标注。
    if (rawId.startsWith('immediate-')) { view.state = 'immediate'; return view; }
    const item = sourceIndex().get(rawId);
    if (item) {
      const itemTitle = String(item.title || '').trim();
      if (itemTitle) {
        view.name = itemTitle;
        view.state = 'available';
        // 目录项自带 kind 时以它为准（ref 上的 kind 可能是遗留词）。刻意先取
        // 独立变量再比较，不写成内联短路取值：cognition-chain-view 的源码守护
        // 按裸源码扫描（连注释一起），那种形状会被判成"机器码可能漏进展示文案"。
        const itemKind = String((item && item.kind) || '');
        if (kind === 'conversation' || itemKind === 'conversation') asConversation();
        return view;
      }
      if (['pending', 'processing'].includes(String(item.status || ''))) { view.state = 'processing'; return view; }
    }
    if (kind === 'conversation') {
      // 批量标题口（conversations.titles）补目录 100 条窗口外的会话；命中即有名。
      const titles = S.conversationTitles || {};
      if (Object.prototype.hasOwnProperty.call(titles, rawId)) {
        view.name = String(titles[rawId] || '').trim();
        view.state = 'available';
        asConversation();
        return view;
      }
      // 目录与标题口都查无 → 来源确实失效。**fail-closed，不软化**：宁可如实说
      // 「来源记录不可用」，也不给一个听起来正常却无从核对的泛称（既有契约，
      // 由 test/renderer/recall-source-display.test.ts 守住）。
      return view;
    }
    // 其余 kind 拿不到名字（如 turn-* 执行记录）：同样按不可用呈现——存在但
    // 无从核对，与"已删除"给用户的信息量一样，都不该退化成裸 id。
    return view;
  }

  // 来源三态：available=目录命中/整理中；
  // immediate=对话中当场记（无独立会话出处——不是被删，诚实标注不计弱证据）；
  // unavailable=查无（引用的会话已不存在或无处核对）。
  // 起判据统一由 resolveSourceRef 给出，本函数只做三态收敛——
  // 「待我处理」的断链口径与修复前完全一致（available/processing 算在，其余算
  // 不可用），不随呈现层一起漂。
  function sourceRefKind(ref) {
    const view = resolveSourceRef(ref);
    if (view.state === 'immediate') return 'immediate';
    return (view.state === 'available' || view.state === 'processing') ? 'available' : 'unavailable';
  }
  function sourceRefUnavailable(ref) {
    return sourceRefKind(ref) === 'unavailable';
  }
  /** 证据条目的**唯一**呈现出口：每类带类型前缀，
   *  一律经 resolveSourceRef，任何分支都不上屏裸 id。
   *  可解析的来源给回看入口（会话跳转 / 复盘展开），其余只显名。
   *  详情重构：拆成 text+html 两半——详情页来历区要做同文去重
   *  与"不可用"聚合（同句 chip 连排两枚=噪音），其他调用方仍拿单个 html。 */
  const evidenceChipParts = (ref) => {
    const view = resolveSourceRef(ref);
    const linked = (cls, attrs, label) => ({ text: label, html: `<span class="tag ${cls} chip-link"${attrs} ${roleBtn()}>${esc(label)}</span>` });
    if (view.state === 'immediate') return { text: T('cognition.evidence_immediate_note', '对话中当场记（无独立会话出处）'), html: chip(T('cognition.evidence_immediate_note', '对话中当场记（无独立会话出处）'), 'line') };
    if (view.state === 'unavailable') return { text: T('cognition.source_unavailable_label', '来源记录不可用'), html: chip(T('cognition.source_unavailable_label', '来源记录不可用'), 'line') };
    if (view.state === 'processing') return { text: T('cognition.evidence_source_processing', '来源整理中'), html: chip(T('cognition.evidence_source_processing', '来源整理中'), 'line') };
    if (view.openRoute === 'kstar') {
      const label = T('cognition.evidence_task_review', '任务复盘：{title}', {
        title: view.name || T('cognition.evidence_task_review_generic', '一次任务'),
      });
      return linked('blue', ` data-act="open-kstar-episode" data-id="${esc(view.rawId)}" title="${esc(T('cognition.kstar_episode_open_hint', '查看这次任务的复盘'))}"`, label);
    }
    if (view.kind === 'user_teaching_signal') return { text: T('cognition.evidence_teaching', '你的一次明确表态'), html: chip(T('cognition.evidence_teaching', '你的一次明确表态'), 'line') };
    if (view.kind === 'conversation') {
      if (String((ref && ref.subtype) || '') === 'message') return { text: T('cognition.evidence_message', '对话里的一条消息'), html: chip(T('cognition.evidence_message', '对话里的一条消息'), 'line') };
      const label = view.name
        ? T('cognition.evidence_conversation_named', '对话：《{name}》', { name: view.name })
        : T('cognition.evidence_conversation_generic', '一段对话');
      // 可解析到会话就给回看入口：点回原对话核对证据。
      if (view.openRoute === 'conversation' && view.openTarget) {
        return linked('gray', ` data-act="open-conversation" data-id="${esc(view.openTarget)}" title="${esc(T('cognition.evidence_conversation_open_hint', '回到这段对话'))}"`, label);
      }
      return { text: label, html: chip(label, 'line') };
    }
    if (view.name) return { text: view.name, html: chip(view.name, 'line') };
    // 类型可辨但拿不到名字（如 turn-* 执行记录）：给中性泛称，不编造名字、
    // 也不回落裸 id。
    return { text: T('cognition.evidence_fallback', '来源记录'), html: chip(T('cognition.evidence_fallback', '来源记录'), 'line') };
  };
  const evidenceChip = (ref) => evidenceChipParts(ref).html;
  const isKstarEvidenceRef = (ref) => String(ref.kind || '') === 'execution' && String(ref.id || '').startsWith('kse-');
  /** 血统判据只认"还活着"的证据：被标 degraded 的复盘
   *  证据（写入时解析不到对应记录）不算 KSTAR 血统——查无的引用不能当出身。
   *  分组展示仍按形状走 isKstarEvidenceRef：一条脏证据也要显示在它该在的
   *  组里，只是标明不可用。 */
  const isLiveKstarEvidenceRef = (ref) => isKstarEvidenceRef(ref) && ref.degraded !== true;
  /** 归边判定：纯渲染层口径，不动主进程——身上挂有
   *  KSTAR 任务复盘证据（kind=execution 且 id 前缀 kse-），或带 KSTAR 学习
   *  信号/溯源（learningSignal.source=review|preference_scan、
   *  learningProvenance）即归 KSTAR 线。reason=review_decision 不能用作
   *  判据：对话线候选确认的版本也写这个前缀（两线共用确认队列）。
   *  挂 NS 供列表过滤与测试共用。 */
  NS.isKstarAsset = function isKstarAsset(asset) {
    if (!asset) return false;
    if (asset.learningProvenance) return true;
    const signal = asset.learningSignal;
    if (signal && ['review', 'preference_scan'].includes(String(signal.source || ''))) return true;
    return (asset.evidenceRefs || []).some(isLiveKstarEvidenceRef);
  };
  NS.isKstarCandidate = function isKstarCandidate(candidate) {
    if (!candidate) return false;
    if (candidate.learningSignal || candidate.learningProvenance) return true;
    return (candidate.sourceRefs || []).some((ref) => String(ref.id || '').startsWith('kse-') && ref.degraded !== true);
  };
  /** 证据分组：KSTAR 任务复盘一组、对话与表态
   *  一组，各带一句来源说明——两线证据混排一排正是"杂揉"观感的来源。
   *  详情重构：组内同文 chip 去重（同一来源被引用两次只出一枚，
   *  ×N 计数）；"来源记录不可用"这类无信息量芯片聚合为一枚摘要——原始
   *  引用清单仍在版本数据里，界面上不再逐枚刷灰。 */
  const evidenceGroupsHtml = (refs) => {
    const kstar = refs.filter(isKstarEvidenceRef);
    const chat = refs.filter((ref) => !isKstarEvidenceRef(ref) && !/^ontimport-[a-f0-9]{64}$/.test(ref.id || ''));
    const group = (titleKey, title, hintKey, hint, list) => {
      if (!list.length) return '';
      const UNAVAILABLE_TEXT = T('cognition.source_unavailable_label', '来源记录不可用');
      const byText = new Map();
      let unavailable = 0;
      for (const ref of list) {
        const parts = evidenceChipParts(ref);
        if (parts.text === UNAVAILABLE_TEXT) { unavailable += 1; continue; }
        const hit = byText.get(parts.text);
        if (hit) hit.count += 1;
        else byText.set(parts.text, { ...parts, count: 1 });
      }
      const chips = [...byText.values()].map((entry) => entry.count > 1
        ? entry.html.replace(/<\/span>$/, ` <b class="evdup">×${entry.count}</b></span>`)
        : entry.html);
      if (unavailable) {
        const label = unavailable > 1
          ? `${UNAVAILABLE_TEXT} ×${unavailable}`
          : UNAVAILABLE_TEXT;
        chips.push(chip(label, 'line'));
      }
      return `<div class="evgroup">
          <div class="evgroup-title">${esc(T(titleKey, title))}<span class="note">${esc(T(hintKey, hint))}</span></div>
          <div class="chips">${chips.join('')}</div>
        </div>`;
    };
    return group('cognition.evidence_group_kstar', '任务复盘', 'cognition.evidence_group_kstar_hint', '任务完结后系统复盘学到的', kstar)
      + group('cognition.evidence_group_chat', '对话与你的表态', 'cognition.evidence_group_chat_hint', '日常对话里总结出来的', chat);
  };

  /** 原始记录清洗：实际产出里会有 markdown 记号（**、##、代码
   *  块），原样展示是一坨看不懂的技术文本——去记号、折叠代码块、压空白。 */
  function stripMarkdown(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*#>_|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  /** 长值折叠：短值直出，超长/多行值套既有折叠样式
   *  （ca-tl-body/ca-tl-text，与整理详情的消息体同款）——不新造控件、不加 CSS。
   *  原生 <details> 自带三角标记，展开/收起无需 JS。 */
  function foldValue(text, limit) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const max = Number.isFinite(limit) ? Number(limit) : 160;
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    if (raw.length <= max && !raw.includes('\n')) return `<p class="note">${esc(raw)}</p>`;
    return `<details class="ca-tl-body"><summary>${esc(oneLine.slice(0, max))}…</summary><div class="ca-tl-text">${esc(raw)}</div></details>`;
  }

  /** 归因枚举 → 人话：此前直接透传 execution_gap/unclear 这类
   *  内部枚举，用户看不懂"为什么"。 */
  const ATTRIBUTION_LABELS = {
    knowledge_gap: ['cognition.attribution_knowledge_gap', '缺相关知识'],
    rule_gap: ['cognition.attribution_rule_gap', '规则不合适'],
    template_gap: ['cognition.attribution_template_gap', '缺合适的模板'],
    skill_gap: ['cognition.attribution_skill_gap', '缺对应技能'],
    execution_gap: ['cognition.attribution_execution_gap', '执行环节没做到位'],
    unclear: ['cognition.attribution_unclear', '原因不明确'],
  };
  function attributionLabel(value) {
    const entry = ATTRIBUTION_LABELS[String(value || '')];
    return entry ? T(entry[0], entry[1]) : '';
  }

  /** 任务经过块：点证据 chip 就地展开"当时
   *  这次任务发生了什么"——字段是内部语言（attribution 枚举、markdown
   *  原文、与目标重复的 expectedResult），逐项翻成人话：当时的目标 /
   *  实际发生（清洗+截断）/ 结果 / 为什么 / 学到的。 */
  function kstarEpisodeSection(route) {
    const id = String(route.kstarEpisodeId || '');
    if (!id) return '';
    const state = S.kstarEpisode;
    if (!state || state.episodeId !== id || state.loading) {
      return `<div class="sect-block"><div class="sub">${esc(T('cognition.kstar_episode_loading', '正在读取这次任务的经过…'))}</div></div>`;
    }
    // 失败态（读不到 ≠ 没有）：给失败说明与「收起」出口——收起后重新点开
    // 会重新走 loadKstarEpisode，天然重试，不冒充只有标题的空详情。
    if (state.failed) {
      return `<div class="sect-block ca-episode-detail">
        <div class="tt">${esc(T('cognition.kstar_episode_detail_title', '这次任务的经过'))}</div>
        <p class="note">${esc(T('cognition.kstar_episode_failed', '这次没读出这块内容。收起后重新点开，会再试一次。'))}</p>
        ${btn(T('common.close', '收起'), 'open-kstar-episode', { id: '', small: true })}
      </div>`;
    }
    const review = state.review || {};
    const goal = String((state.episode && state.episode.goal) || '').trim();
    const expected = stripMarkdown(review.expectedResult);
    const actual = stripMarkdown(review.actualResult).slice(0, 160);
    const outcomeText = {
      better_than_expected: T('cognition.review_outcome_better', '比预期好'),
      met_expected: T('cognition.review_outcome_met', '符合预期'),
      worse_than_expected: T('cognition.review_outcome_worse', '比预期差'),
      unclear: T('cognition.review_outcome_unclear', '结果不明'),
    }[String(review.outcome || '')] || '';
    const row = (label, value) => value ? `<div class="meta-item"><span class="meta-k">${esc(label)}</span><span class="meta-v">${esc(String(value))}</span></div>` : '';
    return `<div class="sect-block ca-episode-detail">
      <div class="tt">${esc(T('cognition.kstar_episode_detail_title', '这次任务的经过'))}</div>
      <div class="meta-row">
        ${row(T('cognition.kstar_episode_goal_label', '当时的任务'), goal)}
        ${expected && expected !== goal ? row(T('cognition.review_signal_expected', '期望的结果'), expected) : ''}
        ${row(T('cognition.review_signal_actual', '实际发生'), actual)}
        ${row(T('cognition.review_signal_outcome', '结果'), outcomeText)}
        ${row(T('cognition.review_signal_attribution', '为什么'), attributionLabel(review.attribution))}
        ${row(T('cognition.kstar_lesson_label', '沉淀的经验'), review.lesson)}
      </div>
      ${btn(T('common.close', '收起'), 'open-kstar-episode', { id: '', small: true })}
    </div>`;
  }

  /** 复盘结果枚举 → 人话（三处共用：任务经过 / 复盘依据 / 依据链）。 */
  function reviewOutcomeText(value) {
    return {
      better_than_expected: T('cognition.review_outcome_better', '比预期好'),
      met_expected: T('cognition.review_outcome_met', '符合预期'),
      worse_than_expected: T('cognition.review_outcome_worse', '比预期差'),
      unclear: T('cognition.review_outcome_unclear', '结果不明'),
    }[String(value || '')] || '';
  }

  /** 结论 reason 是主进程写的人话短句，但句子里嵌了内部 id（「aa-…」/「ksf-…」）——
   *   铁律：rawId 不上屏。已知资产换标题、其余换泛称，句子其余部分照原样。
   *  只认主进程真的会写进结论的那几种前缀（aa/aur/kio/kse/ksf/ksr/ksp/rcand/rcap/
   *  immediate）：宁可漏掉没见过的前缀，也不拿通用规则去改人话里的连字符词。 */
  const INTERNAL_ID_RE = /\b(?:aa|aur|kio|kse|ksf|ksr|ksp|rcand|rcap|immediate)-[A-Za-z0-9-]{2,}\b/g;
  function stripInternalIds(text) {
    return String(text || '').replace(INTERNAL_ID_RE, (id) => {
      const asset = S.assets.find((row) => String(row.id) === id);
      if (asset) return String(asset.title || '').trim() || T('cognition.improvement_ref_asset_generic', '这条方法');
      return T('cognition.improvement_ref_generic', '相关记录');
    });
  }

  /* ────────────────────────── 认知树 v4（光斑有机版） ────────────────────────── */
  /* 垂直轴 = 处理梯度：土壤（来源与整理）→ 根（待确认候选）→ 干（本体总览）
     → 枝（四类资产）→ 冠（已验证）。层级语义：
     枝端光斑 = 大方向分类；叶片 = 细分方向（家族组名 → 标题冒号前主题 →
     标题，同方向合并计数）；单条资产不渲染成光斑——树上没有资产级节点，
     树冠/根部各只有一个聚合光斑。视觉走 Organic Biophilic：贝塞尔枝、
     径向渐变光斑、锥形树干；SVG viewBox 自适应，无需手动 resize 重绘。 */

  /** 叶片方向派生 + 同方向合并计数。返回 [[方向名, n], ...]（按量降序）。
   *  取名口径与原型一致：优先族名，其次标题冒号/箭头前的头段。
   *  族名表示**同源血缘**，不是主题分类；主题分类见资产的 `tags`。 */
  function branchDirections(assets) {
    const map = new Map();
    for (const a of assets) {
      const title = String(a.title || '').trim();
      if (!title) continue;
      const family = String(a.familyName || '').trim();
      const colonAt = Math.min(...[title.indexOf(':'), title.indexOf('：'), title.indexOf('→')].filter((i) => i > 0).concat([title.length]));
      const theme = family || (colonAt < title.length ? title.slice(0, colonAt).trim() : '') || title;
      const key = theme.slice(0, 14);
      if (!key) continue;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].sort((x, y) => y[1] - x[1]);
  }

  /** 四主枝：技能与方法 / 事实与知识 / 规则与偏好 / 模板与范例。
   *  side/len/y 是原型 v7 的几何参数：两条上枝（y=.32）分列左右，两条下枝（y=.72）更短。 */
  const TREE_BRANCHES = [
    /* y = 枝端高度系数（占干顶以下可用地面的比例，越大越高）。下枝组
       0.32 → 0.44：原值末梢扫到近土面、下垂像柳树，抬高后接近真实树形。 */
    { id: 'skill_method', key: 'cognition.tree_branch_skill_method', fallback: '技能与方法', side: -1, len: 400, y: 0.44 },
    { id: 'fact', key: 'cognition.tree_branch_fact', fallback: '事实与知识', side: 1, len: 360, y: 0.44 },
    { id: 'rule', key: 'cognition.tree_branch_rule', fallback: '规则与偏好', side: -1, len: 286, y: 0.72 },
    { id: 'template', key: 'cognition.tree_branch_template', fallback: '模板与范例', side: 1, len: 304, y: 0.72 },
  ];

  /* ── 认知树图示（原型 v7 drawTree 的移植）─────────────────────────────
     原型按容器实测像素画图（viewBox 自适应），所以这里同样产出「以当前
     视口尺寸为坐标」的 SVG：宽高由 treeViewport() 量出，容器 resize 后
     重画一次。视觉层次：土壤 → 根芽 → 枝上大方向 → 树冠已验证，
     枝端光斑=分类、叶片=细分方向。 */

  /** 容器像素尺寸：原型读 svg.clientWidth/clientHeight，画完一帧后就有了
   *  真值；首帧（容器里还没有 svg）退回 1240×760，app.js 量到不一致会重画一次。 */
  let treeSize = { W: 1240, H: 760 };
  function treeViewport() {
    const el = typeof document !== 'undefined' ? document.getElementById('ca-tree-svg') : null;
    if (el && el.clientWidth) treeSize = { W: el.clientWidth, H: el.clientHeight };
    return treeSize;
  }

  /** 单个光斑（原型 spotSvg）：halo 双层 + 实心核 + 可选 KSTAR 点 + 可选标签。 */
  function spotSvg(o) {
    const kstar = o.kstar
      ? `<circle class="spot-kstar" cx="${(o.x + o.r * 0.72).toFixed(1)}" cy="${(o.y - o.r * 0.72).toFixed(1)}" r="4"/>`
      : '';
    const hasLabel = o.tx !== undefined && o.ty !== undefined;
    const labelText = o.title.length > 16 ? `${o.title.slice(0, 15)}…` : o.title;
    return `<g class="spot${o.sel ? ' sel' : ''}" ${roleBtn(`data-act="${esc(o.act)}"${o.id ? ` data-id="${esc(o.id)}"` : ''} data-title="${esc(o.title)}" data-sub="${esc(o.sub || '')}" aria-label="${esc(o.aria || o.title)}"`)}>
      ${o.glow ? `<circle class="halo" cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="${(o.r * 2.1).toFixed(1)}" fill="${o.color}" opacity=".24" filter="url(#ca-tree-glow)"/>` : ''}
      <circle class="halo" cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="${(o.r + 5).toFixed(1)}" fill="${o.color}" opacity=".12"/>
      <circle class="core" cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="${o.r}" fill="${o.color}" stroke="var(--color-white)" stroke-width="1.8"/>
      ${kstar}
      ${hasLabel ? `<text ${o.labelId ? `id="${esc(o.labelId)}" ` : ''}x="${o.tx.toFixed(1)}" y="${o.ty.toFixed(1)}" text-anchor="middle" class="spot-label">${esc(labelText)}</text>` : ''}
    </g>`;
  }

  function treeFigure(info, directions) {
    const { W, H } = treeViewport();
    const cx = W / 2;
    const groundY = H - 148;
    /* 树冠覆盖干顶约 62px，窗口变高时保持连接；clamp 防止矮窗口的树冠越界。 */
    const trunkTop = groundY - 392;
    const crownCy = Math.max(96, trunkTop - 56);
    const pending = Number(info.pending || 0);
    const validated = Number(info.validated || 0);
    const catCount = (id) => Number((info.counts || {})[id] || 0);

    /* defs：树干/枝条/叶片/树冠/光斑五套渐变 + 柔光滤镜（与原型同名同色）。 */
    let g = `<defs>
      <filter id="ca-tree-glow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <linearGradient id="ca-trunk-grad" x1="0" x2="1">
        <stop offset="0" class="trunk-hi"/><stop offset=".48" class="trunk-mid"/><stop offset="1" class="trunk-lo"/>
      </linearGradient>
      <linearGradient id="ca-branch-grad" x1="0" x2="1">
        <stop offset="0" class="branch-hi"/><stop offset="1" class="branch-lo"/>
      </linearGradient>
      <linearGradient id="ca-leaf-grad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" class="leaf-hi"/><stop offset="1" class="leaf-lo"/>
      </linearGradient>
      <radialGradient id="ca-crown-grad" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${crownCy - 90}" r="${330}">
        <stop offset="0" class="crown-1"/><stop offset=".55" class="crown-2"/><stop offset="1" class="crown-3"/>
      </radialGradient>
      <radialGradient id="ca-orb-grad" cx=".36" cy=".3" r=".78">
        <stop offset="0" class="orb-1"/><stop offset=".58" class="orb-2"/><stop offset="1" class="orb-3"/>
      </radialGradient>
    </defs>`;

    /* 树冠：八圆聚成一顶有轮廓的冠（userSpaceOnUse 渐变让它读成一个
       连续形体，而不是三个椭圆的叠影），左上一道高光；中央白底药丸
       承载「有真实任务使用记录的资产数」（与枝牌同一视觉语言），整冠可点=已验证资产，
       落点「我的认知」默认按最近真实使用排。 */
    const crownTitle = validated
      ? T('cognition.tree_crown_validated', '有带入或读取记录 {n} 条', { n: String(validated) })
      : T('cognition.tree_crown_empty', '暂无带入或读取记录');
    const pillY = crownCy - 20;
    g += `<g class="spot" ${roleBtn(`data-act="open-overview" data-title="${esc(crownTitle)}" data-sub="${esc(T('cognition.tree_crown_sub', '点开查看资产列表及带入或读取记录'))}" aria-label="${esc(crownTitle)}"`)}>
      <circle cx="${cx}" cy="${crownCy}" r="118" fill="url(#ca-crown-grad)"/>
      <circle cx="${cx - 150}" cy="${crownCy + 30}" r="80" fill="url(#ca-crown-grad)"/>
      <circle cx="${cx + 150}" cy="${crownCy + 30}" r="80" fill="url(#ca-crown-grad)"/>
      <circle cx="${cx - 72}" cy="${crownCy - 72}" r="76" fill="url(#ca-crown-grad)"/>
      <circle cx="${cx + 72}" cy="${crownCy - 72}" r="76" fill="url(#ca-crown-grad)"/>
      <circle cx="${cx}" cy="${crownCy - 96}" r="66" fill="url(#ca-crown-grad)"/>
      <circle cx="${cx - 205}" cy="${crownCy + 58}" r="52" fill="url(#ca-crown-grad)"/>
      <circle cx="${cx + 205}" cy="${crownCy + 58}" r="52" fill="url(#ca-crown-grad)"/>
      <ellipse cx="${cx - 60}" cy="${crownCy - 92}" rx="92" ry="34" class="crown-sheen"/>
      <rect x="${cx - 85}" y="${pillY}" width="170" height="40" rx="20" class="branch-plate"/>
      <circle cx="${cx - 55}" cy="${pillY + 20}" r="5" class="crown-dot"/>
      <text x="${cx + 8}" y="${pillY + 26}" text-anchor="middle" class="branch-plate-name">${esc(crownTitle)}</text>
      <text x="${cx}" y="${pillY + 66}" text-anchor="middle" class="crown-sub">${esc(T('cognition.tree_crown_sub', '点开查看资产列表及带入或读取记录'))}</text>
    </g>`;

    /* 树干：有机锥形 + 竖排「本体」（点开进入多领域本体总览）。 */
    const ontologyTreeLabel = Array.from(T('cognition.ontology_tree_label', '本体'))
      .map((letter, index) => `<tspan x="${cx + 1}"${index ? ' dy="35"' : ''}>${esc(letter)}</tspan>`)
      .join('');
    g += `<path d="M ${cx - 22} ${groundY - 20} C ${cx - 25} ${groundY - 152}, ${cx - 12} ${groundY - 248}, ${cx - 9} ${trunkTop} L ${cx + 9} ${trunkTop} C ${cx + 14} ${groundY - 244}, ${cx + 25} ${groundY - 146}, ${cx + 22} ${groundY - 20} Z" fill="url(#ca-trunk-grad)"/>
      <path d="M ${cx - 8} ${groundY - 35} C ${cx - 10} ${groundY - 160}, ${cx - 4} ${groundY - 258}, ${cx - 3} ${trunkTop + 20}" class="trunk-ridge-light" stroke-width="4"/>
      <path d="M ${cx + 10} ${groundY - 70} C ${cx + 12} ${groundY - 160}, ${cx + 7} ${groundY - 265}, ${cx + 6} ${trunkTop + 60}" class="trunk-ridge-dark" stroke-width="2.5"/>
      <g class="spot" ${roleBtn(`data-act="open-ontology" data-title="${esc(T('cognition.ontology_entry_title', '本体'))}" data-sub="${esc(T('cognition.ontology_entry_hint', '浏览个人与事项本体、分类以及它们之间的关系'))}" aria-label="${esc(T('cognition.ontology_entry_title', '本体'))}"`)}>
        <text x="${cx + 1}" y="${groundY - 310}" text-anchor="middle" class="trunk-name">${ontologyTreeLabel}</text>
      </g>`;
    /* 树干光斑：竖排名下方一颗绿核，给「可点」一个看得见的落点（光斑走
       spotSvg 统一形态；点击落点与树干同是 open-ontology）。 */
    g += spotSvg({
      kind: 'trunk', x: cx + 1, y: groundY - 190, r: 9, color: 'url(#ca-orb-grad)', glow: true, act: 'open-ontology',
      title: T('cognition.ontology_entry_title', '本体'),
      sub: T('cognition.ontology_entry_hint', '浏览个人与事项本体、分类以及它们之间的关系'),
      aria: T('cognition.ontology_entry_title', '本体'),
    });

    /* 大方向枝：一根枝一个光斑；叶片（药丸）承载下一层细分方向。
       枝长在窄窗按可用半宽收敛（原型按固定长度画，只在整窗宽度下成立；
       收敛后桌面宽度下与原值一致，窄窗才变短，枝牌不会顶出画布）。 */
    const maxLen = Math.max(200, W / 2 - 96);
    for (const branch of TREE_BRANCHES) {
      const len = Math.min(branch.len, maxLen);
      const end = { x: cx + branch.side * len, y: groundY - branch.y * (groundY - 190) };
      const originY = end.y + 96;
      const x0 = cx + branch.side * 17;
      const c1x = cx + branch.side * 124;
      const c1y = originY + 10;
      const c2x = end.x - branch.side * 104;
      const c2y = end.y + 26;
      const branchPath = `M ${x0} ${originY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`;
      g += `<path d="${branchPath}" stroke="url(#ca-branch-grad)" stroke-width="10" fill="none" stroke-linecap="round" opacity=".92"/>
        <path d="${branchPath}" class="branch-ridge" stroke-width="2.5" transform="translate(0,-2.2)"/>`;
      const label = T(branch.key, branch.fallback);
      const dirs = directions[branch.id] || [];
      const ts = dirs.length === 1 ? [0.66] : dirs.length === 2 ? [0.48, 0.8] : [0.4, 0.66, 0.9];
      dirs.slice(0, 3).forEach((dir, i) => {
        const t = ts[i] || 0.7;
        const mt = 1 - t;
        const px = mt * mt * mt * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * end.x;
        const py = mt * mt * mt * originY + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * end.y;
        const upper = i % 2 === 0;
        const stemX = px + branch.side * (26 + (i % 2) * 5);
        const stemY = py + (upper ? -20 : 18);
        const stemPath = `M ${px.toFixed(1)} ${py.toFixed(1)} Q ${((px + stemX) / 2 + branch.side * 3).toFixed(1)} ${((py + stemY) / 2).toFixed(1)} ${stemX.toFixed(1)} ${stemY.toFixed(1)}`;
        const angle = branch.side === -1 ? (upper ? 204 : 158) : (upper ? -22 : 22);
        const text = dir[1] > 1 ? `${dir[0]} ×${dir[1]}` : dir[0];
        /* 药丸宽度按字宽估算（中文 11px、英文 6px），超宽截断到能放下的
           字数——原型的数据集标签短，不会溢出；真实数据里标题头段可以很
           长，不截会顶出药丸外。 */
        const textLen = (value) => [...value].reduce((n, ch) => n + (/[\u4e00-\u9fa5]/.test(ch) ? 11 : 6), 0);
        const pillW = Math.max(82, Math.min(156, textLen(text) + 24));
        const fitted = (() => {
          if (textLen(text) <= pillW - 16) return text;
          let out = '';
          for (const ch of text) {
            if (textLen(`${out}${ch}…`) > pillW - 16) break;
            out += ch;
          }
          return `${out}…`;
        })();
        const pillX = stemX + branch.side * 16 - pillW / 2;
        let pillY = upper ? stemY - 48 : stemY + 20;
        /* 枝牌（end.x±84，end.y-73..-30）被叶药丸压住时翻到枝下方——
           t=0.9 的上侧叶正好撞牌。 */
        const hitsPlate = !(pillX + pillW < end.x - 84 || pillX > end.x + 84
          || pillY + 24 < end.y - 73 || pillY > end.y - 30);
        if (hitsPlate) pillY = stemY + 20;
        g += `<g class="leaf" role="img" aria-label="${esc(T('cognition.tree_leaf_aria', '{label}，细分方向 {n} 条', { label: dir[0], n: String(dir[1]) }))}">
          <path d="${stemPath}" class="leaf-stem" stroke-width="2"/>
          <g transform="translate(${stemX.toFixed(1)} ${stemY.toFixed(1)}) rotate(${angle})">
            <path d="M0 0 C13,-14 34,-14 45,0 C34,14 13,14 0,0 Z" fill="url(#ca-leaf-grad)" class="leaf-blade"/>
            <path d="M3 0 H39" class="leaf-vein" stroke-width="1"/>
          </g>
          <rect x="${pillX.toFixed(1)}" y="${pillY.toFixed(1)}" width="${pillW.toFixed(1)}" height="24" rx="12" class="leaf-pill"/>
          <text x="${(pillX + pillW / 2).toFixed(1)}" y="${(pillY + 16).toFixed(1)}" text-anchor="middle" class="leaf-pill-text">${esc(fitted)}</text>
        </g>`;
      });
      const count = catCount(branch.id);
      g += `<rect x="${end.x - 84}" y="${end.y - 73}" width="168" height="43" rx="12" class="branch-plate"/>
        <text x="${end.x}" y="${end.y - 55}" text-anchor="middle" class="branch-plate-name">${esc(label)} · ${count}</text>
        <text x="${end.x}" y="${end.y - 39}" text-anchor="middle" class="branch-plate-sub">${esc(T('cognition.tree_branch_dirs', '{n} 个细分方向', { n: String(dirs.length) }))}</text>`;
      g += spotSvg({
        kind: 'branch', id: branch.id, x: end.x, y: end.y, r: 12, color: 'url(#ca-orb-grad)', glow: true,
        sel: String(S.route.category || '') === branch.id,
        act: 'filter-cat',
        title: `${label} · ${count}`,
        sub: T('cognition.tree_branch_hint', '{label} · {n} 条；点击进入该分类的资产明细', { label, n: String(count) }),
        aria: T('cognition.tree_branch_aria', '{label}：{n} 条资产，点开分类明细', { label, n: String(count) }),
      });
    }

    /* 根：根须图案 + 唯一一个光斑（点开=待确认候选清单）。 */
    g += `<g class="root-hairs" stroke-width="5">
      <path d="M ${cx - 5} ${groundY - 36} C ${cx - 42} ${groundY - 26}, ${cx - 78} ${groundY - 20}, ${cx - 118} ${groundY - 6}"/>
      <path d="M ${cx - 5} ${groundY - 30} C ${cx - 30} ${groundY - 16}, ${cx - 52} ${groundY - 10}, ${cx - 74} ${groundY + 2}"/>
      <path d="M ${cx + 5} ${groundY - 36} C ${cx + 42} ${groundY - 26}, ${cx + 78} ${groundY - 20}, ${cx + 118} ${groundY - 6}"/>
      <path d="M ${cx + 5} ${groundY - 30} C ${cx + 30} ${groundY - 16}, ${cx + 52} ${groundY - 10}, ${cx + 74} ${groundY + 2}"/>
      <path d="M ${cx} ${groundY - 24} C ${cx - 4} ${groundY - 12}, ${cx + 4} ${groundY - 6}, ${cx} ${groundY + 4}"/></g>
      <rect x="${cx - 7}" y="${groundY - 40}" width="14" height="42" class="root-collar"/>
      ${spotSvg({ kind: 'root', x: cx, y: groundY - 52, r: 12, color: 'var(--amber-dot)', glow: true, act: 'go-review', title: pending ? T('cognition.tree_root_pending', '{n} 条新芽等你确认', { n: String(pending) }) : T('cognition.tree_root_empty', '暂无待确认'), sub: T('cognition.tree_root_go', '点开去拍板'), labelId: 'ca-root-n', tx: cx, ty: groundY - 72 })}
      <rect x="${cx - 7}" y="${groundY - 24}" width="14" height="26" class="root-collar"/>`;

    /* 土壤：会话与采集记录的来源层。 */
    g += `<g class="spot" ${roleBtn(`data-act="go-review" data-title="${esc(T('cognition.tree_soil_title', '认知生长：整理过程与结果都在这里'))}" data-sub="${esc(T('cognition.tree_soil_hint', '会话与记录在这里生根'))}" aria-label="${esc(T('cognition.tree_soil_label', '土壤 · 记录 {s} · 整理 {c}', { s: String(Number(info.sources || 0)), c: String(Number(info.captures || 0)) }))}"`)}>
      <rect x="${cx - 330}" y="${groundY + 2}" width="660" height="58" rx="12" class="soil-band"/>
      <text x="${cx}" y="${groundY + 27}" text-anchor="middle" class="soil-title">${esc(T('cognition.tree_soil_label', '土壤 · 记录 {s} · 整理 {c}', { s: String(Number(info.sources || 0)), c: String(Number(info.captures || 0)) }))}</text>
      <text x="${cx}" y="${groundY + 46}" text-anchor="middle" class="soil-sub">${esc(T('cognition.tree_soil_hint', '会话与记录在这里生根'))}</text>
    </g>`;

    return `<svg id="ca-tree-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(T('cognition.tree_panel_title', '我的认知树'))}">${g}</svg>`;
  }

  /* ────────────────────────── 资产详情 ────────────────────────── */

  /* 会话名 join：使用记录事件只带 conversationId，用户看不懂裸 id——按来源
   * 清单里的会话项翻成标题；join 不到（会话已删/老数据无此字段）用泛称，
   * 不编造名字。整句叙事见 proofSentence。（自独立使用记录页
   * 迁入资产详情，成为资产详情的使用记录区。） */
  function conversationNames() {
    const names = new Map();
    for (const group of S.sources) {
      for (const item of Array.isArray(group.items) ? group.items : []) {
        if (item.kind === 'conversation' && item.id) names.set(String(item.id), String(item.title || ''));
      }
    }
    // 目录只有 100 条窗口，窗口外的会话此前一律退化成「一次对话里」（
    // 「可定位会话」不成立）。批量标题口是权威，覆盖目录里的同名旧值。
    const titles = S.conversationTitles || {};
    for (const cid of Object.keys(titles)) {
      const title = String(titles[cid] || '').trim();
      if (title) names.set(String(cid), title);
    }
    return names;
  }
  function proofWherePhrase(names, conversationId) {
    const name = conversationId ? names.get(String(conversationId)) : '';
    // name 不在此处 esc：proofSentence 的返回值整体过 esc（T() 只做占位
    // 替换），内层再转义会把 & < > 显示成实体（双重转义）。
    return name
      ? T('cognition.proof_where_named', '对话《{name}》里', { name })
      : T('cognition.proof_where_generic', '一次对话里');
  }
  /** 事件整句化：一句话说明在什么时间、哪个对话里被怎么用。
   *  knownVersions：该资产现存的版本号集合——使用记录忠实保留历史，引用
   *  的版本可能已被删除（版本真删上线后很常见），裸标 v5 用户会懵"v5 是
   *  啥，我只有 v1/v2"；不在集合内的标注"当时的版本后来已删除"。 */
  function proofSentence(names, proof, knownVersions) {
    const refs = proof.refs || {};
    const when = fmtDate(proof.occurredAt);
    const where = proofWherePhrase(names, refs.conversationId);
    const version = refs.version
      ? (knownVersions && knownVersions.size && !knownVersions.has(String(refs.version))
        ? T('cognition.proof_version_deleted', '（当时的 v{n}，该版本后来已删除）', { n: String(refs.version) })
        : T('cognition.proof_version_suffix', '（v{n}）', { n: String(refs.version) }))
      : '';
    const kind = String(proof.kind || '');
    if (kind === 'usage_recorded') {
      // 按 outcome 说清"怎么用到的"：宿主注入、
      // 模型自读、派发授予一律不宣称"被实际采用"——是否采用只看「实际采用记录」
      // （有据回执）。旧记录没有 outcome，按中性"带进上下文"表述。
      const outcome = String(refs.usageOutcome || '');
      if (outcome === 'agent_read') {
        return T('cognition.proof_sentence_agent_read', '{when}，{where}的模型读取了这条内容{version}', { when, where, version });
      }
      if (outcome === 'dispatched') {
        return T('cognition.proof_sentence_dispatched', '{when}，这条内容被派发给执行者{version}', { when, version });
      }
      if (outcome === 'succeeded' || outcome === 'degraded' || outcome === 'rejected') {
        return T('cognition.proof_sentence_transfer', '{when}，{where}的这次使用已核对结果{version}', { when, where, version });
      }
      if (outcome === 'feedback_positive' || outcome === 'feedback_negative') {
        return T('cognition.proof_sentence_feedback', '{when}，你对这次使用给了评价{version}', { when, version });
      }
      return T('cognition.proof_sentence_brought_in', '{when}，{where}的这次任务把这条内容带进了上下文{version}', { when, where, version });
    }
    if (kind === 'projection_confirmed') {
      return T('cognition.proof_sentence_projected', '{when}，在{where}被任务带入{version}', { when, where, version });
    }
    if (kind === 'projection_revoked') {
      // 模型自选的撤销要在使用记录里看得见：否则"我撤过它"没有
      // 任何痕迹，只剩一堆"被带入任务"。
      return T('cognition.proof_sentence_attachment_revoked', '{when}，{where}的这次挂载被你撤销（此后的回合不再带上）', { when, where });
    }
    if (kind === 'asset_created') {
      return T('cognition.proof_sentence_created', '{when}，这条内容被创建', { when });
    }
    if (kind === 'asset_version') {
      return T('cognition.proof_sentence_version', '{when}，保存了新版本{version}', { when, version });
    }
    if (kind === 'asset_version_selected') {
      return T('cognition.proof_sentence_version_selected', '{when}，选用 v{n} 为在用版本', { when, n: String(refs.version || '') });
    }
    return T('cognition.proof_sentence_unknown', '{when}，{title}', { when, title: proofEventTitle(proof) });
  }

  /** 「被任务用过」计数（唯一公式，列表行 / 目录行 / 详情摘要共用；原「被带入任务」）：
   *  白名单事件（来自主进程）+ 防重复——一次带入在数据层会产生两条记录
   *  （projection_confirmed 与同投影的 usage_recorded/injected），必须按投影去重，
   *  否则一次带入被数成两次。没有投影关联的 usage 行按明确曝光路线计入；反馈不计数。明确是"另一条路线"
   *  （注入 / 模型自读 / 派发 / 迁移核对）时才另计；否则视作该投影自身的记录，
   *  **宁可少算不多算**。撤销事件单列不计。 */
  function assetProofItems(assetId) {
    const timeline = S.assetTimeline;
    if (timeline && String(timeline.assetId || '') === String(assetId)
      && !timeline.loading && !timeline.failed && Array.isArray(timeline.items)) return timeline.items;
    return S.proofs;
  }

  function taskExposureProofs(assetId, proofItems) {
    const realKinds = new Set(Array.isArray(S.realUsageKinds) ? S.realUsageKinds : []);
    const routes = new Set(['injected', 'agent_read', 'dispatched', 'succeeded', 'degraded', 'rejected']);
    const byExposure = new Map();
    for (const proof of (Array.isArray(proofItems) ? proofItems : S.proofs)) {
      const kind = String(proof.kind || '');
      const refs = proof.refs || {};
      if (!realKinds.has(kind) || String(refs.assetId || '') !== String(assetId)) continue;
      if (kind !== 'projection_confirmed' && !(kind === 'usage_recorded' && routes.has(String(refs.usageOutcome || 'injected')))) continue;
      const key = refs.projectionId ? `projection:${refs.projectionId}` : `event:${proof.id}`;
      const previous = byExposure.get(key);
      if (!previous || String(proof.occurredAt || '') > String(previous.occurredAt || '')) byExposure.set(key, proof);
    }
    return [...byExposure.values()];
  }

  function broughtInCountFor(assetId, proofItems) {
    return taskExposureProofs(assetId, proofItems).length;
  }

  /** Scan each timeline item once; reuse the same whitelist and exposure
   * deduplication as the per-asset count, without a long-lived stale cache. */
  function broughtInCountsFor(proofItems) {
    const grouped = new Map();
    for (const proof of (Array.isArray(proofItems) ? proofItems : S.proofs)) {
      const id = String(proof.refs?.assetId || '');
      if (!id) continue;
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(proof);
    }
    return new Map([...grouped].map(([id, items]) => [id, broughtInCountFor(id, items)]));
  }

  /** 资产详情的使用记录区（原独立「使用记录」页的按资产切片）。 */
  function assetUsageSection(asset, route) {
    const realKinds = new Set(Array.isArray(S.realUsageKinds) ? S.realUsageKinds : []);
    const proofItems = assetProofItems(asset.id);
    const items = proofItems
      .filter((p) => String((p.refs || {}).assetId || '') === String(asset.id))
      // 真实使用事件白名单来自主进程；撤销需要展示但不计数。
      // 版本保存、选用切换和治理操作均不是使用。
      .filter((p) => realKinds.has(String(p.kind || '')) || String(p.kind || '') === 'projection_revoked')
      .sort((left, right) => String(right.occurredAt || '').localeCompare(String(left.occurredAt || '')));
    if (!items.length) {
      return `<div class="sect-block"><div class="sub">${esc(T('cognition.asset_no_proofs_section', '还没有被真实使用过。资产在任务中被真正使用、并留下可核对的记录后，会出现在这里。'))}</div></div>`;
    }
    const names = conversationNames();
    // 现存版本集合：只认版本链里实际存在的版本——asset.version 是
    // 只增游标（真删不回退，防引用错位），不能当"现存"用；链未加载时不
    // 标注（拿不准宁可显示普通后缀，不误标"已删除"）。
    const knownVersions = new Set();
    if (S.assetVersions && S.assetVersions.assetId === String(asset.id) && Array.isArray(S.assetVersions.versions)) {
      knownVersions.add(String(asset.activeVersion || ''));
      for (const v of S.assetVersions.versions) knownVersions.add(String(v.version));
    }
    // 「被任务用过」计数走唯一公式（与目录行、列表侧同口径）。
    const broughtInCount = broughtInCountFor(asset.id, proofItems);
    // 「实际采用」只认有据回执：applied 才算采用，contradicted 单列，
    // 其余（usage_unknown / considered_not_applicable / available_no_opportunity）
    // 如实显示为「证据不足」——不夸大成全部采用，也不谎称失败。
    const receipts = (S.adoptionReceipts && String(S.adoptionReceipts.assetId || '') === String(asset.id)
      && Array.isArray(S.adoptionReceipts.items))
      ? S.adoptionReceipts.items
      : [];
    const appliedCount = receipts.filter((r) => String(r.status || '') === 'applied').length;
    const contradictedCount = receipts.filter((r) => String(r.status || '') === 'contradicted').length;
    const unknownCount = receipts.filter((r) => !['applied', 'contradicted'].includes(String(r.status || ''))).length;
    const summaryLine = [
      broughtInCount ? T('cognition.proof_projected_times', '带入或读取 {n} 次', { n: String(broughtInCount) }) : '',
      appliedCount ? T('cognition.adoption_applied_times', '其中模型确认采用 {n} 次', { n: String(appliedCount) }) : '',
      contradictedCount ? T('cognition.adoption_contradicted_times', '被否定 {n} 次', { n: String(contradictedCount) }) : '',
      unknownCount ? T('cognition.adoption_unknown_times', '证据不足 {n} 次', { n: String(unknownCount) }) : '',
    ].filter(Boolean).join(' · ');
    const rows = items.slice(0, 20).map((proof) => {
      const refs = proof.refs || {};
      const isOpen = String(route.proofEventId) === String(proof.id);
      const transferProofId = String(refs.transferProofId || '');
      const kind = String(proof.kind || '');
      let ratingHtml = '';
      if (isOpen) {
        // 评价闸门（对齐后端 E_RECALL_* 口径）：只有「被实际使用」
        // （usage_recorded）且留下迁移证明的事件才可评。
        if (kind === 'usage_recorded' && transferProofId) {
          ratingHtml = `<div class="ca-rating"><strong>${esc(T('cognition.proof_rate_question', '这次用得怎么样？'))}</strong>
            <div class="actions">${PROOF_FEEDBACKS.map(([value, key, fb]) => btn(T(key, fb), 'proof-rate', { id: transferProofId, data: { feedback: value, proof: proof.id } })).join('')}</div>
            <div class="note-zone">
              ${window.uiTextarea({ id: `ca-proof-note-${esc(proof.id)}`, placeholder: T('cognition.proof_note_optional_placeholder', '可补充一句你观察到的变化（可选；先写再点评，说明会随评价一起附上）'), attrs: { 'data-f': 'note' } })}
            </div>
          </div>`;
        } else if (kind === 'effectiveness_recorded') {
          const outcome = String(proof.outcome || 'insufficient_evidence');
          ratingHtml = `<div class="ca-rating"><strong>${esc(T(`cognition.effect_outcome_${outcome}`, '证据不足'))}</strong>
            <p class="note">${esc(proof.summary || '')}</p></div>`;
        } else {
          ratingHtml = `<div class="ca-rating"><p class="note">${esc(T('cognition.proof_rating_blocked_no_transfer', '这次还没有形成可评价的使用记录。'))}</p></div>`;
        }
      }
      return `
      <div class="ca-proof-row${isOpen ? ' is-open' : ''}">
        <div class="ca-proof-event" data-act="proof-toggle" data-id="${esc(proof.id)}" ${roleBtn()}>
          <span class="ca-proof-dot" aria-hidden="true"></span>
          <span class="ca-proof-body"><strong class="ca-proof-sentence">${esc(proofSentence(names, proof, knownVersions))}</strong></span>
        </div>
        ${ratingHtml}
      </div>`;
    }).join('');
    return `<div class="sect-block">
      ${sectionHead(T('cognition.asset_usage_section', '使用记录'), summaryLine)}
      <div class="ca-proof-list">${rows}</div>
      ${items.length > 20 ? `<div class="sub">${esc(T('cognition.asset_usage_more', '仅显示最近 {n} 条', { n: '20' }))}</div>` : ''}
    </div>`;
  }

  /** 实际采用记录：唯一权威 = usage 回执 applied。
   *  每条给出同次任务（时间）、具体版本、执行事件类型与产物位置（证据来源名走统一
   *  解析器，不裸 id）；contradicted 单列；其余如实标「证据不足 · 未知」——不夸大
   *  成全部采用，也不谎称失败。没有回执时说明"还没有可核对的采用证据"。 */
  function assetAdoptionSection(asset) {
    const state = S.adoptionReceipts;
    const items = (state && String(state.assetId || '') === String(asset.id) && Array.isArray(state.items))
      ? state.items
      : [];
    if (!items.length) {
      return `<div class="sect-block">${sectionHead(T('cognition.adoption_section', '实际采用记录'))}
        <div class="sub">${esc(T('cognition.adoption_empty', '还没有可核对的采用证据。任务里真正用到、并留下可核对痕迹的记录才会出现在这里。'))}</div></div>`;
    }
    const statusLabel = (status) => {
      if (status === 'applied') return T('cognition.adoption_status_applied', '已实际采用');
      if (status === 'contradicted') return T('cognition.adoption_status_contradicted', '被否定');
      if (status === 'considered_not_applicable') return T('cognition.adoption_status_not_applicable', '这次不适用');
      if (status === 'available_no_opportunity') return T('cognition.adoption_status_no_opportunity', '没有使用机会');
      return T('cognition.adoption_status_unknown', '证据不足 · 未知');
    };
    const evidenceKindLabel = (kind) => {
      if (kind === 'tool_call') return T('cognition.adoption_evidence_tool_call', '工具调用');
      if (kind === 'agent_action') return T('cognition.adoption_evidence_agent_action', '执行动作');
      if (kind === 'artifact') return T('cognition.adoption_evidence_artifact', '产物');
      if (kind === 'final_output') return T('cognition.adoption_evidence_final_output', '最终输出');
      return '';
    };
    const rows = items.map((receipt) => {
      const version = String(receipt.assetVersion || '');
      const kindLabel = evidenceKindLabel(String(receipt.evidenceKind || ''));
      const names = (Array.isArray(receipt.evidence) ? receipt.evidence : [])
        .map((ref) => resolveSourceRef(ref))
        .map((view) => view.name)
        .filter(Boolean);
      const meta = [version ? `v${version}` : '', fmtDate(receipt.createdAt), kindLabel].filter(Boolean).join(' · ');
      const evidenceLine = names.length
        ? `<div class="sub">${esc(T('cognition.adoption_evidence_line', '证据：{names}', { names: names.join('、') }))}</div>`
        : '';
      const observationLabel = T('cognition.usage_model_assisted', '模型辅助检查');
      const observationHint = T('cognition.usage_model_assisted_hint', '这是对本次回答遵守情况的观察，不是改善效果的证明。');
      const observation = receipt.observationMethod === 'model_assisted' ? window.uiTag({
        label: observationLabel, variant: 'outline',
        attrs: { title: observationHint, 'aria-label': observationLabel + ' · ' + observationHint },
      }) : '';
      const reportFailureKeys = {
        quote_not_found: 'cognition.adoption_report_quote_not_found',
        result_unavailable: 'cognition.adoption_report_result_unavailable',
        result_changed: 'cognition.adoption_report_result_changed',
      };
      const reportFailureKey = receipt.status === 'usage_unknown' && receipt.observationMethod === 'agent_reported'
        ? reportFailureKeys[receipt.reportFailure] : '';
      const reportFailure = reportFailureKey ? window.uiTag({ label: T(reportFailureKey), variant: 'outline' }) : '';
      return `<div class="ca-proof-row">
        <div class="ca-proof-body">
          <strong class="ca-proof-sentence">${esc(statusLabel(String(receipt.status || '')))}</strong>
          ${observation}
          ${reportFailure}
          ${meta ? `<span class="note">${esc(meta)}</span>` : ''}
        </div>
        ${evidenceLine}
      </div>`;
    }).join('');
    const applied = items.filter((r) => String(r.status || '') === 'applied').length;
    const contradicted = items.filter((r) => String(r.status || '') === 'contradicted').length;
    const unknown = items.length - applied - contradicted;
    const note = [
      T('cognition.asset_usage_applied', '模型确认采用 {n} 次', { n: String(applied) }),
      contradicted ? T('cognition.adoption_contradicted_times', '被否定 {n} 次', { n: String(contradicted) }) : '',
      unknown ? T('cognition.adoption_unknown_times', '证据不足 {n} 次', { n: String(unknown) }) : '',
    ].filter(Boolean).join(' · ');
    return `<div class="sect-block">
      ${sectionHead(T('cognition.adoption_section', '实际采用记录'), note)}
      <div class="ca-proof-list">${rows}</div>
    </div>`;
  }

  /** 资产详情「为什么这一轮排在前面」：使用
   *  记录区里的折叠小节，解释这条资产最近一轮在目录里的推荐排序依据。
   *  数据 = recall.catalog.ranking（注入回执的 ranking 拆解，只读）——由
   *  app.js 按详情页资产异步取回后挂在 NS.rankingWhy。
   *  呈现纪律：缺的因子不显示（不是 0）；缺席给一句人话；旧回执没有
   *  ranking → 如实说「没有记录」，不编造；weightsSource=invalid-fallback
   *  → 醒目提示「你的权重配置没生效」。 */
  function assetRankingWhySection(asset) {
    if (!['active', 'paused'].includes(String(asset.status || 'active'))) return '';
    const state = NS.rankingWhy;
    const mine = state && String(state.assetId || '') === String(asset.id) ? state : null;
    let body;
    if (!mine || mine.loading) {
      body = `<div class="sub">${esc(T('cognition.ranking_loading', '正在取这一轮的排序依据…'))}</div>`;
    } else if (mine.failed) {
      body = `<div class="sub">${esc(T('cognition.ranking_load_failed', '排序依据暂时取不到（读取失败），可以稍后再试。'))}</div>`;
    } else if (!mine.turnId) {
      // 使用记录里找不到这条资产的任何回合 → 它没进过当轮目录（空态契约）。
      body = `<div class="sub">${esc(T('cognition.ranking_not_in_catalog', '这一轮没有进入目录'))}</div>`;
    } else if (!mine.item || mine.item.explainable === false) {
      body = `<div class="sub">${esc(T('cognition.ranking_no_record', '这一轮没有记录排序依据'))}</div>`;
    } else {
      const FACTOR_LABELS = {
        relevance: T('cognition.ranking_factor_relevance', '内容相关'),
        adoption: T('cognition.ranking_factor_adoption', '实际采用'),
        scene: T('cognition.ranking_factor_scene', '场景'),
        maturity: T('cognition.ranking_factor_maturity', '成熟度'),
      };
      const num = (value) => Number(value || 0).toFixed(2);
      const rows = (Array.isArray(mine.item.factors) ? mine.item.factors : []).map((factor) => `
        <div class="ca-rank-row">
          <span class="ca-rank-name">${esc(FACTOR_LABELS[factor.name] || String(factor.name || ''))}</span>
          <span class="ca-rank-raw">${esc(num(factor.raw))}</span>
          <span class="ca-rank-weight">× ${esc(Number(factor.weight || 0).toFixed(1))}</span>
          <span class="ca-rank-contrib">= ${esc(num(factor.contribution))}</span>
        </div>`).join('');
      // 缺席因子 = 不进分子也不进分母：给一句人话说明（scene/relevance 之外
      // 的因子在场恒定，不会缺席——出现未知缺席名时不编理由，只如实不显示）。
      const sceneAbsentNote = mine.item.sceneExcludedReason === 'no_scene_context'
        ? T('cognition.ranking_scene_no_context_note', '这一轮没有关联的项目或工作空间，所以场景不计分')
        : mine.item.sceneExcludedReason === 'no_matching_association'
          ? T('cognition.ranking_scene_no_match_note', '当前项目或工作空间没有与这条资产匹配的关联，所以场景不计分')
          : T('cognition.ranking_scene_absent_note', '这一轮没有匹配当前任务的场景关联，因此不计分');
      const ABSENT_NOTES = {
        scene: sceneAbsentNote,
        relevance: T('cognition.ranking_relevance_absent_note', '这一轮没有可比对的任务文本，内容相关不计分'),
      };
      const absent = (Array.isArray(mine.item.excluded) ? mine.item.excluded : [])
        .map((name) => ABSENT_NOTES[name] || '')
        .filter(Boolean)
        .map((note) => `<p class="note">${esc(note)}</p>`)
        .join('');
      const source = String(mine.item.weightsSource || '');
      const sourceNote = source === 'invalid-fallback'
        ? `<p class="note ca-rank-warn">${esc(T('cognition.ranking_weights_invalid_note', '你的权重配置没生效（配置不合法），当前用的是默认权重'))}</p>`
        : source === 'default'
          ? `<p class="note">${esc(T('cognition.ranking_source_default_note', '当前使用默认权重'))}</p>`
          : '';
      body = `
        <div class="ca-rank-rows">${rows}</div>
        <div class="sub"><strong>${esc(T('cognition.ranking_total', '加权总分 {score}', { score: num(mine.item.score) }))}</strong></div>
        ${absent}
        ${sourceNote}
        <p class="note">${esc(T('cognition.ranking_why_hint', '这是模型挑资产时这一轮的打分拆解，只读；排序规则由系统维护，不能手动调整。'))}</p>`;
    }
    return `<div class="sect-block ca-rank-why" data-ranking-why>
      <details class="details">
        <summary>${esc(T('cognition.ranking_why_title', '为什么这一轮排在前面'))}</summary>
        <div class="dbody">${body}</div>
      </details>
    </div>`;
  }

  /** 版本来源标签：reason 是审计字段（多为机器
   *  生成），直接透传用户读不懂；先归一成来源种类，标签走 locale，原文
   *  收进展开块"变更说明"。reason 归一只认数据层的固定英文前缀（core 写
   *  reason 时用英文常量，不随界面语言变——否则归一化会跟着漂）。 */
  function versionSourceKind(v) {
    const reason = String(v.reason || '');
    if (reason.startsWith('review_decision:')) return 'decision';
    if (reason.startsWith('legacy ') || reason.includes('(2026-08-15)') || reason.includes('(2026-09-13')) return 'migration';
    if (reason.startsWith('merged from ') || reason.startsWith('merged active version')) return 'merge';
    if (reason.startsWith('user rollback to v')) return 'rollback';
    if (reason === 'evidence merged from candidate dedup') return 'dedup';
    if (reason.startsWith('merge versions v')) return 'version_merge';
    if (reason.startsWith('user manual edit')) return 'manual';
    return v.actor === 'user' ? 'manual' : 'system';
  }
  const VERSION_SOURCE_LABELS = {
    // 「确认沉淀」：review_decision 前缀两线通用（对话线
    // 候选确认与 KSTAR 复盘确认都写它），此前文案「候选确认」是内部流程
    // 词汇——用户视角这一版是"确认后沉淀下来的"。
    decision: ['cognition.asset_version_src_decision', '确认沉淀'],
    migration: ['cognition.asset_version_src_migration', '系统迁移'],
    merge: ['cognition.asset_version_src_merge', '归并'],
    rollback: ['cognition.asset_version_src_rollback', '回退'],
    dedup: ['cognition.asset_version_src_dedup', '证据归并'],
    version_merge: ['cognition.asset_version_src_version_merge', '版本合并'],
    manual: ['cognition.asset_version_src_manual', '手动编辑'],
    system: ['cognition.asset_version_src_system', '系统'],
  };
  function versionSourceLabel(v) {
    const entry = VERSION_SOURCE_LABELS[versionSourceKind(v)] || VERSION_SOURCE_LABELS.system;
    return T(entry[0], entry[1]);
  }

  /** 两版字段级对比：两版全量快照已在渲染层
   *  （versions.list），前端自算任意两版——通道只返回相邻版本对，覆盖
   *  不了"v3 vs 在用 v2"。展示顺序照主进程 CHANGE_ORDER：类型→边界→范围→
   *  正文→证据→标题；无差异明说"内容一致"。
   *  双实现同修：主进程 version-diff.ts 补了 type/scopePolicy 显式
   *  比对与其余快照键的「其他变更」兜底，这里保持同一口径——否则仅改
   *  type/scopePolicy 等字段的版本在渲染层仍谎称"两版内容一致"。 */
  function assetVersionDiffBlock(asset, baseV, targetV) {
    const a = (baseV && baseV.snapshot) || {};
    const b = (targetV && targetV.snapshot) || {};
    const text = (value) => (Array.isArray(value) ? value.join('、') : String(value || '')) || '—';
    const brief = (value) => {
      if (value === undefined || value === null) return '—';
      if (typeof value === 'string') return value || '—';
      const out = JSON.stringify(value, Object.keys(value).sort());
      return out || '—';
    };
    const rows = [
      [T('cognition.detail_future_use', '用途'), text(a.value), text(b.value)],
      [T('cognition.asset_edit_field_applicable', '适用场景'), text(a.applicableWhen), text(b.applicableWhen)],
      [T('cognition.asset_edit_field_forbidden', '禁用场景'), text(a.forbiddenWhen), text(b.forbiddenWhen)],
      [T('cognition.asset_version_diff_scope', '适用范围'), text(a.scope), text(b.scope)],
      [T('cognition.asset_version_diff_scope_policy', '可见范围策略'), brief(a.scopePolicy), brief(b.scopePolicy)],
      [T('cognition.asset_version_diff_statement', '正文'), text(a.statement), text(b.statement)],
      [T('cognition.asset_version_diff_evidence', '证据数量'), String((a.evidenceRefs || []).length), String((b.evidenceRefs || []).length)],
      [T('cognition.asset_version_diff_title_field', '标题'), text(a.title), text(b.title)],
    ].filter((row) => row[1] !== row[2]);
    // 其余快照键兜底（与主进程 EXPLICIT_SNAPSHOT_KEYS 同口径）：version 是
    // 版本号本身，每版必变，不比。
    const explicit = ['title', 'statement', 'value', 'type', 'scope', 'scopePolicy', 'applicableWhen', 'forbiddenWhen', 'evidenceRefs', 'maturity', 'status', 'version'];
    const seen = new Set();
    for (const key of [...Object.keys(a), ...Object.keys(b)]) {
      if (seen.has(key) || explicit.includes(key)) continue;
      seen.add(key);
      const before = brief(a[key]);
      const after = brief(b[key]);
      if (before !== after) rows.push([`${T('cognition.asset_version_diff_other', '其他变更')}·${key}`, before, after]);
    }
    const title = T('cognition.asset_version_diff_line', '版本对比：v{a}（在用） → v{b}', { a: String((baseV && baseV.version) || '?'), b: String((targetV && targetV.version) || '?') });
    if (!rows.length) {
      return `<div class="sect-block ca-version-diff"><div class="tt">${esc(title)}</div><p class="note">${esc(T('cognition.asset_version_diff_same', '两版内容一致。'))}</p></div>`;
    }
    return `<div class="sect-block ca-version-diff">
      <div class="tt">${esc(title)}</div>
      ${rows.map(([label, from, to]) => `<div class="meta-item"><span class="meta-k">${esc(label)}</span><span class="meta-v">${esc(from)} → ${esc(to)}</span></div>`).join('')}
    </div>`;
  }

  /** 单个版本的展开详情：列表行只给 80 字预览，点行看全文与
   * 逐项信息；非在用版就地提供「删除此版本」（真删：物理移除，引用它的
   * 已确认注入在服务端冻结了内容副本）。 */
  /** 适用范围白话化。 */
  function scopeLabelText(raw) {
    const value = String(raw || '');
    if (!value) return T('cognition.asset_scope_unset', '还没设置');
    // 白话映射覆盖中英两种内部写法：
    // 后端 scope 是自由文本，认得出的常见形态翻人话，认不出原样显示。
    const known = { general: T('cognition.capture.scope_general', '跨任务通用'), report: T('cognition.capture.scope_report', '报告'), code: T('cognition.capture.scope_code', '编程'), review: T('cognition.capture.scope_review', '审查与评审'), product: T('cognition.capture.scope_product', '产品工作') };
    if (known[value]) return known[value];
    if (value === 'personal') return T('cognition.asset_scope_personal', '个人对话');
    return value;
  }
  /** 版本快照的来源行：按该版快照的学习信号判定 KSTAR
   *  血统；无信号（会话整理线）不显示——返回空串即可被行渲染跳过。 */
  function snapshotOriginText(signal, provenance) {
    const source = provenance ? 'review'
      : signal && ['review', 'preference_scan'].includes(String(signal.source || '')) ? String(signal.source) : '';
    if (!source) return '';
    return source === 'preference_scan'
      ? T('cognition.asset_origin_pref_scan', '来自偏好扫描')
      : T('cognition.asset_origin_kstar', '来自那次任务的复盘');
  }

  function assetVersionDetailBlock(asset, v, isActive, usage, options = {}) {
    const snap = v.snapshot || {};
    const usageText = usage
      ? [usage.applied ? T('cognition.asset_usage_applied', '模型确认采用 {n} 次', { n: String(usage.applied) }) : '',
        usage.contradicted ? T('cognition.asset_usage_contradicted', '被否定 {n} 次', { n: String(usage.contradicted) }) : '']
        .filter(Boolean).join(' · ')
      : '';
    const evidenceCount = Array.isArray(snap.evidenceRefs) ? snap.evidenceRefs.length : 0;
    const rowHtml = (label, value) => value ? `<div class="meta-item"><span class="meta-k">${esc(label)}</span><span class="meta-v">${esc(String(value))}</span></div>` : '';
    // 对比/合并的目标与基准都在版本链里；diff 就地展开，
    // 合并两版为新版也挂这里——查看与危险操作集中在展开块。
    const versions = (S.assetVersions && S.assetVersions.versions) || [];
    const activeV = versions.find((x) => String(x.version) === String(asset.activeVersion || asset.version));
    const showDiff = String(S.route.assetVersionDiff || '') === String(v.version);
    // 编辑入口只在版本行：每个版本（含在用版）都能
    // 成为编辑起点——在用版直接编辑，历史版先设为在用再编辑（合一步）。
    const editFromBtn = btn(T('cognition.asset_edit_from_version', '基于此版修改'), 'edit-from-version', { id: asset.id, data: { version: String(v.version) }, small: true, primary: true });
    const actions = options.readOnly
      ? (!isActive ? btn(showDiff ? T('cognition.asset_version_diff_hide', '收起对比') : T('cognition.asset_version_diff_show', '与在用版对比'), 'diff-asset-version', { id: asset.id, data: { version: String(v.version) }, small: true }) : '')
      : isActive
      ? `${editFromBtn}<span class="note">${esc(T('cognition.asset_version_active_locked', '当前在用版本不可删除；先选用其他版本，再删除它。'))}</span>`
      : `${editFromBtn}
        ${btn(showDiff ? T('cognition.asset_version_diff_hide', '收起对比') : T('cognition.asset_version_diff_show', '与在用版对比'), 'diff-asset-version', { id: asset.id, data: { version: String(v.version) }, small: true })}
        ${btn(T('cognition.asset_version_merge', '与在用版合并为新版'), 'merge-asset-version', { id: asset.id, data: { version: String(v.version) }, small: true })}
        ${btn(T('cognition.asset_version_delete', '删除此版本'), 'delete-asset-version', { id: asset.id, data: { version: String(v.version) }, danger: true, small: true })}`;
    // 详细信息与证据按版本下沉：范围/怎么来的/证据
    // 本就存于每版快照、各版不同——跟版本走，顶部不再显示资产级副本。
    // 证据 chips 点开「这次任务的经过」也挂块内（展开态走路由，重画不丢）。
    return `<div class="sect-block ca-version-detail">
      <div class="tt">${esc(T('cognition.asset_version_detail_title', '版本详情'))} · v${esc(String(v.version))}</div>
      ${cognitionContentFields(snap)}
      <div class="meta-row">
        ${rowHtml(T('cognition.asset_origin_label', '怎么来的'), snapshotOriginText(snap.learningSignal, snap.learningProvenance))}
        ${rowHtml(T('cognition.asset_version_reason_label', '变更说明'), [versionSourceLabel(v), fmtDate(v.at)].filter(Boolean).join(' · '))}
        ${rowHtml(T('cognition.asset_version_usage_label', '使用效果'), usageText)}
      </div>
      ${evidenceCount ? `${evidenceGroupsHtml(snap.evidenceRefs)}${kstarEpisodeSection(S.route)}` : ''}
      <div class="actions actions-right">${actions}</div>
      ${showDiff && activeV ? assetVersionDiffBlock(asset, activeV, v) : ''}
    </div>`;
  }

  /** 版本链：V1 归入同条目可展开；在用=指针可切换，
   *  「选用此版」走 select-asset-version（内容同步、不产生新版本号）。
   *  守卫 ≥1 版即显示：详细信息和证据都归版本展开
   *  块——单版本资产的证据也要有位置可看。
   *  读失败显式标记 + 重试：
   *  不把「没读到」伪装成「没有版本」。 */
  function assetVersionsSection(asset, options = {}) {
    options = { ...options, readOnly: options.readOnly || !!S.assetsError || !(asset.type === 'cognition' || CATEGORIES.some(([type]) => type === asset.type)) || !['active', 'paused'].includes(asset.status) };
    const state = S.assetVersions;
    if (state && state.assetId === String(asset.id) && state.failed) {
      return `<div class="ca-asset-usage-feedback">
        <p class="note">${esc(T('cognition.asset_versions_failed', '版本记录暂不可用'))}</p>
        ${btn(T('common.retry', '重试'), 'asset-versions-retry', { id: asset.id, small: true })}
      </div>`;
    }
    if (!state || state.assetId !== String(asset.id) || !Array.isArray(state.versions) || state.versions.length < 1) return '';
    const active = String(asset.activeVersion || asset.version || '');
    const usageByVersion = new Map((state.usage || []).map((u) => [String(u.version), u]));
    // 空版本标记：与相邻版内容一字不差的版本（系统迁移垫高/
    // 旧版归并搬运）显示"内容未变"，避免"两版一模一样"被误读为出错。
    const contentKey = (snap) => `${snap.title || ''}\n${snap.statement || ''}`;
    const sortedAsc = [...state.versions].sort((left, right) => Number(left.version) - Number(right.version));
    const unchangedAfter = new Set(sortedAsc.filter((v, i) => i > 0 && contentKey(v.snapshot || {}) === contentKey(sortedAsc[i - 1].snapshot || {})).map((v) => String(v.version)));
    // 来源标签：reason 原文收展开块，行上只给归一化标签。
    // 系统迁移产生的空版本默认折叠：与相邻版一字不差的
    // 迁移垫版本整行隐藏，尾部给展开入口——用户扫版本链时分得清"哪些是
    // 我真的改过、哪些只是系统垫高了号"。
    const isNoiseVersion = (v) => versionSourceKind(v) === 'migration' && unchangedAfter.has(String(v.version));
    const expanded = !!S.route.assetVersionsExpanded;
    const noiseCount = state.versions.filter(isNoiseVersion).length;
    const visibleVersions = expanded ? state.versions : state.versions.filter((v) => !isNoiseVersion(v));
    const rows = [...visibleVersions]
      .sort((left, right) => Number(right.version) - Number(left.version))
      .map((v) => {
        const isActive = String(v.version) === active;
        const title = String((v.snapshot && v.snapshot.title) || asset.title || '');
        const usage = usageByVersion.get(String(v.version));
        const usageText = usage
          ? [usage.applied ? T('cognition.asset_usage_applied', '模型确认采用 {n} 次', { n: String(usage.applied) }) : '',
            usage.contradicted ? T('cognition.asset_usage_contradicted', '被否定 {n} 次', { n: String(usage.contradicted) }) : '']
            .filter(Boolean).join(' · ')
          : '';
        // 内容摘要（用户反馈：两版只显示标题看不出差异，也看不到
        // 具体内容）——正文截 80 字进 meta，标题相同的内容差异由此可辨。
        const statement = String((v.snapshot && v.snapshot.statement) || '').replace(/\s+/g, ' ').trim();
        const statementPreview = statement.length > 80 ? `${statement.slice(0, 80)}…` : statement;
        const meta = [statementPreview, fmtDate(v.at), versionSourceLabel(v), unchangedAfter.has(String(v.version)) ? T('cognition.asset_version_unchanged', '内容未变（系统迁移/搬运）') : '', usageText].filter(Boolean).join(' · ');
        const side = isActive
          ? chip(T('cognition.asset_version_active', '在用'), 'green')
          : `${options.readOnly ? '' : btn(T('cognition.asset_version_select', '切回此版'), 'select-asset-version', { id: asset.id, data: { version: String(v.version) }, small: true })}`;
        // 行可点开：点行就地展开该版本全文详情；再点收起。
        const open = String(S.route.assetVersionId || '') === String(v.version);
        return `<div class="row is-flat is-clickable" data-act="open-asset-version" data-version="${esc(String(v.version))}" ${roleBtn()}>
          <div class="tw"><div class="tt">v${esc(String(v.version))} · ${esc(title)}</div><div class="mm">${esc(meta)}</div></div>
          <div class="sd">${side}</div>
        </div>
        ${open ? assetVersionDetailBlock(asset, v, isActive, usage, options) : ''}`;
      }).join('');
    // 头部「已有更新的版本」下钻已随头部重构移除：版本信息
    // 全部归版本区——每行展开块内本就有「与在用版对比」，头部不再重复。
    const noiseToggle = noiseCount
      ? `<div class="sub">${btn(expanded
        ? T('cognition.asset_versions_noise_hide', '收起系统迁移版本')
        : T('cognition.asset_versions_noise_show', '显示 {n} 条系统迁移产生的空版本', { n: String(noiseCount) }),
      'toggle-asset-versions-noise', { id: asset.id, small: true })}</div>`
      : '';
    return `<div class="sect-block"><div class="tt">${esc(T('cognition.asset_versions_section', '版本记录'))}</div>${rows}${noiseToggle}</div>`;
  }

  /** 可读名称只用于界面；保存策略仍保留稳定 id。已从目录消失的历史目标
   *  以不暴露 id 的占位项留在选择里，用户主动取消后才会移除。 */
  function assetScopeChoiceGroup(asset, kind, label, available, selectedIds, policy, editDraft) {
    const isAgent = kind === 'agent';
    const policyField = isAgent ? 'agentIds' : 'workspaceIds';
    const idField = isAgent ? 'agent_id' : 'space_id';
    const missingLabelKey = isAgent ? 'cognition.asset_scope_missing_agent' : 'cognition.asset_scope_missing_space';
    const missingFallback = isAgent ? '已不可用的旧智能体限制 {n}' : '已不可用的旧工作空间限制 {n}';
    const values = (Array.isArray(available) ? available : [])
      .filter((item) => item && typeof item[idField] === 'string' && item[idField])
      .map((item) => ({ id: String(item[idField]), label: String(item.name || item.displayName || item[idField]) }));
    if (isAgent && !values.some((item) => item.id === 'commander')) {
      values.push({ id: 'commander', label: T('cognition.asset_scope_main_agent', '主助手') });
    }
    const duplicateCounts = new Map();
    values.forEach((item) => duplicateCounts.set(item.label, (duplicateCounts.get(item.label) || 0) + 1));
    const duplicateIndexes = new Map();
    values.sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base', numeric: true })
      || left.id.localeCompare(right.id));
    const knownIds = new Set(values.map((item) => item.id));
    const selected = Array.from(new Set((Array.isArray(selectedIds) ? selectedIds : [])
      .map((id) => String(id || '').trim()).filter(Boolean)));
    const rows = values.map((item, index) => {
      let itemLabel = item.label;
      if ((duplicateCounts.get(item.label) || 0) > 1) {
        const duplicateIndex = (duplicateIndexes.get(item.label) || 0) + 1;
        duplicateIndexes.set(item.label, duplicateIndex);
        itemLabel = `${itemLabel}（${duplicateIndex}）`;
      }
      const controlId = `ca-asset-edit-scope-${kind}-${index}-${esc(asset.id)}`;
      return `<div><label for="${controlId}">${window.uiCheckbox({
        id: controlId, checked: selected.includes(item.id), value: item.id, label: itemLabel,
        attrs: { 'data-scope-kind': kind, 'data-scope-id': item.id },
      })}<span>${esc(itemLabel)}</span></label></div>`;
    });
    const missing = selected.filter((id) => !knownIds.has(id));
    missing.forEach((id, index) => {
      const controlId = `ca-asset-edit-scope-${kind}-missing-${index}-${esc(asset.id)}`;
      const itemLabel = T(missingLabelKey, missingFallback, { n: String(index + 1) });
      rows.push(`<div><label for="${controlId}">${window.uiCheckbox({
        id: controlId, checked: true, value: id, label: itemLabel,
        attrs: { 'data-scope-kind': kind, 'data-scope-id': id },
      })}<span>${esc(itemLabel)}</span></label></div>`);
    });

    const groupId = `ca-asset-edit-scope-label-${kind}-${esc(asset.id)}`;
    const selection = (editDraft && editDraft.scopeSelection) || {};
    const unrestrict = Array.isArray(editDraft && editDraft.scopeUnrestrict) ? editDraft.scopeUnrestrict : [];
    const hasCurrentRestriction = Object.prototype.hasOwnProperty.call(policy || {}, policyField)
      && !unrestrict.includes(kind);
    const selectedForDraft = Object.prototype.hasOwnProperty.call(selection, policyField)
      ? (Array.isArray(selection[policyField]) ? selection[policyField] : []) : policy[policyField];
    const explicitlyDenied = hasCurrentRestriction
      && Array.isArray(policy[policyField]) && policy[policyField].length === 0
      && (!Array.isArray(selectedForDraft) || selectedForDraft.length === 0);
    const deniedNote = explicitlyDenied
      ? `<p class="note">${esc(T('cognition.asset_scope_denied_all', '当前明确禁止任何对象使用这条资产。'))}</p>` : '';
    const restrictionNote = explicitlyDenied
      ? ''
      : hasCurrentRestriction
        ? `<p class="note">${esc(T('cognition.asset_scope_edit_limit_note', '当前有限定范围：仅勾选对象可以使用。至少保留一个；要取消整项限制，请点“取消此项限制”。'))}</p>`
        : unrestrict.includes(kind)
          ? `<p class="note">${esc(T('cognition.asset_scope_unrestrict_pending', '保存后会取消这一项限制；其他范围限制仍会保留。'))}</p>`
          : `<p class="note">${esc(T('cognition.asset_scope_unrestricted_note', '当前不限制此项；勾选后只允许所选对象使用。'))}</p>`;
    const removeRestriction = hasCurrentRestriction
      ? btn(T('cognition.asset_scope_unrestrict', '取消此项限制'), 'asset-scope-unrestrict', {
        id: asset.id, data: { kind, key: `scope-unrestrict-${kind}-${asset.id}` }, small: true,
      }) : '';
    const emptyNote = rows.length ? '' : `<p class="note">${esc(T(
      isAgent ? 'cognition.asset_scope_empty_agents' : 'cognition.asset_scope_empty_spaces',
      isAgent ? '没有可选智能体。' : '没有可选工作空间。',
    ))}</p>`;
    return `<div class="field"><span id="${groupId}">${esc(label)}</span><div role="group" aria-labelledby="${groupId}">${deniedNote}${restrictionNote}${rows.join('')}${emptyNote}${removeRestriction}</div></div>`;
  }

  function assetScopeEditor(asset, editDraft) {
    const options = S.assetScopeOptions || { status: 'idle', agents: [], spaces: [] };
    const policy = asset.scopePolicy && typeof asset.scopePolicy === 'object' ? asset.scopePolicy : {};
    const selection = editDraft.scopeSelection && typeof editDraft.scopeSelection === 'object' ? editDraft.scopeSelection : {};
    const scopeUnrestrict = new Set(Array.isArray(editDraft.scopeUnrestrict) ? editDraft.scopeUnrestrict : []);
    const currentOrDraftSelection = (field, kind) => {
      if (scopeUnrestrict.has(kind)) return Object.prototype.hasOwnProperty.call(selection, field) ? selection[field] : [];
      if (!Object.prototype.hasOwnProperty.call(selection, field)) return policy[field];
      const selected = Array.isArray(selection[field]) ? selection[field] : [];
      // 对现有限制，空草稿不代表取消；保持原选择可见，取消需走明确按钮。
      if (!selected.length && Array.isArray(policy[field]) && policy[field].length) return policy[field];
      return selected;
    };
    const agentIds = currentOrDraftSelection('agentIds', 'agent');
    const workspaceIds = currentOrDraftSelection('workspaceIds', 'space');
    const agentCount = Array.isArray(agentIds) ? agentIds.length : 0;
    const workspaceCount = Array.isArray(workspaceIds) ? workspaceIds.length : 0;
    const hasOtherPolicy = Object.keys(policy).some((key) => !['agentIds', 'workspaceIds'].includes(key));
    const hasAgentLimit = !scopeUnrestrict.has('agent') && (agentCount > 0 || Object.prototype.hasOwnProperty.call(policy, 'agentIds'));
    const hasWorkspaceLimit = !scopeUnrestrict.has('space') && (workspaceCount > 0 || Object.prototype.hasOwnProperty.call(policy, 'workspaceIds'));
    const hasLimit = hasAgentLimit || hasWorkspaceLimit || hasOtherPolicy;
    const summary = hasLimit
      ? T('cognition.asset_scope_summary_limited', '范围有限制（智能体 {agents} 个、工作空间 {spaces} 个）', {
        agents: String(agentCount), spaces: String(workspaceCount),
      })
      : T('cognition.asset_scope_summary_unrestricted', '智能体和工作空间均不限制');
    const status = String(options.status || 'idle');
    let content = '';
    if (status === 'ready') {
      content = `${assetScopeChoiceGroup(
        asset, 'agent', T('cognition.asset_edit_field_visible_agents', '可使用的智能体'),
        options.agents, agentIds, policy, editDraft,
      )}${assetScopeChoiceGroup(
        asset, 'space', T('cognition.asset_edit_field_visible_spaces', '可使用的工作空间'),
        options.spaces, workspaceIds, policy, editDraft,
      )}`;
    } else if (status === 'error') {
      content = `<p class="note">${esc(T('cognition.asset_scope_failed', '列表暂时读取失败。本次仍可保存正文，但不会更改可见范围。'))}</p>
        <div class="actions">${btn(T('cognition.asset_scope_retry', '重试读取'), 'asset-scope-options-retry', { small: true })}</div>`;
    } else {
      content = `<p class="note" role="status">${esc(T('cognition.asset_scope_loading', '正在读取可选智能体和工作空间…'))}</p>`;
    }
    return `<details class="details ca-asset-scope-editor"${hasLimit ? ' open' : ''}>
      <summary>${esc(summary)}</summary>
      <div class="dbody"><p class="note">${esc(T('cognition.asset_scope_other_preserved', '其他限制（如任务用途、文件类型）会原样保留。'))}</p>${content}</div>
    </details>`;
  }

  /** 资产编辑表单：预填在用版现值；保存产生新
   *  版本（core.editAsset 先比对，无实际修改不提交——后端相同内容也会
   *  bump 出空版本）。类型变更走候选线重审；Agent/工作空间限制通过可读名称
   *  多选，底层仍保存稳定 id。 */
  function prototypeScopeEditor(asset, draft) {
    const directory = S.assetScopeOptions || {};
    const ready = directory.status === 'ready';
    const policy = asset.scopePolicy || {};
    const group = (field, kind, label, items, idKey) => {
      const clear = (draft.scopeUnrestrict || []).includes(kind);
      const chosen = draft.scopeSelection?.[field] || policy[field] || [];
      const mode = clear ? 'clear' : draft.scopeSelectionModes?.[field] || 'keep';
      const choices = [...(items || [])];
      let missingIndex = 0;
      for (const id of chosen) if (!choices.some(item => item[idKey] === id)) choices.push({ [idKey]: id, name: T(field === 'agentIds' ? 'cognition.asset_scope_missing_agent' : 'cognition.asset_scope_missing_space', field === 'agentIds' ? '已不可用的旧智能体限制 {n}' : '已不可用的旧工作空间限制 {n}', { n: String(++missingIndex) }) });
      const modeControl = window.uiSelect({ id: `ca-proto-mode-${asset.id}-${field}`, native: true, ariaLabel: label, value: mode, disabled: !ready, options: [
        { value: 'keep', label: T('cognition.prototype_scope_keep', '保持现有限制') },
        { value: 'restrict', label: T('cognition.prototype_scope_restrict', '限制到所选对象') },
        { value: 'clear', label: T('cognition.prototype_scope_clear', '明确移除此维度限制') },
      ], attrs: { 'data-prototype-scope-mode': field, 'data-scope-kind': kind } });
      const selection = window.uiSelect({ id: `ca-proto-multi-${asset.id}-${field}`, native: true, multiple: true, size: 3, ariaLabel: label, value: chosen, disabled: !ready || mode !== 'restrict', options: choices.map(item => ({ value: item[idKey], label: item.name || item[idKey] })), attrs: { 'data-prototype-scope-multi': field } });
      return `<div class="field"><span>${esc(label)}</span>${modeControl}${selection}</div>`;
    };
    return `<p class="note">${esc(T('cognition.prototype_scope_preserve', '不选择不代表解除限制。项目与用途维度保持原样；解除需明确确认。'))}</p>${ready ? '' : `<p role="status">${esc(T('cognition.library_manual_scope_unavailable', '对象目录尚未就绪；当前不能更改对象限制。'))}</p>${btn(T('cognition.asset_scope_retry', '重试读取'), 'asset-scope-options-retry')}`}${group('agentIds', 'agent', T('cognition.prototype_agent', '智能体'), directory.agents, 'agent_id')}${group('workspaceIds', 'space', T('cognition.prototype_workspace', '工作空间'), directory.spaces, 'space_id')}${assetLibraryScopeSection(asset)}`;
  }
  function assetEditForm(asset, options = {}) {
    const fieldHtml = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
    const joinList = (list) => (Array.isArray(list) ? list.join('、') : '');
    const draftId = String(asset.id);
    if (!S.assetEditDrafts?.[draftId]) {
      S.assetEditDrafts = Object.assign({}, S.assetEditDrafts || {}, { [draftId]: {
        baseVersion: String(asset.version), baseActiveVersion: String(asset.activeVersion || asset.version),
      } });
    }
    const editDraft = S.assetEditDrafts[draftId];
    // Freeze the contents the user opened, not only its CAS versions. A later
    // broadcast must never replace an unedited body while the user changes a title.
    if (!editDraft.baseReviewDetails && String(editDraft.baseVersion) === String(asset.version)
      && String(editDraft.baseActiveVersion) === String(asset.activeVersion || asset.version)) {
      editDraft.baseReviewDetails = { statement: String(asset.statement || ''), value: asset.value,
        applicableWhen: [...(asset.applicableWhen || [])], forbiddenWhen: [...(asset.forbiddenWhen || [])] };
      editDraft.baseScopePolicy = JSON.parse(JSON.stringify(asset.scopePolicy || {}));
      for (const [key, value] of Object.entries({ title: String(asset.title || ''), statement: String(asset.statement || ''), value: String(asset.value || ''),
        contentCategory: contentCategoryOf(asset), applicable: joinList(asset.applicableWhen), forbidden: joinList(asset.forbiddenWhen) })) {
        if (!Object.prototype.hasOwnProperty.call(editDraft, key)) editDraft[key] = value;
      }
    }
    const draftValue = (key, fallback) => Object.prototype.hasOwnProperty.call(editDraft, key) ? editDraft[key] : fallback;
    const fid = (name) => `ca-asset-edit-${name}-${esc(asset.id)}`;
    // 边界编辑与 scopePolicy 可见范围收在「高级」折叠，复用候选表单形态。普通
    // 用户只改标题/正文，边界与范围按需展开；折叠内能力不变。
    const boundaryFields = `${fieldHtml(T('cognition.asset_edit_field_applicable', '适用场景（多条用顿号分隔）'), window.uiInput({ id: fid('applicable'), value: String(draftValue('applicable', joinList(asset.applicableWhen)) || ''), attrs: { 'data-f': 'applicable' } }))}
      ${fieldHtml(T('cognition.asset_edit_field_forbidden', '禁用场景（多条用顿号分隔）'), window.uiInput({ id: fid('forbidden'), value: String(draftValue('forbidden', joinList(asset.forbiddenWhen)) || ''), attrs: { 'data-f': 'forbidden' } }))}`;
    const ruleBoundaryVisible = true; // Full detail save reviews both conditions alongside the body.
    const advancedFold = `<details class="details ca-asset-edit-advanced">
      <summary>${esc(T('cognition.library_manual_scope_title', '限定使用对象'))}</summary>
      ${options.compact ? prototypeScopeEditor({ ...asset, scopePolicy: editDraft.baseScopePolicy || asset.scopePolicy }, editDraft) : assetScopeEditor({ ...asset, scopePolicy: editDraft.baseScopePolicy || asset.scopePolicy }, editDraft)}
    </details>`;
    const content = `
      ${editDraft.saveError ? `<p class="warn" role="alert">${esc(String(editDraft.saveError))}</p>` : ''}
      ${editDraft.saveConflict ? `<div class="actions">${btn(T('cognition.library_review_conflict', '核对最新版本'), 'library-review-conflict', { id: asset.id, small: true })}</div>` : ''}
      <p class="note">${esc(T('cognition.asset_edit_hint', '修改内容或适用范围会生成新版本；来源和证据会保留，旧版本也可回滚。'))}</p>
      <p class="note">${esc(T('cognition.asset_edit_review_details_hint', '修改正文或条件后保存，表示你已核对下方完整内容。只改标题或分类不代表再次审阅正文；已有范围和来源规则继续适用。'))}</p>
      ${fieldHtml(options.compact ? T('cognition.prototype_title_required', '标题 *') : T('cognition.asset_edit_field_title', '标题'), window.uiInput({ id: fid('title'), value: String(draftValue('title', asset.title || '') || ''), attrs: { 'data-f': 'title' } }))}
      ${fieldHtml(options.compact ? T('cognition.prototype_content_required', '内容 *') : T('cognition.asset_edit_field_statement', '正文'), window.uiTextarea({ id: fid('statement'), value: String(draftValue('statement', asset.statement || '') || ''), attrs: { 'data-f': 'statement', rows: options.compact ? 9 : 5 } }))}
      ${fieldHtml(T('cognition.detail_future_use', '用途'), window.uiTextarea({ id: fid('value'), value: String(draftValue('value', asset.value || '') || ''), attrs: { 'data-f': 'value', rows: 3, maxlength: 4000 } }))}
      ${fieldHtml(T('cognition.content_category', '分类'), contentCategorySelect(fid('contentCategory'), asset, draftValue('contentCategory', contentCategoryOf(asset))))}
      ${ruleBoundaryVisible ? boundaryFields : ''}
      ${advancedFold}<span class="note" data-library-dirty-marker${S.libraryView?.dirty ? '' : ' hidden'}>${esc(T('cognition.prototype_unsaved_marker', '有未保存修改'))}</span>`;
    const actions = `
        ${btn(T('common.cancel', '取消'), 'asset-edit-cancel', { id: asset.id })}
        ${btn(options.compact ? T('cognition.prototype_save_version', '保存新版本') : T('cognition.asset_edit_save', '保存为新版本'), 'asset-edit-save', { id: asset.id, primary: true })}`;
    if (options.compact) return `<div class="ca-asset-page ca-library-asset-detail ca-asset-edit" data-asset-edit-id="${esc(asset.id)}">
      <header class="ca-library-detail-head ca-detail-head"><div class="ca-library-detail-title"><h2>${esc(T('cognition.prototype_edit_title', '修改认知'))}</h2>${btn(T('common.close', '关闭'), 'asset-edit-cancel', { id: asset.id, small: true })}</div><p class="note">${esc(T('cognition.library_edit_base', '基于在用版本 v{n}', { n: String(editDraft.baseActiveVersion || asset.activeVersion || asset.version || '') }))}</p></header>
      <div class="ca-library-detail-body ca-detail-body">${content}</div><footer class="ca-library-detail-footer ca-detail-footer">${actions}</footer>
    </div>`;
    return `<div class="sect-block ca-asset-edit" data-asset-edit-id="${esc(asset.id)}">
      <div class="tt">${esc(T('cognition.asset_edit_title', '编辑资产'))}</div>${content}
      <div class="actions actions-right">${actions}</div>
    </div>`;
  }

  function assetDetail(asset, route, options = {}) {
    // 编辑态：正文区替换为编辑表单——改自己写的
    // 话不该以"系统先产候选"为前提；保存走 recall.assets.update（+1 版本，
    // 与候选采纳产出的版本同链）。类型变更走候选线重审；范围由可读名称
    // 选择，不要求用户输入内部 id。
    // 资产级状态与开关贴着标题：标题右侧
    // 放总开关、标题下方一句实时生效说明——资产级信息归顶部（正文是内容、
    // 不是状态说明的挂载点）。异常态（删除/归并）仍走下方独立块。
    const verifiedAsset = (asset.type === 'cognition' || CATEGORIES.some(([type]) => type === asset.type)) && ['active', 'paused', 'archived', 'deleted', 'revoked', 'purged'].includes(String(asset.status || ''));
    const editing = !!route.assetEdit && verifiedAsset && !S.assetsError && ['active', 'paused'].includes(String(asset.status || ''));
    if (editing && options.compact) return assetEditForm(asset, options);
    const statusKind = String(asset.status || '');
    const statusOn = statusKind === 'active';
    const switchable = verifiedAsset && (statusKind === 'active' || statusKind === 'paused');
    const switchEl = window.uiSwitch({
      label: T('cognition.asset_switch_label', '允许后续任务使用'),
      checked: statusOn,
      attrs: {
        'data-act': 'asset-action',
        'data-id': asset.id,
        'data-action': statusOn ? 'pause' : 'resume',
      },
    });
    const switchHint = statusOn
      ? T('cognition.asset_switch_on_hint', '已启用：符合当前任务、范围和来源规则时，后续任务会向模型展示简短目录，模型可按需读取正文。')
      : T('cognition.asset_switch_off_hint', '已暂停：这条资产不会出现在后续任务的目录中，也不能被读取；历史和使用记录仍保留，可随时恢复。');
    const topControl = statusKind === 'deleted'
      ? `<div class="sect-block"><p class="note">${esc(T('cognition.asset_deleted_hint', '已删除的资产在保留期内可恢复；恢复后重新出现在常用资产。'))}</p><div class="actions">${btn(T('cognition.asset_restore_deleted', '恢复'), 'asset-action', { id: asset.id, data: { action: 'restore' }, primary: true, small: true })}</div></div>`
      : statusKind === 'archived'
        ? `<div class="sect-block"><p class="note">${esc(asset.mergedInto ? T('cognition.asset_archived_note', '已归并：这条资产已并入另一条资产，历史版本完整保留在并入目标的版本记录中。') : T('cognition.asset_archived_unavailable', '已归档：这条认知不会供后续任务使用，来源与历史仍可查看。'))}</p></div>`
        : '';
    // 详细信息与证据已按版本下沉：范围/怎么来的/证据
    // 各版不同、存于各版快照——归版本展开块显示，顶部不再放资产级副本。
    const moreRow = (label, hint, action) => `
      <div class="ca-more-row">
        <div class="ca-more-copy"><strong>${esc(label)}</strong><span>${esc(hint)}</span></div>
        ${btn(label, 'asset-action', { id: asset.id, data: { action }, danger: true, small: true })}
      </div>`;
    /* 正文、来历、使用各有明确入口；版本和治理保持按需展开，不丢原有能力。 */
    /* 来历：来源会话 chip、那次任务的复盘 chip——可点回。解析一律
     * 走唯一解析器 + 唯一呈现出口；
     * legacy 字符串形态的来源先归一成 {id} 再解析。 */
    const refs = (asset.evidenceRefs || [])
      .map((ref) => ((ref && typeof ref === 'object') ? ref : { id: String(ref || '') }))
      .filter((ref) => String(ref.id || '').trim());
    /* 来历保留原始引用数量；分组展示会合并同名来源，不能让裸数字看起来像
     * 页面上可点击 chip 的数量。 */
    const originSection = `<div class="card ca-detail-origin">
      <div class="ca-asset-section-head"><h2>${esc(T('cognition.asset_origin_section', '来历'))}</h2>${refs.length ? `<span class="note">${esc(T('cognition.asset_origin_count', '{n} 条来源记录', { n: String(refs.length) }))}</span>` : ''}</div>
      ${refs.length ? evidenceGroupsHtml(refs) : `<div class="sub">${esc(T('cognition.asset_origin_empty', '没有可追溯的来源记录。'))}</div>`}
    </div>`;
    /* 用过吗：被任务用过 N 次 · 其中模型
     * 确认采用 M 次（无采用回执时省略后半句）· 最近一次 {when}。口径零改动：
     * 被任务用过＝broughtInCountFor 唯一公式（原「被带入」），模型确认采用＝
     * applied 回执（原「实际采用」）；逐条明细在「详情与历史」折叠区。 */
    const detailProofs = assetProofItems(asset.id);
    const realProofs = taskExposureProofs(asset.id, detailProofs)
      .sort((left, right) => String(right.occurredAt || '').localeCompare(String(left.occurredAt || '')));
    const lastProof = realProofs[0] || null;
    const timelineState = S.assetTimeline && String(S.assetTimeline.assetId || '') === String(asset.id)
      ? S.assetTimeline : null;
    const receiptState = S.adoptionReceipts && String(S.adoptionReceipts.assetId || '') === String(asset.id)
      ? S.adoptionReceipts : null;
    const receipts = receiptState && Array.isArray(receiptState.items) ? receiptState.items : [];
    const appliedCount = receipts.filter((r) => String(r.status || '') === 'applied').length;
    const broughtIn = broughtInCountFor(asset.id, detailProofs);
    const timelinePending = (!timelineState || timelineState.loading) && !realProofs.length;
    const timelineFailed = !!(timelineState && timelineState.failed);
    const receiptPending = !receiptState || receiptState.loading;
    const receiptFailed = !!(receiptState && receiptState.failed);
    const lastRef = lastProof
      ? ((lastProof.refs || {}).conversationId
        ? { kind: 'conversation', id: String(lastProof.refs.conversationId) }
        : String((lastProof.refs || {}).episodeId || '').startsWith('kse-') ? { kind: 'execution', id: String(lastProof.refs.episodeId) } : null)
      : null;
    const usedSection = `<div class="ca-asset-usage">
      <div class="ca-asset-section-head"><h2>${esc(T('cognition.asset_used_section', '用过吗'))}</h2></div>
      <div class="ca-asset-usage-facts">
        <div class="ca-asset-usage-fact">
          <strong>${esc(timelineFailed
            ? T('cognition.asset_usage_failed_short', '使用记录暂不可用')
            : timelinePending
              ? T('cognition.asset_usage_loading', '使用记录读取中…')
              : T('cognition.proof_projected_times', '带入或读取 {n} 次', { n: String(broughtIn) }))}</strong>
        </div>
        <div class="ca-asset-usage-fact">
          <strong>${esc(receiptFailed
            ? T('cognition.asset_adoption_failed_short', '采用记录暂不可用')
            : receiptPending
              ? T('cognition.asset_adoption_loading', '采用记录读取中…')
              : T('cognition.adoption_applied_times', '其中模型确认采用 {n} 次', { n: String(appliedCount) }))}</strong>
        </div>
      </div>
      ${timelineFailed ? `<div class="ca-asset-usage-feedback">${btn(T('common.retry', '重试'), 'asset-timeline-retry', { id: asset.id, small: true })}</div>` : ''}
      ${receiptFailed ? `<div class="ca-asset-usage-feedback">${btn(T('common.retry', '重试'), 'asset-adoption-retry', { id: asset.id, small: true })}</div>` : ''}
      ${!timelinePending && !timelineFailed && !broughtIn && !appliedCount ? `<p class="note">${esc(T('cognition.asset_no_proofs_section', '还没有被真实使用过。资产在任务中被真正使用、并留下可核对的记录后，会出现在这里。'))}</p>` : ''}
      ${lastProof ? `<div class="ca-asset-last-use"><span class="note">${esc(T('cognition.asset_last_used_at', '最近带入或读取 {when}', { when: fmtDate(lastProof.occurredAt) }))}</span>${lastRef ? evidenceChip(lastRef) : ''}</div>` : ''}
      ${!timelinePending && !timelineFailed && broughtIn ? `<p class="note ca-asset-usage-note">${esc(T('cognition.asset_usage_metric_note', '前者记录任务中带入或读取等痕迹；真正采用只计模型确认的回执。'))}</p>` : ''}
    </div>`;
    /* 状态章始终展示类型和生效状态。 */
    const currentVersion = String(asset.activeVersion || asset.version || '').trim();
    const factsLine = `<div class="sub ca-detail-facts">

      ${assetStatusChip(asset)}
      ${currentVersion && switchable ? `<span class="ca-asset-version-label">${esc(T('cognition.asset_current_version', '在用版本 v{n}', { n: currentVersion }))}</span>` : ''}
    </div>`;
    const applicable = (Array.isArray(asset.applicableWhen) ? asset.applicableWhen : [])
      .map((value) => String(value || '').trim()).filter(Boolean);
    const forbidden = (Array.isArray(asset.forbiddenWhen) ? asset.forbiddenWhen : [])
      .map((value) => String(value || '').trim()).filter(Boolean);
    const boundarySection = applicable.length || forbidden.length
      ? `<section class="ca-asset-boundaries" aria-label="${esc(T('cognition.asset_boundary_section', '使用边界'))}">
          <h3>${esc(T('cognition.asset_boundary_section', '使用边界'))}</h3>
          ${applicable.length ? `<div class="ca-asset-boundary"><span>${esc(T('cognition.asset_version_applicable', '适用场景'))}</span><p>${esc(applicable.join('；'))}</p></div>` : ''}
          ${forbidden.length ? `<div class="ca-asset-boundary"><span>${esc(T('cognition.asset_version_forbidden', '禁用场景'))}</span><p>${esc(forbidden.join('；'))}</p></div>` : ''}
        </section>`
      : '';
    /* 「详情与历史」折叠区＝④怎么被用的明细：版本历史在前，使用明细在后。
     * 标签、归并和生命周期记录放在侧栏「更多操作」。默认收起，内容保留。 */
    /* 版本计数挂上折叠标题：默认收起
     * 又无计数，多版本资产的演化链从外面完全不可见。计数＝版本流里的真实
     * 版本数（S.assetVersions 已补拉时）；补拉未回或单版本时不挂数字。 */
    const versionCount = (S.assetVersions && String(S.assetVersions.assetId) === String(asset.id)
      && Array.isArray(S.assetVersions.versions) && S.assetVersions.versions.length > 1)
      ? S.assetVersions.versions.length : null;
    const historyFold = foldBlock(
      T('cognition.asset_history_fold', '使用与版本'),
      versionCount,
      T('cognition.asset_history_fold_hint', '版本历史、使用明细、采用记录与排序依据都在这里，内容一样全。'),
      `${assetVersionsSection(asset)}${assetUsageSection(asset, route)}${assetRankingWhySection(asset)}${assetAdoptionSection(asset)}`,
      'ca-detail-history',
    );
    const recommendWarn = (() => {
      /* 推荐卡（告警位，紧贴页头）：recommendedAction 数据存在时渲染。 */
      const ra = asset.recommendedAction;
      if (!ra || !['active', 'paused'].includes(String(asset.status || ''))) return '';
      const label = ra === 'pause'
        ? T('cognition.asset_recommend_pause', '系统建议暂停使用这条资产')
        : T('cognition.asset_recommend_rework', '系统建议返工这条资产');
      const reason = asset.recommendationReason || '';
      const btnHtml = btn(T('cognition.asset_recommend_ack', '知道了'), 'asset-recommend-ack', { id: asset.id, small: true });
      return `<div class="warn" style="display:flex;align-items:flex-start;gap:9px">
          <div style="flex:1"><b>${esc(label)}</b>
            <div class="note" style="margin-top:3px">${esc(T('cognition.asset_recommend_reason', '原因'))}：${esc(reason)}</div></div>
          ${btnHtml}</div>`;
    })();
    const lifecycleBlock = (() => {
      /* 审计履历块：auditRows.slice(0,12) + 超限提示。动作标签显式列全
       * （与 asset-service.ts::AbilityAssetAuditRecord 的 action 联合类型
       * 一一对应），i18n 覆盖门禁按 T() 调用点扫描，动态拼键扫不到。 */
        const AUDIT_ACTION_LABELS = {
          created: T('cognition.audit_created', '创建'),
          updated: T('cognition.audit_updated', '更新内容'),
          paused: T('cognition.audit_paused', '暂停使用'),
          resumed: T('cognition.audit_resumed', '恢复使用'),
          revoked: T('cognition.audit_revoked', '撤回使用'),
          archived: T('cognition.audit_archived', '归档'),
          deleted: T('cognition.audit_deleted', '删除'),
          purged: T('cognition.audit_purged', '彻底清除'),
          restored: T('cognition.audit_restored', '恢复删除'),
          rolled_back: T('cognition.audit_rolled_back', '版本回滚'),
          version_selected: T('cognition.audit_version_selected', '切换在用版本'),
          version_deleted: T('cognition.audit_version_deleted', '删除版本'),
          merged_from: T('cognition.audit_merged_from', '归并来源'),
          merged_into: T('cognition.audit_merged_into', '归并入'),
          maturity_downgraded: T('cognition.audit_maturity_downgraded', '成熟度降档'),
          maturity_advanced: T('cognition.audit_maturity_advanced', '成熟度升档'),
          maturity_corrected: T('cognition.audit_maturity_corrected', '成熟度修正'),
          pause_recommended: T('cognition.audit_pause_recommended', '系统建议暂停'),
          rework_recommended: T('cognition.audit_rework_recommended', '系统建议返工'),
          recommendation_cleared: T('cognition.audit_recommendation_cleared', '推荐已确认'),
          cross_scope_confirmed: T('cognition.audit_cross_scope_confirmed', '跨范围确认'),
          cross_scope_withdrawn: T('cognition.audit_cross_scope_withdrawn', '跨范围撤回'),
          // 资产管家安全网。
          danger_snapshot: T('cognition.audit_danger_snapshot', '危险操作前留档'),
          danger_confirmed: T('cognition.audit_danger_confirmed', '危险操作已确认'),
          danger_denied: T('cognition.audit_danger_denied', '危险操作未确认'),
          attempt_blocked: T('cognition.audit_attempt_blocked', '操作被拦下'),
          // 审批提议族的审计行（AI 提议/确认/拒绝/稍后/编辑）。
          approval_proposed: T('cognition.audit_approval_proposed', 'AI 提议变更'),
          approval_confirmed: T('cognition.audit_approval_confirmed', '提议已确认'),
          approval_rejected: T('cognition.audit_approval_rejected', '提议已拒绝'),
          approval_deferred: T('cognition.audit_approval_deferred', '提议稍后处理'),
          approval_edited: T('cognition.audit_approval_edited', '卡片内容被编辑'),
        };
        /* 台账四项：谁（actor）/ 何时（at）/ 前后值 / 依据，
         * 四项都要在界面上看得见——只给一句"更新内容"等于没账。 */
        const AUDIT_ACTOR_LABELS = {
          user: T('cognition.audit_actor_user', '你'),
          ai: T('cognition.audit_actor_ai', 'AI'),
          system: T('cognition.audit_actor_system', '系统'),
        };
        // 台账来自版本链读口（同一个资产、同一次拉取）。此前只认 asset.audit，
        // 而那个字段从来没有被赋过值——这一整块审计区是死的。
        const auditRows = Array.isArray(asset.audit) && asset.audit.length
          ? asset.audit
          : (S.assetVersions && String(S.assetVersions.assetId) === String(asset.id) && Array.isArray(S.assetVersions.audit)
            ? S.assetVersions.audit
            : []);
        const rows = auditRows.slice(0, 12);
        if (!rows.length) return '';
        const items = rows.map(function (row) {
          const label = AUDIT_ACTION_LABELS[String(row.action)] || String(row.action);
          const actor = AUDIT_ACTOR_LABELS[String(row.actor || '')] || '';
          // 依据取 `reason`（权威字段）优先、`note` 兜底：写入时两者同源，但只认
          // note 会让"有 reason 没有 note"的记录在界面上丢掉依据。
          const basis = row.reason || row.note;
          const note = basis ? ' · ' + esc(String(basis)) : '';
          const head = (actor ? esc(actor) + ' · ' : '') + '<b>' + esc(label) + '</b>' + note;
          // 前后值摘要（台账四项之一）：正文类字段在服务端已截成"字数·前缀"，
          // 这里只负责显示，不做二次加工。
          const change = (row.before || row.after)
            ? '<div class="sub">' + esc(String(row.before || '—')) + ' → ' + esc(String(row.after || '—')) + '</div>'
            : '';
          // 行内「回滚到这次改动前」已删：与版本区
          // 「切回此版」功能重叠且 0 使用。想回到某次改动前的内容，走版本
          // 区的「切回此版」（rollbackAnchor 数据仍在服务端，只是不再出按钮）。
          return '<div class="proc-row"><span class="when">' + esc(fmtDate(row.at)) + '</span>'
            + '<span style="flex:1">' + head + change + '</span></div>';
        }).join('');
        const tip = auditRows.length > 12
          ? '<div class="note" style="margin-top:6px">' + esc(T('cognition.audit_truncated', '仅显示最近 12 条；真实环境由审计流提供完整履历。')) + '</div>'
          : '';
        /* 详情重构：台账不再自撑一个折叠——并入右栏「治理与历史」
         * 折叠体（三处折叠收敛为两处：主栏「使用与版本」＋右栏「治理与历史」）。 */
        return `<div class="sect-block"><div class="tt">${esc(T('cognition.audit_section', '生命周期记录'))}</div>${items}${tip}</div>`;
      })();
    /* 正式资产详情统一单列：内容、来历、使用、版本、管理各占一行。
     * 长正文和台账共用阅读宽度，窄窗仅收紧内边距，不改变区块顺序。 */
    const governanceFold = foldBlock(
      T('cognition.asset_governance_fold', '治理与历史'),
      null,
      T('cognition.asset_governance_fold_hint', '标签、与另一条合并、生命周期台账都在这里。'),
      `${assetMergeSection(asset)}${lifecycleBlock}`,
      'ca-detail-governance',
    );
    const dangerActions = `${switchable ? moreRow(T('cognition.asset_delete', '删除'), T('cognition.asset_delete_hint', '从资产列表移除，历史记录保留'), 'delete') : ''}
      ${statusKind !== 'purged' ? moreRow(T('cognition.asset_purge', '彻底清除'), T('cognition.asset_purge_hint', '删除全部历史与证据，不可恢复'), 'purge') : ''}`;
    if (options.compact) {
      const mutationReady = !S.assetsError && S.assetCapabilities?.versionedUpdate === true;
      const more = switchable && mutationReady ? assetMergeSection(asset) : '';
      S.libraryDialogBodies = { assetId: asset.id, records: `${usedSection}${assetUsageSection(asset, route)}${assetAdoptionSection(asset)}${lifecycleBlock}`, merge: more };
      const deletedState = S.deletedAssets;
      const deletedRecord = !deletedState?.loading && !deletedState?.stale && Array.isArray(deletedState?.items)
        ? deletedState.items.find(item => String(item.id) === String(asset.id)) : null;
      const restoreAllowed = !!deletedRecord && deletedRecord.retentionUnknown === false
        && typeof deletedRecord.retentionDaysLeft === 'number' && deletedRecord.retentionDaysLeft > 0 && deletedRecord.restorable === true;
      const restoreHint = !deletedRecord ? T('cognition.library_restore_reading', '尚未读到有效的删除保留期记录，请刷新读取后再恢复。')
        : deletedRecord.retentionUnknown ? T('cognition.library_restore_unknown', '删除时间无法核实，暂时不能恢复。')
          : restoreAllowed ? T('cognition.library_restore_days', '保留期还剩 {n} 天。', { n: String(deletedRecord.retentionDaysLeft) })
            : T('cognition.library_restore_expired', '已超过保留期，不能恢复。');
      const placeholders = [...new Set(String(asset.statement || '').match(/\{\{[^{}\r\n]+\}\}/g) || [])];
      const typeHint = asset.type === 'template' && placeholders.length ? `<p class="note ca-prototype-notice ca-library-template-slots">${esc(T('cognition.prototype_template_notice', '可填写字段：{slots}', { slots: placeholders.length ? placeholders.join('、') : T('cognition.prototype_no_slots', '此模板未定义槽位') }))}</p>`
        : asset.type === 'skill_method' ? `<p class="note">${esc(T('cognition.library_method_note', '这里保存方法与步骤；内容说明不代表已安装可执行技能。'))}</p>` : '';
      const organizationId = asset.organizationArchivedBy || asset.contentOrganizationId;
      const lineageIds = asset.organizationResultIds || (asset.contentOrganizationId ? asset.derivedFrom || [] : []);
      const lineage = organizationId ? `<section class="ca-library-related"><h3>${esc(T('cognition.organization_lineage', '整理来源与去向'))}</h3>${lineageIds.map(id => btn(S.assets.find(item => item.id === id)?.title || id, 'open-asset', { id, small: true })).join('')}${btn(T('cognition.organization_record', '查看整组处理记录与撤销'), 'open-candidate', { id: organizationId, small: true })}</section>` : '';
      const referencesAsset = item => String(item.id) === String(organizationId || '') || item.contentOrganization?.draft.sourceAssetIds.includes(asset.id) || String(item.promotedAssetId || '') === String(asset.id)
        || String(item.id || '') === String(asset.candidateId || '')
        || (Array.isArray(asset.sourceCandidateIds) && asset.sourceCandidateIds.some(id => String(id) === String(item.id)))
        || String(item.targetAssetId || '') === String(asset.id)
        || String(item.mergedIntoAssetId || '') === String(asset.id)
        || String(item.assetId || '') === String(asset.id)
        || (Array.isArray(item.assetIds) && item.assetIds.some(id => String(id) === String(asset.id)))
        || (Array.isArray(item.pair) && item.pair.some(id => String(id) === String(asset.id)));
      const relatedCandidates = (S.candidates || []).filter(item => referencesAsset(item) && NS.candidate?.awaiting(item)
        && !['confirmed', 'integrated', 'rejected', 'ignored', 'expired', 'superseded'].includes(String(item.status || '')));
      const relatedInbox = (S.inbox || []).filter(item => referencesAsset(item) && !['resolved', 'rejected', 'ignored', 'closed'].includes(String(item.status || '')));
      const formationCandidates = (S.candidates || []).filter(item => referencesAsset(item) && ['confirmed', 'integrated'].includes(String(item.status || '')));
      const formationSection = formationCandidates.length ? `<section class="ca-library-related"><h3>${esc(T('cognition.library_formation_records', '形成与保存记录'))}</h3>${formationCandidates.map(item => btn(item.summary || item.judgment || T('cognition.activity_check', '需要核对'), 'open-candidate', { id: item.id, className: 'rnm', small: true })).join('')}</section>` : '';
      const relatedSection = relatedCandidates.length || relatedInbox.length ? `<section class="ca-library-related"><h3>${esc(T('cognition.library_related_changes', '相关待确认变化'))}</h3>${relatedCandidates.map(item => btn(item.summary || item.judgment || T('cognition.activity_check', '需要核对'), 'open-candidate', { id: item.id, className: 'rnm', small: true })).join('')}${relatedInbox.map(item => btn(item.title || item.summary || T('cognition.activity_check', '需要核对'), 'library-open-inbox', { id: item.id, className: 'rnm', small: true })).join('')}</section>` : '';
      const leftActions = asset.organizationArchivedBy ? btn(T('cognition.organization_restore_group', '到处理记录撤销整组整理'), 'open-candidate', { id: asset.organizationArchivedBy }) : statusKind === 'deleted'
        ? btn(T('cognition.asset_restore_deleted', '恢复'), 'asset-action', { id: asset.id, data: { action: 'restore' }, primary: true, disabled: !verifiedAsset || !restoreAllowed || !!S.assetsError })
        : switchable ? `${btn(T('cognition.prototype_edit', '修改'), 'edit-asset', { id: asset.id, primary: true, disabled: !mutationReady })}${mutationReady ? btn(T('cognition.prototype_merge', '版本归组'), 'library-show-merge', { id: asset.id }) : ''}` : '';
      const rightActions = switchable && !S.assetsError ? `${btn(T(statusOn ? 'cognition.asset_pause' : 'cognition.asset_resume', statusOn ? '暂停使用' : '恢复使用'), 'asset-action', { id: asset.id, data: { action: statusOn ? 'pause' : 'resume' } })}${btn(T('cognition.asset_delete', '删除'), 'asset-action', { id: asset.id, data: { action: 'delete' }, className: 'd' })}` : '';
      return window.uiCard({ tag: 'div', readonly: true, className: 'ca-asset-page ca-library-asset-detail', attrs: { 'data-library-asset-id': asset.id }, bodyHtml: `
        <header class="ca-library-detail-head ca-detail-head"><div class="ca-library-detail-title"><h2>${esc(asset.title || asset.id)}</h2>${detailTitleActions({ expandAct: options.presentation === 'expanded' ? '' : 'library-expand', closeAct: options.presentation === 'expanded' ? 'library-expand-close' : 'library-close' })}</div><div class="ca-library-facts">${window.uiTag({ label: contentCategoryLabel(asset) })}${chip(!verifiedAsset ? T('cognition.asset_status_unknown', '状态未知') : statusKind === 'active' ? T('cognition.library_active', '启用') : statusKind === 'paused' ? T('cognition.library_paused', '暂停') : statusKind === 'deleted' ? T('cognition.library_deleted', '已删除') : statusKind === 'archived' ? (asset.mergedInto ? T('cognition.library_merged', '已归并') : T('cognition.library_archived', '归档')) : statusKind === 'revoked' ? T('cognition.asset_status.revoked', '已撤回') : statusKind === 'purged' ? T('cognition.asset_status.purged', '已清除') : T('cognition.asset_status_unknown', '状态未知'), 'line')}<span class="note">${esc(T(switchable ? 'cognition.prototype_active_version' : 'cognition.library_saved_version', switchable ? '在用 v{n}' : '保存版本 v{n}', { n: String(asset.activeVersion || asset.version || T('cognition.activity_version_unknown', '版本未记录')) }))}</span></div></header>
        <div class="ca-library-detail-body ca-detail-body">
          ${topControl && statusKind !== 'deleted' ? topControl : ''}${recommendWarn}${!verifiedAsset ? `<p class="note" role="alert">${esc(T('cognition.library_invalid_readonly', '这条记录的类型或状态无法核对，未计入正式库；当前仅可查看原文与记录。'))}</p>` : ''}${S.assetsError ? `<p class="note" role="alert">${esc(T('cognition.library_stale_readonly', '当前显示上次读取的内容；请刷新核对后再修改。'))}</p>` : ''}
          ${cognitionContentFields(asset, { part: 'body' })}${typeHint}
          ${cognitionContentFields(asset, { part: 'boundary', omitUseHint: true })}
          ${cognitionSources(asset.evidenceRefs, 'asset:' + asset.id, { listDetail: true })}
          ${cognitionRelated(asset)}
          ${switchable && !mutationReady && !S.assetsError ? `<p class="note">${esc(T('cognition.library_restart_hint', '当前后台版本较旧，重启 CogSeed 后可修改内容。'))}</p>` : ''}
          ${cognitionHistory(`<div class="ca-library-deep-links">${btn(T('cognition.library_sources', '来源与证据'), 'library-show-sources', { id: asset.id })}${btn(T('cognition.library_versions', '版本与比较'), 'library-show-versions', { id: asset.id })}${btn(T('cognition.library_records', '使用与管理记录'), 'library-show-records', { id: asset.id })}</div>${lineage}${formationSection}${relatedSection}${assetUsageSection(asset, route)}`)}
          ${statusKind === 'deleted' ? `<p class="note" role="status">${esc(restoreHint)}</p>` : ''}
        </div>
        <footer class="ca-library-detail-footer ca-detail-footer">${leftActions ? `<div class="ca-library-footer-left">${leftActions}</div>` : ''}${rightActions ? `<div class="ca-library-footer-right">${rightActions}</div>` : ''}</footer>
      ` });
    }
    return `<div class="ca-asset-page">
      ${btn(T('cognition.asset_back', '← 返回列表'), 'go-back', { className: 'backlink' })}
      <header class="ca-detail-head ca-asset-head">
        ${factsLine}
        <div class="ca-asset-title-row">
          <h1>${esc(asset.title || asset.id)}</h1>
          <div class="ca-asset-head-actions">
            ${switchable && !editing ? btn(T('cognition.asset_edit_action', '修改内容'), 'edit-asset', { id: asset.id, small: true }) : ''}
          </div>
        </div>
        ${switchable ? `<div class="ca-asset-availability"><div><strong>${esc(T('cognition.asset_switch_label', '允许后续任务使用'))}</strong><p>${esc(switchHint)}</p></div>${switchEl}</div>` : ''}
      </header>
      <div class="ca-asset-stack">
        <section class="card ca-asset-detail">
          ${topControl}
          ${recommendWarn}
          ${editing ? assetEditForm(asset) : `<div class="ca-asset-section-head"><h2>${esc(T('cognition.asset_content_section', '内容'))}</h2></div><p class="content-text ca-asset-body">${esc(asset.statement || T('cognition.asset_content_empty', '这条资产还没有正文。'))}</p>${boundarySection}`}
        </section>
        ${originSection}
        <section class="card ca-asset-usage-card">${usedSection}</section>
        ${historyFold}
        <section class="card ca-asset-manage-card">
          <div class="ca-asset-section-head"><h2>${esc(T('cognition.asset_manage_section', '管理'))}</h2></div>
          ${governanceFold}
          ${dangerActions.trim() ? `<div class="ca-more-wrap">
            ${btn(T('cognition.asset_more', '更多操作'), 'toggle-asset-more', { className: 'ca-more-toggle', attrs: { 'aria-expanded': 'false', 'aria-controls': `ca-asset-more-${asset.id}` } })}
            <div class="ca-more" id="ca-asset-more-${esc(asset.id)}" data-asset-more hidden>${dangerActions}</div>
          </div>` : ''}
        </section>
      </div>
    </div>`;
  }

  function detailTitleActions(options = {}) {
    const buttons = [];
    if (options.expandAct && typeof window.uiIconButton === 'function') {
      buttons.push(window.uiIconButton({
        icon: 'expand-detail', label: T('cognition.detail_expand', '展开详情'), size: 'sm',
        attrs: { 'data-act': options.expandAct },
      }));
    }
    if (options.closeAct && typeof window.uiIconButton === 'function') {
      buttons.push(window.uiIconButton({
        icon: 'x', label: T('common.close', '关闭'), size: 'sm',
        attrs: { 'data-act': options.closeAct },
      }));
    }
    return `<div class="ca-detail-title-actions">${buttons.join('')}</div>`;
  }
  // Both pages render the same version-owned content; actions remain page-owned.
  function cognitionContentFields(content, options = {}) {
    const missing = T('cognition.activity_not_recorded', '未记录');
    const controls = options.controls || {};
    const text = value => Array.isArray(value) ? value.join('；') || missing : String(value || missing);
    const value = (key, className = '') => controls[key] || `<p class="content-text ${className}">${esc(text(content[key]))}</p>`;
    const section = (label, html, cls = '') => `<section class="ca-library-content ${cls}"><h3>${esc(label)}</h3>${html}</section>`;
    const part = options.part || 'all';
    const body = section(T(options.ontologyOnly ? 'cognition.ontology_proposal_description' : 'cognition.asset_content_section', options.ontologyOnly ? '完整变更说明' : '内容'), value('statement', 'ca-asset-body'))
      + section(T('cognition.detail_future_use', '用途'), options.ontologyOnly && !content.value ? `<p>${esc(T('cognition.detail_not_applicable', '不适用'))}</p>` : value('value'));
    const boundary = `<section class="ca-prototype-boundaries"><h3>${esc(T('cognition.asset_boundary_section', '使用边界'))}</h3>
        ${options.omitUseHint ? '' : `<p class="note">${esc(T('cognition.library_use_hint', '启用不代表所有任务自动使用；仍需满足范围、来源与任务条件。'))}</p>`}
        ${controls.scope ? `<div class="field"><span>${esc(T('cognition.library_scope', '使用范围'))}</span>${controls.scope}</div>` : assetLibraryScopeSection(content)}
        <dl><dt>${esc(T('cognition.detail_conditions', '适用条件'))}</dt><dd>${value('applicableWhen')}</dd>
        <dt>${esc(T('cognition.detail_exceptions', '禁止与例外'))}</dt><dd>${value('forbiddenWhen')}</dd></dl></section>`;
    if (part === 'body') return body;
    if (part === 'boundary') return boundary;
    return body + boundary;
  }
  function detailFoldSection(key, label, html, options = {}) {
    return `<details class="details ${esc(options.className || '')}" data-detail-fold-key="${esc(key)}"${options.open ? ' open' : ''}><summary>${esc(label)}</summary>${html}</details>`;
  }
  function cognitionRelated(content, options = {}) {
    const relations = (content.relations || []).map(ref => {
      const target = (S.assets || []).find(item => item.id === ref.assetId);
      return btn(target?.title || T('cognition.detail_related_cognition', '关联认知'), 'go-inbox-asset', { id: ref.assetId, small: true });
    });
    for (const ref of content.ontologyRefs || []) {
      const record = S.ontologySnapshot?.records?.[ref.recordId];
      relations.push(btn(record?.name || record?.title || T('cognition.detail_related_ontology', '关联本体'), 'open-ontology', { small: true, data: { 'module-id': ref.moduleId, 'record-id': ref.recordId } }));
    }
    if (!relations.length) return '';
    const label = T('cognition.detail_related', '关联认知与本体');
    return options.fold ? detailFoldSection('related', label, relations.join(''), { className: 'ca-library-related' })
      : `<section class="ca-library-related"><h3>${esc(label)}</h3>${relations.join('')}</section>`;
  }
  function cognitionSourceParts(refs = [], stateKey = '', listDetail = false) {
    const seen = new Set();
    const rows = refs.filter(ref => {
      const key = `${ref.kind}:${ref.id || ref.ref || ''}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(ref => {
      const evidenceState = S.reviewEvidence?.[stateKey];
      const resolved = evidenceState?.items?.find(item => item.ref?.kind === ref.kind && item.ref?.id === ref.id);
      const view = resolveSourceRef(resolved?.title ? { ...ref, title: resolved.title } : ref);
      const activity = String(stateKey).startsWith('candidate:') && S.route?.name === 'activity';
      const detail = activity || (String(stateKey).startsWith('asset:') && ['overview', 'activity'].includes(S.route?.name));
      if (detail && /^会话\s+[\w-]+\/[\w-]+(?:\s*·|$)|^(?:[a-z]+[-_])?[a-f0-9]{12,}(?:\/msg_[a-f0-9]+)?(?:…|\.\.\.)?$/i.test(view.name)) {
        view.name = ''; view.state = 'unavailable'; view.openRoute = 'none';
      }
      const missingSource = resolved?.state === 'missing';
      const unavailable = missingSource || ['unavailable', 'changed', 'ambiguous', 'unmatched'].includes(resolved?.state) || view.state === 'unavailable' || ref.degraded === true;
      const located = detail && !!ref.locator;
      const readableLocated = located && resolved?.state === 'available';
      const label = missingSource ? T('cognition.source_missing', '来源缺失，等待补充资料') : view.state === 'processing' ? T('cognition.evidence_source_processing', '来源整理中') : unavailable ? T('cognition.source_unavailable_label', '来源记录不可用')
        : view.state === 'immediate' ? T('cognition.evidence_immediate_note', '对话中当场记（无独立会话出处）')
          : view.name || T('cognition.evidence_fallback', '来源记录');
      const checkedLegacy = listDetail && detail && !located && view.openRoute === 'conversation';
      const verifiedLink = !unavailable && resolved?.state !== 'read_failed' && (readableLocated && resolved.openTarget || checkedLegacy);
      const open = verifiedLink
        ? btn(T('cognition.activity_view_source', '查看来源 ›'), 'open-review-source', { id: ref.id, small: true, className: 'rnm ca-review-source-link', data: { 'evidence-key': stateKey, 'source-kind': ref.kind } })
        : located || checkedLegacy ? '' : !unavailable && view.openRoute === 'conversation'
        ? btn(T('cognition.activity_view_source', '查看来源 ›'), 'open-conversation', { id: view.openTarget, small: true, className: 'rnm ca-review-source-link' })
        : !unavailable && view.openRoute === 'kstar'
          ? btn(T('cognition.activity_view_source', '查看来源 ›'), 'open-kstar-episode', { id: view.openTarget, small: true, className: 'rnm ca-review-source-link' }) : '';
      // 摘录只能来自服务端保留的来源数据；不可用/撤权来源不展示旧摘录。
      const excerpt = !unavailable && (!located || readableLocated) && view.state !== 'processing' ? String(resolved ? resolved.excerpt || '' : ref.excerpt || '').trim() : '';
      const sourceLabel = !unavailable && view.state === 'available' && view.openRoute === 'kstar' ? T('cognition.evidence_task_review', '任务复盘：{title}', { title: view.name || T('cognition.evidence_task_review_generic', '一次任务') }) : !unavailable && view.state === 'available' && view.kind === 'conversation' && view.name ? T('cognition.evidence_conversation_named', '对话：《{name}》', { name: view.name }) : label;
      const issue = unavailable || resolved?.state === 'read_failed' || Boolean(located && !resolved && (evidenceState?.error || evidenceState?.loaded));
      return { issue, html: `<div class="ca-review-source"><div class="ca-review-source-head"><span>${esc(sourceLabel)}</span>${open}</div>${readableLocated && resolved.location ? `<p class="note">${esc(T('cognition.activity_source_lines', '原文第 {start}–{end} 行', { start: String(resolved.location.startLine), end: String(resolved.location.endLine) }))}</p>` : ''}${excerpt ? `<blockquote class="ca-review-quote">${resolved?.excerptKind === 'conversation_context' ? `<span class="ca-review-excerpt-label">${esc(T('cognition.prototype_context_excerpt', '来源对话节选（供核对）'))}</span>` : ''}${esc(excerpt)}</blockquote>` : missingSource ? '' : `<p class="note">${esc(located && !resolved ? evidenceState?.error || (evidenceState?.loaded ? T('cognition.source_unavailable_label', '来源记录不可用') : T('common.loading', '加载中…')) : resolved?.state === 'changed' ? T('cognition.activity_source_changed', '来源内容发生变化，需要重新核对原文。') : resolved?.state === 'ambiguous' ? T('cognition.activity_source_ambiguous', '找到多处相同原文，尚未确定引用位置。') : resolved?.state === 'unmatched' ? T('cognition.activity_source_unmatched', '来源线索已保留，但未在对应消息或附件中找到原文。') : unavailable ? T('cognition.activity_source_unavailable', '当前无法读取此来源，不能核对原文；其他可用来源仍可逐项查看。') : resolved?.state === 'read_failed' ? T('cognition.prototype_evidence_failed', '来源原文暂时无法读取，请重试或打开来源核对。') : T('cognition.activity_source_no_excerpt', '此来源未保留原文摘录，请打开来源核对。'))}</p>`}</div>` };
    });
    const missing = `<p class="note">${esc(T('cognition.activity_not_recorded', '未记录'))}</p>`;
    return {
      rows: rows.map(row => row.html).join('') || missing,
      content: rows.filter(row => !row.issue).map(row => row.html).join('') || (rows.length ? '' : missing),
      alerts: rows.filter(row => row.issue).map(row => row.html).join(''),
    };
  }
  function cognitionSourceRows(refs, stateKey) {
    return cognitionSourceParts(refs, stateKey).rows;
  }
  function cognitionSourceSection(content, options = {}) {
    const label = T('cognition.detail_sources', '依据与来源');
    if (!options.fold) return `<section class="ca-review-evidence"><h3>${esc(label)}</h3>${content}</section>`;
    return (options.alerts ? `<div class="ca-detail-source-alerts" role="status">${options.alerts}</div>` : '')
      + detailFoldSection('sources', label, content, { open: options.open, className: 'ca-review-evidence' });
  }
  function cognitionSources(refs = [], stateKey, options = {}) {
    const parts = cognitionSourceParts(refs, stateKey, options.listDetail != null ? !!options.listDetail : !!options.fold);
    const content = !refs.length && options.empty !== undefined ? options.empty : options.fold ? parts.content : parts.rows;
    return cognitionSourceSection(`${options.before || ''}${content}${options.after || ''}`, {
      ...options, alerts: (options.alerts || '') + parts.alerts,
    });
  }
  function cognitionHistory(content, options = {}) {
    const trigger = options.candidateId ? ` data-act="activity-history" data-id="${esc(options.candidateId)}"` : '';
    return `<details class="details ca-review-history"${options.open ? ' open' : ''}><summary${trigger}>${esc(T('cognition.detail_history', '版本与使用记录'))}</summary><div class="ca-review-history-body">${content}</div></details>`;
  }
  // Adopt the existing native disclosures in the two list-side inspectors.
  // Move nodes rather than recreate controls: summary actions, field values,
  // native keyboard behavior and business-owned open state stay on their nodes.
  function styleDetailDisclosures(root) {
    const details = root?.querySelectorAll?.('.ca-detail-card:is(.ca-activity-detail,.ca-library-detail) .ca-detail-body details, .ca-detail-expand .ca-detail-body details') || [];
    for (const detail of details) {
      if (detail.classList.contains('ca-detail-disclosure')) continue;
      const summary = Array.from(detail.children).find(child => child.tagName === 'SUMMARY');
      if (!summary) continue;
      const title = document.createElement('span');
      title.className = 'ca-detail-disclosure-title';
      while (summary.firstChild) title.appendChild(summary.firstChild);
      summary.innerHTML = window.uiIconHtml('chevron-right', 'ca-detail-disclosure-icon');
      summary.appendChild(title);
      const body = document.createElement('div');
      body.className = 'ca-detail-disclosure-body';
      while (summary.nextSibling) body.appendChild(summary.nextSibling);
      detail.appendChild(body);
      detail.classList.add('ca-detail-disclosure');
    }
  }
  function versionContent(assetId, version) {
    const asset = (S.assets || []).find(item => String(item.id) === String(assetId));
    if (!asset || asset.status === 'purged' || S.assetsError) return null;
    const versions = S.assetVersions;
    if (versions?.assetId === assetId && !versions.loading) {
      if (versions.failed) return null;
      return (versions.versions || []).find(item => String(item.version) === String(version))?.snapshot || null;
    }
    // The live record contains the selected active version, not necessarily the latest version.
    return String(asset.activeVersion || asset.version) === String(version) ? asset : null;
  }

  function savedDecisionContent(kind, decision) {
    const assetId = kind === 'candidate' ? decision.promotedAssetId : decision.assetId;
    const state = S.assetVersions;
    if (!assetId || state?.assetId !== assetId || state.loading || state.failed) return null;
    const row = (state.versions || []).find(item => kind === 'candidate'
      ? decision.reviewDecisionId && String(item.reason || '').split(';', 1)[0] === 'review_decision:' + decision.reviewDecisionId
      : decision.appliedVersion ? String(item.version) === String(decision.appliedVersion)
        : String(item.reason || '').includes('proposal=' + decision.id + '）') && Number(item.version) > Number(decision.baselineVersion));
    const content = row && versionContent(assetId, row.version);
    return content ? { content, version: row.version, assetId } : null;
  }
  function assetLibraryScopeSection(asset) {
    const policy = asset.scopePolicy && typeof asset.scopePolicy === 'object' ? asset.scopePolicy : {};
    const options = S.assetScopeOptions || {};
    const names = (items, idField) => new Map((Array.isArray(items) ? items : []).filter(item => item && item[idField]).map(item => [String(item[idField]), String(item.name || item.displayName || item[idField])]));
    const agentNames = names(options.agents, 'agent_id'), spaceNames = names(options.spaces, 'space_id');
    if (!agentNames.has('commander')) agentNames.set('commander', T('cognition.asset_scope_main_agent', '主助手'));
    const dimensions = [
      ['agentIds', T('cognition.asset_scope_visible_agents', '可使用的智能体'), agentNames],
      ['workspaceIds', T('cognition.asset_scope_visible_spaces', '可使用的工作空间'), spaceNames],
      ['roleIds', T('cognition.asset_scope_visible_roles', '可使用的角色')],
      ['projectIds', T('cognition.asset_scope_visible_projects', '可使用的项目')],
      ['purposeTags', T('cognition.asset_scope_visible_purposes', '适用任务')],
      ['conversationKinds', T('cognition.asset_scope_visible_conversation_kinds', '适用会话类型')],
      ['fileKinds', T('cognition.asset_scope_visible_file_kinds', '适用文件类型')],
    ];
    const scopeLabels = { general: T('cognition.capture.scope_general', '跨任务通用'), report: T('cognition.capture.scope_report', '报告'), code: T('cognition.capture.scope_code', '编程'), review: T('cognition.capture.scope_review', '审查与评审'), product: T('cognition.capture.scope_product', '产品工作') };
    const scope = String(asset.scope || '').split(',').map(value => value.trim()).filter(Boolean).map(value => scopeLabels[value] || scopeLabelText(value)).join('、');
    const baseDimensions = [
      ['agentIds', T('cognition.prototype_agent', '智能体'), agentNames],
      ['workspaceIds', T('cognition.prototype_workspace', '工作空间'), spaceNames],
      ['projectIds', T('cognition.prototype_project', '项目')],
      ['purposeTags', T('cognition.prototype_purpose', '用途')],
    ];
    const visible = [...baseDimensions, ...dimensions.filter(([key]) => !baseDimensions.some(([base]) => key === base) && Object.prototype.hasOwnProperty.call(policy, key))]
      .filter(([key]) => Object.prototype.hasOwnProperty.call(policy, key) && policy[key] !== null);
    const rows = visible.map(([key, label, lookup]) => {
      const ids = Array.isArray(policy[key]) ? policy[key].map(String) : null;
      const value = ids === null ? T('cognition.library_scope_incomplete', '范围信息不完整，请核对') : ids.length ? ids.map((id, index) => lookup ? lookup.get(id) || T(key === 'agentIds' ? 'cognition.asset_scope_missing_agent' : 'cognition.asset_scope_missing_space', key === 'agentIds' ? '已不可用的旧智能体限制 {n}' : '已不可用的旧工作空间限制 {n}', { n: String(index + 1) }) : id).join('、') : T('cognition.asset_scope_denied_all', '明确禁止任何对象使用');
      return `<span>${esc(label)}</span><span>${esc(value)}</span>`;
    }).join('');
    return `<section class="ca-library-scope"><h3>${esc(T('cognition.library_scope', '使用范围'))}</h3><p class="ca-library-scope-summary">${esc(scope || T('cognition.scope_unknown', '范围未记录'))}</p>${rows ? `<div class="ca-prototype-kv">${rows}</div>` : ''}<p class="note ca-review-footnote">${esc(T('cognition.library_scope_usage_note', '是否使用仍取决于任务匹配、状态与来源权限。'))}</p></section>`;
  }
  function libraryEvidenceDialog(asset) {
    const state = S.reviewEvidence?.['asset:' + asset.id];
    if (state?.error) return `<p role="alert">${esc(state.error)}</p>`;
    const refs = asset.evidenceRefs || [];
    if (refs.length && (!state || state.loading)) return `<p role="status">${esc(T('common.loading', '加载中…'))}</p>`;
    return (refs.length ? `<p class="note">${esc(T('cognition.asset_origin_count', '{n} 条来源记录', { n: String(refs.length) }))}</p>` : '') + (refs.map(ref => {
      const item = state?.items?.find(row => row.ref?.id === ref.id && row.ref?.kind === ref.kind);
      const view = resolveSourceRef(item?.title ? { ...ref, title: item.title } : ref);
      const available = item?.state === 'available' || (!item || item.state === 'unrecorded') && view.state === 'available';
      const title = view.openRoute === 'kstar' ? T('cognition.evidence_task_review', '任务复盘：{title}', { title: view.name || T('cognition.evidence_task_review_generic', '一次任务') }) : view.kind === 'conversation' && view.name ? T('cognition.evidence_conversation_named', '对话：《{name}》', { name: view.name }) : view.name || T('cognition.evidence_fallback', '来源记录');
      return `<div class="ca-prototype-source-card"><strong>${esc(title)}</strong><span class="note">${esc(item?.state === 'missing' ? T('cognition.source_missing', '来源缺失，等待补充资料') : available ? T('cognition.prototype_source_readable', '可读取') : T('cognition.prototype_source_unreadable', '不可读取'))}</span>${available && item?.excerpt ? `<div class="ca-prototype-source-block">${item.excerptKind === 'conversation_context' ? `<span class="note">${esc(T('cognition.prototype_context_excerpt', '来源对话节选（供核对）'))}</span>\n` : ''}${esc(item.excerpt)}</div>` : item?.state === 'missing' ? '' : `<p class="note">${esc(T('cognition.activity_source_no_excerpt', '此来源未保留原文摘录，请打开来源核对。'))}</p>`}${available && view.openRoute === 'conversation' ? btn(T('cognition.activity_view_source', '查看来源 ›'), 'open-conversation', { id: view.openTarget, className: 'rnm' }) : available && view.openRoute === 'kstar' ? btn(T('cognition.activity_view_source', '查看来源 ›'), 'open-kstar-episode', { id: view.openTarget, className: 'rnm' }) : ''}</div>`;
    }).join('') || `<p class="note">${esc(asset.origin === 'manual' ? T('cognition.prototype_manual_source', '手动添加 · 已经你确认保存；没有外部引用。') : T('cognition.asset_origin_empty', '没有可追溯的来源记录。'))}</p>`);
  }
  function libraryVersionDialog(asset, selectedVersion) {
    const state = S.assetVersions;
    if (!state || state.assetId !== asset.id || state.loading) return `<p role="status">${esc(T('common.loading', '加载中…'))}</p>`;
    if (state.failed) return `<p role="alert">${esc(T('cognition.asset_versions_failed', '版本记录暂不可用'))}</p>${btn(T('common.retry', '重试'), 'asset-versions-retry', { id: asset.id })}`;
    const versions = state?.assetId === asset.id && Array.isArray(state.versions) ? state.versions : [];
    if (!versions.length) return `<p class="ca-prototype-notice">${esc(T('cognition.prototype_no_snapshots', '旧记录没有版本快照，无法补造历史版本。'))}</p>`;
    const active = String(asset.activeVersion || asset.version || '');
    const available = (asset.type === 'cognition' || CATEGORIES.some(([type]) => type === asset.type)) && ['active', 'paused'].includes(asset.status);
    const selected = versions.find(item => String(item.version) === String(selectedVersion)) || versions.find(item => String(item.version) !== active) || versions[0];
    const snap = selected.snapshot || {};
    const snapshot = (title, body) => {
      const refs = Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [];
      const origin = snapshotOriginText(body.learningSignal, body.learningProvenance);
      return `<div><strong>${esc(title)}</strong>${cognitionContentFields(body)}${cognitionRelated(body)}${origin ? `<p class="note">${esc(T('cognition.asset_origin_label', '怎么来的'))}：${esc(origin)}</p>` : ''}${refs.length ? evidenceGroupsHtml(refs) : ''}${kstarEpisodeSection(S.route)}</div>`;
    };
    const current = versions.find(item => String(item.version) === active)?.snapshot || asset;
    const titleDiff = snap.title !== current.title ? T('cognition.prototype_title_diff', '标题：{before} → {after}', { before: snap.title || '', after: current.title || '' }) + '；' : '';
    const pickerLabel = T('cognition.prototype_choose_version', '选择历史版本');
    const picker = window.uiSelect({ id: `ca-proto-version-${asset.id}`, native: true, ariaLabel: pickerLabel, value: String(selected.version), options: versions.map(item => ({ value: String(item.version), label: `v${item.version} · ${versionSourceLabel(item)}${String(item.version) === active && available ? '（' + T('cognition.prototype_in_use', '在用') + '）' : ''}` })), attrs: { 'data-prototype-version-select': 'true' } });
    return `<label class="field"><span>${esc(pickerLabel)}</span>${picker}</label><div class="ca-prototype-pair">${snapshot(T('cognition.prototype_selected_version', '所选 v{n}', { n: selected.version }), snap)}${snapshot(T(available ? 'cognition.prototype_current_version' : 'cognition.library_saved_version', available ? '当前在用 v{n}' : '保存版本 v{n}', { n: active }), current)}</div><div class="ca-prototype-notice"><strong>${esc(T('cognition.prototype_diff_summary', '差异摘要'))}</strong><p>${esc(titleDiff)}${esc(String(snap.statement || '') === String(current.statement || '') ? T('cognition.asset_version_diff_same', '两版内容一致。') : T('cognition.prototype_diff_changed', '正文不同，请对照两侧内容核对；适用边界与来源跟随各自快照展示。'))}</p></div><div class="ca-prototype-notice">${esc(T('cognition.prototype_version_guarantee', '切换历史正文与边界时，当前范围与来源权限不会回退。已有对话引用和使用记录保留当时快照。'))}</div>`;
  }
  NS.renderLibraryDialog = function renderLibraryDialog(kind, assetId, selectedVersion, proofEventId) {
    const asset = S.assets.find(item => String(item.id) === String(assetId));
    if (!asset) return '';
    if (kind === 'sources') return `<section class="ca-library-sources">${libraryEvidenceDialog(asset)}</section>`;
    if (kind === 'versions') return `<section class="ca-library-versions">${libraryVersionDialog(asset, selectedVersion)}</section>`;
    assetDetail(asset, proofEventId === undefined ? S.route : { ...S.route, assetId, proofEventId }, { compact: true });
    return `<section class="ca-library-${kind}">${S.libraryDialogBodies?.[kind] || ''}</section>`;
  };
  NS.showLibraryDialog = async function showLibraryDialog(kind, assetId) {
    const asset = S.assets.find(item => String(item.id) === String(assetId));
    if (!asset || !['sources', 'versions', 'records', 'merge'].includes(kind)) return;
    if (kind === 'versions') await NS.loadAssetVersions(asset.id, true);
    if (kind === 'records') {
      await Promise.all([NS.loadAssetVersions(asset.id, true), NS.loadAssetTimeline(asset.id, true),
        NS.loadAdoptionReceipts(asset.id, true)]);
      await NS.loadRankingWhy?.(asset.id, true);
      // Source conversations may exist only in this complete per-asset slice,
      // not the global recent-event window (or a library-first route).
      await NS.loadConversationTitles(asset.id);
    }
    if (kind === 'sources') await NS.loadAssetEvidence?.(asset.id, true);
    assetDetail(asset, S.route, { compact: true });
    const titles = {
      sources: T('cognition.library_sources', '来源与证据'), versions: T('cognition.library_versions', '版本与比较'),
      records: T('cognition.library_records', '使用与管理记录'), merge: T('cognition.prototype_merge_target', '归入另一条认知的版本组'),
    };
    const versions = S.assetVersions?.assetId === asset.id ? S.assetVersions.versions || [] : [];
    const active = String(asset.activeVersion || asset.version || '');
    let selected = String((versions.find(item => String(item.version) !== active) || versions[0])?.version || '');
    let openedProofId = String(S.route.proofEventId || '');
    const mutable = !S.assetsError && (asset.type === 'cognition' || CATEGORIES.some(([type]) => type === asset.type)) && ['active', 'paused'].includes(asset.status) && S.assetCapabilities?.versionedUpdate === true;
    const dialog = window.uiModal({
      title: titles[kind], description: kind === 'versions' ? asset.title + ' · ' + T(['active', 'paused'].includes(asset.status) ? 'cognition.prototype_current_version' : 'cognition.library_saved_version', ['active', 'paused'].includes(asset.status) ? '当前在用 v{n}' : '保存版本 v{n}', { n: active }) : asset.title,
      size: kind === 'versions' || kind === 'merge' ? 'lg' : 'md', closeLabel: T('common.close', '关闭'),
      bodyHtml: NS.renderLibraryDialog(kind, asset.id, selected),
      actions: [{ id: 'close', label: T('common.close', '关闭') }, ...(kind === 'versions' && versions.length && mutable ? [{ id: 'use-version', label: T('cognition.prototype_switch_version', '切换为在用版本'), role: 'primary', disabled: selected === active }] : [])],
    });
    dialog.overlay.classList.add('ca-prototype-modal');
    // The modal lives outside the replaced page body. Keep that actual surface
    // subscribed, re-reading only its invalidated details while it is visible.
    let refreshing = false;
    const refreshBody = () => {
      const body = dialog.dialog.querySelector('.ui-modal__body');
      if (!body) return;
      const active = document.activeElement;
      const editing = active && body.contains(active) && active.matches('[data-f="note"], [data-prototype-version-select]')
        ? { selector: active.matches('[data-f="note"]') ? '[data-f="note"]' : '[data-prototype-version-select]',
          value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
      const html = NS.renderLibraryDialog(kind, asset.id, selected, openedProofId);
      if (body.innerHTML !== html) body.innerHTML = html;
      if (!editing) return;
      // A background refresh must not swallow an unsubmitted evaluation note.
      const next = body.querySelector(editing.selector);
      if (!next) return;
      next.value = editing.value;
      next.focus();
      if (editing.start !== null && typeof next.setSelectionRange === 'function') next.setSelectionRange(editing.start, editing.end);
    };
    const refreshDialog = () => {
      if (refreshing || !dialog.overlay.isConnected || !NS.isChangeRailVisible()) return;
      refreshing = true;
      try {
        const current = S.assets.find(item => String(item.id) === String(asset.id));
        if (!current) return;
        if (kind === 'sources') void NS.loadAssetEvidence(asset.id);
        if (kind === 'versions' || kind === 'records') void NS.loadAssetVersions(asset.id);
        if (kind === 'records') {
          void NS.loadAssetTimeline(asset.id);
          void NS.loadAdoptionReceipts(asset.id);
          void NS.loadRankingWhy?.(asset.id);
        }
        refreshBody();
        const description = dialog.dialog.querySelector('.ui-modal__description');
        if (description) description.textContent = kind === 'versions' ? current.title + ' · '
          + T(['active', 'paused'].includes(current.status) ? 'cognition.prototype_current_version' : 'cognition.library_saved_version',
            ['active', 'paused'].includes(current.status) ? '当前在用 v{n}' : '保存版本 v{n}', { n: String(current.activeVersion || current.version || '') }) : current.title;
        const action = dialog.dialog.querySelector('[data-ui-modal-action="use-version"]');
        if (action) action.disabled = !['active', 'paused'].includes(current.status)
          || selected === String(current.activeVersion || current.version || '') || Boolean(S.assetVersions?.loading || S.assetVersions?.failed);
      } finally { refreshing = false; }
    };
    const unsubscribe = NS.onChange(refreshDialog);
    dialog.overlay.addEventListener('click', event => {
      // The shared modal contains click bubbling. Record actions therefore
      // belong to this dialog; routing the background page cannot repaint it.
      const proofToggle = kind === 'records' && event.target.closest('[data-act="proof-toggle"]');
      if (proofToggle) {
        event.stopPropagation();
        openedProofId = openedProofId === proofToggle.dataset.id ? '' : String(proofToggle.dataset.id || '');
        dialog.dialog.querySelector('.ui-modal__body').innerHTML = NS.renderLibraryDialog(kind, asset.id, selected, openedProofId);
        Array.from(dialog.dialog.querySelectorAll('[data-act="proof-toggle"]')).find(item => item.dataset.id === proofToggle.dataset.id)?.focus();
        return;
      }
      const proofRate = kind === 'records' && event.target.closest('[data-act="proof-rate"]');
      if (proofRate) {
        event.stopPropagation();
        const note = String(proofRate.closest('.ca-rating')?.querySelector('textarea[data-f="note"]')?.value || '').trim();
        if (proofRate.disabled) return;
        proofRate.disabled = true;
        void NS.actions.rateProof(proofRate.dataset.id, proofRate.dataset.feedback, note ? { note } : undefined)
          .then(async result => {
            if (!result) return;
            await Promise.all([NS.loadAssetTimeline(asset.id, true), NS.loadAdoptionReceipts(asset.id, true)]);
            dialog.dialog.querySelector('.ui-modal__body').innerHTML = NS.renderLibraryDialog(kind, asset.id, selected, openedProofId);
          }).catch(error => NS.alertUser(NS.recallErrorText(error)))
          .finally(() => { proofRate.disabled = false; });
        return;
      }
      const episode = event.target.closest('[data-act="open-kstar-episode"]');
      if (episode) {
        event.stopPropagation(); dialog.close(null, 'navigate');
        void NS.loadKstarEpisode(episode.dataset.id).then(() => {
          const detail = window.uiModal({ title: T('cognition.kstar_episode_detail_title', '这次任务的经过'), closeLabel: T('common.close', '关闭'), bodyHtml: kstarEpisodeSection({ kstarEpisodeId: episode.dataset.id }), actions: [{ id: 'close', label: T('common.close', '关闭') }] });
          detail.overlay.classList.add('ca-prototype-modal'); document.getElementById('ca-root').appendChild(detail.overlay);
        });
      } else if (event.target.closest('[data-act="open-conversation"]')) dialog.close(null, 'navigate');
    }, true);
    document.getElementById('ca-root').appendChild(dialog.overlay);
    refreshDialog();
    dialog.overlay.addEventListener('change', event => {
      if (!event.target.matches('[data-prototype-version-select]')) return;
      selected = event.target.value;
      refreshDialog();
    });
    dialog.then(async result => {
      unsubscribe();
      const current = S.assets.find(item => String(item.id) === String(asset.id));
      if (result?.value !== 'use-version' || !current || !['active', 'paused'].includes(current.status)
        || !selected || selected === String(current.activeVersion || current.version || '')) return;
      if (!(await NS.confirmUser(T('cognition.prototype_version_confirm', '切换在用版本？已有引用快照保持原样。')))) return;
      try { await NS.actions.selectAssetVersion(asset.id, selected); }
      catch (error) { await NS.alertUser(NS.recallErrorText(error)); }
    });
    return dialog;
  };
  NS.showCleanupDialog = async function showCleanupDialog(run) {
    const dialog = window.uiModal({ title: T('cognition.cleanup_title', '整理报告'), closeLabel: T('common.close', '关闭'), bodyHtml: `<p>${esc(T('common.loading', '加载中…'))}</p>`, size: 'lg', actions: [{ id: 'close', label: T('common.close', '关闭') }] });
    dialog.overlay.classList.add('ca-prototype-modal'); document.getElementById('ca-root').appendChild(dialog.overlay);
    try {
      if (run) await NS.actions.runMaintenance();
      await NS.loadCleanupReports(true);
      dialog.dialog.querySelector('.ui-modal__body').innerHTML = viewCleanup({ name: 'cleanup' });
    } catch (error) { dialog.dialog.querySelector('.ui-modal__body').textContent = NS.recallErrorText(error); }
    return dialog;
  };
  NS.renderLibraryAssetDetail = (asset, route = {}, options = {}) => assetDetail(asset, route, { compact: true, ...options });

  /** 存量治理：同义资产归并面板——同类型的其他条目可选为
   *  归并目标，本条版本链并入它（本条归档、较新内容为在用）。 */
  function assetMergeSection(asset) {
    const sameType = S.assets
      .filter((a) => String(a.id) !== String(asset.id)
        && a.type === asset.type
        && !['archived', 'deleted', 'purged', 'revoked'].includes(String(a.status || 'active')))
      .slice(0, 8);
    if (!sameType.length) return '';
    const rows = sameType.map((other) => `<div class="row is-flat">
      <div class="tw"><div class="tt">${esc(other.title || other.id)}</div><div class="mm">v${esc(String(other.activeVersion || other.version || '1'))}</div></div>
      <div class="sd">${btn(T('cognition.asset_merge_into', '归入版本组'), 'merge-asset', { id: asset.id, data: { target: String(other.id) }, small: true })}</div>
    </div>`).join('');
    return `<details class="details">
      <summary>${esc(T('cognition.asset_merge_section', '版本归组（同一认知的重复条目）'))}</summary>
      <p class="note">${esc(T('cognition.asset_merge_hint', '把本条的全部历史版本并入所选条目：较新的内容成为其新版本，本条归档不再单独显示。'))}</p>
      ${rows}
    </details>`;
  }

  /* ────────────────────────── 视图：我的认知 ────────────────────────── */

  /** 大类分组：按 same_family 关系做连通分量，
   *  一组＝一个大类；组名默认取组内最近更新的资产标题（族命名功能挂本体分组，
   *  后续轮接）；无族关系的资产归入无血缘组。视图与筛选都保留原行为——
   *  分组只改变排列，不改变可见性。
   *  族名表示同源血缘，主题分类见 tags。 */
  function familyGroupsOf(assets) {
    const parent = new Map(assets.map((asset) => [String(asset.id), String(asset.id)]));
    const find = (id) => { let root = id; while (parent.get(root) !== root) root = parent.get(root); return root; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra > rb ? rb : ra, ra > rb ? ra : rb); };
    const byId = new Map(assets.map((asset) => [String(asset.id), asset]));
    for (const asset of assets) {
      for (const relation of asset.relations || []) {
        if (relation.kind !== 'same_family') continue;
        if (byId.has(String(relation.assetId))) union(String(asset.id), String(relation.assetId));
      }
    }
    const groups = new Map();
    for (const asset of assets) {
      const root = find(String(asset.id));
      const bucket = groups.get(root) || [];
      bucket.push(asset);
      groups.set(root, bucket);
    }
    const named = [];
    let unsorted = [];
    /* 组名兜底短名：原来直接 slice(0,10)，把
       「沟通风格偏好：…」切成「沟通风格偏好（2026」——
       括号/日期被腰斩，读起来是乱码。改成先取自然头段（到冒号/括号/间隔号
       为止），仍超长才截断加省略号。 */
    const shortName = (rawTitle) => {
      const raw = String(rawTitle || '').trim();
      const head = raw.split(/[：:（(【[·—]/)[0].trim();
      const base = head || raw;
      return base.length > 12 ? `${base.slice(0, 12)}…` : base;
    };
    for (const bucket of groups.values()) {
      if (bucket.length >= 2) {
        // 组名：用户历史命名的族名优先（数据保留、展示保留）；默认短名取用
        // 得最多的那条资产标题的头段。族命名的写入按钮已删，历史命名仍保留展示。
        const namedOne = bucket.find((a) => String(a.familyName || '').trim());
        const fallback = bucket.slice().sort((a, b) => String(b.title || '').length - String(a.title || '').length)[0];
        const title = namedOne
          ? String(namedOne.familyName).trim()
          : shortName(fallback?.title);
        named.push({ title, assets: bucket });
      } else {
        unsorted = unsorted.concat(bucket);
      }
    }
    named.sort((a, b) => String(b.assets.length).localeCompare(String(a.assets.length)));
    if (unsorted.length) named.push({ title: '', assets: unsorted });
    return named;
  }

  /* ────────────────────────── 视图:认知树(独立页) ────────────────────────── */
  /* 页签迁移:树从「我的认知」页顶部的卡片拆成独立全屏页。
   * 树只讲结构(冠/枝/干/根/土),资产明细全部留在「我的认知」——两个入口
   * 一份事实源,树上的每次点击都是导航而不是就地展开。 */

  function viewTree(route) {
    const stats = NS.stats();
    const counts = {};
    for (const [id] of CATEGORIES) counts[id] = S.assets.filter((a) => a.type === id && !['archived', 'deleted', 'purged', 'revoked'].includes(String(a.status || 'active'))).length;
    const sourceCount = S.sources.reduce((n, group) => n + (Array.isArray(group.items) ? group.items.length : 0), 0);
    const captureCount = Array.isArray(S.captures) ? S.captures.length : 0;
    // 计数口径:已验证 = 成熟度达标且 active;待确认走 stats 口径
    // (countsAsPending && !isSnoozed);叶片方向按枝派生。
    const validated = S.assets.filter((a) => String(a.status || 'active') === 'active'
      && (a.maturity === 'transfer_validated' || a.maturity === 'effectiveness_validated')).length;
    const directions = { kstar: [] };
    for (const branch of TREE_BRANCHES) {
      const assets = S.assets.filter((a) => a.type === branch.id
        && !['archived', 'deleted', 'purged', 'revoked'].includes(String(a.status || 'active')));
      directions[branch.id] = branchDirections(assets);
      if (assets.some((a) => NS.isKstarAsset && NS.isKstarAsset(a))) directions.kstar.push(branch.id);
    }
    /* 树页使用整屏画布、顶部读法提示和底部图例，避免重复的页头卡片。 */
    return `
      <div class="tree-stage${S.loading && !S.loaded ? ' is-loading' : ''}">
        <div class="fl-top">
          <div class="ft ft-title">${esc(T('cognition.tree_panel_title', '我的认知树'))}</div>
          <div class="ft">${esc(T('cognition.tree_page_hint', '查看常规资产、候选和来源的分布。树冠统计有带入或读取记录的资产；不代表已采用或效果已验证。'))}</div>
          <div class="ft">${btn(T('cognition.catalog_view_back', '列表视图'), 'asset-view', { id: '', small: true, className: 'o' })}</div>
        </div>
        ${treeFigure({ counts, pending: stats.pending, validated, sources: sourceCount, captures: captureCount }, directions)}
        <div class="fl-bottom">
          <div class="legend">
            <span class="k"><span class="dt" style="background:var(--green)"></span>${esc(T('cognition.tree_legend_validated', '有带入或读取记录'))}</span>
            <span class="k"><span class="dt" style="background:var(--green-line)"></span>${esc(T('cognition.tree_legend_asset', '资产'))}</span>
            <span class="k"><span class="dt" style="background:var(--blue)"></span>${esc(T('cognition.tree_legend_kstar', '任务复盘学的'))}</span>
            <span class="k"><span class="dt" style="background:var(--amber-dot)"></span>${esc(T('cognition.tree_legend_pending', '新芽（待确认）'))}</span>
            <span class="legend-hint">${esc(T('cognition.tree_legend_hint', '枝端光斑 = 大方向 · 叶片 = 细分方向 · 悬停看详情'))}</span>
          </div>
        </div>
        <div class="tip" id="ca-tree-tip" role="tooltip"></div>
      </div>`;
  }

  /* ────────────────────────── 视图:本体工作台 ────────────────────────── */
  /* 新工作台以独立 classic script 懒加载到这个挂载点；旧 personal-ontology 页
   * 已退役（深链在 boot.js 归一化为 recall），本体工作台是唯一入口。 */

  function viewOntology() {
    return '<div id="ca-ontology-mount" class="ca-ontology-mount"></div>';
  }

  function ontologyDirectorySection(activity = false) {
    const doc = S.ontologySnapshot;
    if (S.ontologyError) return `<section>${sectionHead(T('ontologyWorkspace.title', '本体'), '')}<p role="alert">${esc(T('ontologyWorkspace.loadFailed', '本体暂时无法加载'))}</p>${btn(T('ontologyWorkspace.retry', '重试'), 'open-ontology')}</section>`;
    if (!doc?.records) return '';
    const modules = Object.values(doc.records).filter(record => record.kind === 'module' && record.status === 'active');
    const entries = activity ? (doc.history || []).slice(-20).reverse() : modules;
    if (!entries.length) return '';
    return `<section>${sectionHead(T(activity ? 'cognition.ontology_changes' : 'cognition.ontology_directory', activity ? '本体保存与版本变更' : '本体目录'), String(entries.length), btn(T('ontologyWorkspace.title', '本体'), 'open-ontology', { small: true, icon: 'git-branch' }))}
      <p class="note">${esc(T(activity ? 'cognition.ontology_changes_hint' : 'cognition.ontology_directory_hint', activity ? '这里显示最近20条真实保存与纠正，打开记录查看版本、依据和完整历史；保存不代表任务已采用。' : '与本体页读取同一份内容。打开可查看定义、对象、关系、规则、来源和版本。'))}</p>
      ${entries.map(entry => {
        const record = activity ? entry.after : entry;
        const moduleId = record.kind === 'module' ? record.id : record.moduleId;
        const label = activity ? `${fmtDate(entry.recordedAt)} · ${T('ontologyWorkspace.' + entry.intent, entry.intent)} · ${record.name || record.id}` : record.name;
        return `<div class="row"><div class="tw">${btn(label, 'open-ontology', { className: 'rnm', data: { 'module-id': moduleId, ...(activity ? { 'record-id': record.id, 'record-version': String(record.version) } : {}) } })}<div class="mm">v${esc(record.version)} · ${esc(record.source?.label || '')}${activity ? '' : ' · ' + esc(record.description || '')}</div></div></div>`;
      }).join('')}</section>`;
  }

  function viewOverview(route) {
    // 历史经验深链仍可追溯，正式资产目录由统一工作台承载。
    if (route.experienceId) return viewExperienceDetail(route);
    if (route.category === 'experiences') return `${hero(T('cognition.experience_title', '经验目录'), '')}${experienceDirectoryHtml()}${experienceMigrationSection()}`;
    if (NS.library) return NS.library.render(route);
    const selected = (S.assets || []).find((asset) => asset && String(asset.id) === String(route.assetId || ''));
    return selected ? assetDetail(selected, route) : '';
  }

  /* ────────────────────────── 视图：经验目录─────────────────────────
   * 经验与资产完全隔离：本区只消费 recall.experiences.* 通道的数据
   * （store.experiences / store.experienceDetail），资产列表零混入；反过来
   * 资产页也不读这里的数据。列表和详情复用既有行、元信息、chip 与折叠区。 */

  /** 来源任务 chip（唯一出口）：回看复用既有 open-kstar-episode 深链，不新建
   *  跳转机制。goal 用载荷里主进程截好的任务目标，展示侧再压 24 字
   *  ——chip 是短标签不是正文区；episodeId 缺席时如实标「来源记录不可用」。 */
  function experienceSourceChip(exp) {
    const episodeId = String((exp.sourceTask && exp.sourceTask.episodeId) || (exp.source && exp.source.episodeId) || '');
    const goal = String((exp.sourceTask && exp.sourceTask.goal) || (exp.source && exp.source.taskGoal) || '');
    if (!episodeId) return chip(T('cognition.experience_source_missing', '来源任务记录不可用'), 'line');
    const label = T('cognition.experience_source_task', '来源任务：《{goal}》', {
      goal: NS.truncateText(goal, 24) || T('cognition.evidence_task_review_generic', '一次任务'),
    });
    return `<span class="tag blue chip-link" data-act="open-kstar-episode" data-id="${esc(episodeId)}" ${roleBtn()} title="${esc(T('cognition.kstar_episode_open_hint', '查看这次任务的复盘'))}">${esc(label)}</span>`;
  }

  /** 列表行：标题 + 来源任务（可点回看）+ 任务类型/验证状态/结果一行元信息。
   *  行本身点开详情（open-experience）；异常态（暂停）出章，正常态不出。 */
  function experienceRow(item) {
    const status = String(item.status || 'active');
    const meta = [
      NS.experience.taskTypeLabel(item.taskType),
      NS.experience.verificationLabel(item.verificationState),
      reviewOutcomeText(item.outcome),
    ].filter(Boolean).join(' · ');
    return `<div class="row is-flat is-clickable" data-act="open-experience" data-id="${esc(item.id)}" ${roleBtn()}>
      <div class="tw">
        <div class="tt">${esc(item.title || '')}</div>
        <div class="catline">${experienceSourceChip(item)}</div>
        ${meta ? `<div class="mm">${esc(meta)}</div>` : ''}
      </div>
      <div class="sd">${status === 'paused' ? chip(NS.experience.statusLabel(status), 'amber') : ''}<span class="chev" aria-hidden="true">›</span></div>
    </div>`;
  }

  /** 合并目标区：复用既有列表行形态，只列**同类型**且非终态的
   *  其他经验——跨类型合并在选择面就被排除（后端仍会拒绝并说明）。 */
  function experienceMergeSection(exp) {
    const others = ((S.experiences && S.experiences.items) || [])
      .filter((row) => String(row.id) !== String(exp.id)
        && NS.experience.groupKey(row.experienceType) === NS.experience.groupKey(exp.experienceType)
        && ['active', 'paused'].includes(String(row.status || 'active')))
      .slice(0, 8);
    if (!others.length) return '';
    const rows = others.map((other) => `<div class="row is-flat">
      <div class="tw"><div class="tt">${esc(other.title || '')}</div><div class="mm">${esc(NS.experience.taskTypeLabel(other.taskType))}</div></div>
      <div class="sd">${btn(T('cognition.experience_merge_into', '并入这条'), 'experience-merge', { id: exp.id, data: { target: String(other.id) }, small: true })}</div>
    </div>`).join('');
    return `<details class="details">
      <summary>${esc(T('cognition.experience_merge_section', '与另一条同类经验合并'))}</summary>
      <p class="note">${esc(T('cognition.experience_merge_hint', '同一条经验的重复条目可合并：来源任务与证据全部并入所选条目，本条不再单独显示。'))}</p>
      ${rows}
    </details>`;
  }

  /** 台账动作 → 人话（与 experience-service 的 history action 一一对应；
   *  未知动作中性兜底，不裸出内部枚举）。 */
  function experienceHistoryLabel(action) {
    return {
      paused: T('cognition.experience_history_paused', '暂停带入'),
      resumed: T('cognition.experience_history_resumed', '恢复带入'),
      type_changed: T('cognition.experience_history_type_changed', '类型调整'),
      merged: T('cognition.experience_history_merged', '并入其他经验'),
      merged_from: T('cognition.experience_history_merged_from', '接收并入'),
      archived: T('cognition.experience_history_archived', '归档清理'),
    }[String(action || '')] || T('cognition.experience_history_unknown', '管理操作');
  }

  /** 详情视图：正文 + 预期/实际 + 适用/禁用范围 + 证据引用 +
   *  合并来源 + 台账 + 四个管理动作。 */
  function viewExperienceDetail(route) {
    const id = String(route.experienceId || '');
    const state = S.experienceDetail;
    const back = btn(T('cognition.experience_back', '← 返回经验目录'), 'go-back', { className: 'backlink' });
    if (!state || String(state.experienceId) !== id || state.loading) {
      return `<div class="ca-asset-page ca-experience-page">${back}<div class="card">${empty(T('cognition.experience_detail_loading', '正在读取这条经验…'))}</div></div>`;
    }
    if (state.failed || !state.experience) {
      return `<div class="ca-asset-page ca-experience-page">${back}<div class="card">${empty(T('cognition.experience_detail_failed', '这条经验读取失败或已不存在'))}</div></div>`;
    }
    const exp = state.experience;
    const status = String(exp.status || 'active');
    const terminal = status === 'archived' || status === 'merged';
    const metaRow = (label, valueHtml) => valueHtml
      ? `<div class="meta-item"><span class="meta-k">${esc(label)}</span><span class="meta-v">${valueHtml}</span></div>`
      : '';
    // 验证状态一行：状态 + 结果（结果沿用复盘语境的既有四语文案，不另造词）。
    // 内部评分字段不展示；验证结果只呈现可核对的状态与结论。
    const verification = exp.verification || {};
    const verificationValue = [
      NS.experience.verificationLabel(verification.state),
      reviewOutcomeText(verification.outcome),
    ].filter(Boolean).join(' · ');
    const applicable = (exp.applicableWhen || []).filter(Boolean);
    const forbidden = (exp.forbiddenWhen || []).filter(Boolean);
    const evidence = (exp.evidenceRefs || [])
      .map((ref) => ((ref && typeof ref === 'object') ? ref : { id: String(ref || '') }))
      .filter((ref) => String(ref.id || '').trim());
    const mergedFrom = exp.mergedFrom || [];
    const historyRows = (exp.history || []).slice(-12).reverse();
    const switchable = status === 'active' || status === 'paused';
    /* 经验独立于正式资产，但详情也采用单列阅读顺序：正文和适用范围在前，
     * 元信息、管理、并入来源与证据随后各占一行。 */
    /* 复盘中的预期与实际可缺省；与正文同属内容区，长值沿用折叠呈现。 */
    const expectedActualHtml = (() => {
      const expected = foldValue(exp.expected, 120);
      const actual = foldValue(exp.actual, 120);
      if (!expected && !actual) return '';
      return `<div class="sect-block">
        <div class="meta-row">
          ${expected ? `<div class="meta-item"><span class="meta-k">${esc(T('cognition.experience_expected', '当时的预期'))}</span><span class="meta-v">${expected}</span></div>` : ''}
          ${actual ? `<div class="meta-item"><span class="meta-k">${esc(T('cognition.experience_actual', '实际发生'))}</span><span class="meta-v">${actual}</span></div>` : ''}
        </div>
      </div>`;
    })();
    /* 管理台账保持折叠，记录内容不丢。 */
    const historyFoldHtml = historyRows.length ? `<details class="details">
      <summary>${esc(T('cognition.experience_history_section', '管理台账'))}</summary>
      <div class="dbody">${historyRows.map((row) => {
        const actor = String(row.actor || '') === 'user' ? T('cognition.audit_actor_user', '你') : String(row.actor || '') === 'system' ? T('cognition.audit_actor_system', '系统') : '';
        const change = (row.from || row.to)
          ? `（${esc(String(row.from || '—'))} → ${esc(String(row.to || '—'))}）`
          : '';
        const reason = row.reason ? ` · ${esc(String(row.reason))}` : '';
        return `<div class="proc-row"><span class="when">${esc(fmtDate(row.at))}</span><span style="flex:1">${actor ? `${esc(actor)} · ` : ''}<b>${esc(experienceHistoryLabel(row.action))}</b>${change}${reason}</span></div>`;
      }).join('')}</div>
    </details>` : '';
    return `<div class="ca-asset-page ca-experience-page">${back}
    <div class="ca-detail-head">
      <div class="rowline">
        <div>
          <h1>${esc(exp.title || '')}</h1>
          <div class="sub">${esc([
            NS.experience.typeLabel(exp.experienceType),
            NS.experience.taskTypeLabel(exp.taskType),
            fmtDate(exp.updatedAt || exp.createdAt),
          ].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="right">${chip(NS.experience.statusLabel(status), status === 'active' ? 'green' : status === 'paused' ? 'amber' : '')}</div>
      </div>
    </div>
    <div class="ca-detail-grid ca-experience-detail-grid">
      <div class="ca-detail-main">
        <div class="card">
          <p class="content-text">${esc(exp.body || '')}</p>
          ${expectedActualHtml}
        </div>
        ${(() => {
          // 适用/禁用范围：缺失 = 没记录过（不是"无限制"）——
          // 显式标注未记录，避免被读成"哪里都能用"。
          const listHtml = (rows) => rows.map((row) => esc(String(row))).join('、');
          return `<div class="card"><div class="sect-block">
            <div class="meta-row">
              <div class="meta-item"><span class="meta-k">${esc(T('cognition.experience_applicable', '适用范围'))}</span><span class="meta-v">${applicable.length ? listHtml(applicable) : esc(T('cognition.experience_applicable_missing', '没有记录过适用范围'))}</span></div>
              <div class="meta-item"><span class="meta-k">${esc(T('cognition.experience_forbidden', '禁用范围'))}</span><span class="meta-v">${forbidden.length ? listHtml(forbidden) : esc(T('cognition.experience_forbidden_missing', '没有记录过禁用范围'))}</span></div>
            </div>
          </div></div>`;
        })()}
      </div>
      <aside class="ca-detail-side">
        <div class="card">
          <div class="sect-block">
            <div class="meta-row">
              ${metaRow(T('cognition.experience_meta_type', '经验类型'), esc(NS.experience.typeLabel(exp.experienceType)))}
              ${metaRow(T('cognition.experience_meta_task_type', '学自哪类任务'), esc(NS.experience.taskTypeLabel(exp.taskType)))}
              ${metaRow(T('cognition.experience_meta_scope', '可用在哪类任务'), esc(NS.experience.taskTypeLabel(exp.scope)))}
              ${metaRow(T('cognition.experience_meta_source', '来源任务'), experienceSourceChip(exp))}
              ${metaRow(T('cognition.experience_meta_verification', '验证状态'), esc(verificationValue))}
            </div>
          </div>
          ${experienceMergedIntoBlock(exp)}
        </div>
        <div class="card">
          ${(() => {
            // 管理动作：终态（已归档/已并入）无管理出口，只说明现状。
            if (!switchable) {
              const note = status === 'merged'
                ? T('cognition.experience_merged_into_note', '这条经验已并入另一条；来源与历史在并入目标上完整保留。')
                : T('cognition.experience_archived_note', '这条经验已归档清理，不再进入任何清单；归档原因与时间记录在台账里。');
              return `<div class="sect-block"><p class="note">${esc(note)}</p></div>`;
            }
            const otherTypes = ['lesson', 'workflow', 'gap', 'uncategorized']
              .filter((type) => NS.experience.groupKey(type) !== NS.experience.groupKey(exp.experienceType));
            return `<div class="sect-block ca-experience-actions">
              <div class="sub"><strong>${esc(T('cognition.experience_manage_section', '管理'))}</strong></div>
              <div class="chips">
                ${btn(status === 'active'
                  ? T('cognition.experience_action_pause', '暂停带入')
                  : T('cognition.experience_action_resume', '恢复带入'),
                'experience-status-toggle', { id: exp.id, data: { action: status === 'active' ? 'pause' : 'resume' }, small: true })}
                ${otherTypes.map((type) => btn(NS.experience.typeLabel(type), 'experience-set-type', { id: exp.id, data: { type }, small: true, className: 'o', title: T('cognition.experience_action_set_type', '调整类型') })).join('')}
                ${btn(T('cognition.experience_action_archive', '归档清理'), 'experience-archive', { id: exp.id, small: true, danger: true })}
              </div>
              <p class="note">${esc(status === 'active'
                ? T('cognition.experience_action_pause_hint', '暂停后新任务的清单不再带入这条经验；历史与引用记录全部保留，随时可恢复。')
                : T('cognition.experience_action_resume_hint', '已暂停：恢复后下一轮清单重新带入。'))}</p>
            </div>`;
          })()}
          ${/* 归并治理和管理台账沿用原交互，按单列放在管理卡内。 */''}
          ${experienceMergeSection(exp)}
          ${historyFoldHtml}
        </div>
        ${mergedFrom.length ? `<div class="card"><div class="sect-block">
          <div class="sub"><strong>${esc(T('cognition.experience_merged_from_section', '并入来源'))}<span class="note">${String(mergedFrom.length)}</span></strong></div>
          ${mergedFrom.map((entry) => `<div class="row is-flat is-clickable" data-act="open-experience" data-id="${esc(String(entry.id || ''))}" ${roleBtn()}>
            <div class="tw"><div class="tt">${esc(entry.title || '')}</div>
            <div class="mm">${esc(T('cognition.experience_merged_from_at', '并入于 {when}', { when: fmtDate(entry.mergedAt) }))}</div></div>
          </div>`).join('')}
        </div></div>` : ''}
        ${evidence.length ? `<div class="card">${(() => {
          // 证据引用块：一律走唯一呈现出口 evidenceChip（内部 id 不上屏）。
          const rowsHtml = evidence.map((ref) => `<div class="evrow">${evidenceChip(ref)}</div>`).join('');
          return `<div class="sect-block"><div class="sub"><strong>${esc(T('cognition.asset_evidence_section', '证据引用'))}<span class="note">${String(evidence.length)}</span></strong></div>${rowsHtml}</div>`;
        })()}</div>` : ''}
      </aside>
    </div></div>`;
  }

  /** merged 终态的去向提示：有目标 id 时给跳转（经验记录不物理删除，
   *  详情仍可读），没有就只说明。函数名避开同名字段（exp.mergedIntoExperienceId）。 */
  function experienceMergedIntoBlock(exp) {
    const targetId = String(exp.mergedIntoExperienceId || '');
    if (String(exp.status || '') !== 'merged' || !targetId) return '';
    return `<div class="sect-block">
      <div class="meta-item"><span class="meta-k">${esc(T('cognition.experience_merged_into_label', '并入去向'))}</span><span class="meta-v"><span class="tag blue chip-link" data-act="open-experience" data-id="${esc(targetId)}" ${roleBtn()}>${esc(T('cognition.experience_open_target', '查看并入后的条目'))}</span></span></div>
    </div>`;
  }

  /** 存量迁移区：页签底部折叠区。预览（只读扫描）→ 逐条核对
   *  → 显式发起（run 必须带 assetIds，单条/批量两个入口都来自可见清单）；
   *  跳过理由与上次结果如实列出（「可核对」，不满足于一枚 toast）。 */
  function experienceMigrationSection() {
    const state = S.experienceMigration;
    const preview = state && state.preview;
    const lastRun = state && state.lastRun;
    const previewItems = (preview && preview.items) || [];
    let body = `<p class="note">${esc(T('cognition.experience_migration_hint', '扫描资产库中带任务复盘沉淀标记的经验类资产，逐条确认后迁入经验目录；迁移会先冻结历史引用，再迁出资产记录。'))}</p>`;
    if (state && state.previewLoading) {
      body += `<p class="note">${esc(T('cognition.experience_migration_scanning', '正在扫描可迁移的存量…'))}</p>`;
    } else if (state && state.previewFailed) {
      body += `<p class="note">${esc(T('cognition.experience_migration_scan_failed', '扫描失败，可重试。'))}${btn(T('common.retry', '重试'), 'experience-migration-preview', { small: true })}</p>`;
    } else if (preview) {
      body += `<p class="note">${esc(T('cognition.experience_migration_preview_count', '扫描 {scanned} 条：可迁 {migratable} 条，跳过 {skipped} 条', {
        scanned: String(preview.scanned || 0),
        migratable: String(preview.migratable || 0),
        skipped: String(preview.skipped || 0),
      }))}</p>`;
      const skipReasons = (preview.skippedReasons) || [];
      if (skipReasons.length) {
        body += `<div class="note">${skipReasons.map((row) => `· ${esc(NS.experience.migrationReasonText(row.reason))} × ${esc(String(row.count || 0))}`).join('<br>')}</div>`;
      }
      if (previewItems.length) {
        // 迁移执行中（state.running）：两个执行入口置灰（对齐批量打标/
        // 旧记忆迁移的做法）——执行中的写入广播会 drain 重画换 DOM，
        // disabled 是 store 态驱动的，重画后仍成立。
        const running = Boolean(state && state.running);
        body += previewItems.map((item) => `<div class="row is-flat">
          <div class="tw">
            <div class="tt">${esc(item.title || '')}</div>
            <div class="mm">${esc([
              categoryLabel(item.assetType),
              NS.experience.typeLabel(item.experienceTypeGuess),
              item.frozenProjections ? T('cognition.experience_migration_frozen_refs', '将冻结 {n} 处历史引用', { n: String(item.frozenProjections) }) : '',
            ].filter(Boolean).join(' · '))}</div>
          </div>
          <div class="sd">${btn(T('cognition.experience_migration_run_one', '迁这一条'), 'experience-migration-run', { data: { asset: String(item.assetId || '') }, disabled: running, small: true })}</div>
        </div>`).join('');
        body += `<div class="actions">${btn(T('cognition.experience_migration_run_all', '迁移以上 {n} 条', { n: String(previewItems.length) }), 'experience-migration-run', { data: { assets: previewItems.map((item) => String(item.assetId || '')).filter(Boolean).join(',') }, primary: true, disabled: running, small: true })}</div>`;
      } else {
        body += `<p class="note">${esc(T('cognition.experience_migration_nothing', '没有可迁移的存量：资产库里没有带任务复盘沉淀标记的经验类资产。'))}</p>`;
      }
    } else {
      body += `<div class="actions">${btn(T('cognition.experience_migration_scan', '扫描可迁移的存量'), 'experience-migration-preview', { small: true })}</div>`;
    }
    if (lastRun) {
      const titleById = new Map(previewItems.map((item) => [String(item.assetId || ''), String(item.title || '')]));
      const details = (lastRun.details) || [];
      body += `<div class="sect-block">
        <div class="tt">${esc(T('cognition.experience_migration_last_run', '上次迁移：已迁 {migrated} 条，跳过 {skipped} 条，失败 {failed} 条', {
          migrated: String(lastRun.migrated || 0),
          skipped: String(lastRun.skipped || 0),
          failed: String(lastRun.failed || 0),
        }))}</div>
        ${details.slice(0, 20).map((row) => `<div class="proc-row"><span style="flex:1">${esc(titleById.get(String(row.assetId || '')) || T('cognition.experience_migration_detail_untitled', '（一条经验类资产）'))}</span><span class="note">${esc(NS.experience.migrationReasonText(row.reason))}</span></div>`).join('')}
      </div>`;
    }
    body += `<div class="actions">${btn(T('cognition.experience_migration_view_status', '查看上次迁移结果'), 'experience-migration-status', { small: true, className: 'o' })}</div>`;
    return `<details class="details ca-experience-migration">
      <summary>${esc(T('cognition.experience_migration_title', '存量迁移'))}<span class="note">${esc(T('cognition.experience_migration_short_hint', '把旧的 KSTAR 经验类资产迁入经验目录'))}</span></summary>
      <div class="dbody">${body}</div>
    </details>`;
  }

  /** 经验目录本体：嵌在「我的认知」经验档中：
   *  按经验类型分组（lesson → workflow → gap → uncategorized 固定顺序，只摆
   *  非空组）；列表只放非终态（active/paused——archived/merged 是终态，不再
   *  占目录；合并的来源在目标详情的「并入来源」里可见）。三态分开：
   *  载入中 / 读取失败（给重试）/ 空态。 */
  function experienceDirectoryHtml() {
    const state = S.experiences;
    if (!state || state.loading) {
      return `<div class="card">${empty(T('cognition.experience_loading', '正在读取经验目录…'))}</div>`;
    }
    if (state.failed) {
      // 读不到 ≠ 没有（五态要求）：失败与空态分开，失败给重试出口。
      return `<div class="card">${empty(T('cognition.experience_load_failed', '经验目录读取失败'))}${btn(T('common.retry', '重试'), 'refresh', { small: true })}</div>`;
    }
    const items = ((state.items) || []).filter((item) => ['active', 'paused'].includes(String(item.status || 'active')));
    const groups = ['lesson', 'workflow', 'gap', 'uncategorized'].map((type) => ({
      type,
      rows: items.filter((item) => NS.experience.groupKey(item.experienceType) === type),
    })).filter((group) => group.rows.length);
    return groups.length
      ? groups.map((group) => `${sectionHead(NS.experience.typeLabel(group.type), String(group.rows.length))}
          <div class="card">${group.rows.map(experienceRow).join('')}</div>`).join('')
      : `<div class="card">${empty(
        T('cognition.experience_empty', '还没有沉淀下来的经验'),
        T('cognition.experience_empty_hint', '任务完结、复盘沉淀出经验后会出现在这里；经验与正式资产分开管理。'),
      )}</div>`;
  }

  /* ───────────────── KSTAR 复盘历史区块 ─────────────────
   * 两线不拆 tab：KSTAR 任务复盘作为「我的认知」页底部折叠区（默认收起），
   * 每场被复盘的任务一行，点行就地展开完整复盘（复用 kstarEpisodeSection）。 */
  function kstarEpisodesSection(route) {
    const episodes = Array.isArray(S.kstarEpisodes) ? S.kstarEpisodes : [];
    const openId = String(route.kstarEpisodeId || '');
    const rows = (episodes || []).map((ep) => {
      // goal 兼容两种形态：kstar.episodes.list 返回平铺 goal 字段（精简
      // 摘要）；完整 episode 记录里在 t.userGoal——此前只读后者，列表
      // 全显示"（未记录目标）"。
      const goal = String(ep.goal || (ep.t && ep.t.userGoal) || '').trim();
      const at = String(ep.updatedAt || ep.createdAt || '');
      const isOpen = openId === String(ep.id || '');
      return `<div class="row is-flat is-clickable" data-act="open-kstar-episode" data-id="${esc(String(ep.id || ''))}" ${roleBtn()}>
        <div class="tw">
          <div class="tt">${esc(goal || T('cognition.kstar_episode_no_goal', '（未记录目标）'))}</div>
          <div class="mm">${esc(fmtDate(at))}</div>
        </div>
      </div>${isOpen ? kstarEpisodeSection(route) : ''}`;
    }).join('');
    const body = episodes === null
      ? `<div class="card">${empty(T('cognition.kstar_episodes_loading', '正在读取任务复盘列表…'))}</div>`
      : episodes.length
        ? `<div class="card">${rows}</div>`
        : `<div class="card">${empty(T('cognition.kstar_episodes_empty', '还没有被复盘过的任务'))}</div>`;
    return `<details class="details ca-kstar-episodes"${openId ? ' open' : ''}>
      <summary>${esc(T('cognition.evidence_group_kstar', '任务复盘'))}<span class="note">${esc(T('cognition.kstar_episodes_hint', '任务完结后系统自动复盘：当时的任务、实际发生、为什么、学到的经验。点开看完整复盘。'))}</span></summary>
      ${body}
    </details>`;
  }

  /* ────────── 改进分析（只读分区）──────────────
   * 分析过但**没形成候选**的结论如实列出：结论标签 + 人话原因 + 来源任务 + 时间。
   * 这里只读、**不进待办**（结论是终态快照，不是要用户决定的事）；失败类结论给一个
   * 就地展开的「看失败详情」，数据来自既有失败面 `kstar.failures.list`。
   * 隐私口径：只渲染契约里明列的字段（结论/原因/来源任务/时间 + 失败环节），
   * **不整条 dump 记录**——受限正文不进界面；`errorMessage` 原文也不上屏。 */
  const IMPROVEMENT_CONCLUSIONS = {
    no_update: ['cognition.improvement_conclusion_no_update', '无需更新', 'line'],
    insufficient_evidence: ['cognition.improvement_conclusion_insufficient_evidence', '证据不足', 'amber'],
    analysis_failed: ['cognition.improvement_conclusion_analysis_failed', '分析失败', 'red'],
    submit_failed: ['cognition.improvement_conclusion_submit_failed', '提交失败', 'red'],
  };
  const IMPROVEMENT_FAILURE_CONCLUSIONS = new Set(['analysis_failed', 'submit_failed']);
  const IMPROVEMENT_FAILURE_STAGES = {
    capture: ['cognition.improvement_failure_stage_capture', '沉淀'],
    review_inference: ['cognition.improvement_failure_stage_review_inference', '复盘分析'],
    precipitation: ['cognition.improvement_failure_stage_precipitation', '沉淀落库'],
    control_receipt: ['cognition.improvement_failure_stage_control_receipt', '回执下发'],
  };

  /** 失败详情（就地展开，只读）：环节 + 时间 + 失败标识——够用户/支持去失败面核对，
   *  又不把内部错误原文（可能是内部措辞或夹带正文）搬上屏。 */
  function improvementFailureDetail(outcome) {
    const state = S.kstarFailures;
    const episodeId = String(outcome.episodeId || '');
    const items = (state && Array.isArray(state.items))
      ? state.items.filter((failure) => String(failure.episodeId || '') === episodeId)
      : [];
    const rows = items.slice(0, 5).map((failure) => {
      const stageEntry = IMPROVEMENT_FAILURE_STAGES[String(failure.stage || '')];
      const stage = stageEntry
        ? T(stageEntry[0], stageEntry[1])
        : T('cognition.improvement_failure_stage_other', '未知环节');
      const at = String(failure.at || '');
      const code = String(failure.errorCode || '');
      return `<div class="rowline">
        <span class="note">${esc(stage)}${at ? ` · ${esc(fmtDate(at))}` : ''}</span>
        ${code ? `<span class="note">${esc(T('cognition.improvement_failure_code', '失败标识：{code}', { code }))}</span>` : ''}
      </div>`;
    }).join('');
    const body = !state || state.loading
      ? `<p class="note">${esc(T('cognition.improvement_failure_loading', '正在读取失败详情…'))}</p>`
      : rows || `<p class="note">${esc(T('cognition.improvement_failure_empty', '失败记录里暂时没有查到这条的详情。'))}</p>`;
    return `<details class="details"><summary>${esc(T('cognition.improvement_failure_detail', '看失败详情'))}</summary><div class="dbody">${body}</div></details>`;
  }

  function improvementOutcomeRow(outcome, route) {
    const conclusion = String(outcome.conclusion || '');
    // 认不出的结论给中性标签，不编造"无需更新"这类具体结论（不冒充）。
    const entry = IMPROVEMENT_CONCLUSIONS[conclusion]
      || ['cognition.improvement_conclusion_other', '分析结论', 'line'];
    const episodeId = String(outcome.episodeId || '');
    const at = String(outcome.updatedAt || outcome.createdAt || '');
    const reason = stripInternalIds(String(outcome.reason || '').trim());
    const isOpen = String(route.kstarEpisodeId || '') === episodeId;
    return `<div class="row is-flat">
      <div class="tw">
        <div class="tt">${chip(T(entry[0], entry[1]), entry[2])}</div>
        <div class="mm">${episodeId
          ? evidenceChip({ kind: 'execution', id: episodeId })
          : esc(T('cognition.improvement_task_missing', '这次分析没有关联到具体的任务复盘。'))}${at ? ` · ${esc(fmtDate(at))}` : ''}</div>
        ${reason ? foldValue(reason) : ''}
        ${IMPROVEMENT_FAILURE_CONCLUSIONS.has(conclusion) ? improvementFailureDetail(outcome) : ''}
      </div>
    </div>${isOpen ? kstarEpisodeSection(route) : ''}`;
  }

  function improvementAnalysisSection(route) {
    const state = S.improvementOutcomes;
    const items = (state && Array.isArray(state.items)) ? state.items : [];
    const title = T('cognition.improvement_section', '改进分析');
    // 同一 episode 已经产出候选时，
    // 不再摆该 episode 的「无需更新」——"无需更新"与"这里有更新提议"同屏自相矛盾。
    // 只隐藏这一种组合，其余结论照旧（隐藏依据是已加载的候选，不猜）。
    const candidateEpisodes = new Set(S.candidates
      .map((row) => String((row.learningProvenance && row.learningProvenance.episodeId) || ''))
      .filter(Boolean));
    const visible = items.filter((row) => !(
      String(row.conclusion || '') === 'no_update'
      && candidateEpisodes.has(String(row.episodeId || ''))
    ));
    if (state && !state.loading && !state.failed && visible.length) {
      // 有结论时收进折叠区（默认收起）：它是记录，不与上面的待办抢注意力。
      return `<details class="details fold ca-improvement">
        <summary>${esc(title)}<span class="n">${visible.length}</span></summary>
        <div class="dbody">
          <div class="note">${esc(T('cognition.improvement_section_hint', '分析过但没有形成候选的结论：只作记录，不需要你处理。'))}</div>
          ${visible.map((outcome) => improvementOutcomeRow(outcome, route)).join('')}
        </div>
      </details>`;
    }
    // 读取中 / 读取失败 / 空态三态分开（五态要求：读不到 ≠ 没有）。
    const body = !state || state.loading
      ? `<p class="note">${esc(T('cognition.improvement_loading', '正在读取改进分析结论…'))}</p>`
      : state.failed
        ? `<div class="rowline"><span class="note">${esc(T('cognition.improvement_read_failed', '改进分析结论暂时读不到。'))}</span>${btn(T('common.retry', '重试'), 'refresh', { small: true, className: 'o' })}</div>`
        : empty(
          T('cognition.improvement_empty', '还没有改进分析结论'),
          T('cognition.improvement_empty_hint', '任务复盘后如果分析出要改进的方法，结论会出现在这里；形成候选的会进「等待你确认」。'),
        );
    return `<div class="sect-block ca-improvement-empty">${sectionHead(title)}${body}</div>`;
  }

  /* ────────────────────────── 使用记录零件 ────────────────────────── */

  const PROOF_FEEDBACKS = [
    ['positive', 'cognition.proof_carried_in', '有用'],
    ['rework', 'cognition.proof_rework', '没用对'],
    ['neutral', 'cognition.proof_no_diff', '没差别'],
    ['invalid', 'cognition.proof_degraded', '说不清'],
  ];

  /** 时间线事件标题：优先用 kind（稳定枚举）映射成人话；英文标题仅作兜底。
   *  此前只映射了 title 的三种英文串，usage_recorded / projection_confirmed
   *  两类漏网，全部补齐；未知事件原样显示不编造。 */
  const EVENT_TITLES = {
    asset_created: ['cognition.proof_event_created', '已创建资产'],
    asset_version: ['cognition.proof_event_version', '版本已保存'],
    asset_updated: ['cognition.proof_event_updated', '资产已更新'],
    projection_confirmed: ['cognition.proof_event_projection', '被带入一次任务'],
    usage_recorded: ['cognition.proof_event_usage', '任务中被实际使用'],
    catalog_hint_unused: ['cognition.proof_event_catalog_hint_unused', '相关而未被用'],
  };
  const EVENT_TITLE_BY_TEXT = {
    'Asset created': EVENT_TITLES.asset_created,
    'Asset version saved': EVENT_TITLES.asset_version,
    'Asset updated': EVENT_TITLES.asset_updated,
  };
  const proofEventTitle = (proof) => {
    const byKind = EVENT_TITLES[String(proof.kind || '')];
    if (byKind) return T(byKind[0], byKind[1]);
    const raw = String(proof.outcome || proof.title || proof.kind || '');
    const byText = EVENT_TITLE_BY_TEXT[raw];
    if (byText) return T(byText[0], byText[1]);
    // title 可能是历史数据里的自然语言标题，保留原文；outcome/kind 是内部
    // 枚举，认不出时宁可给占位文案也不裸 snake_case 机器码。
    if (proof.title) return String(proof.title);
    return T('cognition.proof_event_other', '证明事件');
  };

  /* ────────────────────────── 视图：整理（任务流 + 策略） ────────────────────────── */

  /* ────────────────────────── 沉淀设置页 ────────────────────────── */

  /** 标题重起轮判定：重起轮的整理报告或以
   *  独立 trigger 值标记本轮、或由 kind='title_regen' 的报告项可辨——两种载体
   *  形态都认；导语、文案按它区分轮次（规则轮沿用原文案；LLM 重起轮上"只自动
   *  规范标题、合并重复项"是假话——重起轮不做合并）。 */
  const isTitleRegenReport = (report) => Boolean(report)
    && (String(report.trigger || '') === 'title_regen'
      || (Array.isArray(report.items) && report.items.some((item) => String(item.kind || '') === 'title_regen')));

  function viewOrganizeSettingsPage() {
    const settings = S.captureSettings || {};
    const stateUnknown = Boolean(S.captureModelError) || !S.captureSettings;
    const nightlyOn = settings.enabled !== false;
    const discovery = NS.assetSettings.discoveryStatus(S.captureStats, S.captureStatsError);
    const budget = !S.captureStatsError && S.captureStats?.budget;
    const budgetNote = budget?.recorded ? T('cognition.settings_model_usage', '夜间窗口 {night}：模型调用 {calls} 次，其中已有内容整理 {stockCalls} 次。已报告 {tokens} token，{unknown} 次用量未知。', {
      night: budget.windowKey, calls: String(budget.calls), stockCalls: String(budget.stock?.calls || 0), tokens: String(budget.reportedTokens),
      unknown: String(budget.unknownUsageCalls),
    }) : budget ? T('cognition.settings_model_usage_unrecorded', '本窗口暂无模型调用记录。') : '';
    const discoveryLabels = {
      stopped: T('cognition.scan_phase_stopped', '本次停止'),
      budget_held: T('cognition.scan_phase_budget_held', '上次因旧额度限制暂停'),
      failure_held: T('cognition.scan_phase_failure_held', '模型异常，扫描暂停'),
      unknown: T('cognition.settings_discovery_unknown', '状态暂时无法读取'),
      never: T('cognition.settings_discovery_never', '尚无运行记录'),
      running: T('cognition.settings_discovery_running', '运行中'),
      partial_complete: T('cognition.settings_discovery_partial', '部分完成'),
      failed: T('cognition.settings_discovery_failed', '最近运行有失败'),
      completed: T('cognition.settings_discovery_completed', '最近运行已完成'),
      missed: T('cognition.settings_discovery_missed', '上次窗口未运行'),
      scheduled: T('cognition.settings_discovery_scheduled', '等待运行'),
    };
    const failureReasons = {
      connection: T('cognition.scan_failure_connection', '模型连接失败'),
      model_error: T('cognition.scan_failure_model_error', '模型请求失败'),
      empty_output: T('cognition.scan_failure_empty_output', '模型返回空内容'),
    };
    const failureReason = failureReasons[budget?.failureGuard?.reason] || failureReasons.model_error;
    const discoveryNote = discovery.state === 'failure_held'
      ? T('cognition.settings_scan_failure_hold', '{reason}，连续 {count} 个处理任务未完成。检查模型设置或连接后，点击“立即扫描”重试；进度保留。', {
        reason: failureReason, count: String(budget?.failureGuard?.consecutiveFailures || 3),
      }) : discovery.state === 'budget_held'
        ? T('cognition.settings_scan_legacy_hold', '旧次数上限已取消。点击“立即扫描”接续上次进度。')
        : discovery.state === 'missed'
          ? T('cognition.settings_discovery_missed_note', '上次窗口未运行；可立即扫描，不会自动补扫。')
          : discovery.state === 'scheduled'
            ? (S.captureStats?.window?.withinWindow
              ? T('cognition.settings_discovery_due', '本次窗口内，可立即扫描。')
              : T('cognition.settings_discovery_waiting', '等待下次自动运行。'))
        : ['completed', 'failed', 'partial_complete'].includes(discovery.state)
      ? [T('cognition.settings_discovery_counts', '检查 {day} 的 {scanned} 场对话 · 初筛保留 {queued} 场继续价值判断。', { day: discovery.reviewDay || T('cognition.settings_discovery_previous_day', '前一完整日'), scanned: String(discovery.scanned), queued: String(discovery.queued) }),
        discovery.deferred ? T('cognition.settings_discovery_deferred', '延后 {count} 场。', { count: String(discovery.deferred) }) : '',
        discovery.failed ? T('cognition.settings_discovery_errors', '失败 {count} 场。', { count: String(discovery.failed) }) : '',
        discovery.state === 'failed' ? T('cognition.settings_nightly_failure_review_hint', '本轮扫描未全部完成，后台会记录原因；完整建议按确认规则处理。') : '',
        ['failed', 'partial_complete'].includes(discovery.state) ? T('cognition.settings_run_continue', '本轮未全部完成；检查失败原因后，点击“立即扫描”继续。') : '',
      ].filter(Boolean).join(' ')
      : discovery.state === 'unknown'
        ? T('cognition.settings_discovery_read_failed', '暂时无法核实最近发现结果。')
        : discovery.state === 'running'
          ? T('cognition.settings_discovery_in_progress', '扫描对话与已有认知、本体，形成完整建议。')
          : discovery.state === 'stopped' ? discoveryLabels[discovery.state] : T('cognition.settings_discovery_waiting', '暂无扫描记录。夜间运行，或点击“立即扫描”。');
    const switchHtml = (label, checked, act, disabled) => window.uiSwitch({ label, checked, disabled, attrs: { 'data-act': act } });
    const discoveryPill = window.uiStatusPill({
      label: discovery.state === 'running' ? T('cognition.settings_discovery_running', '运行中')
        : stateUnknown ? T('cognition.settings_policy_unknown', '状态未知')
          : nightlyOn ? T('cognition.settings_discovery_allowed', '允许') : T('cognition.settings_status_off', '已暂停'),
      tone: discovery.state === 'running' ? 'attention' : !stateUnknown && nightlyOn ? 'success' : 'neutral',
    });
    const runtimePill = window.uiStatusPill({
      label: discoveryLabels[discovery.state],
      tone: ['failed', 'partial_complete', 'running', 'failure_held', 'missed', 'error'].includes(discovery.state) ? 'attention' : discovery.state === 'completed' ? 'success' : 'neutral',
    });
    const scanButton = btn(discovery.state === 'running'
      ? T('cognition.settings_discovery_scanning', '扫描中…') : T('cognition.settings_discovery_scan_now', '立即扫描'),
    'nightly-scan-now', { small: true, disabled: stateUnknown || !nightlyOn || discovery.state === 'running' });
    const sweep = !S.captureStatsError && S.captureStats?.sweep;
    const progress = sweep?.discovery || {};
    const inspection = sweep?.inspection || {};
    const stock = sweep?.stock;
    const phaseLabels = {
      inventory: T('cognition.scan_phase_inventory', '清点'),
      discovery: T('cognition.scan_phase_discovery', '发现新内容'),
      inspection: T('cognition.scan_phase_inspection', '巡检已有内容'),
      reconcile: T('cognition.scan_phase_reconcile', '核对建议'),
      conversations: T('cognition.scan_phase_conversations', '处理对话'),
      organizing: T('cognition.scan_phase_organizing', '整理'), checking: T('cognition.scan_phase_checking', '核对'),
      complete: T('cognition.scan_phase_complete', '完成'), stopped: T('cognition.scan_phase_stopped', '本次停止'),
      budget_held: T('cognition.scan_phase_budget_held', '上次因旧额度限制暂停'),
      failure_held: T('cognition.scan_phase_failure_held', '模型异常，扫描暂停'),
      failed: T('cognition.settings_discovery_failed', '最近运行有失败'),
      partial_complete: T('cognition.settings_discovery_partial', '部分完成'),
    };
    const discoveryProgress = Number(progress.ranges || progress.queued) ? T('cognition.settings_discovery_progress', '发现：检查 {ranges} 段对话，{queued} 段进入处理。', {
      ranges: String(progress.ranges || 0), queued: String(progress.queued || 0),
    }) : '';
    const inspectionProgress = Number(inspection.scanned) ? T('cognition.settings_inspection_progress', '巡检：检查 {scanned} 条，发现 {findings} 组（重复 {duplicate}、冲突 {conflict}、建议复核 {outdated}），跳过已由本轮更新处理 {skipped} 条。', {
      scanned: String(inspection.scanned || 0), findings: String(inspection.findings || 0),
      duplicate: String(inspection.duplicate || 0), conflict: String(inspection.conflict || 0),
      outdated: String(inspection.outdated || 0), skipped: String(inspection.skippedClaimed || 0),
    }) : '';
    const stockProgress = stock ? T('cognition.settings_stock_progress', '存量：检查 {checked}/{total} 条，建议 {proposed} 组，保存结果 {saved} 条，无需修改 {noChange}，依据不足 {insufficient}，失败 {failed}，剩余 {remaining}。', {
      ...stock, failed: stock.failed || 0,
    }) : '';
    const receipt = sweep?.receipt;
    const items = Array.isArray(receipt?.items) ? receipt.items : [];
    const countItems = status => items.filter(item => item.status === status).length;
    const itemSummary = items.length ? T('cognition.settings_run_item_counts', '对话：完成 {completed}，失败 {failed}，待处理 {pending}，跳过 {skipped}，部分完成 {partial}。', {
      completed: String(countItems('completed')), failed: String(countItems('failed')),
      pending: String(countItems('pending')), skipped: String(countItems('skipped')), partial: String(countItems('partial')),
    }) : '';
    const reasons = {
      source_removed: T('cognition.settings_run_reason_removed', '来源已移除'),
      source_paused: T('cognition.settings_run_reason_paused', '来源已暂停'),
      source_unavailable: T('cognition.settings_run_reason_source', '来源暂不可读取'),
      model_not_configured: T('cognition.settings_run_reason_config', '未配置模型'),
      model_auth_required: T('cognition.settings_run_reason_auth', '模型需要授权'),
      invalid_model_output: T('cognition.settings_run_reason_output', '模型结果无法识别'),
      formation_baseline_stale: T('cognition.settings_run_reason_changed', '处理期间内容多次变化'),
      stock_model_unavailable: T('cognition.settings_run_reason_connection', '模型连接失败'),
      stock_output_invalid: T('cognition.settings_run_reason_output', '模型结果无法识别'),
      stock_baseline_changed: T('cognition.settings_run_reason_changed', '处理期间内容多次变化'),
      summary_output_invalid: T('cognition.settings_run_reason_summary_invalid', '对话摘要未通过检查，点击“立即扫描”重试。'),
      summary_budget_exhausted: T('cognition.settings_run_reason_summary_long', '对话摘要过长，无法完成；可将内容分到新对话后再扫描。'),
      extraction_context_too_large: T('cognition.settings_run_reason_context_long', '对话内容过长，无法完整处理；可将内容分到新对话后再扫描。'),
      candidate_save_failed: T('cognition.settings_run_reason_save', '建议未能保存；检查存储后点击“立即扫描”重试。'),
      formation_baseline_unavailable: T('cognition.settings_run_reason_baseline', '相关认知或版本不可读取；核对内容与权限后重新扫描。'),
      candidate_support_unavailable: T('cognition.settings_run_reason_support', '建议依据尚未核对，未能形成完整建议；请核对相关内容后重新扫描。'),
      related_assets_overflow: T('cognition.settings_run_reason_overflow', '这项关联认知超过当前处理上限，未能形成建议；请人工核对相关认知。'),
      context_too_large: T('cognition.settings_run_reason_context_long', '对话内容过长，无法完整处理；可将内容分到新对话后再扫描。'),
      uncertainty_context_too_large: T('cognition.settings_run_reason_context_long', '对话内容过长，无法完整处理；可将内容分到新对话后再扫描。'),
      uncertainty_context_unavailable: T('cognition.settings_run_reason_source', '来源暂不可读取'),
      assessment_invalid: T('cognition.settings_run_reason_output', '模型结果无法识别'),
      uncertainty_assessment_invalid: T('cognition.settings_run_reason_output', '模型结果无法识别'),
      uncertainty_model_unavailable: T('cognition.settings_run_reason_model_unavailable', '模型暂不可用，请检查模型设置后重试。'),
    };
    const itemStates = {
      completed: T('cognition.settings_run_completed', '已完成'), failed: T('cognition.settings_run_failed', '失败'),
      pending: T('cognition.settings_run_pending', '待处理'), skipped: T('cognition.settings_run_skipped', '已跳过'),
      partial: T('cognition.settings_discovery_partial', '部分完成'),
    };
    const itemTitle = item => (S.captures || []).find(row => String(row.id) === String(item.captureId))?.conversationTitle
      || S.conversationTitles?.[item.conversationId] || T('cognition.settings_run_conversation', '对话');
    const failures = items.filter(item => item.status === 'failed' || item.status === 'partial').map(item => {
      const groups = Array.isArray(item.failures) ? item.failures : [];
      const groupDetails = groups.map(group => {
        const number = Number.isInteger(group.candidateIndex) && group.candidateIndex >= 0 ? String(group.candidateIndex + 1) : '?';
        const stage = group.stage === 'uncertainty' ? T('cognition.settings_run_group_uncertainty', '不确定内容核对') : T('cognition.settings_run_group_grounding', '依据核对');
        const reason = reasons[group.reason] || T('cognition.settings_run_reason_support', '建议依据尚未核对，未能形成完整建议；请核对相关内容后重新扫描。');
        return `<li>${esc(T('cognition.settings_run_group_failure', '第 {number} 项 · {stage}：{reason}', { number, stage, reason }))}</li>`;
      }).join('');
      const saved = Array.isArray(item.candidateIds) ? item.candidateIds.length : 0;
      const savedText = saved ? `<p>${esc(T('cognition.settings_run_saved_suggestions', '已保留 {count} 条建议，可在“查看本轮建议”中核对。', { count: String(saved) }))}</p>` : '';
      return `<li>${esc(itemTitle(item))}：${esc(itemStates[item.status])}${savedText}${groupDetails ? `<ul>${groupDetails}</ul>` : ` · ${esc(reasons[item.errorCode] || T('cognition.settings_run_reason_unknown', '处理失败，原因待核对'))}`}</li>`;
    }).join('');
    const conversationItems = items.map(item => `<li>${esc(itemTitle(item))}：${esc(itemStates[item.status] || itemStates.pending)}</li>`).join('');
    const coverage = inspection.coverage;
    const coverageText = coverage ? T('cognition.settings_inspection_coverage', '旧内容：累计检查 {evaluated}/{total} 条，剩余 {remaining} 条，其中 {unavailable} 条不可读取；相似或矛盾内容仍可能有遗漏。', {
      evaluated: String(coverage.evaluated), total: String(coverage.total), remaining: String(coverage.remaining), unavailable: String(coverage.unavailable || 0),
    }) : '';
    const unavailableIds = new Set(Array.isArray(inspection.unavailableAssetIds) ? inspection.unavailableAssetIds.map(String) : []);
    const inspectionNames = (ids) => (Array.isArray(ids) ? ids : []).filter(id => !unavailableIds.has(String(id))).map(id => {
      const asset = !S.assetsError && (S.assets || []).find(row => String(row.id) === String(id));
      return `<li>${esc(asset?.title || T('cognition.settings_inspection_name_unavailable', '名称暂不可读取'))}</li>`;
    }).join('');
    const inspectedNames = inspectionNames(inspection.evaluatedAssetIds);
    const coveredNames = inspectionNames(inspection.coveredAssetIds);
    const pendingNames = inspectionNames(inspection.pendingAssetIds);
    const inspectionDetails = inspectedNames || coveredNames || pendingNames || unavailableIds.size
      ? `<details class="details"><summary>${esc(T('cognition.settings_inspection_details', '查看检查范围'))}</summary>${coveredNames ? `<p>${esc(T('cognition.settings_inspection_covered', '累计已检查'))}</p><ul>${coveredNames}</ul>` : ''}${inspectedNames ? `<p>${esc(T('cognition.settings_inspection_this_batch', '本次检查'))}</p><ul>${inspectedNames}</ul>` : ''}${pendingNames ? `<p>${esc(T('cognition.settings_inspection_pending', '尚未检查'))}</p><ul>${pendingNames}</ul>` : ''}${unavailableIds.size ? `<p class="note">${esc(T('cognition.settings_inspection_unavailable_count', '{count} 条不可读取，未显示名称。', { count: String(unavailableIds.size) }))}</p>` : ''}</details>` : '';
    const inspectionError = inspection.error ? T(inspection.error === 'inspection_baseline_stale' ? 'cognition.settings_inspection_changed' : 'cognition.settings_inspection_failed',
      inspection.error === 'inspection_baseline_stale' ? '检查期间内容发生变化，点击“立即扫描”继续。' : '旧内容检查失败，点击“立即扫描”重试。') : '';
    const reconcileError = sweep?.reconcile?.error ? T('cognition.settings_reconcile_failed', '结果汇总未完成，点击“立即扫描”继续。') : '';
    const stockItems = Object.entries(stock?.items || {}).map(([key, item]) => {
      const asset = key.startsWith('asset-') ? (S.assets || []).find(row => String(row.id) === key.slice(6)) : null;
      const ontology = key.startsWith('ontology-') ? S.ontologySnapshot?.records?.[key.slice(9)] : null;
      const title = asset?.title || ontology?.name || T('cognition.settings_run_existing_item', '已有内容');
      const state = itemStates[item.status] || itemStates.pending;
      const reason = item.status === 'failed' ? reasons[item.errorCode] || T('cognition.settings_run_reason_unknown', '处理失败，原因待核对') : '';
      return `<li>${esc(title)}：${esc(state)}${reason ? ` · ${esc(reason)}` : ''}</li>`;
    }).join('');
    const progressHtml = `${sweep?.phase && !['stopped', 'partial_complete', 'budget_held', 'failure_held', 'missed', 'scheduled'].includes(discovery.state) ? `<p role="status">${esc(phaseLabels[sweep.phase] || '')}</p>` : ''}${discoveryProgress ? `<p class="note">${esc(discoveryProgress)}</p>` : ''}${itemSummary ? `<p class="note">${esc(itemSummary)}</p>` : ''}${failures ? `<ul>${failures}</ul>` : ''}${conversationItems ? `<details class="details"><summary>${esc(T('cognition.settings_run_conversation_details', '查看对话处理结果'))}</summary><ul>${conversationItems}</ul></details>` : ''}${inspectionProgress ? `<p class="note">${esc(inspectionProgress)}</p>` : ''}${inspectionError ? `<p role="alert">${esc(inspectionError)}</p>` : ''}${coverageText ? `<p class="note">${esc(coverageText)}</p>` : ''}${inspectionDetails}${stockProgress ? `<p class="note">${esc(stockProgress)}</p>` : ''}${stockItems ? `<details class="details"><summary>${esc(T('cognition.settings_run_existing_details', '查看已有内容处理结果'))}</summary><ul>${stockItems}</ul></details>` : ''}${reconcileError ? `<p role="alert">${esc(reconcileError)}</p>` : ''}`;
    const runtimeCard = NS.assetSettings.settingCard({
      title: T('cognition.settings_recent_run', '最近运行'),
      hint: discovery.at ? fmtDate(discovery.at) : '',
      controls: runtimePill,
      bodyHtml: `${progressHtml}<p class="note">${esc(discoveryNote)}</p>${budgetNote ? `<p class="note">${esc(budgetNote)}</p>` : ''}<div class="actions">${btn(T('cognition.settings_view_run_suggestions', '查看本轮建议'), 'go-run-review', { small: true, disabled: !receipt?.runId })}${btn(T('cognition.settings_view_all_suggestions', '查看全部建议'), 'go-review', { small: true })}</div>`,
    });
    return `<section class="ca-settings-page"><div class="ca-settings-shell">
      <div class="ca-settings-cards" aria-label="${esc(T('cognition.settings_policy_label', '认知资产设置'))}">
        <div id="ca-settings-organize" tabindex="-1">${NS.assetSettings.settingCard({
          title: T('cognition.settings_discovery_title', '夜间发现'),
          hint: T('cognition.settings_discovery_hint', '检查新对话与新增消息，巡检已有认知与本体，包括内容合并与拆分。'),
          controls: `${discoveryPill}${switchHtml(T('cognition.settings_discovery_switch', '允许夜间发现'), nightlyOn, 'nightly-toggle', stateUnknown)}`,
          bodyHtml: `<div class="ca-discovery-row"><div class="ca-discovery-copy"><p class="note">${esc(T('cognition.settings_nightly_window', '自动：{start}–{end}；手动“立即扫描”可随时处理。应用需运行，会消耗模型额度。窗口内启动，错过不补扫。', { start: settings.nightlyStart || '02:00', end: settings.nightlyEnd || '06:00' }))}</p><p class="note">${esc(T('cognition.settings_organization_hint', '没有新对话时，巡检已有认知与本体，给出整理、冲突或建议复核的提醒。建议经你确认后保存；连续 3 个模型处理任务失败时停止本轮，保留进度。'))}</p></div><div class="ca-setting-head-ctl ca-discovery-actions">${scanButton}${discovery.state === 'running' ? btn(T('cognition.settings_scan_stop', '停止本次'), 'nightly-scan-stop', { small: true }) : ''}</div></div>${NS.assetSettings.advancedControls()}`,
        })}</div>
        ${NS.assetSettings.autoApprovalControls()}
        ${runtimeCard}
      </div>
    </div></section>`;
  }

  /* ────────────────────────── 视图：整理（任务流 + 策略） ──────────────────────────
   * 全模块重构：原「从历史会话整理」「整理记录」「设置与管理→
   * 整理方式」三处合并为一。一行 = 一个会话 × 它的整理任务（含无留存内容
   * 的静默记录）；策略收成页首抽屉；分桶筛选与批量入口保留。 */

  /** 整理报告：每项改动可核对、可回滚。
   *
   *  报告存在的意义是"用户能自己核对"——所以每一项都显示改了什么、为什么、
   *  以及一个回滚入口；拿不准的项单列，等用户给个处置意见（不擅自处置）。 */
  // 自动维护合并：inspectionSettingsCard 随之删除——巡检并入
  // 上方「自动维护」合并卡（开关同步 + 最近检查行 + 检查一次按钮），
  // 独立开关与「高级设置」折叠不再存在。

  function viewCleanup(route) {
    const state = S.cleanupReports;
    const reports = state && Array.isArray(state.reports) ? state.reports : [];
    const selectedId = String(route.cleanupReportId || '');
    const report = reports.find((row) => String(row.id) === selectedId) || reports[0] || null;
    const reportOnly = !!report && report.mode === 'report_only';
    const loading = Boolean(state && state.loading);
    // 页头与其余详情页同款：返回行 + 大标题 + 一行说明 +
    // 右侧「立即维护」（此前用 uiPageHeader 紧凑组件，模块内三种详情页头
    // 各不相同）；说明放页头 sub，正文 note 只讲本轮干了什么。
    const header = `${btn(T('cognition.cleanup_back', '← 返回'), 'go-back', { className: 'backlink' })}
    ${heroRow(
      T('cognition.cleanup_title', '整理报告'),
      T('cognition.cleanup_page_hint', '检查建议与历史整理记录；当前检查不会修改资产或候选。'),

    )}`;
    // 导语按轮次区分：完整整理轮（round:'full'，三轮合一后的常态）
    // 用合并导语；旧规则轮/标题重起轮的历史报告沿用各自原文案。
    const hint = `<p class="note">${esc(!report || report.mode === 'report_only'
      ? T('cognition.cleanup_report_only_hint', '本次只检查并提出建议，没有修改资产或候选。需要修改时，打开对应内容逐项处理。')
      : String(report && report.round || '') === 'full'
      ? T('cognition.cleanup_full_hint', '本轮自动完成：规范标题、合并重复项、补标签，并由模型重写了不合格的标题与啰嗦的正文；写前有整库备份，逐项留档可回滚。')
      : isTitleRegenReport(report)
      ? T('cognition.cleanup_regen_hint', '由模型把不合格的标题重新拟一个简短的新标题，自动写入并逐条留档对照；写前有整库备份，不会合并内容或修改正文。')
      : T('cognition.cleanup_run_hint_legacy', '只自动规范标题、合并正文完全相同的重复项；不确定的内容不会改动，会留给你判断。'))}</p>`;
    if (!report) {
      return `<div class="ca-page">${header}${hint}${empty(
        T('cognition.cleanup_empty', '还没有整理报告'),
        T('cognition.cleanup_empty_hint', '运行检查后，这里显示建议与依据；资产和候选内容保持原样。'),
      )}</div>`;
    }

    const KIND_LABELS = {
      title_normalized: T('cognition.cleanup_kind_title_normalized', '标题规范化'),
      merged_duplicate: T('cognition.cleanup_kind_merged_duplicate', '重复归并'),
      tag_added: T('cognition.cleanup_kind_tag_added', '补标签'),
      title_regen: T('cognition.cleanup_kind_title_regen', '标题重起'),
      statement_regen: T('cognition.cleanup_kind_statement_regen', '正文改写'),
    };
    const STATUS_LABELS = {
      applied: T('cognition.cleanup_status_applied', '已执行'),
      failed: T('cognition.cleanup_status_failed', '失败'),
      uncertain: T('cognition.cleanup_status_uncertain', '拿不准'),
      skipped: T('cognition.cleanup_status_skipped', '已跳过'),
    };
    const items = Array.isArray(report.items) ? report.items : [];
    const uncertain = Array.isArray(report.uncertain) ? report.uncertain : [];
    const appliedCount = items.filter((item) => item.status === 'applied').length;
    // 认不出的枚举一律走人话兜底，**不裸出机器码**（本模块的既有约定，
    // 有守护测试盯着）；资产名从快照解析，解析不到也给一句话，不裸出内部 id。
    const unknownLabel = (table, key, fallback) => table[key] || fallback;
    // 工程码翻译：报告 reason/note 里裸出的
    // too_long/local_path 等正文问题码 → 人话（与候选警示同词条）。
    const ISSUE_WORD_LABELS = {
      too_long: T('cognition.statement_issue_too_long', '正文超长'),
      session_debris: T('cognition.statement_issue_session_debris', '正文带会话一次性标识'),
      local_path: T('cognition.statement_issue_local_path', '正文带本机路径或源码文件名'),
      empty: T('cognition.statement_issue_empty', '正文为空'),
    };
    const issueText = (text) => String(text || '').replace(/too_long|session_debris|local_path|empty/g, (code) => ISSUE_WORD_LABELS[code] || code);
    const assetTitle = (assetId) => {
      const found = (Array.isArray(S.assets) ? S.assets : []).find((row) => String(row.id) === String(assetId));
      return found && found.title ? String(found.title) : T('cognition.cleanup_item_asset', '这条资产');
    };
    const reportRows = reports.map((row) => `<div class="row is-flat is-clickable ${String(row.id) === String(report.id) ? 'is-selected' : ''}" data-act="open-cleanup-report" data-report="${esc(String(row.id))}" ${roleBtn()}>
      <div class="tw"><div class="tt">${esc(fmtDate(row.createdAt))}</div><div class="mm">${esc(row.mode === 'report_only' ? T('cognition.cleanup_check_row', '建议 {uncertain} 项 · 内容未修改', { uncertain: String((row.uncertain || []).length) }) : T('cognition.cleanup_row_summary', '执行 {applied} 项 · 拿不准 {uncertain} 项', {
        applied: String((row.items || []).filter((item) => item.status === 'applied').length),
        uncertain: String((row.uncertain || []).length),
      }))}</div></div>
      <div class="sd">${row.interrupted ? window.uiTag({ label: T('cognition.cleanup_status_interrupted', '中断过'), variant: 'outline' }) : ''}</div>
    </div>`).join('');
    const itemRows = items.length ? items.map((item) => {
      // 改前/改后分段呈现：原来 `${before} → ${after}`
      // 拼一行，80 字两段糊在一起读不出哪段是改前；现在各带小标签分行，
      // after 为空（失败/跳过）只显示改前。
      const diffHtml = `${item.before ? `<div class="mm ca-diff"><span class="ca-diff-tag is-before">${esc(T('cognition.cleanup_diff_before', '改前'))}</span><span class="ca-diff-text">${esc(String(item.before))}</span></div>` : ''}${item.after ? `<div class="mm ca-diff"><span class="ca-diff-tag is-after">${esc(T('cognition.cleanup_diff_after', '改后'))}</span><span class="ca-diff-text">${esc(String(item.after))}</span></div>` : ''}`;
      return `<div class="row is-flat ca-cleanup-item">
      <div class="tw">
        <div class="tt">${esc(unknownLabel(KIND_LABELS, item.kind, T('cognition.cleanup_kind_unknown', '整理动作')))} · <a class="ca-asset-link" data-go-asset="${esc(String(item.assetId))}">${esc(assetTitle(item.assetId))}</a></div>
        ${diffHtml}
        <div class="mm">${esc(issueText(item.reason || ''))}${item.note ? ` · ${esc(issueText(item.note))}` : ''}</div>
      </div>
      <div class="sd">
        ${window.uiTag({ label: unknownLabel(STATUS_LABELS, item.status, T('cognition.cleanup_status_unknown', '状态未知')), variant: item.status === 'applied' ? 'success' : 'outline' })}
        ${item.status === 'applied' && item.rollbackAnchor ? btn(T('cognition.cleanup_rollback', '回滚这一项'), 'rollback-cleanup-item', {
          small: true,
          data: { id: String(item.assetId), version: String(item.rollbackAnchor) },
        }) : ''}
      </div>
    </div>`;
    }).join('') : `<p class="note">${esc(T('cognition.cleanup_no_items', '这一轮没有需要改动的地方。'))}</p>`;
    const uncertainRows = uncertain.map((entry) => `<div class="row is-flat ca-cleanup-item">
      <div class="tw">
        <div class="tt">${btn(String(entry.title || assetTitle(entry.assetId)), 'open-asset', { id: String(entry.assetId), small: true, className: 'o' })}</div>
        <div class="mm">${esc(issueText(String(entry.question || '')))}</div>
        <div class="mm">${esc(issueText(String(entry.reason || '')))}</div>
      </div>
      <div class="sd">${entry.decision
        ? window.uiTag({
          label: entry.decision === 'dismissed' ? T('cognition.cleanup_decided_dismissed', '已标记不管') : T('cognition.cleanup_decided_deferred', '已放到回头再看'),
          variant: 'outline',
        })
        : `${btn(T('cognition.cleanup_dismiss', '不管它'), 'cleanup-uncertain-dismiss', { small: true, data: { id: String(entry.assetId), report: String(report.id) } })}${btn(T('cognition.cleanup_defer', '回头再看'), 'cleanup-uncertain-defer', { small: true, data: { id: String(entry.assetId), report: String(report.id) } })}`}
      </div>
    </div>`).join('');
    return `<div class="ca-page">${header}${hint}
      ${report.interrupted ? `<div class="sect-block"><p class="note">${esc(reportOnly ? T('cognition.cleanup_check_interrupted', '检查中断，报告保留已形成的建议；资产与候选内容没有修改。') : T('cognition.cleanup_interrupted', '这轮中断过：已执行项仍然有效、可逐项回滚；未执行的保持原状。'))}</p></div>` : ''}
      <div class="sect-block"><div class="tt">${esc(reportOnly ? T('cognition.cleanup_check_summary', '扫描 {scanned} 条 · 建议 {uncertain} 项 · 内容未修改', { scanned: String(report.scanned || 0), uncertain: String(uncertain.length) }) : T('cognition.cleanup_summary', '扫描 {scanned} 条 · 执行 {applied} 项 · 拿不准 {uncertain} 项', {
        scanned: String(report.scanned || 0), applied: String(appliedCount), uncertain: String(uncertain.length),
      }))}</div>
      ${Array.isArray(report.skippedSteps) && report.skippedSteps.length
        ? `<p class="note">${esc(T('cognition.cleanup_skipped', '本轮跳过：{steps}', { steps: report.skippedSteps.join('；') }))}</p>`
        : ''}</div>
      ${reportOnly ? '' : `<div class="sect-block"><div class="tt">${esc(T('cognition.cleanup_items', '逐项改动'))}</div>${itemRows}</div>`}
      ${uncertain.length ? `<div class="sect-block"><div class="tt">${esc(T('cognition.cleanup_uncertain_section', '拿不准的（未改动）'))}</div>${uncertainRows}</div>` : ''}
      ${reports.length > 1 ? `<div class="sect-block"><div class="tt">${esc(T('cognition.cleanup_reports', '历史报告'))}</div>${reportRows}</div>` : ''}

    </div>`;
  }

  const CAPTURE_CANDIDATE_STATUS = {
    pending_review: ['cognition.capture_detail_candidate_pending', '待确认'],
    deferred: ['cognition.capture_detail_candidate_pending', '待确认'],
    confirmed: ['cognition.capture_detail_candidate_confirmed', '已保存'],
    rejected: ['cognition.capture_detail_candidate_rejected', '未保存'],
    ignored: ['cognition.capture_detail_candidate_ignored', '已忽略'],
  };
  function captureCandidateStatus(status) {
    const hit = CAPTURE_CANDIDATE_STATUS[String(status || '')];
    const label = hit ? T(hit[0], hit[1]) : T('cognition.capture_detail_candidate_other', '已处理');
    const tone = status === 'confirmed' ? 'green'
      : (status === 'rejected' || status === 'ignored') ? 'line'
        : status === 'pending_review' || status === 'deferred' ? 'amber' : '';
    return { label, tone };
  }

  /** 整理详情的候选来源：优先读 workflow
   *  记录自带的 candidateOutcomes 内联投影（主进程 summarize 全量读池后
   *  下发，与 confirmedAssetReceipts 同先例）——此前这里 join 渲染层候选
   *  队列，而队列（review-queue 视图）只含最近 5 条处理记录，旧任务的
   *  join 全落空，「整理结果」被误报成「没有发现值得留存的内容」，与同页
   *  「已保存资产」区自相矛盾。投影缺失时兜底原 join（防御性，不改变
   *  活任务的现有行为）。 */
  function captureCandidatesOf(capture) {
    if (Array.isArray(capture.candidateOutcomes)) return capture.candidateOutcomes;
    return (Array.isArray(capture.candidateIds) ? capture.candidateIds : [])
      .map((id) => (Array.isArray(S.candidates) ? S.candidates : []).find((row) => String(row.id) === String(id)))
      .filter(Boolean);
  }

  function captureResultSection(capture, messageBySourceId) {
    const vocab = NS.vocabulary;
    const candidates = captureCandidatesOf(capture);
    const running = ['queued', 'extracting', 'writing', 'waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled'].includes(String(capture.status));
    const partial = capture.displayStatus === 'partial';
    const partialNotice = partial ? `<p role="status">${esc(T('cognition.capture_partial_hint', '部分建议已保留，其余内容未处理完成。可到资产设置点击“立即扫描”继续。'))}</p>` : '';
    // 确认动作收敛到待我处理页，不在整理详情就地编辑。结果按状态呈现：
    //  - 待确认候选 → 结果区一行摘要（标题 · 数量）+「去待我处理」按钮；
    //  - 已保存候选 → 成果在「已沉淀资产」区（含完整 statement），结果区不重复；
    //  - 未保存候选（拒绝/忽略/过期）→ 结果区展示**完整内容块**（判断全文 +
    //    类型/作用域 + 证据映射 + 未保存标记）——"不保存之后也要看得到
    //    当时整理出的具体内容"，不再只剩一行截断标题。
    const pendingCandidates = candidates.filter((candidate) => NS.candidate.pending(candidate));
    // 待确认候选也展示完整内容，避免摘要和跳转把待核对信息藏起来。
    // 内容块通过 open-candidate 深链直达该条的
    // 确认页（此前只能跳大队列页自己翻），「去待我处理」按钮保留作总览出口。
    const pendingSummaryHtml = pendingCandidates.length
      ? `<div class="notice-row ca-pending-summary">
          <div class="notice-copy"><div class="notice-title">${esc(T('cognition.capture_detail_pending_hint', '发现 {n} 条待确认内容', { n: String(pendingCandidates.length) }))}</div></div>
          <span class="sp"></span>${btn(T('cognition.overview_empty_go_review', '去待我处理'), 'go-review', { small: true, primary: true })}
        </div>`
      : '';
    const rejectedCandidates = candidates.filter((candidate) => !pendingCandidates.includes(candidate)
      && candidate.status !== 'confirmed');
    const savedCount = candidates.length - pendingCandidates.length - rejectedCandidates.length;
    /** 结果区内容块（未保存/待确认共用）：章行 + 全文 + 证据 chips；
     *  clickable 时挂 open-candidate 深链并加粗标题（待确认直达确认页）。 */
    const resultItemHtml = (candidate, statusChip, clickable) => {
      const scope = String(candidate.suggestedScope || '').trim();
      const evidenceBits = (candidate.evidenceRefs || candidate.sourceRefs || []).map((ref) => {
        const message = messageBySourceId.get(String(ref.id || ''));
        return message
          ? `<span class="tag gray">${esc(T('cognition.capture_detail_evidence_from', '来自消息 {label} · {when}', { label: message.label, when: fmtDate(message.ts) }))}</span>`
          : evidenceChip(ref);
      }).slice(0, 6).join(' ');
      const judgment = String(candidate.judgment || '').trim();
      return `<div class="ca-result-item${clickable ? ' is-clickable' : ''}"${clickable ? ` data-act="open-candidate" data-id="${esc(candidate.id)}" ${roleBtn()}` : ''}>
          <div class="ca-result-head">

            ${scope ? `<span class="note">${esc(scope)}</span>` : ''}
            <span class="right">${chip(statusChip.label, statusChip.tone)}</span>
          </div>
          ${clickable ? `<b class="ca-result-title">${esc(NS.candidate.title(candidate))}</b>` : ''}
          <p class="content-text">${esc(judgment || NS.candidate.title(candidate))}</p>
          ${evidenceBits ? `<div class="chips">${evidenceBits}</div>` : ''}
        </div>`;
    };
    let body = '';
    if (candidates.length) {
      const cardHtml = rejectedCandidates.map((candidate) => resultItemHtml(candidate, captureCandidateStatus(candidate.status), false)).join('');
      const pendingHtml = pendingCandidates.map((candidate) => resultItemHtml(candidate, { label: T('cognition.candidate_status_pending', '待确认'), tone: 'amber' }, true)).join('');
      body = `${pendingSummaryHtml}${pendingHtml}${cardHtml}${savedCount && !pendingCandidates.length && !rejectedCandidates.length
        ? `<div class="note">${esc(T('cognition.capture_detail_saved_hint', '这次整理出的内容已保存为认知资产，可在「我的认知」中查看和修改。'))}</div>`
        : ''}`;
    } else if (running || partial) {
      body = partial ? '' : `<div class="note">${esc(T('cognition.capture_detail_result_pending', '整理还在进行，完成后这里会列出从这段对话发现的内容。'))}</div>`;
    } else {
      const modelReason = String(capture.noCandidateReason || '').trim();
      const filterText = vocab && capture.filterReason ? vocab.captureFilterReasonText(capture.filterReason) : '';
      body = `
      ${empty(T('cognition.capture_detail_result_none_title', '没有发现值得留存的内容'))}
      ${filterText ? `<div class="note">${esc(T('cognition.capture_detail_filter_label', '筛选原因'))}：${esc(filterText)}</div>` : ''}
      ${modelReason ? `<blockquote class="ca-quote">${esc(modelReason)}</blockquote>` : ''}`;
    }
    /* 单卡版式：分区不再各包一张 card 散在外面，
     * 统一收进主体卡内做分节（分隔线区隔）——整页=页头 + 一张完整内容卡，
     * 与建议详情同构。 */
    return `<div class="ca-capture-sec">${sectionHead(T('cognition.capture_detail_result_title', '整理结果'))}${partialNotice}${body}</div>`;
  }

  /* 对话上下文区：参与角色 + 消息时间线（展示口径 = 本次整理实际读到的消息，
   *  与模型看到的一致）；价值信号 chips 说明「为什么是这段」。 */
  function captureConversationSection(capture, context) {
    const vocab = NS.vocabulary;
    const signals = (Array.isArray(capture.screeningSignals) ? capture.screeningSignals : [])
      .filter((signal) => signal !== 'manual_selection');
    const signalChips = signals.length
      ? `<span class="chips">${signals.map((signal) => chip(vocab ? vocab.captureSignalText(signal) : T('cognition.capture_signal_other', '其他信号'), 'line')).join(' ')}</span>`
      : '';
    if (!context || context.loading) {
      const hint = context && context.loading
        ? T('cognition.capture_detail_context_loading', '正在读取对话上下文…')
        : T('cognition.capture_detail_context_unavailable', '消息内容不可用（会话可能已被清理或迁移）。');
      return `<div class="ca-capture-sec">${sectionHead(T('cognition.capture_detail_context_title', '对话上下文'), '', signalChips)}<div class="note">${esc(hint)}</div></div>`;
    }
    const nameById = new Map((context.participants || []).map((p) => [String(p.id), p]));
    const actorName = (actorId) => {
      if (actorId === 'user') return T('cognition.capture_detail_you', '你');
      if (actorId === 'commander') return T('cognition.capture_detail_commander', '指挥官');
      const participant = nameById.get(String(actorId));
      return participant ? participant.name : T('cognition.capture_detail_actor_unknown', '未知参与者');
    };
    const rows = (context.messages || []).map((message) => {
      const text = String(message.text || '');
      const oneLine = text.replace(/\s+/g, ' ').trim();
      const isShort = text.length <= 200 && !text.includes('\n');
      const bodyHtml = isShort
        ? `<div class="ca-tl-text">${esc(text)}</div>`
        : `<details class="ca-tl-body"><summary>${esc(oneLine.slice(0, 140))}${oneLine.length > 140 ? '…' : ''}</summary><div class="ca-tl-text">${esc(text)}</div></details>`;
      const artifacts = (message.artifacts || []);
      return `
      <div class="ca-tl-row is-${message.role === 'user' ? 'user' : 'assistant'}">
        <span class="ca-tl-dot" aria-hidden="true"></span>
        <div class="ca-tl-main">
          <div class="ca-tl-head"><b>${esc(actorName(message.from))}</b><span class="note">${esc(message.label)} · ${esc(fmtDate(message.ts))}</span></div>
          ${bodyHtml}
          ${message.truncated ? `<div class="note">${esc(T('cognition.capture_detail_msg_truncated', '内容过长，已截断'))}</div>` : ''}
          ${artifacts.length ? `<div class="chips">${artifacts.map((artifact) => chip(artifact.title || artifact.id, 'line')).join(' ')}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    const participantsHtml = (context.participants || []).length
      ? `<div class="chips ca-participants">${(context.participants || []).map((p) => chip(actorName(p.id), p.kind === 'user' ? 'green' : '')).join(' ')}</div>`
      : '';
    return `<div class="ca-capture-sec">
      ${sectionHead(T('cognition.capture_detail_context_title', '对话上下文'), '', signalChips)}
      ${participantsHtml ? `${sectionHead(T('cognition.capture_detail_participants_title', '参与角色'))}${participantsHtml}` : ''}
      ${sectionHead(T('cognition.capture_detail_messages_title', '消息时间线'))}
      <div class="ca-tl">${rows}</div>
    </div>`;
  }

  /** 整理过程五步进度条：stage 驱动（extracting 期间 4s 轮询自推进），
   *  当前步高亮、已过步打勾感（is-done）；非提炼期不显示（结果区已终态）。 */
  const CAPTURE_STAGE_ORDER = ['model_check', 'recall_view', 'model_extraction', 'candidate_save', 'asset_write'];
  function captureStageStepper(stage) {
    if (!stage) return '';
    const vocab = NS.vocabulary;
    const currentAt = CAPTURE_STAGE_ORDER.indexOf(String(stage));
    if (currentAt < 0) return '';
    return `<div class="ca-steps-bar" role="progressbar" aria-label="${esc(T('cognition.capture_detail_stage', '当前步骤'))}">
      ${CAPTURE_STAGE_ORDER.map((id, index) => `<span class="ca-step${index === currentAt ? ' is-current' : ''}${index < currentAt ? ' is-done' : ''}">${esc(vocab ? vocab.captureStageText(id) : id)}</span>`).join('<i class="ca-step-arrow" aria-hidden="true">→</i>')}
    </div>`;
  }

  function viewCaptureDetail(route) {
    const vocab = NS.vocabulary;
    const backHtml = btn(`← ${T('common.back', '返回')}`, 'go-back', { className: 'backlink' });
    const capture = (Array.isArray(S.captures) ? S.captures : [])
      .find((row) => String(row.id) === String(route.captureId));
    if (!capture) {
      return `${backHtml}${empty(T('cognition.capture_detail_missing', '这条整理任务不存在或已被清理'), '')}`;
    }
    // 上下文缓存命中当前任务才用（防串页）；sourceId 索引供证据映射。
    const contextHit = S.captureContext
      && String(S.captureContext.captureId) === String(route.captureId)
      ? S.captureContext : null;
    const context = contextHit ? contextHit.data : null;
    const messageBySourceId = new Map(
      ((context && context.messages) || []).map((message) => [String(message.sourceId), message]),
    );
    const summary = capture.reviewSummary || {};
    /** 卡头元信息项：浅色标签 + 墨色值，流式排（空值不占位）。 */
    const metaItem = (label, value) => (value
      ? `<span class="meta-item"><i>${esc(label)}</i>${esc(value)}</span>`
      : '');
    const totalSec = Number(capture.durationMs) > 0 ? Math.round(Number(capture.durationMs) / 1000) : 0;
    const durationText = totalSec > 0
      ? (totalSec < 60
        ? T('cognition.capture_duration_sec', '{n} 秒', { n: String(totalSec) })
        : T('cognition.capture_duration_min', '{n} 分 {s} 秒', { n: String(Math.floor(totalSec / 60)), s: String(totalSec % 60) }))
      : '';
    const tokens = Number(capture.modelUsage && capture.modelUsage.totalTokens) || 0;
    const statusTone = capture.displayStatus === 'failed' ? 'red'
      : (capture.displayStatus === 'completed' || capture.displayStatus === 'review_ready') ? 'green' : 'amber';
    const receipts = Array.isArray(capture.confirmedAssetReceipts) ? capture.confirmedAssetReceipts : [];
    // 卡头状态三态：已完成 · 已保存（有沉淀资产）/
    // 已完成 · 未保存（候选被拒且无资产）/ 原状态文案。文案复用候选状态键。
    // 候选来源与「整理结果」区同改为 workflow 记录内联投影，
    // 旧任务的卡头「未保存」徽标不再因队列窗口截断而丢失。
    const settledRows = captureCandidatesOf(capture);
    const hasSaved = receipts.length > 0 || (Number(summary.promoted) || 0) > 0;
    const hasUnsaved = !hasSaved && settledRows.some((row) => ['rejected', 'ignored', 'expired'].includes(String(row.status)));
    const statusLabel = vocab
      ? vocab.captureDisplayStatusText(capture.displayStatus)
      : T('cognition.capture_display_status_other', '状态未知');
    const headStatus = capture.displayStatus === 'completed'
      ? (hasSaved
        ? { label: `${statusLabel} · ${T('cognition.capture_detail_candidate_confirmed', '已保存')}`, tone: 'green' }
        : hasUnsaved
          ? { label: `${statusLabel} · ${T('cognition.capture_detail_candidate_rejected', '未保存')}`, tone: 'amber' }
          : { label: statusLabel, tone: statusTone })
      : { label: statusLabel, tone: statusTone };
    // 已沉淀资产：直接展示沉淀的正文
    //（statement 取自 S.assets 快照，零后端改动），「查看资产」降为项内次级
    // 入口；快照缺该资产（已删除等）时退回「类型 · 版本」，不裸出内部 id。
    const depositBlocks = receipts.map((receipt) => {
      const asset = (Array.isArray(S.assets) ? S.assets : [])
        .find((row) => String(row.id) === String(receipt.assetId));
      const title = asset && asset.title
        ? String(asset.title)
        : `${categoryLabel(receipt.assetType)} · v${String(receipt.version || '1')}`;
      const statement = String((asset && asset.statement) || '').trim();
      return `<div class="ca-deposit-item">
        <div class="ca-deposit-head">${chip(categoryLabel(receipt.assetType))}<b>${esc(title)}</b></div>
        ${statement ? `<p class="content-text">${esc(statement)}</p>` : ''}
        <div class="ca-deposit-foot"><span class="note">v${esc(String(receipt.version || '1'))}</span>${btn(T('cognition.capture_action_view_assets', '查看资产'), 'open-asset', { id: receipt.assetId, small: true })}</div>
      </div>`;
    }).join('');
    /* 整页版式：页头 = 返回行 + 固定标题
     * 「整理任务详情」+ 一行说明；此前把会话标题、触发原因、统计卡全塞进
     * 页头（仪表盘版式），与建议详情（固定标题 → 进卡片）两套观感。会话
     * 标题降为卡片内 h2（同建议详情的内容标题位）；统计卡撤掉——待确认数
     * 看下方整理结果区、已保存资产看沉淀区，尝试次数与触发原因进元信息行。
     * 下方整理结果、对话上下文同为卡内分节（单卡文档式，不再散板双栏）。 */
    const recordTitleText = vocab
      ? vocab.recordTitle(capture)
      : String(capture.conversationTitle || T('cognition.capture_untitled_record', '未命名会话的整理'));
    return `${backHtml}
    ${hero(
      T('cognition.capture_detail_title', '整理任务详情'),
      T('cognition.capture_detail_hint', '查看这场对话的整理任务、进度和结果。'),
    )}
    <div class="card ca-capture-panel">
      <div class="ca-capture-head">
        ${chip(headStatus.label, headStatus.tone)}
        <div class="meta-row">
          ${metaItem(T('cognition.capture_detail_created', '创建于'), fmtDate(capture.createdAt))}
          ${metaItem(T('cognition.capture_detail_started', '开始时间'), fmtDate(capture.startedAt))}
          ${metaItem(T('cognition.capture_detail_finished', '结束时间'), fmtDate(capture.finishedAt))}
          ${metaItem(T('cognition.capture_detail_duration', '耗时'), durationText)}
          ${metaItem(T('cognition.capture_detail_tokens', '模型用量（token）'), tokens ? String(tokens) : '')}
          ${metaItem(T('cognition.capture_detail_attempt', '尝试次数'), String(Number(capture.attempt) || 1))}
          ${metaItem(T('cognition.capture_detail_reason', '触发'), capture.displayReason && vocab ? vocab.captureReasonText(capture.displayReason) : '')}
        </div>
      </div>
      <h2 class="cand-title">${esc(recordTitleText)}</h2>
      ${depositBlocks ? `<div class="ca-deposit">${sectionHead(T('cognition.capture_detail_assets', '已保存资产'))}${depositBlocks}</div>` : ''}
      <div class="ca-capture-sections">
        ${captureResultSection(capture, messageBySourceId)}
        ${captureConversationSection(capture, contextHit ? (contextHit.loading ? { loading: true } : context) : null)}
      </div>
      <div class="ca-capture-foot">
        ${captureStageStepper(capture.stage)}
        ${captureActionButtonsHtml(capture)}
      </div>
    </div>`;
  }

  /** 卡底一行：五步进度条靠左、操作按钮靠右，同一行；
   *  窄窗放不下时按钮换行到进度条下方、仍右对齐（actions-right 的 auto 边距）。
   *  动线=先看状态与内容，最后是过程与操作。 */
  function captureActionButtonsHtml(capture) {
    return `<div class="actions actions-right">
      ${capture.displayStatus === 'partial' ? btn(T('cognition.capture_partial_continue', '前往资产设置继续'), 'go-organize-settings', { small: true }) : ''}
      ${btn(T('cognition.capture_action_open_conversation', '打开会话'), 'open-conversation', { id: capture.conversationId || '', small: true })}
    </div>`;
  }

  /* ────────────────────────── 渲染入口 ────────────────────────── */

  /** 上一帧的路由指纹与本页滚动位置：同页重画（操作后刷新 / 4s 轮询）保持
   *  滚动位置（此前每次重画都弹回顶部——长列表里 4 秒一跳）；切换页面由
   *  router.go 归零，这里不恢复。 */
  let lastRenderKey = '';
  let treeSettlePass = 0;
  function routeKey(route) {
    return [route.name, route.assetId, route.candidateId, route.moduleId, route.recordId, route.recordVersion, route.captureId, route.inboxId, route.poCandidateId, route.activityView, route.activityPage, route.activityFilter, route.category, route.captureBucket, route.experienceId, route.activityDone].join('|');
  }

  function render(opts) {
    const options = opts || {};
    const root = document.getElementById('ca-root');
    if (!root) return;
    let route = S.route;
    // 旧深链统一到当前页面入口：router.go 已在
    // 入栈前归一，这里兜住直接写 store 的路径（持久化恢复/测试装配）。只归一
    // 渲染视角、不回写 store。
    if (route.name === 'tree') route = Object.assign({}, route, { name: 'overview' });
    else if (route.name === 'organize' || route.name === 'review') route = Object.assign({}, route, { name: 'activity' });
    else if (route.name === 'organize-settings') route = Object.assign({}, route, { name: 'settings' });
    else if (route.name === 'experiences') route = Object.assign({}, route, { name: 'overview', category: route.category || 'experiences' });
    if (route.category === 'kstar') route = Object.assign({}, route, { category: '' });
    const key = routeKey(route);
    const previousScroll = document.getElementById('ca-scroll');
    const activityRenderState = route.name === 'activity' ? NS.activityController?.captureRenderState(previousScroll) : null;
    const libraryRenderState = route.name === 'overview' ? NS.library?.captureRenderState(previousScroll) : null;
    NS.library?.closeFilters();
    NS.activityController?.closeFilters();
    const sameRoute = lastRenderKey === key && !!previousScroll;
    const restoreScroll = sameRoute ? previousScroll.scrollTop : 0;
    const disclosureSelectors = ['.ca-asset-page .ca-detail-history', '.ca-asset-page .ca-detail-governance', '.ca-asset-page .ca-asset-edit-advanced'];
    const openDisclosures = route.assetId && sameRoute && typeof previousScroll.querySelector === 'function'
      ? disclosureSelectors.filter((selector) => previousScroll.querySelector(selector)?.open)
      : [];
    lastRenderKey = key;
    // 候选详情归「待我处理」、整理详情与大扫除报告归「认知生长」；
    // interactive-tour 靠 data-cognition-page-link="assets"/"captures" 定位 tab。
    // 五个顶级入口（树 / 本体 / 我的认知 / 认知生长 / 设置，
    // 收敛：独立待我处理下线）；activity 承接候选详情、captureId、cleanup
    // 报告与旧 review 深链；未知路由回到我的认知。
    const activeTab = route.name === 'activity' || route.name === 'cleanup' || route.captureId || route.candidateId ? 'activity'
      : route.name === 'settings' ? 'settings'
        : route.name === 'ontology' ? 'ontology'
          : route.name === 'tree' ? 'tree' : 'overview';
    // 详情子界面（资产/经验/整理详情、整理报告）也走整页版式；候选详情
    // 复用旧 review 工作台的全宽态（候选卡类名同一套，layout 类名仅为宽度）。
    const isDetailRoute = Boolean(route.assetId || route.experienceId || route.candidateId
      || (route.name === 'activity' && route.captureId) || route.name === 'cleanup');
    const layoutView = activeTab === 'overview' && !route.experienceId ? 'overview' : activeTab === 'ontology' || activeTab === 'settings' ? activeTab
      : activeTab === 'overview' && !route.assetId && !route.experienceId ? 'overview'
        : activeTab === 'activity' && route.name === 'activity' && !route.captureId ? 'activity'
          : route.candidateId ? 'review'
            : isDetailRoute ? 'detail' : '';
    const layoutClass = layoutView ? ` ca-layout-${layoutView}` : '';
    // 角标口径：资产候选 + 本体
    // 候选，一个收件箱数得全。
    const pendingCount = Number(NS.stats().pending || 0) + (Array.isArray(S.poCandidates) ? S.poCandidates.length : 0);
    const tabBodies = new Map();
    const tabsInner = NS.TABS.map((tab) => {
      const active = !tab.disabled && activeTab === tab.id;
      const extra = tab.id === 'overview' ? ' data-cognition-page-link="assets"' : (tab.id === 'activity' ? ' data-cognition-page-link="captures"' : '');
      // tab 只留标题，描述小字与 title 悬浮注释删除。
      // 待确认计数走原型 .bdg 角标。
      const badge = tab.id === 'activity' && pendingCount ? `<span class="bdg">${pendingCount}</span>` : '';
      const content = `<strong>${esc(T(tab.titleKey, tab.title))}</strong>${badge}`;
      tabBodies.set(tab.id, content);
      return `<div class="ca-tab${active ? ' is-on' : ''}${tab.disabled ? ' is-disabled' : ''}" data-act="tab" data-id="${tab.id}"${extra} ${tab.disabled ? `role="button" aria-disabled="true" tabindex="-1" title="${esc(T('cognition.tree_coming_soon', '敬请期待'))}"` : roleBtn()}>${content}</div>`;
    }).join('');
    let body = '';
    if (NS.isRouteLoading()) {
      // 首载骨架：结构化的三行占位（shimmer 由 CSS 驱动），比纯文字更快有页面感。
      body = `<div class="ca-loading"><div class="ca-skel-row"></div><div class="ca-skel-row"></div><div class="ca-skel-row"></div></div>`;
    } else if (route.name === 'ontology') body = viewOntology(route);
    else if (route.name === 'activity') body = route.captureId ? viewCaptureDetail(route) : NS.viewActivity(route);
    else if (route.name === 'cleanup') body = viewCleanup(route);
    else if (route.name === 'settings') body = viewOrganizeSettingsPage();
    else if (route.name === 'tree') body = viewTree(route);
    else body = viewOverview(route);
    const errorBanner = S.errors.length && S.loaded
      ? `<div class="ca-banner">${esc(T('cognition.partial_load', '部分数据读取失败，页面已用可用数据渲染。'))}${btn(T('common.retry', '重试'), 'refresh', { small: true })}</div>`
      : '';
    // 离开本体路由时显式卸载本体工作台（清窗口级 i18n 监听与内部状态）；
    // 同一路由的后台重绘保留工作台节点与当前交互状态；显式深链变化才重新挂载。
    const enteringOntology = route.name === 'ontology' && S.prevRouteName !== 'ontology';
    if (S.prevRouteName === 'ontology' && route.name !== 'ontology'
      && typeof NS.unmountPersonalOntology === 'function') {
      NS.unmountPersonalOntology();
    }
    const ontologyRouteKey = JSON.stringify([route.moduleId || '', route.recordId || '', route.recordVersion || '', route.candidateId || '']);
    const preserveOntologyMount = route.name === 'ontology' && !enteringOntology && !options.rebuild
      && S.ontologyMountRouteKey === ontologyRouteKey && !!document.getElementById('ca-ontology-mount')?.querySelector?.('.ontology-workspace');
    S.ontologyMountRouteKey = route.name === 'ontology' ? ontologyRouteKey : null;
    S.prevRouteName = route.name;
    // 持久页面壳：ca-app 结构只建一次，此后每次
    // 渲染只更新页签态、横幅与内容区——壳不重建，事件委托与 tab 焦点稳定，
    // 本体挂载节点也不会被无谓地拔掉。语言切换等需要换壳文案时传 rebuild。
    // 壳节点用 id 取：测试沙箱只实现字符串级 innerHTML（getElementById 恒
    // null）时自然退回整串写入，两边行为一致。
    const tabsNav = document.getElementById('ca-tabs-nav');
    // 页签导航住在外壳侧栏（specs/008-shell-rail-layout，#sidebar-recall-nav）。
    // 测试沙箱取不到宿主（或宿主即 root）时退回写进 root，行为与旧壳一致。
    const navHostEl = document.getElementById('sidebar-recall-nav');
    const navHost = navHostEl && navHostEl !== root ? navHostEl : null;
    const navAria = esc(T('sidebar.recall', '认知资产'));
    const tabsNavHtml = `<nav class="ca-tabs sidebar-nav" id="ca-tabs-nav" aria-label="${navAria}">${tabsInner}</nav>`;
    // 统一页面 header（specs/008 D12）：标题跟随当前页签。
    const activeTabMeta = NS.TABS.find((tab) => tab.id === activeTab) || NS.TABS[0];
    const pageDescriptions = {
      overview: ['cognition.library_intro', '查找已保存的内容，理解依据，再决定如何使用。'],
      activity: ['cognition.activity_page_hint', '集中浏览建议，逐项核对后处理。'],
      settings: ['cognition.settings_nightly_confirmation_flow', '从对话中发现新认知，整理已有认知与本体；在认知生长查看建议和处理结果。'],
    };
    const description = !route.captureId && pageDescriptions[route.name];
    const pageHeaderHtml = typeof window.uiPageHeader === 'function'
      ? window.uiPageHeader({ title: T(activeTabMeta.titleKey, activeTabMeta.title), ...(description ? { meta: T(...description) } : {}) })
      : '';
    const bannerSlot = document.getElementById('ca-banner-slot');
    const main = document.getElementById('ca-scroll');
    const settingsDisclosures = route.name === 'settings' ? NS.assetSettings.captureDisclosures(main) : null;
    const oldSearch = route.name === 'activity' && !route.candidateId ? main?.querySelector?.('#ca-activity-search') : null;
    const searchSelection = oldSearch && oldSearch === document.activeElement ? { start: oldSearch.selectionStart, end: oldSearch.selectionEnd } : null;
    // 树页/本体页是「整页高度」型：滚动容器不收滚动、改由页面自己占满
    //（原型 .tree-stage/.onto-page 都是整屏高度，不随内容滚）。
    const stageScroll = route.name === 'tree' || route.name === 'ontology';
    // .wrap 统一管理内容区的内边距；主工作页通过 ca-layout-* 路由态铺满可用宽度，
    // 不参与这些布局的详情页继续沿用默认阅读栏宽度。
    if (!stageScroll) body = `<div class="wrap">${body}</div>`;
    if (options.rebuild || !tabsNav || !bannerSlot || !main) {
      if (navHost) navHost.innerHTML = tabsNavHtml;
      root.innerHTML = `
        <div class="ca-app">
          ${navHost ? '' : tabsNavHtml}
          <div class="ca-page-header" id="ca-page-header">${pageHeaderHtml}</div>
          <div class="ca-banner-slot" id="ca-banner-slot">${errorBanner}</div>
          <div class="ca-scroll${stageScroll ? ' is-stage' : ''}${layoutClass}" id="ca-scroll">${body}</div>
        </div>`;
    } else {
      // 后台首载/刷新到达时保留正在被点击或键盘聚焦的页签节点。
      // 只更新选中状态与有变化的标题/计数，避免替换节点吞掉切页操作。
      if (typeof tabsNav.querySelector === 'function') {
        for (const tab of NS.TABS) {
          const item = tabsNav.querySelector(`[data-act="tab"][data-id="${tab.id}"]`);
          if (!item) { tabsNav.innerHTML = tabsInner; break; }
          item.classList.toggle('is-on', !tab.disabled && activeTab === tab.id);
          if (item.innerHTML !== tabBodies.get(tab.id)) item.innerHTML = tabBodies.get(tab.id);
        }
      } else tabsNav.innerHTML = tabsInner;
      bannerSlot.innerHTML = errorBanner;
      const headerSlot = document.getElementById('ca-page-header');
      if (headerSlot && headerSlot !== root) headerSlot.innerHTML = pageHeaderHtml;
      // 测试沙箱的 getElementById 返回裸对象（只有 innerHTML，没有 classList）：
      // 取不到就跳过切类，与上面的「退回整串写入」同一条守则。
      if (main.classList) {
        main.classList.toggle('is-stage', stageScroll);
        ['overview', 'ontology', 'review', 'activity', 'settings', 'detail'].forEach((layout) => {
          main.classList.toggle(`ca-layout-${layout}`, layoutView === layout);
        });
      }
      if (!preserveOntologyMount) main.innerHTML = body;
    }
    const scrollRoot = document.getElementById('ca-scroll');
    styleDetailDisclosures(scrollRoot);
    if (settingsDisclosures) NS.assetSettings.restoreDisclosures(scrollRoot, settingsDisclosures);
    const newSearch = searchSelection ? scrollRoot?.querySelector?.('#ca-activity-search') : null;
    if (newSearch) {
      newSearch.focus();
      if (typeof newSearch.setSelectionRange === 'function') newSearch.setSelectionRange(searchSelection.start, searchSelection.end);
    }
    if (route.assetId && scrollRoot && typeof scrollRoot.querySelector === 'function') {
      for (const selector of openDisclosures) {
        const disclosure = scrollRoot.querySelector(selector);
        if (disclosure) disclosure.open = true;
      }
    }
    if (scrollRoot && restoreScroll) scrollRoot.scrollTop = restoreScroll;
    else if (scrollRoot && ['activity', 'overview'].includes(route.name)) scrollRoot.scrollTop = 0;
    if (route.name === 'activity') {
      NS.activityController?.hydrateFilters(scrollRoot);
      NS.activityController?.restoreRenderState(scrollRoot, activityRenderState);
    }
    if (route.name === 'overview') {
      NS.library?.hydrateFilters(scrollRoot);
      NS.library?.restoreRenderState(scrollRoot, libraryRenderState);
    }
    // 树的出图尺寸按容器实测像素定（见 treeViewport）：首帧容器里还没有
    // svg，只知占位尺寸；挂载后量真值，不一致就重画一次收敛（最多两跳，
    // 防抖动循环）。横幅出现/消失改变内容区高度时也靠这一步跟上。
    if (route.name === 'tree' && treeSettlePass < 2 && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const svg = document.getElementById('ca-tree-svg');
        if (!svg || !svg.clientWidth) return;
        const [w, h] = String(svg.getAttribute('viewBox') || '').split(/\s+/).slice(2).map(Number);
        if (w && h && (Math.abs(w - svg.clientWidth) > 1 || Math.abs(h - svg.clientHeight) > 1)) { treeSettlePass += 1; render(); } else treeSettlePass = 0;
      });
    }
    // 进入本体路由：mount 点已在 body 里，交给 core 的挂载编排（加载特性组、
    // 移 section、渲染本体）。异步执行，不阻塞本轮渲染。
    if (preserveOntologyMount && typeof window.syncCognitionOntology === 'function' && S.ontologySnapshot) window.syncCognitionOntology(S.ontologySnapshot);
    if (route.name === 'ontology' && !preserveOntologyMount && typeof NS.mountPersonalOntology === 'function') {
      void NS.mountPersonalOntology({ resetToOverview: enteringOntology && !route.candidateId && !route.moduleId && !route.recordId,
        ...(route.candidateId ? { candidateId: String(route.candidateId) } : {}),
        ...(route.moduleId ? { moduleId: String(route.moduleId) } : {}),
        ...(route.recordId ? { recordId: String(route.recordId) } : {}),
        ...(route.recordVersion ? { recordVersion: Number(route.recordVersion) } : {}),
      });
    }
    // 标签弹层接线：DOM 刚写完，就地过 uiModalController
    //（onChange 监听器注册顺序早于 boot 的渲染监听，不能放 app.js 的 notify 里）。
  }
  NS.render = render;
  // 认知生长·已处理视角复用的只读分区（改进分析： 随 viewOrganizeTasks
  // 退役自 activity 主视图迁出，仍由本文件渲染）。
  NS.improvementAnalysisSection = improvementAnalysisSection;
  // 认知生长·已处理视角的本体保存记录区（最近保存与纠正，精确版本链接；
  // 保存不代表任务已采用）。
  NS.ontologyActivitySection = () => ontologyDirectorySection(true);
  // 共享渲染件：个人本体页复用资产页同一套
  // 章/行形态。只有 IIFE 顶层的件可导出——plainRow/catalogRow 定义在
  // render 内部（闭包捕获每帧状态），不在此列。
  // resolveSourceRef 一并导出：五处来源展示与用例都
  // 认这一份解析结果，避免测试各自复制一套判据。
  NS.ui = { cognitionHistory, savedDecisionContent, cognitionSourceParts, cognitionSourceSection, cognitionSourceRows, cognitionContentFields, cognitionRelated, cognitionSources, versionContent, broughtInCountFor, broughtInCountsFor, chip, assetStatusChip, resolveSourceRef, evidenceChip, btn, roleBtn, hero, empty, sectionHead, termNote, otherActions, CATEGORIES, categoryLabel, CONTENT_CATEGORIES, contentCategoryOf, contentCategoryLabel, contentCategorySelect, evidenceChipParts, isKstarEvidenceRef, isLiveKstarEvidenceRef, evidenceGroupsHtml, stripMarkdown, attributionLabel, sourceRefKind, sourceIndex, reviewOutcomeText, stripInternalIds, foldValue, kstarEpisodeSection, detailTitleActions };
})();
