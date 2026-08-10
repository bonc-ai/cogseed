// ─── Settings (entries-based: picker + priority list) ────────────────────
// The page is split in two:
//   1. "Add model auth": pick provider + model, then "+ Add account" →
//      either an API Key form or the OAuth flow, depending on what the
//      provider supports. On success we auto-create a priority-list
//      entry pointing at the new credential.
//   2. "Configured (by priority)": ordered list of
//      (provider, model, profile)
//      entries. First = default model; later items are the fallback chain.
//      Rows are drag-reorderable.

const _settingsLog = createLogger('settings');

let _settingsState = {
  providers: [],      // from auth.listProviders  [{id, label, supportsApiKey, supportsOAuth, profiles, ...}]
  entries: [],        // from auth.listEntries
  modelsCache: {},    // provider → [{id, name}]
  pickerProviderSel: null,
  pickerModelSel: null,
  pickerProviderEl: null,
  pickerModelEl: null,
  addBtnEl: null,
  ttsPresets: [],
  ttsProfiles: [],
  ttsProviderSel: null,
  dragState: null,
  taskNotifications: {
    enabled: true,
    permission: { state: 'unknown', can_open_settings: false },
  },
  taskNotificationsBound: false,
  taskNotificationPermissionRefreshTimer: null,
  clientConfigBound: false,
  commanderBackendView: null,
  commanderBackendSel: null,
  commanderBackendEl: null,
  commanderBackendBound: false,
  authProfilesStatus: null,
  authProfilesRecoveryBound: false,
  customProviders: [],
  customProvidersBound: false,
  ccswitchStatus: null,
  ccswitchPreviewRows: [],
  ccswitchPreviewSelectedIds: [],
  ccswitchPreviewBound: false,
};

function _settingsTrackClick() {}

function _settingsTrackEvent(action, payload) {
  void action;
  void payload;
}

function _settingsTrackError(action, payload) {
  void action;
  void payload;
}

async function _settingsSafeCall(label, fn) {
  if (typeof fn !== 'function') return;
  try {
    await fn();
  } catch (err) {
    _settingsLog.warn(`${label} failed`, { error: (err && err.message) || String(err) });
  }
}

async function loadSettings() {
  // 4-tab structure (batch 6). Initialize switching + activate default tab
  // (通用 by default — matches the is-active class on the markup).
  if (typeof initSettingsTabs === 'function') initSettingsTabs();
  _settingsBindLanguageOnce();
  _settingsBindTaskNotificationsOnce();
  _settingsBindClientConfigOnce();
  _settingsSyncLanguageRadio();
  await Promise.all([
    _settingsSafeCall('settings providers refresh', _settingsRefreshProviders),
    _settingsSafeCall('settings entries refresh', _settingsRefreshEntries),
    _settingsSafeCall('settings local execution refresh', _settingsRefreshLocalExec),
    _settingsSafeCall('settings search refresh', _settingsRefreshSearchProfiles),
    _settingsSafeCall('settings image refresh', _settingsRefreshImageProfiles),
    _settingsSafeCall('settings video refresh', _settingsRefreshVideoProfiles),
    _settingsSafeCall('settings tts refresh', _settingsRefreshTtsProfiles),
    _settingsSafeCall('settings task notifications refresh', _settingsRefreshTaskNotifications),
    _settingsSafeCall('settings metacognition refresh', _settingsRefreshMetacognition),
    _settingsSafeCall('settings data root refresh', _settingsRefreshDataRoot),
    _settingsSafeCall('settings commander backend refresh', _settingsRefreshCommanderBackend),
    _settingsSafeCall('settings auth profiles status refresh', _settingsRefreshAuthProfilesStatus),
    _settingsSafeCall('settings custom providers refresh', _settingsRefreshCustomProviders),
    _settingsSafeCall('settings ccswitch status refresh', _settingsRefreshCcswitchStatus),
    _settingsSafeCall('settings messaging refresh', () => window.initMessagingSettings && window.initMessagingSettings()),
    _settingsSafeCall('settings personal context refresh', () => window.initPersonalContextSettings && window.initPersonalContextSettings()),
  ]);
  await _settingsSafeCall('settings model authorization init', () => window.initModelAuthorizationSettings && window.initModelAuthorizationSettings());
  await _settingsSafeCall('settings local execution render', _settingsRenderLocalExec);
  await _settingsSafeCall('settings search render', _settingsRenderSearchSection);
  await _settingsSafeCall('settings image render', _settingsRenderImageSection);
  await _settingsSafeCall('settings video render', _settingsRenderVideoSection);
  await _settingsSafeCall('settings tts render', _settingsRenderTtsEntries);
  await _settingsSafeCall('settings task notifications render', _settingsRenderTaskNotifications);
  await _settingsSafeCall('settings metacognition render', _settingsRenderMetacognition);
  await _settingsSafeCall('settings data root render', _settingsRenderDataRoot);
  await _settingsSafeCall('settings commander backend render', _settingsRenderCommanderBackend);
  await _settingsSafeCall('settings auth profiles recovery render', _settingsRenderAuthProfilesRecovery);
  await _settingsSafeCall('settings custom providers render', _settingsRenderCustomProviders);
  await _settingsSafeCall('settings ccswitch render', _settingsRenderCcswitchStatus);
  // Account card + subscription card (views/login/account_settings.js — absent in
  // the open-source build, so these are no-ops there). renderSubscriptionSettings rebinds the
  // action button's click handler with the current subscription state on every
  // render — opening the panel is the canonical "guarantee fresh button binding"
  // moment, so call it explicitly here (not just from the account.onChange listener
  // which only fires on state changes — for a Free user with no transitions the
  // listener never fires after boot, leaving the button bound to whatever its
  // first render captured).
}

// ── Native task notifications ──

function _settingsTaskNotificationPermissionState(state) {
  return String(state?.permission?.state || 'unknown');
}

async function _settingsRefreshTaskNotifications() {
  try {
    const res = await window.orkas.invoke('prefs.getTaskNotifications');
    _settingsState.taskNotifications = (res && res.ok)
      ? {
          enabled: !!res.enabled,
          permission: {
            state: String(res.permission && res.permission.state || 'unknown'),
            can_open_settings: !!(res.permission && res.permission.can_open_settings),
          },
        }
      : {
          enabled: true,
          permission: { state: 'unknown', can_open_settings: false },
        };
  } catch (_) {
    _settingsState.taskNotifications = {
      enabled: true,
      permission: { state: 'unknown', can_open_settings: false },
    };
  }
}

function _settingsBindTaskNotificationsOnce() {
  if (_settingsState.taskNotificationsBound) return;
  _settingsState.taskNotificationsBound = true;
  window.addEventListener('focus', () => {
    if (typeof currentView !== 'undefined' && currentView !== 'settings') return;
    if (_settingsState.taskNotificationPermissionRefreshTimer) {
      clearTimeout(_settingsState.taskNotificationPermissionRefreshTimer);
    }
    _settingsState.taskNotificationPermissionRefreshTimer = setTimeout(async () => {
      _settingsState.taskNotificationPermissionRefreshTimer = null;
      await _settingsRefreshTaskNotifications();
      _settingsRenderTaskNotifications();
    }, 350);
  });
}

function _settingsRenderTaskNotifications() {
  const cb = document.getElementById('settings-task-notifications-toggle');
  if (!cb) return;
  const state = _settingsState.taskNotifications || {
    enabled: true,
    permission: { state: 'unknown', can_open_settings: false },
  };
  cb.checked = !!state.enabled;

  const warning = document.getElementById('settings-task-notification-permission');
  const openBtn = document.getElementById('settings-task-notification-open-settings');
  // Only make the definitive "system notifications are off" claim when the
  // platform also exposes an actionable per-app settings destination. A
  // delivery failure on an unsupported/unprobeable desktop can surface as
  // `denied` without proving that the user disabled Orkas in system settings.
  const permissionDenied = state.enabled
    && state.permission
    && state.permission.state === 'denied'
    && state.permission.can_open_settings;
  if (warning) warning.hidden = !permissionDenied;
  if (openBtn) {
    openBtn.hidden = !(state.permission && state.permission.can_open_settings);
    if (!openBtn.dataset.bound) {
      openBtn.addEventListener('click', async () => {
        openBtn.disabled = true;
        try {
          await window.orkas.invoke('prefs.openTaskNotificationSettings');
        } catch (err) {
          _settingsLog.warn('open task notification settings failed', err);
        } finally {
          openBtn.disabled = false;
        }
      });
      openBtn.dataset.bound = '1';
    }
  }

  if (!cb.dataset.bound) {
    cb.addEventListener('change', async () => {
      const next = !!cb.checked;
      const currentState = _settingsState.taskNotifications || {
        enabled: true,
        permission: { state: 'unknown', can_open_settings: false },
      };
      const previous = !!currentState.enabled;
      const permissionState = _settingsTaskNotificationPermissionState(currentState);
      cb.disabled = true;
      try {
        const res = await window.orkas.invoke('prefs.setTaskNotifications', { enabled: next });
        if (res && res.ok) {
          _settingsState.taskNotifications = {
            ...currentState,
            enabled: !!res.enabled,
            permission: res.permission
              ? {
                  state: String(res.permission.state || 'unknown'),
                  can_open_settings: !!res.permission.can_open_settings,
                }
              : currentState.permission,
          };
          _settingsLog.info('task notification toggle saved', {
            previous_enabled: previous,
            enabled: !!res.enabled,
            permission_state: _settingsTaskNotificationPermissionState(_settingsState.taskNotifications),
          });
        } else {
          _settingsState.taskNotifications = { ...currentState, enabled: previous };
          _settingsLog.warn('set task notifications rejected', {
            target_enabled: next,
            error: String(res?.error || 'preference update rejected'),
          });
        }
      } catch (err) {
        _settingsState.taskNotifications = { ...currentState, enabled: previous };
        _settingsLog.warn('set task notifications failed', err);
      } finally {
        cb.disabled = false;
        _settingsRenderTaskNotifications();
      }
    });
    cb.dataset.bound = '1';
  }
}

function _settingsBindClientConfigOnce() {}

// ── Tool execution access permission ──

const _LOCALEXEC_MODES = ['workspace_approval', 'all_files_approval', 'all_files_auto'];

async function _settingsRefreshLocalExec() {
  const res = await window.orkas.invoke('permissions.getLocalExec');
  const mode = (res && res.ok && _LOCALEXEC_MODES.includes(res.mode)) ? res.mode : 'all_files_approval';
  _settingsState.localExec = { mode };
}

function _settingsRenderLocalExec() {
  const container = document.getElementById('settings-localexec-modes');
  if (!container) return;
  const mode = (_settingsState.localExec && _settingsState.localExec.mode) || 'all_files_approval';
  const radios = container.querySelectorAll('input[name="localexec-mode"]');
  radios.forEach((r) => { r.checked = (r.value === mode); });
  if (!container.dataset.bound) {
    radios.forEach((radio) => {
      radio.addEventListener('change', async () => {
        if (!radio.checked) return;
        const next = radio.value;
        const prev = (_settingsState.localExec && _settingsState.localExec.mode) || 'all_files_approval';
        try {
          const res = await window.orkas.invoke('permissions.setLocalExecMode', { mode: next });
          if (res && res.ok && res.mode) {
            _settingsState.localExec = { mode: res.mode };
            _settingsRenderLocalExec();
          } else {
            _settingsState.localExec = { mode: prev };
            _settingsRenderLocalExec();
          }
        } catch (err) {
          _settingsState.localExec = { mode: prev };
          _settingsRenderLocalExec();
          _settingsLog.warn('local exec mode set failed', err);
        }
      });
    });
    container.dataset.bound = '1';
  }
}

