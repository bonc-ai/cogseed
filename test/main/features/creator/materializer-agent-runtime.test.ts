import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getAgentDispatchPolicy, isAgentChatDispatchable } from '../../../../src/main/features/agent-dispatch-policy';
import {
  deleteCustomAgentForUser,
  getAgentRuntimeSpecForUser,
  updateCustomAgentForUser,
} from '../../../../src/main/features/agents';
import { createCreatorPresetMaterializer } from '../../../../src/main/features/creator/materializer';
import {
  createCreatorLifecycleService,
  type CreatorApprovalInput,
} from '../../../../src/main/features/creator/lifecycle-service';
import {
  readCreatorAgentBinding,
  type CreatorAgentBinding,
} from '../../../../src/main/features/creator/agent-binding-store';
import {
  saveCreatorDraft,
  type CreatorPresetDraft,
} from '../../../../src/main/features/creator/store';
import type { CreatorPresetManifestV1 } from '../../../../src/main/features/creator/types';
import {
  creatorManifestDigest,
  type CreatorVerificationReport,
} from '../../../../src/main/features/creator/verification-service';
import { buildRunner } from '../../../../src/main/model/core-agent/runner';
import { activateUser } from '../../../../src/main/features/users';
import { agentDefinitionFile, userSkillsDir } from '../../../../src/main/paths';
import { drainReportWrites } from '../../../../src/main/quality/report';

const userId = 'creator-runtime-user';
const presetId = 'local-research';
const skillId = 'creator-research';
const workspaceRoot = process.env.COGSEED_WORKSPACE_ROOT as string;

