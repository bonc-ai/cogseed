import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  creatorRuntimeExecutionOptions,
  getAgentDispatchPolicy,
  isAgentChatDispatchable,
} from '../../../../src/main/features/agent-dispatch-policy';
import { agentDefinitionFile, userCreatorAgentBindingFile, userCreatorPresetStateFile, userCreatorAuditFile, userMarketplaceAgentDir } from '../../../../src/main/paths';
import { userCreatorPresetVersionFile } from '../../../../src/main/paths';
import { activateUser } from '../../../../src/main/features/users';
import type { CreatorPresetManifestV1 } from '../../../../src/main/features/creator/types';
import type { CreatorAgentBindingPolicy } from '../../../../src/main/features/creator/agent-binding-store';
import { creatorManifestDigest } from '../../../../src/main/features/creator/verification-service';

const userId = 'creator-dispatch-user';
const agentId = 'agentabc12345';
const presetId = 'local-research';
const workspaceRoot = process.env.COGSEED_WORKSPACE_ROOT as string;

function validManifest(): CreatorPresetManifestV1 {
  return {
    schemaVersion: 1,
    presetId,
    version: '1',
    displayName: 'Local research agent',
    description: 'Bounded research.',
    presetType: 'cogseed-agent',
    model: { providerId: 'provider-main', modelId: 'deepseek-chat' },
    capabilities: [],
    prompt: { systemSections: ['bounded'], locale: 'en' },
    runtime: {
      sessionPolicy: 'new-per-run',
      memoryPolicy: 'read-only',
      loopPolicy: 'single-agent',
      sandboxProfile: 'creator-read-only-v1',
      timeoutMs: 60000,
      budget: {},
    },
    permissions: {
      tools: [],
      files: ['workspace.readonly'],
      sideEffects: [],
      approvalMode: 'always',
    },
    provenance: {
      createdBy: 'user',
      sourceSessionId: 'creator-session',
      sourceAssetRefs: [],
    },
  };
}

const digest = creatorManifestDigest(validManifest());

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

async function writeCreatorAgent(): Promise<void> {
  await writeJson(agentDefinitionFile(userId, agentId), {
    agent_id: agentId,
    name: 'Local-research-agent-v1',
    description_en: 'Bounded research.',
    workflow: 'bounded',
    status: 'approved',
    default_model: { provider: 'provider-main', model: 'deepseek-chat' },
    skill_list: [],
    creator_binding: {
      schemaVersion: 1,
      presetId,
      version: '1',
      manifestDigest: digest,
      materializationRevision: 'revision-1',
    },
  });
}

function validPolicy(): Record<string, unknown> {
  return {
    model: { providerId: 'provider-main', modelId: 'deepseek-chat' },
    skillIds: [],
    capabilityIds: [],
    runtime: { sessionPolicy: 'new-per-run', memoryPolicy: 'read-only', loopPolicy: 'single-agent', sandboxProfile: 'creator-read-only-v1', timeoutMs: 60000, budget: {} },
    permissions: { tools: [], files: ['workspace.readonly'], sideEffects: [], approvalMode: 'always' },
  };
}

function typedValidPolicy(): CreatorAgentBindingPolicy {
  return validPolicy() as unknown as CreatorAgentBindingPolicy;
}

async function writeBinding(policy: Record<string, unknown> = validPolicy()): Promise<void> {
  await writeJson(userCreatorAgentBindingFile(userId, presetId), {
    schemaVersion: 1,
    presetId,
    bindings: [{
      schemaVersion: 1,
      presetId,
      version: '1',
      manifestDigest: digest,
      agentId,
      materializedAt: '2026-08-21T06:03:00.000Z',
      materializationRevision: 'revision-1',
      policy,
    }],
  });
}

