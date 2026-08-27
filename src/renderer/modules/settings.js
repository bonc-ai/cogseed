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
  recycleBatches: [], // from recycle.list [{id, kind, label, created_at_ms, items, paths_preview, ...}]
  pickerProviderSel: null,
  pickerModelSel: null,
  pickerProviderEl: null,
  pickerModelEl: null,
  pickerProviderValueBeforeAction: '',
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
  customProviderModalGeneration: 0,
  customProviderModalView: null,
  pickerModelRequestGeneration: 0,
  ccswitchStatus: null,
  ccswitchPreviewRows: [],
  ccswitchPreviewUnsupported: [],
  ccswitchPreviewSelectedIds: [],
  ccswitchPreviewSelectedProvider: null,
  ccswitchPreviewSelectedModels: [],
  ccswitchPreviewGeneration: 0,
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
  _settingsBindConfiguredToggle();
  _settingsBindLanguageOnce();
  _settingsBindThinkingOnce();
  _settingsBindTaskNotificationsOnce();
  _settingsBindClientConfigOnce();
  _settingsBindContextsEntryOnce();
  _settingsBindUsageConnectionsOnce();
  _settingsSyncLanguageRadio();
  await Promise.all([
    _settingsSafeCall('settings providers refresh', _settingsRefreshProviders),
    _settingsSafeCall('settings entries refresh', _settingsRefreshEntries),
    _settingsSafeCall('settings local execution refresh', _settingsRefreshLocalExec),
    _settingsSafeCall('settings search refresh', _settingsRefreshSearchProfiles),
    _settingsSafeCall('settings image refresh', _settingsRefreshImageProfiles),
    _settingsSafeCall('settings tts refresh', _settingsRefreshTtsProfiles),
    _settingsSafeCall('settings task notifications refresh', _settingsRefreshTaskNotifications),
    _settingsSafeCall('settings metacognition refresh', _settingsRefreshMetacognition),
    _settingsSafeCall('settings data root refresh', _settingsRefreshDataRoot),
    _settingsSafeCall('settings commander backend refresh', _settingsRefreshCommanderBackend),
    _settingsSafeCall('settings auth profiles status refresh', _settingsRefreshAuthProfilesStatus),
    _settingsSafeCall('settings custom providers refresh', _settingsRefreshCustomProviders),
    _settingsSafeCall('settings ccswitch status refresh', _settingsRefreshCcswitchStatus),
    _settingsSafeCall('settings recycle refresh', _settingsRefreshRecycle),
    _settingsSafeCall('settings touchpoint refresh', () => window.initTouchpointSettings && window.initTouchpointSettings()),
    _settingsSafeCall('settings hub account refresh', () => window.initHubAccountSettings && window.initHubAccountSettings()),
  ]);
  await _settingsSafeCall('settings model picker render', _settingsRenderPicker);
  await _settingsSafeCall('settings model entries render', _settingsRenderEntries);
  await _settingsSafeCall('settings local execution render', _settingsRenderLocalExec);
  await _settingsSafeCall('settings search render', _settingsRenderSearchSection);
  await _settingsSafeCall('settings image render', _settingsRenderImageSection);
  await _settingsSafeCall('settings tts render', _settingsRenderTtsEntries);
  await _settingsSafeCall('settings task notifications render', _settingsRenderTaskNotifications);
  await _settingsSafeCall('settings metacognition render', _settingsRenderMetacognition);
  await _settingsSafeCall('settings data root render', _settingsRenderDataRoot);
  await _settingsSafeCall('settings commander backend render', _settingsRenderCommanderBackend);
  await _settingsSafeCall('settings auth profiles recovery render', _settingsRenderAuthProfilesRecovery);
  await _settingsSafeCall('settings custom providers render', _settingsRenderCustomProviders);
  await _settingsSafeCall('settings ccswitch render', _settingsRenderCcswitchStatus);
  await _settingsSafeCall('settings recycle render', _settingsRenderRecycle);
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
    const res = await window.cogseed.invoke('prefs.getTaskNotifications');
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
  // `denied` without proving that the user disabled CogSeed in system settings.
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
          await window.cogseed.invoke('prefs.openTaskNotificationSettings');
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
        const res = await window.cogseed.invoke('prefs.setTaskNotifications', { enabled: next });
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
  const res = await window.cogseed.invoke('permissions.getLocalExec');
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
          const res = await window.cogseed.invoke('permissions.setLocalExecMode', { mode: next });
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
// `COGSEED_METACOGNITION='0'` is still a higher-priority kill switch
// (surfaced as `envForcedOff`); when active, the UI greys out the
// toggle and shows an explanatory hint.

async function _settingsRefreshMetacognition() {
  try {
    const res = await window.cogseed.invoke('prefs.getMetacognition');
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
        const res = await window.cogseed.invoke('prefs.setMetacognition', { enabled: next });
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
    const res = await window.cogseed.invoke('app.dataRootPath');
    _settingsState.dataRoot = (res && res.ok && res.path) ? String(res.path) : '';
  } catch (_) {
    _settingsState.dataRoot = '';
  }
}

function _settingsBindContextsEntryOnce() {
  const btn = document.getElementById('settings-contexts-open-btn');
  if (!btn || btn.dataset.bound) return;
  btn.addEventListener('click', () => {
    if (typeof setView === 'function') setView('contexts');
  });
  btn.dataset.bound = '1';
}

// Settings › 账号与用量 › 前往连接：模型与触点配置已收敛到「连接」一级入口。
function _settingsBindUsageConnectionsOnce() {
  const btn = document.getElementById('settings-usage-open-connections');
  if (!btn || btn.dataset.bound) return;
  btn.addEventListener('click', () => {
    if (typeof setView === 'function') setView('connections');
  });
  btn.dataset.bound = '1';
}

