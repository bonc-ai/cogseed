import { nowIso, safeId } from '../../storage';
import type { RecallCandidateRecord } from '../recall/candidate-service';
import { readContextProjection } from '../recall/context-projection';
import { readWorldModelForecast } from '../recall/world-model';
import { readKstarEpisode } from './episode-store';
import type { KstarCandidateProposal } from './types';
import { saveKstarCandidateProposals } from './recall-bridge';
import { closeKstarRequirement } from './requirement-closure';
import {
  createKstarRequirementRecord,
  createKstarTaskRecord,
  listKstarRequirementsForTask,
  readConversationTaskState,
  readKstarTask,
  replaceConversationTaskState,
  replaceKstarRequirement,
  replaceKstarTask,
} from './requirement-store';
import type { KstarConversationTaskStateRecord, KstarRequirementRecord, KstarTaskRecord } from './requirement-types';

export type KstarTaskCandidateBridge = (userId: string, proposals: KstarCandidateProposal[]) => Promise<RecallCandidateRecord[]>;

export interface DrainKstarTaskStateOptions {
  candidateBridge?: KstarTaskCandidateBridge;
}

export interface KstarTaskAggregateResult {
  task: KstarTaskRecord;
  closedRequirements: KstarRequirementRecord[];
  proposals: KstarCandidateProposal[];
  candidates: RecallCandidateRecord[];
}

function normalizedSeed(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameAssetVersions(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
  const rightEntries = Object.entries(right).sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([assetId, version], index) => (
      rightEntries[index]?.[0] === assetId && rightEntries[index]?.[1] === version
    ));
}

async function proposalFromRequirement(
  userId: string,
  requirement: KstarRequirementRecord,
): Promise<KstarCandidateProposal | null> {
  const seed = requirement.aar?.candidateSeed?.replace(/\s+/g, ' ').trim();
  const review = requirement.prmReview;
  const projectionId = requirement.projectionId;
  const forecastId = requirement.forecastId;
  const episodeId = requirement.episodeIds.at(-1);
  if (!seed || !review || !projectionId || !forecastId || !episodeId || review.evidenceRefs.length === 0) return null;

  const [forecast, projection, episode] = await Promise.all([
    readWorldModelForecast(userId, forecastId),
    readContextProjection(userId, projectionId).catch(() => null),
    readKstarEpisode(userId, episodeId),
  ]);
  if (
    !forecast
    || forecast.provenanceComplete !== true
    || forecast.projectionId !== projectionId
    || forecast.requirementId !== requirement.id
    || !projection
    || projection.status !== 'confirmed'
    || !projection.assetVersions
    || !forecast.assetVersions
    || !sameAssetVersions(forecast.assetVersions, projection.assetVersions)
    || !episode
    || episode.projectionId !== projectionId
    || episode.forecastId !== forecastId
  ) return null;

  return {
    judgment: seed,
    summary: `KSTAR requirement lesson: ${requirement.title}`.slice(0, 200),
    uncertainty: 'Generated from a closed Requirement PRM/AAR and still requires user confirmation.',
    suggestedType: review.attribution === 'template_gap'
      ? 'template'
      : review.attribution === 'skill_gap'
        ? 'skill_method'
        : review.attribution === 'rule_gap'
          ? 'rule'
          : 'personal',
    suggestedScope: 'general',
    sourceRefs: review.evidenceRefs,
    learningSignal: {
      ...(review.expectedResult ? { expectedResult: review.expectedResult } : {}),
      ...(review.actualResult ? { actualResult: review.actualResult } : {}),
      deltaR: review.deltaR,
      deltaA: review.deltaA,
      outcome: review.outcome,
      confidence: review.confidence,
      source: 'review',
    },
    learningProvenance: {
      projectionId,
      forecastId,
      episodeId,
      ruleRefs: forecast.ruleRefs || [],
      attribution: review.attribution,
      ...(review.actionDelta ? { actionDelta: review.actionDelta } : {}),
      ...(review.resultDelta ? { resultDelta: review.resultDelta } : {}),
    },
  };
}

