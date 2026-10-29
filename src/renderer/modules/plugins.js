// Plugins status panel — 「连接」面板的「插件」tab。
//
// 定位：状态面板（不是操作台）。列表只回答"装没装、启没启用、什么版本、
// 授权状态如何"；真正的操作发生在对话里 —— 智能体调用插件技能（遥控器），
// 把数据发往插件所属平台；插件自带界面只作为对话里的「确认面板」出现。
//
// v1 能力：
//   - 列表：插件卡片 + 状态徽章（已启用/已停用）+ 授权状态（未配置 /
//     检查中 / 已激活 / 未授权，来自插件 runtime 的 license-check）
//   - 管理：安装（确认弹窗，展示将执行的准确命令）、启用/停用、更新、移除
//   - 详情：manifest 富字段 + 技能清单 + 平台配置表单（packages.ui.save-config，
//     api_key 只写不读；对话里智能体调插件时由 run-skill 自动注入）
//
// 经典脚本，无构建步骤；由 lazy-features 的 `plugins` 包按需加载。

(function () {
  'use strict';

  const _log = typeof createLogger === 'function' ? createLogger('plugins') : null;
  function log(level, msg, extra) {
    if (_log && typeof _log[level] === 'function') _log[level](msg, extra);
  }

  function _t(key, fallback, vars) {
    try {
      if (typeof t === 'function') {
        const v = t(key, vars);
        if (v && v !== key) return v;
      }
    } catch (_) { /* fall through */ }
    return fallback;
  }
  function _esc(s) {
    const raw = String(s == null ? '' : s);
    try { if (typeof escapeHtml === 'function') return escapeHtml(raw); } catch (_) {}
    return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function _icon(name, cls) {
    try { if (typeof uiIconHtml === 'function') return uiIconHtml(name, cls || ''); } catch (_) {}
    return '';
  }
  function _btn(opts) {
    try { if (typeof uiButton === 'function') return uiButton(opts); } catch (_) {}
    const label = _esc((opts && opts.label) || '');
    return `<button type="button" class="btn btn-sm"${opts && opts.disabled ? ' disabled' : ''}>${label}</button>`;
  }
  function _toast(msgKey, fallback, variant, vars) {
    try {
      if (typeof uiToast === 'function') {
        uiToast(fallback, { i18nKey: msgKey, i18nVars: vars, variant: variant || 'info' });
      }
    } catch (_) {}
  }
  function _invoke(channel, payload) {
    if (typeof window === 'undefined' || !window.cogseed || typeof window.cogseed.invoke !== 'function') {
      return Promise.reject(new Error('cogseed bridge unavailable'));
    }
    return window.cogseed.invoke(channel, payload);
  }

  // ── State ────────────────────────────────────────────────────────────────
  let _packagesCache = null;
  let _loadPromise = null;
  let _view = 'list';            // 'list' | 'detail'
  let _detailName = null;
  let _detailInfo = null;
  const _licenseCache = new Map();   // name -> {state, label?, error?}

  function _root() { return document.getElementById('plugins-root'); }

  // ── Data ─────────────────────────────────────────────────────────────────
  function _loadPackages(force) {
    if (!force && _loadPromise) return _loadPromise;
    _loadPromise = _invoke('packages.list')
      .then((res) => {
        _packagesCache = (res && res.ok && Array.isArray(res.packages)) ? res.packages : [];
        return _packagesCache;
      })
      .catch((err) => {
        log('warn', 'plugins list load failed', { error: (err && err.message) || String(err) });
        _packagesCache = [];
        return _packagesCache;
      });
    return _loadPromise;
  }

  function _displayName(pkg) {
    if (pkg && pkg.manifest && pkg.manifest.name) {
      return pkg.manifest.name.zh || pkg.manifest.name.en || pkg.display_name || pkg.name;
    }
    return (pkg && pkg.display_name) || (pkg && pkg.name) || '';
  }

  function _description(pkg) {
    const d = pkg && pkg.manifest && pkg.manifest.description;
    if (!d) return '';
    return d.zh || d.en || '';
  }

  function _kindLabel(kind) {
    return _t(`plugins.kind_${kind}`, kind || '');
  }

  function _fmtDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } catch (_) { return ''; }
  }

  // 简单语义化版本比较：a > b → 1；相等 → 0；a < b → -1。
  function _cmpVersion(a, b) {
    const pa = String(a || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  // ── 授权状态（license-check，经 packages.ui.invoke） ──────────────────────
  // 按角色从插件自带技能里挑（不硬编码具体技能名，通用插件也能用）：
  // 优先选名字含 student/teacher 的技能，否则退化为第一个技能。
  function _pickSkill(info, role) {
    const skills = (info && Array.isArray(info.skills)) ? info.skills : [];
    if (!skills.length) return '';
    const want = role === 'teacher' ? 'teacher' : 'student';
    return skills.find((s) => String(s).toLowerCase().includes(want)) || skills[0];
  }

  function _licenseSkill(info) {
    const role = info && info.config && info.config.role === 'teacher' ? 'teacher' : 'student';
    return _pickSkill(info, role);
  }

  function _refreshLicenses(pkgs) {
    // 只对"已启用 + 自带界面"的插件做授权检查；停用的插件不显示授权徽章
    // （停用状态下 runtime 调用会被拒，检查结果没有意义）。
    const targets = (pkgs || []).filter((p) => p.enabled && p.has_ui);
    // Sequential on purpose: each license-check spawns the plugin runtime;
    // parallel checks would pile up child processes for nothing.
    const chain = targets.reduce((acc, pkg) => acc.then(() => _checkLicense(pkg)), Promise.resolve());
    chain.catch(() => {});
  }

  // License 检查完成后刷新当前视图（列表徽章或详情「授权状态」行）。
  function _refreshViewAfterLicense() {
    if (_view === 'list') { _renderIfList(); return; }
    if (_view === 'detail') _render();
  }

  function _checkLicense(pkg) {
    _licenseCache.set(pkg.name, { state: 'checking' });
    _refreshViewAfterLicense();
    return _invoke('packages.ui.info', { name: pkg.name })
      .then((res) => {
        if (!(res && res.ok && res.info)) throw new Error((res && res.error) || 'no info');
        const info = res.info;
        const newer = info.latest_version && info.version && _cmpVersion(info.latest_version, info.version) > 0
          ? info.latest_version
          : null;
        if (!(info.config && info.config.configured)) {
          _licenseCache.set(pkg.name, { state: 'unconfigured', latest: newer });
          _refreshViewAfterLicense();
          return;
        }
        return _invoke('packages.ui.invoke', {
          name: pkg.name,
          method: 'runtime',
          params: { skill: _licenseSkill(info), command: 'license-check', args: {} },
        }).then((r) => {
          if (r && r.ok) {
            const licensed = !!(r.result && r.result.licensed);
            _licenseCache.set(pkg.name, { state: licensed ? 'licensed' : 'unlicensed', latest: newer });
          } else {
            _licenseCache.set(pkg.name, { state: 'error', error: (r && r.error) || 'check failed', latest: newer });
          }
          _refreshViewAfterLicense();
        });
      })
      .catch((err) => {
        _licenseCache.set(pkg.name, { state: 'error', error: (err && err.message) || String(err) });
        _refreshViewAfterLicense();
      });
  }

  function _versionChip(name, currentVersion) {
    const entry = _licenseCache.get(name);
    const latest = entry && entry.latest;
    if (!latest || !currentVersion || _cmpVersion(latest, currentVersion) <= 0) return '';
    return `<span class="plugins-version-dot" title="${_esc(_t('plugins.new_version', '新版本 v{ver}', { ver: latest }))}">${_esc(_t('plugins.new_version_short', 'v{ver}', { ver: latest }))}</span>`;
  }

  function _renderIfList() {
    if (_view === 'list' && _root() && _root().children.length) _renderList(_root());
  }

  function _licenseChip(name) {
    const entry = _licenseCache.get(name);
    if (!entry) return '<span class="plugins-license is-unknown">—</span>';
    if (entry.state === 'checking') {
      return `<span class="plugins-license is-checking">${_esc(_t('plugins.license_checking', '授权检查中…'))}</span>`;
    }
    if (entry.state === 'unconfigured') {
      return `<span class="plugins-license is-unconfigured">${_esc(_t('plugins.license_unconfigured', '未配置'))}</span>`;
    }
    if (entry.state === 'licensed') {
      return `<span class="plugins-license is-licensed">${_esc(_t('plugins.license_ok', '已激活'))}</span>`;
    }
    if (entry.state === 'unlicensed') {
      return `<span class="plugins-license is-unlicensed">${_esc(_t('plugins.license_denied', '未授权'))}</span>`;
    }
    return `<span class="plugins-license is-error" title="${_esc(entry.error || '')}">${_esc(_t('plugins.license_error', '检查失败'))}</span>`;
  }

  // ── View switching ───────────────────────────────────────────────────────
  function _render() {
    const root = _root();
    if (!root) return;
    if (_view === 'detail' && _detailName) { _renderDetail(root); return; }
    _renderList(root);
  }

  // ── List view（状态面板） ────────────────────────────────────────────────
  function _renderList(root) {
    const pkgs = _packagesCache || [];
    const loading = _loadPromise == null || (_packagesCache == null);
    const headerActions = [_btn({
      label: _t('plugins.install', '安装插件'),
      role: 'primary',
      icon: 'plus',
      attrs: { 'data-plugins-action': 'install' },
    })];
    const header = `<div class="plugins-page-header">
      <div class="plugins-page-header-main">
        <h1 class="plugins-page-title">${_esc(_t('plugins.title', '插件'))}</h1>
        <p class="plugins-page-subtitle">${_esc(_t('plugins.subtitle_status', '查看插件安装与授权状态。日常使用：在对话里直接说需求，智能体会调用插件完成操作。'))}</p>
      </div>
      <div class="plugins-page-header-actions">${headerActions.join('')}</div>
    </div>`;

    let body = '';
    if (loading) {
      body = `<div class="plugins-loading">${_esc(_t('plugins.loading', '正在加载插件…'))}</div>`;
    } else if (!pkgs.length) {
      try {
        if (typeof uiEmptyState === 'function') {
          body = uiEmptyState({
            kind: 'actionable',
            icon: 'puzzle',
            title: _t('plugins.empty_title', '还没有安装插件'),
            hint: _t('plugins.empty_hint', '从本地目录或 Git 仓库安装第一个插件。'),
            action: {
              label: _t('plugins.install', '安装插件'),
              role: 'primary',
              icon: 'plus',
              attrs: { 'data-plugins-action': 'install' },
            },
          });
        }
      } catch (_) {}
      if (!body) body = `<div class="plugins-empty">${_esc(_t('plugins.empty_title', '还没有安装插件'))}</div>`;
    } else {
      body = `<div class="plugins-grid">${pkgs.map(_cardHtml).join('')}</div>`;
    }
    root.innerHTML = `<div class="plugins-view plugins-view-list">${header}${body}</div>`;
    _hydrateUiIcons(root);
    _bindListEvents(root);
  }

  function _cardHtml(pkg) {
    const name = _displayName(pkg);
    const desc = _description(pkg);
    const metaBits = [];
    if (pkg.manifest && pkg.manifest.version) metaBits.push(`v${_esc(pkg.manifest.version)}`);
    metaBits.push(_esc(_kindLabel(pkg.kind)));
    if (pkg.updated_at) metaBits.push(_esc(_fmtDate(pkg.updated_at)));
    const enabledBadge = pkg.enabled
      ? `<span class="plugins-badge is-on">${_esc(_t('plugins.enabled', '已启用'))}</span>`
      : `<span class="plugins-badge is-off">${_esc(_t('plugins.disabled', '已停用'))}</span>`;
    return `<div class="plugins-card ui-resource-card${pkg.enabled ? '' : ' is-disabled'}" data-plugins-card="${_esc(pkg.name)}" role="button" tabindex="0">
      <div class="plugins-card-main" data-plugins-action="detail" data-plugins-name="${_esc(pkg.name)}">
        <div class="plugins-card-icon">${_icon('puzzle', 'plugins-card-icon-svg')}</div>
        <div class="plugins-card-body">
          <div class="plugins-card-title-row">
            <span class="plugins-card-name">${_esc(name)}</span>
            ${enabledBadge}
            ${pkg.has_ui ? _licenseChip(pkg.name) : ''}
            ${_versionChip(pkg.name, pkg.manifest && pkg.manifest.version)}
          </div>
          ${desc ? `<p class="plugins-card-desc">${_esc(desc)}</p>` : ''}
          <div class="plugins-card-meta">
            ${metaBits.map((m) => `<span class="plugins-card-meta-item">${m}</span>`).join('')}
            <span class="plugins-card-meta-item">${_esc(_t('plugins.skills_count', '技能 {count}', { count: pkg.skill_count || 0 }))}</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  function _bindListEvents(root) {
    root.querySelectorAll('[data-plugins-action="install"]').forEach((el) => {
      el.addEventListener('click', (ev) => { ev.stopPropagation(); _openInstallModal(); });
    });
    root.querySelectorAll('[data-plugins-action="detail"]').forEach((el) => {
      const name = el.dataset.pluginsName;
      if (!name) return;
      el.addEventListener('click', (ev) => { ev.stopPropagation(); _openDetail(name); });
    });
    root.querySelectorAll('[data-plugins-card]').forEach((card) => {
      card.addEventListener('keydown', (ev) => {
        if (ev.isComposing || ev.keyCode === 229) return;
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          _openDetail(card.dataset.pluginsCard);
        }
      });
    });
  }

  // ── Install modal ────────────────────────────────────────────────────────
  function _openInstallModal() {
    if (typeof uiModal !== 'function' || typeof uiField !== 'function') {
      _toast('plugins.action_failed', _t('plugins.action_failed', '操作失败'), 'error');
      return;
    }
    const bodyHtml = [
      '<div class="plugins-install-form">',
      uiField({
        id: 'plugins-install-source',
        label: _t('plugins.install_source', '来源（本地目录或 Git URL）'),
        required: true,
        hint: _t('plugins.install_source_hint', '本地目录需已存在；URL 仅支持 http(s) Git 仓库。'),
        control: { kind: 'input', type: 'text', placeholder: '/path/to/plugin 或 https://github.com/…' },
      }),
      '<div class="plugins-install-pick-row">',
      _btn({ label: _t('plugins.install_pick_dir', '选择本地目录…'), role: 'secondary', attrs: { id: 'plugins-install-pick' } }),
      '</div>',
      uiField({
        id: 'plugins-install-name',
        label: _t('plugins.install_name', '插件名（目录名，英文/数字/._-）'),
        required: true,
        hint: _t('plugins.install_name_hint', '安装后不可更改；留空则按仓库名推断。'),
        control: { kind: 'input', type: 'text', placeholder: 'my-plugin' },
      }),
      '<p class="plugins-install-note">' + _esc(_t('plugins.install_note', '安装会读取并校验插件内容；依赖安装（npm/pip）不会在此执行，需要依赖的插件请在对话中由智能体完成安装。')) + '</p>',
      '</div>',
    ].join('');
    const modal = uiModal({
      title: _t('plugins.install_title', '安装插件'),
      description: _t('plugins.install_desc', '确认后将在后台执行 cogseed-pkg install。'),
      bodyHtml,
      closeLabel: _t('plugins.cancel', '取消'),
      dismissOnBackdrop: false,
      actions: [
        { id: 'cancel', label: _t('plugins.cancel', '取消'), role: 'secondary' },
        { id: 'confirm', label: _t('plugins.install', '安装'), role: 'primary' },
      ],
    });
    const dialog = modal.dialog;
    const pickBtn = dialog.querySelector('#plugins-install-pick');
    pickBtn.addEventListener('click', () => {
      _invoke('common.pickDirectory', { title: _t('plugins.install_pick_dir', '选择插件目录') })
        .then((res) => {
          if (!res || res.cancelled) return;
          // IPC 契约：{cancelled:false, path:<所选目录>}
          const dir = res.path || res.dirPath || res.filePath || (res.paths && res.paths[0]);
          if (dir) dialog.querySelector('#plugins-install-source').value = dir;
        })
        .catch(() => {});
    });
    modal.then(async (outcome) => {
      if (outcome.value !== 'confirm') return;
      const source = dialog.querySelector('#plugins-install-source').value.trim();
      const name = dialog.querySelector('#plugins-install-name').value.trim();
      if (!source || !name) {
        _toast('plugins.install_invalid', _t('plugins.install_invalid', '请填写来源与插件名'), 'warning');
        return;
      }
      const installBtn = dialog.querySelector('[data-ui-modal-action="confirm"]');
      if (installBtn) { installBtn.disabled = true; installBtn.classList.add('is-loading'); }
      const res = await _invoke('packages.install', { source, name });
      if (res && res.ok) {
        _toast('plugins.installed', _t('plugins.installed', '插件 {name} 已安装', { name }), 'success', { name });
        _packagesCache = null;
        _loadPromise = null;
        _loadPackages(true).then(() => _render());
      } else {
        _toast('plugins.action_failed', _t('plugins.action_failed', '安装失败：{msg}', { msg: (res && res.error) || '' }), 'error', { msg: (res && res.error) || '' });
      }
    });
  }

  // ── Detail view ──────────────────────────────────────────────────────────
  function _openDetail(name) {
    _detailName = name;
    _detailInfo = null;
    _view = 'detail';
    _render();
    const fetchInfo = (attempt) => {
      _invoke('packages.ui.info', { name })
        .then((res) => {
          if (_view !== 'detail' || _detailName !== name) return;
          _detailInfo = (res && res.ok && res.info) ? res.info : null;
          // 主进程偶发抽风（如插件刚更新完）→ 800ms 后重试一次，界面自愈
          if (!_detailInfo && attempt === 0) {
            setTimeout(() => { if (_view === 'detail' && _detailName === name) fetchInfo(1); }, 800);
            return;
          }
          _render();
        })
        .catch(() => {
          if (attempt === 0) {
            setTimeout(() => { if (_view === 'detail' && _detailName === name) fetchInfo(1); }, 800);
            return;
          }
          if (_view === 'detail' && _detailName === name) _render();
        });
    };
    fetchInfo(0);
  }

  function _renderDetail(root) {
    const pkg = (_packagesCache || []).find((p) => p.name === _detailName);
    const info = _detailInfo;
    if (!pkg) {
      _view = 'list';
      _render();
      return;
    }
    const name = _displayName(pkg);
    const desc = _description(pkg);
    const rows = [];
    const addRow = (label, value) => { if (value) rows.push(`<div class="plugins-detail-row"><span class="plugins-detail-label">${_esc(label)}</span><span class="plugins-detail-value">${_esc(value)}</span></div>`); };
    addRow(_t('plugins.detail_version', '版本'), pkg.manifest && pkg.manifest.version);
    addRow(_t('plugins.detail_kind', '类型'), _kindLabel(pkg.kind));
    addRow(_t('plugins.detail_repo', '来源'), pkg.repo_url);
    addRow(_t('plugins.detail_commit', '提交'), pkg.commit);
    addRow(_t('plugins.detail_updated', '更新时间'), _fmtDate(pkg.updated_at));
    if (info && info.latest_version && pkg.manifest && pkg.manifest.version && _cmpVersion(info.latest_version, pkg.manifest.version) > 0) {
      addRow(_t('plugins.detail_new_version', '新版本'), info.latest_version + '（当前 v' + pkg.manifest.version + '）');
    }
    const roles = info && Array.isArray(info.roles) ? info.roles.join(' / ') : '';
    addRow(_t('plugins.detail_roles', '面向角色'), roles);
    const license = info && info.license ? [info.license.model, info.license.unit].filter(Boolean).join(' · ') : '';
    addRow(_t('plugins.detail_license', '授权'), license);
    // 实时授权状态（列表徽章同源）：详情页也给出「已激活/未授权/检查失败」。
    if (info && info.config && info.config.configured) {
      const lic = _licenseCache.get(_detailName);
      const licHtml = lic && _licenseChip(_detailName) !== '<span class="plugins-license is-unknown">—</span>'
        ? _licenseChip(_detailName)
        : `<span class="plugins-license is-checking">${_esc(_t('plugins.license_checking', '授权检查中…'))}</span>`;
      rows.push(`<div class="plugins-detail-row"><span class="plugins-detail-label">${_esc(_t('plugins.detail_license_status', '授权状态'))}</span><span class="plugins-detail-value">${licHtml}</span></div>`);
    }
    // 技能列表双保险：info 优先，失败/为空回退列表行携带的技能名。
    const infoSkills = (info && Array.isArray(info.skills)) ? info.skills : [];
    const skills = infoSkills.length ? infoSkills : ((pkg && Array.isArray(pkg.skills)) ? pkg.skills : []);
    const commands = (info && info.ui && Array.isArray(info.ui.commands) && info.ui.commands.length) ? info.ui.commands : [];

    const configSection = info ? _configSectionHtml(info) : '';

    const actionBtns = [];
    actionBtns.push(_btn({
      label: pkg.enabled ? _t('plugins.disable', '停用') : _t('plugins.enable', '启用'),
      role: 'secondary',
      icon: pkg.enabled ? 'x' : 'check',
      attrs: { 'data-plugins-detail-action': pkg.enabled ? 'disable' : 'enable' },
    }));
    // 内置/本地安装的包没有 git 源（repo_url 为空），升级随 CogSeed 发版，
    // cogseed-pkg update 会失败——不展示「更新」按钮。
    if (pkg.repo_url) {
      actionBtns.push(_btn({
        label: _t('plugins.update', '更新'),
        role: 'secondary',
        icon: 'refresh',
        attrs: { 'data-plugins-detail-action': 'update' },
      }));
    }
    actionBtns.push(_btn({
      label: _t('plugins.remove', '移除'),
      role: 'secondary',
      attrs: { 'data-plugins-detail-action': 'remove', class: 'is-danger' },
    }));

    root.innerHTML = `<div class="plugins-view plugins-view-detail">
      <div class="plugins-detail-top">
        <button type="button" class="btn btn-sm plugins-back" data-plugins-detail-action="back">← ${_esc(_t('plugins.back', '返回'))}</button>
      </div>
      <div class="plugins-detail-card">
        <div class="plugins-detail-head">
          <div class="plugins-card-icon">${_icon('puzzle', 'plugins-card-icon-svg')}</div>
          <div class="plugins-detail-head-text">
            <div class="plugins-detail-title-row">
              <h2 class="plugins-detail-title">${_esc(name)}</h2>
              ${pkg.enabled ? `<span class="plugins-badge is-on">${_esc(_t('plugins.enabled', '已启用'))}</span>` : `<span class="plugins-badge is-off">${_esc(_t('plugins.disabled', '已停用'))}</span>`}
            </div>
            ${desc ? `<p class="plugins-detail-desc">${_esc(desc)}</p>` : ''}
          </div>
        </div>
        <div class="plugins-detail-actions">${actionBtns.join('')}</div>
        <div class="plugins-detail-section">
          <h3 class="plugins-detail-section-title">${_esc(_t('plugins.detail_section_info', '基本信息'))}</h3>
          ${rows.join('')}
        </div>
        <div class="plugins-detail-section">
          <h3 class="plugins-detail-section-title">${_esc(_t('plugins.detail_section_skills', '技能（{count}）', { count: skills.length }))}</h3>
          ${skills.length ? `<div class="plugins-chip-row">${skills.map((s) => `<span class="plugins-chip">${_esc(s)}</span>`).join('')}</div>` : `<p class="plugins-detail-empty">${_esc(_t('plugins.no_skills', '无技能'))}</p>`}
        </div>
        ${commands.length ? `<div class="plugins-detail-section">
          <h3 class="plugins-detail-section-title">${_esc(_t('plugins.detail_section_commands', '对话可用命令'))}</h3>
          <div class="plugins-chip-row">${commands.map((c) => `<span class="plugins-chip">${_esc(c)}</span>`).join('')}</div>
        </div>` : ''}
        ${configSection}
      </div>
    </div>`;
    _hydrateUiIcons(root);
    root.querySelectorAll('[data-plugins-detail-action]').forEach((el) => {
      el.addEventListener('click', () => {
        const action = el.dataset.pluginsDetailAction;
        if (action === 'back') { _view = 'list'; _detailName = null; _detailInfo = null; _render(); return; }
        if (action === 'enable' || action === 'disable' || action === 'update') { _runPackageAction(action, _detailName); return; }
        if (action === 'remove') { _confirmRemove(_detailName); return; }
      });
    });
    _bindConfigEvents(root);
  }

  // ── 平台连接（模块 A：授权取代手工粘贴密钥） ─────────────────────────────
  //
  // 优先级与主进程一致：**授权令牌 > 手工 API Key**。
  // 界面据此分三种呈现，互不混用（同一块区域只讲一件事）：
  //   · method==='legacy'：存量用户，保持原样（表单直接可见）+ 一行"改用授权连接"
  //   · 其它：以「连接课程平台」为主路径，手工表单收进 <details> 折叠区
  // 状态 A/B/C/D/F 直接来自 `packages.ui.info` 的 `auth.state`，前端不自己推断 ——
  // 令牌有效性只有主进程知道（renderer 拿不到明文，也就不该猜）。
  function _authBlockHtml(info) {
    const auth = info.auth || {};
    const method = auth.method || 'none';
    const state = auth.state || 'A';
    const roleLabel = auth.role === 'teacher'
      ? _t('plugins.config_role_teacher', '教师')
      : _t('plugins.config_role_student', '学生');
    const identity = [auth.person_id ? roleLabel + ' · ' + auth.person_id : ''].filter(Boolean).join('');

    // ── 上一次尝试的结果（徽章与说明都要用，所以放在最前面算）──────────────
    // 一律限定**未连接**（state !== 'C'）：否则用户后来连上了，
    //    一条过期的失败原因会把"已连接"的徽章与说明一起盖掉 —— 界面又开始说假话。
    const notConnected = state !== 'C';
    const identityConflict = notConnected && auth.last_error_code === 'identity_conflict';
    // 账号被停用（平台码 account_disabled，来自 Hub 的 data.account.status）
    const accountDisabled = notConnected && auth.last_error_code === 'account_disabled';
    // 用户主动换账号（平台已解除绑定）：对应的动作是**再连一次**，与其他几条不同
    const lastSwitched = notConnected && auth.last_error_code === 'account_switch';
    const lastCancelled = notConnected && auth.last_error_code === 'access_denied';
    // 「需恢复」= 东西还在，但用户得先做点什么（原型对这类状态用 amber tag）。
    // 覆盖：授权失效（F）、身份冲突、账号停用。
    const needsRecovery = notConnected && (state === 'F' || identityConflict || accountDisabled);

    if (method === 'legacy') {
      return `<div class="plugins-auth is-legacy">
        <div class="plugins-auth-status">
          <span class="plugins-badge is-on">${_esc(_t('plugins.config_configured', '已配置'))}</span>
          <span class="plugins-auth-status-text">${_esc(_t('plugins.auth_legacy_title', '当前使用手工填写的 API Key'))}</span>
        </div>
        <p class="plugins-auth-note">${_esc(_t('plugins.auth_legacy_note', '改用授权连接后不必再手工复制密钥，也能随时在网页端撤销。'))}</p>
        <div class="plugins-auth-actions">
          ${_btn({ label: _t('plugins.auth_legacy_switch', '改用授权连接（推荐）'), role: 'primary', attrs: { 'data-plugins-config-action': 'authorize' } })}
        </div>
      </div>`;
    }

    const badge = state === 'C'
      ? `<span class="plugins-badge is-on">${_esc(_t('plugins.auth_connected', '已连接'))}</span>`
      : state === 'B'
        ? `<span class="plugins-badge is-checking">${_esc(_t('plugins.auth_state_pending', '已登录，还差一步：请到浏览器完成确认'))}</span>`
        : state === 'D'
          ? `<span class="plugins-badge is-off">${_esc(_t('plugins.auth_state_ineligible', '这门课需要合作账号才能使用'))}</span>`
          : needsRecovery
            // 原型对"东西还在、但需要恢复"的状态用 amber tag「需恢复」。
            // 之前这里落到「未配置」——那是**假话**：它是配置过之后才失效的。
            ? `<span class="plugins-badge is-warn">${_esc(_t('plugins.auth_state_needs_recovery', '需恢复'))}</span>`
            : `<span class="plugins-badge is-off">${_esc(_t('plugins.auth_state_unconnected', '未连接'))}</span>`;

    // 默认说明是"教你怎么连接"——但**已连接**的用户不需要被教（真人验收反馈：
    // 界面对已连接用户还在说"点连接课程平台…"，是废话）。
    // 另：**不显示令牌剩余时间**（真人验收反馈："剩余 62 分钟"会让人以为要手动做什么）。
    //    只在真的需要用户动手时才提示。
    let note = state === 'C'
      ? _t('plugins.auth_ready', '已连接，可以直接在对话里让它查挑战、交作业。到期自动续期，无需操作。')
      : _t('plugins.auth_note', '点「连接课程平台」后在浏览器里用你的 CogSeed 账号登录并确认课程身份即可，不需要手工复制密钥。授权令牌只存本机，不会出现在对话或日志里。');
    // Hub 未登录时**必须说清楚先去登录**（真人验收发现的缺陷：原先态 B 只认
    //    "有待确认流程"就宣称"已登录"，用户登出 Hub 后界面仍在说假话）。
    const hubMissing = auth.hub_signed_in === false && (auth.state === 'A' || auth.state === 'B');
    if (hubMissing) {
      note = `${_t('plugins.auth_need_hub_login', '请先登录 CogSeed 账号，再连接课程平台')} —— ${_t('plugins.auth_need_hub_login_hint', '左下角账号区可以登录。')}`;
    }
    // 已连接但 Hub 登录失效：令牌当下仍可用，如实提示"到期后无法自动续期"
    if (auth.state === 'C' && auth.hub_signed_in === false) {
      note = _t('plugins.auth_hub_logged_out', '登录已失效，建议重新登录 CogSeed 账号（当前授权仍可用，但到期后无法自动续期）');
    }
    // 下面几条来自**上一次尝试的失败原因**（last_error_code，判定已在函数开头算好）。
    // 原型把它们做成了独立的演示场景（cancelled / conflict / disabled），这里让它们常驻在卡片上
    // —— 用户回来还能看到"为什么没连上、接下来该做什么"。
    if (state === 'F') note = _t('plugins.auth_state_expired', '授权已失效，请重新授权后继续；历史作品仍会保留');
    else if (state === 'D') note = _t('plugins.auth_state_ineligible', '这门课需要合作账号才能使用');
    else if (identityConflict) note = _t('plugins.auth_state_conflict', '这个教育身份已经连到另一个 CogSeed 账号，请联系管理员核对');
    else if (accountDisabled) note = _t('plugins.auth_state_account_disabled', '这个账号已被停用，请联系平台管理员恢复');
    else if (lastSwitched) note = _t('plugins.auth_state_switch_account', '已解除这个教育身份的连接，请用正确的账号重新连接');
    else if (lastCancelled) note = _t('plugins.auth_state_cancelled', '你已取消授权，尚未建立教育连接。可随时重新发起');
    else if (auth.corrupt) note = _t('plugins.auth_state_corrupt', '本地授权信息已损坏，请重新连接');


    const actions = [];
    if (state === 'C') {
      actions.push(_btn({ label: _t('plugins.auth_disconnect', '断开连接'), role: 'secondary', attrs: { 'data-plugins-config-action': 'disconnect' } }));
      // 令牌当下仍可用，所以不强制；但给一个明确的补救入口
      if (auth.hub_signed_in === false) {
        actions.push(_btn({ label: _t('plugins.auth_login_hub', '登录 CogSeed 账号'), role: 'primary', attrs: { 'data-plugins-config-action': 'hub-login' } }));
      }
    } else if (state === 'B') {
      actions.push(_btn({ label: _t('plugins.auth_resume', '去浏览器完成确认'), role: 'primary', attrs: { 'data-plugins-config-action': 'authorize' } }));
    } else if (state === 'D') {
      // 无资格不是故障：给出路（复用现有咨询渠道），不呈现技术错误码。
      actions.push(_btn({ label: _t('plugins.auth_state_ineligible_action', '联系开通'), role: 'primary', attrs: { 'data-plugins-config-action': 'contact' } }));
    } else if (identityConflict || accountDisabled) {
      // 两个"恢复类"状态都只给出路，不给「重新连接」：
      //   身份冲突 → 找管理员核对账号关系；账号停用 → 找管理员恢复账号。重试都不会变好。
      actions.push(_btn({ label: _t('plugins.auth_state_recovery_action', '查看处理方式'), role: 'primary', attrs: { 'data-plugins-config-action': 'contact' } }));
    } else if (auth.hub_signed_in === false) {
      // Hub 未登录时**不能**给「重新连接」：那个动作第一步就要求 Hub 会话，
      //    用户点了必然失败（实测：先看到"正在打开浏览器…"再看到"连接失败"）。
      //    正确动作是先登录 —— 直接复用左下角账号区的登录通道，不另造一条。
      actions.push(_btn({ label: _t('plugins.auth_login_hub', '登录 CogSeed 账号'), role: 'primary', attrs: { 'data-plugins-config-action': 'hub-login' } }));
    } else {
      actions.push(_btn({ label: _t('plugins.auth_reconnect', '重新连接'), role: 'primary', attrs: { 'data-plugins-config-action': 'authorize' } }));
    }

    // ── 三步进度（原型 .authprogress）─────────────────────────────────────
    // 原型只按「Hub 是否登录」标第 1 步（`state.hub ? 'done' : 'now'`），后两步是常量。
    // 这里沿用**同一个组件、同一套语义**，但把已经知道的事实都说出来：
    // 教育身份有没有确认，主进程是知道的（auth.person_id），没必要让用户猜。
    // 已连接（C）不显示进度：那条路径没有待办，显示进度只会让人以为还得做点什么
    //（原型在"已连接"卡片里同样没有这一条）。
    const step = (cls, text) => (cls
      ? `<span class="${cls}">${_esc(text)}</span>`
      : `<span>${_esc(text)}</span>`);
    const stepLogin = auth.hub_signed_in === false ? 'now' : 'done';
    const stepIdentity = auth.person_id ? 'done' : (stepLogin === 'done' ? 'now' : '');
    const stepFinish = state === 'B' ? 'now' : '';
    const progress = state === 'C' ? '' : `<div class="plugins-auth-progress">
        ${step(stepLogin, _t('plugins.auth_step_login', '1 登录 CogSeed'))}
        <span class="sep">→</span>
        ${step(stepIdentity, _t('plugins.auth_step_identity', '2 确认教育身份'))}
        <span class="sep">→</span>
        ${step(stepFinish, _t('plugins.auth_step_done', '3 授权完成'))}
      </div>`;

    return `<div class="plugins-auth">
      <div class="plugins-auth-status">
        ${badge}
        ${identity && state === 'C' ? `<span class="plugins-auth-identity">${_esc(identity)}</span>` : ''}
        ${state === 'C' && auth.masked_access ? `<span class="plugins-auth-mask">${_esc(auth.masked_access)}</span>` : ''}
      </div>
      <p class="plugins-auth-note">${_esc(note)}</p>
      ${progress}
      <div class="plugins-auth-actions">${actions.join('')}</div>
    </div>`;
  }

  function _configSectionHtml(info) {
    const cfg = info.config || {};
    const auth = info.auth || {};
    const configured = !!cfg.configured;
    // 极简表单：只填平台地址 + API Key。角色/学号由平台按 key 自动识别
    // （whoami），只读展示；班级由平台侧掌握，无需本地配置。
    const identityLine = configured
      ? `<div class="plugins-config-identity">
          <span class="plugins-config-identity-label">${_esc(_t('plugins.config_identity', '识别结果'))}</span>
          <span class="plugins-config-identity-value">${_esc(cfg.role === 'teacher' ? _t('plugins.config_role_teacher', '教师') : _t('plugins.config_role_student', '学生'))} · ${_esc(cfg.student_id || '')}</span>
        </div>`
      : '';
    // 平台地址不再需要任何输入：全部使用新版密钥（地址由密钥自带）。
    // 已识别出的地址只读展示，方便确认连的是哪个平台。
    const serverLine = cfg.server_url
      ? `<div class="plugins-config-identity">
          <span class="plugins-config-identity-label">${_esc(_t('plugins.config_server', '平台地址'))}</span>
          <span class="plugins-config-identity-value">${_esc(cfg.server_url)}${_esc(_t('plugins.config_server_embedded', '（由密钥自带）'))}</span>
        </div>`
      : '';
    // 当前连接（生产 / 本地）—— 主进程启动时探测一次的结果。
    // 显示它，是为了不让人在"静默换环境"里猜：出问题时一眼看出连的是哪台。
    const _connLabel = (source) => {
      if (source === 'production') return _t('plugins.conn_production', '生产');
      if (source === 'local') return _t('plugins.conn_local', '本地');
      if (source === 'env') return _t('plugins.conn_env', '手动指定');
      return _t('plugins.conn_unreachable', '不可达');
    };
    const resolvedLine = cfg.resolved
      ? `<div class="plugins-config-identity">
          <span class="plugins-config-identity-label">${_esc(_t('plugins.config_connection', '当前连接'))}</span>
          <span class="plugins-config-identity-value">${_esc(_t('plugins.conn_hub', 'Hub'))} ${_esc(_connLabel(cfg.resolved.hub?.source))} · ${_esc(_t('plugins.conn_platform', '平台'))} ${_esc(_connLabel(cfg.resolved.platform?.source))}</span>
        </div>`
      : '';
    const fields = [
      resolvedLine,
      serverLine,
      uiField({
        id: 'plugins-config-key',
        label: _t('plugins.config_key', 'API Key'),
        hint: configured ? _t('plugins.config_key_set', '已配置（只写不回显，留空保持不变）') : _t('plugins.config_key_unset', '未配置'),
        control: { kind: 'input', type: 'password', value: '', placeholder: configured ? '••••••••' : '' },
      }),
    ].join('');
    const manualActions = `<div class="plugins-config-actions">
        ${_btn({ label: _t('plugins.config_save', '保存配置'), role: auth.method === 'legacy' ? 'primary' : 'secondary', attrs: { 'data-plugins-config-action': 'save' } })}
        ${_btn({ label: _t('plugins.config_test', '测试连接'), role: 'secondary', attrs: { 'data-plugins-config-action': 'test' } })}
      </div>`;

    // 存量用户（method==='legacy'）保持原样：表单直接可见，不把他们的入口藏起来。
    const manualBlock = auth.method === 'legacy'
      ? `${serverLine}${identityLine}
        <div class="plugins-config-fields">${uiField({
          id: 'plugins-config-key',
          label: _t('plugins.config_key', 'API Key'),
          hint: configured ? _t('plugins.config_key_set', '已配置（只写不回显，留空保持不变）') : _t('plugins.config_key_unset', '未配置'),
          control: { kind: 'input', type: 'password', value: '', placeholder: configured ? '••••••••' : '' },
        })}</div>
        ${manualActions}`
      // 走授权路径时，手工表单收进折叠区：主路径只有一件事，减少误操作。
      : `<details class="plugins-config-manual">
          <summary>${_esc(_t('plugins.auth_other_way', '其他方式：手动填写密钥'))}</summary>
          <p class="plugins-config-note">${_esc(_t('plugins.auth_other_way_note', '没有 CogSeed 账号，或需要连自建平台时使用。'))}</p>
          <div class="plugins-config-fields">${fields}</div>
          ${manualActions}
        </details>`;

    return `<div class="plugins-detail-section plugins-config-section">
      <h3 class="plugins-detail-section-title">${_esc(_t('plugins.auth_title', '课程平台连接'))}</h3>
      ${_authBlockHtml(info)}
      ${manualBlock}
    </div>`;
  }

  function _bindConfigEvents(root) {
    try { if (typeof hydrateUiFormSelects === 'function') hydrateUiFormSelects(root); } catch (_) {}
    const configSection = root.querySelector('.plugins-config-section');
    if (!configSection) return;
    configSection.querySelectorAll('[data-plugins-config-action]').forEach((el) => {
      el.addEventListener('click', async () => {
        const action = el.dataset.pluginsConfigAction;
        if (action === 'save') {
          // 只提交平台地址 + API Key；身份由主进程按新 key 自动识别。
          const config = {
            // 只提交 API Key：地址由密钥自带（主进程从 key 前缀解析）。
            api_key: configSection.querySelector('#plugins-config-key').value.trim(),
          };
          const keyInput = configSection.querySelector('#plugins-config-key');
          const res = await _invoke('packages.ui.save-config', { name: _detailName, config });
          if (res && res.ok) {
            keyInput.value = '';
            const id = res.identity && res.identity.role
              ? `${res.identity.role === 'teacher' ? _t('plugins.config_role_teacher', '教师') : _t('plugins.config_role_student', '学生')} · ${res.identity.person_id || ''}`
              : '';
            _toast('plugins.config_saved', id
              ? _t('plugins.config_saved_id', '配置已保存（识别为 {id}）', { id })
              : _t('plugins.config_saved', '配置已保存'), 'success', { id });
            _licenseCache.delete(_detailName);
            _openDetail(_detailName);
            // 保存后立即重查授权，详情「授权状态」与列表徽章即时刷新。
            const row = (_packagesCache || []).find((p) => p.name === _detailName);
            if (row) _checkLicense(row);
          } else {
            _toast('plugins.action_failed', _t('plugins.action_failed', '保存失败：{msg}', { msg: (res && res.error) || '' }), 'error', { msg: (res && res.error) || '' });
          }
          return;
        }

        if (action === 'authorize') {
          // 浏览器由主进程打开（授权 URL 里带 hub_token，绝不能进 renderer）。
          const btn = el;
          btn.disabled = true;
          btn.classList.add('is-loading');
          _toast('plugins.auth_opening', _t('plugins.auth_opening', '正在打开浏览器…'), 'info');
          let res;
          try {
            res = await _invoke('packages.auth.start', { name: _detailName });
          } finally {
            btn.disabled = false;
            btn.classList.remove('is-loading');
          }
          if (!res || !res.ok) {
            const msg = (res && (res.message || res.error)) || '';
            _toast('plugins.auth_start_failed', _t('plugins.auth_start_failed', '连接失败：{msg}', { msg }), 'error', { msg });
            return;
          }
          // 授权在浏览器里完成，深链回来时主进程会推 packages:auth-changed；
          // 这里只提示用户"去浏览器"，不假装已经连上。
          _openDetail(_detailName);
          return;
        }

        if (action === 'hub-login') {
          // 与左下角账号区同一条通道（hub-account.start_login）：登录在浏览器完成，
          // 回来后由 `hub-account:login-result` 推送 + 窗口焦点兜底刷新本页。
          const btn = el;
          btn.disabled = true;
          btn.classList.add('is-loading');
          _toast('plugins.auth_logging_in', _t('plugins.auth_logging_in', '正在打开登录页面…'), 'info');
          let res;
          try {
            res = await _invoke('hub-account.start_login');
          } catch (err) {
            res = { started: false, error: (err && err.message) || String(err) };
          } finally {
            btn.disabled = false;
            btn.classList.remove('is-loading');
          }
          if (!res || res.started !== true) {
            const msg = (res && (res.error || res.message)) || '';
            _toast('plugins.auth_login_failed', _t('plugins.auth_login_failed', '登录失败：{msg}', { msg }), 'error', { msg });
            return;
          }
          return;
        }

        if (action === 'disconnect') {
          _confirmDisconnect(_detailName);
          return;
        }

        if (action === 'contact') {
          // 无资格不是故障：给出路（复用现有对外链接处理），不显示技术错误码。
          const url = 'https://cogseed-open.bonc.com.cn/';
          try {
            if (typeof window !== 'undefined' && window.cogseed && typeof window.cogseed.openExternal === 'function') {
              await window.cogseed.openExternal(url);
            } else if (typeof window !== 'undefined') {
              window.open(url, '_blank', 'noopener');
            }
          } catch (err) {
            log('warn', 'open contact url failed', { error: (err && err.message) || String(err) });
          }
          return;
        }

        if (action === 'test') {
          const btn = el;
          btn.disabled = true;
          btn.classList.add('is-loading');
          // 按角色从插件自带技能里挑（不硬编码技能名）。
          const role = _detailInfo && _detailInfo.config && _detailInfo.config.role === 'teacher' ? 'teacher' : 'student';
          const skill = _pickSkill(_detailInfo, role);
          const res = await _invoke('packages.ui.invoke', { name: _detailName, method: 'runtime', params: { skill, command: 'health', args: {} } });
          btn.disabled = false;
          btn.classList.remove('is-loading');
          if (res && res.ok) {
            _toast('plugins.config_test_ok', _t('plugins.config_test_ok', '连接正常'), 'success');
          } else {
            _toast('plugins.action_failed', _t('plugins.config_test_fail', '连接失败：{msg}', { msg: (res && res.error) || '' }), 'error', { msg: (res && res.error) || '' });
          }
          // 无论测试结果如何，刷新一次授权状态行。
          const row = (_packagesCache || []).find((p) => p.name === _detailName);
          if (row) _checkLicense(row);
        }
      });
    });
  }

  function _confirmDisconnect(name) {
    const run = async () => {
      const res = await _invoke('packages.auth.disconnect', { name });
      if (res && res.ok) {
        _toast('plugins.auth_disconnected', _t('plugins.auth_disconnected', '已断开连接'), 'success');
        if (res.serverRevoked && res.revoked) {
          _toast('plugins.auth_revoked_toast', _t('plugins.auth_revoked_toast', '已在该平台撤销本机会话（{count} 个）', { count: res.revoked }), 'info', { count: res.revoked });
        }
        _licenseCache.delete(name);
        _detailInfo = null;
        _openDetail(name);
      } else {
        const msg = (res && (res.message || res.error)) || '';
        _toast('plugins.auth_disconnect_failed', _t('plugins.auth_disconnect_failed', '断开失败：{msg}', { msg }), 'error', { msg });
      }
    };
    if (typeof uiModal !== 'function') { run(); return; }
    uiModal({
      title: _t('plugins.auth_confirm_disconnect_title', '断开课程平台连接'),
      description: _t('plugins.auth_confirm_disconnect', '断开后本机将不再持有该平台的授权，插件无法再访问课程数据。确定断开？'),
      tone: 'danger',
      closeLabel: _t('plugins.auth_cancel', '取消'),
      dismissOnBackdrop: false,
      actions: [
        { id: 'cancel', label: _t('plugins.auth_cancel', '取消'), role: 'secondary' },
        { id: 'confirm', label: _t('plugins.auth_confirm_disconnect_ok', '断开'), role: 'danger' },
      ],
    }).then((outcome) => {
      if (outcome && outcome.value === 'confirm') run();
    });
  }

  function _runPackageAction(command, name) {
    _invoke('packages.action', { command, name }).then((res) => {
      if (res && res.ok) {
        _toast('plugins.action_done', _t('plugins.action_done', '操作完成'), 'success');
        _licenseCache.delete(name);
        _packagesCache = null;
        _loadPromise = null;
        _loadPackages(true).then(() => {
          if (_view === 'detail' && _detailName === name) {
            _detailInfo = null;
            _openDetail(name);
          } else {
            _render();
          }
        });
      } else {
        _toast('plugins.action_failed', _t('plugins.action_failed', '操作失败：{msg}', { msg: (res && res.error) || '' }), 'error', { msg: (res && res.error) || '' });
      }
    }).catch((err) => {
      _toast('plugins.action_failed', _t('plugins.action_failed', '操作失败：{msg}', { msg: (err && err.message) || String(err) }), 'error', { msg: (err && err.message) || String(err) });
    });
  }

  function _confirmRemove(name) {
    const pkg = (_packagesCache || []).find((p) => p.name === name);
    const label = pkg ? _displayName(pkg) : name;
    if (typeof uiModal !== 'function') { _runPackageAction('remove', name); return; }
    const modal = uiModal({
      title: _t('plugins.remove_title', '移除插件'),
      description: _t('plugins.remove_desc', '确定移除 {name}？其技能将不再可用。', { name: label }),
      tone: 'danger',
      closeLabel: _t('plugins.cancel', '取消'),
      dismissOnBackdrop: false,
      actions: [
        { id: 'cancel', label: _t('plugins.cancel', '取消'), role: 'secondary' },
        { id: 'confirm', label: _t('plugins.remove', '移除'), role: 'danger' },
      ],
    });
    modal.then((outcome) => {
      if (outcome.value !== 'confirm') return;
      _runPackageAction('remove', name);
      _view = 'list';
      _detailName = null;
      _detailInfo = null;
    });
  }

  // ── Shared helpers ───────────────────────────────────────────────────────
  function _hydrateUiIcons(scope) {
    try {
      if (typeof hydrateUiIcons === 'function') hydrateUiIcons(scope || document);
    } catch (_) {}
  }

  // ── Entry ────────────────────────────────────────────────────────────────
  function renderPlugins() {
    const root = _root();
    if (!root) return;
    _render();
    _loadPackages(false).then((pkgs) => {
      if (_view === 'list' && _root() === root) _render();
      _refreshLicenses(pkgs);
    });
  }

  window.renderPlugins = renderPlugins;
  // Re-render on locale switch so dynamic text follows the active language.
  if (typeof document !== 'undefined') {
    document.addEventListener('i18n-change', () => {
      if (_root() && _root().children.length) _render();
    });
  }

  // Hub 登录完成后刷新本页（用户可能正停在插件详情页等结果）。
  if (typeof window !== 'undefined' && window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
    try {
      window.cogseed.onPushEvent('hub-account:login-result', () => {
        const root = _root();
        if (!root || !root.children.length) return;
        _detailInfo = null;
        if (_view === 'detail' && _detailName) _openDetail(_detailName);
        else _render();
      });
    } catch (err) {
      log('warn', 'hub login push subscription failed', { error: (err && err.message) || String(err) });
    }
  }

  // 从浏览器切回应用时刷新状态。
  //
  // 为什么必须有这条兜底（2026-09-21 真机实测）：
  //   授权是在**浏览器**里完成的，界面靠主进程推送 `packages:auth-changed` 更新。
  //   实测用户点完「同意授权」切回应用时，界面**仍停在"还差一步"** ——
  //   而磁盘上的令牌其实已经写好了（状态是"已连接"）。
  //   用户因此以为"没连上"。窗口重新获得焦点是**最可靠**的刷新时机：
  //   不依赖推送通道、不依赖时序，用户切回来必然触发。
  if (typeof window !== 'undefined') {
    let _lastFocusRefresh = 0;
    const refreshNow = () => {
      const root = _root();
      if (!root || !root.children.length) return; // 插件面板没打开就不打扰
      _licenseCache.clear();
      _detailInfo = null;
      if (_view === 'detail' && _detailName) _openDetail(_detailName);
      else _render();
    };
    window.addEventListener('focus', () => {
      const now = Date.now();
      if (now - _lastFocusRefresh < 3000) return; // 节流：切窗口会连发多次
      _lastFocusRefresh = now;
      // 必须**查两次**（实测踩到）：授权是在浏览器里完成、回到主进程后才写盘的，
      //    而"切回窗口"这个动作往往比写盘**早几十毫秒**（实测 18.433 查询 /
      //    18.459 才写完）→ 只查一次会读到旧状态，用户以为没连上，
      //    于是又点一次（实测用户就是这样连点了两下）。
      refreshNow();
      setTimeout(refreshNow, 1500);
    });
  }

  // 授权是在**浏览器**里完成的：深链回到主进程时，renderer 并没有在等这个结果。
  // 没有这条推送，用户授权成功后回到应用会看到"仍未连接"，直到手动切页
  // （与 hub-account 的 login-result 推送同一模式）。
  if (typeof window !== 'undefined' && window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
    try {
      window.cogseed.onPushEvent('packages:auth-changed', (change) => {
        log('info', 'plugin auth change received', { result: (change && change.result) || 'unknown' });
        _licenseCache.clear();
        _detailInfo = null;
        if (_view === 'detail' && _detailName) _openDetail(_detailName);
        else if (_root() && _root().children.length) _render();
        if (change && change.result === 'success') {
          _toast('plugins.auth_connected', _t('plugins.auth_connected', '已连接'), 'success');
        } else if (change && change.result === 'failure') {
          // 失败原因由主进程给出中文说明（授权页里也显示过）；这里只提示"没连上"。
          _toast('plugins.auth_failed_generic', _t('plugins.auth_failed_generic', '连接未完成，请在插件页面重试'), 'error');
        }
      });
    } catch (err) {
      log('warn', 'plugin auth push subscription failed', { error: (err && err.message) || String(err) });
    }
  }
})();