function _settingsRenderDataRoot() {
  const btn = document.getElementById('settings-data-root-btn');
  const span = document.getElementById('settings-data-root-path');
  if (!btn || !span) return;
  span.textContent = _settingsState.dataRoot || '';
  if (!btn.dataset.bound) {
    btn.addEventListener('click', async () => {
      try {
        await window.cogseed.invoke('app.openDataRoot');
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
      ]),
];

// Configured-models list toggle: collapse/expand the priority entry list so
// a long model list stays scannable. Preference is remembered per machine.
function _settingsBindConfiguredToggle() {
  const toggle = document.getElementById('settings-configured-toggle');
  const section = document.getElementById('settings-configured-models');
  if (!toggle || !section || toggle.dataset.bound) return;
  toggle.dataset.bound = '1';
  const apply = (collapsed) => {
    section.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    try {
      if (collapsed) localStorage.setItem('settings.configuredModelsCollapsed', '1');
      else localStorage.removeItem('settings.configuredModelsCollapsed');
    } catch { /* storage unavailable — in-memory only */ }
  };
  let collapsed = false;
  try { collapsed = localStorage.getItem('settings.configuredModelsCollapsed') === '1'; } catch { /* ignore */ }
  apply(collapsed);
  toggle.addEventListener('click', () => apply(!section.classList.contains('is-collapsed')));
}

function _settingsBindLanguageOnce() {
  if (_settingsLanguageSel) return;
  const el = document.getElementById('settings-language-select');
  if (!el) return;
  _settingsLanguageSel = _aiSelectMount(el, {
    options: _SETTINGS_LANG_OPTIONS,
    value: (typeof getLang === 'function') ? getLang() : 'zh',
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

// ── Global default thinking strength (unified execution entry) ──
// The composer's exec-config chip is task-scoped only; the GLOBAL default
// lives here. Options mirror prefs.getThinkingLevel/setThinkingLevel.
let _settingsThinkingSel = null; // _aiSelectMount api

const _SETTINGS_THINKING_OPTIONS = [
  { value: 'auto', label: '' },
  { value: 'off', label: '' },
  { value: 'low', label: '' },
  { value: 'high', label: '' },
];

function _settingsThinkingLabels() {
  // Resolve through t() at render time so an in-flight language switch
  // relabels the options without a page reload.
  return _SETTINGS_THINKING_OPTIONS.map((o) => ({
    value: o.value,
    label: t('model_effort.' + o.value),
  }));
}

function _settingsBindThinkingOnce() {
  const el = document.getElementById('settings-thinking-select');
  if (!el) return;
  const apply = (level) => {
    if (_settingsThinkingSel) _settingsThinkingSel.setValue(level);
    return;
  };
  _settingsThinkingSel = _aiSelectMount(el, {
    options: _settingsThinkingLabels(),
    value: 'auto',
  });
  _settingsThinkingSel.onChange(async (next) => {
    if (!['auto', 'off', 'low', 'high'].includes(next)) return;
    try {
      await window.cogseed.invoke('prefs.setThinkingLevel', { level: next });
      _settingsLog.info('thinking level changed', { level: next });
      if (typeof window.refreshExecConfigChip === 'function') window.refreshExecConfigChip();
    } catch (err) {
      _settingsLog.warn('setThinkingLevel failed', { error: (err && err.message) || String(err) });
    }
  });
  window.cogseed.invoke('prefs.getThinkingLevel').then((res) => {
    if (res && res.level) apply(res.level);
  }).catch(() => {});
}

function _settingsSyncLanguageRadio() {
  // Function name kept for caller-side compatibility; semantics is now "sync dropdown value".
  const cur = (typeof getLang === 'function') ? getLang() : 'zh';
  if (_settingsLanguageSel) _settingsLanguageSel.setValue(cur);
}

// Keep the radio in sync if some other code path changes language, and
// re-render sections whose text is written by JS (so their content
// isn't refreshed by applyDomI18n's data-i18n sweep).
window.addEventListener('i18n-change', () => {
  _settingsSyncLanguageRadio();
  // Unified execution entry: thinking-strength option labels resolve
  // through t(), so re-apply them on language switches.
  if (_settingsThinkingSel && typeof _settingsThinkingSel.setOptions === 'function') {
    _settingsThinkingSel.setOptions(_settingsThinkingLabels());
  }
  _settingsRenderLocalExec();
  _settingsRenderPicker();
  _settingsRenderEntries();
  _settingsRenderSearchSection();
  _settingsRenderImageSection();
  _settingsRenderMetacognition();
  _settingsRenderCommanderBackend();
  _settingsRenderCustomProviders();
  _settingsRenderCcswitchStatus();
  _settingsRenderCliFallback();
  _settingsRerenderCustomProviderModalForI18n();
  if (_settingsState.ccswitchPreviewRows.length) _settingsRenderCcswitchPreviewDialog();
});

// ── Commander CLI fallback (no API-key model) ─────────────────────────────
// Friendly label for a fallback CLI value ('' → auto). Mirrors the
// conversation.js fallback labels; must cover every cli-fallback whitelist
// entry (claude / codex / opencode / workbuddy).
function _settingsCliFallbackLabel(cli) {
  if (cli === 'claude') return 'Claude Code';
  if (cli === 'codex') return 'Codex';
  if (cli === 'opencode') return 'OpenCode';
  if (cli === 'workbuddy') return 'WorkBuddy';
  return '';
}

async function _settingsRenderCliFallback() {
  const select = document.getElementById('settings-cli-fallback-select');
  const stateEl = document.getElementById('settings-cli-fallback-state');
  if (!select) return;

  let prefs = { cli: '', noticeShown: false };
  try {
    const res = await window.cogseed.invoke('prefs.getCliFallback');
    if (res) prefs = { cli: res.cli || '', noticeShown: !!res.noticeShown };
  } catch (_) { /* prefs unavailable */ }

  select.value = prefs.cli || '';
  if (stateEl) {
    stateEl.textContent = prefs.cli
      ? t('settings.cli_fallback.state_chosen').replace('{cli}', _settingsCliFallbackLabel(prefs.cli))
      : t('settings.cli_fallback.state_auto');
  }

  if (select.dataset.bound === '1') return;
  select.dataset.bound = '1';
  select.addEventListener('change', async () => {
    try {
      await window.cogseed.invoke('prefs.setCliFallback', { cli: select.value });
      const res = await window.cogseed.invoke('model.hasConfigured');
      const noApi = !(res && res.configured);
      if (stateEl) {
        stateEl.textContent = select.value
          ? t('settings.cli_fallback.state_chosen').replace('{cli}', _settingsCliFallbackLabel(select.value))
          : t('settings.cli_fallback.state_auto');
      }
      if (noApi && typeof uiToast === 'function') {
        uiToast(t('settings.cli_fallback.saved_no_api'), {
          variant: 'warning',
          timeoutMs: 5000,
          i18nKey: 'settings.cli_fallback.saved_no_api',
        });
      }
    } catch (err) {
      _settingsLog.warn('cli fallback save failed', err);
    }
  });

  // One-time honest notice when the user is in the no-API state.
  try {
    const modelRes = await window.cogseed.invoke('model.hasConfigured');
    if (!(modelRes && modelRes.configured) && !prefs.noticeShown) {
      await window.cogseed.invoke('prefs.markCliFallbackNoticeShown');
      if (typeof uiToast === 'function') {
        uiToast(t('settings.cli_fallback.notice_no_api'), {
          variant: 'warning',
          timeoutMs: 8000,
          i18nKey: 'settings.cli_fallback.notice_no_api',
        });
      }
    }
  } catch (_) { /* notice is best-effort */ }
}

async function _settingsRefreshProviders() {
  const res = await window.cogseed.invoke('auth.listProviders');
  _settingsState.providers = (res && res.ok && Array.isArray(res.providers)) ? res.providers : [];
  // Shared cache for the model-authorization modal so it never re-triggers
  // auth.listProviders (core-agent cold start) just to paint preset cards.
  if (_settingsState.providers.length) window.__settingsProvidersCache = _settingsState.providers;
}

async function _settingsRefreshEntries() {
  const res = await window.cogseed.invoke('auth.listEntries', { includeUnavailable: true });
  _settingsState.entries = (res && res.ok && Array.isArray(res.entries)) ? res.entries : [];
  if (typeof trackModelConfigSnapshot === 'function') trackModelConfigSnapshot(_settingsState.entries);
}

async function _settingsRefreshAuthProfilesStatus() {
  const res = await window.cogseed.invoke('auth.getProfilesStoreStatus');
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
  const res = await window.cogseed.invoke('auth.resetProfilesStoreAfterDecryptFailure');
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
  const res = await window.cogseed.invoke('settings.getCommanderBackend');
  if (res && res.ok) {
    _settingsState.commanderBackendView = {
      settings: res.settings || { backend: 'cogseed-core-agent', authEntryId: null, localCli: null },
      cloudConfigured: !!res.cloudConfigured,
    };
    return;
  }
  _settingsState.commanderBackendView = {
    settings: { backend: 'cogseed-core-agent', authEntryId: null, localCli: null },
    cloudConfigured: false,
  };
}

function _settingsCommanderBackendOptions() {
  const view = _settingsState.commanderBackendView || {};
  return [
    {
      value: 'cogseed-core-agent',
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
    settings: { backend: 'cogseed-core-agent', authEntryId: null, localCli: null },
    cloudConfigured: false,
  };
  const backend = 'cogseed-core-agent';
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
  const settings = { backend: 'cogseed-core-agent', authEntryId: null, localCli: null };
  _settingsSetStatus('settings-commander-backend-status', '', t('settings.save_loading'));
  const res = await window.cogseed.invoke('settings.setCommanderBackend', { settings });
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
  if (key === 'openai-responses') return t('settings.custom_providers.protocol_openai_responses');
  if (key === 'gemini') return t('settings.custom_providers.protocol_gemini');
  return key || t('settings.custom_providers.protocol_unknown');
}

const _CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW = 131072;
const _CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS = 8192;
const _CUSTOM_PROVIDER_MAX_MODELS = 100;
const _CUSTOM_PROVIDER_MAX_CONTEXT_WINDOW = 16777216;
const _CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS = 1048576;
const _settingsCustomProviderPendingActions = new Set();
let _settingsCustomProviderModelFieldId = 0;

function _settingsSetCustomProviderModalView(kind, provider = null, model = null, preserveSession = false) {
  const current = _settingsState.customProviderModalView;
  const generation = preserveSession && current
    ? current.generation
    : ++_settingsState.customProviderModalGeneration;
  _settingsState.customProviderModalView = {
    kind,
    generation,
    provider: provider || null,
    providerId: provider?.id || null,
    model: model || null,
    busyActionKey: preserveSession ? (current?.busyActionKey || null) : null,
  };
  return generation;
}

function _settingsIsCustomProviderModalViewActive(generation, providerId = null) {
  const overlay = document.getElementById('settings-custom-provider-modal');
  const view = _settingsState.customProviderModalView;
  return !!(
    overlay?.classList.contains('open')
    && view
    && view.generation === generation
    && (!providerId || view.providerId === providerId)
  );
}

function _settingsCurrentCustomProvider(providerId) {
  return (_settingsState.customProviders || []).find((provider) => provider.id === providerId) || null;
}

function _settingsCustomProviderForCatalogProvider(provider) {
  if (!provider || provider.providerKind !== 'custom') return null;
  const id = String(provider.id || '').startsWith('cp:')
    ? String(provider.id).slice(3)
    : String(provider.id || '');
  return _settingsCurrentCustomProvider(id);
}

function _settingsIsCatalogProviderEnabled(provider) {
  if (!provider || provider.providerKind !== 'custom') return true;
  if (provider.enabled === false) return false;
  const customProvider = _settingsCustomProviderForCatalogProvider(provider);
  return customProvider ? customProvider.enabled !== false : true;
}

function _settingsCustomProviderApiFormatLabel(protocol) {
  const key = String(protocol || '').toLowerCase();
  if (key === 'anthropic') return t('settings.custom_providers.api_format_anthropic');
  if (key === 'openai') return t('settings.custom_providers.api_format_openai');
  if (key === 'openai-responses') return t('settings.custom_providers.api_format_openai_responses');
  if (key === 'gemini') return t('settings.custom_providers.api_format_gemini');
  return _settingsCustomProviderProtocolLabel(key);
}

function _settingsCustomProviderModels(provider) {
  if (!Array.isArray(provider?.models)) return [];
  const seen = new Set();
  const models = [];
  for (const raw of provider.models) {
    const id = String(typeof raw === 'string' ? raw : raw?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const contextWindow = Number.isSafeInteger(raw?.contextWindow) && raw.contextWindow > 0
      ? raw.contextWindow
      : _CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW;
    const maxTokens = Number.isSafeInteger(raw?.maxTokens) && raw.maxTokens > 0
      ? raw.maxTokens
      : _CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS;
    models.push({ id, contextWindow, maxTokens });
  }
  return models;
}

function _settingsFormatTokenLimit(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  if (amount >= 1000000 && amount % 1000000 === 0) return `${amount / 1000000}M`;
  if (amount >= 1000 && amount % 1000 === 0) return `${amount / 1000}K`;
  return new Intl.NumberFormat().format(amount);
}

function _settingsIconHtml(name, className = 'ui-icon') {
  return (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml(name, className)
    : '';
}

function _settingsCustomProviderActionButton(icon, label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = label;
  button.setAttribute('aria-label', label);
  const iconOnly = String(className || '').split(/\s+/).includes('icon-btn');
  button.innerHTML = `${_settingsIconHtml(icon, 'ui-icon settings-custom-provider-action-icon')}${iconOnly ? '' : `<span>${escapeHtml(label)}</span>`}`;
  button.addEventListener('click', async (event) => {
    if (button.disabled) return;
    _settingsSetCustomProviderButtonBusy(button, true);
    try {
      await onClick(event);
    } finally {
      _settingsSetCustomProviderButtonBusy(button, false);
    }
  });
  return button;
}

function _settingsSetCustomProviderButtonBusy(button, busy) {
  if (!button) return;
  button.disabled = !!busy;
  button.classList.toggle('is-busy', !!busy);
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

function _settingsSetCustomProviderModalActionBusy(generation, actionKey, busy, sourceButton = null) {
  const view = _settingsState.customProviderModalView;
  const activeGeneration = view?.generation === generation;
  if (activeGeneration) {
    view.busyActionKey = busy ? actionKey : (view.busyActionKey === actionKey ? null : view.busyActionKey);
    const actions = document.getElementById('settings-custom-provider-modal-actions');
    for (const button of actions?.children || []) {
      if (button.dataset?.customProviderActionKey === actionKey) {
        _settingsSetCustomProviderButtonBusy(button, busy);
      }
    }
  }
  if (sourceButton) _settingsSetCustomProviderButtonBusy(sourceButton, busy);
}

async function _settingsCallCustomProvider(channel, payload) {
  try {
    return await window.cogseed.invoke(channel, payload);
  } catch (err) {
    const error = (err && err.message) || String(err);
    _settingsLog.warn('custom provider action failed', { channel, error });
    return { ok: false, error };
  }
}

async function _settingsWithCustomProviderAction(key, action) {
  if (_settingsCustomProviderPendingActions.has(key)) return false;
  const viewGeneration = _settingsState.customProviderModalView?.generation || 0;
  _settingsCustomProviderPendingActions.add(key);
  try {
    return await action();
  } catch (err) {
    _settingsLog.warn('custom provider UI action failed', {
      action: key,
      error: (err && err.message) || String(err),
    });
    if (_settingsIsCustomProviderModalViewActive(viewGeneration)) {
      _settingsCustomProviderModalStatus('error', t('settings.custom_providers.action_failed'));
    }
    return false;
  } finally {
    _settingsCustomProviderPendingActions.delete(key);
  }
}

function _settingsCustomProviderModalStatus(kind, text) {
  const status = document.getElementById('settings-custom-provider-modal-status');
  if (!status) return;
  status.textContent = text || '';
  status.className = 'form-msg' + (kind ? ` ${kind}` : '');
}

function _settingsNormalizeCustomProviderModel(input) {
  const id = String(input?.id || '').trim();
  const contextWindow = Number(input?.contextWindow);
  const maxTokens = Number(input?.maxTokens);
  if (!id) return { ok: false, error: t('settings.custom_providers.error_model_id') };
  if (id.length > 200) return { ok: false, error: t('settings.custom_providers.error_model_id_long') };
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > _CUSTOM_PROVIDER_MAX_CONTEXT_WINDOW) {
    return { ok: false, error: t('settings.custom_providers.error_context_window') };
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > _CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS || maxTokens > contextWindow) {
    return { ok: false, error: t('settings.custom_providers.error_max_tokens') };
  }
  return { ok: true, model: { id, contextWindow, maxTokens } };
}

function _settingsIsValidCustomProviderUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function _settingsAppendCustomProviderModelDraft(container, model = null) {
  if (!container || container.children.length >= _CUSTOM_PROVIDER_MAX_MODELS) return null;
  const normalized = model || {
    id: '',
    contextWindow: _CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW,
    maxTokens: _CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
  };
  const row = document.createElement('div');
  row.className = 'settings-custom-provider-model-draft';

  // Minimal editing: one model name per row. Context window / max output
  // fall back to the provider defaults when not supplied.
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.className = 'form-input settings-custom-provider-model-id';
  idInput.value = normalized.id || '';
  idInput.placeholder = t('settings.custom_providers.model_id_placeholder');
  idInput.setAttribute('aria-label', t('settings.custom_providers.model_id'));
  idInput.autocomplete = 'off';
  idInput.spellcheck = false;
  row.appendChild(idInput);

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'settings-custom-provider-model-draft-remove';
  removeButton.title = t('settings.custom_providers.remove_model');
  removeButton.setAttribute('aria-label', removeButton.title);
  removeButton.innerHTML = _settingsIconHtml('x', 'ui-icon');
  removeButton.addEventListener('click', () => {
    if (container.children.length === 1) {
      idInput.value = '';
      idInput.focus();
      return;
    }
    row.remove();
  });
  row.appendChild(removeButton);

  container.appendChild(row);
  return row;
}

function _settingsReadCustomProviderModelDrafts(container) {
  const models = [];
  const seen = new Set();
  for (const row of container?.querySelectorAll('.settings-custom-provider-model-draft') || []) {
    const result = _settingsNormalizeCustomProviderModel({
      id: row.querySelector('.settings-custom-provider-model-id')?.value,
      // Context / max-output inputs no longer exist in the minimal UI; fall
      // back to the provider defaults when absent.
      contextWindow: Number(row.querySelector('.settings-custom-provider-model-context')?.value) || _CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW,
      maxTokens: Number(row.querySelector('.settings-custom-provider-model-output')?.value) || _CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
    });
    if (!result.ok) return result;
    if (seen.has(result.model.id)) return { ok: false, error: t('settings.custom_providers.error_duplicate_model') };
    seen.add(result.model.id);
    models.push(result.model);
  }
  if (!models.length) return { ok: false, error: t('settings.custom_providers.error_models_required') };
  return { ok: true, models };
}

async function _settingsRefreshCustomProviders() {
  const res = await window.cogseed.invoke('customProviders.list');
  _settingsState.customProviders = (res && res.ok && Array.isArray(res.providers)) ? res.providers : [];
}

async function _settingsRefreshCcswitchStatus() {
  const res = await window.cogseed.invoke('customProviders.ccswitch.probe');
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

// ── 回收站（本机删除快照，可恢复 / 彻底删除）──
const _RECYCLE_KIND_LABEL = {
  conversation: '会话', conversations: '会话', project: '项目', auto_task: '自动化任务',
  attachment: '附件', context: '资料库/知识库', space_file: '空间文件', saved_app: '已保存应用',
  agent: '智能体', skill: '技能', workspace: '工作区', other: '其他',
};

async function _settingsRefreshRecycle() {
  try {
    const res = await window.cogseed.invoke('recycle.list');
    _settingsState.recycleBatches = (res && Array.isArray(res.batches)) ? res.batches : [];
  } catch (_) {
    _settingsState.recycleBatches = [];
  }
}

function _settingsRecycleTitle(batch) {
  const name = batch && (batch.label || batch.display_title);
  if (name) return String(name);
  const label = _RECYCLE_KIND_LABEL[String(batch && batch.kind || 'other')] || '其他';
  const paths = Array.isArray(batch && batch.paths_preview) ? batch.paths_preview : [];
  const first = paths[0] ? String(paths[0]).split('/').pop() : '';
  return first ? `${label} · ${first}` : label;
}

function _settingsRecycleMeta(batch) {
  const label = _RECYCLE_KIND_LABEL[String(batch && batch.kind || 'other')] || '其他';
  const n = Array.isArray(batch && batch.items) ? batch.items.length
    : (Array.isArray(batch && batch.paths_preview) ? batch.paths_preview.length : 0);
  const d = new Date(Number(batch && batch.created_at_ms) || Date.now());
  const pad = (x) => String(x).padStart(2, '0');
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${label} · ${n} 项 · 删除于 ${time}`;
}

function _settingsRenderRecycle() {
  const body = document.getElementById('settings-recycle-body');
  if (!body) return;
  const batches = _settingsState.recycleBatches || [];
  if (!batches.length) {
    body.innerHTML = '<div class="settings-empty">暂无可恢复数据</div>';
    return;
  }
  body.innerHTML = `<div class="settings-recycle-scroll">${batches.map((b) => {
    const id = String(b && b.id || '');
    return `<div class="settings-recycle-row">
      <div class="settings-recycle-row-head">
        <div class="settings-recycle-main">
          <div class="settings-recycle-name">${escapeHtml(_settingsRecycleTitle(b))}</div>
          <div class="settings-recycle-meta">${escapeHtml(_settingsRecycleMeta(b))}</div>
        </div>
        <div class="settings-recycle-actions">
          <button type="button" class="btn btn-sm" data-recycle-action="restore" data-recycle-id="${escapeHtml(id)}">恢复</button>
          <button type="button" class="btn btn-sm" data-recycle-action="delete" data-recycle-id="${escapeHtml(id)}">彻底删除</button>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
  body.querySelectorAll('[data-recycle-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.recycleId;
      if (!id) return;
      if (btn.dataset.recycleAction === 'restore') {
        try {
          const res = await window.cogseed.invoke('recycle.restore', { id });
          if (res && res.ok) {
            if (typeof uiToast === 'function') uiToast(`已恢复 ${Number(res.restored) || 0} 项`, { variant: 'success', timeoutMs: 2500 });
          } else if (typeof uiToast === 'function') uiToast('恢复失败', { variant: 'warning' });
        } catch (e) {
          if (typeof uiToast === 'function') uiToast('恢复失败：' + String((e && e.message) || e), { variant: 'error' });
        }
      } else {
        let ok = false;
        try {
          ok = typeof uiConfirmDanger === 'function'
            ? await uiConfirmDanger({ title: '彻底删除', message: '彻底删除后不可恢复，确认删除该回收站条目？', dangerLabel: '彻底删除', cancelLabel: '取消' })
            : window.confirm('彻底删除后不可恢复，确认删除？');
        } catch (_) { return; }
        if (!ok) return;
        try {
          const res = await window.cogseed.invoke('recycle.delete', { id });
          if (res && res.deleted) { if (typeof uiToast === 'function') uiToast('已彻底删除', { variant: 'success' }); }
          else if (typeof uiToast === 'function') uiToast('删除失败', { variant: 'warning' });
        } catch (e) {
          if (typeof uiToast === 'function') uiToast('删除失败：' + String((e && e.message) || e), { variant: 'error' });
        }
      }
      await _settingsRefreshRecycle();
      _settingsRenderRecycle();
    });
  });
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
    row.setAttribute('draggable', 'false');

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    primary.textContent = provider.name || provider.id;
    main.appendChild(primary);

    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    const modelCount = _settingsCustomProviderModels(provider).length;
    const metaBits = [
      _settingsCustomProviderApiFormatLabel(provider.protocol),
      provider.baseUrl,
      t('settings.custom_providers.model_count', { count: String(modelCount) }),
      provider.enabled === false ? t('common.disabled') : t('common.enabled'),
    ].filter(Boolean);
    meta.textContent = metaBits.join(' · ');
    main.appendChild(meta);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    actions.appendChild(_settingsCustomProviderActionButton(
      'settings',
      t('settings.custom_providers.manage'),
      'btn btn-sm settings-custom-provider-manage',
      () => _settingsOpenCustomProviderDetails(provider),
    ));
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function _settingsOpenCustomProviderModal(provider = null, options = {}) {
  const overlay = document.getElementById('settings-custom-provider-modal');
  const title = document.getElementById('settings-custom-provider-modal-title');
  const body = document.getElementById('settings-custom-provider-modal-body');
  const actions = document.getElementById('settings-custom-provider-modal-actions');
  const status = document.getElementById('settings-custom-provider-modal-status');
  if (!overlay || !title || !body || !actions || !status) return;
  const editing = !!provider?.id;
  const viewGeneration = _settingsSetCustomProviderModalView('provider-form', provider, null, options.preserveSession === true);
  title.textContent = editing ? t('settings.custom_providers.edit_title') : t('settings.custom_providers.add_title');
  body.innerHTML = `
    <p class="settings-custom-provider-modal-subtitle">${escapeHtml(editing ? t('settings.custom_providers.edit_subtitle') : t('settings.custom_providers.add_subtitle'))}</p>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.name'))}</label><input id="settings-custom-provider-name" type="text" class="form-input" autocomplete="off" spellcheck="false" /></div>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.base_url'))}</label><input id="settings-custom-provider-base-url" type="text" class="form-input" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1" /></div>
    <div class="form-row settings-custom-provider-secret-row"><label>${escapeHtml(t('settings.custom_providers.api_key'))}</label><div class="settings-custom-provider-secret-input"><input id="settings-custom-provider-api-key" type="password" class="form-input" autocomplete="new-password" spellcheck="false" placeholder="sk-..." /><button type="button" id="settings-custom-provider-api-key-toggle" class="icon-btn" title="${escapeHtml(t('settings.custom_providers.toggle_key_visibility'))}" aria-label="${escapeHtml(t('settings.custom_providers.toggle_key_visibility'))}">${_settingsIconHtml('eye', 'ui-icon')}</button></div></div>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.api_format'))}</label><div class="ai-select" id="settings-custom-provider-protocol"></div></div>
    ${editing ? '' : `<div class="form-row settings-custom-provider-model-editor"><label>${escapeHtml(t('settings.custom_providers.models'))}</label><div id="settings-custom-provider-model-list" class="settings-custom-provider-model-list"></div><button type="button" class="btn settings-custom-provider-add-model" id="settings-custom-provider-add-model">${_settingsIconHtml('plus', 'ui-icon')}<span>${escapeHtml(t('settings.custom_providers.add_model'))}</span></button></div>`}
  `;
  const nameInput = body.querySelector('#settings-custom-provider-name') || document.getElementById('settings-custom-provider-name');
  const protocolEl = body.querySelector('#settings-custom-provider-protocol') || document.getElementById('settings-custom-provider-protocol');
  // Custom-styled select (ai-select) instead of the native macOS picker.
  let protocolSel = null;
  if (protocolEl) {
    protocolSel = _aiSelectMount(protocolEl, { placeholder: t('settings.custom_providers.api_format') });
    protocolSel.setOptions([
      { value: 'anthropic', label: t('settings.custom_providers.api_format_anthropic') },
      { value: 'openai', label: t('settings.custom_providers.api_format_openai') },
      { value: 'openai-responses', label: t('settings.custom_providers.api_format_openai_responses') },
      { value: 'gemini', label: t('settings.custom_providers.api_format_gemini') },
    ], { value: provider?.protocol || 'anthropic' });
  }
  const baseUrlInput = body.querySelector('#settings-custom-provider-base-url') || document.getElementById('settings-custom-provider-base-url');
  const apiKeyInput = body.querySelector('#settings-custom-provider-api-key') || document.getElementById('settings-custom-provider-api-key');
  const apiKeyToggle = body.querySelector('#settings-custom-provider-api-key-toggle') || document.getElementById('settings-custom-provider-api-key-toggle');
  const modelList = body.querySelector('#settings-custom-provider-model-list') || document.getElementById('settings-custom-provider-model-list');
  const addModelButton = body.querySelector('#settings-custom-provider-add-model') || document.getElementById('settings-custom-provider-add-model');
  if (nameInput) nameInput.value = provider?.name || '';
  if (baseUrlInput) baseUrlInput.value = provider?.baseUrl || '';
  if (apiKeyInput) apiKeyInput.value = '';
  if (apiKeyInput && provider?.apiKeyMasked) apiKeyInput.placeholder = t('settings.custom_providers.api_key_placeholder_masked');
  if (apiKeyToggle && apiKeyInput) {
    apiKeyToggle.addEventListener('click', () => {
      apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    });
  }
  if (!editing && modelList) {
    modelList.innerHTML = '';
    _settingsAppendCustomProviderModelDraft(modelList);
    addModelButton?.addEventListener('click', () => {
      const row = _settingsAppendCustomProviderModelDraft(modelList);
      row?.querySelector('.settings-custom-provider-model-id')?.focus();
    });
  }
  actions.innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.addEventListener('click', () => _settingsCloseModal(overlay));
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = t('settings.save');
  saveBtn.dataset.customProviderActionKey = 'provider-save';
  _settingsSetCustomProviderButtonBusy(saveBtn, _settingsState.customProviderModalView?.busyActionKey === 'provider-save');
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    const name = String(nameInput?.value || '').trim();
    const protocol = String(protocolSel?.getValue() || 'anthropic').trim();
    const baseUrl = String(baseUrlInput?.value || '').trim();
    const apiKey = String(apiKeyInput?.value || '').trim();
    if (!name) { _settingsCustomProviderModalStatus('error', t('settings.custom_providers.error_name')); return; }
    if (!_settingsIsValidCustomProviderUrl(baseUrl)) { _settingsCustomProviderModalStatus('error', t('settings.custom_providers.error_base_url')); return; }
    if (!editing && !apiKey) { _settingsCustomProviderModalStatus('error', t('settings.custom_providers.error_api_key')); return; }
    const payload = { name, protocol, baseUrl, source: provider?.source || 'manual' };
    if (!editing) {
      const modelResult = _settingsReadCustomProviderModelDrafts(modelList);
      if (!modelResult.ok) { _settingsCustomProviderModalStatus('error', modelResult.error); return; }
      payload.models = modelResult.models;
    }
    if (apiKey) payload.apiKey = apiKey;
    if (provider?.id) payload.id = provider.id;
    if (!_settingsIsCustomProviderModalViewActive(viewGeneration, provider?.id || null)) return;
    _settingsCustomProviderModalStatus('', t('settings.custom_providers.saving'));
    _settingsSetCustomProviderModalActionBusy(viewGeneration, 'provider-save', true, saveBtn);
    const channel = provider?.id ? 'customProviders.update' : 'customProviders.add';
    const res = await _settingsCallCustomProvider(channel, payload);
    _settingsSetCustomProviderModalActionBusy(viewGeneration, 'provider-save', false, saveBtn);
    if (!res || !res.ok) {
      if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider?.id || null)) {
        _settingsCustomProviderModalStatus('error', (res && res.error) || t('settings.custom_providers.save_failed'));
      }
      return;
    }
    if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider?.id || null)) {
      _settingsCloseModal(overlay);
    }
    await _settingsReload();
    _settingsSetStatus('settings-picker-status', 'ok', editing ? t('settings.custom_providers.update_ok') : t('settings.custom_providers.add_ok'));
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  status.textContent = '';
  status.className = 'form-msg';
  _settingsOpenModal(overlay);
  setTimeout(() => nameInput?.focus(), 0);
}

function _settingsRerenderCustomProviderModalForI18n() {
  const overlay = document.getElementById('settings-custom-provider-modal');
  const view = _settingsState.customProviderModalView;
  if (!overlay?.classList.contains('open') || !view) return;

  const provider = view.providerId
    ? (_settingsCurrentCustomProvider(view.providerId) || view.provider)
    : view.provider;
  if (view.kind === 'details') {
    if (provider) _settingsOpenCustomProviderDetails(provider, { preserveSession: true });
    return;
  }

  if (view.kind === 'provider-form') {
    const body = document.getElementById('settings-custom-provider-modal-body');
    const name = body?.querySelector('#settings-custom-provider-name')?.value || '';
    const protocol = body?.querySelector('#settings-custom-provider-protocol')?.dataset.value || 'anthropic';
    const baseUrl = body?.querySelector('#settings-custom-provider-base-url')?.value || '';
    const apiKey = body?.querySelector('#settings-custom-provider-api-key')?.value || '';
    const draftList = body?.querySelector('#settings-custom-provider-model-list');
    const drafts = [];
    for (const row of draftList?.querySelectorAll('.settings-custom-provider-model-draft') || []) {
      drafts.push({
        id: row.querySelector('.settings-custom-provider-model-id')?.value || '',
        contextWindow: Number(row.querySelector('.settings-custom-provider-model-context')?.value) || _CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW,
        maxTokens: Number(row.querySelector('.settings-custom-provider-model-output')?.value) || _CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
      });
    }
    _settingsOpenCustomProviderModal(provider, { preserveSession: true });
    const nextBody = document.getElementById('settings-custom-provider-modal-body');
    const nextName = nextBody?.querySelector('#settings-custom-provider-name');
    const nextBaseUrl = nextBody?.querySelector('#settings-custom-provider-base-url');
    const nextApiKey = nextBody?.querySelector('#settings-custom-provider-api-key');
    if (nextName) nextName.value = name;
    if (nextBaseUrl) nextBaseUrl.value = baseUrl;
    if (nextApiKey) nextApiKey.value = apiKey;
    const nextDraftList = nextBody?.querySelector('#settings-custom-provider-model-list');
    if (nextDraftList && drafts.length) {
      nextDraftList.innerHTML = '';
      for (const draft of drafts) _settingsAppendCustomProviderModelDraft(nextDraftList, draft);
    }
    return;
  }

  if (view.kind === 'model-form' && provider) {
    const body = document.getElementById('settings-custom-provider-modal-body');
    const id = body?.querySelector('#settings-custom-provider-model-edit-id')?.value || '';
    const contextWindow = body?.querySelector('#settings-custom-provider-model-edit-context')?.value || '';
    const maxTokens = body?.querySelector('#settings-custom-provider-model-edit-output')?.value || '';
    _settingsOpenCustomProviderModelEditor(provider, view.model, { preserveSession: true });
    const nextBody = document.getElementById('settings-custom-provider-modal-body');
    const nextId = nextBody?.querySelector('#settings-custom-provider-model-edit-id');
    const nextContext = nextBody?.querySelector('#settings-custom-provider-model-edit-context');
    const nextOutput = nextBody?.querySelector('#settings-custom-provider-model-edit-output');
    if (nextId) nextId.value = id;
    if (nextContext) nextContext.value = contextWindow;
    if (nextOutput) nextOutput.value = maxTokens;
  }
}

function _settingsOpenCustomProviderDetails(provider, options = {}) {
  const overlay = document.getElementById('settings-custom-provider-modal');
  const title = document.getElementById('settings-custom-provider-modal-title');
  const body = document.getElementById('settings-custom-provider-modal-body');
  const actions = document.getElementById('settings-custom-provider-modal-actions');
  if (!overlay || !title || !body || !actions || !provider?.id) return;
  _settingsSetCustomProviderModalView('details', provider, null, options.preserveSession === true);
  const models = _settingsCustomProviderModels(provider);
  const enabled = provider.enabled !== false;
  title.textContent = provider.name || provider.id;
  body.innerHTML = `
    <div class="settings-custom-provider-detail-toolbar">
      <span class="settings-custom-provider-state ${enabled ? 'is-enabled' : 'is-disabled'}">${escapeHtml(enabled ? t('common.enabled') : t('common.disabled'))}</span>
      <div class="settings-custom-provider-detail-actions" id="settings-custom-provider-detail-actions"></div>
    </div>
    <dl class="settings-custom-provider-facts">
      <div><dt>${escapeHtml(t('settings.custom_providers.base_url'))}</dt><dd>${escapeHtml(provider.baseUrl || '')}</dd></div>
      <div><dt>${escapeHtml(t('settings.custom_providers.api_format'))}</dt><dd>${escapeHtml(_settingsCustomProviderApiFormatLabel(provider.protocol))}</dd></div>
      <div><dt>${escapeHtml(t('settings.custom_providers.api_key'))}</dt><dd class="account-mask">${escapeHtml(provider.apiKeyMasked || t('settings.custom_providers.api_key_missing'))}</dd></div>
    </dl>
    <div class="settings-custom-provider-detail-models">
      <div class="settings-custom-provider-detail-models-head"><h4>${escapeHtml(t('settings.custom_providers.models'))}</h4><button type="button" class="btn" id="settings-custom-provider-detail-add-model">${_settingsIconHtml('plus', 'ui-icon')}<span>${escapeHtml(t('settings.custom_providers.add_model'))}</span></button></div>
      <div id="settings-custom-provider-detail-model-list" class="settings-custom-provider-detail-model-list"></div>
    </div>
  `;
  const detailActions = body.querySelector('#settings-custom-provider-detail-actions') || document.getElementById('settings-custom-provider-detail-actions');
  detailActions?.appendChild(_settingsCustomProviderActionButton(
    'edit-pencil', t('settings.custom_providers.edit_provider'), 'btn btn-sm',
    () => _settingsOpenCustomProviderModal(provider),
  ));
  detailActions?.appendChild(_settingsCustomProviderActionButton(
    enabled ? 'x' : 'check',
    enabled ? t('settings.custom_providers.disable') : t('settings.custom_providers.enable'),
    'btn btn-sm',
    () => _settingsSetCustomProviderEnabled(provider, !enabled),
  ));
  detailActions?.appendChild(_settingsCustomProviderActionButton(
    'trash', t('settings.custom_providers.delete_provider'), 'icon-btn danger',
    () => _settingsRemoveCustomProvider(provider),
  ));

  const modelList = body.querySelector('#settings-custom-provider-detail-model-list') || document.getElementById('settings-custom-provider-detail-model-list');
  if (modelList) {
    if (!models.length) {
      modelList.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.custom_providers.empty_models'))}</div>`;
    } else {
      for (const model of models) {
        const row = document.createElement('div');
        row.className = 'settings-custom-provider-detail-model-row';
        const info = document.createElement('div');
        info.className = 'settings-custom-provider-detail-model-info';
        info.innerHTML = `<strong>${escapeHtml(model.id)}</strong><span>${escapeHtml(t('settings.custom_providers.context_badge', { value: _settingsFormatTokenLimit(model.contextWindow) }))}</span><span>${escapeHtml(t('settings.custom_providers.output_badge', { value: _settingsFormatTokenLimit(model.maxTokens) }))}</span>`;
        const rowActions = document.createElement('div');
        rowActions.className = 'settings-custom-provider-detail-model-actions';
        rowActions.appendChild(_settingsCustomProviderActionButton('zap', t('settings.custom_providers.test_model'), 'icon-btn', () => _settingsTestCustomProviderModel(provider, model)));
        rowActions.appendChild(_settingsCustomProviderActionButton('edit-pencil', t('settings.custom_providers.edit_model'), 'icon-btn', () => _settingsOpenCustomProviderModelEditor(provider, model)));
        rowActions.appendChild(_settingsCustomProviderActionButton('trash', t('settings.custom_providers.remove_model'), 'icon-btn danger', () => _settingsRemoveCustomProviderModel(provider, model.id)));
        row.appendChild(info);
        row.appendChild(rowActions);
        modelList.appendChild(row);
      }
    }
  }
  const addModelButton = body.querySelector('#settings-custom-provider-detail-add-model') || document.getElementById('settings-custom-provider-detail-add-model');
  addModelButton?.addEventListener('click', () => _settingsOpenCustomProviderModelEditor(provider));
  // 远端模型发现：调服务自己的 list-models 端点拉全量清单，勾选导入。
  const fetchModelsButton = document.createElement('button');
  fetchModelsButton.type = 'button';
  fetchModelsButton.className = 'btn';
  fetchModelsButton.innerHTML = `${_settingsIconHtml('refresh', 'ui-icon')}<span>${escapeHtml(t('settings.custom_providers.fetch_models'))}</span>`;
  fetchModelsButton.addEventListener('click', () => _settingsOpenCustomProviderFetchModels(provider));
  addModelButton?.parentNode?.appendChild(fetchModelsButton);

  actions.innerHTML = '';
  const closeButton = document.createElement('button');
  closeButton.className = 'btn';
  closeButton.textContent = t('common.close');
  closeButton.addEventListener('click', () => _settingsCloseModal(overlay));
  actions.appendChild(closeButton);
  _settingsCustomProviderModalStatus('', '');
  if (!overlay.classList.contains('open')) _settingsOpenModal(overlay);
}

/** 远端模型发现视图：打开即向服务发起 list-models 请求，结果按勾选导入。
 *  已在本地的模型标记「已存在」不可重复勾选；导入走 customProviders.model.add
 *  逐个落库（窗口/输出上限用默认值，可在导入后按需编辑）。 */
async function _settingsOpenCustomProviderFetchModels(provider) {
  const overlay = document.getElementById('settings-custom-provider-modal');
  const title = document.getElementById('settings-custom-provider-modal-title');
  const body = document.getElementById('settings-custom-provider-modal-body');
  const actions = document.getElementById('settings-custom-provider-modal-actions');
  if (!overlay || !title || !body || !actions || !provider?.id) return;
  _settingsSetCustomProviderModalView('fetch-models', provider, null, false);
  title.textContent = t('settings.custom_providers.fetch_models_title', { name: provider.name || provider.id });
  body.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.custom_providers.fetch_models_loading'))}</div>`;
  actions.innerHTML = '';

  const existing = new Set(_settingsCustomProviderModels(provider).map((model) => model.id));
  const res = await _settingsCallCustomProvider('customProviders.fetchModels', { providerId: provider.id });
  // Modal may have been closed / navigated while the request was in flight.
  const viewActive = _settingsState.customProviderModalView
    && _settingsState.customProviderModalView.providerId === provider.id
    && _settingsState.customProviderModalView.kind === 'fetch-models'
    && overlay.classList.contains('open');
  if (!viewActive) return;
  if (!res || !res.ok) {
    body.innerHTML = `
      <div class="settings-custom-provider-fetch-error">
        ${_settingsIconHtml('warning', 'ui-icon')}
        <span>${escapeHtml(t('settings.custom_providers.fetch_models_failed', { error: (res && res.error) || '' }))}</span>
      </div>`;
    const closeButton = document.createElement('button');
    closeButton.className = 'btn';
    closeButton.textContent = t('common.close');
    closeButton.addEventListener('click', () => _settingsOpenCustomProviderDetails(provider));
    actions.appendChild(closeButton);
    return;
  }

  const rows = (res.models || []).slice(0, 200);
  const selectable = rows.filter((row) => !existing.has(row.id));
  body.innerHTML = `
    <p class="settings-custom-provider-modal-subtitle">${escapeHtml(t('settings.custom_providers.fetch_models_hint'))}</p>
    <div class="settings-custom-provider-fetch-list" id="settings-custom-provider-fetch-list"></div>
  `;
  const listEl = body.querySelector('#settings-custom-provider-fetch-list');
  for (const row of rows) {
    const isExisting = existing.has(row.id);
    const rowEl = document.createElement('label');
    rowEl.className = 'settings-custom-provider-fetch-row' + (isExisting ? ' is-existing' : '');
    rowEl.innerHTML = `
      <input type="checkbox" value="${escapeHtml(row.id)}" ${isExisting ? 'disabled' : 'checked'} />
      <span class="settings-custom-provider-fetch-name">${escapeHtml(row.name ? `${row.name} (${row.id})` : row.id)}</span>
      ${isExisting ? `<span class="settings-custom-provider-fetch-badge">${escapeHtml(t('settings.custom_providers.fetch_models_existing'))}</span>` : ''}
    `;
    listEl.appendChild(rowEl);
  }

  actions.innerHTML = '';
  const cancelButton = document.createElement('button');
  cancelButton.className = 'btn';
  cancelButton.textContent = t('common.cancel');
  cancelButton.addEventListener('click', () => _settingsOpenCustomProviderDetails(provider));
  actions.appendChild(cancelButton);
  const importButton = document.createElement('button');
  importButton.className = 'btn btn-primary';
  importButton.textContent = t('settings.custom_providers.fetch_models_import', { count: selectable.length });
  importButton.disabled = selectable.length === 0;
  importButton.addEventListener('click', async () => {
    if (importButton.disabled) return;
    const picked = [...listEl.querySelectorAll('input[type=checkbox]:checked:not(:disabled)')]
      .map((input) => input.value)
      .filter((id) => !existing.has(id));
    if (!picked.length) return;
    importButton.disabled = true;
    let imported = 0;
    let firstError = '';
    for (const id of picked) {
      const normalized = _settingsNormalizeCustomProviderModel({
        id,
        contextWindow: _CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW,
        maxTokens: _CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
      });
      if (!normalized.ok) { if (!firstError) firstError = `${id}: ${normalized.error}`; continue; }
      const added = await _settingsCallCustomProvider('customProviders.model.add', {
        providerId: provider.id,
        model: normalized.model,
      });
      if (added && added.ok) imported += 1;
      else if (!firstError) firstError = `${id}: ${(added && added.error) || 'failed'}`;
    }
    if (imported > 0) await _settingsReload();
    const refreshed = _settingsState.customProviders.find((item) => item.id === provider.id);
    if (refreshed) _settingsOpenCustomProviderDetails(refreshed, { preserveSession: true });
    if (firstError) _settingsCustomProviderModalStatus('error', t('settings.custom_providers.fetch_models_partial', { ok: imported, error: firstError }));
    else if (imported > 0) _settingsCustomProviderModalStatus('', t('settings.custom_providers.fetch_models_done', { count: imported }));
  });
  actions.appendChild(importButton);
}

async function _settingsSetCustomProviderEnabled(provider, enabled) {  const viewGeneration = _settingsState.customProviderModalView?.generation || 0;
  return _settingsWithCustomProviderAction(`provider:enabled:${provider.id}`, async () => {
    if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsCustomProviderModalStatus('', t(enabled ? 'settings.custom_providers.enabling' : 'settings.custom_providers.disabling'));
    }
    const res = await _settingsCallCustomProvider('customProviders.setEnabled', { id: provider.id, enabled: !!enabled });
    if (!res || !res.ok) {
      if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
        _settingsCustomProviderModalStatus('error', (res && res.error) || t('settings.custom_providers.enable_failed'));
      }
      return false;
    }
    await _settingsReload();
    const refreshed = _settingsState.customProviders.find((item) => item.id === provider.id);
    if (refreshed && _settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsOpenCustomProviderDetails(refreshed, { preserveSession: true });
    }
    return true;
  });
}

async function _settingsRemoveCustomProvider(provider) {
  const viewGeneration = _settingsState.customProviderModalView?.generation || 0;
  return _settingsWithCustomProviderAction(`provider:remove:${provider.id}`, async () => {
    const confirmed = typeof uiConfirm === 'function'
      ? await uiConfirm(t('settings.custom_providers.confirm_delete', { name: provider.name || provider.id }))
      : true;
    if (!confirmed) return false;
    if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsCustomProviderModalStatus('', t('settings.custom_providers.deleting'));
    }
    const res = await _settingsCallCustomProvider('customProviders.remove', { id: provider.id });
    if (!res || !res.ok) {
      if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
        _settingsCustomProviderModalStatus('error', (res && res.error) || t('settings.custom_providers.delete_failed'));
      }
      return false;
    }
    const overlay = document.getElementById('settings-custom-provider-modal');
    if (overlay && _settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsCloseModal(overlay);
    }
    await _settingsReload();
    _settingsSetStatus('settings-custom-providers-status', 'ok', t('settings.custom_providers.delete_ok'));
    return true;
  });
}

function _settingsOpenCustomProviderModelEditor(provider, model = null, options = {}) {
  const overlay = document.getElementById('settings-custom-provider-modal');
  const title = document.getElementById('settings-custom-provider-modal-title');
  const body = document.getElementById('settings-custom-provider-modal-body');
  const actions = document.getElementById('settings-custom-provider-modal-actions');
  if (!overlay || !title || !body || !actions || !provider?.id) return;
  const editing = !!model?.id;
  _settingsSetCustomProviderModalView('model-form', provider, model, options.preserveSession === true);
  const current = model || {
    id: '', contextWindow: _CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW, maxTokens: _CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
  };
  title.textContent = editing ? t('settings.custom_providers.edit_model') : t('settings.custom_providers.add_model');
  body.innerHTML = `
    <p class="settings-custom-provider-modal-subtitle">${escapeHtml(provider.name || provider.id)}</p>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.model_id'))}</label><input id="settings-custom-provider-model-edit-id" type="text" class="form-input" autocomplete="off" spellcheck="false" value="${escapeHtml(current.id)}" /></div>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.context_window'))}</label><input id="settings-custom-provider-model-edit-context" type="number" min="1" max="${_CUSTOM_PROVIDER_MAX_CONTEXT_WINDOW}" step="1" class="form-input" value="${escapeHtml(String(current.contextWindow))}" /></div>
    <div class="form-row"><label>${escapeHtml(t('settings.custom_providers.max_tokens'))}</label><input id="settings-custom-provider-model-edit-output" type="number" min="1" max="${_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS}" step="1" class="form-input" value="${escapeHtml(String(current.maxTokens))}" /></div>
  `;
  actions.innerHTML = '';
  const cancelButton = document.createElement('button');
  cancelButton.className = 'btn';
  cancelButton.textContent = t('common.cancel');
  cancelButton.addEventListener('click', () => _settingsOpenCustomProviderDetails(provider));
  const saveButton = document.createElement('button');
  saveButton.className = 'btn btn-primary';
  saveButton.textContent = t('common.save');
  saveButton.dataset.customProviderActionKey = 'model-save';
  _settingsSetCustomProviderButtonBusy(saveButton, _settingsState.customProviderModalView?.busyActionKey === 'model-save');
  saveButton.addEventListener('click', async () => {
    if (saveButton.disabled) return;
    const viewGeneration = _settingsState.customProviderModalView?.generation || 0;
    _settingsSetCustomProviderModalActionBusy(viewGeneration, 'model-save', true, saveButton);
    const saved = await _settingsSaveCustomProviderModel(provider, editing ? model.id : null, {
      id: body.querySelector('#settings-custom-provider-model-edit-id')?.value,
      contextWindow: Number(body.querySelector('#settings-custom-provider-model-edit-context')?.value),
      maxTokens: Number(body.querySelector('#settings-custom-provider-model-edit-output')?.value),
    });
    _settingsSetCustomProviderModalActionBusy(viewGeneration, 'model-save', false, saveButton);
    if (!saved) return;
  });
  actions.appendChild(cancelButton);
  actions.appendChild(saveButton);
  _settingsCustomProviderModalStatus('', '');
  if (!overlay.classList.contains('open')) _settingsOpenModal(overlay);
  setTimeout(() => body.querySelector('#settings-custom-provider-model-edit-id')?.focus(), 0);
}

async function _settingsSaveCustomProviderModel(provider, previousModelId, input) {
  const normalized = _settingsNormalizeCustomProviderModel(input);
  if (!normalized.ok) {
    _settingsCustomProviderModalStatus('error', normalized.error);
    return false;
  }
  const viewGeneration = _settingsState.customProviderModalView?.generation || 0;
  return _settingsWithCustomProviderAction(`model:save:${provider.id}:${previousModelId || normalized.model.id}`, async () => {
    if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsCustomProviderModalStatus('', t('settings.custom_providers.saving_model'));
    }
    const updating = !!previousModelId;
    const channel = updating ? 'customProviders.model.update' : 'customProviders.model.add';
    const payload = {
      providerId: provider.id,
      ...(updating ? { modelId: previousModelId } : {}),
      model: normalized.model,
    };
    const res = await _settingsCallCustomProvider(channel, payload);
    if (!res || !res.ok) {
      if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
        _settingsCustomProviderModalStatus('error', (res && res.error) || t('settings.custom_providers.save_model_failed'));
      }
      return false;
    }
    await _settingsReload();
    const refreshed = _settingsState.customProviders.find((item) => item.id === provider.id);
    if (refreshed && _settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsOpenCustomProviderDetails(refreshed, { preserveSession: true });
    }
    return true;
  });
}

async function _settingsRemoveCustomProviderModel(provider, modelId) {
  const viewGeneration = _settingsState.customProviderModalView?.generation || 0;
  return _settingsWithCustomProviderAction(`model:remove:${provider.id}:${modelId}`, async () => {
    const confirmed = typeof uiConfirm === 'function'
      ? await uiConfirm(t('settings.custom_providers.confirm_remove_model', { model: modelId }))
      : true;
    if (!confirmed) return false;
    if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsCustomProviderModalStatus('', t('settings.custom_providers.removing_model'));
    }
    const res = await _settingsCallCustomProvider('customProviders.model.remove', { providerId: provider.id, modelId });
    if (!res || !res.ok) {
      if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
        _settingsCustomProviderModalStatus('error', (res && res.error) || t('settings.custom_providers.remove_model_failed'));
      }
      return false;
    }
    await _settingsReload();
    const refreshed = _settingsState.customProviders.find((item) => item.id === provider.id);
    if (refreshed && _settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsOpenCustomProviderDetails(refreshed, { preserveSession: true });
    }
    return true;
  });
}

