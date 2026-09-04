// Unified Runtime action approval dialog. Requests are main-process owned;
// this module only renders the supplied summary and returns an opaque verdict.
(function initActionApproval(root) {
  'use strict';

  const queue = [];
  let showing = false;
  const log = typeof root.createLogger === 'function' ? root.createLogger('action-approval') : { warn() {} };

  function tr(key, fallback, vars) {
    try {
      const value = root.t(key, vars || {});
      return value && value !== key ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function text(value, fallback) {
    const normalized = String(value == null ? '' : value).trim();
    return normalized || fallback;
  }

  function reasonText(reasons) {
    const values = Array.isArray(reasons) ? reasons : [];
    const labels = values.map((reason) => tr(`action_approval.reason.${reason}`, String(reason)));
    return labels.filter(Boolean).join(tr('action_approval.reason_sep', '、')) || tr('action_approval.reason.default', '该操作可能影响本机或外部服务');
  }

  function expiryText(raw) {
    const date = new Date(String(raw || ''));
    if (Number.isNaN(date.getTime())) return tr('action_approval.expiry_unknown', '本次请求会自动失效');
    return new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(date);
  }

  function detailRow(label, value, className) {
    return `<div class="action-approval-detail${className ? ` ${className}` : ''}">
      <dt>${escapeText(label)}</dt>
      <dd>${escapeText(value)}</dd>
    </div>`;
  }

  async function showRequest(info) {
    const actor = text(info.actor, tr('action_approval.actor_fallback', 'CogSeed Agent'));
    const target = text(info.target, tr('action_approval.target_unknown', '未提供执行目标'));
    const scope = text(info.scope, tr('action_approval.scope_unknown', '仅限本次明确操作'));
    const risk = info.risk === 'critical' ? 'critical' : 'high';
    const riskLabel = tr(`action_approval.risk.${risk}`, risk === 'critical' ? '高危' : '需要确认');
    const bodyHtml = `<dl class="action-approval-details">
      ${detailRow(tr('action_approval.field.actor', '执行主体'), actor)}
      ${detailRow(tr('action_approval.field.target', '目标'), target, 'is-target')}
      ${detailRow(tr('action_approval.field.scope', '权限范围'), scope)}
      ${detailRow(tr('action_approval.field.risk', '风险'), `${riskLabel}：${reasonText(info.reasons)}`, `is-risk is-${risk}`)}
      ${detailRow(tr('action_approval.field.expiry', '授权有效期'), tr('action_approval.expiry_at', '请在 {time} 前决定；批准仅用于这一次执行。', { time: expiryText(info.expires_at) }))}
    </dl>`;
    if (typeof root.uiModal !== 'function') return 'deny';
    const modal = root.uiModal({
      title: tr('action_approval.title', '需要你的批准'),
      description: tr('action_approval.description', '请核对以下执行范围。拒绝或超时后，该操作不会执行。'),
      bodyHtml,
      size: 'md',
      dismissible: false,
      tone: risk === 'critical' ? 'danger' : undefined,
      actions: [
        { id: 'deny', label: tr('action_approval.deny', '拒绝'), role: 'danger' },
        { id: 'approve', label: tr('action_approval.approve_once', '仅批准这一次'), role: 'primary', icon: 'check' },
      ],
    });
    const onI18nChange = () => modal.close('rerender', 'i18n-change');
    root.addEventListener('i18n-change', onI18nChange);
    const result = await modal;
    root.removeEventListener('i18n-change', onI18nChange);
    if (result && result.reason === 'i18n-change') return showRequest(info);
    return result && result.value === 'approve' ? 'approve' : 'deny';
  }

  async function drain() {
    if (showing) return;
    showing = true;
    try {
      while (queue.length) {
        const info = queue.shift();
        const decision = await showRequest(info);
        try {
          await root.cogseed.invoke('actionApproval.respond', {
            request_id: info.request_id,
            decision,
          });
        } catch (error) {
          log.warn('approval response failed', { error: error && error.message });
        }
      }
    } finally {
      showing = false;
    }
  }

  if (root.cogseed && typeof root.cogseed.onPushEvent === 'function') {
    try {
      root.cogseed.onPushEvent('action-approval:request', (info) => {
        if (!info || typeof info.request_id !== 'string' || !info.request_id) return;
        queue.push(info);
        void drain();
      });
    } catch (error) {
      log.warn('approval listener registration failed', { error: error && error.message });
    }
  }
})(window);
