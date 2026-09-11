import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GroupKstarMessageInput } from '../../../../src/main/features/kstar/episode-builder';
import type { KstarReviewInfer } from '../../../../src/main/features/kstar/task-closure';
import type { KstarEpisodeRecord, KstarTaskStatus } from '../../../../src/main/features/kstar/types';

// Keep semantic lookup deterministic so this scenario exercises the persisted
// lifecycle rather than the availability of a local embedding model.
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, index) => (digest[index % 32] / 255 - 0.5) * 0.2);
  },
}));

const semanticReviewMock = vi.hoisted(() => ({
  reviewCandidateSemantically: vi.fn(),
}));

vi.mock('../../../../src/main/features/cognition/semantic-review', () => ({
  reviewCandidateSemantically: semanticReviewMock.reviewCandidateSemantically,
}));

const USER_ID = 'kstar-closure-scenario-user';
const CONVERSATION_ID = 'cid-kstar-closure-scenario';
const WORKSPACE_ID = 'workspace-kstar-closure';
const AGGREGATE_RUN_ID = 'run-kstar-closure-aggregate';
const TURN_ID = 'turn-kstar-closure-real';
const NEGATIVE_AGGREGATE_RUN_ID = 'run-kstar-closure-missing-evidence';
const NEGATIVE_TURN_ID = 'turn-kstar-closure-missing-evidence';
const USER_MESSAGE_ID = 'msg-kstar-closure-user';
const AGENT_MESSAGE_ID = 'msg-kstar-closure-agent';
const TOOL_ID = 'tool-kstar-closure-read';
const LOCKED_ASSET_STATEMENT = 'Preserve verified file evidence before finalizing a task result.';
const REVISED_ASSET_STATEMENT = 'Use the newer replacement workflow for future task results.';
const STARTED_AT = Date.parse('2026-09-07T00:00:00.000Z');
const FINISHED_AT = Date.parse('2026-09-07T00:01:00.000Z');

let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  semanticReviewMock.reviewCandidateSemantically.mockReset();
  semanticReviewMock.reviewCandidateSemantically.mockResolvedValue({ ok: true, findings: [] });
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-kstar-closure-acceptance-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = workspaceRoot;
});

afterEach(async () => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, refs, projections, promptInjection, injections, usage, closure, requirements, trace, episodes, runEvidence] =
    await Promise.all([
      import('../../../../src/main/features/recall/candidate-service'),
      import('../../../../src/main/features/recall/asset-service'),
      import('../../../../src/main/features/recall/workspace-refs'),
      import('../../../../src/main/features/recall/context-projection'),
      import('../../../../src/main/features/recall/prompt-injection'),
      import('../../../../src/main/features/recall/injection-receipt'),
      import('../../../../src/main/features/recall/asset-usage-receipt'),
      import('../../../../src/main/features/kstar/task-closure'),
      import('../../../../src/main/features/kstar/requirement-store'),
      import('../../../../src/main/features/kstar/trace'),
      import('../../../../src/main/features/kstar/episode-store'),
      import('../../../../src/main/features/kstar/run-evidence'),
    ]);
  return { candidates, assets, refs, projections, promptInjection, injections, usage, closure, requirements, trace, episodes, runEvidence };
}

async function createTransferValidatedAsset(): Promise<Awaited<ReturnType<(typeof import('../../../../src/main/features/recall/asset-service'))['readAbilityAsset']>>> {
  const { candidates, assets, refs } = await modules();
  const candidate = await candidates.saveRecallCandidate(USER_ID, {
    judgment: LOCKED_ASSET_STATEMENT,
    value: LOCKED_ASSET_STATEMENT,
    summary: 'Preserve verified file evidence',
    suggestedType: 'rule',
    suggestedScope: 'general',
    suggestedAction: 'create',
    applicableWhen: ['When a task must retain a verified file result.'],
    sourceRefs: [{ kind: 'execution', id: 'exec-kstar-closure-candidate' }],
    evidenceRefs: [{ kind: 'execution', id: 'exec-kstar-closure-candidate' }],
  });
  const promoted = await candidates.autoApplyRecallCandidate(USER_ID, candidate.id, { provenance: 'kstar' });
  expect(semanticReviewMock.reviewCandidateSemantically).toHaveBeenCalledTimes(1);
  if (!promoted.asset) throw new Error('KSTAR scenario asset was not promoted');
  const asset = await assets.setAbilityAssetMaturity(USER_ID, promoted.asset.id, 'transfer_validated');
  await refs.addWorkspaceAssetReference(USER_ID, {
    assetId: asset.id,
    workspaceId: WORKSPACE_ID,
    scope: 'review',
  });
  return asset;
}