async function _settingsTestCustomProviderModel(provider, model) {
  const viewGeneration = _settingsState.customProviderModalView?.generation || 0;
  return _settingsWithCustomProviderAction(`model:test:${provider.id}:${model.id}`, async () => {
    if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsCustomProviderModalStatus('', t('settings.custom_providers.testing_model', { model: model.id }));
    }
    const res = await _settingsCallCustomProvider('customProviders.model.test', { providerId: provider.id, modelId: model.id });
    if (!res || !res.ok) {
      if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
        _settingsCustomProviderModalStatus('error', (res && res.error) || t('settings.custom_providers.test_model_failed'));
      }
      return false;
    }
    const duration = Number.isFinite(res.durationMs) ? ` ${res.durationMs} ms` : '';
    if (_settingsIsCustomProviderModalViewActive(viewGeneration, provider.id)) {
      _settingsCustomProviderModalStatus('ok', `${t('settings.custom_providers.test_model_ok')}${duration}`);
    }
    return true;
  });
}

async function _settingsOpenCcswitchPreviewDialog() {
  const overlay = document.getElementById('settings-ccswitch-preview-modal');
  if (!overlay) return;
  const title = document.getElementById('settings-ccswitch-preview-modal-title');
  if (title) title.textContent = t('settings.ccswitch.preview_title');
  const closeBtn = document.getElementById('settings-ccswitch-preview-close-btn');
  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', () => _settingsCloseModal(overlay));
  }
  // Fresh dialog: start at the provider list, forget any in-progress detail view.
  _settingsState.ccswitchPreviewSelectedProvider = null;
  _settingsState.ccswitchPreviewSelectedModels = [];
  const gen = ++_settingsState.ccswitchPreviewGeneration;
  _settingsRenderCcswitchPreviewDialog('loading');
  _settingsOpenModal(overlay);
  const res = await window.cogseed.invoke('customProviders.ccswitch.preview');
  if (gen !== _settingsState.ccswitchPreviewGeneration || !overlay.classList.contains('open')) return;
  _settingsState.ccswitchPreviewRows = (res && res.ok && Array.isArray(res.items)) ? res.items : [];
  _settingsState.ccswitchPreviewUnsupported = (res && res.ok && Array.isArray(res.unsupported)) ? res.unsupported : [];
  _settingsRenderCcswitchPreviewDialog('providers');
}

