// Knowledge base discovery renders data assembled by the main-process feature.
// It does not seed marketplace or connection records in the renderer.
(function () {
  const _state = {
    rendered: false,
    activeTab: 'featured',
    query: '',
    files: [],
    spaces: [],
    feishuShares: [],
    cogseedShares: [],
    summary: { total: 0, ready: 0, processing: 0, pending: 0, failed: 0 },
    loading: false,
    error: '',
    sharedError: '',
    publicFilter: 'all',
    savedCatalogIds: new Set(),
    feishuBusy: false,
    feishuOperation: '',
  };
  const _catalog = {
    featured: [],
    public: [],
    sources: [],
  };
  let _loadPromise = null;
  let _loadSeq = 0;

  function _t(key, fallback, vars) {
    try {
      const value = typeof window.t === 'function' ? window.t(key, vars || {}) : '';
      return value && value !== key ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function _esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _icon(name, className) {
    return typeof window.uiIconHtml === 'function'
      ? window.uiIconHtml(name, className || '')
      : '';
  }

  function _button(options) {
    return window.uiButton(options);
  }

  function _iconButton(options) {
    return window.uiIconButton(options);
  }

  function _catalogIcon(category, origin) {
    if (origin === 'published') return 'users';
    if (category === '研究') return 'globe';
    if (category === '团队') return 'folder';
    return 'book-open';
  }

  function _catalogTone(category) {
    if (category === '研究') return 'blue';
    if (category === '团队') return 'violet';
    return 'mint';
  }

  function _normalizeCatalogItem(item) {
    const origin = item?.origin === 'published' ? 'published' : 'official';
    const category = String(item?.category || '产品');
    return {
      id: String(item?.id || ''),
      category,
      icon: _catalogIcon(category, origin),
      tone: _catalogTone(category),
      title: String(item?.title || ''),
      desc: String(item?.description || ''),
      curator: String(item?.publisher || ''),
      author: String(item?.publisher || ''),
      source: origin,
      count: Math.max(0, Number(item?.sourceCount) || 0),
      followers: '',
      tags: Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag)) : [],
      update: item?.updatedAt ? _formatTime(item.updatedAt) : _t('kb.discover.time_unknown', '时间未知'),
      saved: item?.saved === true,
      imported: item?.imported === true,
      updateAvailable: item?.updateAvailable === true,
      importable: item?.importable === true,
      url: typeof item?.url === 'string' ? item.url : '',
    };
  }

  function _normalizeSourceItem(item) {
    const provider = String(item?.provider || 'official');
    const icon = provider === 'feishu' ? 'users' : (provider === 'team_space' ? 'folder' : 'book-open');
    const tone = provider === 'feishu' ? 'blue' : (provider === 'team_space' ? 'violet' : 'mint');
    const authorization = String(item?.authorization || 'not_connected');
    return {
      id: String(item?.id || ''), icon, tone,
      title: String(item?.title || ''), desc: String(item?.description || ''),
      scope: String(item?.scopeLabel || ''), owner: String(item?.ownerLabel || ''),
      count: Math.max(0, Number(item?.sourceCount) || 0),
      update: item?.updatedAt ? _formatTime(item.updatedAt) : '',
      status: authorization,
      configured: item?.configured === true,
      error: String(item?.error || ''),
      documents: Array.isArray(item?.documents) ? item.documents
        .filter((document) => document && typeof document.path === 'string' && document.path)
        .map((document) => ({ title: String(document.title || ''), path: String(document.path), importedAt: String(document.importedAt || '') })) : [],
    };
  }

  async function _invoke(channel, payload) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      return { ok: false, error: _t('kb.discover.ipc_unavailable', '知识库服务不可用') };
    }
    try {
      return await window.cogseed.invoke(channel, payload || {});
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err || _t('kb.discover.load_failed', '加载失败')) };
    }
  }

  function _flattenTree(nodes, result) {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node) continue;
      if (node.type === 'file' && node.path) {
        result.push({
          path: String(node.path),
          kind: '',
          status: 'unindexed',
          chunks: 0,
          bytes: Number(node.bytes) || 0,
          mtime: Number(node.mtime) || 0,
          error: '',
        });
      }
      if (node.type === 'dir') _flattenTree(node.children, result);
    }
    return result;
  }

  function _normalizeFiles(statusFiles, tree) {
    const byPath = new Map();
    for (const row of Array.isArray(statusFiles) ? statusFiles : []) {
      const path = String(row?.path || '');
      if (!path) continue;
      byPath.set(path, {
        path,
        kind: String(row.kind || ''),
        status: String(row.status || 'unindexed'),
        chunks: Math.max(0, Number(row.chunks) || 0),
        bytes: Math.max(0, Number(row.bytes) || 0),
        mtime: Number(row.mtime) || 0,
        error: String(row.error || ''),
      });
    }
    for (const file of _flattenTree(tree, [])) {
      const existing = byPath.get(file.path);
      if (existing) {
        existing.bytes = existing.bytes || file.bytes;
        existing.mtime = existing.mtime || file.mtime;
      } else {
        byPath.set(file.path, file);
      }
    }
    return [...byPath.values()].sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path, 'zh-CN'));
  }

  function _formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = bytes / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
  }

  function _formatTime(value) {
    if (!value) return _t('kb.discover.time_unknown', '时间未知');
    const date = typeof value === 'number'
      ? new Date(value * 1000)
      : new Date(String(value));
    if (Number.isNaN(date.getTime())) return _t('kb.discover.time_unknown', '时间未知');
    return new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function _fileName(path) {
    const bits = String(path || '').split('/');
    return bits[bits.length - 1] || path;
  }

  function _topicName(path) {
    const first = String(path || '').split('/').filter(Boolean)[0];
    return first || _t('kb.discover.ungrouped', '未归类资料');
  }

  function _statusMeta(file) {
    const status = file.status;
    if (status === 'ready') return { label: _t('kb.discover.status_ready', '可检索'), tone: 'ready', icon: 'check-circle' };
    if (status === 'failed') return { label: _t('kb.discover.status_failed', '索引失败'), tone: 'failed', icon: 'warning' };
    if (status === 'processing') return { label: _t('kb.discover.status_processing', '索引中'), tone: 'processing', icon: 'loader' };
    if (status === 'pending') return { label: _t('kb.discover.status_pending', '等待索引'), tone: 'pending', icon: 'hourglass' };
    return { label: _t('kb.discover.status_unindexed', '未索引'), tone: 'unindexed', icon: 'file-text' };
  }

  function _sourceMatches(file) {
    const query = _state.query.trim().toLocaleLowerCase();
    if (!query) return true;
    return [file.path, file.kind, _statusMeta(file).label]
      .some((value) => String(value || '').toLocaleLowerCase().includes(query));
  }

  function _topicRows(files) {
    const groups = new Map();
    for (const file of files) {
      const name = _topicName(file.path);
      const group = groups.get(name) || { name, files: [], bytes: 0, ready: 0, newest: 0 };
      group.files.push(file);
      group.bytes += file.bytes;
      group.ready += file.status === 'ready' ? 1 : 0;
      group.newest = Math.max(group.newest, file.mtime);
      groups.set(name, group);
    }
    return [...groups.values()]
      .map((group) => ({ ...group, files: group.files.sort((a, b) => b.mtime - a.mtime) }))
      .sort((a, b) => b.newest - a.newest || a.name.localeCompare(b.name, 'zh-CN'));
  }

  function _sharedRows() {
    const spaceById = new Map(_state.spaces.map((space) => [String(space.space_id || ''), space]));
    const rows = [];
    const seen = new Set();
    const pushShare = (share, channel) => {
      const spaceId = String(share?.spaceId || '');
      const key = `${channel}:${spaceId}`;
      if (!spaceId || seen.has(key)) return;
      seen.add(key);
      const space = spaceById.get(spaceId);
      rows.push({
        key,
        channel,
        kind: 'published',
        spaceId,
        name: String(share.spaceName || space?.name || spaceId),
        description: String(space?.description || ''),
        access: String(share.access || ''),
        fileCount: Math.max(0, Number(share.fileCount) || 0),
        updatedAt: share.updatedAt || share.createdAt || space?.updated_at || '',
        url: String(share.url || ''),
      });
    };
    for (const share of _state.cogseedShares) pushShare(share, 'cogseed');
    for (const share of _state.feishuShares) pushShare(share, 'feishu');
    for (const space of _state.spaces) {
      if (space?.shared !== true) continue;
      const spaceId = String(space.space_id || '');
      if (!spaceId || seen.has(`cogseed:${spaceId}`) || seen.has(`feishu:${spaceId}`)) continue;
      seen.add(`space:${spaceId}`);
      rows.push({
        key: `space:${spaceId}`,
        channel: 'space',
        kind: 'space',
        spaceId,
        name: String(space.name || spaceId),
        description: String(space.description || ''),
        access: String(space.member_permission || ''),
        fileCount: 0,
        updatedAt: String(space.updated_at || ''),
        url: '',
      });
    }
    return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.name.localeCompare(b.name, 'zh-CN'));
  }

  function _emptyState(options) {
    const actionable = Boolean(options.action);
    const kind = actionable ? 'actionable' : (options.detail || options.loading || options.error ? 'explained' : 'quiet');
    const hint = options.detail || (options.loading
      ? _t('kb.discover.loading_detail', '正在同步当前知识库状态，请稍候。')
      : '');
    const html = window.uiEmptyState({
      kind,
      icon: options.icon || 'database',
      title: options.message,
      hint,
      ...(actionable ? {
        action: {
          label: options.actionLabel,
          icon: options.action === 'refresh' ? 'refresh' : undefined,
          attrs: { 'data-discover-action': options.action },
        },
      } : {}),
    });
    return `<div class="kb-discover-shared-state${options.loading ? ' is-loading' : ''}${options.error ? ' is-error' : ''}">${html}</div>`;
  }

  function _renderStatusChip(file) {
    const meta = _statusMeta(file);
    return `<span class="kb-discover-status-chip is-${_esc(meta.tone)}">
      ${_icon(meta.icon, 'kb-discover-status-chip-icon')}${_esc(meta.label)}
    </span>`;
  }

  function _renderFileRow(file) {
    const meta = [
      file.kind || _t('kb.discover.file_kind', '文件'),
      _formatBytes(file.bytes),
      file.status === 'ready' ? _t('kb.discover.chunks', '{count} 个片段', { count: file.chunks }) : _formatTime(file.mtime),
    ].filter(Boolean);
    return `<article class="kb-discover-file">
      <span class="kb-discover-file-icon">${_icon('file-text', 'kb-discover-file-icon-svg')}</span>
      <span class="kb-discover-file-main">
        <span class="kb-discover-file-name">${_esc(_fileName(file.path))}</span>
        <span class="kb-discover-file-path">${_esc(file.path)}</span>
        <span class="kb-discover-file-meta">${_esc(meta.join(' · '))}</span>
      </span>
      ${_renderStatusChip(file)}
      ${_button({
        label: _t('kb.discover.view_sources', '查看资料'),
        role: 'ghost',
        size: 'sm',
        iconEnd: 'arrow-right',
        attrs: {
          'data-discover-path': file.path,
          title: _t('kb.discover.open_source', '打开原文：{path}', { path: file.path }),
        },
      })}
    </article>`;
  }

  function _renderFeatured(topics) {
    if (_state.loading && !_state.files.length) {
      return _emptyState({ loading: true, icon: 'loader', message: _t('kb.discover.loading_topics', '正在读取真实专题') });
    }
    if (_state.error && !_state.files.length) {
      return _emptyState({ error: true, icon: 'warning', message: _t('kb.discover.load_topics_failed', '无法读取专题资料'), detail: _state.error, action: 'refresh', actionLabel: _t('common.retry', '重新加载') });
    }
    if (!topics.length) {
      return _emptyState({
        icon: 'folder',
        message: _t('kb.discover.no_topics', '还没有可展示的真实专题'),
        detail: _t('kb.discover.no_topics_detail', '导入资料并按文件夹整理后，这里会自动形成可复用专题。'),
        action: 'open-workbench',
        actionLabel: _t('kb.discover.open_library', '前往知识库'),
      });
    }
    return `<div class="kb-discover-topic-grid">${topics.map((topic) => {
      const latest = topic.files[0];
      const previews = topic.files.slice(0, 2);
      return `<article class="kb-discover-topic-card">
        <header class="kb-discover-card-head">
          <span class="kb-discover-card-icon">${_icon('folder', 'kb-discover-card-icon-svg')}</span>
          <span class="kb-discover-origin">${_esc(_t('kb.discover.origin_personal', '我的资料'))}</span>
        </header>
        <h3>${_esc(topic.name)}</h3>
        <p>${_esc(_t('kb.discover.topic_meta', '{files} 个资料 · {ready} 个可检索 · {size}', {
          files: topic.files.length, ready: topic.ready, size: _formatBytes(topic.bytes),
        }))}</p>
        <div class="kb-discover-card-sources">${previews.map((file) => `<span>${_icon('file-text', 'kb-discover-card-source-icon')}${_esc(_fileName(file.path))}</span>`).join('')}</div>
        <footer>
          <span>${_esc(_t('kb.discover.updated_at', '更新于 {time}', { time: _formatTime(topic.newest) }))}</span>
          ${_button({ label: _t('kb.discover.view_sources', '查看资料'), role: 'ghost', size: 'sm', iconEnd: 'arrow-right', attrs: { 'data-discover-path': latest.path } })}
        </footer>
      </article>`;
    }).join('')}</div>`;
  }

  function _renderSources(files) {
    if (_state.loading && !_state.files.length) {
      return _emptyState({ loading: true, icon: 'loader', message: _t('kb.discover.loading_sources', '正在读取资料来源') });
    }
    if (_state.error && !_state.files.length) {
      return _emptyState({ error: true, icon: 'warning', message: _t('kb.discover.load_sources_failed', '无法读取资料来源'), detail: _state.error, action: 'refresh', actionLabel: _t('common.retry', '重新加载') });
    }
    if (!files.length) {
      return _emptyState({
        icon: _state.query ? 'search' : 'file-text',
        message: _state.query ? _t('kb.discover.no_source_match', '没有找到匹配的真实资料') : _t('kb.discover.no_sources', '知识库中还没有可检索的资料来源'),
        detail: _state.query ? '' : _t('kb.discover.no_sources_detail', '此处只会展示已导入或已连接的真实资料。'),
        action: _state.query ? 'clear-query' : 'open-workbench',
        actionLabel: _state.query ? _t('kb.discover.clear_query', '清除搜索') : _t('kb.discover.open_library', '前往知识库'),
      });
    }
    return `<div class="kb-discover-file-list">${files.map(_renderFileRow).join('')}</div>`;
  }

  function _accessLabel(value) {
    const access = String(value || '');
    const labels = {
      anyone: _t('kb.discover.access_public', '公开链接'),
      tenant: _t('kb.discover.access_tenant', '组织内'),
      private: _t('kb.discover.access_private', '私密'),
      view_export: _t('kb.discover.access_export', '可查看和导出'),
      view_only: _t('kb.discover.access_view', '仅查看'),
      hidden: _t('kb.discover.access_hidden', '成员不可见'),
    };
    return labels[access] || _t('kb.discover.access_shared', '已共享');
  }

  function _channelLabel(channel) {
    if (channel === 'cogseed') return _t('kb.discover.channel_cogseed', 'CogSeed 共享');
    if (channel === 'feishu') return _t('kb.discover.channel_feishu', '飞书共享');
    return _t('kb.discover.channel_space', '共享知识库');
  }

  function _catalogSourceLabel(origin) {
    return origin === 'official'
      ? _t('kb.discover.source_official', '官方知识库')
      : _t('kb.discover.source_published', '已发布知识库');
  }

  function _renderShared(items) {
    if (_state.loading && !items.length) {
      return _emptyState({ loading: true, icon: 'loader', message: _t('kb.discover.loading_shared', '正在读取共享知识库') });
    }
    if (_state.sharedError && !items.length) {
      return _emptyState({ error: true, icon: 'warning', message: _t('kb.discover.load_shared_failed', '无法读取共享记录'), detail: _state.sharedError, action: 'refresh', actionLabel: _t('common.retry', '重新加载') });
    }
    if (!items.length) {
      return _emptyState({
        icon: 'users',
        message: _t('kb.discover.no_shared', '还没有真实的共享或订阅记录'),
        detail: _t('kb.discover.no_shared_detail', '知识库完成共享或被加入共享空间后，会在这里展示。'),
        action: 'open-workbench',
        actionLabel: _t('kb.discover.manage_shares', '管理知识库'),
      });
    }
    return `<div class="kb-discover-share-grid">${items.map((item) => `<article class="kb-discover-share-card">
      <header class="kb-discover-card-head">
        <span class="kb-discover-card-icon">${_icon(item.kind === 'space' ? 'users' : 'external', 'kb-discover-card-icon-svg')}</span>
        <span class="kb-discover-origin">${_esc(_channelLabel(item.channel))}</span>
      </header>
      <h3>${_esc(item.name)}</h3>
      ${item.description ? `<p>${_esc(item.description)}</p>` : `<p class="is-muted">${_esc(_t('kb.discover.no_description', '暂未填写简介'))}</p>`}
      <div class="kb-discover-share-meta">
        <span>${_icon('lock', 'kb-discover-share-meta-icon')}${_esc(_accessLabel(item.access))}</span>
        ${item.fileCount ? `<span>${_icon('file-text', 'kb-discover-share-meta-icon')}${_esc(_t('kb.discover.file_count', '{count} 个资料', { count: item.fileCount }))}</span>` : ''}
      </div>
      <footer>
        <span>${_esc(item.updatedAt ? _t('kb.discover.updated_at', '更新于 {time}', { time: _formatTime(item.updatedAt) }) : _t('kb.discover.time_unknown', '时间未知'))}</span>
        ${item.url ? _button({ label: _t('kb.discover.copy_link', '复制链接'), role: 'ghost', size: 'sm', icon: 'copy', attrs: { 'data-discover-copy-url': item.url } }) : ''}
      </footer>
    </article>`).join('')}</div>`;
  }

  function _catalogTags(tags) {
    return `<div class="kb-discover-catalog-tags">${tags.map((tag) => `<span>${_esc(tag)}</span>`).join('')}</div>`;
  }

  function _catalogLead(icon, eyebrow, title, detail, count) {
    return `<section class="kb-discover-catalog-lead">
      <span class="kb-discover-catalog-lead-icon">${_icon(icon, 'kb-discover-catalog-lead-icon-svg')}</span>
      <div><span class="kb-discover-catalog-eyebrow">${_esc(eyebrow)}</span><h2>${_esc(title)}</h2><p>${_esc(detail)}</p></div>
      <div class="kb-discover-catalog-stat"><strong>${_esc(count)}</strong><span>${_esc(_t('kb.discover.discoverable_libraries', '可发现资料库'))}</span></div>
    </section>`;
  }

  function _renderCatalogCard(item, kind) {
    const saved = item.saved === true;
    const isPublic = kind === 'public';
    const previewButton = _button({
      label: _t('kb.discover.view_collection', '查看'),
      role: 'ghost',
      size: 'sm',
      iconEnd: 'arrow-right',
      attrs: { 'data-discover-catalog-preview': item.id },
    });
    const importButton = item.importable ? _button({
      label: item.updateAvailable
        ? _t('kb.discover.update_library', '更新知识包')
        : (item.imported ? _t('kb.discover.imported', '已导入') : _t('kb.discover.import_library', '导入知识库')),
      role: 'secondary',
      size: 'sm',
      disabled: item.imported && !item.updateAvailable,
      attrs: { 'data-discover-catalog-import': item.id },
    }) : '';
    const saveButton = _iconButton({
      icon: saved ? 'check-circle' : 'plus',
      label: saved ? _t('kb.discover.saved', '已收藏') : _t('kb.discover.save', '收藏'),
      attrs: { 'data-discover-catalog-save': item.id },
    });
    return `<article class="kb-discover-catalog-card${isPublic ? ' is-public' : ''} is-${_esc(item.tone || 'mint')}">
      <header><span class="kb-discover-catalog-icon">${_icon(item.icon, 'kb-discover-catalog-icon-svg')}</span><span class="kb-discover-catalog-origin">${_esc(_catalogSourceLabel(item.source))}</span></header>
      <h3>${_esc(item.title)}</h3><p>${_esc(item.desc)}</p>${_catalogTags(item.tags)}
      <div class="kb-discover-catalog-facts"><span>${_icon('users', 'kb-discover-catalog-fact-icon')}${_esc(item.author || item.curator)}</span><span>${_icon('file-text', 'kb-discover-catalog-fact-icon')}${_esc(_t('kb.discover.material_count', '{count} 份资料', { count: item.count }))}</span></div>
      <footer><span>${_esc(_t('kb.discover.updated_at', '更新于 {time}', { time: item.update }))}</span><div class="kb-discover-card-controls">${previewButton}${importButton}${saveButton}</div></footer>
    </article>`;
  }

  function _renderFeaturedEcosystem() {
    const personal = _topicRows(_state.files);
    const personalContent = personal.length ? `<div class="kb-discover-personal-list">${personal.slice(0, 4).map((topic) => {
      const latest = topic.files[0];
      return `<article class="kb-discover-personal-topic"><span>${_icon('folder', 'kb-discover-personal-topic-icon')}</span><span><strong>${_esc(topic.name)}</strong><small>${_esc(_t('kb.discover.topic_meta', '{files} 个资料 · {ready} 个可检索 · {size}', { files: topic.files.length, ready: topic.ready, size: _formatBytes(topic.bytes) }))}</small></span><em>${_esc(_t('kb.discover.updated_at', '更新于 {time}', { time: _formatTime(topic.newest) }))}</em>${_iconButton({ icon: 'arrow-right', label: _t('kb.discover.view_sources', '查看资料'), attrs: { 'data-discover-path': latest.path } })}</article>`;
    }).join('')}</div>` : _emptyState({ icon: 'folder', message: _t('kb.discover.no_topics', '还没有可展示的真实专题'), detail: _t('kb.discover.no_topics_detail', '导入资料并按文件夹整理后，这里会自动形成可复用专题。'), action: 'open-workbench', actionLabel: _t('kb.discover.open_library', '前往知识库') });
    return `${_catalogLead('sparkles', _t('kb.discover.featured_eyebrow', '官方与个人知识库'), _t('kb.discover.featured_lead_title', '把成熟经验带进你的知识库'), _t('kb.discover.featured_lead_detail', '官方知识包与已导入资料分别管理，并且都可追溯到真实来源。'), String(_catalog.featured.length))}
      <section class="kb-discover-catalog-section"><div class="kb-discover-catalog-section-head"><div><h3>${_esc(_t('kb.discover.official_featured', '官方精选'))}</h3><p>${_esc(_t('kb.discover.official_featured_detail', '随产品发布、带版本和资料清单的正式知识包。'))}</p></div></div>${_catalog.featured.length ? `<div class="kb-discover-catalog-grid">${_catalog.featured.map((item) => _renderCatalogCard(item, 'featured')).join('')}</div>` : _emptyState({ icon: 'book-open', message: _t('kb.discover.no_official_packages', '暂无可用的官方知识包') })}</section>
      <section class="kb-discover-catalog-section"><div class="kb-discover-catalog-section-head"><div><h3>${_esc(_t('kb.discover.my_topics', '我的专题'))}</h3><p>${_esc(_t('kb.discover.my_topics_detail', '从已导入资料自动归纳，和外部专题分开管理。'))}</p></div></div>${personalContent}</section>`;
  }

  function _renderPublicPlaza() {
    return `<section class="kb-discover-catalog-section">${_emptyState(_publicPlazaPendingStateOptions())}</section>`;
  }

  function _publicPlazaPendingStateOptions() {
    return {
      icon: 'clock',
      message: _t('kb.discover.public_pending_title', '公共广场待开发'),
      detail: _t('kb.discover.public_pending_detail', '远端知识目录、发布、订阅和跨设备同步能力仍在规划中，当前版本暂不开放。'),
    };
  }

  function _renderSourceHub() {
    const total = _catalog.sources.reduce((sum, source) => sum + source.count, 0);
    const statusLabel = {
      active: _t('kb.discover.source_status_active', '已连接'),
      not_connected: _t('kb.discover.source_status_not_connected', '未连接'),
      expired: _t('kb.discover.source_status_expired', '需要重新授权'),
      error: _t('kb.discover.source_status_error', '连接异常'),
    };
    const sourceAction = (source) => {
      if (source.id !== 'feishu') return _button({ label: _t('kb.discover.view_status', '查看状态'), role: 'ghost', size: 'sm', iconEnd: 'arrow-right', attrs: { 'data-discover-source-preview': source.id } });
      if (!source.configured) return _button({ label: _t('kb.discover.configure_feishu', '配置飞书'), role: 'secondary', size: 'sm', disabled: _state.feishuBusy, attrs: { 'data-discover-action': 'configure-feishu' } });
      if (source.status === 'active') {
        return `<div class="kb-discover-source-actions">${source.count ? _button(_feishuSyncActionOptions(_state.feishuBusy, _state.feishuOperation)) : ''}${_button(_feishuDocumentActionOptions(_state.feishuBusy, _state.feishuOperation))}${_button({ label: _t('kb.discover.feishu_disconnect', '断开'), role: 'ghost', size: 'sm', icon: 'log-out', disabled: _state.feishuBusy, attrs: { 'data-discover-action': 'disconnect-feishu' } })}</div>`;
      }
      return `<div class="kb-discover-source-actions">${_button({ label: _t('kb.discover.connect_feishu', '连接飞书'), role: 'primary', size: 'sm', disabled: _state.feishuBusy, attrs: { 'data-discover-action': 'authorize-feishu' } })}${_button({ label: _t('kb.discover.feishu_remove_source', '移除来源'), role: 'ghost', size: 'sm', disabled: _state.feishuBusy, attrs: { 'data-discover-action': 'remove-feishu' } })}</div>`;
    };
    return `${_catalogLead('folder', _t('kb.discover.sources_eyebrow', '真实资料来源'), _t('kb.discover.sources_lead_title', '让团队资料持续进入知识库'), _t('kb.discover.sources_lead_detail', '每个来源都展示授权范围、真实资料量和当前同步状态。'), String(total))}
      <section class="kb-discover-catalog-section"><div class="kb-discover-catalog-section-head"><div><h3>${_esc(_t('kb.discover.source_overview', '来源总览'))}</h3><p>${_esc(_t('kb.discover.source_overview_detail', '官方知识包、飞书连接和团队空间都使用真实状态。'))}</p></div></div>${_catalog.sources.length ? `<div class="kb-discover-source-grid">${_catalog.sources.map((source) => `<article class="kb-discover-source-card is-${_esc(source.tone)}"><header><span class="kb-discover-source-icon">${_icon(source.icon, 'kb-discover-source-icon-svg')}</span><span>${source.status === 'active' ? _icon('check-circle', 'kb-discover-source-check') : _icon('warning', 'kb-discover-source-check')}${_esc(statusLabel[source.status] || _t('kb.discover.source_status_unknown', '状态未知'))}</span></header><h3>${_esc(source.title)}</h3><p>${_esc(source.desc)}</p><dl><div><dt>${_esc(_t('kb.discover.source_scope', '资料范围'))}</dt><dd>${_esc(source.scope)}</dd></div><div><dt>${_esc(_t('kb.discover.source_owner', '维护方'))}</dt><dd>${_esc(source.owner)}</dd></div></dl>${_renderFeishuSourceDocuments(source)}<footer><span>${_esc(_t('kb.discover.included_material_count', '{count} 份已纳入资料', { count: source.count }))}</span>${sourceAction(source)}</footer>${source.update ? `<small>${_icon('refresh', 'kb-discover-source-refresh')}${_esc(_t('kb.discover.updated_at', '更新于 {time}', { time: source.update }))}</small>` : ''}${source.error ? `<small>${_esc(source.error)}</small>` : ''}</article>`).join('')}</div>` : _emptyState({ icon: 'folder', message: _t('kb.discover.no_available_sources', '暂无可用资料来源') })}</section>`;
  }

  function _renderFeishuSourceDocuments(source) {
    if (source?.id !== 'feishu' || !Array.isArray(source.documents) || !source.documents.length) return '';
    return `<div class="kb-discover-source-documents"><strong>${_esc(_t('kb.discover.feishu_imported_documents', '已导入文档'))}</strong>${source.documents.slice(0, 4).map((document) => _button({ label: document.title || _fileName(document.path), icon: 'file-text', role: 'ghost', size: 'sm', className: 'kb-discover-source-document', attrs: { 'data-discover-path': document.path, title: document.title || _fileName(document.path) } })).join('')}</div>`;
  }

  function _feishuDocumentActionOptions(busy, operation) {
    const loading = operation === 'list-documents' || operation === 'import-documents';
    const label = operation === 'list-documents'
      ? _t('kb.discover.feishu_loading_documents', '正在读取文档…')
      : (operation === 'import-documents'
        ? _t('kb.discover.feishu_importing_documents', '正在导入文档…')
        : _t('kb.discover.select_documents', '选择文档'));
    return {
      label,
      role: 'secondary',
      size: 'sm',
      loading,
      disabled: busy,
      attrs: { 'data-discover-action': 'select-feishu-documents' },
    };
  }

  function _feishuSyncActionOptions(busy, operation) {
    const loading = operation === 'sync-documents';
    return {
      label: loading
        ? _t('kb.discover.feishu_syncing_documents', '正在同步…')
        : _t('kb.discover.feishu_sync_documents', '立即同步'),
      role: 'ghost',
      size: 'sm',
      icon: 'refresh',
      loading,
      disabled: busy,
      attrs: { 'data-discover-action': 'sync-feishu-documents' },
    };
  }

  function _feishuDisconnectModalOptions(documentCount) {
    return {
      title: _t('kb.discover.feishu_disconnect_title', '断开飞书连接？'),
      description: _t('kb.discover.feishu_disconnect_description', '将撤销飞书访问授权，但保留已经导入知识库的 {count} 篇文档。', { count: documentCount }),
      closeLabel: _t('common.close', '关闭'),
      actions: [
        { id: 'cancel', label: _t('common.cancel', '取消'), role: 'secondary' },
        { id: 'confirm', label: _t('kb.discover.feishu_confirm_disconnect', '确认断开'), role: 'danger' },
      ],
    };
  }

  function _feishuRemoveModalOptions(documentCount) {
    return {
      title: _t('kb.discover.feishu_remove_title', '移除飞书知识来源？'),
      description: _t('kb.discover.feishu_remove_description', '这会断开飞书授权，并从知识库删除通过该来源导入的 {count} 篇文档。此操作无法撤销。', { count: documentCount }),
      closeLabel: _t('common.close', '关闭'),
      actions: [
        { id: 'cancel', label: _t('common.cancel', '取消'), role: 'secondary' },
        { id: 'confirm', label: _t('kb.discover.feishu_confirm_remove', '确认移除'), role: 'danger' },
      ],
    };
  }

  function _feishuDocumentChoiceOptions(document) {
    const imported = document?.imported === true;
    const title = String(document?.title || '');
    return {
      label: imported ? `${title} · ${_t('kb.discover.feishu_already_imported_label', '已导入')}` : title,
      icon: imported ? 'check-circle' : 'file-text',
      role: 'ghost',
      className: 'kb-discover-feishu-document',
      disabled: imported,
      attrs: {
        'data-discover-feishu-document': String(document?.id || ''),
        'aria-pressed': 'false',
      },
    };
  }

  function _feishuImportSuccessModalOptions(items, count) {
    const documents = Array.isArray(items) ? items : [];
    const bodyHtml = `<div class="kb-discover-import-success-list">${documents.map((item) => `<div>${_icon('check-circle', 'kb-discover-import-success-icon')}<span>${_esc(item?.title || _fileName(item?.path || ''))}</span></div>`).join('')}</div>`;
    return {
      title: _t('kb.discover.feishu_import_success_title', '导入完成'),
      description: _t('kb.discover.feishu_import_success_description', '已成功导入 {count} 篇文档，正在建立知识库索引。', { count }),
      closeLabel: _t('common.close', '关闭'),
      bodyHtml,
      actions: [
        { id: 'stay', label: _t('kb.discover.feishu_import_success_stay', '留在发现'), role: 'secondary' },
        { id: 'open-library', label: _t('kb.discover.open_library', '前往知识库'), role: 'primary' },
      ],
    };
  }

  function _latestModalRoot() {
    const roots = document.querySelectorAll('[data-ui-modal-root]');
    return roots.length ? roots[roots.length - 1] : null;
  }

  async function _configureFeishu() {
    if (_state.feishuBusy || typeof window.uiModal !== 'function') return;
    const form = { appId: '', appSecret: '' };
    const bodyHtml = `<div class="kb-discover-feishu-config">${window.uiForm({
      ariaLabel: _t('kb.discover.feishu_form_label', '飞书 Wiki 应用配置'),
      fields: [
        { html: window.uiField({ id: 'kb-discover-feishu-app-id', label: _t('kb.discover.feishu_app_id', 'App ID'), required: true, control: { kind: 'input', attrs: { 'data-discover-feishu-app-id': 'true', autocomplete: 'off' } } }) },
        { html: window.uiField({ id: 'kb-discover-feishu-app-secret', label: _t('kb.discover.feishu_app_secret', 'App Secret'), required: true, control: { kind: 'input', type: 'password', attrs: { 'data-discover-feishu-app-secret': 'true', autocomplete: 'new-password' } } }) },
      ],
    })}</div>`;
    const modal = window.uiModal({
      title: _t('kb.discover.configure_feishu_title', '配置飞书 Wiki'),
      description: _t('kb.discover.configure_feishu_description', '应用凭据只保存在本机加密存储中。'),
      closeLabel: _t('common.close', '关闭'),
      bodyHtml,
      actions: [
        { id: 'cancel', label: _t('common.cancel', '取消'), role: 'secondary' },
        { id: 'save', label: _t('kb.discover.save_and_connect', '保存并连接'), role: 'primary' },
      ],
    });
    const root = _latestModalRoot();
    root?.querySelector('[data-discover-feishu-app-id]')?.addEventListener('input', (event) => { form.appId = event.currentTarget.value || ''; });
    root?.querySelector('[data-discover-feishu-app-secret]')?.addEventListener('input', (event) => { form.appSecret = event.currentTarget.value || ''; });
    const choice = await modal;
    if (choice?.value !== 'save') return;
    _state.feishuBusy = true;
    _renderAll();
    const saved = await _invoke('kb.discover.feishu.config.set', form);
    _state.feishuBusy = false;
    if (saved?.ok === false) { if (typeof uiToast === 'function') uiToast(saved.error || _t('kb.discover.feishu_config_failed', '飞书应用配置失败'), { variant: 'warning' }); _renderAll(); return; }
    await _beginFeishuAuthorize();
  }

  async function _beginFeishuAuthorize() {
    if (_state.feishuBusy) return;
    _state.feishuBusy = true;
    _renderAll();
    const result = await _invoke('kb.discover.feishu.authorize');
    _state.feishuBusy = false;
    if (result?.ok === false) { if (typeof uiToast === 'function') uiToast(result.error || _t('kb.discover.feishu_authorize_failed', '无法发起飞书授权'), { variant: 'warning' }); }
    else if (typeof uiToast === 'function') uiToast(_t('kb.discover.feishu_authorize_opened', '已在浏览器打开飞书授权页，完成后返回此处刷新。'), { variant: 'success', timeoutMs: 3500 });
    _renderAll();
  }

  async function _selectFeishuDocuments() {
    if (_state.feishuBusy || typeof window.uiModal !== 'function') return;
    _state.feishuBusy = true;
    _state.feishuOperation = 'list-documents';
    _renderAll();
    const result = await _invoke('kb.discover.feishu.documents.list');
    _state.feishuBusy = false;
    _state.feishuOperation = '';
    _renderAll();
    const documents = Array.isArray(result?.items) ? result.items : [];
    if (result?.ok === false || !documents.length) { if (typeof uiToast === 'function') uiToast(result?.error || _t('kb.discover.feishu_no_documents', '当前授权账号没有可读取的 Wiki 文档。'), { variant: 'warning' }); return; }
    const selected = new Set();
    const modal = window.uiModal({ title: _t('kb.discover.feishu_select_title', '选择要导入的飞书文档'), description: _t('kb.discover.feishu_select_description', '仅导入你在此处勾选的文档；导入后会建立知识库索引。'), closeLabel: _t('common.close', '关闭'), size: 'lg', bodyHtml: `<div class="kb-discover-feishu-document-list">${documents.map((document) => _button(_feishuDocumentChoiceOptions(document))).join('')}</div>`, actions: [{ id: 'cancel', label: _t('common.cancel', '取消'), role: 'secondary' }, { id: 'import', label: _t('kb.discover.confirm_import', '确认导入'), role: 'primary' }] });
    const root = _latestModalRoot();
    root?.querySelectorAll('[data-discover-feishu-document]').forEach((button) => button.addEventListener('click', () => {
      const documentId = button.dataset.discoverFeishuDocument;
      const isSelected = !selected.has(documentId);
      if (isSelected) selected.add(documentId); else selected.delete(documentId);
      button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      button.classList.toggle('ui-button--secondary', isSelected);
      button.classList.toggle('ui-button--ghost', !isSelected);
    }));
    const choice = await modal;
    if (choice?.value !== 'import') return;
    if (!selected.size) { if (typeof uiToast === 'function') uiToast(_t('kb.discover.feishu_select_required', '请至少选择一篇飞书文档。'), { variant: 'warning' }); return; }
    _state.feishuBusy = true;
    _state.feishuOperation = 'import-documents';
    _renderAll();
    const imported = await _invoke('kb.discover.feishu.documents.import', { documentIds: [...selected] });
    _state.feishuBusy = false;
    _state.feishuOperation = '';
    _renderAll();
    if (imported?.ok === false) { if (typeof uiToast === 'function') uiToast(imported.error || _t('kb.discover.feishu_import_failed', '飞书文档导入失败'), { variant: 'warning' }); return; }
    const importedCount = Math.max(0, Number(imported?.imported) || 0);
    const alreadyImportedCount = Math.max(0, Number(imported?.alreadyImported) || 0);
    const emptyCount = Math.max(0, Number(imported?.empty) || 0);
    if (importedCount === 0) {
      if (typeof uiToast === 'function') {
        const message = alreadyImportedCount > 0
          ? _t('kb.discover.feishu_already_imported', '所选文档已经导入，无需重复导入。')
          : _t('kb.discover.feishu_empty_documents', '文档正文为空或当前账号无法读取正文，未导入。');
        uiToast(message, { variant: emptyCount > 0 ? 'warning' : 'info' });
      }
      return;
    }
    const importedItems = Array.isArray(imported?.items) ? imported.items : [];
    _refreshKbWorkbenchAfterImport();
    void _loadAll(true);
    if (typeof window.uiModal === 'function') {
      const choice = await window.uiModal(_feishuImportSuccessModalOptions(importedItems, importedCount));
      if (choice?.value === 'open-library') document.querySelector('[data-kb-eco="kb"]')?.click();
    } else if (typeof uiToast === 'function') {
      uiToast(_t('kb.discover.feishu_imported', '已导入 {count} 篇飞书文档。', { count: importedCount }), { variant: 'success' });
    }
  }

  async function _syncFeishuDocuments() {
    if (_state.feishuBusy) return;
    _state.feishuBusy = true;
    _state.feishuOperation = 'sync-documents';
    _renderAll();
    const result = await _invoke('kb.discover.feishu.documents.sync');
    _state.feishuBusy = false;
    _state.feishuOperation = '';
    _renderAll();
    if (result?.ok === false) {
      if (typeof uiToast === 'function') uiToast(result.error || _t('kb.discover.feishu_sync_failed', '飞书文档同步失败'), { variant: 'warning' });
      return;
    }
    const updated = Math.max(0, Number(result?.updated) || 0);
    const recovered = Math.max(0, Number(result?.recovered) || 0);
    const unchanged = Math.max(0, Number(result?.unchanged) || 0);
    const unavailable = Math.max(0, Number(result?.unavailable) || 0);
    const empty = Math.max(0, Number(result?.empty) || 0);
    const failed = Math.max(0, Number(result?.failed) || 0);
    if (updated || recovered) _refreshKbWorkbenchAfterImport();
    void _loadAll(true);
    if (typeof uiToast === 'function') {
      uiToast(_t('kb.discover.feishu_sync_result', '同步完成：更新 {updated} 篇，恢复 {recovered} 篇，未变化 {unchanged} 篇；不可访问 {unavailable} 篇，空文档 {empty} 篇，失败 {failed} 篇。', {
        updated, recovered, unchanged, unavailable, empty, failed,
      }), { variant: failed || unavailable || empty ? 'warning' : 'success', timeoutMs: 5000 });
    }
  }

  async function _disconnectFeishu() {
    if (_state.feishuBusy || typeof window.uiModal !== 'function') return;
    const source = _catalog.sources.find((item) => item.id === 'feishu');
    const choice = await window.uiModal(_feishuDisconnectModalOptions(source?.count || 0));
    if (choice?.value !== 'confirm') return;
    _state.feishuBusy = true;
    _renderAll();
    const result = await _invoke('kb.discover.feishu.disconnect');
    _state.feishuBusy = false;
    _renderAll();
    if (result?.ok === false) {
      if (typeof uiToast === 'function') uiToast(result.error || _t('kb.discover.feishu_disconnect_failed', '断开飞书连接失败'), { variant: 'warning' });
      return;
    }
    void _loadAll(true);
    if (typeof uiToast === 'function') uiToast(_t('kb.discover.feishu_disconnected', '已断开飞书连接，导入的文档仍保留在知识库中。'), { variant: 'success' });
  }

  async function _removeFeishuSource() {
    if (_state.feishuBusy || typeof window.uiModal !== 'function') return;
    const source = _catalog.sources.find((item) => item.id === 'feishu');
    const choice = await window.uiModal(_feishuRemoveModalOptions(source?.count || 0));
    if (choice?.value !== 'confirm') return;
    _state.feishuBusy = true;
    _renderAll();
    const result = await _invoke('kb.discover.feishu.remove');
    _state.feishuBusy = false;
    _renderAll();
    if (result?.ok === false) {
      if (typeof uiToast === 'function') uiToast(result.error || _t('kb.discover.feishu_remove_failed', '飞书知识来源移除失败'), { variant: 'warning' });
      void _loadAll(true);
      return;
    }
    _refreshKbWorkbenchAfterImport();
    void _loadAll(true);
    if (typeof uiToast === 'function') uiToast(_t('kb.discover.feishu_removed', '飞书知识来源及其导入文档已移除。'), { variant: 'success' });
  }

  function _refreshKbWorkbenchAfterImport() {
    if (typeof window.renderKbWorkbench === 'function') window.renderKbWorkbench();
  }

  function _catalogItem(id) {
    return [..._catalog.featured, ..._catalog.public].find((item) => item.id === id)
      || _catalog.sources.find((item) => item.id === id);
  }

  function _openCatalogPreview(id) {
    const item = _catalogItem(id);
    if (!item) return;
    const details = item.scope ? `<dl><div><dt>${_esc(_t('kb.discover.sync_scope', '同步范围'))}</dt><dd>${_esc(item.scope)}</dd></div><div><dt>${_esc(_t('kb.discover.source_owner', '维护方'))}</dt><dd>${_esc(item.owner)}</dd></div></dl>` : `<dl><div><dt>${_esc(_t('kb.discover.material_source', '资料来源'))}</dt><dd>${_esc(item.curator || item.author)}</dd></div><div><dt>${_esc(_t('kb.discover.material_scale', '资料规模'))}</dt><dd>${_esc(_t('kb.discover.material_count', '{count} 份资料', { count: item.count }))}</dd></div></dl>${_catalogTags(item.tags)}`;
    const bodyHtml = `<div class="kb-discover-catalog-detail"><span>${_icon(item.icon, 'kb-discover-catalog-detail-icon')}</span><p>${_esc(item.desc)}</p>${details}<small>${_esc(_t('kb.discover.detail_source_note', '资料详情来自当前账号可见的正式知识包、发布记录或已授权来源。'))}</small></div>`;
    if (typeof window.uiModal === 'function') {
      window.uiModal({ title: item.title, closeLabel: _t('common.close', '关闭'), bodyHtml });
    } else if (typeof window.uiToast === 'function') {
      window.uiToast(item.title, { variant: 'success' });
    }
  }

  async function _toggleCatalogSave(id) {
    const item = _catalogItem(id);
    if (!item) return;
    const nextSaved = item.saved !== true;
    const result = await _invoke('kb.discover.subscription.set', { itemId: id, saved: nextSaved });
    if (result?.ok === false) {
      if (typeof window.uiToast === 'function') window.uiToast(result.error || _t('kb.discover.save_failed', '收藏操作失败'), { variant: 'warning' });
      return;
    }
    item.saved = nextSaved;
    if (typeof window.uiToast === 'function') window.uiToast(nextSaved ? _t('kb.discover.saved', '已收藏') : _t('kb.discover.unsaved', '已从收藏中移除'), { variant: 'success', timeoutMs: 1500 });
    _renderAll();
  }

  async function _importCatalogPackage(id) {
    const result = await _invoke('kb.discover.package.import', { packageId: id });
    if (result?.ok === false) {
      if (typeof window.uiToast === 'function') window.uiToast(result.error || _t('kb.discover.package_import_failed', '导入知识包失败'), { variant: 'warning' });
      return;
    }
    if (typeof window.uiToast === 'function') window.uiToast(_t('kb.discover.package_import_result', '知识包处理完成：新增 {imported} 份，更新 {updated} 份，未变化 {skipped} 份。', {
      imported: Number(result.imported) || 0,
      updated: Number(result.updated) || 0,
      skipped: Number(result.skipped) || 0,
    }), { variant: 'success', timeoutMs: 3000 });
    void _loadAll(true);
  }

  function _tabMeta() {
    if (_state.activeTab === 'public') {
      return {
        title: _t('kb.discover.tab_public', '公共广场'),
        subtitle: _t('kb.discover.public_subtitle', '远端知识目录与订阅能力待开发'),
        placeholder: '',
        searchable: false,
        content: _renderPublicPlaza(),
      };
    }
    if (_state.activeTab === 'sources') {
      return {
        title: _t('kb.discover.tab_external', '外部来源'),
        subtitle: _t('kb.discover.external_subtitle', '统一连接飞书、网页和团队资料来源'),
        searchable: false,
        content: _renderSourceHub(),
      };
    }
    return {
      title: _t('kb.discover.tab_featured', '精选专题'),
      subtitle: _t('kb.discover.featured_subtitle', '用精选知识专题，补齐团队工作需要的背景与方法'),
      searchable: false,
      content: _renderFeaturedEcosystem(),
    };
  }

  function _renderAll() {
    const host = document.getElementById('kb-discover');
    if (!host || !_state.rendered) return;
    const activeQuery = document.activeElement?.id === 'kb-discover-query';
    const selection = activeQuery ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
    const tab = _tabMeta();
    const tabs = [
      ['featured', 'sparkles', _t('kb.discover.tab_featured', '精选专题')],
      ['public', 'globe', _t('kb.discover.tab_public', '公共广场')],
      ['sources', 'folder', _t('kb.discover.tab_external', '外部来源')],
    ];
    const tabButtons = tabs.map(([key, icon, label]) => _button({
      label,
      role: _state.activeTab === key ? 'secondary' : 'ghost',
      size: 'sm',
      icon,
      className: 'kb-discover-tab',
      attrs: {
        id: `kb-discover-tab-${key}`,
        role: 'tab',
        'aria-selected': _state.activeTab === key ? 'true' : 'false',
        'aria-controls': 'kb-discover-active-panel',
        'data-kb-discover-tab': key,
      },
    })).join('');
    const pageHeader = window.uiPageHeader({
      title: tab.title,
      actions: [{
        label: _t('kb.discover.refresh', '刷新真实数据'),
        icon: 'refresh',
        loading: _state.loading,
        attrs: { 'data-discover-action': 'refresh' },
      }],
    });
    const searchField = tab.searchable ? `<div class="kb-discover-search-field">${window.uiField({
      id: 'kb-discover-query',
      label: _t('kb.discover.search_label', '搜索资料'),
      control: {
        kind: 'input',
        type: 'search',
        placeholder: tab.placeholder,
        value: _state.query,
        attrs: { autocomplete: 'off' },
      },
    })}</div>` : '';

    host.innerHTML = `
      <div class="kb-discover">
        ${pageHeader}
        <section class="kb-discover-pane">
          <p class="kb-discover-page-description">${_esc(tab.subtitle)}</p>
          <nav class="kb-discover-tabs" role="tablist" aria-label="${_esc(_t('kb.discover.tab_label', '知识库发现分类'))}">${tabButtons}</nav>
          ${searchField}
          <div id="kb-discover-active-panel" role="tabpanel" aria-labelledby="kb-discover-tab-${_esc(_state.activeTab)}">${tab.content}</div>
        </section>
      </div>`;

    host.querySelectorAll('[data-kb-discover-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        const tabKey = button.dataset.kbDiscoverTab;
        if (!tabKey || tabKey === _state.activeTab) return;
        _state.activeTab = tabKey;
        _state.query = '';
        _renderAll();
      });
    });
    host.querySelector('#kb-discover-query')?.addEventListener('input', (event) => {
      _state.query = event.currentTarget.value || '';
      _renderAll();
    });
    host.querySelectorAll('[data-discover-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.discoverAction;
        if (action === 'refresh') void _loadAll(true);
        if (action === 'clear-query') { _state.query = ''; _renderAll(); }
        if (action === 'open-workbench') document.querySelector('[data-kb-eco="kb"]')?.click();
        if (action === 'open-connectors') document.getElementById('connectors-btn')?.click();
        if (action === 'configure-feishu') void _configureFeishu();
        if (action === 'authorize-feishu') void _beginFeishuAuthorize();
        if (action === 'select-feishu-documents') void _selectFeishuDocuments();
        if (action === 'sync-feishu-documents') void _syncFeishuDocuments();
        if (action === 'disconnect-feishu') void _disconnectFeishu();
        if (action === 'remove-feishu') void _removeFeishuSource();
      });
    });
    host.querySelectorAll('[data-discover-public-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        _state.publicFilter = button.dataset.discoverPublicFilter || 'all';
        _renderAll();
      });
    });
    host.querySelectorAll('[data-discover-path]').forEach((button) => {
      button.addEventListener('click', () => _openSource(button.dataset.discoverPath));
    });
    host.querySelectorAll('[data-discover-catalog-preview], [data-discover-source-preview]').forEach((button) => {
      button.addEventListener('click', () => _openCatalogPreview(button.dataset.discoverCatalogPreview || button.dataset.discoverSourcePreview));
    });
    host.querySelectorAll('[data-discover-catalog-save]').forEach((button) => {
      button.addEventListener('click', () => void _toggleCatalogSave(button.dataset.discoverCatalogSave));
    });
    host.querySelectorAll('[data-discover-catalog-import]').forEach((button) => {
      button.addEventListener('click', () => void _importCatalogPackage(button.dataset.discoverCatalogImport));
    });
    host.querySelectorAll('[data-discover-copy-url]').forEach((button) => {
      button.addEventListener('click', () => void _copyShareLink(button.dataset.discoverCopyUrl));
    });
    if (activeQuery) {
      const input = host.querySelector('#kb-discover-query');
      if (input) {
        input.focus();
        if (selection) input.setSelectionRange(selection.start, selection.end);
      }
    }
  }

  function _openSource(path) {
    if (typeof window.__openAnchorViewer === 'function') {
      window.__openAnchorViewer({ source: 'library', scope: 'global', path, chunkIdx: 1, view: 'document' });
      return;
    }
    if (typeof uiToast === 'function') uiToast(_t('kb.discover.viewer_unavailable', '原文查看器尚未就绪'), { variant: 'warning' });
  }

  async function _copyShareLink(url) {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      if (typeof uiToast === 'function') uiToast(_t('kb.discover.link_copied', '链接已复制'), { variant: 'success', timeoutMs: 1500 });
    } catch (_) {
      if (typeof uiToast === 'function') uiToast(_t('kb.discover.copy_failed', '复制链接失败'), { variant: 'warning' });
    }
  }

  function _loadAll(force) {
    if (_loadPromise && !force) return _loadPromise;
    const seq = ++_loadSeq;
    _state.loading = true;
    _state.error = '';
    _state.sharedError = '';
    _renderAll();
    _loadPromise = (async () => {
      if (force) await _invoke('kb.reconcile');
      const [discoverResult, treeResult, statusResult] = await Promise.all([
        _invoke('kb.discover.list'),
        _invoke('contexts.tree'),
        _invoke('kb.status'),
      ]);
      if (seq !== _loadSeq) return;
      _catalog.featured = Array.isArray(discoverResult?.featured) ? discoverResult.featured.map(_normalizeCatalogItem) : [];
      _catalog.public = Array.isArray(discoverResult?.public) ? discoverResult.public.map(_normalizeCatalogItem) : [];
      _catalog.sources = Array.isArray(discoverResult?.sources) ? discoverResult.sources.map(_normalizeSourceItem) : [];
      const tree = Array.isArray(treeResult?.tree) ? treeResult.tree : [];
      const statusFiles = Array.isArray(statusResult?.files) ? statusResult.files : [];
      _state.files = _normalizeFiles(statusFiles, tree);
      _state.summary = statusResult?.summary && typeof statusResult.summary === 'object'
        ? { ..._state.summary, ...statusResult.summary }
        : { total: 0, ready: 0, processing: 0, pending: 0, failed: 0 };
      _state.error = discoverResult?.ok === false
        ? String(discoverResult.error || _t('kb.discover.load_failed', '加载失败'))
        : (treeResult?.ok === false
        ? String(treeResult.error || _t('kb.discover.tree_failed', '读取资料目录失败'))
        : (statusResult?.ok === false ? String(statusResult.error || _t('kb.discover.status_failed_load', '读取索引状态失败')) : ''));
      _state.sharedError = '';
      _state.loading = false;
      _renderAll();
    })().finally(() => {
      if (seq === _loadSeq) _loadPromise = null;
    });
    return _loadPromise;
  }

  function renderKbDiscover() {
    const host = document.getElementById('kb-discover');
    if (!host) return;
    _state.rendered = true;
    _renderAll();
    void _loadAll(false);
  }

  window.addEventListener('i18n-change', () => { if (_state.rendered) _renderAll(); });
  window.renderKbDiscover = renderKbDiscover;
  if (typeof module !== 'undefined' && module.exports) module.exports = { _feishuDisconnectModalOptions, _feishuDocumentActionOptions, _feishuDocumentChoiceOptions, _feishuImportSuccessModalOptions, _feishuRemoveModalOptions, _feishuSyncActionOptions, _normalizeSourceItem, _publicPlazaPendingStateOptions, _refreshKbWorkbenchAfterImport, _renderFeishuSourceDocuments };
})();
