// ─── 安全与信任设置页（v2 设计：Hero 总览 + 组件卡 + 记录表 + 单技能检查）───
// UX-first 原则：
//   - 健康态极简：一眼绿勾，不读任何详情也知道"现在安全"；
//   - 异常态可行动：每个异常都带一句"怎么办"；
//   - 单技能检查：每行可重新检查；也支持搜索任意已安装技能来检查；
//   - 只读页面，绝不新增阻塞弹窗——检查是后台动作，结果就地刷新。

(() => {
  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function relTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
    if (mins < 1) return t('settings.security.just_now');
    if (mins < 60) return t('settings.security.mins_ago', { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('settings.security.hours_ago', { n: hours });
    const days = Math.floor(hours / 24);
    return t('settings.security.days_ago', { n: days });
  }

  // ── 状态模型 ────────────────────────────────────────────────────────────
  let state = {
    status: null,      // skills.security.status 结果
    receipts: [],      // skills.trust.list
    skills: [],        // skills.list（用于选择器与总数）
    expanded: false,   // 记录表是否"查看全部"
    pickerOpen: false,
  };

  function heroKind() {
    const st = state.status;
    if (!st) return 'bad';
    if (st.scanner !== 'present' || st.scannerIntegrity === 'tampered' || st.declarationIntegrity === 'tampered') return 'bad';
    if (st.scannerIntegrity !== 'verified' || st.declarationIntegrity !== 'verified') return 'warn';
    return 'ok';
  }

  function pillCls(decision) {
    if (decision === 'pass') return 'ok';
    if (decision === 'risk') return 'warn';
    if (decision === 'blocked') return 'bad';
    return 'muted';
  }

  function decisionText(decision) {
    if (decision === 'pass') return t('settings.security.decision_pass');
    if (decision === 'risk') return t('settings.security.decision_risk');
    if (decision === 'blocked') return t('settings.security.decision_blocked');
    return t('settings.security.decision_unknown');
  }

  function integrityText(v) {
    return {
      verified: t('settings.security.integrity_verified'),
      tampered: t('settings.security.integrity_tampered'),
      unpinned: t('settings.security.integrity_unpinned'),
      unreadable: t('settings.security.integrity_unreadable'),
    }[v] || String(v || '—');
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────
  function heroHtml(kind) {
    const st = state.status || {};
    const ok = kind === 'ok';
    const warn = kind === 'warn';
    const tagCls = ok ? 'ok' : warn ? 'warn' : 'bad';
    const tagText = ok ? t('settings.security.tag_ok')
      : warn ? t('settings.security.tag_attention') : t('settings.security.tag_alert');
    const title = ok ? t('settings.security.hero_ok')
      : warn ? t('settings.security.hero_attention') : t('settings.security.hero_alert');
    const desc = ok ? t('settings.security.hero_ok_desc')
      : warn ? t('settings.security.hero_attention_desc') : t('settings.security.hero_alert_desc');
    const last = state.receipts[0];
    const lastAt = last && last.scannedAt ? t('settings.security.last_checked_at', { time: relTime(last.scannedAt) }) : '';
    return `<div class="sec-hero">
      <div class="sec-hero-icon ${tagCls}"><span class="sec-hero-dot"></span></div>
      <div class="sec-hero-main">
        <div class="sec-hero-title">${esc(title)} <span class="sec-tag ${tagCls}">${esc(tagText)}</span></div>
        <div class="sec-hero-desc">${esc(desc)}${lastAt ? ` ${esc(lastAt)}` : ''}</div>
        <div class="sec-hero-meta">
          <span>${esc(t('settings.security.scanner_label'))} <b>${esc(st.scanner === 'present' ? t('settings.security.scanner_present') : st.scanner === 'absent_by_build' ? t('settings.security.scanner_absent_build') : st.scanner === 'broken' ? t('settings.security.scanner_broken') : t('settings.security.status_unknown'))}</b></span>
          <span>${esc(t('settings.security.ruleset'))} <b>${esc(st.sentryRulesetVersion || '—')}</b></span>
          <span>${esc(t('settings.security.sentry_engine'))} <b>${esc(st.sentryEngineVersion ? `skill-sentry ${st.sentryEngineVersion}` : '—')}</b></span>
          <span>${esc(t('settings.security.declaration_engine'))} <b>${esc(st.declarationEngineVersion ? `declaration-core ${st.declarationEngineVersion}` : '—')}</b></span>
        </div>
      </div>
    </div>`;
  }

  function componentCardsHtml() {
    const st = state.status || {};
    const scannerOk = st.scanner === 'present';
    const sentryOk = st.scannerIntegrity === 'verified';
    const declarationOk = st.declarationIntegrity === 'verified';
    const cls = (ok) => (ok ? 'ok' : st.scannerIntegrity === 'tampered' || st.declarationIntegrity === 'tampered' ? 'bad' : 'warn');
    return `<div class="sec-grid">
      <div class="sec-card">
        <div class="sec-card-head"><div class="sec-card-name">${esc(t('settings.security.scanner_label'))}</div>
          <span class="sec-pill ${scannerOk ? 'ok' : 'bad'}">${esc(scannerOk ? t('settings.security.scanner_present') : t('settings.security.scanner_broken'))}</span></div>
        <div class="sec-card-row"><span>${esc(t('settings.security.integrity_label'))}</span><span>${esc(integrityText(st.scannerIntegrity))}</span></div>
        <div class="sec-card-row"><span>${esc(t('settings.security.ruleset'))}</span><span>${esc(st.sentryRulesetVersion || '—')}</span></div>
        <div class="sec-card-note">${esc(scannerOk ? t('settings.security.card_scanner_note') : t('settings.security.card_scanner_note_broken'))}</div>
      </div>
      <div class="sec-card">
        <div class="sec-card-head"><div class="sec-card-name">${esc(t('settings.security.sentry_engine'))}</div>
          <span class="sec-pill ${cls(sentryOk)}">${esc(sentryOk ? t('settings.security.tag_ok') : t('settings.security.tag_attention'))}</span></div>
        <div class="sec-card-row"><span>${esc(t('settings.security.col_version'))}</span><span>${esc(st.sentryEngineVersion || '—')}</span></div>
        <div class="sec-card-row"><span>${esc(t('settings.security.ruleset'))}</span><span>${esc(st.sentryRulesetVersion || '—')}</span></div>
        <div class="sec-card-note">${esc(t('settings.security.card_sentry_note'))}</div>
      </div>
      <div class="sec-card">
        <div class="sec-card-head"><div class="sec-card-name">${esc(t('settings.security.declaration_engine'))}</div>
          <span class="sec-pill ${cls(declarationOk)}">${esc(declarationOk ? t('settings.security.tag_ok') : t('settings.security.tag_attention'))}</span></div>
        <div class="sec-card-row"><span>${esc(t('settings.security.integrity_label'))}</span><span>${esc(integrityText(st.declarationIntegrity))}</span></div>
        <div class="sec-card-row"><span>${esc(t('settings.security.col_version'))}</span><span>${esc(st.declarationEngineVersion || '—')}</span></div>
        <div class="sec-card-note">${esc(t('settings.security.card_declaration_note'))}</div>
      </div>
    </div>`;
  }

  function scoreBar(score) {
    if (typeof score !== 'number') return '<span class="sec-score-num">—</span>';
    const cls = score >= 90 ? '' : score >= 60 ? 'mid' : 'low';
    return `<div class="sec-score"><div class="sec-score-bar"><i class="${cls}" style="width:${Math.max(4, Math.min(100, score))}%"></i></div><span class="sec-score-num">${score}</span></div>`;
  }

  function receiptRow(r) {
    const sub = [r.scanner === 'deep' ? t('skills.security_scanner_deep') : t('skills.security_scanner_local')]
      .concat(r.rulesDegraded ? [t('skills.security_rules_degraded')] : [])
      .join(' · ');
    return `<tr data-skill="${esc(r.skillId)}">
      <td><div class="sec-id"><div class="sec-dot">${esc(String(r.skillId).slice(0, 1).toUpperCase())}</div>
        <div><div class="sec-id-name">${esc(r.skillId)}</div><div class="sec-id-sub">${esc(sub || '—')}</div></div></div></td>
      <td><span class="sec-pill ${pillCls(r.decision)}" data-role="pill">${esc(decisionText(r.decision))}</span></td>
      <td>${scoreBar(r.securityScore)}</td>
      <td class="sec-time">${esc(relTime(r.scannedAt))}</td>
      <td><button type="button" class="sec-link" data-action="recheck">${esc(t('settings.security.recheck'))}</button></td>
    </tr>`;
  }

  function receiptsHtml() {
    const rows = state.expanded ? state.receipts : state.receipts.slice(0, 10);
    return `<div class="sec-section-head">
      <div><div class="sec-section-title">${esc(t('settings.security.recent_title'))}</div>
      <div class="sec-section-sub">${esc(t('settings.security.recent_sub'))}</div></div>
      <div class="sec-section-sub">${esc(t('settings.security.checked_count', { n: state.receipts.length }))}</div>
    </div>
    <div class="sec-table-wrap">
      <table class="sec-table">
        <thead><tr>
          <th>${esc(t('settings.security.col_skill'))}</th>
          <th>${esc(t('settings.security.col_decision'))}</th>
          <th>${esc(t('settings.security.col_score'))}</th>
          <th>${esc(t('settings.security.col_time'))}</th>
          <th></th>
        </tr></thead>
        <tbody>${rows.length ? rows.map(receiptRow).join('') : `<tr><td colspan="5"><div class="sec-empty">${esc(t('settings.security.no_receipts'))}</div></td></tr>`}</tbody>
      </table>
      ${state.receipts.length > 10
        ? `<div class="sec-table-foot">
            <span class="sec-hint">${esc(t('settings.security.table_foot_hint'))}</span>
            <button type="button" class="sec-link" data-action="toggle-all">${esc(state.expanded ? t('settings.security.view_recent') : t('settings.security.view_all'))}</button>
          </div>`
        : `<div class="sec-table-foot"><span class="sec-hint">${esc(t('settings.security.table_foot_hint'))}</span></div>`}
    </div>`;
  }

  function pickerHtml() {
    const q = state.pickerQuery || '';
    const matches = state.skills
      .filter((sk) => !q || String(sk.id || '').toLowerCase().includes(q.toLowerCase())
        || String(sk.name || '').toLowerCase().includes(q.toLowerCase()))
      .slice(0, 50);
    const receiptById = new Map(state.receipts.map((r) => [r.skillId, r]));
    return `<div class="sec-picker${state.pickerOpen ? ' open' : ''}">
      <input class="sec-picker-input" data-role="picker-input" placeholder="${esc(t('settings.security.search_placeholder'))}" value="${esc(q)}">
      <div class="sec-picker-list">
        ${matches.length
          ? matches.map((sk) => {
            const rc = receiptById.get(sk.id);
            return `<div class="sec-picker-item">
              <span class="sec-picker-name">${esc(sk.id)}</span>
              <span class="sec-picker-sub">${esc(sk.name || '')}${rc ? ` · ${esc(decisionText(rc.decision))}` : ''}</span>
              <button type="button" class="sec-link" data-action="check" data-skill="${esc(sk.id)}">${esc(t('settings.security.check_action'))}</button>
            </div>`;
          }).join('')
          : `<div class="sec-empty">${esc(t('settings.security.picker_empty'))}</div>`}
      </div>
    </div>`;
  }

  function render() {
    const body = $('#settings-security-body');
    if (!body) return;
    const kind = heroKind();
    body.innerHTML = `
      ${heroHtml(kind)}
      ${componentCardsHtml()}
      ${receiptsHtml()}
      <div class="sec-actions">
        <button type="button" class="btn btn-sm sec-btn-primary" data-action="export">${esc(t('settings.security.export'))}</button>
        <button type="button" class="btn btn-sm" data-action="toggle-picker">${esc(t('settings.security.check_one'))}</button>
        <button type="button" class="btn btn-sm" data-action="refresh">${esc(t('settings.security.refresh'))}</button>
      </div>
      ${pickerHtml()}
      <div class="sec-protect"><span class="sec-lock"></span><span>${esc(t('settings.security.protection_sub'))}</span></div>`;
    wire();
  }

  function renderLoading() {
    const body = $('#settings-security-body');
    if (body) body.innerHTML = `<div class="sec-loading">${esc(t('settings.security.loading'))}</div>`;
  }

  // ── 数据加载与动作 ────────────────────────────────────────────────────────
  async function loadAll() {
    renderLoading();
    try {
      const r = await window.cogseed.invoke('skills.security.status', {});
      state.status = (r && r.status) || null;
    } catch (_) { state.status = null; }
    try {
      const r = await window.cogseed.invoke('skills.trust.list', {});
      state.receipts = Array.isArray(r && r.receipts) ? r.receipts : [];
    } catch (_) { state.receipts = []; }
    try {
      const r = await window.cogseed.invoke('skills.list', {});
      state.skills = Array.isArray(r && r.skills) ? r.skills : [];
    } catch (_) { state.skills = []; }
    render();
  }

  function setRowChecking(skillId, on) {
    const row = document.querySelector(`#settings-security-body tr[data-skill="${CSS.escape(skillId)}"]`);
    if (!row) return;
    const btn = row.querySelector('[data-action="recheck"]');
    if (!btn) return;
    if (on) {
      btn.disabled = true;
      btn.classList.add('checking');
      btn.textContent = t('settings.security.checking');
    } else {
      btn.disabled = false;
      btn.classList.remove('checking');
      btn.textContent = t('settings.security.recheck');
    }
  }

  async function recheckSkill(skillId) {
    setRowChecking(skillId, true);
    try {
      await window.cogseed.invoke('skills.trust.reverify', { skillId });
    } catch (_) {
      // A failed recheck keeps the old record — the next full refresh retries.
    }
    // Refresh receipts + guardrail status in place; the row updates on render.
    try {
      const r = await window.cogseed.invoke('skills.trust.list', {});
      state.receipts = Array.isArray(r && r.receipts) ? r.receipts : [];
    } catch (_) { /* keep old */ }
    render();
  }

  function exportReceipts() {
    const payload = state.receipts.map((r) => ({
      skillId: r.skillId,
      decision: r.decision,
      scannedAt: r.scannedAt,
      securityScore: r.securityScore,
      scanner: r.scanner,
      scannerVersion: r.scannerVersion,
      rulesetVersion: r.rulesetVersion,
      isolated: r.isolated,
      rulesDegraded: r.rulesDegraded,
      attackSurface: r.attackSurface,
      dependencyHash: r.dependencyHash,
      permissionHash: r.permissionHash,
      violationCount: r.violationCount,
      topRule: r.topRule,
      topLevel: r.topLevel,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cogseed-security-receipts.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function wire() {
    const body = $('#settings-security-body');
    if (!body) return;
    if (body.dataset.securityBound === '1') return;
    body.dataset.securityBound = '1';
    body.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === 'recheck' || action === 'check') {
        const tr = el.closest('tr');
        const skillId = action === 'recheck'
          ? tr && tr.dataset.skill
          : el.dataset.skill;
        if (skillId) recheckSkill(skillId);
      } else if (action === 'refresh') {
        loadAll();
      } else if (action === 'export') {
        exportReceipts();
      } else if (action === 'toggle-all') {
        state.expanded = !state.expanded;
        render();
      } else if (action === 'toggle-picker') {
        state.pickerOpen = !state.pickerOpen;
        render();
      }
    });
    body.addEventListener('input', (ev) => {
      const el = ev.target.closest('[data-role="picker-input"]');
      if (!el) return;
      state.pickerQuery = String(el.value || '');
      // Re-render just the picker list by re-rendering the picker block.
      const pickerEl = body.querySelector('.sec-picker');
      if (pickerEl) pickerEl.outerHTML = pickerHtml();
      const input = body.querySelector('[data-role="picker-input"]');
      if (input) { input.focus(); const v = input.value; input.value = ''; input.value = v; }
    });
  }

  function initSecuritySettings() {
    const tabBtn = document.querySelector('[data-settings-tab="security"]');
    if (tabBtn) {
      tabBtn.addEventListener('click', () => {
        if (!tabBtn.dataset.securityLoaded) {
          tabBtn.dataset.securityLoaded = '1';
          loadAll();
        }
      });
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('i18n-change', () => {
      const tabBtn = document.querySelector('[data-settings-tab="security"]');
      if (tabBtn?.dataset.securityLoaded === '1') render();
    });
  }

  function onReady() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initSecuritySettings);
    } else {
      initSecuritySettings();
    }
  }
  onReady();

  if (typeof window !== 'undefined') {
    window.loadSecuritySettings = loadAll;
  }
})();
