/* Embedded reimbursement workbench. No HTTP requests are made here. */
(function () {
  'use strict';

  let runtime = null;
  let openEpoch = 0;
  let closing = Promise.resolve();

  class StaleWorkbenchError extends Error {
    constructor() {
      super('报销工作台会话已关闭');
      this.name = 'StaleWorkbenchError';
    }
  }

  function markup() { return window.expenseWorkbenchMarkup; }

  function isActive(active) {
    return !!active && runtime === active && !active.closed;
  }

  function assertActive(active) {
    if (!isActive(active)) throw new StaleWorkbenchError();
  }

  function invokeFor(active, operation, payload) {
    if (!isActive(active)) return Promise.reject(new StaleWorkbenchError());
    return window.orkas.expenseWorkbench.invoke(operation, payload || {}).then((response) => {
      assertActive(active);
      if (!response || response.ok !== true) throw new Error(response && response.error ? response.error : '报销工作台调用失败');
      return response;
    });
  }

  function invoke(operation, payload, active) {
    return invokeFor(active || runtime, operation, payload);
  }

  function invokeExternal(operation, payload, active) {
    const current = active || runtime;
    if (!isActive(current)) return Promise.reject(new StaleWorkbenchError());
    return window.orkas.expenseWorkbench.invokeExternal(operation, payload || {}).then((response) => {
      assertActive(current);
      if (!response || response.ok !== true) throw new Error(response && response.error ? response.error : '外部系统操作未完成');
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

  function renderPage(active) {
    const current = active || runtime;
    if (!isActive(current)) return;
    const target = document.getElementById('ew-main');
    if (!target) return;
    const m = markup();
    const page = current.state.page;
    if (page === 'assistant') target.innerHTML = m.assistant(current.state);
    else if (page === 'applications') target.innerHTML = m.applications(current.state);
    else if (page === 'precheck') target.innerHTML = m.precheck(current.state);
    else if (page === 'overview') target.innerHTML = m.overview(current.state);
    else if (page === 'reviews') target.innerHTML = m.reviews(current.state);
    else if (page === 'connections') target.innerHTML = m.connections(current.state);
    else if (page === 'audit') target.innerHTML = m.audit(current.state);
    target.querySelectorAll('[data-ew-page]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.ewPage === page);
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
    const serial = beginRequest(current, 'page');
    current.state.page = page;
    current.state.message = '';
    renderPage(current);
    setHeader('加载中…', current);
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
      renderPage(current);
      setHeader(current.projectStatus.configured ? '已连接本地项目' : '未配置项目', current);
    } catch (error) {
      if (error instanceof StaleWorkbenchError || !isActive(current)) return;
      current.state.message = error && error.message ? error.message : '加载失败';
      renderPage(current);
      setHeader('需要检查', current);
    }
  }

  async function configureProject() {
    const active = runtime;
    if (!active) return;
    const response = await window.orkas.expenseWorkbench.configure();
    assertActive(active);
    if (!response || response.ok !== true) throw new Error(response && response.error ? response.error : '项目配置失败');
    if (response.cancelled) return;
    active.projectStatus = response;
    const banner = document.getElementById('ew-config-banner');
    if (banner) banner.hidden = true;
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
    let payload;
    try { payload = JSON.parse(editor ? editor.value : '{}'); }
    catch (_) { throw new Error('草稿数据不是有效 JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('草稿必须是 JSON 对象');
    if (!Array.isArray(payload.expense_items) || payload.expense_items.length === 0) {
      throw new Error(markup().text('draft_missing_items', '至少填写一笔费用明细后再保存。'));
    }
    if (payload.expense_items.some((item) => (
      !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0
    ))) {
      throw new Error(markup().text('draft_invalid_amount', '每笔费用明细都必须包含大于 0 的金额。'));
    }
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
    active.state.message = '草稿已保存为新版本。';
    await refreshApplications(selected.application.application_id, active);
    renderPage(active);
  }

  async function addMaterials() {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    if (!selected || !selected.application) return;
    const response = await window.orkas.expenseWorkbench.pickAndAddMaterials(
      selected.application.application_id,
    );
    assertActive(active);
    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : markup().text('material_add_failed', '材料登记失败'));
    }
    if (response.cancelled) return;
    const refs = Array.isArray(response.materials) ? response.materials : [];
    const failed = Array.isArray(response.failed) ? response.failed : [];
    const failureDetails = failed
      .map((item) => `${String(item && item.name || markup().text('material_unnamed', '未命名材料'))}：${String(item && item.error || markup().text('material_add_failed', '登记失败'))}`)
      .join('；');
    active.state.message = failed.length
      ? `${refs.length} 项材料已登记，${failed.length} 项未登记。${failureDetails}`
      : `${refs.length} 项材料已登记并绑定到新的草稿版本。`;
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
    active.state.assistantMessage = response.status === 'ready' ? '当前版本预审通过，可以进入显式确认。' : '预审完成，仍有项目需要人工复核。';
    await loadApplication(selected.application.application_id, active);
    renderPage(active);
  }

  async function assistantAction(action) {
    const active = runtime;
    assertActive(active);
    const selected = selectedApplication();
    if (!selected || !selected.application) return;
    const response = await invoke(action === 'precheck' ? 'assistant.propose' : 'assistant.inspect', {
      application_id: selected.application.application_id,
      command: action === 'precheck' ? '同步材料并执行预审' : '检查当前申请',
    }, active);
    active.state.assistantMessage = response.message || '已完成当前申请检查。';
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
    setHeader('提交中…', active);
    const response = await window.orkas.expenseWorkbench.confirmAndSubmit(
      app.application_id,
      Number(app.current_version || 0),
      String(app.current_payload_hash || ''),
    );
    assertActive(active);
    if (!response || response.ok !== true) throw new Error(response && response.error ? response.error : markup().text('submit_failed', '飞书提交失败'));
    active.state.selectedApplication = response.submitted || response.confirmed || selected;
    active.state.message = response.submitted && response.submitted.application && response.submitted.application.oa_status === 'submitted'
      ? markup().text('submitted_waiting', '已提交到飞书，等待人工审批。')
      : markup().text('confirmed_refresh', '已完成确认，提交状态需要刷新。');
    await refreshApplications(app.application_id, active);
    renderPage(active);
    setHeader(markup().text('submitted_header', '已提交飞书审批'), active);
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
    try {
      await operation();
    } finally {
      active.inFlight.delete(key);
    }
  }

  async function handleClick(event) {
    const target = event.target.closest('[data-ew-page],[data-ew-close],[data-ew-configure],[data-ew-create],[data-ew-refresh],[data-ew-application],[data-ew-save-draft],[data-ew-add-material],[data-ew-precheck],[data-ew-report],[data-ew-submit],[data-ew-submit-status],[data-ew-recover-submission],[data-ew-retry-feishu],[data-ew-assistant],[data-ew-settings-test]');
    if (!target || !runtime) return;
    const active = runtime;
    try {
      if (target.hasAttribute('data-ew-close')) { closeExpenseWorkbench(); return; }
      if (target.hasAttribute('data-ew-configure')) { await runLocked(active, 'configure', configureProject); return; }
      if (target.dataset.ewPage) { await loadPage(target.dataset.ewPage, active); return; }
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
            active.state.message = report.status === 'draft' ? '草稿报告已生成。' : '报告操作完成。';
            renderPage(active);
          }
        });
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
      active.state.message = error && error.message ? error.message : '操作失败';
      renderPage(active);
    }
  }

  function closeExpenseWorkbench() {
    if (!runtime) {
      const closeRequest = window.orkas.expenseWorkbench.close().catch(() => {});
      closing = Promise.allSettled([closing, closeRequest]).then(() => undefined);
      return;
    }
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
    const closeRequest = window.orkas.expenseWorkbench.close().catch(() => {});
    closing = Promise.allSettled([closing, closeRequest]).then(() => undefined);
  }

  async function openExpenseWorkbench(agentId, openGesture, preparedOpen = false) {
    if (!agentId) return;
    if (openGesture !== 'agent_card' && openGesture !== 'agent_detail') {
      throw new Error('报销工作台必须由用户点击受信任入口打开');
    }
    if (!preparedOpen) await window.orkas.expenseWorkbench.prepareOpen(agentId, openGesture);
    if (runtime) closeExpenseWorkbench();
    await closing;
    const target = host();
    if (!target) {
      await window.orkas.expenseWorkbench.close().catch(() => {});
      throw new Error('报销工作台管理容器不存在');
    }
    const detail = document.getElementById('agents-detail-content');
    const chat = document.getElementById('agents-chat-col');
    const active = {
      epoch: ++openEpoch,
      agentId,
      state: { page: 'assistant', applications: [], selectedId: '', selectedApplication: null, precheck: null, reviews: [], audit: [], stats: null, settings: null, feishuPreflight: null, assistantMessage: '', message: '' },
      detailDisplay: detail ? detail.style.display : '',
      chatDisplay: chat ? chat.style.display : 'none',
      projectStatus: { configured: false },
      requestSerial: Object.create(null),
      inFlight: new Set(),
      closed: false,
    };
    let hostOpened = false;
    try {
      runtime = active;
      if (detail) detail.style.display = 'none';
      if (chat) chat.style.display = 'none';
      target.hidden = false;
      target.innerHTML = markup().shell((typeof _selectedAgent !== 'undefined' && _selectedAgent) ? _selectedAgent.name : '报销智能体');
      target.onclick = handleClick;
      await window.orkas.expenseWorkbench.open(agentId);
      hostOpened = true;
      assertActive(active);
      const status = await window.orkas.expenseWorkbench.status();
      assertActive(active);
      active.projectStatus = status && status.ok ? status : { configured: false };
      const banner = document.getElementById('ew-config-banner');
      if (banner) banner.hidden = !!active.projectStatus.configured;
      if (active.projectStatus.configured) await loadPage('assistant', active);
      else { renderPage(active); setHeader('未配置项目', active); }
    } catch (error) {
      if (!hostOpened) {
        if (isActive(active)) closeExpenseWorkbench();
        else await window.orkas.expenseWorkbench.close().catch(() => {});
        await closing;
        throw error;
      }
      if (error instanceof StaleWorkbenchError || !isActive(active)) return;
      active.state.message = error && error.message ? error.message : '无法读取项目配置';
      const banner = document.getElementById('ew-config-banner');
      if (banner) banner.hidden = false;
      renderPage(active);
      setHeader('需要配置', active);
    }
  }

  window.openExpenseWorkbench = openExpenseWorkbench;
  window.closeExpenseWorkbench = closeExpenseWorkbench;
}());
