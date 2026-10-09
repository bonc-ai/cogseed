// Shared Library transfer dialog.
//
// One "Move or copy to…" entry point serves single-row and batch operations
// across global/project Libraries. Move/Copy is chosen inside this dialog so
// row menus stay compact. Main owns path validation and copy/move semantics.
(function initLibraryTransfer(root) {
  function _libraryValue(ref) {
    // 空间化后仅全局资料库（contexts）可迁移；项目库已删。
    return 'global';
  }

  function _parseLibraryValue(value) {
    return { scope: 'global' };
  }

  function _folderRows(nodes, depth = 0, out = []) {
    for (const node of nodes || []) {
      if (!node || node.type !== 'dir') continue;
      const rel = String(node.relPath || node.path || '');
      if (!rel) continue;
      out.push({ path: rel, name: String(node.name || rel.split('/').pop() || rel), depth });
      _folderRows(node.children || [], depth + 1, out);
    }
    return out;
  }

  function _icon(name, cls) {
    return root && typeof root.uiIconHtml === 'function' ? root.uiIconHtml(name, cls) : '';
  }

  function _errorKey(code) {
    return {
      target_exists: 'contexts.transfer.error_target_exists',
      unsupported_destination: 'contexts.transfer.error_unsupported',
      invalid_target: 'contexts.transfer.error_invalid_target',
      not_found: 'contexts.transfer.error_not_found',
      source_delete_failed: 'contexts.transfer.error_source_delete',
      rollback_failed: 'contexts.transfer.error_rollback',
    }[String(code || '')] || 'contexts.transfer.error_generic';
  }

  function _errorLabel(code) {
    return t(_errorKey(code));
  }

  async function _loadFolderTree(ref) {
    // 空间化后仅全局资料库（contexts）可迁移；项目文件树已删。
    const res = await apiFetch('/api/contexts/tree');
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error || 'load_failed');
    return data.tree || [];
  }

  function _track(name, payload, kind = 'event') {
    void name;
    void payload;
    void kind;
  }

  async function openLibraryTransfer(opts) {
    const source = opts?.source;
    const paths = Array.from(new Set((opts?.paths || []).map((item) => String(item || '')).filter(Boolean)));
    if (!source || !paths.length) return null;
    document.getElementById('library-transfer-overlay')?.remove();

    const libraryOptions = () => [
      { value: 'global', label: t('contexts.transfer.global_library'), iconName: 'folder' },
    ];
    const initialLibrary = _libraryValue(source);
    const overlay = document.createElement('div');
    overlay.id = 'library-transfer-overlay';
    overlay.className = 'modal-overlay library-transfer-overlay';
    overlay.innerHTML = `
      <div class="modal modal-standard library-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="library-transfer-title">
        <div class="modal-header library-transfer-header">
          <div>
            <div class="modal-title library-transfer-title" id="library-transfer-title">${escapeHtml(t('contexts.transfer.title'))}</div>
            <div class="library-transfer-summary">${escapeHtml(t('contexts.transfer.selected_count', { count: paths.length }))}</div>
          </div>
          <button type="button" class="modal-close-btn project-library-modal-close" data-transfer-close title="${escapeHtml(t('common.close'))}" aria-label="${escapeHtml(t('common.close'))}">
            ${_icon('x', 'modal-close-icon')}
          </button>
        </div>
        <div class="modal-body library-transfer-body">
          <div class="library-transfer-label" id="library-transfer-mode-label" data-transfer-label="action">${escapeHtml(t('contexts.transfer.action'))}</div>
          <div class="library-transfer-mode" role="radiogroup" aria-labelledby="library-transfer-mode-label">
            <label class="library-transfer-mode-option">
              <input class="library-transfer-mode-input" type="radio" name="library-transfer-mode" value="move" data-transfer-mode="move" checked>
              <span data-transfer-mode-label="move">${escapeHtml(t('contexts.transfer.move'))}</span>
            </label>
            <label class="library-transfer-mode-option">
              <input class="library-transfer-mode-input" type="radio" name="library-transfer-mode" value="copy" data-transfer-mode="copy">
              <span data-transfer-mode-label="copy">${escapeHtml(t('contexts.transfer.copy'))}</span>
            </label>
          </div>
          <label class="library-transfer-label" data-transfer-label="library">${escapeHtml(t('contexts.transfer.destination_library'))}</label>
          <div class="ai-select library-transfer-library-select" data-transfer-library></div>
          <label class="library-transfer-label" data-transfer-label="folder">${escapeHtml(t('contexts.transfer.destination_folder'))}</label>
          <div class="library-transfer-folders" data-transfer-folders></div>
          <div class="library-transfer-error" data-transfer-error hidden></div>
        </div>
        <div class="modal-actions library-transfer-footer">
          <button type="button" class="btn" data-transfer-cancel>${escapeHtml(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-transfer-confirm>${escapeHtml(t('contexts.transfer.move'))}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const dialog = overlay.querySelector('[role="dialog"]');

    let mode = 'move';
    let targetDir = '';
    let currentRef = _parseLibraryValue(initialLibrary) || { scope: 'global' };
    let loadingFolders = false;
    let folderTree = [];
    let currentErrorKey = '';
    let onI18nChange = null;
    const folderEl = overlay.querySelector('[data-transfer-folders]');
    const errorEl = overlay.querySelector('[data-transfer-error]');
    const confirmBtn = overlay.querySelector('[data-transfer-confirm]');

    // 四项行为（ESC / 背景滚动锁定 / 焦点陷阱 / 焦点回归）统一走 uiModalController。
    const cleanup = () => {
      if (onI18nChange) window.removeEventListener('i18n-change', onI18nChange);
      selector?.close?.();
      overlay.remove();
    };
    const controller = typeof uiModalController === 'function'
      ? uiModalController({ overlay, dialog, onClose: cleanup })
      : null;
    const close = () => {
      if (controller) controller.close('action');
      else cleanup();
    };
    const showError = (message, key = '') => {
      currentErrorKey = message ? key : '';
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    };
    const renderFolders = (tree, preserveTarget = false) => {
      const rows = _folderRows(tree);
      const selectedDir = preserveTarget && rows.some((row) => row.path === targetDir) ? targetDir : '';
      folderEl.innerHTML = `
        <button type="button" class="library-transfer-folder${selectedDir ? '' : ' active'}" data-folder-path="" style="padding-left:10px">
          ${_icon('folder-open', 'library-transfer-folder-icon')}
          <span>${escapeHtml(t('contexts.root_label'))}</span>
        </button>
        ${rows.map((row) => `
          <button type="button" class="library-transfer-folder${row.path === selectedDir ? ' active' : ''}" data-folder-path="${escapeHtml(row.path)}" style="padding-left:${32 + row.depth * 18}px">
            ${_icon('folder', 'library-transfer-folder-icon')}
            <span>${escapeHtml(row.name)}</span>
          </button>
        `).join('')}
      `;
      targetDir = selectedDir;
      folderEl.querySelectorAll('[data-folder-path]').forEach((row) => {
        row.addEventListener('click', () => {
          targetDir = row.dataset.folderPath || '';
          folderEl.querySelectorAll('.active').forEach((node) => node.classList.remove('active'));
          row.classList.add('active');
          showError('');
        });
      });
    };
    const refreshFolders = async (value) => {
      const ref = _parseLibraryValue(value);
      if (!ref) return;
      currentRef = ref;
      loadingFolders = true;
      confirmBtn.disabled = true;
      folderEl.innerHTML = `<div class="library-transfer-loading">${escapeHtml(t('common.loading'))}</div>`;
      showError('');
      try {
        folderTree = await _loadFolderTree(ref);
        renderFolders(folderTree);
      }
      catch (_) {
        folderTree = [];
        folderEl.innerHTML = '';
        showError(t('contexts.transfer.load_failed'), 'contexts.transfer.load_failed');
      } finally {
        loadingFolders = false;
        confirmBtn.disabled = false;
      }
    };

    const selector = _aiSelectMount(overlay.querySelector('[data-transfer-library]'), {
      options: libraryOptions(),
      value: initialLibrary,
      onChange: (value) => refreshFolders(value),
    });
    selector?.setValue(initialLibrary);
    onI18nChange = () => {
      overlay.querySelector('.library-transfer-title').textContent = t('contexts.transfer.title');
      overlay.querySelector('.library-transfer-summary').textContent = t('contexts.transfer.selected_count', { count: paths.length });
      overlay.querySelector('[data-transfer-label="action"]').textContent = t('contexts.transfer.action');
      overlay.querySelector('[data-transfer-label="library"]').textContent = t('contexts.transfer.destination_library');
      overlay.querySelector('[data-transfer-label="folder"]').textContent = t('contexts.transfer.destination_folder');
      overlay.querySelector('[data-transfer-mode-label="move"]').textContent = t('contexts.transfer.move');
      overlay.querySelector('[data-transfer-mode-label="copy"]').textContent = t('contexts.transfer.copy');
      overlay.querySelector('[data-transfer-cancel]').textContent = t('common.cancel');
      confirmBtn.textContent = t(mode === 'copy' ? 'contexts.transfer.copy' : 'contexts.transfer.move');
      const closeBtn = overlay.querySelector('[data-transfer-close]');
      closeBtn.title = t('common.close');
      closeBtn.setAttribute('aria-label', t('common.close'));
      selector?.setOptions(libraryOptions(), { value: selector.getValue() });
      if (loadingFolders) folderEl.innerHTML = `<div class="library-transfer-loading">${escapeHtml(t('common.loading'))}</div>`;
      else if (folderTree.length || !currentErrorKey) renderFolders(folderTree, true);
      if (currentErrorKey) showError(t(currentErrorKey), currentErrorKey);
    };
    window.addEventListener('i18n-change', onI18nChange);
    overlay.querySelectorAll('[data-transfer-mode]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        mode = input.dataset.transferMode === 'copy' ? 'copy' : 'move';
        confirmBtn.textContent = t(mode === 'copy' ? 'contexts.transfer.copy' : 'contexts.transfer.move');
        showError('');
      });
    });
    overlay.querySelector('[data-transfer-close]')?.addEventListener('click', close);
    overlay.querySelector('[data-transfer-cancel]')?.addEventListener('click', close);
    confirmBtn.addEventListener('click', async () => {
      if (loadingFolders || confirmBtn.disabled) return;
      const startedAt = performance.now();
      confirmBtn.disabled = true;
      showError('');
      _track('library_transfer_submit', {
        mode,
        source_scope: source.scope,
        destination_scope: currentRef.scope,
        entry_count: paths.length,
      }, 'click');
      try {
        const result = await root.cogseed.invoke('library.transfer', {
          mode,
          source,
          paths,
          destination: { ...currentRef, dir: targetDir },
        });
        if (!result?.ok) throw new Error(result?.error || 'transfer_failed');
        _track('library_transfer_result', {
          result: Number(result.failed || 0) === 0
            ? 'success'
            : (Number(result.succeeded || 0) > 0 ? 'partial' : 'failure'),
          mode,
          source_scope: source.scope,
          destination_scope: currentRef.scope,
          entry_count: paths.length,
          succeeded_count: Number(result.succeeded || 0),
          failed_count: Number(result.failed || 0),
          duration_ms: Math.round(performance.now() - startedAt),
        });
        if (Number(result.succeeded || 0) === 0) {
          const firstError = result.results?.find((row) => !row.ok)?.error;
          showError(_errorLabel(firstError), _errorKey(firstError));
          confirmBtn.disabled = false;
          return;
        }
        close();
        if (typeof opts?.onComplete === 'function') {
          await opts.onComplete({ ...result, mode, source, destination: { ...currentRef, dir: targetDir } });
        }
        const key = result.failed
          ? 'contexts.transfer.partial_result'
          : (mode === 'copy' ? 'contexts.transfer.copy_success' : 'contexts.transfer.move_success');
        if (typeof uiToast === 'function') {
          uiToast(t(key, {
            count: Number(result.succeeded || 0),
            failed: Number(result.failed || 0),
          }), { variant: result.failed ? 'warning' : 'success', timeoutMs: result.failed ? 6000 : 3200 });
        }
      } catch (err) {
        _track('library_transfer', {
          mode,
          source_scope: source.scope,
          destination_scope: currentRef.scope,
          error_type: 'exception',
          error_message: String(err?.message || 'transfer_failed').slice(0, 120),
        }, 'error');
        showError(t('contexts.transfer.error_generic'), 'contexts.transfer.error_generic');
        confirmBtn.disabled = false;
      }
    });

    _track('library_transfer_open', {
      source_scope: source.scope,
      entry_count: paths.length,
      entry_point: opts?.entryPoint || 'menu',
    }, 'click');
    if (controller) controller.open();
    await refreshFolders(initialLibrary);
    return { close };
  }

  const api = Object.freeze({ open: openLibraryTransfer });
  root.LibraryTransfer = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _libraryValue, _parseLibraryValue, _folderRows };
  }
})(typeof window !== 'undefined' ? window : globalThis);