// ── Metacognition (agent self-evolution) ──
// Stored at preferences.json::metacognition_enabled. The env var
// `ORKAS_METACOGNITION='0'` is still a higher-priority kill switch
// (surfaced as `envForcedOff`); when active, the UI greys out the
// toggle and shows an explanatory hint.

async function _settingsRefreshMetacognition() {
  try {
    const res = await window.orkas.invoke('prefs.getMetacognition');
    _settingsState.metacognition = (res && res.ok)
      ? { enabled: !!res.enabled, envForcedOff: !!res.envForcedOff }
      : { enabled: true, envForcedOff: false };
  } catch (_) {
    _settingsState.metacognition = { enabled: true, envForcedOff: false };
  }
}

function _settingsRenderMetacognition() {
  const cb = document.getElementById('settings-metacognition-toggle');
  const status = document.getElementById('settings-metacognition-status');
  if (!cb) return;
  const s = _settingsState.metacognition || { enabled: true, envForcedOff: false };
  cb.checked = s.envForcedOff ? false : !!s.enabled;
  cb.disabled = !!s.envForcedOff;
  if (status) {
    status.textContent = s.envForcedOff ? t('settings.metacognition.env_forced_off') : '';
  }
  if (!cb.dataset.bound) {
    cb.addEventListener('change', async () => {
      if (cb.disabled) return;
      const next = !!cb.checked;
      try {
        const res = await window.orkas.invoke('prefs.setMetacognition', { enabled: next });
        if (res && res.ok) {
          _settingsState.metacognition = { ..._settingsState.metacognition, enabled: !!res.enabled };
        } else {
          // Roll back the UI on write failure.
          cb.checked = !next;
          _settingsLog.warn('setMetacognition rejected', res);
          _settingsTrackEvent('metacognition_toggle_result', { result: 'failure', enabled: !next });
          _settingsTrackError('metacognition_toggle', {
            error_type: 'operation',
            error_message: 'metacognition_toggle_rejected',
          });
        }
      } catch (err) {
        cb.checked = !next;
        _settingsLog.warn('setMetacognition failed', err);
        _settingsTrackEvent('metacognition_toggle_result', { result: 'failure', enabled: !next });
        _settingsTrackError('metacognition_toggle', {
          error_type: 'operation',
          error_message: 'metacognition_toggle_failed',
        });
      }
    });
    cb.dataset.bound = '1';
  }
}

// ── Data root row ──
// Read-only display of the unified data root path; click to open it in
// the OS file manager via the `app.openDataRoot` IPC.

async function _settingsRefreshDataRoot() {
  try {
    const res = await window.orkas.invoke('app.dataRootPath');
    _settingsState.dataRoot = (res && res.ok && res.path) ? String(res.path) : '';
  } catch (_) {
    _settingsState.dataRoot = '';
  }
}

function _settingsRenderDataRoot() {
  const btn = document.getElementById('settings-data-root-btn');
  const span = document.getElementById('settings-data-root-path');
  if (!btn || !span) return;
  span.textContent = _settingsState.dataRoot || '';
  if (!btn.dataset.bound) {
    btn.addEventListener('click', async () => {
      try {
        await window.orkas.invoke('app.openDataRoot');
      } catch (err) {
        _settingsLog.warn('open data root failed', { error: (err && err.message) || String(err) });
        _settingsTrackEvent('settings_open_data_root_result', { result: 'failure' });
        _settingsTrackError('settings_open_data_root', {
          error_type: 'operation',
          error_message: 'open_data_root_failed',
        });
      }
    });
    btn.dataset.bound = '1';
  }
}

// ── Language dropdown ──
// Bound once on first panel open; `loadSettings` then calls _settingsSyncLanguageRadio()
// to re-sync the dropdown's current value with whatever setLang() last persisted.
// Option labels are each language's autonym (本族语自称), intentionally NOT routed
// through t() — a Chinese user picking "English" should see "English", not the
// translation of "English" in the current UI language.

let _settingsLanguageSel = null;   // _aiSelectMount api

const _SETTINGS_LANG_OPTIONS = [
  ...((typeof getSupportedLanguages === 'function')
    ? getSupportedLanguages().map((l) => ({ value: l.code, label: l.label }))
    : [
        { value: 'zh', label: '简体中文' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
      ]),
];

function _settingsBindLanguageOnce() {
  if (_settingsLanguageSel) return;
  const el = document.getElementById('settings-language-select');
  if (!el) return;
  _settingsLanguageSel = _aiSelectMount(el, {
    options: _SETTINGS_LANG_OPTIONS,
    value: (typeof getLang === 'function') ? getLang() : 'en',
  });
  _settingsLanguageSel.onChange(async (next) => {
    if (typeof isSupportedLang === 'function' && !isSupportedLang(next)) return;
    try {
      await setLang(next);
      _settingsLog.info('language changed', { lang: next });
    } catch (err) {
      _settingsLog.warn('setLang failed', { error: (err && err.message) || String(err) });
    }
  });
}

function _settingsSyncLanguageRadio() {
  // Function name kept for caller-side compatibility; semantics is now "sync dropdown value".
  const cur = (typeof getLang === 'function') ? getLang() : 'en';
  if (_settingsLanguageSel) _settingsLanguageSel.setValue(cur);
}

// Keep the radio in sync if some other code path changes language, and
// re-render sections whose text is written by JS (so their content
// isn't refreshed by applyDomI18n's data-i18n sweep).
window.addEventListener('i18n-change', () => {
  _settingsSyncLanguageRadio();
  _settingsRenderLocalExec();
  if (window.refreshModelAuthorizationSettings) window.refreshModelAuthorizationSettings();
  _settingsRenderSearchSection();
  _settingsRenderImageSection();
  _settingsRenderVideoSection();
  _settingsRenderMetacognition();
  _settingsRenderCommanderBackend();
  _settingsRenderCustomProviders();
  _settingsRenderCcswitchStatus();
  if (_settingsState.ccswitchPreviewRows.length) _settingsRenderCcswitchPreviewDialog();
});

async function _settingsRefreshProviders() {
  const res = await window.orkas.invoke('auth.listProviders');
  _settingsState.providers = (res && res.ok && Array.isArray(res.providers)) ? res.providers : [];
}

async function _settingsRefreshEntries() {
  const res = await window.orkas.invoke('auth.listEntries', { includeUnavailable: true });
  _settingsState.entries = (res && res.ok && Array.isArray(res.entries)) ? res.entries : [];
  if (typeof trackModelConfigSnapshot === 'function') trackModelConfigSnapshot(_settingsState.entries);
}

async function _settingsRefreshAuthProfilesStatus() {
  const res = await window.orkas.invoke('auth.getProfilesStoreStatus');
  _settingsState.authProfilesStatus = (res && res.ok !== undefined) ? res : null;
}

function _settingsRenderAuthProfilesRecovery() {
  const box = document.getElementById('settings-auth-profiles-recovery');
  if (!box) return;
  const status = _settingsState.authProfilesStatus;
  const show = !!(status && status.ok === false && status.recoverable === true);
  box.hidden = !show;
  const msg = document.getElementById('settings-auth-profiles-recovery-message');
  if (msg && show) {
    msg.textContent = status.reason === 'hosted_backend_unavailable'
      ? t('settings.auth_recovery.hosted_unavailable')
      : t('settings.auth_recovery.decrypt_failed');
  }
  if (!_settingsState.authProfilesRecoveryBound) {
    _settingsState.authProfilesRecoveryBound = true;
    const btn = document.getElementById('settings-auth-profiles-reset');
    if (btn) btn.addEventListener('click', _settingsResetAuthProfilesStore);
  }
}

async function _settingsResetAuthProfilesStore() {
  _settingsSetStatus('settings-auth-profiles-reset-status', '', t('settings.auth_recovery.resetting'));
  const res = await window.orkas.invoke('auth.resetProfilesStoreAfterDecryptFailure');
  if (!res || !res.ok) {
    _settingsSetStatus('settings-auth-profiles-reset-status', 'error', (res && res.error) || t('settings.auth_recovery.reset_failed'));
    return;
  }
  await _settingsRefreshAuthProfilesStatus();
  _settingsRenderAuthProfilesRecovery();
  await _settingsReload();
  _settingsSetStatus('settings-auth-profiles-reset-status', 'ok', t('settings.auth_recovery.reset_ok'));
}

async function _settingsRefreshCommanderBackend() {
  const res = await window.orkas.invoke('settings.getCommanderBackend');
  if (res && res.ok) {
    _settingsState.commanderBackendView = {
      settings: res.settings || { backend: 'orkas-core-agent', authEntryId: null, localCli: null },
      cloudConfigured: !!res.cloudConfigured,
    };
    return;
  }
  _settingsState.commanderBackendView = {
    settings: { backend: 'orkas-core-agent', authEntryId: null, localCli: null },
    cloudConfigured: false,
  };
}

function _settingsCommanderBackendOptions() {
  const view = _settingsState.commanderBackendView || {};
  return [
    {
      value: 'orkas-core-agent',
      label: t('settings.commander_backend.option_core'),
      hint: view.cloudConfigured
        ? t('settings.commander_backend.core_ready')
        : t('settings.commander_backend.core_needs_model'),
    },
  ];
}

function _settingsRenderCommanderBackend() {
  const el = document.getElementById('settings-commander-backend-select');
  if (!el) return;
  const view = _settingsState.commanderBackendView || {
    settings: { backend: 'orkas-core-agent', authEntryId: null, localCli: null },
    cloudConfigured: false,
  };
  const backend = 'orkas-core-agent';
  if (!_settingsState.commanderBackendSel || _settingsState.commanderBackendEl !== el) {
    _settingsState.commanderBackendEl = el;
    _settingsState.commanderBackendSel = _aiSelectMount(el, {
      placeholder: t('settings.commander_backend.pick_backend'),
    });
  }
  _settingsState.commanderBackendSel.setOptions(_settingsCommanderBackendOptions(), {
    value: backend,
    placeholder: t('settings.commander_backend.pick_backend'),
  });
  const detail = document.getElementById('settings-commander-backend-detail');
  if (detail) {
    detail.textContent = view.cloudConfigured
      ? t('settings.commander_backend.core_ready')
      : t('settings.commander_backend.core_needs_model');
  }

  if (!_settingsState.commanderBackendBound) {
    _settingsState.commanderBackendBound = true;
    const saveBtn = document.getElementById('settings-commander-backend-save');
    if (saveBtn) saveBtn.addEventListener('click', _settingsSaveCommanderBackend);
  }
}

async function _settingsSaveCommanderBackend() {
  const settings = { backend: 'orkas-core-agent', authEntryId: null, localCli: null };
  _settingsSetStatus('settings-commander-backend-status', '', t('settings.save_loading'));
  const res = await window.orkas.invoke('settings.setCommanderBackend', { settings });
  if (!res || !res.ok) {
    _settingsSetStatus('settings-commander-backend-status', 'error', (res && res.error) || t('settings.save_failed'));
    return;
  }
  await _settingsRefreshCommanderBackend();
  _settingsRenderCommanderBackend();
  if (typeof refreshModelGuard === 'function') refreshModelGuard().catch(() => {});
  _settingsSetStatus('settings-commander-backend-status', 'ok', t('settings.save_ok'));
}

function _settingsCustomProviderProtocolLabel(protocol) {
  const key = String(protocol || '').toLowerCase();
  if (key === 'anthropic') return t('settings.custom_providers.protocol_anthropic');
  if (key === 'openai') return t('settings.custom_providers.protocol_openai');
  if (key === 'gemini') return t('settings.custom_providers.protocol_gemini');
  return key || t('settings.custom_providers.protocol_unknown');
}

async function _settingsRefreshCustomProviders() {
  const res = await window.orkas.invoke('customProviders.list');
  _settingsState.customProviders = (res && res.ok && Array.isArray(res.providers)) ? res.providers : [];
}

async function _settingsRefreshCcswitchStatus() {
  const res = await window.orkas.invoke('customProviders.ccswitch.probe');
  _settingsState.ccswitchStatus = (res && res.ok !== false) ? res : { ok: false, available: false, error: (res && res.error) || t('settings.ccswitch.probe_failed') };
}

function _settingsRenderCcswitchStatus() {
  const statusEl = document.getElementById('settings-ccswitch-status');
  if (!statusEl) return;
  const status = _settingsState.ccswitchStatus || { ok: false, available: false };
  if (status.ok) {
    statusEl.className = 'settings-status ok';
    statusEl.textContent = status.available === false
      ? t('settings.ccswitch.not_available')
      : t('settings.ccswitch.ready');
  } else {
    statusEl.className = 'settings-status error';
    statusEl.textContent = status.error || t('settings.ccswitch.probe_failed');
  }
  const btn = document.getElementById('settings-ccswitch-preview-btn');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', _settingsOpenCcswitchPreviewDialog);
  }
}

