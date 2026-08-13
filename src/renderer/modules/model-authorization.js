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
      preselectAll: !!draft.preselectAll,
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
      next.step = action.source === 'ccswitch' ? 'ccswitch_select' : 'provider_preset';
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
      // Builtin presets ship their own model catalog; preselect every entry so
      // the user can go from API key to usable model without extra clicks.
      next.preselectAll = next.providerKind === 'builtin';
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
      next.providerKind = 'custom';
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
    if (type === 'back') {
      // Step back through the current flow; entered data (key, models) is
      // kept so the user can fix one field without restarting. Credential
      // input ('credentials') and the ready state ('credential_ready') share
      // one UI step; 'discovering' is a transient transition between
      // credentials and models — backing out of it lands back on the
      // credentials step it came from.
      const order = next.authType === 'oauth'
        ? ['auth_type', 'provider', 'oauth_signin', 'models', 'confirm']
        : next.source === 'ccswitch'
          ? ['auth_type', 'api_key_source', 'ccswitch_select', 'models', 'confirm']
          : ['auth_type', 'api_key_source', 'provider_preset', 'credential_ready', 'models', 'confirm'];
      if (next.step === 'discovering') {
        next.step = 'credential_ready';
        return repairSelection(next);
      }
      let current = next.step;
      if (current === 'credentials') current = 'credential_ready';
      if (current === 'manual_model') current = 'models';
      const idx = order.indexOf(current);
      if (idx > 0) next.step = order[idx - 1];
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
      } else if (next.preselectAll) {
        next.selectedModels = Array.from(known);
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

  function isExpiredCcSwitchDraft(result) {
    const code = String(result && (result.errorCode || result.code) || '').trim();
    return code === 'draft_not_found' || code === 'draft_expired';
  }

  function resetExpiredCcSwitchDraft() {
    const next = cloneDraft(controller.draft);
    next.step = 'ccswitch_select';
    next.providerKind = null;
    next.providerId = '';
    next.profileId = '';
    next.draftId = '';
    next.externalId = '';
    next.customProvider = null;
    next.credential = {};
    next.discoveryToken = '';
    next.discoveryStatus = 'idle';
    next.discoveryErrorCode = '';
    next.declaredModels = [];
    next.models = [];
    next.selectedModels = [];
    next.defaultModel = '';
    next.preselectAll = false;
    controller.draft = next;
    setStatus(tr('settings.model_authorization.ccswitch_draft_expired'), 'error');
    render();
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
    providerCatalog: {
      status: 'idle',
      error: '',
    },
    providerLoadSeq: 0,
    authorizations: [],
    draft: createDraft(),
    ccswitchRows: [],
    ccswitchUnsupported: [],
    ccswitchPreviewSeq: 0,
    ccswitchPrepareSeq: 0,
    discoverySeq: 0,
    busy: false,
    removingAuthorizationId: '',
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

  function setAuthorizationStatus(message, klass) {
    const status = el('settings-model-authorization-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = `settings-status${klass ? ` ${klass}` : ''}`;
  }

  async function invoke(channel, payload) {
    if (!window || !window.cogseed || typeof window.cogseed.invoke !== 'function') return { ok: false, error: 'ipc unavailable' };
    return window.cogseed.invoke(channel, payload);
  }

  async function invokeResult(channel, payload, fallbackKey) {
    try {
      const result = await invoke(channel, payload);
      if (!result || result.ok === false) {
        const resultMessage = result && typeof result.error === 'string' ? result.error.trim() : '';
        return {
          ok: false,
          result: result || null,
          message: resultMessage ? resultMessage.slice(0, 300) : tr(fallbackKey),
        };
      }
      return { ok: true, result };
    } catch (_error) {
      return { ok: false, result: null, message: tr(fallbackKey) };
    }
  }

  async function ensureProviders(options) {
    const force = !!(options && options.force);
    if (!force && controller.providerCatalog.status === 'ready') return controller.providers;
    if (!force && controller.providerCatalog.status === 'loading') return controller.providers;
    // Reuse the settings page's provider list when it is already loaded so
    // opening the modal never re-triggers auth.listProviders (core-agent cold
    // start can take 1-2s) just to paint the preset cards.
    const shared = typeof window !== 'undefined' ? window.__settingsProvidersCache : null;
    if (!force && Array.isArray(shared)) {
      controller.providers = shared;
      controller.providerCatalog.status = 'ready';
      controller.providerCatalog.error = '';
      return controller.providers;
    }
    const loadSeq = ++controller.providerLoadSeq;
    controller.providerCatalog.status = 'loading';
    controller.providerCatalog.error = '';
    try {
      const outcome = await invokeResult('auth.listProviders', undefined, 'settings.model_authorization.providers_load_failed');
      if (loadSeq !== controller.providerLoadSeq) return controller.providers;
      const res = outcome.result;
      if (!outcome.ok || !res || !Array.isArray(res.providers)) {
        controller.providerCatalog.status = 'error';
        controller.providerCatalog.error = outcome.message;
        return controller.providers;
      }
      controller.providers = res.providers;
      controller.providerCatalog.status = 'ready';
      if (typeof window !== 'undefined') window.__settingsProvidersCache = controller.providers;
    } catch (_error) {
      if (loadSeq !== controller.providerLoadSeq) return controller.providers;
      controller.providerCatalog.status = 'error';
      controller.providerCatalog.error = tr('settings.model_authorization.providers_load_failed');
    }
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
    // Steps are flow-dependent: API-key presets, CC Switch import, and OAuth
    // each show their own sequence with localized labels (no raw step ids).
    const draft = controller.draft;
    const steps = draft.authType === 'oauth'
      ? [['auth_type', 'step_auth_type'], ['provider', 'step_provider'], ['models', 'step_models'], ['confirm', 'step_confirm']]
      : draft.source === 'ccswitch'
        ? [['auth_type', 'step_auth_type'], ['api_key_source', 'step_api_key_source'], ['ccswitch_select', 'step_ccswitch'], ['models', 'step_models'], ['confirm', 'step_confirm']]
        : [['auth_type', 'step_auth_type'], ['api_key_source', 'step_api_key_source'], ['provider_preset', 'step_provider_preset'], ['credentials', 'step_credentials'], ['models', 'step_models'], ['confirm', 'step_confirm']];
    let current = draft.step;
    if (current === 'credential_ready' || current === 'discovering') current = 'credentials';
    if (current === 'manual_model') current = 'models';
    const idx = steps.findIndex(([step]) => step === current);
    return steps.map(([step, key], i) => {
      const done = idx >= 0 && i < idx;
      const active = step === current;
      return `<span class="model-authorization-step${active ? ' is-active' : ''}${done ? ' is-done' : ''}">${done ? '<span class="model-authorization-step-check">✓</span>' : ''}${esc(tr(`settings.model_authorization.${key}`))}</span>`;
    }).join('');
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

  // Brand accent colors for the preset letter badges. No image assets are
  // shipped (matches the onboarding "no per-agent brand marks" rule); a
  // neutral slate color covers providers without an entry.
  const PRESET_COLORS = Object.freeze({
    deepseek: '#4D6BFE',
    openai: '#10A37F',
    google: '#4285F4',
    anthropic: '#D97757',
    zai: '#3859FF',
    moonshot: '#1A1A1A',
    'kimi-coding': '#5E5CE6',
    'minimax-cn': '#7B61FF',
    doubao: '#325AB4',
    openrouter: '#7B61FF',
  });

  function providerInitial(provider) {
    const label = String(provider.label || provider.id || '?');
    return esc(label.trim().charAt(0).toUpperCase());
  }

  function renderProviderPresets() {
    const presets = controller.providers.filter((provider) =>
      provider && provider.providerKind === 'builtin'
      && provider.supportsApiKey
      && !provider.manualModel
    );
    const cards = presets.map((provider) => {
      const color = PRESET_COLORS[provider.id] || '#6b7280';
      const badge = provider.recommended
        ? ` <span class="model-authorization-provider-badge">${esc(tr('settings.model_authorization.preset_recommended'))}</span>`
        : '';
      const configured = (provider.profiles && provider.profiles.length)
        ? ` <span class="model-authorization-provider-configured">${esc(tr('settings.model_authorization.provider_configured'))}</span>`
        : '';
      // subscriptionNote is an i18n key resolved here so the hint follows the
      // UI language (e.g. Moonshot pay-as-you-go vs Kimi Coding subscription).
      const note = provider.subscriptionNote
        ? `<span class="model-authorization-provider-note">${esc(tr(provider.subscriptionNote))}</span>`
        : '';
      const docs = provider.docsUrl
        ? `<span class="model-authorization-provider-docs"><a href="${esc(provider.docsUrl)}" target="_blank" rel="noopener noreferrer">${esc(tr('settings.model_authorization.provider_docs_hint'))}</a></span>`
        : '';
      return `<button type="button" class="model-authorization-choice model-authorization-provider-card" data-model-auth-action="choose-provider-preset" data-provider-id="${esc(provider.id)}">
        <span class="model-authorization-provider-logo" style="--provider-color:${color}">${providerInitial(provider)}</span>
        <span class="model-authorization-provider-main">
          <span class="model-authorization-provider-title">${esc(provider.label)}${badge}${configured}</span>
          ${note}${docs}
        </span>
      </button>`;
    }).join('');
    const custom = `<button type="button" class="model-authorization-choice model-authorization-provider-card model-authorization-provider-card-custom" data-model-auth-action="choose-custom-endpoint">
      <span class="model-authorization-provider-logo" style="--provider-color:#6b7280">＋</span>
      <span class="model-authorization-provider-main">
        <span class="model-authorization-provider-title">${esc(tr('settings.model_authorization.custom_endpoint'))}</span>
        <span class="model-authorization-provider-note">${esc(tr('settings.model_authorization.custom_endpoint_hint'))}</span>
      </span>
    </button>`;
    let catalogState = '';
    if (controller.providerCatalog.status === 'loading' || controller.providerCatalog.status === 'idle') {
      catalogState = `<div class="model-authorization-progress">${esc(tr('settings.model_authorization.providers_loading'))}</div>`;
    } else if (controller.providerCatalog.status === 'error') {
      catalogState = `<div class="model-authorization-warning">${esc(controller.providerCatalog.error || tr('settings.model_authorization.providers_load_failed'))}</div>
        <button type="button" class="btn" data-model-auth-action="retry-providers">${esc(tr('settings.model_authorization.retry_providers'))}</button>`;
    } else if (!presets.length) {
      catalogState = `<div class="settings-empty">${esc(tr('settings.model_authorization.providers_empty'))}</div>`;
    }
    return `<div class="model-authorization-progress">${esc(tr('settings.model_authorization.provider_preset_title'))}</div>
      ${catalogState}
      <div class="model-authorization-choice-grid model-authorization-provider-grid">${cards}${custom}</div>`;
  }

  function endpointLabel(baseUrl) {
    try { return new URL(baseUrl).hostname || 'Custom endpoint'; }
    catch { return 'Custom endpoint'; }
  }

  function keyInputHtml() {
    const eye = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
      ? window.uiIconHtml('eye', 'model-authorization-key-toggle-icon')
      : '👁';
    return `<div class="model-authorization-key-wrap">
      <input id="model-authorization-api-key" class="form-input" type="password" autocomplete="off" spellcheck="false" />
      <button type="button" class="model-authorization-key-toggle" data-model-auth-action="toggle-key-visible" data-target="model-authorization-api-key" title="${esc(tr('settings.model_authorization.key_show'))}">${eye}</button>
    </div>`;
  }

  function renderCredentials() {
    const provider = controller.providers.find((item) => item.id === controller.draft.providerId);
    const isBuiltin = controller.draft.providerKind === 'builtin';
    const title = isBuiltin && provider ? provider.label : tr('settings.model_authorization.api_key_flow_hint');
    const baseRow = isBuiltin
      ? `<div class="model-authorization-note">${esc(tr('settings.model_authorization.base_url_builtin_hint'))}</div>`
      : `<div class="form-row"><label>${esc(tr('settings.custom.base_url'))}</label><input id="model-authorization-base-url" class="form-input" type="url" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1" /></div>`;
    const docs = isBuiltin && provider && provider.docsUrl
      ? `<a class="model-authorization-provider-docs" href="${esc(provider.docsUrl)}" target="_blank" rel="noopener noreferrer">${esc(tr('settings.model_authorization.provider_docs_hint'))}</a>`
      : '';
    return `<div class="model-authorization-credentials">
      <div class="model-authorization-progress">${esc(title)}</div>
      <div class="form-row"><label>${esc(tr('settings.custom.api_key'))}</label>${keyInputHtml()}</div>
      ${baseRow}
      ${docs}
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

  function renderActions() {
    const step = controller.draft.step;
    const cancel = `<button class="btn" data-model-auth-action="cancel">${esc(tr('common.cancel') || 'Cancel')}</button>`;
    const back = `<button class="btn" data-model-auth-action="back">${esc(tr('common.back') || 'Back')}</button>`;
    if (step === 'auth_type') return cancel;
    if (step === 'credentials' || step === 'credential_ready') {
      return `${back}<button class="btn btn-primary" data-model-auth-action="continue-credentials">${esc(tr('common.continue') || 'Continue')}</button>`;
    }
    if (step === 'models' || step === 'manual_model') {
      const disabled = controller.busy || !controller.draft.selectedModels.length;
      return `${back}<button class="btn btn-primary" data-model-auth-action="complete"${disabled ? ' disabled' : ''}>${esc(tr('settings.model_authorization.complete'))}</button>`;
    }
    return back;
  }

  function render() {
    const steps = el('model-authorization-steps');
    const body = el('model-authorization-body');
    const actions = el('model-authorization-actions');
    if (!body || !actions) return;
    if (steps) steps.innerHTML = activeSteps();
    actions.innerHTML = renderActions();
    if (controller.draft.step === 'auth_type') body.innerHTML = renderChoices();
    else if (controller.draft.step === 'api_key_source') body.innerHTML = renderSourceChoices();
    else if (controller.draft.step === 'provider' || controller.draft.step === 'protocol') body.innerHTML = renderProtocols();
    else if (controller.draft.step === 'provider_preset') body.innerHTML = renderProviderPresets();
    else if (controller.draft.step === 'ccswitch_select') body.innerHTML = renderCcswitchRows();
    else if (controller.draft.step === 'credentials' || controller.draft.step === 'credential_ready') body.innerHTML = renderCredentials();
    else if (controller.draft.step === 'discovering') body.innerHTML = renderProgress();
    else if (controller.draft.step === 'models' || controller.draft.step === 'manual_model') body.innerHTML = renderModels();
    else body.innerHTML = renderChoices();
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
    render();
    // Load the provider catalog in the background instead of awaiting it
    // here — the click must not stall on a 1-2s core-agent cold start. The
    // preset step paints a loading placeholder and re-renders when ready.
    if (!controller.providers.length) {
      ensureProviders().then(() => { if (controller.open) render(); });
    }
  }

  async function chooseApiKeySource(source) {
    controller.draft = transition(controller.draft, { type: 'choose_api_key_source', source });
    const previewSeq = ++controller.ccswitchPreviewSeq;
    if (source === 'ccswitch') {
      setStatus(tr('settings.model_authorization.ccswitch_preview_loading'), '');
      const outcome = await invokeResult(
        'customProviders.ccswitch.preview',
        undefined,
        'settings.model_authorization.ccswitch_load_failed',
      );
      if (previewSeq !== controller.ccswitchPreviewSeq || controller.draft.source !== 'ccswitch') return;
      if (!outcome.ok) {
        controller.ccswitchRows = [];
        controller.ccswitchUnsupported = [];
        setStatus(outcome.message, 'error');
        render();
        return;
      }
      const res = outcome.result;
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
      // Manual API-key flow now starts from the builtin provider presets; the
      // custom-endpoint card inside the presets keeps the protocol-first path.
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

  async function chooseProviderPreset(providerId) {
    if (!providerId) return;
    controller.draft = transition(controller.draft, { type: 'choose_provider', providerId, providerKind: 'builtin' });
    render();
  }

  async function retryProviders() {
    if (controller.providerCatalog.status === 'loading') return;
    controller.providerCatalog.error = '';
    const pending = ensureProviders({ force: true });
    render();
    await pending;
    if (controller.open) render();
  }

  async function selectCcswitch(externalId) {
    const prepareSeq = ++controller.ccswitchPrepareSeq;
    const outcome = await invokeResult(
      'modelAuthorizations.prepareCcSwitch',
      { externalId },
      'settings.model_authorization.ccswitch_load_failed',
    );
    if (prepareSeq !== controller.ccswitchPrepareSeq
      || controller.draft.source !== 'ccswitch'
      || controller.draft.step !== 'ccswitch_select') return;
    if (!outcome.ok) {
      setStatus(outcome.message, 'error');
      return;
    }
    const res = outcome.result;
    const prepared = res.draft && typeof res.draft === 'object' ? res.draft : res;
    const draftId = String(prepared.draftId || '').trim();
    if (!draftId) {
      setStatus(tr('settings.model_authorization.error_discovery_failed'), 'error');
      return;
    }
    controller.draft = transition(controller.draft, {
      type: 'ccswitch_ready',
      draftId,
      externalId: prepared.externalId || externalId,
      maskedKey: prepared.maskedKey || '',
    });
    await discoverModels({ kind: 'ccswitch_draft', draftId, declaredModels: prepared.declaredModels || [] });
  }

  async function continueCredentials() {
    const keyEl = el('model-authorization-api-key');
    const apiKey = String((keyEl && keyEl.value) || '').trim();
    const isBuiltin = controller.draft.providerKind === 'builtin';
    if (!apiKey) {
      setStatus(tr('settings.model_authorization.error_required'), 'error');
      return;
    }
    if (isBuiltin) {
      // Builtin preset: base URL is provider-owned, so only the key is asked
      // for; the model list comes from the local catalog (no network probe).
      const providerId = controller.draft.providerId;
      controller.draft = transition(controller.draft, {
        type: 'set_api_key_credentials',
        providerKind: 'builtin',
        providerId,
        apiKey,
      });
      await discoverModels({ kind: 'builtin', providerId });
      return;
    }
    const baseUrlEl = el('model-authorization-base-url');
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
    const outcome = await invokeResult(
      'modelAuthorizations.discover',
      payload,
      'settings.model_authorization.error_discovery_failed',
    );
    if (controller.draft.discoveryToken !== token) return;
    const result = outcome.result || { ok: false, errorCode: 'network_error' };
    if (controller.draft.source === 'ccswitch' && isExpiredCcSwitchDraft(result)) {
      resetExpiredCcSwitchDraft();
      return;
    }
    controller.draft = applyDiscovery(controller.draft, { ...(result || {}), token, declaredModels: (result && result.declaredModels) || payload.declaredModels || [] });
    setStatus(result && result.ok === false ? outcome.message : '', result && result.ok === false ? 'error' : '');
    render();
  }

  async function completeDraft() {
    if (controller.busy) return;
    let payload;
    try { payload = buildCompletionPayload(controller.draft); }
    catch (err) { setStatus((err && err.message) || tr('settings.model_authorization.error_required'), 'error'); return; }
    const testPayload = payload.source === 'ccswitch'
      ? { kind: 'ccswitch_draft', draftId: payload.draftId, model: payload.defaultModel }
      : payload.providerKind === 'builtin'
        ? { kind: 'builtin_api_key', providerId: payload.providerId, apiKey: payload.apiKey, model: payload.defaultModel }
        : { kind: 'custom_api_key', protocol: payload.customProvider.protocol, baseUrl: payload.customProvider.baseUrl, apiKey: payload.customProvider.apiKey, model: payload.defaultModel };
    // The test call hits the provider over the network; disable the button
    // and show progress so the wait reads as work, not a freeze.
    controller.busy = true;
    setStatus(tr('settings.model_authorization.testing_connection'), '');
    render();
    let succeeded = false;
    try {
      const testOutcome = await invokeResult(
        'modelAuthorizations.testDraft',
        testPayload,
        'settings.model_authorization.error_test_failed',
      );
      if (payload.source === 'ccswitch' && isExpiredCcSwitchDraft(testOutcome.result)) {
        resetExpiredCcSwitchDraft();
        return;
      }
      if (!testOutcome.ok) { setStatus(testOutcome.message, 'error'); return; }
      const completionOutcome = await invokeResult(
        'modelAuthorizations.complete',
        payload,
        'settings.model_authorization.complete_failed',
      );
      if (payload.source === 'ccswitch' && isExpiredCcSwitchDraft(completionOutcome.result)) {
        resetExpiredCcSwitchDraft();
        return;
      }
      if (!completionOutcome.ok) { setStatus(completionOutcome.message, 'error'); return; }
      succeeded = true;
      closeModal();
      await refreshModelAuthorizationSettings();
      if (typeof refreshModelGuard === 'function') await refreshModelGuard();
    } finally {
      controller.busy = false;
      if (succeeded) setStatus('', '');
      if (controller.open) render();
    }
  }

  async function removeAuthorization(authorizationId) {
    const id = normalizeModelId(authorizationId);
    if (!id || controller.removingAuthorizationId) return;
    if (typeof uiConfirm !== 'function' || !(await uiConfirm(tr('settings.model_authorization.confirm_remove_authorization')))) return;
    controller.removingAuthorizationId = id;
    setAuthorizationStatus('', '');
    try {
      const outcome = await invokeResult(
        'modelAuthorizations.remove',
        { authorizationId: id },
        'settings.entries.delete_failed',
      );
      const res = outcome.result;
      if (!outcome.ok || !res || !res.removed) {
        setAuthorizationStatus(outcome.message, 'error');
        return;
      }
      await refreshModelAuthorizationSettings();
      if (typeof refreshModelGuard === 'function') await refreshModelGuard();
    } finally {
      controller.removingAuthorizationId = '';
    }
  }

  async function handleAction(dataset, targetNode) {
    const action = dataset && dataset.modelAuthAction;
    if (!action) return;
    if (action === 'choose-oauth') return chooseAuthType('oauth');
    if (action === 'choose-api-key') return chooseAuthType('api_key');
    if (action === 'source-manual') return chooseApiKeySource('manual');
    if (action === 'source-ccswitch') return chooseApiKeySource('ccswitch');
    if (action === 'choose-provider') return chooseProvider(dataset);
    if (action === 'choose-provider-preset') return chooseProviderPreset(dataset.providerId);
    if (action === 'choose-custom-endpoint') return chooseProtocol('openai');
    if (action === 'retry-providers') return retryProviders();
    if (action === 'choose-protocol') return chooseProtocol(dataset.protocol);
    if (action === 'select-ccswitch') return selectCcswitch(dataset.externalId);
    if (action === 'continue-credentials') return continueCredentials();
    if (action === 'back') { controller.draft = transition(controller.draft, { type: 'back' }); render(); return; }
    if (action === 'cancel') { closeModal(); return; }
    if (action === 'toggle-key-visible') {
      const input = el(dataset.target || 'model-authorization-api-key');
      if (input) {
        const show = input.type !== 'text';
        input.type = show ? 'text' : 'password';
        if (targetNode && typeof targetNode.setAttribute === 'function') {
          targetNode.setAttribute('title', tr(show ? 'settings.model_authorization.key_hide' : 'settings.model_authorization.key_show'));
        }
      }
      return;
    }
    if (action === 'toggle-model') { controller.draft = toggleModel(controller.draft, dataset.modelId, dataset.checked !== 'false'); render(); return; }
    if (action === 'default-model') { controller.draft = setDefaultModel(controller.draft, dataset.modelId); render(); return; }
    if (action === 'add-manual-model') { const input = el('model-authorization-manual-model'); controller.draft = addManualModel(controller.draft, input && input.value); render(); return; }
    if (action === 'complete') return completeDraft();
    if (action === 'remove-authorization') return removeAuthorization(dataset.authorizationId);
  }

  function bindDelegates() {
    for (const id of ['model-authorization-body', 'model-authorization-actions']) {
      const node = el(id);
      if (!node || node.dataset.modelAuthorizationBound) continue;
      node.dataset.modelAuthorizationBound = '1';
      node.addEventListener('click', (event) => handleAction(event && event.target && event.target.dataset, event && event.target));
      node.addEventListener('keydown', (event) => {
        if (!event || event.key !== 'Enter') return;
        if (event.isComposing || event.keyCode === 229) return;
        if (event.preventDefault) event.preventDefault();
        if (controller.draft.step === 'credentials' || controller.draft.step === 'credential_ready') continueCredentials();
      });
    }
    const authorizationList = el('settings-model-authorization-list');
    if (authorizationList && !authorizationList.dataset.modelAuthorizationBound) {
      authorizationList.dataset.modelAuthorizationBound = '1';
      authorizationList.addEventListener('click', (event) => handleAction(event && event.target && event.target.dataset, event && event.target));
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
      const chips = models.map((model) => {
        const id = model.model || model.id || '';
        const isDefault = id === defaultModel;
        return `<span class="model-authorization-model-chip${isDefault ? ' is-default' : ''}">${esc(id)}${isDefault ? '<span class="model-authorization-chip-check">✓</span>' : ''}</span>`;
      }).join('');
      const warning = auth.unbound || auth.warningCode === 'unbound_authorization'
        ? tr('settings.model_authorization.unbound_title')
        : '';
      return `<div class="model-authorization-card" data-authorization-id="${esc(auth.authorizationId || auth.id)}">
        <div class="model-authorization-card-head">
          <div>
            <div class="model-authorization-card-title">${esc(auth.label || auth.providerLabel || auth.authorizationId || auth.id)}</div>
            <div class="model-authorization-card-meta"><span class="model-authorization-auth-type">${esc(auth.authType || '')}</span><span>${esc(auth.source || '')}</span></div>
          </div>
          <button type="button" class="btn btn-sm btn-danger" data-model-auth-action="remove-authorization" data-authorization-id="${esc(auth.authorizationId || auth.id)}">${esc(tr('settings.model_authorization.remove_authorization'))}</button>
        </div>
        ${warning ? `<div class="model-authorization-warning">${esc(warning)}</div>` : ''}
        ${chips ? `<div class="model-authorization-model-chips">${chips}</div>` : ''}
      </div>`;
    }).join('');
  }

  async function refreshModelAuthorizationSettings() {
    const outcome = await invokeResult(
      'modelAuthorizations.list',
      undefined,
      'settings.model_authorization.authorization_list_failed',
    );
    if (!outcome.ok) {
      setAuthorizationStatus(outcome.message, 'error');
      renderAuthorizationCards();
      return;
    }
    const res = outcome.result;
    controller.authorizations = (res && Array.isArray(res.authorizations)) ? res.authorizations : (Array.isArray(res) ? res : []);
    setAuthorizationStatus('', '');
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
