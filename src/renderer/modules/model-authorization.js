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
      return repairSelection(next);
    }
    if (type === 'choose_api_key_source') {
      if (next.authType !== 'api_key') throw new Error('api key auth type required');
      if (action.source !== 'manual' && action.source !== 'ccswitch') throw new Error('invalid api key source');
      next.source = action.source;
      next.step = action.source === 'ccswitch' ? 'ccswitch_select' : 'provider';
      next.credential = {};
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
  });

  if (typeof window !== 'undefined') window.ModelAuthorizationFlow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
