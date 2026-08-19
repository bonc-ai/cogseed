// ─── 导入检查结果弹窗（W5：文件夹 / URL 导入统一使用）──────────────────
// 一个弹窗、五种状态：通过 / 有提示 / 已拦截 / 检查不可用 / 检查中。
// 原则：
//   - 通过态不打断操作流：一次点击即完成，无二次确认；
//   - 已拦截态无"强制安装"——只给 [知道了] 与 [导出脱敏报告]；
//   - 发现列表只显示白话风险与位置，绝不展示匹配到的原文（可能是密钥）；
//   - 来源（文件夹 / URL）只体现在头部徽章，弹窗结构与动作完全一致。
(() => {
  const RISK_RULE_KEYS = [
    'no_credential_path_read',
    'no_exfiltration_of_local_files',
    'no_root_scope_destruction',
    'no_download_then_execute',
    'no_eval_with_external_input',
  ];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function riskText(ruleId) {
    const key = `marketplace.risk_rule_${ruleId}`;
    const loc = typeof t === 'function' ? t(key) : key;
    return loc === key ? String(ruleId) : loc;
  }

  function icon(svg) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`;
  }
  const ICONS = {
    ok: icon('<path d="M20 6L9 17l-5-5"/>'),
    warn: icon('<path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
    bad: icon('<circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>'),
    miss: icon('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
    scan: icon('<circle cx="12" cy="12" r="9" stroke-dasharray="42 14"/>'),
  };

  function findingRow(level, text, loc) {
    const cls = level === 'EXTREME' ? 'extreme' : level === 'MEDIUM' ? 'medium' : 'low';
    return `<div class="imp-finding"><span class="imp-finding-dot ${cls}"></span>
      <span class="imp-finding-text">${esc(text)}</span>
      <span class="imp-finding-loc">${esc(loc || '')}</span></div>`;
  }

  /**
   * 展示导入检查结果弹窗。
   *
   * @param opts
   *   skillName  技能名
   *   source     'folder' | 'url'
   *   state      'scanning' | 'pass' | 'risk' | 'blocked' | 'unavailable'
   *   score      0-100（可选）
   *   description  状态说明（可选，缺省用内置文案）
   *   findings   [{ level: 'EXTREME'|'MEDIUM'|'LOW', text, loc }]
   *   surface    { egressPoints, dynamicExecPoints, persistencePoints }（可选）
   *   actions    { primary, secondary[], danger, ghost, primaryId, ... }
   *
   * 返回 Promise<'done'|'keep'|'recheck'|'delete'|'draft'|'retry'|'close'>。
   * 支持调用方先以 'scanning' 展示，再调用 updateImportCheckState(state, patch) 原地更新。
   */
  function showImportCheckResult(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay imp-overlay open';
      const modal = document.createElement('div');
      modal.className = 'modal imp-modal';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      let settled = false;
      const onI18nChange = () => {
        if (!settled) render();
      };
      const settle = (action) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('i18n-change', onI18nChange);
        overlay.classList.remove('open');
        setTimeout(() => overlay.remove(), 200);
        resolve(action);
      };

      const stateDefs = {
        scanning: {
          cls: 'muted', ic: 'scan', title: () => t('import_check.scanning_title'), score: null,
          desc: () => t('import_check.scanning_desc'),
          actions: null,
        },
        pass: {
          cls: 'ok', ic: 'ok', title: () => t('import_check.pass_title'), score: true,
          desc: () => t('import_check.pass_desc'),
          actions: { primary: { id: 'done', labelKey: 'import_check.done' }, ghost: { id: 'view', labelKey: 'import_check.view_skill' } },
        },
        risk: {
          cls: 'warn', ic: 'warn', title: () => t('import_check.risk_title'), score: true,
          desc: () => t('import_check.risk_desc'),
          actions: {
            primary: { id: 'keep', labelKey: 'import_check.keep' },
            secondary: [{ id: 'recheck', labelKey: 'import_check.recheck' }],
            danger: { id: 'delete', labelKey: 'import_check.delete' },
          },
        },
        blocked: {
          cls: 'bad', ic: 'bad', title: () => t('import_check.blocked_title'), score: true,
          desc: () => t('import_check.blocked_desc'),
          actions: { primary: { id: 'close', labelKey: 'import_check.got_it' }, ghost: { id: 'export', labelKey: 'import_check.export_report' } },
        },
        unavailable: {
          cls: 'muted', ic: 'miss', title: () => t('import_check.unavailable_title'), score: null,
          desc: () => t('import_check.unavailable_desc'),
          actions: {
            primary: { id: 'draft', labelKey: 'import_check.keep_draft' },
            secondary: [{ id: 'retry', labelKey: 'import_check.retry' }],
          },
        },
      };

      function render() {
        const st = opts.state || 'scanning';
        const def = stateDefs[st] || stateDefs.scanning;
        const score = typeof opts.score === 'number' ? opts.score : null;
        const findings = Array.isArray(opts.findings) ? opts.findings.slice(0, 6) : [];
        const more = Array.isArray(opts.findings) && opts.findings.length > findings.length
          ? opts.findings.length - findings.length : 0;
        const surface = opts.surface || null;
        const srcLabel = opts.source === 'url' ? t('import_check.src_url') : t('import_check.src_folder');
        const actionLabel = (action) => action.labelKey ? t(action.labelKey) : (action.label || '');

        let foot = '';
        if (def.actions) {
          const a = def.actions;
          foot += a.primary ? `<button type="button" class="btn imp-btn-primary" data-act="${a.primary.id}">${esc(actionLabel(a.primary))}</button>` : '';
          (a.secondary || []).forEach((s) => { foot += `<button type="button" class="btn" data-act="${s.id}">${esc(actionLabel(s))}</button>`; });
          foot += '<span class="imp-spacer"></span>';
          if (a.danger) foot += `<button type="button" class="btn imp-btn-danger" data-act="${a.danger.id}">${esc(actionLabel(a.danger))}</button>`;
          if (a.ghost) foot += `<button type="button" class="btn imp-btn-ghost" data-act="${a.ghost.id}">${esc(actionLabel(a.ghost))}</button>`;
        }

        modal.innerHTML = `
          <div class="modal-header">
            <div>
              <div class="modal-title">${esc(t('import_check.title'))}</div>
              <div class="imp-sub"><span>${esc(opts.skillName || '')}</span><span class="imp-src-badge">${esc(srcLabel)}</span></div>
            </div>
            <button type="button" class="modal-close-btn imp-close" data-act="close" title="${esc(t('import_check.close'))}">✕</button>
          </div>
          <div class="imp-status ${def.cls}">
            <div class="imp-status-icon">${ICONS[def.ic]}</div>
            <div class="imp-status-main">
              <div class="imp-status-title">${esc(def.title())}${score != null && def.score ? `<span class="imp-score-chip">${esc(t('import_check.score', { n: score }))}</span>` : ''}</div>
              <div class="imp-status-desc">${esc(opts.description || def.desc())}</div>
            </div>
          </div>
          ${surface ? `<div class="imp-surface">
            <span class="imp-surface-chip">${esc(t('import_check.egress'))} <b>${surface.egressPoints ?? 0}</b></span>
            <span class="imp-surface-chip">${esc(t('import_check.dynexec'))} <b>${surface.dynamicExecPoints ?? 0}</b></span>
            <span class="imp-surface-chip">${esc(t('import_check.persist'))} <b>${surface.persistencePoints ?? 0}</b></span>
          </div>` : ''}
          ${findings.length ? `<div class="imp-findings-title">${esc(t('import_check.findings_title'))}</div>
          <div class="imp-findings">
            ${findings.map((f) => findingRow(f.level || 'LOW', f.text, f.loc)).join('')}
            ${more ? `<div class="imp-findings-more">${esc(t('import_check.more_findings', { n: more }))}</div>` : ''}
          </div>` : ''}
          <div class="imp-foot">${foot}</div>
          <div class="imp-note">${esc(t('import_check.note'))}</div>`;

        modal.querySelectorAll('[data-act]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.act;
            if (id === 'view' || id === 'export' || id === 'close') settle(id);
            else settle(id);
          });
        });
      }

      window.addEventListener('i18n-change', onI18nChange);
      render();

      const api = {
        update(patch) {
          Object.assign(opts, patch);
          render();
        },
        close(action = 'close') { settle(action); },
      };
      if (typeof window !== 'undefined') {
        window.__lastImportCheckModal = api;
      }
      // 供调用方持有句柄：通过自定义事件外露
      overlay.dataset.api = '1';
      (overlay).__api = api;
      opts._api = api;
      if (typeof opts.onReady === 'function') opts.onReady(api);
    });
  }

  window.showImportCheckResult = showImportCheckResult;
  window.importCheckFindingText = riskText;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { showImportCheckResult, riskText };
  }
})();