function _settingsRenderCustomProviders() {
  const container = document.getElementById('settings-custom-provider-list');
  if (!container) return;
  container.innerHTML = '';
  const list = _settingsState.customProviders || [];
  const addBtn = document.getElementById('settings-custom-provider-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => _settingsOpenCustomProviderModal());
  }
  if (!list.length) {
    container.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.custom_providers.empty'))}</div>`;
    return;
  }
  list.forEach((provider) => {
    const row = document.createElement('div');
    row.className = 'entry-row settings-custom-provider-row';
    row.dataset.providerId = provider.id;

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    primary.innerHTML = `
      <span class="entry-provider">${escapeHtml(provider.name || provider.id)}</span>
      <span class="entry-sep">·</span>
      <span class="entry-model">${escapeHtml(_settingsCustomProviderProtocolLabel(provider.protocol))}</span>
      ${provider.apiKeyMasked ? `<span class="account-mask">${escapeHtml(provider.apiKeyMasked)}</span>` : ''}
    `;
    main.appendChild(primary);
    row.textContent = provider.name || provider.id;

    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    const metaBits = [provider.baseUrl, Array.isArray(provider.models) ? `${provider.models.length}` : '', provider.source ? t(`settings.custom_providers.source_${provider.source}`) : ''].filter(Boolean);
    meta.textContent = metaBits.join(' · ');
    main.appendChild(meta);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = t('settings.edit');
    editBtn.addEventListener('click', () => _settingsOpenCustomProviderModal(provider));
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('settings.delete');
    delBtn.addEventListener('click', async () => {
      const ok = typeof uiConfirm === 'function' ? await uiConfirm(t('settings.custom_providers.confirm_delete', { name: provider.name || provider.id })) : true;
      if (!ok) return;
      _settingsSetStatus('settings-custom-providers-status', 'busy', t('settings.custom_providers.deleting'));
      const res = await window.orkas.invoke('customProviders.remove', { id: provider.id });
      if (!res || !res.ok) {
        _settingsSetStatus('settings-custom-providers-status', 'error', (res && res.error) || t('settings.custom_providers.delete_failed'));
        return;
      }
      await _settingsRefreshCustomProviders();
      _settingsRenderCustomProviders();
      _settingsSetStatus('settings-custom-providers-status', 'ok', t('settings.custom_providers.delete_ok'));
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function _settingsOpenCustomProviderModal(provider = null) {
  const overlay = document.getElementById('settings-custom-provider-modal');
  const title = document.getElementById('settings-custom-provider-modal-title');
  const body = document.getElementById('settings-custom-provider-modal-body');
  const actions = document.getElementById('settings-custom-provider-modal-actions');
  const status = document.getElementById('settings-custom-provider-modal-status');
  if (!overlay || !title || !body || !actions || !status) return;
  const editing = !!provider?.id;
  title.textContent = editing ? t('settings.custom_providers.edit_title') : t('settings.custom_providers.add_title');
  body.innerHTML = `
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.name'))}</label><input id="settings-custom-provider-name" type="text" class="form-input" autocomplete="off" spellcheck="false" /></div>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.protocol'))}</label><select id="settings-custom-provider-protocol" class="form-input"><option value="anthropic">${escapeHtml(t('settings.custom_providers.protocol_anthropic'))}</option><option value="openai">${escapeHtml(t('settings.custom_providers.protocol_openai'))}</option><option value="gemini">${escapeHtml(t('settings.custom_providers.protocol_gemini'))}</option></select></div>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.base_url'))}</label><input id="settings-custom-provider-base-url" type="text" class="form-input" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1" /></div>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.api_key'))}</label><input id="settings-custom-provider-api-key" type="text" class="form-input" autocomplete="off" spellcheck="false" placeholder="sk-…" /></div>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.models'))}</label><input id="settings-custom-provider-models" type="text" class="form-input" autocomplete="off" spellcheck="false" placeholder="gpt-4.1-mini, claude-3-5-sonnet" /></div>
  `;
  const nameInput = body.querySelector('#settings-custom-provider-name') || document.getElementById('settings-custom-provider-name');
  const protocolInput = body.querySelector('#settings-custom-provider-protocol') || document.getElementById('settings-custom-provider-protocol');
  const baseUrlInput = body.querySelector('#settings-custom-provider-base-url') || document.getElementById('settings-custom-provider-base-url');
  const apiKeyInput = body.querySelector('#settings-custom-provider-api-key') || document.getElementById('settings-custom-provider-api-key');
  const modelsInput = body.querySelector('#settings-custom-provider-models') || document.getElementById('settings-custom-provider-models');
  if (nameInput) nameInput.value = provider?.name || '';
  if (protocolInput) protocolInput.value = provider?.protocol || 'anthropic';
  if (baseUrlInput) baseUrlInput.value = provider?.baseUrl || '';
  if (apiKeyInput) apiKeyInput.value = '';
  if (apiKeyInput && provider?.apiKeyMasked) apiKeyInput.placeholder = t('settings.custom_providers.api_key_placeholder_masked');
  if (modelsInput) modelsInput.value = Array.isArray(provider?.models) ? provider.models.join(', ') : '';
  actions.innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.addEventListener('click', () => _settingsCloseModal(overlay));
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = t('settings.save');
  saveBtn.addEventListener('click', async () => {
    const name = String(nameInput?.value || '').trim();
    const protocol = String(protocolInput?.value || 'anthropic').trim();
    const baseUrl = String(baseUrlInput?.value || '').trim();
    const apiKey = String(apiKeyInput?.value || '').trim();
    const models = String(modelsInput?.value || '').split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
    if (!baseUrl) { status.textContent = t('settings.custom_providers.error_base_url'); status.className = 'form-msg error'; return; }
    const payload = { name, protocol, baseUrl, models, source: provider?.source || 'manual' };
    if (apiKey) payload.apiKey = apiKey;
    if (provider?.id) payload.id = provider.id;
    status.textContent = t('settings.custom_providers.saving');
    status.className = 'form-msg';
    saveBtn.disabled = true;
    const channel = provider?.id ? 'customProviders.update' : 'customProviders.add';
    const res = await window.orkas.invoke(channel, payload);
    saveBtn.disabled = false;
    if (!res || !res.ok) {
      status.textContent = (res && res.error) || t('settings.custom_providers.save_failed');
      status.className = 'form-msg error';
      return;
    }
    await _settingsRefreshCustomProviders();
    _settingsRenderCustomProviders();
    _settingsCloseModal(overlay);
    _settingsSetStatus('settings-custom-providers-status', 'ok', editing ? t('settings.custom_providers.update_ok') : t('settings.custom_providers.add_ok'));
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  _settingsOpenModal(overlay);
}

async function _settingsOpenCcswitchPreviewDialog() {
  const overlay = document.getElementById('settings-ccswitch-preview-modal');
  const title = document.getElementById('settings-ccswitch-preview-modal-title');
  const body = document.getElementById('settings-ccswitch-preview-modal-body');
  const actions = document.getElementById('settings-ccswitch-preview-modal-actions');
  const status = document.getElementById('settings-ccswitch-preview-modal-status');
  if (!overlay || !title || !body || !actions || !status) return;
  title.textContent = t('settings.ccswitch.preview_title');
  status.textContent = t('settings.ccswitch.loading');
  status.className = 'form-msg';
  const res = await window.orkas.invoke('customProviders.ccswitch.preview');
  _settingsState.ccswitchPreviewRows = (res && res.ok && Array.isArray(res.rows)) ? res.rows : (res && res.ok && Array.isArray(res.items) ? res.items : []);
  _settingsState.ccswitchPreviewSelectedIds = _settingsState.ccswitchPreviewRows.filter((row) => row.selected !== false).map((row) => row.externalId);
  _settingsRenderCcswitchPreviewDialog();
  _settingsOpenModal(overlay);
}

function _settingsRenderCcswitchPreviewDialog() {
  const overlay = document.getElementById('settings-ccswitch-preview-modal');
  const body = document.getElementById('settings-ccswitch-preview-modal-body');
  const actions = document.getElementById('settings-ccswitch-preview-modal-actions');
  const status = document.getElementById('settings-ccswitch-preview-modal-status');
  if (!overlay || !body || !actions || !status) return;
  body.innerHTML = '';
  const rows = _settingsState.ccswitchPreviewRows || [];
  if (!rows.length) {
    body.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.ccswitch.preview_empty'))}</div>`;
  } else {
    rows.forEach((row) => {
      const item = document.createElement('label');
      item.className = 'settings-ccswitch-row';
      item.textContent = `${row.name || row.externalId} ${(row.missingKey || row.needsKey) ? t('settings.ccswitch.missing_key') : ''}`.trim();
      item.innerHTML = `
        <input type="checkbox" ${_settingsState.ccswitchPreviewSelectedIds.includes(row.externalId) ? 'checked' : ''} />
        <span class="settings-ccswitch-row-main">${escapeHtml(row.name || row.externalId)}</span>
        <span class="settings-ccswitch-row-meta">${escapeHtml(_settingsCustomProviderProtocolLabel(row.protocol))}${(row.missingKey || row.needsKey) ? ` · ${escapeHtml(t('settings.ccswitch.missing_key'))}` : ''}${row.maskedKey || row.apiKeyMasked ? ` · ${escapeHtml(row.maskedKey || row.apiKeyMasked)}` : ''}</span>
      `;
      const cb = item.querySelector('input');
      cb?.addEventListener('change', () => {
        if (cb.checked) {
          if (!_settingsState.ccswitchPreviewSelectedIds.includes(row.externalId)) _settingsState.ccswitchPreviewSelectedIds.push(row.externalId);
        } else {
          _settingsState.ccswitchPreviewSelectedIds = _settingsState.ccswitchPreviewSelectedIds.filter((id) => id !== row.externalId);
        }
      });
      body.appendChild(item);
    });
  }
  actions.innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = t('common.close');
  cancelBtn.addEventListener('click', () => _settingsCloseModal(overlay));
  const syncBtn = document.createElement('button');
  syncBtn.className = 'btn btn-primary';
  syncBtn.id = 'settings-ccswitch-preview-sync-btn';
  syncBtn.textContent = t('settings.ccswitch.sync');
  syncBtn.addEventListener('click', async () => {
    status.textContent = t('settings.ccswitch.syncing');
    status.className = 'form-msg';
    const res = await window.orkas.invoke('customProviders.ccswitch.sync', { externalIds: _settingsState.ccswitchPreviewSelectedIds });
    if (!res || !res.ok) {
      status.textContent = (res && res.error) || t('settings.ccswitch.sync_failed');
      status.className = 'form-msg error';
      return;
    }
    await _settingsRefreshCustomProviders();
    await _settingsRefreshCcswitchStatus();
    _settingsRenderCustomProviders();
    _settingsRenderCcswitchStatus();
    _settingsCloseModal(overlay);
    _settingsSetStatus('settings-ccswitch-status', 'ok', t('settings.ccswitch.sync_ok'));
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(syncBtn);
  if (overlay.classList.contains('open')) overlay.classList.add('open');
}

function _settingsSyncCustomModelFields(providerId) {
  const provider = _settingsState.providers.find((p) => p.id === providerId);
  const box = document.getElementById('settings-custom-model-fields');
  if (!box) return;
  box.hidden = !(provider && provider.manualModel);
}

async function _settingsGetModels(providerId) {
  if (!providerId) return [];
  if (_settingsState.modelsCache[providerId]) return _settingsState.modelsCache[providerId];
  const res = await window.orkas.invoke('auth.listModels', { provider: providerId });
  const list = (res && res.ok && Array.isArray(res.models)) ? res.models : [];
  _settingsState.modelsCache[providerId] = list;
  return list;
}

// ── Picker (provider + model + add button) ──

async function _settingsRenderPicker() {
  const providerEl = document.getElementById('settings-picker-provider');
  const modelEl    = document.getElementById('settings-picker-model');
  if (!providerEl || !modelEl) return;

  const providerOptions = _settingsState.providers.map((p) => {
    const baseLabel = p.label || p.id;
    const label = p.recommended ? `${baseLabel} ${t('settings.picker.recommended_suffix')}` : baseLabel;
    let authHint = '';
    if (p.supportsOAuth && p.supportsApiKey)       authHint = t('settings.oauth.support_api_and_oauth');
    else if (p.supportsOAuth && !p.supportsApiKey) authHint = t('settings.oauth.support_oauth_only');
    else if (p.supportsApiKey)                     authHint = t('settings.oauth.support_api_only');
    // subscriptionNote is the "wrong-account → 401 wastes the key"
    // class of critical prerequisite, so it goes first; the auth
    // capability hint comes second. Join with ' · ' when both exist.
    // subscriptionNote is an i18n key (see the field comment in
    // provider_catalog.ts) — translated on render.
    const subNote = p.subscriptionNote ? t(p.subscriptionNote) : '';
    const hint = [subNote, authHint].filter(Boolean).join(' · ');
    return { value: p.id, label, hint };
  });

  const prevProvider = _settingsState.pickerProviderSel?.getValue()
    || providerEl.dataset.value
    || '';
  if (!_settingsState.pickerProviderSel || _settingsState.pickerProviderEl !== providerEl) {
    _settingsState.pickerProviderEl = providerEl;
    _settingsState.pickerProviderSel = _aiSelectMount(providerEl, {
      placeholder: t('settings.picker.select_provider'),
    });
    _settingsState.pickerProviderSel.onChange(async (val) => {
      _settingsSyncCustomModelFields(val);
      await _settingsPopulatePickerModel(val, '');
      _settingsSetStatus('settings-picker-status', '', '');
    });
  }
  _settingsState.pickerProviderSel.setOptions(providerOptions, {
    value: prevProvider,
    placeholder: t('settings.picker.select_provider'),
  });
  _settingsSyncCustomModelFields(_settingsState.pickerProviderSel.getValue());

  const prevModel = _settingsState.pickerModelSel?.getValue()
    || modelEl.dataset.value
    || '';
  if (!_settingsState.pickerModelSel || _settingsState.pickerModelEl !== modelEl) {
    _settingsState.pickerModelEl = modelEl;
    _settingsState.pickerModelSel = _aiSelectMount(modelEl, {
      placeholder: t('settings.picker.pick_provider_first'),
    });
    _settingsState.pickerModelSel.onChange((val) => {
      _settingsSetStatus('settings-picker-status', '', '');
    });
  }
  await _settingsPopulatePickerModel(
    _settingsState.pickerProviderSel.getValue(),
    prevModel,
  );

  const addBtn = document.getElementById('settings-add-entry-btn');
  if (addBtn && _settingsState.addBtnEl !== addBtn) {
    _settingsState.addBtnEl = addBtn;
    addBtn.addEventListener('click', _settingsClickAddEntry);
    for (const id of ['settings-custom-label-input', 'settings-custom-base-url-input', 'settings-custom-model-input', 'settings-custom-api-key-input']) {
      const input = document.getElementById(id);
      if (!input || input.dataset.boundCustomModel) continue;
      input.dataset.boundCustomModel = '1';
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { _settingsClickAddEntry(); e.preventDefault(); }
      });
    }
  }
}

async function _settingsPopulatePickerModel(providerId, selected) {
  const sel = _settingsState.pickerModelSel;
  if (!sel) return;
  const provider = _settingsState.providers.find((p) => p.id === providerId);
  if (provider && provider.manualModel) {
    sel.setOptions([], { value: '', placeholder: t('settings.picker.manual_model_in_form') });
    return;
  }
  const models = await _settingsGetModels(providerId);
  sel.setOptions(
    models.map((m) => ({ value: m.id, label: m.name || m.id })),
    { value: selected || '', placeholder: providerId ? t('settings.picker.select_model') : t('settings.picker.pick_provider_first') },
  );
}

async function _settingsAddManualModelEntry(provider) {
  const labelEl = document.getElementById('settings-custom-label-input');
  const baseUrlEl = document.getElementById('settings-custom-base-url-input');
  const modelEl = document.getElementById('settings-custom-model-input');
  const keyEl = document.getElementById('settings-custom-api-key-input');
  const label = (labelEl?.value || '').trim();
  const baseUrl = (baseUrlEl?.value || '').trim();
  const model = (modelEl?.value || '').trim();
  const apiKey = (keyEl?.value || '').trim();
  if (!baseUrl) { _settingsSetStatus('settings-picker-status', 'error', t('settings.modal.base_url_required')); return; }
  if (!model) { _settingsSetStatus('settings-picker-status', 'error', t('settings.modal.model_required')); return; }
  if (!apiKey) { _settingsSetStatus('settings-picker-status', 'error', t('settings.paste_key_first')); return; }

  _settingsSetStatus('settings-picker-status', '', t('settings.save_loading'));
  const addRes = await window.orkas.invoke('auth.addApiKey', {
    provider: provider.id,
    apiKey,
    label: label || undefined,
    baseUrl,
  });
  if (!addRes || !addRes.ok) {
    _settingsSetStatus('settings-picker-status', 'error', (addRes && addRes.error) || t('settings.save_failed'));
    return;
  }
  const entryRes = await window.orkas.invoke('auth.addEntry', {
    provider: provider.id,
    model,
    profileId: addRes.profileId,
  });
  if (!entryRes || !entryRes.ok) {
    _settingsSetStatus('settings-picker-status', 'error', (entryRes && entryRes.error) || t('settings.add_entry_failed'));
    return;
  }
  _settingsSetStatus('settings-picker-status', 'ok', t('settings.save_ok'));
  if (keyEl) keyEl.value = '';
  await _settingsReload();
}

async function _settingsClickAddEntry() {
  const providerId = _settingsState.pickerProviderSel?.getValue() || '';
  let modelId    = _settingsState.pickerModelSel?.getValue() || '';
  if (!providerId) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_provider_needed')); return; }

  const provider = _settingsState.providers.find((p) => p.id === providerId);
  if (!provider) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_provider_missing')); return; }
  if (provider.manualModel) {
    await _settingsAddManualModelEntry(provider);
    return;
  }
  if (!modelId) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_model_needed')); return; }

  _settingsSetStatus('settings-picker-status', '', '');
  _settingsChooseAccountMethod(provider, modelId);
}

// ── Method chooser + credential forms ──

function _settingsChooseAccountMethod(provider, modelId) {

  const hasApi   = !!provider.supportsApiKey;
  const hasOAuth = !!provider.supportsOAuth;

  if (hasApi && hasOAuth) {
    // Present the two-tile chooser first.
    const overlay = document.getElementById('add-account-modal');
    const title   = document.getElementById('add-account-title');
    const body    = document.getElementById('add-account-body');
    const actions = document.getElementById('add-account-actions');
    if (!overlay || !title || !body || !actions) return;

    title.textContent = t('settings.modal.add_account_title_with_provider', { provider: provider.label || provider.id });
    body.innerHTML = `
      <div class="method-chooser">
        <div class="method-tile" data-method="api_key">
          <div class="method-title">${escapeHtml(t('settings.modal.method_api_title'))}</div>
          <div class="method-hint">${escapeHtml(t('settings.modal.method_api_hint'))}</div>
        </div>
        <div class="method-tile" data-method="oauth">
          <div class="method-title">${escapeHtml(t('settings.modal.method_oauth_title'))}</div>
          <div class="method-hint">${escapeHtml(t('settings.modal.method_oauth_hint'))}</div>
        </div>
      </div>
    `;
    actions.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = t('common.cancel');
    cancelBtn.onclick = () => _settingsCloseModal(overlay);
    actions.appendChild(cancelBtn);

    body.querySelector('.method-chooser').addEventListener('click', (e) => {
      const tile = e.target.closest('.method-tile');
      if (!tile) return;
      const method = tile.dataset.method;
      _settingsCloseModal(overlay);
      if (method === 'api_key') _settingsShowApiKeyForm(provider, modelId);
      else _settingsStartOAuthFlow(provider, modelId);
    });

    _settingsOpenModal(overlay);
    return;
  }

  if (hasOAuth && !hasApi) { _settingsStartOAuthFlow(provider, modelId); return; }
  _settingsShowApiKeyForm(provider, modelId);
}

function _settingsShowApiKeyForm(provider, modelId) {
  const overlay = document.getElementById('add-account-modal');
  const title   = document.getElementById('add-account-title');
  const body    = document.getElementById('add-account-body');
  const actions = document.getElementById('add-account-actions');
  if (!overlay || !title || !body || !actions) return;

  title.textContent = t('settings.modal.api_key_form_title', { provider: provider.label || provider.id });
  // docs_prefix has `{url}` which we fill with a marked-up span; escape the
  // surrounding text but keep the span as raw HTML.
  const docsUrlMarkup = `<span class="form-hint-url">${escapeHtml(provider.docsUrl || '')}</span>`;
  const docsRaw = t('settings.modal.docs_prefix', { url: '\u0001URL\u0001' });
  const docsHtml = provider.docsUrl
    ? `<div class="form-hint">${escapeHtml(docsRaw).replace(escapeHtml('\u0001URL\u0001'), docsUrlMarkup)}</div>`
    : '';
  const subNoteHtml = provider.subscriptionNote
    ? `<div class="form-hint form-hint-warn">${escapeHtml(t(provider.subscriptionNote))}</div>`
    : '';
  const manualModelHtml = provider.manualModel ? `
    <div class="form-row">
      <label>${escapeHtml(t('settings.modal.base_url'))}</label>
      <input type="text" class="api-base-url-input form-input" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false" />
    </div>
    <div class="form-row">
      <label>${escapeHtml(t('settings.modal.model_id'))}</label>
      <input type="text" class="api-model-input form-input" placeholder="gpt-4o-mini" autocomplete="off" spellcheck="false" />
    </div>
  ` : '';
  body.innerHTML = `
    ${subNoteHtml}
    <div class="form-row">
      <label>${escapeHtml(t('settings.modal.label'))}</label>
      <input type="text" class="api-label-input form-input" placeholder="${escapeHtml(t('settings.modal.label_placeholder'))}" autocomplete="off" spellcheck="false" />
    </div>
    ${manualModelHtml}
    <div class="form-row">
      <label>API Key</label>
      <input type="text" class="api-key-input form-input" placeholder="sk-…" autocomplete="off" spellcheck="false" />
    </div>
    ${docsHtml}
    <div class="form-msg"></div>
  `;
  actions.innerHTML = '';

  const labelInput = body.querySelector('.api-label-input');
  const keyInput   = body.querySelector('.api-key-input');
  const baseUrlInput = body.querySelector('.api-base-url-input');
  const modelInput = body.querySelector('.api-model-input');
  const msg        = body.querySelector('.form-msg');

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.onclick = () => _settingsCloseModal(overlay);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = t('settings.save');
  const save = async () => {
    const label  = (labelInput.value || '').trim();
    const apiKey = (keyInput.value || '').trim();
    const customBaseUrl = baseUrlInput ? (baseUrlInput.value || '').trim() : '';
    const customModelId = modelInput ? (modelInput.value || '').trim() : modelId;
    if (provider.manualModel && !customBaseUrl) { msg.textContent = t('settings.modal.base_url_required'); msg.className = 'form-msg error'; return; }
    if (provider.manualModel && !customModelId) { msg.textContent = t('settings.modal.model_required'); msg.className = 'form-msg error'; return; }
    if (!apiKey) { msg.textContent = t('settings.paste_key_first'); msg.className = 'form-msg error'; return; }
    saveBtn.disabled = true;
    msg.textContent = t('settings.save_loading'); msg.className = 'form-msg';
    _settingsLog.info('add api key', { provider: provider.id, model: customModelId, has_label: !!label, has_base_url: !!customBaseUrl });
    const addRes = await window.orkas.invoke('auth.addApiKey', {
      provider: provider.id,
      apiKey,
      label: label || undefined,
      ...(customBaseUrl ? { baseUrl: customBaseUrl } : {}),
    });
    if (!addRes || !addRes.ok) {
      saveBtn.disabled = false;
      msg.textContent = (addRes && addRes.error) || t('settings.save_failed');
      msg.className = 'form-msg error';
      _settingsLog.warn('add api key failed', { provider: provider.id, error: addRes && addRes.error });
      return;
    }
    const entryRes = await window.orkas.invoke('auth.addEntry', {
      provider: provider.id,
      model: customModelId,
      profileId: addRes.profileId,
    });
    saveBtn.disabled = false;
    if (!entryRes || !entryRes.ok) {
      msg.textContent = (entryRes && entryRes.error) || t('settings.add_entry_failed');
      msg.className = 'form-msg error';
      return;
    }
    _settingsCloseModal(overlay);
    await _settingsReload();
  };
  saveBtn.onclick = save;
  // IME guard (CLAUDE.md §8): Enter on these inputs advances focus / saves;
  // skip while a Chinese / Japanese / Korean candidate is being composed.
  labelInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { (baseUrlInput || modelInput || keyInput).focus(); e.preventDefault(); }
  });
  if (baseUrlInput) baseUrlInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { (modelInput || keyInput).focus(); e.preventDefault(); }
  });
  if (modelInput) modelInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { keyInput.focus(); e.preventDefault(); }
  });
  keyInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { save(); e.preventDefault(); }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  _settingsOpenModal(overlay);
  setTimeout(() => labelInput.focus(), 0);
}

function _settingsOpenModal(overlay) {
  overlay.classList.add('open');
  const onKey = (e) => { if (e.key === 'Escape') _settingsCloseModal(overlay, onKey); };
  overlay._onKey = onKey;
  document.addEventListener('keydown', onKey, true);
}

function _settingsCloseModal(overlay) {
  overlay.classList.remove('open');
  if (overlay._onKey) {
    document.removeEventListener('keydown', overlay._onKey, true);
    delete overlay._onKey;
  }
}

// ── OAuth flow modal ──

let _oauthFlowPollTimer = null;
let _oauthFlowId        = null;
let _oauthFlowTarget    = null; // { provider, modelId }

async function _settingsStartOAuthFlow(provider, modelId) {
  const overlay   = document.getElementById('oauth-flow-modal');
  const title     = document.getElementById('oauth-flow-title');
  const body      = document.getElementById('oauth-flow-body');
  const closeBtn  = document.getElementById('oauth-flow-close-btn');
  if (!overlay || !title || !body || !closeBtn) return;

  // OAuth back-end may be different from the user-picked provider (e.g.
  // openai → openai-codex). `oauthProvider` is the id we actually log into.
  const oauthProviderId = provider.oauthProvider || provider.id;
  const aliased = oauthProviderId !== provider.id;

  _oauthFlowTarget = { provider, modelId, oauthProviderId };
  title.textContent = t('settings.oauth.title_prefix', { provider: provider.label || provider.id });
  const aliasTip = aliased
    ? `<div class="oauth-flow-hint">${escapeHtml(t('settings.oauth.alias_tip', { provider: oauthProviderId }))}</div>`
    : '';
  body.innerHTML = `<div class="oauth-flow-stage">${escapeHtml(t('settings.oauth.starting'))}</div>${aliasTip}`;
  overlay.classList.add('open');

  const closeFlow = () => {
    if (_oauthFlowPollTimer) { clearInterval(_oauthFlowPollTimer); _oauthFlowPollTimer = null; }
    if (_oauthFlowId) {
      window.orkas.invoke('auth.cancelOAuthFlow', { flowId: _oauthFlowId }).catch(() => {});
    }
    _oauthFlowId = null;
    _oauthFlowTarget = null;
    overlay.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') closeFlow(); };
  closeBtn.onclick = closeFlow;
  document.addEventListener('keydown', onKey, true);

  _settingsLog.info('oauth start', { provider: oauthProviderId });
  const startRes = await window.orkas.invoke('auth.startOAuth', { provider: oauthProviderId });
  if (!startRes || !startRes.ok) {
    body.innerHTML = `<div class="oauth-flow-stage error">${escapeHtml((startRes && startRes.error) || t('settings.oauth.start_failed'))}</div>`;
    _settingsLog.warn('oauth start failed', { provider: oauthProviderId, error: startRes && startRes.error });
    return;
  }
  _oauthFlowId = startRes.flowId;

  let lastKind = '';
  _oauthFlowPollTimer = setInterval(async () => {
    if (!_oauthFlowId) return;
    const res = await window.orkas.invoke('auth.pollOAuthFlow', { flowId: _oauthFlowId });
    if (!res || !res.ok) return;
    const status = res.status || {};
    if (status.kind === lastKind && status.kind !== 'done' && status.kind !== 'error') return;
    lastKind = status.kind;
    _oauthFlowRender(provider, status, closeFlow);
  }, 400);
}

function _oauthFlowRender(provider, status, closeFlow) {
  const body = document.getElementById('oauth-flow-body');
  if (!body) return;

  if (status.kind === 'starting' || status.kind === 'progress') {
    body.innerHTML = `<div class="oauth-flow-stage">${escapeHtml(status.message || t('settings.oauth.processing'))}</div>`;
    return;
  }

  if (status.kind === 'awaiting_auth') {
    const url = status.url || '';
    const instructions = status.instructions || '';
    // Device-code flows (e.g. MiniMax) don't run a local callback server,
    // so the "paste callback URL" box doesn't apply — the user_code in
    // instructions is what carries the flow forward.
    const usesCallbackServer = status.usesCallbackServer !== false;
    const topHint = usesCallbackServer
      ? t('settings.oauth.top_hint_browser')
      : t('settings.oauth.top_hint_page');
    const subHint = usesCallbackServer
      ? t('settings.oauth.sub_hint_callback')
      : t('settings.oauth.sub_hint_devicecode');
    body.innerHTML = `
      <div class="oauth-flow-stage">${escapeHtml(topHint)}</div>
      <div class="oauth-flow-hint">${escapeHtml(subHint)}</div>
      <div class="oauth-flow-actions">
        <button class="btn oauth-open-btn">${escapeHtml(t('settings.oauth.reopen'))}</button>
        <button class="btn oauth-copy-btn">${escapeHtml(t('settings.oauth.copy_link'))}</button>
      </div>
      ${(!usesCallbackServer && instructions) ? `<div class="oauth-flow-tip oauth-flow-tip-multiline">${escapeHtml(instructions)}</div>` : ''}
      ${usesCallbackServer ? `
      <div class="oauth-manual-row">
        <input type="text" class="oauth-manual-input form-input" placeholder="${escapeHtml(t('settings.oauth.manual_placeholder'))}" autocomplete="off" spellcheck="false" />
        <button class="btn oauth-manual-submit-btn">${escapeHtml(t('settings.oauth.submit'))}</button>
      </div>` : ''}
    `;
    body.querySelector('.oauth-open-btn').onclick = () => {
      window.orkas.invoke('auth.openExternal', { url }).catch(() => {});
    };
    body.querySelector('.oauth-copy-btn').onclick = async () => {
      try { await navigator.clipboard.writeText(url); } catch (_) {}
    };
    if (usesCallbackServer) {
      const input = body.querySelector('.oauth-manual-input');
      const submit = async () => {
        const val = (input.value || '').trim();
        if (!val) return;
        body.innerHTML = `<div class="oauth-flow-stage">${escapeHtml(t('settings.oauth.submitting'))}</div>`;
        await window.orkas.invoke('auth.submitOAuthInput', { flowId: _oauthFlowId, value: val });
      };
      body.querySelector('.oauth-manual-submit-btn').onclick = submit;
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { submit(); e.preventDefault(); }
      });
    }
    return;
  }

  if (status.kind === 'awaiting_input') {
    const prompt = status.prompt || {};
    const msg = prompt.message || t('settings.oauth.enter_prompt_fallback');
    const placeholder = prompt.placeholder || '';
    body.innerHTML = `
      <div class="oauth-flow-stage">${escapeHtml(msg)}</div>
      <div class="form-row">
        <input type="text" class="oauth-input form-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" />
      </div>
      <div class="oauth-flow-actions">
        <button class="btn btn-primary oauth-submit-btn">${escapeHtml(t('settings.oauth.submit'))}</button>
      </div>
    `;
    const input = body.querySelector('.oauth-input');
    const submit = async () => {
      const val = input.value || '';
      if (!val && !prompt.allowEmpty) return;
      body.innerHTML = `<div class="oauth-flow-stage">${escapeHtml(t('settings.oauth.submitting'))}</div>`;
      await window.orkas.invoke('auth.submitOAuthInput', { flowId: _oauthFlowId, value: val });
    };
    body.querySelector('.oauth-submit-btn').onclick = submit;
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { submit(); e.preventDefault(); }
    });
    setTimeout(() => input.focus(), 0);
    return;
  }

  if (status.kind === 'done') {
    const target = _oauthFlowTarget;
    const profileId = status.profileId || '';
    body.innerHTML = `<div class="oauth-flow-stage ok">${escapeHtml(t('settings.oauth.success_writing'))}</div>`;
    if (_oauthFlowPollTimer) { clearInterval(_oauthFlowPollTimer); _oauthFlowPollTimer = null; }
    (async () => {
      if (target && target.modelId && profileId) {
        // profileId is namespaced with the OAuth back-end provider (e.g.
        // `openai-codex:default`), so the entry must use the same provider
        // or addEntry will reject it as a cross-provider mismatch.
        const entryProvider = target.oauthProviderId || target.provider.id;
        // The user picked a model from the user-facing provider (e.g.
        // `openai`), but OAuth's back-end (e.g. `openai-codex`) may expose
        // a different model list. Remap to a supported model if needed, or
        // the chat-time call will throw "model not found".
        let model = target.modelId;
        if (entryProvider !== target.provider.id) {
          const modelsRes = await window.orkas.invoke('auth.listModels', { provider: entryProvider });
          const supported = (modelsRes && modelsRes.ok && Array.isArray(modelsRes.models)) ? modelsRes.models : [];
          const hit = supported.find(m => m.id === model);
          if (!hit && supported.length) model = supported[0].id;
        }
        await window.orkas.invoke('auth.addEntry', {
          provider: entryProvider,
          model,
          profileId,
        });
      }
      closeFlow();
      await _settingsReload();
    })();
    return;
  }

  if (status.kind === 'error') {
    body.innerHTML = `<div class="oauth-flow-stage error">${escapeHtml(status.error || t('settings.oauth.auth_failed'))}</div>`;
    if (_oauthFlowPollTimer) { clearInterval(_oauthFlowPollTimer); _oauthFlowPollTimer = null; }
    return;
  }
}

