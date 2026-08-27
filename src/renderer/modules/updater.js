// ─── In-app update reminders ─────────────────────────────────────────────
// Resident module (loaded with the shell, like account-chip.js) so the
// reminder banner can surface on any view. Owns:
//   - Settings › 通用 › 更新 group: current version, manual check, download
//     with live progress, "open installer" once verified, "skip this version".
//   - A global banner driven by main's `updates:available` push (boot-time
//     silent check surfaced a new version).
//
// Consumes only `updates.*` IPC channels and `updates:*` push events. All
// state decisions (throttle, skip list, checksum) live in main; this module
// renders and forwards user intent.

(function () {
  'use strict';

  const _updLog = createLogger('updater');

  const _state = {
    currentVersion: '',
    info: null,          // latest available UpdateInfo | null
    downloadedVersion: '',
    downloading: false,
    progress: null,      // { received, total, percent } | null
    statusKey: '',       // i18n key of the current status line (re-render on i18n-change)
    statusVars: null,
    statusKind: '',      // '' | 'error'
    bannerInfo: null,    // info shown in the global banner (dismissed → null)
    autoStatus: null,    // AutoUpdateStatus pushed from main (updates:auto)
  };

  // ── helpers ────────────────────────────────────────────────────────────

  function _escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function _id(id) {
    return document.getElementById(id);
  }

  function _progressText(progress, info) {
    const size = _formatBytes(progress.total || info && info.size);
    const received = _formatBytes(progress.received);
    const pct = progress.percent;
    if (progress.total > 0) {
      return `${received} / ${size} · ${pct}%`;
    }
    return `${received} · ${pct}%`;
  }

  // ── settings page rendering ────────────────────────────────────────────

  function _setStatus(key, vars, kind) {
    _state.statusKey = key;
    _state.statusVars = vars || null;
    _state.statusKind = kind || '';
    _renderStatus();
  }

  function _renderStatus() {
    const row = _id('updater-status-row');
    const text = _id('updater-status-text');
    if (!row || !text) return;
    if (!_state.statusKey) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    text.textContent = t(_state.statusKey, _state.statusVars || {});
    text.className = 'settings-updater-status' + (_state.statusKind === 'error' ? ' settings-updater-status-error' : '');
  }

  function _renderActions() {
    const row = _id('updater-actions-row');
    if (!row) return;
    const hasInfo = !!_state.info;
    const downloaded = hasInfo && _state.downloadedVersion === _state.info.latest_version;
    row.hidden = !hasInfo;
    _id('updater-download-btn').hidden = downloaded || _state.downloading;
    _id('updater-open-btn').hidden = !downloaded;
    _id('updater-skip-btn').hidden = !hasInfo || downloaded || _state.downloading;
  }

  function _renderProgress() {
    const row = _id('updater-progress-row');
    const bar = _id('updater-progress-bar');
    const text = _id('updater-progress-text');
    if (!row || !bar || !text) return;
    if (!_state.downloading) {
      row.hidden = true;
      bar.style.width = '0%';
      return;
    }
    row.hidden = false;
    const p = _state.progress || { received: 0, total: 0, percent: 0 };
    bar.style.width = `${p.percent}%`;
    text.textContent = _progressText(p, _state.info);
  }

  function _renderAuto() {
    const row = _id('updater-auto-row');
    const text = _id('updater-auto-text');
    const btn = _id('updater-auto-install-btn');
    if (!row || !text || !btn) return;
    const st = _state.autoStatus;
    if (!st) {
      row.hidden = true;
      return;
    }
    btn.hidden = st.state !== 'downloaded';
    if (st.state === 'disabled') {
      row.hidden = true; // 开发模式：不展示自动更新行，走 v1 手动流程
      return;
    }
    row.hidden = false;
    const keyFor = {
      idle: 'settings.updates.auto.up_to_date',
      checking: 'settings.updates.auto.checking',
      downloading: 'settings.updates.auto.downloading',
      downloaded: 'settings.updates.auto.downloaded',
      error: 'settings.updates.auto.error',
    };
    const key = keyFor[st.state];
    if (key) {
      text.textContent = t(key, {
        percent: st.percent != null ? String(st.percent) : '0',
        version: st.version || '',
        message: st.message || '',
      });
      text.className = 'settings-updater-status' + (st.state === 'error' ? ' settings-updater-status-error' : '');
    }
  }

  function _renderAll() {
    _renderStatus();
    _renderActions();
    _renderProgress();
    _renderAuto();
  }

  /** Re-sync the whole settings surface from the latest known state. */
  function _refreshSettings() {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    window.cogseed.invoke('updates.getState', {})
      .then((res) => {
        if (!res || !res.ok) return;
        const state = res.state || {};
        _state.currentVersion = res.current_version || _state.currentVersion;
        _state.info = state.latest_info || null;
        _state.downloadedVersion = state.downloaded && state.downloaded.version
          ? state.downloaded.version : '';
        _id('updater-current-version').textContent = t('settings.updates.current_version', {
          version: _state.currentVersion,
        });
        _renderActions();
        // Re-surface the latest available update when the user re-opens
        // settings and a download is already verified.
        if (_state.info && _state.downloadedVersion === _state.info.latest_version) {
          _setStatus('settings.updates.download_ready', { version: _state.info.latest_version });
        } else if (_state.info) {
          _setStatus('settings.updates.available', { version: _state.info.latest_version });
        }
      })
      .catch((err) => {
        _updLog.warn('updates.getState failed', { error: err && err.message });
      });
  }

  // ── actions ────────────────────────────────────────────────────────────

  async function _checkNow() {
    _setStatus('settings.updates.checking');
    _renderActions();
    try {
      const res = await window.cogseed.invoke('updates.check', { manual: true });
      if (!res || !res.ok) {
        _setStatus('settings.updates.error', { message: _friendlyError(res && res.error) }, 'error');
        return;
      }
      if (res.checked && res.has_update && res.info) {
        _state.info = res.info;
        _state.currentVersion = res.current_version || _state.currentVersion;
        _setStatus('settings.updates.available', { version: res.info.latest_version });
        _renderActions();
      } else if (res.checked) {
        _setStatus('settings.updates.up_to_date', { version: res.current_version || _state.currentVersion });
      } else {
        _setStatus('settings.updates.error', { message: _friendlyError(res.error) }, 'error');
      }
    } catch (err) {
      _setStatus('settings.updates.error', { message: _friendlyError(err && err.message) }, 'error');
    }
  }

  async function _download() {
    const info = _state.info;
    if (!info) return;
    _state.downloading = true;
    _state.progress = null;
    _setStatus('settings.updates.downloading', { percent: 0 });
    _renderActions();
    _renderProgress();
    try {
      const res = await window.cogseed.invoke('updates.download', {});
      if (res && res.ok) {
        _state.downloadedVersion = res.version;
        _state.downloading = false;
        _setStatus('settings.updates.download_ready', { version: res.version });
        _renderActions();
        _renderProgress();
      } else {
        _state.downloading = false;
        _setStatus('settings.updates.error', { message: _friendlyError(res && res.error) }, 'error');
        _renderActions();
        _renderProgress();
      }
    } catch (err) {
      _state.downloading = false;
      _setStatus('settings.updates.error', { message: _friendlyError(err && err.message) }, 'error');
      _renderActions();
      _renderProgress();
    }
  }

  async function _openInstaller() {
    try {
      const res = await window.cogseed.invoke('updates.open', {});
      if (!res || !res.ok || !res.opened) {
        _setStatus('settings.updates.error', { message: _friendlyError(res && res.error) }, 'error');
      }
    } catch (err) {
      _setStatus('settings.updates.error', { message: _friendlyError(err && err.message) }, 'error');
    }
  }

  async function _skipVersion() {
    const info = _state.info;
    if (!info) return;
    try {
      await window.cogseed.invoke('updates.dismiss', { version: info.latest_version });
      _setStatus('settings.updates.skipped', { version: info.latest_version });
      _state.downloadedVersion = '';
      _renderActions();
    } catch (err) {
      _setStatus('settings.updates.error', { message: _friendlyError(err && err.message) }, 'error');
    }
  }

  function _friendlyError(raw) {
    const message = String(raw || '');
    if (!message) return message;
    if (message.includes('no_update_info')) return t('settings.updates.errors.no_update_info');
    if (message.includes('verify_failed')) return t('settings.updates.errors.verify_failed');
    if (message.includes('already_downloading')) return t('settings.updates.errors.already_downloading');
    if (message.includes('file_missing')) return t('settings.updates.errors.file_missing');
    if (message.includes('insecure_url') || message.includes('bad_url')) {
      return t('settings.updates.errors.bad_url');
    }
    return message;
  }

  // ── banner ─────────────────────────────────────────────────────────────

  function _showBanner(info) {
    _state.bannerInfo = info;
    const banner = _id('updater-banner');
    if (!banner) return;
    _id('updater-banner-text').textContent = t('settings.updates.banner', {
      version: info.latest_version,
    });
    banner.hidden = false;
  }

  function _hideBanner() {
    _state.bannerInfo = null;
    const banner = _id('updater-banner');
    if (banner) banner.hidden = true;
  }

  // ── init ───────────────────────────────────────────────────────────────

  function _bindSettings() {
    _id('updater-check-btn').addEventListener('click', () => { void _checkNow(); });
    _id('updater-download-btn').addEventListener('click', () => { void _download(); });
    _id('updater-open-btn').addEventListener('click', () => { void _openInstaller(); });
    _id('updater-skip-btn').addEventListener('click', () => { void _skipVersion(); });
    _id('updater-auto-install-btn').addEventListener('click', () => {
      if (window.cogseed && typeof window.cogseed.invoke === 'function') {
        void window.cogseed.invoke('updates.autoInstall', {});
      }
    });
  }

  function _bindBanner() {
    _id('updater-banner-view-btn').addEventListener('click', () => {
      _hideBanner();
      // Open Settings › 通用 where the update group lives.
      if (typeof window.setView === 'function') {
        try { window.setView('settings'); } catch (_) { /* fall through */ }
      }
      if (typeof window.activateSettingsTab === 'function') {
        try { window.activateSettingsTab('general'); } catch (_) { /* non-fatal */ }
      }
      _refreshSettings();
    });
    _id('updater-banner-later-btn').addEventListener('click', () => _hideBanner());
  }

  function initUpdater() {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    try {
      _bindSettings();
      _bindBanner();
    } catch (err) {
      _updLog.warn('updater DOM bind failed', { error: err && err.message });
      return;
    }
    // Boot-time check surfaced a new version (main broadcasts after the
    // once-per-day throttle + skip rules pass).
    if (typeof window.cogseed.onPushEvent === 'function') {
      window.cogseed.onPushEvent('updates:available', (payload) => {
        if (!payload || !payload.info) return;
        _state.info = payload.info;
        _state.currentVersion = payload.current_version || _state.currentVersion;
        _showBanner(payload.info);
        _refreshSettings();
      });
      window.cogseed.onPushEvent('updates:auto', (status) => {
        if (!status) return;
        _state.autoStatus = status;
        _renderAuto();
      });
      window.cogseed.onPushEvent('updates:progress', (p) => {
        if (!p || !_state.downloading) return;
        _state.progress = {
          received: Number(p.received) || 0,
          total: Number(p.total) || 0,
          percent: Number(p.percent) || 0,
        };
        _renderProgress();
        if (p.percent >= 100) {
          _setStatus('settings.updates.downloading', { percent: 100 });
        }
      });
    }
    // Fill the current-version label once (cheap, local).
    _refreshSettings();
    if (typeof window.cogseed.invoke === 'function') {
      window.cogseed.invoke('updates.autoStatus', {})
        .then((res) => {
          if (res && res.ok && res.status) {
            _state.autoStatus = res.status;
            _renderAuto();
          }
        })
        .catch(() => { /* non-fatal */ });
    }
    window.addEventListener('i18n-change', () => {
      _renderAll();
      if (_state.bannerInfo) _showBanner(_state.bannerInfo);
    });
  }

  window.initUpdater = initUpdater;
  window._updaterRefreshSettings = _refreshSettings; // settings.js may re-trigger on tab entry

  // Resident module: bind immediately (script runs at the end of <body>, DOM
  // is ready). Push subscriptions must be in place before main's deferred
  // boot check broadcasts `updates:available`.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initUpdater(), { once: true });
  } else {
    initUpdater();
  }
})();
