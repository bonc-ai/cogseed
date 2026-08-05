/* Embedded reimbursement workbench. No HTTP requests are made here. */
(function () {
  'use strict';

  let runtime = null;
  let openEpoch = 0;
  let closing = Promise.resolve();

  function stateTools() {
    return window.expenseWorkbenchState || {
      createState: (seed) => ({
        page: 'assistant', pageEpoch: 0, applications: [], selectedId: '', selectedApplication: null,
        precheck: null, reviews: [], audit: [], stats: null, settings: null, feishuPreflight: null,
        assistantMessage: '', message: '', loading: false, error: null, conflict: null, recovery: null,
        progress: null, busy: {}, ...(seed || {}),
      }),
      normalizeError: (error, fallback) => ({
        code: error && error.code ? error.code : 'workbench_operation_failed',
        message: error && error.message ? error.message : fallback,
        retryable: !!(error && error.retryable),
      }),
      parseDraftText: (value) => {
        try {
          const parsed = JSON.parse(value);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, message: '草稿必须是 JSON 对象。' };
          if (!Array.isArray(parsed.expense_items) || parsed.expense_items.length === 0) return { ok: false, message: '至少填写一笔费用明细后再保存。' };
          return { ok: true, value: parsed };
        } catch (_) { return { ok: false, message: '草稿数据不是有效 JSON。' }; }
      },
    };
  }

  function setStateError(active, error, fallback) {
    const tools = stateTools();
    active.state.error = tools.normalizeError(error, fallback);
    active.state.recovery = active.state.error.retryable
      ? { code: active.state.error.code, action: 'retry', message: active.state.error.message }
      : null;
  }

  class StaleWorkbenchError extends Error {
    constructor() {
      super('报销工作台会话已关闭');
      this.name = 'StaleWorkbenchError';
    }
  }

  function markup() { return window.expenseWorkbenchMarkup; }

  function uiText(key, fallback, replacements = {}) {
    let value = markup().text(key, fallback);
    for (const [name, replacement] of Object.entries(replacements)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  }

  function isActive(active) {
    return !!active && runtime === active && !active.closed;
  }

  function assertActive(active) {
    if (!isActive(active)) throw new StaleWorkbenchError();
  }

  function invokeFor(active, channel, operation, payload) {
    if (!isActive(active)) return Promise.reject(new StaleWorkbenchError());
    return window.orkas.invoke(channel, {
      agent_id: active.agentId,
      operation,
      payload: payload || {},
    }).then((response) => {
      assertActive(active);
      if (!response || response.ok !== true) {
        const details = response && response.error && typeof response.error === 'object' ? response.error : {};
        const failure = new Error(details.message || response && response.error || uiText('invoke_failed', '报销工作台调用失败'));
        Object.assign(failure, details);
        throw failure;
      }
      return response;
    });
  }

  function invoke(operation, payload, active) {
    return invokeFor(active || runtime, 'expenseWorkbench.invoke', operation, payload);
  }

  function invokeExternal(operation, payload, active) {
    const current = active || runtime;
    if (!isActive(current)) return Promise.reject(new StaleWorkbenchError());
    return window.orkas.invoke('expenseWorkbench.invokeExternal', {
      agent_id: current.agentId,
      operation,
      payload: payload || {},
    }).then((response) => {
      assertActive(current);
      if (!response || response.ok !== true) {
        const details = response && response.error && typeof response.error === 'object' ? response.error : {};
        const failure = new Error(details.message || response && response.error || uiText('external_operation_failed', '外部系统操作未完成'));
        Object.assign(failure, details);
        throw failure;
      }
      return response;
    });
  }

  function setHeader(value, active) {
    if (active && !isActive(active)) return;
    const el = document.getElementById('ew-header-status');
    if (el) el.textContent = value;
  }

  function host() { return document.getElementById('agent-management-surface'); }

  function selectedApplication() {
    return runtime && runtime.state.selectedApplication;
  }

  function hasConfiguredProject(active) {
    return !!(active && active.projectStatus && active.projectStatus.configured === true);
  }

  function renderPage(active) {
    const current = active || runtime;
    if (!isActive(current)) return;
    const target = document.getElementById('ew-main');
    if (!target) return;
    const m = markup();
    const page = current.state.page;
    if (!hasConfiguredProject(current) && typeof m.unconfigured === 'function') target.innerHTML = m.unconfigured(current.state);
    else if (page === 'assistant') target.innerHTML = m.assistant(current.state);
    else if (page === 'applications') target.innerHTML = m.applications(current.state);
    else if (page === 'precheck') target.innerHTML = m.precheck(current.state);
    else if (page === 'overview') target.innerHTML = m.overview(current.state);
    else if (page === 'reviews') target.innerHTML = m.reviews(current.state);
    else if (page === 'connections') target.innerHTML = m.connections(current.state);
    else if (page === 'audit') target.innerHTML = m.audit(current.state);
    if (typeof target.setAttribute === 'function') target.setAttribute('aria-busy', current.state.loading ? 'true' : 'false');
    if (typeof target.dataset === 'object' && target.dataset) target.dataset.ewBusy = current.state.loading ? '1' : '0';
    const progress = document.getElementById('ew-progress');
    if (progress) {
      const visible = !!(current.state.progress && current.state.progress.message);
      progress.hidden = !visible;
      progress.textContent = visible ? current.state.progress.message : '';
      if (typeof progress.dataset === 'object' && progress.dataset) {
        progress.dataset.status = visible ? (current.state.progress.status || 'running') : '';
      }
    }
    const error = document.getElementById('ew-error');
    if (error) {
      const failure = current.state.error;
      const code = failure && failure.code ? ` [${failure.code}]` : '';
      error.hidden = !failure || !failure.message;
      error.textContent = failure && failure.message
        ? `${uiText('error_title', '操作失败')}：${failure.message}${code}`
        : '';
      if (typeof error.dataset === 'object' && error.dataset) {
        error.dataset.retryable = failure && failure.retryable ? '1' : '0';
      }
    }
    const surface = host();
    const navigationButtons = surface && typeof surface.querySelectorAll === 'function'
      ? surface.querySelectorAll('[data-ew-page]')
      : [];
    navigationButtons.forEach((button) => {
      const selected = button.dataset.ewPage === page;
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function beginRequest(active, key) {
    const serial = (active.requestSerial[key] || 0) + 1;
    active.requestSerial[key] = serial;
    return serial;
  }

  function assertCurrentRequest(active, key, serial) {
    assertActive(active);
    if (active.requestSerial[key] !== serial) throw new StaleWorkbenchError();
  }

  async function refreshApplications(selectId, active, pageSerial) {
    const current = active || runtime;
    assertActive(current);
    const serial = beginRequest(current, 'applications');
    const response = await invoke('applications.list', { limit: 100 }, current);
    assertCurrentRequest(current, 'applications', serial);
    if (pageSerial !== undefined) assertCurrentRequest(current, 'page', pageSerial);
    current.state.applications = Array.isArray(response.applications) ? response.applications : [];
    const nextId = selectId || current.state.selectedId || current.state.applications[0]?.application_id || '';
    current.state.selectedId = current.state.applications.some((item) => item.application_id === nextId) ? nextId : '';
    current.state.selectedApplication = null;
    if (current.state.selectedId) await loadApplication(current.state.selectedId, current, pageSerial);
  }

  async function loadApplication(applicationId, active, pageSerial) {
    const current = active || runtime;
    assertActive(current);
    if (!applicationId) return;
    const serial = beginRequest(current, 'application');
    current.state.selectedId = applicationId;
    const response = await invoke('applications.get', { application_id: applicationId }, current);
    assertCurrentRequest(current, 'application', serial);
    if (pageSerial !== undefined) assertCurrentRequest(current, 'page', pageSerial);
    if (current.state.selectedId !== applicationId) throw new StaleWorkbenchError();
    current.state.selectedApplication = response;
    current.state.precheck = response.unified_precheck || null;
  }

  async function loadPage(page, active) {
    const current = active || runtime;
    assertActive(current);
    current.state.loading = true;
    const serial = beginRequest(current, 'page');
    current.state.page = page;
    current.state.message = '';
    if (!hasConfiguredProject(current)) {
      current.state.loading = false;
      renderPage(current);
      setHeader(uiText('unconfigured_header', '未配置项目'), current);
      return;
    }
    renderPage(current);
    setHeader(uiText('loading', '加载中…'), current);
    try {
      if (page === 'overview') {
        const response = await invoke('overview.stats', {}, current);
        assertCurrentRequest(current, 'page', serial);
        current.state.stats = response;
      } else if (page === 'reviews') {
        const response = await invoke('reviews.list', { status: 'pending', limit: 100 }, current);
        assertCurrentRequest(current, 'page', serial);
        current.state.reviews = Array.isArray(response.reviews) ? response.reviews : [];
      } else if (page === 'connections') {
        const response = await invoke('settings.get', {}, current);
        assertCurrentRequest(current, 'page', serial);
        current.state.settings = response;
      } else if (page === 'audit') {
        const response = await invoke('audit.list', { limit: 100 }, current);
        assertCurrentRequest(current, 'page', serial);
        current.state.audit = Array.isArray(response.logs) ? response.logs : [];
      } else {
        await refreshApplications(undefined, current, serial);
        assertCurrentRequest(current, 'page', serial);
      }
      current.state.loading = false;
      current.state.error = null;
      renderPage(current);
      setHeader(current.projectStatus.configured ? uiText('configured_header', '已连接本地项目') : uiText('unconfigured_header', '未配置项目'), current);
    } catch (error) {
      if (error instanceof StaleWorkbenchError || !isActive(current)) return;
      current.state.loading = false;
      setStateError(current, error, uiText('load_failed', '加载失败'));
      current.state.message = error && error.message ? error.message : uiText('load_failed', '加载失败');
      renderPage(current);
      setHeader(uiText('needs_attention', '需要检查'), current);
    }
  }

  async function configureProject() {
    const active = runtime;
    if (!active) return;
    const response = await window.orkas.invoke('expenseWorkbench.pickAndConfigure', {
      agent_id: active.agentId,
    });
    assertActive(active);
    if (!response || response.ok !== true) throw new Error(response && response.error ? response.error : uiText('configure_failed', '项目配置失败'));
    if (response.cancelled) return;
    active.projectStatus = response.configured === true ? response : { configured: false };
    const banner = document.getElementById('ew-config-banner');
    if (banner) banner.hidden = !hasConfiguredProject(active);
    if (!hasConfiguredProject(active)) {
      renderPage(active);
      setHeader(uiText('unconfigured_header', '未配置项目'), active);
      return;
    }
    await loadPage(active.state.page, active);
  }

  async function createApplication() {
    const active = runtime;
    assertActive(active);
    const select = document.getElementById('ew-application-type');
    const response = await invoke('applications.create', { application_type: select ? select.value : 'daily_expense' }, active);
    active.state.selectedApplication = response;
    active.state.selectedId = response.application?.application_id || '';
    await refreshApplications(active.state.selectedId, active);
    renderPage(active);
  }

  async function saveDraft() {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    if (!selected || !selected.application) return;
    const editor = document.getElementById('ew-draft-json');
    const parsed = stateTools().parseDraftText(editor ? editor.value : '{}');
    if (!parsed.ok) throw new Error(parsed.message || markup().text('draft_invalid_json', '草稿数据无效。'));
    const payload = parsed.value;
    const draft = selected.draft || {};
    const response = await invoke('applications.draft', {
      application_id: selected.application.application_id,
      expected_version: Number(selected.application.current_version || 0),
      draft: payload,
      material_refs: Array.isArray(draft.material_refs) ? draft.material_refs : [],
      material_categories: draft.material_categories || {},
      review_reasons: Array.isArray(draft.review_reasons) ? draft.review_reasons : [],
    }, active);
    active.state.selectedApplication = response;
    active.state.message = uiText('draft_saved', '草稿已保存为新版本。');
    await refreshApplications(selected.application.application_id, active);
    renderPage(active);
  }

  async function addMaterials() {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    if (!selected || !selected.application) return;
    const response = await window.orkas.invoke('expenseWorkbench.pickAndAddMaterials', {
      agent_id: active.agentId,
      application_id: selected.application.application_id,
    });
    assertActive(active);
    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : markup().text('material_add_failed', '材料登记失败'));
    }
    if (response.cancelled) return;
    const refs = Array.isArray(response.materials) ? response.materials : [];
    const failed = Array.isArray(response.failed) ? response.failed : [];
    const failureDetails = failed
      .map((item) => `${String(item && item.name || uiText('material_unnamed', '未命名材料'))}: ${String(item && item.error || uiText('material_add_failed', '登记失败'))}`)
      .join('; ');
    active.state.message = failed.length
      ? uiText('materials_partial', '{registered} 项材料已登记，{failed} 项未登记：{details}', { registered: refs.length, failed: failed.length, details: failureDetails })
      : uiText('materials_added', '{count} 项材料已登记并绑定到新的草稿版本。', { count: refs.length });
    if (response.application) active.state.selectedApplication = response.application;
    await refreshApplications(selected.application.application_id, active);
    renderPage(active);
  }

  async function runPrecheck() {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    if (!selected || !selected.application) return;
    const response = await invoke('applications.precheck', { application_id: selected.application.application_id }, active);
    active.state.precheck = response;
    active.state.assistantMessage = response.status === 'ready'
      ? uiText('precheck_ready_message', '当前版本预审通过，可以进入显式确认。')
      : uiText('precheck_review_message', '预审完成，仍有项目需要人工复核。');
    await loadApplication(selected.application.application_id, active);
    renderPage(active);
  }

  async function decideApplication(decision, role) {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    const app = selected && selected.application;
    const approval = selected && selected.approval;
    if (!app || !approval || !approval.can_decide || !approval.artifact_hash || !role) return;
    const comment = typeof window.prompt === 'function'
      ? (window.prompt(
        decision === 'approve'
          ? markup().text('approval_comment_prompt', '审批意见（可选）')
          : markup().text('approval_reject_prompt', '驳回原因（必填）'),
        '',
      ) || '')
      : '';
    if (decision === 'reject' && !comment.trim()) {
      throw new Error(markup().text('approval_reject_required', '驳回必须填写原因'));
    }
    const response = await window.orkas.invoke('expenseWorkbench.approveApplication', {
      agent_id: active.agentId,
      application_id: app.application_id,
      approval_role: role,
      decision,
      expected_artifact_hash: approval.artifact_hash,
      comment,
    });
    assertActive(active);
    if (!response || response.ok === false) {
      throw new Error(response && response.error ? response.error : markup().text('approval_failed', '人员审批未完成'));
    }
    active.state.message = decision === 'approve'
      ? markup().text('approval_recorded', '人员审批已记录。')
      : markup().text('approval_rejected', '人员审批已驳回。');
    await loadApplication(app.application_id, active);
    renderPage(active);
  }

  async function assistantAction(action) {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    if (!selected || !selected.application) return;
    const response = await invoke(action === 'precheck' ? 'assistant.propose' : 'assistant.inspect', {
      application_id: selected.application.application_id,
      command: action === 'precheck' ? uiText('assistant_precheck_command', '同步材料并执行预审') : uiText('assistant_inspect_command', '检查当前申请'),
    }, active);
    active.state.assistantMessage = response.message || uiText('assistant_completed', '已完成当前申请检查。');
    if (response.precheck) active.state.precheck = response.precheck;
    await loadApplication(selected.application.application_id, active);
    renderPage(active);
  }

  async function confirmAndSubmit() {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    const app = selected && selected.application;
    if (!app) return;
    const confirmed = typeof uiConfirm === 'function'
      ? await uiConfirm({
        message: markup().text('submit_confirm', '将把当前版本 v{version} 提交到飞书审批。提交后由飞书中的人工审批人处理，是否继续？').replace('{version}', String(app.current_version || 0)),
        okLabel: markup().text('submit_confirm_ok', '确认提交'),
        cancelLabel: markup().text('submit_confirm_cancel', '取消'),
      })
      : window.confirm(markup().text('submit_confirm_short', '提交当前版本到飞书审批？'));
    assertActive(active);
    if (!confirmed) return;
    setHeader(uiText('submitting', '提交中…'), active);
    const response = await window.orkas.invoke('expenseWorkbench.confirmAndSubmit', {
      agent_id: active.agentId,
      application_id: app.application_id,
      version: Number(app.current_version || 0),
      payload_hash: String(app.current_payload_hash || ''),
    });
    assertActive(active);
    if (!response || response.ok !== true) throw new Error(response && response.error ? response.error : markup().text('submit_failed', '飞书提交失败'));
    active.state.selectedApplication = response.submitted || response.confirmed || selected;
    active.state.message = response.submitted && response.submitted.application && response.submitted.application.oa_status === 'submitted'
      ? markup().text('submitted_waiting', '已提交到飞书，等待人工审批。')
      : markup().text('confirmed_refresh', '已完成确认，提交状态需要刷新。');
    await refreshApplications(app.application_id, active);
    renderPage(active);
    setHeader(uiText('submitted_header', '已提交飞书审批'), active);
  }

  async function refreshFeishuStatus() {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    const app = selected && selected.application;
    if (!app || !app.external_application_id) return;
    setHeader(markup().text('refreshing_header', '正在刷新飞书审批状态…'), active);
    const response = await invokeExternal('applications.submitStatus', {
      application_id: app.application_id,
    }, active);
    active.state.selectedApplication = response;
    active.state.message = markup().text('status_refreshed', '飞书审批状态已刷新。');
    await refreshApplications(app.application_id, active);
    renderPage(active);
    setHeader(markup().text('status_refreshed_header', '飞书审批状态已更新'), active);
  }

  async function runExternalApplicationOperation(operation, progress, success) {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    const app = selected && selected.application;
    if (!app) return;
    setHeader(progress, active);
    const response = await invokeExternal(operation, { application_id: app.application_id }, active);
    active.state.selectedApplication = response;
    active.state.message = success;
    await refreshApplications(app.application_id, active);
    renderPage(active);
    setHeader(success, active);
  }

  async function runLocked(active, key, operation) {
    assertActive(active);
    if (active.inFlight.has(key)) return;
    active.inFlight.add(key);
    active.state.error = null;
    active.state.conflict = null;
    active.state.recovery = null;
    const tools = stateTools();
    if (typeof tools.setBusy === 'function') tools.setBusy(active.state, key, true);
    if (typeof tools.setProgress === 'function') {
      tools.setProgress(active.state, key, markup().text(`progress_${key}`, '正在处理当前操作…'), 'running');
    }
    renderPage(active);
    try {
      await operation();
    } finally {
      active.inFlight.delete(key);
      if (typeof tools.setBusy === 'function') tools.setBusy(active.state, key, false);
      if (typeof tools.setProgress === 'function') tools.setProgress(active.state, null, null, null);
      if (isActive(active)) renderPage(active);
    }
  }

  async function handleClick(event) {
    const target = event.target.closest('[data-ew-page],[data-ew-close],[data-ew-configure],[data-ew-create],[data-ew-refresh],[data-ew-application],[data-ew-save-draft],[data-ew-add-material],[data-ew-precheck],[data-ew-report],[data-ew-formal-report],[data-ew-submit],[data-ew-submit-status],[data-ew-recover-submission],[data-ew-retry-feishu],[data-ew-retry-feishu-notifications],[data-ew-approve],[data-ew-assistant],[data-ew-settings-test]');
    if (!target || !runtime) return;
    const active = runtime;
    try {
      if (target.hasAttribute('data-ew-close')) { closeExpenseWorkbench(); return; }
      if (target.hasAttribute('data-ew-configure')) { await runLocked(active, 'configure', configureProject); return; }
      if (target.dataset.ewPage) { await loadPage(target.dataset.ewPage, active); return; }
      if (!hasConfiguredProject(active)) {
        renderPage(active);
        setHeader(uiText('unconfigured_header', '未配置项目'), active);
        return;
      }
      if (target.dataset.ewApplication) { await loadApplication(target.dataset.ewApplication, active); renderPage(active); return; }
      if (target.hasAttribute('data-ew-create')) { await runLocked(active, 'create', createApplication); return; }
      if (target.hasAttribute('data-ew-refresh')) { await loadPage(active.state.page, active); return; }
      if (target.dataset.ewSaveDraft !== undefined) { await runLocked(active, 'save', saveDraft); return; }
      if (target.dataset.ewAddMaterial !== undefined) { await runLocked(active, 'materials', addMaterials); return; }
      if (target.dataset.ewPrecheck !== undefined) { await runLocked(active, 'precheck', runPrecheck); return; }
      if (target.dataset.ewReport !== undefined) {
        await runLocked(active, 'report', async () => {
          const selected = selectedApplication();
          if (selected && selected.application) {
            const report = await invoke('applications.report', { application_id: selected.application.application_id, mode: 'draft' }, active);
            active.state.message = report.status === 'draft'
              ? uiText('draft_report_generated', '草稿报告已生成。')
              : uiText('report_completed', '报告操作完成。');
            renderPage(active);
          }
        });
        return;
      }
      if (target.dataset.ewFormalReport !== undefined) {
        await runLocked(active, 'formal-report', async () => {
          const selected = selectedApplication();
          if (selected && selected.application) {
            const report = await invoke('applications.report', { application_id: selected.application.application_id, mode: 'formal' }, active);
            active.state.message = report.status === 'formal'
              ? markup().text('formal_report_generated', '正式报告已生成。')
              : markup().text('formal_report_blocked', '正式报告未生成：{status}').replace('{status}', report.status || markup().text('gate_blocked', '闸门未通过'));
            renderPage(active);
          }
        });
        return;
      }
      if (target.dataset.ewApprove) {
        const role = target.dataset.ewApprovalRole || '';
        await runLocked(active, `approval-${role}`, () => decideApplication(target.dataset.ewApprove, role));
        return;
      }
      if (target.dataset.ewSubmit !== undefined) { await runLocked(active, 'submit', confirmAndSubmit); return; }
      if (target.dataset.ewSubmitStatus !== undefined) { await runLocked(active, 'submit-status', refreshFeishuStatus); return; }
      if (target.dataset.ewRecoverSubmission !== undefined) {
        await runLocked(active, 'recover-submission', () => runExternalApplicationOperation(
          'applications.recoverSubmission',
          markup().text('recovering_submission', '正在访问 OA 并恢复提交结果…'),
          markup().text('submission_recovered', 'OA 提交结果已恢复。'),
        ));
        return;
      }
      if (target.dataset.ewRetryFeishu !== undefined) {
        await runLocked(active, 'retry-feishu', () => runExternalApplicationOperation(
          'applications.retryFeishu',
          markup().text('retrying_feishu', '正在重试向飞书发送数据…'),
          markup().text('feishu_retried', '飞书同步重试已执行。'),
        ));
        return;
      }
      if (target.dataset.ewRetryFeishuNotifications !== undefined) {
        await runLocked(active, 'retry-feishu-notifications', () => runExternalApplicationOperation(
          'applications.retryFeishuNotifications',
          markup().text('retrying_feishu_notifications', '正在重试发送飞书通知…'),
          markup().text('feishu_notifications_retried', '飞书通知重试已执行。'),
        ));
        return;
      }
      if (target.dataset.ewAssistant) { await runLocked(active, 'assistant', () => assistantAction(target.dataset.ewAssistant)); return; }
      if (target.hasAttribute('data-ew-settings-test')) {
        await runLocked(active, 'settings-preflight', async () => {
          const response = await invokeExternal('settings.preflight', {}, active);
          active.state.feishuPreflight = response;
          active.state.message = response.status === 'ready' ? markup().text('preflight_ready', '飞书预检通过。') : `${markup().text('preflight_status', '飞书预检状态：')}${response.status || 'unknown'}`;
          renderPage(active);
        });
      }
    } catch (error) {
      if (error instanceof StaleWorkbenchError || !isActive(active)) return;
      setStateError(active, error, uiText('operation_failed', '操作失败'));
      active.state.message = error && error.message ? error.message : uiText('operation_failed', '操作失败');
      renderPage(active);
    }
  }

  function closeExpenseWorkbench() {
    if (!runtime) return;
    const current = runtime;
    current.closed = true;
    runtime = null;
    const target = host();
    if (target) {
      target.hidden = true;
      target.innerHTML = '';
      target.onclick = null;
    }
    const detail = document.getElementById('agents-detail-content');
    if (detail) detail.style.display = current.detailDisplay || '';
    const chat = document.getElementById('agents-chat-col');
    if (chat) chat.style.display = current.chatDisplay || 'none';
    const closeRequest = window.orkas.invoke('expenseWorkbench.close', {}).catch(() => {});
    closing = Promise.allSettled([closing, closeRequest]).then(() => undefined);
  }

  async function openExpenseWorkbench(agentId) {
    if (!agentId) return;
    if (runtime) closeExpenseWorkbench();
    await closing;
    const target = host();
    if (!target) return;
    const detail = document.getElementById('agents-detail-content');
    const chat = document.getElementById('agents-chat-col');
    const active = {
      epoch: ++openEpoch,
      agentId,
      state: stateTools().createState({ page: 'assistant' }),
      detailDisplay: detail ? detail.style.display : '',
      chatDisplay: chat ? chat.style.display : 'none',
      projectStatus: { configured: false },
      requestSerial: Object.create(null),
      inFlight: new Set(),
      closed: false,
    };
    runtime = active;
    if (detail) detail.style.display = 'none';
    if (chat) chat.style.display = 'none';
    target.hidden = false;
    target.innerHTML = markup().shell((typeof _selectedAgent !== 'undefined' && _selectedAgent) ? _selectedAgent.name : '报销智能体');
    target.onclick = handleClick;
    try {
      const status = await window.orkas.invoke('expenseWorkbench.status', {});
      assertActive(active);
      active.projectStatus = status && status.ok ? status : { configured: false };
      const banner = document.getElementById('ew-config-banner');
      if (banner) banner.hidden = !!active.projectStatus.configured;
      if (active.projectStatus.configured) await loadPage('assistant', active);
      else { renderPage(active); setHeader(uiText('unconfigured_header', '未配置项目'), active); }
    } catch (error) {
      if (error instanceof StaleWorkbenchError || !isActive(active)) return;
      setStateError(active, error, uiText('status_failed', '无法读取项目配置'));
      active.state.message = error && error.message ? error.message : uiText('status_failed', '无法读取项目配置');
      const banner = document.getElementById('ew-config-banner');
      if (banner) banner.hidden = false;
      renderPage(active);
      setHeader(uiText('configure_required', '需要配置'), active);
    }
  }

  window.openExpenseWorkbench = openExpenseWorkbench;
  window.closeExpenseWorkbench = closeExpenseWorkbench;
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('i18n-change', () => {
      if (runtime && !runtime.closed) renderPage(runtime);
    });
  }
}());
