// Task-level Recall projection card. Edits only the current projection draft;
// it never mutates or deletes formal ability assets.
(function () {
  function _escape(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _label(key, fallback, vars) {
    try {
      if (typeof t === 'function') {
        const value = t(key, vars || undefined);
        if (value && value !== key) return value;
      }
    } catch (_) {}
    let out = String(fallback || '');
    if (vars) out = out.replace(/\{(\w+)\}/g, (match, name) => vars[name] != null ? String(vars[name]) : match);
    return out;
  }

  function _statusLabel(status) {
    if (status === 'confirmed') return _label('recall.projection.status.confirmed', 'Confirmed');
    if (status === 'preview') return _label('recall.projection.status.preview', 'Preview');
    if (status === 'deferred') return _label('recall.projection.status.deferred', 'Deferred');
    if (status === 'rejected') return _label('recall.projection.status.rejected', 'Rejected');
    if (status === 'expired') return _label('recall.projection.status.expired', 'Expired');
    return String(status || '');
  }

  function _assetRow(asset, editable) {
    const id = String(asset?.assetId || asset?.id || '');
    const title = String(asset?.title || id);
    const meta = [asset?.type, asset?.scope, asset?.version].filter(Boolean).join(' · ');
    return `<div class="chat-recall-projection-asset" data-recall-projection-asset="${_escape(id)}"><div><strong>${_escape(title)}</strong>${meta ? `<small>${_escape(meta)}</small>` : ''}</div>${editable ? `<button type="button" class="btn btn-sm" data-recall-projection-remove="${_escape(id)}">${_escape(_label('recall.projection.remove_task_asset', 'Remove from this task'))}</button>` : ''}</div>`;
  }

  function _availableRow(asset) {
    const id = String(asset?.id || asset?.assetId || '');
    const title = String(asset?.title || id);
    const meta = [asset?.type, asset?.scope, asset?.version].filter(Boolean).join(' · ');
    return `<div class="chat-recall-projection-available"><div><strong>${_escape(title)}</strong>${meta ? `<small>${_escape(meta)}</small>` : ''}</div><button type="button" class="btn btn-sm" data-recall-projection-add="${_escape(id)}">${_escape(_label('recall.projection.add_task_asset', 'Add to preloaded assets'))}</button></div>`;
  }

  function _render(host, card, available, opts) {
    const editable = card?.status === 'preview';
    const assets = Array.isArray(card?.assetSummaries) ? card.assetSummaries : [];
    const omitted = Array.isArray(card?.omittedAssetRefs) ? card.omittedAssetRefs : [];
    const availableRows = editable && Array.isArray(available) && available.length
      ? `<div class="chat-recall-projection-available-list">${available.map(_availableRow).join('')}</div>`
      : editable
        ? `<div class="chat-recall-projection-empty">${_escape(_label('recall.projection.no_available_assets', 'No more eligible preloaded assets to add.'))}</div>`
        : '';
    host.className = 'chat-recall-projection-card';
    host.dataset.projectionId = String(card?.projectionId || opts?.projectionId || '');
    const actions = editable
      ? `<div class="chat-recall-projection-actions"><button type="button" class="btn btn-primary btn-sm" data-recall-projection-confirm="1">${_escape(_label('recall.projection.confirm_assets', 'Confirm preloaded assets'))}</button></div>`
      : '';
    host.innerHTML = `<div class="chat-recall-projection-head"><div><strong>${_escape(_label('recall.projection.title', 'Preloaded asset list'))}</strong><small>${_escape(card?.purpose || '')}</small></div><span class="chat-recall-projection-status">${_escape(_statusLabel(card?.status))}</span></div>
      <div class="chat-recall-projection-summary">${_escape(card?.summary?.text || _label('recall.projection.summary', '{count} preloaded assets selected for this task.', { count: assets.length }))}</div>
      <div class="chat-recall-projection-section"><div class="chat-recall-projection-section-title">${_escape(_label('recall.projection.included_assets', 'Preloaded assets for this task'))}</div>${assets.length ? assets.map((asset) => _assetRow(asset, editable)).join('') : `<div class="chat-recall-projection-empty">${_escape(_label('recall.projection.no_included_assets', 'No preloaded ability assets selected for this task.'))}</div>`}</div>
      ${editable ? `<div class="chat-recall-projection-section"><div class="chat-recall-projection-section-title">${_escape(_label('recall.projection.add_assets', 'Add preloaded asset'))}</div>${availableRows}</div>` : `<div class="chat-recall-projection-locked">${_escape(_label('recall.projection.locked', 'This preloaded asset list is locked.'))}</div>`}
      ${actions}
      ${omitted.length ? `<div class="chat-recall-projection-omitted">${_escape(_label('recall.projection.omitted_count', '{count} omitted candidates', { count: omitted.length }))}</div>` : ''}`;
  }

  async function _loadCard(projectionId) {
    const result = await window.orkas.invoke('recall.projections.card', { projectionId });
    if (!result?.ok || !result.card) throw new Error(result?.error || 'projection card unavailable');
    return result.card;
  }

  async function _loadAvailable(projectionId, editable) {
    if (!editable) return [];
    const result = await window.orkas.invoke('recall.projections.availableAssets', { projectionId });
    if (!result?.ok) return [];
    return Array.isArray(result.assets) ? result.assets : [];
  }

  async function mountRecallProjectionCard(host, messageCard, opts = {}) {
    if (!host || !messageCard?.projectionId) return;
    const projectionId = String(messageCard.projectionId);
    async function refresh() {
      host.dataset.loading = '1';
      try {
        const card = await _loadCard(projectionId);
        const available = await _loadAvailable(projectionId, card.status === 'preview');
        _render(host, card, available, { ...opts, projectionId });
      } catch (error) {
        host.className = 'chat-recall-projection-card is-error';
        host.innerHTML = _escape((error && error.message) || String(error));
      } finally {
        host.dataset.loading = '0';
      }
    }
    if (!host.dataset.recallProjectionBound) {
      host.dataset.recallProjectionBound = '1';
      host.addEventListener('click', async (event) => {
        const confirm = event.target.closest('[data-recall-projection-confirm]');
        const remove = !confirm ? event.target.closest('[data-recall-projection-remove]') : null;
        const add = !confirm && !remove ? event.target.closest('[data-recall-projection-add]') : null;
        const button = confirm || remove || add;
        if (!button || button.disabled || host.dataset.loading === '1') return;
        const assetId = remove ? remove.dataset.recallProjectionRemove : add?.dataset.recallProjectionAdd;
        if (!confirm && !assetId) return;
        button.disabled = true;
        try {
          const result = confirm
            ? await window.orkas.invoke('recall.projections.confirm', { projectionId })
            : await window.orkas.invoke('recall.projections.revise', remove
              ? { projectionId, removeAssetIds: [assetId] }
              : { projectionId, addAssetIds: [assetId] });
          if (!result?.ok) throw new Error(result?.error || (confirm ? 'projection confirmation failed' : 'projection revision failed'));
          await refresh();
        } catch (error) {
          if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
        } finally {
          button.disabled = false;
        }
      });
    }
    await refresh();
  }

  window.mountRecallProjectionCard = mountRecallProjectionCard;
})();
