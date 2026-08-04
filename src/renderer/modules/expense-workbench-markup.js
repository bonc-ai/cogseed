/* Classic-script templates for the reimbursement management surface. */
(function () {
  'use strict';

  function text(key, fallback) {
    try {
      const value = typeof t === 'function' ? t(`expense_workbench.${key}`) : '';
      return value && value !== `expense_workbench.${key}` ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function escape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const pages = [
    ['assistant', 'assistant', 'sparkles'],
    ['applications', 'applications', 'file-text'],
    ['precheck', 'precheck', 'clipboard-list'],
    ['overview', 'overview', 'layout-grid'],
    ['reviews', 'reviews', 'check-circle'],
    ['connections', 'connections', 'settings'],
    ['audit', 'audit', 'list'],
  ];

  function icon(name) {
    try { return typeof uiIconHtml === 'function' ? uiIconHtml(name, 'ew-icon') : ''; }
    catch (_) { return ''; }
  }

  function shell(agentName) {
    const nav = pages.map(([id, key, iconName], index) => `
      <button type="button" class="ew-nav-item${index === 0 ? ' is-active' : ''}" data-ew-page="${id}">
        ${icon(iconName)}<span>${escape(text(`nav_${key}`, key))}</span>
      </button>`).join('');
    return `<section class="expense-workbench" aria-label="${escape(text('title', '报销智能体'))}">
      <header class="ew-header">
        <div class="ew-heading">
          <button type="button" class="btn btn-sm ew-close" data-ew-close>${escape(text('back', '返回 Agent'))}</button>
          <div><span class="ew-kicker">${escape(text('kicker', 'EXPENSE WORKBENCH'))}</span><h1>${escape(agentName || text('title', '报销智能体'))}</h1></div>
        </div>
        <div class="ew-header-status" id="ew-header-status" aria-live="polite">${escape(text('loading', '加载中…'))}</div>
      </header>
      <div class="ew-config-banner" id="ew-config-banner" hidden>
        <div><strong>${escape(text('configure_title', '验证本地报销组件'))}</strong><span>${escape(text('configure_hint', '选择报销项目目录。Mate 只执行固定发布归档解出的受信 Python 和完整校验后的私有缓存，不执行项目解释器或网页服务。'))}</span></div>
        <button type="button" class="btn btn-primary btn-sm" data-ew-configure>${escape(text('configure', '选择并验证项目'))}</button>
      </div>
      <div class="ew-layout">
        <nav class="ew-nav" aria-label="${escape(text('nav_label', '报销工作区'))}">${nav}</nav>
        <main class="ew-main" id="ew-main" tabindex="-1"></main>
      </div>
    </section>`;
  }

  function empty(title, hint) {
    return `<div class="ew-empty"><strong>${escape(title)}</strong><span>${escape(hint)}</span></div>`;
  }

  function status(value) {
    const clean = String(value || 'collecting');
    return `<span class="ew-status ew-status-${escape(clean.replace(/[^a-z0-9_-]/gi, '-'))}">${escape(clean)}</span>`;
  }

  function applicationRows(applications, selectedId) {
    if (!applications.length) return empty(text('no_applications', '暂无报销申请'), text('no_applications_hint', '在这里创建第一笔本地报销申请。'));
    return applications.map((application) => {
      const id = application.application_id || '';
      return `<button type="button" class="ew-application-row${id === selectedId ? ' is-selected' : ''}" data-ew-application="${escape(id)}">
        <span class="ew-row-title">${escape(application.application_type_label || application.application_type || text('application', '报销申请'))}</span>
        ${status(application.precheck_status)}<code>${escape(id)}</code>
      </button>`;
    }).join('');
  }

  function assistant(state) {
    const selected = state.selectedApplication;
    const app = selected && selected.application;
    return `<div class="ew-page ew-assistant-page">
      <div class="ew-page-intro"><div><span class="ew-kicker">${escape(text('nav_assistant', '报销助手'))}</span><h2>${escape(text('assistant_heading', '把材料、草稿与预审结论放在同一案件'))}</h2></div><button type="button" class="btn btn-primary" data-ew-create>${escape(text('create_application', '新建报销申请'))}</button></div>
      <div class="ew-assistant-grid">
        <aside class="ew-panel ew-case-list"><div class="ew-panel-head"><strong>${escape(text('recent_cases', '近期案件'))}</strong><button type="button" class="btn btn-ghost btn-sm" data-ew-refresh>${escape(text('refresh', '刷新'))}</button></div><div class="ew-list">${applicationRows(state.applications, app && app.application_id)}</div></aside>
        <section class="ew-panel ew-assistant-main"><div class="ew-panel-head"><div><strong>${escape(app ? app.application_type_label || text('application', '报销申请') : text('start_case', '开始一笔报销'))}</strong><span>${escape(app ? app.application_id : text('start_case_hint', '建立申请后在这里执行助手动作'))}</span></div>${app ? status(app.precheck_status) : ''}</div>
          <div class="ew-assistant-log" id="ew-assistant-log">${state.assistantMessage ? `<p>${escape(state.assistantMessage)}</p>` : empty(text('assistant_empty', '从一笔真实报销开始'), text('assistant_empty_hint', '助手只会调用当前申请的受控预审操作。'))}</div>
          <div class="ew-command-row">${app ? `<button type="button" class="btn btn-secondary" data-ew-assistant="inspect">${escape(text('inspect', '检查当前申请'))}</button><button type="button" class="btn btn-secondary" data-ew-assistant="precheck">${escape(text('run_precheck', '同步材料并预审'))}</button>` : ''}</div>
        </section>
        <aside class="ew-panel ew-context"><div class="ew-panel-head"><strong>${escape(text('case_context', '案件概览'))}</strong></div>${app ? `<dl class="ew-facts"><div><dt>${escape(text('version', '当前版本'))}</dt><dd>v${escape(app.current_version || 0)}</dd></div><div><dt>${escape(text('confirmation', '显式确认'))}</dt><dd>${escape(app.confirmation_status || '-')}</dd></div><div><dt>${escape(text('oa', '外部审批'))}</dt><dd>${escape(app.oa_status || '-')}</dd></div></dl>` : empty(text('no_case', '尚未选择案件'), text('no_case_hint', '选择或创建一笔申请。'))}</aside>
      </div>
    </div>`;
  }

  function applications(state) {
    const selected = state.selectedApplication;
    const app = selected && selected.application;
    const draft = selected && selected.draft;
    const payload = draft && draft.payload ? JSON.stringify(draft.payload, null, 2) : '{\n  "expense_items": []\n}';
    const precheck = state.precheck || (selected && selected.unified_precheck) || {};
    const target = app && app.target ? app.target : {};
    const canSubmitToFeishu = !!app
      && app.oa_status === 'not_submitted'
      && (precheck.status === 'ready' || app.precheck_status === 'ready_for_confirmation')
      && target.adapter === 'feishu-approval'
      && target.environment === 'feishu';
    const canRefreshFeishu = !!app && !!app.external_application_id;
    const canRecoverSubmission = !!app
      && !app.external_application_id
      && app.oa_status === 'submission_unknown';
    const canRetryFeishu = !!app
      && (app.feishu_status === 'sync_failed'
        || (selected && selected.feishu_outbox && selected.feishu_outbox.state === 'failed'));
    return `<div class="ew-page ew-applications-page"><div class="ew-page-intro"><div><span class="ew-kicker">${escape(text('nav_applications', '报销申请'))}</span><h2>${escape(text('applications_heading', '申请生命周期'))}</h2></div><div class="ew-inline-actions"><select id="ew-application-type"><option value="daily_expense">${escape(text('daily_expense', '日常费用报销'))}</option><option value="travel_expense">${escape(text('travel_expense', '差旅费报销'))}</option><option value="rental_expense">${escape(text('rental_expense', '房租费报销'))}</option><option value="communication_expense">${escape(text('communication_expense', '通讯费报销'))}</option></select><button type="button" class="btn btn-primary" data-ew-create>${escape(text('create', '新建'))}</button></div></div>
      <div class="ew-application-layout"><aside class="ew-panel ew-case-list"><div class="ew-panel-head"><strong>${escape(text('all_applications', '全部申请'))}</strong><span>${state.applications.length}</span></div><div class="ew-list">${applicationRows(state.applications, app && app.application_id)}</div></aside>
      <section class="ew-panel ew-application-detail">${app ? `<div class="ew-panel-head"><div><strong>${escape(app.application_type_label || text('application', '报销申请'))}</strong><code>${escape(app.application_id)}</code></div>${status(app.precheck_status)}</div><div class="ew-summary-grid"><div><span>${escape(text('version', '当前版本'))}</span><strong>v${escape(app.current_version || 0)}</strong></div><div><span>${escape(text('hash', '草稿哈希'))}</span><code>${escape((app.current_payload_hash || '').slice(0, 12) || '-')}</code></div><div><span>${escape(text('oa', '外部审批'))}</span><strong>${escape(app.oa_status || '-')}</strong></div></div><label class="ew-field"><span>${escape(text('draft_json', '草稿数据 JSON'))}</span><textarea id="ew-draft-json" rows="14" spellcheck="false">${escape(payload)}</textarea></label><div class="ew-material-toolbar"><strong>${escape(text('materials', '材料'))}</strong><span>${escape(String((draft && draft.material_refs || []).length))}</span><button type="button" class="btn btn-secondary btn-sm" data-ew-add-material>${escape(text('add_material', '添加材料'))}</button></div><div class="ew-material-list">${(draft && draft.material_refs || []).map((item) => `<span>${escape(item.name || item.ref)}</span>`).join('') || `<em>${escape(text('no_materials', '尚未绑定材料'))}</em>`}</div><div class="ew-action-row"><button type="button" class="btn btn-primary" data-ew-save-draft>${escape(text('save_draft', '保存草稿'))}</button><button type="button" class="btn btn-secondary" data-ew-precheck>${escape(text('run_precheck', '执行预审'))}</button><button type="button" class="btn btn-secondary" data-ew-report>${escape(text('draft_report', '生成草稿报告'))}</button>${canSubmitToFeishu ? `<button type="button" class="btn btn-primary" data-ew-submit>${escape(text('submit_feishu', '确认并提交飞书审批'))}</button>` : ''}${canRefreshFeishu ? `<button type="button" class="btn btn-secondary" data-ew-submit-status>${escape(text('refresh_feishu_status', '访问飞书 / OA 并刷新审批状态'))}</button>` : ''}${canRecoverSubmission ? `<button type="button" class="btn btn-secondary" data-ew-recover-submission>${escape(text('recover_submission', '二次确认并恢复 OA 提交结果'))}</button>` : ''}${canRetryFeishu ? `<button type="button" class="btn btn-secondary" data-ew-retry-feishu>${escape(text('retry_feishu', '二次确认并重试飞书同步'))}</button>` : ''}</div><div class="ew-message" id="ew-application-message" aria-live="polite">${escape(state.message || '')}</div>` : empty(text('select_application', '选择或新建一笔申请'), text('select_application_hint', '申请资料、材料和版本控制会在这里显示。'))}</section></div></div>`;
  }

  function precheck(state) {
    const app = state.selectedApplication && state.selectedApplication.application;
    const result = state.precheck;
    return `<div class="ew-page"><div class="ew-page-intro"><div><span class="ew-kicker">${escape(text('nav_precheck', '预审会话'))}</span><h2>${escape(text('precheck_heading', '基于当前不可变版本执行预审'))}</h2></div>${app ? `<button type="button" class="btn btn-primary" data-ew-precheck>${escape(text('run_precheck', '执行预审'))}</button>` : ''}</div>${app ? `<section class="ew-panel ew-result-panel"><div class="ew-panel-head"><div><strong>${escape(app.application_id)}</strong><span>v${escape(app.current_version || 0)}</span></div>${status(result && result.status || app.precheck_status)}</div>${result ? `<dl class="ew-facts"><div><dt>${escape(text('result_status', '结果'))}</dt><dd>${escape(result.status || '-')}</dd></div><div><dt>${escape(text('policy', '规则版本'))}</dt><dd>${escape(result.policy_version || '-')}</dd></div><div><dt>${escape(text('reason_codes', '原因'))}</dt><dd>${escape((result.reason_codes || []).join('、') || text('none', '无'))}</dd></div></dl>` : empty(text('not_run', '尚未执行预审'), text('预审会读取当前草稿和材料清单。'))}</section>` : empty(text('select_application', '先选择一笔申请'), text('预审结果绑定到申请版本，不会写回聊天记录。'))}</div>`;
  }

  function overview(state) {
    const stats = state.stats || { total_applications: 0, status_counts: {} };
    const counts = Object.entries(stats.status_counts || {}).map(([key, value]) => `<div class="ew-stat"><span>${escape(key)}</span><strong>${escape(value)}</strong></div>`).join('');
    return `<div class="ew-page"><div class="ew-page-intro"><div><span class="ew-kicker">${escape(text('nav_overview', '工作台'))}</span><h2>${escape(text('overview_heading', '案件与预审概览'))}</h2></div><button type="button" class="btn btn-secondary" data-ew-refresh>${escape(text('refresh', '刷新'))}</button></div><div class="ew-stat-grid"><div class="ew-stat ew-stat-primary"><span>${escape(text('total_applications', '申请总数'))}</span><strong>${escape(stats.total_applications || 0)}</strong></div>${counts || `<div class="ew-stat"><span>${escape(text('no_data', '暂无状态数据'))}</span></div>`}</div></div>`;
  }

  function reviews(state) {
    const rows = state.reviews || [];
    return `<div class="ew-page"><div class="ew-page-intro"><div><span class="ew-kicker">${escape(text('nav_reviews', '人工复核'))}</span><h2>${escape(text('reviews_heading', '等待人工判断的任务'))}</h2></div><button type="button" class="btn btn-secondary" data-ew-refresh>${escape(text('refresh', '刷新'))}</button></div><section class="ew-panel ew-table-panel">${rows.length ? `<table><thead><tr><th>${escape(text('review_task', '任务'))}</th><th>${escape(text('review_status', '状态'))}</th><th>${escape(text('review_reason', '触发原因'))}</th></tr></thead><tbody>${rows.map((row) => `<tr><td><code>${escape(row.task_id)}</code></td><td>${status(row.status)}</td><td>${escape(row.trigger_reason || '-')}</td></tr>`).join('')}</tbody></table>` : empty(text('no_reviews', '暂无待复核任务'), text('预审产生的人工判断会显示在这里。'))}</section></div>`;
  }

  function connections(state) {
    const config = state.settings || {};
    const preflight = state.feishuPreflight || {};
    const errors = Array.isArray(preflight.error_codes) ? preflight.error_codes.join('、') : '';
    return `<div class="ew-page"><div class="ew-page-intro"><div><span class="ew-kicker">${escape(text('nav_connections', '连接配置'))}</span><h2>${escape(text('connections_heading', '外部连接状态'))}</h2></div><button type="button" class="btn btn-secondary" data-ew-settings-test>${escape(text('test_connection', '允许访问飞书并检查连接'))}</button></div><section class="ew-panel ew-settings-panel"><div class="ew-message">${escape(text('connection_external_notice', '打开本页只读取本地配置，不会联网。点击上方按钮后，Mate 会先显示确认框，确认后才访问飞书的租户身份、审批模板和权限接口。'))}</div><div class="ew-setting-row"><span>${escape(text('project_connection', '本地报销项目'))}</span><strong>${config.configured ? escape(text('configured', '已配置')) : escape(text('not_configured', '未配置'))}</strong></div><div class="ew-setting-row"><span>${escape(text('credential_connection', '凭据'))}</span><strong>${config.configured ? escape(text('managed', '由项目管理')) : '-'}</strong></div><div class="ew-setting-row"><span>${escape(text('feishu_preflight', '飞书预检'))}</span><strong>${escape(preflight.status || text('not_tested', '尚未测试'))}</strong></div>${errors ? `<div class="ew-message">${escape(errors)}</div>` : ''}<div class="ew-message" id="ew-settings-message" aria-live="polite">${escape(state.message || '')}</div></section></div>`;
  }

  function audit(state) {
    const rows = state.audit || [];
    return `<div class="ew-page"><div class="ew-page-intro"><div><span class="ew-kicker">${escape(text('nav_audit', '审计记录'))}</span><h2>${escape(text('audit_heading', '可追溯操作记录'))}</h2></div><button type="button" class="btn btn-secondary" data-ew-refresh>${escape(text('refresh', '刷新'))}</button></div><section class="ew-panel ew-table-panel">${rows.length ? `<table><thead><tr><th>${escape(text('audit_time', '时间'))}</th><th>${escape(text('audit_action', '动作'))}</th><th>${escape(text('audit_target', '对象'))}</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escape(row.created_at || row.timestamp || '-')}</td><td>${escape(row.action || row.event || '-')}</td><td><code>${escape(row.session_id || row.application_id || '-')}</code></td></tr>`).join('')}</tbody></table>` : empty(text('no_audit', '暂无审计记录'), text('完成一次操作后会在这里保留可追溯记录。'))}</section></div>`;
  }

  window.expenseWorkbenchMarkup = { shell, assistant, applications, precheck, overview, reviews, connections, audit, text, escape };
}());
