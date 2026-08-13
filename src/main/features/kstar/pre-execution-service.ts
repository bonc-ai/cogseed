import { nowIso, safeId } from '../../storage';
import {
  confirmContextProjection,
  readContextProjection,
  type ContextProjectionRecord,
} from '../recall/context-projection';
import { readWorldModelForecast } from '../recall/world-model';
import type { WorldModelForecastRecord } from '../recall/world-model-types';
import {
  readState,
  updatePendingProjectionDispatch,
} from '../group_chat/state';
import {
  findKstarRequirementByProjection,
  readKstarRequirement,
  readKstarTask,
  replaceKstarRequirement,
} from './requirement-store';
import { runWorldModelAtBoundary } from './world-model-bridge';

export interface PreExecutionDependencies {
  runWorldModel?: typeof runWorldModelAtBoundary;
  resumeDispatch?: (userId: string, cid: string) => Promise<boolean>;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code.trim()) return code.trim().slice(0, 160);
  const message = (error as Error)?.message || '';
  if (/not configured/i.test(message)) return 'model_not_configured';
  if (/authorization|auth/i.test(message)) return 'model_auth_required';
  return 'world_model_unavailable';
}

async function committedProjection(userId: string, projectionId: string): Promise<ContextProjectionRecord> {
  try {
    return await confirmContextProjection(userId, projectionId);
  } catch (error) {
    if (!/already confirmed/i.test((error as Error).message || '')) throw error;
    const projection = await readContextProjection(userId, projectionId);
    if (projection.status !== 'confirmed') throw error;
    return projection;
  }
}

async function defaultResume(userId: string, cid: string): Promise<boolean> {
  const bus = await import('../group_chat/bus');
  return bus.resumePendingProjectionDispatch(userId, cid);
}

async function existingForecast(
  userId: string,
  requirementId: string,
): Promise<WorldModelForecastRecord | undefined> {
  const requirement = await readKstarRequirement(userId, requirementId);
  if (!requirement?.forecastId) return undefined;
  const forecast = await readWorldModelForecast(userId, requirement.forecastId);
  return forecast || undefined;
}

async function prepare(
  userId: string,
  input: { cid: string; projectionId: string },
  dependencies: PreExecutionDependencies,
  confirmProjection: boolean,
): Promise<{ projection: ContextProjectionRecord; forecast: WorldModelForecastRecord; resumed: boolean }> {
  if (!safeId(userId) || !safeId(input.cid) || !safeId(input.projectionId)) {
    throw new Error('invalid kstar pre-execution input');
  }
  const state = await readState(userId, input.cid);
  const pending = state.pending_projection_dispatch;
  if (!pending || pending.projectionId !== input.projectionId) {
    throw Object.assign(new Error('pending projection dispatch not found'), { code: 'projection_not_found' });
  }
  const projection = confirmProjection
    ? await committedProjection(userId, input.projectionId)
    : await readContextProjection(userId, input.projectionId);
  if (projection.status !== 'confirmed') {
    throw Object.assign(new Error('projection is not committed'), { code: 'projection_not_committed' });
  }
  const requirement = await findKstarRequirementByProjection(userId, input.cid, input.projectionId);
  if (requirement.id !== pending.requirementId || requirement.taskId !== pending.taskRunId) {
    throw Object.assign(new Error('pending projection requirement mismatch'), { code: 'forecast_projection_mismatch' });
  }
  const prior = await existingForecast(userId, requirement.id);
  if (prior) {
    await updatePendingProjectionDispatch(userId, input.cid, (current) => ({
      ...current,
      status: 'ready_to_dispatch',
      forecastId: prior.id,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: nowIso(),
    }));
    const resumed = await (dependencies.resumeDispatch || defaultResume)(userId, input.cid);
    return { projection, forecast: prior, resumed };
  }
  await updatePendingProjectionDispatch(userId, input.cid, (current) => ({
    ...current,
    status: 'forecasting',
    errorCode: undefined,
    errorMessage: undefined,
    updatedAt: nowIso(),
  }));
  try {
    const task = await readKstarTask(userId, requirement.taskId);
    const run = dependencies.runWorldModel || runWorldModelAtBoundary;
    const forecast = await run(userId, {
      taskRunId: requirement.taskId,
      requirementId: requirement.id,
      ...(task?.workspaceId ? { workspaceId: task.workspaceId } : {}),
      taskText: requirement.goalText,
    });
    if (!forecast) throw Object.assign(new Error('world model unavailable'), { code: 'world_model_unavailable' });
    await replaceKstarRequirement(userId, { ...requirement, forecastId: forecast.id, updatedAt: nowIso() });
    await updatePendingProjectionDispatch(userId, input.cid, (current) => ({
      ...current,
      status: 'ready_to_dispatch',
      forecastId: forecast.id,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: nowIso(),
    }));
    const resumed = await (dependencies.resumeDispatch || defaultResume)(userId, input.cid);
    return { projection, forecast, resumed };
  } catch (error) {
    await updatePendingProjectionDispatch(userId, input.cid, (current) => ({
      ...current,
      status: 'world_model_failed',
      errorCode: errorCode(error),
      errorMessage: (error as Error).message.slice(0, 1_000),
      updatedAt: nowIso(),
    }));
    throw error;
  }
}

export function confirmProjectionAndPrepareDispatch(
  userId: string,
  input: { cid: string; projectionId: string },
  dependencies: PreExecutionDependencies = {},
): Promise<{ projection: ContextProjectionRecord; forecast: WorldModelForecastRecord; resumed: boolean }> {
  return prepare(userId, input, dependencies, true);
}

export function retryProjectionForecast(
  userId: string,
  input: { cid: string; projectionId: string },
  dependencies: PreExecutionDependencies = {},
): Promise<{ projection: ContextProjectionRecord; forecast: WorldModelForecastRecord; resumed: boolean }> {
  return prepare(userId, input, dependencies, false);
}
