// 认知成长页纯渲染层。认知树只消费阶段状态，证据和操作仍由外层工作流负责。
(function (root) {
  const STAGES = ['seed', 'sprout', 'growing', 'bright'];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function text(key, fallback, vars) {
    if (typeof root.t === 'function') {
      const translated = root.t(key, vars);
      if (translated && translated !== key) return translated;
    }
    if (!vars) return fallback;
    return fallback.replace(/\{(\w+)\}/g, (match, name) => vars[name] == null ? match : String(vars[name]));
  }

  function stageMeta(stage) {
    const meta = {
      seed: {
        label: text('cognition.stage.seed', '种子'),
        description: text('cognition.stage.seed_desc', '发现候选，尚无证据'),
        state: text('cognition.state.seed', '候选阶段'),
      },
      sprout: {
        label: text('cognition.stage.sprout', '发芽'),
        description: text('cognition.stage.sprout_desc', '证据开始聚合，等待确认'),
        state: text('cognition.state.sprout', '待确认'),
      },
      growing: {
        label: text('cognition.stage.growing', '生长'),
        description: text('cognition.stage.growing_desc', '已确认，开始被复用'),
        state: text('cognition.state.growing', '已确认'),
      },
      bright: {
        label: text('cognition.stage.bright', '明亮'),
        description: text('cognition.stage.bright_desc', '稳定能力，可迁移复用'),
        state: text('cognition.state.bright', '稳定能力'),
      },
    };
    return meta[STAGES.includes(stage) ? stage : 'seed'];
  }

  function renderTabs(view) {
    const tabs = [
      ['tree', text('cognition.tab.tree', '成长树')],
      ['pending', text('cognition.tab.pending', '待确认种子')],
      ['history', text('cognition.tab.history', '成长记录')],
    ];
    return '<nav class="cognition-tabs" role="tablist" aria-label="' + escapeHtml(text('cognition.stage_rail.label', '认知成长阶段')) + '">' + tabs.map(([id, label]) =>
      `<button type="button" class="cognition-tab${view === id ? ' active' : ''}" data-cognition-view="${id}" role="tab" aria-selected="${view === id}">${escapeHtml(label)}</button>`
    ).join('') + '</nav>';
  }

  function renderStageRail(stage) {
    const current = STAGES.includes(stage) ? stage : 'seed';
    const label = text('cognition.stage_rail.label', '认知成长阶段');
    return `<div class="cognition-stage-rail" aria-label="${escapeHtml(label)}">` + STAGES.map((id) => {
      const active = id === current;
      const index = STAGES.indexOf(id);
      const reached = index <= STAGES.indexOf(current);
      const meta = stageMeta(id);
      return `<div class="cognition-stage-step${active ? ' active' : ''}${reached ? ' reached' : ''}" data-cognition-stage="${id}">`
        + `<span class="cognition-stage-index">${index + 1}</span>`
        + `<strong>${escapeHtml(meta.label)}</strong>`
        + `<small>${escapeHtml(meta.description)}</small>`
        + '</div>';
    }).join('') + '</div>';
  }

  function renderGrowthVisual(asset) {
    const meta = stageMeta(asset.stage);
    return `<div class="cognition-growth-visual cognition-growth-visual-${escapeHtml(asset.stage)}" data-cognition-growth-visual data-stage="${escapeHtml(asset.stage)}">`
      + '<div class="cognition-growth-visual-label">'
      + `<span>${escapeHtml(text('cognition.visual.title', '认知成长过程'))}</span>`
      + `<small>${escapeHtml(meta.state)}</small>`
      + '</div>'
      + `<div class="cognition-growth-scene" role="img" aria-label="${escapeHtml(`${asset.title} · ${meta.state}`)}">`
      + '<svg class="cognition-tree-svg" viewBox="0 0 520 360" focusable="false" aria-hidden="true">'
      + '<ellipse class="cognition-tree-soil" cx="260" cy="319" rx="184" ry="27"></ellipse>'
      + '<ellipse class="cognition-tree-soil-ring" cx="260" cy="315" rx="142" ry="18"></ellipse>'
      + '<g class="cognition-tree-roots">'
      + '<path d="M260 288 C244 299 224 311 198 319 C183 324 169 325 151 323"></path>'
      + '<path d="M260 290 C276 301 294 312 322 319 C340 323 357 323 374 319"></path>'
      + '<path d="M252 292 C238 305 232 317 227 328"></path><path d="M271 292 C287 304 293 317 298 330"></path>'
      + '<path d="M240 300 C220 306 207 315 195 326"></path><path d="M284 301 C305 308 316 318 329 329"></path>'
      + '</g>'
      + '<g class="cognition-tree-seed-layer">'
      + '<path class="cognition-tree-seed" d="M260 282 C243 270 245 247 259 237 C276 245 279 267 260 282 Z"></path>'
      + '<path class="cognition-tree-seed-line" d="M260 242 C260 255 263 269 260 280"></path>'
      + '</g>'
      + '<g class="cognition-tree-sprout-layer">'
      + '<path class="cognition-tree-sprout-stem" d="M260 292 C253 272 254 250 260 231 C266 211 264 194 274 174"></path>'
      + '<path class="cognition-tree-sprout-leaf" d="M271 181 C254 174 247 164 249 151 C263 153 272 163 273 177 Z"></path>'
      + '<path class="cognition-tree-sprout-leaf cognition-tree-sprout-leaf-alt" d="M270 205 C282 195 294 194 302 201 C294 213 283 217 271 211 Z"></path>'
      + '</g>'
      + '<g class="cognition-tree-growing-layer">'
      + '<path class="cognition-tree-trunk" d="M253 299 C244 270 247 242 254 215 C262 186 251 158 266 128 C278 104 286 84 284 61"></path>'
      + '<path class="cognition-tree-trunk-highlight" d="M258 295 C253 262 256 239 262 216 C270 185 261 157 274 131 C283 111 291 86 289 67"></path>'
      + '<path class="cognition-tree-branch" d="M263 193 C235 179 207 157 175 137 C151 121 132 105 112 88"></path>'
      + '<path class="cognition-tree-branch" d="M264 193 C295 178 322 157 348 132 C367 114 382 96 401 77"></path>'
      + '<path class="cognition-tree-branch" d="M257 226 C231 216 205 215 178 220 C155 225 138 235 121 246"></path>'
      + '<path class="cognition-tree-branch" d="M258 226 C290 221 316 208 338 188 C356 171 367 153 379 134"></path>'
      + '<path class="cognition-tree-branch cognition-tree-branch-high" d="M272 128 C297 111 319 91 337 63"></path>'
      + '<path class="cognition-tree-branch cognition-tree-branch-twig" d="M175 137 C162 126 154 115 148 101"></path>'
      + '<path class="cognition-tree-branch cognition-tree-branch-twig" d="M348 132 C359 119 367 108 374 95"></path>'
      + '<path class="cognition-tree-branch cognition-tree-branch-twig" d="M178 220 C166 211 157 202 151 191"></path>'
      + '<path class="cognition-tree-branch cognition-tree-branch-twig" d="M338 188 C348 177 354 166 359 153"></path>'
      + '<path class="cognition-tree-branch cognition-tree-branch-twig" d="M337 63 C348 52 355 43 358 33"></path>'
      + '<path class="cognition-tree-branch cognition-tree-branch-twig" d="M121 246 C108 251 99 257 91 265"></path>'
      + '</g>'
      + '<g class="cognition-tree-canopy-layer cognition-tree-canopy-base">'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-large" d="M114 89 C91 75 69 79 50 96 C69 113 96 111 117 95 Z"></path>'
      + '<path class="cognition-tree-vein" d="M57 97 C77 96 96 92 114 89"></path>'
      + '<path class="cognition-tree-leaf" d="M398 78 C401 57 414 44 430 39 C433 57 422 73 401 83 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-light" d="M347 132 C347 113 357 99 373 94 C379 111 368 126 350 137 Z"></path>'
      + '<path class="cognition-tree-leaf" d="M178 220 C163 207 147 207 133 217 C146 231 162 232 180 224 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-light" d="M338 188 C338 171 348 158 363 153 C368 169 358 183 341 193 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-light" d="M232 176 C218 160 205 158 193 166 C203 181 218 184 233 180 Z"></path>'
      + '<path class="cognition-tree-leaf" d="M292 109 C306 94 319 90 331 96 C322 111 308 116 293 114 Z"></path>'
      + '</g>'
      + '<g class="cognition-tree-canopy-layer cognition-tree-canopy-full">'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-light" d="M173 137 C157 121 142 119 128 127 C139 143 154 148 174 143 Z"></path>'
      + '<path class="cognition-tree-leaf" d="M205 157 C195 142 182 137 168 141 C174 157 187 165 205 164 Z"></path>'
      + '<path class="cognition-tree-leaf" d="M401 77 C415 63 430 61 442 69 C432 83 418 88 401 84 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-light" d="M367 114 C377 98 390 92 402 96 C398 112 386 121 368 122 Z"></path>'
      + '<path class="cognition-tree-leaf" d="M121 246 C106 233 91 233 78 242 C89 257 105 260 122 252 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-light" d="M379 134 C393 122 408 122 418 132 C407 145 392 149 378 142 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-small" d="M337 63 C328 49 330 37 340 28 C350 40 349 53 338 66 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-small cognition-tree-leaf-light" d="M286 62 C276 51 277 39 286 31 C296 42 296 53 288 65 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-light" d="M149 103 C137 91 124 89 113 96 C122 109 136 112 150 108 Z"></path>'
      + '<path class="cognition-tree-leaf" d="M374 95 C374 79 383 68 397 64 C401 80 392 92 376 99 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-light" d="M152 191 C138 181 126 182 117 191 C128 204 141 205 155 197 Z"></path>'
      + '<path class="cognition-tree-leaf" d="M359 153 C365 138 376 131 389 132 C386 147 376 157 360 159 Z"></path>'
      + '<path class="cognition-tree-leaf cognition-tree-leaf-light" d="M91 265 C79 255 66 257 58 267 C69 278 82 278 93 270 Z"></path>'
      + '<path class="cognition-tree-leaf" d="M358 33 C350 20 352 9 362 1 C371 13 369 25 359 37 Z"></path>'
      + '<path class="cognition-tree-bud" d="M418 98 C411 88 413 77 422 71 C431 80 429 91 419 101 Z"></path>'
      + '<path class="cognition-tree-bud cognition-tree-bud-alt" d="M151 182 C144 172 146 163 155 157 C163 166 162 176 153 185 Z"></path>'
      + '</g>'
      + '</svg>'
      + '</div>'
      + `<div class="cognition-tree-caption"><strong>${escapeHtml(asset.title)}</strong><span>${escapeHtml(meta.description)}</span></div>`
      + renderStageRail(asset.stage)
      + '</div>';
  }

  function renderEvidence(asset) {
    const evidence = Array.isArray(asset.evidence) ? asset.evidence : [];
    if (!evidence.length) return `<div class="cognition-empty-inline">${escapeHtml(text('cognition.evidence.empty', '还没有证据'))}</div>`;
    return '<ol class="cognition-evidence-list">' + evidence.map((item) =>
      `<li><strong>${escapeHtml(item.summary)}</strong><span>${escapeHtml(item.sourceLabel)}</span></li>`
    ).join('') + '</ol>';
  }

  function renderReuseEvents(asset) {
    const reuseEvents = Array.isArray(asset.reuseEvents) ? asset.reuseEvents : [];
    if (!reuseEvents.length) return `<div class="cognition-empty-inline">${escapeHtml(text('cognition.reuse.empty', '尚未记录复用'))}</div>`;
    return '<ol class="cognition-reuse-list">' + reuseEvents.map((item) => {
      const date = new Date(item.createdAt);
      const label = Number.isNaN(date.getTime()) ? item.createdAt : date.toLocaleString();
      return `<li><strong>${escapeHtml(item.sourceLabel)}</strong><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(label)}</time></li>`;
    }).join('') + '</ol>';
  }

  function renderActions(asset) {
    const evidence = Array.isArray(asset.evidence) ? asset.evidence : [];
    if (asset.reviewState === 'confirmed') {
      return '<div class="cognition-actions">'
        + `<button type="button" class="btn btn-primary" data-cognition-action="reuse" data-cognition-id="${escapeHtml(asset.id)}">${escapeHtml(text('cognition.action.reuse', '记录一次复用'))}</button>`
        + `<button type="button" class="btn" data-cognition-action="add-evidence" data-cognition-id="${escapeHtml(asset.id)}">${escapeHtml(text('cognition.action.add_evidence', '补充证据'))}</button>`
        + `<button type="button" class="btn" data-cognition-action="view-history" data-cognition-id="${escapeHtml(asset.id)}">${escapeHtml(text('cognition.action.history', '查看成长记录'))}</button>`
        + '</div>';
    }
    if (asset.reviewState === 'invalidated') {
      const disabled = evidence.length ? '' : ' disabled aria-disabled="true"';
      return '<div class="cognition-actions">'
        + `<button type="button" class="btn btn-primary" data-cognition-action="confirm" data-cognition-id="${escapeHtml(asset.id)}"${disabled}>${escapeHtml(text('cognition.action.reconfirm', '重新确认并写入长期记忆'))}</button>`
        + `<button type="button" class="btn" data-cognition-action="add-evidence" data-cognition-id="${escapeHtml(asset.id)}">${escapeHtml(text('cognition.action.add_evidence', '补充证据'))}</button>`
        + `<button type="button" class="btn" data-cognition-action="defer" data-cognition-id="${escapeHtml(asset.id)}">${escapeHtml(text('cognition.action.defer', '暂不确认'))}</button>`
        + '</div>';
    }
    const disabled = evidence.length ? '' : ' disabled aria-disabled="true"';
    const confirmLabel = asset.confirmationRequestedAt
      ? text('cognition.action.confirm_retry', '重试写入长期记忆')
      : text('cognition.action.confirm', '确认并写入长期记忆');
    return '<div class="cognition-actions">'
      + `<button type="button" class="btn btn-primary" data-cognition-action="confirm" data-cognition-id="${escapeHtml(asset.id)}"${disabled}>${escapeHtml(confirmLabel)}</button>`
      + `<button type="button" class="btn" data-cognition-action="add-evidence" data-cognition-id="${escapeHtml(asset.id)}">${escapeHtml(text('cognition.action.add_evidence', '补充证据'))}</button>`
      + `<button type="button" class="btn" data-cognition-action="defer" data-cognition-id="${escapeHtml(asset.id)}">${escapeHtml(text('cognition.action.defer', '暂不确认'))}</button>`
      + '</div>';
  }

  function renderCreateForm() {
    return '<form class="cognition-create-form" id="cognition-create-form" hidden>'
      + `<label>${escapeHtml(text('cognition.create.title', '认知名称'))}<input id="cognition-create-title" maxlength="120" required /></label>`
      + `<label>${escapeHtml(text('cognition.create.summary', '观察到的工作方式'))}<textarea id="cognition-create-summary" maxlength="2000" required></textarea></label>`
      + `<div class="cognition-actions"><button type="submit" class="btn btn-primary">${escapeHtml(text('cognition.create.submit', '创建种子'))}</button><button type="button" class="btn" data-cognition-action="cancel-create">${escapeHtml(text('cognition.action.cancel', '取消'))}</button></div>`
      + '</form>';
  }

  function renderCognitionCapture(input) {
    const title = String(input?.title || '').trim();
    const summary = String(input?.summary || '').trim();
    const evidence = String(input?.evidence || '').trim();
    const sourceLabel = String(input?.sourceLabel || '').trim();
    const conversationId = String(input?.conversationId || '').trim();
    return '<div class="cognition-capture-overlay" data-cognition-capture-overlay>'
      + '<form class="cognition-capture-modal" data-cognition-capture-form role="dialog" aria-modal="true">'
      + '<div class="cognition-capture-header"><div>'
      + '<strong>' + escapeHtml(text('cognition.capture.title', '沉淀为认知')) + '</strong>'
      + '<span>' + escapeHtml(text('cognition.capture.subtitle', '把这次有效做法保存为待确认候选。')) + '</span>'
      + '</div>'
      + '<button type="button" class="cognition-capture-close" data-cognition-capture-cancel aria-label="'
      + escapeHtml(text('common.close', 'Close')) + '">x</button>'
      + '</div>'
      + '<div class="cognition-capture-body">'
      + '<label>' + escapeHtml(text('cognition.capture.name', '认知名称')) + '<input data-cognition-capture-title maxlength="120" required value="'
      + escapeHtml(title) + '" /></label>'
      + '<label>' + escapeHtml(text('cognition.capture.summary', '可复用的工作方式')) + '<textarea data-cognition-capture-summary maxlength="2000" required>'
      + escapeHtml(summary) + '</textarea></label>'
      + '<label>' + escapeHtml(text('cognition.capture.evidence', '本次证据')) + '<textarea data-cognition-capture-evidence maxlength="2000" required>'
      + escapeHtml(evidence) + '</textarea></label>'
      + '<label>' + escapeHtml(text('cognition.capture.source', '来源')) + '<input data-cognition-capture-source maxlength="160" required value="'
      + escapeHtml(sourceLabel) + '" /></label>'
      + '<input type="hidden" data-cognition-capture-conversation value="' + escapeHtml(conversationId) + '" />'
      + '<p class="cognition-capture-note">' + escapeHtml(text('cognition.capture.note', '保存后会进入待确认列表；确认会将它写入长期记忆。')) + '</p>'
      + '</div>'
      + '<div class="cognition-capture-actions"><button type="button" class="btn" data-cognition-capture-cancel>'
      + escapeHtml(text('cognition.action.cancel', '取消')) + '</button><button type="submit" class="btn btn-primary" data-cognition-capture-submit>'
      + escapeHtml(text('cognition.capture.submit', '保存待确认认知')) + '</button></div>'
      + '</form>'
      + '</div>';
  }

  function renderAssetList(assets, activeId, emptyText) {
    if (!assets.length) return `<div class="cognition-empty">${escapeHtml(emptyText)}</div>`;
    return '<ul class="cognition-asset-list">' + assets.map((asset) => {
      const meta = stageMeta(asset.stage);
      return `<li><button type="button" class="cognition-asset-row${asset.id === activeId ? ' active' : ''}" data-cognition-select="${escapeHtml(asset.id)}">`
        + `<span class="cognition-asset-row-stage cognition-stage-${escapeHtml(asset.stage)}">${escapeHtml(meta.label)}</span>`
        + `<span class="cognition-asset-row-copy"><strong>${escapeHtml(asset.title)}</strong><small>${escapeHtml(asset.summary)}</small></span>`
        + '</button></li>';
    }).join('') + '</ul>';
  }

  function renderInvalidation(asset) {
    if (asset.reviewState !== 'invalidated') return '';
    const reason = asset.invalidation?.reason;
    const reasons = {
      removed: text('cognition.invalidated.reason.removed', '对应的长期记忆已被删除。'),
      replaced: text('cognition.invalidated.reason.replaced', '对应的长期记忆已被其他内容替换。'),
      content_changed: text('cognition.invalidated.reason.content_changed', '长期记忆内容与这项认知已不一致。'),
      metadata_missing: text('cognition.invalidated.reason.metadata_missing', '长期记忆的关联信息缺失或损坏。'),
    };
    const reasonText = reasons[reason] || text('cognition.invalidated.reason.unknown', '长期记忆关联已失效。');
    return '<div class="cognition-invalidated" role="status">'
      + `<strong>${escapeHtml(text('cognition.invalidated.title', '需要重新确认'))}</strong>`
      + `<p>${escapeHtml(text('cognition.invalidated.description', '这项认知已不再处于长期记忆中。请核对内容后重新确认。'))}</p>`
      + `<span>${escapeHtml(reasonText)}</span>`
      + '</div>';
  }

  function renderDetail(asset, view) {
    const evidence = Array.isArray(asset.evidence) ? asset.evidence : [];
    const reuseEvents = Array.isArray(asset.reuseEvents) ? asset.reuseEvents : [];
    const meta = stageMeta(asset.stage);
    return '<section class="cognition-detail">'
      + `<div class="cognition-detail-kicker">${escapeHtml(text('cognition.detail.kicker', '当前认知'))}</div>`
      + `<h2>${escapeHtml(asset.title)}</h2>`
      + `<div class="cognition-status cognition-status-${escapeHtml(asset.stage)}"><i></i>${escapeHtml(meta.state)} · ${escapeHtml(meta.description)}</div>`
      + `<p class="cognition-summary">${escapeHtml(asset.summary)}</p>`
      + renderInvalidation(asset)
      + '<div class="cognition-metrics">'
      + `<div><strong>${evidence.length}</strong><span>${escapeHtml(text('cognition.metric.evidence', '有效证据'))}</span></div>`
      + `<div><strong>${reuseEvents.length}</strong><span>${escapeHtml(text('cognition.metric.reuse', '复用次数'))}</span></div>`
      + '</div>'
      + `<div class="cognition-detail-section"><h3>${escapeHtml(text('cognition.section.evidence', '推动成长的证据'))}</h3>${renderEvidence(asset)}</div>`
      + (asset.reviewState !== 'invalidated' && (view === 'history' || asset.reviewState === 'confirmed')
        ? `<div class="cognition-detail-section"><h3>${escapeHtml(text('cognition.section.reuse', '复用记录'))}</h3>${renderReuseEvents(asset)}</div>` : '')
      + renderActions(asset)
      + '</section>';
  }

  function renderDetailLoading(summary) {
    return '<section class="cognition-detail cognition-detail-loading" aria-busy="true">'
      + `<div class="cognition-detail-kicker">${escapeHtml(text('cognition.detail.kicker', '当前认知'))}</div>`
      + `<h2>${escapeHtml(summary.title)}</h2>`
      + `<p>${escapeHtml(text('cognition.detail.loading', '正在加载完整证据和复用记录…'))}</p>`
      + '</section>';
  }

  function renderDetailUnavailable(summary) {
    return '<section class="cognition-detail cognition-detail-loading">'
      + `<div class="cognition-detail-kicker">${escapeHtml(text('cognition.detail.kicker', '当前认知'))}</div>`
      + `<h2>${escapeHtml(summary.title)}</h2>`
      + `<p>${escapeHtml(text('cognition.detail.unavailable', '完整详情暂不可用，请重试。'))}</p>`
      + '<div class="cognition-actions">'
      + `<button type="button" class="btn" data-cognition-action="retry-detail">${escapeHtml(text('cognition.action.retry_detail', '重新加载详情'))}</button>`
      + '</div></section>';
  }

  function renderPagination(pagination, loading) {
    if (!pagination || !Number.isInteger(pagination.page) || !Number.isInteger(pagination.totalPages)) return '';
    if (pagination.totalPages <= 1) return '';
    const page = Math.min(Math.max(1, pagination.page), pagination.totalPages);
    const label = text('cognition.pagination.status', '第 {page} / {totalPages} 页', {
      page,
      totalPages: pagination.totalPages,
    });
    const busy = loading ? ` · ${text('cognition.pagination.loading', '加载中…')}` : '';
    return '<nav class="cognition-pagination" aria-label="' + escapeHtml(text('cognition.pagination.label', '认知资产分页')) + '">'
      + `<button type="button" class="btn" data-cognition-page="${page - 1}"${loading || page <= 1 ? ' disabled' : ''}>${escapeHtml(text('cognition.pagination.previous', '上一页'))}</button>`
      + `<span>${escapeHtml(label + busy)}</span>`
      + `<button type="button" class="btn" data-cognition-page="${page + 1}"${loading || page >= pagination.totalPages ? ' disabled' : ''}>${escapeHtml(text('cognition.pagination.next', '下一页'))}</button>`
      + '</nav>';
  }

  function renderCognitionPage(input) {
    const inputValue = input || {};
    const assets = Array.isArray(inputValue.assets) ? inputValue.assets.filter((asset) => asset && typeof asset === 'object') : [];
    const view = inputValue.view === 'pending' || inputValue.view === 'history' ? inputValue.view : 'tree';
    const visible = view === 'pending'
      ? assets.filter((asset) => asset.reviewState !== 'confirmed')
      : assets;
    const active = visible.find((asset) => asset.id === inputValue.activeId) || visible[0] || null;
    const activeAsset = inputValue.activeAsset && active && inputValue.activeAsset.id === active.id
      && Array.isArray(inputValue.activeAsset.evidence) && Array.isArray(inputValue.activeAsset.reuseEvents)
      ? inputValue.activeAsset
      : null;
    const title = text('cognition.title', '认知成长');
    const subtitle = text('cognition.subtitle', '真实证据会让一项认知逐步成为可复用能力。');
    const emptyText = view === 'pending'
      ? (inputValue.pagination?.totalPages > 1
          ? text('cognition.empty.pending_page', '本页暂无待确认的认知种子')
          : text('cognition.empty.pending', '暂无待确认的认知种子'))
      : text('cognition.empty.all', '还没有认知资产，先创建一颗种子。');
    const detail = !active
      ? ''
      : (activeAsset
          ? renderDetail(activeAsset, view)
          : (inputValue.detailLoading ? renderDetailLoading(active) : renderDetailUnavailable(active)));
    const emptyPage = inputValue.listLoading
      ? text('cognition.list.loading', '正在加载认知资产…')
      : emptyText;
    return '<div class="cognition-page" data-cognition-view-root>'
      + `<header class="cognition-header"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><button type="button" class="btn btn-primary" data-cognition-action="open-create">${escapeHtml(text('cognition.action.create', '新建认知种子'))}</button></header>`
      + renderTabs(view)
      + renderCreateForm()
      + (active ? `<div class="cognition-content"><main class="cognition-main">${renderGrowthVisual(active)}</main><aside>${renderAssetList(visible, active.id, emptyText)}${renderPagination(inputValue.pagination, inputValue.listLoading)}</aside>${detail}</div>` : `<div class="cognition-empty-page"${inputValue.listLoading ? ' aria-busy="true"' : ''}><div><p>${escapeHtml(emptyPage)}</p>${renderPagination(inputValue.pagination, inputValue.listLoading)}</div></div>`)
      + '</div>';
  }

  const api = { escapeHtml, renderCognitionPage, renderGrowthVisual, renderCognitionCapture, stageMeta };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CognitionPages = api;
})(typeof window !== 'undefined' ? window : globalThis);
