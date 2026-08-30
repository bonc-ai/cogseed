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

  function _checkLicense(pkg) {
    _licenseCache.set(pkg.name, { state: 'checking' });
    _renderIfList();
    return _invoke('packages.ui.info', { name: pkg.name })
      .then((res) => {
        if (!(res && res.ok && res.info)) throw new Error((res && res.error) || 'no info');
        const info = res.info;
        if (!(info.config && info.config.configured)) {
          _licenseCache.set(pkg.name, { state: 'unconfigured' });
          _renderIfList();
          return;
        }
        return _invoke('packages.ui.invoke', {
          name: pkg.name,
          method: 'runtime',
          params: { skill: _licenseSkill(info), command: 'license-check', args: {} },
        }).then((r) => {
          if (r && r.ok) {
            const licensed = !!(r.result && r.result.licensed);
            _licenseCache.set(pkg.name, { state: licensed ? 'licensed' : 'unlicensed' });
          } else {
            _licenseCache.set(pkg.name, { state: 'error', error: (r && r.error) || 'check failed' });
          }
          _renderIfList();
        });
      })
      .catch((err) => {
        _licenseCache.set(pkg.name, { state: 'error', error: (err && err.message) || String(err) });
        _renderIfList();
      });
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
    return `<div class="plugins-card${pkg.enabled ? '' : ' is-disabled'}" data-plugins-card="${_esc(pkg.name)}" role="button" tabindex="0">
      <div class="plugins-card-main" data-plugins-action="detail" data-plugins-name="${_esc(pkg.name)}">
        <div class="plugins-card-icon">${_icon('puzzle', 'plugins-card-icon-svg')}</div>
        <div class="plugins-card-body">
          <div class="plugins-card-title-row">
            <span class="plugins-card-name">${_esc(name)}</span>
            ${enabledBadge}
            ${pkg.has_ui ? _licenseChip(pkg.name) : ''}
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
    _invoke('packages.ui.info', { name })
      .then((res) => {
        if (_view !== 'detail' || _detailName !== name) return;
        _detailInfo = (res && res.ok && res.info) ? res.info : null;
        _render();
      })
      .catch(() => { if (_view === 'detail' && _detailName === name) _render(); });
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
    const roles = info && Array.isArray(info.roles) ? info.roles.join(' / ') : '';
    addRow(_t('plugins.detail_roles', '面向角色'), roles);
    const license = info && info.license ? [info.license.model, info.license.unit].filter(Boolean).join(' · ') : '';
    addRow(_t('plugins.detail_license', '授权'), license);
    const skills = (info && Array.isArray(info.skills) && info.skills.length) ? info.skills : [];
    const commands = (info && info.ui && Array.isArray(info.ui.commands) && info.ui.commands.length) ? info.ui.commands : [];

    const configSection = info ? _configSectionHtml(info) : '';

    const actionBtns = [];
    actionBtns.push(_btn({
      label: pkg.enabled ? _t('plugins.disable', '停用') : _t('plugins.enable', '启用'),
      role: 'secondary',
      icon: pkg.enabled ? 'x' : 'check',
      attrs: { 'data-plugins-detail-action': pkg.enabled ? 'disable' : 'enable' },
    }));
    actionBtns.push(_btn({
      label: _t('plugins.update', '更新'),
      role: 'secondary',
      icon: 'refresh',
      attrs: { 'data-plugins-detail-action': 'update' },
    }));
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

  function _configSectionHtml(info) {
    const cfg = info.config || {};
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
    const fields = [
      serverField,
      uiField({
        id: 'plugins-config-key',
        label: _t('plugins.config_key', 'API Key'),
        hint: configured ? _t('plugins.config_key_set', '已配置（只写不回显，留空保持不变）') : _t('plugins.config_key_unset', '未配置'),
        control: { kind: 'input', type: 'password', value: '', placeholder: configured ? '••••••••' : '' },
      }),
    ].join('');
    return `<div class="plugins-detail-section plugins-config-section">
      <h3 class="plugins-detail-section-title">${_esc(_t('plugins.config_title', '平台配置'))}</h3>
      <p class="plugins-config-note">${_esc(_t('plugins.config_note_auto', '只填平台地址和 API Key 即可：角色与身份由平台按密钥自动识别。密钥只存本机，不会出现在对话或日志里。'))}</p>
      <div class="plugins-config-status">
        ${configured
          ? `<span class="plugins-badge is-on">${_esc(_t('plugins.config_configured', '已配置'))}</span>`
          : `<span class="plugins-badge is-off">${_esc(_t('plugins.config_not_configured', '未配置'))}</span>`}
      </div>
      ${identityLine}
      <div class="plugins-config-fields">${fields}</div>
      <div class="plugins-config-actions">
        ${_btn({ label: _t('plugins.config_save', '保存配置'), role: 'primary', attrs: { 'data-plugins-config-action': 'save' } })}
        ${_btn({ label: _t('plugins.config_test', '测试连接'), role: 'secondary', attrs: { 'data-plugins-config-action': 'test' } })}
      </div>
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
          } else {
            _toast('plugins.action_failed', _t('plugins.action_failed', '保存失败：{msg}', { msg: (res && res.error) || '' }), 'error', { msg: (res && res.error) || '' });
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
        }
      });
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
})();
