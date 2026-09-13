import { describe, expect, it, vi } from 'vitest';

import type { Agent, CreateAgentOptions, UpdateAgentFields } from '../../../../src/main/features/agents';
import type { CreatorAgentBinding } from '../../../../src/main/features/creator/agent-binding-store';
import {
  createCreatorPresetMaterializer,
  type CreatorMaterializerDependencies,
} from '../../../../src/main/features/creator/materializer';
import type { CreatorAuditRecord, CreatorPresetDraft } from '../../../../src/main/features/creator/store';
import type { CreatorPresetManifestV1 } from '../../../../src/main/features/creator/types';
import { creatorCatalogLogicalId } from '../../../../src/main/features/creator/catalog';
import { creatorManifestDigest } from '../../../../src/main/features/creator/verification-service';

const userId = 'creator-materializer-user';

function manifest(version = '1'): CreatorPresetManifestV1 {
  return {
    schemaVersion: 1,
    presetId: 'local-research',
    version,
    displayName: 'Local research agent',
    description: 'Produces bounded research with citations.',
    presetType: 'cogseed-agent',
    model: { providerId: 'provider-main', modelId: 'deepseek-chat' },
    capabilities: [
      { capabilityId: 'skill.research', version: '1' },
      { capabilityId: 'tool.search', version: '1' },
    ],
    prompt: { systemSections: ['research', 'citations'], locale: 'en' },
    runtime: {
      sessionPolicy: 'new-per-run',
      memoryPolicy: 'read-only',
      loopPolicy: 'single-agent',
      sandboxProfile: 'creator-read-only-v1',
      timeoutMs: 60_000,
      budget: { maxCost: 2, maxTokens: 8_000 },
    },
    permissions: {
      tools: ['tool.search'],
      files: ['workspace.readonly'],
      sideEffects: [],
      approvalMode: 'always',
    },
    provenance: {
      createdBy: 'creator-agent',
      sourceSessionId: 'creator-session-1',
      sourceAssetRefs: [],
    },
  };
}

function agent(agentId = 'agentabc12345'): Agent {
  return {
    agent_id: agentId,
    name: 'Local research agent',
    description_zh: '',
    description_en: 'Produces bounded research with citations.',
    workflow: 'bounded workflow',
    skill_list: ['research'],
    source: 'custom',
    created_at: '2026-08-21T06:00:00.000Z',
    updated_at: '2026-08-21T06:00:00.000Z',
    category: 'general',
    enabled: true,
  };
}

function publishedAudit(value: CreatorPresetManifestV1): CreatorAuditRecord[] {
  const digest = creatorManifestDigest(value);
  const draftId = `draft-${value.presetId}`;
  const verificationRunId = `verify-${value.version}`;
  const capabilities = value.capabilities.map((item) => item.capabilityId);
  return [{
    schemaVersion: 1,
    auditId: 'audit-draft-saved',
    event: 'draft.saved',
    createdAt: '2026-08-21T05:59:00.000Z',
    draftId,
    presetId: value.presetId,
    version: value.version,
    metadata: { manifestDigest: digest },
  }, {
    schemaVersion: 1,
    auditId: 'audit-sandboxed',
    event: 'creator.lifecycle.sandboxed',
    createdAt: '2026-08-21T06:00:00.000Z',
    draftId,
    presetId: value.presetId,
    metadata: { manifestDigest: digest },
  }, {
    schemaVersion: 1,
    auditId: 'audit-verification-recorded',
    event: 'creator.verification.recorded',
    createdAt: '2026-08-21T06:00:30.000Z',
    draftId,
    presetId: value.presetId,
    metadata: { manifestDigest: digest, verificationRunId, status: 'passed' },
  }, {
    schemaVersion: 1,
    auditId: 'audit-verified',
    event: 'creator.lifecycle.verified',
    createdAt: '2026-08-21T06:01:00.000Z',
    draftId,
    presetId: value.presetId,
    metadata: { manifestDigest: digest, verificationRunId },
  }, {
    schemaVersion: 1,
    auditId: 'audit-approved',
    event: 'creator.lifecycle.approved',
    createdAt: '2026-08-21T06:02:00.000Z',
    draftId,
    presetId: value.presetId,
    metadata: {
      manifestDigest: digest,
      verificationRunId,
      actorId: 'user-reviewer',
      confirmedAt: '2026-08-21T06:02:00.000Z',
      approvedCapabilities: capabilities,
      approvedSideEffects: value.permissions.sideEffects,
    },
  }, {
    schemaVersion: 1,
    auditId: 'audit-version-published',
    event: 'preset.version_published',
    createdAt: '2026-08-21T06:02:30.000Z',
    draftId,
    presetId: value.presetId,
    version: value.version,
  }, {
    schemaVersion: 1,
    auditId: 'audit-published',
    event: 'creator.lifecycle.published',
    createdAt: '2026-08-21T06:03:00.000Z',
    draftId,
    presetId: value.presetId,
    version: value.version,
    metadata: {
      manifestDigest: digest,
      draftManifestDigest: digest,
      verificationRunId,
    },
  }];
}

