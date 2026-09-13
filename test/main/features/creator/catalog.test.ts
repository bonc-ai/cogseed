import { describe, expect, it, vi } from 'vitest';
import {
  buildCreatorCapabilityCatalog,
  sanitizeCreatorCapabilityCatalog,
  validateCreatorCatalogSnapshot,
} from '../../../../src/main/features/creator/catalog';

const SENSITIVE_PROJECTED_VALUES = [
  '/opt/private/catalog-secret',
  '/Users/private/catalog-secret',
  '/home/private/catalog-secret',
  'C:\\private\\catalog-secret',
  '\\private\\catalog-secret',
  '\\\\private-server\\catalog-secret',
  '//private-server/catalog-secret',
  '\\\\?\\C:\\private\\catalog-secret',
  'ssh://private.internal/model',
  'custom+scheme://private.internal/value',
  'custom+scheme:private.internal/value',
  'Format:JSON labels are useful.',
  'Use \\alpha notation in formulas.',
  'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
  'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
  'glpat-abcdefghijklmnopqrstuvwxyz1234567890',
  'npm_abcdefghijklmnopqrstuvwxyz1234567890',
  'pypi-abcdefghijklmnopqrstuvwxyz1234567890',
  'ya29.abcdefghijklmnopqrstuvwxyz1234567890',
  'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
  'AKIAABCDEFGHIJKLMNOP',
  'xoxb-abcdefghijklmnopqrstuvwxyz123456',
  'Bearer abcdefghijklmnopqrstuvwxyz123456',
  'token=private-catalog-credential',
  'catalog\u0000secret',
  'catalog\u0085secret',
  'x'.repeat(500),
] as const;

const DEPENDENCY_ERROR_SECRETS = [
  '/opt/private/catalog-source',
  'C:\\private\\catalog-source',
  'custom+scheme://private.internal/catalog',
  'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
] as const;

function dependencyError(): Error {
  return new Error(`provider failure: ${DEPENDENCY_ERROR_SECRETS.join(' ')}`);
}

function exposedErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [error.name, error.message, error.stack ?? '', JSON.stringify(error)].join('\n');
}