function manifest(description: string, includeSearchCapability = true): CreatorPresetManifestV1 {
  const capabilities = [
    { capabilityId: 'skill.creator-research', version: '1' },
    ...(includeSearchCapability ? [{ capabilityId: 'tool.search', version: '1' }] : []),
  ];
  return {
    schemaVersion: 1,
    presetId,
    version: 'draft',
    displayName: 'Local research agent',
    description,
    presetType: 'cogseed-agent',
    model: { providerId: 'provider-main', modelId: 'deepseek-chat' },
    capabilities,
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
      tools: includeSearchCapability ? ['tool.search'] : [],
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

function verification(
  value: CreatorPresetManifestV1,
  runId: string,
): CreatorVerificationReport {
  return {
    schemaVersion: 1,
    runId,
    presetId: value.presetId,
    manifestDigest: creatorManifestDigest(value),
    status: 'passed',
    checks: [
      'schema', 'catalog-resolution', 'tool-allow-list', 'file-grants',
      'side-effects', 'budget', 'timeout', 'cancel',
      'idempotency', 'audit-trajectory', 'agent-usefulness',
    ].map((id) => ({ id, status: 'passed', evidence: ['verified'] })) as CreatorVerificationReport['checks'],
    startedAt: '2026-08-21T06:01:00.000Z',
    completedAt: '2026-08-21T06:01:01.000Z',
  };
}

function approval(
  draftId: string,
  value: CreatorPresetManifestV1,
  verificationRunId: string,
): CreatorApprovalInput {
  return {
    draftId,
    manifestDigest: creatorManifestDigest(value),
    verificationRunId,
    actorId: 'user-reviewer',
    confirmedAt: '2026-08-21T06:02:00.000Z',
    approved: true,
    approvedCapabilities: value.capabilities.map((capability) => capability.capabilityId),
    approvedSideEffects: [],
  };
}

async function writeSkill(): Promise<void> {
  const directory = path.join(userSkillsDir(userId), skillId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${skillId}`,
    'description: Bounded Creator research.',
    '---',
    '',
    'Use bounded research.',
  ].join('\n'), 'utf8');
}

async function writeSkillId(id: string): Promise<void> {
  const directory = path.join(userSkillsDir(userId), id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${id}`,
    `description: Bounded ${id}.`,
    '---',
    '',
    'Use bounded skill behavior.',
  ].join('\n'), 'utf8');
}

async function publishVersion(
  lifecycle: ReturnType<typeof createCreatorLifecycleService>,
  draftId: string,
  version: string,
  description: string,
  includeSearchCapability = true,
): Promise<{ digest: string }> {
  const input: CreatorPresetDraft = {
    schemaVersion: 1,
    draftId,
    manifest: manifest(description, includeSearchCapability),
    updatedAt: '2026-08-21T06:00:00.000Z',
  };
  const saved = await saveCreatorDraft(userId, input);
  const digest = creatorManifestDigest(saved.manifest);
  const runId = `verify-${version}`;
  await lifecycle.sandboxPreset(userId, draftId, digest);
  await lifecycle.recordVerification(userId, draftId, verification(saved.manifest, runId));
  await lifecycle.approvePreset(userId, draftId, approval(draftId, saved.manifest, runId));
  await lifecycle.publishPreset(userId, draftId, {
    version,
    manifestDigest: digest,
    verificationRunId: runId,
  });
  return { digest: creatorManifestDigest({ ...saved.manifest, version }) };
}

function expectSafeBinding(binding: CreatorAgentBinding): void {
  const serialized = JSON.stringify(binding.policy);
  expect(serialized).not.toMatch(/\"(?:endpoint|apiKey|authorization|baseURL)\"|\/Users\/|private\/tmp/i);
}

beforeEach(async () => {
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
  activateUser(userId);
  await writeSkill();
});

afterEach(async () => {
  await drainReportWrites();
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
});

describe('Creator materializer integration with the existing Agent runtime', () => {
  it('does not expose network tools when the Creator lacks the approved search capability', async () => {
    const lifecycle = createCreatorLifecycleService({
      verifyPreset: async (_userId, value, runId) => verification(value, runId),
    });
    const materializer = createCreatorPresetMaterializer({
      resolveCapabilities: async () => ({ skillIds: [skillId] }),
      now: () => '2026-08-21T06:03:00.000Z',
      createRevision: () => 'revision-no-search',
    });

    const published = await publishVersion(lifecycle, 'draft-no-search', '1', 'local-only', false);
    const binding = await materializer.materializeCreatorPreset(userId, {
      presetId,
      version: '1',
      manifestDigest: published.digest,
    });
    await lifecycle.activatePreset(userId, presetId, '1');

    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-creator-runtime-test';
    try {
      const built = await buildRunner({
        sessionId: `gmember-${binding.agentId}`,
        userId,
        cid: 'creator-no-search-conversation',
        agentId: binding.agentId,
        systemPrompt: 'Inspect the approved workspace read-only.',
        skillList: [skillId],
        ephemeralSession: true,
      });
      const names = built.toolDefs.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        'read_file', 'stat_file', 'search_files', 'grep_files', 'list_files',
      ]));
      expect(names).not.toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
      expect([...((built.runner as any).tools as Map<string, unknown>).keys()])
        .not.toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
    } finally {
      if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });

  it('persists v1/v2 provenance and skills, gates dispatch, and follows rollback', async () => {
    const lifecycle = createCreatorLifecycleService({
      verifyPreset: async (_userId, value, runId) => verification(value, runId),
    });
    const materializer = createCreatorPresetMaterializer({
      resolveCapabilities: async () => ({ skillIds: [skillId] }),
      now: () => '2026-08-21T06:03:00.000Z',
      createRevision: (() => {
        let revision = 0;
        return () => `revision-${++revision}`;
      })(),
    });

    const v1 = await publishVersion(lifecycle, 'draft-v1', '1', 'version one');
    const bindingV1 = await materializer.materializeCreatorPreset(userId, {
      presetId,
      version: '1',
      manifestDigest: v1.digest,
    });
    const agentV1 = await getAgentRuntimeSpecForUser(userId, bindingV1.agentId);

    expect(agentV1).toMatchObject({
      name: 'Local-research-agent-v1',
      source: 'custom',
      skill_list: [skillId],
      default_model: { provider: 'provider-main', model: 'deepseek-chat' },
      creator_binding: {
        schemaVersion: 1,
        presetId,
        version: '1',
        manifestDigest: v1.digest,
        materializationRevision: bindingV1.materializationRevision,
      },
    });
    expectSafeBinding(bindingV1);
    expect(await readCreatorAgentBinding(userId, presetId, '1')).toEqual(bindingV1);
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, bindingV1.agentId))).toBe(false);

    await writeSkillId('outside-skill');
    const beforeUpdate = await fs.readFile(agentDefinitionFile(userId, bindingV1.agentId), 'utf8');
    await expect(updateCustomAgentForUser(userId, bindingV1.agentId, {
      skill_list: [skillId, 'outside-skill'],
    })).rejects.toThrow('creator_agent_skill_scope_invalid');
    expect(await fs.readFile(agentDefinitionFile(userId, bindingV1.agentId), 'utf8')).toBe(beforeUpdate);

    await lifecycle.activatePreset(userId, presetId, '1');
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, bindingV1.agentId))).toBe(true);

    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-creator-runtime-test';
    try {
      const built = await buildRunner({
        sessionId: `gmember-${bindingV1.agentId}`,
        userId,
        cid: 'creator-runtime-conversation',
        agentId: bindingV1.agentId,
        systemPrompt: 'Inspect the approved workspace read-only.',
        skillList: [skillId],
        ephemeralSession: true,
      });
      const names = built.toolDefs.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        'read_file', 'stat_file', 'search_files', 'grep_files', 'list_files',
        'web_search', 'web_fetch',
      ]));
      expect(names).not.toEqual(expect.arrayContaining([
        'bash', 'write_file', 'edit_file', 'delete_file', 'generate_image',
        'create_docx', 'create_xlsx', 'create_pptx', 'messaging_send',
      ]));
      const runtimeTools = [...(built.runner as any).tools.keys()];
      expect(runtimeTools).not.toEqual(expect.arrayContaining([
        'bash', 'write_file', 'edit_file', 'delete_file', 'generate_image',
        'create_docx', 'create_xlsx', 'create_pptx', 'messaging_send',
        'manage_execution_plan',
      ]));
      const catalog = Object.values((built.runner as any).config.models.catalog as Record<string, { maxOutputTokens?: number }>);
      expect((built.runner as any).config.agent.toolIdleTimeoutMs).toBe(60_000);
      expect(catalog.some((entry) => entry.maxOutputTokens !== undefined)).toBe(true);
      expect(catalog.every((entry) => (entry.maxOutputTokens ?? 8000) <= 8000)).toBe(true);
    } finally {
      if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }

    const v2 = await publishVersion(lifecycle, 'draft-v2', '2', 'version two');
    const bindingV2 = await materializer.materializeCreatorPreset(userId, {
      presetId,
      version: '2',
      manifestDigest: v2.digest,
    });
    const agentV2 = await getAgentRuntimeSpecForUser(userId, bindingV2.agentId);

    expect(bindingV2.agentId).not.toBe(bindingV1.agentId);
    expect(agentV2?.name).toBe('Local-research-agent-v2');
    expect(agentV2?.skill_list).toEqual([skillId]);
    expectSafeBinding(bindingV2);
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, bindingV2.agentId))).toBe(false);

    await lifecycle.activatePreset(userId, presetId, '2');
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, bindingV1.agentId))).toBe(false);
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, bindingV2.agentId))).toBe(true);

    await lifecycle.rollbackPreset(userId, presetId, '1', {
      actorId: 'user-reviewer',
      confirmedAt: '2026-08-21T06:04:00.000Z',
    });
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, bindingV1.agentId))).toBe(true);
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, bindingV2.agentId))).toBe(false);
  });

  it('fails activation closed when the materialized Agent is deleted or its provenance is changed', async () => {
    const lifecycle = createCreatorLifecycleService({
      verifyPreset: async (_userId, value, runId) => verification(value, runId),
    });
    const materializer = createCreatorPresetMaterializer({
      resolveCapabilities: async () => ({ skillIds: [skillId] }),
      createRevision: () => 'revision-1',
    });
    const published = await publishVersion(lifecycle, 'draft-v1', '1', 'version one');
    const binding = await materializer.materializeCreatorPreset(userId, {
      presetId,
      version: '1',
      manifestDigest: published.digest,
    });

    const agentFile = agentDefinitionFile(userId, binding.agentId);
    const raw = JSON.parse(await fs.readFile(agentFile, 'utf8')) as Record<string, unknown>;
    const provenance = raw.creator_binding as Record<string, unknown>;
    await fs.writeFile(agentFile, `${JSON.stringify({
      ...raw,
      creator_binding: { ...provenance, materializationRevision: 'forged-revision' },
    })}\n`, 'utf8');

    await expect(lifecycle.activatePreset(userId, presetId, '1'))
      .rejects.toThrow('creator_preset_not_materialized');
    expect(isAgentChatDispatchable(await getAgentDispatchPolicy(userId, binding.agentId))).toBe(false);

    await fs.writeFile(agentFile, `${JSON.stringify(raw)}\n`, 'utf8');
    await expect(deleteCustomAgentForUser(userId, binding.agentId)).resolves.toBe(true);
    await expect(lifecycle.activatePreset(userId, presetId, '1'))
      .rejects.toThrow('creator_preset_not_materialized');
  });
});