// ── Step 1: provider list. Clicking a row drills into its model scan. ──
function _settingsCcswitchRenderProviderList() {
  const overlay = document.getElementById('settings-ccswitch-preview-modal');
  const body = document.getElementById('settings-ccswitch-preview-modal-body');
  const actions = document.getElementById('settings-ccswitch-preview-modal-actions');
  const status = document.getElementById('settings-ccswitch-preview-modal-status');
  if (!overlay || !body || !actions || !status) return;
  body.innerHTML = '';
  status.textContent = '';
  status.className = 'form-msg';
  const rows = _settingsState.ccswitchPreviewRows || [];

  if (!rows.length) {
    const plugIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
      ? window.uiIconHtml('plug', 'ui-icon settings-ccswitch-empty-icon')
      : '';
    body.innerHTML = `
      <div class="settings-ccswitch-empty">
        ${plugIcon}
        <span>${escapeHtml(t('settings.ccswitch.preview_empty'))}</span>
      </div>`;
  } else {
    const sub = document.createElement('div');
    sub.className = 'settings-ccswitch-sub';
    sub.textContent = t('settings.ccswitch.provider_step_sub', { count: String(rows.length) });
    body.appendChild(sub);

    const list = document.createElement('div');
    list.className = 'settings-ccswitch-list';
    const arrowIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
      ? window.uiIconHtml('chevron-right', 'ui-icon settings-ccswitch-row-chevron')
      : '›';
    rows.forEach((row) => {
      const item = document.createElement('div');
      item.className = 'settings-ccswitch-row settings-ccswitch-provider-row';
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      const metaBits = [];
      if (row.baseUrl) metaBits.push(String(row.baseUrl));
      const masked = row.apiKeyMasked || row.maskedKey;
      if (masked) metaBits.push(String(masked));
      const modelCount = Array.isArray(row.models) ? row.models.length : 0;
      item.innerHTML = `
        <span class="settings-ccswitch-row-main">
          <span class="settings-ccswitch-row-top">
            <span class="settings-ccswitch-row-name">${escapeHtml(row.name || row.externalId)}</span>
            <span class="account-type-badge">${escapeHtml(_settingsCustomProviderProtocolLabel(row.protocol))}</span>
            ${modelCount > 0 ? `<span class="settings-ccswitch-row-count">${escapeHtml(t('settings.custom_providers.model_count', { count: String(modelCount) }))}</span>` : ''}
          </span>
          <span class="settings-ccswitch-row-meta">${escapeHtml(metaBits.join(' · '))}</span>
        </span>
        ${row.needsKey || row.missingKey ? `<span class="settings-ccswitch-row-warn">${escapeHtml(t('settings.ccswitch.missing_key'))}</span>` : ''}
        ${arrowIcon}
      `;
      const enter = () => {
        _settingsState.ccswitchPreviewSelectedProvider = row;
        _settingsState.ccswitchPreviewSelectedModels = [];
        _settingsRenderCcswitchPreviewDialog('provider-detail');
      };
      item.addEventListener('click', enter);
      item.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(); }
      });
      list.appendChild(item);
    });
    body.appendChild(list);

    const unsupported = _settingsState.ccswitchPreviewUnsupported || [];
    if (unsupported.length) {
      const hint = document.createElement('div');
      hint.className = 'settings-ccswitch-unsupported';
      hint.title = unsupported.map((u) => `${u.name || u.externalId}: ${u.reason || ''}`).join('\n');
      hint.textContent = t('settings.ccswitch.unsupported_hint', { count: String(unsupported.length) });
      body.appendChild(hint);
    }
  }

  actions.innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = t('common.close');
  cancelBtn.addEventListener('click', () => _settingsCloseModal(overlay));
  actions.appendChild(cancelBtn);
}

