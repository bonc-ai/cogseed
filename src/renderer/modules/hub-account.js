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
  // P3394 DEVICE-05：设备名缺失时不回落到 device_id 等内部标识——用户看到的
  // 永远是可理解的名称（缺失时由调用方给通用占位名）。
  const raw = dev.device_name || '';
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
    const err = new Error((res && (res.error || res.code)) || `${channel} failed`);
    err.code = (res && res.code) || '';
    throw err;
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
    // 注销流程进行中：状态刷新失败也不打断流程（切窗口后焦点刷新的重渲染）。
    if (_deletionCtx) { _renderDeletion(card); return; }
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
    // 真实登出/注销（会话已失效）：丢弃进行中的注销流程，呈现未登录态。
    _stopDeletionCountdown();
    _deletionCtx = null;
    card.innerHTML = _signedOutCard(status);
    _bindSignIn(card);
    return;
  }

  // 注销流程进行中：保留当前步骤与已填内容，不重建为普通账号卡。
  // 窗口切换/焦点恢复、i18n 切换、状态广播等触发的重渲染都会走到这里。
  if (_deletionCtx) { _renderDeletion(card); return; }

  let devices = [];
  let consents = [];
  let displayName = null;
  let loginId = null;
  let phoneMasked = null;
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
    try {
      const m = await _invoke('hub-account.me');
      const acct = m.me && m.me.account;
      displayName = (acct && acct.community_profile && acct.community_profile.display_name) || null;
      // CogSeed ID + 掩码手机号（服务端只下发掩码，PHONE-06）。
      loginId = (acct && acct.login_id) || null;
      phoneMasked = (acct && acct.phone && acct.phone.masked) || null;
    } catch (err) {
      // 装饰信息（昵称 / CogSeed ID / 手机号）失败时静默回退到脱敏 ID。
      _hubLog.warn('hub me refresh failed (identity metadata unavailable)', { error: (err && err.message) || String(err) });
    }
  }

  card.innerHTML = _signedInCard(status, devices, consents, displayName, loginId, phoneMasked);
  _bindSignedIn(card, { phoneMasked });
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
    <div class="hub-hero hub-hero-signedout">
      <div class="hub-hero-mark">${_icon('user', 'hub-hero-mark-icon')}</div>
      <h3 class="hub-hero-title">${_escapeHtml(t('hub.account.signed_out_title'))}</h3>
      <p class="hub-hero-desc">${_escapeHtml(t('hub.account.signed_out_desc'))}</p>
      ${unreachable}
      <button type="button" class="btn btn-primary hub-hero-cta" id="hub-account-sign-in" data-i18n="hub.account.sign_in">${_icon('shield-check', 'hub-hero-cta-icon')}${_escapeHtml(t('hub.account.sign_in'))}</button>
      <div class="hub-hero-safe">${_icon('shield-check', 'hub-hero-safe-icon')}${_escapeHtml(t('hub.account.local_safe_hint'))}</div>
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