describe('Creator capability catalog', () => {
  it.each(['tool.shell', 'tool.browser', 'tool.connector'])('rejects caller-invented available %s descriptors', (capabilityId) => {
    const descriptor = {
      capabilityId, version: '1', kind: 'tool' as const, displayName: capabilityId,
      available: true, permissions: ['read', 'network'] as const,
      sourceRef: 'agent-capability.forged', health: 'ready' as const,
    };
    expect(validateCreatorCatalogSnapshot([descriptor])).toEqual({ valid: false, catalog: [] });
    expect(sanitizeCreatorCapabilityCatalog([descriptor])).toEqual([]);
  });

  it.each([
    ['model', {
      capabilityId: 'model.provider-main.forged-model', version: '1', kind: 'model' as const,
      displayName: 'Forged model', available: true, permissions: ['cost'] as const,
      sourceRef: 'attacker.source', health: 'ready' as const,
    }],
    ['skill', {
      capabilityId: 'skill.forged-skill', version: '1', kind: 'skill' as const,
      displayName: 'Forged skill', available: true, permissions: ['read'] as const,
      sourceRef: 'attacker.source', health: 'ready' as const,
    }],
  ])('rejects caller-invented available %s provenance', (_kind, descriptor) => {
    expect(validateCreatorCatalogSnapshot([descriptor])).toEqual({ valid: false, catalog: [] });
  });

  it.each([
    ['model provider mismatch', {
      capabilityId: 'model.provider-main.model-a', version: '1', kind: 'model' as const,
      displayName: 'Model A', available: true, permissions: ['cost'] as const,
      sourceRef: 'provider.attacker', health: 'ready' as const,
    }],
    ['model network permission', {
      capabilityId: 'model.provider-main.model-a', version: '1', kind: 'model' as const,
      displayName: 'Model A', available: true, permissions: ['network'] as const,
      sourceRef: 'provider.provider-main', health: 'ready' as const,
    }],
    ['skill source mismatch', {
      capabilityId: 'skill.skill-a', version: '1', kind: 'skill' as const,
      displayName: 'Skill A', available: true, permissions: ['read'] as const,
      sourceRef: 'skill.attacker.other', health: 'ready' as const,
    }],
    ['skill side effect permission', {
      capabilityId: 'skill.skill-a', version: '1', kind: 'skill' as const,
      displayName: 'Skill A', available: true, permissions: ['side-effect'] as const,
      sourceRef: 'skill.custom.skill-a', health: 'ready' as const,
    }],
  ])('rejects forged canonical %s', (_name, descriptor) => {
    expect(validateCreatorCatalogSnapshot([descriptor])).toEqual({ valid: false, catalog: [] });
  });

  it('does not invoke a caller-supplied permissions iterator or method', () => {
    let someCalled = false;
    const descriptor = {
      capabilityId: 'model.provider-main.model-a', version: '1', kind: 'model' as const,
      displayName: 'Model A', available: true, sourceRef: 'provider.provider-main', health: 'ready' as const,
      permissions: Object.assign(['cost'], {
        some: () => { someCalled = true; throw new Error('permissions method must not run'); },
      }),
    };
    expect(validateCreatorCatalogSnapshot([descriptor])).toEqual({ valid: true, catalog: [expect.anything()] });
    expect(someCalled).toBe(false);
  });

  it('fails closed for proxy and inherited descriptor keys without walking unbounded input', () => {
    const inherited = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 100_000; index += 1) inherited[`inherited-${index}`] = true;
    const descriptor = Object.assign(Object.create(inherited), {
      capabilityId: 'model.provider-main.model-a', version: '1', kind: 'model',
      displayName: 'Model A', available: true, permissions: ['cost'],
      sourceRef: 'provider.provider-main', health: 'ready',
    });
    expect(validateCreatorCatalogSnapshot([descriptor])).toEqual({ valid: false, catalog: [] });

    const hostile = new Proxy(descriptor, { ownKeys() { throw new Error('/private/key token=secret'); } });
    expect(validateCreatorCatalogSnapshot([hostile])).toEqual({ valid: false, catalog: [] });
  });

  it('bounds provider fan-out, model collection, and concurrency deterministically', async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const catalog = await buildCreatorCapabilityCatalog('user-1', {
      getActiveUserId: () => 'user-1',
      listProviders: async () => ({ providers: Array.from({ length: 200 }, (_unused, index) => ({ id: `provider-${index}`, profiles: [{}] })) as never[] }),
      listModels: async (_userId, providerId) => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { models: Array.from({ length: 1_000 }, (_unused, index) => ({ id: `${providerId}-model-${index}`, name: `${providerId} model ${index}` })) };
      },
      listSkills: async () => [],
    });
    expect(calls).toBeLessThanOrEqual(64);
    expect(peak).toBeLessThanOrEqual(4);
    expect(catalog.filter((entry) => entry.kind === 'model')).toHaveLength(24);
    expect(catalog).toHaveLength(33);
  });

  it('caps rejected descriptor and no-profile provider traversal', async () => {
    let modelCalls = 0;
    let rejectedVisited = 0;
    const rejectedValues = Array.from({ length: 10_000 }, (_unused, index) => ({
      kind: 'unknown', capabilityId: `ignored-${index}`,
    }));
    const rejected = {
      *[Symbol.iterator]() {
        for (const value of rejectedValues) {
          rejectedVisited += 1;
          yield value;
        }
      },
    } as unknown as readonly unknown[];
    const sanitized = sanitizeCreatorCapabilityCatalog(rejected);
    expect(sanitized).toEqual([]);
    expect(rejectedVisited).toBeLessThanOrEqual(256);

    let providersVisited = 0;
    const providerValues = Array.from({ length: 10_000 }, (_unused, index) => ({ id: `empty-${index}`, profiles: [] }));
    const catalog = await buildCreatorCapabilityCatalog('user-1', {
      getActiveUserId: () => 'user-1',
      listProviders: async () => ({ providers: {
        *[Symbol.iterator]() {
          for (const value of providerValues) {
            providersVisited += 1;
            yield value;
          }
        },
      } as never }),
      listModels: async () => { modelCalls += 1; return { models: [] }; },
      listSkills: async () => [],
    });
    expect(modelCalls).toBe(0);
    expect(providersVisited).toBeLessThanOrEqual(256);
    expect(catalog.filter((entry) => entry.kind === 'model')).toHaveLength(0);
  });
  it.each(['providers', 'models', 'skills'] as const)(
    'replaces raw %s dependency failures with a stable non-sensitive error',
    async (dependency) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const promise = buildCreatorCapabilityCatalog('user-1', {
          getActiveUserId: () => 'user-1',
          listProviders: async () => {
            if (dependency === 'providers') throw dependencyError();
            return { providers: dependency === 'models' ? [{ id: 'provider-main', profiles: [{}] }] as never[] : [] };
          },
          listModels: async () => { throw dependencyError(); },
          listSkills: async () => {
            if (dependency === 'skills') throw dependencyError();
            return [];
          },
        });

        let failure: unknown;
        try {
          await promise;
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('creator_catalog_dependency_failed');
        const exposed = [
          exposedErrorText(failure),
          JSON.stringify(consoleError.mock.calls),
          JSON.stringify(consoleWarn.mock.calls),
        ].join('\n');
        for (const secret of DEPENDENCY_ERROR_SECRETS) expect(exposed).not.toContain(secret);
      } finally {
        consoleError.mockRestore();
        consoleWarn.mockRestore();
      }
    },
  );

  it.each(SENSITIVE_PROJECTED_VALUES)(
    'never projects sensitive or unbounded value %j from any descriptor string field',
    (sensitiveValue) => {
      const fields = ['capabilityId', 'version', 'displayName', 'sourceRef'] as const;
      for (const field of fields) {
        const descriptor = {
          capabilityId: 'model.provider.model',
          version: '2.3.4',
          kind: 'model' as const,
          displayName: 'Model name',
          available: true,
          permissions: ['cost'] as const,
          sourceRef: 'provider.provider',
          health: 'ready' as const,
          [field]: sensitiveValue,
        };

        const serialized = JSON.stringify(sanitizeCreatorCapabilityCatalog([descriptor]));
        expect(serialized, `${field} leaked a provider-controlled value`).not.toContain(sensitiveValue);
        expect(serialized).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
      }
    },
  );

  it('preserves ordinary projected identifiers and semantic versions', () => {
    expect(sanitizeCreatorCapabilityCatalog([{
      capabilityId: 'model.provider_alpha.model-v2',
      version: '2.3.4-beta.1+build.7',
      kind: 'model',
      displayName: 'Model Alpha v2',
      available: true,
      permissions: ['cost'],
      sourceRef: 'provider.provider_alpha',
      health: 'ready',
    }])).toEqual([{
      capabilityId: 'model.provider_alpha.model-v2',
      version: '2.3.4-beta.1+build.7',
      kind: 'model',
      displayName: 'Model Alpha v2',
      available: true,
      permissions: ['cost'],
      sourceRef: 'provider.provider_alpha',
      health: 'ready',
    }]);
  });

  it('bounds nested permissions and display-name work before projection', () => {
    const descriptor = {
      capabilityId: 'model.provider.model', version: '1', kind: 'model' as const,
      displayName: 'x'.repeat(1_000_000), available: true,
      permissions: Array.from({ length: 100_000 }, () => 'cost'),
      sourceRef: 'provider.provider', health: 'ready' as const,
    };
    const result = sanitizeCreatorCapabilityCatalog([descriptor]);
    expect(result).toEqual([]);
  });

  it('fails closed for an iterator that throws instead of returning partial catalog data', () => {
    const malformed = {
      [Symbol.iterator]() { throw new Error('/private/catalog iterator ssh://private.invalid ghp_secret'); },
    } as unknown as readonly unknown[];
    expect(() => sanitizeCreatorCapabilityCatalog(malformed)).toThrow('creator_catalog_dependency_failed');
  });

  it('fails closed when a catalog snapshot array length trap is accessed', () => {
    const hostile = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('/private/catalog length ssh://private.invalid token=secret');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => validateCreatorCatalogSnapshot(hostile)).not.toThrow();
    expect(validateCreatorCatalogSnapshot(hostile)).toEqual({ valid: false, catalog: [] });
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['infinite', Number.POSITIVE_INFINITY],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s catalog snapshot length', (_name, length) => {
    const hostile = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') return length;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(validateCreatorCatalogSnapshot(hostile)).toEqual({ valid: false, catalog: [] });
  });

  it.each(SENSITIVE_PROJECTED_VALUES)(
    'sanitizes sensitive upstream value %j in every catalog-producing field',
    async (sensitiveValue) => {
      const fields = [
        'providerId',
        'modelId',
        'modelName',
        'skillId',
        'skillName',
        'skillVersion',
        'skillSource',
      ] as const;

      for (const field of fields) {
        const providerId = field === 'providerId' ? sensitiveValue : 'provider-main';
        const modelId = field === 'modelId' ? sensitiveValue : 'model-main';
        const modelName = field === 'modelName' ? sensitiveValue : 'Model main';
        const skillId = field === 'skillId' ? sensitiveValue : 'skill-main';
        const skillName = field === 'skillName' ? sensitiveValue : 'Skill main';
        const skillVersion = field === 'skillVersion' ? sensitiveValue : '2.3.4';
        const skillSource = field === 'skillSource' ? sensitiveValue : 'custom';
        const catalog = await buildCreatorCapabilityCatalog('user-1', {
          getActiveUserId: () => 'user-1',
          listProviders: async () => ({ providers: [{ id: providerId, profiles: [{}] }] as never[] }),
          listModels: async () => ({ models: [{ id: modelId, name: modelName }] }),
          listSkills: async () => ([{
            id: skillId,
            name: skillName,
            source: skillSource,
            version: skillVersion,
            enabled: true,
            security: { status: 'verified' },
          }] as never[]),
        });

        const serialized = JSON.stringify(catalog);
        expect(serialized, `${field} leaked a provider-controlled value`).not.toContain(sensitiveValue);
        expect(serialized).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
      }
    },
  );

  it('builds bounded descriptors without exposing provider or skill secrets', async () => {
    const secrets = {
      baseUrl: 'https://private-provider.example/v1',
      masked: 'sk-private...9999',
      email: 'employee@example.internal',
      path: '/Users/private/skills/research/SKILL.md',
      endpoint: 'http://127.0.0.1:9444/private',
      token: 'peer-secret-token',
    };
    const catalog = await buildCreatorCapabilityCatalog('user-1', {
      getActiveUserId: () => 'user-1',
      listProviders: async () => ({ providers: [{
        id: 'deepseek', label: 'DeepSeek', profiles: [{
          profileId: 'profile-1', provider: 'deepseek', label: 'Private', type: 'api_key',
          masked: secrets.masked, baseUrl: secrets.baseUrl, email: secrets.email,
          createdAt: 1, lastUsed: 1,
        }],
      }] as never[] }),
      listModels: async () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
      listSkills: async () => ([
        { id: 'research', name: 'Research', source: 'custom', enabled: true, version: '2.0.0', path: secrets.path, security: { status: 'verified' } },
        { id: 'unsafe', name: 'Unsafe', source: 'marketplace', enabled: true, security: { status: 'withheld' } },
      ] as never[]),
    });

    expect(catalog).toContainEqual({
      capabilityId: 'model.deepseek.deepseek-chat', version: '1', kind: 'model',
      displayName: 'DeepSeek Chat', available: true, permissions: ['cost'],
      sourceRef: 'provider.deepseek', health: 'ready',
    });
    expect(catalog).toContainEqual({
      capabilityId: 'skill.research', version: '2.0.0', kind: 'skill',
      displayName: 'Research', available: true, permissions: ['read'],
      sourceRef: 'skill.custom.research', health: 'ready',
    });
    expect(catalog).toContainEqual(expect.objectContaining({
      capabilityId: 'skill.unsafe', available: false, health: 'unavailable',
    }));
    expect(catalog).toContainEqual(expect.objectContaining({
      capabilityId: 'tool.shell', kind: 'tool', available: false,
      permissions: ['side-effect'], health: 'unavailable',
    }));

    expect(catalog.every((item) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.capabilityId))).toBe(true);
    expect(new Set(catalog.map((item) => item.capabilityId)).size).toBe(catalog.length);

    const serialized = JSON.stringify(catalog);
    for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/baseUrl|masked|email|path|endpoint|dial_token|Authorization/i);
  });


  it('does not collapse distinct upstream identifiers into the same logical capability id', async () => {
    const catalog = await buildCreatorCapabilityCatalog('user-1', {
      getActiveUserId: () => 'user-1',
      listProviders: async () => ({ providers: [
        { id: 'a.b', label: 'First', profiles: [{}] },
        { id: 'a', label: 'Second', profiles: [{}] },
      ] as never[] }),
      listModels: async (_userId, providerId) => ({ models: providerId === 'a.b'
        ? [{ id: 'c', name: 'First model' }]
        : [{ id: 'b.c', name: 'Second model' }] }),
      listSkills: async () => [],
    });

    const modelIds = catalog.filter((item) => item.kind === 'model').map((item) => item.capabilityId);
    expect(modelIds).toHaveLength(2);
    expect(new Set(modelIds).size).toBe(2);
  });

  it('redacts, sanitizes, validates, and bounds strings that are actually projected', async () => {
    const secretId = 'sk-proj-abcdefghijklmnopqrstuvwx';
    const secretProviderId = 'token=provider-secret-value';
    const secretSkillId = 'password=skill-secret-value';
    const secretName = 'Bearer abcDEF1234567890secret';
    const urlName = 'https://private.invalid/model';
    const pathName = '/Users/private/skills/unsafe';
    const oversizedName = 'x'.repeat(500);
    const catalog = await buildCreatorCapabilityCatalog('user-1', {
      getActiveUserId: () => 'user-1',
      listProviders: async () => ({ providers: [
        { id: 'provider-main', profiles: [{}] },
        { id: secretProviderId, profiles: [{}] },
      ] as never[] }),
      listModels: async (_userId, providerId) => ({ models: providerId === 'provider-main' ? [
        { id: 'url-model', name: urlName },
        { id: secretId, name: oversizedName },
        { id: 'control-model', name: 'Clean\u0000Name' },
      ] : [{ id: 'provider-model', name: 'Provider model' }] }),
      listSkills: async () => ([
        { id: 'path-skill', name: pathName, source: 'custom', enabled: true, version: '2.0.0', security: { status: 'verified' } },
        { id: 'secret-skill', name: secretName, source: 'marketplace', enabled: true, version: '../unsafe', security: { status: 'verified' } },
        { id: secretSkillId, name: 'Safe skill', source: 'custom', enabled: true, version: '1.0.0', security: { status: 'verified' } },
      ] as never[]),
    });

    const serialized = JSON.stringify(catalog);
    for (const raw of [secretId, secretProviderId, secretSkillId, secretName, urlName, pathName, oversizedName]) {
      expect(serialized).not.toContain(raw);
    }
    expect(catalog.find((entry) => entry.capabilityId === 'model.provider-main.url-model')?.displayName)
      .toBe('[REDACTED]');
    expect(catalog.find((entry) => entry.capabilityId === 'model.provider-main.control-model')?.displayName)
      .toBe('[REDACTED]');
    expect(catalog.find((entry) => entry.kind === 'model' && entry.displayName.startsWith('x'))?.displayName.length)
      .toBeLessThanOrEqual(160);
    expect(catalog.find((entry) => entry.capabilityId === 'skill.path-skill')?.displayName)
      .toBe('[REDACTED]');
    expect(catalog.find((entry) => entry.capabilityId === 'skill.secret-skill')).toMatchObject({
      displayName: '[REDACTED]', version: '1', available: false, health: 'unavailable',
    });
    expect(catalog.every((entry) => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(entry.version))).toBe(true);
  });

  it('fails closed when asked to inspect a non-active user', async () => {
    await expect(buildCreatorCapabilityCatalog('user-2', {
      getActiveUserId: () => 'user-1',
      listProviders: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
      listSkills: async () => [],
    })).rejects.toThrow('creator_user_not_active');
  });

  it('passes the requested user to skill listing after provider/model awaits switch the active user', async () => {
    let activeUserId = 'user-1';
    const catalog = await buildCreatorCapabilityCatalog('user-1', {
      getActiveUserId: () => activeUserId,
      listProviders: async () => ({ providers: [{ id: 'provider-main', profiles: [{}] }] }),
      listModels: async () => {
        await Promise.resolve();
        activeUserId = 'user-2';
        return { models: [{ id: 'model-a', name: 'Model A' }] };
      },
      listSkills: async (requestedUserId?: string) => {
        expect(requestedUserId).toBe('user-1');
        return [];
      },
    });

    expect(catalog.some((entry) => entry.capabilityId === 'model.provider-main.model-a')).toBe(true);
  });

  it('passes the requested user to provider and model dependencies across awaited work', async () => {
    let activeUserId = 'user-1';
    const catalog = await buildCreatorCapabilityCatalog('user-1', {
      getActiveUserId: () => activeUserId,
      listProviders: async (requestedUserId?: string) => {
        expect(requestedUserId).toBe('user-1');
        await Promise.resolve();
        activeUserId = 'user-2';
        return { providers: [{ id: 'provider-main', profiles: [{}] }] };
      },
      listModels: async (requestedUserId?: string, providerId?: string) => {
        expect(requestedUserId).toBe('user-1');
        expect(providerId).toBe('provider-main');
        return { models: [{ id: 'model-a', name: 'Model A' }] };
      },
      listSkills: async (requestedUserId?: string) => {
        expect(requestedUserId).toBe('user-1');
        return [];
      },
    });

    expect(catalog.some((entry) => entry.capabilityId === 'model.provider-main.model-a')).toBe(true);
  });
});