// ── Step 2: one provider's detected models; check the ones to add. ──
function _settingsCcswitchRenderProviderDetail(provider) {
  const overlay = document.getElementById('settings-ccswitch-preview-modal');
  const body = document.getElementById('settings-ccswitch-preview-modal-body');
  const actions = document.getElementById('settings-ccswitch-preview-modal-actions');
  const status = document.getElementById('settings-ccswitch-preview-modal-status');
  if (!overlay || !body || !actions || !status) return;
  body.innerHTML = '';
  status.textContent = '';
  status.className = 'form-msg';

  const backBtn = document.createElement('button');
  backBtn.className = 'settings-ccswitch-back-btn';
  backBtn.type = 'button';
  backBtn.innerHTML = `${(typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') ? window.uiIconHtml('chevron-left', 'ui-icon settings-ccswitch-back-icon') : '‹ '}<span>${escapeHtml(t('settings.ccswitch.back'))}</span>`;
  backBtn.addEventListener('click', () => {
    _settingsState.ccswitchPreviewSelectedProvider = null;
    _settingsState.ccswitchPreviewSelectedModels = [];
    _settingsRenderCcswitchPreviewDialog('providers');
  });
  body.appendChild(backBtn);

  const head = document.createElement('div');
  head.className = 'settings-ccswitch-provider-head';
  const metaBits = [];
  if (provider.baseUrl) metaBits.push(String(provider.baseUrl));
  const masked = provider.apiKeyMasked || provider.maskedKey;
  if (masked) metaBits.push(String(masked));
  head.innerHTML = `
    <div class="settings-ccswitch-provider-title-row">
      <span class="settings-ccswitch-provider-name">${escapeHtml(provider.name || provider.externalId)}</span>
      <span class="account-type-badge">${escapeHtml(_settingsCustomProviderProtocolLabel(provider.protocol))}</span>
      ${provider.needsKey || provider.missingKey ? `<span class="settings-ccswitch-row-warn">${escapeHtml(t('settings.ccswitch.missing_key'))}</span>` : ''}
    </div>
    <div class="settings-ccswitch-provider-meta">${escapeHtml(metaBits.join(' · '))}</div>
  `;
  body.appendChild(head);

  const models = Array.isArray(provider.models) ? provider.models : [];
  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-ccswitch-no-models';
    empty.textContent = t('settings.ccswitch.no_models');
    body.appendChild(empty);
  } else {
    const sub = document.createElement('div');
    sub.className = 'settings-ccswitch-sub';
    // Probe succeeded → live model list; failed → config hints (unverified).
    sub.textContent = provider.modelsProbe === false
      ? t('settings.ccswitch.models_step_sub_fallback', { count: String(models.length) })
      : t('settings.ccswitch.models_step_sub', { count: String(models.length) });
    body.appendChild(sub);

    const list = document.createElement('div');
    list.className = 'settings-ccswitch-list';
    models.forEach((model) => {
      const id = String(model && typeof model === 'object' ? (model.id || model.name || '') : model || '');
      if (!id) return;
      const selected = _settingsState.ccswitchPreviewSelectedModels.includes(id);
      const item = document.createElement('label');
      item.className = 'settings-ccswitch-model-row' + (selected ? ' is-selected' : '');
      item.innerHTML = `
        <input type="checkbox" class="settings-ccswitch-model-check" ${selected ? 'checked' : ''} />
        <span class="settings-ccswitch-model-id">${escapeHtml(id)}</span>
      `;
      const cb = item.querySelector('.settings-ccswitch-model-check');
      cb?.addEventListener('change', () => {
        if (cb.checked) {
          if (!_settingsState.ccswitchPreviewSelectedModels.includes(id)) _settingsState.ccswitchPreviewSelectedModels.push(id);
          item.classList.add('is-selected');
        } else {
          _settingsState.ccswitchPreviewSelectedModels = _settingsState.ccswitchPreviewSelectedModels.filter((m) => m !== id);
          item.classList.remove('is-selected');
        }
        _settingsSyncCcswitchPreviewUi();
      });
      list.appendChild(item);
    });
    body.appendChild(list);
  }

  actions.innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = t('common.close');
  cancelBtn.addEventListener('click', () => _settingsCloseModal(overlay));
  actions.appendChild(cancelBtn);
  if (models.length) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary';
    addBtn.id = 'settings-ccswitch-preview-sync-btn';
    addBtn.addEventListener('click', async () => {
      if (addBtn.disabled) return;
      const modelIds = _settingsState.ccswitchPreviewSelectedModels;
      if (!modelIds.length) return;
      addBtn.disabled = true;
      addBtn.classList.add('is-loading');
      status.textContent = t('settings.ccswitch.syncing');
      status.className = 'form-msg';
      // ONE provider instance per import: the provider carries exactly the
      // user-selected models (not the full probed list), and the configured
      // list gets a single default entry whose model picker offers those
      // models to switch between.
      const syncRes = await window.cogseed.invoke('customProviders.ccswitch.sync', {
        externalIds: [provider.externalId],
        modelsByExternalId: { [provider.externalId]: modelIds },
        // The probe pins the real API base (CC Switch bare-host URLs lack /v1).
        baseUrlsByExternalId: { [provider.externalId]: provider.baseUrl },
        // Probed model abilities (context window, vision) ride along —
        // aggregator endpoints volunteer them; plain OpenAI-compatible ones
        // have none and this stays empty.
        abilitiesByExternalId: { [provider.externalId]: provider.modelAbilities || {} },
      });
      if (!syncRes || !syncRes.ok) {
        addBtn.classList.remove('is-loading');
        status.textContent = (syncRes && syncRes.error) || t('settings.ccswitch.sync_failed');
        status.className = 'form-msg error';
        _settingsSyncCcswitchPreviewUi();
        return;
      }
      await _settingsRefreshCustomProviders();
      await _settingsRefreshEntries();
      const cp = _settingsState.customProviders.find((p) => p.source === 'ccswitch' && p.externalId === provider.externalId);
      if (!cp) {
        addBtn.classList.remove('is-loading');
        status.textContent = t('settings.ccswitch.sync_failed');
        status.className = 'form-msg error';
        _settingsSyncCcswitchPreviewUi();
        return;
      }
      const providerId = `cp:${cp.id}`;
      const defaultModel = modelIds[0];
      // Drop every other entry of this provider (including leftovers from
      // earlier imports), keep exactly one default entry.
      for (const entry of _settingsState.entries) {
        if (entry.provider === providerId && entry.model !== defaultModel) {
          await window.cogseed.invoke('auth.removeEntry', { entryId: entry.entryId });
        }
      }
      // Idempotent: sync already auto-bound the first model; this is a no-op
      // when it exists.
      await window.cogseed.invoke('auth.addEntry', { provider: providerId, model: defaultModel, profileId: providerId });
      await _settingsReload();
      _settingsCloseModal(overlay);
      _settingsSetStatus('settings-picker-status', 'ok', t('settings.ccswitch.sync_ok'));
    });
    actions.appendChild(addBtn);
  }
  _settingsSyncCcswitchPreviewUi();
}