async function createTaskRequirement(titleSuffix: string) {
  const { requirements } = await modules();
  const task = requirements.createKstarTaskRecord(USER_ID, {
    conversationId: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    title: `KSTAR closure acceptance scenario ${titleSuffix}`,
  });
  const requirement = requirements.createKstarRequirementRecord(USER_ID, {
    taskId: task.id,
    conversationId: CONVERSATION_ID,
    userMessageIds: [USER_MESSAGE_ID],
    title: `Persist the verified closure facts ${titleSuffix}`,
    goalText: 'Persist the verified closure facts for the completed task.',
    rHat: {
      summary: 'The verified closure facts are persisted.',
      acceptanceSignals: ['episode exists', 'tool call is successful', 'trace is complete'],
      source: 'user_message',
      confidence: 1,
    },
  });
  await requirements.replaceKstarRequirement(USER_ID, requirement);
  await requirements.replaceKstarTask(USER_ID, {
    ...task,
    requirementIds: [requirement.id],
    currentRequirementId: requirement.id,
  });
  await requirements.writeConversationTaskState(USER_ID, {
    ...requirements.createInitialConversationTaskState(USER_ID, CONVERSATION_ID),
    currentTaskId: task.id,
    currentRequirementId: requirement.id,
  });
  return { task, requirement };
}

async function bindProjectionToRequirement(
  requirement: Awaited<ReturnType<typeof createTaskRequirement>>['requirement'],
  projectionId: string,
) {
  const { requirements } = await modules();
  const bound = {
    ...requirement,
    projectionId,
    projectionIds: [projectionId],
  };
  await requirements.replaceKstarRequirement(USER_ID, bound);
  return bound;
}

function deterministicReview(_userId: string, episode: KstarEpisodeRecord) {
  return Promise.resolve({
    review: {
      expectedResult: episode.t.userGoal,
      actualResult: episode.r.finalText || 'The task completed.',
      deltaR: 0 as const,
      deltaA: 0 as const,
      outcome: 'met_expected' as const,
      attribution: 'unclear' as const,
      reason: 'The acceptance scenario completed with persisted execution evidence.',
      confidence: 1,
      evidenceRefs: episode.evidenceRefs,
    },
    reviewState: 'inferred' as const,
    inferenceMethod: 'deterministic' as const,
    needsConfirmation: false,
  });
}

function conservativeReview(_userId: string, episode: KstarEpisodeRecord) {
  return Promise.resolve({
    review: {
      expectedResult: episode.t.userGoal,
      actualResult: episode.r.finalText || 'The task did not produce a verified result.',
      deltaR: 'unknown' as const,
      deltaA: 'unknown' as const,
      outcome: 'unclear' as const,
      attribution: 'unclear' as const,
      reason: 'No Host-observable evidence proved that the cited asset affected the result.',
      confidence: 0,
      evidenceRefs: episode.evidenceRefs,
    },
    reviewState: 'unknown' as const,
    inferenceMethod: 'deterministic' as const,
    needsConfirmation: false,
  });
}

async function createInjectedScenario(input: {
  titleSuffix: string;
  turnId: string;
  purpose: string;
  taskText: string;
  injectionMessageId: string;
}) {
  const { assets, projections, promptInjection, injections } = await modules();
  const asset = await createTransferValidatedAsset();
  const { task, requirement } = await createTaskRequirement(input.titleSuffix);
  const projection = await projections.previewContextProjection(USER_ID, {
    taskRunId: task.id,
    workspaceId: WORKSPACE_ID,
    purpose: input.purpose,
    authorization: 'workspace_policy',
    confirm: true,
  });
  await bindProjectionToRequirement(requirement, projection.id);
  const promptContext = await promptInjection.buildRecallTurnPromptContext(USER_ID, {
    cid: CONVERSATION_ID,
    taskRunId: input.turnId,
    taskText: input.taskText,
    workspaceId: WORKSPACE_ID,
    committedProjectionId: projection.id,
  });
  const citation = promptContext.citations.find((item) => item.assetId === asset.id);
  if (!citation) throw new Error('KSTAR scenario asset was not injected');
  const injection = await injections.recordInjectionReceipt(USER_ID, {
    taskRunId: input.turnId,
    projectionId: projection.id,
    assetId: citation.assetId,
    assetVersion: citation.version,
    boundary: 'real',
    status: 'injected',
    messageId: input.injectionMessageId,
  });
  const liveAsset = await assets.updateAbilityAsset(USER_ID, asset.id, {
    statement: REVISED_ASSET_STATEMENT,
    reason: 'exercise the historical Projection snapshot',
    actor: 'user',
  });
  return { asset, task, requirement, projection, promptContext, citation, injection, liveAsset };
}