function dependencies(overrides: Partial<CreatorMaterializerDependencies> = {}) {
  const value = manifest();
  const created = agent();
  let persisted = created;
  const createAgent = vi.fn(async (_uid: string, options: CreateAgentOptions) => {
    persisted = {
      ...created,
      ...(options.skill_list ? { skill_list: options.skill_list } : {}),
      ...(options.default_model ? { default_model: options.default_model } : {}),
      creator_binding: options.creator_binding,
    };
    return persisted;
  });
  const updateAgent = vi.fn(async (_uid: string, _agentId: string, updates: UpdateAgentFields) => {
    persisted = { ...persisted, ...(updates.skill_list ? { skill_list: updates.skill_list } : {}) };
    return persisted;
  });
  const getAgent = vi.fn(async (_uid: string, _agentId: string) => persisted);
  const deleteAgent = vi.fn(async (_uid: string, _agentId: string) => true);
  const readBinding = vi.fn(async () => null);
  const saveBinding = vi.fn(async (_uid: string, binding: CreatorAgentBinding) => binding);
  return {
    value,
    created,
    createAgent,
    updateAgent,
    getAgent,
    deleteAgent,
    readBinding,
    saveBinding,
    deps: {
      getActiveUserId: () => userId,
      readVersion: async () => value,
      readDraft: async () => ({
        draftId: `draft-${value.presetId}`,
        manifest: structuredClone(value),
      } satisfies CreatorPresetDraft),
      listAudit: async () => publishedAudit(value),
      resolveCapabilities: async () => ({ skillIds: ['research'] }),
      readBinding,
      saveBinding,
      createAgent,
      updateAgent,
      getAgent,
      deleteAgent,
      now: () => '2026-08-21T06:03:00.000Z',
      createRevision: () => 'revision-1',
      ...overrides,
    } satisfies CreatorMaterializerDependencies,
  };
}

