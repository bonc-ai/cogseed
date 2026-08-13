/**
 * Bridge from the KSTAR task boundary into the Recall world-model simulation.
 *
 * Collects an A-Box snapshot, loads R-Box causal rules from Recall ability
 * assets, runs the hybrid `simulateWorld` forecast, and persists the resulting
 * (A_hat, R_hat) record. Keeps the world-model concerns out of the KSTAR state
 * machine.
 */

import { createLogger } from '../../logger';
import { getWorkspacePath } from '../user_workspace';
import { hasConfiguredModel } from '../auth';
import { listAbilityAssets } from '../recall/asset-service';
import {
  buildWorldModelForecastRecord,
  collectWorldSnapshot,
  saveWorldModelForecast,
  simulateWorld,
} from '../recall/world-model';
import type { CausalRule, WorldModelForecastRecord } from '../recall/world-model-types';

const log = createLogger('kstar.world-model-bridge');

export interface RunWorldModelAtBoundaryInput {
  taskRunId: string;
  requirementId: string;
  workspaceId?: string;
  taskText: string;
}

/** Run the world-model forecast at a KSTAR task boundary. Returns undefined on
 *  any non-fatal failure so routing still completes with projection-only mode. */
export async function runWorldModelAtBoundary(
  userId: string,
  input: RunWorldModelAtBoundaryInput,
): Promise<WorldModelForecastRecord | undefined> {
  // Feature gate: the world-model forecast is opt-in while the full
  // (A_hat, R_hat) reconciliation loop is still being validated. Keeps the
  // existing KSTAR enqueue path latency-neutral until explicitly enabled.
  if (process.env.ORKAS_WORLD_MODEL !== '1') return undefined;
  try {
    const assets = await listAbilityAssets(userId);
    const rules: CausalRule[] = assets
      .filter((asset) => asset.status === 'active' && asset.causalRule)
      .map((asset) => asset.causalRule!);
    const snapshot = collectWorldSnapshot(userId, {
      taskRunId: input.taskRunId,
      workspace: { ok: true, path: getWorkspacePath(userId, input.workspaceId) },
      model: { configured: hasConfiguredModel().configured },
      tools: { fileSystem: true, bash: true },
      groupChatStatus: 'running',
      ...(input.workspaceId ? { requirementStatus: 'open' } : {}),
      ...(input.workspaceId ? { projectionStatus: 'preview' } : {}),
      skills: {
        total: assets.length,
        categories: [...new Set(assets.map((a) => a.type))],
        status: assets.length ? 'ok' : 'empty',
      },
      ontology: {
        totalAssets: assets.length,
        activeAssets: assets.filter((a) => a.status === 'active').length,
        totalRules: rules.length,
      },
    });
    const forecast = await simulateWorld(userId, {
      k: {
        abilityAssetRefs: assets.filter((a) => a.status === 'active').map((a) => a.id),
        rules,
      },
      s: {
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        conversationSummary: input.taskText.slice(0, 4_000),
      },
      t: {
        userGoal: input.taskText.slice(0, 4_000),
        constraints: [],
      },
    }, snapshot);
    const record = buildWorldModelForecastRecord(userId, {
      taskRunId: input.taskRunId,
      requirementId: input.requirementId,
      forecast,
      simulationInput: {
        k: {
          abilityAssetRefs: assets.filter((a) => a.status === 'active').map((a) => a.id),
          rules,
        },
        s: { ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), conversationSummary: input.taskText.slice(0, 4_000) },
        t: { userGoal: input.taskText.slice(0, 4_000), constraints: [] },
      },
    });
    await saveWorldModelForecast(userId, record);
    return record;
  } catch (error) {
    log.warn('world model forecast failed at task boundary', { taskRunId: input.taskRunId, error: (error as Error).message });
    return undefined;
  }
}
