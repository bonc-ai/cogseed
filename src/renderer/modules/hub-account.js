// ─── Hub 账号设置区块 ────────────────────────────────────────────────────
// Settings › 账号 tab. Renders the desktop-side Hub account management
// surface: sign-in state, device list, consent list, sign-out and account
// deletion. Talks to the Hub account service through the `hub-account.*`
// IPC handlers; token material never crosses the IPC boundary (status DTOs
// only).

const _hubLog = createLogger('hub-account:settings');

/** Render a UI icon by name (single source: modules/icons.js — no emoji). */
function _icon(name, className) {
  const html = window.uiIconHtml ? window.uiIconHtml(name, className) : '';
  return html || `<span class="${className || 'ui-icon'}"></span>`;
}

/** Friendly device name: strip hostname noise and unknown placeholders. */
function _friendlyDeviceName(dev) {
  const raw = dev.device_name || dev.device_id || '';
  if (!raw || /unknown/i.test(raw)) return '';
  // MacBook-Pro-6.local -> MacBook Pro
  return raw
    .replace(/\.local$/, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

  if (status.release_enabled === false) {
    card.innerHTML = `
      <div class="settings-section-head">${_escapeHtml(t('hub.account.title'))}</div>
      <div class="settings-empty">${_escapeHtml(t('hub.account.release_gate_closed'))}</div>
    `;
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
    ? `<div class="hub-alert" role="status">${_icon('info', 'hub-alert-icon')}${_escapeHtml(t('hub.account.hub_unreachable'))}</div>`
    : '';
  const features = [
    ['cloud_sync', 'cloud'],
    ['publish', 'globe'],
    ['backup', 'shield-check'],
    ['devices', 'monitor'],
  ].map(([key, iconName]) => `
    <div class="hub-feature-card">
      <span class="hub-feature-icon">${_icon(iconName)}</span>
      <span class="hub-feature-title">${_escapeHtml(t(`hub.account.feature_${key}`))}</span>
      <span class="hub-feature-desc">${_escapeHtml(t(`hub.account.feature_${key}_desc`))}</span>
    </div>`).join('');

  return `
    <div class="hub-hero">
      <div class="hub-hero-badge">${_escapeHtml(t('hub.account.title'))}</div>
      <h3 class="hub-hero-title">${_escapeHtml(t('hub.account.signed_out_title'))}</h3>
      <p class="hub-hero-desc">${_escapeHtml(t('hub.account.signed_out_desc'))}</p>
      ${unreachable}
      <button type="button" class="btn btn-primary hub-hero-cta" id="hub-account-sign-in" data-i18n="hub.account.sign_in">${_escapeHtml(t('hub.account.sign_in'))}</button>
    </div>

    <div class="settings-section-head">${_escapeHtml(t('hub.account.local_section'))}</div>
    <div class="hub-card hub-card-row">
      <span class="hub-card-icon">${_icon('hard-drive')}</span>
      <div class="hub-card-body">
        <span class="hub-card-title">${_escapeHtml(t('hub.account.local_mode'))}</span>
        <span class="hub-card-desc">${_escapeHtml(t('hub.account.local_mode_desc'))}</span>
      </div>
    </div>

    <div class="settings-section-head">${_escapeHtml(t('hub.account.features_section'))}</div>
    <div class="hub-feature-grid">${features}</div>
  `;
}

function _signedInCard(status, devices, consents) {
  const deviceRows = devices.map((dev) => {
    const current = dev.is_current
      ? `<span class="hub-chip hub-chip-current">${_escapeHtml(t('hub.account.device_current'))}</span>`
      : '';
    const revoke = dev.is_current
      ? ''
      : `<button type="button" class="hub-btn-mini" data-hub-revoke-device="${_escapeHtml(dev.device_id)}">${_icon('trash-2', 'hub-btn-icon')}${_escapeHtml(t('hub.account.revoke'))}</button>`;
    const name = _friendlyDeviceName(dev) || _maskId(dev.device_id || '');
    const os = (dev.device_os || '').replace(/\bunknown\b/gi, '').trim();
    const meta = [os, _formatTime(dev.last_seen_at)].filter(Boolean).join(' · ');
    return `
      <div class="hub-device-row">
        <span class="hub-device-icon">${_icon('monitor')}</span>
        <div class="hub-device-body">
          <span class="hub-device-name">${_escapeHtml(name)}${current}</span>
          ${meta ? `<span class="hub-device-meta">${_escapeHtml(meta)}</span>` : ''}
        </div>
        ${revoke}
      </div>
    `;
  }).join('') || `<div class="hub-card-empty">${_icon('monitor', 'hub-empty-icon')}${_escapeHtml(t('hub.account.devices_empty'))}</div>`;

  const consentRows = consents.map((c) => {
    const action = c.granted
      ? `<button type="button" class="hub-btn-mini" data-hub-consent="${_escapeHtml(c.scope)}" data-hub-consent-action="revoke">${_icon('x-circle', 'hub-btn-icon')}${_escapeHtml(t('hub.account.consent_revoke'))}</button>`
      : `<button type="button" class="hub-btn-mini hub-btn-mini-ghost" data-hub-consent="${_escapeHtml(c.scope)}" data-hub-consent-action="grant">${_icon('check-circle', 'hub-btn-icon')}${_escapeHtml(t('hub.account.consent_grant'))}</button>`;
    const state = c.granted ? `<span class="hub-chip hub-chip-on">${_icon('check-circle', 'hub-chip-icon')}${_escapeHtml(t('hub.account.consent_granted'))}</span>` : `<span class="hub-chip hub-chip-off">${_escapeHtml(t('hub.account.consent_revoked'))}</span>`;
    return `
      <div class="hub-consent-row">
        <span class="hub-consent-scope">${_escapeHtml(c.scope)}</span>
        ${state}
        ${action}
      </div>
    `;
  }).join('') || `<div class="hub-card-empty">${_icon('shield', 'hub-empty-icon')}${_escapeHtml(t('hub.account.consents_empty'))}</div>`;

  return `
    <div class="hub-hero hub-hero-compact">
      <div class="hub-hero-badge hub-hero-badge-on">${_icon('check-circle', 'hub-hero-badge-icon')}${_escapeHtml(t('hub.account.signed_in_title'))}</div>
      <div class="hub-account-line">
        <span class="hub-account-avatar">${_icon('user')}</span>
        <div class="hub-account-id">
          <span class="hub-account-id-value">${_escapeHtml(_maskId(status.account_id || ''))}</span>
          <span class="hub-account-id-sub">${status.bound ? _icon('shield-check', 'hub-id-sub-icon') : ''}${status.bound ? _escapeHtml(t('hub.account.bound_local')) : _escapeHtml(t('hub.account.not_bound'))}</span>
        </div>
      </div>
      <p class="hub-hero-desc">${_escapeHtml(t('hub.account.signed_in_desc'))}</p>
    </div>

    <div class="settings-section-head">${_escapeHtml(t('hub.account.devices'))}</div>
    <div class="hub-card hub-card-list">${deviceRows}</div>

    <div class="settings-section-head">${_escapeHtml(t('hub.account.consents'))}</div>
    <div class="hub-card hub-card-list">${consentRows}</div>

    <div class="hub-actions">
      <button type="button" class="btn btn-sm" id="hub-account-sign-out">${_icon('log-out', 'hub-btn-icon')}${_escapeHtml(t('hub.account.sign_out'))}</button>
      <button type="button" class="btn btn-sm btn-danger" id="hub-account-delete">${_icon('trash-2', 'hub-btn-icon')}${_escapeHtml(t('hub.account.delete_account'))}</button>
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
