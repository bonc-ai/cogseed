// ─── 应用中心（T2b，Tutti 式应用中心）──────────────────────────────────
// 人与智能体共用的能力单元：AI 画图（direct 直连，不经 LLM）+ 文档/PPT/
// 表格（agent_task：任务模板驱动群聊智能体，工具已注入）。产物落工作
// 空间，可经渠道回传（channel-bridge 文件投递）——飞书里发消息让智能
// 体出产物再收文件，同样走这些应用能力。
// 懒加载入口：boot.js setView('apps') → _loadViewFeature('apps')。
// i18n：所有文案走 t(key[, vars])；键缺失回显键名。切换语言重渲染。

(function () {
  'use strict';

  const _appsLog = (window.__cogseedLogger?.for?.('app-center')) || console;

  function el(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let _lastData = null;

  async function fetchAppsData() {
    const res = await window.cogseed.invoke('apps.list', {}).catch(() => null);
    return {
      apps: (res && res.apps) || [],
      availability: (res && res.availability) || {},
    };
  }

  function renderAppCard(app) {
    const avail = _lastData.availability[app.id] || { available: false };
    const badge = avail.available
      ? `<span class="dash-badge dash-badge-on">${esc(t('apps.status_ready'))}</span>`
      : `<span class="dash-badge dash-badge-off">${esc(t(avail.reasonKey || 'apps.unavailable_office'))}</span>`;
    return `<div class="dash-row-wrap">
      <div class="dash-row" role="button" tabindex="0" data-apps-action="run" data-app-id="${esc(app.id)}" data-app-kind="${esc(app.kind)}" ${avail.available ? '' : 'aria-disabled="true"'}>
        <div class="dash-row-main">
          <div class="dash-row-name"><span class="apps-card-icon">${esc(app.icon)}</span> ${esc(t(app.nameKey))}${badge}</div>
          <div class="dash-row-sub">${esc(t(app.descKey))}</div>
        </div>
        <div class="dash-row-actions"><button type="button" class="btn btn-sm" data-apps-action="run" data-app-id="${esc(app.id)}" data-app-kind="${esc(app.kind)}" ${avail.available ? '' : 'disabled'}>${esc(t('apps.run'))}</button></div>
      </div>
    </div>`;
  }

  function render(data) {
    _lastData = data;
    const box = el('apps-list');
    if (!box) return;
    if (!data.apps.length) {
      box.innerHTML = `<div class="dash-empty">${esc(t('apps.empty'))}</div>`;
      return;
    }
    box.innerHTML = data.apps.map(renderAppCard).join('');
    const hint = el('apps-agent-hint');
    if (hint) hint.textContent = t('apps.agent_hint');
  }

  async function refresh() {
    try {
      render(await fetchAppsData());
    } catch (err) {
      _appsLog.warn?.('app center refresh failed', { error: (err && err.message) || String(err) });
    }
  }

  // ── 运行对话框 ──
  // direct（AI 画图）：表单填 prompt → apps.runImage → 产物预览。
  // agent_task（文档三件套）：目标描述 → 新建任务会话发模板消息
  //（群聊智能体调 create_docx/pptx/xlsx 完成，产物与审批走现有链路）。
  function openRunDialog(app) {
    const overlay = el('apps-run-overlay');
    const dialog = el('apps-run-dialog');
    if (!overlay || !dialog) return;
    const isImage = app.kind === 'direct';
    dialog.innerHTML = `
      <div class="dash-section-head"><h3>${esc(app.icon)} ${esc(t(app.nameKey))}</h3></div>
      <div class="dash-row-sub" style="margin-bottom:10px">${esc(t(app.descKey))}</div>
      <textarea id="apps-run-input" rows="4" placeholder="${esc(t(isImage ? 'apps.input_placeholder_image' : 'apps.input_placeholder_doc'))}"></textarea>
      <div class="apps-run-actions">
        <button type="button" class="btn btn-sm" id="apps-run-cancel">${esc(t('apps.cancel'))}</button>
        <button type="button" class="btn btn-primary btn-sm" id="apps-run-submit">${esc(t('apps.run'))}</button>
      </div>
      <div class="dash-form-status" id="apps-run-status"></div>
      <div id="apps-run-result"></div>`;
    overlay.hidden = false;
    const input = el('apps-run-input');
    if (input) input.focus();
    const close = () => { overlay.hidden = true; };
    el('apps-run-cancel')?.addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    el('apps-run-submit')?.addEventListener('click', async () => {
      const goal = String(input?.value || '').trim();
      const status = el('apps-run-status');
      const setStatus = (kind, text) => { if (status) { status.textContent = text; status.className = `dash-form-status ${kind}`; } };
      if (!goal) { setStatus('err', t('apps.goal_required')); return; }
      const submitBtn = el('apps-run-submit');
      if (submitBtn) submitBtn.disabled = true;
      try {
        if (isImage) {
          setStatus('pending', t('apps.image_running'));
          const res = await window.cogseed.invoke('apps.runImage', { prompt: goal });
          if (!res || !res.ok) {
            setStatus('err', (res && res.error) || t('apps.image_failed'));
            return;
          }
          setStatus('ok', t('apps.image_done', { path: res.path }));
          const result = el('apps-run-result');
          if (result) result.innerHTML = `<img class="apps-image-preview" src="${esc('file://' + res.path)}" alt="${esc(goal.slice(0, 60))}">`;
        } else {
          // agent_task：渲染层组装模板消息，经主进程注册表校验后走
          // 现有"新建任务会话"链路（conversation 模块的全局入口）。
          const res = await window.cogseed.invoke('apps.taskMessage', { appId: app.id, goal });
          if (!res || !res.ok || !res.message) {
            setStatus('err', (res && res.error) || 'apps.goal_required');
            return;
          }
          close();
          if (typeof window.startAppTaskConversation === 'function') {
            window.startAppTaskConversation(res.message);
          } else {
            if (typeof uiToast === 'function') uiToast(t('apps.task_copy_fallback'));
            // 兜底：复制到剪贴板，用户粘贴到新建任务
            try { await navigator.clipboard.writeText(res.message); } catch { /* clipboard may be denied */ }
          }
        }
      } catch (err) {
        setStatus('err', (err && err.message) || String(err));
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  function onAppsClick(event) {
    const target = event.target.closest('[data-apps-action]');
    if (!target) return;
    if (target.getAttribute('aria-disabled') === 'true' || target.disabled) return;
    const appId = target.dataset.appId;
    const app = (_lastData?.apps || []).find((a) => a.id === appId);
    if (!app) return;
    if (target.dataset.appsAction === 'run') openRunDialog(app);
  }

  function renderAppCenter() {
    const panel = el('panel-apps');
    if (!panel) return;
    if (!panel.dataset.wired) {
      panel.dataset.wired = '1';
      panel.addEventListener('click', onAppsClick);
      const refreshBtn = el('apps-refresh-btn');
      if (refreshBtn) refreshBtn.addEventListener('click', () => refresh());
      window.addEventListener('i18n-change', () => { if (_lastData) render(_lastData); });
    }
    refresh();
  }

  // 应用任务 → 新建任务会话：切到 new-chat 视图、预填模板消息并触发
  // 发送，复用现有"新建任务"全链路（会话创建/智能体路由/产物审批）。
  window.startAppTaskConversation = (message) => {
    if (typeof window.setView === 'function') window.setView('new-chat');
    const input = document.getElementById('new-chat-input');
    if (!input) return false;
    input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => {
      const btn = document.getElementById('new-chat-send-btn');
      if (btn && !btn.disabled) btn.click();
    }, 120);
    return true;
  };

  window.renderAppCenter = renderAppCenter;
})();
