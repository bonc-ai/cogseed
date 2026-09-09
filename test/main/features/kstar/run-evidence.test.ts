import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-run-evidence-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

function usageReceiptId(input: {
  taskRunId: string;
  projectionId: string;
  assetId: string;
  assetVersion: string;
}): string {
  const key = JSON.stringify([input.taskRunId, input.projectionId, input.assetId, input.assetVersion]);
  return `aur-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

async function createVersionedAsset(
  userId: string,
  assetId: string,
  statementV1: string,
  statementV2 = `${statementV1} revised`,
) {
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const createdAt = '2026-09-10T02:00:00.000Z';
  const v1 = await assets.createSystemAbilityAsset(userId, {
    schemaVersion: 1,
    ownerId: userId,
    id: assetId,
    candidateId: `candidate-${assetId}`,
    reviewDecisionId: `rd_${assetId.replace(/-/g, '_')}_create`,
    type: 'template',
    title: `Asset ${assetId}`,
    statement: statementV1,
    evidenceRefs: [{ kind: 'memory', id: `memory-${assetId}` }],
    scope: 'product',
    status: 'active',
    lifecycleStatus: 'automatically_extracted_unverified',
    maturity: 'seed',
    version: '1',
    createdAt,
    updatedAt: createdAt,
  }, 'seed KSTAR run-evidence fixture');
  const v2 = await assets.updateAbilityAsset(userId, assetId, {
    statement: statementV2,
    reason: 'create a newer live version for historical evidence testing',
    actor: 'user',
  });
  return { v1, v2 };
}

async function seedLinkedRun(input: {
  userId: string;
  suffix: string;
  taskRunId: string;
  projection: Record<string, unknown>;
  reuseTurnIds: string[];
  executionId?: string;
  reuseTurnIdsTruncated?: boolean;
}) {
  const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
  const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
  const recallStore = await import('../../../../src/main/features/recall/store');
  const conversationId = `conversation-${input.suffix}`;
  const task = requirementStore.createKstarTaskRecord(input.userId, {
    conversationId,
    title: `Task ${input.suffix}`,
  });
  const requirement = requirementStore.createKstarRequirementRecord(input.userId, {
    taskId: task.id,
    conversationId,
    userMessageIds: [`message-${input.suffix}`],
    title: `Requirement ${input.suffix}`,
    goalText: `Complete ${input.suffix}`,
  });
  const projection = {
    schemaVersion: 2,
    ownerId: input.userId,
    taskRunId: task.id,
    conversationId,
    purpose: `Evidence for ${input.suffix}`,
    authorization: 'workspace_policy',
    sourceRefs: [],
    omittedRefs: [],
    status: 'confirmed',
    createdAt: '2026-09-10T02:10:00.000Z',
    confirmedAt: '2026-09-10T02:10:00.000Z',
    ...input.projection,
  };
  await recallStore.writeRecallJsonRecord(input.userId, 'projections', String(projection.id), projection);
  const episode = {
    schemaVersion: 1 as const,
    ownerId: input.userId,
    id: `episode-${input.suffix}`,
    sessionId: `session-${input.suffix}`,
    taskRunId: input.taskRunId,
    reuseTurnIds: input.reuseTurnIds,
    ...(input.reuseTurnIdsTruncated === true ? { reuseTurnIdsTruncated: true as const } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
    projectionId: String(projection.id),
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [...(projection.assetIds as string[])] },
    s: { conversationSummary: conversationId },
    t: { userGoal: `Complete ${input.suffix}`, constraints: [] },
    a: { toolCalls: [], agentActions: [] },
    r: { status: 'completed' as const, producedFiles: [] },
    evidenceRefs: [],
    createdAt: '2026-09-10T02:11:00.000Z',
    updatedAt: '2026-09-10T02:11:00.000Z',
  };
  await episodeStore.writeKstarEpisode(input.userId, episode);
  await requirementStore.replaceKstarRequirement(input.userId, {
    ...requirement,
    projectionId: String(projection.id),
    projectionIds: [String(projection.id)],
    episodeIds: [episode.id],
  });
  await requirementStore.replaceKstarTask(input.userId, {
    ...task,
    requirementIds: [requirement.id],
    currentRequirementId: requirement.id,
  });
  return { task, requirement, projection, episode };
}

describe('KSTAR run evidence', () => {
  it('isolates aggregate-run evidence through logical-task, Episode, Projection, and per-turn receipt references', async () => {
    const userId = 'user-a';
    const conversationId = 'conversation-shared';
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const reviewService = await import('../../../../src/main/features/kstar/review-service');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');

    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId,
      title: 'Two isolated aggregate runs',
    });
    const requirementA = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId,
      userMessageIds: ['message-a'],
      title: 'Aggregate run A',
      goalText: 'Complete aggregate run A',
    });
    const requirementB = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId,
      userMessageIds: ['message-b'],
      title: 'Aggregate run B',
      goalText: 'Complete aggregate run B',
    });

    const projectionA = {
      schemaVersion: 2,
      ownerId: userId,
      id: 'projection-run-a',
      taskRunId: task.id,
      conversationId,
      purpose: 'aggregate run A evidence',
      authorization: 'workspace_policy',
      assetIds: ['asset-shared'],
      assetVersions: { 'asset-shared': '1' },
      sourceRefs: [],
      omittedRefs: [],
      status: 'confirmed',
      createdAt: '2026-09-10T00:00:00.000Z',
      confirmedAt: '2026-09-10T00:00:00.000Z',
    };
    const projectionB = {
      ...projectionA,
      id: 'projection-run-b',
      purpose: 'aggregate run B evidence',
      createdAt: '2026-09-10T00:01:00.000Z',
      confirmedAt: '2026-09-10T00:01:00.000Z',
    };
    const projectionAAlternate = {
      ...projectionA,
      id: 'projection-run-a-alternate',
      purpose: 'aggregate run A alternate evidence',
      createdAt: '2026-09-10T00:01:30.000Z',
      confirmedAt: '2026-09-10T00:01:30.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'projections', projectionA.id, projectionA);
    await recallStore.writeRecallJsonRecord(userId, 'projections', projectionB.id, projectionB);
    await recallStore.writeRecallJsonRecord(userId, 'projections', projectionAAlternate.id, projectionAAlternate);

    const episodeA = {
      schemaVersion: 1 as const,
      ownerId: userId,
      id: 'episode-run-a',
      sessionId: 'session-run-a',
      taskRunId: 'aggregate-run-a',
      reuseTurnIds: [
        'turn-a-bound',
        'turn-a-plain',
        'turn-forged-injection',
        'turn-forged-task-source',
        'turn-forged-task-usage',
        'turn-forged-projection',
        'turn-forged-asset',
        'turn-forged-version',
        'turn-forged-boundary',
      ],
      projectionId: projectionA.id,
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: ['asset-shared'] },
      s: { conversationSummary: conversationId },
      t: { userGoal: 'Complete aggregate run A', constraints: [] },
      a: { toolCalls: [], agentActions: [] },
      r: { status: 'completed' as const, producedFiles: [] },
      evidenceRefs: [],
      createdAt: '2026-09-10T00:02:00.000Z',
      updatedAt: '2026-09-10T00:02:00.000Z',
    };
    const episodeB = {
      ...episodeA,
      id: 'episode-run-b',
      sessionId: 'session-run-b',
      taskRunId: 'aggregate-run-b',
      reuseTurnIds: ['turn-b'],
      projectionId: projectionB.id,
      t: { userGoal: 'Complete aggregate run B', constraints: [] },
      createdAt: '2026-09-10T00:03:00.000Z',
      updatedAt: '2026-09-10T00:03:00.000Z',
    };
    const episodeAAlternate = {
      ...episodeA,
      id: 'episode-run-a-alternate',
      sessionId: 'session-run-a-alternate',
      reuseTurnIds: [],
      projectionId: projectionAAlternate.id,
      createdAt: '2026-09-10T00:03:30.000Z',
      updatedAt: '2026-09-10T00:03:30.000Z',
    };
    await episodeStore.writeKstarEpisode(userId, episodeA);
    await episodeStore.writeKstarEpisode(userId, episodeB);
    await episodeStore.writeKstarEpisode(userId, episodeAAlternate);

    await requirementStore.replaceKstarRequirement(userId, {
      ...requirementA,
      projectionId: projectionA.id,
      projectionIds: [projectionA.id, projectionAAlternate.id],
      episodeIds: [episodeA.id, episodeAAlternate.id],
    });
    await requirementStore.replaceKstarRequirement(userId, {
      ...requirementB,
      projectionId: projectionB.id,
      projectionIds: [projectionB.id],
      episodeIds: [episodeB.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirementA.id, requirementB.id],
      currentRequirementId: requirementB.id,
    });

    const reviewA = reviewService.createInitialKstarReview(episodeA);
    const reviewB = reviewService.createInitialKstarReview(episodeB);
    await reviewService.saveKstarReviewRecord(userId, reviewA);
    await reviewService.saveKstarReviewRecord(userId, reviewB);

    const injectionA = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-a-bound',
      projectionId: projectionA.id,
      assetId: 'asset-shared',
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'injection-message-a',
    });
    const projectionlessA = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-a-plain',
      assetId: 'asset-authoritative-only',
      assetVersion: '1',
      boundary: 'real',
      status: 'dispatched',
      messageId: 'injection-message-a-plain',
    });
    const injectionB = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-b',
      projectionId: projectionB.id,
      assetId: 'asset-shared',
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'injection-message-b',
    });
    const mismatchedProjectionInjection = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-a-bound',
      projectionId: projectionB.id,
      assetId: 'asset-shared',
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'injection-message-mismatched-projection',
    });
    const usageA = await usage.recordAssetUsageReceipt(userId, {
      taskRunId: 'turn-a-bound',
      projectionId: projectionA.id,
      assetId: 'asset-shared',
      assetVersion: '1',
      injectionReceiptId: injectionA.id,
      status: 'usage_unknown',
      evidenceRefs: [],
      evidenceKind: 'none',
      boundary: 'real',
    });
    const usageB = await usage.recordAssetUsageReceipt(userId, {
      taskRunId: 'turn-b',
      projectionId: projectionB.id,
      assetId: 'asset-shared',
      assetVersion: '1',
      injectionReceiptId: injectionB.id,
      status: 'usage_unknown',
      evidenceRefs: [],
      evidenceKind: 'none',
      boundary: 'real',
    });

    // Same aggregate run, different logical Task, same conversation and asset.
    // Its projection-less receipt must not leak through the shared asset id.
    const otherTask = requirementStore.createKstarTaskRecord(userId, {
      conversationId,
      title: 'Other logical task',
    });
    const otherRequirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: otherTask.id,
      conversationId,
      userMessageIds: ['message-other'],
      title: 'Other task run',
      goalText: 'Complete another task in the same aggregate run',
    });
    const otherEpisode = {
      ...episodeA,
      id: 'episode-other-task',
      sessionId: 'session-other-task',
      reuseTurnIds: ['turn-other-task'],
      projectionId: undefined,
      t: { userGoal: 'Other task', constraints: [] },
      createdAt: '2026-09-10T00:04:00.000Z',
      updatedAt: '2026-09-10T00:04:00.000Z',
    };
    await episodeStore.writeKstarEpisode(userId, otherEpisode);
    await requirementStore.replaceKstarRequirement(userId, {
      ...otherRequirement,
      episodeIds: [otherEpisode.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...otherTask,
      requirementIds: [otherRequirement.id],
      currentRequirementId: otherRequirement.id,
    });
    const otherProjectionless = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-other-task',
      assetId: 'asset-authoritative-only',
      assetVersion: '1',
      boundary: 'real',
      status: 'dispatched',
      messageId: 'injection-message-other',
    });

    const relationshipInjections = await Promise.all([
      ['turn-forged-injection', 'asset-forged-injection', 'message-forged-injection'],
      ['turn-forged-task-source', 'asset-forged-task', 'message-forged-task'],
      ['turn-forged-projection', 'asset-forged-projection', 'message-forged-projection'],
      ['turn-forged-asset', 'asset-forged-asset-source', 'message-forged-asset'],
      ['turn-forged-version', 'asset-forged-version', 'message-forged-version'],
      ['turn-forged-boundary', 'asset-forged-boundary', 'message-forged-boundary'],
    ].map(([taskRunId, assetId, messageId]) => injections.recordInjectionReceipt(userId, {
      taskRunId,
      projectionId: projectionA.id,
      assetId,
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId,
    })));
    const usageBase = (injection: typeof relationshipInjections[number]) => ({
      schemaVersion: 1,
      ownerId: userId,
      taskRunId: injection.taskRunId,
      projectionId: injection.projectionId!,
      assetId: injection.assetId,
      assetVersion: injection.assetVersion,
      injectionReceiptId: injection.id,
      status: 'usage_unknown',
      evidenceRefs: [],
      evidenceKind: 'none',
      boundary: injection.boundary,
      createdAt: '2026-09-10T00:05:00.000Z',
    });
    const forgedUsage = [
      { ...usageBase(relationshipInjections[0]), injectionReceiptId: 'injection-unowned' },
      { ...usageBase(relationshipInjections[1]), taskRunId: 'turn-forged-task-usage' },
      { ...usageBase(relationshipInjections[2]), projectionId: projectionAAlternate.id },
      { ...usageBase(relationshipInjections[3]), assetId: 'asset-forged-asset-usage' },
      { ...usageBase(relationshipInjections[4]), assetVersion: '2' },
      { ...usageBase(relationshipInjections[5]), boundary: 'test-double' },
    ].map((record) => {
      return {
        ...record,
        id: usageReceiptId(record),
      };
    });
    expect(new Set([usageA.id, ...forgedUsage.map((record) => record.id)]).size)
      .toBe(forgedUsage.length + 1);
    for (const record of forgedUsage) {
      await recallStore.appendRecallJsonlRecord(userId, 'asset-usage-receipts', 'events', record);
    }

    const listInjections = vi.spyOn(injections, 'listInjectionReceipts');
    const listUsage = vi.spyOn(usage, 'listAssetUsageReceipts');
    listInjections.mockClear();
    listUsage.mockClear();
    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: 'aggregate-run-a',
    });

    expect(listInjections).toHaveBeenCalledTimes(1);
    expect(listInjections).toHaveBeenCalledWith(userId);
    expect(listUsage).toHaveBeenCalledTimes(1);
    expect(listUsage).toHaveBeenCalledWith(userId);
    expect(result).toMatchObject({
      taskId: task.id,
      taskRunId: 'aggregate-run-a',
      conversationId,
      requirementIds: [requirementA.id],
      projections: [projectionA, projectionAAlternate].sort((left, right) => left.id.localeCompare(right.id)),
      injectionReceipts: [injectionA, projectionlessA, ...relationshipInjections]
        .sort((left, right) => left.id.localeCompare(right.id)),
      usageReceipts: [usageA],
      episodes: [episodeA, episodeAAlternate].sort((left, right) => left.id.localeCompare(right.id)),
      reviews: [reviewA],
      generatedAt: expect.any(String),
    });
    expect(result.assets.map(({ assetId, assetVersion }) => ({ assetId, assetVersion }))).toEqual([
      { assetId: 'asset-authoritative-only', assetVersion: '1' },
      { assetId: 'asset-forged-asset-source', assetVersion: '1' },
      { assetId: 'asset-forged-boundary', assetVersion: '1' },
      { assetId: 'asset-forged-injection', assetVersion: '1' },
      { assetId: 'asset-forged-projection', assetVersion: '1' },
      { assetId: 'asset-forged-task', assetVersion: '1' },
      { assetId: 'asset-forged-version', assetVersion: '1' },
      { assetId: 'asset-shared', assetVersion: '1' },
    ]);
    expect(result.assets.find((asset) => asset.assetId === 'asset-shared')).toMatchObject({
      injectionReceipts: [injectionA],
      usageReceipts: [usageA],
    });
    expect(result.assets.find((asset) => asset.assetId === 'asset-authoritative-only')).toMatchObject({
      injectionReceipts: [projectionlessA],
      usageReceipts: [],
    });
    for (const forged of forgedUsage) {
      expect(result.usageReceipts, forged.id).not.toContainEqual(expect.objectContaining({ id: forged.id }));
    }
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);

    const serialized = JSON.stringify(result);
    for (const excludedId of [
      'aggregate-run-b',
      requirementB.id,
      projectionB.id,
      injectionB.id,
      mismatchedProjectionInjection.id,
      usageB.id,
      episodeB.id,
      reviewB.id,
      'session-run-b',
      'turn-b',
      'injection-message-mismatched-projection',
      otherTask.id,
      otherRequirement.id,
      otherEpisode.id,
      otherProjectionless.id,
      'turn-other-task',
      'injection-message-other',
      'injection-unowned',
      'asset-mismatch',
    ]) {
      expect(serialized).not.toContain(excludedId);
    }
  });

  it('does not read receipt stores when the authoritative reuse turn list is empty', async () => {
    const userId = 'user-a';
    const conversationId = 'conversation-empty-receipts';
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId,
      title: 'No receipt reads',
    });
    const requirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId,
      userMessageIds: ['message-empty-receipts'],
      title: 'Empty authoritative receipt list',
      goalText: 'Return evidence without scanning receipt stores',
    });
    const episode = {
      schemaVersion: 1 as const,
      ownerId: userId,
      id: 'episode-empty-receipts',
      sessionId: 'session-empty-receipts',
      taskRunId: 'aggregate-empty-receipts',
      reuseTurnIds: [],
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
      s: { conversationSummary: conversationId },
      t: { userGoal: 'Return evidence without scanning receipt stores', constraints: [] },
      a: { toolCalls: [], agentActions: [] },
      r: { status: 'completed' as const, producedFiles: [] },
      evidenceRefs: [],
      createdAt: '2026-09-10T00:10:00.000Z',
      updatedAt: '2026-09-10T00:10:00.000Z',
    };
    await episodeStore.writeKstarEpisode(userId, episode);
    await requirementStore.replaceKstarRequirement(userId, {
      ...requirement,
      episodeIds: [episode.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });

    const listInjections = vi.spyOn(injections, 'listInjectionReceipts');
    const listUsage = vi.spyOn(usage, 'listAssetUsageReceipts');
    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: episode.taskRunId,
    });

    expect(listInjections).not.toHaveBeenCalled();
    expect(listUsage).not.toHaveBeenCalled();
    expect(result.injectionReceipts).toEqual([]);
    expect(result.usageReceipts).toEqual([]);
  });

  it('treats only a missing linked Projection as absent and surfaces malformed persisted data', async () => {
    const userId = 'user-a';
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId: 'conversation-malformed',
      title: 'Malformed projection task',
    });
    const requirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId: task.conversationId,
      userMessageIds: ['message-malformed'],
      title: 'Malformed projection requirement',
      goalText: 'Read the referenced projection',
    });
    const episode = {
      schemaVersion: 1 as const,
      ownerId: userId,
      id: 'episode-missing-projection',
      sessionId: 'session-missing-projection',
      taskRunId: 'aggregate-malformed',
      reuseTurnIds: [],
      projectionId: 'projection-missing',
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
      s: {},
      t: { userGoal: 'Read the referenced projection', constraints: [] },
      a: { toolCalls: [], agentActions: [] },
      r: { status: 'completed' as const, producedFiles: [] },
      evidenceRefs: [],
      createdAt: '2026-09-10T01:00:00.000Z',
      updatedAt: '2026-09-10T01:00:00.000Z',
    };
    expect(episode.projectionId).toBe('projection-missing');
    await episodeStore.writeKstarEpisode(userId, episode);
    await requirementStore.replaceKstarRequirement(userId, {
      ...requirement,
      projectionId: 'projection-missing',
      projectionIds: ['projection-missing'],
      episodeIds: [episode.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    await expect(readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: episode.taskRunId,
    })).resolves.toMatchObject({
      requirementIds: [requirement.id],
      projections: [],
      episodes: [episode],
    });

    await recallStore.writeRecallJsonRecord(userId, 'projections', 'projection-missing', {
      schemaVersion: 2,
      ownerId: userId,
      id: 'projection-missing',
      taskRunId: task.id,
      purpose: 'malformed',
      authorization: 'workspace_policy',
      status: 'confirmed',
      createdAt: '2026-09-10T01:00:00.000Z',
    });

    await expect(readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: episode.taskRunId,
    })).rejects.toThrow('malformed context projection');
  });

  it('freezes historical asset versions and keeps owned proof and validation facts separate', async () => {
    const userId = 'user-assets';
    const assetId = 'asset-frozen';
    const { v2 } = await createVersionedAsset(
      userId,
      assetId,
      'Use the approved v1 delivery checklist.',
      'Use the replacement v2 delivery checklist.',
    );
    expect(v2.version).toBe('2');
    const linked = await seedLinkedRun({
      userId,
      suffix: 'frozen',
      taskRunId: 'aggregate-frozen',
      executionId: 'execution-frozen',
      reuseTurnIds: ['turn-frozen'],
      projection: {
        id: 'projection-frozen',
        assetIds: [assetId],
        assetVersions: { [assetId]: '1' },
        assetMatches: [
          { assetId, matchScore: 0.91, matchMethod: 'semantic' },
          { assetId: 'asset-unowned', matchScore: 0.99, matchMethod: 'semantic' },
        ],
      },
    });
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const injection = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-frozen',
      projectionId: 'projection-frozen',
      assetId,
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'message-frozen-injection',
    });
    const usageReceipt = await usage.recordAssetUsageReceipt(userId, {
      taskRunId: 'turn-frozen',
      projectionId: 'projection-frozen',
      assetId,
      assetVersion: '1',
      injectionReceiptId: injection.id,
      status: 'usage_unknown',
      evidenceRefs: [],
      evidenceKind: 'none',
      boundary: 'real',
    });
    const transfer = {
      schemaVersion: 1,
      ownerId: userId,
      id: 'tp-owned-frozen',
      projectionId: 'projection-frozen',
      executionId: 'execution-frozen',
      expectedResultSnapshot: 'Expected delivery result.',
      assetVersions: [{ assetId, version: '1' }],
      status: 'succeeded',
      observedTransfer: 'Asset was available to the run.',
      createdAt: '2026-09-10T02:12:00.000Z',
      completedAt: '2026-09-10T02:13:00.000Z',
    };
    const aggregateTransfer = {
      ...transfer,
      id: 'tp-aggregate-frozen',
      executionId: linked.episode.taskRunId,
      createdAt: '2026-09-10T02:13:30.000Z',
    };
    const foreignTransfer = {
      ...transfer,
      id: 'tp-foreign-execution',
      executionId: 'execution-foreign',
      createdAt: '2026-09-10T02:14:00.000Z',
    };
    const foreignProjectionTransfer = {
      ...transfer,
      id: 'tp-foreign-projection',
      projectionId: 'projection-foreign',
      createdAt: '2026-09-10T02:15:00.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'transfer-proofs', transfer.id, transfer);
    await recallStore.writeRecallJsonRecord(userId, 'transfer-proofs', aggregateTransfer.id, aggregateTransfer);
    await recallStore.writeRecallJsonRecord(userId, 'transfer-proofs', foreignTransfer.id, foreignTransfer);
    await recallStore.writeRecallJsonRecord(userId, 'transfer-proofs', foreignProjectionTransfer.id, foreignProjectionTransfer);
    const effectiveness = {
      schemaVersion: 1,
      ownerId: userId,
      id: 'ep-owned-frozen',
      transferProofId: transfer.id,
      outcome: 'worse',
      status: 'valid',
      observedResult: 'The outcome regressed.',
      evidenceRefs: [],
      createdAt: '2026-09-10T02:16:00.000Z',
    };
    const aggregateEffectiveness = {
      ...effectiveness,
      id: 'ep-aggregate-frozen',
      transferProofId: aggregateTransfer.id,
      createdAt: '2026-09-10T02:16:30.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'effectiveness-proofs', effectiveness.id, effectiveness);
    await recallStore.writeRecallJsonRecord(
      userId,
      'effectiveness-proofs',
      aggregateEffectiveness.id,
      aggregateEffectiveness,
    );
    await recallStore.writeRecallJsonRecord(userId, 'effectiveness-proofs', 'ep-foreign-frozen', {
      ...effectiveness,
      id: 'ep-foreign-frozen',
      transferProofId: foreignTransfer.id,
    });
    const validation = {
      schemaVersion: 1,
      ownerId: userId,
      id: 'val-owned-frozen',
      assetId,
      candidateId: `candidate-${assetId}`,
      taskRunId: transfer.executionId,
      outcome: 'failure',
      evidenceRefs: [],
      createdAt: '2026-09-10T02:17:00.000Z',
    };
    const aggregateValidation = {
      ...validation,
      id: 'val-aggregate-frozen',
      taskRunId: aggregateTransfer.executionId,
      createdAt: '2026-09-10T02:17:30.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'validation-records', validation.id, validation);
    await recallStore.writeRecallJsonRecord(
      userId,
      'validation-records',
      aggregateValidation.id,
      aggregateValidation,
    );
    await recallStore.writeRecallJsonRecord(userId, 'validation-records', 'val-foreign-execution', {
      ...validation,
      id: 'val-foreign-execution',
      taskRunId: foreignTransfer.executionId,
    });
    await recallStore.writeRecallJsonRecord(userId, 'validation-records', 'val-foreign-asset', {
      ...validation,
      id: 'val-foreign-asset',
      assetId: 'asset-unowned',
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-frozen',
    });

    expect(result.assets).toEqual([{
      assetId,
      assetVersion: '1',
      snapshot: expect.objectContaining({
        version: '1',
        statement: 'Use the approved v1 delivery checklist.',
      }),
      matches: [{
        projectionId: 'projection-frozen',
        matchScore: 0.91,
        matchMethod: 'semantic',
      }],
      injectionReceipts: [injection],
      usageReceipts: [usageReceipt],
    }]);
    expect(result.transferProofs).toEqual([aggregateTransfer, transfer]);
    expect(result.effectivenessProofs).toEqual([aggregateEffectiveness, effectiveness]);
    expect(result.validations).toEqual([aggregateValidation, validation]);
    expect(result.gaps).toEqual(['review_not_recorded']);
    expect(result.usageReceipts[0]).not.toHaveProperty('successful');
    expect(result.episodes[0]).not.toHaveProperty('applied');
    expect(result.reviews).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('tp-foreign-execution');
    expect(JSON.stringify(result)).not.toContain('tp-foreign-projection');
    expect(JSON.stringify(result)).not.toContain('val-foreign-execution');
    expect(JSON.stringify(result)).not.toContain('val-foreign-asset');
  });

  it('keeps Projection matches scoped to the asset version each Projection locked', async () => {
    const userId = 'user-version-matches';
    const assetId = 'asset-version-matches';
    await createVersionedAsset(userId, assetId, 'Version one.', 'Version two.');
    const linked = await seedLinkedRun({
      userId,
      suffix: 'version-match-one',
      taskRunId: 'aggregate-version-matches',
      reuseTurnIds: [],
      projection: {
        id: 'projection-version-one',
        assetIds: [assetId],
        assetVersions: { [assetId]: '1' },
        assetMatches: [{ assetId, matchScore: 0.21, matchMethod: 'semantic' }],
      },
    });
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const secondRequirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: linked.task.id,
      conversationId: linked.task.conversationId,
      userMessageIds: ['message-version-match-two'],
      title: 'Version two match',
      goalText: 'Use version two',
    });
    const secondProjection = {
      ...linked.projection,
      id: 'projection-version-two',
      purpose: 'Evidence for version two',
      assetVersions: { [assetId]: '2' },
      assetMatches: [{ assetId, matchScore: 0.92, matchMethod: 'semantic' }],
      createdAt: '2026-09-10T02:12:00.000Z',
      confirmedAt: '2026-09-10T02:12:00.000Z',
    };
    const secondEpisode = {
      ...linked.episode,
      id: 'episode-version-match-two',
      sessionId: 'session-version-match-two',
      projectionId: secondProjection.id,
      createdAt: '2026-09-10T02:13:00.000Z',
      updatedAt: '2026-09-10T02:13:00.000Z',
    };
    await recallStore.writeRecallJsonRecord(
      userId,
      'projections',
      secondProjection.id,
      secondProjection,
    );
    await episodeStore.writeKstarEpisode(userId, secondEpisode);
    await requirementStore.replaceKstarRequirement(userId, {
      ...secondRequirement,
      projectionId: secondProjection.id,
      projectionIds: [secondProjection.id],
      episodeIds: [secondEpisode.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...linked.task,
      requirementIds: [linked.requirement.id, secondRequirement.id],
      currentRequirementId: secondRequirement.id,
    });

    const assets = await import('../../../../src/main/features/recall/asset-service');
    const listVersions = vi.spyOn(assets, 'listAbilityAssetVersions');
    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-version-matches',
    });

    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(listVersions).toHaveBeenCalledWith(userId, assetId);
    expect(result.assets.map(({ assetVersion, matches }) => ({ assetVersion, matches }))).toEqual([
      {
        assetVersion: '1',
        matches: [{
          projectionId: 'projection-version-one',
          matchScore: 0.21,
          matchMethod: 'semantic',
        }],
      },
      {
        assetVersion: '2',
        matches: [{
          projectionId: 'projection-version-two',
          matchScore: 0.92,
          matchMethod: 'semantic',
        }],
      },
    ]);
  });

  it('reports a snapshot gap for a legacy Projection asset without guessing its live version', async () => {
    const userId = 'user-legacy-unlocked';
    const assetId = 'asset-legacy-unlocked';
    await createVersionedAsset(userId, assetId, 'Live content must not be guessed.');
    const linked = await seedLinkedRun({
      userId,
      suffix: 'legacy-unlocked',
      taskRunId: 'aggregate-legacy-unlocked',
      reuseTurnIds: [],
      projection: {
        id: 'projection-legacy-unlocked',
        assetIds: [assetId],
      },
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-legacy-unlocked',
    });

    expect(result.assets).toEqual([]);
    expect(result.gaps).toContain('asset_version_snapshot_not_recorded');
  });

  it('returns a null locked snapshot without guessing an unlocked live asset version', async () => {
    const userId = 'user-missing-snapshot';
    await createVersionedAsset(userId, 'asset-missing-snapshot', 'Existing v1 statement.');
    await createVersionedAsset(userId, 'asset-unlocked-live', 'Never infer this version.');
    const linked = await seedLinkedRun({
      userId,
      suffix: 'missing-snapshot',
      taskRunId: 'aggregate-missing-snapshot',
      reuseTurnIds: [],
      projection: {
        id: 'projection-missing-snapshot',
        assetIds: ['asset-missing-snapshot', 'asset-unlocked-live'],
        assetVersions: { 'asset-missing-snapshot': '99' },
      },
    });

    const assets = await import('../../../../src/main/features/recall/asset-service');
    const listVersions = vi.spyOn(assets, 'listAbilityAssetVersions');
    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-missing-snapshot',
    });

    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(listVersions).toHaveBeenCalledWith(userId, 'asset-missing-snapshot');
    expect(result.assets).toEqual([expect.objectContaining({
      assetId: 'asset-missing-snapshot',
      assetVersion: '99',
      snapshot: null,
    })]);
    expect(result.gaps).toEqual([
      'asset_version_snapshot_not_recorded',
      'review_not_recorded',
      'effectiveness_not_recorded',
    ]);
    // Explicit empty reuseTurnIds means no per-turn receipts were expected, so
    // absence of receipts must not be reported as injection/usage gaps.
    expect(result.gaps).not.toContain('injection_not_recorded');
    expect(result.gaps).not.toContain('usage_not_recorded');
  });

  it('propagates corrupt asset version history instead of treating it as missing evidence', async () => {
    const userId = 'user-snapshot-error';
    const assetId = 'asset-snapshot-error';
    await createVersionedAsset(userId, assetId, 'Snapshot read errors are not absence.');
    const linked = await seedLinkedRun({
      userId,
      suffix: 'snapshot-error',
      taskRunId: 'aggregate-snapshot-error',
      reuseTurnIds: [],
      projection: {
        id: 'projection-snapshot-error',
        assetIds: [assetId],
        assetVersions: { [assetId]: '1' },
      },
    });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const recallPaths = await import('../../../../src/main/features/recall/paths');
    fs.writeFileSync(
      recallPaths.recallJsonlPath(userId, 'ability-asset-versions', assetId),
      '{not valid json\n',
      'utf8',
    );
    const listVersions = vi.spyOn(assets, 'listAbilityAssetVersions');
    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');

    await expect(readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-snapshot-error',
    })).rejects.toThrow(
      'recall JSONL ability-asset-versions/asset-snapshot-error line 1: invalid JSON',
    );
    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(listVersions).toHaveBeenCalledWith(userId, assetId);
  });

  it('does not bind projections or receipts to an aggregate run without an authoritative Episode', async () => {
    const userId = 'user-unlinked';
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId: 'conversation-unlinked',
      title: 'Unlinked evidence',
    });
    const requirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId: task.conversationId,
      userMessageIds: ['message-unlinked'],
      title: 'Unlinked requirement',
      goalText: 'Do not infer aggregate ownership',
    });
    const projection = {
      schemaVersion: 2,
      ownerId: userId,
      id: 'projection-unlinked',
      taskRunId: task.id,
      conversationId: task.conversationId,
      purpose: 'Confirmed but not linked to the aggregate run',
      authorization: 'workspace_policy',
      assetIds: ['asset-unlinked'],
      assetVersions: { 'asset-unlinked': '1' },
      sourceRefs: [],
      omittedRefs: [],
      status: 'confirmed',
      createdAt: '2026-09-10T03:00:00.000Z',
      confirmedAt: '2026-09-10T03:00:00.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'projections', projection.id, projection);
    await requirementStore.replaceKstarRequirement(userId, {
      ...requirement,
      projectionId: projection.id,
      projectionIds: [projection.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });
    const injection = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'aggregate-unlinked',
      projectionId: projection.id,
      assetId: 'asset-unlinked',
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'message-unlinked-injection',
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: 'aggregate-unlinked',
    });

    expect(result.requirementIds).toEqual([]);
    expect(result.projections).toEqual([]);
    expect(result.assets).toEqual([]);
    expect(result.injectionReceipts).toEqual([]);
    expect(result.episodes).toEqual([]);
    expect(result.gaps).toEqual([
      'task_run_not_linked',
      'projection_not_recorded',
      'injection_not_recorded',
      'usage_not_recorded',
      'execution_not_recorded',
      'review_not_recorded',
      'effectiveness_not_recorded',
    ]);
    expect(JSON.stringify(result)).not.toContain(injection.id);
    expect(result).not.toHaveProperty('successful');
    expect(result).not.toHaveProperty('applied');
    expect(result).not.toHaveProperty('better');
  });

  it('reports missing evaluation evidence without claiming execution is absent when an Episode exists', async () => {
    const userId = 'user-conservative-gaps';
    const assetId = 'asset-conservative-gaps';
    await createVersionedAsset(userId, assetId, 'Use the recorded delivery fact.');
    const linked = await seedLinkedRun({
      userId,
      suffix: 'conservative-gaps',
      taskRunId: 'aggregate-conservative-gaps',
      reuseTurnIds: ['turn-conservative-gaps'],
      projection: {
        id: 'projection-conservative-gaps',
        assetIds: [assetId],
        assetVersions: { [assetId]: '1' },
      },
    });
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const injection = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-conservative-gaps',
      projectionId: 'projection-conservative-gaps',
      assetId,
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'message-conservative-gaps',
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-conservative-gaps',
    });

    expect(result.assets).toEqual([expect.objectContaining({
      assetId,
      assetVersion: '1',
      snapshot: expect.objectContaining({ statement: 'Use the recorded delivery fact.' }),
      injectionReceipts: [injection],
      usageReceipts: [],
    })]);
    expect(result.transferProofs).toEqual([]);
    expect(result.effectivenessProofs).toEqual([]);
    expect(result.validations).toEqual([]);
    expect(result.reviews).toEqual([]);
    expect(result.gaps).toEqual([
      'usage_not_recorded',
      'review_not_recorded',
      'effectiveness_not_recorded',
    ]);
    expect(result.gaps).not.toContain('execution_not_recorded');
  });

  it('does not report effectiveness_not_recorded for a terminal unowned Episode when owned Episodes are non-terminal', async () => {
    const userId = 'user-owned-nonterminal';
    const conversationId = 'conversation-owned-nonterminal';
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId,
      title: 'Effectiveness scoped to owned Episodes',
    });
    const requirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId,
      userMessageIds: ['message-owned-nonterminal'],
      title: 'Owned non-terminal requirement',
      goalText: 'Only terminal owned Episodes demand effectiveness evidence',
    });
    const ownedProjection = {
      schemaVersion: 2,
      ownerId: userId,
      id: 'projection-owned-cancelled',
      taskRunId: task.id,
      conversationId,
      purpose: 'Owned but cancelled Episode',
      authorization: 'workspace_policy',
      assetIds: [],
      sourceRefs: [],
      omittedRefs: [],
      status: 'confirmed',
      createdAt: '2026-09-10T04:20:00.000Z',
      confirmedAt: '2026-09-10T04:20:00.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'projections', ownedProjection.id, ownedProjection);
    const ownedEpisode = {
      schemaVersion: 1 as const,
      ownerId: userId,
      id: 'episode-owned-cancelled',
      sessionId: 'session-owned-cancelled',
      taskRunId: 'aggregate-owned-nonterminal',
      reuseTurnIds: [],
      projectionId: ownedProjection.id,
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
      s: { conversationSummary: conversationId },
      t: { userGoal: 'Only terminal owned Episodes demand effectiveness evidence', constraints: [] },
      a: { toolCalls: [], agentActions: [] },
      r: { status: 'cancelled' as const, producedFiles: [] },
      evidenceRefs: [],
      createdAt: '2026-09-10T04:21:00.000Z',
      updatedAt: '2026-09-10T04:21:00.000Z',
    };
    // Terminal Episode matched to the run whose linked Projection record is
    // missing: it is matched but NOT owned, so it must not trigger the legacy
    // effectiveness fallback on its own.
    const unownedTerminalEpisode = {
      ...ownedEpisode,
      id: 'episode-unowned-terminal',
      sessionId: 'session-unowned-terminal',
      reuseTurnIds: ['turn-unowned-terminal'],
      projectionId: 'projection-unowned-terminal',
      r: { status: 'completed' as const, producedFiles: [] },
      createdAt: '2026-09-10T04:21:30.000Z',
      updatedAt: '2026-09-10T04:21:30.000Z',
    };
    await episodeStore.writeKstarEpisode(userId, ownedEpisode);
    await episodeStore.writeKstarEpisode(userId, unownedTerminalEpisode);
    await requirementStore.replaceKstarRequirement(userId, {
      ...requirement,
      projectionId: ownedProjection.id,
      projectionIds: [ownedProjection.id, 'projection-unowned-terminal'],
      episodeIds: [ownedEpisode.id, unownedTerminalEpisode.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: 'aggregate-owned-nonterminal',
    });

    // Both Episodes are matched, but only the cancelled one is owned; the
    // completed Episode's linked Projection is missing so it is not owned.
    expect(result.episodes).toHaveLength(2);
    expect(result.projections.map((projection) => projection.id)).toEqual([ownedProjection.id]);
    expect(result.gaps).not.toContain('effectiveness_not_recorded');
    expect(result.gaps).toEqual(['review_not_recorded']);
  });

  it('reports usage_not_recorded when only one of two assets under a shared linked Projection has Usage', async () => {
    const userId = 'user-per-injection-usage';
    const conversationId = 'conversation-per-injection-usage';
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    await createVersionedAsset(userId, 'asset-per-usage-a', 'Asset A for per-usage coverage.');
    await createVersionedAsset(userId, 'asset-per-usage-b', 'Asset B for per-usage coverage.');
    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId,
      title: 'Per-usage coverage',
    });
    const requirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId,
      userMessageIds: ['message-per-usage'],
      title: 'Per-usage coverage',
      goalText: 'Cover each owned injection with usage',
    });
    const projection = {
      schemaVersion: 2,
      ownerId: userId,
      id: 'projection-per-usage',
      taskRunId: task.id,
      conversationId,
      purpose: 'Two assets under one linked projection',
      authorization: 'workspace_policy',
      assetIds: ['asset-per-usage-a', 'asset-per-usage-b'],
      assetVersions: { 'asset-per-usage-a': '1', 'asset-per-usage-b': '1' },
      sourceRefs: [],
      omittedRefs: [],
      status: 'confirmed',
      createdAt: '2026-09-10T04:00:00.000Z',
      confirmedAt: '2026-09-10T04:00:00.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'projections', projection.id, projection);
    const episode = {
      schemaVersion: 1 as const,
      ownerId: userId,
      id: 'episode-per-usage',
      sessionId: 'session-per-usage',
      taskRunId: 'aggregate-per-usage',
      reuseTurnIds: ['turn-per-usage-a', 'turn-per-usage-b'],
      projectionId: projection.id,
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: projection.assetIds },
      s: { conversationSummary: conversationId },
      t: { userGoal: 'Cover each owned injection with usage', constraints: [] },
      a: { toolCalls: [], agentActions: [] },
      r: { status: 'completed' as const, producedFiles: [] },
      evidenceRefs: [],
      createdAt: '2026-09-10T04:01:00.000Z',
      updatedAt: '2026-09-10T04:01:00.000Z',
    };
    await episodeStore.writeKstarEpisode(userId, episode);
    await requirementStore.replaceKstarRequirement(userId, {
      ...requirement,
      projectionId: projection.id,
      projectionIds: [projection.id],
      episodeIds: [episode.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });
    const injectionA = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-per-usage-a',
      projectionId: projection.id,
      assetId: 'asset-per-usage-a',
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'message-per-usage-a',
    });
    const injectionB = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-per-usage-b',
      projectionId: projection.id,
      assetId: 'asset-per-usage-b',
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'message-per-usage-b',
    });
    await usage.recordAssetUsageReceipt(userId, {
      taskRunId: 'turn-per-usage-a',
      projectionId: projection.id,
      assetId: 'asset-per-usage-a',
      assetVersion: '1',
      injectionReceiptId: injectionA.id,
      status: 'usage_unknown',
      evidenceRefs: [],
      evidenceKind: 'none',
      boundary: 'real',
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: 'aggregate-per-usage',
    });

    expect(result.assets.find((asset) => asset.assetId === 'asset-per-usage-a')).toMatchObject({
      injectionReceipts: [injectionA],
      usageReceipts: [expect.objectContaining({ injectionReceiptId: injectionA.id })],
    });
    expect(result.assets.find((asset) => asset.assetId === 'asset-per-usage-b')).toMatchObject({
      injectionReceipts: [injectionB],
      usageReceipts: [],
    });
    expect(result.gaps).toContain('usage_not_recorded');
    expect(result.gaps).not.toContain('injection_not_recorded');
    expect(result.gaps).not.toContain('execution_not_recorded');
  });

  it('reports review_not_recorded when only one of two matched Episodes has a review', async () => {
    const userId = 'user-per-episode-review';
    const conversationId = 'conversation-per-episode-review';
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const reviewService = await import('../../../../src/main/features/kstar/review-service');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId,
      title: 'Per-episode review',
    });
    const requirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId,
      userMessageIds: ['message-per-episode-review'],
      title: 'Per-episode review',
      goalText: 'Review each owned episode',
    });
    const projectionOne = {
      schemaVersion: 2,
      ownerId: userId,
      id: 'projection-review-one',
      taskRunId: task.id,
      conversationId,
      purpose: 'First owned episode',
      authorization: 'workspace_policy',
      assetIds: [],
      sourceRefs: [],
      omittedRefs: [],
      status: 'confirmed',
      createdAt: '2026-09-10T04:10:00.000Z',
      confirmedAt: '2026-09-10T04:10:00.000Z',
    };
    const projectionTwo = {
      ...projectionOne,
      id: 'projection-review-two',
      purpose: 'Second owned episode',
      createdAt: '2026-09-10T04:10:30.000Z',
      confirmedAt: '2026-09-10T04:10:30.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'projections', projectionOne.id, projectionOne);
    await recallStore.writeRecallJsonRecord(userId, 'projections', projectionTwo.id, projectionTwo);
    const episodeOne = {
      schemaVersion: 1 as const,
      ownerId: userId,
      id: 'episode-review-one',
      sessionId: 'session-review-one',
      taskRunId: 'aggregate-per-episode-review',
      reuseTurnIds: [],
      projectionId: projectionOne.id,
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
      s: { conversationSummary: conversationId },
      t: { userGoal: 'Review each owned episode', constraints: [] },
      a: { toolCalls: [], agentActions: [] },
      r: { status: 'completed' as const, producedFiles: [] },
      evidenceRefs: [],
      createdAt: '2026-09-10T04:11:00.000Z',
      updatedAt: '2026-09-10T04:11:00.000Z',
    };
    const episodeTwo = {
      ...episodeOne,
      id: 'episode-review-two',
      sessionId: 'session-review-two',
      projectionId: projectionTwo.id,
      createdAt: '2026-09-10T04:11:30.000Z',
      updatedAt: '2026-09-10T04:11:30.000Z',
    };
    await episodeStore.writeKstarEpisode(userId, episodeOne);
    await episodeStore.writeKstarEpisode(userId, episodeTwo);
    await requirementStore.replaceKstarRequirement(userId, {
      ...requirement,
      projectionId: projectionOne.id,
      projectionIds: [projectionOne.id, projectionTwo.id],
      episodeIds: [episodeOne.id, episodeTwo.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });
    const reviewOne = reviewService.createInitialKstarReview(episodeOne);
    await reviewService.saveKstarReviewRecord(userId, reviewOne);

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: 'aggregate-per-episode-review',
    });

    expect(result.episodes).toHaveLength(2);
    expect(result.reviews).toHaveLength(1);
    expect(result.gaps).toContain('review_not_recorded');
    expect(result.gaps).not.toContain('execution_not_recorded');
    expect(result.gaps).not.toContain('task_run_not_linked');
  });

  it('reports reuse_turn_ids_truncated when a matched Episode retained only a receipt-id suffix', async () => {
    const userId = 'user-reuse-truncated';
    await createVersionedAsset(userId, 'asset-reuse-truncated', 'Complete ownership is unknown.');
    const linked = await seedLinkedRun({
      userId,
      suffix: 'truncated',
      taskRunId: 'aggregate-truncated',
      reuseTurnIds: ['turn-reuse-truncated'],
      reuseTurnIdsTruncated: true,
      projection: {
        id: 'projection-reuse-truncated',
        assetIds: ['asset-reuse-truncated'],
        assetVersions: { 'asset-reuse-truncated': '1' },
      },
    });
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-reuse-truncated',
      projectionId: 'projection-reuse-truncated',
      assetId: 'asset-reuse-truncated',
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'message-reuse-truncated',
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-truncated',
    });

    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0].reuseTurnIdsTruncated).toBe(true);
    expect(result.gaps).toContain('reuse_turn_ids_truncated');
    expect(result.gaps).not.toContain('execution_not_recorded');
  });

  it('does not report usage or injection gaps when matched Episodes carry explicit empty reuseTurnIds', async () => {
    const userId = 'user-empty-reuse-gaps';
    await createVersionedAsset(userId, 'asset-empty-reuse-gaps', 'No per-turn receipts expected.');
    const linked = await seedLinkedRun({
      userId,
      suffix: 'empty-reuse-gaps',
      taskRunId: 'aggregate-empty-reuse-gaps',
      reuseTurnIds: [],
      projection: {
        id: 'projection-empty-reuse-gaps',
        assetIds: ['asset-empty-reuse-gaps'],
        assetVersions: { 'asset-empty-reuse-gaps': '1' },
      },
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-empty-reuse-gaps',
    });

    expect(result.injectionReceipts).toEqual([]);
    expect(result.usageReceipts).toEqual([]);
    expect(result.gaps).not.toContain('injection_not_recorded');
    expect(result.gaps).not.toContain('usage_not_recorded');
    expect(result.gaps).not.toContain('execution_not_recorded');
  });

  it('keeps injection_not_recorded aggregate-run scoped across owned Episodes with disjoint authoritative turn lists', async () => {
    const userId = 'user-run-injection-contract';
    const conversationId = 'conversation-run-injection-contract';
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const reviewService = await import('../../../../src/main/features/kstar/review-service');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const assetId = 'asset-run-injection-contract';
    await createVersionedAsset(userId, assetId, 'Run-level injection contract asset.');
    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId,
      title: 'Run-level injection contract',
    });
    const requirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId,
      userMessageIds: ['message-run-injection-contract'],
      title: 'Run-level injection requirement',
      goalText: 'Injection gaps are aggregate-run scoped, not per-Episode',
    });
    const projectionA = {
      schemaVersion: 2,
      ownerId: userId,
      id: 'projection-run-contract-a',
      taskRunId: task.id,
      conversationId,
      purpose: 'Episode A projection',
      authorization: 'workspace_policy',
      assetIds: [assetId],
      assetVersions: { [assetId]: '1' },
      sourceRefs: [],
      omittedRefs: [],
      status: 'confirmed',
      createdAt: '2026-09-10T04:30:00.000Z',
      confirmedAt: '2026-09-10T04:30:00.000Z',
    };
    const projectionB = {
      ...projectionA,
      id: 'projection-run-contract-b',
      purpose: 'Episode B projection',
      createdAt: '2026-09-10T04:30:30.000Z',
      confirmedAt: '2026-09-10T04:30:30.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'projections', projectionA.id, projectionA);
    await recallStore.writeRecallJsonRecord(userId, 'projections', projectionB.id, projectionB);
    const episodeA = {
      schemaVersion: 1 as const,
      ownerId: userId,
      id: 'episode-run-contract-a',
      sessionId: 'session-run-contract-a',
      taskRunId: 'aggregate-run-injection-contract',
      reuseTurnIds: ['turn-run-contract-a'],
      projectionId: projectionA.id,
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [assetId] },
      s: { conversationSummary: conversationId },
      t: { userGoal: 'Episode A resolves an Injection', constraints: [] },
      a: { toolCalls: [], agentActions: [] },
      r: { status: 'completed' as const, producedFiles: [] },
      evidenceRefs: [],
      createdAt: '2026-09-10T04:31:00.000Z',
      updatedAt: '2026-09-10T04:31:00.000Z',
    };
    const episodeB = {
      ...episodeA,
      id: 'episode-run-contract-b',
      sessionId: 'session-run-contract-b',
      reuseTurnIds: ['turn-run-contract-b'],
      projectionId: projectionB.id,
      t: { userGoal: 'Episode B resolves zero Injections', constraints: [] },
      createdAt: '2026-09-10T04:31:30.000Z',
      updatedAt: '2026-09-10T04:31:30.000Z',
    };
    await episodeStore.writeKstarEpisode(userId, episodeA);
    await episodeStore.writeKstarEpisode(userId, episodeB);
    await requirementStore.replaceKstarRequirement(userId, {
      ...requirement,
      projectionId: projectionA.id,
      projectionIds: [projectionA.id, projectionB.id],
      episodeIds: [episodeA.id, episodeB.id],
    });
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });
    // Only Episode A gets a review: per-owner review semantics must still flag B.
    const reviewA = reviewService.createInitialKstarReview(episodeA);
    await reviewService.saveKstarReviewRecord(userId, reviewA);
    const injectionA = await injections.recordInjectionReceipt(userId, {
      taskRunId: 'turn-run-contract-a',
      projectionId: projectionA.id,
      assetId,
      assetVersion: '1',
      boundary: 'real',
      status: 'injected',
      messageId: 'message-run-contract-a',
    });
    await usage.recordAssetUsageReceipt(userId, {
      taskRunId: 'turn-run-contract-a',
      projectionId: projectionA.id,
      assetId,
      assetVersion: '1',
      injectionReceiptId: injectionA.id,
      status: 'usage_unknown',
      evidenceRefs: [],
      evidenceKind: 'none',
      boundary: 'real',
    });

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: 'aggregate-run-injection-contract',
    });

    expect(result.episodes).toHaveLength(2);
    // Both Episodes carry authoritative non-empty reuseTurnIds, but only A
    // resolves any Injection.
    expect(result.injectionReceipts.map((receipt) => receipt.id)).toEqual([injectionA.id]);
    // Contract: injection_not_recorded is a single aggregate-run signal. A
    // resolved an Injection for the run, so B's disjoint list resolving zero
    // Injections must NOT add injection_not_recorded, and with no Injection
    // there is no injection->usage chain from which to fabricate
    // usage_not_recorded for B.
    expect(result.gaps).not.toContain('injection_not_recorded');
    expect(result.gaps).not.toContain('usage_not_recorded');
    // Review semantics stay per-owner: A's review must not hide B's missing one.
    expect(result.gaps).toContain('review_not_recorded');
    expect(result.gaps).not.toContain('execution_not_recorded');
  });

  it('caps returned collections and reports truncated plus output_truncated when the cap is exceeded', async () => {
    const userId = 'user-capped-evidence';
    const linked = await seedLinkedRun({
      userId,
      suffix: 'capped',
      taskRunId: 'aggregate-capped',
      reuseTurnIds: ['turn-capped'],
      projection: {
        id: 'projection-capped',
        assetIds: [],
      },
    });
    const recallStore = await import('../../../../src/main/features/recall/store');
    const createdAt = '2026-09-10T05:00:00.000Z';
    for (let index = 0; index < 1001; index += 1) {
      await recallStore.appendRecallJsonlRecord(userId, 'injection-receipts', 'events', {
        schemaVersion: 1,
        ownerId: userId,
        id: `inj-${createHash('sha256').update(`capped-${index}`).digest('hex').slice(0, 24)}`,
        taskRunId: 'turn-capped',
        projectionId: 'projection-capped',
        assetId: 'asset-capped',
        assetVersion: '1',
        boundary: 'real',
        status: 'injected',
        createdAt,
      });
    }

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-capped',
    });

    expect(result.episodes).toHaveLength(1);
    expect(result.injectionReceipts).toHaveLength(1000);
    expect(result.assets).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.gaps).toContain('output_truncated');
  });

  it('keeps exactly EVIDENCE_COLLECTION_CAP (1000) records untruncated at the inclusive boundary', async () => {
    const userId = 'user-cap-boundary';
    const assetId = 'asset-cap-boundary';
    await createVersionedAsset(userId, assetId, 'Boundary cap asset.');
    const linked = await seedLinkedRun({
      userId,
      suffix: 'cap-boundary',
      taskRunId: 'aggregate-cap-boundary',
      reuseTurnIds: ['turn-cap-boundary'],
      projection: {
        id: 'projection-cap-boundary',
        assetIds: [assetId],
        assetVersions: { [assetId]: '1' },
      },
    });
    const recallStore = await import('../../../../src/main/features/recall/store');
    const createdAt = '2026-09-10T05:10:00.000Z';
    for (let index = 0; index < 1000; index += 1) {
      await recallStore.appendRecallJsonlRecord(userId, 'injection-receipts', 'events', {
        schemaVersion: 1,
        ownerId: userId,
        id: `inj-${createHash('sha256').update(`cap-boundary-${index}`).digest('hex').slice(0, 24)}`,
        taskRunId: 'turn-cap-boundary',
        projectionId: 'projection-cap-boundary',
        assetId,
        assetVersion: '1',
        boundary: 'real',
        status: 'injected',
        createdAt,
      });
    }

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: linked.task.id,
      taskRunId: 'aggregate-cap-boundary',
    });

    // The cap is inclusive: only length > EVIDENCE_COLLECTION_CAP truncates.
    expect(result.injectionReceipts).toHaveLength(1000);
    expect(result.truncated).toBe(false);
    expect(result.gaps).not.toContain('output_truncated');
  });

  it('still surfaces a genuine gap computed from evidence beyond the collection cap', async () => {
    const userId = 'user-gap-beyond-cap';
    const assetId = 'asset-gap-beyond-cap';
    const conversationId = 'conversation-gap-beyond-cap';
    const taskRunId = 'aggregate-gap-beyond-cap';
    const projectionId = 'projection-gap-beyond-cap';
    await createVersionedAsset(userId, assetId, 'Capping must not hide gaps.');
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const recallStore = await import('../../../../src/main/features/recall/store');
    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId,
      title: 'Gap beyond cap',
    });
    const requirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId,
      userMessageIds: ['message-gap-beyond-cap'],
      title: 'Gap beyond cap requirement',
      goalText: 'Capping must not hide a real gap',
    });
    const projection = {
      schemaVersion: 2,
      ownerId: userId,
      id: projectionId,
      taskRunId: task.id,
      conversationId,
      purpose: 'Beyond-cap gap evidence',
      authorization: 'workspace_policy',
      assetIds: [assetId],
      assetVersions: { [assetId]: '1' },
      sourceRefs: [],
      omittedRefs: [],
      status: 'confirmed',
      createdAt: '2026-09-10T05:20:00.000Z',
      confirmedAt: '2026-09-10T05:20:00.000Z',
    };
    await recallStore.writeRecallJsonRecord(userId, 'projections', projectionId, projection);
    // Usage receipt ids are keyed to (taskRunId, projectionId, assetId,
    // assetVersion), so each covered Injection needs its own turn id. An
    // Episode persists at most 100 canonical reuse turn ids, so spread 1100
    // per-turn receipts across 11 owned Episodes sharing the linked Projection.
    const createdAt = '2026-09-10T05:20:00.000Z';
    const episodeIds: string[] = [];
    const turnIds: string[] = [];
    for (let episodeIndex = 0; episodeIndex < 11; episodeIndex += 1) {
      const episodeId = `episode-gap-beyond-cap-${episodeIndex}`;
      episodeIds.push(episodeId);
      const reuseTurnIds: string[] = [];
      for (let turn = 0; turn < 100; turn += 1) {
        reuseTurnIds.push(`turn-gap-beyond-cap-${String(episodeIndex * 100 + turn).padStart(4, '0')}`);
      }
      turnIds.push(...reuseTurnIds);
      await episodeStore.writeKstarEpisode(userId, {
        schemaVersion: 1 as const,
        ownerId: userId,
        id: episodeId,
        sessionId: `session-gap-beyond-cap-${episodeIndex}`,
        taskRunId,
        reuseTurnIds,
        projectionId,
        k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [assetId] },
        s: { conversationSummary: conversationId },
        t: { userGoal: 'Capping must not hide a real gap', constraints: [] },
        a: { toolCalls: [], agentActions: [] },
        r: { status: 'completed' as const, producedFiles: [] },
        evidenceRefs: [],
        createdAt,
        updatedAt: createdAt,
      });
    }
    expect(turnIds).toHaveLength(1100);
    await requirementStore.replaceKstarRequirement(userId, {
      ...requirement,
      projectionId,
      projectionIds: [projectionId],
      episodeIds,
    });
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });
    // One Injection per turn. ids sort by padded turn so the first 1000 after
    // the id sort are turns 0000..0999 and the remaining 100 are beyond cap.
    for (const turnId of turnIds) {
      await recallStore.appendRecallJsonlRecord(userId, 'injection-receipts', 'events', {
        schemaVersion: 1,
        ownerId: userId,
        id: `inj-${turnId}`,
        taskRunId: turnId,
        projectionId,
        assetId,
        assetVersion: '1',
        boundary: 'real',
        status: 'injected',
        createdAt,
      });
    }
    // Usage for every Injection that survives the cap (turns 0000..0999); the
    // 100 beyond-cap Injections (turns 1000..1099) are left without Usage, so
    // any usage_not_recorded gap can only come from beyond-the-cap evidence.
    for (const turnId of turnIds.slice(0, 1000)) {
      await recallStore.appendRecallJsonlRecord(userId, 'asset-usage-receipts', 'events', {
        schemaVersion: 1,
        ownerId: userId,
        id: usageReceiptId({
          taskRunId: turnId,
          projectionId,
          assetId,
          assetVersion: '1',
        }),
        taskRunId: turnId,
        projectionId,
        assetId,
        assetVersion: '1',
        injectionReceiptId: `inj-${turnId}`,
        status: 'usage_unknown',
        evidenceRefs: [],
        evidenceKind: 'none',
        boundary: 'real',
        createdAt,
      });
    }

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    const result = await readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId,
    });

    expect(result.injectionReceipts).toHaveLength(1000);
    expect(result.usageReceipts).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.gaps).toContain('output_truncated');
    // Every returned (capped) Injection has Usage, so the usage gap is driven
    // exclusively by Injections dropped by the cap; the gap must still surface.
    for (const injection of result.injectionReceipts) {
      expect(result.usageReceipts.some((usage) => usage.injectionReceiptId === injection.id)).toBe(true);
    }
    expect(result.gaps).toContain('usage_not_recorded');
  });


  it('propagates a corrupt authoritative Requirement instead of silently skipping it', async () => {
    const userId = 'user-corrupt-requirement';
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const kstarPaths = await import('../../../../src/main/features/kstar/paths');
    const task = requirementStore.createKstarTaskRecord(userId, {
      conversationId: 'conversation-corrupt-requirement',
      title: 'Corrupt requirement task',
    });
    const requirement = requirementStore.createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId: task.conversationId,
      userMessageIds: ['message-corrupt-requirement'],
      title: 'Corrupt requirement',
      goalText: 'Must not be skipped',
    });
    await requirementStore.replaceKstarRequirement(userId, requirement);
    await requirementStore.replaceKstarTask(userId, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });
    fs.writeFileSync(
      kstarPaths.kstarRequirementPath(userId, requirement.id),
      '{not valid json\n',
      'utf8',
    );

    const { readKstarRunEvidence } = await import('../../../../src/main/features/kstar/run-evidence');
    await expect(readKstarRunEvidence(userId, {
      taskId: task.id,
      taskRunId: 'aggregate-corrupt-requirement',
    })).rejects.toThrow(/malformed kstar requirements record: invalid JSON/);
  });
});