function _signedInCard(status, devices, consents, displayName, loginId, phoneMasked) {
  const deviceRows = devices.map((dev) => {
    const current = dev.is_current
      ? `<span class="hub-chip hub-chip-current">${_escapeHtml(t('hub.account.device_current'))}</span>`
      : '';
    const revoke = dev.is_current
      ? ''
      : `<button type="button" class="hub-btn-mini" data-hub-revoke-device="${_escapeHtml(dev.device_id)}">${_icon('trash-2', 'hub-btn-icon')}${_escapeHtml(t('hub.account.revoke'))}</button>`;
    // P3394 DEVICE-05：设备名缺失用通用占位名，不展示 device_id/installation_id 等内部标识。
    const name = _friendlyDeviceName(dev) || _escapeHtml(t('hub.account.device_unknown'));
    const os = (dev.device_os || '').replace(/\bunknown\b/gi, '').trim();
    // 最近活跃时间 = 最近一次成功登录或有效活动（服务端 last_seen_at 语义，契约 v1.7）。
    const lastActive = dev.last_seen_at ? `${_escapeHtml(t('hub.account.device_last_active'))} ${_escapeHtml(_formatTime(dev.last_seen_at))}` : '';
    const meta = [os, lastActive].filter(Boolean).join(' · ');
    return `
      <div class="hub-device-row">
        <span class="hub-device-icon">${_icon('monitor')}</span>
        <div class="hub-device-body">
          <span class="hub-device-name">${name}${current}</span>
          ${meta ? `<span class="hub-device-meta">${meta}</span>` : ''}
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

  // 身份卡：首字母渐变头像 + 昵称/脱敏 ID 双层 + CogSeed ID/掩码手机号。
  // P3394 ACCOUNT-03：不展示 LocalIdentity 绑定状态（已绑定/未绑定本机身份）。
  const maskedId = _maskId(status.account_id || '');
  const initial = String(displayName || status.account_id || '?').trim().charAt(0).toUpperCase() || '?';
  const nameLine = displayName ? _escapeHtml(displayName) : maskedId;
  const monoLine = displayName
    ? `<span class="hub-account-id-value">${_escapeHtml(maskedId)}</span>`
    : '';
  // CogSeed ID（login_id）与掩码手机号（PRD PHONE-06：设置页只展示掩码手机号和 CogSeed ID）。
  const identityMeta = [
    loginId ? `<span class="hub-account-meta-row"><span class="hub-account-meta-label">${_escapeHtml(t('hub.account.login_id'))}</span><span class="hub-account-id-value">${_escapeHtml(loginId)}</span></span>` : '',
    phoneMasked ? `<span class="hub-account-meta-row"><span class="hub-account-meta-label">${_escapeHtml(t('hub.account.phone_masked'))}</span><span class="hub-account-phone">${_escapeHtml(phoneMasked)}</span></span>` : '',
  ].filter(Boolean).join('');
  const identityMetaBlock = identityMeta
    ? `<div class="hub-account-meta">${identityMeta}</div>`
    : '';

  return `
    <div class="hub-hero hub-hero-compact">
      <div class="hub-hero-top">
        <div class="hub-hero-badge hub-hero-badge-on">${_icon('check-circle', 'hub-hero-badge-icon')}${_escapeHtml(t('hub.account.signed_in_title'))}</div>
        <button type="button" class="btn btn-sm hub-hero-manage" id="hub-account-manage">${_icon('settings', 'hub-btn-icon')}${_escapeHtml(t('hub.account.manage'))}</button>
      </div>
      <div class="hub-account-line">
        <span class="hub-account-avatar is-gradient" aria-hidden="true">${_escapeHtml(initial)}</span>
        <div class="hub-account-id">
          <span class="hub-account-name">${nameLine}</span>
          ${monoLine}
          ${identityMetaBlock}
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
  const idleHtml = `${_icon('shield-check', 'hub-hero-cta-icon')}${_escapeHtml(t('hub.account.sign_in'))}`;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = _escapeHtml(t('hub.account.signing_in'));
    try {
      await _invoke('hub-account.start_login');
      // Browser flow: the deep link callback completes the login; keep the
      // button disabled until the status refresh reflects it.
      window.setTimeout(() => { btn.disabled = false; btn.innerHTML = idleHtml; void _renderHubAccount(); }, 800);
    } catch (err) {
      _hubLog.warn('hub sign-in start failed', { error: (err && err.message) || String(err) });
      btn.disabled = false;
      btn.innerHTML = idleHtml;
      window.alert((err && err.message) || t('hub.account.error_start'));
    }
  });
}