// Refresh count + import button from the current detail-view selection.
function _settingsSyncCcswitchPreviewUi() {
  const body = document.getElementById('settings-ccswitch-preview-modal-body');
  const actions = document.getElementById('settings-ccswitch-preview-modal-actions');
  if (!body || !actions) return;
  const selected = _settingsState.ccswitchPreviewSelectedModels.length;
  const addBtn = actions.querySelector('#settings-ccswitch-preview-sync-btn');
  if (addBtn) {
    addBtn.disabled = selected === 0;
    addBtn.textContent = t('settings.ccswitch.add_models_with_count', { count: String(selected) });
  }
}

function _settingsRenderCcswitchPreviewDialog(mode) {
  const overlay = document.getElementById('settings-ccswitch-preview-modal');
  const body = document.getElementById('settings-ccswitch-preview-modal-body');
  const actions = document.getElementById('settings-ccswitch-preview-modal-actions');
  const status = document.getElementById('settings-ccswitch-preview-modal-status');
  if (!overlay || !body || !actions || !status) return;

  if (mode === 'loading') {
    body.innerHTML = `<div class="settings-ccswitch-loading">${escapeHtml(t('settings.ccswitch.loading'))}</div>`;
    actions.innerHTML = '';
    status.textContent = '';
    status.className = 'form-msg';
    return;
  }

  const provider = _settingsState.ccswitchPreviewSelectedProvider;
  if (provider) {
    _settingsCcswitchRenderProviderDetail(provider);
  } else {
    _settingsCcswitchRenderProviderList();
  }
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
  const res = await window.cogseed.invoke('auth.listModels', { provider: providerId });
  const list = (res && res.ok && Array.isArray(res.models)) ? res.models : [];
  _settingsState.modelsCache[providerId] = list;
  return list;
}

