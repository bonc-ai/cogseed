// ─── In-app update reminders ─────────────────────────────────────────────
// Resident module (loaded with the shell, like account-chip.js) so the
// reminder banner can surface on any view. Owns:
//   - Settings › 关于我们 pane: current version, manual check, download
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

  /** 主进程说"没有传输在跑"时的落点；本地任何猜测都必须能回到它。 */
  function _idleDownload() {
    return { phase: 'idle', received: 0, total: 0, percent: 0 };
  }

  const _state = {
    currentVersion: '',
    info: null,          // latest available UpdateInfo | null
    hasUpdate: false,    // 主进程判定：latest_info 确实比当前运行的版本新
    installReady: false, // 主进程判定：已有校验通过的、比当前版本新的安装包
    downloadedVersion: '',
    // 下载运行时态由主进程持有（getState + `updates:download` 推送）。渲染层不再
    // 自己记「是否正在下载」：2026-09-21 报障——第二次点「下载更新」撞上
    // already_downloading，本地标志被清成 false，进度行被拆掉，随后所有进度推送
    // 都被那个标志挡在门外，下载还在跑但进度条再也回不来。
    download: _idleDownload(),
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

  /**
   * 自动更新通道是否正在接管这次更新（electron autoUpdater 负责检查/下载/
   * 待安装）。此时 v1 手动通道必须退场：「关于我们」里两条通道同时渲染各自的
   * 进度，就会出现多个进度条、且数值互相矛盾（自动行拿不到百分比只能显示 0%，
   * 手动进度条却在往前走）。自动更新不可用（开发模式 / 非 macOS）或停在
   * idle/error 时，保留 v1 手动流程作为唯一可操作通道。
   */
  function _autoAuthoritative() {
    const st = _state.autoStatus;
    if (!st) return false;
    return st.state === 'checking' || st.state === 'downloading' || st.state === 'downloaded';
  }

  function _bytes(value) {
    return _formatBytes(value) || '0 B';
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

  /** 文案变量：进度口径只认主进程给的数，渲染层不自己算百分比。 */
  function _progressVars(d) {
    return {
      percent: String(d.percent || 0),
      received: _bytes(d.received),
      total: _bytes(d.total),
    };
  }

  /**
   * 传输进行中的状态行。返回 null 表示"当前没有传输语义"，交给
   * `_state.statusKey`（检查结果 / 已就绪 / 已跳过）渲染。
   */
  function _transferStatus() {
    const d = _state.download;
    if (!d || !d.phase || d.phase === 'idle') return null;
    if (d.phase === 'downloading') {
      // 主进程还没给出总长度时不编字节数（总长度未知），只报百分比。
      return d.total > 0
        ? { key: 'settings.updates.downloading_bytes', vars: _progressVars(d), kind: '' }
        : { key: 'settings.updates.downloading', vars: { percent: String(d.percent || 0) }, kind: '' };
    }
    if (d.phase === 'paused') {
      return { key: 'settings.updates.paused', vars: _progressVars(d), kind: '' };
    }
    if (d.phase === 'verifying') {
      return { key: 'settings.updates.verifying', vars: {}, kind: '' };
    }
    if (d.phase === 'failed') {
      if (d.resumable) {
        return { key: 'settings.updates.interrupted', vars: { received: _bytes(d.received) }, kind: 'error' };
      }
      return { key: 'settings.updates.error', vars: { message: _friendlyError(d.error) }, kind: 'error' };
    }
    return null;
  }

  // ── settings page rendering ────────────────────────────────────────────

  function _setStatus(key, vars, kind) {
    _state.statusKey = key;
    _state.statusVars = vars || null;
    _state.statusKind = kind || '';
    _renderStatus();
    // 状态行是"是否要收起整块更新行"的输入之一，改完文案必须重新判定一次：
    // 否则"先渲染、再清空旧文案"的顺序会让四行全隐、容器却留在页面上（一条空带）。
    _renderRowsVisibility();
  }

  function _renderStatus() {
    const row = _id('updater-status-row');
    const text = _id('updater-status-text');
    if (!row || !text) return;
    const transfer = _transferStatus();
    // 进度文案让位给自动更新行：同一时刻只允许一处声明「正在下载」。
    if (transfer && _autoAuthoritative()) {
      row.hidden = true;
      return;
    }
    const key = transfer ? transfer.key : _state.statusKey;
    if (!key) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    text.textContent = t(key, transfer ? transfer.vars : (_state.statusVars || {}));
    const kind = transfer ? transfer.kind : _state.statusKind;
    text.className = 'settings-updater-status' + (kind === 'error' ? ' settings-updater-status-error' : '');
  }

  function _setVisible(id, visible) {
    const el = _id(id);
    if (el) el.hidden = !visible;
  }

  /**
   * 传输进行中（下载 / 暂停 / 校验 / 可续传的中断）时，动作行整体退场：控制权
   * 交给进度行。否则「下载更新」会和「继续下载」同时出现，一个从零重下、一个
   * 接着下，用户分不清按哪个。
   */
  function _transferOwnsControls() {
    const d = _state.download;
    return d.phase === 'downloading'
      || d.phase === 'paused'
      || d.phase === 'verifying'
      || (d.phase === 'failed' && !!d.resumable);
  }

  /** 失败且没有可续的半包时，「下载更新」的语义就是「重试」。 */
  function _syncDownloadLabel() {
    const btn = _id('updater-download-btn');
    if (!btn || typeof btn.querySelector !== 'function') return;
    const label = btn.querySelector('.ui-button__label');
    if (!label || typeof label.setAttribute !== 'function') return;
    const retry = _state.download.phase === 'failed' && !_state.download.resumable;
    const key = retry ? 'settings.updates.retry' : 'settings.updates.download';
    if (label.getAttribute('data-i18n') !== key) label.setAttribute('data-i18n', key);
    label.textContent = t(key);
  }

  function _renderActions() {
    const row = _id('updater-actions-row');
    if (!row) return;
    // 自动更新接管期间不给入口：否则用户能手动起第二条下载，
    // 于是同一个更新出现两个进度。
    if (_autoAuthoritative()) {
      row.hidden = true;
      return;
    }
    // 关键判据是主进程算好的 has_update（确实比当前运行的版本新），不是
    // "有没有 latest_info"——后者会让已装好的版本继续显示「下载更新」。
    const actionable = _state.hasUpdate && !!_state.info;
    const transferOwns = _transferOwnsControls();
    row.hidden = transferOwns || !(actionable || _state.installReady);
    _setVisible('updater-download-btn', actionable && !_state.installReady && !transferOwns);
    _setVisible('updater-open-btn', _state.installReady);
    _setVisible('updater-skip-btn', actionable && !_state.installReady && !transferOwns);
    _syncDownloadLabel();
  }

  function _renderProgress() {
    const row = _id('updater-progress-row');
    const bar = _id('updater-progress-bar');
    const text = _id('updater-progress-text');
    if (!row || !bar || !text) return;
    const d = _state.download;
    const showTransfer = !_autoAuthoritative() && _transferOwnsControls();
    if (!showTransfer) {
      row.hidden = true;
      bar.style.width = '0%';
      return;
    }
    row.hidden = false;
    const p = { received: d.received || 0, total: d.total || 0, percent: d.percent || 0 };
    bar.style.width = `${p.percent}%`;
    // 暂停不是"没有进度"，而是"进度停在这里"：条留着并降饱和。
    bar.className = 'updater-progress-bar' + (d.phase === 'paused' ? ' is-paused' : '');
    text.textContent = _progressText(p, _state.info);
  }

  /**
   * 传输控件（暂停 / 继续下载 / 取消下载）由共享 `uiButton()` 生成后注入空容器。
   * 不能写成 index.html 里的裸 button 元素，也不能在本文件里拼 button 标签字符串：
   * test/renderer/shared-ui-adoption-guard.test.ts 冻结了这两处的裸控件计数，
   * 而本文件的基线是 0（连注释里出现该标签都会被算进去）。
   */
  function _renderTransferActions() {
    const slot = _id('updater-progress-actions');
    if (!slot) return;
    const d = _state.download;
    const specs = [];
    if (!_autoAuthoritative()) {
      const resumable = d.phase === 'paused' || (d.phase === 'failed' && !!d.resumable);
      if (d.phase === 'downloading') {
        specs.push(['settings.updates.pause', 'secondary', 'updater-pause-btn']);
      }
      if (resumable) {
        specs.push(['settings.updates.resume', 'primary', 'updater-resume-btn']);
      }
      if (d.phase === 'downloading' || resumable) {
        specs.push(['settings.updates.cancel_download', 'ghost', 'updater-cancel-btn']);
      }
    }
    const html = typeof uiButton === 'function'
      ? specs.map(([key, role, id]) => uiButton({ label: t(key), role, size: 'sm', attrs: { id } })).join('')
      : '';
    // 只在真正重建了节点时绑定：真机里 innerHTML 赋值会销毁旧节点（连带监听器），
    // 但若内容没变就不该再挂一层——否则按一次会触发多次。
    if (html === slot.innerHTML) return;
    slot.innerHTML = html;
    _bindClick('updater-pause-btn', () => { void _pauseDownload(); });
    _bindClick('updater-resume-btn', () => { void _resumeDownload(); });
    _bindClick('updater-cancel-btn', () => { void _cancelDownload(); });
  }

  function _bindClick(id, handler) {
    const el = _id(id);
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', handler);
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
      downloaded: 'settings.updates.auto.downloaded',
      error: 'settings.updates.auto.error',
    };
    // 下载中的百分比只在平台真的上报进度时才渲染（macOS 的 Squirrel.Mac 只有
    // update-available / update-downloaded，没有 download-progress）。拿不到就
    // 明说「正在下载更新…」，不补一个 0%——那是一条永远不动的假进度，会跟
    // 页面里真实的下载进度互相打架。
    let key = '';
    let vars = {};
    if (st.state === 'downloading') {
      const percent = Math.round(Number(st.percent));
      const tracked = Number.isFinite(percent) && percent > 0;
      key = tracked
        ? 'settings.updates.auto.downloading'
        : 'settings.updates.auto.downloading_indeterminate';
      vars = { percent: tracked ? String(Math.min(100, percent)) : '' };
    } else {
      key = keyFor[st.state] || '';
      vars = { version: st.version || '', message: st.message || '' };
    }
    if (key) {
      text.textContent = t(key, vars);
      text.className = 'settings-updater-status' + (st.state === 'error' ? ' settings-updater-status-error' : '');
    }
  }

  function _renderAll() {
    _renderStatus();
    _renderActions();
    _renderProgress();
    _renderTransferActions();
    _renderAuto();
    _renderRowsVisibility();
  }

  /**
   * 四行都隐藏时把整个更新行容器收掉。容器自带 padding + 上边框，只要还有子
   * 节点就会画出来，于是"什么都没有"的更新组会留一条空带。
   */
  function _renderRowsVisibility() {
    const rows = typeof document.querySelector === 'function'
      ? document.querySelector('.settings-about-rows')
      : null;
    if (!rows) return;
    const ids = ['updater-status-row', 'updater-actions-row', 'updater-auto-row', 'updater-progress-row'];
    const anyVisible = ids.some((id) => {
      const el = _id(id);
      return !!el && !el.hidden;
    });
    rows.hidden = !anyVisible;
  }

  /** 采纳主进程给的状态快照（唯一权威来源）。 */
  function _applyState(res) {
    const state = res.state || {};
    _state.currentVersion = res.current_version || _state.currentVersion;
    _state.info = state.latest_info || null;
    _state.hasUpdate = res.has_update === true;
    _state.installReady = res.install_ready === true;
    _state.downloadedVersion = state.downloaded && state.downloaded.version
      ? state.downloaded.version
      : '';
    // 老版本主进程不带 download 字段时退回"没有传输在进行"这个安全落点，
    // 而不是让上一个乐观状态继续挂在页面上。
    _state.download = res.download && res.download.phase ? res.download : _idleDownload();
    const versionLabel = _id('updater-current-version');
    if (versionLabel) {
      versionLabel.textContent = t('settings.updates.current_version', {
        version: _state.currentVersion,
      });
    }
    _renderAll();
    if (_state.installReady && _state.info) {
      _setStatus('settings.updates.download_ready', { version: _state.info.latest_version });
    } else if (_state.hasUpdate && _state.info) {
      _setStatus('settings.updates.available', { version: _state.info.latest_version });
    } else {
      // 没有可执行的更新就不留旧文案（「发现新版本 X」会和新版本号一起过期）。
      _setStatus('', null, '');
    }
  }

  /** Re-sync the whole settings surface from the latest known state. */
  function _refreshSettings() {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return Promise.resolve();
    return window.cogseed.invoke('updates.getState', {})
      .then((res) => {
        if (!res || !res.ok) return;
        _applyState(res);
      })
      .catch((err) => {
        _updLog.warn('updates.getState failed', { error: err && err.message });
      });
  }

  /**
   * 本地状态与主进程脱节时的对齐动作。拿不到快照就退回「没有传输在进行」——
   * 一个安全的落点，而不是让上一条乐观状态继续挂在页面上。
   */
  async function _resyncDownload() {
    if (window.cogseed && typeof window.cogseed.invoke === 'function') {
      try {
        const res = await window.cogseed.invoke('updates.getState', {});
        if (res && res.ok) {
          _applyState(res);
          return;
        }
      } catch (err) {
        _updLog.warn('updates.getState failed', { error: err && err.message });
      }
    }
    _state.download = _idleDownload();
    _renderAll();
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
        _state.hasUpdate = true;
        _setStatus('settings.updates.available', { version: res.info.latest_version });
      } else if (res.checked) {
        // 检查说没有更新 → 必须把上一轮的 info 一起丢掉：否则「已是最新版本」旁边
        // 还挂着「下载更新 / 打开安装包」两个按钮（2026-09-21 报障）。
        _state.info = null;
        _state.hasUpdate = false;
        _state.installReady = false;
        _state.downloadedVersion = '';
        _setStatus('settings.updates.up_to_date', { version: res.current_version || _state.currentVersion });
      } else {
        _setStatus('settings.updates.error', { message: _friendlyError(res.error) }, 'error');
      }
      _renderAll();
    } catch (err) {
      _setStatus('settings.updates.error', { message: _friendlyError(err && err.message) }, 'error');
    }
  }

  async function _download() {
    if (!_state.hasUpdate) {
      // 理论上不可达（按钮与这里用同一个 has_update 判定）。真出现就说明与主进程
      // 脱节了（例如另一个窗口刚跳过了这个版本）：重新对齐、让界面自己纠正，
      // 而不是静默什么都不发生——"按钮在、点不动"正是 2026-09-21 报障的表象。
      await _resyncDownload();
      return;
    }
    // 乐观起手：立刻给出「下载中」，之后一律以主进程为准（`updates:download`
    // 推送 + getState）。乐观值刻意不带 total —— 总数未知时不编字节数。
    _state.download = { phase: 'downloading', received: 0, total: 0, percent: 0 };
    _renderAll();
    let res = null;
    try {
      res = await window.cogseed.invoke('updates.download', {});
    } catch (err) {
      res = { ok: false, error: err && err.message };
    }
    await _adoptDownloadResult(res);
  }

  /**
   * 一次下载 invoke 结束后的收尾。
   *
   * `already_downloading` 不是失败：主进程只是说"已经有一条在跑"。旧实现在这里
   * 把本地 downloading 置 false，于是进度行被拆掉、后续进度推送全被丢弃——
   * 下载还在跑，进度条却永久消失。现在的处理是"按主进程状态重新对齐"。
   */
  async function _adoptDownloadResult(res) {
    if (res && res.ok) {
      _state.downloadedVersion = res.version || _state.downloadedVersion;
      await _refreshSettings();
      return;
    }
    const error = res && res.error;
    if (error === 'paused' || error === 'canceled' || error === 'already_downloading') {
      await _resyncDownload();
      return;
    }
    await _resyncDownload();
    _setStatus('settings.updates.error', { message: _friendlyError(error) }, 'error');
  }

  /** 暂停：主进程保留已下载的字节，进度面停在当前位置。 */
  async function _pauseDownload() {
    try {
      const res = await window.cogseed.invoke('updates.pauseDownload', {});
      // not_downloading 表示已经没有传输在跑（例如刚好下完），对齐即可，不报错。
      if (res && !res.ok && res.error && res.error !== 'paused' && res.error !== 'not_downloading') {
        _updLog.warn('updates.pauseDownload failed', { error: res.error });
      }
    } catch (err) {
      _updLog.warn('updates.pauseDownload failed', { error: err && err.message });
    }
    await _resyncDownload();
  }

  /** 继续：主进程用 Range 从已有字节接着下。 */
  async function _resumeDownload() {
    _state.download = { ..._state.download, phase: 'downloading' };
    _renderAll();
    let res = null;
    try {
      res = await window.cogseed.invoke('updates.resumeDownload', {});
    } catch (err) {
      res = { ok: false, error: err && err.message };
    }
    await _adoptDownloadResult(res);
  }

  /** 取消：丢弃半包，回到「发现新版本」。 */
  async function _cancelDownload() {
    try {
      await window.cogseed.invoke('updates.cancelDownload', {});
    } catch (err) {
      _updLog.warn('updates.cancelDownload failed', { error: err && err.message });
    }
    await _resyncDownload();
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
      // 跳过之后主进程不再把这个版本算作「值得提供」，按钮随之退场；
      // 显式「检查更新」仍会如实报告，所以跳过不是死路。
      await _refreshSettings();
      _setStatus('settings.updates.skipped', { version: info.latest_version });
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
    // `insecure_url` came from a reachable-but-plaintext download URL: saying
    // "地址无效" sends self-hosted deployments hunting for a typo in a URL that
    // is in fact correct, so it gets its own actionable wording.
    if (message.includes('insecure_url')) return t('settings.updates.errors.insecure_url');
    if (message.includes('bad_url')) return t('settings.updates.errors.bad_url');
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
      // Open Settings › 关于我们 where the update group lives.
      if (typeof window.setView === 'function') {
        try { window.setView('settings'); } catch (_) { /* fall through */ }
      }
      if (typeof window.activateSettingsTab === 'function') {
        try { window.activateSettingsTab('about'); } catch (_) { /* non-fatal */ }
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
        // 整块重渲染：自动更新接管/交还都会改变 v1 三行的可操作性。
        _renderAll();
      });
      window.cogseed.onPushEvent('updates:progress', (p) => {
        if (!p) return;
        // 自动更新接管时，迟到的 v1 进度不得把第二个进度条拉回页面。
        if (_autoAuthoritative()) return;
        // 主进程还在推进度，就说明它确实在下载：本地状态落后时以推送为准（自愈），
        // 而不是把这条推送丢掉。
        _state.download = {
          phase: 'downloading',
          version: _state.download.version,
          received: Number(p.received) || 0,
          total: Number(p.total) || 0,
          percent: Number(p.percent) || 0,
        };
        // 状态文案与进度条同源前进。只在 100% 时更新会让「正在下载 0%」和
        // 前进中的进度条同时出现在页面上——同一个下载两个数。
        _renderProgress();
        _renderStatus();
        _renderTransferActions();
        _renderRowsVisibility();
      });
      // 阶段变化由主进程推送（downloading / paused / verifying / failed / idle）。
      // 渲染层据此重画，而不是自己记「我点过下载没有」——本地记账一旦与主进程
      // 脱节，重复点击就会把进度面永久拆掉。
      window.cogseed.onPushEvent('updates:download', (state) => {
        if (!state || !state.phase) return;
        _state.download = state;
        _renderAll();
        // 阶段变化通常伴随持久化状态变化（就绪记录 / 半包记录），拉一次权威快照。
        void _refreshSettings();
      });
    }
    // Fill the current-version label once (cheap, local).
    _refreshSettings();
    if (typeof window.cogseed.invoke === 'function') {
      window.cogseed.invoke('updates.autoStatus', {})
        .then((res) => {
          if (res && res.ok && res.status) {
            _state.autoStatus = res.status;
            _renderAll();
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