function _bindSignedIn(card, opts) {
  const manage = card.querySelector('#hub-account-manage');
  if (manage) {
    manage.addEventListener('click', () => {
      // 管理账号：滚动到本卡下方的设备列表（完整管理面就在设置-账号页内）。
      const head = card.querySelector('.settings-section-head');
      if (head && typeof head.scrollIntoView === 'function') {
        head.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

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

  // 注销入口：进入 P3394 注销流程（影响说明 → 重新认证 → 二次确认 → 一次性回执）。
  const del = card.querySelector('#hub-account-delete');
  if (del) {
    del.addEventListener('click', () => {
      void _startDeletionFlow(card, opts || {});
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

// ── 注销流程（P3394 DEL-01~04）───────────────────────────────────────────
// 步骤：1 影响说明 → 2 重新认证（短信验证码/账号密码）→ 3 二次确认
//      → 一次性退出回执 → 呈现普通未登录状态。云端注销与本机数据分开呈现。

let _deletionCtx = null; // { step, impact, phoneMasked, method, code, password, resendAfter, error, busy }
let _deletionCountdown = null;

function _stopDeletionCountdown() {
  if (_deletionCountdown !== null) {
    window.clearInterval(_deletionCountdown);
    _deletionCountdown = null;
  }
}

function _deletionErrorHtml(ctx) {
  if (!ctx.error) return '';
  return `<div class="hub-alert hub-alert-danger hub-deletion-error" role="alert">${_icon('warning', 'hub-alert-icon')}${_escapeHtml(ctx.error)}</div>`;
}

function _deletionStep1Html(ctx) {
  const days = (ctx.impact && ctx.impact.reversal_days) || 30;
  const rows = ((ctx.impact && ctx.impact.items) || []).map((it) => `
    <div class="hub-deletion-impact-row">
      <span class="hub-deletion-impact-title">${_escapeHtml(it.title)}</span>
      <span class="hub-deletion-impact-desc">${_escapeHtml(it.description)}</span>
      <span class="hub-deletion-impact-effects">
        <span class="hub-deletion-impact-immediate">${_escapeHtml(t('hub.account.deletion_impact_immediate_label'))}${_escapeHtml(it.immediate)}</span>
        <span class="hub-deletion-impact-final">${_escapeHtml(t('hub.account.deletion_impact_final_label'))}${_escapeHtml(it.final)}</span>
      </span>
    </div>`).join('');
  return `
    <div class="hub-deletion-flow">
      <div class="hub-deletion-head">
        <h3 class="hub-deletion-title">${_escapeHtml(t('hub.account.deletion_title'))}</h3>
        <span class="hub-deletion-step">${_escapeHtml(t('hub.account.deletion_step', { current: 1, total: 3 }))}</span>
      </div>
      <div class="hub-alert" role="status">${_icon('warning', 'hub-alert-icon')}${_escapeHtml(t('hub.account.deletion_impact_notice', { days }))}</div>
      <div class="hub-card hub-card-list">${rows}</div>
      <div class="hub-deletion-local-note">${_icon('hard-drive', 'hub-btn-icon')}${_escapeHtml(t('hub.account.deletion_local_note'))}</div>
      <div class="hub-actions">
        <button type="button" class="btn btn-sm" data-hub-deletion-cancel>${_escapeHtml(t('hub.account.deletion_back'))}</button>
        <button type="button" class="btn btn-sm btn-primary" data-hub-deletion-next>${_escapeHtml(t('hub.account.deletion_continue'))}</button>
      </div>
    </div>`;
}

function _deletionStep2Html(ctx) {
  const sendBtn = ctx.method === 'sms_code'
    ? `<button type="button" class="btn btn-sm" data-hub-deletion-send ${ctx.resendAfter > 0 ? 'disabled' : ''}>${_escapeHtml(ctx.resendAfter > 0 ? t('hub.account.deletion_resend_in', { s: ctx.resendAfter }) : t('hub.account.deletion_send_code'))}</button>`
    : '';
  const reauthField = ctx.method === 'sms_code'
    ? `
      <div class="hub-deletion-reauth-line">${_icon('smartphone', 'hub-btn-icon')}${_escapeHtml(t('hub.account.deletion_reauth_sms_hint', { phone: ctx.phoneMasked || '—' }))}</div>
      <div class="hub-deletion-code-row">
        <input class="hub-deletion-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" data-hub-deletion-code value="${_escapeHtml(ctx.code)}" placeholder="${_escapeHtml(t('hub.account.deletion_code_placeholder'))}" />
        ${sendBtn}
      </div>`
    : `<input class="hub-deletion-input" type="password" data-hub-deletion-password value="${_escapeHtml(ctx.password)}" placeholder="${_escapeHtml(t('hub.account.deletion_password_placeholder'))}" />`;
  return `
    <div class="hub-deletion-flow">
      <div class="hub-deletion-head">
        <h3 class="hub-deletion-title">${_escapeHtml(t('hub.account.deletion_reauth_title'))}</h3>
        <span class="hub-deletion-step">${_escapeHtml(t('hub.account.deletion_step', { current: 2, total: 3 }))}</span>
      </div>
      <p class="hub-deletion-desc">${_escapeHtml(t('hub.account.deletion_reauth_desc'))}</p>
      ${reauthField}
      ${_deletionErrorHtml(ctx)}
      <div class="hub-actions">
        <button type="button" class="btn btn-sm" data-hub-deletion-back>${_escapeHtml(t('hub.account.deletion_back'))}</button>
        <button type="button" class="btn btn-sm btn-primary" data-hub-deletion-next>${_escapeHtml(t('hub.account.deletion_continue'))}</button>
      </div>
    </div>`;
}

function _deletionStep3Html(ctx) {
  const days = (ctx.impact && ctx.impact.reversal_days) || 30;
  const deadline = new Date(Date.now() + days * 24 * 3600 * 1000).toLocaleString();
  const checks = [1, 2, 3].map((i) => `
    <label class="hub-deletion-check">
      <input type="checkbox" data-hub-deletion-check ${ctx.checks[i - 1] ? 'checked' : ''} />
      <span>${_escapeHtml(t(`hub.account.deletion_check_${i}`, { days }))}</span>
    </label>`).join('');
  return `
    <div class="hub-deletion-flow">
      <div class="hub-deletion-head">
        <h3 class="hub-deletion-title">${_escapeHtml(t('hub.account.deletion_confirm_title'))}</h3>
        <span class="hub-deletion-step">${_escapeHtml(t('hub.account.deletion_step', { current: 3, total: 3 }))}</span>
      </div>
      <div class="hub-alert hub-alert-danger" role="status">${_icon('warning', 'hub-alert-icon')}${_escapeHtml(t('hub.account.deletion_confirm_notice', { deadline }))}</div>
      <div class="hub-deletion-checks">${checks}</div>
      <input class="hub-deletion-input" type="text" data-hub-deletion-phrase value="${_escapeHtml(ctx.phrase)}" placeholder="${_escapeHtml(t('hub.account.deletion_phrase_placeholder'))}" />
      ${_deletionErrorHtml(ctx)}
      <div class="hub-actions">
        <button type="button" class="btn btn-sm" data-hub-deletion-back>${_escapeHtml(t('hub.account.deletion_back'))}</button>
        <button type="button" class="btn btn-sm btn-danger" data-hub-deletion-submit disabled>${_escapeHtml(t('hub.account.deletion_confirm_submit'))}</button>
      </div>
    </div>`;
}

function _renderDeletion(card) {
  const ctx = _deletionCtx;
  if (!ctx) return;
  if (ctx.step === 1) card.innerHTML = _deletionStep1Html(ctx);
  else if (ctx.step === 2) card.innerHTML = _deletionStep2Html(ctx);
  else card.innerHTML = _deletionStep3Html(ctx);
  _bindDeletion(card, ctx);
}

async function _startDeletionFlow(card, opts) {
  _stopDeletionCountdown();
  let impact = null;
  try {
    const res = await _invoke('hub-account.deletion_impact');
    impact = res.impact;
  } catch (err) {
    _hubLog.warn('hub deletion impact load failed', { error: (err && err.message) || String(err) });
    window.alert((err && err.message) || t('hub.account.error_delete'));
    return;
  }
  _deletionCtx = {
    step: 1,
    impact,
    phoneMasked: opts.phoneMasked || null,
    method: opts.phoneMasked ? 'sms_code' : 'password',
    code: '',
    password: '',
    phrase: '',
    checks: [false, false, false],
    resendAfter: 0,
    error: null,
    busy: false,
  };
  _renderDeletion(card);
}

async function _sendDeletionReauthCode(card, ctx) {
  if (ctx.busy || ctx.resendAfter > 0) return;
  ctx.busy = true;
  try {
    const res = await _invoke('hub-account.deletion_send_code');
    const sent = (res && res.sent) || {};
    ctx.resendAfter = Number(sent.resend_after) > 0 ? Number(sent.resend_after) : 60;
    ctx.error = null;
    // 倒计时只更新按钮文案，不整卡重渲染（保住已输入的验证码）。
    _startDeletionCountdown(card, ctx);
  } catch (err) {
    ctx.error = (err && err.message) || t('hub.account.error_delete');
  } finally {
    ctx.busy = false;
  }
  const btn = card.querySelector('[data-hub-deletion-send]');
  if (btn) {
    btn.disabled = ctx.resendAfter > 0;
    btn.textContent = ctx.resendAfter > 0 ? t('hub.account.deletion_resend_in', { s: ctx.resendAfter }) : t('hub.account.deletion_send_code');
  }
  if (ctx.error) {
    const box = card.querySelector('.hub-deletion-flow');
    if (box) {
      card.querySelectorAll('.hub-deletion-error').forEach((n) => n.remove());
      box.insertAdjacentHTML('beforeend', _deletionErrorHtml(ctx));
    }
  }
}

function _startDeletionCountdown(card, ctx) {
  _stopDeletionCountdown();
  _deletionCountdown = window.setInterval(() => {
    if (ctx.step !== 2) {
      _stopDeletionCountdown();
      return;
    }
    if (ctx.resendAfter > 0) ctx.resendAfter -= 1;
    const btn = card.querySelector('[data-hub-deletion-send]');
    if (btn) {
      btn.disabled = ctx.resendAfter > 0;
      btn.textContent = ctx.resendAfter > 0 ? t('hub.account.deletion_resend_in', { s: ctx.resendAfter }) : t('hub.account.deletion_send_code');
    }
    if (ctx.resendAfter <= 0) _stopDeletionCountdown();
  }, 1000);
}

async function _performDeletion(card, ctx) {
  if (ctx.busy) return;
  ctx.busy = true;
  const submit = card.querySelector('[data-hub-deletion-submit]');
  if (submit) submit.disabled = true;
  try {
    const payload = { confirmation: 'DELETE_MY_ACCOUNT', reauth_method: ctx.method };
    if (ctx.method === 'sms_code') payload.code = String(ctx.code || '').trim();
    else payload.password = String(ctx.password || '');
    const res = await _invoke('hub-account.delete_account', payload);
    const deletion = (res && res.deletion) || {};
    _stopDeletionCountdown();
    _deletionCtx = null;
    // 一次性退出回执（DEL-04）：之后直接呈现普通未登录状态，无注销专属页面。
    window.alert(t('hub.account.deletion_receipt', { deadline: _formatTime(deletion.reversal_deadline_at) }));
    await _renderHubAccount();
  } catch (err) {
    ctx.busy = false;
    const code = String((err && err.code) || '');
    ctx.error = (err && err.message) || t('hub.account.error_delete');
    // 重新认证类错误回到第 2 步（验证码/密码问题），其余留在本步展示。
    if (ctx.method === 'sms_code' && /^(SMS_CODE|SMS_VERIFY_LOCKED)/.test(code)) ctx.step = 2;
    if (ctx.method === 'password' && /^(AUTH_INVALID_CREDENTIALS|ACCOUNT_LOCKED)/.test(code)) ctx.step = 2;
    _renderDeletion(card);
  }
}

function _bindDeletion(card, ctx) {
  const cancel = card.querySelector('[data-hub-deletion-cancel]');
  if (cancel) {
    cancel.addEventListener('click', () => {
      _stopDeletionCountdown();
      _deletionCtx = null;
      void _renderHubAccount();
    });
  }
  const back = card.querySelector('[data-hub-deletion-back]');
  if (back) {
    back.addEventListener('click', () => {
      ctx.error = null;
      if (ctx.step === 2) ctx.step = 1;
      else if (ctx.step === 3) ctx.step = 2;
      _renderDeletion(card);
    });
  }
  const next = card.querySelector('[data-hub-deletion-next]');
  if (next) {
    next.addEventListener('click', () => {
      if (ctx.step === 1) {
        ctx.step = 2;
        _renderDeletion(card);
        return;
      }
      // step 2 → 3：重新认证材料必须已就绪。
      if (ctx.method === 'sms_code') {
        if (!String(ctx.code || '').trim()) {
          ctx.error = t('hub.account.deletion_code_required');
          _renderDeletion(card);
          return;
        }
      } else if (!String(ctx.password || '')) {
        ctx.error = t('hub.account.deletion_password_required');
        _renderDeletion(card);
        return;
      }
      ctx.error = null;
      ctx.step = 3;
      _renderDeletion(card);
    });
  }

  const send = card.querySelector('[data-hub-deletion-send]');
  if (send) {
    send.addEventListener('click', () => {
      void _sendDeletionReauthCode(card, ctx);
    });
  }
  const codeInput = card.querySelector('[data-hub-deletion-code]');
  if (codeInput) {
    codeInput.addEventListener('input', () => { ctx.code = codeInput.value; });
  }
  const passwordInput = card.querySelector('[data-hub-deletion-password]');
  if (passwordInput) {
    passwordInput.addEventListener('input', () => { ctx.password = passwordInput.value; });
  }

  const phrase = card.querySelector('[data-hub-deletion-phrase]');
  const checks = Array.from(card.querySelectorAll('[data-hub-deletion-check]'));
  const submit = card.querySelector('[data-hub-deletion-submit]');
  if (phrase && submit) {
    // 重渲染（如窗口切换后的焦点刷新）后恢复已勾选项与已输入短语，
    // 保证流程状态跨窗口切换保持不变。
    checks.forEach((c, i) => { c.checked = !!ctx.checks[i]; });
    phrase.value = ctx.phrase || '';
    const updateSubmit = () => {
      const allChecked = checks.every((c) => c.checked);
      submit.disabled = !(allChecked && phrase.value.trim() === 'DELETE_MY_ACCOUNT');
    };
    checks.forEach((c, i) => c.addEventListener('change', () => { ctx.checks[i] = c.checked; updateSubmit(); }));
    phrase.addEventListener('input', () => { ctx.phrase = phrase.value; updateSubmit(); });
    updateSubmit();
    submit.addEventListener('click', () => {
      void _performDeletion(card, ctx);
    });
  }
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

// deep link 登录完成的推送事件。`start_login` 在打开浏览器时就已返回，登录真正
// 完成是在主进程收到 cogseed://account/callback 之后，渲染端不 await 那一步，
// 所以只能靠这个事件刷新。
//
// 这里刻意不判断面板是否可见：上面的 focus 处理器不足以覆盖两种情况——
//   1. 主进程会先 _focusMainWindow() 再 await completeLogin，focus 那次刷新
//      读到的仍是旧状态，之后不会有第二次刷新；
//   2. 用户当时不在账号面板（甚至没打开设置），focus 分支直接跳过。
// _renderHubAccount 自身在找不到卡片时会立即返回，因此无条件调用是安全的。
if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
  try {
    window.cogseed.onPushEvent('hub-account:login-result', (outcome) => {
      _hubLog.info('hub login result received', {
        result: (outcome && outcome.result) || 'unknown',
        code: (outcome && outcome.code) || undefined,
      });
      void _renderHubAccount();
    });
  } catch (err) {
    _hubLog.warn('hub login result subscription failed', { error: (err && err.message) || String(err) });
  }

  // 状态变更广播（登出 / 注销，可能来自左下角账号区等其它表面）。
  // 账号面板不可见时跳过刷新，避免隐藏面板白打后端；打开设置时
  // loadSettings → initHubAccountSettings 会主动刷新一次。
  try {
    window.cogseed.onPushEvent('hub-account:state-changed', (change) => {
      _hubLog.info('hub state change received', { reason: (change && change.reason) || 'unknown' });
      const pane = document.querySelector('.settings-tab-pane[data-settings-pane="account"]');
      if (pane && !pane.hidden) void _renderHubAccount();
    });
  } catch (err) {
    _hubLog.warn('hub state change subscription failed', { error: (err && err.message) || String(err) });
  }
}

window.initHubAccountSettings = _renderHubAccount;
