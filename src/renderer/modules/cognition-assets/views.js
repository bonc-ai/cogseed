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
    return window.uiButton({
      label,
      className: classes,
      size: opts.small ? 'sm' : 'md',
      ...(opts.disabled ? { disabled: true } : {}),
      attrs: Object.assign(
        {},
        act ? { 'data-act': act } : {},
        opts.id != null ? { 'data-id': String(opts.id) } : {},
        opts.data || {},
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

  const hero = (kicker, title, hint, statsHtml) => `
    <div class="ca-hero">
      <div class="ca-hero-main">
        <span class="ca-kicker">${esc(kicker)}</span>
        <h2>${esc(title)}</h2>
        <p>${esc(hint)}</p>
      </div>
      ${statsHtml || ''}
    </div>`;

  const empty = (title, hint, actionHtml) => `
    <div class="ca-empty">
      <div class="ca-empty-icon" aria-hidden="true">◎</div>
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
    const label = sourceRefUnavailable(ref)
      ? T('cognition.source_unavailable_label', '来源记录不可用')
      : String(ref.title || ref.conversationTitle || ref.name || sourceIndex().get(String(ref.id || ''))?.title || '').trim();
    return chip(label || T('cognition.source_deleted', '来源已删除'), sourceRefUnavailable(ref) ? 'amber' : 'line');
  };

  const candidatePending = (candidate) => !!(candidate.capabilities && candidate.capabilities.countsAsPending);
  const candidateTitle = (candidate) => String(candidate.judgment || candidate.summary || '').trim().slice(0, 60)
    || T('cognition.candidate_untitled', '未命名候选');

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
      <g class="ca-fig-soil" data-act="go-sources" role="button" tabindex="0">
        <title>${esc(T('cognition.tree_soil_hint', '采集与来源记录保留在这里；点击查看数据来源'))}</title>
        <rect x="76" y="392" width="336" height="58" rx="8"/>
        <text x="244" y="426" text-anchor="middle">${esc(T('cognition.tree_soil_label', '土壤 · 来源 {s} · 采集 {c}', { s: String(Number(info.sources || 0)), c: String(Number(info.captures || 0)) }))}</text>
      </g>
      <g class="ca-fig-soil" data-act="go-experiences" role="button" tabindex="0">
        <title>${esc(T('cognition.tree_soil_experience_hint', '真实任务的过程记录（KSTAR 经验）；点击查看'))}</title>
        <rect x="428" y="392" width="196" height="58" rx="8"/>
        <text x="526" y="426" text-anchor="middle">${esc(T('cognition.tree_soil_experience', '经验 · {n}', { n: String(Number(info.experiences || 0)) }))}</text>
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
      <g class="ca-fig-crown${validated > 0 ? '' : ' is-empty'}" data-act="open-evidence" role="button" tabindex="0">
        <title>${esc(T('cognition.tree_crown_hint', '已被真实复用或验证有效的资产；点击查看使用证明'))}</title>
        <rect x="206" y="60" width="48" height="38" rx="6"/>
        <rect x="446" y="60" width="48" height="38" rx="6"/>
        <rect x="252" y="40" width="196" height="58" rx="8"/>
        <text x="350" y="75" text-anchor="middle">${esc(T('cognition.tree_crown_validated', '已验证 {n}', { n: String(validated) }))}</text>
      </g>
    </svg>`;
  }

  /* ────────────────────────── 资产详情 ────────────────────────── */

  function assetDetail(asset) {
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
    const originText = {
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
          <div class="ca-sub">${esc(categoryLabel(asset.type))} · v${esc(String(asset.version || '1'))} · ${esc(T('cognition.asset_updated', '更新于'))} ${esc(fmtDate(asset.updatedAt || asset.createdAt))}</div>
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
      ${affectedCopy.length ? `<div class="ca-sect"><p class="ca-note">${esc(affectedCopy[0])}</p><div class="ca-actions">${affectedCopy.slice(1).join('')}${proofCount ? btn(T('cognition.asset_usage_link', '查看使用记录'), 'open-evidence', { small: true }) : ''}</div></div>` : ''}
      <div class="ca-more-wrap">
        ${btn(T('cognition.asset_more', '更多操作'), 'toggle-asset-more', { className: 'ca-more-toggle' })}
        <div class="ca-more" data-asset-more hidden>
          ${moreRow(T('cognition.asset_delete', '删除'), T('cognition.asset_delete_hint', '从资产列表移除，历史记录保留'), 'delete')}
          ${moreRow(T('cognition.asset_revoke', '撤回使用'), T('cognition.asset_revoke_hint', '只影响未来的任务'), 'revoke')}
          ${moreRow(T('cognition.asset_purge', '彻底清除'), T('cognition.asset_purge_hint', '删除全部历史与证据，不可恢复'), 'purge')}
        </div>
      </div>
    </div>`;
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
      T('cognition.tree_eyebrow', '我的认知'), T('cognition.overview_title', '我的认知资产'),
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
      // 详情视图不显示统计条：那是列表页的上下文，详情页只讲这一条资产。
      if (asset) return hero(T('cognition.tree_eyebrow', '我的认知'), T('cognition.overview_title', '我的认知资产'), '') + assetDetail(asset);
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
          <div class="ca-row-side">${assetStatusChip(asset)}<span class="ca-chevron">›</span></div>
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
        ${treeBlocks(counts, { pending: stats.pending, validated: stats.transferOk, sources: sourceCount, captures: captureCount, experiences: S.experienceTotal })}
        <div class="ca-tree-cap">${esc(T('cognition.tree_legend_bud_hint', '枝头的小点是还没确认的候选；确认后它会成为同一根主枝上的正式资产。'))}</div>
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
        <div class="ca-row-title">${esc(candidateTitle(candidate))} <span class="ca-chevron" aria-hidden="true">›</span></div>
        <div class="ca-right">${chip(categoryLabel(candidate.suggestedType), '')} ${broken ? chip(T('cognition.candidate_evidence_weak', '来源已删'), 'amber') : chip(T('cognition.candidate_evidence_ok', '证据充足'), 'green')}</div>
      </div>
      <p class="ca-content-text">${esc(String(candidate.judgment || candidate.value || '').slice(0, 220))}</p>
      ${refsHtml}${warnHtml}
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
      attention.push(`<div class="ca-attention-row" data-act="go-sources" ${roleBtn()}><span>${esc(T('cognition.overview_source_issues', '{count} 条来源记录需要处理', { count: String(stats.sourceIssues) }))}</span><b>${esc(T('common.handle', '处理'))}</b></div>`);
    }
    if (stats.failedTasks) {
      attention.push(`<div class="ca-attention-row" data-act="go-organize" ${roleBtn()}><span>${esc(T('cognition.overview_failed_tasks', '{count} 个整理任务需要重试', { count: String(stats.failedTasks) }))}</span><b>${esc(T('common.handle', '处理'))}</b></div>`);
    }
    return `${hero(
      T('cognition.inbox', '待我处理'), T('cognition.review_title', '待我处理'),
      T('cognition.inbox_page_hint', '每条只需要一个决定：保存，还是不保存。'),
      statsRow([
        [healthy.length, T('cognition.review_stat_wait', '等待确认')],
        [broken.length, T('cognition.review_stat_evidence', '来源已删')],
      ]),
    )}
    ${attention.length ? `<div class="ca-notice">${attention.join('')}</div>` : ''}
    ${sectionHead(T('cognition.review_group_wait', '等待你确认'), T('cognition.review_group_wait_note', '确认后会创建 v1，并保留来源与撤销入口'))}
    ${healthy.length ? healthy.map((c) => candidateCard(c, false)).join('') : `<div class="ca-card">${empty(T('cognition.review_empty_wait', '当前没有等待确认的候选'))}</div>`}
    ${broken.length ? sectionHead(T('cognition.review_group_evidence', '来源已删除的候选'), T('cognition.review_group_evidence_note', '这些候选的原始出处已被删除；可以点开确认后仍要保存，或选择不保存')) + broken.map((c) => candidateCard(c, true)).join('') : ''}
    ${processed.length ? sectionHead(T('cognition.inbox_processed_badge', '处理记录'), T('cognition.inbox_processed_hint', '按处理时间倒序，只显示已处理的决定')) + `<div class="ca-card">${processed.map((c) => `
      <div class="ca-row is-flat">
        <div class="ca-row-main"><div class="ca-row-title">${esc(candidateTitle(c))}</div>
        <div class="ca-row-meta">${esc(fmtDate(c.updatedAt || c.createdAt))} · ${esc(processedLabel(c))}</div></div>
      </div>`).join('')}</div>` : ''}`;
  }

  /* ────────────────────────── 视图：候选详情 ────────────────────────── */

  function viewCandidate(route) {
    const candidate = S.candidates.find((c) => String(c.id) === String(route.candidateId));
    // 顶部「返回」按钮（原卡片底部的返回列表按钮已删，返回入口收在此处）。
    const backHtml = btn(`← ${T('common.back', '返回')}`, 'go-back', { className: 'ca-backlink' });
    if (!candidate) {
      return `${backHtml}${hero(T('cognition.candidate_eyebrow', 'CANDIDATE'), T('cognition.candidate_detail_title', '候选详情'), '')}${empty(T('cognition.candidate_detail_missing', '这条候选已不在待处理列表中'), '')}`;
    }
    const refs = evidenceRefs(candidate);
    const broken = evidenceMostlyUnavailable(candidate);
    const edit = candidate.capabilities && candidate.capabilities.canEdit;
    const field = (label, inner) => `<label class="ca-field"><span>${esc(label)}</span>${inner}</label>`;
    const actionsHtml = `<div class="ca-actions ca-actions-right">
        ${(candidate.capabilities && candidate.capabilities.canPromote) ? btn(T('cognition.candidate_save_and_use', '保存并使用'), 'cand-adopt-with-form', { id: candidate.id, primary: true }) : ''}
        ${btn(T('cognition.candidate_reject', '拒绝'), 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true })}
      </div>`;
    return `${backHtml}
    ${hero(
      T('cognition.candidate_eyebrow', 'CANDIDATE'), T('cognition.candidate_detail_title', '确认内容，也确认它该在什么范围生效'),
      T('cognition.candidate_detail_hint', '确认后会创建正式资产的第一个版本，并保留来源与撤销入口。'),
    )}
    <div class="ca-card ca-candidate-detail" data-cand-type="${esc(candidate.suggestedType || '')}">
      <div class="ca-line">
        <div class="ca-row-title">${esc(candidateTitle(candidate))}</div>
        <div class="ca-right">${chip(categoryLabel(candidate.suggestedType))}${broken ? chip(T('cognition.candidate_evidence_weak', '证据不足'), 'amber') : ''}</div>
      </div>
      ${broken ? `<div class="ca-warn">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或选择不保存。'))}</div>` : ''}
      ${edit ? `
        ${field(T('cognition.type', '类型'), `<div class="ca-chips">${CATEGORIES.map(([id, key, fb]) => { const on = String(candidate.suggestedType || '') === id; return `<span class="ca-chip ca-chip-opt${on ? ' is-green' : ''}" data-act="cand-type" data-id="${esc(id)}" ${roleBtn(`aria-pressed="${on ? 'true' : 'false'}"`)}>${esc(T(key, fb))}</span>`; }).join('')}</div>`)}
        ${field(T('cognition.judgment', '具体内容'), window.uiTextarea({ id: 'ca-cand-judgment', value: candidate.judgment || '', attrs: { 'data-f': 'judgment' } }))}
        <details class="ca-advanced">
          <summary>${esc(T('cognition.candidate_advanced', '高级选项（通常不用改）'))}</summary>
          ${field(T('cognition.candidate_scope_label', '作用范围'), window.uiInput({ id: 'ca-cand-scope', value: candidate.suggestedScope || '', placeholder: T('cognition.candidate_scope_placeholder', '例如：仅产品工作空间'), attrs: { 'data-f': 'scope' } }))}
          <div class="ca-note">${esc(T('cognition.candidate_scope_hint', '建议用受控词：general=跨对话通用；report/code/review/product=任务类型。自由文本在自动投影中可能匹配不上任务。'))}</div>
          ${field(T('cognition.summary', '摘要'), window.uiInput({ id: 'ca-cand-summary', value: candidate.summary || '', attrs: { 'data-f': 'summary' } }))}
        </details>
        <div class="ca-detail-foot">
          ${field(T('cognition.evidence_refs', '证据引用'), `<div class="ca-chips">${refs.map(evidenceChip).join('') || `<span class="ca-note">${esc(T('cognition.candidate_no_evidence', '没有可追溯的证据引用；确认前建议先补证。'))}</span>`}</div>`)}
          ${actionsHtml}
        </div>
      ` : `
        <p class="ca-content-text">${esc(candidate.judgment || '')}</p>
        ${field(T('cognition.candidate_scope_label', '作用范围'), `<span class="ca-v">${esc(candidate.suggestedScope || T('cognition.asset_scope_unset', '未设置'))}</span>`)}
        ${actionsHtml}
      `}
    </div>`;
  }

  /* ────────────────────────── 视图：使用与证明 ────────────────────────── */

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
  const eventTitle = (proof) => {
    const byKind = EVENT_TITLES[String(proof.kind || '')];
    if (byKind) return T(byKind[0], byKind[1]);
    const raw = String(proof.outcome || proof.title || proof.kind || '');
    const byText = EVENT_TITLE_BY_TEXT[raw];
    return byText ? T(byText[0], byText[1]) : raw;
  };
  /** 事件摘要过滤：版本号（meta 已显示）与技术 ID 不展示给用户；
   *  已知技术串翻成人话，其余原样（未来若写入人话摘要可直接透出）。 */
  const proofSummary = (proof) => {
    const text = String(proof.summary || '').trim();
    if (!text) return '';
    if (/^v\d+$/i.test(text) || /^version\s*\d+$/i.test(text)) return '';
    if (text.startsWith('review_decision:')) return '';
    if (text === 'conversation_reply') return T('cognition.proof_summary_conversation', '来自一次对话');
    return text;
  };

  function viewEvidence(route) {
    const stats = NS.stats();
    const proofs = S.proofs;
    const byAsset = new Map();
    for (const proof of proofs) {
      const assetId = String((proof.refs || {}).assetId || '');
      if (!assetId) continue;
      if (!byAsset.has(assetId)) byAsset.set(assetId, []);
      byAsset.get(assetId).push(proof);
    }
    const heroHtml = hero(
      T('cognition.proofs_eyebrow', 'USAGE'), T('cognition.proofs_title', '使用记录'),
      T('cognition.proofs_page_hint', '资产在任务里的使用记录和你的评价。'),
      statsRow([
        [stats.coveredAssets, T('cognition.proofs_assets_covered', '涉及资产')],
        [stats.proofCount, T('cognition.proofs_event_count', '使用与证明记录')],
        [proofs.filter((p) => p.kind === 'effectiveness_recorded').length, T('cognition.proofs_effect_count', '效果评价')],
      ]),
    );
    if (!proofs.length) {
      return heroHtml + `<div class="ca-card">${empty(
        T('cognition.proofs_empty_title', '还没有资产被真实使用过'),
        T('cognition.proofs_empty_hint', '当资产在任务中被真正使用、并留下可核对的记录后，会在这里出现。系统不会把「已注入」当作「已使用」，也不会把「被使用」当作「有效」。'),
        `<div class="ca-steps">${esc(T('cognition.proofs_empty_steps', '① 确认资产 → ② 任务中使用 → ③ 留下使用记录 → ④ 效果验证'))}</div>${btn(T('cognition.proof_open_asset', '查看资产'), 'open-overview', { primary: true })}`,
      )}</div>`;
    }
    // 会话名 join：事件只带 conversationId，用户看不懂裸 id——按来源清单
    // 里的会话项翻成标题；join 不到（会话已删/老数据无此字段）用泛称，
    // 不编造名字。整句叙事见 proofSentence。
    const convNames = new Map();
    for (const group of S.sources) {
      for (const item of Array.isArray(group.items) ? group.items : []) {
        if (item.kind === 'conversation' && item.id) convNames.set(String(item.id), String(item.title || ''));
      }
    }
    const wherePhrase = (cid) => {
      const name = cid ? convNames.get(String(cid)) : '';
      // name 不在此处 esc：proofSentence 的返回值整体过 esc（T() 只做占位
      // 替换），内层再转义会把 & < > 显示成实体（双重转义）。
      return name
        ? T('cognition.proof_where_named', '对话《{name}》里', { name })
        : T('cognition.proof_where_generic', '一次对话里');
    };
    /** 事件整句化（用户要求：一句话说明在什么时间、哪个对话里被怎么用）。 */
    const proofSentence = (proof) => {
      const refs = proof.refs || {};
      const when = fmtDate(proof.occurredAt);
      const where = wherePhrase(refs.conversationId);
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
      return T('cognition.proof_sentence_unknown', '{when}，{title}', { when, title: eventTitle(proof) });
    };
    const sections = [...byAsset.entries()].map(([assetId, items]) => {
      const asset = S.assets.find((a) => String(a.id) === assetId);
      const title = asset ? (asset.title || assetId) : assetId;
      // 卡片默认收缩：头部只给概要（使用/带入次数 + 最近时间），点开看逐条。
      const expanded = S.expandedProofs.has(String(assetId));
      const usedCount = items.filter((p) => p.kind === 'usage_recorded').length;
      const projectedCount = items.filter((p) => p.kind === 'projection_confirmed').length;
      const lastAt = items.reduce((max, p) => (String(p.occurredAt || '') > max ? String(p.occurredAt) : max), '');
      const summaryLine = [
        usedCount ? T('cognition.proof_used_times', '被实际使用 {n} 次', { n: String(usedCount) }) : '',
        projectedCount ? T('cognition.proof_projected_times', '被带入任务 {n} 次', { n: String(projectedCount) }) : '',
        lastAt ? T('cognition.proof_last_at', '最近 {when}', { when: fmtDate(lastAt) }) : '',
      ].filter(Boolean).join(' · ');
      const rows = items.slice(0, 20).map((proof) => {
        const refs = proof.refs || {};
        const isOpen = String(route.proofEventId) === String(proof.id);
        const transferProofId = String(refs.transferProofId || '');
        const kind = String(proof.kind || '');
        let ratingHtml = '';
        if (isOpen) {
          // 评价闸门（对齐后端 E_RECALL_* 口径）：只有「被实际使用」
          // （usage_recorded）且留下迁移证明的事件才可评——此前只看
          // transferProofId 字段存在就渲染按钮，投影/降级行点了必吃后端
          // 报错（旧实现的闸门随 skills.js 瘦身丢失，2026-09-14 恢复）。
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
            <span class="ca-proof-body"><strong class="ca-proof-sentence">${esc(proofSentence(proof))}</strong></span>
          </div>
          ${ratingHtml}
        </div>`;
      }).join('');
      return `<div class="ca-card ca-proof-asset">
        <div class="ca-proof-head-row">
          <div class="ca-proof-head" data-act="toggle-proof-asset" data-id="${esc(assetId)}" aria-expanded="${expanded ? 'true' : 'false'}" ${roleBtn()}>
            <span class="ca-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
            <span class="ca-proof-head-main">
              <span class="ca-row-title">${esc(title)}</span>
              ${summaryLine ? `<span class="ca-sub">${esc(summaryLine)}</span>` : ''}
            </span>
          </div>
          <div class="ca-right"><span class="ca-note">${esc(String(items.length))} ${esc(T('cognition.common_records', '条'))}</span>${btn(T('cognition.proof_open_asset', '查看资产'), 'open-asset', { id: assetId, small: true })}</div>
        </div>
        ${expanded ? `<div class="ca-proof-list">${rows}</div>` : ''}
      </div>`;
    }).join('');
    return `${heroHtml}${sections}`;
  }

  /* ────────────────────────── 视图：设置与管理 ────────────────────────── */

  const MANAGE_TABS = [
    ['sources', 'cognition.tab_sources', '来源健康'],
    ['organize', 'cognition.capture_activity_title', '整理方式'],
  ];

  function viewManage(route) {
    const sub = route.manageTab === 'organize' ? 'organize' : 'sources';
    const nav = `<div class="ca-subnav">${MANAGE_TABS.map(([id, key, fb]) => btn(T(key, fb), 'manage-tab', { id, className: `ca-pill${sub === id ? ' is-on' : ''}`, ...(id === 'organize' ? { data: { 'cognition-page-link': 'captures' } } : {}) })).join('')}</div>`;
    if (sub === 'organize') return nav + viewOrganize();
    // 两层结构：无 sourceKind=五类概览；有=该类明细（下钻）。
    return nav + (route.sourceKind ? viewSourceDetail(route) : viewSourcesOverview());
  }

  /** 来源健康口径（与顶部待办一致）：failed，或非用户主动暂停的 paused。 */
  function sourceItemNeedsAttention(item) {
    return item.status === 'failed'
      || (item.status === 'paused' && String(item.statusReason || '') !== 'source_paused');
  }

  /* 概览层：五类来源各一张卡——名称、条数、健康徽标、异常摘要；点卡片下钻明细。 */
  function viewSourcesOverview() {
    const groups = S.sources;
    const cards = groups.map((group) => {
      const kind = String(group.kind || '');
      const items = Array.isArray(group.items) ? group.items : [];
      const issues = items.filter(sourceItemNeedsAttention);
      const health = !items.length
        ? chip(T('cognition.sources_health_empty', '空'), '')
        : issues.length
          ? chip(T('cognition.sources_health_issues', '{n} 条异常', { n: String(issues.length) }), 'amber')
          : chip(T('cognition.sources_health_ok', '正常'), 'green');
      const issueRows = issues.slice(0, 2).map((item) => `
        <div class="ca-row is-flat">
          <div class="ca-row-main"><div class="ca-row-title">${esc(item.title || item.id)}</div>
          <div class="ca-row-meta">${esc(NS.vocabulary ? NS.vocabulary.sourceReasonText(item.statusReason) || NS.vocabulary.sourceStatusText(item.status) : String(item.status || ''))}</div></div>
        </div>`).join('');
      return `<div class="ca-card ca-source-card" data-act="go-source-kind" data-id="${esc(kind)}" ${roleBtn()}>
        <div class="ca-line">
          <div><div class="ca-row-title">${esc(NS.vocabulary ? NS.vocabulary.kindLabel(kind) : kind)}</div>
          <div class="ca-sub">${esc(items.length)} ${esc(T('cognition.sources_items_unit', '条'))}</div></div>
          <div class="ca-right">${health}<span class="ca-chevron" aria-hidden="true">›</span></div>
        </div>
        ${issueRows ? `<div class="ca-warn">${issueRows}</div>` : ''}
      </div>`;
    }).join('');
    return `${hero(
      T('cognition.sources_eyebrow', 'SOURCES'), T('cognition.sources_title', '来源健康'),
      T('cognition.sources_page_hint', '认知资产只从这五类来源采集。这里看每类的健康状态；点开看明细。'),
    )}
    ${cards || `<div class="ca-card">${empty(T('cognition.sources_empty', '还没有任何来源记录'), T('cognition.sources_empty_hint', '完成几轮对话后，会话、文件与执行记录会作为来源出现在这里。'))}</div>`}
    <p class="ca-footnote">${esc(T('cognition.source_boundary_hint', '普通内容先成为候选；只有用户教学信号可在限定范围内形成可撤销回执。'))}</p>`;
  }

  /* 明细层：某一类来源的全部条目——状态与原因用人话，操作按状态条件渲染。 */
  function viewSourceDetail(route) {
    const kind = String(route.sourceKind || '');
    const group = S.sources.find((row) => String(row.kind || '') === kind);
    const items = Array.isArray(group && group.items) ? group.items : [];
    const usable = items.filter((i) => i.status === 'ready' || !i.status).length;
    const issues = items.filter(sourceItemNeedsAttention).length;
    const kindName = NS.vocabulary ? NS.vocabulary.kindLabel(kind) : kind;
    const rows = items.map((item) => {
      const statusText = NS.vocabulary ? NS.vocabulary.sourceStatusText(item.status) : String(item.status || '');
      const reasonText = NS.vocabulary ? NS.vocabulary.sourceReasonText(item.statusReason) : '';
      const needsAttention = sourceItemNeedsAttention(item);
      const userPaused = item.status === 'paused' && String(item.statusReason || '') === 'source_paused';
      const action = needsAttention && item.status === 'failed'
        ? btn(T('cognition.source_retry', '重试'), 'source-action', { id: item.id, data: { action: 'retry', kind }, small: true })
        : item.status === 'paused'
          ? btn(T('cognition.source_resume', '恢复'), 'source-action', { id: item.id, data: { action: 'resume', kind }, small: true })
          : btn(T('cognition.source_pause', '暂停'), 'source-action', { id: item.id, data: { action: 'pause', kind }, small: true });
      return `<div class="ca-row is-flat">
        <div class="ca-row-main">
          <div class="ca-row-title">${esc(item.title || item.id)}</div>
          <div class="ca-row-meta">${esc(statusText)}${reasonText && needsAttention ? ` · ${esc(reasonText)}` : (userPaused && reasonText ? ` · ${esc(reasonText)}` : '')}</div>
        </div>
        <div class="ca-row-side">${action}</div>
      </div>`;
    }).join('');
    return `${btn(`← ${T('cognition.sources_back_overview', '返回来源概览')}`, 'go-sources-overview', { className: 'ca-backlink' })}
    ${hero(T('cognition.sources_eyebrow', 'SOURCES'), kindName,
      T('cognition.sources_detail_hint', '这一类来源的全部条目；异常条目带原因与处理入口。'))}
    <div class="ca-statbar">
      <div class="ca-stat"><b>${items.length}</b><span>${esc(T('cognition.sources_stat_visible', '收录条目'))}</span></div>
      <div class="ca-stat"><b>${usable}</b><span>${esc(T('cognition.sources_stat_usable', '可用'))}</span></div>
      <div class="ca-stat"><b class="${issues ? 'is-warn' : ''}">${issues}</b><span>${esc(T('cognition.sources_stat_issues', '需要处理'))}</span></div>
    </div>
    ${rows || `<div class="ca-card">${empty(T('cognition.sources_detail_empty', '这一类还没有来源条目'))}</div>`}`;
  }

  /* ────────────────────────── 视图：提炼出的经验 ────────────────────────── */
  /* 经验（KSTAR review.lesson）的家：入口在认知树土壤区的「经验」块，
   * 不再挂在来源页（2026-09-14 归位——来源页只讲采集渠道健康）。 */
  function viewExperiences() {
    const list = Array.isArray(S.experiences) ? S.experiences : [];
    const total = Number(S.experienceTotal || list.length) || 0;
    const timeLabel = (iso) => {
      const d = new Date(String(iso || ''));
      if (Number.isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const rows = list.map((exp) => `
      <div class="ca-row is-flat">
        <div class="ca-row-main">
          <div class="ca-row-title">${esc(exp.lesson || '')}</div>
          <div class="ca-row-meta">${exp.goal ? `${esc(exp.goal)} · ` : ''}${esc(timeLabel(exp.createdAt))}</div>
        </div>
        <div class="ca-row-side">${chip(exp.precipitated ? T('cognition.exp_precipitated', '已沉淀成候选') : T('cognition.exp_not_precipitated', '未沉淀'), exp.precipitated ? 'green' : 'line')}</div>
      </div>`).join('');
    return `${hero(
      T('cognition.experiences_eyebrow', 'EXPERIENCES'), T('cognition.experiences_title', '提炼出的经验'),
      T('cognition.experiences_hint', '从任务中提炼出的可复用教训（KSTAR）；达到沉淀门槛的会自动成为候选。'),
    )}
    <div class="ca-card ca-source-card">
      ${rows || `<div class="ca-sub">${esc(T('cognition.experiences_empty', '还没有提炼出的经验；任务中发现的教训会出现在这里。'))}</div>`}
      ${total > list.length ? `<div class="ca-sub">${esc(T('cognition.experiences_more_hint', '仅显示最近 {n} 条', { n: String(list.length) }))}</div>` : ''}
    </div>`;
  }

  function viewOrganize() {
    const settings = S.captureSettings || {};
    const policy = String(settings.executionPolicy || 'smart');
    const enabled = settings.enabled !== false;
    const reviewAuto = String(settings.reviewPolicy || 'auto') === 'auto';
    const POLICY = [
      ['smart', 'cognition.capture_policy_smart_title', '任务结束后发现', 'cognition.capture_policy_smart_hint', '任务完成或出现用户纠正时，在本机分析有意义的变化。'],
      ['nightly', 'cognition.capture_policy_nightly_title', '本地夜间整理', 'cognition.capture_policy_nightly_hint', '仅在你启用后运行；设备休眠时顺延到下一个可运行窗口。'],
      ['manual', 'cognition.capture_policy_manual_title', '主动整理', 'cognition.capture_policy_manual_hint', '从历史会话里挑选内容整理，读取前会先让你确认范围。'],
    ];
    const policyEntry = POLICY.find(([id]) => id === policy) || POLICY[0];
    return `${hero(
      T('cognition.tab_manage', '设置与管理'), T('cognition.capture_activity_title', '整理方式'),
      T('cognition.capture_activity_hint', '这几项决定候选什么时候被提炼、要不要先经过你确认。'),
      statsRow([
        [Number((S.captureCounts && S.captureCounts.review) || 0), T('cognition.capture_metric_review', '待确认')],
        [Number((S.captureCounts && S.captureCounts.processing) || 0), T('cognition.capture_metric_processing', '处理中')],
        [Number((S.captureCounts && S.captureCounts.failed) || 0), T('cognition.capture_metric_abnormal', '失败')],
      ]),
    )}
    <div class="ca-flow">${[T('cognition.capture_chain_source', '会话 / 执行结果'), T('cognition.capture_chain_candidate', '提取候选'), T('cognition.capture_chain_confirm', '你确认'), T('cognition.capture_chain_asset', '我的资产')].map((s) => `<b>${esc(s)}</b>`).join('<i>→</i>')}</div>
    <div class="ca-card ca-setcard">
      <div class="ca-line">
        <div><div class="ca-row-title">${esc(T('cognition.capture_switch_title', '自动整理'))}</div>
        <div class="ca-sub">${esc(T('cognition.capture_switch_hint', '自动发现值得留存的内容；只有需要你判断时才打扰你。'))}</div></div>
        <div class="ca-right">${chip(enabled ? T('cognition.capture_switch_on', '已开启') : T('cognition.capture_switch_off', '已关闭'), enabled ? 'green' : 'line')}
          ${btn(enabled ? T('cognition.capture_toggle_off', '关闭') : T('cognition.capture_toggle_on', '开启'), 'capture-toggle', { small: true, danger: enabled, primary: !enabled })}</div>
      </div>
    </div>
    <div class="ca-card ca-setcard">
      <div class="ca-line">
        <div class="ca-row-title">${esc(T('cognition.capture_trigger_title', '整理时机'))}</div>
        <span class="ca-note">${esc(T('cognition.capture_trigger_note', '三种时机同时只有一种生效'))}</span>
      </div>
      <div class="ca-subnav">${POLICY.map(([id, key, fb]) => btn(T(key, fb), 'capture-policy', { id, className: `ca-pill${policy === id ? ' is-on' : ''}` })).join('')}</div>
      <p class="ca-note">${esc(T(policyEntry[3], policyEntry[4]))}</p>
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

  /* 从历史会话整理（独立 tab，2026-09-14 自设置页拆出）。 */
  function viewOrganizeHistory() {
    const conversationItems = S.sources
      .filter((g) => String(g.kind || '') === 'conversation' || (g.items || []).some((i) => i.kind === 'conversation'))
      .flatMap((g) => (Array.isArray(g.items) ? g.items : []));
    // 默认收拢最近 5 条可整理会话，「查看全部」展开（列表与侧栏高度重复，铺开即噪音）。
    const listLimit = S.organizeListExpanded ? conversationItems.length : Math.min(5, conversationItems.length);
    const conversations = conversationItems.slice(0, listLimit);
    return `${hero(
      T('cognition.capture_manual_eyebrow', 'ORGANIZE'), T('cognition.capture_manual_title', '从历史会话整理'),
      T('cognition.capture_manual_note', '整理会使用模型额度，随时可以取消'),
    )}
    <div class="ca-card">${conversations.length ? conversations.map((conv) => `
      <div class="ca-row is-flat">
        <div class="ca-row-main"><div class="ca-row-title">${esc(conv.title || conv.id)}</div><div class="ca-row-meta">${esc(fmtDate(conv.updatedAt || conv.createdAt))}</div></div>
        <div class="ca-row-side">${btn(T('cognition.capture_manual_history_create', '开始整理'), 'organize-conv', { id: conv.id, small: true })}</div>
      </div>`).join('') : `<div class="ca-note">${esc(T('cognition.capture_tasks_empty_hint', '一轮会话结束后，系统会在静默期结束后创建整理任务。'))}</div>`}
      ${conversationItems.length > 5 ? `<div class="ca-line ca-line-center">${btn(T(S.organizeListExpanded ? 'cognition.capture_list_collapse' : 'cognition.capture_list_expand', S.organizeListExpanded ? '收起' : `查看全部 ${conversationItems.length} 个会话`, { n: String(conversationItems.length) }), 'toggle-organize-list', { small: true })}</div>` : ''}
    </div>`;
  }

  /* 整理记录（独立 tab，2026-09-14 自设置页拆出）。 */
  function viewCaptureLog() {
    const captureStatus = (capture) => (NS.vocabulary
      ? NS.vocabulary.captureStatusText(capture.status)
      : String(capture.status || ''));
    const recordTitle = (capture) => (NS.vocabulary
      ? NS.vocabulary.recordTitle(capture)
      : String(capture.conversationTitle || capture.title || capture.id || ''));
    const captures = Array.isArray(S.captures) ? S.captures : [];
    return `${hero(
      T('cognition.capture_log_eyebrow', 'LOG'), T('cognition.capture_task_log_title', '整理记录'),
      T('cognition.capture_log_hint', '每次整理的执行结果；失败的可以重试。'),
    )}
    ${captures.length ? `<div class="ca-card">${captures.map((capture) => `
      <div class="ca-row is-flat">
        <div class="ca-row-main"><div class="ca-row-title">${esc(recordTitle(capture))}</div>
        <div class="ca-row-meta">${esc(captureStatus(capture))} · ${esc(fmtDate(capture.updatedAt || capture.createdAt))}</div></div>
        <div class="ca-row-side">
          ${capture.status === 'failed' ? btn(T('cognition.capture_action_retry', '重试'), 'capture-action', { id: capture.id, data: { action: 'retry' }, small: true }) : ''}
          ${capture.status === 'paused' ? btn(T('cognition.capture_action_resume', '继续'), 'capture-action', { id: capture.id, data: { action: 'resume' }, small: true }) : ''}
        </div>
      </div>`).join('')}</div>` : `<div class="ca-card">${empty(T('cognition.capture_log_empty', '还没有整理记录'))}</div>`}`;
  }

  /* ────────────────────────── 渲染入口 ────────────────────────── */

  function render() {
    const root = document.getElementById('ca-root');
    if (!root) return;
    const route = S.route;
    const activeTab = route.name === 'candidate' ? 'review' : route.name;
    const tabsHtml = `<nav class="ca-tabs">${NS.TABS.map((tab) => {
      const active = activeTab === tab.id;
      const extra = tab.id === 'overview' ? ' data-cognition-page-link="assets"' : '';
      return `<div class="ca-tab${active ? ' is-on' : ''}" data-act="tab" data-id="${tab.id}"${extra} title="${esc(T(tab.descKey, tab.desc))}" ${roleBtn()}>
        <strong>${esc(T(tab.titleKey, tab.title))}</strong><small>${esc(T(tab.descKey, tab.desc))}</small>
      </div>`;
    }).join('')}</nav>`;
    let body = '';
    if (S.loading && !S.loaded) {
      body = `<div class="ca-loading">${esc(T('cognition.loading', '加载中…'))}</div>`;
    } else if (route.name === 'review') body = viewReview(route);
    else if (route.name === 'evidence') body = viewEvidence(route);
    else if (route.name === 'experiences') body = viewExperiences();
    else if (route.name === 'organize-history') body = viewOrganizeHistory();
    else if (route.name === 'capture-log') body = viewCaptureLog();
    else if (route.name === 'manage') body = viewManage(route);
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
  }
  NS.render = render;
})();
