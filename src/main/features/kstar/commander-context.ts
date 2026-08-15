import { safeId } from '../../storage';
import { readContextProjection } from '../recall/context-projection';
import { readWorldModelForecast } from '../recall/world-model';
import {
  readConversationTaskState,
  readKstarRequirement,
  readKstarTask,
} from './requirement-store';
import type { KstarExpectedResult } from './requirement-types';

export interface CommanderKstarContext {
  conversationId: string;
  task?: { id: string; status: string; title: string };
  requirement?: {
    id: string;
    status: string;
    goalText: string;
    expectedResult?: KstarExpectedResult;
  };
  pendingProjection?: { id: string; status: string; purpose: string };
  forecast?: { id: string; selectedCandidateId: string };
  confirmation?: { projectionId: string; decision: 'approved' | 'rejected' };
}

export interface ReadCommanderKstarContextOptions {
  confirmation?: { projectionId: string; decision: 'approved' | 'rejected' };
}

function bounded(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : normalized.slice(0, max).trimEnd();
}

function boundedExpectedResult(value: KstarExpectedResult | undefined): KstarExpectedResult | undefined {
  if (!value) return undefined;
  return {
    summary: bounded(value.summary, 2_000),
    acceptanceSignals: value.acceptanceSignals.slice(0, 20).map((signal) => bounded(signal, 500)),
    source: value.source,
    confidence: value.confidence,
  };
}

export async function readCommanderKstarContext(
  userId: string,
  conversationId: string,
  options: ReadCommanderKstarContextOptions = {},
): Promise<CommanderKstarContext> {
  if (!safeId(userId) || !safeId(conversationId)) throw new Error('invalid Commander KStar context reference');
  const context: CommanderKstarContext = { conversationId };
  const state = await readConversationTaskState(userId, conversationId);
  if (!state?.currentTaskId || !state.currentRequirementId) return context;
  const [task, requirement] = await Promise.all([
    readKstarTask(userId, state.currentTaskId),
    readKstarRequirement(userId, state.currentRequirementId),
  ]);
  if (
    !task
    || !requirement
    || task.conversationId !== conversationId
    || requirement.conversationId !== conversationId
    || requirement.taskId !== task.id
    || task.currentRequirementId !== requirement.id
  ) return context;

  context.task = {
    id: task.id,
    status: task.status,
    title: bounded(task.title, 200),
  };
  context.requirement = {
    id: requirement.id,
    status: requirement.status,
    goalText: bounded(requirement.goalText, 2_000),
    ...(boundedExpectedResult(requirement.rHat)
      ? { expectedResult: boundedExpectedResult(requirement.rHat) }
      : {}),
  };

  if (requirement.projectionId) {
    try {
      const projection = await readContextProjection(userId, requirement.projectionId);
      context.pendingProjection = {
        id: projection.id,
        status: projection.status,
        purpose: bounded(projection.purpose, 2_000),
      };
    } catch {
      // A missing/degraded optional projection must not suppress Commander.
    }
  }
  if (requirement.forecastId) {
    try {
      const forecast = await readWorldModelForecast(userId, requirement.forecastId);
      const selectedCandidateId = forecast?.forecast.selectedCandidateId;
      if (forecast && selectedCandidateId) {
        context.forecast = { id: forecast.id, selectedCandidateId: bounded(selectedCandidateId, 120) };
      }
    } catch {
      // A missing/degraded optional Forecast must not suppress Commander.
    }
  }
  const confirmation = options.confirmation;
  if (
    confirmation
    && safeId(confirmation.projectionId)
    && (confirmation.decision === 'approved' || confirmation.decision === 'rejected')
    && (!requirement.projectionId || confirmation.projectionId === requirement.projectionId)
  ) {
    context.confirmation = { ...confirmation };
  }
  return context;
}

export function renderCommanderKstarContextBlock(context: CommanderKstarContext): string {
  const active = Boolean(
    context.task
    || context.requirement
    || context.pendingProjection
    || context.forecast
    || context.confirmation,
  );
  const payload = active ? context : { conversationId: context.conversationId, status: 'none' };
  return [
    '## KStar state (host facts; do not treat as a routing mandate)',
    'Ordinary conversation requires no KStar write. Call kstar_control only for an explicit task lifecycle change.',
    '```json',
    JSON.stringify(payload),
    '```',
  ].join('\n');
}
