// ─── Hub 账号设置区块 ────────────────────────────────────────────────────
// Settings › 账号 tab. Renders the desktop-side Hub account management
// surface: sign-in state, device list, consent list, sign-out and account
// deletion. Talks to the Hub account service through the `hub-account.*`
// IPC handlers; token material never crosses the IPC boundary (status DTOs
// only).

const _hubLog = createLogger('hub-account:settings');

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Mask long ids for display (e.g. cogseed_acc_abc123 → cogseed_acc_***123). */
function _maskId(id) {
  if (!id) return '';
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}***${id.slice(-4)}`;
}

function _formatTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function _invoke(channel, payload) {
  const res = await window.cogseed.invoke(channel, payload || {});
  if (!res || !res.ok) {
    throw new Error((res && (res.error || res.code)) || `${channel} failed`);
  }
  return res;
}

async function _hubStatus() {
  const res = await _invoke('hub-account.status');
  return res.status;
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

async function _renderHubAccount() {
  const card = document.getElementById('hub-account-card');
  if (!card) return;
  let status = null;
  try {
    status = await _hubStatus();
  } catch (err) {
    _hubLog.warn('hub account status refresh failed', { error: (err && err.message) || String(err) });
  }

  if (!status) {
    card.innerHTML = `<div class="settings-empty">${_escapeHtml(t('hub.account.unavailable'))}</div>`;
    return;
  }

  if (!status.signed_in) {
    card.innerHTML = _signedOutCard(status);
    _bindSignIn(card);
    return;
  }

  let devices = [];
  let consents = [];
  if (status.signed_in) {
    try {
      const d = await _invoke('hub-account.devices');
      devices = d.devices || [];
    } catch (err) {
      _hubLog.warn('hub devices refresh failed', { error: (err && err.message) || String(err) });
    }
    try {
      const c = await _invoke('hub-account.consents');
      consents = c.consents || [];
    } catch (err) {
      _hubLog.warn('hub consents refresh failed', { error: (err && err.message) || String(err) });
    }
  }

  card.innerHTML = _signedInCard(status, devices, consents);
  _bindSignedIn(card);
}

function _signedOutCard(status) {
  const unreachable = status.hub_reachable === false
    ? `<div class="settings-row"><span class="settings-hint" role="status">${_escapeHtml(t('hub.account.hub_unreachable'))}</span></div>`
    : '';
  return `
    <div class="settings-section-head">${_escapeHtml(t('hub.account.title'))}</div>
    <div class="settings-group-head">
      <div class="settings-group-title">${_escapeHtml(t('hub.account.signed_out_title'))}</div>
      <div class="settings-group-sub">${_escapeHtml(t('hub.account.signed_out_desc'))}</div>
    </div>
    ${unreachable}
    <div class="settings-row">
      <button type="button" class="btn btn-primary" id="hub-account-sign-in" data-i18n="hub.account.sign_in">${_escapeHtml(t('hub.account.sign_in'))}</button>
    </div>
  `;
}

function _signedInCard(status, devices, consents) {
  const deviceRows = devices.map((dev) => {
    const current = dev.is_current ? ` <span class="settings-chip">${_escapeHtml(t('hub.account.device_current'))}</span>` : '';
    const revoke = dev.is_current
      ? ''
      : `<button type="button" class="btn btn-sm" data-hub-revoke-device="${_escapeHtml(dev.device_id)}">${_escapeHtml(t('hub.account.revoke'))}</button>`;
    return `
      <div class="settings-row">
        <span>${_escapeHtml(dev.device_name || dev.device_id)}${current}</span>
        <span class="settings-hint">${_escapeHtml(dev.device_os || '')} · ${_escapeHtml(_formatTime(dev.last_seen_at))}</span>
        ${revoke}
      </div>
    `;
  }).join('');

  const consentRows = consents.map((c) => {
    const action = c.granted
      ? `<button type="button" class="btn btn-sm" data-hub-consent="${_escapeHtml(c.scope)}" data-hub-consent-action="revoke">${_escapeHtml(t('hub.account.consent_revoke'))}</button>`
      : `<button type="button" class="btn btn-sm" data-hub-consent="${_escapeHtml(c.scope)}" data-hub-consent-action="grant">${_escapeHtml(t('hub.account.consent_grant'))}</button>`;
    return `
      <div class="settings-row">
        <span>${_escapeHtml(c.scope)}</span>
        <span class="settings-hint">${c.granted ? _escapeHtml(t('hub.account.consent_granted')) : _escapeHtml(t('hub.account.consent_revoked'))}</span>
        ${action}
      </div>
    `;
  }).join('') || `<div class="settings-row"><span class="settings-hint">${_escapeHtml(t('hub.account.consents_empty'))}</span></div>`;

  return `
    <div class="settings-section-head">${_escapeHtml(t('hub.account.title'))}</div>
    <div class="settings-group-head">
      <div class="settings-group-title">${_escapeHtml(t('hub.account.signed_in_title'))}</div>
      <div class="settings-group-sub">${_escapeHtml(t('hub.account.signed_in_desc'))}</div>
    </div>
    <div class="settings-row">
      <span>${_escapeHtml(t('hub.account.account_id'))} ${_escapeHtml(_maskId(status.account_id || ''))}</span>
      <span class="settings-hint">${status.bound ? _escapeHtml(t('hub.account.bound_local')) : _escapeHtml(t('hub.account.not_bound'))}</span>
    </div>

    <div class="settings-section-head">${_escapeHtml(t('hub.account.devices'))}</div>
    ${deviceRows || `<div class="settings-row"><span class="settings-hint">${_escapeHtml(t('hub.account.devices_empty'))}</span></div>`}

    <div class="settings-section-head">${_escapeHtml(t('hub.account.consents'))}</div>
    ${consentRows}

    <div class="settings-row settings-actions">
      <button type="button" class="btn btn-sm" id="hub-account-sign-out">${_escapeHtml(t('hub.account.sign_out'))}</button>
      <button type="button" class="btn btn-sm btn-danger" id="hub-account-delete">${_escapeHtml(t('hub.account.delete_account'))}</button>
    </div>
  `;
}

// ── 交互 ─────────────────────────────────────────────────────────────────

function _bindSignIn(card) {
  const btn = card.querySelector('#hub-account-sign-in');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = t('hub.account.signing_in');
    try {
      await _invoke('hub-account.start_login');
      // Browser flow: the deep link callback completes the login; keep the
      // button disabled until the status refresh reflects it.
      window.setTimeout(() => { btn.disabled = false; btn.textContent = t('hub.account.sign_in'); void _renderHubAccount(); }, 800);
    } catch (err) {
      _hubLog.warn('hub sign-in start failed', { error: (err && err.message) || String(err) });
      btn.disabled = false;
      btn.textContent = t('hub.account.sign_in');
      window.alert((err && err.message) || t('hub.account.error_start'));
    }
  });
}

function _bindSignedIn(card) {
  const signOut = card.querySelector('#hub-account-sign-out');
  if (signOut) {
    signOut.addEventListener('click', async () => {
      if (!window.confirm(t('hub.account.sign_out_confirm'))) return;
      try {
        await _invoke('hub-account.logout');
        await _renderHubAccount();
      } catch (err) {
        _hubLog.warn('hub sign-out failed', { error: (err && err.message) || String(err) });
        window.alert((err && err.message) || t('hub.account.error_sign_out'));
      }
    });
  }

  const del = card.querySelector('#hub-account-delete');
  if (del) {
    del.addEventListener('click', async () => {
      const confirmation = window.prompt(t('hub.account.delete_confirm_prompt'));
      if (!confirmation) return;
      if (confirmation.trim() !== 'DELETE_MY_ACCOUNT') {
        window.alert(t('hub.account.delete_confirm_mismatch'));
        return;
      }
      if (!window.confirm(t('hub.account.delete_confirm_final'))) return;
      try {
        await _invoke('hub-account.delete_account', { confirmation: 'DELETE_MY_ACCOUNT' });
        window.alert(t('hub.account.delete_scheduled'));
        await _renderHubAccount();
      } catch (err) {
        _hubLog.warn('hub account deletion failed', { error: (err && err.message) || String(err) });
        window.alert((err && err.message) || t('hub.account.error_delete'));
      }
    });
  }

  card.querySelectorAll('[data-hub-revoke-device]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const deviceId = btn.dataset.hubRevokeDevice;
      if (!deviceId || !window.confirm(t('hub.account.revoke_confirm'))) return;
      try {
        await _invoke('hub-account.revoke_device', { device_id: deviceId });
        await _renderHubAccount();
      } catch (err) {
        _hubLog.warn('hub device revoke failed', { error: (err && err.message) || String(err) });
        window.alert((err && err.message) || t('hub.account.error_revoke'));
      }
    });
  });

  card.querySelectorAll('[data-hub-consent]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const scope = btn.dataset.hubConsent;
      const action = btn.dataset.hubConsentAction;
      if (!scope) return;
      try {
        if (action === 'revoke') await _invoke('hub-account.revoke_consent', { scope });
        else await _invoke('hub-account.set_consent', { scope });
        await _renderHubAccount();
      } catch (err) {
        _hubLog.warn('hub consent update failed', { error: (err && err.message) || String(err) });
        window.alert((err && err.message) || t('hub.account.error_consent'));
      }
    });
  });
}

// 登录成功后（deep link 回调完成），设置页再次刷新状态。
window.addEventListener('focus', () => {
  const pane = document.querySelector('.settings-tab-pane[data-settings-pane="account"]');
  if (pane && !pane.hidden) void _renderHubAccount();
});
window.addEventListener('i18n-change', () => {
  const pane = document.querySelector('.settings-tab-pane[data-settings-pane="account"]');
  if (pane && !pane.hidden) void _renderHubAccount();
});

window.initHubAccountSettings = _renderHubAccount;
