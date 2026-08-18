// Task-level Recall projection card. Edits only the current projection draft;
// it never mutates or deletes formal ability assets.
//
// 这张卡渲染的是**正式 Ability Asset**（context-projection 全程只有 assetId /
// maturity），不是候选池对象。文案一律用「资产」：叫成「候选」会把 Candidate
// 生命周期和 Asset 成熟度两层重新混掉，用户会以为这些东西还等着确认。
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


  function _assetStatusLabel(status) {
    if (status === 'active') return _label('recall.asset.status.active', 'Active');
    if (status === 'paused') return _label('recall.asset.status.paused', 'Paused');
    if (status === 'revoked') return _label('recall.asset.status.revoked', 'Revoked');
    return String(status || '');
  }

  function _assetRecommendationLabel(action) {
    if (action === 'pause') return _label('recall.asset.recommend.pause', 'Pause recommended');
    if (action === 'rework') return _label('recall.asset.recommend.rework', 'Rework recommended');
    return String(action || '');
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
    // 资产 id 是定位键，不是名字：解析不出标题时给语义占位。
    const title = String(asset?.title || '').trim() || _label('recall.projection.asset_untitled', 'Untitled asset');
    // 已确认投影注入的是确认时那一版，所以这里显示确认版本而不是 live 版本，
    // 否则用户会以为运行中用的是他刚改出来的新版。
    const shownVersion = asset?.confirmedVersion || asset?.version;
    const meta = [asset?.type, asset?.scope, shownVersion ? `v${shownVersion}` : ''].filter(Boolean).join(' · ');
    const governance = [asset?.status && asset.status !== 'active' ? _assetStatusLabel(asset.status) : '', asset?.recommendedAction ? _assetRecommendationLabel(asset.recommendedAction) : ''].filter(Boolean).join(' · ');
    const reason = asset?.recommendationReason ? `<em>${_escape(asset.recommendationReason)}</em>` : '';
    // 版本钉住是有意的（不在用户背后换掉他确认过的内容），所以这里只告知，
    // 不提供"就地升到新版"——已确认投影不可再改，新版本要靠下次重新选择。
    const stale = asset?.stale
      ? `<small class="chat-recall-projection-stale">${_escape(_label(
          'recall.projection.asset_stale',
          'Still running the confirmed v{confirmed}; the asset is now v{current}. It takes effect after you select it again.',
          { confirmed: asset?.confirmedVersion || '', current: asset?.version || '' },
        ))}</small>`
      : '';
    return `<div class="chat-recall-projection-asset${asset?.stale ? ' is-stale' : ''}" data-recall-projection-asset="${_escape(id)}"><div><strong>${_escape(title)}</strong>${meta ? `<small>${_escape(meta)}</small>` : ''}${governance ? `<small class="chat-recall-projection-governance">${_escape(governance)}</small>` : ''}${stale}${reason}</div>${editable ? `<button type="button" class="btn btn-sm" data-recall-projection-remove="${_escape(id)}">${_escape(_label('recall.projection.remove_task_asset', 'Remove asset'))}</button>` : ''}</div>`;
  }

  function _availableRow(asset) {
    const id = String(asset?.id || asset?.assetId || '');
    const title = String(asset?.title || id);
    const meta = [asset?.type, asset?.scope, asset?.version].filter(Boolean).join(' · ');
    return `<div class="chat-recall-projection-available"><div><strong>${_escape(title)}</strong>${meta ? `<small>${_escape(meta)}</small>` : ''}</div><button type="button" class="btn btn-sm" data-recall-projection-add="${_escape(id)}">${_escape(_label('recall.projection.add_task_asset', 'Add asset'))}</button></div>`;
  }

  function _render(host, card, available, opts, forecastFailure) {
    const editable = card?.status === 'preview';
    const assets = Array.isArray(card?.assetSummaries) ? card.assetSummaries : [];
    const omitted = Array.isArray(card?.omittedAssetRefs) ? card.omittedAssetRefs : [];
    const availableRows = editable && Array.isArray(available) && available.length
      ? `<div class="chat-recall-projection-available-list">${available.map(_availableRow).join('')}</div>`
      : editable
        ? `<div class="chat-recall-projection-empty">${_escape(_label('recall.projection.no_available_assets', 'No more assets to add.'))}</div>`
        : '';
    host.className = 'chat-recall-projection-card';
    host.dataset.projectionId = String(card?.projectionId || opts?.projectionId || '');
    const actions = forecastFailure
      ? `<div class="chat-recall-projection-forecast-failure" role="alert"><strong>${_escape(_label('recall.projection.forecast_failed', 'Forecast failed; task has not started.'))}</strong><small>${_escape(forecastFailure.message || '')}</small><button type="button" class="btn btn-sm" data-recall-projection-retry="1">${_escape(_label('recall.projection.retry_forecast', 'Retry forecast'))}</button></div>`
      : editable
        ? `<div class="chat-recall-projection-actions"><button type="button" class="btn btn-primary btn-sm" data-recall-projection-confirm="1">${_escape(_label('recall.projection.confirm_assets', 'Confirm assets'))}</button></div>`
        : '';
    host.innerHTML = `<div class="chat-recall-projection-head"><div><strong>${_escape(_label('recall.projection.title', 'Preloaded assets'))}</strong><small>${_escape(card?.purpose || '')}</small></div><span class="chat-recall-projection-status">${_escape(_statusLabel(card?.status))}</span></div>
      <div class="chat-recall-projection-summary">${_escape(_label('recall.projection.summary', '{count} preloaded assets.', { count: assets.length }))}</div>
      <div class="chat-recall-projection-section"><div class="chat-recall-projection-section-title">${_escape(_label('recall.projection.included_assets', 'Preloaded assets'))}</div>${assets.length ? assets.map((asset) => _assetRow(asset, editable)).join('') : `<div class="chat-recall-projection-empty">${_escape(_label('recall.projection.no_included_assets', 'No preloaded assets selected.'))}</div>`}</div>
      ${editable ? `<div class="chat-recall-projection-section"><div class="chat-recall-projection-section-title">${_escape(_label('recall.projection.add_assets', 'Add asset'))}</div>${availableRows}</div>` : `<div class="chat-recall-projection-locked">${_escape(_label('recall.projection.locked', 'These preloaded assets are locked.'))}</div>`}
      ${actions}
      ${omitted.length ? `<div class="chat-recall-projection-omitted">${_escape(_label('recall.projection.omitted_count', '{count} assets hidden', { count: omitted.length }))}</div>` : ''}`;
  }

  async function _loadCard(projectionId) {
    const result = await window.cogseed.invoke('recall.projections.card', { projectionId });
    if (!result?.ok || !result.card) throw new Error(result?.error || 'projection card unavailable');
    return result.card;
  }

  async function _loadAvailable(projectionId, editable) {
    if (!editable) return [];
    const result = await window.cogseed.invoke('recall.projections.availableAssets', { projectionId });
    if (!result?.ok) return [];
    return Array.isArray(result.assets) ? result.assets : [];
  }

  async function mountRecallProjectionCard(host, messageCard, opts = {}) {
    if (!host || !messageCard?.projectionId) return;
    const projectionId = String(messageCard.projectionId);
    const cid = String(opts.cid || '');
    let forecastFailure = null;
    async function refresh() {
      host.dataset.loading = '1';
      try {
        const card = await _loadCard(projectionId);
        const available = await _loadAvailable(projectionId, card.status === 'preview');
        _render(host, card, available, { ...opts, projectionId }, forecastFailure);
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
        const retry = !confirm ? event.target.closest('[data-recall-projection-retry]') : null;
        const remove = !confirm && !retry ? event.target.closest('[data-recall-projection-remove]') : null;
        const add = !confirm && !retry && !remove ? event.target.closest('[data-recall-projection-add]') : null;
        const button = confirm || retry || remove || add;
        if (!button || button.disabled || host.dataset.loading === '1') return;
        const assetId = remove ? remove.dataset.recallProjectionRemove : add?.dataset.recallProjectionAdd;
        if (!confirm && !retry && !assetId) return;
        button.disabled = true;
        try {
          const result = confirm
            ? await window.cogseed.invoke('recall.projections.confirm', { projectionId, ...(cid ? { cid } : {}) })
            : retry
              ? await window.cogseed.invoke('recall.projections.retryForecast', { projectionId, ...(cid ? { cid } : {}) })
              : await window.cogseed.invoke('recall.projections.revise', remove
                ? { projectionId, removeAssetIds: [assetId] }
                : { projectionId, addAssetIds: [assetId] });
          if (!result?.ok) throw Object.assign(new Error(result?.error || (confirm ? 'projection confirmation failed' : retry ? 'forecast retry failed' : 'projection revision failed')), { code: result?.code });
          forecastFailure = null;
          await refresh();
        } catch (error) {
          const code = error && error.code;
          const retryable = ['model_not_configured', 'model_unavailable', 'model_auth_failed', 'forecast_unavailable'].includes(code);
          if (confirm && retryable) {
            forecastFailure = { message: (error && error.message) || String(error) };
            await refresh();
          } else if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
        } finally {
          button.disabled = false;
        }
      });
    }
    await refresh();
  }

  window.mountRecallProjectionCard = mountRecallProjectionCard;
})();
