import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GroupKstarMessageInput } from '../../../../src/main/features/kstar/episode-builder';
import type { KstarEpisodeRecord } from '../../../../src/main/features/kstar/types';

// Keep semantic lookup deterministic so this scenario exercises the persisted
// lifecycle rather than the availability of a local embedding model.
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, index) => (digest[index % 32] / 255 - 0.5) * 0.2);
  },
}));

const USER_ID = 'kstar-closure-scenario-user';
const CONVERSATION_ID = 'cid-kstar-closure-scenario';
const WORKSPACE_ID = 'workspace-kstar-closure';
const RUN_ID = 'run-kstar-closure-scenario';
const USER_MESSAGE_ID = 'msg-kstar-closure-user';
const AGENT_MESSAGE_ID = 'msg-kstar-closure-agent';
const TOOL_ID = 'tool-kstar-closure-read';
const STARTED_AT = Date.parse('2026-09-07T00:00:00.000Z');
const FINISHED_AT = Date.parse('2026-09-07T00:01:00.000Z');

let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(async () => {
  vi.resetModules();
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
  const [candidates, assets, refs, projections, promptInjection, injections, usage, closure, requirements, trace, episodes] =
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
    ]);
  return { candidates, assets, refs, projections, promptInjection, injections, usage, closure, requirements, trace, episodes };
}

async function createTransferValidatedAsset(): Promise<Awaited<ReturnType<(typeof import('../../../../src/main/features/recall/asset-service'))['readAbilityAsset']>>> {
  const { candidates, assets, refs } = await modules();
  const candidate = await candidates.saveRecallCandidate(USER_ID, {
    judgment: 'Preserve verified file evidence before finalizing a task result.',
    value: 'Preserve verified file evidence before finalizing a task result.',
    summary: 'Preserve verified file evidence',
    suggestedType: 'rule',
    suggestedScope: 'general',
    suggestedAction: 'create',
    applicableWhen: ['When a task must retain a verified file result.'],
    sourceRefs: [{ kind: 'execution', id: 'exec-kstar-closure-candidate' }],
    evidenceRefs: [{ kind: 'execution', id: 'exec-kstar-closure-candidate' }],
  });
  const promoted = await candidates.autoApplyRecallCandidate(USER_ID, candidate.id, { provenance: 'kstar' });
  if (!promoted.asset) throw new Error('KSTAR scenario asset was not promoted');
  const asset = await assets.setAbilityAssetMaturity(USER_ID, promoted.asset.id, 'transfer_validated');
  await refs.addWorkspaceAssetReference(USER_ID, {
    assetId: asset.id,
    workspaceId: WORKSPACE_ID,
    scope: 'review',
  });
  return asset;
}

async function createTaskRequirement(projectionId: string) {
  const { requirements } = await modules();
  const task = requirements.createKstarTaskRecord(USER_ID, {
    conversationId: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    title: 'KSTAR closure acceptance scenario',
  });
  const requirement = requirements.createKstarRequirementRecord(USER_ID, {
    taskId: task.id,
    conversationId: CONVERSATION_ID,
    userMessageIds: [USER_MESSAGE_ID],
    title: 'Persist the verified closure facts',
    goalText: 'Persist the verified closure facts for the completed task.',
    rHat: {
      summary: 'The verified closure facts are persisted.',
      acceptanceSignals: ['episode exists', 'tool call is successful', 'trace is complete'],
      source: 'user_message',
      confidence: 1,
    },
  });
  requirement.projectionId = projectionId;
  requirement.projectionIds = [projectionId];
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

describe('KSTAR closure acceptance scenario', () => {
  it('persists a real Recall-to-KSTAR closed loop without leaking tool data', async () => {
    const { projections, promptInjection, injections, usage, closure, requirements, trace, episodes } = await modules();
    const asset = await createTransferValidatedAsset();

    const projection = await projections.previewContextProjection(USER_ID, {
      taskRunId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      purpose: 'review',
      authorization: 'workspace_policy',
      confirm: true,
    });
    expect(projection.status).toBe('confirmed');
    expect(projection.assetIds).toContain(asset.id);

    const { task, requirement } = await createTaskRequirement(projection.id);
    const promptContext = await promptInjection.buildRecallTurnPromptContext(USER_ID, {
      cid: CONVERSATION_ID,
      taskRunId: RUN_ID,
      taskText: 'Persist the verified closure facts for the completed task.',
      workspaceId: WORKSPACE_ID,
      committedProjectionId: projection.id,
    });
    const citation = promptContext.citations.find((item) => item.assetId === asset.id);
    expect(citation).toMatchObject({
      assetId: asset.id,
      version: asset.version,
      projectionId: projection.id,
    });
    expect(promptContext.promptBlock).toContain(asset.statement);

    const injection = await injections.recordInjectionReceipt(USER_ID, {
      taskRunId: RUN_ID,
      projectionId: projection.id,
      assetId: citation!.assetId,
      assetVersion: citation!.version,
      boundary: 'real',
      status: 'injected',
      messageId: AGENT_MESSAGE_ID,
    });

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
          asset_id: citation!.assetId,
          version: citation!.version,
          projection_id: citation!.projectionId,
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

    const result = await closure.captureGroupKstarClosure({
      userId: USER_ID,
      runId: RUN_ID,
      conversationId: CONVERSATION_ID,
      projectionId: projection.id,
      logicalRunId: 'logical-kstar-closure-scenario',
      executionId: 'exec-kstar-closure-scenario',
      status: 'completed',
      startedAtMs: STARTED_AT,
      finishedAtMs: FINISHED_AT,
      messages,
      inferReview: deterministicReview,
      createdAt: '2026-09-07T00:01:01.000Z',
    });

    expect(result.episode).toMatchObject({
      id: `kse-${RUN_ID}`,
      projectionId: projection.id,
      taskRunId: RUN_ID,
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

    const storedInjections = await injections.listInjectionReceipts(USER_ID, RUN_ID);
    expect(storedInjections).toEqual([expect.objectContaining({ id: injection.id, boundary: 'real', status: 'injected' })]);
    const storedUsage = await usage.listAssetUsageReceipts(USER_ID, RUN_ID);
    expect(storedUsage).toEqual([expect.objectContaining({
      taskRunId: RUN_ID,
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
});
