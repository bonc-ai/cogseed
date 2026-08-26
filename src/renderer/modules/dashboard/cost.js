// ─── 智能体总览 2.0 · 成本标签（双层账本）────────────────────────────────
// 人话层默认（钱），技术层展开（token 明细）。诚实性五条在这里执行：
// 钱数只在用户自填单价后出现（localStorage 设备本地——每台机器的中转价
// 不同，内置表必然不准）；没填单价显示引导按钮而非空转；成本带「按你
// 填的单价估算」字样；统计起点永显；无缓存数据的桶不给命中率（不拿 0
// 冒充）。外接 CLI 分区如实标注「内部消耗由其自计，此处不可见」。
(function () {
  'use strict';
  const DS = () => window.DashboardShared;

  const PRICE_KEY = 'dashboard-price-table';      // { [modelId]: { in: ¥/1M, out: ¥/1M } }
  const BUDGET_KEY = 'dashboard-daily-budget';    // ¥/day（字符串数字）

  let _pane = null;
  let _aggregate = null;      // dimension=day 的本周数据（默认视图）
  let _dim = 'day';
  let _dimData = null;

  function readPrices() {
    try {
      const raw = JSON.parse(localStorage.getItem(PRICE_KEY) || '{}');
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (_) { return {}; }
  }

  function readBudget() {
    try {
      const v = Number(localStorage.getItem(BUDGET_KEY));
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (_) { return 0; }
  }

  // 按已填单价折算一个桶的花费（¥）；无法折算返回 null——绝不假算
  function yuanOf(bucket) {
    const prices = readPrices();
    if (!Object.keys(prices).length) return null;
    // day 维度桶是多模型混合，需按模型拆——第一版按桶级单价表聚合：
    // 用桶的 input/output 与「默认单价」（用户填的 * 或 default 条目）。
    const def = prices['*'] || prices.default;
    if (!def) return null;
    const cost = (bucket.inputTokens / 1e6) * (Number(def.in) || 0)
      + (bucket.outputTokens / 1e6) * (Number(def.out) || 0);
    return cost;
  }

  function dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function todayBucket() {
    if (!_aggregate || _aggregate.empty) return null;
    const key = dayKey(Date.now());
    return (_aggregate.buckets || []).find((b) => b.key === key) || null;
  }

  async function fetchAggregate(dimension, from, to) {
    const res = await DS().invoke('dashboard.cost.query', { dimension, from, to });
    if (res && res.ok && res.aggregate) return res.aggregate;
    throw new Error('cost query failed');
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────
  function render() {
    if (!_pane) return;
    const esc = DS().esc;
    const t = DS().t;
    const fmt = DS().fmtTokens;
    const agg = _dim === 'day' ? _aggregate : _dimData;
    if (!agg) {
      _pane.innerHTML = `<div class="dash-loading">${esc(t('dashboard.loading'))}</div>`;
      return;
    }

    const prices = readPrices();
    const hasPrices = Object.keys(prices).length > 0;
    const today = todayBucket();
    const budget = readBudget();
    const todayYuan = hasPrices && today ? (yuanOf(today) || 0) : null;

    // 预算横幅（只在填了单价与预算且今日超线时出现）
    let budgetBanner = '';
    if (todayYuan !== null && budget > 0 && todayYuan > budget) {
      budgetBanner = `<div class="dash-budget-warn">${esc(t('dashboard.cost.budget_exceeded', { amount: todayYuan.toFixed(2), budget: String(budget) }))}</div>`;
    }

    // 人话层：今日花费（有单价才有）；未填单价 → 引导按钮
    const money = hasPrices
      ? `<div class="dash-cost-big">
          <span class="dash-cost-amount">¥ ${todayYuan === null ? '—' : todayYuan.toFixed(2)}</span>
          <span class="dash-cost-note">${esc(t('dashboard.cost.estimate_note'))}</span>
        </div>`
      : `<div class="dash-cost-big">
          <button type="button" class="btn btn-primary" data-cost-act="setup-prices">${esc(t('dashboard.cost.setup_prices'))}</button>
        </div>`;

    // 技术层：维度切换 + 表格
    const dims = ['day', 'agent', 'conversation'].map((d) =>
      `<button type="button" class="btn btn-sm${_dim === d ? ' btn-primary' : ''}" data-cost-act="dim" data-dim="${d}">${esc(t(`dashboard.cost.dim_${d}`))}</button>`).join('');
    const rows = (agg.buckets || []).map((b) => {
      const cache = typeof b.cacheHitRate === 'number'
        ? `<span class="dash-cost-cache">${Math.round(b.cacheHitRate * 100)}%</span>`
        : `<span class="dash-cost-cache is-na">${esc(t('dashboard.cost.no_cache_data'))}</span>`;
      return `<tr>
        <td class="dash-mono">${esc(b.key)}</td>
        <td>${b.calls}</td>
        <td>${fmt(b.inputTokens)}</td>
        <td>${fmt(b.outputTokens)}</td>
        <td>${fmt(b.totalTokens)}</td>
        <td>${cache}</td>
      </tr>`;
    }).join('');
    const table = agg.empty
      ? `<div class="dash-empty">${esc(t('dashboard.cost.empty'))}</div>`
      : `<table class="dash-cost-table">
        <thead><tr>
          <th>${esc(t(`dashboard.cost.dim_${_dim}`))}</th>
          <th>${esc(t('dashboard.cost.calls'))}</th>
          <th>${esc(t('dashboard.cost.input'))}</th>
          <th>${esc(t('dashboard.cost.output'))}</th>
          <th>${esc(t('dashboard.cost.total'))}</th>
          <th>${esc(t('dashboard.cost.cache'))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    const since = agg.since
      ? `<div class="dash-cost-since">${esc(t('dashboard.cost.since', { date: agg.since.slice(0, 10) }))}</div>`
      : '';

    // 外接 CLI 诚实标注（常态显示）
    const cliNote = `<div class="dash-cost-clinote">${esc(t('dashboard.cost.cli_note'))}</div>`;

    _pane.innerHTML = `
      ${budgetBanner}
      ${money}
      <div class="dash-cost-toolbar">
        <span class="dash-cost-dims">${dims}</span>
        <span class="dash-roster-spacer"></span>
        <button type="button" class="btn btn-sm" data-cost-act="setup-prices">${esc(t('dashboard.cost.price_settings'))}</button>
      </div>
      ${table}
      ${cliNote}
      ${since}`;
  }

  // ── 单价/预算设置（T14）：设备本地存储，编辑后立即生效 ─────────────────
  function renderPriceDialog() {
    const t = DS().t;
    const esc = DS().esc;
    const prices = readPrices();
    const budget = readBudget();
    const overlay = document.createElement('div');
    overlay.className = 'dash-price-dialog';
    overlay.innerHTML = `
      <div class="dash-price-card">
        <div class="dash-price-title">${esc(t('dashboard.cost.price_title'))}</div>
        <p class="dash-price-desc">${esc(t('dashboard.cost.price_desc'))}</p>
        <label class="dash-model-row">
          <span>${esc(t('dashboard.cost.default_price_in'))}（¥/1M）</span>
          <input type="number" step="0.01" min="0" id="dash-price-in" value="${Number((prices['*'] || {}).in) || ''}">
        </label>
        <label class="dash-model-row">
          <span>${esc(t('dashboard.cost.default_price_out'))}（¥/1M）</span>
          <input type="number" step="0.01" min="0" id="dash-price-out" value="${Number((prices['*'] || {}).out) || ''}">
        </label>
        <label class="dash-model-row">
          <span>${esc(t('dashboard.cost.budget'))}（¥/天，0=不提醒）</span>
          <input type="number" step="0.01" min="0" id="dash-price-budget" value="${budget || ''}">
        </label>
        <div class="dash-price-actions">
          <button type="button" class="btn btn-sm" data-cost-act="close-prices">${esc(t('dashboard.cost.close'))}</button>
          <button type="button" class="btn btn-sm btn-primary" data-cost-act="save-prices">${esc(t('dashboard.cost.save'))}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }

  function savePrices(overlay) {
    const num = (id) => {
      const v = Number((document.getElementById(id) || {}).value);
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    const pin = num('dash-price-in');
    const pout = num('dash-price-out');
    const budget = num('dash-price-budget');
    const prices = pin > 0 || pout > 0 ? { '*': { in: pin || 0, out: pout || 0 } } : {};
    try {
      localStorage.setItem(PRICE_KEY, JSON.stringify(prices));
      localStorage.setItem(BUDGET_KEY, String(budget));
    } catch (_) { /* 存储失败不阻塞界面 */ }
    if (overlay && overlay.remove) overlay.remove();
    render();
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  async function load() {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    _aggregate = await fetchAggregate('day', weekAgo, now).catch(() => null);
    if (_dim !== 'day') _dimData = await fetchAggregate(_dim, weekAgo, now).catch(() => null);
    render();
  }

  async function mount(pane) {
    _pane = pane;
    if (!_pane.dataset.costWired) {
      _pane.dataset.costWired = '1';
      _pane.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('[data-cost-act]') : null;
        if (!btn) return;
        const act = btn.dataset.costAct;
        if (act === 'dim') {
          _dim = btn.dataset.dim || 'day';
          void load();
        } else if (act === 'setup-prices') {
          renderPriceDialog();
        } else if (act === 'close-prices') {
          const overlay = btn.closest('.dash-price-dialog');
          if (overlay && overlay.remove) overlay.remove();
        } else if (act === 'save-prices') {
          savePrices(btn.closest('.dash-price-dialog'));
        }
      });
    }
    render();
    await load();
  }

  function unmount() { _pane = null; }

  async function refresh() { await load(); }

  function onI18nChange() { render(); }

  window.DashboardViews = window.DashboardViews || {};
  window.DashboardViews.cost = { mount, unmount, refresh, onI18nChange };
}());