describe('Creator preset materializer', () => {
  it('rejects a non-active user before reading Creator or Agent state', async () => {
    const readVersion = vi.fn(async () => manifest());
    const fixture = dependencies({ getActiveUserId: () => 'other-user', readVersion });
    const service = createCreatorPresetMaterializer(fixture.deps);

    await expect(service.materializeCreatorPreset(userId, {
      presetId: 'local-research', version: '1', manifestDigest: creatorManifestDigest(fixture.value),
    })).rejects.toThrow('creator_active_user_mismatch');
    expect(readVersion).not.toHaveBeenCalled();
  });

  it('rejects stale digests and versions without a published or active lifecycle', async () => {
    const stale = dependencies();
    const staleService = createCreatorPresetMaterializer(stale.deps);
    await expect(staleService.materializeCreatorPreset(userId, {
      presetId: 'local-research', version: '1', manifestDigest: `sha256:${'0'.repeat(64)}`,
    })).rejects.toThrow('creator_manifest_digest_mismatch');
    expect(stale.createAgent).not.toHaveBeenCalled();

    const unapproved = dependencies({ listAudit: async () => [{
      schemaVersion: 1,
      auditId: 'audit-approved',
      event: 'creator.lifecycle.approved',
      createdAt: '2026-08-21T06:00:00.000Z',
      presetId: 'local-research',
      metadata: { manifestDigest: creatorManifestDigest(manifest()) },
    }] });
    const unapprovedService = createCreatorPresetMaterializer(unapproved.deps);
    await expect(unapprovedService.materializeCreatorPreset(userId, {
      presetId: 'local-research', version: '1', manifestDigest: creatorManifestDigest(unapproved.value),
    })).rejects.toThrow('creator_preset_not_materializable');
    expect(unapproved.createAgent).not.toHaveBeenCalled();
  });

  it('rejects a forged published record without the linked draft, verification, approval, and version records', async () => {
    const value = manifest();
    const fixture = dependencies({
      listAudit: async () => [{
        schemaVersion: 1,
        auditId: 'forged-published',
        event: 'creator.lifecycle.published',
        createdAt: '2026-08-21T06:03:00.000Z',
        presetId: value.presetId,
        version: value.version,
        metadata: { manifestDigest: creatorManifestDigest(value), verificationRunId: 'forged-run' },
      }],
    });
    const service = createCreatorPresetMaterializer(fixture.deps);

    await expect(service.materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: creatorManifestDigest(fixture.value),
    })).rejects.toThrow('creator_preset_not_materializable');
    expect(fixture.createAgent).not.toHaveBeenCalled();
  });

  it('keeps final skill validation on the requested user after an awaited dependency switches users', async () => {
    let active = userId;
    const fixture = dependencies({
      getActiveUserId: () => active,
      resolveCapabilities: undefined,
      buildCatalog: async (requestedUserId) => {
        expect(requestedUserId).toBe(userId);
        await Promise.resolve();
        active = 'other-user';
        return [
          {
            capabilityId: 'model.provider-main.deepseek-chat', version: '1', kind: 'model',
            displayName: 'DeepSeek', available: true, permissions: ['cost'],
            sourceRef: 'provider.provider-main', health: 'ready',
          },
          {
            capabilityId: 'skill.research', version: '1', kind: 'skill',
            displayName: 'Research', available: true, permissions: ['read'],
            sourceRef: 'skill.custom.research', health: 'ready',
          },
          {
            capabilityId: 'tool.search', version: '1', kind: 'tool',
            displayName: 'search', available: true, permissions: ['read'],
            sourceRef: 'agent-capability.search', health: 'ready',
          },
        ];
      },
      listSkills: async (requestedUserId?: string) => {
        expect(requestedUserId).toBe(userId);
        return [{
          id: 'research', name: 'Research', source: 'custom', description_zh: '',
          description_en: '', category: 'general', enabled: true,
        }];
      },
    });
    const service = createCreatorPresetMaterializer(fixture.deps);

    await expect(service.materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: creatorManifestDigest(fixture.value),
    })).resolves.toBeDefined();
  });

  it('rejects a linked draft whose non-version manifest fields differ from the published version', async () => {
    const fixture = dependencies();
    const changedDraft = structuredClone(fixture.value);
    changedDraft.model = { providerId: 'other-provider', modelId: 'other-model' };
    const changedDigest = creatorManifestDigest(changedDraft);
    fixture.deps.readDraft = async () => ({
      draftId: `draft-${fixture.value.presetId}`,
      manifest: changedDraft,
    } satisfies CreatorPresetDraft);
    fixture.deps.listAudit = async () => publishedAudit(fixture.value).map((record) => {
      if (record.event === 'draft.saved' || record.event === 'creator.verification.recorded'
          || record.event === 'creator.lifecycle.verified' || record.event === 'creator.lifecycle.approved') {
        return { ...record, metadata: { ...record.metadata, manifestDigest: changedDigest } };
      }
      if (record.event === 'creator.lifecycle.published') {
        return { ...record, metadata: { ...record.metadata, draftManifestDigest: changedDigest } };
      }
      return record;
    });

    await expect(createCreatorPresetMaterializer(fixture.deps).materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: creatorManifestDigest(fixture.value),
    })).rejects.toThrow('creator_preset_not_materializable');
    expect(fixture.createAgent).not.toHaveBeenCalled();
  });

  it('rejects a capability resolver that adds a skill outside the approved manifest subset', async () => {
    const fixture = dependencies({
      resolveCapabilities: async () => ({ skillIds: ['research', 'unapproved-skill'] }),
    });
    const service = createCreatorPresetMaterializer(fixture.deps);

    await expect(service.materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: creatorManifestDigest(fixture.value),
    })).rejects.toThrow('creator_capability_scope_invalid');
    expect(fixture.createAgent).not.toHaveBeenCalled();
  });

  it('rejects an empty resolved skill subset when the manifest approves a skill capability', async () => {
    const fixture = dependencies({
      resolveCapabilities: async () => ({ skillIds: [] }),
    });
    const service = createCreatorPresetMaterializer(fixture.deps);

    await expect(service.materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: creatorManifestDigest(fixture.value),
    })).rejects.toThrow('creator_capability_scope_invalid');
    expect(fixture.createAgent).not.toHaveBeenCalled();
  });

  it('materializes through existing Agent create/update APIs and persists only after agent verification', async () => {
    const fixture = dependencies();
    const order: string[] = [];
    let persisted = fixture.created;
    fixture.createAgent.mockImplementation(async (_uid, options) => {
      order.push('create');
      persisted = {
        ...fixture.created,
        ...(options.skill_list ? { skill_list: options.skill_list } : {}),
        ...(options.default_model ? { default_model: options.default_model } : {}),
        creator_binding: options.creator_binding,
      };
      return persisted;
    });
    fixture.updateAgent.mockImplementation(async (_uid, _agentId, updates) => {
      order.push('update');
      persisted = { ...persisted, ...(updates.skill_list ? { skill_list: updates.skill_list } : {}) };
      return persisted;
    });
    fixture.getAgent.mockImplementation(async () => { order.push('get'); return persisted; });
    fixture.saveBinding.mockImplementation(async (_uid, binding) => { order.push('bind'); return binding; });
    const service = createCreatorPresetMaterializer(fixture.deps);

    const result = await service.materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: creatorManifestDigest(fixture.value),
    });

    expect(order).toEqual(['create', 'get', 'bind']);
    expect(fixture.createAgent).toHaveBeenCalledWith(userId, expect.objectContaining({
      name: 'Local-research-agent-v1',
      description: fixture.value.description,
      runtime: { kind: 'in_process' },
      output_format: 'text',
      default_model: { provider: 'provider-main', model: 'deepseek-chat' },
      skill_list: ['research'],
    }));
    const serializedOptions = JSON.stringify(fixture.createAgent.mock.calls[0]?.[1]);
    expect(serializedOptions).not.toMatch(/endpoint|token|authorization|baseUrl|private\/tmp/i);
    expect(result).toEqual({
      schemaVersion: 1,
      presetId: 'local-research',
      version: '1',
      manifestDigest: creatorManifestDigest(fixture.value),
      agentId: fixture.created.agent_id,
      materializedAt: '2026-08-21T06:03:00.000Z',
      materializationRevision: 'revision-1',
      policy: {
        model: { providerId: 'provider-main', modelId: 'deepseek-chat' },
        skillIds: ['research'],
        capabilityIds: ['skill.research', 'tool.search'],
        runtime: fixture.value.runtime,
        permissions: fixture.value.permissions,
      },
    });
  });

  it('materializes a local CogSeed agent without embedding external-agent instructions', async () => {
    const fixture = dependencies();
    fixture.value.presetId = 'local-research';
    fixture.value.displayName = 'Local research agent';
    fixture.value.presetType = 'cogseed-agent';
    fixture.value.capabilities = fixture.value.capabilities.filter((item) => !item.capabilityId.startsWith('peer.'));
    const service = createCreatorPresetMaterializer(fixture.deps);

    await service.materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: creatorManifestDigest(fixture.value),
    });

    const options = fixture.createAgent.mock.calls[0]?.[1];
    expect(options?.runtime).toEqual({ kind: 'in_process' });
    expect(options?.workflow).not.toMatch(/remote|P3394|external agent/i);
  });

  it('is idempotent for an exact binding and fails closed if its Agent disappeared', async () => {
    const fixture = dependencies();
    const existing: CreatorAgentBinding = {
      schemaVersion: 1,
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: creatorManifestDigest(fixture.value),
      agentId: fixture.created.agent_id,
      materializedAt: '2026-08-21T06:02:00.000Z',
      materializationRevision: 'revision-existing',
      policy: {
        model: fixture.value.model,
        skillIds: ['research'],
        capabilityIds: fixture.value.capabilities.map((item) => item.capabilityId),
        runtime: fixture.value.runtime,
        permissions: fixture.value.permissions,
      },
    };
    fixture.readBinding.mockResolvedValue(existing);
    fixture.getAgent.mockResolvedValue({
      ...fixture.created,
      creator_binding: {
        schemaVersion: 1,
        presetId: existing.presetId,
        version: existing.version,
        manifestDigest: existing.manifestDigest,
        materializationRevision: existing.materializationRevision,
      },
    });
    const service = createCreatorPresetMaterializer(fixture.deps);

    await expect(service.materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: existing.manifestDigest,
    })).resolves.toEqual(existing);
    expect(fixture.createAgent).not.toHaveBeenCalled();
    expect(fixture.updateAgent).not.toHaveBeenCalled();
    expect(fixture.saveBinding).not.toHaveBeenCalled();

    fixture.getAgent.mockResolvedValueOnce(null);
    await expect(service.materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: existing.manifestDigest,
    })).rejects.toThrow('creator_bound_agent_missing');
  });

  it('rejects an existing binding whose policy adds a skill outside the verified manifest', async () => {
    const fixture = dependencies();
    const existing: CreatorAgentBinding = {
      schemaVersion: 1,
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: creatorManifestDigest(fixture.value),
      agentId: fixture.created.agent_id,
      materializedAt: '2026-08-21T06:02:00.000Z',
      materializationRevision: 'revision-existing',
      policy: {
        model: fixture.value.model,
        skillIds: ['research', 'outside-skill'],
        capabilityIds: [...fixture.value.capabilities.map((item) => item.capabilityId), 'skill.outside-skill'],
        runtime: fixture.value.runtime,
        permissions: fixture.value.permissions,
      },
    };
    fixture.readBinding.mockResolvedValue(existing);
    fixture.getAgent.mockResolvedValue({
      ...fixture.created,
      skill_list: ['research', 'outside-skill'],
      creator_binding: {
        schemaVersion: 1,
        presetId: existing.presetId,
        version: existing.version,
        manifestDigest: existing.manifestDigest,
        materializationRevision: existing.materializationRevision,
      },
    });

    await expect(createCreatorPresetMaterializer(fixture.deps).materializeCreatorPreset(userId, {
      presetId: fixture.value.presetId,
      version: fixture.value.version,
      manifestDigest: existing.manifestDigest,
    })).rejects.toThrow('creator_capability_scope_invalid');
    expect(fixture.createAgent).not.toHaveBeenCalled();
  });

  it('does not leave a binding when capability resolution, Agent create, update, or persistence fails', async () => {
    const capabilityFailure = dependencies({
      resolveCapabilities: async () => { throw new Error('creator_capability_unavailable'); },
    });
    await expect(createCreatorPresetMaterializer(capabilityFailure.deps).materializeCreatorPreset(userId, {
      presetId: 'local-research', version: '1', manifestDigest: creatorManifestDigest(capabilityFailure.value),
    })).rejects.toThrow('creator_capability_unavailable');
    expect(capabilityFailure.createAgent).not.toHaveBeenCalled();
    expect(capabilityFailure.saveBinding).not.toHaveBeenCalled();

    const createFailure = dependencies();
    createFailure.createAgent.mockRejectedValue(new Error('agent quality failed'));
    await expect(createCreatorPresetMaterializer(createFailure.deps).materializeCreatorPreset(userId, {
      presetId: 'local-research', version: '1', manifestDigest: creatorManifestDigest(createFailure.value),
    })).rejects.toThrow('agent quality failed');
    expect(createFailure.saveBinding).not.toHaveBeenCalled();
    expect(createFailure.deleteAgent).not.toHaveBeenCalled();

    const persistenceFailure = dependencies();
    persistenceFailure.getAgent.mockResolvedValue(null);
    await expect(createCreatorPresetMaterializer(persistenceFailure.deps).materializeCreatorPreset(userId, {
      presetId: 'local-research', version: '1', manifestDigest: creatorManifestDigest(persistenceFailure.value),
    })).rejects.toThrow('creator_materialized_agent_missing');
    expect(persistenceFailure.saveBinding).not.toHaveBeenCalled();
    expect(persistenceFailure.deleteAgent).toHaveBeenCalledWith(userId, persistenceFailure.created.agent_id);
  });

  it('cleans up only the newly-created Agent if binding persistence fails', async () => {
    const fixture = dependencies();
    fixture.saveBinding.mockRejectedValue(new Error('binding write failed'));
    const service = createCreatorPresetMaterializer(fixture.deps);

    await expect(service.materializeCreatorPreset(userId, {
      presetId: 'local-research', version: '1', manifestDigest: creatorManifestDigest(fixture.value),
    })).rejects.toThrow('binding write failed');
    expect(fixture.deleteAgent).toHaveBeenCalledTimes(1);
    expect(fixture.deleteAgent).toHaveBeenCalledWith(userId, fixture.created.agent_id);
  });


  it('maps hashed catalog capability ids back to the exact upstream Skill id', async () => {
    const specialSkillId = 'research.special';
    const specialCapabilityId = creatorCatalogLogicalId('skill', specialSkillId);
    const value = manifest();
    value.capabilities[0] = { capabilityId: specialCapabilityId, version: '1' };
    const fixture = dependencies({
      readVersion: async () => value,
      readDraft: async () => ({
        draftId: `draft-${value.presetId}`,
        manifest: structuredClone(value),
      } satisfies CreatorPresetDraft),
      listAudit: async () => publishedAudit(value),
      resolveCapabilities: undefined,
      buildCatalog: async () => [
        { capabilityId: 'model.provider-main.deepseek-chat', version: '1', kind: 'model', displayName: 'DeepSeek', available: true, permissions: ['cost'], sourceRef: 'provider.provider-main', health: 'ready' },
        { capabilityId: specialCapabilityId, version: '1', kind: 'skill', displayName: 'Research Special', available: true, permissions: ['read'], sourceRef: 'skill.custom.id', health: 'ready' },
        { capabilityId: 'tool.search', version: '1', kind: 'tool', displayName: 'search', available: true, permissions: ['read'], sourceRef: 'agent-capability.search', health: 'ready' },
      ],
      listSkills: async () => [{
        id: specialSkillId,
        name: 'Research Special',
        source: 'custom',
        description_zh: '',
        description_en: '',
        category: 'general',
        enabled: true,
      }],
    });
    const service = createCreatorPresetMaterializer(fixture.deps);

    await service.materializeCreatorPreset(userId, {
      presetId: value.presetId,
      version: value.version,
      manifestDigest: creatorManifestDigest(value),
    });

    expect(fixture.createAgent).toHaveBeenCalledWith(userId, expect.objectContaining({
      skill_list: [specialSkillId],
    }));
  });

  it('creates a distinct Agent for an explicit new preset version instead of overwriting another Agent', async () => {
    const second = manifest('2');
    const fixture = dependencies({
      readVersion: async () => second,
      readDraft: async () => ({
        draftId: `draft-${second.presetId}`,
        manifest: structuredClone(second),
      } satisfies CreatorPresetDraft),
      listAudit: async () => publishedAudit(second),
    });
    const service = createCreatorPresetMaterializer(fixture.deps);

    await service.materializeCreatorPreset(userId, {
      presetId: second.presetId,
      version: second.version,
      manifestDigest: creatorManifestDigest(second),
    });

    expect(fixture.createAgent).toHaveBeenCalledTimes(1);
    expect(fixture.createAgent).toHaveBeenCalledWith(userId, expect.objectContaining({
      skill_list: ['research'],
    }));
  });
});

