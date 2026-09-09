import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAgentRuntimeSpecForUser } from '../../../../src/main/features/agents';
import type { CreatorCapabilityDescriptor } from '../../../../src/main/features/creator/catalog';
import { createCreatorLifecycleService } from '../../../../src/main/features/creator/lifecycle-service';
import { createCreatorPresetMaterializer } from '../../../../src/main/features/creator/materializer';
import { proposeCreatorPreset } from '../../../../src/main/features/creator/proposal-service';
import { verifyCreatorPreset, creatorManifestDigest } from '../../../../src/main/features/creator/verification-service';
import { activateUser } from '../../../../src/main/features/users';
import { drainReportWrites } from '../../../../src/main/quality/report';

const userId = 'creator-local-golden-path-user';
const workspaceRoot = process.env.COGSEED_WORKSPACE_ROOT as string;

const catalog: CreatorCapabilityDescriptor[] = [
  {
    capabilityId: 'model.provider-main.local-model',
    version: '1',
    kind: 'model',
    displayName: 'Local model',
    available: true,
    permissions: ['cost'],
    sourceRef: 'provider.provider-main',
    health: 'ready',
  },
  {
    capabilityId: 'tool.search',
    version: '1',
    kind: 'tool',
    displayName: 'Search',
    available: true,
    permissions: ['read'],
    sourceRef: 'agent-capability.search',
    health: 'ready',
  },
];

const proposal = JSON.stringify({
  schemaVersion: 1,
  presetId: 'local-research',
  version: '1',
  displayName: 'Local research agent',
  description: 'Researches locally through the CogSeed runtime.',
  presetType: 'cogseed-agent',
  model: { providerId: 'provider-main', modelId: 'local-model' },
  capabilities: [{ capabilityId: 'tool.search', version: '1' }],
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
  provenance: { createdBy: 'creator-agent', sourceSessionId: 'untrusted', sourceAssetRefs: [] },
});

beforeEach(async () => {
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
  activateUser(userId);
});

afterEach(async () => {
  await drainReportWrites();
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
});

describe('Creator local CogSeed agent golden path', () => {
  it('proposes, verifies, approves, publishes, materializes, and activates using the existing CogSeed runtime', async () => {
    const { draft } = await proposeCreatorPreset(userId, {
      goal: 'Create a local read-only research agent.',
      sourceSessionId: 'creator-source-session',
    }, {
      runModel: async () => proposal,
      buildCatalog: async () => catalog,
      getLocale: () => 'en',
      createId: () => 'local-proposal-1',
      now: () => '2026-08-25T01:00:00.000Z',
    });

    const verification = await verifyCreatorPreset(userId, {
      manifest: draft.manifest,
      catalogSnapshot: catalog,
    }, {
      createId: () => 'local-verification-1',
      buildCatalog: async () => catalog,
      now: (() => {
        const values = ['2026-08-25T01:01:00.000Z', '2026-08-25T01:01:01.000Z'];
        return () => values.shift() ?? '2026-08-25T01:01:01.000Z';
      })(),
    });
    expect(verification.status).toBe('passed');

    const lifecycle = createCreatorLifecycleService({
      buildCatalog: async () => catalog,
    });
    const draftDigest = creatorManifestDigest(draft.manifest);
    await lifecycle.sandboxPreset(userId, draft.draftId, draftDigest);
    await lifecycle.recordVerification(userId, draft.draftId, verification);
    await lifecycle.approvePreset(userId, draft.draftId, {
      draftId: draft.draftId,
      manifestDigest: draftDigest,
      verificationRunId: verification.runId,
      actorId: 'local-user',
      confirmedAt: '2026-08-25T01:02:00.000Z',
      approved: true,
      approvedCapabilities: ['tool.search'],
      approvedSideEffects: [],
    });
    const published = await lifecycle.publishPreset(userId, draft.draftId, {
      version: '1',
      manifestDigest: draftDigest,
      verificationRunId: verification.runId,
    });

    const binding = await createCreatorPresetMaterializer({
      resolveCapabilities: async () => ({ skillIds: [] }),
      createRevision: () => 'local-revision-1',
      now: () => '2026-08-25T01:03:00.000Z',
    }).materializeCreatorPreset(userId, {
      presetId: draft.manifest.presetId,
      version: '1',
      manifestDigest: published.manifestDigest,
    });
    await lifecycle.activatePreset(userId, draft.manifest.presetId, '1');

    const agent = await getAgentRuntimeSpecForUser(userId, binding.agentId);
    expect(agent).toMatchObject({
      source: 'custom',
      creator_binding: {
        presetId: 'local-research',
        version: '1',
        manifestDigest: published.manifestDigest,
      },
    });
    expect(agent?.runtime?.kind).not.toBe('p3394-gateway');
    expect(agent?.workflow).not.toMatch(/P3394|external-agent delegation/i);
    expect(draft.manifest.remote).toBeUndefined();
  });
});