async function writeActiveState(version = '1'): Promise<void> {
  await writeJson(userCreatorPresetStateFile(userId, presetId), {
    schemaVersion: 1,
    presetId,
    activeVersion: version,
    updatedAt: '2026-08-21T06:04:00.000Z',
  });
  await writeLifecycleAudit([
    { auditId: `published-${version}`, event: 'creator.lifecycle.published', createdAt: '2026-08-21T06:02:00.000Z', version },
    { auditId: `active-${version}`, event: 'creator.lifecycle.active', createdAt: '2026-08-21T06:04:00.000Z', version },
  ]);
}

async function writeLifecycleAudit(records: Array<{
  auditId: string;
  event: string;
  createdAt: string;
  version: string;
}>): Promise<void> {
  const file = userCreatorAuditFile(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, records.map((record) => JSON.stringify({
    schemaVersion: 1,
    ...record,
    presetId,
    metadata: { manifestDigest: digest },
  })).join('\n') + '\n', 'utf8');
}

beforeEach(async () => {
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
  activateUser(userId);
  await writeCreatorAgent();
  await writeJson(userCreatorPresetVersionFile(userId, presetId, '1'), validManifest());
});

afterEach(async () => {
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
});

describe('Creator-bound Agent dispatch policy', () => {
  it('projects the read-only runtime policy into executable tool, timeout, and budget limits', () => {
    expect(creatorRuntimeExecutionOptions(typedValidPolicy())).toEqual({
      toolAccess: 'read-only',
      toolAllowlist: expect.arrayContaining([
        'read_file', 'stat_file', 'search_files', 'grep_files', 'list_files',
      ]),
      idleTimeout: 60,
      streamIdleTimeout: 60,
      maxOutputTokens: undefined,
    });
    expect(creatorRuntimeExecutionOptions(typedValidPolicy()).toolAllowlist)
      .not.toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
  });

  it('adds network tools only when the approved search capability is declared', () => {
    const policy = typedValidPolicy();
    const withSearch = {
      ...policy,
      capabilityIds: ['tool.search'],
      permissions: { ...policy.permissions, tools: ['tool.search'] },
    } as CreatorAgentBindingPolicy;

    expect(creatorRuntimeExecutionOptions(withSearch).toolAllowlist)
      .toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
  });

  it('fails closed for side effects, non-workspace file grants, and an unrepresentable cost budget', () => {
    expect(() => creatorRuntimeExecutionOptions({
      ...typedValidPolicy(),
      permissions: { ...typedValidPolicy().permissions, sideEffects: ['message.send'] },
    })).toThrow('creator_runtime_policy_not_read_only');
    expect(() => creatorRuntimeExecutionOptions({
      ...typedValidPolicy(),
      permissions: { ...typedValidPolicy().permissions, files: ['home.readonly'] },
    })).toThrow('creator_runtime_policy_not_read_only');
    expect(() => creatorRuntimeExecutionOptions({
      ...typedValidPolicy(),
      runtime: { ...typedValidPolicy().runtime, budget: { maxCost: 0 } },
    })).toThrow('creator_runtime_cost_budget_unrepresentable');
  });

  it('fails closed before binding and while the preset version is not active', async () => {
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);

    await writeBinding();
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it('allows only the exact active binding and rejects stale active versions', async () => {
    await writeBinding();
    await writeActiveState();
    const policy = await getAgentDispatchPolicy(userId, agentId);
    expect(isAgentChatDispatchable(policy)).toBe(true);
    expect(policy).toMatchObject({
      creator_runtime: {
        permissions: {
          tools: [],
          files: ['workspace.readonly'],
          sideEffects: [],
        },
        runtime: {
          sandboxProfile: 'creator-read-only-v1',
          timeoutMs: 60000,
          budget: {},
        },
      },
    });

    await writeJson(userCreatorPresetStateFile(userId, presetId), {
      schemaVersion: 1,
      presetId,
      activeVersion: '2',
      previousActiveVersion: '1',
      updatedAt: '2026-08-21T06:05:00.000Z',
    });
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it('rejects a binding after its active version is disabled even when the state pointer remains', async () => {
    await writeBinding();
    await writeActiveState();
    await fs.writeFile(userCreatorAuditFile(userId), [
      {
        schemaVersion: 1,
        auditId: 'published-1',
        event: 'creator.lifecycle.published',
        createdAt: '2026-08-21T06:02:00.000Z',
        presetId,
        version: '1',
        metadata: { manifestDigest: digest },
      },
      {
        schemaVersion: 1,
        auditId: 'active-1',
        event: 'creator.lifecycle.active',
        createdAt: '2026-08-21T06:04:00.000Z',
        presetId,
        version: '1',
        metadata: { manifestDigest: digest },
      },
      {
        schemaVersion: 1,
        auditId: 'disabled-1',
        event: 'creator.lifecycle.disabled',
        createdAt: '2026-08-21T06:05:00.000Z',
        presetId,
        version: '1',
        metadata: { manifestDigest: digest },
      },
    ].map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');

    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it('rejects a forged active lifecycle row without durable audit provenance', async () => {
    await writeBinding();
    await writeActiveState();
    await fs.writeFile(userCreatorAuditFile(userId), [
      {
        schemaVersion: 1,
        auditId: 'published-1',
        event: 'creator.lifecycle.published',
        createdAt: '2026-08-21T06:02:00.000Z',
        presetId,
        version: '1',
        metadata: { manifestDigest: digest },
      },
      {
        schemaVersion: 1,
        event: 'creator.lifecycle.active',
        presetId,
        version: '1',
        metadata: { manifestDigest: digest },
      },
    ].map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');

    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it.each([
    ['unknown policy field', { ...validPolicy(), endpoint: 'https://internal.invalid' }],
    ['missing permissions', Object.fromEntries(Object.entries(validPolicy()).filter(([key]) => key !== 'permissions'))],
    ['malformed budget', { ...validPolicy(), runtime: { ...(validPolicy().runtime as Record<string, unknown>), budget: { maxTokens: -1 } } }],
  ])('rejects an active binding with %s', async (_label, policy) => {
    await writeBinding(policy);
    await writeActiveState();
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it('rejects the whole binding file when a sibling row is malformed or conflicts', async () => {
    await writeBinding();
    await writeActiveState();
    const bindingFile = userCreatorAgentBindingFile(userId, presetId);
    const original = JSON.parse(await fs.readFile(bindingFile, 'utf8')) as { bindings: Array<Record<string, unknown>> };

    await writeJson(bindingFile, {
      ...original,
      bindings: [...original.bindings, { malformed: true }],
    });
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);

    await writeJson(bindingFile, {
      ...original,
      bindings: [
        ...original.bindings,
        {
          ...original.bindings[0],
          manifestDigest: `sha256:${'b'.repeat(64)}`,
          materializationRevision: 'revision-2',
        },
      ],
    });
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it('rejects a Creator-bound Agent whose persisted skills expand beyond the binding policy', async () => {
    await writeBinding({
      ...validPolicy(),
      skillIds: ['approved-skill'],
      capabilityIds: ['skill.approved-skill'],
    });
    await writeActiveState();
    const file = agentDefinitionFile(userId, agentId);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await writeJson(file, { ...raw, skill_list: ['approved-skill', 'outside-skill'] });

    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it('rejects a Creator-bound Agent whose persisted model differs from the approved model policy', async () => {
    await writeBinding();
    await writeActiveState();
    const file = agentDefinitionFile(userId, agentId);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await writeJson(file, { ...raw, default_model: { provider: 'other-provider', model: 'other-model' } });

    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it.each([
    { kind: 'cli', cli: 'codex' },
    { kind: 'p3394-gateway', cli: 'codex' },
  ])('rejects a Creator-bound Agent using the external %s runtime', async (runtime) => {
    await writeBinding();
    await writeActiveState();
    const file = agentDefinitionFile(userId, agentId);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await writeJson(file, { ...raw, runtime, interface_contract: { version: 1, role: 'external_expert', runtime } });

    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it.each([
    ['model', { ...validPolicy(), model: { providerId: 'other-provider', modelId: 'other-model' } }],
    ['capabilities', { ...validPolicy(), capabilityIds: ['skill.outside'] }],
    ['runtime', { ...validPolicy(), runtime: { ...(validPolicy().runtime as Record<string, unknown>), timeoutMs: 120000 } }],
    ['permissions', { ...validPolicy(), permissions: { ...(validPolicy().permissions as Record<string, unknown>), files: ['workspace.other'] } }],
  ] as const)('rejects a binding whose %s policy differs from the verified manifest', async (_label, policy) => {
    await writeBinding(policy);
    await writeActiveState();

    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it('rejects a symlinked Creator state file and state parent before reading state', async () => {
    await writeBinding();
    await writeActiveState();
    const stateFile = userCreatorPresetStateFile(userId, presetId);
    const outsideState = path.join(workspaceRoot, 'outside-creator-state.json');
    await writeJson(outsideState, {
      schemaVersion: 1,
      presetId,
      activeVersion: '1',
      updatedAt: '2026-08-21T06:04:00.000Z',
    });
    await fs.rm(stateFile, { force: true });
    await fs.symlink(outsideState, stateFile);
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
    await fs.rm(stateFile, { force: true });
    await fs.rm(outsideState, { force: true });

    const presetDir = path.dirname(stateFile);
    const outsidePreset = path.join(workspaceRoot, 'outside-creator-preset');
    await fs.mkdir(path.join(outsidePreset, 'versions'), { recursive: true });
    await writeJson(path.join(outsidePreset, 'versions', '1.json'), validManifest());
    await writeJson(path.join(outsidePreset, 'state.json'), {
      schemaVersion: 1,
      presetId,
      activeVersion: '1',
      updatedAt: '2026-08-21T06:04:00.000Z',
    });
    await fs.rm(presetDir, { recursive: true, force: true });
    await fs.symlink(outsidePreset, presetDir);
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
    await fs.rm(presetDir, { force: true });
    await fs.rm(outsidePreset, { recursive: true, force: true });
  });

  it('rejects malformed provenance, marketplace provenance, binding mismatches, and malformed state', async () => {
    const agentFile = agentDefinitionFile(userId, agentId);
    const raw = JSON.parse(await fs.readFile(agentFile, 'utf8')) as Record<string, unknown>;
    await writeBinding();
    await writeActiveState();

    await writeJson(agentFile, {
      ...raw,
      creator_binding: {
        ...(raw.creator_binding as Record<string, unknown>),
        unexpected: true,
      },
    });
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);

    await fs.rm(path.dirname(agentFile), { recursive: true, force: true });
    await writeJson(path.join(userMarketplaceAgentDir(userId, agentId), 'agent.json'), raw);
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);

    await fs.rm(userMarketplaceAgentDir(userId, agentId), { recursive: true, force: true });
    await writeJson(agentFile, raw);
    const bindingFile = userCreatorAgentBindingFile(userId, presetId);
    const bindingRaw = JSON.parse(await fs.readFile(bindingFile, 'utf8')) as { bindings: Array<Record<string, unknown>> };
    await writeJson(bindingFile, {
      ...bindingRaw,
      bindings: bindingRaw.bindings.map((binding) => ({ ...binding, materializationRevision: 'revision-mismatch' })),
    });
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);

    await writeBinding();
    await writeJson(userCreatorPresetStateFile(userId, presetId), {
      schemaVersion: 1,
      presetId,
      activeVersion: '1',
      unexpected: true,
    });
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, agentId))).toBe(false);
  });

  it('does not require Creator state for an ordinary custom Agent', async () => {
    await writeJson(agentDefinitionFile(userId, 'ordinary-agent'), {
      agent_id: 'ordinary-agent',
      name: 'Ordinary-agent',
      description_en: 'Ordinary Agent.',
      workflow: 'bounded',
      status: 'approved',
    });
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, 'ordinary-agent'))).toBe(true);
  });

});
