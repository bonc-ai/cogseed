/**
 * KSTAR boundary bridge into the Recall world-model simulation.
 *
 * A Forecast is permitted only after a Recall Projection is confirmed. The
 * exact frozen Projection assets form K for both this Forecast and the later
 * Commander turn; this module never scans the user's full active asset set.
 */

import * as fs from 'node:fs/promises';

import { hasConfiguredModel } from '../auth';
import { getWorkspacePath } from '../user_workspace';
import { loadCommittedProjectionKnowledge } from '../recall/projection-knowledge';
import {
  buildWorldModelForecastRecord,
  collectWorldSnapshot,
  saveWorldModelForecast,
  simulateWorld,
} from '../recall/world-model';
import type {
  WorldModelForecast,
  WorldModelForecastRecord,
  WorldModelSimulationInput,
  WorldModelSnapshot,
} from '../recall/world-model-types';

export interface RunWorldModelAtBoundaryInput {
  taskRunId: string;
  requirementId: string;
  committedProjectionId: string;
  workspaceId?: string;
  taskText: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
}

export interface RunWorldModelDependencies {
  runSimulation?: (
    userId: string,
    input: WorldModelSimulationInput,
    snapshot: WorldModelSnapshot,
  ) => Promise<WorldModelForecast>;
  getWorkspaceAvailability?: (userId: string, workspaceId?: string) => Promise<boolean>;
}

async function defaultWorkspaceAvailability(userId: string, workspaceId?: string): Promise<boolean> {
  try {
    await fs.access(getWorkspacePath(userId, workspaceId));
    return true;
  } catch {
    return false;
  }
}

function boundedList(values: string[] | undefined, maxItems: number, maxLength: number): string[] {
  return (values || [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.replace(/\s+/g, ' ').trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export async function runWorldModelAtBoundary(
  userId: string,
  input: RunWorldModelAtBoundaryInput,
  dependencies: RunWorldModelDependencies = {},
): Promise<WorldModelForecastRecord> {
  const knowledge = await loadCommittedProjectionKnowledge(userId, input.committedProjectionId);
  if (input.workspaceId && knowledge.workspaceId && input.workspaceId !== knowledge.workspaceId) {
    throw Object.assign(new Error('forecast projection workspace mismatch'), { code: 'forecast_projection_mismatch' });
  }

  const workspaceAvailable = await (dependencies.getWorkspaceAvailability || defaultWorkspaceAvailability)(
    userId,
    input.workspaceId || knowledge.workspaceId,
  );
  const modelConfigured = hasConfiguredModel().configured;
  const rules = knowledge.rules.map((entry) => entry.rule);
  const snapshot = collectWorldSnapshot(userId, {
    taskRunId: input.taskRunId,
    workspace: { ok: workspaceAvailable },
    model: { configured: modelConfigured },
    tools: { fileSystem: true, bash: true },
    groupChatStatus: 'running',
    requirementStatus: 'open',
    projectionStatus: 'confirmed',
    skills: {
      total: knowledge.abilityAssets.length,
      categories: [...new Set(knowledge.abilityAssets.map((asset) => asset.type))],
      status: knowledge.abilityAssets.length ? 'ok' : 'empty',
    },
    ontology: {
      totalAssets: knowledge.abilityAssets.length,
      activeAssets: knowledge.abilityAssets.length,
      totalRules: rules.length,
    },
  });

  const simulationInput: WorldModelSimulationInput = {
    k: {
      projectionId: knowledge.projectionId,
      projectionConfirmedAt: knowledge.projectionConfirmedAt,
      abilityAssetRefs: knowledge.abilityAssetRefs,
      abilityAssets: knowledge.abilityAssets,
      assetVersions: knowledge.assetVersions,
      rules: knowledge.rules,
    },
    s: {
      snapshotId: snapshot.id,
      ...(input.workspaceId || knowledge.workspaceId
        ? { workspaceId: input.workspaceId || knowledge.workspaceId }
        : {}),
      conversationSummary: input.taskText.replace(/\s+/g, ' ').trim().slice(0, 4_000),
      environment: {
        workspaceAvailable,
        modelConfigured,
        fileSystemAvailable: true,
        shellAvailable: true,
      },
      execution: {
        groupChatStatus: 'running',
        availableActors: ['commander'],
        accessConstraints: [],
        energyConstraints: [],
      },
      lifecycle: {
        requirementStatus: 'open',
        projectionStatus: 'confirmed',
      },
      recall: {
        selectedAssetCount: knowledge.abilityAssets.length,
        selectedRuleCount: knowledge.rules.length,
      },
    },
    t: {
      userGoal: input.taskText.replace(/\s+/g, ' ').trim().slice(0, 4_000),
      constraints: boundedList(input.constraints, 20, 1_000),
      acceptanceCriteria: boundedList(input.acceptanceCriteria, 20, 1_000),
    },
  };

  const forecast = await (dependencies.runSimulation || simulateWorld)(userId, simulationInput, snapshot);
  const record = buildWorldModelForecastRecord(userId, {
    taskRunId: input.taskRunId,
    requirementId: input.requirementId,
    projectionId: knowledge.projectionId,
    projectionConfirmedAt: knowledge.projectionConfirmedAt,
    assetVersions: knowledge.assetVersions,
    ruleRefs: knowledge.rules.map((entry) => entry.id),
    snapshotId: snapshot.id,
    forecast,
    simulationInput,
  });
  await saveWorldModelForecast(userId, record);
  return record;
}
