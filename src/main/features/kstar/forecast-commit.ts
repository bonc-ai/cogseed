import * as fs from 'node:fs/promises';

import { nowIso, safeId } from '../../storage';
import { getWorkspacePath } from '../user_workspace';
import { loadCommittedProjectionKnowledge } from '../recall/projection-knowledge';
import { evaluateRules } from '../recall/rule-engine';
import {
  applyCausalRules,
  buildWorldModelForecastRecord,
  collectWorldSnapshot,
  saveWorldModelSnapshot,
  saveWorldModelForecast,
} from '../recall/world-model';
import {
  selectWorldModelCandidate,
  validateWorldModelCandidate,
} from '../recall/world-model-scoring';
import type {
  PredictedRisk,
  WorldModelCandidateForecast,
  WorldModelForecast,
  WorldModelForecastRecord,
  WorldModelSimulationInput,
} from '../recall/world-model-types';
import {
  readKstarRequirement,
  readKstarTask,
  replaceKstarRequirement,
} from './requirement-store';

export const FORECAST_COMMIT_ERROR_CODES = Object.freeze({
  invalidCandidate: 'kstar_invalid_candidate',
  unavailableTool: 'kstar_unavailable_tool',
  invalidRuleRef: 'kstar_invalid_rule_ref',
  projectionNotConfirmed: 'kstar_projection_not_confirmed',
  persistenceFailed: 'kstar_persistence_failed',
} as const);

export interface CommitForecastInput {
  taskRunId: string;
  requirementId: string;
  projectionId: string;
  candidates: unknown[];
  allowedToolNames: ReadonlySet<string>;
  workspaceId?: string;
  taskText: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
}

type ForecastCommitErrorCode = typeof FORECAST_COMMIT_ERROR_CODES[keyof typeof FORECAST_COMMIT_ERROR_CODES];

function codedError(code: ForecastCommitErrorCode, message: string): Error & { code: ForecastCommitErrorCode } {
  return Object.assign(new Error(message), { code });
}

function normalizedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedList(values: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizedText(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

async function workspaceAvailable(userId: string, workspaceId?: string): Promise<boolean> {
  try {
    await fs.access(getWorkspacePath(userId, workspaceId));
    return true;
  } catch {
    return false;
  }
}

function predictedRisksForKnowledge(
  snapshot: ReturnType<typeof collectWorldSnapshot>,
  rules: WorldModelSimulationInput['k']['rules'],
): PredictedRisk[] {
  const out: PredictedRisk[] = [];
  for (const entry of rules) {
    const rule = 'rule' in entry ? entry.rule : entry;
    for (const hit of applyCausalRules(snapshot, [rule])) {
      out.push({ ...hit, ruleId: 'rule' in entry ? entry.id : hit.ruleId });
    }
  }
  return out;
}

function mapValidationError(error: unknown): Error & { code: ForecastCommitErrorCode } {
  const message = (error as Error)?.message || 'invalid Forecast candidate';
  if (message.startsWith('unavailable_tool:')) {
    return codedError(FORECAST_COMMIT_ERROR_CODES.unavailableTool, message);
  }
  if (message.startsWith('invalid_rule_ref:')) {
    return codedError(FORECAST_COMMIT_ERROR_CODES.invalidRuleRef, message);
  }
  return codedError(FORECAST_COMMIT_ERROR_CODES.invalidCandidate, message);
}

function validateCandidates(
  value: unknown,
  context: {
    allowedToolNames: ReadonlySet<string>;
    allowedRuleRefs: Set<string>;
    predictedRisks: PredictedRisk[];
  },
): WorldModelCandidateForecast[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw codedError(
      FORECAST_COMMIT_ERROR_CODES.invalidCandidate,
      'Forecast must contain two to four candidates',
    );
  }
  try {
    return value.map((candidate, index) => validateWorldModelCandidate(candidate, {
      allowedTools: new Set(context.allowedToolNames),
      allowedRuleRefs: context.allowedRuleRefs,
      predictedRisks: context.predictedRisks,
    }, index));
  } catch (error) {
    throw mapValidationError(error);
  }
}

function assertInput(userId: string, input: CommitForecastInput): void {
  if (
    !safeId(userId)
    || !safeId(input.taskRunId)
    || !safeId(input.requirementId)
    || !safeId(input.projectionId)
    || (input.workspaceId !== undefined && !safeId(input.workspaceId))
    || !normalizedText(input.taskText, 4_000)
  ) {
    throw codedError(FORECAST_COMMIT_ERROR_CODES.invalidCandidate, 'invalid Forecast commit input');
  }
  if (!input.allowedToolNames || typeof input.allowedToolNames[Symbol.iterator] !== 'function') {
    throw codedError(FORECAST_COMMIT_ERROR_CODES.invalidCandidate, 'invalid allowed tool scope');
  }
}

export async function commitCommanderForecast(
  userId: string,
  input: CommitForecastInput,
): Promise<WorldModelForecastRecord> {
  assertInput(userId, input);

  const requirement = await readKstarRequirement(userId, input.requirementId);
  const task = await readKstarTask(userId, input.taskRunId);
  if (
    !requirement
    || !task
    || requirement.taskId !== task.id
    || requirement.projectionId !== input.projectionId
    || task.currentRequirementId !== requirement.id
    || requirement.status !== 'open'
    || task.status !== 'open'
  ) {
    throw codedError(
      FORECAST_COMMIT_ERROR_CODES.invalidCandidate,
      'Forecast does not match the active KStar Requirement',
    );
  }

  let knowledge: Awaited<ReturnType<typeof loadCommittedProjectionKnowledge>>;
  try {
    knowledge = await loadCommittedProjectionKnowledge(userId, input.projectionId);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'projection_not_committed' || code === 'projection_expired') {
      throw codedError(
        FORECAST_COMMIT_ERROR_CODES.projectionNotConfirmed,
        'KStar Projection is not confirmed',
      );
    }
    throw error;
  }

  const effectiveWorkspaceId = input.workspaceId || knowledge.workspaceId || task.workspaceId;
  if (
    input.workspaceId
    && knowledge.workspaceId
    && input.workspaceId !== knowledge.workspaceId
  ) {
    throw codedError(
      FORECAST_COMMIT_ERROR_CODES.invalidCandidate,
      'Forecast Projection workspace mismatch',
    );
  }
  if (
    task.workspaceId
    && effectiveWorkspaceId
    && task.workspaceId !== effectiveWorkspaceId
  ) {
    throw codedError(
      FORECAST_COMMIT_ERROR_CODES.invalidCandidate,
      'Forecast Task workspace mismatch',
    );
  }

  const workspaceIsAvailable = await workspaceAvailable(userId, effectiveWorkspaceId);
  const rules = knowledge.rules.map((entry) => entry.rule);
  const snapshot = collectWorldSnapshot(userId, {
    taskRunId: task.id,
    workspace: { ok: workspaceIsAvailable },
    model: { configured: true },
    tools: { fileSystem: true, bash: true },
    groupChatStatus: 'running',
    requirementStatus: requirement.status,
    projectionStatus: 'confirmed',
    skills: {
      total: knowledge.abilityAssets.length,
      categories: [...new Set(knowledge.abilityAssets.map((asset) => asset.type))],
      status: knowledge.abilityAssets.length ? 'ok' : 'empty',
    },
    ontology: {
      totalAssets: knowledge.abilityAssets.length + knowledge.ontologyAssets.length,
      activeAssets: knowledge.abilityAssets.length + knowledge.ontologyAssets.length,
      totalRules: rules.length,
    },
  });

  const taskText = normalizedText(input.taskText, 4_000);
  // Rule engine: which rules actually apply to THIS task? Text-triggered
  // evaluation over ontology R-Box rules + asset ΔR lessons; the matched
  // subset rides into K so the Commander reasons over relevant rules only.
  const matchedRules = evaluateRules({
    taskText,
    ontologyRules: knowledge.ontologyRules,
    assetRules: knowledge.abilityAssets.flatMap((asset) => (
      asset.causalRule ? [{ assetId: asset.id, rule: asset.causalRule }] : []
    )),
  }).matchedRules.map((rule) => rule.source === 'ontology'
    ? {
        source: 'ontology' as const,
        ruleId: rule.ruleId,
        trigger: rule.trigger,
        subject: rule.subject,
        object: rule.object,
      }
    : {
        source: 'asset' as const,
        ruleId: rule.ruleId,
        trigger: rule.trigger,
        cause: rule.cause,
        effect: rule.effect,
        mitigation: rule.mitigation,
        severity: rule.severity,
        deltaR: rule.deltaR,
      });
  const simulationInput: WorldModelSimulationInput = {
    k: {
      projectionId: knowledge.projectionId,
      projectionConfirmedAt: knowledge.projectionConfirmedAt,
      abilityAssetRefs: knowledge.abilityAssetRefs,
      abilityAssets: knowledge.abilityAssets,
      assetVersions: knowledge.assetVersions,
      rules: knowledge.rules,
      ontologyAssets: knowledge.ontologyAssets,
      ontologyTaxonomy: knowledge.ontologyTaxonomy,
      ontologyRules: knowledge.ontologyRules,
      ...(matchedRules.length ? { matchedRules } : {}),
    },
    s: {
      snapshotId: snapshot.id,
      ...(effectiveWorkspaceId ? { workspaceId: effectiveWorkspaceId } : {}),
      conversationSummary: taskText,
      environment: {
        workspaceAvailable: workspaceIsAvailable,
        modelConfigured: true,
        fileSystemAvailable: true,
        shellAvailable: true,
      },
      execution: {
        groupChatStatus: 'running',
        availableActors: ['commander'],
        availableTools: [...new Set(input.allowedToolNames)].sort(),
        accessConstraints: [],
        energyConstraints: [],
      },
      lifecycle: {
        requirementStatus: requirement.status,
        projectionStatus: 'confirmed',
      },
      recall: {
        selectedAssetCount: knowledge.abilityAssets.length,
        selectedRuleCount: knowledge.rules.length,
      },
    },
    t: {
      userGoal: taskText,
      constraints: boundedList(input.constraints, 20, 1_000),
      acceptanceCriteria: boundedList(input.acceptanceCriteria, 20, 1_000),
    },
  };

  const predictedRisks = predictedRisksForKnowledge(snapshot, knowledge.rules);
  const candidates = validateCandidates(input.candidates, {
    allowedToolNames: input.allowedToolNames,
    allowedRuleRefs: new Set(knowledge.rules.map((entry) => entry.id)),
    predictedRisks,
  });
  const selected = selectWorldModelCandidate(candidates);
  const forecast: WorldModelForecast = {
    candidates,
    selectedCandidateId: selected.id,
    aHat: selected.aHat,
    rHat: selected.rHat,
    causalLinks: selected.causalLinks,
    assumptions: selected.assumptions,
    predictedRisks: selected.predictedRisks.length ? selected.predictedRisks : predictedRisks,
  };
  const record = buildWorldModelForecastRecord(userId, {
    taskRunId: task.id,
    requirementId: requirement.id,
    projectionId: knowledge.projectionId,
    projectionConfirmedAt: knowledge.projectionConfirmedAt,
    assetVersions: knowledge.assetVersions,
    ruleRefs: knowledge.rules.map((entry) => entry.id),
    snapshotId: snapshot.id,
    forecast,
    simulationInput,
  });

  try {
    await saveWorldModelSnapshot(userId, snapshot);
    await saveWorldModelForecast(userId, record);
    await replaceKstarRequirement(userId, {
      ...requirement,
      forecastId: record.id,
      forecastStatus: 'committed',
      forecastError: undefined,
      updatedAt: nowIso(),
    });
  } catch (error) {
    throw codedError(
      FORECAST_COMMIT_ERROR_CODES.persistenceFailed,
      (error as Error)?.message || 'KStar Forecast persistence failed',
    );
  }
  return record;
}
