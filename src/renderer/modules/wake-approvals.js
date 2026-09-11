// ─── 唤醒审批控制中心（conv-core T3 · Run Center 形态）──────────────────
//
// 跨会话 pending wake 请求聚合：批准恢复派发执行、拒绝终止、跳转会话看
// 上下文——与会话内审批卡（conversation.js / interaction-hub 镜像链）等效。
// conv-core 原实现挂在旧 panel-dashboard；develop 统一 Run Center 后迁到此，
// 面板无待审批时整条隐藏。数据一次往返 p3394.listWakeRequests（cid 缺省 =
// 全量聚合）。按钮走共享 uiButton 原语（shared-ui-adoption-guard 合规）。
//
// 挂载点：index.html panel-run-center 内 #wake-approvals-strip。

(function () {
  'use strict';

  const _wakeLog = (window.__cogseedLogger && window.__cogseedLogger.for)
    ? window.__cogseedLogger.for('wake-approvals')
    : { info() {}, warn() {}, error() {} };

  function strip() { return document.getElementById('wake-approvals-strip'); }
  function listBox() { return document.getElementById('wake-approvals-list'); }

  let _lastPending = null;
  let _timer = null;
  let _loading = false;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function t(key, vars) {
    return typeof window.t === 'function' ? window.t(key, vars) : key;
  }

  // 相对时间（与原 dashboard 控制中心同口径）：秒/分/时/天，超 7 天绝对日期。
  function formatRelative(iso) {
    if (!iso) return '';
    const ts = new Date(iso).getTime();
    if (!Number.isFinite(ts)) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return '';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return t('dashboard.ago_seconds', { n: sec });
    const min = Math.floor(sec / 60);
    if (min < 60) return t('dashboard.ago_minutes', { n: min });
    const hr = Math.floor(min / 60);
    if (hr < 24) return t('dashboard.ago_hours', { n: hr });
    const day = Math.floor(hr / 24);
    if (day < 7) return t('dashboard.ago_days', { n: day });
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function rowHtml(r) {
    const id = esc(r.id);
    const cid = esc(r.conversation_id || '');
    const name = esc(r.agent_name || r.agent_id || '');
    const objective = esc(String(r.objective || '').slice(0, 160));
    const seen = esc(formatRelative(r.created_at));
    const source = esc(r.source || '');
    const decide = function (decision) {
      return (typeof window.uiButton === 'function')
        ? window.uiButton({
          label: decision === 'approve' ? t('p3394.wake.approve') : t('p3394.wake.reject'),
          role: decision === 'approve' ? 'primary' : 'secondary',
          size: 'sm',
          attrs: { 'data-wake-action': 'decide', 'data-decision': decision, 'data-request-id': id, 'data-cid': cid },
        })
        : '';
    };
    const openBtn = (typeof window.uiButton === 'function' && cid)
      ? window.uiButton({
        label: t('dashboard.control_open_conversation'),
        role: 'secondary',
        size: 'sm',
        attrs: { 'data-wake-action': 'open', 'data-cid': cid },
      })
      : '';
    return '<div class="wake-approvals-row" data-wake-row="' + id + '">'
      + '<div class="wake-approvals-row-main">'
      + '<div class="wake-approvals-row-name">' + name
      + ' <span class="wake-approvals-badge">' + esc(t('p3394.wake.status.pending')) + '</span></div>'
      + (objective ? '<div class="wake-approvals-row-sub">' + objective + '</div>' : '')
      + '<div class="wake-approvals-row-meta">'
      + (source ? '<span>' + esc(t('dashboard.control_source')) + ': ' + source + '</span>' : '')
      + (cid ? '<span>' + esc(t('dashboard.control_conversation')) + ': ' + cid + '</span>' : '')
      + (seen ? '<span>' + esc(t('dashboard.last_seen')) + ': ' + seen + '</span>' : '')
      + '</div></div>'
      + '<div class="wake-approvals-row-actions">' + decide('approve') + decide('reject') + openBtn + '</div>'
      + '</div>';
  }

  function render(pending) {
    const box = strip();
    const list = listBox();
    if (!box || !list) return;
    if (!pending || !pending.length) {
      box.hidden = true;
      list.innerHTML = '';
      return;
    }
    list.innerHTML = pending.map(rowHtml).join('');
    box.hidden = false;
  }

  async function refresh() {
    if (_loading) return;
    _loading = true;
    try {
      const res = await window.cogseed.invoke('p3394.listWakeRequests', {});
      const pending = ((res && res.requests) || []).filter(function (r) { return r && r.status === 'pending'; });
      _lastPending = pending;
      render(pending);
    } catch (err) {
      _wakeLog.warn('list wake requests failed', { error: (err && err.message) || String(err) });
    } finally {
      _loading = false;
    }
  }

  function decide(cid, requestId, decision) {
    const run = function () {
      window.cogseed.invoke('p3394.decideWakeRequest', { cid: cid, requestId: requestId, decision: decision })
        .then(function (res) {
          if (!res || !res.ok) {
            if (typeof window.uiToast === 'function') {
              window.uiToast((res && res.error && res.error.message) || t('p3394.wake.failed'));
            }
            return;
          }
          if (typeof window.uiToast === 'function') {
            window.uiToast(t(decision === 'approve' ? 'dashboard.control_decided_approve' : 'dashboard.control_decided_reject'));
          }
          void refresh();
        })
        .catch(function (err) {
          if (typeof window.uiToast === 'function') {
            window.uiToast((err && err.message) || t('p3394.wake.failed'));
          }
        });
    };
    if (decision === 'reject' && typeof window.uiConfirm === 'function') {
      window.uiConfirm({ message: t('dashboard.control_reject_confirm') }).then(function (ok) { if (ok) run(); });
    } else {
      run();
    }
  }

  function onClick(event) {
    const btn = event.target && event.target.closest ? event.target.closest('[data-wake-action]') : null;
    if (!btn) return;
    const action = btn.getAttribute('data-wake-action');
    if (action === 'open') {
      const cid = btn.getAttribute('data-cid');
      if (cid && typeof window.setView === 'function') window.setView('conversation', cid);
      return;
    }
    if (action === 'decide') {
      decide(btn.getAttribute('data-cid') || '', btn.getAttribute('data-request-id') || '', btn.getAttribute('data-decision') || '');
    }
  }

  function startPolling() {
    if (_timer) return;
    _timer = setInterval(function () {
      const box = strip();
      // 面板不可见时不轮询（hidden class 由 boot 视图切换维护）。
      if (box && !box.closest('.panel')?.classList.contains('hidden') && document.visibilityState === 'visible') {
        void refresh();
      }
    }, 30000);
  }

  function init() {
    const list = listBox();
    if (!list) return;
    list.addEventListener('click', onClick);
    window.addEventListener('i18n-change', function () { if (_lastPending) render(_lastPending); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') void refresh();
    });
    startPolling();
    void refresh();
  }

  window.refreshWakeApprovals = refresh;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
