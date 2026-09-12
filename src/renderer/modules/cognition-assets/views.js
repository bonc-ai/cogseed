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

  const btn = (label, act, options) => {
    const opts = options || {};
    const cls = ['ca-btn', opts.primary ? 'is-primary' : '', opts.danger ? 'is-danger' : '', opts.small ? 'is-sm' : ''].filter(Boolean).join(' ');
    const attrs = [
      act ? `data-act="${esc(act)}"` : '',
      opts.id != null ? `data-id="${esc(opts.id)}"` : '',
      opts.data ? Object.entries(opts.data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ') : '',
      opts.go ? `data-go="${esc(opts.go)}"` : '',
      opts.disabled ? 'disabled' : '',
      opts.title ? `title="${esc(opts.title)}"` : '',
    ].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" ${attrs}>${esc(label)}</button>`;
  };

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
     全部用方块堆出树形：树干=竖长块、枝条=斜排小方块、树冠=三个方块拼蓬松、
     根=小长方块、土=大灰方块；每个方块可点击直达对应清单。 */

  function treeBlocks(counts, info) {
    const c = (id) => counts[id] || 0;
    const pending = Number(info.pending || 0);
    const validated = Number(info.validated || 0);
    /* 枝条：从树干斜向伸出的连续小方块（像素风），两端对准干边与模块方块。 */
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
    return `
    <svg class="ca-fig" viewBox="0 0 700 460" role="img" aria-label="${esc(T('cognition.tree_panel_title', '我的认知树'))}">
      <g class="ca-fig-soil" data-act="go-sources" role="button" tabindex="0">
        <title>${esc(T('cognition.tree_soil_hint', '采集与来源记录保留在这里；点击查看数据来源'))}</title>
        <rect x="76" y="392" width="548" height="58" rx="8"/>
        <text x="350" y="426" text-anchor="middle">${esc(T('cognition.tree_soil_label', '土壤 · 来源 {s} · 采集 {c}', { s: String(Number(info.sources || 0)), c: String(Number(info.captures || 0)) }))}</text>
      </g>
      <g class="ca-fig-root${pending > 0 ? '' : ' is-empty'}" data-act="go-review" role="button" tabindex="0">
        <title>${esc(T('cognition.tree_root_hint', '待你确认的候选；点击进入待我处理'))}</title>
        <rect x="278" y="344" width="144" height="46" rx="8"/>
        <circle cx="308" cy="367" r="6"/>
        <text x="374" y="372" text-anchor="middle">${esc(T('cognition.tree_root_pending', '待确认 {n}', { n: String(pending) }))}</text>
      </g>
      <rect x="343" y="98" width="14" height="56" fill="#c3a179"/>
      <rect x="338" y="150" width="24" height="198" fill="#c3a179"/>
      ${twig(344, 176, 252, 158)}
      ${twig(356, 176, 448, 158)}
      ${twig(344, 268, 252, 288)}
      ${twig(356, 268, 448, 288)}
      ${modBlock('personal', 84, 128, 172, 56)}
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
    return `
    <div class="ca-card ca-asset-detail">
      <div class="ca-line">
        <div>
          <h3>${esc(asset.title || asset.id)}</h3>
          <div class="ca-sub">${esc(categoryLabel(asset.type))} · v${esc(String(asset.version || '1'))} · ${esc(T('cognition.asset_updated', '更新于'))} ${esc(fmtDate(asset.updatedAt || asset.createdAt))}</div>
        </div>
        <div class="ca-right">${assetStatusChip(asset)}</div>
      </div>
      <p class="ca-content-text">${esc(asset.statement || '')}</p>
      <div class="ca-kv">
        <div><div class="ca-k">${esc(T('cognition.asset_scope_label', '生效范围'))}</div><div class="ca-v">${esc(asset.scope || T('cognition.asset_scope_unset', '未设置'))}</div></div>
        <div><div class="ca-k">${esc(T('cognition.asset_origin_label', '写入来源'))}</div><div class="ca-v">${esc({
          user_confirmed: T('cognition.asset_origin_user', '确认采纳'),
          user_confirmed_unverified: T('cognition.asset_origin_user', '确认采纳'),
          automatically_extracted_unverified: T('cognition.asset_write_origin_auto', '自动采纳'),
          system_precipitated_unverified: T('cognition.asset_write_origin_auto', '自动采纳'),
        }[String(asset.lifecycleStatus || '')] || String(asset.lifecycleStatus || '—'))}</div></div>
        <div><div class="ca-k">${esc(T('cognition.asset_proofs_label', '使用记录'))}</div><div class="ca-v">${proofCount ? `${proofCount} ${esc(T('cognition.common_records', '条'))}` : esc(T('cognition.asset_no_proofs', '暂无'))}</div></div>
      </div>
      ${affectedCopy.length ? `<div class="ca-sect"><h4>${esc(T('cognition.asset_impact_title', '影响预览'))}</h4><p>${esc(affectedCopy[0])}</p><div class="ca-actions">${affectedCopy.slice(1).join('')}</div></div>` : ''}
      <div class="ca-sect">
        <h4>${esc(T('cognition.asset_body_title', '资产本体'))}</h4>
        <p>${esc(T('cognition.asset_body_hint', '三种操作影响不同：删除会从资产列表移除但保留历史；撤回使用只影响未来任务；彻底清除会删除全部历史与证据，不可恢复。'))}</p>
        <div class="ca-actions">
          ${btn(T('cognition.asset_delete', '删除'), 'asset-action', { id: asset.id, data: { action: 'delete' }, danger: true, small: true })}
          ${btn(T('cognition.asset_revoke', '撤回使用'), 'asset-action', { id: asset.id, data: { action: 'revoke' }, danger: true, small: true })}
          ${btn(T('cognition.asset_purge', '彻底清除'), 'asset-action', { id: asset.id, data: { action: 'purge' }, danger: true, small: true })}
        </div>
      </div>
      <div class="ca-sect">
        <div class="ca-actions">
          ${btn(T('cognition.proof_open_asset', '查看使用记录'), 'open-evidence', { id: asset.id })}
          ${btn(T('cognition.asset_list_back', '返回列表'), 'open-overview', {})}
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
    const heroHtml = hero(
      T('cognition.tree_eyebrow', '我的认知'), T('cognition.overview_title', '我的认知资产'),
      T('cognition.tree_page_hint', '树只展示正式认知资产。候选经确认后成为正式资产，经真实复用与证据验证后升级为「已验证」。'),
      statsRow([
        [stats.confirmed, T('cognition.overview_stat_confirmed', '已确认资产')],
        [stats.pending, T('cognition.overview_stat_pending', '待确认候选')],
        [stats.validated, T('cognition.overview_stat_validated', '已验证')],
      ]),
    );
    if (route.assetId) {
      const asset = S.assets.find((a) => String(a.id) === String(route.assetId));
      if (asset) return heroHtml + assetDetail(asset);
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
            <div class="ca-row-meta">${esc(categoryLabel(asset.type))} · v${esc(String(asset.version || '1'))} · ${esc(T('cognition.asset_last_use', '最近无使用记录'))}</div>
          </div>
          <div class="ca-row-side">${assetStatusChip(asset)}<span class="ca-chevron">›</span></div>
        </div>`).join('')
      : empty(
        T('cognition.tree_empty', '还没有正式资产'),
        T('cognition.tree_empty_hint', '候选被确认为正式资产后会出现在这里；当前还没有已确认的资产。'),
        S.candidates.length ? btn(T('cognition.tree_view_buds', '查看 {n} 条待确认候选', { n: String(stats.pending) }), 'go-review', { primary: true }) : '',
      );
    return `${heroHtml}
      <div class="ca-card ca-tree-card">
        <div class="ca-line">
          <div><h3>${esc(T('cognition.tree_panel_title', '我的认知树'))}</h3>
          <div class="ca-sub">${esc(T('cognition.tree_panel_caption', '一位用户只有一棵树，四条主枝对应四类资产'))}；${esc(T('cognition.tree_click_hint', '点击分类查看明细'))}</div></div>
          <div class="ca-right">${stats.pending ? btn(T('cognition.tree_view_buds', '查看 {n} 条待确认候选', { n: String(stats.pending) }), 'go-review', { small: true }) : ''}</div>
        </div>
        ${treeBlocks(counts, { pending: stats.pending, validated: stats.transferOk, sources: sourceCount, captures: captureCount })}
        <div class="ca-tree-cap">${esc(T('cognition.tree_legend_bud_hint', '枝头的小点是还没确认的候选；确认后它会成为同一根主枝上的正式资产。'))}</div>
      </div>
      ${sectionHead(T('cognition.overview_list_title', '资产明细'), '', chips.map(([id, label, count]) => `
        <button type="button" class="ca-chip${String(route.category || '') === id ? ' is-green' : ''} ca-chip-btn" data-act="filter-cat" data-id="${esc(id)}">${esc(label)} ${count}</button>`).join(' '))}
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
      ? `<div class="ca-warn">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或直接拒绝。'))}</div>`
      : '';
    const actionsHtml = broken
      ? `<div class="ca-actions ca-actions-right">${btn(T('cognition.candidate_open_detail', '查看与调整'), 'open-candidate', { id: candidate.id })}${btn(T('cognition.candidate_reject', '拒绝'), 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true })}</div>`
      : `<div class="ca-actions ca-actions-right">
          ${btn(T('cognition.candidate_confirm_scoped', '确认采纳'), 'cand-adopt', { id: candidate.id, primary: true })}
          ${btn(T('cognition.candidate_adjust_adopt', '调整后采纳'), 'open-candidate', { id: candidate.id })}
          ${btn(T('cognition.candidate_reject', '拒绝'), 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true })}
        </div>`;
    return `
    <div class="ca-card ca-candidate${broken ? ' is-broken' : ''}">
      <div class="ca-line">
        <div class="ca-row-title">${esc(candidateTitle(candidate))}</div>
        <div class="ca-right">${chip(categoryLabel(candidate.suggestedType), '')} ${broken ? chip(T('cognition.candidate_evidence_weak', '证据不足'), 'amber') : chip(T('cognition.candidate_evidence_ok', '证据充足'), 'green')}</div>
      </div>
      <p class="ca-content-text">${esc(String(candidate.judgment || candidate.value || '').slice(0, 220))}</p>
      ${refsHtml}${warnHtml}${actionsHtml}
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
    const attention = [];
    if (stats.sourceIssues) {
      attention.push(`<button type="button" class="ca-attention-row" data-act="go-sources"><span>${esc(T('cognition.overview_source_issues', '{count} 条来源记录需要处理', { count: String(stats.sourceIssues) }))}</span><b>${esc(T('common.handle', '处理'))}</b></button>`);
    }
    if (stats.failedTasks) {
      attention.push(`<button type="button" class="ca-attention-row" data-act="go-organize"><span>${esc(T('cognition.overview_failed_tasks', '{count} 个整理任务需要重试', { count: String(stats.failedTasks) }))}</span><b>${esc(T('common.handle', '处理'))}</b></button>`);
    }
    const teachingHtml = S.teaching.length
      ? `<div class="ca-card">${sectionHead(T('cognition.inbox_teaching_receipts', '教学记录'))}${S.teaching.slice(0, 6).map((signal) => `
          <div class="ca-row is-flat">
            <div class="ca-row-main"><div class="ca-row-title">${esc(signal.summary || signal.text || signal.id)}</div>
            <div class="ca-row-meta">${esc(fmtDate(signal.createdAt))}</div></div>
            <div class="ca-row-side">${btn(T('cognition.teaching_revoke', '撤销'), 'teaching-revoke', { id: signal.id, small: true })}</div>
          </div>`).join('')}</div>`
      : '';
    return `${hero(
      T('cognition.inbox', '待我处理'), T('cognition.review_title', '待我处理'),
      T('cognition.inbox_page_hint', '先处理会阻塞自动整理或资产使用的事项，其余候选保持低打扰。'),
      statsRow([
        [healthy.length, T('cognition.review_stat_wait', '等待确认')],
        [broken.length, T('cognition.review_stat_evidence', '需要补证据')],
        [processed.length, T('cognition.review_stat_processed', '已处理')],
      ]),
    )}
    ${attention.length ? `<div class="ca-notice">${attention.join('')}</div>` : ''}
    ${sectionHead(T('cognition.review_group_wait', '等待你确认'), T('cognition.review_group_wait_note', '确认后会创建 v1，并保留来源与撤销入口'))}
    ${healthy.length ? healthy.map((c) => candidateCard(c, false)).join('') : `<div class="ca-card">${empty(T('cognition.review_empty_wait', '当前没有等待确认的候选'))}</div>`}
    ${broken.length ? sectionHead(T('cognition.review_group_evidence', '需要先补充证据'), T('cognition.review_group_evidence_note', '这些候选的原始出处已被删除，补充新证据后才能保存')) + broken.map((c) => candidateCard(c, true)).join('') : ''}
    ${processed.length ? sectionHead(T('cognition.inbox_processed_badge', '处理记录'), T('cognition.inbox_processed_hint', '按处理时间倒序，只显示已处理的决定')) + `<div class="ca-card">${processed.map((c) => `
      <div class="ca-row is-flat">
        <div class="ca-row-main"><div class="ca-row-title">${esc(candidateTitle(c))}</div>
        <div class="ca-row-meta">${esc(fmtDate(c.updatedAt || c.createdAt))} · ${esc(T('cognition.candidate_status_promoted', '已采纳'))}</div></div>
      </div>`).join('')}</div>` : ''}
    ${teachingHtml}`;
  }

  /* ────────────────────────── 视图：候选详情 ────────────────────────── */

  function viewCandidate(route) {
    const candidate = S.candidates.find((c) => String(c.id) === String(route.candidateId));
    if (!candidate) {
      return hero(T('cognition.candidate_eyebrow', 'CANDIDATE'), T('cognition.candidate_detail_title', '候选详情'), '') + empty(T('cognition.candidate_detail_missing', '这条候选已不在待处理列表中'), '');
    }
    const refs = evidenceRefs(candidate);
    const broken = evidenceMostlyUnavailable(candidate);
    const edit = candidate.capabilities && candidate.capabilities.canEdit;
    const field = (label, inner) => `<label class="ca-field"><span>${esc(label)}</span>${inner}</label>`;
    return `${hero(
      T('cognition.candidate_eyebrow', 'CANDIDATE'), T('cognition.candidate_detail_title', '确认内容，也确认它该在什么范围生效'),
      T('cognition.candidate_detail_hint', '确认后会创建正式资产的第一个版本，并保留来源与撤销入口。'),
    )}
    <div class="ca-card ca-candidate-detail">
      <div class="ca-line">
        <div class="ca-row-title">${esc(candidateTitle(candidate))}</div>
        <div class="ca-right">${chip(categoryLabel(candidate.suggestedType))}${broken ? chip(T('cognition.candidate_evidence_weak', '证据不足'), 'amber') : ''}</div>
      </div>
      ${broken ? `<div class="ca-warn">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或直接拒绝。'))}</div>` : ''}
      ${edit ? `
        ${field(T('cognition.type', '类型'), `<select class="ca-input" data-f="type">${CATEGORIES.map(([id, key, fb]) => `<option value="${id}" ${candidate.suggestedType === id ? 'selected' : ''}>${esc(T(key, fb))}</option>`).join('')}</select>`)}
        ${field(T('cognition.candidate_scope_label', '作用范围'), `<input class="ca-input" data-f="scope" value="${esc(candidate.suggestedScope || '')}" placeholder="${esc(T('cognition.candidate_scope_placeholder', '例如：仅产品工作空间'))}">`)}
        ${field(T('cognition.summary', '摘要'), `<input class="ca-input" data-f="summary" value="${esc(candidate.summary || '')}">`)}
        ${field(T('cognition.judgment', '具体内容'), `<textarea class="ca-input ca-textarea" data-f="judgment">${esc(candidate.judgment || '')}</textarea>`)}
        ${field(T('cognition.evidence_refs', '证据引用'), `<div class="ca-chips">${refs.map(evidenceChip).join('') || `<span class="ca-note">${esc(T('cognition.candidate_no_evidence', '没有可追溯的证据引用；确认前建议先补证。'))}</span>`}</div>`)}
      ` : `
        <p class="ca-content-text">${esc(candidate.judgment || '')}</p>
        ${field(T('cognition.candidate_scope_label', '作用范围'), `<span class="ca-v">${esc(candidate.suggestedScope || T('cognition.asset_scope_unset', '未设置'))}</span>`)}
      `}
      <div class="ca-actions ca-actions-right">
        ${(candidate.capabilities && candidate.capabilities.canPromote) ? btn(T('cognition.candidate_save_and_use', '保存并使用'), 'cand-adopt-with-form', { id: candidate.id, primary: true }) : ''}
        ${env_defer(candidate)}
        ${btn(T('cognition.candidate_reject', '拒绝'), 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true })}
        ${btn(T('cognition.asset_list_back', '返回列表'), 'go-review', {})}
      </div>
    </div>`;
  }
  const env_defer = (candidate) => (candidate.capabilities && candidate.capabilities.canDefer)
    ? btn(T('cognition.status_deferred', '稍后'), 'cand-decide', { id: candidate.id, data: { action: 'defer' } }) : '';

  /* ────────────────────────── 视图：使用与证明 ────────────────────────── */

  const PROOF_FEEDBACKS = [
    ['positive', 'cognition.proof_carried_in', '带入正确', true],
    ['rework', 'cognition.proof_rework', '需要修正', false],
    ['neutral', 'cognition.proof_no_diff', '未产生明显差异', false],
    ['invalid', 'cognition.proof_degraded', 'Evidence 不足', false],
  ];

  /** 时间线事件的原始标题是英文契约串（后端产物）；常见几类在这里翻成人话。 */
  const EVENT_TITLE_MAP = {
    'Asset created': 'cognition.proof_event_created',
    'Asset version saved': 'cognition.proof_event_version',
    'Asset updated': 'cognition.proof_event_updated',
  };
  const EVENT_TITLE_FALLBACK = {
    'cognition.proof_event_created': '已创建资产',
    'cognition.proof_event_version': '版本已保存',
    'cognition.proof_event_updated': '资产已更新',
  };
  const eventTitle = (proof) => {
    const raw = String(proof.outcome || proof.title || proof.kind || '');
    const key = EVENT_TITLE_MAP[raw];
    return key ? T(key, EVENT_TITLE_FALLBACK[key]) : raw;
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
      T('cognition.proofs_eyebrow', 'USE & EVIDENCE'), T('cognition.proofs_title', '使用与证明'),
      T('cognition.proofs_page_hint', '使用、迁移与效果分层展示；没有效果证明时，不会把「被使用」说成「已验证」。'),
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
    const sections = [...byAsset.entries()].map(([assetId, items]) => {
      const asset = S.assets.find((a) => String(a.id) === assetId);
      const title = asset ? (asset.title || assetId) : assetId;
      const rows = items.slice(0, 20).map((proof) => {
        const refs = proof.refs || {};
        const isOpen = String(route.proofEventId) === String(proof.id);
        const transferProofId = String(refs.transferProofId || '');
        const metaParts = [
          refs.version ? `v${esc(String(refs.version))}` : '',
          refs.taskRunId ? esc(T('cognition.proof_task_used', '在一次任务中被带入')) : '',
        ].filter(Boolean).join(' · ');
        let ratingHtml = '';
        if (isOpen) {
          if (transferProofId) {
            ratingHtml = `<div class="ca-rating"><strong>${esc(T('cognition.proof_rate_question', '这次带入在任务里表现如何？'))}</strong>
              <div class="ca-actions">${PROOF_FEEDBACKS.map(([value, key, fb, needsNote]) => btn(T(key, fb), needsNote ? 'proof-note-open' : 'proof-rate', { id: transferProofId, data: { feedback: value, proof: proof.id } })).join('')}</div>
              <div class="ca-note-zone" data-proof="${esc(transferProofId)}" hidden>
                <textarea class="ca-input ca-textarea" data-f="note" placeholder="${esc(T('cognition.proof_evidence_note_placeholder', '先写一句你观察到的变化——这句话就是这次评价的依据。'))}"></textarea>
                <div class="ca-actions">${btn(T('cognition.proof_evidence_submit', '记下这次评价'), 'proof-note-submit', { id: transferProofId, primary: true, small: true })}</div>
              </div>
            </div>`;
          } else {
            ratingHtml = `<div class="ca-rating"><p class="ca-note">${esc(T('cognition.proof_rating_blocked_no_transfer', '这次复用还没有形成传递证明，暂时不能评价。任务结束并留下使用记录后，这里会出现评价入口。'))}</p></div>`;
          }
        }
        return `
        <div class="ca-proof-row${isOpen ? ' is-open' : ''}">
          <button type="button" class="ca-proof-event" data-act="proof-toggle" data-id="${esc(proof.id)}">
            <span class="ca-proof-dot" aria-hidden="true"></span>
            <span class="ca-proof-body"><strong>${esc(eventTitle(proof))}</strong>
            ${proof.summary ? `<span class="ca-proof-summary">${esc(String(proof.summary).slice(0, 120))}</span>` : ''}
            ${metaParts ? `<span class="ca-proof-meta">${metaParts}</span>` : ''}</span>
            <time>${esc(fmtDate(proof.occurredAt))}</time>
          </button>
          ${ratingHtml}
        </div>`;
      }).join('');
      return `<div class="ca-card ca-proof-asset">
        <div class="ca-line"><div class="ca-row-title">${esc(title)}</div>
        <div class="ca-right"><span class="ca-note">${esc(String(items.length))} ${esc(T('cognition.common_records', '条'))}</span>${btn(T('cognition.proof_open_asset', '查看资产'), 'open-asset', { id: assetId, small: true })}</div></div>
        <div class="ca-proof-list">${rows}</div>
      </div>`;
    }).join('');
    return `${heroHtml}${sections}`;
  }

  /* ────────────────────────── 视图：设置与管理 ────────────────────────── */

  const MANAGE_TABS = [
    ['governance', 'cognition.tab_governance', '版本与治理'],
    ['sources', 'cognition.tab_sources', '数据来源'],
    ['organize', 'cognition.capture_activity_title', '自动整理'],
    ['about', 'cognition.tab_about', '关于我'],
  ];

  function viewManage(route) {
    const sub = route.manageTab || 'governance';
    const nav = `<div class="ca-subnav">${MANAGE_TABS.map(([id, key, fb]) => `
      <button type="button" class="ca-pill${sub === id ? ' is-on' : ''}" data-act="manage-tab" data-id="${id}" ${id === 'organize' ? 'data-cognition-page-link="captures"' : ''}>${esc(T(key, fb))}</button>`).join('')}</div>`;
    if (sub === 'sources') return nav + viewSources();
    if (sub === 'organize') return nav + viewOrganize();
    if (sub === 'about') return nav + viewAbout();
    return nav + viewGovernance(route);
  }

  function viewGovernance(route) {
    const stats = NS.stats();
    const list = S.assets;
    const selected = route.assetId ? list.find((a) => String(a.id) === String(route.assetId)) : list[0];
    return `${hero(
      T('cognition.tab_manage', '设置与管理'), T('cognition.governance_title', '版本与治理'),
      T('cognition.governance_hint', '每次变化都有版本，也有退路。暂停、撤回、删除与彻底清除是不同动作，执行前都会说明影响。'),
      statsRow([[list.length, T('cognition.governance_stat_all', '全部资产')], [stats.confirmed, T('cognition.governance_stat_active', '正常使用')], [list.filter((a) => String(a.status || 'active') === 'paused' || String(a.status || '') === 'archived').length, T('cognition.governance_stat_attention', '需要关注')]]),
    )}
    <div class="ca-split">
      <div class="ca-card">
        <h3>${esc(T('cognition.governance_list_title', '资产与当前版本'))}</h3>
        <div class="ca-sub">${esc(T('cognition.governance_list_hint', '选择一项，查看它的状态与可执行操作。'))}</div>
        <div class="ca-vlist">${list.map((asset) => `
          <div class="ca-vrow${selected && selected.id === asset.id ? ' is-on' : ''}" data-act="select-asset" data-id="${esc(asset.id)}">
            <div><div class="ca-row-title">${esc(asset.title || asset.id)}</div>
            <div class="ca-row-meta">${esc(categoryLabel(asset.type))} · v${esc(String(asset.version || '1'))}</div></div>
            <div class="ca-right">${assetStatusChip(asset)}</div>
          </div>`).join('')}</div>
      </div>
      ${selected ? assetDetail(selected) : `<div class="ca-card">${empty(T('cognition.governance_empty', '还没有可管理的资产'))}</div>`}
    </div>`;
  }

  const SOURCE_KINDS = {
    conversation: ['cognition.source_conversation', '会话', 'cognition.source_conversation_desc', '已完成会话及其可引用消息'],
    artifact: ['cognition.source_artifact', 'Artifact 与文件', 'cognition.source_artifact_desc', '上下文文件和会话产物'],
    execution: ['cognition.source_execution', '执行与评价', 'cognition.source_execution_desc', '任务执行与结果评估'],
    teaching: ['cognition.source_teaching', '用户教学信号', 'cognition.source_teaching_desc', '用户明确要求记住或纠正的内容'],
    external: ['cognition.source_external', '授权外部系统', 'cognition.source_external_desc', '已授权且当前可用的外部连接器'],
  };

  function viewSources() {
    const groups = S.sources;
    const items = groups.flatMap((g) => (Array.isArray(g.items) ? g.items : []));
    const usable = items.filter((i) => i.status === 'ok' || i.status === 'available' || !i.status).length;
    const issues = items.filter((i) => i.status === 'failed' || i.status === 'paused').length;
    const kindOf = (group) => String(group.kind || (group.items && group.items[0] && group.items[0].kind) || 'conversation');
    return `${hero(
      T('cognition.sources_eyebrow', 'SOURCES'), T('cognition.sources_title', '数据来源'),
      T('cognition.sources_page_hint', '五类来源分别管理授权、可用性和最近读取；来源不是正式认知资产。'),
    )}
    <div class="ca-statbar">
      <div class="ca-stat"><b>${groups.length}</b><span>${esc(T('cognition.sources_stat_kinds', '来源类型'))}</span></div>
      <div class="ca-stat"><b>${items.length}</b><span>${esc(T('cognition.sources_stat_visible', '当前可见'))}</span></div>
      <div class="ca-stat"><b>${usable}</b><span>${esc(T('cognition.sources_stat_usable', '可用'))}</span></div>
      <div class="ca-stat"><b class="${issues ? 'is-warn' : ''}">${issues}</b><span>${esc(T('cognition.sources_stat_issues', '需要处理'))}</span></div>
    </div>
    ${issues ? `<div class="ca-notice">${`<button type="button" class="ca-attention-row" data-act="noop"><span>${esc(T('cognition.overview_source_issues', '{count} 条来源记录需要处理', { count: String(issues) }))}</span></button>`}</div>` : ''}
    ${groups.map((group) => {
      const kind = kindOf(group);
      const [key, fb, descKey, descFb] = SOURCE_KINDS[kind] || ['cognition.source_other', kind, '', ''];
      const list = Array.isArray(group.items) ? group.items : [];
      return `<div class="ca-card ca-source-card">
        <div class="ca-line">
          <div><div class="ca-row-title">${esc(T(key, fb))}</div><div class="ca-sub">${esc(descFb ? T(descKey, descFb) : '')}</div></div>
          <div class="ca-right">${chip(`${list.length} · ${esc(T('cognition.sources_visible', '可见'))}`, list.length ? 'green' : '')}</div>
        </div>
        ${list.slice(0, 8).map((item) => `
          <div class="ca-row is-flat">
            <div class="ca-row-main"><div class="ca-row-title">${esc(item.title || item.id)}</div>
            <div class="ca-row-meta">${esc(item.status === 'failed' ? T('cognition.source_status_failed', '读取失败') : item.status === 'paused' ? T('cognition.source_status_paused', '已暂停') : T('cognition.source_status_ok', '可用'))}</div></div>
            <div class="ca-row-side">
              ${item.status === 'paused' ? btn(T('cognition.source_resume', '恢复'), 'source-action', { id: item.id, data: { action: 'resume', kind }, small: true })
                : item.status === 'failed' ? btn(T('cognition.source_retry', '重试'), 'source-action', { id: item.id, data: { action: 'retry', kind }, small: true })
                  : btn(T('cognition.source_pause', '暂停'), 'source-action', { id: item.id, data: { action: 'pause', kind }, small: true })}
            </div>
          </div>`).join('')}
      </div>`;
    }).join('')}
    <p class="ca-footnote">${esc(T('cognition.source_boundary_hint', '普通内容先成为候选；只有用户教学信号可在限定范围内形成可撤销回执。'))}</p>`;
  }

  function viewOrganize() {
    const settings = S.captureSettings || {};
    const policy = String(settings.executionPolicy || 'smart');
    const enabled = settings.enabled !== false;
    const reviewAuto = String(settings.reviewPolicy || 'auto') === 'auto';
    const conversations = S.sources
      .filter((g) => String(g.kind || '') === 'conversation' || (g.items || []).some((i) => i.kind === 'conversation'))
      .flatMap((g) => (Array.isArray(g.items) ? g.items : []))
      .slice(0, 8);
    const POLICY = [
      ['smart', 'cognition.capture_policy_smart_title', '任务结束后发现', 'cognition.capture_policy_smart_hint', '任务完成或出现用户纠正时，在本机分析有意义的变化。'],
      ['nightly', 'cognition.capture_policy_nightly_title', '本地夜间整理', 'cognition.capture_policy_nightly_hint', '仅在你启用后运行；设备休眠时顺延到下一个可运行窗口。'],
      ['manual', 'cognition.capture_policy_manual_title', '主动整理', 'cognition.capture_policy_manual_hint', '从历史会话里挑选内容整理，读取前会先让你确认范围。'],
    ];
    const statusText = (capture) => ({
      completed: T('cognition.capture_status_completed', '已完成'),
      review_ready: T('cognition.capture_status_review', '待确认'),
      processing: T('cognition.capture_status_processing', '整理中'),
      failed: T('cognition.capture_status_failed', '失败'),
      cancelled: T('cognition.capture_status_cancelled', '已取消'),
      paused: T('cognition.capture_status_paused', '已暂停'),
      queued: T('cognition.capture_status_queued', '排队中'),
      waiting_quiet: T('cognition.capture_status_waiting', '等待中'),
    }[String(capture.status || '')] || String(capture.status || ''));
    return `${hero(
      T('cognition.tab_manage', '设置与管理'), T('cognition.capture_activity_title', '自动整理'),
      T('cognition.capture_activity_hint', '自动发现值得留存的内容；只有需要你判断时才打扰你。'),
      statsRow([
        [Number((S.captureCounts && S.captureCounts.review) || 0), T('cognition.capture_metric_review', '待确认')],
        [Number((S.captureCounts && S.captureCounts.processing) || 0), T('cognition.capture_metric_processing', '处理中')],
        [Number((S.captureCounts && S.captureCounts.failed) || 0), T('cognition.capture_metric_abnormal', '失败')],
      ]),
    )}
    <div class="ca-flow">${[T('cognition.capture_chain_source', '会话 / 执行结果'), T('cognition.capture_chain_candidate', '提取候选'), T('cognition.capture_chain_confirm', '你确认'), T('cognition.capture_chain_asset', '我的资产')].map((s) => `<b>${esc(s)}</b>`).join('<i>→</i>')}</div>
    ${sectionHead(T('cognition.capture_auto_title', '整理时机与设置'), T('cognition.capture_trigger_note', '三种时机同时只有一种生效'))}
    <div class="ca-whenwrap">${POLICY.map(([id, key, fb, descKey, descFb]) => `
      <div class="ca-card ca-whencard${policy === id ? ' is-on' : ''}">
        <div class="ca-line"><div class="ca-row-title">${esc(T(key, fb))}</div><div class="ca-right">${policy === id ? `<span class="ca-chip is-green">${esc(T('cognition.capture_mode_on', '使用中'))}</span>` : ''}</div></div>
        <p class="ca-sub">${esc(T(descKey, descFb))}</p>
        ${policy === id ? '' : `<div class="ca-actions">${btn(T('cognition.capture_mode_use', '切换为此方式'), 'capture-policy', { id, small: true })}</div>`}
      </div>`).join('')}</div>
    <div class="ca-setrow">
      <div class="ca-sub">${esc(enabled ? T('cognition.capture_enabled_on', '自动整理已开启') : T('cognition.capture_enabled_off', '自动整理已关闭'))} · ${esc(reviewAuto ? T('cognition.capture_review_auto_note', '符合条件的候选会自动采纳（不再询问）') : T('cognition.capture_review_manual_note', '候选先进入待确认，由你决定'))}</div>
      <div class="ca-actions">${btn(enabled ? T('cognition.capture_toggle_off', '关闭') : T('cognition.capture_toggle_on', '开启'), 'capture-toggle', {})}${btn(T('cognition.capture_review_switch', reviewAuto ? '改为先问我' : '改为自动采纳'), 'capture-review-toggle', {})}</div>
    </div>
    ${sectionHead(T('cognition.capture_manual_title', '从历史会话整理'), T('cognition.capture_manual_note', '整理会使用模型额度，随时可以取消'))}
    <div class="ca-card">${conversations.length ? conversations.map((conv) => `
      <div class="ca-row is-flat">
        <div class="ca-row-main"><div class="ca-row-title">${esc(conv.title || conv.id)}</div><div class="ca-row-meta">${esc(fmtDate(conv.updatedAt || conv.createdAt))}</div></div>
        <div class="ca-row-side">${btn(T('cognition.capture_manual_history_create', '开始整理'), 'organize-conv', { id: conv.id, small: true })}</div>
      </div>`).join('') : `<div class="ca-note">${esc(T('cognition.capture_tasks_empty_hint', '一轮会话结束后，系统会在静默期结束后创建整理任务。'))}</div>`}</div>
    ${S.captures.length ? sectionHead(T('cognition.capture_task_log_title', '② 整理记录')) + `<div class="ca-card">${S.captures.slice(0, 8).map((capture) => `
      <div class="ca-row is-flat">
        <div class="ca-row-main"><div class="ca-row-title">${esc(capture.conversationTitle || capture.title || capture.id)}</div>
        <div class="ca-row-meta">${esc(statusText(capture))} · ${esc(fmtDate(capture.updatedAt || capture.createdAt))}</div></div>
        <div class="ca-row-side">
          ${capture.status === 'failed' ? btn(T('cognition.capture_action_retry', '重试'), 'capture-action', { id: capture.id, data: { action: 'retry' }, small: true }) : ''}
          ${capture.status === 'paused' ? btn(T('cognition.capture_action_resume', '继续'), 'capture-action', { id: capture.id, data: { action: 'resume' }, small: true }) : ''}
        </div>
      </div>`).join('')}</div>` : ''}`;
  }

  function viewAbout() {
    const personal = S.assets.filter((a) => a.type === 'personal');
    return `${hero(
      T('cognition.tab_manage', '设置与管理'), T('cognition.tab_about', '关于我'),
      T('cognition.about_page_hint', '记录你是谁、你的长期身份与沟通定位。这里的内容会随确认的沉淀持续更新。'),
      statsRow([[personal.length, T('cognition.about_stat_assets', '该分类资产')], [S.teaching.length, T('cognition.about_stat_teaching', '教学记录')], [1, T('cognition.about_stat_profile', '个人画像')]]),
    )}
    ${personal.length ? personal.map((asset) => `
      <div class="ca-card">
        <div class="ca-line"><div class="ca-row-title">${esc(asset.title || asset.id)}</div><div class="ca-right">${assetStatusChip(asset)}</div></div>
        <p class="ca-content-text">${esc(asset.statement || '')}</p>
        <div class="ca-actions ca-actions-right">${btn(T('cognition.proof_open_asset', '查看详情'), 'open-asset', { id: asset.id, small: true })}</div>
      </div>`).join('') : `<div class="ca-card">${empty(T('cognition.about_empty', '还没有「关于我」的资产'), T('cognition.about_empty_hint', '在会话中明确你的身份或偏好，确认后会出现在这里。'))}</div>`}`;
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
      return `<button type="button" class="ca-tabcard${active ? ' is-on' : ''}" data-act="tab" data-id="${tab.id}"${extra}>
        <span class="ca-tab-ico" aria-hidden="true"></span>
        <span class="ca-tab-copy"><strong>${esc(T(tab.titleKey, tab.title))}</strong><small>${esc(T(tab.descKey, tab.desc))}</small></span>
      </button>`;
    }).join('')}</nav>`;
    let body = '';
    if (S.loading && !S.loaded) {
      body = `<div class="ca-loading">${esc(T('cognition.loading', '加载中…'))}</div>`;
    } else if (route.name === 'review') body = viewReview(route);
    else if (route.name === 'evidence') body = viewEvidence(route);
    else if (route.name === 'manage') body = viewManage(route);
    else body = viewOverview(route);
    const errorBanner = S.errors.length && S.loaded
      ? `<div class="ca-banner">${esc(T('cognition.partial_load', '部分数据读取失败，页面已用可用数据渲染。'))}${btn(T('common.retry', '重试'), 'refresh', { small: true })}</div>`
      : '';
    root.innerHTML = `
      <div class="ca-app">
        <header class="ca-head">
          <h1>${esc(T('cognition.title', '认知资产'))}</h1>
          <div class="ca-head-actions">
            <button type="button" class="ca-iconbtn" data-act="refresh" title="${esc(T('common.refresh', '刷新'))}" aria-label="${esc(T('common.refresh', '刷新'))}">⟳</button>
          </div>
        </header>
        ${tabsHtml}
        ${errorBanner}
        <div class="ca-scroll" id="ca-scroll">${body}</div>
      </div>`;
  }
  NS.render = render;
  NS.helpers = { sourceRefUnavailable, evidenceMostlyUnavailable, candidatePending, categoryLabel };
})();