// ── Picker (provider + model + add button) ──
// The provider dropdown ends with two action rows (instead of a separate
// "custom endpoints" card): "Custom providers" opens the add-provider
// dialog, "CC Switch import" opens the CC Switch preview/import dialog.
// These are pseudo-options — picking one restores the previously selected
// provider and runs the action.
const _PICKER_ACTION_CUSTOM_PROVIDERS = '__picker-action-custom-providers__';
const _PICKER_ACTION_CCSWITCH_IMPORT  = '__picker-action-ccswitch-import__';

function _settingsPickerActionForValue(val) {
  if (val === _PICKER_ACTION_CUSTOM_PROVIDERS) return 'custom-providers';
  if (val === _PICKER_ACTION_CCSWITCH_IMPORT) return 'ccswitch-import';
  return null;
}

async function _settingsHandlePickerProviderAction(action) {
  const sel = _settingsState.pickerProviderSel;
  const restore = _settingsState.pickerProviderValueBeforeAction || '';
  // Always restore the trigger (back to placeholder when nothing was selected
  // yet) so the pseudo-action rows never stick as the visible value.
  if (sel) sel.setValue(restore);
  _settingsState.pickerProviderValueBeforeAction = restore || '';
  _settingsSyncCustomModelFields(restore);
  if (action === 'custom-providers') {
    _settingsOpenCustomProviderModal();
  } else if (action === 'ccswitch-import') {
    _settingsOpenCcswitchPreviewDialog();
  }
}