async function dedupeProposals(
  userId: string,
  requirements: KstarRequirementRecord[],
): Promise<KstarCandidateProposal[]> {
  const seen = new Set<string>();
  const proposals: KstarCandidateProposal[] = [];
  for (const requirement of requirements) {
    const proposal = await proposalFromRequirement(userId, requirement);
    if (!proposal) continue;
    const key = normalizedSeed(proposal.judgment);
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push(proposal);
  }
  return proposals.slice(0, 3);
}

export async function startPendingTopicSwitchTask(
  userId: string,
  state: KstarConversationTaskStateRecord,
): Promise<KstarConversationTaskStateRecord> {
  const pending = state.pendingTaskStart;
  if (!pending) return state;
  const task = createKstarTaskRecord(userId, {
    conversationId: state.conversationId,
    title: pending.text,
    ...(pending.workspaceId ? { workspaceId: pending.workspaceId } : {}),
  });
  const requirement = createKstarRequirementRecord(userId, {
    taskId: task.id,
    conversationId: state.conversationId,
    userMessageIds: [pending.userMessageId],
    title: pending.text,
    goalText: pending.text,
    rHat: { summary: pending.text, acceptanceSignals: [], source: 'user_message', confidence: 0.6 },
  });
  task.requirementIds = [requirement.id];
  task.currentRequirementId = requirement.id;
  await replaceKstarRequirement(userId, requirement);
  await replaceKstarTask(userId, task);
  const nextState: KstarConversationTaskStateRecord = {
    ...state,
    currentTaskId: task.id,
    currentRequirementId: requirement.id,
    requirementJustClosed: undefined,
    taskComplete: false,
    pendingTaskStart: undefined,
    updatedAt: nowIso(),
  };
  return replaceConversationTaskState(userId, nextState);
}

export async function drainKstarTaskState(
  userId: string,
  conversationId: string,
  options: DrainKstarTaskStateOptions = {},
): Promise<KstarTaskAggregateResult | null> {
  if (!safeId(conversationId)) throw new Error('invalid kstar conversation id');
  let state = await readConversationTaskState(userId, conversationId);
  if (!state) return null;

  let justClosed: KstarRequirementRecord | null = null;
  if (state.requirementJustClosed) {
    justClosed = await closeKstarRequirement(userId, { requirementId: state.requirementJustClosed });
    state = await replaceConversationTaskState(userId, {
      ...state,
      requirementJustClosed: undefined,
      updatedAt: nowIso(),
    });
  }

  if (state.taskComplete !== true) return null;
  if (!state.currentTaskId) return null;
  const task = await readKstarTask(userId, state.currentTaskId);
  if (!task) return null;

  const requirements = await listKstarRequirementsForTask(userId, task.id);
  const closedRequirements = requirements.filter((requirement) => requirement.status === 'closed');
  const proposals = await dedupeProposals(userId, closedRequirements);
  const bridge = options.candidateBridge || saveKstarCandidateProposals;
  const candidates = proposals.length ? await bridge(userId, proposals) : [];
  const closedTask: KstarTaskRecord = {
    ...task,
    status: 'closed',
    candidateRunId: `kstc-${task.id}`,
    currentRequirementId: undefined,
    updatedAt: nowIso(),
  };
  await replaceKstarTask(userId, closedTask);

  const result: KstarTaskAggregateResult = {
    task: closedTask,
    closedRequirements: justClosed && !closedRequirements.some((requirement) => requirement.id === justClosed!.id)
      ? [...closedRequirements, justClosed]
      : closedRequirements,
    proposals,
    candidates,
  };

  if (state.pendingTaskStart) {
    await startPendingTopicSwitchTask(userId, {
      ...state,
      currentTaskId: undefined,
      currentRequirementId: undefined,
      taskComplete: false,
      updatedAt: nowIso(),
    });
  } else {
    await replaceConversationTaskState(userId, {
      ...state,
      currentTaskId: undefined,
      currentRequirementId: undefined,
      requirementJustClosed: undefined,
      taskComplete: false,
      pendingTaskStart: undefined,
      updatedAt: nowIso(),
    });
  }

  return result;
}
