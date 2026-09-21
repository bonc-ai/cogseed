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

  const CATEGORIES = [
    ['personal', 'cognition.asset_category_personal', '关于我'],
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
  /** 详情页头部章（2026-09-17 用户视角重构）：正常状态（active）不摆任何
   *  章——自己确认过的资产不需要解释；只有异常状态（暂停/删除/撤回等）
   *  才出章提醒。成熟度章只在列表行显示（快速识别），不进详情头部。 */
  const detailStatusChip = (asset) => {
    const status = String(asset.status || 'active');
    if (status === 'active') return '';
    const entry = ASSET_STATUS[status];
    const [label, tone] = entry ? [entry[0](), entry[1]] : [status, ''];
    return chip(label, tone);
  };

  /** 来源目录索引：证据 chip 的解析与"多数不可用"判断共用这一份。 */
  function sourceIndex() {
    const index = new Map();
    for (const group of S.sources) {
      for (const item of (Array.isArray(group.items) ? group.items : [])) {
        if (item && item.id) index.set(String(item.id), item);
      }
    }
    return index;
  }
  // 来源三态（2026-09-20 修复「来源已删」误判）：available=目录命中/整理中；
  // immediate=对话中当场记（无独立会话出处——不是被删，诚实标注不计弱证据）；
  // unavailable=目录查无（引用的会话已不存在或无处核对）。
  function sourceRefKind(ref) {
    if (!ref) return 'unavailable';
    const title = String(ref.title || ref.conversationTitle || ref.name || '').trim();
    if (title) return 'available';
    const id = String(ref.id || ref.conversationId || ref.ref || '').trim();
    if (!id) return 'unavailable';
    if (id.startsWith('immediate-')) return 'immediate'; // 存量合成 id（渲染兼容）
    const item = sourceIndex().get(id);
    if (item && String(item.title || '').trim()) return 'available';
    if (item && (item.status === 'pending' || item.status === 'processing')) return 'available';
    return 'unavailable';
  }
  // 「对话中记」候选身份：captureKey `immediate-` 前缀（新）或引用 id 的
  // `immediate-` 前缀（存量）——两个信号源同前缀。
  function isImmediateCandidate(candidate) {
    if (candidate && typeof candidate.captureKey === 'string' && candidate.captureKey.startsWith('immediate-')) return true;
    return evidenceRefs(candidate).some((ref) => String(ref && ref.id || '').startsWith('immediate-'));
  }
  function sourceRefUnavailable(ref) {
    return sourceRefKind(ref) === 'unavailable';
  }
  function evidenceRefs(candidate) {
    return candidate.evidenceRefs || candidate.sourceRefs || [];
  }
  // 归组口径：按 id 去重（sourceRefs/evidenceRefs 存储上就是同内容双份），
  // 且「对话中当场记」不计弱证据——只有目录真查无的才算。
  function evidenceMostlyUnavailable(candidate) {
    const refs = evidenceRefs(candidate);
    if (!refs.length) return false;
    const seen = new Set();
    let unavailable = 0;
    let total = 0;
    for (const ref of refs) {
      const id = String(ref && (ref.id || ref.conversationId || ref.ref) || '').trim();
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      total += 1;
      if (sourceRefKind(ref) === 'unavailable') unavailable += 1;
    }
    if (!total) return false;
    return unavailable * 2 > total;
  }
  const evidenceChip = (ref) => {
    // 证据条目按类型说人话（2026-09-17，子安"看不懂"口径）：此前裸问句
    // （任务目标摘要）、裸会话名、以及两条「来源记录不可用」并排——没有
    // 一条说得出自己是什么。现在每类带类型前缀；"不可用"只在补不出任何
    // 类型时兜底。
    // 来源诚实状态（2026-09-17 审查补回）：详情页证据区此前把"来源已
    // 删/整理中"吞成泛化 chip——不可读就明说不可读（防裸 id 的底线之上
    // 还要可诊断），整理中如实说整理中。
    const refId = String(ref.id || '');
    const refKind = sourceRefKind(ref);
    if (refKind === 'immediate') return chip(T('cognition.evidence_immediate_note', '对话中当场记（无独立会话出处）'), 'line');
    if (refKind === 'unavailable') return chip(T('cognition.source_unavailable_label', '来源记录不可用'), 'line');
    const catalogItem = sourceIndex().get(refId);
    if (catalogItem && !String(catalogItem.title || '').trim()
      && ['pending', 'processing'].includes(String(catalogItem.status || ''))) {
      return chip(T('cognition.evidence_source_processing', '来源整理中'), 'line');
    }
    const kind = String(ref.kind || '');
    if (refId.startsWith('kse-')) {
      // 来源诚实状态（2026-09-18 补 kse 支）：复盘记录已不存在时明说不可用，
      // 不给可点的假入口——两种来源：写入时解析不到被标 degraded（数据层
      // 口径），或摘要请求回来确实没有这条（历史脏数据）。「还没拉到」不在
      // 此列：读不到 ≠ 不存在。
      const settled = (S.kstarSummariesSettled || []).includes(refId);
      const summary = (S.kstarSummaries && S.kstarSummaries[refId]) || null;
      if (ref.degraded || (settled && !summary)) return chip(T('cognition.source_unavailable_label', '来源记录不可用'), 'line');
      const goal = summary && summary.goal ? String(summary.goal).slice(0, 24) : '';
      const label = T('cognition.evidence_task_review', '任务复盘：{title}', {
        title: goal || T('cognition.evidence_task_review_generic', '一次任务'),
      });
      return `<span class="tag blue chip-link" data-act="open-kstar-episode" data-id="${esc(refId)}" ${roleBtn()} title="${esc(T('cognition.kstar_episode_open_hint', '查看这次任务的复盘'))}">${esc(label)}</span>`;
    }
    if (kind === 'user_teaching_signal') return chip(T('cognition.evidence_teaching', '你的一次明确表态'), 'line');
    if (kind === 'conversation') {
      if (String(ref.subtype || '') === 'message') return chip(T('cognition.evidence_message', '对话里的一条消息'), 'line');
      const name = String(ref.title || ref.conversationTitle || sourceIndex().get(refId)?.title || '').trim()
        || String(conversationNames().get(refId) || '');
      return chip(name
        ? T('cognition.evidence_conversation_named', '对话：《{name}》', { name })
        : T('cognition.evidence_conversation_generic', '一段对话'), 'line');
    }
    const loose = String(ref.title || ref.conversationTitle || ref.name || sourceIndex().get(refId)?.title || '').trim();
    return chip(loose || T('cognition.evidence_fallback', '来源记录'), 'line');
  };
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
   *  一组，各带一句来源说明——两线证据混排一排正是"杂揉"观感的来源。 */
  const evidenceGroupsHtml = (refs) => {
    const kstar = refs.filter(isKstarEvidenceRef);
    const chat = refs.filter((ref) => !isKstarEvidenceRef(ref));
    const group = (titleKey, title, hintKey, hint, list) => list.length
      ? `<div class="evgroup">
          <div class="evgroup-title">${esc(T(titleKey, title))}<span class="note">${esc(T(hintKey, hint))}</span></div>
          <div class="chips">${list.map(evidenceChip).join('')}</div>
        </div>`
      : '';
    return group('cognition.evidence_group_kstar', 'KSTAR 任务复盘', 'cognition.evidence_group_kstar_hint', '任务完结后 KSTAR 复盘学到的', kstar)
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

  const candidatePending = (candidate) => !!(candidate.capabilities && candidate.capabilities.countsAsPending);
  /** 候选来源徽章（2026-09-16 KSTAR 融合）：三条产出线可辨——KSTAR 复盘
   *  （learningSignal/learningProvenance）、KSTAR 偏好（source=preference_scan，
   *  确定性扫描线）、会话整理（capture 线，无信号）。KSTAR 两条线的徽章
   *  文案必须带 "KSTAR" 前缀（子安口径：用户可辨，不接受裸"任务复盘"）。 */
  function candidateSourceBadge(candidate) {
    const signal = candidate.learningSignal;
    if (signal && String(signal.source || '') === 'preference_scan') {
      return chip(T('cognition.source_pref_scan', 'KSTAR 偏好'));
    }
    if (signal || candidate.learningProvenance) return chip(T('cognition.source_kstar_review', 'KSTAR 复盘'));
    if (isImmediateCandidate(candidate)) return chip(T('cognition.source_immediate', '对话中记'));
    return chip(T('cognition.source_capture', '会话整理'));
  }
  /** KSTAR 候选的复盘依据块（2026-09-16）：预期/实际/结果四行——知道"这条
   *  是从哪次成败学来的"，确认保存才心里有底。 */
  function reviewSignalBlock(candidate) {
    const signal = candidate.learningSignal;
    const provenance = candidate.learningProvenance;
    if (!signal && !provenance) return '';
    const outcomeText = {
      better_than_expected: T('cognition.review_outcome_better', '比预期好'),
      met_expected: T('cognition.review_outcome_met', '符合预期'),
      worse_than_expected: T('cognition.review_outcome_worse', '比预期差'),
      unclear: T('cognition.review_outcome_unclear', '结果不明'),
    }[String(signal && signal.outcome || '')] || String(signal && signal.outcome || '');
    const row = (label, value) => value ? `<div class="meta-item"><span class="meta-k">${esc(label)}</span><span class="meta-v">${esc(String(value).slice(0, 200))}</span></div>` : '';
    return `<div class="sect-block">
      <div class="tt">${esc(T('cognition.review_signal_title', '复盘依据'))}</div>
      <div class="meta-row">
        ${row(T('cognition.review_signal_expected', '期望的结果'), stripMarkdown(signal && signal.expectedResult))}
        ${row(T('cognition.review_signal_actual', '实际发生'), stripMarkdown(signal && signal.actualResult).slice(0, 160))}
        ${row(T('cognition.review_signal_outcome', '结果'), outcomeText)}
        ${row(T('cognition.review_signal_attribution', '为什么'), attributionLabel(provenance && provenance.attribution))}
      </div>
    </div>`;
  }
  /** 待确认口径（2026-09-16 B1 统一）：需要用户判断且未被"稍后处理"静音。
   *  统计卡与全局 stats 共用这一份（单一事实源），杜绝 7/5/0 三数分叉；
   *  deferred 行仍在列表可见（子安口径：与待确认同形态），只是不占
   *  "等待确认"名额并带「已稍后处理」标注。 */
  const candidateAwaiting = (candidate) => candidatePending(candidate) && !(candidate.capabilities && candidate.capabilities.isSnoozed);
  /** 候选显示名（2026-09-16 修）：优先模型提炼的 summary 短标题——此前
   *  judgment 截断 60 字优先，卡片名成了"内容前缀"看不懂；无 summary 的
   *  存量候选用类别 + 判断前 12 字克制兜底，两者皆空给未命名。 */
  const candidateTitle = (candidate) => {
    const summary = String(candidate.summary || '').trim();
    if (summary) return summary.length > 24 ? `${summary.slice(0, 24)}…` : summary;
    const judgment = String(candidate.judgment || '').trim();
    if (judgment) {
      const label = categoryLabel(candidate.suggestedType);
      return `${label ? `${label} · ` : ''}${judgment.slice(0, 12)}${judgment.length > 12 ? '…' : ''}`;
    }
    return T('cognition.candidate_untitled', '未命名候选');
  };

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
  /* 垂直轴 = 处理梯度：土壤（来源与整理）→ 根（待确认候选）→ 干（个人本体）
     → 枝（四类资产）→ 冠（已验证）。层级语义（2026-09-21 原型 v7 契约）：
     枝端光斑 = 大方向分类；叶片 = 细分方向（家族组名 → 标题冒号前主题 →
     标题，同方向合并计数）；单条资产不渲染成光斑——树上没有资产级节点，
     树冠/根部各只有一个聚合光斑。视觉走 Organic Biophilic：贝塞尔枝、
     径向渐变光斑、锥形树干；SVG viewBox 自适应，无需手动 resize 重绘。 */

  /** 叶片方向派生 + 同方向合并计数。返回 [[方向名, n], ...]（按量降序）。
   *  取名口径与原型一致：优先族名，其次标题冒号/箭头前的头段。 */
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
       承载「已验证 N」（与枝牌同一视觉语言），整冠可点=已验证资产。 */
    const crownTitle = T('cognition.tree_crown_validated', '已验证 {n}', { n: String(validated) });
    const pillY = crownCy - 20;
    g += `<g class="spot" ${roleBtn(`data-act="open-overview" data-title="${esc(crownTitle)}" data-sub="${esc(T('cognition.tree_crown_sub', '点击进入已验证资产'))}" aria-label="${esc(crownTitle)}"`)}>
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
      <text x="${cx}" y="${pillY + 66}" text-anchor="middle" class="crown-sub">${esc(T('cognition.tree_crown_sub', '点击进入已验证资产'))}</text>
    </g>`;

    /* 树干：有机锥形 + 竖排「个人本体」（点开=本体独立页）。 */
    g += `<path d="M ${cx - 22} ${groundY - 20} C ${cx - 25} ${groundY - 152}, ${cx - 12} ${groundY - 248}, ${cx - 9} ${trunkTop} L ${cx + 9} ${trunkTop} C ${cx + 14} ${groundY - 244}, ${cx + 25} ${groundY - 146}, ${cx + 22} ${groundY - 20} Z" fill="url(#ca-trunk-grad)"/>
      <path d="M ${cx - 8} ${groundY - 35} C ${cx - 10} ${groundY - 160}, ${cx - 4} ${groundY - 258}, ${cx - 3} ${trunkTop + 20}" class="trunk-ridge-light" stroke-width="4"/>
      <path d="M ${cx + 10} ${groundY - 70} C ${cx + 12} ${groundY - 160}, ${cx + 7} ${groundY - 265}, ${cx + 6} ${trunkTop + 60}" class="trunk-ridge-dark" stroke-width="2.5"/>
      <g class="spot" ${roleBtn(`data-act="open-ontology" data-title="${esc(T('cognition.ontology_entry_title', '个人本体'))}" data-sub="${esc(T('cognition.ontology_entry_hint', '我是谁、我怎么工作：画像与偏好的结构化整理'))}" aria-label="${esc(T('cognition.ontology_entry_title', '个人本体'))}"`)}>
        <text x="${cx + 1}" y="${groundY - 310}" text-anchor="middle" class="trunk-name">个<tspan x="${cx + 1}" dy="35">人</tspan><tspan x="${cx + 1}" dy="35">本</tspan><tspan x="${cx + 1}" dy="35">体</tspan></text>
      </g>`;
    /* 树干光斑：竖排名下方一颗绿核，给「可点」一个看得见的落点（光斑走
       spotSvg 统一形态；点击落点与树干同是 open-ontology）。 */
    g += spotSvg({
      kind: 'trunk', x: cx + 1, y: groundY - 190, r: 9, color: 'url(#ca-orb-grad)', glow: true, act: 'open-ontology',
      title: T('cognition.ontology_entry_title', '个人本体'),
      sub: T('cognition.ontology_entry_hint', '我是谁、我怎么工作：画像与偏好的结构化整理'),
      aria: T('cognition.ontology_entry_title', '个人本体'),
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
      ${spotSvg({ kind: 'root', x: cx, y: groundY - 52, r: 12, color: 'var(--amber-dot)', glow: true, act: 'go-review', title: pending ? T('cognition.tree_root_pending', '待确认 {n}', { n: String(pending) }) : T('cognition.tree_root_empty', '暂无待确认'), labelId: 'ca-root-n', tx: cx, ty: groundY - 72 })}
      <rect x="${cx - 7}" y="${groundY - 24}" width="14" height="26" class="root-collar"/>`;

    /* 土壤：会话与采集记录的来源层（点开=整理页）。 */
    g += `<g class="spot" ${roleBtn(`data-act="go-organize" aria-label="${esc(T('cognition.tree_soil_label', '土壤 · 来源 {s} · 采集 {c}', { s: String(Number(info.sources || 0)), c: String(Number(info.captures || 0)) }))}"`)}>
      <rect x="${cx - 330}" y="${groundY + 2}" width="660" height="58" rx="12" class="soil-band"/>
      <text x="${cx}" y="${groundY + 27}" text-anchor="middle" class="soil-title">${esc(T('cognition.tree_soil_label', '土壤 · 来源 {s} · 采集 {c}', { s: String(Number(info.sources || 0)), c: String(Number(info.captures || 0)) }))}</text>
      <text x="${cx}" y="${groundY + 46}" text-anchor="middle" class="soil-sub">${esc(T('cognition.tree_soil_hint', '会话与采集记录在这里生根；来源异常会出现在「待我处理」'))}</text>
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
      return T('cognition.proof_sentence_usage', '{when}，在{where}被实际使用{version}', { when, where, version });
    }
    if (kind === 'projection_confirmed') {
      return T('cognition.proof_sentence_projected', '{when}，在{where}被带入任务{version}', { when, where, version });
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

  /** 资产详情的使用记录区（原独立「使用记录」页的按资产切片）。 */
  function assetUsageSection(asset, route) {
    const items = S.proofs
      .filter((p) => String((p.refs || {}).assetId || '') === String(asset.id))
      // 只认「真实引用」事件（2026-09-17 子安口径）：什么时候在哪个对话被
      // 带入任务/被实际使用。版本保存、选用切换、治理与迁移证明这类系统
      // 操作不是使用，不进使用记录。
      .filter((p) => ['usage_recorded', 'projection_confirmed'].includes(String(p.kind || '')))
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
    const usedCount = items.filter((p) => p.kind === 'usage_recorded').length;
    const projectedCount = items.filter((p) => p.kind === 'projection_confirmed').length;
    const summaryLine = [
      usedCount ? T('cognition.proof_used_times', '被实际使用 {n} 次', { n: String(usedCount) }) : '',
      projectedCount ? T('cognition.proof_projected_times', '被带入任务 {n} 次', { n: String(projectedCount) }) : '',
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
      ? T('cognition.asset_origin_pref_scan', '来自 KSTAR 偏好')
      : T('cognition.asset_origin_kstar', '来自 KSTAR 复盘');
  }

  function assetVersionDetailBlock(asset, v, isActive, usage) {
    const snap = v.snapshot || {};
    const usageText = usage
      ? [usage.applied ? T('cognition.asset_usage_applied', '实际采用 {n} 次', { n: String(usage.applied) }) : '',
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
   *  块——单版本资产的证据也要有位置可看。 */
  function assetVersionsSection(asset) {
    const state = S.assetVersions;
    if (!state || state.assetId !== String(asset.id) || !Array.isArray(state.versions) || state.versions.length < 1) return '';
    const active = String(asset.activeVersion || asset.version || '');
    const usageByVersion = new Map((state.usage || []).map((u) => [String(u.version), u]));
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
          ? [usage.applied ? T('cognition.asset_usage_applied', '实际采用 {n} 次', { n: String(usage.applied) }) : '',
            usage.contradicted ? T('cognition.asset_usage_contradicted', '被否定 {n} 次', { n: String(usage.contradicted) }) : '']
            .filter(Boolean).join(' · ')
          : '';
        // 内容摘要（2026-09-16 用户反馈：两版只显示标题看不出差异，也看不到
        // 具体内容）——正文截 80 字进 meta，标题相同的内容差异由此可辨。
        const statement = String((v.snapshot && v.snapshot.statement) || '').replace(/\s+/g, ' ').trim();
        const statementPreview = statement.length > 80 ? `${statement.slice(0, 80)}…` : statement;
        const meta = [statementPreview, fmtDate(v.at), versionSourceLabel(v), unchangedAfter.has(String(v.version)) ? T('cognition.asset_version_unchanged', '内容未变（系统迁移/搬运）') : '', usageText].filter(Boolean).join(' · ');
        const side = isActive
          ? chip(T('cognition.asset_version_active', '在用'), 'green')
          : btn(T('cognition.asset_version_select', '切回此版'), 'select-asset-version', { id: asset.id, data: { version: String(v.version) }, small: true });
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

  /** 资产编辑表单（2026-09-17 报告建议 A）：预填在用版现值；保存产生新
   *  版本（core.editAsset 先比对，无实际修改不提交——后端相同内容也会
   *  bump 出空版本）。类型与范围不在此改：类型变更走候选线重审，范围
   *  自由文本会再触发 scope 迁移。 */
  function assetEditForm(asset) {
    const fieldHtml = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
    const joinList = (list) => (Array.isArray(list) ? list.join('、') : '');
    const fid = (name) => `ca-asset-edit-${name}-${esc(asset.id)}`;
    return `<div class="sect-block ca-asset-edit">
      <div class="tt">${esc(T('cognition.asset_edit_title', '编辑资产'))}</div>
      <p class="note">${esc(T('cognition.asset_edit_hint', '保存后会产生一个新版本；当前内容仍完整保留在版本记录里。'))}</p>
      ${fieldHtml(T('cognition.asset_edit_field_title', '标题'), window.uiInput({ id: fid('title'), value: String(asset.title || ''), attrs: { 'data-f': 'title' } }))}
      ${fieldHtml(T('cognition.asset_edit_field_statement', '正文'), window.uiTextarea({ id: fid('statement'), value: String(asset.statement || ''), attrs: { 'data-f': 'statement' } }))}
      ${fieldHtml(T('cognition.asset_edit_field_applicable', '适用场景（多条用顿号分隔）'), window.uiInput({ id: fid('applicable'), value: joinList(asset.applicableWhen), attrs: { 'data-f': 'applicable' } }))}
      ${fieldHtml(T('cognition.asset_edit_field_forbidden', '禁用场景（多条用顿号分隔）'), window.uiInput({ id: fid('forbidden'), value: joinList(asset.forbiddenWhen), attrs: { 'data-f': 'forbidden' } }))}
      ${fieldHtml(T('cognition.asset_edit_field_visible_agents', '谁能看见·Agent（id 用顿号分隔，留空＝不限制）'), window.uiInput({ id: fid('visible-agents'), value: joinList(asset.scopePolicy && asset.scopePolicy.agentIds), attrs: { 'data-f': 'visible-agents' } }))}
      ${fieldHtml(T('cognition.asset_edit_field_visible_spaces', '谁能看见·空间（id 用顿号分隔，留空＝不限制）'), window.uiInput({ id: fid('visible-spaces'), value: joinList(asset.scopePolicy && asset.scopePolicy.workspaceIds), attrs: { 'data-f': 'visible-spaces' } }))}
      <div class="actions actions-right">
        ${btn(T('common.cancel', '取消'), 'asset-edit-cancel', { id: asset.id })}
        ${btn(T('cognition.asset_edit_save', '保存为新版本'), 'asset-edit-save', { id: asset.id, primary: true })}
      </div>
    </div>`;
  }

  function assetDetail(asset, route) {
    // 编辑态（2026-09-17 报告建议 A）：正文区替换为编辑表单——改自己写的
    // 话不该以"系统先产候选"为前提；保存走 recall.assets.update（+1 版本，
    // 与候选采纳产出的版本同链）。类型与范围不在表单里：类型变更走候选线
    // 重审，范围自由文本会再触发 scope 迁移产空版本。
    // 资产级状态与开关贴着标题（2026-09-17 二改，子安红线口径）：标题右侧
    // 放总开关、标题下方一句实时生效说明——资产级信息归顶部（正文是内容、
    // 不是状态说明的挂载点）。异常态（删除/归并）仍走下方独立块。
    const editing = !!route.assetEdit && ['active', 'paused'].includes(String(asset.status || 'active'));
    const statusKind = String(asset.status || 'active');
    const statusOn = statusKind === 'active';
    const switchable = statusKind === 'active' || statusKind === 'paused';
    const switchEl = window.uiSwitch({
      label: T('cognition.asset_switch_label', '自动带入新任务'),
      checked: statusOn,
      attrs: {
        'data-act': 'asset-action',
        'data-id': asset.id,
        'data-action': statusOn ? 'pause' : 'resume',
      },
    });
    const switchHint = statusOn
      ? T('cognition.asset_switch_on_hint', '使用中：这条资产会自动带入你的新任务，作为背景知识提供给 AI')
      : T('cognition.asset_switch_off_hint', '已暂停：新任务不再自动带入这条资产；历史与使用记录全部保留，随时可打开');
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
    return `
    ${btn(T('cognition.asset_back', '← 返回列表'), 'go-back', { className: 'backlink' })}
    <div class="card ca-asset-detail">
      <div class="rowline">
        <div>
          <h1>${esc(asset.title || asset.id)}</h1>
          ${switchable ? `<div class="sub">${esc(switchHint)}</div>` : ''}
        </div>
        <div class="right">${switchable ? switchEl : detailStatusChip(asset)}${['active'].includes(String(asset.status || 'active')) ? btn(T('cognition.asset_use_in_chat', '用到当前对话'), 'asset-use-in-chat', { id: asset.id, small: true }) : ''}</div>
      </div>
      ${editing ? assetEditForm(asset) : `<p class="content-text">${esc(asset.statement || '')}</p>`}
      ${topControl}
      ${(() => {
        /* 推荐卡：recommendedAction 数据存在时渲染（系统建议暂停/返工 + 知道了） */
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
      })()}
      ${(() => {
        /* 证据引用块：evidenceRefs 列表，KSTAR 前缀蓝标、其余灰标 */
        const refs = (asset.evidenceRefs || []).map((ref) => {
          if (ref && typeof ref === 'object') return String(ref.id || ref.ref || '');
          return String(ref || '');
        }).filter(Boolean);
        if (!refs.length) return '';
        const rows = refs.map(function (refId) {
          const isKstar = refId.startsWith('kse-');
          const tag = isKstar
            ? '<span class="tag blue">KSTAR</span>'
            : '<span class="tag gray">来源</span>';
          return '<div class="evrow">' + tag + '<span style="flex:1">' + esc(refId) + '</span></div>';
        }).join('');
        return '<div class="sect-block"><div class="sub"><strong>' + esc(T('cognition.asset_evidence_section', '证据引用')) + '</strong><span class="note">' + String(refs.length) + '</span></div>' + rows + '</div>';
      })()}
      ${assetVersionsSection(asset)}
      ${assetUsageSection(asset, route)}
      ${(() => {
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
        };
        const auditRows = Array.isArray(asset.audit) ? asset.audit : [];
        const rows = auditRows.slice(0, 12);
        if (!rows.length) return '';
        const items = rows.map(function (row) {
          const label = AUDIT_ACTION_LABELS[String(row.action)] || String(row.action);
          const note = row.note ? ' · ' + esc(row.note) : '';
          return '<div class="proc-row"><span class="when">' + esc(row.at || '') + '</span><span style="flex:1"><b>' + esc(label) + '</b>' + note + '</span></div>';
        }).join('');
        const tip = auditRows.length > 12
          ? '<div class="note" style="margin-top:6px">' + esc(T('cognition.audit_truncated', '仅显示最近 12 条；真实环境由审计流提供完整履历。')) + '</div>'
          : '';
        return '<details class="details" style="margin-top:14px"><summary>' + esc(T('cognition.audit_section', '生命周期记录')) + '</summary><div class="dbody">' + items + tip + '</div></details>';
      })()}
      <div class="ca-more-wrap">
        ${btn(T('cognition.asset_more', '更多操作'), 'toggle-asset-more', { className: 'ca-more-toggle' })}
        <div class="ca-more" data-asset-more hidden>
          ${moreRow(T('cognition.asset_delete', '删除'), T('cognition.asset_delete_hint', '从资产列表移除，历史记录保留'), 'delete')}
          ${moreRow(T('cognition.asset_revoke', '撤回使用'), T('cognition.asset_revoke_hint', '只影响未来的任务'), 'revoke')}
          ${moreRow(T('cognition.asset_purge', '彻底清除'), T('cognition.asset_purge_hint', '删除全部历史与证据，不可恢复'), 'purge')}
        </div>
      </div>
      ${assetMergeSection(asset)}
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
 *  后续轮接）；无族关系的资产归入「未归类」组。视图与筛选都保留原行为——
 *  分组只改变排列，不改变可见性。 */
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
        // 组名（2026-09-22 族可命名）：用户起的名优先；默认短名取用得最多的
        // 那条资产标题的头段。
        const namedOne = bucket.find((a) => String(a.familyName || '').trim());
        const fallback = bucket.slice().sort((a, b) => String(b.title || '').length - String(a.title || '').length)[0];
        const title = namedOne
          ? String(namedOne.familyName).trim()
          : shortName(fallback?.title);
        named.push({ title, anchorId: String(bucket[0].id), named: Boolean(namedOne), assets: bucket });
      } else {
        unsorted = unsorted.concat(bucket);
      }
    }
    named.sort((a, b) => String(b.assets.length).localeCompare(String(a.assets.length)));
    if (unsorted.length) named.push({ title: '', anchorId: '', named: false, assets: unsorted });
    return named;
  }

  /* ────────────────────────── 视图:认知树(独立页) ────────────────────────── */
  /* 2026-09-21 五页签迁移:树从「我的认知」页顶部的卡片拆成独立全屏页。
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
       没有页头卡片（树的读法靠图例自解释）。 */
    return `
      <div class="tree-stage${S.loading && !S.loaded ? ' is-loading' : ''}">
        <div class="fl-top">
          <div class="ft ft-title">${esc(T('cognition.tree_panel_title', '我的认知树'))}</div>
          <div class="ft">${esc(T('cognition.tree_read_hint', '土壤 → 根芽 → 枝上大方向 → 树冠已验证 · 枝端光斑看分类，叶片看细分方向'))}</div>
        </div>
        ${treeFigure({ counts, pending: stats.pending, validated, sources: sourceCount, captures: captureCount }, directions)}
        <div class="fl-bottom">
          <div class="legend">
            <span class="k"><span class="dt" style="background:var(--green)"></span>${esc(T('cognition.tree_legend_validated', '已验证'))}</span>
            <span class="k"><span class="dt" style="background:var(--green-line)"></span>${esc(T('cognition.tree_legend_asset', '资产'))}</span>
            <span class="k"><span class="dt" style="background:var(--blue)"></span>KSTAR</span>
            <span class="k"><span class="dt" style="background:var(--amber-dot)"></span>${esc(T('cognition.tree_legend_pending', '待处理（根）'))}</span>
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

  function viewOverview(route) {
    const stats = NS.stats();
    // 两线不拆列表（2026-09-17 二次定调）：全量列表+每条 KSTAR 资产打徽章
    //（子安口径：出身标记直接带 KSTAR 字样）+ chips 里给一个「KSTAR」筛选
    // 档。已删除档保留全部（保留期恢复入口只有这一处）。
    const counts = {};
    for (const [id] of CATEGORIES) counts[id] = S.assets.filter((a) => a.type === id && !['archived', 'deleted', 'purged', 'revoked'].includes(String(a.status || 'active'))).length;
    // 每个资产的最近使用时间（时间线里 occurredAt 的最大值）：列表行此前
    // 硬编码「最近无使用记录」，被真实复用过的资产也这么显示（终审修）。
    const lastUseByAsset = new Map();
    for (const proof of S.proofs) {
      const assetId = String((proof.refs || {}).assetId || '');
      const at = String(proof.occurredAt || '');
      if (!assetId || !at) continue;
      const current = lastUseByAsset.get(assetId);
      if (!current || at > current) lastUseByAsset.set(assetId, at);
    }
    const lastUseText = (assetId) => {
      const at = lastUseByAsset.get(String(assetId));
      return at
        ? T('cognition.asset_last_used_at', '最近使用 {when}', { when: fmtDate(at) })
        : T('cognition.asset_last_use', '最近无使用记录');
    };
    /* 「当前任务选用」卡已撤（2026-09-21 子安决策）：modelSelectedAssetIds
       是最近确认投影的并集，撑不起「当前任务」的语义；模型挂载的可见性
       由对话侧投影回执卡（带完整控制）与目录视图的「模型挂着」标记承担。 */
    const heroHtml = hero(
      T('cognition.overview_title', '我的认知资产'),
      T('cognition.tree_page_hint', '这棵树是你的认知全景：土壤是记录与来源，根部是待确认的候选，枝上是正式资产，树冠是被真实复用验证过的。'),
      `${statsRow([
        [stats.confirmed, T('cognition.overview_stat_confirmed', '已确认资产'), 'g'],
        [stats.pending, T('cognition.overview_stat_pending', '待确认候选'), 'a'],
        [stats.transferOk, T('cognition.overview_stat_validated', '已验证'), 'b'],
        [stats.attention, T('cognition.overview_stat_attention', '需要关注')],
      ])}`,
    );
    if (route.assetId) {
      const asset = S.assets.find((a) => String(a.id) === String(route.assetId));
      // 详情视图不显示统计条：那是列表页的上下文，详情页只讲这一条资产
      //（使用记录已并入详情，2026-09-15）。
      if (asset) return hero(T('cognition.overview_title', '我的认知资产'), '') + assetDetail(asset, route);
    }
    // 列表口径（2026-09-17 报告建议 G，顺带修 bug）：默认视图只放正常态
    // （archived/deleted/purged/revoked 都不混进来——此前只排除 archived，
    // 已删除资产会漏进「全部」）；「已删除」单列一档，保留期内可自助恢复。
    // purged/revoked 不单列（墓碑无内容/终态）。
    const HIDDEN_STATUS = ['archived', 'deleted', 'purged', 'revoked'];
    const deletedCount = S.assets.filter((a) => String(a.status || 'active') === 'deleted').length;
    const kstarCount = S.assets.filter((a) => !HIDDEN_STATUS.includes(String(a.status || 'active')) && NS.isKstarAsset(a)).length;
    const filtered = route.category === 'deleted'
      ? S.assets.filter((a) => String(a.status || 'active') === 'deleted')
      : route.category === 'kstar'
        ? S.assets.filter((a) => !HIDDEN_STATUS.includes(String(a.status || 'active')) && NS.isKstarAsset(a))
        : S.assets.filter((a) => !HIDDEN_STATUS.includes(String(a.status || 'active'))
          && (!route.category || a.type === route.category));
    const chips = [['', T('common.all', '全部'), S.assets.filter((a) => !HIDDEN_STATUS.includes(String(a.status || 'active'))).length]]
      .concat(CATEGORIES.map(([id, key, fallback]) => [id, T(key, fallback), counts[id]]))
      .concat(kstarCount ? [['kstar', T('cognition.assets_kstar_tab', 'KSTAR'), kstarCount]] : [])
      .concat(deletedCount ? [['deleted', T('cognition.assets_deleted_tab', '已删除'), deletedCount]] : []);
    /** 目录视图行（2026-09-18）：把"模型看到的那份目录"原样搬到面板上——
     *  标题 + 一句话 + 类型/范围/版本/用没用过。模型看目录挑资产、用户看同一份
     *  目录核对它的判断，两边看到的是同一件事。 */
    const catalogRow = (asset) => {
      const statement = String(asset.statement || '').replace(/\s+/g, ' ').trim();
      const oneLine = statement.split(/[。！？!?]/)[0] || statement;
      const used = S.proofs.filter((proof) => proof.kind === 'usage_recorded'
        && String((proof.refs || {}).assetId || '') === String(asset.id)).length;
      const meta = [
        categoryLabel(asset.type),
        scopeLabelText(asset.scope),
        `v${String(asset.activeVersion || asset.version || '1')}`,
        used ? T('cognition.catalog_used_times', '用过 {n} 次', { n: String(used) }) : T('cognition.catalog_never_used', '还没用过'),
      ].join(' · ');
      return `<div class="row" data-go-asset="${esc(asset.id)}" role="button" tabindex="0">
        <div class="tw">
          <div class="tt">${esc(asset.title || asset.id)}</div>
          ${oneLine ? `<div class="catline">${esc(oneLine.slice(0, 60))}</div>` : ''}
          <div class="mm">${esc(meta)}</div>
        </div>
        <div class="sd">${(S.modelSelectedAssetIds || []).includes(String(asset.id)) ? chip(T('cognition.catalog_model_attached', '模型挂着'), 'blue') : ''}${assetStatusChip(asset)}<span class="chev" aria-hidden="true">›</span></div>
      </div>`;
    };
    const plainRow = (asset) => `
        <div class="row" data-go-asset="${esc(asset.id)}" role="button" tabindex="0">
          <div class="tw">
            <div class="tt">${esc(asset.title || asset.id)}</div>
            <!-- 行上版本号显示在用版（2026-09-17 子安实测抓出）：version 是
                 只增游标（真删不回退，防历史引用错位），删掉高版本后游标
                 停在旧值（如 v5）——用户看到的是"这条资产现在用第几版"。 -->
            <div class="mm">${esc(categoryLabel(asset.type))} · v${esc(String(asset.activeVersion || asset.version || '1'))} · ${esc(lastUseText(asset.id))}</div>
          </div>
          <div class="sd">${NS.isKstarAsset(asset) ? chip(T('cognition.asset_kstar_badge', 'KSTAR'), 'blue') : ''}${assetStatusChip(asset)}<span class="chev" aria-hidden="true">›</span></div>
        </div>`;
    const catalogView = String(route.assetView || '') === 'catalog';
    let listHtml = filtered.length
      ? filtered.map((asset) => (catalogView ? catalogRow(asset) : plainRow(asset))).join('')
      : empty(
        T('cognition.tree_empty', '还没有正式资产'),
        T('cognition.tree_empty_hint', '候选被确认为正式资产后会出现在这里；当前还没有已确认的资产。'),
        // 条件与按钮数字同口径（stats.pending），避免出现「查看 0 条」。
        stats.pending ? {
          label: T('cognition.tree_view_buds', '查看 {n} 条待确认候选', { n: String(stats.pending) }),
          attrs: { 'data-act': 'go-review' },
        } : null,
      );
    // 默认列表视图按大类分组渲染（目录视图=模型视角保持平铺）。
    if (filtered.length && !catalogView) {
      const groups = familyGroupsOf(filtered);
      listHtml = groups.map((group) => {
        const renaming = String(route.familyRename || '') === group.anchorId && group.anchorId;
        return `
        <div class="fam-hd">
          <span class="nm">${renaming
            ? `${window.uiInput({ id: `ca-family-name-${esc(group.anchorId)}`, value: esc(group.title || ''), attrs: { 'data-family-name': '1', maxlength: '40' }, className: 'litxt' })}${btn(T('common.save', '保存'), 'family-rename-save', { id: group.anchorId, className: 'rnm' })}${btn(T('common.cancel', '取消'), 'family-rename-cancel', { className: 'rnm is-muted' })}`
            : group.title
              ? `${esc(group.title)} <span class="n">${esc(T('cognition.family_group_count', '{n} 条同类', { n: String(group.assets.length) }))}</span>${group.anchorId ? btn(group.named ? T('cognition.family_rename_done', '改名') : T('cognition.family_rename', '命名'), 'family-rename', { id: group.anchorId, className: 'rnm' }) : ''}`
              : `<span class="n">${esc(T('cognition.family_unsorted', '未归类'))}</span>`}</span>
          <span class="sp"></span>
        </div>
        ${group.assets.map((asset) => plainRow(asset)).join('')}
      `;
      }).join('');
    }
    return `${heroHtml}
      ${sectionHead(
        catalogView ? T('cognition.catalog_view_title', '资产目录（模型视角）') : T('cognition.overview_list_title', '资产明细'),
        String(filtered.length),
        `${btn(catalogView ? T('cognition.catalog_view_back', '列表视图') : T('cognition.catalog_view_toggle', '目录视图'), 'asset-view', { id: catalogView ? '' : 'catalog', small: true, className: 'o' })}`,
      )}
      ${catalogView ? `<div class="note list-caption">${esc(T('cognition.catalog_view_hint', '这就是模型挑资产时看的那份目录：一行一条；要看全文点进去。'))}</div>` : ''}
      <div class="pillbox">${chips.map(([id, label, count]) => btn(`${label} ${count}`, 'filter-cat', { id, className: `chip${String(route.category || '') === id ? ' on' : ''}` })).join('')}</div>
      ${listHtml}
      ${kstarEpisodesSection(route)}`;
  }

  /* ────────────────────────── 视图：待我处理 ────────────────────────── */

  function candidateCard(candidate, broken) {
    const refs = evidenceRefs(candidate);
    const refsHtml = refs.length
      ? `<div class="c4">${esc(T('cognition.candidate_source', '来源'))}：${refs.slice(0, 4).map((ref) => {
        const refKind = sourceRefKind(ref);
        if (refKind === 'immediate') return esc(T('cognition.evidence_immediate_note', '对话中当场记（无独立会话出处）'));
        if (refKind === 'unavailable') return esc(T('cognition.source_unavailable_label', '来源记录不可用'));
        return esc(String(ref.title || ref.conversationTitle || '').trim() || T('cognition.source_resolved', '会话记录'));
      }).join(' · ')}</div>`
      : '';
    const warnHtml = broken
      ? `<div class="warn">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或选择不保存。'))}</div>`
      : '';
    // 决策动作（保存/不保存/调整）统一收在详情页：卡片整体即入口，不再放
    // 行内按钮——按钮与「点卡片进详情」的落点相冲突（用户实测反馈）。
    return `
    <div class="cand${broken ? ' is-broken' : ''}" data-act="open-candidate" data-id="${esc(candidate.id)}" role="button" tabindex="0">
      <div class="c1">${esc(candidateTitle(candidate))}<span class="chev" aria-hidden="true">›</span></div>
      <div class="c2">${chip(categoryLabel(candidate.suggestedType))}${candidateSourceBadge(candidate)}${(candidate.capabilities && candidate.capabilities.isSnoozed) ? chip(T('cognition.candidate_snoozed', '已稍后处理'), 'amber') : ''}${broken ? chip(T('cognition.candidate_evidence_weak', '来源已删'), 'amber') : chip(T('cognition.candidate_evidence_ok', '证据充足'), 'green')}</div>
      <div class="c3">${esc(String(candidate.judgment || candidate.value || '').slice(0, 220))}</div>
      ${refsHtml}${warnHtml}
    </div>`;
  }

  /** 来源异常的判定与统计（与 stats.sourceIssues 同口径）：failed，或非用户
   *  主动暂停的 paused。2026-09-15 重构：来源健康不再有常态页，异常条目
   *  就地展开在「待我处理」，健康时完全沉默。 */
  function sourceItemNeedsAttention(item) {
    // 执行失败轮次（execution_evaluation/failed）不算来源异常（2026-09-16）：
    // 它是 agent 执行失败的历史记录，不是用户能修复的数据源——进异常区只
    // 显示成 turn-哈希 + 无效重试；执行失败在对话侧已可见。
    if (String(item.kind || '') === 'execution_evaluation') return false;
    return item.status === 'failed'
      || (item.status === 'paused' && String(item.statusReason || '') !== 'source_paused');
  }
  function sourceIssueItems() {
    return S.sources
      .flatMap((group) => (Array.isArray(group.items) ? group.items : []))
      .filter(sourceItemNeedsAttention);
  }
  /** 来源异常展开区：只讲需要处理的那几条（标题/原因人话/动作）。 */
  function sourceIssuesSection(route) {
    const issues = sourceIssueItems();
    if (!issues.length) return '';
    const open = String(route.sourceIssueOpen || '') === 'open';
    if (!open) return '';
    const vocab = NS.vocabulary;
    const rows = issues.slice(0, 20).map((item) => {
      const reasonText = vocab ? vocab.sourceReasonText(item.statusReason) : '';
      // 重试只给 actions 里真支持 retry 的项（2026-09-16）：无差别给重试会让
      // 不支持重试的来源（如 actions 仅 remove）点了无效、误导用户。
      const actions = Array.isArray(item.actions) ? item.actions : [];
      const action = item.status === 'failed' && actions.includes('retry')
        ? btn(T('cognition.source_retry', '重试'), 'source-action', { id: item.id, data: { action: 'retry', kind: item.kind }, small: true })
        : item.status !== 'failed' && actions.includes('resume')
          ? btn(T('cognition.source_resume', '恢复'), 'source-action', { id: item.id, data: { action: 'resume', kind: item.kind }, small: true })
          : '';
      return `<div class="row is-flat">
        <div class="tw">
          <div class="tt">${esc(item.title || item.id)}</div>
          <div class="mm">${esc(vocab ? vocab.kindLabel(item.kind) : T('cognition.source_kind_other', '其他来源'))}${reasonText ? ` · ${esc(reasonText)}` : ''}</div>
        </div>
        <div class="sd">${action}</div>
      </div>`;
    }).join('');
    return `<div class="card">${rows}
      ${issues.length > 20 ? `<div class="sub">${esc(T('cognition.source_issues_more', '仅显示前 {n} 条', { n: '20' }))}</div>` : ''}
    </div>`;
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
        : `<div class="card">${empty(T('cognition.kstar_episodes_empty', '还没有被 KSTAR 复盘过的任务'))}</div>`;
    return `<details class="details ca-kstar-episodes"${openId ? ' open' : ''}>
      <summary>${esc(T('cognition.evidence_group_kstar', 'KSTAR 任务复盘'))}<span class="note">${esc(T('cognition.kstar_episodes_hint', '每场任务完结后 KSTAR 自动复盘：当时的任务、实际发生、为什么、学到的经验。点开看完整复盘。'))}</span></summary>
      ${body}
    </details>`;
  }

  function viewReview(route) {
    if (route.candidateId) return viewCandidate(route);
    const stats = NS.stats();
    // 两线不拆（2026-09-17 二次定调）：KSTAR 提案与对话候选同池确认，
    // 候选卡自带来源徽章（KSTAR 复盘/KSTAR 偏好/会话整理）区分出身。
    // 分组顺序（2026-09-21 原型 v7 契约）：等待确认 → 来源已删 → 证据不足
    // → 已稍后处理 → 终态折叠 → 处理记录折叠——需要行动的组永远排在
    // 低打扰组之前，分组依据全部来自后端 capabilities，不看本地 status 猜。
    const pending = S.candidates.filter(candidatePending);
    const displayState = (c) => String(((c || {}).capabilities || {}).displayState || '');
    const awaiting = pending.filter(candidateAwaiting);
    const broken = awaiting.filter(evidenceMostlyUnavailable);
    const weak = awaiting.filter((c) => !evidenceMostlyUnavailable(c) && displayState(c) === 'weak_evidence');
    const ready = awaiting.filter((c) => !evidenceMostlyUnavailable(c) && displayState(c) !== 'weak_evidence');
    const snoozed = pending.filter((c) => c.capabilities && c.capabilities.isSnoozed);
    const terminal = S.candidates.filter((c) => ['expired', 'superseded'].includes(displayState(c)) && !candidatePending(c)).slice(0, 8);
    const processed = S.candidates
      .filter((c) => ['confirmed', 'rejected', 'ignored'].includes(String(c.status || '')))
      .slice(0, 5);
    // 处理结果按真实状态如实显示——此前无论保存还是拒绝都写「已保存」，
    // 与筛选口径（confirmed/rejected/ignored 三种）不符（用户实测抓出）。
    const processedLabel = (c) => ({
      confirmed: T('cognition.candidate_status_promoted', '已保存'),
      rejected: T('cognition.candidate_status_rejected', '未保存'),
      ignored: T('cognition.candidate_status_ignored', '已忽略'),
    }[String(c.status || '')] || T('cognition.candidate_status_other', '已处理'));
    const attention = [];
    // 注：治理待办（cognition.inbox：未分级 / 规则缺边界 / 分类冲突等）曾在此
    // 列出，但新 UI 尚无资产分级与边界编辑入口——报了警却无处处理，只会
    // 制造焦虑（2026-09-14 撤下）。等治理动作入口恢复后，连同每类的动作
    // 指引一起重上。此处只保留有明确处理出口的两条。
    if (stats.sourceIssues) {
      // 来源异常就地展开（2026-09-15：来源健康无常态页，异常驱动）。
      attention.push(`<div class="notice-row" data-act="toggle-source-issues" ${roleBtn()}><span class="notice-text">${esc(T('cognition.overview_source_issues', '{count} 条来源记录需要处理', { count: String(stats.sourceIssues) }))}</span><span class="sp"></span>${btn(T('common.handle', '处理'), 'toggle-source-issues', { small: true, className: 'o' })}</div>`);
    }
    if (stats.failedTasks) {
      // 落点（2026-09-15）：重试按钮在「整理」页的任务流里。
      attention.push(`<div class="notice-row" data-act="go-organize" ${roleBtn()}><span class="notice-text">${esc(T('cognition.overview_failed_tasks', '{count} 个整理任务需要重试', { count: String(stats.failedTasks) }))}</span><span class="sp"></span>${btn(T('common.handle', '处理'), 'go-organize', { small: true, className: 'o' })}</div>`);
    }
    return `${hero(
      T('cognition.review_title', '待我处理'),
      T('cognition.inbox_page_hint', '每条只需要一个决定：保存、不保存，或稍后处理。'),
      statsRow([
        [ready.length, T('cognition.review_stat_wait', '等待确认'), 'a'],
        [broken.length, T('cognition.review_stat_evidence', '来源已删')],
        [weak.length, T('cognition.review_stat_weak', '证据不足')],
      ]),
    )}
    ${attention.length ? `<div class="notice-stack">${attention.join('')}</div>` : ''}
    ${sourceIssuesSection(route)}
    ${sectionHead(T('cognition.review_group_wait', '等待你确认'), String(ready.length))}
    <div class="note sect-note">${esc(T('cognition.review_group_wait_note', '确认后会创建 v1，并保留来源与撤销入口'))}</div>
    ${ready.length ? ready.map((c) => candidateCard(c, false)).join('') : empty(T('cognition.review_empty_wait', '当前没有等待确认的候选'), T('cognition.review_empty_wait_hint', '会话整理出候选、来源异常或整理失败时会出现在这里。'), { label: T('cognition.go_organize', '去整理会话'), attrs: { 'data-act': 'go-organize' } })}
    ${broken.length ? `${sectionHead(T('cognition.review_group_evidence', '来源已删除的候选'), String(broken.length))}<div class="note sect-note">${esc(T('cognition.review_group_evidence_note', '这些候选的原始出处已被删除；可以点开确认后仍要保存，或选择不保存'))}</div>${broken.map((c) => candidateCard(c, true)).join('')}` : ''}
    ${weak.length ? `${sectionHead(T('cognition.review_group_weak', '证据不足（先补证据）'), String(weak.length))}<div class="note sect-note">${esc(T('cognition.review_group_weak_note', '可以修改内容并补上证据后保存，或先稍后处理'))}</div>${weak.map((c) => candidateCard(c, false)).join('')}` : ''}
    ${snoozed.length ? `<details class="details fold fold-snoozed"><summary>${esc(T('cognition.review_group_snoozed', '已稍后处理'))}<span class="n">${snoozed.length}</span></summary><div class="dbody"><div class="note">${esc(T('cognition.review_group_snoozed_note', '静音中，不计入待确认'))}</div>${snoozed.map((c) => candidateCard(c, false)).join('')}</div></details>` : ''}
    ${terminal.length ? `<details class="details fold fold-terminal"><summary>${esc(T('cognition.review_group_terminal', '已失效的候选'))}<span class="n">${terminal.length}</span></summary><div class="dbody"><div class="note">${esc(T('cognition.review_group_terminal_note', '已过期或被取代，仅保留记录'))}</div>${terminal.map((c) => candidateCard(c, false)).join('')}</div></details>` : ''}
    ${processed.length ? `<details class="details fold fold-processed"><summary>${esc(T('cognition.inbox_processed_badge', '处理记录'))}<span class="n">${processed.length}</span></summary><div class="dbody"><div class="note">${esc(T('cognition.inbox_processed_hint', '按处理时间倒序，只显示已处理的决定'))}</div>${processed.map((c) => `
      <div class="vrow">
        <div class="vt"><div class="v1">${esc(candidateTitle(c))}</div>
        <div class="v2">${esc(fmtDate(c.updatedAt || c.createdAt))} · ${esc(processedLabel(c))}</div></div>
      </div>`).join('')}</div></details>` : ''}`;
  }

  /* ────────────────────────── 视图：候选详情 ────────────────────────── */

  /* 候选确认表单（2026-09-15 自 viewCandidate 抽出共享）：
   *  - candidateFormBody：纯表单区（警示/类型/判断/高级/证据+动作），
   *    供整理详情页合并进执行信息卡（外层由调用方提供 ca-candidate-detail
   *    标识——cand-type 与 readCandidateForm 靠它就近定位）；
   *  - candidateFormCard：带卡壳与标题行的完整卡（候选详情页用）。
   *  控件 id 带候选 id 后缀：一页多卡时全局 id 不重复（读取靠 [data-f]）。 */
  function candidateFormBody(candidate) {
    const refs = evidenceRefs(candidate);
    const broken = evidenceMostlyUnavailable(candidate);
    // 能力一律按主进程下发的 capability 判定，**缺失即视为只读**——与旧模块
    // "treats a candidate without capabilities as read-only instead of guessing"
    // 的口径一致。2026-09-20 统一：此前同一函数里并存三种读法（canEdit 用
    // `capabilities && …`、canPromote 用真值、canDefer/canReject 用 `!== false`），
    // 于是"capabilities 缺失"时仍会渲染出「稍后处理 / 拒绝」——正是本 PR 要消灭的
    // 那类必然失败的按钮。
    const caps = candidate.capabilities || {};
    const canEdit = !!caps.canEdit;
    const canPromote = !!caps.canPromote;
    const canDefer = !!caps.canDefer;
    const canReject = !!caps.canReject;
    const edit = canEdit;
    const field = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
    // 更新候选的差异确认卡（2026-09-16 版本组）：旧版全文对照 + 版本核对
    // 提示——任务所用版与当前在用版不一致时，确认前先核对改进对象。
    const updateDiff = (() => {
      const mutating = ['update', 'limit_scope'].includes(String(candidate.suggestedAction || ''));
      if (!mutating || !candidate.targetAssetId) return '';
      const target = S.assets.find((a) => String(a.id) === String(candidate.targetAssetId));
      if (!target) return '';
      const activeVersion = String(target.activeVersion || target.version || '1');
      const usedVersion = String(candidate.targetVersionUsed || '');
      const mismatch = usedVersion && usedVersion !== activeVersion
        ? `<div class="warn">${esc(T('cognition.candidate_version_mismatch', '核对改进对象：任务当时使用的是 v{used}，该资产当前在用 v{active}——确认这次更新应作用在当前在用版上。', { used: usedVersion, active: activeVersion }))}</div>`
        : '';
      // 融合语义说明（2026-09-22 刀二）：确认后新旧内容融合出新版本，旧版
      // 保留可切回——不让用户误以为"新内容会覆盖旧内容"。
      const fusionNote = `<div class="note">${esc(T('cognition.candidate_fusion_note', '确认后会把这段内容与下面的当前版本融合成一个新版本（旧内容保留、可随时切回），不是覆盖。'))}</div>`;
      return `${mismatch}${fusionNote}<div class="field"><span>${esc(T('cognition.candidate_current_version', '当前版本（v{n}）', { n: activeVersion }))}</span><p class="note">${esc(target.statement || '')}</p></div>`;
    })();
    // 决策动作同样按 capability 收敛（2026-09-20 修）：终态候选（confirmed /
    // rejected / ignored）的映射是 canDefer=false、canReject=false、isTerminal=true，
    // 此前这两个按钮**无条件**渲染，用户点下去必然被后端状态机拒绝——旧 skills.js
    // 模块有一条 "never renders decision actions for terminal candidates" 的用例守着，
    // 2026-09-15 #266 重写时没带过来。口径见函数开头：缺失 capabilities 即只读。
    const actionsHtml = `<div class="actions actions-right">
        ${canPromote ? btn(T('cognition.candidate_save_and_use', '保存并使用'), 'cand-adopt-with-form', { id: candidate.id, primary: true }) : ''}
        ${canDefer ? btn(T('cognition.candidate_defer_action', '稍后处理'), 'cand-decide', { id: candidate.id, data: { action: 'defer' }, className: 'o' }) : ''}
        ${canReject ? btn(T('cognition.candidate_reject', '拒绝'), 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true }) : ''}
      </div>`;
    return `
      ${broken ? `<div class="warn">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或选择不保存。'))}</div>` : ''}
      ${candidate.mergedIntoAssetId ? `<div class="note">${esc(T('cognition.candidate_merged_into', '这条与已有资产相似：确认后会并入那条资产（融合出新版本），不会另开一条。'))}</div>` : ''}
      ${reviewSignalBlock(candidate)}
      ${updateDiff}
      ${edit ? `
        ${field(T('cognition.type', '类型'), `<div class="chips">${CATEGORIES.map(([id, key, fb]) => { const on = String(candidate.suggestedType || '') === id; return `<span class="ca-chip ca-chip-opt${on ? ' is-green' : ''}" data-act="cand-type" data-id="${esc(id)}" ${roleBtn(`aria-pressed="${on ? 'true' : 'false'}"`)}>${esc(T(key, fb))}</span>`; }).join('')}</div>`)}
        ${field(T('cognition.judgment', '具体内容'), window.uiTextarea({ id: `ca-cand-judgment-${esc(candidate.id)}`, value: candidate.judgment || '', attrs: { 'data-f': 'judgment' } }))}
        <details class="details">
          <summary>${esc(T('cognition.candidate_advanced', '高级选项（通常不用改）'))}</summary>
          ${field(T('cognition.candidate_scope_label', '作用范围'), window.uiInput({ id: `ca-cand-scope-${esc(candidate.id)}`, value: candidate.suggestedScope || '', placeholder: T('cognition.candidate_scope_placeholder', '例如：仅产品工作空间'), attrs: { 'data-f': 'scope' } }))}
          <div class="note">${esc(T('cognition.candidate_scope_hint', '建议用受控词：general=跨对话通用；report/code/review/product=任务类型。自由文本在自动投影中可能匹配不上任务。'))}</div>
          ${field(T('cognition.summary', '摘要'), window.uiInput({ id: `ca-cand-summary-${esc(candidate.id)}`, value: candidate.summary || '', attrs: { 'data-f': 'summary' } }))}
        </details>
        <div class="ca-detail-foot">
          ${field(T('cognition.evidence_refs', '证据引用'), refs.length ? evidenceGroupsHtml(refs) : `<span class="note">${esc(T('cognition.candidate_no_evidence', '没有可追溯的证据引用；确认前建议先补证。'))}</span>`)}
          ${kstarEpisodeSection(S.route)}
          ${(() => {
            /* 保存并使用被能力门控关掉时必须说明原因——否则用户面前只有
               稍后/拒绝两个出口，不知道为什么不能确认（2026-09-21 真机抓出）。 */
            const capsAll = candidate.capabilities || {};
            const reasons = Array.isArray(capsAll.ineligibleReasons) ? capsAll.ineligibleReasons : [];
            if (canPromote || !reasons.length) return '';
            const lines = reasons.map((r) => NS.promotionBlockText ? NS.promotionBlockText(r) : '').filter(Boolean);
            if (!lines.length) return '';
            return `<div class="note cand-block-note">${esc(T('cognition.candidate_error_promotion_blocked', '这条候选还不够格成为正式资产：'))}${lines.map((line) => `<br>· ${esc(line)}`).join('')}<br>${esc(T('cognition.candidate_block_hint', '修改内容或类型使其合格后，「保存并使用」会自动出现。'))}</div>`;
          })()}
          ${actionsHtml}
        </div>
      ` : `
        <p class="content-text">${esc(candidate.judgment || '')}</p>
        ${field(T('cognition.candidate_scope_label', '作用范围'), `<span class="ca-v">${esc(candidate.suggestedScope || T('cognition.asset_scope_unset', '未设置'))}</span>`)}
        ${refs.length ? evidenceGroupsHtml(refs) : ''}
        ${kstarEpisodeSection(S.route)}
        ${actionsHtml}
      `}`;
  }

  function candidateFormCard(candidate) {
    const broken = evidenceMostlyUnavailable(candidate);
    /* 标题=完整 summary（不再截 24 字）：这是用户要确认的东西的名字，
       截断后「看起来没有标题」（2026-09-21 子安真机抓出）；CSS 限 3 行。 */
    const fullTitle = String(candidate.summary || candidate.judgment || T('cognition.candidate_untitled', '未命名候选')).trim();
    return `
    <div class="card ca-candidate-detail" data-cand-id="${esc(candidate.id)}" data-cand-type="${esc(candidate.suggestedType || '')}">
      <div class="cand-head">
        ${chip(T('cognition.candidate_status_pending', '待确认'), 'amber')}${chip(categoryLabel(candidate.suggestedType))}${broken ? chip(T('cognition.candidate_evidence_weak', '证据不足'), 'amber') : ''}
      </div>
      <h2 class="cand-title">${esc(fullTitle)}</h2>
      ${candidateFormBody(candidate)}
    </div>`;
  }

  function viewCandidate(route) {
    const candidate = S.candidates.find((c) => String(c.id) === String(route.candidateId));
    // 顶部「返回」按钮（原卡片底部的返回列表按钮已删，返回入口收在此处）。
    const backHtml = btn(`← ${T('common.back', '返回')}`, 'go-back', { className: 'backlink' });
    if (!candidate) {
      return `${backHtml}${hero(T('cognition.candidate_detail_title', '候选详情'), '')}${empty(T('cognition.candidate_detail_missing', '这条候选已不在待处理列表中'), '')}`;
    }
    return `${backHtml}
    ${hero(
      T('cognition.candidate_detail_title', '确认内容，也确认它该在什么范围生效'),
      T('cognition.candidate_detail_hint', '确认后会创建正式资产的第一个版本，并保留来源与撤销入口。'),
    )}
    ${candidateFormCard(candidate)}`;
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

  function viewOrganizeSettingsPage() {
    const settings = S.captureSettings || {};
    const enabled = settings.enabled !== false;
    const nightlyOn = String(settings.executionPolicy || 'manual') === 'nightly';
    const reviewAuto = String(settings.reviewPolicy || 'auto') === 'auto';
    const nightlyStart = String(settings.nightlyStart || '02:00');
    return `${btn(`← ${T('cognition.tab_organize', '整理')}`, 'go-back', { className: 'backlink' })}
    ${hero(
      T('cognition.organize_settings_title', '沉淀设置'),
      T('cognition.organize_settings_hint', '决定系统什么时候自动沉淀、沉淀出的内容要不要先经过你。'),
    )}
    <div class="card ca-setting-row">
      <div class="ca-setting-copy">
        <div class="tt">${esc(T('cognition.nightly_capture_title', '夜间自动沉淀'))}</div>
        <div class="sub">${esc(T('cognition.nightly_capture_hint', '夜间在所选时间自动整理当天结束的会话（消耗模型额度）；产出的内容进入「待我处理」，等你批准或调整。'))}</div>
      </div>
      ${nightlyOn ? `<label class="ca-setting-time"><span>${esc(T('cognition.nightly_capture_time', '开始时间'))}</span>${window.uiInput({ id: 'ca-nightly-start', type: 'time', value: nightlyStart, attrs: { 'data-act': 'nightly-time' } })}</label>` : ''}
      ${window.uiSwitch({ label: T('cognition.nightly_capture_title', '夜间自动沉淀'), checked: nightlyOn, attrs: { 'data-act': 'nightly-toggle' } })}
    </div>
    <div class="card ca-setcard">
      <div class="rowline">
        <div><div class="tt">${esc(T('cognition.capture_switch_title', '整理功能'))}</div>
        <div class="sub">${esc(T('cognition.capture_switch_hint', '在「整理」列表里挑选会话手动沉淀；只有需要你判断时才打扰你。'))}</div></div>
        <div class="right">${chip(enabled ? T('cognition.capture_switch_on', '已开启') : T('cognition.capture_switch_off', '已关闭'), enabled ? 'green' : 'line')}
          ${btn(enabled ? T('cognition.capture_toggle_off', '关闭') : T('cognition.capture_toggle_on', '开启'), 'capture-toggle', { small: true, danger: enabled, primary: !enabled })}</div>
      </div>
    </div>
    <div class="card ca-setcard">
      <div class="rowline">
        <div class="tt">${esc(T('cognition.capture_review_title', '候选怎么确认'))}</div>
      </div>
      <div class="ca-subnav">
        ${btn(T('cognition.capture_review_auto', '自动采纳'), 'capture-review-toggle', { id: 'auto', className: `chip${reviewAuto ? ' is-on' : ''}` })}
        ${btn(T('cognition.capture_review_manual', '先问我'), 'capture-review-toggle', { id: 'manual', className: `chip${!reviewAuto ? ' is-on' : ''}` })}
      </div>
      <p class="note">${esc(T(reviewAuto ? 'cognition.capture_review_auto_note' : 'cognition.capture_review_manual_note', reviewAuto ? '符合条件的候选会自动采纳（不再询问）' : '候选先进入待确认，由你决定'))}</p>
    </div>`;
  }

  /* ────────────────────────── 视图：整理（任务流 + 策略） ──────────────────────────
   * 2026-09-15 全模块重构：原「从历史会话整理」「整理记录」「设置与管理→
   * 整理方式」三处合并为一。一行 = 一个会话 × 它的整理任务（含无留存内容
   * 的静默记录）；策略收成页首抽屉；分桶筛选与批量入口保留。 */

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
        // 低价值无任务行：标题可点回看会话内容，「开始整理」位置改为
        // 「无需整理」提示（2026-09-16 子安口径：内容可看，但不再给整理入口）。
        if (excluded) {
          return `
          <div class="cap-row">
            <div class="tw"><div class="tt is-link" data-act="open-conversation" data-id="${esc(conv.id)}" ${roleBtn()} title="${esc(T('cognition.capture_action_open_conversation', '打开会话'))}">${esc(conv.title || T('cognition.evidence_conversation_generic', '一段对话'))}</div>
            <div class="mm"><span>${esc(convTime)}</span></div></div>
            <div class="sd">${excludedTag}${chip(T('cognition.capture_excluded_action_hint', '无需整理'), 'amber')}</div>
          </div>`;
        }
        return `
        <div class="cap-row">
          <div class="tw"><div class="tt">${esc(conv.title || T('chat.untitled', '未命名对话'))}</div>
          <div class="mm"><span>${esc(convTime)}</span></div></div>
          <div class="sd">${btn(T('cognition.capture_manual_history_create', '开始整理'), 'organize-conv', { id: conv.id, small: true, className: 'g' })}</div>
        </div>`;
      }
      const detailLink = `data-act="open-capture-detail" data-id="${esc(capture.id)}"`;
      const titleHtml = `<div class="tt is-link" ${detailLink} ${roleBtn()} title="${esc(T('cognition.capture_detail_open_hint', '查看整理情况'))}">${esc(vocab ? vocab.recordTitle(capture) : String(capture.conversationTitle || conv.title || T('cognition.capture_untitled_record', '未命名会话的整理')))}</div>`;
      const pending = Number(capture.reviewSummary && capture.reviewSummary.pending) || 0;
      const metaText = [
        vocab ? vocab.captureReasonText(capture.displayReason) : T('cognition.capture_display_reason_other', '原因未记录'),
        pending ? T('cognition.capture_review_count', '{n} 条待确认', { n: String(pending) }) : '',
        convTime,
      ].filter(Boolean).join(' · ');
      // 用 isRunning 判定「整理中」（仅排队/提炼/写入）：等待类显示原因
      // chip；等待手动开始的行直接给「立即整理」按钮（不必进详情页）。
      /* 低价值行（纯寒暄/未回复）不给「立即整理」——行上同时摆「纯寒暄」
         和「立即整理」是自相矛盾的口径（2026-09-21 子安抓出「界面混乱」）；
         与无任务的低价值行同款「无需整理」提示，点标题可回看内容。 */
      const primaryAction = !excluded && !isRunning(capture) && (capture.actions || []).includes('run_now')
        ? btn(T('cognition.capture_action_run_now', '立即整理'), 'capture-action', { id: capture.id, data: { action: 'run_now' }, small: true, primary: true })
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
        <div class="cap-row">
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
    return `${heroRow(
      T('cognition.tab_organize', '整理'),
      T('cognition.capture_manual_note', '整理会使用模型额度，随时可以取消'),
      btn(T('cognition.organize_settings_title', '沉淀设置'), 'go-organize-settings', { className: 'o', icon: 'settings' }),
    )}
    ${!S.captureSettings || S.captureSettings.enabled === false ? `<div class="warn">${esc(T('cognition.capture_disabled_note', '整理功能已关闭：不再开始新的整理；已创建任务和「我的认知」资产不受影响。'))}</div>` : ''}
    ${S.captureSettings && S.captureSettings.enabled !== false && retryableIds.length ? `<div class="toolbar"><div class="toolbar-right">${retryableIds.length ? btn(T('cognition.capture_batch_retry', '重试失败（{n}）', { n: String(retryableIds.length) }), 'capture-batch', { data: { batch: 'retry' }, small: true, className: 'o' }) : ''}</div></div>` : ''}
    ${(Array.isArray(S.captures) ? S.captures : []).some((c) => bucketOf(c) === 'active') ? `<div class="note toolbar-note">${esc(T('cognition.capture_running_note', '有任务正在跑：任务完成后这一页会自动更新，不用手动刷新。'))}</div>` : ''}
    <div class="pillbox"><div class="chips">${chips}</div></div>
    ${visibleRows.length ? visibleRows.map(rowHtml).join('') : empty(T('cognition.capture_tasks_empty', '暂无整理任务'), T('cognition.capture_tasks_empty_hint', '一轮会话结束后，系统会在静默期结束后创建整理任务。'), { label: T('cognition.organize_settings_title', '沉淀设置'), attrs: { 'data-act': 'go-organize-settings' } })}
    ${conversationItems.length >= 100 ? `<div class="note">${esc(T('cognition.capture_sources_truncated', '仅显示最近 100 个会话（来源拉取上限）'))}</div>` : ''}
    ${filtered.length > 5 ? `<div class="list-more">${btn(S.organizeListExpanded
      ? T('cognition.capture_list_collapse', '收起')
      : T('cognition.capture_list_expand', '查看全部 {n} 个会话', { n: String(filtered.length) }), 'toggle-organize-list', { small: true, className: 'o' })}</div>` : ''}
    <div class="note footnote">${esc(T('cognition.capture_bucket_scope_note', '口径说明：分桶按每个会话最相关的一次整理任务计算；「需要我处理」包括待确认与被暂停的记录，比「待我处理」页只数失败的口径宽；「无需沉淀」是寒暄会话或最近一轮失败且无任务的会话。'))}</div>`;
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
    // 三分呈现（2026-09-15 子安口径）：
    //  - 待确认候选 → 下方表单区（可编辑），结果区只给一行指引；
    //  - 已保存候选 → 成果在「已沉淀资产」区（含完整 statement），结果区不重复；
    //  - 未保存候选（拒绝/忽略/过期）→ 结果区展示**完整内容块**（判断全文 +
    //    类型/作用域 + 证据映射 + 未保存标记）——"不保存之后也要看得到
    //    当时整理出的具体内容"，不再只剩一行截断标题。
    const pendingEditable = candidates.filter((candidate) => candidatePending(candidate)
      && candidate.capabilities && candidate.capabilities.canEdit);
    const rejectedCandidates = candidates.filter((candidate) => !pendingEditable.includes(candidate)
      && candidate.status !== 'confirmed');
    const savedCount = candidates.length - pendingEditable.length - rejectedCandidates.length;
    let body = '';
    if (candidates.length) {
      const cardHtml = rejectedCandidates.map((candidate) => {
        const { label, tone } = captureCandidateStatus(candidate.status);
        const scope = String(candidate.suggestedScope || '').trim();
        const evidenceBits = (candidate.evidenceRefs || candidate.sourceRefs || []).map((ref) => {
          const message = messageBySourceId.get(String(ref.id || ''));
          return message
            ? `<span class="tag gray">${esc(T('cognition.capture_detail_evidence_from', '来自消息 {label} · {when}', { label: message.label, when: fmtDate(message.ts) }))}</span>`
            : evidenceChip(ref);
        }).slice(0, 6).join(' ');
        return `<div class="ca-result-item">
          <div class="ca-result-head">
            ${chip(categoryLabel(candidate.suggestedType))}
            ${scope ? `<span class="note">${esc(scope)}</span>` : ''}
            <span class="right">${chip(label, tone)}</span>
          </div>
          <p class="content-text">${esc(String(candidate.judgment || '').trim() || candidateTitle(candidate))}</p>
          ${evidenceBits ? `<div class="chips">${evidenceBits}</div>` : ''}
        </div>`;
      }).join('');
      body = `${pendingEditable.length
        ? `<div class="note">${esc(T('cognition.capture_detail_pending_hint', '发现 {n} 条待确认内容，在下方卡片中查看和确认。', { n: String(pendingEditable.length) }))}</div>`
        : ''}${cardHtml}${savedCount && !pendingEditable.length && !rejectedCandidates.length
        ? `<div class="note">${esc(T('cognition.capture_detail_saved_hint', '这次整理的内容已保存为资产（见下方「已沉淀资产」）。'))}</div>`
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
    return `<div class="card ca-result-card">${sectionHead(T('cognition.capture_detail_result_title', '整理结果'))}${body}</div>`;
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
      return `<div class="card">${sectionHead(T('cognition.capture_detail_context_title', '对话上下文'), '', signalChips)}<div class="note">${esc(hint)}</div></div>`;
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
    return `<div class="card">
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
    // 待确认候选的编辑表单块（2026-09-15 子安标注：与执行信息卡合并为一张
    // 卡，在时间/用量/动作之下显示）。外层带 ca-candidate-detail 标识但不带
    // card——cand-type 与 readCandidateForm 靠 closest 就近定位，多候选时
    // 各块互不串值。
    const pendingFormBlocks = (Array.isArray(capture.candidateIds) ? capture.candidateIds : [])
      .map((id) => (Array.isArray(S.candidates) ? S.candidates : []).find((row) => String(row.id) === String(id)))
      .filter((row) => row && candidatePending(row) && row.capabilities && row.capabilities.canEdit)
      .map((candidate) => `<div class="ca-candidate-detail ca-pending-block" data-cand-id="${esc(candidate.id)}" data-cand-type="${esc(candidate.suggestedType || '')}">${candidateFormBody(candidate)}</div>`)
      .join('');
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
    return `${backHtml}
    ${hero(
      vocab ? vocab.recordTitle(capture) : String(capture.conversationTitle || T('cognition.capture_untitled_record', '未命名会话的整理')),
      vocab ? vocab.captureReasonText(capture.displayReason) : T('cognition.capture_display_reason_other', '原因未记录'),
      statsRow([
        [Number(summary.pending) || 0, T('cognition.capture_metric_review', '待确认')],
        [Number(summary.promoted) || 0, T('cognition.capture_detail_assets', '已沉淀资产')],
        [Number(capture.attempt) || 1, T('cognition.capture_detail_attempt', '尝试次数')],
      ]),
    )}
    ${captureResultSection(capture, messageBySourceId)}
    ${captureConversationSection(capture, contextHit ? (contextHit.loading ? { loading: true } : context) : null)}
    <div class="card ca-capture-panel">
      <div class="ca-capture-head">
        ${chip(headStatus.label, headStatus.tone)}
        <div class="meta-row">
          ${metaItem(T('cognition.capture_detail_created', '创建于'), fmtDate(capture.createdAt))}
          ${metaItem(T('cognition.capture_detail_started', '开始时间'), fmtDate(capture.startedAt))}
          ${metaItem(T('cognition.capture_detail_finished', '结束时间'), fmtDate(capture.finishedAt))}
          ${metaItem(T('cognition.capture_detail_duration', '耗时'), durationText)}
          ${metaItem(T('cognition.capture_detail_tokens', '模型用量'), tokens ? `${tokens} tokens` : '')}
        </div>
        <div class="ca-head-actions">
          ${captureActionButtons({ ...capture, actions: (capture.actions || []).filter((action) => action !== 'review_candidates' && action !== 'view_assets') })}
          ${btn(T('cognition.capture_action_open_conversation', '打开会话'), 'open-conversation', { id: capture.conversationId || '', small: true })}
        </div>
      </div>
      ${captureStageStepper(capture.stage)}
      ${pendingFormBlocks ? `<div class="ca-pending-embed">${pendingFormBlocks}</div>` : ''}
      ${depositBlocks ? `<div class="ca-deposit">${sectionHead(T('cognition.capture_detail_assets', '已沉淀资产'))}${depositBlocks}</div>` : ''}
    </div>`;
  }

  /* ────────────────────────── 渲染入口 ────────────────────────── */

  /** 上一帧的路由指纹与本页滚动位置：同页重画（操作后刷新 / 4s 轮询）保持
   *  滚动位置（此前每次重画都弹回顶部——长列表里 4 秒一跳）；切换页面由
   *  router.go 归零，这里不恢复。 */
  let lastRenderKey = '';
  let treeSettlePass = 0;
  function routeKey(route) {
    return [route.name, route.assetId, route.candidateId, route.captureId, route.category, route.captureBucket].join('|');
  }

  function render(opts) {
    const options = opts || {};
    const root = document.getElementById('ca-root');
    if (!root) return;
    const route = S.route;
    const key = routeKey(route);
    const previousScroll = document.getElementById('ca-scroll');
    const restoreScroll = lastRenderKey === key && previousScroll ? previousScroll.scrollTop : 0;
    lastRenderKey = key;
    // 候选详情归「待我处理」、整理详情归「整理」；interactive-tour 靠
    // data-cognition-page-link="assets"/"captures" 定位 tab，随重构迁移。
    // 五页签（2026-09-21）：tree / ontology 是独立路由；详情深链仍归并到
    // 对应列表页签（overview 默认兜底）。
    const activeTab = route.name === 'review' || route.candidateId ? 'review'
      : route.name === 'organize' || route.name === 'organize-settings' || route.captureId ? 'organize'
        : route.name === 'ontology' ? 'ontology'
          : route.name === 'tree' ? 'tree' : 'overview';
    const pendingCount = Number(NS.stats().pending || 0);
    const tabsInner = NS.TABS.map((tab) => {
      const active = activeTab === tab.id;
      const extra = tab.id === 'overview' ? ' data-cognition-page-link="assets"' : (tab.id === 'organize' ? ' data-cognition-page-link="captures"' : '');
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
    } else if (route.name === 'tree') body = viewTree(route);
    else if (route.name === 'ontology') body = viewOntology(route);
    else if (route.name === 'review') body = viewReview(route);
    else if (route.name === 'organize') body = route.captureId ? viewCaptureDetail(route) : viewOrganizeTasks(route);
    else if (route.name === 'organize-settings') body = viewOrganizeSettingsPage();
    else body = viewOverview(route);
    const errorBanner = S.errors.length && S.loaded
      ? `<div class="ca-banner">${esc(T('cognition.partial_load', '部分数据读取失败，页面已用可用数据渲染。'))}${btn(T('common.retry', '重试'), 'refresh', { small: true })}</div>`
      : '';
    // 离开本体路由，或在本体路由上重渲染（轮询/数据刷新触发的 notify）：
    // 都要先把 section 归还 parking——内容区即将整体替换，若不先移走，
    // 本体 DOM 会连同内部状态一起被 innerHTML 销毁，页面从此白一片
    // （Phase 3 挂载契约；2026-09-21 补「本路由重渲染」这半边）。
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
    // 持久页面壳（2026-09-21 五页签迁移）：ca-app 结构只建一次，此后每次
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
    // 列表页/详情页统一收进原型 .wrap（居中 780px 阅读栏）——整屏铺满的
    // 列表行在宽窗里读起来很散，原型就是按阅读栏做的。
    if (!stageScroll) body = `<div class="wrap">${body}</div>`;
    if (options.rebuild || !tabsNav || !bannerSlot || !main) {
      root.innerHTML = `
        <div class="ca-app">
          <nav class="ca-tabs" id="ca-tabs-nav">${tabsInner}</nav>
          <div class="ca-banner-slot" id="ca-banner-slot">${errorBanner}</div>
          <div class="ca-scroll${stageScroll ? ' is-stage' : ''}" id="ca-scroll">${body}</div>
        </div>`;
    } else {
      tabsNav.innerHTML = tabsInner;
      bannerSlot.innerHTML = errorBanner;
      // 测试沙箱的 getElementById 返回裸对象（只有 innerHTML，没有 classList）：
      // 取不到就跳过切类，与上面的「退回整串写入」同一条守则。
      if (main.classList) main.classList.toggle('is-stage', stageScroll);
      main.innerHTML = body;
    }
    const scrollRoot = main || document.getElementById('ca-scroll');
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
      void NS.mountPersonalOntology();
    }
  }
  NS.render = render;
  // 共享渲染件（2026-09-20 本体界面重构）：个人本体页复用资产页同一套
  // 章/行形态。只有 IIFE 顶层的件可导出——plainRow/catalogRow 定义在
  // render 内部（闭包捕获每帧状态），不在此列。
  NS.ui = { chip, assetStatusChip };
})();