async function _settingsRenderPicker() {
  const providerEl = document.getElementById('settings-picker-provider');
  const modelEl    = document.getElementById('settings-picker-model');
  if (!providerEl || !modelEl) return;

  const providerOptions = _settingsState.providers.filter(_settingsIsCatalogProviderEnabled).map((p) => {
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
  providerOptions.push(
    { value: _PICKER_ACTION_CUSTOM_PROVIDERS, label: t('settings.picker.custom_providers'), hint: t('settings.picker.custom_providers_hint') },
    { value: _PICKER_ACTION_CCSWITCH_IMPORT, label: t('settings.picker.ccswitch_import'), hint: t('settings.picker.ccswitch_import_hint') },
  );

  const prevProvider = _settingsState.pickerProviderSel?.getValue()
    || providerEl.dataset.value
    || '';
  if (!_settingsState.pickerProviderSel || _settingsState.pickerProviderEl !== providerEl) {
    _settingsState.pickerProviderEl = providerEl;
    _settingsState.pickerProviderSel = _aiSelectMount(providerEl, {
      placeholder: t('settings.picker.select_provider'),
    });
    _settingsState.pickerProviderSel.onChange(async (val) => {
      const action = _settingsPickerActionForValue(val);
      if (action) {
        await _settingsHandlePickerProviderAction(action);
        return;
      }
      _settingsState.pickerProviderValueBeforeAction = val;
      _settingsSyncCustomModelFields(val);
      await _settingsPopulatePickerModel(val, '');
      _settingsSetStatus('settings-picker-status', '', '');
    });
  }
  _settingsState.pickerProviderSel.setOptions(providerOptions, {
    value: prevProvider,
    placeholder: t('settings.picker.select_provider'),
  });
  // Track the current real provider so picking an action row can restore it.
  const currentValue = _settingsState.pickerProviderSel.getValue();
  if (currentValue && !_settingsPickerActionForValue(currentValue)) {
    _settingsState.pickerProviderValueBeforeAction = currentValue;
  }
  _settingsSyncCustomModelFields(currentValue);

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
  const requestGeneration = ++_settingsState.pickerModelRequestGeneration;
  const provider = _settingsState.providers.find((p) => p.id === providerId);
  if (provider && provider.id === 'openai-compatible') {
    sel.setOptions([], { value: '', placeholder: t('settings.picker.manual_model_in_form') });
    return;
  }
  if (provider && provider.manualModel && provider.providerKind !== 'custom') {
    sel.setOptions([], { value: '', placeholder: t('settings.picker.manual_model_in_form') });
    return;
  }
  const models = await _settingsGetModels(providerId);
  const activeProviderId = _settingsState.pickerProviderSel?.getValue() || '';
  if (
    requestGeneration !== _settingsState.pickerModelRequestGeneration
    || activeProviderId !== providerId
    || sel !== _settingsState.pickerModelSel
  ) return;
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
  const addRes = await window.cogseed.invoke('auth.addApiKey', {
    provider: provider.id,
    apiKey,
    label: label || undefined,
    baseUrl,
  });
  if (!addRes || !addRes.ok) {
    _settingsSetStatus('settings-picker-status', 'error', (addRes && addRes.error) || t('settings.save_failed'));
    return;
  }
  const entryRes = await window.cogseed.invoke('auth.addEntry', {
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
  if (!_settingsIsCatalogProviderEnabled(provider)) {
    _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_provider_disabled'));
    return;
  }
  if (provider.id === 'openai-compatible') {
    if (typeof window.openCustomProviderEditor === 'function') window.openCustomProviderEditor({ protocol: 'openai' });
    else _settingsOpenCustomProviderModal({ protocol: 'openai' });
    return;
  }
  if (provider.providerKind === 'custom') {
    if (!modelId) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_model_needed')); return; }
    const profileId = provider.profiles && provider.profiles[0] && provider.profiles[0].profileId;
    if (!profileId) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_provider_missing')); return; }
    _settingsSetStatus('settings-picker-status', 'busy', t('settings.save_loading'));
    const entryRes = await window.cogseed.invoke('auth.addEntry', { provider: provider.id, model: modelId, profileId });
    if (!entryRes || !entryRes.ok) {
      _settingsSetStatus('settings-picker-status', 'error', (entryRes && entryRes.error) || t('settings.add_entry_failed'));
      return;
    }
    _settingsSetStatus('settings-picker-status', 'ok', t('settings.save_ok'));
    await _settingsReload();
    return;
  }
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
    const addRes = await window.cogseed.invoke('auth.addApiKey', {
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
    const entryRes = await window.cogseed.invoke('auth.addEntry', {
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
  if (overlay.classList.contains('open')) return;
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
  if (overlay.id === 'settings-custom-provider-modal') {
    const secret = document.getElementById('settings-custom-provider-api-key');
    if (secret) {
      secret.value = '';
      secret.type = 'password';
    }
    const body = document.getElementById('settings-custom-provider-modal-body');
    const actions = document.getElementById('settings-custom-provider-modal-actions');
    const status = document.getElementById('settings-custom-provider-modal-status');
    if (body) body.innerHTML = '';
    if (actions) actions.innerHTML = '';
    if (status) {
      status.textContent = '';
      status.className = 'form-msg';
    }
    ++_settingsState.customProviderModalGeneration;
    _settingsState.customProviderModalView = null;
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
      window.cogseed.invoke('auth.cancelOAuthFlow', { flowId: _oauthFlowId }).catch(() => {});
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
  const startRes = await window.cogseed.invoke('auth.startOAuth', { provider: oauthProviderId });
  if (!startRes || !startRes.ok) {
    body.innerHTML = `<div class="oauth-flow-stage error">${escapeHtml((startRes && startRes.error) || t('settings.oauth.start_failed'))}</div>`;
    _settingsLog.warn('oauth start failed', { provider: oauthProviderId, error: startRes && startRes.error });
    return;
  }
  _oauthFlowId = startRes.flowId;

  let lastKind = '';
  _oauthFlowPollTimer = setInterval(async () => {
    if (!_oauthFlowId) return;
    const res = await window.cogseed.invoke('auth.pollOAuthFlow', { flowId: _oauthFlowId });
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
      window.cogseed.invoke('auth.openExternal', { url }).catch(() => {});
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
        await window.cogseed.invoke('auth.submitOAuthInput', { flowId: _oauthFlowId, value: val });
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
      await window.cogseed.invoke('auth.submitOAuthInput', { flowId: _oauthFlowId, value: val });
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
          const modelsRes = await window.cogseed.invoke('auth.listModels', { provider: entryProvider });
          const supported = (modelsRes && modelsRes.ok && Array.isArray(modelsRes.models)) ? modelsRes.models : [];
          const hit = supported.find(m => m.id === model);
          if (!hit && supported.length) model = supported[0].id;
        }
        await window.cogseed.invoke('auth.addEntry', {
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
  `;
  main.appendChild(primary);

  // Inline model picker — lets users switch the entry's model without
  // deleting + re-adding. auth.listModels is the complete whitelist; a saved
  // model that left the catalog remains visible only as a remediation row and
  // is never injected back into these options.
  const modelEl = document.createElement('div');
  modelEl.className = 'ai-select ai-select-compact entry-model-select';
  const initialModelState = _settingsEntryModelState(entry, []);
  const modelUnavailable = initialModelState.unavailable;
  const modelSel = _aiSelectMount(modelEl, {
    placeholder: initialModelState.placeholder,
  });
  // Prevent drag from starting when interacting with the picker.
  modelEl.addEventListener('mousedown', (e) => e.stopPropagation());
  modelEl.setAttribute('draggable', 'false');
  (async () => {
    const res = await window.cogseed.invoke('auth.listModels', { provider: entry.provider });
    const list = (res && res.ok && Array.isArray(res.models)) ? res.models : [];
    const modelState = _settingsEntryModelState(entry, list);
    modelSel.setOptions(modelState.options, {
      value: modelState.value,
      placeholder: modelState.placeholder,
    });
    modelSel.onChange(async (val) => {
      if (!val || val === entry.model) return;
      const up = await window.cogseed.invoke('auth.updateEntryModel', { entryId: entry.entryId, model: val });
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
    badge.textContent = 'CogSeed';
  } else {
    badge.className = 'account-type-badge';
    badge.textContent = 'API Key';
  }
  meta.appendChild(badge);

  // API-key profiles get an editable capsule: masked with dots by default,
  // the eye button reveals the real key, typing + blur/Enter saves it.
  if (entry.profileType !== 'oauth' && entry.profileType !== 'managed') {
    // Dot mask is long enough to fill at least a third of the capsule.
    const STAR_MASK = '••••••••••••••••••••••••••••••••';
    const capsule = document.createElement('div');
    capsule.className = 'entry-api-key-capsule';
    capsule.setAttribute('draggable', 'false');
    capsule.innerHTML = `
      <input class="entry-api-key-input" type="password" value="${STAR_MASK}" autocomplete="off" spellcheck="false" />
      <button type="button" class="entry-api-key-toggle" title="${escapeHtml(t('settings.entries.api_key_show'))}" aria-label="${escapeHtml(t('settings.entries.api_key_show'))}">${_settingsIconHtml('eye', 'ui-icon')}</button>
    `;
    meta.appendChild(capsule);

    const input = capsule.querySelector('.entry-api-key-input');
    const toggle = capsule.querySelector('.entry-api-key-toggle');
    let revealed = false;
    let revealedKey = '';

    const hideKey = () => {
      revealed = false;
      revealedKey = '';
      input.type = 'password';
      input.value = STAR_MASK;
      const label = t('settings.entries.api_key_show');
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
    };

    toggle.addEventListener('click', async () => {
      if (revealed) { hideKey(); return; }
      const res = await window.cogseed.invoke('auth.revealApiKey', { profileId: entry.profileId });
      const key = res && res.ok ? String(res.apiKey || '') : '';
      if (!key) {
        await uiAlert((res && res.error) || t('settings.entries.api_key_reveal_failed'));
        return;
      }
      revealed = true;
      revealedKey = key;
      input.type = 'text';
      input.value = key;
      const label = t('settings.entries.api_key_hide');
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
    });

    // Interacting with the capsule must not start the row's drag-reorder.
    capsule.addEventListener('mousedown', (e) => e.stopPropagation());

    const commitKey = async () => {
      const value = String(input.value || '').trim();
      if (value === STAR_MASK) { hideKey(); return; }
      if (!value) { hideKey(); return; }
      if (revealed && value === revealedKey) { hideKey(); return; }
      const up = await window.cogseed.invoke('auth.updateApiKey', { profileId: entry.profileId, apiKey: value });
      if (!up || !up.ok) {
        await uiAlert((up && up.error) || t('settings.entries.api_key_update_failed'));
        hideKey();
        return;
      }
      hideKey();
      await _settingsReload();
    };

    input.addEventListener('focus', () => {
      // Typing replaces the dot mask instead of appending to it.
      if (!revealed && input.value === STAR_MASK) input.value = '';
    });
    input.addEventListener('blur', () => { void commitKey(); });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { hideKey(); input.blur(); }
    });
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

  if (entry.providerKind === 'custom' || String(entry.provider || '').startsWith('cp:')) {
    const customProviderId = String(entry.provider || '').startsWith('cp:')
      ? String(entry.provider).slice(3)
      : String(entry.provider || '');
    const customProvider = _settingsCurrentCustomProvider(customProviderId);
    if (customProvider) {
      actions.appendChild(_settingsCustomProviderActionButton(
        'settings',
        t('settings.custom_providers.manage'),
        'icon-btn settings-entry-custom-provider-manage',
        () => _settingsOpenCustomProviderDetails(customProvider),
      ));
    }
  }

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

  // Model picker sits to the left of the settings (gear) button.
  actions.prepend(modelEl);

  row.appendChild(actions);

  _settingsAttachReorderDnd(row, {
    kind: 'chat',
    id: entry.entryId,
    getIds: () => _settingsState.entries.map((e) => e.entryId),
    ipcName: 'auth.reorderEntries',
    onSuccess: () => _settingsReload(),
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
    const res = await window.cogseed.invoke(ipcName, { orderedIds: ids });
    if (res && res.ok) {
      await onSuccess(res);
    } else {
      await uiAlert((res && res.error) || t('settings.entries.reorder_failed'));
    }
  });
}

async function _settingsTestEntry(entry, statusEl) {
  _settingsSetRowStatus(statusEl, 'busy', t('settings.entries.testing'), 'entry-status');
  // Custom providers use a synthetic `cp:<id>` profile that has no entry in
  // the profile store — route their tests through the custom-provider
  // channel instead of auth.testConnection (which would say "profile not found").
  const isCustom = String(entry.provider || '').startsWith('cp:');
  const res = isCustom
    ? await window.cogseed.invoke('customProviders.model.test', {
        providerId: String(entry.provider).slice(3),
        modelId: entry.model,
      })
    : await window.cogseed.invoke('auth.testConnection', {
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
  const res = await window.cogseed.invoke('auth.removeEntry', { entryId: entry.entryId });
  if (!res || !res.ok) {
    _settingsLog.warn('remove entry failed', { entry_id: entry.entryId, error: res && res.error });
    await uiAlert((res && res.error) || t('settings.entries.delete_failed'));
    return;
  }
  await _settingsReload();
}

// ── Helpers ──

async function _settingsReload() {
  _settingsState.modelsCache = {};
  await Promise.all([_settingsRefreshProviders(), _settingsRefreshEntries(), _settingsRefreshCommanderBackend(), _settingsRefreshAuthProfilesStatus(), _settingsRefreshCustomProviders()]);
  await _settingsRenderPicker();
  _settingsRenderEntries();
  _settingsRenderCommanderBackend();
  _settingsRenderAuthProfilesRecovery();
  _settingsRenderCustomProviders();
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
  const res = await window.cogseed.invoke('searchAuth.list');
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
    const res = await window.cogseed.invoke('searchAuth.add', { provider, apiKey, label: 'default' });
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
      const res = await window.cogseed.invoke('searchAuth.remove', { id: p.id });
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
  const res = await window.cogseed.invoke('imageAuth.list');
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
    const res = await window.cogseed.invoke('imageAuth.add', { provider, model, apiKey, label: 'default' });
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
      const res = await window.cogseed.invoke('imageAuth.remove', { id: p.id });
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

// ── Text-to-speech API key section ─────────────────────────────────────────

async function _settingsRefreshTtsProfiles() {
  const res = await window.cogseed.invoke('ttsAuth.list');
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
    const res = await window.cogseed.invoke('ttsAuth.add', payload);
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
      const res = await window.cogseed.invoke('ttsAuth.remove', { id: p.id });
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