describe('governed Agent config-sheet fidelity', () => {
  it('passes governed display and runtime fields through without Creator wrapping', async () => {
    const fixture = dependencies();
    const governed = {
      ...fixture.value,
      displayName: '原始配置单名称',
      description: '原始摘要',
      prompt: { systemSections: ['第一段工作流', '第二段停止规则：失败时转人工。'] },
      agent: {
        category: 'research',
        icon: 'book',
        color: 'blue',
        interactive: true,
        description_zh: '中文说明',
        description_en: 'English description',
        knowhow: ['知识一'],
        standards: ['标准一'],
        inputs: [{ id: 'material', type: 'file', label: '材料', default: '', required: true }],
      },
    };
    fixture.deps.readVersion = async () => governed;
    fixture.deps.readDraft = async () => ({
      draftId: `draft-${governed.presetId}`,
      manifest: structuredClone(governed),
    } satisfies CreatorPresetDraft);
    fixture.deps.listAudit = async () => publishedAudit(governed);
    const service = createCreatorPresetMaterializer(fixture.deps);

    await service.materializeCreatorPreset(userId, {
      presetId: governed.presetId,
      version: governed.version,
      manifestDigest: creatorManifestDigest(governed),
    });

    expect(fixture.createAgent).toHaveBeenCalledWith(userId, expect.objectContaining({
      name: '原始配置单名称',
      description: '原始摘要',
      description_zh: '中文说明',
      description_en: 'English description',
      workflow: '第一段工作流\n\n第二段停止规则：失败时转人工。\n\nCreator governance binding: local-research@1',
      category: 'research',
      icon: 'book',
      color: 'blue',
      interactive: true,
      knowhow: ['知识一'],
      standards: ['标准一'],
      inputs: [{ id: 'material', type: 'file', label: '材料', default: '', required: true }],
    }));
    const options = fixture.createAgent.mock.calls[0]?.[1] as CreateAgentOptions;
    expect(options.workflow).not.toContain('Creator preset:');
    expect(options.name).not.toContain('-v1');
  });
});