// ── Entries list (priority, drag-reorderable) ──

function _settingsRenderEntries() {
  const container = document.getElementById('settings-entries');
  if (!container) return;
  container.innerHTML = '';

  if (!_settingsState.entries.length) {
    container.innerHTML = `<div class="settings-empty" data-i18n="settings.entries.empty">${escapeHtml(t('settings.entries.empty'))}</div>`;
    return;
  }

  _settingsState.entries.forEach((entry, idx) => {
    container.appendChild(_settingsRenderEntryRow(entry, idx));
  });
}

function _settingsEntryModelState(entry, list) {
  const unavailable = entry.modelAvailable === false;
  return {
    unavailable,
    options: list.map(m => ({ value: m.id, label: m.name || m.id })),
    value: unavailable ? '' : entry.model,
    placeholder: unavailable
      ? t('settings.entries.model_unavailable')
      : (entry.modelName || entry.model),
  };
}

function _settingsRenderEntryRow(entry, idx) {
  const row = document.createElement('div');
  row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
  row.dataset.entryId = entry.entryId;
  row.draggable = true;

  const rank = document.createElement('div');
  rank.className = 'entry-rank';
  rank.textContent = idx === 0 ? t('settings.entries.default_tag') : `#${idx + 1}`;
  row.appendChild(rank);

  const main = document.createElement('div');
  main.className = 'entry-main';
  const primary = document.createElement('div');
  primary.className = 'entry-primary';
  primary.innerHTML = `
    <span class="entry-provider">${escapeHtml(entry.providerLabel || entry.provider)}</span>
    <span class="entry-sep">·</span>
    <div class="ai-select ai-select-compact entry-model-select"></div>
    <span class="entry-account-chip" title="${escapeHtml(t('settings.entries.account_title'))}">@ ${escapeHtml(entry.profileLabel || '')}</span>
  `;
  main.appendChild(primary);

  // Inline model picker — lets users switch the entry's model without
  // deleting + re-adding. auth.listModels is the complete whitelist; a saved
  // model that left the catalog remains visible only as a remediation row and
  // is never injected back into these options.
  const modelEl = primary.querySelector('.entry-model-select');
  const initialModelState = _settingsEntryModelState(entry, []);
  const modelUnavailable = initialModelState.unavailable;
  const modelSel = _aiSelectMount(modelEl, {
    placeholder: initialModelState.placeholder,
  });
  // Prevent drag from starting when interacting with the picker.
  modelEl.addEventListener('mousedown', (e) => e.stopPropagation());
  modelEl.setAttribute('draggable', 'false');
  (async () => {
    const res = await window.orkas.invoke('auth.listModels', { provider: entry.provider });
    const list = (res && res.ok && Array.isArray(res.models)) ? res.models : [];
    const modelState = _settingsEntryModelState(entry, list);
    modelSel.setOptions(modelState.options, {
      value: modelState.value,
      placeholder: modelState.placeholder,
    });
    modelSel.onChange(async (val) => {
      if (!val || val === entry.model) return;
      const up = await window.orkas.invoke('auth.updateEntryModel', { entryId: entry.entryId, model: val });
      if (!up || !up.ok) {
        await uiAlert((up && up.error) || t('settings.entries.switch_model_failed'));
        modelSel.setValue(entry.model);
        return;
      }
      await _settingsReload();
    });
  })();

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  const badge = document.createElement('span');
  if (entry.profileType === 'oauth') {
    badge.className = 'account-type-badge oauth' + (entry.oauthExpired ? ' expired' : '');
    badge.textContent = entry.oauthExpired ? t('settings.entries.oauth_expired') : t('settings.entries.oauth_badge');
  } else if (entry.profileType === 'managed') {
    badge.className = 'account-type-badge';
    badge.textContent = 'Mate Agent';
  } else {
    badge.className = 'account-type-badge';
    badge.textContent = 'API Key';
  }
  meta.appendChild(badge);

  if (entry.profileMasked) {
    const mask = document.createElement('span');
    mask.className = 'account-mask';
    mask.textContent = entry.profileMasked;
    meta.appendChild(mask);
  }
  main.appendChild(meta);

  const status = document.createElement('div');
  status.className = 'entry-status';
  if (modelUnavailable) {
    status.className += ' error';
    status.textContent = t('settings.entries.model_unavailable');
  }
  main.appendChild(status);
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  const testBtn = document.createElement('button');
  testBtn.className = 'icon-btn';
  testBtn.textContent = t('settings.entries.test');
  testBtn.onclick = () => _settingsTestEntry(entry, status);
  actions.appendChild(testBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn danger';
  delBtn.textContent = t('common.delete');
  delBtn.onclick = () => _settingsRemoveEntry(entry);
  actions.appendChild(delBtn);

  row.appendChild(actions);

  _settingsAttachReorderDnd(row, {
    kind: 'chat',
    id: entry.entryId,
    getIds: () => _settingsState.entries.map((e) => e.entryId),
    ipcName: 'auth.reorderEntries',
    onSuccess: (res) => {
      _settingsState.entries = Array.isArray(res.entries) ? res.entries : _settingsState.entries;
      _settingsRenderEntries();
    },
  });

  return row;
}

// Shared row drag-and-drop reorder. `kind` discriminates between the three
// lists (chat / search / image) so a drag started in one list can't drop
// into another — without the check, dragover would still highlight foreign
// rows and the drop handler would feed a stranger's id to the wrong reorder
// IPC. `getIds` is read at drop time (not bound at attach time) so each row
// sees the current state's id order even after re-renders.
async function _settingsAttachReorderDnd(row, opts) {
  const { kind, id, getIds, ipcName, onSuccess } = opts;
  row.draggable = true;
  const handle = document.createElement('div');
  handle.className = 'entry-drag-handle';
  handle.title = t('settings.entries.drag_title');
  handle.textContent = '⋮⋮';
  row.prepend(handle);
  row.addEventListener('dragstart', (e) => {
    _settingsState.dragState = { kind, id };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    row.parentElement?.querySelectorAll('.entry-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    _settingsState.dragState = null;
  });
  row.addEventListener('dragover', (e) => {
    const ds = _settingsState.dragState;
    if (!ds || ds.kind !== kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    row.classList.toggle('drop-before', before);
    row.classList.toggle('drop-after', !before);
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-before', 'drop-after');
  });
  row.addEventListener('drop', async (e) => {
    const ds = _settingsState.dragState;
    if (!ds || ds.kind !== kind) return;
    e.preventDefault();
    row.classList.remove('drop-before', 'drop-after');
    const srcId = ds.id;
    if (srcId === id) return;
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    const ids = [...getIds()];
    const srcIdx = ids.indexOf(srcId);
    if (srcIdx < 0) return;
    ids.splice(srcIdx, 1);
    let refIdx = ids.indexOf(id);
    if (refIdx < 0) refIdx = ids.length;
    ids.splice(before ? refIdx : refIdx + 1, 0, srcId);
    const res = await window.orkas.invoke(ipcName, { orderedIds: ids });
    if (res && res.ok) {
      await onSuccess(res);
    } else {
      await uiAlert((res && res.error) || t('settings.entries.reorder_failed'));
    }
  });
}

async function _settingsTestEntry(entry, statusEl) {
  _settingsSetRowStatus(statusEl, 'busy', t('settings.entries.testing'), 'entry-status');
  const res = await window.orkas.invoke('auth.testConnection', {
    provider: entry.provider,
    model: entry.model,
    profileId: entry.profileId,
  });
  if (res && res.ok) {
    const ms = typeof res.durationMs === 'number' ? `${res.durationMs}ms` : '';
    _settingsSetRowStatus(statusEl, 'ok', t('settings.entries.conn_ok', { ms }).trim(), 'entry-status');
  } else {
    const msg = (res && res.error) || t('settings.entries.conn_failed');
    _settingsSetRowStatus(statusEl, 'error', msg.slice(0, 160), 'entry-status');
  }
}

async function _settingsRemoveEntry(entry) {
  const title = `${entry.providerLabel || entry.provider} · ${entry.modelName || entry.model} · ${entry.profileLabel}`;
  if (!(await uiConfirm(t('settings.entries.delete_confirm', { title })))) return;
  _settingsLog.info('remove entry', {
    entry_id: entry.entryId,
    provider: entry.provider,
    model: entry.model,
  });
  const res = await window.orkas.invoke('auth.removeEntry', { entryId: entry.entryId });
  if (!res || !res.ok) {
    _settingsLog.warn('remove entry failed', { entry_id: entry.entryId, error: res && res.error });
    await uiAlert((res && res.error) || t('settings.entries.delete_failed'));
    return;
  }
  await _settingsReload();
}

// ── Helpers ──

async function _settingsReload() {
  await Promise.all([_settingsRefreshProviders(), _settingsRefreshEntries(), _settingsRefreshCommanderBackend(), _settingsRefreshAuthProfilesStatus()]);
  if (window.refreshModelAuthorizationSettings) window.refreshModelAuthorizationSettings();
  _settingsRenderCommanderBackend();
  _settingsRenderAuthProfilesRecovery();
  // The priority list just changed — re-check the model-guard flag so the
  // top banner and gated actions unlock (or re-lock, after removing the
  // last entry) without waiting for a reload.
  if (typeof refreshModelGuard === 'function') {
    refreshModelGuard().catch(() => {});
  }
}

function _settingsSetStatus(id, kind, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'settings-status' + (kind ? ` ${kind}` : '');
}

function _settingsSetRowStatus(el, kind, text, baseCls = 'account-row-status') {
  if (!el) return;
  el.textContent = text || '';
  el.className = baseCls + (kind ? ` ${kind}` : '');
}

// ── Search API key section ──────────────────────────────────────────────
//
// Shape mirrors the chat-entries list visually but uses simpler rows
// (provider + label + delete). Provider list is fixed (Tavily / Serper /
// Brave Search API / Baidu AI Search); see search-adapters.ts for the
// canonical registry.

const _SEARCH_PROVIDER_OPTIONS = [
  { id: 'tavily',            label: 'Tavily', docs: 'https://tavily.com/' },
  { id: 'serper',            label: 'Serper', docs: 'https://serper.dev/' },
  { id: 'brave-search',      label: 'Brave', docs: 'https://brave.com/search/api/' },
  { id: 'baidu-ai-search',   label: 'Baidu', docs: 'https://cloud.baidu.com/doc/qianfan-api/s/em82g4tlk' },
  { id: 'metaso',            label: 'Metaso', docs: 'https://metaso.cn/' },
];

function _searchProviderLabel(id) {
  const hit = _SEARCH_PROVIDER_OPTIONS.find((p) => p.id === id);
  return hit ? hit.label : id;
}

async function _settingsRefreshSearchProfiles() {
  const res = await window.orkas.invoke('searchAuth.list');
  _settingsState.searchProfiles = (res && res.ok && Array.isArray(res.profiles)) ? res.profiles : [];
}

function _settingsRenderSearchSection() {
  _settingsRenderSearchPicker();
  _settingsRenderSearchEntries();
}

function _settingsRenderSearchPicker() {
  const el = document.getElementById('settings-search-provider');
  if (!el) return;
  if (!_settingsState.searchProviderSel) {
    _settingsState.searchProviderSel = _aiSelectMount(el, {
      placeholder: t('settings.search.pick_provider'),
    });
  }
  // setOptions on every call — the second arg refreshes the placeholder so a
  // mid-session language switch updates the dropdown header text.
  const prev = _settingsState.searchProviderSel.getValue();
  _settingsState.searchProviderSel.setOptions(
    _SEARCH_PROVIDER_OPTIONS.map((p) => ({ value: p.id, label: p.label, hint: p.docs })),
    { value: prev || '', placeholder: t('settings.search.pick_provider') },
  );
  const addBtn = document.getElementById('settings-search-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', _settingsClickAddSearchKey);
  }
}

async function _settingsClickAddSearchKey() {
  const provider = _settingsState.searchProviderSel?.getValue() || '';
  const input = document.getElementById('settings-search-key-input');
  const apiKey = (input?.value || '').trim();
  if (!provider) { _settingsSetStatus('settings-search-status', 'error', t('settings.search.error_provider_needed')); return; }
  if (!apiKey)   { _settingsSetStatus('settings-search-status', 'error', t('settings.search.error_key_needed')); return; }
  _settingsSetStatus('settings-search-status', 'busy', t('settings.search.adding'));
  try {
    const res = await window.orkas.invoke('searchAuth.add', { provider, apiKey, label: 'default' });
    if (!res || !res.ok) {
      _settingsSetStatus('settings-search-status', 'error', (res && res.error) || t('settings.search.add_failed'));
      return;
    }
    if (input) input.value = '';
    _settingsSetStatus('settings-search-status', 'ok', t('settings.search.add_ok'));
    await _settingsRefreshSearchProfiles();
    _settingsRenderSearchEntries();
  } catch (err) {
    _settingsSetStatus('settings-search-status', 'error', (err && err.message) || String(err));
  }
}

function _settingsRenderSearchEntries() {
  const container = document.getElementById('settings-search-entries');
  if (!container) return;
  container.innerHTML = '';
  const list = _settingsState.searchProfiles || [];
  if (!list.length) {
    container.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.search.empty'))}</div>`;
    return;
  }
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
    row.dataset.profileId = p.id;

    const rank = document.createElement('div');
    rank.className = 'entry-rank';
    rank.textContent = idx === 0 ? t('settings.search.active_tag') : `#${idx + 1}`;
    row.appendChild(rank);

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    primary.innerHTML = `
      <span class="entry-provider">${escapeHtml(_searchProviderLabel(p.provider))}</span>
      <span class="entry-sep">·</span>
      <span class="entry-account-chip">@ ${escapeHtml(p.label || 'default')}</span>
      ${p.apiKeyMasked ? `<span class="account-mask">${escapeHtml(p.apiKeyMasked)}</span>` : ''}
    `;
    main.appendChild(primary);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('settings.delete');
    delBtn.addEventListener('click', async () => {
      const ok = await uiConfirm(t('settings.search.confirm_delete', { provider: _searchProviderLabel(p.provider) }));
      if (!ok) return;
      const res = await window.orkas.invoke('searchAuth.remove', { id: p.id });
      if (res && res.ok) {
        await _settingsRefreshSearchProfiles();
        _settingsRenderSearchEntries();
      }
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    _settingsAttachReorderDnd(row, {
      kind: 'search',
      id: p.id,
      getIds: () => (_settingsState.searchProfiles || []).map((x) => x.id),
      ipcName: 'searchAuth.reorder',
      onSuccess: async () => {
        await _settingsRefreshSearchProfiles();
        _settingsRenderSearchEntries();
      },
    });

    container.appendChild(row);
  });
}

// ── Image generation API key section ────────────────────────────────────
//
// Multi-model providers are flattened into individual choices. The picker
// shows DouBao · Seedream 5.0 Lite / Pro directly, while the main process
// still persists provider=doubao plus the selected model id.

const _IMAGE_PROVIDER_OPTIONS = [
  { id: 'openai',  label: 'OpenAI · GPT Image 2', docs: 'https://platform.openai.com/api-keys' },
  { id: 'google',  label: 'Google · Nano Banana 2', docs: 'https://aistudio.google.com/app/apikey' },
  { id: 'doubao',  label: 'DouBao · Seedream', docs: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
];

function _imageProviderLabel(id) {
  const hit = _IMAGE_PROVIDER_OPTIONS.find((p) => p.id === id);
  return hit ? hit.label : id;
}

async function _settingsRefreshImageProfiles() {
  const res = await window.orkas.invoke('imageAuth.list');
  _settingsState.imageProfiles = (res && res.ok && Array.isArray(res.profiles)) ? res.profiles : [];
}

function _settingsRenderImageSection() {
  _settingsRenderImagePicker();
  _settingsRenderImageEntries();
}

function _settingsRenderImagePicker() {
  const el = document.getElementById('settings-image-provider');
  if (!el) return;
  if (!_settingsState.imageProviderSel) {
    _settingsState.imageProviderSel = _aiSelectMount(el, {
      placeholder: t('settings.image.pick_provider'),
    });
  }
  const prev = _settingsState.imageProviderSel.getValue();
  _settingsState.imageProviderSel.setOptions(
    _IMAGE_PROVIDER_OPTIONS.map((p) => ({ value: p.id, label: p.label, hint: p.docs })),
    { value: prev || '', placeholder: t('settings.image.pick_provider') },
  );
  const addBtn = document.getElementById('settings-image-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', _settingsClickAddImageKey);
  }
}

async function _settingsClickAddImageKey() {
  const provider = _settingsState.imageProviderSel?.getValue() || '';
  const input = document.getElementById('settings-image-key-input');
  const apiKey = (input?.value || '').trim();
  if (!provider) { _settingsSetStatus('settings-image-status', 'error', t('settings.image.error_provider_needed')); return; }
  if (!apiKey)   { _settingsSetStatus('settings-image-status', 'error', t('settings.image.error_key_needed')); return; }
  _settingsSetStatus('settings-image-status', 'busy', t('settings.image.adding'));
  try {
    const res = await window.orkas.invoke('imageAuth.add', { provider, model, apiKey, label: 'default' });
    if (!res || !res.ok) {
      _settingsSetStatus('settings-image-status', 'error', (res && res.error) || t('settings.image.add_failed'));
      return;
    }
    if (input) input.value = '';
    _settingsSetStatus('settings-image-status', 'ok', t('settings.image.add_ok'));
    await _settingsRefreshImageProfiles();
    _settingsRenderImageEntries();
  } catch (err) {
    _settingsSetStatus('settings-image-status', 'error', (err && err.message) || String(err));
  }
}

function _settingsRenderImageEntries() {
  const container = document.getElementById('settings-image-entries');
  if (!container) return;
  container.innerHTML = '';
  const list = _settingsState.imageProfiles || [];
  if (!list.length) {
    container.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.image.empty'))}</div>`;
    return;
  }
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
    row.dataset.profileId = p.id;

    const rank = document.createElement('div');
    rank.className = 'entry-rank';
    rank.textContent = idx === 0 ? t('settings.image.active_tag') : `#${idx + 1}`;
    row.appendChild(rank);

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    primary.innerHTML = `
      <span class="entry-provider">${escapeHtml(_imageProviderLabel(p.provider))}</span>
      <span class="entry-sep">·</span>
      <span class="entry-account-chip">@ ${escapeHtml(p.label || 'default')}</span>
      ${p.apiKeyMasked ? `<span class="account-mask">${escapeHtml(p.apiKeyMasked)}</span>` : ''}
    `;
    main.appendChild(primary);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('settings.delete');
    delBtn.addEventListener('click', async () => {
      const ok = await uiConfirm(t('settings.image.confirm_delete', { provider: _imageProviderLabel(p.provider, p.model) }));
      if (!ok) return;
      const res = await window.orkas.invoke('imageAuth.remove', { id: p.id });
      if (res && res.ok) {
        await _settingsRefreshImageProfiles();
        _settingsRenderImageEntries();
      }
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    _settingsAttachReorderDnd(row, {
      kind: 'image',
      id: p.id,
      getIds: () => (_settingsState.imageProfiles || []).map((x) => x.id),
      ipcName: 'imageAuth.reorder',
      onSuccess: async () => {
        await _settingsRefreshImageProfiles();
        _settingsRenderImageEntries();
      },
    });

    container.appendChild(row);
  });
}

// ── Video generation API key section ────────────────────────────────────
//
// Dedicated BYO video-generation credentials. The open-source build exposes
// user-owned provider keys only; managed Orkas video providers stay stripped.

const _VIDEO_AUTH_PROVIDER_OPTIONS = [
  { id: 'doubao', label: 'DouBao · Seedance', docs: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
];

function _settingsVideoProviderOptions() {
  return Array.isArray(_settingsState.videoAuthProviderOptions) && _settingsState.videoAuthProviderOptions.length
    ? _settingsState.videoAuthProviderOptions
    : _VIDEO_AUTH_PROVIDER_OPTIONS;
}

function _videoProviderLabel(id) {
  const hit = _settingsVideoProviderOptions().find((p) => p.id === id);
  return hit ? hit.label : id;
}

function _settingsSelectedVideoProvider() {
  return _settingsState.videoProviderSel?.getValue()
    || document.getElementById('settings-video-provider')?.dataset?.value
    || '';
}

async function _settingsRefreshVideoProfiles() {
  const res = await window.orkas.invoke('videoAuth.list');
  _settingsState.videoProfiles = (res && res.ok && Array.isArray(res.profiles)) ? res.profiles : [];
  _settingsState.videoAuthProviderOptions = (res && res.ok && Array.isArray(res.providers) && res.providers.length)
    ? res.providers
    : _VIDEO_AUTH_PROVIDER_OPTIONS;
}

function _settingsRenderVideoSection() {
  _settingsRenderVideoPicker();
  _settingsRenderVideoEntries();
}

function _settingsRenderVideoPicker() {
  const providerEl = document.getElementById('settings-video-provider');
  if (!providerEl) return;
  if (!_settingsState.videoProviderSel) {
    _settingsState.videoProviderSel = _aiSelectMount(providerEl, {
      placeholder: t('settings.video.pick_provider'),
    });
    _settingsState.videoProviderSel.onChange((provider) => {
      _settingsTrackModelProviderSelect('video_auth_picker', provider);
      _settingsSetStatus('settings-video-status', '', '');
    });
  }
  const prevProvider = _settingsState.videoProviderSel.getValue();
  _settingsState.videoProviderSel.setOptions(
    _settingsVideoProviderOptions().map((p) => ({
      value: p.id,
      label: p.label || p.id,
      hint: p.docs,
    })),
    { value: prevProvider || '', placeholder: t('settings.video.pick_provider') },
  );
  const addBtn = document.getElementById('settings-video-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', _settingsClickAddVideoKey);
  }
}

async function _settingsClickAddVideoKey() {
  const provider = _settingsSelectedVideoProvider();
  const input = document.getElementById('settings-video-key-input');
  const apiKey = (input?.value || '').trim();
  if (!provider) { _settingsSetStatus('settings-video-status', 'error', t('settings.video.error_provider_needed')); return; }
  if (!apiKey) { _settingsSetStatus('settings-video-status', 'error', t('settings.video.error_key_needed')); return; }
  _settingsSetStatus('settings-video-status', 'busy', t('settings.video.adding'));
  try {
    const res = await window.orkas.invoke('videoAuth.add', { provider, apiKey, label: 'default' });
    if (!res || !res.ok) {
      _settingsSetStatus('settings-video-status', 'error', (res && res.error) || t('settings.video.add_failed'));
      return;
    }
    if (input) input.value = '';
    _settingsSetStatus('settings-video-status', 'ok', t('settings.video.add_ok'));
    await _settingsRefreshVideoProfiles();
    _settingsRenderVideoEntries();
  } catch (err) {
    _settingsSetStatus('settings-video-status', 'error', (err && err.message) || String(err));
  }
}

function _settingsRenderVideoEntries() {
  const container = document.getElementById('settings-video-entries');
  if (!container) return;
  container.innerHTML = '';
  const list = _settingsState.videoProfiles || [];
  if (!list.length) {
    container.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.video.empty'))}</div>`;
    return;
  }
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
    row.dataset.profileId = p.id;

    const rank = document.createElement('div');
    rank.className = 'entry-rank';
    rank.textContent = idx === 0 ? t('settings.video.active_tag') : `#${idx + 1}`;
    row.appendChild(rank);

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    primary.innerHTML = `
      <span class="entry-provider">${escapeHtml(_videoProviderLabel(p.provider))}</span>
      <span class="entry-sep">·</span>
      <span class="entry-account-chip">@ ${escapeHtml(p.label || 'default')}</span>
      ${p.apiKeyMasked ? `<span class="account-mask">${escapeHtml(p.apiKeyMasked)}</span>` : ''}
    `;
    main.appendChild(primary);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('settings.delete');
    delBtn.addEventListener('click', async () => {
      const ok = await uiConfirm(t('settings.video.confirm_delete', { provider: _videoProviderLabel(p.provider, p.model) }));
      if (!ok) return;
      const res = await window.orkas.invoke('videoAuth.remove', { id: p.id });
      if (res && res.ok) {
        await _settingsRefreshVideoProfiles();
        _settingsRenderVideoEntries();
      }
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    _settingsAttachReorderDnd(row, {
      kind: 'video',
      id: p.id,
      getIds: () => (_settingsState.videoProfiles || []).map((x) => x.id),
      ipcName: 'videoAuth.reorder',
      onSuccess: async () => {
        await _settingsRefreshVideoProfiles();
        _settingsRenderVideoEntries();
      },
    });

    container.appendChild(row);
  });
}

// ── Text-to-speech API key section ─────────────────────────────────────────

async function _settingsRefreshTtsProfiles() {
  const res = await window.orkas.invoke('ttsAuth.list');
  if (!res || !res.ok) return;
  _settingsState.ttsPresets = Array.isArray(res.presets) ? res.presets : [];
  _settingsState.ttsProfiles = Array.isArray(res.profiles) ? res.profiles : [];
  const providerEl = document.getElementById('settings-tts-provider');
  if (providerEl && !_settingsState.ttsProviderSel) {
    _settingsState.ttsProviderSel = _aiSelectMount(providerEl, { placeholder: t('settings.tts.pick_provider') });
    _settingsState.ttsProviderSel.onChange((id) => {
      _settingsTtsPrefillProvider(id);
      _settingsTtsApplyProviderFields(id);
      _settingsSetStatus('settings-tts-status', '', '');
    });
  }
  if (_settingsState.ttsProviderSel) {
    const prev = _settingsState.ttsProviderSel.getValue();
    _settingsState.ttsProviderSel.setOptions(
      (_settingsState.ttsPresets || []).map((p) => ({ value: p.id, label: p.label, hint: p.docs })),
      { value: prev || '', placeholder: t('settings.tts.pick_provider') },
    );
    _settingsTtsApplyProviderFields(_settingsState.ttsProviderSel.getValue());
  }
  const addBtn = document.getElementById('settings-tts-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', _settingsClickAddTts);
  }
  _settingsRenderTtsEntries();
}

function _settingsTtsPreset(providerId) {
  return (_settingsState.ttsPresets || []).find((p) => p.id === providerId);
}

function _ttsProviderLabel(id) {
  const hit = (_settingsState.ttsPresets || []).find((p) => p.id === id);
  return hit ? hit.label : (id || 'custom');
}

function _settingsTtsPrefillProvider(providerId) {
  const preset = _settingsTtsPreset(providerId);
  const baseInput = document.getElementById('settings-tts-base-input');
  const modelInput = document.getElementById('settings-tts-model-input');
  const voiceInput = document.getElementById('settings-tts-voice-input');
  const resInput = document.getElementById('settings-tts-doubao-resource');
  if (baseInput) baseInput.value = preset?.baseUrl || '';
  if (modelInput) modelInput.value = preset?.defaultModel || '';
  if (voiceInput) {
    voiceInput.value = '';
    voiceInput.placeholder = preset?.defaultVoice || 'alloy';
  }
  if (resInput) resInput.value = preset?.defaultResourceId || '';
}

function _settingsTtsSetRowHidden(selector, hidden) {
  document.querySelectorAll(selector).forEach((el) => {
    el.hidden = !!hidden;
    el.style.display = hidden ? 'none' : '';
    el.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  });
}

function _settingsTtsApplyProviderFields(providerId) {
  const preset = _settingsTtsPreset(providerId);
  const isCustom = providerId === 'custom';
  const needsVoice = !!providerId && !preset?.defaultVoice;
  _settingsTtsSetRowHidden('#settings-tts-key-row', false);
  _settingsTtsSetRowHidden('.tts-row-base, .tts-row-model', !isCustom);
  _settingsTtsSetRowHidden('.tts-row-voice', !needsVoice);
  _settingsTtsSetRowHidden('.tts-row-doubao-res', true);
}

async function _settingsClickAddTts() {
  const provider = _settingsState.ttsProviderSel?.getValue() || '';
  if (!provider) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_provider_needed')); return; }
  const preset = _settingsTtsPreset(provider);
  const apiKey = (document.getElementById('settings-tts-key-input')?.value || '').trim();
  const voice = (document.getElementById('settings-tts-voice-input')?.value || '').trim();
  if (!apiKey) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_key_needed')); return; }

  let payload;
  if (provider === 'doubao') {
    const resourceId = (document.getElementById('settings-tts-doubao-resource')?.value || '').trim();
    payload = { provider, apiKey, voice: voice || (preset?.defaultVoice || ''), resourceId };
  } else {
    const baseUrl = (document.getElementById('settings-tts-base-input')?.value || '').trim() || (preset?.baseUrl || '');
    const model = (document.getElementById('settings-tts-model-input')?.value || '').trim() || (preset?.defaultModel || '');
    const finalVoice = voice || (preset?.defaultVoice || '');
    if (!baseUrl) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_base_needed')); return; }
    if (!model) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_model_needed')); return; }
    if (!finalVoice) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_voice_needed')); return; }
    payload = { provider, baseUrl, model, apiKey, voice: finalVoice };
  }

  _settingsSetStatus('settings-tts-status', 'busy', t('settings.tts.adding'));
  try {
    const res = await window.orkas.invoke('ttsAuth.add', payload);
    if (!res || !res.ok) {
      _settingsSetStatus('settings-tts-status', 'error', (res && res.error) || t('settings.tts.add_failed'));
      return;
    }
    const keyInput = document.getElementById('settings-tts-key-input');
    if (keyInput) keyInput.value = '';
    _settingsSetStatus('settings-tts-status', 'ok', t('settings.tts.add_ok'));
    await _settingsRefreshTtsProfiles();
  } catch (err) {
    _settingsSetStatus('settings-tts-status', 'error', (err && err.message) || String(err));
  }
}

function _settingsRenderTtsEntries() {
  const container = document.getElementById('settings-tts-entries');
  if (!container) return;
  container.innerHTML = '';
  const list = _settingsState.ttsProfiles || [];
  if (!list.length) {
    container.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.tts.empty'))}</div>`;
    return;
  }
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
    row.dataset.profileId = p.id;

    const rank = document.createElement('div');
    rank.className = 'entry-rank';
    rank.textContent = idx === 0 ? t('settings.tts.active_tag') : `#${idx + 1}`;
    row.appendChild(rank);

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    const detail = p.provider === 'doubao' ? (p.resourceId || '') : (p.model || '');
    primary.innerHTML = `
      <span class="entry-provider">${escapeHtml(_ttsProviderLabel(p.provider))}</span>
      ${detail ? `<span class="entry-sep">·</span><span class="entry-model">${escapeHtml(detail)}</span>` : ''}
      ${p.voice ? `<span class="entry-sep">·</span><span class="entry-model">${escapeHtml(p.voice)}</span>` : ''}
      <span class="entry-sep">·</span>
      <span class="entry-account-chip">@ ${escapeHtml(p.label || 'default')}</span>
      ${p.apiKeyMasked ? `<span class="account-mask">${escapeHtml(p.apiKeyMasked)}</span>` : ''}
    `;
    main.appendChild(primary);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('settings.delete');
    delBtn.addEventListener('click', async () => {
      const ok = await uiConfirm(t('settings.tts.confirm_delete', { provider: _ttsProviderLabel(p.provider) }));
      if (!ok) return;
      const res = await window.orkas.invoke('ttsAuth.remove', { id: p.id });
      if (res && res.ok) await _settingsRefreshTtsProfiles();
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    _settingsAttachReorderDnd(row, {
      kind: 'tts',
      id: p.id,
      getIds: () => (_settingsState.ttsProfiles || []).map((x) => x.id),
      ipcName: 'ttsAuth.reorder',
      onSuccess: async () => {
        await _settingsRefreshTtsProfiles();
        _settingsRenderTtsEntries();
      },
    });

    container.appendChild(row);
  });
}
