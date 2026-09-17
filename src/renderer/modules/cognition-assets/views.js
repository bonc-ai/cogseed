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
   * 裸控件）。视觉仍由 .ca-btn 系列类驱动（cognition-assets.css 内
   * .ca-app 前缀覆盖全局 .btn 默认）。 */
  const btn = (label, act, options) => {
    const opts = options || {};
    const classes = ['ca-btn', opts.primary ? 'is-primary' : '', opts.danger ? 'is-danger' : '', opts.small ? 'is-sm' : '', opts.className || ''].filter(Boolean).join(' ');
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
      size: opts.small ? 'sm' : 'md',
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

  const chip = (label, tone) => `<span class="ca-chip${tone ? ` is-${tone}` : ''}">${esc(label)}</span>`;

  const stat = (value, label) => `<div class="ca-stat"><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`;
  const statsRow = (items) => `<div class="ca-stats">${items.map(([v, l]) => stat(v, l)).join('')}</div>`;

  const hero = (title, hint, statsHtml) => `
    <div class="ca-hero">
      <div class="ca-hero-main">
        <h2>${esc(title)}</h2>
        <p>${esc(hint)}</p>
      </div>
      ${statsHtml || ''}
    </div>`;

  /** 共享图标（icons.js）取用：缺席时用等义字符兜底（icons.js 由全局
   *  加载，认知资产模块晚于它；防御性兜底保证任何加载顺序下可用）。 */
  const uiIcon = (name, className, fallback) => (typeof window.uiIconHtml === 'function'
    ? window.uiIconHtml(name, className)
    : fallback);

  const empty = (title, hint, actionHtml) => `
    <div class="ca-empty">
      <div class="ca-empty-icon" aria-hidden="true">${uiIcon('circle', 'ca-empty-glyph', '◎')}</div>
      <strong>${esc(title)}</strong>
      ${hint ? `<span>${esc(hint)}</span>` : ''}
      ${actionHtml || ''}
    </div>`;

  const sectionHead = (title, note, right) => `
    <div class="ca-section-head"><strong>${esc(title)}</strong>${note ? `<span class="ca-note">${esc(note)}</span>` : ''}${right ? `<span class="ca-section-right">${right}</span>` : ''}</div>`;

  const CATEGORIES = [
    ['personal', 'cognition.asset_category_personal', '关于我'],
    ['rule', 'cognition.asset_category_rule', '规则与偏好'],
    ['template', 'cognition.asset_category_template', '模板与范例'],
    ['skill_method', 'cognition.asset_category_skill_method', '技能与方法'],
  ];
  const categoryLabel = (type) => {
    const hit = CATEGORIES.find(([id]) => id === type);
    return hit ? T(hit[1], hit[2]) : T('cognition.asset_category_other', '其他');
  };

  const ASSET_STATUS = {
    active: ['已确认', 'green'], paused: ['已暂停', 'amber'], archived: ['已归档', ''],
    deleted: ['已删除', 'red'], purged: ['已清除', 'red'], revoked: ['已撤回', 'red'],
  };
  const assetStatusChip = (asset) => {
    const [label, tone] = ASSET_STATUS[String(asset.status || 'active')] || [String(asset.status || ''), ''];
    const maturity = asset.maturity === 'effectiveness_validated'
      ? chip(T('cognition.maturity_validated', '已验证'), 'green')
      : (asset.maturity === 'transfer_validated' ? chip(T('cognition.maturity_transferred', '已成功带入'), 'green') : '');
    return chip(label, tone) + maturity;
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
  function sourceRefUnavailable(ref) {
    if (!ref) return true;
    const title = String(ref.title || ref.conversationTitle || ref.name || '').trim();
    if (title) return false;
    const id = String(ref.id || ref.conversationId || ref.ref || '').trim();
    if (!id) return true;
    const item = sourceIndex().get(id);
    if (item && String(item.title || '').trim()) return false;
    if (item && (item.status === 'pending' || item.status === 'processing')) return false;
    return true;
  }
  function evidenceRefs(candidate) {
    return candidate.evidenceRefs || candidate.sourceRefs || [];
  }
  function evidenceMostlyUnavailable(candidate) {
    const refs = evidenceRefs(candidate);
    if (!refs.length) return false;
    return refs.filter(sourceRefUnavailable).length * 2 > refs.length;
  }
  const evidenceChip = (ref) => {
    const unavailable = sourceRefUnavailable(ref);
    // KSTAR 任务复盘引用（2026-09-17 资产侧溯源）：显示任务目标摘要、可点
    // 开复盘详情——此前只有内部 id 加占位标题，KSTAR 血统确认后不可见。
    const refId = String(ref.id || '');
    if (!unavailable && refId.startsWith('kse-')) {
      const summary = (S.kstarSummaries && S.kstarSummaries[refId]) || null;
      const label = summary && summary.goal
        ? summary.goal.slice(0, 24)
        : String(ref.title || T('cognition.kstar_episode_generic', 'KSTAR 复盘记录')).trim();
      return `<span class="ca-chip ca-chip-link is-line" data-act="open-kstar-episode" data-id="${esc(refId)}" ${roleBtn()} title="${esc(T('cognition.kstar_episode_open_hint', '查看这次任务的复盘'))}">${esc(label)}</span>`;
    }
    const label = unavailable
      ? T('cognition.source_unavailable_label', '来源记录不可用')
      : String(ref.title || ref.conversationTitle || ref.name || sourceIndex().get(String(ref.id || ''))?.title || '').trim();
    return chip(label || T('cognition.source_deleted', '来源已删除'), unavailable ? 'amber' : 'line');
  };

  /** KSTAR 复盘详情块（2026-09-17）：点开证据 chip 就地展开那次任务的
   *  预期/实际/结果/归因——资产确认后 KSTAR 来龙去脉仍可追。 */
  function kstarEpisodeSection(route) {
    const id = String(route.kstarEpisodeId || '');
    if (!id) return '';
    const state = S.kstarEpisode;
    if (!state || state.episodeId !== id) {
      return `<div class="ca-sect"><div class="ca-sub">${esc(T('cognition.kstar_episode_loading', '正在读取这次任务的复盘…'))}</div></div>`;
    }
    const outcomeText = {
      better_than_expected: T('cognition.review_outcome_better', '比预期好'),
      met_expected: T('cognition.review_outcome_met', '符合预期'),
      worse_than_expected: T('cognition.review_outcome_worse', '比预期差'),
      unclear: T('cognition.review_outcome_unclear', '结果不明'),
    }[String((state.review && state.review.outcome) || '')] || '—';
    const row = (label, value) => value ? `<div class="ca-meta-item"><span class="ca-meta-k">${esc(label)}</span><span class="ca-meta-v">${esc(String(value).slice(0, 200))}</span></div>` : '';
    return `<div class="ca-sect">
      <div class="ca-row-title">${esc(T('cognition.kstar_episode_detail_title', 'KSTAR 复盘详情'))}</div>
      <div class="ca-meta-row">
        ${row(T('cognition.review_signal_expected', '预期'), state.review && state.review.expectedResult)}
        ${row(T('cognition.review_signal_actual', '实际'), state.review && state.review.actualResult)}
        ${row(T('cognition.review_signal_outcome', '结果'), outcomeText)}
        ${row(T('cognition.review_signal_attribution', '归因'), state.review && state.review.attribution)}
        ${row(T('cognition.kstar_lesson_label', '沉淀的经验'), state.review && state.review.lesson)}
      </div>
      <p class="ca-note">${esc(String(state.episode && state.episode.goal || ''))}</p>
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
    const row = (label, value) => value ? `<div class="ca-meta-item"><span class="ca-meta-k">${esc(label)}</span><span class="ca-meta-v">${esc(String(value).slice(0, 200))}</span></div>` : '';
    return `<div class="ca-sect">
      <div class="ca-row-title">${esc(T('cognition.review_signal_title', '复盘依据'))}</div>
      <div class="ca-meta-row">
        ${row(T('cognition.review_signal_expected', '预期'), signal && signal.expectedResult)}
        ${row(T('cognition.review_signal_actual', '实际'), signal && signal.actualResult)}
        ${row(T('cognition.review_signal_outcome', '结果'), outcomeText)}
        ${row(T('cognition.review_signal_attribution', '归因'), provenance && provenance.attribution)}
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

  /* ────────────────────────── 认知树（方块堆形版） ────────────────────────── */
  /* 垂直轴 = 处理梯度：土壤（记录）→ 根（候选）→ 干/枝（正式资产）→ 冠（已验证）。
     全部用方块堆出树形：树干=「个人本体」干块（关于我类资产归属于本体内部，
     不再单列为枝）、枝条=斜排小方块、树冠=三个方块拼蓬松、根=小长方块、
     土=大灰方块；每个方块可点击直达对应清单。 */

  function treeBlocks(counts, info) {
    const c = (id) => counts[id] || 0;
    const pending = Number(info.pending || 0);
    const validated = Number(info.validated || 0);
    /* 枝条：从干块斜向伸出的连续小方块（像素风），两端对准干边与模块方块。 */
    const twig = (x1, y1, x2, y2) => {
      const n = 5;
      const out = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = Math.round(x1 + (x2 - x1) * t) - 9;
        const y = Math.round(y1 + (y2 - y1) * t) - 9;
        out.push(`<rect x="${x}" y="${y}" width="18" height="18" fill="#c3a179"/>`);
      }
      return out.join('');
    };
    const modBlock = (id, x, y, w, h) => `
      <g class="ca-fig-mod${S.route.category === id ? ' is-on' : ''}${c(id) > 0 ? '' : ' is-empty'}" data-act="filter-cat" data-id="${id}" role="button" tabindex="0">
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>
        <text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle">${esc(categoryLabel(id))} · ${c(id)}</text>
      </g>`;
    // 树干主体 = 个人本体：关于我类资产（c('personal')）归属于本体内部，
    // 不再作为独立枝叶；点击干块直接进入本体工作台（2026-09-14 布局调整）。
    const trunk = `
      <g class="ca-fig-mod ca-fig-trunk${S.route.category === 'personal' ? ' is-on' : ''}${c('personal') > 0 ? '' : ' is-empty'}" data-act="open-ontology" role="button" tabindex="0">
        <title>${esc(T('cognition.ontology_entry_hint', '我是谁、我怎么工作：画像与偏好的结构化整理'))}</title>
        <rect x="298" y="150" width="104" height="68" rx="8"/>
        <text x="350" y="182" text-anchor="middle">${esc(T('cognition.ontology_entry_title', '个人本体'))}</text>
        <text class="ca-fig-sub" x="350" y="200" text-anchor="middle">${esc(`${categoryLabel('personal')} ${c('personal')}`)}</text>
      </g>`;
    return `
    <svg class="ca-fig" viewBox="0 0 700 460" role="img" aria-label="${esc(T('cognition.tree_panel_title', '我的认知树'))}">
      <g class="ca-fig-soil" data-act="go-review" role="button" tabindex="0">
        <title>${esc(T('cognition.tree_soil_hint', '认知的土壤：会话与采集记录；来源异常会出现在「待我处理」'))}</title>
        <rect x="76" y="392" width="548" height="58" rx="8"/>
        <text x="350" y="426" text-anchor="middle">${esc(T('cognition.tree_soil_label', '土壤 · 来源 {s} · 采集 {c}', { s: String(Number(info.sources || 0)), c: String(Number(info.captures || 0)) }))}</text>
      </g>
      <g class="ca-fig-root${pending > 0 ? '' : ' is-empty'}" data-act="go-review" role="button" tabindex="0">
        <title>${esc(T('cognition.tree_root_hint', '待你确认的候选；点击进入待我处理'))}</title>
        <rect x="278" y="344" width="144" height="46" rx="8"/>
        <circle cx="308" cy="367" r="6"/>
        <text x="374" y="372" text-anchor="middle">${esc(T('cognition.tree_root_pending', '待确认 {n}', { n: String(pending) }))}</text>
      </g>
      <rect x="343" y="98" width="14" height="52" fill="#c3a179"/>
      <rect x="343" y="218" width="24" height="126" fill="#c3a179"/>
      ${twig(402, 178, 448, 156)}
      ${twig(402, 208, 448, 286)}
      ${twig(298, 208, 252, 286)}
      ${trunk}
      ${modBlock('skill_method', 444, 128, 172, 56)}
      ${modBlock('rule', 84, 258, 172, 56)}
      ${modBlock('template', 444, 258, 172, 56)}
      <g class="ca-fig-crown${validated > 0 ? '' : ' is-empty'}" data-act="open-overview" role="button" tabindex="0">
        <title>${esc(T('cognition.tree_crown_hint', '已被真实复用或验证有效的资产；在资产明细里看使用记录'))}</title>
        <rect x="206" y="60" width="48" height="38" rx="6"/>
        <rect x="446" y="60" width="48" height="38" rx="6"/>
        <rect x="252" y="40" width="196" height="58" rx="8"/>
        <text x="350" y="75" text-anchor="middle">${esc(T('cognition.tree_crown_validated', '已验证 {n}', { n: String(validated) }))}</text>
      </g>
    </svg>`;
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
  /** 事件整句化：一句话说明在什么时间、哪个对话里被怎么用。 */
  function proofSentence(names, proof) {
    const refs = proof.refs || {};
    const when = fmtDate(proof.occurredAt);
    const where = proofWherePhrase(names, refs.conversationId);
    const version = refs.version
      ? T('cognition.proof_version_suffix', '（v{n}）', { n: String(refs.version) })
      : '';
    const kind = String(proof.kind || '');
    if (kind === 'usage_recorded') {
      return T('cognition.proof_sentence_usage', '{when}，在{where}被实际使用{version}', { when, where, version });
    }
    if (kind === 'projection_confirmed') {
      return T('cognition.proof_sentence_projected', '{when}，在{where}被带入任务{version}', { when, where, version });
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
      .sort((left, right) => String(right.occurredAt || '').localeCompare(String(left.occurredAt || '')));
    if (!items.length) {
      return `<div class="ca-sect"><div class="ca-sub">${esc(T('cognition.asset_no_proofs_section', '还没有被真实使用过。资产在任务中被真正使用、并留下可核对的记录后，会出现在这里。'))}</div></div>`;
    }
    const names = conversationNames();
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
            <div class="ca-actions">${PROOF_FEEDBACKS.map(([value, key, fb]) => btn(T(key, fb), 'proof-rate', { id: transferProofId, data: { feedback: value, proof: proof.id } })).join('')}</div>
            <div class="ca-note-zone">
              ${window.uiTextarea({ id: `ca-proof-note-${esc(proof.id)}`, placeholder: T('cognition.proof_note_optional_placeholder', '可补充一句你观察到的变化（可选；先写再点评，说明会随评价一起附上）'), attrs: { 'data-f': 'note' } })}
            </div>
          </div>`;
        } else {
          ratingHtml = `<div class="ca-rating"><p class="ca-note">${esc(T('cognition.proof_rating_blocked_no_transfer', '这次还没有形成可评价的使用记录。'))}</p></div>`;
        }
      }
      return `
      <div class="ca-proof-row${isOpen ? ' is-open' : ''}">
        <div class="ca-proof-event" data-act="proof-toggle" data-id="${esc(proof.id)}" ${roleBtn()}>
          <span class="ca-proof-dot" aria-hidden="true"></span>
          <span class="ca-proof-body"><strong class="ca-proof-sentence">${esc(proofSentence(names, proof))}</strong></span>
        </div>
        ${ratingHtml}
      </div>`;
    }).join('');
    return `<div class="ca-sect">
      ${sectionHead(T('cognition.asset_usage_section', '使用记录'), summaryLine)}
      <div class="ca-proof-list">${rows}</div>
      ${items.length > 20 ? `<div class="ca-sub">${esc(T('cognition.asset_usage_more', '仅显示最近 {n} 条', { n: '20' }))}</div>` : ''}
    </div>`;
  }

  /** 单个版本的展开详情（2026-09-17）：列表行只给 80 字预览，点行看全文与
   * 逐项信息；非在用版就地提供「删除此版本」（真删：物理移除，引用它的
   * 已确认注入在服务端冻结了内容副本）。 */
  function assetVersionDetailBlock(asset, v, isActive, usage) {
    const snap = v.snapshot || {};
    const usageText = usage
      ? [usage.applied ? T('cognition.asset_usage_applied', '实际采用 {n} 次', { n: String(usage.applied) }) : '',
        usage.contradicted ? T('cognition.asset_usage_contradicted', '被否定 {n} 次', { n: String(usage.contradicted) }) : '']
        .filter(Boolean).join(' · ')
      : '';
    const evidenceCount = Array.isArray(snap.evidenceRefs) ? snap.evidenceRefs.length : 0;
    const rowHtml = (label, value) => value ? `<div class="ca-meta-item"><span class="ca-meta-k">${esc(label)}</span><span class="ca-meta-v">${esc(String(value))}</span></div>` : '';
    const actions = isActive
      ? `<span class="ca-note">${esc(T('cognition.asset_version_active_locked', '当前在用版本不可删除；先选用其他版本，再删除它。'))}</span>`
      : btn(T('cognition.asset_version_delete', '删除此版本'), 'delete-asset-version', { id: asset.id, data: { version: String(v.version) }, danger: true, small: true });
    return `<div class="ca-sect ca-version-detail">
      <div class="ca-row-title">${esc(T('cognition.asset_version_detail_title', '版本详情'))} · v${esc(String(v.version))}</div>
      <p class="ca-note">${esc(String(snap.statement || ''))}</p>
      <div class="ca-meta-row">
        ${rowHtml(T('cognition.asset_version_applicable', '适用场景'), (Array.isArray(snap.applicableWhen) ? snap.applicableWhen : []).join('；'))}
        ${rowHtml(T('cognition.asset_version_forbidden', '禁用场景'), (Array.isArray(snap.forbiddenWhen) ? snap.forbiddenWhen : []).join('；'))}
        ${rowHtml(T('cognition.asset_version_evidence_label', '证据来源'), evidenceCount ? T('cognition.asset_version_evidence_count', '{n} 条', { n: String(evidenceCount) }) : '')}
        ${rowHtml(T('cognition.asset_version_reason_label', '变更说明'), [v.reason || '', fmtDate(v.at)].filter(Boolean).join(' · '))}
        ${rowHtml(T('cognition.asset_version_usage_label', '使用效果'), usageText)}
      </div>
      <div class="ca-actions ca-actions-right">${actions}</div>
    </div>`;
  }

  /** 版本链（2026-09-16 版本组）：V1 归入同条目可展开；在用=指针可切换，
   *  「选用此版」走 select-asset-version（内容同步、不产生新版本号）。 */
  function assetVersionsSection(asset) {
    const state = S.assetVersions;
    if (!state || state.assetId !== String(asset.id) || !Array.isArray(state.versions) || state.versions.length < 2) return '';
    const active = String(asset.activeVersion || asset.version || '');
    const usageByVersion = new Map((state.usage || []).map((u) => [String(u.version), u]));
    // 空版本标记（2026-09-16）：与相邻版内容一字不差的版本（系统迁移垫高/
    // 旧版归并搬运）显示"内容未变"，避免"两版一模一样"被误读为出错。
    const contentKey = (snap) => `${snap.title || ''}\n${snap.statement || ''}`;
    const sortedAsc = [...state.versions].sort((left, right) => Number(left.version) - Number(right.version));
    const unchangedAfter = new Set(sortedAsc.filter((v, i) => i > 0 && contentKey(v.snapshot || {}) === contentKey(sortedAsc[i - 1].snapshot || {})).map((v) => String(v.version)));
    const rows = [...state.versions]
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
        const meta = [statementPreview, fmtDate(v.at), String(v.reason || ''), unchangedAfter.has(String(v.version)) ? T('cognition.asset_version_unchanged', '内容未变（系统迁移/搬运）') : '', usageText].filter(Boolean).join(' · ');
        const side = isActive
          ? chip(T('cognition.asset_version_active', '在用'), 'green')
          : btn(T('cognition.asset_version_select', '选用此版'), 'select-asset-version', { id: asset.id, data: { version: String(v.version) }, small: true });
        // 行可点开（2026-09-17）：点行就地展开该版本全文详情；再点收起。
        const open = String(S.route.assetVersionId || '') === String(v.version);
        return `<div class="ca-row is-flat is-clickable" data-act="open-asset-version" data-version="${esc(String(v.version))}" ${roleBtn()}>
          <div class="ca-row-main"><div class="ca-row-title">v${esc(String(v.version))} · ${esc(title)}</div><div class="ca-row-meta">${esc(meta)}</div></div>
          <div class="ca-row-side">${side}</div>
        </div>
        ${open ? assetVersionDetailBlock(asset, v, isActive, usage) : ''}`;
      }).join('');
    return `<div class="ca-sect"><div class="ca-row-title">${esc(T('cognition.asset_versions_section', '版本记录'))}</div>${rows}</div>`;
  }

  function assetDetail(asset, route) {
    const affectedCopy = {
      active: [T('cognition.asset_pause_hint', '暂停后，新任务不再默认带上这条资产；已完成任务、历史版本与使用证据都会保留。'),
        btn(T('cognition.asset_pause', '暂停使用'), 'asset-action', { id: asset.id, data: { action: 'pause' } }),
        btn(T('cognition.asset_archive', '归档'), 'asset-action', { id: asset.id, data: { action: 'archive' } })],
      paused: [T('cognition.asset_resume_hint', '恢复后，这条资产会重新参与任务匹配。'),
        btn(T('cognition.asset_resume', '恢复使用'), 'asset-action', { id: asset.id, data: { action: 'resume' }, primary: true })],
      archived: [T('cognition.asset_restore_hint', '恢复后，这条资产重新出现在常用资产中。'),
        btn(T('cognition.asset_restore', '恢复'), 'asset-action', { id: asset.id, data: { action: 'restore' }, primary: true })],
    }[String(asset.status || 'active')] || [];
    const proofCount = S.proofs.filter((p) => String((p.refs || {}).assetId || '') === String(asset.id)).length;
    // 元信息白话化：后端值可能是内部术语，认出常见形态翻成人话，认不出原样显示。
    const scopeRaw = String(asset.scope || '');
    const scopeText = !scopeRaw
      ? T('cognition.asset_scope_unset', '还没设置')
      : (/全局|画像/.test(scopeRaw) ? T('cognition.asset_scope_all', '所有对话') : scopeRaw);
    // 溯源行（2026-09-17 补齐）：KSTAR 血统认 learningProvenance **或**
    // learningSignal——偏好扫描线不写 provenance 只写信号，此前被漏掉，
    // 资产确认后 KSTAR 来龙去脉在详情页不可见。
    const kstarSource = asset.learningProvenance
      ? 'review'
      : asset.learningSignal && ['review', 'preference_scan'].includes(String(asset.learningSignal.source || ''))
        ? String(asset.learningSignal.source)
        : '';
    const originText = kstarSource === 'preference_scan'
      ? T('cognition.asset_origin_pref_scan', '来自 KSTAR 偏好')
      : kstarSource
        ? T('cognition.asset_origin_kstar', '来自 KSTAR 复盘')
        : {
        user_confirmed: T('cognition.asset_origin_user', '你确认的'),
        user_confirmed_unverified: T('cognition.asset_origin_user', '你确认的'),
        automatically_extracted_unverified: T('cognition.asset_origin_auto', '系统整理出来的'),
        system_precipitated_unverified: T('cognition.asset_origin_auto', '系统整理出来的'),
      }[String(asset.lifecycleStatus || '')] || String(asset.lifecycleStatus || '—');
    const moreRow = (label, hint, action) => `
      <div class="ca-more-row">
        <div class="ca-more-copy"><strong>${esc(label)}</strong><span>${esc(hint)}</span></div>
        ${btn(label, 'asset-action', { id: asset.id, data: { action }, danger: true, small: true })}
      </div>`;
    return `
    ${btn(T('cognition.asset_back', '← 返回列表'), 'go-back', { className: 'ca-backlink' })}
    <div class="ca-card ca-asset-detail">
      <div class="ca-line">
        <div>
          <h3>${esc(asset.title || asset.id)}</h3>
          <div class="ca-sub">${esc(categoryLabel(asset.type))} · v${esc(String(asset.activeVersion || asset.version || '1'))}${asset.activeVersion && asset.activeVersion !== asset.version ? ` · ${esc(T('cognition.asset_version_latest_note', '已有更新的版本'))}` : ''} · ${esc(T('cognition.asset_updated', '更新于'))} ${esc(fmtDate(asset.updatedAt || asset.createdAt))}</div>
        </div>
        <div class="ca-right">${assetStatusChip(asset)}</div>
      </div>
      <p class="ca-content-text">${esc(asset.statement || '')}</p>
      <details class="ca-advanced">
        <summary>${esc(T('cognition.asset_meta_summary', '详细信息'))}</summary>
        <div class="ca-kv">
          <div><div class="ca-k">${esc(T('cognition.asset_scope_label', '适用范围'))}</div><div class="ca-v">${esc(scopeText)}</div></div>
          <div><div class="ca-k">${esc(T('cognition.asset_origin_label', '怎么来的'))}</div><div class="ca-v">${esc(originText)}</div></div>
          <div><div class="ca-k">${esc(T('cognition.asset_proofs_label', '用过几次'))}</div><div class="ca-v">${proofCount ? `${proofCount} ${esc(T('cognition.asset_proof_times', '次'))}` : esc(T('cognition.asset_no_proofs', '还没用过'))}</div></div>
        </div>
      </details>
      ${(asset.evidenceRefs || []).length ? `<details class="ca-advanced"><summary>${esc(T('cognition.asset_evidence_section', '证据来源'))}</summary><div class="ca-chips">${(asset.evidenceRefs || []).map(evidenceChip).join('')}</div></details>` : ''}
      ${kstarEpisodeSection(route)}
      ${assetVersionsSection(asset)}
      ${affectedCopy.length ? `<div class="ca-sect"><p class="ca-note">${esc(affectedCopy[0])}</p><div class="ca-actions">${affectedCopy.slice(1).join('')}</div></div>` : ''}
      ${assetUsageSection(asset, route)}
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
    const rows = sameType.map((other) => `<div class="ca-row is-flat">
      <div class="ca-row-main"><div class="ca-row-title">${esc(other.title || other.id)}</div><div class="ca-row-meta">v${esc(String(other.activeVersion || other.version || '1'))}</div></div>
      <div class="ca-row-side">${btn(T('cognition.asset_merge_into', '并入这条'), 'merge-asset', { id: asset.id, data: { target: String(other.id) }, small: true })}</div>
    </div>`).join('');
    return `<details class="ca-advanced">
      <summary>${esc(T('cognition.asset_merge_section', '与另一条合并（同一认知的重复条目）'))}</summary>
      <p class="ca-note">${esc(T('cognition.asset_merge_hint', '把本条的全部历史版本并入所选条目：较新的内容成为其新版本，本条归档不再单独显示。'))}</p>
      ${rows}
    </details>`;
  }

  /* ────────────────────────── 视图：我的认知 ────────────────────────── */

  function viewOverview(route) {
    const stats = NS.stats();
    const counts = {};
    for (const [id] of CATEGORIES) counts[id] = S.assets.filter((a) => a.type === id && String(a.status || 'active') !== 'archived').length;
    const sourceCount = S.sources.reduce((n, group) => n + (Array.isArray(group.items) ? group.items.length : 0), 0);
    const captureCount = Array.isArray(S.captures) ? S.captures.length : 0;
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
    const heroHtml = hero(
      T('cognition.overview_title', '我的认知资产'),
      T('cognition.tree_page_hint', '树只展示正式认知资产。候选经确认后成为正式资产，经真实复用与证据验证后升级为「已验证」。'),
      statsRow([
        [stats.confirmed, T('cognition.overview_stat_confirmed', '已确认资产')],
        [stats.pending, T('cognition.overview_stat_pending', '待确认候选')],
        [stats.transferOk, T('cognition.overview_stat_validated', '已验证')],
        [stats.attention, T('cognition.overview_stat_attention', '需要关注')],
      ]),
    );
    if (route.assetId) {
      const asset = S.assets.find((a) => String(a.id) === String(route.assetId));
      // 详情视图不显示统计条：那是列表页的上下文，详情页只讲这一条资产
      //（使用记录已并入详情，2026-09-15）。
      if (asset) return hero(T('cognition.overview_title', '我的认知资产'), '') + assetDetail(asset, route);
    }
    const filtered = S.assets.filter((a) => String(a.status || 'active') !== 'archived'
      && (!route.category || a.type === route.category));
    const chips = [['', T('common.all', '全部'), S.assets.filter((a) => String(a.status || 'active') !== 'archived').length]]
      .concat(CATEGORIES.map(([id, key, fallback]) => [id, T(key, fallback), counts[id]]));
    const listHtml = filtered.length
      ? filtered.map((asset) => `
        <div class="ca-row" data-go-asset="${esc(asset.id)}" role="button" tabindex="0">
          <div class="ca-row-main">
            <div class="ca-row-title">${esc(asset.title || asset.id)}</div>
            <div class="ca-row-meta">${esc(categoryLabel(asset.type))} · v${esc(String(asset.version || '1'))} · ${esc(lastUseText(asset.id))}</div>
          </div>
          <div class="ca-row-side">${assetStatusChip(asset)}<span class="ca-chevron" aria-hidden="true">${uiIcon('chevron-right', 'ca-chevron-svg', '›')}</span></div>
        </div>`).join('')
      : empty(
        T('cognition.tree_empty', '还没有正式资产'),
        T('cognition.tree_empty_hint', '候选被确认为正式资产后会出现在这里；当前还没有已确认的资产。'),
        // 条件与按钮数字同口径（stats.pending），避免出现「查看 0 条」。
        stats.pending ? btn(T('cognition.tree_view_buds', '查看 {n} 条待确认候选', { n: String(stats.pending) }), 'go-review', { primary: true }) : '',
      );
    return `${heroHtml}
      <div class="ca-card ca-tree-card">
        <div class="ca-line">
          <div><h3>${esc(T('cognition.tree_panel_title', '我的认知树'))}</h3>
          <div class="ca-sub">${esc(T('cognition.tree_panel_caption', '一位用户只有一棵树，四条主枝对应四类资产'))}；${esc(T('cognition.tree_click_hint', '点击分类查看明细'))}</div></div>
          <div class="ca-right">${stats.pending ? btn(T('cognition.tree_view_buds', '查看 {n} 条待确认候选', { n: String(stats.pending) }), 'go-review', { small: true }) : ''}</div>
        </div>
        ${treeBlocks(counts, { pending: stats.pending, validated: stats.transferOk, sources: sourceCount, captures: captureCount })}
        <div class="ca-tree-cap">${esc(T('cognition.tree_legend_bud_hint', '树根上的圆点是还没确认的候选；确认后它会成为同一根主枝上的正式资产。'))}</div>
        <!-- 教学知识点（2026-09-15）：骨架阶段说明，讲"先骨架后打磨"的
             开发逻辑，并点明未完成界面对外不应展示——仅向内部学员示范。 -->
        <div class="ca-tree-cap ca-tree-wip">${esc(T('cognition.tree_wip_note', '这部分还是开发中的骨架：先搭出可点的骨架，再按骨架逐步打磨视觉与交互。现阶段仅内部学员使用，所以未完成部分暂时展示；正式对外版本中不会出现。'))}</div>
      </div>
      ${sectionHead(T('cognition.overview_list_title', '资产明细'), '', chips.map(([id, label, count]) => btn(`${label} ${count}`, 'filter-cat', { id, className: `ca-chip ca-chip-btn${String(route.category || '') === id ? ' is-green' : ''}` })).join(' '))}
      ${listHtml}`;
  }

  /* ────────────────────────── 视图：待我处理 ────────────────────────── */

  function candidateCard(candidate, broken) {
    const refs = evidenceRefs(candidate);
    const refsHtml = refs.length
      ? `<div class="ca-src">${esc(T('cognition.candidate_source', '来源'))}：${refs.slice(0, 4).map((ref) => esc(sourceRefUnavailable(ref)
        ? T('cognition.source_unavailable_label', '来源记录不可用')
        : String(ref.title || ref.conversationTitle || '').trim() || T('cognition.source_resolved', '会话记录'))).join(' · ')}</div>`
      : '';
    const warnHtml = broken
      ? `<div class="ca-warn">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或选择不保存。'))}</div>`
      : '';
    // 决策动作（保存/不保存/调整）统一收在详情页：卡片整体即入口，不再放
    // 行内按钮——按钮与「点卡片进详情」的落点相冲突（用户实测反馈）。
    return `
    <div class="ca-card ca-candidate${broken ? ' is-broken' : ''}" data-act="open-candidate" data-id="${esc(candidate.id)}" role="button" tabindex="0">
      <div class="ca-line">
        <div class="ca-row-title">${esc(candidateTitle(candidate))} <span class="ca-chevron" aria-hidden="true">${uiIcon('chevron-right', 'ca-chevron-svg', '›')}</span></div>
        <div class="ca-right">${(candidate.capabilities && candidate.capabilities.isSnoozed) ? chip(T('cognition.candidate_snoozed', '已稍后处理'), 'amber') : ''}${chip(categoryLabel(candidate.suggestedType), '')} ${candidateSourceBadge(candidate)} ${broken ? chip(T('cognition.candidate_evidence_weak', '来源已删'), 'amber') : chip(T('cognition.candidate_evidence_ok', '证据充足'), 'green')}</div>
      </div>
      <p class="ca-content-text">${esc(String(candidate.judgment || candidate.value || '').slice(0, 220))}</p>
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
      return `<div class="ca-row is-flat">
        <div class="ca-row-main">
          <div class="ca-row-title">${esc(item.title || item.id)}</div>
          <div class="ca-row-meta">${esc(vocab ? (vocab.kindLabel(item.kind) || String(item.kind || '')) : String(item.kind || ''))}${reasonText ? ` · ${esc(reasonText)}` : ''}</div>
        </div>
        <div class="ca-row-side">${action}</div>
      </div>`;
    }).join('');
    return `<div class="ca-card">${rows}
      ${issues.length > 20 ? `<div class="ca-sub">${esc(T('cognition.source_issues_more', '仅显示前 {n} 条', { n: '20' }))}</div>` : ''}
    </div>`;
  }

  function viewReview(route) {
    if (route.candidateId) return viewCandidate(route);
    const stats = NS.stats();
    const pending = S.candidates.filter(candidatePending);
    const broken = pending.filter(evidenceMostlyUnavailable);
    const healthy = pending.filter((c) => !evidenceMostlyUnavailable(c));
    const processed = S.candidates
      .filter((c) => ['confirmed', 'rejected', 'ignored'].includes(String(c.status || '')))
      .slice(0, 5);
    // 处理结果按真实状态如实显示——此前无论保存还是拒绝都写「已保存」，
    // 与筛选口径（confirmed/rejected/ignored 三种）不符（用户实测抓出）。
    const processedLabel = (c) => ({
      confirmed: T('cognition.candidate_status_promoted', '已保存'),
      rejected: T('cognition.candidate_status_rejected', '未保存'),
      ignored: T('cognition.candidate_status_ignored', '已忽略'),
    }[String(c.status || '')] || String(c.status || ''));
    const attention = [];
    // 注：治理待办（cognition.inbox：未分级 / 规则缺边界 / 分类冲突等）曾在此
    // 列出，但新 UI 尚无资产分级与边界编辑入口——报了警却无处处理，只会
    // 制造焦虑（2026-09-14 撤下）。等治理动作入口恢复后，连同每类的动作
    // 指引一起重上。此处只保留有明确处理出口的两条。
    if (stats.sourceIssues) {
      // 来源异常就地展开（2026-09-15：来源健康无常态页，异常驱动）。
      attention.push(`<div class="ca-attention-row" data-act="toggle-source-issues" ${roleBtn()}><span>${esc(T('cognition.overview_source_issues', '{count} 条来源记录需要处理', { count: String(stats.sourceIssues) }))}</span><b>${esc(String(route.sourceIssueOpen || '') === 'open' ? T('common.collapse', '收起') : T('common.handle', '处理'))}</b></div>`);
    }
    if (stats.failedTasks) {
      // 落点（2026-09-15）：重试按钮在「整理」页的任务流里。
      attention.push(`<div class="ca-attention-row" data-act="go-organize" ${roleBtn()}><span>${esc(T('cognition.overview_failed_tasks', '{count} 个整理任务需要重试', { count: String(stats.failedTasks) }))}</span><b>${esc(T('common.handle', '处理'))}</b></div>`);
    }
    return `${hero(
      T('cognition.review_title', '待我处理'),
      T('cognition.inbox_page_hint', '每条只需要一个决定：保存，还是不保存。'),
      statsRow([
        [healthy.filter(candidateAwaiting).length, T('cognition.review_stat_wait', '等待确认')],
        [broken.filter(candidateAwaiting).length, T('cognition.review_stat_evidence', '来源已删')],
      ]),
    )}
    ${attention.length ? `<div class="ca-notice">${attention.join('')}</div>` : ''}
    ${sourceIssuesSection(route)}
    ${sectionHead(T('cognition.review_group_wait', '等待你确认'), T('cognition.review_group_wait_note', '确认后会创建 v1，并保留来源与撤销入口'))}
    ${healthy.length ? healthy.map((c) => candidateCard(c, false)).join('') : `<div class="ca-card">${empty(T('cognition.review_empty_wait', '当前没有等待确认的候选'))}</div>`}
    ${broken.length ? sectionHead(T('cognition.review_group_evidence', '来源已删除的候选'), T('cognition.review_group_evidence_note', '这些候选的原始出处已被删除；可以点开确认后仍要保存，或选择不保存')) + broken.map((c) => candidateCard(c, true)).join('') : ''}
    ${processed.length ? `<details class="ca-advanced ca-processed-fold"><summary>${esc(T('cognition.inbox_processed_badge', '处理记录'))} <span class="ca-note">${esc(T('cognition.inbox_processed_hint', '按处理时间倒序，只显示已处理的决定'))}</span></summary><div class="ca-card">${processed.map((c) => `
      <div class="ca-row is-flat">
        <div class="ca-row-main"><div class="ca-row-title">${esc(candidateTitle(c))}</div>
        <div class="ca-row-meta">${esc(fmtDate(c.updatedAt || c.createdAt))} · ${esc(processedLabel(c))}</div></div>
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
    const edit = candidate.capabilities && candidate.capabilities.canEdit;
    const field = (label, inner) => `<label class="ca-field"><span>${esc(label)}</span>${inner}</label>`;
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
        ? `<div class="ca-warn">${esc(T('cognition.candidate_version_mismatch', '核对改进对象：任务当时使用的是 v{used}，该资产当前在用 v{active}——确认这次更新应作用在当前在用版上。', { used: usedVersion, active: activeVersion }))}</div>`
        : '';
      return `${mismatch}<div class="ca-field"><span>${esc(T('cognition.candidate_current_version', '当前版本（v{n}）', { n: activeVersion }))}</span><p class="ca-note">${esc(target.statement || '')}</p></div>`;
    })();
    const actionsHtml = `<div class="ca-actions ca-actions-right">
        ${(candidate.capabilities && candidate.capabilities.canPromote) ? btn(T('cognition.candidate_save_and_use', '保存并使用'), 'cand-adopt-with-form', { id: candidate.id, primary: true }) : ''}
        ${btn(T('cognition.candidate_defer_action', '稍后处理'), 'cand-decide', { id: candidate.id, data: { action: 'defer' } })}
        ${btn(T('cognition.candidate_reject', '拒绝'), 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true })}
      </div>`;
    return `
      ${broken ? `<div class="ca-warn">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或选择不保存。'))}</div>` : ''}
      ${reviewSignalBlock(candidate)}
      ${updateDiff}
      ${edit ? `
        ${field(T('cognition.type', '类型'), `<div class="ca-chips">${CATEGORIES.map(([id, key, fb]) => { const on = String(candidate.suggestedType || '') === id; return `<span class="ca-chip ca-chip-opt${on ? ' is-green' : ''}" data-act="cand-type" data-id="${esc(id)}" ${roleBtn(`aria-pressed="${on ? 'true' : 'false'}"`)}>${esc(T(key, fb))}</span>`; }).join('')}</div>`)}
        ${field(T('cognition.judgment', '具体内容'), window.uiTextarea({ id: `ca-cand-judgment-${esc(candidate.id)}`, value: candidate.judgment || '', attrs: { 'data-f': 'judgment' } }))}
        <details class="ca-advanced">
          <summary>${esc(T('cognition.candidate_advanced', '高级选项（通常不用改）'))}</summary>
          ${field(T('cognition.candidate_scope_label', '作用范围'), window.uiInput({ id: `ca-cand-scope-${esc(candidate.id)}`, value: candidate.suggestedScope || '', placeholder: T('cognition.candidate_scope_placeholder', '例如：仅产品工作空间'), attrs: { 'data-f': 'scope' } }))}
          <div class="ca-note">${esc(T('cognition.candidate_scope_hint', '建议用受控词：general=跨对话通用；report/code/review/product=任务类型。自由文本在自动投影中可能匹配不上任务。'))}</div>
          ${field(T('cognition.summary', '摘要'), window.uiInput({ id: `ca-cand-summary-${esc(candidate.id)}`, value: candidate.summary || '', attrs: { 'data-f': 'summary' } }))}
        </details>
        <div class="ca-detail-foot">
          ${field(T('cognition.evidence_refs', '证据引用'), `<div class="ca-chips">${refs.map(evidenceChip).join('') || `<span class="ca-note">${esc(T('cognition.candidate_no_evidence', '没有可追溯的证据引用；确认前建议先补证。'))}</span>`}</div>`)}
          ${actionsHtml}
        </div>
      ` : `
        <p class="ca-content-text">${esc(candidate.judgment || '')}</p>
        ${field(T('cognition.candidate_scope_label', '作用范围'), `<span class="ca-v">${esc(candidate.suggestedScope || T('cognition.asset_scope_unset', '未设置'))}</span>`)}
        ${actionsHtml}
      `}`;
  }

  function candidateFormCard(candidate) {
    const broken = evidenceMostlyUnavailable(candidate);
    return `
    <div class="ca-card ca-candidate-detail" data-cand-id="${esc(candidate.id)}" data-cand-type="${esc(candidate.suggestedType || '')}">
      <div class="ca-line">
        <div class="ca-row-title">${esc(candidateTitle(candidate))}</div>
        <div class="ca-right">${chip(categoryLabel(candidate.suggestedType))}${broken ? chip(T('cognition.candidate_evidence_weak', '证据不足'), 'amber') : ''}</div>
      </div>
      ${candidateFormBody(candidate)}
    </div>`;
  }

  function viewCandidate(route) {
    const candidate = S.candidates.find((c) => String(c.id) === String(route.candidateId));
    // 顶部「返回」按钮（原卡片底部的返回列表按钮已删，返回入口收在此处）。
    const backHtml = btn(`← ${T('common.back', '返回')}`, 'go-back', { className: 'ca-backlink' });
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
    return byText ? T(byText[0], byText[1]) : raw;
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
    return `${btn(`← ${T('cognition.tab_organize', '整理')}`, 'go-back', { className: 'ca-backlink' })}
    ${hero(
      T('cognition.organize_settings_title', '沉淀设置'),
      T('cognition.organize_settings_hint', '决定系统什么时候自动沉淀、沉淀出的内容要不要先经过你。'),
    )}
    <div class="ca-card ca-setting-row">
      <div class="ca-setting-copy">
        <div class="ca-row-title">${esc(T('cognition.nightly_capture_title', '夜间自动沉淀'))}</div>
        <div class="ca-sub">${esc(T('cognition.nightly_capture_hint', '夜间在所选时间自动整理当天结束的会话（消耗模型额度）；产出的内容进入「待我处理」，等你批准或调整。'))}</div>
      </div>
      ${nightlyOn ? `<label class="ca-setting-time"><span>${esc(T('cognition.nightly_capture_time', '开始时间'))}</span><input type="time" value="${esc(nightlyStart)}" data-act="nightly-time"></label>` : ''}
      <button type="button" class="ca-switch${nightlyOn ? ' is-on' : ''}" role="switch" aria-checked="${nightlyOn ? 'true' : 'false'}" data-act="nightly-toggle" aria-label="${esc(T('cognition.nightly_capture_title', '夜间自动沉淀'))}">
        <span class="ca-switch-knob" aria-hidden="true"></span>
      </button>
    </div>
    <div class="ca-card ca-setcard">
      <div class="ca-line">
        <div><div class="ca-row-title">${esc(T('cognition.capture_switch_title', '整理功能'))}</div>
        <div class="ca-sub">${esc(T('cognition.capture_switch_hint', '在「整理」列表里挑选会话手动沉淀；只有需要你判断时才打扰你。'))}</div></div>
        <div class="ca-right">${chip(enabled ? T('cognition.capture_switch_on', '已开启') : T('cognition.capture_switch_off', '已关闭'), enabled ? 'green' : 'line')}
          ${btn(enabled ? T('cognition.capture_toggle_off', '关闭') : T('cognition.capture_toggle_on', '开启'), 'capture-toggle', { small: true, danger: enabled, primary: !enabled })}</div>
      </div>
    </div>
    <div class="ca-card ca-setcard">
      <div class="ca-line">
        <div class="ca-row-title">${esc(T('cognition.capture_review_title', '候选怎么确认'))}</div>
      </div>
      <div class="ca-subnav">
        ${btn(T('cognition.capture_review_auto', '自动采纳'), 'capture-review-toggle', { id: 'auto', className: `ca-pill${reviewAuto ? ' is-on' : ''}` })}
        ${btn(T('cognition.capture_review_manual', '先问我'), 'capture-review-toggle', { id: 'manual', className: `ca-pill${!reviewAuto ? ' is-on' : ''}` })}
      </div>
      <p class="ca-note">${esc(T(reviewAuto ? 'cognition.capture_review_auto_note' : 'cognition.capture_review_manual_note', reviewAuto ? '符合条件的候选会自动采纳（不再询问）' : '候选先进入待确认，由你决定'))}</p>
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
    const runnableIds = (Array.isArray(S.captures) ? S.captures : []).filter((capture) => (capture.actions || []).includes('run_now'));

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
          <div class="ca-row is-flat">
            <div class="ca-row-main"><div class="ca-row-title ca-row-link" data-act="open-conversation" data-id="${esc(conv.id)}" ${roleBtn()} title="${esc(T('cognition.capture_action_open_conversation', '打开会话'))}">${esc(conv.title || conv.id)}</div><div class="ca-row-meta">${esc(convTime)}</div></div>
            <div class="ca-row-side">${excludedTag}${chip(T('cognition.capture_excluded_action_hint', '无需整理'), 'amber')}</div>
          </div>`;
        }
        return `
        <div class="ca-row is-flat">
          <div class="ca-row-main"><div class="ca-row-title">${esc(conv.title || conv.id)}</div><div class="ca-row-meta">${esc(convTime)}</div></div>
          <div class="ca-row-side">${btn(T('cognition.capture_manual_history_create', '开始整理'), 'organize-conv', { id: conv.id, small: true })}</div>
        </div>`;
      }
      const detailLink = `data-act="open-capture-detail" data-id="${esc(capture.id)}"`;
      const titleHtml = `<div class="ca-row-title ca-row-link" ${detailLink} ${roleBtn()} title="${esc(T('cognition.capture_detail_open_hint', '查看整理情况'))}">${esc(vocab ? vocab.recordTitle(capture) : String(capture.conversationTitle || conv.title || conv.id))}</div>`;
      const pending = Number(capture.reviewSummary && capture.reviewSummary.pending) || 0;
      const metaText = [
        vocab ? vocab.captureReasonText(capture.displayReason) : String(capture.displayReason || ''),
        pending ? T('cognition.capture_review_count', '{n} 条待确认', { n: String(pending) }) : '',
        convTime,
      ].filter(Boolean).join(' · ');
      // 用 isRunning 判定「整理中」（仅排队/提炼/写入）：等待类显示原因
      // chip；等待手动开始的行直接给「立即整理」按钮（不必进详情页）。
      const primaryAction = !isRunning(capture) && (capture.actions || []).includes('run_now')
        ? btn(T('cognition.capture_action_run_now', '立即整理'), 'capture-action', { id: capture.id, data: { action: 'run_now' }, small: true, primary: true })
        : '';
      const sideHtml = isRunning(capture)
        ? btn(T('cognition.organize_active_label', '整理中'), '', { small: true, primary: true, disabled: true })
        : `${excludedTag}${chip(
          vocab ? vocab.captureDisplayStatusText(capture.displayStatus) : String(capture.displayStatus || ''),
          capture.displayStatus === 'failed' ? 'red' : (capture.displayStatus === 'review_ready' || capture.displayStatus === 'completed') ? 'green' : 'amber',
        )}${primaryAction}`;
      return `
        <div class="ca-row is-flat">
          <div class="ca-row-main">${titleHtml}<div class="ca-row-meta">${esc(metaText)}</div></div>
          <div class="ca-row-side">${sideHtml}</div>
        </div>`;
    };

    const chips = [['', T('common.all', '全部')], ['attention', null], ['active', null], ['done', null],
      ...(excludedRows.length ? [['excluded', null]] : [])]
      .map(([id, label]) => {
        const text = label || (vocab ? vocab.captureBucketText(id) : id);
        const count = id === '' ? rows.length : id === 'excluded' ? excludedRows.length : rowBucketCounts[id];
        return btn(`${text} ${count}`, 'capture-filter', {
          id,
          className: `ca-chip ca-chip-btn${String(route.captureBucket || '') === id ? ' is-green' : ''}`,
        });
      }).join(' ');
    const batchBtns = [
      retryableIds.length ? btn(T('cognition.capture_batch_retry', '重试失败（{n}）', { n: String(retryableIds.length) }), 'capture-batch', { data: { batch: 'retry' }, small: true }) : '',
      runnableIds.length ? btn(T('cognition.capture_batch_run', '立即整理（{n}）', { n: String(runnableIds.length) }), 'capture-batch', { data: { batch: 'run_now' }, small: true, primary: true }) : '',
    ].filter(Boolean).join('');

    // 页首右侧只留一个齿轮（2026-09-15 子安标注）：点击进「沉淀设置」页。
    // 走共享 uiIconButton + icons.js 的 settings 图标（团队规范：图标不手写
    // SVG；全仓 agents/run-center 同形态）。icons.js 缺席时只丢图标不破功能。
    return `${hero(
      T('cognition.tab_organize', '整理'),
      T('cognition.capture_manual_note', '整理会使用模型额度，随时可以取消'),
      (window.uiIconButton
        ? window.uiIconButton({
          icon: 'settings',
          label: T('cognition.organize_settings_title', '沉淀设置'),
          className: 'ca-settings-btn',
          attrs: { 'data-act': 'go-organize-settings' },
        })
        : ''),
    )}
    <div class="ca-line ca-capture-toolbar">
      <div class="ca-chips">${chips}</div>
      ${batchBtns ? `<div class="ca-right">${batchBtns}</div>` : ''}
    </div>
    <div class="ca-card">${visibleRows.length ? visibleRows.map(rowHtml).join('') : `<div class="ca-note">${esc(route.captureBucket
      ? T('cognition.capture_log_empty_filtered', '这个筛选下没有整理记录')
      : T('cognition.capture_tasks_empty_hint', '一轮会话结束后，系统会在静默期结束后创建整理任务。'))}</div>`}
      ${conversationItems.length >= 100 ? `<div class="ca-sub">${esc(T('cognition.capture_sources_truncated', '仅显示最近 100 个会话（来源拉取上限）'))}</div>` : ''}
      ${filtered.length > 5 ? `<div class="ca-line ca-line-center">${btn(T(S.organizeListExpanded ? 'cognition.capture_list_collapse' : 'cognition.capture_list_expand', S.organizeListExpanded ? '收起' : `查看全部 ${filtered.length} 个会话`, { n: String(filtered.length) }), 'toggle-organize-list', { small: true })}</div>` : ''}
    </div>
    <p class="ca-footnote">${esc(T('cognition.capture_bucket_scope_note', '「需要我处理」包括待确认与被暂停的记录，比「待我处理」页只数失败的口径宽；「无留存内容」的记录只在「全部」里出现；「无需沉淀」收纳纯寒暄（含整理过的）与未得到回复的会话，点标题可回看内容。'))}</p>`;
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
            ? `<span class="ca-chip is-line">${esc(T('cognition.capture_detail_evidence_from', '来自消息 {label} · {when}', { label: message.label, when: fmtDate(message.ts) }))}</span>`
            : evidenceChip(ref);
        }).slice(0, 6).join(' ');
        return `<div class="ca-result-item">
          <div class="ca-result-head">
            ${chip(categoryLabel(candidate.suggestedType))}
            ${scope ? `<span class="ca-note">${esc(scope)}</span>` : ''}
            <span class="ca-right">${chip(label, tone)}</span>
          </div>
          <p class="ca-content-text">${esc(String(candidate.judgment || '').trim() || candidateTitle(candidate))}</p>
          ${evidenceBits ? `<div class="ca-chips">${evidenceBits}</div>` : ''}
        </div>`;
      }).join('');
      body = `${pendingEditable.length
        ? `<div class="ca-note">${esc(T('cognition.capture_detail_pending_hint', '发现 {n} 条待确认内容，在下方卡片中查看和确认。', { n: String(pendingEditable.length) }))}</div>`
        : ''}${cardHtml}${savedCount && !pendingEditable.length && !rejectedCandidates.length
        ? `<div class="ca-note">${esc(T('cognition.capture_detail_saved_hint', '这次整理的内容已保存为资产（见下方「已沉淀资产」）。'))}</div>`
        : ''}`;
    } else if (running) {
      body = `<div class="ca-note">${esc(T('cognition.capture_detail_result_pending', '整理还在进行，完成后这里会列出从这段对话发现的内容。'))}</div>`;
    } else {
      const modelReason = String(capture.noCandidateReason || '').trim();
      const filterText = vocab && capture.filterReason ? vocab.captureFilterReasonText(capture.filterReason) : '';
      body = `
      ${empty(T('cognition.capture_detail_result_none_title', '没有发现值得留存的内容'))}
      ${filterText ? `<div class="ca-note">${esc(T('cognition.capture_detail_filter_label', '筛选原因'))}：${esc(filterText)}</div>` : ''}
      ${modelReason ? `<blockquote class="ca-quote">${esc(modelReason)}</blockquote>` : ''}`;
    }
    return `<div class="ca-card ca-result-card">${sectionHead(T('cognition.capture_detail_result_title', '整理结果'))}${body}</div>`;
  }

  /* 对话上下文区：参与角色 + 消息时间线（展示口径 = 本次整理实际读到的消息，
   *  与模型看到的一致）；价值信号 chips 说明「为什么是这段」。 */
  function captureConversationSection(capture, context) {
    const vocab = NS.vocabulary;
    const signals = (Array.isArray(capture.screeningSignals) ? capture.screeningSignals : [])
      .filter((signal) => signal !== 'manual_selection');
    const signalChips = signals.length
      ? `<span class="ca-chips">${signals.map((signal) => chip(vocab ? vocab.captureSignalText(signal) : String(signal), 'line')).join(' ')}</span>`
      : '';
    if (!context || context.loading) {
      const hint = context && context.loading
        ? T('cognition.capture_detail_context_loading', '正在读取对话上下文…')
        : T('cognition.capture_detail_context_unavailable', '消息内容不可用（会话可能已被清理或迁移）。');
      return `<div class="ca-card">${sectionHead(T('cognition.capture_detail_context_title', '对话上下文'), '', signalChips)}<div class="ca-note">${esc(hint)}</div></div>`;
    }
    const nameById = new Map((context.participants || []).map((p) => [String(p.id), p]));
    const actorName = (actorId) => {
      if (actorId === 'user') return T('cognition.capture_detail_you', '你');
      if (actorId === 'commander') return T('cognition.capture_detail_commander', '指挥官');
      const participant = nameById.get(String(actorId));
      return participant ? participant.name : String(actorId);
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
          <div class="ca-tl-head"><b>${esc(actorName(message.from))}</b><span class="ca-note">${esc(message.label)} · ${esc(fmtDate(message.ts))}</span></div>
          ${bodyHtml}
          ${message.truncated ? `<div class="ca-note">${esc(T('cognition.capture_detail_msg_truncated', '内容过长，已截断'))}</div>` : ''}
          ${artifacts.length ? `<div class="ca-chips">${artifacts.map((artifact) => chip(artifact.title || artifact.id, 'line')).join(' ')}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    const participantsHtml = (context.participants || []).length
      ? `<div class="ca-chips ca-participants">${(context.participants || []).map((p) => chip(actorName(p.id), p.kind === 'user' ? 'green' : '')).join(' ')}</div>`
      : '';
    return `<div class="ca-card">
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
    const backHtml = btn(`← ${T('common.back', '返回')}`, 'go-back', { className: 'ca-backlink' });
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
    // ca-card——cand-type 与 readCandidateForm 靠 closest 就近定位，多候选时
    // 各块互不串值。
    const pendingFormBlocks = (Array.isArray(capture.candidateIds) ? capture.candidateIds : [])
      .map((id) => (Array.isArray(S.candidates) ? S.candidates : []).find((row) => String(row.id) === String(id)))
      .filter((row) => row && candidatePending(row) && row.capabilities && row.capabilities.canEdit)
      .map((candidate) => `<div class="ca-candidate-detail ca-pending-block" data-cand-id="${esc(candidate.id)}" data-cand-type="${esc(candidate.suggestedType || '')}">${candidateFormBody(candidate)}</div>`)
      .join('');
    const summary = capture.reviewSummary || {};
    /** 卡头元信息项：浅色标签 + 墨色值，流式排（空值不占位）。 */
    const metaItem = (label, value) => (value
      ? `<span class="ca-meta-item"><i>${esc(label)}</i>${esc(value)}</span>`
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
      : String(capture.displayStatus || '');
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
        ${statement ? `<p class="ca-content-text">${esc(statement)}</p>` : ''}
        <div class="ca-deposit-foot"><span class="ca-note">v${esc(String(receipt.version || '1'))}</span>${btn(T('cognition.capture_action_view_assets', '查看资产'), 'open-asset', { id: receipt.assetId, small: true })}</div>
      </div>`;
    }).join('');
    return `${backHtml}
    ${hero(
      vocab ? vocab.recordTitle(capture) : String(capture.conversationTitle || capture.id || ''),
      vocab ? vocab.captureReasonText(capture.displayReason) : String(capture.displayReason || ''),
      statsRow([
        [Number(summary.pending) || 0, T('cognition.capture_metric_review', '待确认')],
        [Number(summary.promoted) || 0, T('cognition.capture_detail_assets', '已沉淀资产')],
        [Number(capture.attempt) || 1, T('cognition.capture_detail_attempt', '尝试次数')],
      ]),
    )}
    ${captureResultSection(capture, messageBySourceId)}
    ${captureConversationSection(capture, contextHit ? (contextHit.loading ? { loading: true } : context) : null)}
    <div class="ca-card ca-capture-panel">
      <div class="ca-capture-head">
        ${chip(headStatus.label, headStatus.tone)}
        <div class="ca-meta-row">
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
  function routeKey(route) {
    return [route.name, route.assetId, route.candidateId, route.captureId, route.category, route.captureBucket].join('|');
  }

  function render() {
    const root = document.getElementById('ca-root');
    if (!root) return;
    const route = S.route;
    const key = routeKey(route);
    const previousScroll = document.getElementById('ca-scroll');
    const restoreScroll = lastRenderKey === key && previousScroll ? previousScroll.scrollTop : 0;
    lastRenderKey = key;
    // 候选详情归「待我处理」、整理详情归「整理」；interactive-tour 靠
    // data-cognition-page-link="assets"/"captures" 定位 tab，随重构迁移。
    const activeTab = route.name === 'review' || route.candidateId ? 'review'
      : route.name === 'organize' || route.name === 'organize-settings' || route.captureId ? 'organize' : 'overview';
    const tabsHtml = `<nav class="ca-tabs">${NS.TABS.map((tab) => {
      const active = activeTab === tab.id;
      const extra = tab.id === 'overview' ? ' data-cognition-page-link="assets"' : (tab.id === 'organize' ? ' data-cognition-page-link="captures"' : '');
      // 2026-09-15 子安要求：tab 只留标题，描述小字与 title 悬浮注释删除。
      return `<div class="ca-tab${active ? ' is-on' : ''}" data-act="tab" data-id="${tab.id}"${extra} ${roleBtn()}>
        <strong>${esc(T(tab.titleKey, tab.title))}</strong>
      </div>`;
    }).join('')}</nav>`;
    let body = '';
    if (S.loading && !S.loaded) {
      // 首载骨架：结构化的三行占位（shimmer 由 CSS 驱动），比纯文字更快有页面感。
      body = `<div class="ca-loading"><div class="ca-skel-row"></div><div class="ca-skel-row"></div><div class="ca-skel-row"></div></div>`;
    } else if (route.name === 'review') body = viewReview(route);
    else if (route.name === 'organize') body = route.captureId ? viewCaptureDetail(route) : viewOrganizeTasks(route);
    else if (route.name === 'organize-settings') body = viewOrganizeSettingsPage();
    else body = viewOverview(route);
    const errorBanner = S.errors.length && S.loaded
      ? `<div class="ca-banner">${esc(T('cognition.partial_load', '部分数据读取失败，页面已用可用数据渲染。'))}${btn(T('common.retry', '重试'), 'refresh', { small: true })}</div>`
      : '';
    root.innerHTML = `
      <div class="ca-app">
        ${tabsHtml}
        ${errorBanner}
        <div class="ca-scroll" id="ca-scroll">${body}</div>
      </div>`;
    const main = document.getElementById('ca-scroll');
    if (main && restoreScroll) main.scrollTop = restoreScroll;
  }
  NS.render = render;
})();
