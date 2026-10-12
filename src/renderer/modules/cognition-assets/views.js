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

  /* 标签弹层槽位的「上次写入串」（模块级）：比对用它而不是读回 slot.innerHTML
   * ——uiModalController.open() 会原地改写 overlay 节点（hidden/class/style），
   * 读回值永远不等于生成串，弹层打开期间每次重渲染都会重写槽位 → 控制器
   * 重建泄漏（Tab 键失效的根因，2026-09-28 修）。 */
  let lastTagOverlaySlotHtml = null;

  /* ────────────────────────── 共享零件 ────────────────────────── */

  /* 按钮一律走共享 uiButton 工厂（shared-ui-adoption-guard 约束：本模块不落
   * 裸控件）。皮肤由 cognition-assets.css 的「原型移植段」按 .btn 修饰类给出：
   * 默认 = 浅绿实底（原型 .btn.g）、primary = 深绿实底（.btn）、danger = 红（.btn.d）、
   * 需要描边白底时用 className: 'o'。 */
  const btn = (label, act, options) => {
    const opts = options || {};
    /* chip / rnm 是完整自管皮肤（白底选中态 / 无框文字钮），不吃默认浅绿
       实底——否则 .btn.g 双类特异性压过 .chip，所有筛选 chip 都像选中态
       （2026-09-21 子安真机抓出）。 */
    const ownSkin = /(^|\s)(chip|rnm|backlink)(\s|$)/.test(opts.className || '');
    const variant = opts.danger ? 'd' : opts.primary ? '' : ownSkin ? '' : 'g';
    const classes = ['btn', variant, opts.small ? 'sm' : '', opts.className || ''].filter(Boolean).join(' ');
    // opts.data 的键统一补 data- 前缀：uiButton 的 attrs 白名单只放行
    // id/role/title/aria-*/data-*，裸键（action/batch/kind…）会被静默丢弃——
    // 2026-09-14 前端重建起这里的行内动作属性一直没渲染出来，委托层读到
    // 的 dataset.action 恒为 undefined（2026-09-15 修，整理记录重构时抓出）。
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

  /* ────────────── 人话术语表 + 三层披露共享件（specs/018 T001/T002）──────────────
   * 病根之二：界面词是工程词（候选/作用边界/回执），用户没有这些概念。
   * 术语表在展示层统一翻译，数据层口径一个不动；钉死口径（「模型确认采用」
   * 「被任务用过」「保留期 30 天」）只加脚注、不改写。TERM_TABLE 形态 = [词条键,
   * 界面词, 脚注键, 脚注]，相邻字符串字面量让 i18n 覆盖扫描（literalPattern）
   * 扫得到，四语缺一门即红。（敏感级/扩权两词条已随机制整体删除，2026-09-28。） */
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

  /** 折叠区统一用法（T002）：技术细节与低频记录默认收起，内容不丢。 */
  const foldBlock = (title, count, hint, body, cls) => `<details class="details fold${cls ? ` ${cls}` : ''}"><summary>${esc(title)}${count != null ? `<span class="n">${esc(String(count))}</span>` : ''}${hint ? `<span class="note">${esc(hint)}</span>` : ''}</summary><div class="dbody">${body}</div></details>`;

  /** 「其他处理」折叠（T002 三件套）：主按钮留给推荐动作，其余动作收这里。 */
  const otherActions = (buttonsHtml) => (buttonsHtml
    ? `<details class="details ca-other-actions"><summary>${esc(T('cognition.other_actions', '其他处理'))}</summary><div class="dbody"><div class="actions actions-right">${buttonsHtml}</div></div></details>`
    : '');

  const CATEGORIES = [
    ['personal', 'cognition.asset_category_personal', '个人信息'],
    ['rule', 'cognition.asset_category_rule', '规则与偏好'],
    ['template', 'cognition.asset_category_template', '模板与范例'],
    ['skill_method', 'cognition.asset_category_skill_method', '技能与方法'],
    // 2026-09-21 原型 v7 第四类:事实与知识(项目/环境/领域/工具链的稳定事实)。
    ['fact', 'cognition.asset_category_fact', '事实与知识'],
  ];
  const categoryLabel = (type) => {
    const hit = CATEGORIES.find(([id]) => id === type);
    return hit ? T(hit[1], hit[2]) : T('cognition.asset_category_other', '其他');
  };

  // 状态章（2026-09-22 快赢）：active 从「已确认」改为「生效中」——与出身章
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
    const entry = ASSET_STATUS[String(asset.status || 'active')];
    const [label, tone] = entry ? [entry[0](), entry[1]] : [T('cognition.asset_status_unknown', '状态未知'), ''];
    // 刀三（2026-09-22）：成熟度章收敛两态——transfer+ 统一「已实证」，未验证
    // 不摆章；工作名待认知树映射层统一定名。
    const maturity = ['transfer_validated', 'effectiveness_validated'].includes(String(asset.maturity || ''))
      ? chip(T('cognition.maturity_validated', '已实证'), 'green')
      : '';
    return chip(label, tone) + maturity;
  };
  // originChip（出身章「模型记的/系统沉淀」）已随出身收敛退役（2026-09-20）：
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

  /* ────────── 来源解析：唯一解析器 + 唯一呈现出口（2026-09-25 US-603）──────────
   * 修复前：候选与版本证据走 evidenceChip，资产详情的证据引用块却绕过它直接
   * esc(refId) 上屏，内部 id（immediate-* / kse-* / turn-*）就这么露给用户；
   * 来源异常行还有 `title || id` 的裸 id 兜底。现在解析规则收敛成
   * resolveSourceRef 一份、呈现收敛成 evidenceChip 一份，五处（候选 / 资产 /
   * 版本 / 使用记录 / KSTAR）共用 → 同一来源必然同名（AC1）。
   * 铁律：任何状态下都不得把 rawId 当显示名（AC3）。
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
      view.openTarget = rawId;
    };
    const inlineTitle = String(raw.title || raw.conversationTitle || raw.name || '').trim();
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

  // 来源三态（2026-09-20 修复「来源已删」误判）：available=目录命中/整理中；
  // immediate=对话中当场记（无独立会话出处——不是被删，诚实标注不计弱证据）；
  // unavailable=查无（引用的会话已不存在或无处核对）。
  // 2026-09-25 起判据统一由 resolveSourceRef 给出，本函数只做三态收敛——
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
  /** 证据条目的**唯一**呈现出口（2026-09-17 子安"看不懂"口径：每类带类型前缀；
   *  2026-09-25 US-603：一律经 resolveSourceRef，任何分支都不上屏裸 id）。
   *  可解析的来源给回看入口（会话跳转 / 复盘展开），其余只显名。
   *  2026-09-29 详情重构：拆成 text+html 两半——详情页来历区要做同文去重
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
      // 可解析到会话就给回看入口（US-603 AC2）：点回原对话核对证据。
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
  /** 血统判据只认"还活着"的证据（2026-09-18 乙档）：被标 degraded 的复盘
   *  证据（写入时解析不到对应记录）不算 KSTAR 血统——查无的引用不能当出身。
   *  分组展示仍按形状走 isKstarEvidenceRef：一条脏证据也要显示在它该在的
   *  组里，只是标明不可用。 */
  const isLiveKstarEvidenceRef = (ref) => isKstarEvidenceRef(ref) && ref.degraded !== true;
  /** 归边判定（2026-09-17 B 档）：纯渲染层口径，不动主进程——身上挂有
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
  /** 证据分组（2026-09-17 B 档两线分开）：KSTAR 任务复盘一组、对话与表态
   *  一组，各带一句来源说明——两线证据混排一排正是"杂揉"观感的来源。
   *  2026-09-29 详情重构：组内同文 chip 去重（同一来源被引用两次只出一枚，
   *  ×N 计数）；"来源记录不可用"这类无信息量芯片聚合为一枚摘要——原始
   *  引用清单仍在版本数据里，界面上不再逐枚刷灰。 */
  const evidenceGroupsHtml = (refs) => {
    const kstar = refs.filter(isKstarEvidenceRef);
    const chat = refs.filter((ref) => !isKstarEvidenceRef(ref));
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

  /** 原始记录清洗（2026-09-17）：实际产出里会有 markdown 记号（**、##、代码
   *  块），原样展示是一坨看不懂的技术文本——去记号、折叠代码块、压空白。 */
  function stripMarkdown(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*#>_|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  /** 长值折叠（specs/015 依据链复用件）：短值直出，超长/多行值套既有折叠样式
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

  /** 归因枚举 → 人话（2026-09-17）：此前直接透传 execution_gap/unclear 这类
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

  /** 任务经过块（2026-09-17 二次改，白话化）：点证据 chip 就地展开"当时
   *  这次任务发生了什么"——字段是内部语言（attribution 枚举、markdown
   *  原文、与目标重复的 expectedResult），逐项翻成人话：当时的目标 /
   *  实际发生（清洗+截断）/ 结果 / 为什么 / 学到的。 */
  function kstarEpisodeSection(route) {
    const id = String(route.kstarEpisodeId || '');
    if (!id) return '';
    const state = S.kstarEpisode;
    if (!state || state.episodeId !== id) {
      return `<div class="sect-block"><div class="sub">${esc(T('cognition.kstar_episode_loading', '正在读取这次任务的经过…'))}</div></div>`;
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
   *  US-603 铁律：rawId 不上屏。已知资产换标题、其余换泛称，句子其余部分照原样。
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

  /* 整理任务行内动作（整理记录行与整理详情共用）：主按钮按优先级取一个，
   * 暂停/取消作次级；导航类动作（去确认/配置模型）在 app.js 分流，控制类走
   * capture-action（与后端 actions 语义 id 一字不差）。 */
  const CAPTURE_PRIMARY_ORDER = ['review_candidates', 'run_now', 'resume', 'retry', 'configure_model', 'view_assets'];
  const CAPTURE_NAV_ACTS = { review_candidates: 'go-review', configure_model: 'go-configure-model' };
  function captureActionButtons(capture) {
    const vocab = NS.vocabulary;
    const actions = Array.isArray(capture.actions) ? capture.actions : [];
    const primary = CAPTURE_PRIMARY_ORDER.find((action) => actions.includes(action));
    const primaryBtn = primary === 'view_assets'
      ? btn(T('cognition.capture_action_view_assets', '查看资产'), 'open-asset', { id: (capture.linkedAssetIds || [])[0] || '', small: true, primary: true })
      : primary && CAPTURE_NAV_ACTS[primary]
        ? btn(vocab ? vocab.captureActionText(primary) : primary, CAPTURE_NAV_ACTS[primary], { small: true, primary: true })
        : primary
          ? btn(vocab ? vocab.captureActionText(primary) : primary, 'capture-action', { id: capture.id, data: { action: primary }, small: true, primary: true })
          : '';
    const secondaryBtns = ['pause', 'cancel'].filter((action) => actions.includes(action)).map((action) => btn(
      vocab ? vocab.captureActionText(action) : action,
      'capture-action',
      { id: capture.id, data: { action }, small: true, danger: action === 'cancel' },
    )).join('');
    return primaryBtn + secondaryBtns;
  }

  /* ────────────────────────── 认知树 v4（光斑有机版） ────────────────────────── */
  /* 垂直轴 = 处理梯度：土壤（来源与整理）→ 根（待确认候选）→ 干（本体总览）
     → 枝（四类资产）→ 冠（已验证）。层级语义（2026-09-21 原型 v7 契约）：
     枝端光斑 = 大方向分类；叶片 = 细分方向（家族组名 → 标题冒号前主题 →
     标题，同方向合并计数）；单条资产不渲染成光斑——树上没有资产级节点，
     树冠/根部各只有一个聚合光斑。视觉走 Organic Biophilic：贝塞尔枝、
     径向渐变光斑、锥形树干；SVG viewBox 自适应，无需手动 resize 重绘。 */

  /** 叶片方向派生 + 同方向合并计数。返回 [[方向名, n], ...]（按量降序）。
   *  取名口径与原型一致：优先族名，其次标题冒号/箭头前的头段。
   *  （specs/012 T016 定调：族名 = **同源血缘**，不是主题分类——主题分类
   *  见资产的 `tags`；这里只是拿血缘名当叶片的默认方向名，逻辑不动。） */
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

  /** 四主枝（2026-09-21 第四枝定调）：技能与方法 / 事实与知识 / 规则与偏好 / 模板与范例。
   *  side/len/y 是原型 v7 的几何参数：两条上枝（y=.32）分列左右，两条下枝（y=.72）更短。 */
  const TREE_BRANCHES = [
    /* y = 枝端高度系数（占干顶以下可用地面的比例，越大越高）。下枝组
       0.32 → 0.44：原值末梢扫到近土面、下垂像柳树（2026-09-21 子安真机
       抓出），抬高后接近真实树形。 */
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
    /* 树冠几何：云团坐在树干顶上（冠底盖过干顶 ~62px），窗口再高也不脱开
       （2026-09-21 子安真机两连抓出）。clamp 防矮窗口把云团顶出画布。 */
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
       落点「我的认知」默认按最近真实使用排（018 T021）。 */
    const crownTitle = validated
      ? T('cognition.tree_crown_validated', '被真用过 {n}', { n: String(validated) })
      : T('cognition.tree_crown_empty', '还没有被真用过的');
    const pillY = crownCy - 20;
    g += `<g class="spot" ${roleBtn(`data-act="open-overview" data-title="${esc(crownTitle)}" data-sub="${esc(T('cognition.tree_crown_sub', '被真用过的都在树冠——点开按最近真实使用排'))}" aria-label="${esc(crownTitle)}"`)}>
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
      <text x="${cx}" y="${pillY + 66}" text-anchor="middle" class="crown-sub">${esc(T('cognition.tree_crown_sub', '被真用过的都在树冠——点开按最近真实使用排'))}</text>
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
           t=0.9 的上侧叶正好撞牌（2026-09-21 真机抓出）。 */
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

    /* 土壤：会话与采集记录的来源层（点开=系统活动的时间流，018 T021）。 */
    g += `<g class="spot" ${roleBtn(`data-act="go-organize" data-title="${esc(T('cognition.tree_soil_title', '系统活动：整理过程与结果都在这里'))}" data-sub="${esc(T('cognition.tree_soil_hint', '会话与记录在这里生根'))}" aria-label="${esc(T('cognition.tree_soil_label', '土壤 · 记录 {s} · 整理 {c}', { s: String(Number(info.sources || 0)), c: String(Number(info.captures || 0)) }))}"`)}>
      <rect x="${cx - 330}" y="${groundY + 2}" width="660" height="58" rx="12" class="soil-band"/>
      <text x="${cx}" y="${groundY + 27}" text-anchor="middle" class="soil-title">${esc(T('cognition.tree_soil_label', '土壤 · 记录 {s} · 整理 {c}', { s: String(Number(info.sources || 0)), c: String(Number(info.captures || 0)) }))}</text>
      <text x="${cx}" y="${groundY + 46}" text-anchor="middle" class="soil-sub">${esc(T('cognition.tree_soil_hint', '会话与记录在这里生根'))}</text>
    </g>`;

    return `<svg id="ca-tree-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(T('cognition.tree_panel_title', '我的认知树'))}">${g}</svg>`;
  }

  /* ────────────────────────── 资产详情 ────────────────────────── */

  /* 会话名 join：使用记录事件只带 conversationId，用户看不懂裸 id——按来源
   * 清单里的会话项翻成标题；join 不到（会话已删/老数据无此字段）用泛称，
   * 不编造名字。整句叙事见 proofSentence。（2026-09-15 自独立使用记录页
   * 迁入资产详情，成为资产详情的使用记录区。） */
  function conversationNames() {
    const names = new Map();
    for (const group of S.sources) {
      for (const item of Array.isArray(group.items) ? group.items : []) {
        if (item.kind === 'conversation' && item.id) names.set(String(item.id), String(item.title || ''));
      }
    }
    // 目录只有 100 条窗口，窗口外的会话此前一律退化成「一次对话里」（US-602
    // AC2「可定位会话」不成立）。批量标题口是权威，覆盖目录里的同名旧值。
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
      // 按 outcome 说清"怎么用到的"（2026-09-25 US-602 AC4/AC5）：宿主注入、
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
      // 模型自选的撤销要在使用记录里看得见（2026-09-18）：否则"我撤过它"没有
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
   *  否则一次带入被数成两次。没有投影关联的 usage 行只在明确是"另一条路线"
   *  （模型自读 / 派发 / 迁移核对 / 你的评价）时才另计；否则视作该投影自身的记录，
   *  **宁可少算不多算**。撤销事件单列不计。 */
  function assetProofItems(assetId) {
    const timeline = S.assetTimeline;
    if (timeline && String(timeline.assetId || '') === String(assetId)
      && !timeline.loading && !timeline.failed && Array.isArray(timeline.items)) return timeline.items;
    return S.proofs;
  }

  function broughtInCountFor(assetId, proofItems) {
    const realKinds = new Set(Array.isArray(S.realUsageKinds) ? S.realUsageKinds : []);
    const items = (Array.isArray(proofItems) ? proofItems : S.proofs).filter((proof) => realKinds.has(String(proof.kind || ''))
      && String((proof.refs || {}).assetId || '') === String(assetId));
    const confirmedProjectionIds = new Set(items
      .filter((p) => String(p.kind || '') === 'projection_confirmed')
      .map((p) => String((p.refs || {}).projectionId || ''))
      .filter(Boolean));
    const separateRoutes = new Set(['agent_read', 'dispatched', 'succeeded', 'degraded', 'rejected', 'feedback_positive', 'feedback_negative']);
    return items.filter((p) => String(p.kind || '') === 'projection_confirmed').length
      + items.filter((p) => {
        if (String(p.kind || '') !== 'usage_recorded') return false;
        const refs = p.refs || {};
        const projectionId = String(refs.projectionId || '');
        if (projectionId) return !confirmedProjectionIds.has(projectionId);
        return separateRoutes.has(String(refs.usageOutcome || ''));
      }).length;
  }

  /** 资产详情的使用记录区（原独立「使用记录」页的按资产切片）。 */
  function assetUsageSection(asset, route) {
    const realKinds = new Set(Array.isArray(S.realUsageKinds) ? S.realUsageKinds : []);
    const proofItems = assetProofItems(asset.id);
    const items = proofItems
      .filter((p) => String((p.refs || {}).assetId || '') === String(asset.id))
      // 真实使用事件（白名单来自主进程，与列表侧同一份）+ 撤销事件：撤销要看得见
      //（AC3），但不计入任何次数。版本保存、选用切换、治理操作都不是使用。
      .filter((p) => realKinds.has(String(p.kind || '')) || String(p.kind || '') === 'projection_revoked')
      .sort((left, right) => String(right.occurredAt || '').localeCompare(String(left.occurredAt || '')));
    if (!items.length) {
      return `<div class="sect-block"><div class="sub">${esc(T('cognition.asset_no_proofs_section', '还没有被真实使用过。资产在任务中被真正使用、并留下可核对的记录后，会出现在这里。'))}</div></div>`;
    }
    const names = conversationNames();
    // 现存版本集合（bug3）：只认版本链里实际存在的版本——asset.version 是
    // 只增游标（真删不回退，防引用错位），不能当"现存"用；链未加载时不
    // 标注（拿不准宁可显示普通后缀，不误标"已删除"）。
    const knownVersions = new Set();
    if (S.assetVersions && S.assetVersions.assetId === String(asset.id) && Array.isArray(S.assetVersions.versions)) {
      knownVersions.add(String(asset.activeVersion || ''));
      for (const v of S.assetVersions.versions) knownVersions.add(String(v.version));
    }
    // 「被任务用过」计数走唯一公式（与目录行、列表侧同口径）。
    const broughtInCount = broughtInCountFor(asset.id, proofItems);
    // 「实际采用」只认有据回执（AC5/AC6）：applied 才算采用，contradicted 单列，
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
      broughtInCount ? T('cognition.proof_projected_times', '被任务用过 {n} 次', { n: String(broughtInCount) }) : '',
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

  /** 资产改版后仍有效的长期投影会继续冻结使用旧版。只对可在会话卡上撤销的
   *  user-pinned / model-selected 挂载发提醒；过期记录与普通历史确认保留在时间线，
   *  但不冒充仍在影响后续任务。 */
  function assetPinnedVersionWarningSection(asset) {
    const timeline = S.assetTimeline;
    if (!timeline || String(timeline.assetId || '') !== String(asset.id) || timeline.loading) return '';
    if (timeline.failed) {
      return `<div class="warn ca-stale-pin-warning"><strong>${esc(T('cognition.asset_stale_pins_unavailable', '暂时无法核对这条资产固定在对话中的版本。重试后再判断。'))}</strong>
        ${btn(T('cognition.asset_stale_pins_retry', '重试核对'), 'asset-timeline-retry', { id: asset.id, small: true })}</div>`;
    }
    const currentVersion = String(asset.activeVersion || asset.version || '');
    if (!currentVersion) return '';
    const now = Date.now();
    const stalePins = (Array.isArray(timeline.items) ? timeline.items : [])
      .filter((item) => {
        const refs = item && item.refs || {};
        if (String(item && item.kind || '') !== 'projection_confirmed') return false;
        const longLived = refs.authorization === 'model_selected'
          || (refs.authorization === 'user_confirmed' && refs.purpose === 'user_pinned');
        if (!longLived || !refs.version || String(refs.version) === currentVersion) return false;
        if (refs.expiresAt) {
          const expiry = Date.parse(String(refs.expiresAt));
          if (!Number.isFinite(expiry) || expiry <= now) return false;
        }
        return true;
      })
      .sort((left, right) => String(right.occurredAt || '').localeCompare(String(left.occurredAt || '')));
    if (!stalePins.length) return '';
    const rows = stalePins.slice(0, 5).map((item) => {
      const refs = item.refs || {};
      const where = refs.conversationId
        ? evidenceChip({ kind: 'conversation', id: String(refs.conversationId) })
        : chip(T('cognition.evidence_conversation_generic', '一段对话'), 'line');
      const version = T('cognition.asset_stale_pin_versions', '固定 v{confirmed} · 当前 v{current} · {when}', {
        confirmed: String(refs.version),
        current: currentVersion,
        when: fmtDate(item.occurredAt),
      });
      return `<div class="sub ca-stale-pin-row">${where}<span>${esc(version)}</span></div>`;
    }).join('');
    const more = stalePins.length > 5
      ? `<div class="note">${esc(T('cognition.asset_stale_pins_more', '另有 {n} 个旧版本挂载', { n: String(stalePins.length - 5) }))}</div>`
      : '';
    return `<div class="warn ca-stale-pin-warning">
      <strong>${esc(T('cognition.asset_stale_pins_title', '有 {n} 处长期引用仍固定使用旧版', { n: String(stalePins.length) }))}</strong>
      <details class="ca-stale-pin-detail">
        <summary>${esc(T('cognition.asset_stale_pins_open', '查看引用与处理办法'))}</summary>
        <div class="note">${esc(T('cognition.asset_stale_pins_hint', '这些仍有效的引用会继续把旧版带入后续任务。回到相关对话，在引用卡中撤销旧引用，再重新引用这条资产，后续任务就会使用当前版。'))}</div>
        <div class="ca-stale-pin-list">${rows}${more}</div>
      </details>
    </div>`;
  }

  /** 实际采用记录（2026-09-25 US-602 AC5/AC6）：唯一权威 = usage 回执 applied。
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
      return `<div class="ca-proof-row">
        <div class="ca-proof-body">
          <strong class="ca-proof-sentence">${esc(statusLabel(String(receipt.status || '')))}</strong>
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

  /** 资产详情「为什么这一轮排在前面」（specs/012 T020 / US-202 AC4）：使用
   *  记录区里的折叠小节，解释这条资产最近一轮在目录里的推荐排序依据。
   *  数据 = recall.catalog.ranking（注入回执的 ranking 拆解，只读）——由
   *  app.js 按详情页资产异步取回后挂在 NS.rankingWhy（本文件不改 core）。
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

  /** 版本来源标签（2026-09-17 报告建议 E）：reason 是审计字段（多为机器
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
    // 「确认沉淀」（2026-09-17 改）：review_decision 前缀两线通用（对话线
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

  /** 两版字段级对比（2026-09-17 报告建议 C）：两版全量快照已在渲染层
   *  （versions.list），前端自算任意两版——通道只返回相邻版本对，覆盖
   *  不了"v3 vs 在用 v2"。展示顺序照主进程 CHANGE_ORDER：边界→范围→
   *  正文→证据→标题；无差异明说"内容一致"。 */
  function assetVersionDiffBlock(asset, baseV, targetV) {
    const a = (baseV && baseV.snapshot) || {};
    const b = (targetV && targetV.snapshot) || {};
    const text = (value) => (Array.isArray(value) ? value.join('、') : String(value || '')) || '—';
    const rows = [
      [T('cognition.asset_edit_field_applicable', '适用场景'), text(a.applicableWhen), text(b.applicableWhen)],
      [T('cognition.asset_edit_field_forbidden', '禁用场景'), text(a.forbiddenWhen), text(b.forbiddenWhen)],
      [T('cognition.asset_version_diff_scope', '适用范围'), text(a.scope), text(b.scope)],
      [T('cognition.asset_version_diff_statement', '正文'), text(a.statement), text(b.statement)],
      [T('cognition.asset_version_diff_evidence', '证据数量'), String((a.evidenceRefs || []).length), String((b.evidenceRefs || []).length)],
      [T('cognition.asset_version_diff_title_field', '标题'), text(a.title), text(b.title)],
    ].filter((row) => row[1] !== row[2]);
    const title = T('cognition.asset_version_diff_line', '版本对比：v{a}（在用） → v{b}', { a: String((baseV && baseV.version) || '?'), b: String((targetV && targetV.version) || '?') });
    if (!rows.length) {
      return `<div class="sect-block ca-version-diff"><div class="tt">${esc(title)}</div><p class="note">${esc(T('cognition.asset_version_diff_same', '两版内容一致。'))}</p></div>`;
    }
    return `<div class="sect-block ca-version-diff">
      <div class="tt">${esc(title)}</div>
      ${rows.map(([label, from, to]) => `<div class="meta-item"><span class="meta-k">${esc(label)}</span><span class="meta-v">${esc(from)} → ${esc(to)}</span></div>`).join('')}
    </div>`;
  }

  /** 单个版本的展开详情（2026-09-17）：列表行只给 80 字预览，点行看全文与
   * 逐项信息；非在用版就地提供「删除此版本」（真删：物理移除，引用它的
   * 已确认注入在服务端冻结了内容副本）。 */
  /** 适用范围白话化（2026-09-17 随详细信息下沉版本块提取共用）。 */
  function scopeLabelText(raw) {
    const value = String(raw || '');
    if (!value) return T('cognition.asset_scope_unset', '还没设置');
    // 白话映射覆盖中英两种内部写法（2026-09-17 修 personal 裸英文）：
    // 后端 scope 是自由文本，认得出的常见形态翻人话，认不出原样显示。
    if (/全局|画像|general/.test(value)) return T('cognition.asset_scope_all', '所有对话');
    if (value === 'personal') return T('cognition.asset_scope_personal', '个人对话');
    return value;
  }
  /** 版本快照的来源行（2026-09-17 下沉）：按该版快照的学习信号判定 KSTAR
   *  血统；无信号（会话整理线）不显示——返回空串即可被行渲染跳过。 */
  function snapshotOriginText(signal, provenance) {
    const source = provenance ? 'review'
      : signal && ['review', 'preference_scan'].includes(String(signal.source || '')) ? String(signal.source) : '';
    if (!source) return '';
    return source === 'preference_scan'
      ? T('cognition.asset_origin_pref_scan', '来自偏好扫描')
      : T('cognition.asset_origin_kstar', '来自那次任务的复盘');
  }

  function assetVersionDetailBlock(asset, v, isActive, usage) {
    const snap = v.snapshot || {};
    const usageText = usage
      ? [usage.applied ? T('cognition.asset_usage_applied', '模型确认采用 {n} 次', { n: String(usage.applied) }) : '',
        usage.contradicted ? T('cognition.asset_usage_contradicted', '被否定 {n} 次', { n: String(usage.contradicted) }) : '']
        .filter(Boolean).join(' · ')
      : '';
    const evidenceCount = Array.isArray(snap.evidenceRefs) ? snap.evidenceRefs.length : 0;
    const rowHtml = (label, value) => value ? `<div class="meta-item"><span class="meta-k">${esc(label)}</span><span class="meta-v">${esc(String(value))}</span></div>` : '';
    // 对比/合并的目标与基准都在版本链里；diff 就地展开（报告建议 C），
    // 合并两版为新版（报告建议 H）也挂这里——查看与危险操作集中在展开块。
    const versions = (S.assetVersions && S.assetVersions.versions) || [];
    const activeV = versions.find((x) => String(x.version) === String(asset.activeVersion || asset.version));
    const showDiff = String(S.route.assetVersionDiff || '') === String(v.version);
    // 编辑入口只在版本行（2026-09-17 子安口径）：每个版本（含在用版）都能
    // 成为编辑起点——在用版直接编辑，历史版先设为在用再编辑（合一步）。
    const editFromBtn = btn(T('cognition.asset_edit_from_version', '基于此版修改'), 'edit-from-version', { id: asset.id, data: { version: String(v.version) }, small: true, primary: true });
    const actions = isActive
      ? `${editFromBtn}<span class="note">${esc(T('cognition.asset_version_active_locked', '当前在用版本不可删除；先选用其他版本，再删除它。'))}</span>`
      : `${editFromBtn}
        ${btn(showDiff ? T('cognition.asset_version_diff_hide', '收起对比') : T('cognition.asset_version_diff_show', '与在用版对比'), 'diff-asset-version', { id: asset.id, data: { version: String(v.version) }, small: true })}
        ${btn(T('cognition.asset_version_merge', '与在用版合并为新版'), 'merge-asset-version', { id: asset.id, data: { version: String(v.version) }, small: true })}
        ${btn(T('cognition.asset_version_delete', '删除此版本'), 'delete-asset-version', { id: asset.id, data: { version: String(v.version) }, danger: true, small: true })}`;
    // 详细信息与证据按版本下沉（2026-09-17 子安口径）：范围/怎么来的/证据
    // 本就存于每版快照、各版不同——跟版本走，顶部不再显示资产级副本。
    // 证据 chips 点开「这次任务的经过」也挂块内（展开态走路由，重画不丢）。
    return `<div class="sect-block ca-version-detail">
      <div class="tt">${esc(T('cognition.asset_version_detail_title', '版本详情'))} · v${esc(String(v.version))}</div>
      <p class="note">${esc(String(snap.statement || ''))}</p>
      <div class="meta-row">
        ${rowHtml(T('cognition.asset_scope_label', '适用范围'), scopeLabelText(snap.scope))}
        ${rowHtml(T('cognition.asset_version_applicable', '适用场景'), (Array.isArray(snap.applicableWhen) ? snap.applicableWhen : []).join('；'))}
        ${rowHtml(T('cognition.asset_version_forbidden', '禁用场景'), (Array.isArray(snap.forbiddenWhen) ? snap.forbiddenWhen : []).join('；'))}
        ${rowHtml(T('cognition.asset_origin_label', '怎么来的'), snapshotOriginText(snap.learningSignal, snap.learningProvenance))}
        ${rowHtml(T('cognition.asset_version_reason_label', '变更说明'), [versionSourceLabel(v), fmtDate(v.at)].filter(Boolean).join(' · '))}
        ${rowHtml(T('cognition.asset_version_usage_label', '使用效果'), usageText)}
      </div>
      ${evidenceCount ? `${evidenceGroupsHtml(snap.evidenceRefs)}${kstarEpisodeSection(S.route)}` : ''}
      <div class="actions actions-right">${actions}</div>
      ${showDiff && activeV ? assetVersionDiffBlock(asset, activeV, v) : ''}
    </div>`;
  }

  /** 版本链（2026-09-16 版本组）：V1 归入同条目可展开；在用=指针可切换，
   *  「选用此版」走 select-asset-version（内容同步、不产生新版本号）。
   *  守卫 ≥1 版即显示（2026-09-17 下沉改）：详细信息和证据都归版本展开
   *  块——单版本资产的证据也要有位置可看。
   *  读失败显式标记 + 重试（2026-09-30 r3 补齐，与使用/采用记录同口径）：
   *  不把「没读到」伪装成「没有版本」。 */
  function assetVersionsSection(asset) {
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
    // 冻结引用按版本（主进程现算）：这一版被多少个**已确认投影**引用过。
    // 「已有更新的版本」标记认这个，不认 KSTAR 采用回执——后者为空时标记永不出现
    // （2026-09-25 合并态走查：v1 被 8 条投影冻结，界面却没有标记）。
    const frozenByVersion = new Set((state.frozen || []).map((f) => String(f.version)));
    // 空版本标记（2026-09-16）：与相邻版内容一字不差的版本（系统迁移垫高/
    // 旧版归并搬运）显示"内容未变"，避免"两版一模一样"被误读为出错。
    const contentKey = (snap) => `${snap.title || ''}\n${snap.statement || ''}`;
    const sortedAsc = [...state.versions].sort((left, right) => Number(left.version) - Number(right.version));
    const unchangedAfter = new Set(sortedAsc.filter((v, i) => i > 0 && contentKey(v.snapshot || {}) === contentKey(sortedAsc[i - 1].snapshot || {})).map((v) => String(v.version)));
    // 来源标签（报告建议 E）：reason 原文收展开块，行上只给归一化标签。
    // 系统迁移产生的空版本默认折叠（报告建议 E）：与相邻版一字不差的
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
        // 内容摘要（2026-09-16 用户反馈：两版只显示标题看不出差异，也看不到
        // 具体内容）——正文截 80 字进 meta，标题相同的内容差异由此可辨。
        const statement = String((v.snapshot && v.snapshot.statement) || '').replace(/\s+/g, ' ').trim();
        const statementPreview = statement.length > 80 ? `${statement.slice(0, 80)}…` : statement;
        const meta = [statementPreview, fmtDate(v.at), versionSourceLabel(v), unchangedAfter.has(String(v.version)) ? T('cognition.asset_version_unchanged', '内容未变（系统迁移/搬运）') : '', usageText].filter(Boolean).join(' · ');
        // 已被任务引用过（冻结引用，或 KSTAR 判过采用/否定）的历史版本：明说
        // 「已有更新的版本」。引用它的任务仍按当时冻结的内容执行（服务端按副本
        // 供给），所以这不是错误状态，只是"你看的这一版已经不是最新的"——用户
        // 据此决定切回还是接受新版。文案复用既有的 `asset_version_latest_note`
        // （2026-09-17 头部提示移除后留下的孤儿键，四语已齐）：概念一字不差，
        // 不再造一个近义键。
        // 判据是"被引用过"= 冻结引用计数 > 0 **或** 有采用回执；只有回执那一半
        // 会因回执库为空而恒假，所以冻结引用是主判据（2026-09-25 修）。
        const superseded = !isActive
          && (frozenByVersion.has(String(v.version)) || (!!usage && (usage.total || 0) > 0));
        const side = isActive
          ? chip(T('cognition.asset_version_active', '在用'), 'green')
          : `${superseded ? window.uiTag({ label: T('cognition.asset_version_latest_note', '已有更新的版本'), variant: 'version' }) : ''}${btn(T('cognition.asset_version_select', '切回此版'), 'select-asset-version', { id: asset.id, data: { version: String(v.version) }, small: true })}`;
        // 行可点开（2026-09-17）：点行就地展开该版本全文详情；再点收起。
        const open = String(S.route.assetVersionId || '') === String(v.version);
        return `<div class="row is-flat is-clickable" data-act="open-asset-version" data-version="${esc(String(v.version))}" ${roleBtn()}>
          <div class="tw"><div class="tt">v${esc(String(v.version))} · ${esc(title)}</div><div class="mm">${esc(meta)}</div></div>
          <div class="sd">${side}</div>
        </div>
        ${open ? assetVersionDetailBlock(asset, v, isActive, usage) : ''}`;
      }).join('');
    // 头部「已有更新的版本」下钻已随头部重构移除（2026-09-17）：版本信息
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

  /** 资产编辑表单（2026-09-17 报告建议 A）：预填在用版现值；保存产生新
   *  版本（core.editAsset 先比对，无实际修改不提交——后端相同内容也会
   *  bump 出空版本）。类型变更走候选线重审；Agent/工作空间限制通过可读名称
   *  多选，底层仍保存稳定 id。（敏感级三档控件已随机制整体删除，2026-09-28。） */
  function assetEditForm(asset) {
    const fieldHtml = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
    const joinList = (list) => (Array.isArray(list) ? list.join('、') : '');
    const editDraft = (S.assetEditDrafts || {})[String(asset.id)] || {};
    const draftValue = (key, fallback) => Object.prototype.hasOwnProperty.call(editDraft, key) ? editDraft[key] : fallback;
    const fid = (name) => `ca-asset-edit-${name}-${esc(asset.id)}`;
    // 治理类信息（边界编辑、scopePolicy 可见范围）收「高级」折叠（五区骨架，
    // 2026-09-28）：与候选表单的「高级选项（通常不用改）」同款形态——普通
    // 用户只改标题/正文，边界与范围按需展开；折叠内能力不变。
    const advancedFold = `<details class="details ca-asset-edit-advanced">
      <summary>${esc(T('cognition.candidate_advanced', '高级选项（通常不用改）'))}</summary>
      ${fieldHtml(T('cognition.asset_edit_field_applicable', '适用场景（多条用顿号分隔）'), window.uiInput({ id: fid('applicable'), value: String(draftValue('applicable', joinList(asset.applicableWhen)) || ''), attrs: { 'data-f': 'applicable' } }))}
      ${fieldHtml(T('cognition.asset_edit_field_forbidden', '禁用场景（多条用顿号分隔）'), window.uiInput({ id: fid('forbidden'), value: String(draftValue('forbidden', joinList(asset.forbiddenWhen)) || ''), attrs: { 'data-f': 'forbidden' } }))}
      ${assetScopeEditor(asset, editDraft)}
    </details>`;
    return `<div class="sect-block ca-asset-edit" data-asset-edit-id="${esc(asset.id)}">
      <div class="tt">${esc(T('cognition.asset_edit_title', '编辑资产'))}</div>
      <p class="note">${esc(T('cognition.asset_edit_hint', '修改内容或适用范围会生成新版本；来源和证据会保留，旧版本也可回滚。'))}</p>
      ${fieldHtml(T('cognition.asset_edit_field_title', '标题'), window.uiInput({ id: fid('title'), value: String(draftValue('title', asset.title || '') || ''), attrs: { 'data-f': 'title' } }))}
      ${fieldHtml(T('cognition.asset_edit_field_statement', '正文'), window.uiTextarea({ id: fid('statement'), value: String(draftValue('statement', asset.statement || '') || ''), attrs: { 'data-f': 'statement' } }))}
      ${advancedFold}
      <div class="actions actions-right">
        ${btn(T('common.cancel', '取消'), 'asset-edit-cancel', { id: asset.id })}
        ${btn(T('cognition.asset_edit_save', '保存为新版本'), 'asset-edit-save', { id: asset.id, primary: true })}
      </div>
    </div>`;
  }

  function assetDetail(asset, route) {
    // 编辑态（2026-09-17 报告建议 A）：正文区替换为编辑表单——改自己写的
    // 话不该以"系统先产候选"为前提；保存走 recall.assets.update（+1 版本，
    // 与候选采纳产出的版本同链）。类型变更走候选线重审；范围由可读名称
    // 选择，不要求用户输入内部 id。
    // 资产级状态与开关贴着标题（2026-09-17 二改，子安红线口径）：标题右侧
    // 放总开关、标题下方一句实时生效说明——资产级信息归顶部（正文是内容、
    // 不是状态说明的挂载点）。异常态（删除/归并）仍走下方独立块。
    const editing = !!route.assetEdit && ['active', 'paused'].includes(String(asset.status || 'active'));
    const statusKind = String(asset.status || 'active');
    const statusOn = statusKind === 'active';
    const switchable = statusKind === 'active' || statusKind === 'paused';
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
        ? `<div class="sect-block"><p class="note">${esc(T('cognition.asset_archived_note', '已归并：这条资产已并入另一条资产，历史版本完整保留在并入目标的版本记录中。'))}</p></div>`
        : '';
    // 详细信息与证据已按版本下沉（2026-09-17 子安口径）：范围/怎么来的/证据
    // 各版不同、存于各版快照——归版本展开块显示，顶部不再放资产级副本。
    const moreRow = (label, hint, action) => `
      <div class="ca-more-row">
        <div class="ca-more-copy"><strong>${esc(label)}</strong><span>${esc(hint)}</span></div>
        ${btn(label, 'asset-action', { id: asset.id, data: { action }, danger: true, small: true })}
      </div>`;
    /* 正文、来历、使用各有明确入口；版本和治理保持按需展开，不丢原有能力。 */
    /* 来历（T040②）：来源会话 chip、那次任务的复盘 chip——可点回。解析一律
     * 走唯一解析器 + 唯一呈现出口（evidenceChip，2026-09-25 US-603 口径）；
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
    /* 用过吗（T040③/T042；2026-09-28 词表统一）：被任务用过 N 次 · 其中模型
     * 确认采用 M 次（无采用回执时省略后半句）· 最近一次 {when}。口径零改动：
     * 被任务用过＝broughtInCountFor 唯一公式（原「被带入」），模型确认采用＝
     * applied 回执（原「实际采用」）；逐条明细在「详情与历史」折叠区。 */
    const realKinds = new Set(Array.isArray(S.realUsageKinds) ? S.realUsageKinds : []);
    const detailProofs = assetProofItems(asset.id);
    const realProofs = detailProofs
      .filter((p) => realKinds.has(String(p.kind || '')) && String((p.refs || {}).assetId || '') === String(asset.id))
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
              : T('cognition.proof_projected_times', '被任务用过 {n} 次', { n: String(broughtIn) }))}</strong>
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
      ${lastProof ? `<div class="ca-asset-last-use"><span class="note">${esc(T('cognition.asset_last_used_at', '最近一次 {when}', { when: fmtDate(lastProof.occurredAt) }))}</span>${lastRef ? evidenceChip(lastRef) : ''}</div>` : ''}
      ${!timelinePending && !timelineFailed && broughtIn ? `<p class="note ca-asset-usage-note">${esc(T('cognition.asset_usage_metric_note', '前者记录任务中带入或读取等痕迹；真正采用只计模型确认的回执。'))}</p>` : ''}
    </div>`;
    /* 状态章两件（T040①）：类型 / 生效中（正常态也出章，018 覆盖 2026-09-17
     * 「正常不摆章」的减噪决策）。（「敏感档位/未分级」事实行已随敏感级机制
     * 整体删除，2026-09-28。） */
    const currentVersion = String(asset.activeVersion || asset.version || '').trim();
    const factsLine = `<div class="sub ca-detail-facts">
      ${chip(categoryLabel(asset.type))}
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
    /* 「详情与历史」折叠区＝④怎么被用的明细（五区骨架，2026-09-28 对照表）：
     * 使用明细 / 实际采用记录 / 排序依据 / **版本历史**（版本信息归④）。
     * 标签与归并（管理操作）移⑤侧栏「更多操作」卡，台账（生命周期记录）随⑤。
     * 默认收起、内容不丢（T041 口径不变）。 */
    /* 版本计数挂上折叠标题（2026-09-29 子安走查「版本好像没有」）：默认收起
     * 又无计数，多版本资产的演化链从外面完全不可见。计数＝版本流里的真实
     * 版本数（S.assetVersions 已补拉时）；补拉未回或单版本时不挂数字。 */
    const versionCount = (S.assetVersions && String(S.assetVersions.assetId) === String(asset.id)
      && Array.isArray(S.assetVersions.versions) && S.assetVersions.versions.length > 1)
      ? S.assetVersions.versions.length : null;
    const historyFold = foldBlock(
      T('cognition.asset_history_fold', '使用与版本'),
      versionCount,
      T('cognition.asset_history_fold_hint', '使用明细、采用记录、排序依据与版本历史都在这里，内容一样全。'),
      `${assetUsageSection(asset, route)}${assetRankingWhySection(asset)}${assetAdoptionSection(asset)}${assetVersionsSection(asset)}`,
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
          // 资产管家安全网（specs/008 US-404）。
          danger_snapshot: T('cognition.audit_danger_snapshot', '危险操作前留档'),
          danger_confirmed: T('cognition.audit_danger_confirmed', '危险操作已确认'),
          danger_denied: T('cognition.audit_danger_denied', '危险操作未确认'),
          attempt_blocked: T('cognition.audit_attempt_blocked', '操作被拦下'),
        };
        /* 台账四项（specs/008 US-404 T029）：谁（actor）/ 何时（at）/ 前后值 / 依据，
         * 四项都要在界面上看得见——只给一句"更新内容"等于没账。 */
        const AUDIT_ACTOR_LABELS = {
          user: T('cognition.audit_actor_user', '你'),
          ai: T('cognition.audit_actor_ai', 'AI'),
          system: T('cognition.audit_actor_system', '系统'),
        };
        // 台账来自版本链读口（同一个资产、同一次拉取）。此前只认 asset.audit，
        // 而那个字段从来没有被赋过值——这一整块审计区是死的（2026-09-25 真机抓出）。
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
          // 行内「回滚到这次改动前」已删（审计 R2，2026-09-28）：与版本区
          // 「切回此版」功能重叠且 0 使用。想回到某次改动前的内容，走版本
          // 区的「切回此版」（rollbackAnchor 数据仍在服务端，只是不再出按钮）。
          return '<div class="proc-row"><span class="when">' + esc(fmtDate(row.at)) + '</span>'
            + '<span style="flex:1">' + head + change + '</span></div>';
        }).join('');
        const tip = auditRows.length > 12
          ? '<div class="note" style="margin-top:6px">' + esc(T('cognition.audit_truncated', '仅显示最近 12 条；真实环境由审计流提供完整履历。')) + '</div>'
          : '';
        /* 2026-09-29 详情重构：台账不再自撑一个折叠——并入右栏「治理与历史」
         * 折叠体（三处折叠收敛为两处：主栏「使用与版本」＋右栏「治理与历史」）。 */
        return `<div class="sect-block"><div class="tt">${esc(T('cognition.audit_section', '生命周期记录'))}</div>${items}${tip}</div>`;
      })();
    /* 正式资产详情统一单列：内容、来历、使用、版本、管理各占一行。
     * 长正文和台账共用阅读宽度，窄窗仅收紧内边距，不改变区块顺序。 */
    const governanceFold = foldBlock(
      T('cognition.asset_governance_fold', '治理与历史'),
      null,
      T('cognition.asset_governance_fold_hint', '标签、与另一条合并、生命周期台账都在这里。'),
      `${assetTagsSection(asset)}${assetMergeSection(asset)}${lifecycleBlock}`,
      'ca-detail-governance',
    );
    const dangerActions = `${switchable ? moreRow(T('cognition.asset_delete', '删除'), T('cognition.asset_delete_hint', '从资产列表移除，历史记录保留'), 'delete') : ''}
      ${statusKind !== 'purged' ? moreRow(T('cognition.asset_purge', '彻底清除'), T('cognition.asset_purge_hint', '删除全部历史与证据，不可恢复'), 'purge') : ''}`;
    return `<div class="ca-asset-page">
      ${btn(T('cognition.asset_back', '← 返回列表'), 'go-back', { className: 'backlink' })}
      <header class="ca-detail-head ca-asset-head">
        ${factsLine}
        <div class="ca-asset-title-row">
          <h1>${esc(asset.title || asset.id)}</h1>
          <div class="ca-asset-head-actions">
            ${switchable && !editing ? btn(T('cognition.asset_edit_action', '修改内容'), 'edit-asset', { id: asset.id, small: true }) : ''}
            ${statusKind === 'active' && !editing ? btn(T('cognition.asset_use_in_chat', '用到当前对话'), 'asset-use-in-chat', { id: asset.id, small: true, primary: true, title: T('cognition.asset_use_in_chat_hint', '挂上后，这个对话后续每一轮都会带上它；可以随时在会话里的卡片撤销。') }) : ''}
          </div>
        </div>
        ${switchable ? `<div class="ca-asset-availability"><div><strong>${esc(T('cognition.asset_switch_label', '允许后续任务使用'))}</strong><p>${esc(switchHint)}</p></div>${switchEl}</div>` : ''}
      </header>
      <div class="ca-asset-stack">
        <section class="card ca-asset-detail">
          ${topControl}
          ${recommendWarn}
          ${assetPinnedVersionWarningSection(asset)}
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

  /** 存量治理（2026-09-16）：同义资产归并面板——同类型的其他条目可选为
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
      <div class="sd">${btn(T('cognition.asset_merge_into', '并入这条'), 'merge-asset', { id: asset.id, data: { target: String(other.id) }, small: true })}</div>
    </div>`).join('');
    return `<details class="details">
      <summary>${esc(T('cognition.asset_merge_section', '与另一条合并（同一认知的重复条目）'))}</summary>
      <p class="note">${esc(T('cognition.asset_merge_hint', '把本条的全部历史版本并入所选条目：较新的内容成为其新版本，本条归档不再单独显示。'))}</p>
      ${rows}
    </details>`;
  }

  /* ────────────────────────── 视图：我的认知 ────────────────────────── */

  /** 大类分组（2026-09-22 清单 #2·面板侧）：按 same_family 关系做连通分量，
   *  一组＝一个大类；组名默认取组内最近更新的资产标题（族命名功能挂本体分组，
   *  后续轮接）；无族关系的资产归入无血缘组。视图与筛选都保留原行为——
   *  分组只改变排列，不改变可见性。
   *  （specs/012 T008：族名 = 同源血缘，**不是**主题分类（主题分类见 tags）；
   *  呈现话术已降级——组头计数/无组文案在 i18n 改值，本函数逻辑零改动。） */
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
    /* 组名兜底短名（2026-09-21 修）：原来直接 slice(0,10)，把
       「沟通风格偏好（2026-09-19 明确提出）：…」切成「沟通风格偏好（2026」——
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
        // 得最多的那条资产标题的头段。族命名的写入按钮已删（审计 N2，
        // 2026-09-28：0 使用），recall.families.rename 通道的退役判定见 7.1。
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
  /* 2026-09-21 页签迁移:树从「我的认知」页顶部的卡片拆成独立全屏页。
   * 树只讲结构(冠/枝/干/根/土),资产明细全部留在「我的认知」——两个入口
   * 一份事实源,树上的每次点击都是导航而不是就地展开。 */

  function viewTree(route) {
    const stats = NS.stats();
    const counts = {};
    for (const [id] of CATEGORIES) counts[id] = S.assets.filter((a) => a.type === id && !['archived', 'deleted', 'purged', 'revoked'].includes(String(a.status || 'active'))).length;
    const sourceCount = S.sources.reduce((n, group) => n + (Array.isArray(group.items) ? group.items.length : 0), 0);
    const captureCount = Array.isArray(S.captures) ? S.captures.length : 0;
    // 计数口径(计划 4.4):已验证 = 成熟度达标且 active;待确认走 stats 口径
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
    /* 原型 v7 树页：整页一棵树 + 顶部一条读法提示 + 底部图例，
       没有页头卡片。018 T020：读法提示升级为页头导语（一页一问：
       「我的认知长什么样、有什么新变化」），旧 read_hint 与图例重复，
       就此退场（T023）。 */
    return `
      <div class="tree-stage${S.loading && !S.loaded ? ' is-loading' : ''}">
        <div class="fl-top">
          <div class="ft ft-title">${esc(T('cognition.tree_panel_title', '我的认知树'))}</div>
          <div class="ft">${esc(T('cognition.tree_page_hint', '这棵树是你的认知全景：土壤是记录与来源，根部是待确认的候选，枝上是正式资产，树冠是被真实复用验证过的。'))}</div>
          <div class="ft">${btn(T('cognition.catalog_view_back', '列表视图'), 'asset-view', { id: '', small: true, className: 'o' })}</div>
        </div>
        ${treeFigure({ counts, pending: stats.pending, validated, sources: sourceCount, captures: captureCount }, directions)}
        <div class="fl-bottom">
          <div class="legend">
            <span class="k"><span class="dt" style="background:var(--green)"></span>${esc(T('cognition.tree_legend_validated', '被真用过'))}</span>
            <span class="k"><span class="dt" style="background:var(--green-line)"></span>${esc(T('cognition.tree_legend_asset', '资产'))}</span>
            <span class="k"><span class="dt" style="background:var(--blue)"></span>${esc(T('cognition.tree_legend_kstar', '任务复盘学的'))}</span>
            <span class="k"><span class="dt" style="background:var(--amber-dot)"></span>${esc(T('cognition.tree_legend_pending', '新芽（待确认）'))}</span>
            <span class="legend-hint">${esc(T('cognition.tree_legend_hint', '枝端光斑 = 大方向 · 叶片 = 细分方向 · 悬停看详情'))}</span>
          </div>
        </div>
        <div class="tip" id="ca-tree-tip" role="tooltip"></div>
      </div>`;
  }

  /* ────────────────────────── 视图:个人本体(独立页挂载点) ────────────────────────── */
  /* 本体页的真实内容不在本文件:render() 把这个 mount 放进内容区后,由
   * core.mountPersonalOntology 把 index.html 里的本体 section 移进来并调
   * window.renderPersonalOntology()——本体模块自持状态,切页不销毁。 */

  function viewOntology() {
    return '<div id="ca-ontology-mount" class="ca-ontology-mount"></div>';
  }

  /* ────────────────────────── 标签系统（specs/012 US-201，T010~T013）──────────────────────────
   * 全部走共享控件（uiTag/uiInput/uiCheckbox/uiSegmentedControl/uiProgressBar/
   * uiModalController），零裸控件；可见文案一律 T() 内联（i18n 门禁扫得到）；
   * 渲染层只按主进程给的标签顺序消费（assetCount 常用置顶），不重排。 */

  /** 标签库快照的 active 子集（T012：筛选条只显示 assetCount>0 的 active）。 */
  const activeTagsWithAssets = () => ((S.tags && Array.isArray(S.tags.items)) ? S.tags.items : [])
    .filter((tag) => tag && String(tag.state || 'active') === 'active' && Number(tag.assetCount || 0) > 0);

  /** 标签筛选路由解析的取用件：真机恒走 core.parseTagFilterRoute（唯一处）；
   *  极简测试夹具（只装 views 不装 core 的 NS 桩）按同一口径就地兜底，标签
   *  筛选在桩里自然退化为「未启用」。 */
  const tagRouteState = (route) => {
    if (typeof NS.parseTagFilterRoute === 'function') return NS.parseTagFilterRoute(route);
    return {
      names: [],
      untagged: String((route && route.tagUntagged) || '') === '1',
      mode: String((route && route.tagMode) || '') === 'all' ? 'all' : 'any',
    };
  };

  /** 资产详情「标签」section（T010）：已有标签 uiTag + 移除；uiInput + 候选
   *  下拉（<details>+chips）+「添加」；回车提交在 app.js 委托层带 IME 守卫。
   *  空态 = 「未分类」+ 一句引导。提交走整组替换（core.setAssetTags）。 */
  function assetTagsSection(asset) {
    if (!['active', 'paused'].includes(String(asset.status || 'active'))) return '';
    const tags = Array.isArray(asset.tags) ? asset.tags : [];
    const key = (value) => String(value || '').trim().toLocaleLowerCase();
    const existingKeys = new Set(tags.map((entry) => key(entry)));
    const candidates = activeTagsWithAssets()
      .filter((tag) => !existingKeys.has(key(tag.name)))
      .slice(0, 8);
    const chipsHtml = tags.map((name) => `
      <span class="ca-tag-item">
        ${window.uiTag({ label: String(name), variant: 'outline', className: 'ca-tag-chip' })}
        ${btn(T('cognition.tag_remove', '移除'), 'tag-remove', { id: asset.id, data: { name: String(name) }, small: true, className: 'rnm' })}
      </span>`).join('');
    const inputId = `ca-tag-add-${esc(String(asset.id))}`;
    return `
      <div class="sect-block" data-asset-tags>
        <div class="sub"><strong>${esc(T('cognition.tag_section', '标签'))}</strong>${tags.length ? `<span class="note">${String(tags.length)}</span>` : ''}</div>
        ${tags.length
          ? `<div class="chips ca-tags-row">${chipsHtml}</div>`
          : `<p class="note">${esc(T('cognition.tag_empty', '未分类'))} · ${esc(T('cognition.tag_empty_hint', '打标签后可在列表里按主题筛选'))}</p>`}
        <div class="chips ca-tags-row">
          ${window.uiInput({
            id: inputId,
            placeholder: T('cognition.tag_add_placeholder', '新标签，回车或点「添加」'),
            className: 'litxt ca-tag-input',
            attrs: { 'data-tag-input': '1', 'data-asset-id': String(asset.id), maxlength: '20' },
          })}
          ${btn(T('cognition.tag_add', '添加'), 'tag-add', { id: asset.id, small: true })}
          ${candidates.length ? `
            <details class="details ca-tag-candidates">
              <summary>${esc(T('cognition.tag_candidates', '选择已有标签'))}</summary>
              <div class="chips">${candidates.map((tag) => btn(String(tag.name), 'tag-add', { id: asset.id, data: { name: String(tag.name), preset: '1' }, className: 'chip' })).join('')}</div>
            </details>` : ''}
        </div>
      </div>`;
  }

  /** 标签筛选行（T012）：类型 chips 旁的另一根轴；只显示 assetCount>0 的
   *  active + 「未分类」chip（计数按其它筛选生效后算）+ 交/并集切换 +
   *  「更多」弹层 + 「管理标签」入口。空库（无任何可显示 chip）不渲染该行。 */
  function tagFilterBar(route, baseAssets) {
    if (String(route.category || '') === 'deleted') return '';
    const tagState = tagRouteState(route);
    const tags = activeTagsWithAssets();
    const manageTagsButton = btn(T('cognition.tag_manage', '管理标签'), 'tag-manage', { small: true, className: 'o' });
    // 没有可筛选的标签时不渲染过滤控件，但保留标签管理入口。
    if (!tags.length) return `<div class="pillbox ca-tag-filter">${manageTagsButton}</div>`;
    const untaggedCount = baseAssets.filter((asset) => (Array.isArray(asset.tags) ? asset.tags : []).length === 0).length;
    const visible = tags.slice(0, 12);
    const hiddenCount = Math.max(0, tags.length - visible.length);
    const key = (value) => String(value || '').trim().toLocaleLowerCase();
    const chipOf = (name, count) => {
      const on = tagState.names.some((entry) => key(entry) === key(name));
      return btn(`${name} ${count}`, 'filter-tag', { id: name, className: `chip${on ? ' on' : ''}` });
    };
    const countOf = (name) => baseAssets.filter((asset) => (Array.isArray(asset.tags) ? asset.tags : [])
      .some((entry) => key(entry) === key(name))).length;
    const chips = visible
      .filter((tag) => countOf(tag.name) > 0 || tagState.names.some((entry) => key(entry) === key(tag.name)))
      .map((tag) => chipOf(tag.name, countOf(tag.name)));
    const untaggedChip = untaggedCount > 0 || tagState.untagged
      ? btn(`${T('cognition.tag_untagged', '未分类')} ${untaggedCount}`, 'filter-untagged', { className: `chip${tagState.untagged ? ' on' : ''}` })
      : '';
    const modeToggle = window.uiSegmentedControl({
      ariaLabel: T('cognition.tag_filter_label', '标签'),
      value: tagState.mode,
      items: [
        { label: T('cognition.tag_filter_any', '任一标签'), value: 'any', attrs: { 'data-act': 'filter-tag-mode', 'data-mode': 'any' } },
        { label: T('cognition.tag_filter_all', '同时具备'), value: 'all', attrs: { 'data-act': 'filter-tag-mode', 'data-mode': 'all' } },
      ],
    });
    const active = tagState.names.length > 0 || tagState.untagged;
    return `
      <div class="pillbox ca-tag-filter${active ? ' is-on' : ''}">
        <div class="chips">
          ${chips.join('')}
          ${untaggedChip}
          ${hiddenCount ? btn(T('cognition.tag_more', '更多'), 'tag-more', { className: 'chip' }) : ''}
        </div>
        ${modeToggle}
        ${manageTagsButton}
      </div>`;
  }

  /** 「未分类」+「同时具备」= 永远空集：给明确空态说明（T012 Edge）。 */
  const tagFilterContradiction = (route) => {
    const state = tagRouteState(route);
    return state.untagged && state.mode === 'all' && state.names.length > 0;
  };

  /** 多选态批量条（T011）：已选 N / 全选本页 / 清空 + 三选一语义 + 标签输入
   *  + 执行 + 可见进度（uiProgressBar）+ 逐项失败清单（不截断）。 */
  function tagBatchBar(route, pageAssets) {
    const selected = new Set((S.tagSelectIds || []).map(String));
    const op = String(S.tagBatchOp || 'add');
    const batch = S.tagBatch || null;
    const seg = window.uiSegmentedControl({
      ariaLabel: T('cognition.tag_batch_op_aria', '批量操作语义'),
      value: op,
      items: [
        { label: T('cognition.tag_batch_op_add', '打标'), value: 'add', attrs: { 'data-act': 'tag-batch-op', 'data-op': 'add' } },
        { label: T('cognition.tag_batch_op_remove', '去标'), value: 'remove', attrs: { 'data-act': 'tag-batch-op', 'data-op': 'remove' } },
        { label: T('cognition.tag_batch_op_replace', '替换为'), value: 'replace', attrs: { 'data-act': 'tag-batch-op', 'data-op': 'replace' } },
      ],
    });
    const progress = batch
      ? `
        <div class="ca-tag-progress">
          ${window.uiProgressBar({
            ariaLabel: T('cognition.tag_batch_progress', '批量打标中 {done}/{total}', { done: String(batch.done), total: String(batch.total) }),
            value: batch.done,
            max: Math.max(1, batch.total),
          })}
          <span class="note">${esc(T('cognition.tag_batch_progress', '批量打标中 {done}/{total}', { done: String(batch.done), total: String(batch.total) }))}</span>
        </div>
        ${batch.failed && batch.failed.length ? `
          <div class="ca-tag-failures">
            <p class="note"><strong>${esc(T('cognition.tag_batch_failed_title', '有 {n} 条没成功：', { n: String(batch.failed.length) }))}</strong></p>
            ${batch.failed.map((item) => `<p class="note">· ${esc(item.title || item.assetId)}${item.note ? ` — ${esc(item.note)}` : ''}</p>`).join('')}
            <p class="note">${esc(T('cognition.tag_batch_failed_note', '可重跑：已完成的项不会重复改。'))}</p>
            ${btn(T('cognition.tag_batch_dismiss', '收起失败清单'), 'tag-batch-dismiss', { small: true, className: 'rnm' })}
          </div>` : ''}`
      : '';
    return `
      <div class="ca-batch-bar" data-tag-batch-bar>
        <span class="sub">${esc(T('cognition.tag_selected_count', '已选 {n} 条', { n: String(selected.size) }))}</span>
        ${btn(T('cognition.tag_select_all', '全选本页'), 'tag-select-all', { small: true, className: 'rnm' })}
        ${btn(T('cognition.tag_select_clear', '清空'), 'tag-select-clear', { small: true, className: 'rnm' })}
        ${btn(T('cognition.tag_select_exit', '退出多选'), 'tag-select-mode', { small: true, className: 'rnm' })}
        <span class="sp"></span>
        ${seg}
        ${window.uiInput({
          id: 'ca-tag-batch-input',
          placeholder: T('cognition.tag_batch_tags_label', '标签（多个用顿号分隔）'),
          className: 'litxt ca-tag-input',
          attrs: { 'data-tag-batch-input': '1' },
        })}
        ${btn(T('cognition.tag_batch_run', '执行'), 'tag-batch-run', { small: true, primary: true, disabled: Boolean(batch && batch.running) })}
        ${progress}
      </div>`;
  }

  /** 管理弹层 / 「更多」弹层（T013/T012「更多」）：markup 落进持久壳槽位
   *  （#ca-tag-overlay-slot，render() 维护），由 core.wireTagOverlay 过
   *  uiModalController。不新建页面。 */
  function tagOverlayHtml(route) {
    const mode = String(route.tagOverlay || '');
    if (mode !== 'more' && mode !== 'manage') return '';
    const allItems = (S.tags && Array.isArray(S.tags.items)) ? S.tags.items : [];
    const active = allItems.filter((tag) => String(tag.state || 'active') === 'active');
    const retired = allItems.filter((tag) => String(tag.state || '') === 'merged' || String(tag.state || '') === 'archived');
    const busy = Boolean(S.tagBatch && S.tagBatch.running);
    if (mode === 'more') {
      const state = tagRouteState(route);
      const key = (value) => String(value || '').trim().toLocaleLowerCase();
      const rows = active.filter((tag) => Number(tag.assetCount || 0) > 0).map((tag) => btn(
        `${tag.name} ${tag.assetCount}`,
        'filter-tag',
        { id: String(tag.name), className: `chip${state.names.some((entry) => key(entry) === key(tag.name)) ? ' on' : ''}` },
      )).join('');
      return `
        <div class="ui-modal-overlay" data-tag-overlay="more" hidden>
          <section class="ui-modal ui-modal--sm" role="dialog" aria-modal="true" aria-labelledby="ca-tag-more-title">
            <header class="ui-modal__header"><h2 class="ui-modal__title" id="ca-tag-more-title">${esc(T('cognition.tag_more_title', '全部标签'))}</h2></header>
            <div class="ui-modal__body"><div class="chips">${rows || `<p class="note">${esc(T('cognition.tag_manage_empty', '还没有标签——先在资产上打一个。'))}</p>`}</div></div>
          </section>
        </div>`;
    }
    // manage：三动作 + 同义建议（只建议）+ 已停用/已合并折叠区 + 批量进度。
    const suggestions = Array.isArray(S.tagSuggestions) ? S.tagSuggestions : [];
    const editId = String(S.tagManageEdit || '');
    const mergeState = S.tagManageMerge || null;
    const rowOf = (tag) => {
      if (String(tag.id) === editId) {
        return `
          <div class="row is-flat">
            <div class="tw"><div class="tt">${esc(tag.name)}</div>
              ${window.uiInput({ id: `ca-tag-rename-${esc(tag.id)}`, value: String(tag.name), className: 'litxt', attrs: { 'data-tag-rename-input': '1', maxlength: '20' } })}</div>
            <div class="sd">${btn(T('common.save', '保存'), 'tag-rename-save', { id: tag.id, small: true, primary: true })}${btn(T('common.cancel', '取消'), 'tag-rename-cancel', { small: true, className: 'rnm' })}</div>
          </div>`;
      }
      if (mergeState && String(mergeState.sourceId) === String(tag.id)) {
        const key = (value) => String(value || '').trim().toLocaleLowerCase();
        const targets = active.filter((other) => other.id !== tag.id).slice(0, 12);
        const targetSet = mergeState.targetName
          ? `<p class="note">${esc(T('cognition.tag_merge_target_set', '并入「{name}」', { name: mergeState.targetName }))}</p>`
          : `<p class="note">${esc(T('cognition.tag_merge_need_target', '先选择要并入的目标标签'))}</p>`;
        return `
          <div class="row is-flat">
            <div class="tw"><div class="tt">${esc(tag.name)} → ?</div>
              <p class="note">${esc(T('cognition.tag_merge_pick_target', '选择要并入的目标标签：'))}</p>
              <div class="chips">${targets.map((other) => btn(String(other.name), 'tag-merge-target', { id: tag.id, data: { name: String(other.name) }, className: `chip${mergeState.targetName && key(mergeState.targetName) === key(other.name) ? ' on' : ''}` })).join('')}</div>
              ${targetSet}</div>
            <div class="sd">${btn(T('cognition.tag_merge_confirm', '确认合并'), 'tag-merge-confirm', { id: tag.id, small: true, primary: true, disabled: busy })}${btn(T('common.cancel', '取消'), 'tag-merge-cancel', { small: true, className: 'rnm' })}</div>
          </div>`;
      }
      return `
        <div class="row is-flat">
          <div class="tw"><div class="tt">${esc(tag.name)}</div>
            <div class="mm">${esc(T('cognition.tag_asset_count', '{n} 条资产', { n: String(Number(tag.assetCount || 0)) }))}</div></div>
          <div class="sd">
            ${btn(T('cognition.tag_rename', '重命名'), 'tag-rename', { id: tag.id, small: true, className: 'rnm' })}
            ${btn(T('cognition.tag_merge', '合并'), 'tag-merge', { id: tag.id, small: true, className: 'rnm' })}
            ${btn(T('cognition.tag_delete', '停用'), 'tag-delete', { id: tag.id, small: true, danger: true })}
          </div>
        </div>`;
    };
    const suggestionHtml = suggestions.length ? `
      <div class="sect-block">
        <div class="sub"><strong>${esc(T('cognition.tag_suggestions', '可能重复的标签'))}</strong><span class="note">${esc(T('cognition.tag_suggestions_hint', '只是建议，不会自动合并'))}</span></div>
        ${suggestions.map((item) => `
          <div class="row is-flat">
            <div class="tw"><div class="tt">${esc(item.sourceName)} → ${esc(item.targetName)}</div>
              <div class="mm">${esc(item.reason === 'alias'
                ? T('cognition.tag_suggestion_reason_alias', '别名命中')
                : T('cognition.tag_suggestion_reason_similar', '名字相似'))}</div></div>
            <div class="sd">${btn(T('cognition.tag_suggestion_merge', '合并这组'), 'tag-suggestion-merge', { id: String(item.sourceName), data: { target: String(item.targetName) }, small: true })}</div>
          </div>`).join('')}
      </div>` : '';
    const retiredHtml = retired.length ? `
      <details class="details">
        <summary>${esc(T('cognition.tag_retired_section', '已停用 / 已合并的标签'))}</summary>
        <div class="dbody">
          ${retired.map((tag) => `
            <div class="row is-flat">
              <div class="tw"><div class="tt">${esc(tag.name)}</div>
                <div class="mm">${esc(String(tag.state) === 'merged'
                  ? T('cognition.tag_retired_state_merged', '已合并')
                  : T('cognition.tag_retired_state_archived', '已停用'))}${(tag.formerNames || []).length ? ` · ${esc(T('cognition.tag_retired_former', '曾用名：{names}', { names: tag.formerNames.join('、') }))}` : ''}${(tag.aliases || []).length ? ` · ${esc(T('cognition.tag_retired_aliases', '别名：{names}', { names: tag.aliases.join('、') }))}` : ''}</div></div>
            </div>`).join('')}
        </div>
      </details>` : '';
    const progress = S.tagBatch ? `
      <div class="ca-tag-progress">
        ${window.uiProgressBar({
          ariaLabel: T('cognition.tag_batch_progress', '批量打标中 {done}/{total}', { done: String(S.tagBatch.done), total: String(S.tagBatch.total) }),
          value: S.tagBatch.done,
          max: Math.max(1, S.tagBatch.total),
        })}
        <span class="note">${esc(T('cognition.tag_batch_progress', '批量打标中 {done}/{total}', { done: String(S.tagBatch.done), total: String(S.tagBatch.total) }))}</span>
      </div>` : '';
    return `
      <div class="ui-modal-overlay" data-tag-overlay="manage" hidden>
        <section class="ui-modal ui-modal--lg" role="dialog" aria-modal="true" aria-labelledby="ca-tag-manage-title">
          <header class="ui-modal__header"><h2 class="ui-modal__title" id="ca-tag-manage-title">${esc(T('cognition.tag_manage_title', '管理标签'))}</h2></header>
          <div class="ui-modal__body">
            ${active.length ? active.map(rowOf).join('') : `<p class="note">${esc(T('cognition.tag_manage_empty', '还没有标签——先在资产上打一个。'))}</p>`}
            ${suggestionHtml}
            ${retiredHtml}
            ${progress}
          </div>
          <footer class="ui-modal__footer">${btn(T('common.close', '关闭'), 'tag-overlay-close', {})}</footer>
        </section>
      </div>`;
  }

  /** 「记一条」表单（设计 7.2，2026-09-28）：手动新建候选。复用候选确认表单
   *  的五字段形态（类型/标题/可复用内容/价值/高级选项），容器沿用
   *  `.ca-candidate-detail` + `data-cand-type`——`cand-type` 就地切类型、
   *  readCandidateForm 就近读 [data-f] 值，与候选详情同一交互契约（切换类型
   *  不重画，输入不丢）。保存走 recall.candidates.save 产生**候选**，进
   *  「待我处理」确认后才入库——不破坏"确认后才入库"一致性。 */
  function manualCandidateForm() {
    const defaultType = 'personal';
    const field = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
    return `<div class="card ca-candidate-detail ca-manual-candidate" data-cand-type="${esc(defaultType)}" data-manual-candidate>
      <div class="tt">${esc(T('cognition.cand_create_entry', '记一条'))}</div>
      <p class="note">${esc(T('cognition.cand_create_hint', '自己写一条认知。保存后先进「待我处理」，确认后才会入库。'))}</p>
      ${field(T('cognition.type', '类型'), `<div class="chips">${CATEGORIES.map(([id, key, fb]) => { const on = id === defaultType; return `<span class="ca-chip ca-chip-opt${on ? ' is-green' : ''}" data-act="cand-type" data-id="${esc(id)}" ${roleBtn(`aria-pressed="${on ? 'true' : 'false'}"`)}>${esc(T(key, fb))}</span>`; }).join('')}</div>`)}
      ${field(T('cognition.capture.name', '认知名称'), window.uiInput({ id: 'ca-manual-summary', value: '', attrs: { maxlength: 60, 'data-f': 'summary', placeholder: T('cognition.cand_create_title_placeholder', '一句话标题，建议 16 字以内') } }))}
      ${field(T('cognition.capture.summary', '可复用内容'), window.uiTextarea({ id: 'ca-manual-judgment', value: '', attrs: { 'data-f': 'judgment' } }))}
      ${field(T('cognition.chain_value_label', '带来的价值'), window.uiTextarea({ id: 'ca-manual-value', value: '', attrs: { 'data-f': 'value' } }))}
      <details class="details">
        <summary>${esc(T('cognition.candidate_advanced', '高级选项（通常不用改）'))}</summary>
        ${field(T('cognition.candidate_scope_domain', '适用任务范围'), window.uiInput({ id: 'ca-manual-scope', value: '', placeholder: T('cognition.candidate_scope_placeholder', '例如：仅产品工作空间'), attrs: { 'data-f': 'scope' } }))}
        <div class="note">${esc(T('cognition.candidate_scope_hint', '常用范围：跨对话通用（general）、报告（report）、编程（code）、审查（review）、产品（product）。其他写法可能匹配不上任务，建议从这里选一个。'))}</div>
        ${field(T('cognition.chain_uncertainty_label', '仍不确定的地方'), window.uiTextarea({ id: 'ca-manual-uncertainty', value: '', attrs: { 'data-f': 'uncertainty' } }))}
      </details>
      <div class="actions actions-right">
        ${btn(T('common.cancel', '取消'), 'cand-create-cancel', { small: true })}
        ${btn(T('cognition.cand_create_save', '存为候选'), 'cand-create-save', { small: true, primary: true })}
      </div>
    </div>`;
  }

  function viewOverview(route) {
    const stats = NS.stats();
    // 两线不拆列表（2026-09-17 二次定调；2026-09-26 specs/017 整改一收窄）：
    // 全量列表+每条 KSTAR 资产打徽章（子安口径：出身标记直接带 KSTAR 字样）。
    // KSTAR 独立筛选档已退役——原位置改放「经验」分类档；已删除档保留全部
    //（保留期恢复入口只有这一处）。
    const counts = {};
    for (const [id] of CATEGORIES) counts[id] = S.assets.filter((a) => a.type === id && !['archived', 'deleted', 'purged', 'revoked'].includes(String(a.status || 'active'))).length;
    // 每个资产的最近使用时间（时间线里 occurredAt 的最大值）：列表行此前
    // 硬编码「最近无使用记录」，被真实复用过的资产也这么显示（终审修）。
    // 每个资产的最近使用时间（**只算「真实使用」**）：白名单由主进程单一定义、
    // 随载荷下发（2026-09-25 US-602 FR-004），列表与详情共用同一份。
    // 修复前这里对全部事件取 occurredAt 最大值——创建、保存版本、治理操作都会
    // 把「最近使用」刷新成今天，与详情侧口径打架（缺陷本体）。
    const realKinds = new Set(Array.isArray(S.realUsageKinds) ? S.realUsageKinds : []);
    const lastUseByAsset = new Map();
    for (const proof of S.proofs) {
      if (!realKinds.has(String(proof.kind || ''))) continue;
      const assetId = String((proof.refs || {}).assetId || '');
      const at = String(proof.occurredAt || '');
      if (!assetId || !at) continue;
      const current = lastUseByAsset.get(assetId);
      if (!current || at > current) lastUseByAsset.set(assetId, at);
    }
    const lastUseText = (assetId) => {
      const at = lastUseByAsset.get(String(assetId));
      return at
        ? T('cognition.asset_last_used_at', '最近一次 {when}', { when: fmtDate(at) })
        : T('cognition.asset_last_use', '还没被任务用过');
    };
    /* 导语（specs/018 T030）：hero 统计条并入导语两个可点数字——
     * {n} 条认知（点开滚到列表）· {m} 条等你确认（去「待我处理」）。
     * n 与默认列表同口径（排除已删除/归档等隐藏态——stats.confirmed 口径
     * 更宽，真机上出现过 18 vs 16 的两个数字打架）。
     * 0 值分段不出现（迭代轮 2 猎区 1：空库时「0 条认知 · 0 条等你确认」
     * 与下方空态重复且无信息量，导语让位给空态的引导文案）。
     * 「当前任务选用」卡仍撤（2026-09-21 口径不变）。 */
    const visibleAssetCount = S.assets.filter((a) => !['archived', 'deleted', 'purged', 'revoked'].includes(String(a.status || 'active'))).length;
    const leadNum = (value, anchor) => `<span class="chip-link ca-jump-num" data-act="review-jump" data-id="${esc(anchor)}" aria-label="${esc(T('cognition.review_lead_jump_aria', '跳到「{where}」', { where: anchor === 'ca-review-decide' ? T('cognition.review_queue_decide', '要你拍板') : anchor === 'ca-review-evidence' ? T('cognition.review_lead_evidence', '条证据要补') : T('cognition.overview_list_title', '资产明细') }))}" ${roleBtn()}>${esc(String(value))}</span>`;
    const assetsPart = visibleAssetCount
      ? `${leadNum(visibleAssetCount, 'ca-asset-list')} ${esc(T('cognition.overview_lead_assets', '条认知'))}`
      : '';
    const pendingPart = stats.pending
      ? `<span class="chip-link ca-jump-num" data-act="go-review" aria-label="${esc(T('cognition.overview_lead_pending_aria', '去「待我处理」看 {n} 条', { n: String(stats.pending) }))}" ${roleBtn()}>${esc(String(stats.pending))}</span> ${esc(T('cognition.overview_lead_pending', '条等你确认'))}`
      : '';
    const heroLead = [assetsPart, pendingPart].filter(Boolean).length
      ? `<div class="sub">${[assetsPart, pendingPart].join(' · ')}</div>`
      : '';
    const heroHtml = hero(
      T('cognition.overview_title', '我的认知资产'),
      '',
      heroLead,
    );
    if (route.assetId) {
      const asset = S.assets.find((a) => String(a.id) === String(route.assetId));
      // 详情视图不显示统计条：那是列表页的上下文，详情页只讲这一条资产
      //（使用记录已并入详情，2026-09-15）。
      if (asset) return assetDetail(asset, route);
    }
    // 列表口径（2026-09-17 报告建议 G，顺带修 bug）：默认视图只放正常态
    // （archived/deleted/purged/revoked 都不混进来——此前只排除 archived，
    // 已删除资产会漏进「全部」）；「已删除」单列一档，保留期内可自助恢复。
    // purged/revoked 不单列（墓碑无内容/终态）。
    const HIDDEN_STATUS = ['archived', 'deleted', 'purged', 'revoked'];
    const deletedCount = S.assets.filter((a) => String(a.status || 'active') === 'deleted').length;
    // 经验档（specs/017 整改一）：经验不再单独成页签、KSTAR 不再单独成档——
    // pillbox 在原 KSTAR 位置给一个「经验」分类档（计数=非终态经验条目），
    // 档内渲染经验目录（SC-001 隔离照旧：只读 S.experiences，零资产混入）。
    const experienceItems = (((S.experiences && S.experiences.items) || []))
      .filter((item) => ['active', 'paused'].includes(String(item.status || 'active')));
    const filteredByType = route.category === 'deleted'
      ? S.assets.filter((a) => String(a.status || 'active') === 'deleted')
      : S.assets.filter((a) => !HIDDEN_STATUS.includes(String(a.status || 'active'))
        && (!route.category || a.type === route.category));
    // 标签筛选（specs/012 T012）：与类型筛选 AND 叠加、各自独立可清空；
    // Array.filter 保序——筛完仍按主进程给的顺序，渲染层不重排。
    const tagFilterState = tagRouteState(route);
    const tagFilterActive = Boolean(tagFilterState.names.length || tagFilterState.untagged)
      && typeof NS.matchesTagFilter === 'function';
    const filtered = tagFilterActive && route.category !== 'deleted'
      ? filteredByType.filter((a) => NS.matchesTagFilter(a, tagFilterState.names, tagFilterState.untagged, tagFilterState.mode))
      : filteredByType;
    // 「未分类」+「同时具备」恒为空集：明确说，不给一屏空白。
    const tagContradiction = route.category !== 'deleted' && tagFilterContradiction(route);
    const chips = [['', T('common.all', '全部'), S.assets.filter((a) => !HIDDEN_STATUS.includes(String(a.status || 'active'))).length]]
      .concat(CATEGORIES.map(([id, key, fallback]) => [id, T(key, fallback), counts[id]]))
      .concat([['experiences', T('cognition.assets_experiences_tab', '经验'), experienceItems.length]])
      .concat(deletedCount ? [['deleted', T('cognition.assets_deleted_tab', '已删除'), deletedCount]] : []);
    const pillboxHtml = `<div class="pillbox">${chips.map(([id, label, count]) => btn(`${label} ${count}`, 'filter-cat', { id, className: `chip${String(route.category || '') === id ? ' on' : ''}` })).join('')}</div>`;
    // 经验详情深链（experienceId）：仍归「我的认知」页；返回落点由 app.js
    // go-back 归到经验档（category='experiences'）。
    if (route.experienceId) return viewExperienceDetail(route);
    // 「经验」档：页头 + 分类档条 + 经验目录 + 存量迁移区。资产专属工具
    //（批量打标/目录视图/标签筛选/KSTAR 复盘折叠区）不进这个档（整改一第 3 条）。
    if (route.category === 'experiences') {
      return `${heroHtml}
        ${sectionHead(T('cognition.experience_title', '经验目录'), String(experienceItems.length))}
        ${pillboxHtml}
        <div class="note list-caption">${esc(T('cognition.experience_subtitle', '任务收口后沉淀的经验：哪类任务怎么做成了、栽在哪。经验与正式资产分开管理，互不混入。'))}</div>
        ${experienceDirectoryHtml()}
        ${experienceMigrationSection()}`;
    }
    /** 目录视图行（2026-09-18）：把"模型看到的那份目录"原样搬到面板上——
     *  标题 + 一句话 + 类型/范围/版本/用没用过。模型看目录挑资产、用户看同一份
     *  目录核对它的判断，两边看到的是同一件事。
     *  一句话的口径＝主进程 asset-catalog.ts 的 catalogOneLine（首句、22 字、砍
     *  尾部连接符）——2026-09-28 起镜像同一实现，防两边各写一份慢慢分叉。 */
    const catalogOneLineOf = (asset) => {
      const text = String(asset.statement || '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const first = (text.split(/[。！？!?]/)[0] || text).trim();
      const cut = first.length > 22 ? first.slice(0, 22) : first;
      return cut.replace(/[，、；：,;:\-—\s]+$/, '');
    };
    const catalogRow = (asset) => {
      const oneLine = catalogOneLineOf(asset);
      const used = broughtInCountFor(asset.id);
      const meta = [
        categoryLabel(asset.type),
        scopeLabelText(asset.scope),
        `v${String(asset.activeVersion || asset.version || '1')}`,
        // 目录行与列表/详情同口径（2026-09-25 US-602；2026-09-28 词表统一）：
        // 只算「被任务用过」（原「被带入任务」），不把宿主注入说成采用。
        used ? T('cognition.catalog_used_times', '被任务用过 {n} 次', { n: String(used) }) : T('cognition.catalog_never_used', '还没被任务用过'),
      ].join(' · ');
      return `<div class="row" data-go-asset="${esc(asset.id)}" role="button" tabindex="0">
        <div class="tw">
          <div class="tt">${esc(asset.title || asset.id)}</div>
          ${oneLine ? `<div class="catline">${esc(oneLine)}</div>` : ''}
          <div class="mm">${esc(meta)}</div>
        </div>
        <div class="sd">${(S.modelSelectedAssetIds || []).includes(String(asset.id)) ? chip(T('cognition.catalog_model_attached', '模型挂着'), 'blue') : ''}${assetStatusChip(asset)}<span class="chev" aria-hidden="true">›</span></div>
      </div>`;
    };
    const catalogView = String(route.assetView || '') === 'catalog';
    /* 「管理」模式（specs/018 T031）：目录视图 / 批量打标 / 多选 / 同源分组
     * 默认不可见，收进这个小切换；普通用户默认视图永远只见列表。
     * 深链兜底：assetView=catalog 视同进入管理（旧深链不死链）。 */
    const manageMode = String(route.manage || '') === '1' || catalogView;
    // 多选态（specs/012 T011）：仅列表视图（目录/已删除档不给批量打标）；
    // 行左侧 uiCheckbox、行点击变成勾选（不再挂 data-go-asset 跳详情）。
    const tagSelectOn = String(route.tagSelect || '') === '1' && !catalogView && route.category !== 'deleted';
    const tagSelectedIds = new Set((S.tagSelectIds || []).map(String));
    const plainRow = (asset) => {
      // 行三事实（specs/018 T032）：类型 / 最近一次（或「还没被任务用过」）/
      // 被任务用过 N 次。版本号收进详情（行上不再是第四件事）。
      const used = broughtInCountFor(asset.id);
      if (!tagSelectOn) return `
        <div class="row" data-go-asset="${esc(asset.id)}" role="button" tabindex="0">
          <div class="tw">
            <div class="tt">${esc(asset.title || asset.id)}</div>
            <div class="mm">${esc([
              categoryLabel(asset.type),
              lastUseText(asset.id),
              used ? T('cognition.catalog_used_times', '被任务用过 {n} 次', { n: String(used) }) : T('cognition.catalog_never_used', '还没被任务用过'),
            ].join(' · '))}</div>
          </div>
          <div class="sd">${NS.isKstarAsset(asset) ? chip(T('cognition.asset_kstar_badge', 'KSTAR'), 'blue') : ''}${assetStatusChip(asset)}<span class="chev" aria-hidden="true">›</span></div>
        </div>`;
      const tags = Array.isArray(asset.tags) ? asset.tags : [];
      return `
        <div class="row">
          <div class="tw">
            <div class="tt">${window.uiCheckbox({
              id: `ca-tag-sel-${esc(String(asset.id))}`,
              label: String(asset.title || asset.id),
              checked: tagSelectedIds.has(String(asset.id)),
              attrs: { 'data-act': 'tag-select-toggle', 'data-id': String(asset.id) },
            })}<span>${esc(asset.title || asset.id)}</span></div>
            <div class="mm">${esc(categoryLabel(asset.type))} · v${esc(String(asset.activeVersion || asset.version || '1'))}${tags.length ? ` · ${esc(tags.join('、'))}` : ` · ${esc(T('cognition.tag_untagged', '未分类'))}`}</div>
          </div>
          <div class="sd">${NS.isKstarAsset(asset) ? chip(T('cognition.asset_kstar_badge', 'KSTAR'), 'blue') : ''}${assetStatusChip(asset)}</div>
        </div>`;
    };
    // 「已删除」行（specs/008 US-306/T051）：保留期剩余天数由服务端现算
    // （recall.assets.deleted.list），并给出**唯一**的「立即彻底删除」入口。
    // 注意：行上不能挂 data-go-asset——委托层先判 data-go-asset 再判 data-act，
    // 嵌在里面的按钮会被行跳转吃掉。所以点击区只在标题上。
    const deletedState = S.deletedAssets || null;
    const deletedById = new Map(((deletedState && deletedState.items) || []).map((item) => [String(item.id), item]));
    const deletedRow = (asset) => {
      const info = deletedById.get(String(asset.id)) || null;
      const retention = !info
        ? ''
        : info.retentionUnknown
          ? T('cognition.deleted_retention_unknown', '删除时间不可用：既不能恢复，也不会自动到期，请联系支持')
          : T('cognition.deleted_retention_left', '保留期还剩 {n} 天', { n: String(info.retentionDaysLeft ?? 0) });
      return `<div class="row">
        <div class="tw">
          <div class="tt"><a href="#" data-go-asset="${esc(String(asset.id))}">${esc(asset.title || asset.id)}</a></div>
          <div class="mm">${esc(categoryLabel(asset.type))} · v${esc(String(asset.activeVersion || asset.version || '1'))}${retention ? ` · ${esc(retention)}` : ''}</div>
        </div>
        <div class="sd">${assetStatusChip(asset)}${btn(T('cognition.deleted_purge_now', '立即彻底删除'), 'purge-deleted-asset', { small: true, danger: true, data: { id: String(asset.id) } })}</div>
      </div>`;
    };
    /* 默认排序（specs/018 T032）：按最近真实使用排（口径＝US-602 白名单，
     * 不是推荐分——「列表不按推荐分排序」的钉死口径不变）；没用过的排后面。
     * 管理模式保持主进程顺序 + 同源血缘分组（管理视角，默认不可见）。 */
    const lastUseAt = (asset) => String(lastUseByAsset.get(String(asset.id)) || '');
    const orderedAssets = manageMode ? filtered
      : [...filtered].sort((a, b) => lastUseAt(b).localeCompare(lastUseAt(a)));
    /* 空态引导（specs/018 T033）＋「记一条」（设计 7.2，2026-09-28）：空库
     * 也能手动写第一条——空态在「去待我处理」之外并排给「记一条」入口。 */
    const emptyState = `<div class="actions" style="margin-bottom:8px">
        ${btn(T('cognition.cand_create_entry', '记一条'), 'cand-create', { small: true, primary: true })}
      </div>${empty(
      T('cognition.tree_empty', '还没有正式资产'),
      T('cognition.tree_empty_hint', '你在「待我处理」点过「确认」的事，会出现在这里。'),
      // 空态引导（specs/018 T033）：下一步去哪写死——去待我处理。
      { label: T('cognition.overview_empty_go_review', '去待我处理'), attrs: { 'data-act': 'go-review' } },
    )}`;
    let listHtml = orderedAssets.length
      ? orderedAssets.map((asset) => (route.category === 'deleted'
        ? deletedRow(asset)
        : catalogView ? catalogRow(asset) : plainRow(asset))).join('')
      : route.category === 'deleted'
        ? empty(
          T('cognition.deleted_empty', '没有已删除的资产'),
          T('cognition.deleted_empty_hint', '删除的资产会在这里保留 30 天：期内可恢复，也可以在这里立即彻底删除。'),
        )
      : tagContradiction
        // 「未分类」∩「同时具备」恒空集（T012 Edge）：明确说清原因与出路，
        // 不给一屏无解释的空白。
        ? `<div class="note list-caption">${esc(T('cognition.tag_filter_empty_all', '「未分类」和「同时具备」一起选时，没有资产能两边都满足。切回「任一标签」，或取消「未分类」。'))}</div>`
        : emptyState;
    // 同源血缘分组只在「管理」模式出现（specs/018 T031）；目录视图=模型视角
    // 保持平铺。「已删除」列表**不分组**：那里要的是保留期剩余天数与彻底
    // 删除入口，按族分组只会把"还剩几天"埋进分组标题下面。
    if (orderedAssets.length && manageMode && !catalogView && route.category !== 'deleted') {
      const groups = familyGroupsOf(orderedAssets);
      listHtml = groups.map((group) => `
        <div class="fam-hd">
          <span class="nm">${group.title
            ? `${esc(group.title)} <span class="n">${esc(T('cognition.family_group_count', '{n} 条同源', { n: String(group.assets.length) }))}</span>`
            : `<span class="n">${esc(T('cognition.family_unsorted', '无同源血缘'))}</span>`}</span>
          <span class="sp"></span>
        </div>
        ${group.assets.map((asset) => plainRow(asset)).join('')}
      `).join('');
    }
    /* 工具入口（specs/018 T031）＋「记一条」（设计 7.2）：默认「记一条」+
     * 「树视图」+「管理」小切换；管理模式下才出现 批量打标 / 目录视图
     * （多选条随 tagSelect 出）。「已删除」档不给「记一条」（保留期语义优先）。 */
    const toolButtons = `${route.category !== 'deleted' && !catalogView ? btn(T('cognition.cand_create_entry', '记一条'), 'cand-create', { small: true, primary: true }) : ''}${route.category !== 'deleted' ? btn(T('cognition.tree_view_toggle', '树视图'), 'asset-view', { id: 'tree', small: true, className: 'o' }) : ''}${manageMode
      ? `${route.category !== 'deleted' ? btn(T('cognition.tag_batch_entry', '批量打标'), 'tag-select-mode', { small: true, className: 'o' }) : ''}${btn(catalogView ? T('cognition.catalog_view_back', '列表视图') : T('cognition.catalog_view_toggle', '目录视图'), 'asset-view', { id: catalogView ? '' : 'catalog', small: true, className: 'o' })}${btn(T('cognition.overview_manage_exit', '退出管理'), 'overview-manage-toggle', { small: true, className: 'o' })}`
      : btn(T('cognition.overview_manage_entry', '管理'), 'overview-manage-toggle', { small: true, className: 'o' })}`;
    return `${heroHtml}
      <div id="ca-asset-list">
      ${sectionHead(
        catalogView ? T('cognition.catalog_view_title', '资产目录（模型视角）') : T('cognition.overview_list_title', '资产明细'),
        String(filtered.length),
        toolButtons,
      )}
      ${catalogView ? `<div class="note list-caption">${esc(T('cognition.catalog_view_hint', '这就是模型挑资产时看的那份目录：一行一条；要看全文点进去。'))}</div>` : ''}
      ${!catalogView && route.category !== 'deleted' && !manageMode ? `<div class="note list-caption">${esc(T('cognition.overview_sort_note', '按最近使用排在前；类型 / 最近一次 / 被任务用过次数写在每行上。'))}</div>` : ''}
      ${route.candCreate === '1' && route.category !== 'deleted' && !catalogView ? manualCandidateForm() : ''}
      ${pillboxHtml}
      ${tagFilterBar(route, filteredByType)}
      ${tagSelectOn ? tagBatchBar(route, filtered) : ''}
      ${listHtml}
      </div>
      ${kstarEpisodesSection(route)}`;
  }

  /* ────────────────────────── 视图：经验目录（specs/016 US-801/803）─────────────────────────
   * 经验与资产完全隔离（SC-001）：本区只消费 recall.experiences.* 通道的数据
   * （store.experiences / store.experienceDetail），资产列表零混入；反过来
   * 资产页也不读这里的数据。结构全部复用既有形态（card/row/meta-row/chips/
   * details 折叠），不新增 page-local 结构（structural registry 免登记）。 */

  /** 来源任务 chip（唯一出口）：回看复用既有 open-kstar-episode 深链，不新建
   *  跳转机制。goal 用 E1/E2 载荷里主进程截好的任务目标，展示侧再压 24 字
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

  /** 合并目标区（US-803 AC1）：复用既有列表行形态，只列**同类型**且非终态的
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

  /** 详情视图（E2 载荷）：正文 + 预期/实际 + 适用/禁用范围 + 证据引用 +
   *  合并来源 + 台账 + 四个管理动作（T029）。 */
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
    // 改进幅度与置信度这两个内部度量字段不上屏——specs/015 对 views.js 有
    // 「内部字段整个文件一次都不提」的源码级墓碑，R5 键表也刻意未列它们。
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
    /* ②内容 · 预期/实际（来自复盘 review，可缺）：归宿②（五区对照表）——
     * 与正文同属内容区，长值走既有折叠，不新造控件。 */
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
          // 适用/禁用范围：缺失 = 没记录过（不是"无限制"，data-model §1）——
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
            // 管理动作（T029）：终态（已归档/已并入）无管理出口，只说明现状。
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

  /** 存量迁移区（US-801 AC2）：页签底部折叠区。预览（只读扫描）→ 逐条核对
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
        body += previewItems.map((item) => `<div class="row is-flat">
          <div class="tw">
            <div class="tt">${esc(item.title || '')}</div>
            <div class="mm">${esc([
              categoryLabel(item.assetType),
              NS.experience.typeLabel(item.experienceTypeGuess),
              item.frozenProjections ? T('cognition.experience_migration_frozen_refs', '将冻结 {n} 处历史引用', { n: String(item.frozenProjections) }) : '',
            ].filter(Boolean).join(' · '))}</div>
          </div>
          <div class="sd">${btn(T('cognition.experience_migration_run_one', '迁这一条'), 'experience-migration-run', { data: { asset: String(item.assetId || '') }, small: true })}</div>
        </div>`).join('');
        body += `<div class="actions">${btn(T('cognition.experience_migration_run_all', '迁移以上 {n} 条', { n: String(previewItems.length) }), 'experience-migration-run', { data: { assets: previewItems.map((item) => String(item.assetId || '')).filter(Boolean).join(',') }, primary: true, small: true })}</div>`;
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

  /** 经验目录本体（specs/017 整改一：由独立页签改嵌「我的认知」经验档）：
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

  /* ───────────────── KSTAR 复盘历史区块（2026-09-17 二次定调） ─────────────────
   * 两线不拆 tab：KSTAR 任务复盘作为「我的认知」页底部折叠区（默认收起），
   * 每场被复盘的任务一行，点行就地展开完整复盘（复用 kstarEpisodeSection）。 */
  function kstarEpisodesSection(route) {
    const episodes = Array.isArray(S.kstarEpisodes) ? S.kstarEpisodes : [];
    const openId = String(route.kstarEpisodeId || '');
    const rows = (episodes || []).map((ep) => {
      // goal 兼容两种形态：kstar.episodes.list 返回平铺 goal 字段（精简
      // 摘要）；完整 episode 记录里在 t.userGoal——此前只读后者，列表
      // 全显示"（未记录目标）"（2026-09-17 子安实测抓出）。
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

  /* ────────── 改进分析（只读分区，specs/015 US-701 AC3 / T016）──────────────
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
    // 收敛语义（data-model §2 的「实现期最简」）：同一 episode 已经产出候选时，
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

  function migrationCheckboxAriaLabel(label, text, contentHash) {
    const excerpt = String(text || '').replace(/\s+/g, ' ').trim();
    const summary = excerpt.length > 120 ? `${excerpt.slice(0, 120).trimEnd()}…` : excerpt;
    const shortHash = String(contentHash || '').slice(0, 8);
    return [label, summary, shortHash].filter(Boolean).join('：');
  }

  /** 旧记忆核对是一次性兼容入口（2026-09-28 两页重整自「待我处理」页尾挪入
   *  设置页，与「大扫除」「巡检」同层工具卡）；默认折叠，不盖过日常事项。 */
  function legacyMemoryMigrationSection() {
    const state = S.legacyMemoryMigration;
    const preview = state && state.preview;
    const items = preview && Array.isArray(preview.items) ? preview.items : [];
    const selected = new Set(state && state.selectionKeys || []);
    const userSource = preview && preview.sources && preview.sources.user || {};
    const sharedSource = preview && preview.sources && preview.sources.shared || {};
    const selectedCount = items
      .filter((item) => selected.has(`${item.scope}:${item.contentHash}`))
      .reduce((total, item) => total + Math.max(1, Number(item.occurrences) || 1), 0);
    const retainedTemplates = Number(userSource.retainedTemplateRecords || 0) + Number(sharedSource.retainedTemplateRecords || 0);
    const retainedAssets = Number(userSource.retainedAssetRecords || 0) + Number(sharedSource.retainedAssetRecords || 0);
    const retainedNonIndependent = Number(userSource.retainedNonIndependentRecords || 0) + Number(sharedSource.retainedNonIndependentRecords || 0);
    const sourceLabel = (scope) => T(scope === 'user' ? 'memory.legacy_migration_user_source' : 'memory.legacy_migration_shared_source', scope === 'user' ? '个人记忆 · USER.md' : '共享记忆 · MEMORY.md');
    const sourceWarning = (scope, source) => {
      if (!['blocked', 'unavailable'].includes(String(source.status || ''))) return '';
      const key = source.status === 'blocked'
        ? 'memory.legacy_migration_source_blocked'
        : 'memory.legacy_migration_source_unavailable';
      const fallback = source.status === 'blocked'
        ? '{source} 的来源标记损坏或内容与记录不符。为避免误迁移，整份文件暂不处理，原文保留。'
        : '目前读不了 {source}。没有执行迁移。';
      return `<p class="note">${esc(T(key, fallback, { source: sourceLabel(scope) }))}</p>`;
    };
    const report = state && state.lastRun;
    const reportHtml = report ? `<div class="sect-block" role="status">
      <p class="note">${esc(T('memory.legacy_migration_result', '处理完成：迁入 {migrated} 条，待审核 {pending} 条，失败 {failed} 条；有 {changed} 份源文件发生变化，{stale} 项选择已失效。', {
        migrated: String(Number(report.migrated || 0)), pending: String(Number(report.pendingReview || 0)),
        failed: String(Number(report.failed || 0)), changed: String(Number(report.sourceChangedFiles || 0)),
        stale: String(Number(report.staleSelections || 0)),
      }))}</p>
      ${report.backupFailed ? `<p class="note">${esc(T('memory.legacy_migration_backup_failed', '原文备份未能核验，源文件未清理。请保留原文并稍后重试。'))}</p>` : ''}
      ${Number(report.cleanupFailedFiles || 0) ? `<p class="note">${esc(T('memory.legacy_migration_cleanup_failed', '内容已写入认知资产，但旧文件未能更新；原文仍保留，请重新检查。', { n: String(Number(report.cleanupFailedFiles)) }))}</p>` : ''}
    </div>` : '';

    // 2026-09-29 子安「看不懂」整改：说明大段撤下（合并区顶部已有一句人话）；
    // 条目全文折叠三行（悬浮看全文）。
    let body = '';
    if (!state || state.loading) {
      body += `<p class="note">${esc(T('memory.legacy_migration_loading', '正在检查两份旧记忆文件…'))}</p>`;
    } else if (state.failed || !preview) {
      body += `<p class="note">${esc(T('memory.legacy_migration_load_failed', '暂时无法检查旧记忆；没有执行迁移，原文仍保留。'))}</p>
        ${btn(T('memory.legacy_migration_refresh', '重新检查'), 'legacy-memory-refresh', { small: true, className: 'o' })}`;
    } else {
      body += sourceWarning('user', userSource) + sourceWarning('shared', sharedSource);
      if (reportHtml) body += reportHtml;
      if (items.length) {
        // 保留类说明只在非零时念（2026-09-29：满屏 0 条是噪音）。
        const retainedBits = [
          [retainedTemplates, T('memory.migration_retained_templates', '由角色模板管理')],
          [retainedAssets, T('memory.migration_retained_assets', '已关联认知资产')],
          [retainedNonIndependent, T('memory.migration_retained_orphan', '来源关系不完整')],
        ].filter(([count]) => Number(count) > 0);
        if (retainedBits.length) {
          body += `<p class="note">${esc(T('memory.migration_retained_note', '另有 {n} 条不会由此迁移：{reasons}。', {
            n: String(retainedBits.reduce((total, [count]) => total + Number(count), 0)),
            reasons: retainedBits.map(([count, label]) => `${label} ${Number(count)} 条`).join('、'),
          }))}</p>`;
        }
        body += items.map((item) => {
          const scope = item.scope === 'shared' ? 'shared' : 'user';
          const hash = String(item.contentHash || '');
          const key = `${scope}:${hash}`;
          const checkboxId = `ca-legacy-memory-${scope}-${hash}`;
          const selectionLabel = T('memory.legacy_migration_select', '选择来自 {source} 的这条记忆', { source: sourceLabel(scope) });
          return `<div class="sect-block">
            <div class="rowline">
              ${window.uiCheckbox({
                id: checkboxId,
                label: migrationCheckboxAriaLabel(selectionLabel, item.text, hash),
                checked: selected.has(key),
                disabled: Boolean(state.running),
                attrs: { 'data-act': 'legacy-memory-toggle', 'data-scope': scope, 'data-hash': hash },
              })}
              <label for="${esc(checkboxId)}" class="note">${esc(selectionLabel)}</label>
              ${chip(sourceLabel(scope), 'line')}
              ${Number(item.occurrences || 1) > 1 ? `<span class="note">${esc(T('memory.legacy_migration_duplicates', '相同内容 {n} 条', { n: String(Number(item.occurrences)) }))}</span>` : ''}
            </div>
            <div class="content-text ca-mig-text" title="${esc(String(item.text || ''))}">${esc(String(item.text || ''))}</div>
          </div>`;
        }).join('');
        body += `<div class="actions">
          ${btn(T('memory.legacy_migration_refresh', '重新检查'), 'legacy-memory-refresh', { small: true, className: 'o', disabled: Boolean(state.running) })}
          ${btn(state.running
    ? T('memory.legacy_migration_running', '正在迁入已选记忆…')
    : T('memory.legacy_migration_run', '迁入已选 {n} 条', { n: String(selectedCount) }), 'legacy-memory-run', {
            small: true, primary: true, disabled: selectedCount === 0 || Boolean(state.running),
          })}
        </div>`;
      } else {
        const sourceNeedsReview = ['blocked', 'unavailable'].includes(String(userSource.status || ''))
          || ['blocked', 'unavailable'].includes(String(sharedSource.status || ''));
        if (!sourceNeedsReview) {
          body += `<p class="note">${esc(T('memory.legacy_migration_empty', '没有可迁移的未归属条目。角色模板管理的 {templates} 条、已关联认知资产的 {assets} 条和来源关系不完整的 {orphan} 条记录会继续留在原处。', {
            templates: String(retainedTemplates), assets: String(retainedAssets), orphan: String(retainedNonIndependent),
          }))}</p>`;
        }
        body += btn(T('memory.legacy_migration_refresh', '重新检查'), 'legacy-memory-refresh', { small: true, className: 'o' });
      }
    }
    // 2026-09-29 子安拍板（两迁移区合并+没活自动隐藏）：返回内层 body 与
    // 状态，由设置页组装进单个「旧记忆迁移」折叠区；pending=真正待迁条数
    //（保留类残留不计入角标）；hasReport=有上次结果要展示。
    return {
      body,
      pending: items.length,
      hasReport: Boolean(state && state.lastRun),
      loaded: Boolean(state && !state.loading && preview),
    };
  }

  /** Agent / Space / Project 历史记忆迁移入口。逐项展示原范围；项目旧文件
   *  若正作为 Space 回退来源或已被 Space 文件遮蔽，必须在用户选择前说明。 */
  function legacyScopedMemoryMigrationSection() {
    const state = S.legacyScopedMemoryMigration;
    const preview = state && state.preview;
    const sources = preview && Array.isArray(preview.sources) ? preview.sources : [];
    const items = preview && Array.isArray(preview.items) ? preview.items : [];
    const selected = new Set(state && state.selectionKeys || []);
    const selectedRows = items.filter((item) => selected.has(`${item.kind}:${item.id}:${item.contentHash}`));
    const selectedCount = selectedRows.reduce((total, item) => total + Math.max(1, Number(item.occurrences) || 1), 0);
    const sourceByKey = new Map(sources.map((source) => [String(source.sourceKey || ''), source]));
    const kindLabel = (kind) => T(`memory.scoped_migration_kind_${kind}`, ({
      agent: 'Agent', space: '工作空间', project: 'Project',
    })[kind] || String(kind || ''));
    const locationLabel = (sourceKey) => String(sourceKey || '').endsWith(':legacy')
      ? T('memory.scoped_migration_source_legacy', '历史位置')
      : T('memory.scoped_migration_source_canonical', '当前位置');
    const sourceLabel = (source) => `${kindLabel(source.kind)} · ${String(source.label || source.id || '')} · ${locationLabel(source.sourceKey)}`;
    const statusLabel = (status) => T(`memory.scoped_migration_status_${status}`, ({
      ready: '有可迁入条目', empty: '没有可迁入条目', blocked: '元数据异常，已保留', unavailable: '无法读取，已保留',
    })[status] || '状态未知');
    const sourceCard = (source) => {
      const visibility = source.runtimeVisibility === 'project_fallback'
        ? T('memory.scoped_migration_project_fallback', '当前正作为工作空间记忆的回退来源；迁入后资产仍限于这个项目。')
        : source.runtimeVisibility === 'shadowed'
          ? T('memory.scoped_migration_project_shadowed', '对应工作空间记忆文件已存在，这份旧项目记忆当前不会被运行时读取。')
          : source.runtimeVisibility === 'legacy_only'
            ? T('memory.scoped_migration_project_legacy_only', '没有关联工作空间；迁入后资产只限于这个项目。')
            : '';
      const retained = Number(source.retainedTemplateRecords || 0)
        + Number(source.retainedAssetRecords || 0)
        + Number(source.retainedNonIndependentRecords || 0)
        + Number(source.retainedOversizedRecords || 0);
      // 计数行只念有信息量的（2026-09-29：满屏 0 条是噪音）；retained 非零才补一句。
      const recordsLine = Number(source.eligibleRecords || 0) > 0
        ? T('memory.scoped_migration_source_counts_short', '可迁入 {records} 条。', { records: String(Number(source.eligibleRecords)) })
        : T('memory.scoped_migration_source_counts_none', '没有可直接迁入的条目。');
      return `<div class="sect-block">
        <div class="rowline">${chip(kindLabel(source.kind), 'line')}<strong>${esc(sourceLabel(source))}</strong>${chip(statusLabel(source.status), source.status === 'ready' ? 'green' : source.status === 'blocked' || source.status === 'unavailable' ? 'amber' : 'line')}</div>
        <p class="note">${esc(recordsLine)}${retained > 0 ? esc(T('memory.scoped_migration_source_retained', '另有 {n} 条特殊记录继续保留。', { n: String(retained) })) : ''}</p>
        ${visibility ? `<p class="note">${esc(visibility)}</p>` : ''}
        ${source.status === 'blocked' ? `<p class="note">${esc(T('memory.scoped_migration_blocked', '来源标记异常或正文校验失败；为防止归属错误，整份文件都不会迁移。'))}</p>` : ''}
        ${source.status === 'unavailable' ? `<p class="note">${esc(T('memory.scoped_migration_unavailable', '当前无法读取此文件；没有执行迁移，源内容仍保留。'))}</p>` : ''}
      </div>`;
    };
    const policyText = (item) => {
      const policy = item.scopePolicy && typeof item.scopePolicy === 'object' ? item.scopePolicy : {};
      const dimensions = [
        ['agentIds', 'agent', 'memory.scoped_migration_policy_agent'],
        ['workspaceIds', 'space', 'memory.scoped_migration_policy_space'],
        ['projectIds', 'project', 'memory.scoped_migration_policy_project'],
      ];
      const lines = dimensions.flatMap(([field, kind, key]) => {
        if (!Object.prototype.hasOwnProperty.call(policy, field)) return [];
        const ids = Array.isArray(policy[field]) ? policy[field].map(String) : [];
        const names = ids.map((id) => {
          const found = sources.find((source) => source.kind === kind && String(source.id) === id);
          return found ? String(found.label || id) : id;
        });
        return [`${T(key, ({ agent: '仅限 Agent', space: '仅限工作空间', project: '仅限 Project' })[kind])}：${names.length ? names.join('、') : T('memory.scoped_migration_policy_none', '不允许任何对象')}`];
      });
      return lines.length ? lines.join('；') : T('memory.scoped_migration_policy_unrestricted', '未声明额外对象范围');
    };

    // 2026-09-29 子安「看不懂」整改：说明段撤下（合并区顶部已有一句）。
    let body = '';
    if (!state || state.loading) {
      body += `<p class="note">${esc(T('memory.scoped_migration_loading', '正在扫描旧记忆来源…'))}</p>`;
    } else if (state.failed || !preview) {
      body += `<p class="note">${esc(T('memory.scoped_migration_load_failed', '暂时无法读取旧记忆清单；没有执行迁移，源文件仍保留。'))}</p>
        ${btn(T('memory.scoped_migration_refresh', '重新扫描'), 'legacy-scoped-memory-refresh', { small: true, className: 'o' })}`;
    } else {
      if (state.runFailed) body += `<p class="note">${esc(T('memory.scoped_migration_failed', '迁移没有完成；旧文件仍保留，请重新扫描后重试。'))}</p>`;
      if (state.lastRun) {
        const report = state.lastRun;
        const pendingCandidateIds = Array.isArray(report.pendingCandidateIds)
          ? [...new Set(report.pendingCandidateIds.map(String).filter(Boolean))]
          : [];
        body += `<div class="sect-block" role="status">
          <p class="note">${esc(T('memory.scoped_migration_result', '上次结果：迁入 {migrated} 条，待审核 {pending} 条，失败 {failed} 条；变化来源 {changed} 份，失效选择 {stale} 项，未清理 {cleanup} 份，损坏 {corrupt} 份，读取失败 {readFailed} 份。', {
            migrated: String(Number(report.migrated || 0)), pending: String(Number(report.pendingReview || 0)), failed: String(Number(report.failed || 0)),
            changed: String(Number(report.sourceChangedFiles || 0)), stale: String(Number(report.staleSelections || 0)),
            cleanup: String(Number(report.cleanupFailedFiles || 0)), corrupt: String(Number(report.corruptFiles || 0)), readFailed: String(Number(report.readFailedFiles || 0)),
          }))}</p>
          ${pendingCandidateIds.length ? `<p class="note">${esc(T('memory.scoped_migration_pending_followup', '待审核条目仍保留在旧记忆文件中。若候选还未处理，请先打开并修改或确认；然后（或候选已确认时）回到此处重新扫描、勾选对应条目并再次迁移。只有正式资产保存成功后才会清理旧记录。'))}</p>
            <div class="actions">${pendingCandidateIds.map((candidateId) => btn(T('memory.scoped_migration_open_candidate', '查看候选'), 'open-candidate', { id: candidateId, small: true, className: 'o' })).join('')}</div>` : ''}
          ${report.backupFailed ? `<p class="note">${esc(T('memory.scoped_migration_backup_failed', '原文备份未能完整核验，源文件没有清理。'))}</p>` : ''}
          ${report.backupDir ? `<p class="note">${esc(T('memory.scoped_migration_backup_location', '原文备份目录：'))}<code>${esc(String(report.backupDir))}</code></p>` : ''}
        </div>`;
      }
      if (sources.length) {
        body += `<div class="ca-migration-sources">${sources.map(sourceCard).join('')}</div>`;
      } else {
        body += `<p class="note">${esc(T('memory.scoped_migration_no_sources', '没有找到 Agent、工作空间或旧项目记忆文件。'))}</p>`;
      }
      if (items.length) {
        // 超长记录非零才念（2026-09-29）；「边界/组」术语换人话。
        const oversized = sources.reduce((count, source) => count + Number(source.retainedOversizedRecords || 0), 0);
        body += `<p class="note">${esc(T('memory.scoped_migration_selection_hint_short', '同一条记忆在多个地方出现的会合并成一组，勾一次一起搬。'))}${oversized > 0 ? esc(T('memory.scoped_migration_oversized_note', '另有 {n} 条超长记录不会由此迁移。', { n: String(oversized) })) : ''}</p>`;
        body += items.map((item) => {
          const key = `${item.kind}:${item.id}:${item.contentHash}`;
          const checkboxId = `ca-scoped-memory-${item.kind}-${item.id}-${item.contentHash}`;
          const refs = (Array.isArray(item.sourceKeys) ? item.sourceKeys : []).map((sourceKey) => sourceByKey.get(String(sourceKey))).filter(Boolean);
          const selectionLabel = T('memory.scoped_migration_select', '迁入这条 {kind} 记忆', { kind: kindLabel(item.kind) });
          return `<div class="sect-block ca-scoped-memory-item">
            <div class="rowline">
              ${window.uiCheckbox({
                id: checkboxId,
                label: migrationCheckboxAriaLabel(selectionLabel, item.text, item.contentHash),
                checked: selected.has(key),
                disabled: Boolean(state.running),
                attrs: { 'data-act': 'legacy-scoped-memory-toggle', 'data-scope-kind': item.kind, 'data-scope-id': item.id, 'data-hash': item.contentHash },
              })}
              <label for="${esc(checkboxId)}" class="note">${esc(selectionLabel)}</label>
              ${refs.map((source) => chip(sourceLabel(source), 'line')).join('')}
            </div>
            <p class="note">${esc(policyText(item))}</p>
            <div class="content-text ca-mig-text" title="${esc(String(item.text || ''))}">${esc(String(item.text || ''))}</div>
          </div>`;
        }).join('');
        body += `<div class="actions">
          ${btn(T('memory.scoped_migration_refresh', '重新扫描'), 'legacy-scoped-memory-refresh', { small: true, className: 'o', disabled: Boolean(state.running) })}
          ${btn(state.running
    ? T('memory.scoped_migration_running', '正在迁入所选记忆…')
    : T('memory.scoped_migration_run', '迁入所选 {n} 条', { n: String(selectedCount) }), 'legacy-scoped-memory-run', {
            small: true, primary: true, disabled: selectedCount === 0 || Boolean(state.running),
          })}
        </div>`;
      } else {
        body += `<p class="note">${esc(T('memory.scoped_migration_empty', '当前没有可直接迁入的条目。异常来源、已关联记录、来源不完整或超长内容都会继续留在原文件。'))}</p>
          ${btn(T('memory.scoped_migration_refresh', '重新扫描'), 'legacy-scoped-memory-refresh', { small: true, className: 'o', disabled: Boolean(state.running) })}`;
      }
    }
    // 同上（2026-09-29 两迁移区合并）：返回内层 body 与状态。
    return {
      body,
      pending: items.length,
      hasReport: Boolean(state && state.lastRun),
      loaded: Boolean(state && !state.loading && preview),
    };
  }

  /* ────────────────────────── 使用记录零件（2026-09-15 自独立页迁入资产详情） ────────────────────────── */

  const PROOF_FEEDBACKS = [
    ['positive', 'cognition.proof_carried_in', '有用'],
    ['rework', 'cognition.proof_rework', '没用对'],
    ['neutral', 'cognition.proof_no_diff', '没差别'],
    ['invalid', 'cognition.proof_degraded', '说不清'],
  ];

  /** 时间线事件标题：优先用 kind（稳定枚举）映射成人话；英文标题仅作兜底。
   *  此前只映射了 title 的三种英文串，usage_recorded / projection_confirmed
   *  两类漏网（用户实测"看不懂"），全部补齐；未知事件原样显示不编造。 */
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

  /* ────────────────────────── 沉淀设置页（2026-09-15 自页首抽屉升级） ──────────────────────────
   * 入口=整理页右上齿轮。核心是「夜间自动沉淀」条状卡：右侧开关、中间可选
   * 开始时间；开启时联动「先问我」——产出的候选进「待我处理」等批准/调整
   *（而非自动采纳）。原抽屉的整理功能开关与候选确认方式也收在 this 页。 */

  /** 推荐排序权重卡已彻底移除（拍板项 #3，2026-09-28）：排序已换目录算法
   *  v2 引擎（6f3ff075），权重卡是旧四因子引擎的调参遗物、真机从未配置过
   *  （capture-settings 无 rankingWeights 字段）。读写通道与已存权重数据
   *  后端原样保留；详情页「排序依据」只读解释保留（提示语不再指向设置页）。 */

  /** 标题重起轮判定（2026-09-28 标题一等化 3.3 专项轮）：重起轮的整理报告或以
   *  独立 trigger 值标记本轮、或由 kind='title_regen' 的报告项可辨——两种载体
   *  形态都认；导语、文案按它区分轮次（规则轮沿用原文案；LLM 重起轮上"只自动
   *  规范标题、合并重复项"是假话——重起轮不做合并、按决策 #1 全自动写入）。 */
  const isTitleRegenReport = (report) => Boolean(report)
    && (String(report.trigger || '') === 'title_regen'
      || (Array.isArray(report.items) && report.items.some((item) => String(item.kind || '') === 'title_regen')));

  /** 资产设置中的手动整理入口；报告页继续复用既有 viewCleanup 路由。 */
  function viewOrganizeSettingsPage() {
    // 「整理功能」总开关卡已撤（specs/017 整改三）：「已开启+关闭按钮」读不懂
    // 且关闭是破坏性动作；后端 enabled 字段与契约保留，整理页的「已关闭」
    // warn 路径也保留（只是 UI 上不再可达）。
    const settings = S.captureSettings || {};
    const model = S.captureModel || null;
    const nightlyOn = String(settings.executionPolicy || 'manual') === 'nightly';
    const reviewAuto = String(settings.reviewPolicy || 'auto') === 'auto';
    const nightlyStart = String(settings.nightlyStart || '02:00');
    const quietMinutes = Number(settings.quietMinutes) > 0 ? Number(settings.quietMinutes) : 10;
    const modelNeedsAttention = !model || !model.configured || model.authorizationRequired;
    // 自动维护合并卡（2026-09-29 拍板：夜间自动整理+定期检查合为一个开关）：
    // 巡检随总开关同步启停（见 app.js nightly-toggle），这里展示它的最近一轮。
    const latestInspection = S.inspection && S.inspection.latestRun ? S.inspection.latestRun : null;
    // 最近整理状态（原「整理已有内容」行的 summary，行合并后挪进自动维护行）。
    const cleanupReportsList = (S.cleanupReports && Array.isArray(S.cleanupReports.reports)) ? S.cleanupReports.reports : [];
    const cleanupLatest = cleanupReportsList[0] || null;
    const cleanupLatestNote = cleanupLatest
      ? `<div class="note">${esc(T('cognition.cleanup_latest', '最近一次：{when} · 执行 {applied} 项 · 拿不准 {uncertain} 项', {
        when: fmtDate(cleanupLatest.createdAt),
        applied: String((cleanupLatest.items || []).filter((item) => item.status === 'applied').length),
        uncertain: String((cleanupLatest.uncertain || []).length),
      }))}</div>`
      : '';
    return `${hero(
      T('cognition.organize_settings_title', '资产设置'),
      T('cognition.organize_settings_hint', '自动维护集中在这里：夜间整理对话、检查并清理资产库；整理结果和需要你判断的内容都有记录。'),
    )}
    ${modelNeedsAttention ? `<div class="card ca-setcard">
      <div class="rowline">
        <div><div class="tt">${esc(T('cognition.model_state_title', '模型状态'))}</div>
        <div class="sub">${esc(model && model.configured
          ? (model.authorizationRequired
            ? T('cognition.model_state_auth', '模型已配置但授权未完成：整理会在需要模型时停住，先去完成授权。')
            : T('cognition.model_state_ok', '模型已配置，自动整理可用。'))
        : T('cognition.model_state_missing', '还没配置模型：自动整理与候选提炼都跑不起来。'))}</div></div>
        <div class="right">${btn(T('cognition.model_state_open', '去应用设置'), 'go-configure-model', { small: true, className: 'o' })}</div>
      </div>
    </div>` : ''}
    <div class="card ca-setcard">
      ${(() => {
        // 三块合一（2026-09-29 子安拍板）：「自动维护 + 新建议如何保存 + 整理
        // 已有内容」本来就是一件事的三面——夜间自动整理 / 整理产出怎么入库 /
        // 手动整理存量——收进一张「维护」卡，三行各管一面，通道与动作不变。
        return `<div class="rowline">
        <div>
          <div class="tt">${esc(T('cognition.nightly_capture_title', '自动维护'))}</div>
          <div class="sub">${esc(T('cognition.maint_hint_short', '夜间自动整理当天结束的会话，检查资产库并清理存量（规范标题、合并重复、补标签、重写啰嗦正文；消耗模型额度）；整理产出按下方「是否自动保存」入库。'))}</div>
          ${latestInspection ? `<div class="note">${esc(T('cognition.inspection_last_run', '最近检查：{when} · 发现 {n} 条', {
            when: fmtDate(latestInspection.startedAt), n: String(((latestInspection.findings || [])).length),
          }))}</div>` : ''}
          ${cleanupLatestNote}
        </div>
        <div class="right">
          ${nightlyOn ? `<label class="ca-setting-time"><span>${esc(T('cognition.nightly_capture_time', '开始时间'))}</span>${window.uiInput({ id: 'ca-nightly-start', type: 'time', value: nightlyStart, attrs: { 'data-act': 'nightly-time' } })}</label>` : ''}
          ${cleanupLatest ? btn(T('cognition.cleanup_open_report', '查看整理报告'), 'open-cleanup', {
            small: true, className: 'o',
            title: T('cognition.cleanup_report_title', '看每次整理具体改了什么（改前/改后对照），每项都可以单独回滚。'),
          }) : ''}
          ${window.uiSwitch({ label: T('cognition.nightly_capture_title', '自动维护'), checked: nightlyOn, attrs: { 'data-act': 'nightly-toggle' } })}
        </div>
      </div>
      ${nightlyOn ? `<div class="note ca-maint-note">${esc(T('cognition.nightly_capture_quiet_hint', '系统会等会话最后一条消息后静默 {minutes} 分钟，再在夜间时段安排整理；如有新消息，会重新计时。', { minutes: String(quietMinutes) }))}</div>` : ''}
      <div class="rowline ca-maint-row">
        <div>
          <div class="tt">${esc(T('cognition.maint_review_title', '是否自动保存'))}</div>
          <div class="sub"><b>${esc(T('cognition.maint_review_on_tag', '开'))}</b> · ${esc(T('cognition.maint_review_on_desc', '符合条件的建议直接入库：内容质量达标、能在你的原话里找到依据、模型不拿不准、不涉高风险，同时满足才自动存；其余仍会进「待我处理」问你。'))}</div>
          <div class="sub"><b>${esc(T('cognition.maint_review_off_tag', '关'))}</b> · ${esc(T('cognition.maint_review_off_desc', '每条先进「待我处理」，由你确认或修改后保存。'))}</div>
        </div>
        <div class="right">${window.uiSwitch({
          // 2026-09-29 子安「调整这个按钮」：二选一模式从分段控件收成一个开关
          //（开=符合条件时自动保存，关=每条先问我）；data-id 传目标态，与
          // 资产级开关同一模式。
          label: T('cognition.maint_review_switch', '符合条件时自动保存'),
          checked: reviewAuto,
          attrs: { 'data-act': 'capture-review-toggle', 'data-id': reviewAuto ? 'manual' : 'auto' },
        })}</div>
      </div>
      `;
      })()}
    </div>
    ${(() => {
      // 两迁移区合并 + 没活自动隐藏（2026-09-29 子安拍板）：单个「旧记忆迁移」
      // 折叠区，角标=两区真正待迁条数之和（保留类残留不计）；两区都加载完成、
      // 都没有待迁条目、也都没有上次结果要展示时，整个区不渲染——迁移工具
      // 在界面层自动退役，代码保留（残留/新用户场景仍可用）。
      const legacy = legacyMemoryMigrationSection();
      const scoped = legacyScopedMemoryMigrationSection();
      const pending = legacy.pending + scoped.pending;
      const visible = !legacy.loaded || !scoped.loaded
        || pending > 0 || legacy.hasReport || scoped.hasReport;
      if (!visible) return '';
      return `<details class="details"><summary>${esc(T('memory.migration_merged_title', '旧记忆迁移'))}<span class="n">${esc(String(pending))}</span></summary><div class="dbody">
        <p class="note">${esc(T('memory.migration_merged_desc', '老版本记忆文件里还没搬进认知资产的内容在这里逐条迁移；都搬完后这个区会自动消失。'))}</p>
        <div class="sect-block"><div class="tt">${esc(T('memory.legacy_migration_title', '旧记忆归属与迁移'))}</div>${legacy.body}</div>
        <div class="sect-block"><div class="tt">${esc(T('memory.scoped_migration_title', 'Agent / 工作空间 / Project 旧记忆迁移'))}</div>${scoped.body}</div>
      </div></details>`;
    })()}`;
}

  /* ────────────────────────── 视图：整理（任务流 + 策略） ──────────────────────────
   * 2026-09-15 全模块重构：原「从历史会话整理」「整理记录」「设置与管理→
   * 整理方式」三处合并为一。一行 = 一个会话 × 它的整理任务（含无留存内容
   * 的静默记录）；策略收成页首抽屉；分桶筛选与批量入口保留。 */

  /** 整理报告（specs/008 US-403）：每项改动可核对、可回滚。
   *
   *  报告存在的意义是"用户能自己核对"——所以每一项都显示改了什么、为什么、
   *  以及一个回滚入口；拿不准的项单列，等用户给个处置意见（不擅自处置）。 */
  // 2026-09-29 第 5 批：inspectionRoundCard 死函数删除——018 §四重构后全文件
  // 零调用（定义即唯一出现）；其要表达的 scanned/trigger 摘要若仍需要，属
  // 系统活动页时间流的新需求，另立 spec 再做（09-27 审计遗留的「二选一」按
  // 「默认删」收口）。
  // 2026-09-29 自动维护合并：inspectionSettingsCard 随之删除——巡检并入
  // 上方「自动维护」合并卡（开关同步 + 最近检查行 + 检查一次按钮），
  // 独立开关与「高级设置」折叠不再存在。

  function viewCleanup(route) {
    const state = S.cleanupReports;
    const reports = state && Array.isArray(state.reports) ? state.reports : [];
    const selectedId = String(route.cleanupReportId || '');
    const report = reports.find((row) => String(row.id) === selectedId) || reports[0] || null;
    const loading = Boolean(state && state.loading);
    // 页头与其余详情页同款（2026-09-29 统一）：返回行 + 大标题 + 一行说明 +
    // 右侧「立即维护」（此前用 uiPageHeader 紧凑组件，模块内三种详情页头
    // 各不相同）；说明放页头 sub，正文 note 只讲本轮干了什么。
    const header = `${btn(T('cognition.cleanup_back', '← 返回'), 'go-back', { className: 'backlink' })}
    ${heroRow(
      T('cognition.cleanup_title', '整理报告'),
      T('cognition.cleanup_page_hint', '每次整理与清理改了什么，逐项留档，可核对、可回滚。'),
      btn(loading ? T('cognition.cleanup_running', '正在维护…') : T('cognition.maint_run', '立即维护'), 'run-maintenance', {
        disabled: loading,
        title: T('cognition.maint_run_title_hint', '检查资产库并做一次完整清理（规范标题、合并重复、补标签、重写啰嗦正文）。会消耗模型额度，拿不准的改动会留给你确认。'),
      }),
    )}`;
    // 导语按轮次区分：完整整理轮（round:'full'，2026-09-29 三轮合一后的常态）
    // 用合并导语；旧规则轮/标题重起轮的历史报告沿用各自原文案。
    const hint = `<p class="note">${esc(String(report && report.round || '') === 'full'
      ? T('cognition.cleanup_full_hint', '本轮自动完成：规范标题、合并重复项、补标签，并由模型重写了不合格的标题与啰嗦的正文；写前有整库备份，逐项留档可回滚。')
      : isTitleRegenReport(report)
      ? T('cognition.cleanup_regen_hint', '由模型把不合格的标题重新拟一个简短的新标题，自动写入并逐条留档对照；写前有整库备份，不会合并内容或修改正文。')
      : T('cognition.cleanup_run_hint_legacy', '只自动规范标题、合并正文完全相同的重复项；不确定的内容不会改动，会留给你判断。'))}</p>`;
    if (!report) {
      return `<div class="ca-page">${header}${hint}${empty(
        T('cognition.cleanup_empty', '还没有整理报告'),
        T('cognition.cleanup_empty_hint', '运行整理后，这里会列出改动内容、原因和逐项回滚入口。'),
      )}</div>`;
    }

    const KIND_LABELS = {
      title_normalized: T('cognition.cleanup_kind_title_normalized', '标题规范化'),
      merged_duplicate: T('cognition.cleanup_kind_merged_duplicate', '重复归并'),
      // 补标签（specs/012 T025）：词条四语早已备好却一直没接上，完整整理轮
      // 必产此 kind——欠账补上（2026-09-29）。
      tag_added: T('cognition.cleanup_kind_tag_added', '补标签'),
      // 标题重起轮（3.3 专项轮）的新 kind：词条四语由重起轮配套落，这里先按
      // 既有 cleanup_kind_* 命名引用——勿重蹈 tag_added 缺席、显示兜底的欠账。
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
    // 工程码翻译（2026-09-29 子安抓的样式整改）：报告 reason/note 里裸出的
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
      <div class="tw"><div class="tt">${esc(fmtDate(row.createdAt))}</div><div class="mm">${esc(T('cognition.cleanup_row_summary', '执行 {applied} 项 · 拿不准 {uncertain} 项', {
        applied: String((row.items || []).filter((item) => item.status === 'applied').length),
        uncertain: String((row.uncertain || []).length),
      }))}</div></div>
      <div class="sd">${row.interrupted ? window.uiTag({ label: T('cognition.cleanup_status_interrupted', '中断过'), variant: 'outline' }) : ''}</div>
    </div>`).join('');
    const itemRows = items.length ? items.map((item) => {
      // 改前/改后分段呈现（2026-09-29 子安抓的样式整改）：原来 `${before} → ${after}`
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
        <div class="tt">${esc(String(entry.title || assetTitle(entry.assetId)))}</div>
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
      ${report.interrupted ? `<div class="sect-block"><p class="note">${esc(T('cognition.cleanup_interrupted', '这轮中断过：已执行项仍然有效、可逐项回滚；未执行的保持原状。'))}</p></div>` : ''}
      <div class="sect-block"><div class="tt">${esc(T('cognition.cleanup_summary', '扫描 {scanned} 条 · 执行 {applied} 项 · 拿不准 {uncertain} 项', {
        scanned: String(report.scanned || 0), applied: String(appliedCount), uncertain: String(uncertain.length),
      }))}</div>
      ${Array.isArray(report.skippedSteps) && report.skippedSteps.length
        ? `<p class="note">${esc(T('cognition.cleanup_skipped', '本轮跳过：{steps}', { steps: report.skippedSteps.join('；') }))}</p>`
        : ''}</div>
      <div class="sect-block"><div class="tt">${esc(T('cognition.cleanup_items', '逐项改动'))}</div>${itemRows}</div>
      ${uncertain.length ? `<div class="sect-block"><div class="tt">${esc(T('cognition.cleanup_uncertain_section', '拿不准的（未改动）'))}</div>${uncertainRows}</div>` : ''}
      ${reports.length > 1 ? `<div class="sect-block"><div class="tt">${esc(T('cognition.cleanup_reports', '历史报告'))}</div>${reportRows}</div>` : ''}

    </div>`;
  }

  function viewOrganizeTasks(route) {
    const vocab = NS.vocabulary;

    // 只取会话级项：同组里还有 subtype:message 的消息级溯源项（id=msg- 哈希、
    // 无会话标题，供证据 chip 解析），混进任务流会显示成裸哈希行且不属于任何
    // 筛选桶（2026-09-16 真机抓出；后端 limit 不足时用它补位）。排除法保兼容。
    const conversationItems = S.sources
      .filter((g) => String(g.kind || '') === 'conversation' || (g.items || []).some((i) => i.kind === 'conversation'))
      .flatMap((g) => (Array.isArray(g.items) ? g.items : []))
      .filter((item) => String(item.subtype || '') !== 'message');
    // 任务关联（含 silent：无留存内容的记录也如实显示）：每会话取最相关一条。
    const CLASS_ORDER = { active: 0, attention: 1, done: 2, silent: 3 };
    const captureByConv = new Map();
    for (const capture of (Array.isArray(S.captures) ? S.captures : [])) {
      const prev = captureByConv.get(capture.conversationId);
      const rank = (row) => (CLASS_ORDER[row.bucket] !== undefined ? CLASS_ORDER[row.bucket] : 9);
      if (!prev
        || rank(capture) < rank(prev)
        || (rank(capture) === rank(prev) && String(capture.updatedAt || '') > String(prev.updatedAt || ''))) {
        captureByConv.set(capture.conversationId, capture);
      }
    }
    const bucketOf = (capture) => (capture.bucket || (
      // 兜底口径与后端对齐（2026-09-15）：no_candidate 对用户就是"已完成"，
      // 行上显示的正是「已完成」——不能让它只出现在「全部」里。
      capture.status === 'no_candidate' ? 'done'
        : ['failed', 'configuration_required', 'review_ready', 'paused', 'waiting_manual'].includes(capture.status) ? 'attention'
          : ['completed', 'cancelled'].includes(capture.status) ? 'done' : 'active'));
    /** 真·整理中：排队/提炼/写入（通常几十秒）。等待类（等你手动开始/静默期/
     *  夜间窗口）不算——2026-09-15 修正：waiting_manual 曾被显示成「整理中」，
     *  但它的动作是「立即整理」，列表与详情自相矛盾。 */
    const isRunning = (capture) => ['queued', 'extracting', 'writing'].includes(String(capture.status));

    let rows = conversationItems.map((conv) => ({ conv, capture: captureByConv.get(conv.id) || null }));
    // 低价值归类（2026-09-16「无需沉淀」分类，子安口径）：寒暄命中即归类
    //（无视任务——整理过的寒暄如「hi」也从「已完成」移入）；回复失败仅对
    // 无任务行（失败会话被整理过=用户已主动处理过）。取代旧的 messageCount
    // 前端隐藏过滤——判定信号由后端出，前端不猜，宁漏勿误伤。
    const isExcludedRow = (row) => Boolean(row.conv.chatLike || (!row.capture && row.conv.lastTurnFailed));
    // 真正跑着的（queued/extracting/writing）恒在最顶，其余按会话最近活动。
    rows.sort((left, right) => {
      const leftActive = left.capture && isRunning(left.capture) ? 1 : 0;
      const rightActive = right.capture && isRunning(right.capture) ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return String(right.conv.updatedAt || right.conv.createdAt || '')
        .localeCompare(String(left.conv.updatedAt || left.conv.createdAt || ''));
    });
    const normalRows = rows.filter((row) => !isExcludedRow(row));
    const excludedRows = rows.filter(isExcludedRow);
    // 「全部」含低价值行（2026-09-16 子安口径）：默认视图展示所有会话，低
    // 价值行带标注；任务三桶只数正常行（寒暄任务行已移入无需沉淀）。
    const filtered = route.captureBucket === 'excluded' ? excludedRows
      : route.captureBucket
        ? normalRows.filter((row) => row.capture && bucketOf(row.capture) === route.captureBucket)
        : rows;
    // chip 计数与列表行同口径（2026-09-16 修复）：列表每会话只显示最相关
    // 一条任务，同一会话的多次整理（重试/夜间多轮）会让后端 buckets 的记录
    // 数大于列表行数——chip 必须数 rows，点开筛选看到的行数才和数字对得上。
    const rowBucketCounts = { attention: 0, active: 0, silent: 0, done: 0 };
    for (const row of normalRows) if (row.capture) rowBucketCounts[bucketOf(row.capture)] += 1;
    // 批量入口口径：只作用于「当前已加载且该动作在 actions 里」的行——立即
    // 整理每条都是一次模型额度消耗，绝不按后端计数隐式扩大范围。
    const retryableIds = (Array.isArray(S.captures) ? S.captures : []).filter((capture) => (capture.actions || []).includes('retry'));

    const listLimit = S.organizeListExpanded ? filtered.length : Math.min(5, filtered.length);
    const visibleRows = filtered.slice(0, listLimit);

    const rowHtml = (row) => {
      const { conv, capture } = row;
      const convTime = fmtDate(conv.updatedAt || conv.createdAt);
      const excluded = isExcludedRow(row);
      // 低价值行的原因 chip（2026-09-16）：寒暄/失败分别注明。
      const excludedTag = excluded
        ? (conv.chatLike
          ? chip(T('cognition.capture_excluded_chatty', '纯寒暄'))
          : chip(T('cognition.capture_excluded_failed', '未得到回复')))
        : '';
      if (!capture) {
        // 低价值无任务行：整行可点回看会话内容（2026-09-29 子安指令：条目
        // 整行可点，不再只限标题），「开始整理」位置改为「无需整理」提示
        //（2026-09-16 子安口径：内容可看，但不再给整理入口）。
        if (excluded) {
          return `
          <div class="cap-row is-clickable" data-act="open-conversation" data-id="${esc(conv.id)}" role="button" tabindex="0" title="${esc(T('cognition.capture_action_open_conversation', '打开会话'))}">
            <div class="tw"><div class="tt">${esc(conv.title || T('cognition.evidence_conversation_generic', '一段对话'))}</div>
            <div class="mm"><span>${esc(convTime)}</span></div></div>
            <div class="sd">${excludedTag}${chip(T('cognition.capture_excluded_action_hint', '无需整理'), 'amber')}</div>
          </div>`;
        }
        return `
        <div class="cap-row">
          <div class="tw"><div class="tt">${esc(conv.title || T('chat.untitled', '未命名对话'))}</div>
          <div class="mm"><span>${esc(convTime)}</span></div></div>
          <div class="sd">${btn(T('cognition.capture_manual_history_create', '整理这个会话'), 'organize-conv', { id: conv.id, small: true, className: 'g' })}</div>
        </div>`;
      }
      // 整行即详情入口（2026-09-29 子安指令）：act 提到行根（委托层 closest
      // 最近匹配——行内「立即开始/去确认」等按钮自带 act，点击各归各位）；
      // 标题不再单独伪装链接。
      const titleHtml = `<div class="tt" title="${esc(T('cognition.capture_detail_open_hint', '查看整理情况'))}">${esc(vocab ? vocab.recordTitle(capture) : String(capture.conversationTitle || conv.title || T('cognition.capture_untitled_record', '未命名会话的整理')))}</div>`;
      const pending = Number(capture.reviewSummary && capture.reviewSummary.pending) || 0;
      /* 事件句（specs/018 T060）：一行 = 一句人话 + 时间 + 落点。四型——
       * 整理了会话→产出候选 / 夜间沉淀跑完 / 大扫除 / 后台体检（后两类在
       * 时间流另行并入）；等待与失败类沿用原因白话（vocabulary 唯一出口）。 */
      const nightly = String(capture.executionPolicy || '') === 'nightly';
      const eventLine = isRunning(capture)
        ? T('cognition.activity_event_running', '正在整理这段会话…')
        : nightly && pending
          ? T('cognition.activity_event_nightly', '夜间整理完成 → {n} 条待确认建议', { n: String(pending) })
          : nightly
            ? T('cognition.activity_event_nightly_empty', '夜间整理完成，没有发现需要保存的内容')
            : pending
              ? T('cognition.activity_event_session', '整理了这段会话 → 产出 {n} 条候选', { n: String(pending) })
              : '';
      const reasonText = vocab ? vocab.captureReasonText(capture.displayReason) : T('cognition.capture_display_reason_other', '原因未记录');
      const metaText = [eventLine || reasonText, convTime].filter(Boolean).join(' · ');
      // 用 isRunning 判定「整理中」（仅排队/提炼/写入）：等待类显示原因
      // chip；等待手动开始的行直接给「立即整理」按钮（不必进详情页）。
      /* 低价值行（纯寒暄/未回复）不给「立即整理」——行上同时摆「纯寒暄」
         和「立即整理」是自相矛盾的口径（2026-09-21 子安抓出「界面混乱」）；
         与无任务的低价值行同款「无需整理」提示，点标题可回看内容。 */
      /* 落点按钮（018 T060）：产出候选 →「去处理」（go-review）；
       * 等待手动 →「立即整理」；运行中不给按钮（正在跑）。 */
      const actions = Array.isArray(capture.actions) ? capture.actions : [];
      const primaryAction = !excluded && !isRunning(capture) && actions.includes('run_now')
        ? btn(T('cognition.capture_action_run_now', '立即开始'), 'capture-action', { id: capture.id, data: { action: 'run_now' }, small: true, primary: true })
        : !excluded && !isRunning(capture) && pending && actions.includes('review_candidates')
          ? btn(vocab ? vocab.captureActionText('review_candidates') : T('cognition.capture_action_review_candidates', '去确认'), 'go-review', { small: true, primary: true })
          : excluded && !isRunning(capture)
            ? chip(T('cognition.capture_excluded_action_hint', '无需整理'), 'amber')
            : '';
      const sideHtml = isRunning(capture)
        ? btn(T('cognition.organize_active_label', '整理中'), '', { small: true, primary: true, disabled: true })
        : `${excludedTag}${chip(
          vocab ? vocab.captureDisplayStatusText(capture.displayStatus) : T('cognition.capture_display_status_other', '状态未知'),
          capture.displayStatus === 'failed' ? 'red' : (capture.displayStatus === 'review_ready' || capture.displayStatus === 'completed') ? 'green' : 'amber',
        )}${primaryAction}`;
      return `
        <div class="cap-row is-clickable" data-act="open-capture-detail" data-id="${esc(capture.id)}" role="button" tabindex="0">
          <div class="tw">${titleHtml}<div class="mm"><span>${esc(metaText)}</span></div></div>
          <div class="sd">${sideHtml}</div>
        </div>`;
    };

    const chips = [['', T('common.all', '全部')], ['attention', null], ['active', null], ['done', null],
      ...(excludedRows.length ? [['excluded', null]] : [])]
      .map(([id, label]) => {
        const text = label || (vocab ? vocab.captureBucketText(id) : id);
        const count = id === '' ? rows.length : id === 'excluded' ? excludedRows.length : rowBucketCounts[id];
        return btn(`${text} ${count}`, 'capture-filter', {
          id,
          className: `chip${String(route.captureBucket || '') === id ? ' on' : ''}`,
        });
      }).join('');
    // 批量入口只保留「重试失败」(2026-09-21 原型 v7 定调):批量「立即整理」
    // 会诱导用户跳过逐条处理,且每次都是模型额度消耗——施工矩阵明确不迁移,
    // 单条任务行上的「立即整理」保留。

    // 页首右侧只留一个设置入口（2026-09-15 子安标注）：原型是一枚
    // 「沉淀设置」文字按钮（tbtn），我们走共享 uiButton + icons.js 的
    // settings 图标（团队规范：图标不手写 SVG）。
    /* 系统事件并入时间流（specs/018 T060）：大扫除报告与后台体检作为
     * 时间线事件呈现（一句人话 + 时间 + 落点）；仅在未选分桶筛选时出现
     * （它们不属于任何整理分桶）。发起入口在「设置」页（不重复摆卡）。 */
    const cleanupEvents = ((S.cleanupReports && Array.isArray(S.cleanupReports.reports)) ? S.cleanupReports.reports : [])
      .slice(0, 3)
      .map((report) => {
        // 0 归并是合法结果（跑了但没找到可归并的）——给空态专用句，
        // 不写「归并 0 条重复」（迭代轮 2 猎区 1）。
        const merged = (report.items || []).filter((item) => item.status === 'applied').length;
        return {
          at: String(report.createdAt || ''),
          html: `<div class="cap-row is-clickable" data-act="open-cleanup-report" data-report="${esc(String(report.id))}" role="button" tabindex="0">
          <div class="tw"><div class="tt">${esc(merged
            ? T('cognition.activity_event_cleanup', '整理合并 {n} 条重复项', { n: String(merged) })
            : T('cognition.activity_event_cleanup_empty', '整理完成，没有重复项需要合并'))}</div>
          <div class="mm"><span>${esc(fmtDate(report.createdAt))}</span></div></div>
          <div class="sd">${btn(T('cognition.activity_event_see_report', '看报告'), 'open-cleanup-report', { small: true, className: 'o', data: { report: String(report.id) } })}</div>
        </div>`,
        };
      });
    const inspectionEvents = [];
    if (S.inspection && S.inspection.latestRun) {
      const run = S.inspection.latestRun;
      const found = (run.findings || []).length;
      inspectionEvents.push({
        at: String(run.startedAt || ''),
        html: `<div class="cap-row is-clickable" data-act="go-review" role="button" tabindex="0">
          <div class="tw"><div class="tt">${esc(found
            ? T('cognition.activity_event_inspection', '定期检查发现 {n} 条待处理', { n: String(found) })
            : T('cognition.activity_event_inspection_clean', '定期检查完成，没有发现问题'))}</div>
          <div class="mm"><span>${esc(fmtDate(run.startedAt))}</span></div></div>
          <div class="sd">${btn(T('cognition.activity_event_inspection_go', '去看看'), 'go-review', { small: true, primary: found > 0 })}</div>
        </div>`,
      });
    }
    const timelineEntries = [
      ...visibleRows.map((row) => ({
        at: String(row.conv.updatedAt || row.conv.createdAt || ''),
        pinned: Boolean(row.capture && isRunning(row.capture)),
        html: rowHtml(row),
      })),
      ...(route.captureBucket ? [] : [...cleanupEvents, ...inspectionEvents]),
    ].sort((left, right) => (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0)
      || String(right.at).localeCompare(String(left.at)));
    return `${heroRow(
      T('cognition.tab_activity', '系统活动'),
      T('cognition.activity_lead', '整理记录按时间排列；需要你判断的内容会进入「待我处理」。'),
      // 整理入口集中在资产设置；018 T060 起本页只保留事件时间流。
      // 页头右侧入口已移除，避免与顶层页签重复。
      // 已删（2026-09-27 子安）：页签「沉淀设置」是唯一入口，不再双入口。
      '',
    )}
    ${!S.captureSettings || S.captureSettings.enabled === false ? `<div class="warn">${esc(T('cognition.capture_disabled_note', '整理功能已关闭：不再开始新的整理；已创建任务和「我的认知」资产不受影响。'))}</div>` : ''}
    ${S.captureSettings && S.captureSettings.enabled !== false && retryableIds.length ? `<div class="toolbar"><div class="toolbar-right">${retryableIds.length ? btn(T('cognition.capture_batch_retry', '重试失败（{n}）', { n: String(retryableIds.length) }), 'capture-batch', { data: { batch: 'retry' }, small: true, className: 'o' }) : ''}</div></div>` : ''}
    ${(Array.isArray(S.captures) ? S.captures : []).some((c) => bucketOf(c) === 'active') ? `<div class="note toolbar-note">${esc(T('cognition.capture_running_note', '有任务正在跑：任务完成后这一页会自动更新，不用手动刷新。'))}</div>` : ''}
    <div class="pillbox"><div class="chips">${chips}</div></div>
    ${timelineEntries.length ? timelineEntries.map((entry) => entry.html).join('') : empty(T('cognition.capture_tasks_empty', '暂无整理任务'), T('cognition.capture_tasks_empty_hint', '一轮会话结束后，系统会在静默期结束后创建整理任务。'), { label: T('cognition.organize_settings_title', '资产设置'), attrs: { 'data-act': 'go-organize-settings' } })}
    ${conversationItems.length >= 100 ? `<div class="note">${esc(T('cognition.capture_sources_truncated', '仅显示最近 100 个会话（来源拉取上限）'))}</div>` : ''}
    ${filtered.length > 5 ? `<div class="list-more">${btn(S.organizeListExpanded
      ? T('cognition.capture_list_collapse', '收起')
      : T('cognition.capture_list_expand', '查看全部 {n} 个会话', { n: String(filtered.length) }), 'toggle-organize-list', { small: true, className: 'o' })}</div>` : ''}
    <div class="note footnote">${esc(T('cognition.capture_bucket_scope_note', '口径说明：按每个会话最近相关的整理任务分组；「需要你看一眼」包括待确认与被暂停的任务；「无需保存」包括纯寒暄与未得到回复的会话。'))}</div>
    ${improvementAnalysisSection(route)}`;
  }

  /* 整理详情（2026-09-15 新增）：一条整理任务的完整执行情况——状态与当前
   * 步骤、时间与模型用量、候选产出与已沉淀资产；动作与整理记录行同一套
   * 语义（captureActionButtons），标题可回来源会话。 */
  /* 整理结果区（2026-09-15 详情页改造）：三态——有候选（结构化卡 + 证据
   *  映射到时间线消息）/ 进行中 / 无候选（模型理由 + 筛选原因白话）。 */
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

  function captureResultSection(capture, messageBySourceId) {
    const vocab = NS.vocabulary;
    const candidates = (Array.isArray(capture.candidateIds) ? capture.candidateIds : [])
      .map((id) => (Array.isArray(S.candidates) ? S.candidates : []).find((row) => String(row.id) === String(id)))
      .filter(Boolean);
    const running = ['queued', 'extracting', 'writing', 'waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled'].includes(String(capture.status));
    // 三分呈现（2026-09-15 子安口径；2026-09-28 两页重整改：内嵌确认表单删除，
    //  待确认候选改为「候选摘要 + 去待我处理」——确认动作收敛到待我处理页，
    //  不在整理详情就地编辑）：
    //  - 待确认候选 → 结果区一行摘要（标题 · 数量）+「去待我处理」按钮；
    //  - 已保存候选 → 成果在「已沉淀资产」区（含完整 statement），结果区不重复；
    //  - 未保存候选（拒绝/忽略/过期）→ 结果区展示**完整内容块**（判断全文 +
    //    类型/作用域 + 证据映射 + 未保存标记）——"不保存之后也要看得到
    //    当时整理出的具体内容"，不再只剩一行截断标题。
    const pendingCandidates = candidates.filter((candidate) => NS.candidate.pending(candidate));
    // 待确认也出完整内容块（2026-09-29 子安：只给一行摘要+跳转=具体内容在
    // 详情页和大队列页都找不到）；块可点，open-candidate 深链直达该条的
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
            ${chip(categoryLabel(candidate.suggestedType))}
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
    } else if (running) {
      body = `<div class="note">${esc(T('cognition.capture_detail_result_pending', '整理还在进行，完成后这里会列出从这段对话发现的内容。'))}</div>`;
    } else {
      const modelReason = String(capture.noCandidateReason || '').trim();
      const filterText = vocab && capture.filterReason ? vocab.captureFilterReasonText(capture.filterReason) : '';
      body = `
      ${empty(T('cognition.capture_detail_result_none_title', '没有发现值得留存的内容'))}
      ${filterText ? `<div class="note">${esc(T('cognition.capture_detail_filter_label', '筛选原因'))}：${esc(filterText)}</div>` : ''}
      ${modelReason ? `<blockquote class="ca-quote">${esc(modelReason)}</blockquote>` : ''}`;
    }
    /* 单卡版式（2026-09-29 与建议详情统一）：分区不再各包一张 card 散在外面，
     * 统一收进主体卡内做分节（分隔线区隔）——整页=页头 + 一张完整内容卡，
     * 与建议详情同构。 */
    return `<div class="ca-capture-sec">${sectionHead(T('cognition.capture_detail_result_title', '整理结果'))}${body}</div>`;
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
    // 卡头状态三态（2026-09-15 子安口径）：已完成 · 已保存（有沉淀资产）/
    // 已完成 · 未保存（候选被拒且无资产）/ 原状态文案。文案复用候选状态键。
    const settledRows = (Array.isArray(capture.candidateIds) ? capture.candidateIds : [])
      .map((id) => (Array.isArray(S.candidates) ? S.candidates : []).find((row) => String(row.id) === String(id)))
      .filter(Boolean);
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
    // 已沉淀资产（2026-09-15 合并卡 + 内联内容）：直接展示沉淀的正文
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
    /* 整页版式（2026-09-29 与建议详情统一）：页头 = 返回行 + 固定标题
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

  /** 卡底一行（2026-09-29 子安拍板）：五步进度条靠左、操作按钮靠右，同一行；
   *  窄窗放不下时按钮换行到进度条下方、仍右对齐（actions-right 的 auto 边距）。
   *  动线=先看状态与内容，最后是过程与操作。 */
  function captureActionButtonsHtml(capture) {
    return `<div class="actions actions-right">
      ${captureActionButtons({ ...capture, actions: (capture.actions || []).filter((action) => action !== 'review_candidates' && action !== 'view_assets') })}
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
    return [route.name, route.assetId, route.candidateId, route.captureId, route.category, route.captureBucket, route.experienceId].join('|');
  }

  function render(opts) {
    const options = opts || {};
    const root = document.getElementById('ca-root');
    if (!root) return;
    let route = S.route;
    // 旧深链归一化（specs/018；experiences/kstar 档为 specs/017）：router.go 已在
    // 入栈前归一，这里兜住直接写 store 的路径（持久化恢复/测试装配）。只归一
    // 渲染视角、不回写 store。
    if (route.name === 'organize') route = Object.assign({}, route, { name: 'activity' });
    else if (route.name === 'organize-settings') route = Object.assign({}, route, { name: 'settings' });
    else if (route.name === 'experiences') route = Object.assign({}, route, { name: 'overview', category: route.category || 'experiences' });
    if (route.category === 'kstar') route = Object.assign({}, route, { category: '' });
    const key = routeKey(route);
    const previousScroll = document.getElementById('ca-scroll');
    const sameRoute = lastRenderKey === key && !!previousScroll;
    const restoreScroll = sameRoute ? previousScroll.scrollTop : 0;
    const disclosureSelectors = ['.ca-asset-page .ca-detail-history', '.ca-asset-page .ca-detail-governance', '.ca-asset-page .ca-asset-edit-advanced', '.ca-asset-page .ca-stale-pin-detail'];
    const openDisclosures = route.assetId && sameRoute && typeof previousScroll.querySelector === 'function'
      ? disclosureSelectors.filter((selector) => previousScroll.querySelector(selector)?.open)
      : [];
    lastRenderKey = key;
    // 候选详情归「待我处理」、整理详情与大扫除报告归「系统活动」；
    // interactive-tour 靠 data-cognition-page-link="assets"/"captures" 定位 tab。
    // 六个顶级入口（树 / 本体 / 我的认知 / 待我处理 / 系统活动 / 设置）；
    // activity（captureId、cleanup 报告深链归并）；未知路由回到我的认知。
    const activeTab = route.name === 'review' || route.candidateId ? 'review'
      : route.name === 'activity' || route.name === 'cleanup' || route.captureId ? 'activity'
        : route.name === 'settings' ? 'settings'
          : route.name === 'ontology' ? 'ontology'
            : route.name === 'tree' ? 'tree' : 'overview';
    // 详情子界面（资产/经验/整理详情、整理报告）也走整页版式；候选详情
    // 复用 review 工作台的全宽态（候选卡类名同一套）。
    const isDetailRoute = Boolean(route.assetId || route.experienceId || route.candidateId
      || (route.name === 'activity' && route.captureId) || route.name === 'cleanup');
    const layoutView = activeTab === 'ontology' || activeTab === 'settings' ? activeTab
      : activeTab === 'overview' && !route.assetId && !route.experienceId ? 'overview'
        : activeTab === 'review' && !route.candidateId ? 'review'
          : activeTab === 'activity' && route.name === 'activity' && !route.captureId ? 'activity'
            : isDetailRoute ? 'detail' : '';
    const layoutClass = layoutView ? ` ca-layout-${layoutView}` : '';
    const pendingCount = Number(NS.stats().pending || 0);
    const tabsInner = NS.TABS.map((tab) => {
      const active = activeTab === tab.id;
      const extra = tab.id === 'overview' ? ' data-cognition-page-link="assets"' : (tab.id === 'activity' ? ' data-cognition-page-link="captures"' : '');
      // 2026-09-15 子安要求：tab 只留标题，描述小字与 title 悬浮注释删除。
      // 待确认计数走原型 .bdg 角标（原型只在「待我处理」上挂）。
      const badge = tab.id === 'review' && pendingCount ? `<span class="bdg">${pendingCount}</span>` : '';
      return `<div class="ca-tab${active ? ' is-on' : ''}" data-act="tab" data-id="${tab.id}"${extra} ${roleBtn()}>
        <strong>${esc(T(tab.titleKey, tab.title))}</strong>${badge}
      </div>`;
    }).join('');
    let body = '';
    if (S.loading && !S.loaded) {
      // 首载骨架：结构化的三行占位（shimmer 由 CSS 驱动），比纯文字更快有页面感。
      body = `<div class="ca-loading"><div class="ca-skel-row"></div><div class="ca-skel-row"></div><div class="ca-skel-row"></div></div>`;
    } else if (route.name === 'ontology') body = viewOntology(route);
    else if (route.name === 'review') body = NS.viewReview(route);
    else if (route.name === 'activity') body = route.captureId ? viewCaptureDetail(route) : viewOrganizeTasks(route);
    else if (route.name === 'cleanup') body = viewCleanup(route);
    else if (route.name === 'settings') body = viewOrganizeSettingsPage();
    else if (route.name === 'tree') body = viewTree(route);
    else body = viewOverview(route);
    const errorBanner = S.errors.length && S.loaded
      ? `<div class="ca-banner">${esc(T('cognition.partial_load', '部分数据读取失败，页面已用可用数据渲染。'))}${btn(T('common.retry', '重试'), 'refresh', { small: true })}</div>`
      : '';
    // 离开本体路由，或在本体路由上重渲染（数据变更触发的 notify）：
    // 都要先把 section 归还 parking——内容区即将整体替换，若不先移走，
    // 本体 DOM 会连同内部状态一起被 innerHTML 销毁，页面从此白一片
    // （Phase 3 挂载契约；2026-09-21 补「本路由重渲染」这半边）。
    const enteringOntology = route.name === 'ontology' && S.prevRouteName !== 'ontology';
    if (typeof NS.unmountPersonalOntology === 'function'
      && (S.prevRouteName === 'ontology' || route.name === 'ontology')) {
      const mountedSection = document.getElementById('skills-cognition-personal-ontology');
      if (mountedSection && route.name !== 'ontology') NS.unmountPersonalOntology();
      if (mountedSection && route.name === 'ontology') {
        // 本体路由自身重渲染：mount 点将被重建，先把区段挪出内容区，
        // 随后本渲染尾部的 mountPersonalOntology 会再次移入。
        const mountEl = document.getElementById('ca-ontology-mount');
        if (mountEl && mountedSection.parentElement === mountEl) NS.unmountPersonalOntology();
      }
    }
    S.prevRouteName = route.name;
    // 持久页面壳（2026-09-21 认知页签迁移）：ca-app 结构只建一次，此后每次
    // 渲染只更新页签态、横幅与内容区——壳不重建，事件委托与 tab 焦点稳定，
    // 本体挂载节点也不会被无谓地拔掉。语言切换等需要换壳文案时传 rebuild。
    // 壳节点用 id 取：测试沙箱只实现字符串级 innerHTML（getElementById 恒
    // null）时自然退回整串写入，两边行为一致。
    const tabsNav = document.getElementById('ca-tabs-nav');
    const bannerSlot = document.getElementById('ca-banner-slot');
    const main = document.getElementById('ca-scroll');
    // 树页/本体页是「整页高度」型：滚动容器不收滚动、改由页面自己占满
    //（原型 .tree-stage/.onto-page 都是整屏高度，不随内容滚）。
    const stageScroll = route.name === 'tree' || route.name === 'ontology';
    // .wrap 统一管理内容区的内边距；主工作页通过 ca-layout-* 路由态铺满可用宽度，
    // 不参与这些布局的详情页继续沿用默认阅读栏宽度。
    if (!stageScroll) body = `<div class="wrap">${body}</div>`;
    // 标签弹层槽位（specs/012 T012「更多」/T013 管理）：放在持久壳层（不随
    // 内容区 innerHTML 重渲染被拔掉），内容由 render 按 route.tagOverlay 维护；
    // 接线（焦点圈/Escape/滚动锁）在 core.wireTagOverlay，由 app.js 渲染后调用。
    const tagOverlaySlotHtml = tagOverlayHtml(route);
    if (options.rebuild || !tabsNav || !bannerSlot || !main) {
      root.innerHTML = `
        <div class="ca-app">
          <nav class="ca-tabs" id="ca-tabs-nav">${tabsInner}</nav>
          <div class="ca-banner-slot" id="ca-banner-slot">${errorBanner}</div>
          <div class="ca-tag-overlay-slot" id="ca-tag-overlay-slot">${tagOverlaySlotHtml}</div>
          <div class="ca-scroll${stageScroll ? ' is-stage' : ''}${layoutClass}" id="ca-scroll">${body}</div>
        </div>`;
      lastTagOverlaySlotHtml = tagOverlaySlotHtml;
    } else {
      tabsNav.innerHTML = tabsInner;
      bannerSlot.innerHTML = errorBanner;
      // 测试沙箱的 getElementById 返回裸对象（只有 innerHTML，没有 classList）：
      // 取不到就跳过切类，与上面的「退回整串写入」同一条守则。
      if (main.classList) {
        main.classList.toggle('is-stage', stageScroll);
        ['overview', 'ontology', 'review', 'activity', 'settings', 'detail'].forEach((layout) => {
          main.classList.toggle(`ca-layout-${layout}`, layoutView === layout);
        });
      }
      main.innerHTML = body;
      // 弹层只在内容变化时重写（对照模块级记录串，见文件头注释），保住打开中的
      // overlay 节点与焦点。slot !== root 是测试沙箱防呆：简化夹具的
      // getElementById 对任何 id 都返回根节点，真机槽位是根的子孙、永不相等——
      // 不相等才允许写。
      const slot = document.getElementById('ca-tag-overlay-slot');
      if (slot && slot !== root && lastTagOverlaySlotHtml !== tagOverlaySlotHtml) {
        slot.innerHTML = tagOverlaySlotHtml;
        lastTagOverlaySlotHtml = tagOverlaySlotHtml;
      }
    }
    const scrollRoot = document.getElementById('ca-scroll');
    if (route.assetId && scrollRoot && typeof scrollRoot.querySelector === 'function') {
      for (const selector of openDisclosures) {
        const disclosure = scrollRoot.querySelector(selector);
        if (disclosure) disclosure.open = true;
      }
    }
    if (scrollRoot && restoreScroll) scrollRoot.scrollTop = restoreScroll;
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
    if (route.name === 'ontology' && typeof NS.mountPersonalOntology === 'function') {
      void NS.mountPersonalOntology({ resetToOverview: enteringOntology });
    }
    // 标签弹层接线（specs/012 T012/T013）：DOM 刚写完，就地过 uiModalController
    //（onChange 监听器注册顺序早于 boot 的渲染监听，不能放 app.js 的 notify 里）。
    if (typeof NS.wireTagOverlay === 'function') NS.wireTagOverlay();
  }
  NS.render = render;
  // 共享渲染件（2026-09-20 本体界面重构）：个人本体页复用资产页同一套
  // 章/行形态。只有 IIFE 顶层的件可导出——plainRow/catalogRow 定义在
  // render 内部（闭包捕获每帧状态），不在此列。
  // resolveSourceRef 一并导出（2026-09-25 US-603）：五处来源展示与用例都
  // 认这一份解析结果，避免测试各自复制一套判据。
  NS.ui = { chip, assetStatusChip, resolveSourceRef, evidenceChip, btn, roleBtn, hero, empty, sectionHead, termNote, otherActions, CATEGORIES, categoryLabel, evidenceChipParts, isKstarEvidenceRef, isLiveKstarEvidenceRef, evidenceGroupsHtml, stripMarkdown, attributionLabel, sourceRefKind, sourceIndex, reviewOutcomeText, stripInternalIds, foldValue, kstarEpisodeSection };
})();
