(function () {
  'use strict';

  function cloneDraft(draft) {
    return {
      step: draft.step || 'auth_type',
      authType: draft.authType || null,
      source: draft.source || null,
      providerKind: draft.providerKind || null,
      providerId: draft.providerId || '',
      profileId: draft.profileId || '',
      draftId: draft.draftId || '',
      externalId: draft.externalId || '',
      customProvider: draft.customProvider ? { ...draft.customProvider } : null,
      credential: draft.credential ? { ...draft.credential } : {},
      discoveryToken: draft.discoveryToken || '',
      discoveryStatus: draft.discoveryStatus || 'idle',
      discoveryErrorCode: draft.discoveryErrorCode || '',
      declaredModels: Array.isArray(draft.declaredModels) ? [...draft.declaredModels] : [],
      models: Array.isArray(draft.models) ? draft.models.map((model) => ({ ...model })) : [],
      selectedModels: Array.isArray(draft.selectedModels) ? [...draft.selectedModels] : [],
      defaultModel: draft.defaultModel || '',
    };
  }

  function createDraft() {
    return cloneDraft({});
  }

  function normalizeModelId(value) {
    return String(value || '').trim();
  }

  function normalizeModels(models) {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(models) ? models : []) {
      const id = normalizeModelId(typeof item === 'string' ? item : item && item.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: String((item && item.name) || id).trim() || id,
        description: String((item && item.description) || '').trim(),
      });
    }
    return out;
  }

  function uniqueIds(values) {
    const seen = new Set();
    const out = [];
    for (const value of Array.isArray(values) ? values : []) {
      const id = normalizeModelId(value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function repairSelection(draft) {
    const next = cloneDraft(draft);
    const known = new Set(next.models.map((model) => model.id));
    next.selectedModels = uniqueIds(next.selectedModels).filter((id) => known.has(id) || next.discoveryErrorCode === 'unsupported_discovery');
    if (!next.selectedModels.includes(next.defaultModel)) {
      next.defaultModel = next.selectedModels[0] || '';
    }
    return next;
  }

  function transition(draft, action) {
    const next = cloneDraft(draft || createDraft());
    const type = action && action.type;
    if (type === 'choose_auth_type') {
      if (action.authType !== 'oauth' && action.authType !== 'api_key') throw new Error('invalid auth type');
      next.authType = action.authType;
      next.source = action.authType === 'oauth' ? 'oauth' : null;
      next.step = action.authType === 'oauth' ? 'provider' : 'api_key_source';
      next.providerKind = null;
      next.providerId = '';
      next.credential = {};
      next.discoveryToken = '';
      next.discoveryStatus = 'idle';
      next.discoveryErrorCode = '';
      next.models = [];
      next.selectedModels = [];
      next.defaultModel = '';
      return repairSelection(next);
    }
    if (type === 'choose_api_key_source') {
      if (next.authType !== 'api_key') throw new Error('api key auth type required');
      if (action.source !== 'manual' && action.source !== 'ccswitch') throw new Error('invalid api key source');
      next.source = action.source;
      next.step = action.source === 'ccswitch' ? 'ccswitch_select' : 'protocol';
      next.credential = {};
      next.discoveryToken = '';
      next.discoveryStatus = 'idle';
      next.discoveryErrorCode = '';
      next.models = [];
      next.selectedModels = [];
      next.defaultModel = '';
      return repairSelection(next);
    }
    if (type === 'choose_provider') {
      next.providerKind = action.providerKind === 'custom' ? 'custom' : 'builtin';
      next.providerId = normalizeModelId(action.providerId);
      next.customProvider = action.customProvider ? { ...action.customProvider } : next.customProvider;
      next.step = next.authType === 'oauth' ? 'oauth_signin' : 'credentials';
      return repairSelection(next);
    }
    if (type === 'set_api_key_credentials') {
      next.authType = 'api_key';
      next.source = next.source || 'manual';
      next.providerKind = action.providerKind === 'custom' ? 'custom' : 'builtin';
      next.providerId = normalizeModelId(action.providerId || next.providerId);
      next.customProvider = next.providerKind === 'custom' ? {
        id: normalizeModelId(action.id || action.providerId || ''),
        name: String(action.name || '').trim(),
        protocol: String(action.protocol || '').trim(),
        baseUrl: String(action.baseUrl || '').trim(),
      } : null;
      next.credential = {
        ...next.credential,
        apiKey: String(action.apiKey || ''),
        baseUrl: String(action.baseUrl || '').trim(),
      };
      next.step = 'credential_ready';
      return repairSelection(next);
    }
    if (type === 'credential_ready') {
      next.profileId = normalizeModelId(action.profileId);
      next.step = 'credential_ready';
      return repairSelection(next);
    }
    if (type === 'ccswitch_ready') {
      next.authType = 'api_key';
      next.source = 'ccswitch';
      next.providerKind = 'builtin';
      next.draftId = normalizeModelId(action.draftId);
      next.externalId = normalizeModelId(action.externalId || next.externalId);
      next.credential = {
        ...next.credential,
        maskedKey: String(action.maskedKey || next.credential.maskedKey || ''),
      };
      next.step = 'credential_ready';
      return repairSelection(next);
    }
    if (type === 'begin_discovery') {
      next.discoveryToken = normalizeModelId(action.token);
      next.discoveryStatus = 'loading';
      next.discoveryErrorCode = '';
      next.step = 'discovering';
      return repairSelection(next);
    }
    return next;
  }

  function applyDiscovery(draft, result) {
    const token = normalizeModelId(result && result.token);
    if (draft && draft.discoveryToken && token && token !== draft.discoveryToken) return draft;
    const next = cloneDraft(draft || createDraft());
    next.discoveryStatus = result && result.ok === false ? 'error' : 'ready';
    next.discoveryErrorCode = result && result.ok === false ? String(result.errorCode || result.code || 'discovery_failed') : '';
    next.models = result && result.ok === false ? [] : normalizeModels(result && result.models);
    next.declaredModels = uniqueIds(result && result.declaredModels);
    if (next.discoveryStatus === 'ready') {
      const known = new Set(next.models.map((model) => model.id));
      if (next.source === 'ccswitch' && next.declaredModels.length) {
        next.selectedModels = next.declaredModels.filter((id) => known.has(id));
      } else {
        next.selectedModels = [];
      }
      next.defaultModel = next.selectedModels[0] || '';
      next.step = 'models';
    } else {
      next.selectedModels = [];
      next.defaultModel = '';
      next.step = next.discoveryErrorCode === 'unsupported_discovery' ? 'manual_model' : 'credentials';
    }
    return repairSelection(next);
  }

  function toggleModel(draft, modelId, selected) {
    const next = cloneDraft(draft || createDraft());
    const id = normalizeModelId(modelId);
    if (!id) return repairSelection(next);
    const known = new Set(next.models.map((model) => model.id));
    if (!known.has(id) && next.discoveryErrorCode !== 'unsupported_discovery') throw new Error('unknown model');
    const values = new Set(next.selectedModels);
    if (selected === false) values.delete(id);
    else values.add(id);
    next.selectedModels = Array.from(values);
    return repairSelection(next);
  }

  function setDefaultModel(draft, modelId) {
    const next = cloneDraft(draft || createDraft());
    const id = normalizeModelId(modelId);
    if (!next.selectedModels.includes(id)) throw new Error('default model must be selected');
    next.defaultModel = id;
    return next;
  }

  function addManualModel(draft, modelId) {
    const next = cloneDraft(draft || createDraft());
    if (next.discoveryErrorCode !== 'unsupported_discovery') throw new Error('manual models require unsupported_discovery');
    const id = normalizeModelId(modelId);
    if (!id) throw new Error('model required');
    if (!next.models.some((model) => model.id === id)) next.models.push({ id, name: id, manual: true });
    next.selectedModels = uniqueIds([...next.selectedModels, id]);
    if (!next.defaultModel) next.defaultModel = id;
    next.step = 'models';
    return repairSelection(next);
  }

  function serializeSafeDraft(draft) {
    const next = cloneDraft(draft || createDraft());
    const credential = { ...next.credential };
    const hasApiKey = !!credential.apiKey;
    delete credential.apiKey;
    return {
      ...next,
      credential: {
        ...credential,
        hasApiKey,
      },
    };
  }

  function buildCompletionPayload(draft) {
    const next = repairSelection(draft || createDraft());
    if (!next.selectedModels.length) throw new Error('selected models required');
    if (!next.defaultModel || !next.selectedModels.includes(next.defaultModel)) throw new Error('default model must be selected');
    const base = {
      authType: next.authType,
      source: next.source,
      providerKind: next.providerKind || 'builtin',
      requestId: next.source === 'ccswitch' ? next.draftId : (next.profileId || next.draftId || next.providerId),
      selectedModels: [...next.selectedModels],
      defaultModel: next.defaultModel,
    };
    if (next.authType === 'oauth') {
      return {
        ...base,
        providerId: next.providerId,
        profileId: next.profileId,
      };
    }
    if (next.source === 'ccswitch') {
      return {
        ...base,
        draftId: next.draftId,
        externalId: next.externalId,
      };
    }
    if (next.providerKind === 'custom') {
      return {
        ...base,
        customProvider: {
          ...(next.customProvider || {}),
          apiKey: next.credential.apiKey || '',
        },
      };
    }
    return {
      ...base,
      providerId: next.providerId,
      apiKey: next.credential.apiKey || '',
      baseUrl: next.credential.baseUrl || undefined,
    };
  }


  const controller = {
    bound: false,
    open: false,
    providers: [],
    authorizations: [],
    draft: createDraft(),
    ccswitchRows: [],
    ccswitchUnsupported: [],
    discoverySeq: 0,
    busy: false,
  };

  function tr(key, vars) {
    if (typeof t === 'function') return t(key, vars);
    return key;
  }

  function esc(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function el(id) {
    return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null;
  }

  function setStatus(message, klass) {
    const status = el('model-authorization-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = `form-msg${klass ? ` ${klass}` : ''}`;
  }

  async function invoke(channel, payload) {
    if (!window || !window.orkas || typeof window.orkas.invoke !== 'function') return { ok: false, error: 'ipc unavailable' };
    return window.orkas.invoke(channel, payload);
  }

  async function ensureProviders() {
    if (controller.providers.length) return controller.providers;
    const res = await invoke('auth.listProviders');
    controller.providers = (res && res.ok && Array.isArray(res.providers)) ? res.providers : [];
    return controller.providers;
  }

  function openModal() {
    const overlay = el('model-authorization-modal');
    if (overlay && overlay.classList) overlay.classList.add('open');
    controller.open = true;
  }

  function closeModal() {
    const overlay = el('model-authorization-modal');
    if (overlay && overlay.classList) overlay.classList.remove('open');
    controller.open = false;
  }

  function activeSteps() {
    const steps = ['auth_type', 'provider', 'credentials', 'models', 'confirm'];
    const current = controller.draft.step;
    return steps.map((step) => `<span class="model-authorization-step${step === current ? ' is-active' : ''}">${esc(step)}</span>`).join('');
  }

  function renderChoices() {
    return `<div class="model-authorization-choice-grid">
      <button class="model-authorization-choice" data-model-auth-action="choose-oauth">${esc(tr('settings.model_authorization.auth_type_oauth'))}</button>
      <button class="model-authorization-choice" data-model-auth-action="choose-api-key">${esc(tr('settings.model_authorization.auth_type_api_key'))}</button>
    </div>`;
  }

  function renderSourceChoices() {
    return `<div class="model-authorization-choice-grid">
      <button class="model-authorization-choice" data-model-auth-action="source-manual">${esc(tr('settings.model_authorization.source_manual'))}</button>
      <button class="model-authorization-choice" data-model-auth-action="source-ccswitch">${esc(tr('settings.model_authorization.source_ccswitch'))}</button>
    </div>`;
  }

  function renderProtocols() {
    return `<div class="model-authorization-protocols">
      <div class="model-authorization-progress">${esc(tr('settings.model_authorization.protocol_title'))}</div>
      <div class="model-authorization-choice-grid">
        <button class="model-authorization-choice" data-model-auth-action="choose-protocol" data-protocol="openai">${esc(tr('settings.model_authorization.protocol_openai'))}</button>
        <button class="model-authorization-choice" data-model-auth-action="choose-protocol" data-protocol="anthropic">${esc(tr('settings.model_authorization.protocol_anthropic'))}</button>
        <button class="model-authorization-choice" data-model-auth-action="choose-protocol" data-protocol="gemini">${esc(tr('settings.model_authorization.protocol_gemini'))}</button>
      </div>
    </div>`;
  }

  function endpointLabel(baseUrl) {
    try { return new URL(baseUrl).hostname || 'Custom endpoint'; }
    catch { return 'Custom endpoint'; }
  }

  function renderCredentials() {
    return `<div class="model-authorization-credentials">
      <div class="model-authorization-progress">${esc(tr('settings.model_authorization.api_key_flow_hint'))}</div>
      <div class="form-row"><label>${esc(tr('settings.custom.api_key'))}</label><input id="model-authorization-api-key" class="form-input" type="text" autocomplete="off" spellcheck="false" /></div>
      <div class="form-row"><label>${esc(tr('settings.custom.base_url'))}</label><input id="model-authorization-base-url" class="form-input" type="url" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1" /></div>
    </div>`;
  }

  function renderCcswitchRows() {
    const supported = controller.ccswitchRows.length
      ? `<div class="model-authorization-choice-grid">${controller.ccswitchRows.map((row) => {
        const needsKey = !!row.missingKey;
        const statusKey = needsKey ? 'settings.model_authorization.needs_api_key' : 'settings.model_authorization.ready_to_import';
        return `
      <button class="model-authorization-choice" data-model-auth-action="select-ccswitch" data-external-id="${esc(row.externalId)}"${needsKey ? ' disabled' : ''}>
        <strong>${esc(row.name || row.externalId)}</strong><br />
        <span class="muted">${esc(row.protocol || '')} ${esc(row.maskedKey || '')}</span><br />
        <span class="model-authorization-ccswitch-status ${needsKey ? 'needs-api-key' : 'ready-to-import'}">${esc(tr(statusKey))}</span>
      </button>`;
      }).join('')}</div>`
      : `<div class="settings-empty">${esc(tr('settings.model_authorization.ccswitch_preview_empty'))}</div>`;
    const unsupported = controller.ccswitchUnsupported.length
      ? `<div class="model-authorization-warning model-authorization-ccswitch-unsupported"><strong>${esc(tr('settings.model_authorization.unsupported'))}</strong><div>${esc(tr('settings.model_authorization.ccswitch_unsupported_hint'))}</div><ul>${controller.ccswitchUnsupported.map((row) => `<li>${esc(row.name || row.externalId || '')}</li>`).join('')}</ul></div>`
      : '';
    return `${supported}${unsupported}`;
  }

  function renderModels() {
    const selected = new Set(controller.draft.selectedModels);
    const rows = controller.draft.models.map((model) => `
      <div class="model-authorization-model-row" data-model-id="${esc(model.id)}">
        <button data-model-auth-action="toggle-model" data-model-id="${esc(model.id)}" data-checked="${selected.has(model.id) ? 'false' : 'true'}">${selected.has(model.id) ? '✓' : '+'}</button>
        <span>${esc(model.name || model.id)}</span>
        <button data-model-auth-action="default-model" data-model-id="${esc(model.id)}" ${selected.has(model.id) ? '' : 'disabled'}>${controller.draft.defaultModel === model.id ? esc(tr('settings.model_authorization.default_label')) : 'Make default'}</button>
      </div>`).join('');
    const manual = controller.draft.discoveryErrorCode === 'unsupported_discovery'
      ? `<div class="form-row"><input id="model-authorization-manual-model" class="form-input" type="text" /><button class="btn" data-model-auth-action="add-manual-model">${esc(tr('settings.model_authorization.manual_model_title'))}</button></div>`
      : '';
    return `${manual}<div class="model-authorization-model-list">${rows}</div>`;
  }

  function renderProgress() {
    return `<div class="model-authorization-progress">${esc(tr('settings.model_authorization.progress_discovering'))}</div>`;
  }

  function render() {
    const steps = el('model-authorization-steps');
    const body = el('model-authorization-body');
    const actions = el('model-authorization-actions');
    if (!body || !actions) return;
    if (steps) steps.innerHTML = activeSteps();
    actions.innerHTML = '';
    if (controller.draft.step === 'auth_type') body.innerHTML = renderChoices();
    else if (controller.draft.step === 'api_key_source') body.innerHTML = renderSourceChoices();
    else if (controller.draft.step === 'provider' || controller.draft.step === 'protocol') body.innerHTML = renderProtocols();
    else if (controller.draft.step === 'ccswitch_select') body.innerHTML = renderCcswitchRows();
    else if (controller.draft.step === 'credentials' || controller.draft.step === 'credential_ready') {
      body.innerHTML = renderCredentials();
      actions.innerHTML = `<button class="btn btn-primary" data-model-auth-action="continue-credentials">${esc(tr('common.continue') || 'Continue')}</button>`;
    } else if (controller.draft.step === 'discovering') body.innerHTML = renderProgress();
    else if (controller.draft.step === 'models' || controller.draft.step === 'manual_model') {
      body.innerHTML = renderModels();
      actions.innerHTML = `<button class="btn btn-primary" data-model-auth-action="complete" ${controller.draft.selectedModels.length ? '' : 'disabled'}>${esc(tr('settings.model_authorization.complete'))}</button>`;
    } else body.innerHTML = renderChoices();
  }

  function startDraft() {
    controller.draft = transition(createDraft(), { type: 'choose_auth_type', authType: 'api_key' });
    controller.ccswitchRows = [];
    controller.busy = false;
    setStatus('', '');
    openModal();
    render();
  }

  async function chooseAuthType(authType) {
    controller.draft = transition(controller.draft, { type: 'choose_auth_type', authType });
    await ensureProviders();
    render();
  }

  async function chooseApiKeySource(source) {
    controller.draft = transition(controller.draft, { type: 'choose_api_key_source', source });
    if (source === 'ccswitch') {
      setStatus(tr('settings.model_authorization.ccswitch_preview_loading'), '');
      const res = await invoke('customProviders.ccswitch.preview');
      const rawItems = (res && res.ok && Array.isArray(res.items)) ? res.items : ((res && res.ok && Array.isArray(res.rows)) ? res.rows : []);
      controller.ccswitchRows = rawItems.map((item) => ({
        ...item,
        maskedKey: item.maskedKey || item.apiKeyMasked || '',
        declaredModels: item.declaredModels || item.models || [],
        missingKey: !!(item.missingKey || item.needsKey),
      }));
      controller.ccswitchUnsupported = (res && res.ok && Array.isArray(res.unsupported)) ? res.unsupported : [];
      setStatus('', '');
    } else {
      // Manual API-key flow is protocol-first; provider catalogs are not part of this path.
    }
    render();
  }

  async function chooseProtocol(protocol) {
    if (protocol !== 'openai' && protocol !== 'anthropic' && protocol !== 'gemini') return;
    controller.draft = transition(controller.draft, { type: 'choose_provider', providerId: protocol, providerKind: 'custom' });
    controller.draft.customProvider = { ...(controller.draft.customProvider || {}), protocol };
    render();
  }

  async function chooseProvider(dataset) {
    controller.draft = transition(controller.draft, { type: 'choose_provider', providerId: dataset.providerId, providerKind: dataset.providerKind || 'builtin' });
    render();
    if (controller.draft.authType === 'oauth') {
      const res = await invoke('auth.startOAuth', { provider: controller.draft.providerId });
      if (res && res.ok && (res.kind === 'done' || res.profileId)) {
        controller.draft = transition(controller.draft, { type: 'credential_ready', profileId: res.profileId });
        await discoverModels({ kind: 'oauth', providerId: controller.draft.providerId, profileId: res.profileId });
      } else if (res && !res.ok) {
        setStatus(res.error || tr('settings.model_authorization.error_required'), 'error');
      }
    }
  }

  async function selectCcswitch(externalId) {
    const res = await invoke('modelAuthorizations.prepareCcSwitch', { externalId });
    if (!res || !res.ok) { setStatus((res && res.error) || tr('settings.model_authorization.error_required'), 'error'); return; }
    controller.draft = transition(controller.draft, { type: 'ccswitch_ready', draftId: res.draftId, externalId: res.externalId || externalId, maskedKey: res.maskedKey });
    await discoverModels({ kind: 'ccswitch_draft', draftId: res.draftId, declaredModels: res.declaredModels || [] });
  }

  async function continueCredentials() {
    const keyEl = el('model-authorization-api-key');
    const baseUrlEl = el('model-authorization-base-url');
    const apiKey = String((keyEl && keyEl.value) || '').trim();
    const baseUrl = String((baseUrlEl && baseUrlEl.value) || '').trim();
    const protocol = controller.draft.customProvider && controller.draft.customProvider.protocol;
    if (!apiKey || !baseUrl || !protocol) {
      setStatus(tr('settings.model_authorization.error_required'), 'error');
      return;
    }
    const name = endpointLabel(baseUrl);
    controller.draft = transition(controller.draft, {
      type: 'set_api_key_credentials',
      providerKind: 'custom',
      providerId: protocol,
      protocol,
      name,
      apiKey,
      baseUrl,
    });
    await discoverModels({ kind: 'custom_api_key', protocol, apiKey, baseUrl });
  }

  async function discoverModels(payload) {
    const token = `discovery-${++controller.discoverySeq}`;
    controller.draft = transition(controller.draft, { type: 'begin_discovery', token });
    render();
    const result = await invoke('modelAuthorizations.discover', payload);
    if (controller.draft.discoveryToken !== token) return;
    controller.draft = applyDiscovery(controller.draft, { ...(result || {}), token, declaredModels: (result && result.declaredModels) || payload.declaredModels || [] });
    setStatus(result && result.ok === false ? (result.error || tr('settings.model_authorization.error_discovery_failed')) : '', result && result.ok === false ? 'error' : '');
    render();
  }

  async function completeDraft() {
    let payload;
    try { payload = buildCompletionPayload(controller.draft); }
    catch (err) { setStatus((err && err.message) || tr('settings.model_authorization.error_required'), 'error'); return; }
    const testPayload = payload.source === 'ccswitch'
      ? { kind: 'ccswitch_draft', draftId: payload.draftId, model: payload.defaultModel }
      : { kind: 'custom_api_key', protocol: payload.customProvider.protocol, baseUrl: payload.customProvider.baseUrl, apiKey: payload.customProvider.apiKey, model: payload.defaultModel };
    const testRes = await invoke('modelAuthorizations.testDraft', testPayload);
    if (!testRes || !testRes.ok) { setStatus((testRes && testRes.error) || tr('settings.model_authorization.error_test_failed'), 'error'); return; }
    const res = await invoke('modelAuthorizations.complete', payload);
    if (!res || !res.ok) { setStatus((res && res.error) || tr('settings.model_authorization.complete_failed'), 'error'); return; }
    closeModal();
    await refreshModelAuthorizationSettings();
  }

  async function handleAction(dataset) {
    const action = dataset && dataset.modelAuthAction;
    if (!action) return;
    if (action === 'choose-oauth') return chooseAuthType('oauth');
    if (action === 'choose-api-key') return chooseAuthType('api_key');
    if (action === 'source-manual') return chooseApiKeySource('manual');
    if (action === 'source-ccswitch') return chooseApiKeySource('ccswitch');
    if (action === 'choose-provider') return chooseProvider(dataset);
    if (action === 'choose-protocol') return chooseProtocol(dataset.protocol);
    if (action === 'select-ccswitch') return selectCcswitch(dataset.externalId);
    if (action === 'continue-credentials') return continueCredentials();
    if (action === 'toggle-model') { controller.draft = toggleModel(controller.draft, dataset.modelId, dataset.checked !== 'false'); render(); return; }
    if (action === 'default-model') { controller.draft = setDefaultModel(controller.draft, dataset.modelId); render(); return; }
    if (action === 'add-manual-model') { const input = el('model-authorization-manual-model'); controller.draft = addManualModel(controller.draft, input && input.value); render(); return; }
    if (action === 'complete') return completeDraft();
  }

  function bindDelegates() {
    for (const id of ['model-authorization-body', 'model-authorization-actions']) {
      const node = el(id);
      if (!node || node.dataset.modelAuthorizationBound) continue;
      node.dataset.modelAuthorizationBound = '1';
      node.addEventListener('click', (event) => handleAction(event && event.target && event.target.dataset));
      node.addEventListener('keydown', (event) => {
        if (!event || event.key !== 'Enter') return;
        if (event.isComposing || event.keyCode === 229) return;
        if (event.preventDefault) event.preventDefault();
        if (controller.draft.step === 'credentials' || controller.draft.step === 'credential_ready') continueCredentials();
      });
    }
  }

  function renderAuthorizationCards() {
    const list = el('settings-model-authorization-list');
    if (!list) return;
    if (!controller.authorizations.length) {
      list.innerHTML = `<div class="settings-empty">${esc(tr('settings.entries.empty'))}</div>`;
      return;
    }
    list.innerHTML = controller.authorizations.map((auth) => {
      const models = Array.isArray(auth.models) ? auth.models : [];
      const defaultModel = (models.find((model) => model.default) || models[0] || {}).model || auth.defaultModel || '';
      return `<div class="model-authorization-card" data-authorization-id="${esc(auth.authorizationId || auth.id)}">
        <div class="model-authorization-card-head"><div><div class="model-authorization-card-title">${esc(auth.label || auth.providerLabel || auth.authorizationId || auth.id)}</div><div class="model-authorization-card-meta">${esc(auth.authType || '')} · ${esc(auth.source || '')}</div></div></div>
        ${auth.warningCode ? `<div class="model-authorization-warning">${esc(auth.warningCode)}</div>` : ''}
        <div>${esc(models.map((model) => model.model || model.id).filter(Boolean).join(', '))}</div>
        <div class="model-authorization-card-meta">${esc(tr('settings.model_authorization.default_label'))}: ${esc(defaultModel)}</div>
      </div>`;
    }).join('');
  }

  async function refreshModelAuthorizationSettings() {
    const res = await invoke('modelAuthorizations.list');
    controller.authorizations = (res && res.ok && Array.isArray(res.authorizations)) ? res.authorizations : (Array.isArray(res) ? res : []);
    renderAuthorizationCards();
  }

  async function initModelAuthorizationSettings() {
    bindDelegates();
    const addBtn = el('settings-model-authorization-add-btn');
    if (addBtn && !addBtn.dataset.modelAuthorizationBound) {
      addBtn.dataset.modelAuthorizationBound = '1';
      addBtn.addEventListener('click', () => startDraft());
    }
    const advancedBtn = el('settings-model-authorization-advanced-btn');
    if (advancedBtn && !advancedBtn.dataset.modelAuthorizationBound) {
      advancedBtn.dataset.modelAuthorizationBound = '1';
      advancedBtn.addEventListener('click', () => {
        const advanced = el('settings-model-authorization-advanced');
        if (advanced) advanced.hidden = !advanced.hidden;
      });
    }
    const closeBtn = el('model-authorization-close-btn');
    if (closeBtn && !closeBtn.dataset.modelAuthorizationBound) {
      closeBtn.dataset.modelAuthorizationBound = '1';
      closeBtn.addEventListener('click', () => closeModal());
    }
    await ensureProviders();
    await refreshModelAuthorizationSettings();
  }

  const api = Object.freeze({
    createDraft,
    createAuthorizationDraft: createDraft,
    transition,
    transitionAuthorizationDraft: transition,
    applyDiscovery,
    toggleModel,
    setDefaultModel,
    addManualModel,
    buildCompletionPayload,
    serializeSafeDraft,
    normalizeModels,
    initModelAuthorizationSettings,
    refreshModelAuthorizationSettings,
  });

  if (typeof window !== 'undefined') {
    window.ModelAuthorizationFlow = api;
    window.initModelAuthorizationSettings = initModelAuthorizationSettings;
    window.refreshModelAuthorizationSettings = refreshModelAuthorizationSettings;
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('i18n-change', () => {
        if (controller.open) render();
        renderAuthorizationCards();
      });
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