async function captureScenarioClosure(input: {
  logicalTaskId: string;
  aggregateRunId: string;
  turnId: string;
  projectionId: string;
  executionId: string;
  status: KstarTaskStatus;
  messages: GroupKstarMessageInput[];
  inferReview: KstarReviewInfer;
  createdAt: string;
}) {
  const { closure } = await modules();
  return closure.captureGroupKstarClosure({
    userId: USER_ID,
    runId: input.aggregateRunId,
    conversationId: CONVERSATION_ID,
    projectionId: input.projectionId,
    logicalRunId: input.logicalTaskId,
    executionId: input.executionId,
    reuseTurnIds: [input.turnId],
    status: input.status,
    startedAtMs: STARTED_AT,
    finishedAtMs: FINISHED_AT,
    messages: input.messages,
    inferReview: input.inferReview,
    createdAt: input.createdAt,
  });
}

describe('KSTAR closure acceptance scenario', () => {
  it('persists a real Recall-to-KSTAR closed loop without leaking tool data', async () => {
    const { injections, usage, requirements, trace, episodes, runEvidence } = await modules();
    const {
      asset,
      task,
      requirement,
      projection,
      promptContext,
      citation,
      injection,
      liveAsset,
    } = await createInjectedScenario({
      titleSuffix: 'with observable evidence',
      turnId: TURN_ID,
      purpose: 'review',
      taskText: 'Persist the verified closure facts for the completed task.',
      injectionMessageId: AGENT_MESSAGE_ID,
    });
    expect(projection.status).toBe('confirmed');
    expect(projection.taskRunId).toBe(task.id);
    expect(projection.assetIds).toContain(asset.id);
    expect(projection.assetVersions?.[asset.id]).toBe(asset.version);
    expect(citation).toMatchObject({
      assetId: asset.id,
      version: asset.version,
      projectionId: projection.id,
    });
    expect(promptContext.promptBlock).toContain(asset.statement);
    expect(liveAsset.version).not.toBe(asset.version);

    const privateToolPath = '/private/kstar-closure-secret.txt';
    const privateToolOutput = 'private tool output must never be persisted';
    const messages: GroupKstarMessageInput[] = [
      {
        id: USER_MESSAGE_ID,
        from: 'user',
        text: 'Persist the verified closure facts for the completed task.',
        ts: '2026-09-07T00:00:01.000Z',
      },
      {
        id: AGENT_MESSAGE_ID,
        from: 'agent-a',
        text: 'The verified closure facts were persisted.',
        ts: '2026-09-07T00:00:40.000Z',
        recall_citations: [{
          asset_id: citation.assetId,
          version: citation.version,
          projection_id: citation.projectionId,
        }],
        process: [
          {
            type: 'event',
            event: {
              stream: 'tool',
              data: {
                phase: 'start',
                id: TOOL_ID,
                name: 'read_file',
                arguments: { path: privateToolPath },
              },
            },
          },
          {
            type: 'event',
            event: {
              stream: 'tool',
              data: {
                phase: 'completed',
                id: TOOL_ID,
                name: 'read_file',
                output: privateToolOutput,
              },
            },
          },
        ],
      },
    ];

    const result = await captureScenarioClosure({
      logicalTaskId: task.id,
      aggregateRunId: AGGREGATE_RUN_ID,
      turnId: TURN_ID,
      projectionId: projection.id,
      executionId: 'exec-kstar-closure-scenario',
      status: 'completed',
      messages,
      inferReview: deterministicReview,
      createdAt: '2026-09-07T00:01:01.000Z',
    });

    const evidence = await runEvidence.readKstarRunEvidence(USER_ID, {
      taskId: task.id,
      taskRunId: AGGREGATE_RUN_ID,
    });
    expect(evidence.projections).toEqual([
      expect.objectContaining({ id: projection.id, status: 'confirmed', taskRunId: task.id }),
    ]);
    expect(evidence.requirementIds).toEqual([requirement.id]);
    expect(evidence.assets).toEqual([
      expect.objectContaining({
        assetId: asset.id,
        assetVersion: asset.version,
        snapshot: expect.objectContaining({
          version: asset.version,
          statement: LOCKED_ASSET_STATEMENT,
        }),
        injectionReceipts: [injection],
        usageReceipts: [expect.objectContaining({
          taskRunId: injection.taskRunId,
          projectionId: injection.projectionId,
          assetId: injection.assetId,
          assetVersion: injection.assetVersion,
          injectionReceiptId: injection.id,
          boundary: injection.boundary,
          status: 'applied',
          evidenceKind: 'tool_call',
          evidenceRefs: [expect.objectContaining({
            kind: 'execution_evaluation',
            id: result.episode.id,
            subtype: 'execution',
          })],
        })],
      }),
    ]);
    expect(evidence.injectionReceipts).toEqual([
      expect.objectContaining({
        id: injection.id,
        taskRunId: TURN_ID,
        boundary: 'real',
        status: 'injected',
      }),
    ]);
    expect(evidence.usageReceipts).toEqual([
      expect.objectContaining({
        taskRunId: injection.taskRunId,
        projectionId: injection.projectionId,
        assetId: injection.assetId,
        assetVersion: injection.assetVersion,
        injectionReceiptId: injection.id,
        boundary: injection.boundary,
        status: 'applied',
        evidenceKind: 'tool_call',
        evidenceRefs: [expect.objectContaining({ id: result.episode.id })],
      }),
    ]);
    expect(evidence.episodes).toEqual([
      expect.objectContaining({
        id: result.episode.id,
        taskRunId: AGGREGATE_RUN_ID,
        reuseTurnIds: [TURN_ID],
        r: expect.objectContaining({ status: 'completed' }),
      }),
    ]);
    expect(evidence.reviews).toEqual([
      expect.objectContaining({ id: result.review.id, episodeId: result.episode.id }),
    ]);
    expect(result.review.id).not.toBe(result.episode.id);
    expect(evidence.transferProofs).toEqual([]);
    expect(evidence.effectivenessProofs).toEqual([]);
    expect(evidence.validations).toEqual([]);
    expect(evidence.gaps).toEqual(['effectiveness_not_recorded']);

    expect(result.episode).toMatchObject({
      id: `kse-${AGGREGATE_RUN_ID}`,
      projectionId: projection.id,
      taskRunId: AGGREGATE_RUN_ID,
      reuseTurnIds: [TURN_ID],
      k: { abilityAssetRefs: [asset.id] },
      r: { status: 'completed', finalText: 'The verified closure facts were persisted.', toolCallCount: 1 },
    });
    expect(result.episode.a.toolCalls).toEqual([
      expect.objectContaining({
        id: TOOL_ID,
        name: 'read_file',
        argumentsSummary: 'path',
        status: 'ok',
      }),
    ]);
    expect(result.review).toMatchObject({
      episodeId: result.episode.id,
      inferenceMethod: 'deterministic',
      reviewState: 'inferred',
    });
    expect(result.extractionRun).toMatchObject({
      id: `ksx-${result.episode.id}`,
      episodeId: result.episode.id,
      reviewId: result.review.id,
      status: 'created',
    });

    const storedEpisodes = await episodes.listKstarJsonRecords(USER_ID, 'episodes');
    expect(storedEpisodes).toEqual([expect.objectContaining({ id: result.episode.id })]);
    const storedRequirement = await requirements.readKstarRequirement(USER_ID, requirement.id);
    expect(storedRequirement?.episodeIds).toContain(result.episode.id);

    const storedInjections = await injections.listInjectionReceipts(USER_ID, TURN_ID);
    expect(storedInjections).toEqual([expect.objectContaining({ id: injection.id, boundary: 'real', status: 'injected' })]);
    const storedUsage = await usage.listAssetUsageReceipts(USER_ID, TURN_ID);
    expect(storedUsage).toEqual([expect.objectContaining({
      taskRunId: TURN_ID,
      projectionId: projection.id,
      assetId: asset.id,
      assetVersion: asset.version,
      injectionReceiptId: injection.id,
      status: 'applied',
      evidenceKind: 'tool_call',
      boundary: 'real',
      evidenceRefs: [expect.objectContaining({ id: result.episode.id })],
    })]);
    const persistedReceiptData = JSON.stringify(storedUsage);
    expect(persistedReceiptData).not.toContain(privateToolPath);
    expect(persistedReceiptData).not.toContain(privateToolOutput);
    expect(JSON.stringify(storedEpisodes)).not.toContain(privateToolPath);
    expect(JSON.stringify(storedEpisodes)).not.toContain(privateToolOutput);
    expect(JSON.stringify(evidence)).not.toContain(privateToolPath);
    expect(JSON.stringify(evidence)).not.toContain(privateToolOutput);
    expect(JSON.stringify(evidence)).not.toContain(REVISED_ASSET_STATEMENT);

    const kstarTrace = await trace.readKstarTrace(USER_ID, { taskId: task.id });
    const stages = new Set(kstarTrace.nodes.map((node) => node.stage));
    for (const stage of ['task', 'requirement', 'projection', 'injection', 'usage', 'runtime', 'episode', 'review', 'extraction', 'closure', 'trace_completeness']) {
      expect(stages.has(stage as typeof kstarTrace.nodes[number]['stage'])).toBe(true);
    }
    expect(kstarTrace.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'projection', primaryId: projection.id, status: 'ok' }),
      expect.objectContaining({ stage: 'injection', primaryId: injection.id, status: 'ok' }),
      expect.objectContaining({ stage: 'usage', primaryId: storedUsage[0].id, status: 'ok' }),
      expect.objectContaining({ stage: 'episode', primaryId: result.episode.id, status: 'ok' }),
      expect.objectContaining({ stage: 'closure', primaryId: result.episode.id, status: 'ok' }),
      expect.objectContaining({
        stage: 'trace_completeness',
        primaryId: result.episode.id,
        status: 'ok',
        completeness: 'complete',
      }),
    ]));
  });

  it('keeps cited asset usage unknown when a failed run has no Host-observable success evidence', async () => {
    const { injections, usage, requirements, runEvidence } = await modules();
    const {
      asset,
      task,
      requirement,
      projection,
      promptContext,
      citation,
      injection,
    } = await createInjectedScenario({
      titleSuffix: 'without observable evidence',
      turnId: NEGATIVE_TURN_ID,
      purpose: 'review missing execution evidence',
      taskText: 'Try to persist the closure facts without claiming unverified success.',
      injectionMessageId: 'msg-kstar-closure-agent-missing-evidence',
    });
    expect(projection).toMatchObject({
      status: 'confirmed',
      taskRunId: task.id,
      assetVersions: { [asset.id]: asset.version },
    });
    expect(citation).toMatchObject({
      assetId: asset.id,
      version: asset.version,
      projectionId: projection.id,
    });
    expect(promptContext.promptBlock).toContain(LOCKED_ASSET_STATEMENT);

    const result = await captureScenarioClosure({
      logicalTaskId: task.id,
      aggregateRunId: NEGATIVE_AGGREGATE_RUN_ID,
      turnId: NEGATIVE_TURN_ID,
      projectionId: projection.id,
      executionId: 'exec-kstar-closure-missing-evidence',
      status: 'failed',
      messages: [
        {
          id: USER_MESSAGE_ID,
          from: 'user',
          text: 'Try to persist the closure facts without claiming unverified success.',
          ts: '2026-09-07T00:00:01.000Z',
        },
        {
          id: 'msg-kstar-closure-agent-missing-evidence',
          from: 'agent-a',
          text: 'I referenced the verified-evidence guidance, but the action failed.',
          ts: '2026-09-07T00:00:40.000Z',
          recall_citations: [{
            asset_id: citation.assetId,
            version: citation.version,
            projection_id: citation.projectionId,
          }],
          failure_kind: 'tool_error',
          failure_code: 'verification_failed',
          process: [
            {
              type: 'event',
              event: {
                stream: 'tool',
                data: {
                  phase: 'completed',
                  id: 'tool-kstar-closure-failed',
                  name: 'read_file',
                  isError: true,
                },
              },
            },
          ],
        },
      ],
      inferReview: conservativeReview,
      createdAt: '2026-09-07T00:01:01.000Z',
    });

    // Persist a neighboring successful aggregate run for the same logical
    // Task and Projection so the D03 read must isolate by aggregate run and
    // then follow only that Episode's authoritative per-turn receipt ids.
    const neighboringInjection = await injections.recordInjectionReceipt(USER_ID, {
      taskRunId: TURN_ID,
      projectionId: projection.id,
      assetId: citation.assetId,
      assetVersion: citation.version,
      boundary: 'real',
      status: 'injected',
      messageId: AGENT_MESSAGE_ID,
    });
    const neighboringResult = await captureScenarioClosure({
      logicalTaskId: task.id,
      aggregateRunId: AGGREGATE_RUN_ID,
      turnId: TURN_ID,
      projectionId: projection.id,
      executionId: 'exec-kstar-closure-neighboring-success',
      status: 'completed',
      messages: [
        {
          id: USER_MESSAGE_ID,
          from: 'user',
          text: 'Persist a neighboring verified run.',
          ts: '2026-09-07T00:00:01.000Z',
        },
        {
          id: AGENT_MESSAGE_ID,
          from: 'agent-a',
          text: 'The neighboring verified run completed.',
          ts: '2026-09-07T00:00:40.000Z',
          recall_citations: [{
            asset_id: citation.assetId,
            version: citation.version,
            projection_id: citation.projectionId,
          }],
          process: [{
            type: 'event',
            event: {
              stream: 'tool',
              data: { phase: 'completed', id: TOOL_ID, name: 'read_file' },
            },
          }],
        },
      ],
      inferReview: deterministicReview,
      createdAt: '2026-09-07T00:01:02.000Z',
    });
    expect(await usage.listAssetUsageReceipts(USER_ID, TURN_ID)).toEqual([
      expect.objectContaining({
        injectionReceiptId: neighboringInjection.id,
        status: 'applied',
        evidenceKind: 'tool_call',
      }),
    ]);
    const storedRequirement = await requirements.readKstarRequirement(USER_ID, requirement.id);
    expect(storedRequirement?.episodeIds).toEqual(expect.arrayContaining([
      result.episode.id,
      neighboringResult.episode.id,
    ]));

    const evidence = await runEvidence.readKstarRunEvidence(USER_ID, {
      taskId: task.id,
      taskRunId: NEGATIVE_AGGREGATE_RUN_ID,
    });
    expect(evidence.requirementIds).toEqual([requirement.id]);
    expect(evidence.projections).toEqual([
      expect.objectContaining({ id: projection.id, status: 'confirmed', taskRunId: task.id }),
    ]);
    expect(evidence.injectionReceipts).toEqual([
      expect.objectContaining({
        id: injection.id,
        taskRunId: NEGATIVE_TURN_ID,
        boundary: 'real',
        status: 'injected',
      }),
    ]);
    expect(evidence.usageReceipts).toEqual([
      expect.objectContaining({
        taskRunId: injection.taskRunId,
        projectionId: injection.projectionId,
        assetId: injection.assetId,
        assetVersion: injection.assetVersion,
        injectionReceiptId: injection.id,
        boundary: injection.boundary,
        status: 'usage_unknown',
        evidenceKind: 'none',
        evidenceRefs: [],
      }),
    ]);
    expect(evidence.assets).toEqual([
      expect.objectContaining({
        assetId: asset.id,
        assetVersion: asset.version,
        snapshot: expect.objectContaining({
          version: asset.version,
          statement: LOCKED_ASSET_STATEMENT,
        }),
        injectionReceipts: [injection],
        usageReceipts: [expect.objectContaining({ status: 'usage_unknown' })],
      }),
    ]);
    expect(evidence.episodes).toEqual([
      expect.objectContaining({
        id: result.episode.id,
        taskRunId: NEGATIVE_AGGREGATE_RUN_ID,
        reuseTurnIds: [NEGATIVE_TURN_ID],
        r: expect.objectContaining({ status: 'failed' }),
      }),
    ]);
    expect(evidence.reviews).toEqual([
      expect.objectContaining({
        id: result.review.id,
        episodeId: result.episode.id,
        outcome: 'unclear',
        attribution: 'unclear',
        deltaR: 'unknown',
        deltaA: 'unknown',
      }),
    ]);
    expect(evidence.reviews[0].outcome).not.toBe('better_than_expected');
    expect(evidence.transferProofs).toEqual([]);
    expect(evidence.effectivenessProofs).toEqual([]);
    expect(evidence.validations).toEqual([]);
    expect(evidence.gaps).toEqual(['effectiveness_not_recorded']);

    const usageReceipt = evidence.usageReceipts[0];
    expect(usageReceipt.status).not.toBe('applied');
    for (const synthesizedField of ['successful', 'applied', 'better', 'outcome']) {
      expect(usageReceipt).not.toHaveProperty(synthesizedField);
    }
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('"status":"applied"');
    expect(serialized).not.toContain('better_than_expected');
    expect(serialized).not.toContain(REVISED_ASSET_STATEMENT);
    expect(serialized).not.toContain(AGGREGATE_RUN_ID);
    expect(serialized).not.toContain(TURN_ID);
    expect(serialized).not.toContain(neighboringInjection.id);
    expect(serialized).not.toContain(neighboringResult.episode.id);
  });
});
