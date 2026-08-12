import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const flowPath = resolve(__dirname, '../../src/renderer/modules/model-authorization.js');

describe('model authorization pure wizard state', () => {
  function loadFlow() {
    delete require.cache[flowPath];
    return require(flowPath);
  }

  it('moves through OAuth, manual API key, and CC Switch source transitions', () => {
    const flow = loadFlow();
    const draft = flow.createDraft();

    const apiKey = flow.transition(draft, { type: 'choose_auth_type', authType: 'api_key' });
    expect(apiKey.step).toBe('api_key_source');

    const manual = flow.transition(apiKey, { type: 'choose_api_key_source', source: 'manual' });
    expect(manual).toMatchObject({ authType: 'api_key', source: 'manual', step: 'provider_preset' });

    const ccswitch = flow.transition(apiKey, { type: 'choose_api_key_source', source: 'ccswitch' });
    expect(ccswitch).toMatchObject({ authType: 'api_key', source: 'ccswitch', step: 'ccswitch_select' });

    const oauth = flow.transition(draft, { type: 'choose_auth_type', authType: 'oauth' });
    expect(oauth).toMatchObject({ authType: 'oauth', source: 'oauth', step: 'provider' });
  });

  it('preselects a builtin provider preset and auto-selects its catalog models', () => {
    const flow = loadFlow();
    let draft = flow.transition(flow.createDraft(), { type: 'choose_auth_type', authType: 'api_key' });
    draft = flow.transition(draft, { type: 'choose_api_key_source', source: 'manual' });
    expect(draft.step).toBe('provider_preset');

    draft = flow.transition(draft, { type: 'choose_provider', providerId: 'deepseek', providerKind: 'builtin' });
    expect(draft).toMatchObject({ providerKind: 'builtin', providerId: 'deepseek', step: 'credentials' });

    draft = flow.transition(draft, {
      type: 'set_api_key_credentials',
      providerKind: 'builtin',
      providerId: 'deepseek',
      apiKey: 'sk-test',
    });
    expect(draft.preselectAll).toBe(true);

    draft = flow.applyDiscovery(flow.transition(draft, { type: 'begin_discovery', token: 't3' }), {
      token: 't3',
      ok: true,
      models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ],
    });
    expect(draft.selectedModels).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);
    expect(draft.defaultModel).toBe('deepseek-v4-pro');
    expect(draft.step).toBe('models');

    const payload = flow.buildCompletionPayload(draft);
    expect(payload).toMatchObject({
      authType: 'api_key',
      source: 'manual',
      providerKind: 'builtin',
      providerId: 'deepseek',
      apiKey: 'sk-test',
      selectedModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
      defaultModel: 'deepseek-v4-pro',
    });
  });

  it('keeps the custom protocol path when the custom endpoint card is used', () => {
    const flow = loadFlow();
    let draft = flow.transition(flow.createDraft(), { type: 'choose_auth_type', authType: 'api_key' });
    draft = flow.transition(draft, { type: 'choose_api_key_source', source: 'manual' });
    draft = flow.transition(draft, { type: 'choose_provider', providerId: 'openai', providerKind: 'custom' });
    expect(draft).toMatchObject({ providerKind: 'custom', providerId: 'openai', step: 'credentials' });

    draft = flow.transition(draft, {
      type: 'set_api_key_credentials',
      providerKind: 'custom',
      providerId: 'openai',
      protocol: 'openai',
      name: 'api.example.test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.test/v1',
    });
    expect(draft.preselectAll).toBe(false);
    expect(draft.customProvider).toMatchObject({ protocol: 'openai', baseUrl: 'https://api.example.test/v1' });
    expect(draft.credential).toMatchObject({ apiKey: 'sk-test', baseUrl: 'https://api.example.test/v1' });
  });

  it('serializes drafts without secret values', () => {
    const flow = loadFlow();
    const draft = flow.transition(flow.createDraft(), {
      type: 'set_api_key_credentials',
      providerKind: 'custom',
      protocol: 'openai',
      baseUrl: 'https://models.example.test/v1',
      apiKey: 'sk-secret-value',
    });

    const safe = flow.serializeSafeDraft(draft);
    expect(JSON.stringify(safe)).not.toContain('sk-secret-value');
    expect(safe).toMatchObject({ credential: { hasApiKey: true } });
  });

  it('normalizes discovered models, deduplicates ids, and preselects declared CC Switch models only when found', () => {
    const flow = loadFlow();
    let draft = flow.transition(flow.createDraft(), { type: 'choose_auth_type', authType: 'api_key' });
    draft = flow.transition(draft, { type: 'choose_api_key_source', source: 'ccswitch' });
    draft = flow.transition(draft, { type: 'begin_discovery', token: 'newest' });

    const discovered = flow.applyDiscovery(draft, {
      token: 'newest',
      ok: true,
      declaredModels: ['claude-3-5-sonnet', 'missing-model'],
      models: [
        { id: ' claude-3-5-sonnet ', name: 'Sonnet' },
        { id: 'gpt-5.6-sol', name: 'GPT' },
        { id: 'claude-3-5-sonnet', name: 'Duplicate' },
        { id: '' },
      ],
    });

    expect(discovered.models.map((model: any) => model.id)).toEqual(['claude-3-5-sonnet', 'gpt-5.6-sol']);
    expect(discovered.selectedModels).toEqual(['claude-3-5-sonnet']);
    expect(discovered.defaultModel).toBe('claude-3-5-sonnet');

    const withoutDeclarations = flow.applyDiscovery(draft, {
      token: 'newest',
      ok: true,
      models: [{ id: 'gpt-5.6-sol' }],
    });
    expect(withoutDeclarations.selectedModels).toEqual([]);
    expect(withoutDeclarations.defaultModel).toBe('');
  });

  it('keeps stale discovery responses from mutating the active draft', () => {
    const flow = loadFlow();
    let draft = flow.transition(flow.createDraft(), { type: 'choose_auth_type', authType: 'api_key' });
    draft = flow.transition(draft, { type: 'begin_discovery', token: 'current' });

    const stale = flow.applyDiscovery(draft, {
      token: 'old',
      ok: true,
      models: [{ id: 'should-not-appear' }],
    });

    expect(stale).toEqual(draft);
  });

  it('requires selected defaults while toggling models and setting defaults', () => {
    const flow = loadFlow();
    let draft = flow.applyDiscovery(flow.transition(flow.createDraft(), { type: 'begin_discovery', token: 't1' }), {
      token: 't1',
      ok: true,
      models: [{ id: 'a' }, { id: 'b' }],
    });

    draft = flow.toggleModel(draft, 'a', true);
    draft = flow.setDefaultModel(draft, 'a');
    draft = flow.toggleModel(draft, 'b', true);
    expect(draft).toMatchObject({ selectedModels: ['a', 'b'], defaultModel: 'a' });

    draft = flow.toggleModel(draft, 'a', false);
    expect(draft).toMatchObject({ selectedModels: ['b'], defaultModel: 'b' });

    expect(() => flow.setDefaultModel(draft, 'a')).toThrow(/selected/);
  });

  it('accepts manual model IDs only for unsupported discovery', () => {
    const flow = loadFlow();
    const draft = flow.applyDiscovery(flow.transition(flow.createDraft(), { type: 'begin_discovery', token: 'manual' }), {
      token: 'manual',
      ok: false,
      errorCode: 'unsupported_discovery',
    });

    const withManual = flow.addManualModel(draft, 'manual-model');
    expect(withManual.selectedModels).toEqual(['manual-model']);
    expect(withManual.defaultModel).toBe('manual-model');

    expect(() => flow.addManualModel(flow.createDraft(), 'not-allowed')).toThrow(/unsupported_discovery/);
  });

  it('builds completion payloads with selected/default models and active credential source', () => {
    const flow = loadFlow();
    let draft = flow.transition(flow.createDraft(), { type: 'choose_auth_type', authType: 'api_key' });
    draft = flow.transition(draft, { type: 'choose_api_key_source', source: 'ccswitch' });
    draft = flow.transition(draft, { type: 'ccswitch_ready', draftId: 'draft-1', externalId: 'row-1' });
    draft = flow.applyDiscovery(flow.transition(draft, { type: 'begin_discovery', token: 't2' }), {
      token: 't2',
      ok: true,
      declaredModels: ['a'],
      models: [{ id: 'a' }, { id: 'b' }],
    });

    expect(flow.buildCompletionPayload(draft)).toMatchObject({
      authType: 'api_key',
      providerKind: 'builtin',
      source: 'ccswitch',
      requestId: 'draft-1',
      selectedModels: ['a'],
      defaultModel: 'a',
    });
  });

  it('steps back through the active flow without discarding entered data', () => {
    const flow = loadFlow();
    let draft = flow.transition(flow.createDraft(), { type: 'choose_auth_type', authType: 'api_key' });
    draft = flow.transition(draft, { type: 'choose_api_key_source', source: 'manual' });
    draft = flow.transition(draft, { type: 'choose_provider', providerId: 'deepseek', providerKind: 'builtin' });
    draft = flow.transition(draft, {
      type: 'set_api_key_credentials',
      providerKind: 'builtin',
      providerId: 'deepseek',
      apiKey: 'sk-test',
    });
    draft = flow.applyDiscovery(flow.transition(draft, { type: 'begin_discovery', token: 't-back' }), {
      token: 't-back',
      ok: true,
      models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
    });
    expect(draft.step).toBe('models');

    // Back from model selection → credentials, keeping key and selections.
    const back1 = flow.transition(draft, { type: 'back' });
    expect(back1.step).toBe('credential_ready');
    expect(back1.credential.apiKey).toBe('sk-test');
    expect(back1.selectedModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);

    // Back from credentials → provider preset (entered data retained).
    const back2 = flow.transition(back1, { type: 'back' });
    expect(back2.step).toBe('provider_preset');
    expect(back2.providerId).toBe('deepseek');

    // Backing out of the discovering transition lands on credentials too.
    const discovering = flow.transition(back2, { type: 'choose_provider', providerId: 'deepseek', providerKind: 'builtin' });
    const mid = flow.transition(discovering, { type: 'begin_discovery', token: 't-mid' });
    expect(mid.step).toBe('discovering');
    expect(flow.transition(mid, { type: 'back' }).step).toBe('credential_ready');

    // CC Switch flow and OAuth flow walk their own sequences.
    let cc = flow.transition(flow.createDraft(), { type: 'choose_auth_type', authType: 'api_key' });
    cc = flow.transition(cc, { type: 'choose_api_key_source', source: 'ccswitch' });
    expect(flow.transition(cc, { type: 'back' }).step).toBe('api_key_source');

    let oauth = flow.transition(flow.createDraft(), { type: 'choose_auth_type', authType: 'oauth' });
    oauth = flow.transition(oauth, { type: 'choose_provider', providerId: 'anthropic', providerKind: 'builtin' });
    expect(oauth.step).toBe('oauth_signin');
    expect(flow.transition(oauth, { type: 'back' }).step).toBe('provider');
  });
});
