import * as path from 'node:path';

import type { AbilityAssetType } from './candidate-service';
import type { KstarEpisodeRecord, KstarToolCall } from '../kstar/types';
import type {
  AcceptanceSignalResult,
  ActionDeltaDetail,
  ResultDeltaDetail,
  WorldModelForecast,
  WorldModelReconciliation,
} from './world-model-types';

export interface WorldModelReconciliationOptions {
  selectedAssetTypes?: AbilityAssetType[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalized(value: unknown): string {
  return String(value || '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
}

function orderedCalls(calls: KstarToolCall[]): KstarToolCall[] {
  return calls.map((call, index) => ({ ...call, sequence: call.sequence ?? index }))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

function isSubsequence(expected: string[], actual: string[]): boolean {
  let index = 0;
  for (const value of actual) {
    if (value === expected[index]) index += 1;
    if (index === expected.length) return true;
  }
  return expected.length === 0;
}

function reconcileActions(forecast: WorldModelForecast, episode: KstarEpisodeRecord): {
  deltaA: number | 'unknown';
  detail: ActionDeltaDetail;
} {
  const predictedTools = forecast.aHat.expectedTools;
  const predictedActors = forecast.aHat.expectedActors;
  const actualCalls = orderedCalls(episode.a.toolCalls);
  const actualTools = actualCalls.map((call) => call.name);
  const agentActions = episode.a.agentActions || [];
  const actualActors = unique([
    ...actualCalls.map((call) => call.actor || ''),
    ...agentActions.map((action) => action.actor || ''),
  ]);
  const missingTools = unique(predictedTools.filter((tool) => !actualTools.includes(tool)));
  const unexpectedTools = unique(actualTools.filter((tool) => !predictedTools.includes(tool)));
  const missingActors = actualActors.length
    ? unique(predictedActors.filter((actor) => !actualActors.includes(actor)))
    : [];
  const unexpectedActors = actualActors.length
    ? unique(actualActors.filter((actor) => !predictedActors.includes(actor)))
    : [];
  const failedActions = unique(actualCalls
    .filter((call) => call.status === 'error' || call.status === 'cancelled')
    .map((call) => call.name));
  const actualActionText = agentActions.map((action) => normalized(action.action));
  const missingPlanSteps = agentActions.length
    ? forecast.aHat.plan.filter((step) => {
        const expected = normalized(step);
        if (!expected) return false;
        return !actualActionText.some((actual) => actual === expected || actual.includes(expected) || expected.includes(actual));
      })
    : [];
  const extraActions = agentActions
    .map((action) => action.action)
    .filter((action) => {
      const actual = normalized(action);
      return !forecast.aHat.plan.some((step) => {
        const expected = normalized(step);
        return actual === expected || actual.includes(expected) || expected.includes(actual);
      });
    });
  const predictedToolSequence = predictedTools.filter((tool, index) => predictedTools.indexOf(tool) === index);
  const actualRelevantSequence = actualTools.filter((tool) => predictedToolSequence.includes(tool));
  const orderMismatch = predictedToolSequence.length > 1
    && !isSubsequence(predictedToolSequence, actualRelevantSequence);
  const detail: ActionDeltaDetail = {
    missingTools,
    unexpectedTools,
    missingActors,
    unexpectedActors,
    missingPlanSteps,
    extraActions,
    failedActions,
    orderMismatch,
  };
  if (!predictedTools.length && !forecast.aHat.plan.length && !predictedActors.length) {
    return { deltaA: 'unknown', detail };
  }
  if (!actualCalls.length && !agentActions.length) {
    return { deltaA: 'unknown', detail };
  }
  const predictedCount = Math.max(1, predictedTools.length + predictedActors.length + forecast.aHat.plan.length);
  const gapCount = missingTools.length
    + missingActors.length
    + missingPlanSteps.length
    + failedActions.length
    + (orderMismatch ? 1 : 0)
    + Math.min(1, unexpectedActors.length);
  return {
    deltaA: gapCount === 0 ? 0 : Number((-Math.min(1, gapCount / predictedCount)).toFixed(4)),
    detail,
  };
}

function verificationChecks(value: unknown): { global?: boolean; checks: Map<string, boolean> } {
  const checks = new Map<string, boolean>();
  if (value === true) return { global: true, checks };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { checks };
  const record = value as Record<string, unknown>;
  const global = record.passed === true || record.ok === true || record.success === true
    ? true
    : record.passed === false || record.ok === false || record.success === false
      ? false
      : ['passed', 'succeeded', 'success', 'ok'].includes(String(record.status || '').toLowerCase())
        ? true
        : ['failed', 'failure', 'error', 'not_met'].includes(String(record.status || '').toLowerCase())
          ? false
          : undefined;
  const rawChecks = record.checks;
  if (rawChecks && typeof rawChecks === 'object' && !Array.isArray(rawChecks)) {
    for (const [key, raw] of Object.entries(rawChecks as Record<string, unknown>)) {
      if (raw === true || raw === false) checks.set(normalized(key), raw);
      else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const item = raw as Record<string, unknown>;
        if (item.passed === true || item.ok === true) checks.set(normalized(key), true);
        if (item.passed === false || item.ok === false) checks.set(normalized(key), false);
      }
    }
  }
  return { ...(global !== undefined ? { global } : {}), checks };
}

function signalResult(signal: string, verification: ReturnType<typeof verificationChecks>): AcceptanceSignalResult {
  const key = normalized(signal);
  if (verification.checks.has(key)) {
    const met = verification.checks.get(key) === true;
    return { signal, status: met ? 'met' : 'not_met', evidence: `verification.checks[${signal}]` };
  }
  const fuzzy = [...verification.checks.entries()].find(([candidate]) => candidate.includes(key) || key.includes(candidate));
  if (fuzzy) return { signal, status: fuzzy[1] ? 'met' : 'not_met', evidence: `verification.checks[${fuzzy[0]}]` };
  if (verification.global !== undefined) {
    return { signal, status: verification.global ? 'met' : 'not_met', evidence: 'verification global status' };
  }
  return { signal, status: 'unknown', evidence: 'no structured verification evidence' };
}

function reconcileResults(forecast: WorldModelForecast, episode: KstarEpisodeRecord): {
  deltaR: number | 'unknown';
  detail: ResultDeltaDetail;
} {
  const verification = verificationChecks(episode.r.verification);
  const acceptanceSignals = forecast.rHat.acceptanceSignals.map((signal) => signalResult(signal, verification));
  const actualFiles = unique(episode.r.producedFiles.map((file) => path.normalize(file)));
  const predictedFiles = unique(forecast.rHat.predictedFiles.map((file) => path.normalize(file)));
  const missingPredictedFiles = predictedFiles.filter((file) => !actualFiles.includes(file));
  const unexpectedProducedFiles = actualFiles.filter((file) => !predictedFiles.includes(file));
  const detail: ResultDeltaDetail = {
    acceptanceSignals,
    missingPredictedFiles,
    unexpectedProducedFiles,
    terminalStatus: episode.r.status,
  };
  if (episode.r.status === 'failed' || episode.r.status === 'cancelled') {
    return { deltaR: -1, detail };
  }
  const known: boolean[] = acceptanceSignals
    .filter((signal) => signal.status !== 'unknown')
    .map((signal) => signal.status === 'met');
  known.push(...predictedFiles.map((file) => actualFiles.includes(file)));
  if (!known.length) return { deltaR: 'unknown', detail };
  const met = known.filter(Boolean).length;
  return { deltaR: Number((met / known.length - 1).toFixed(4)), detail };
}

function attributionFor(
  deltaR: number | 'unknown',
  options: WorldModelReconciliationOptions,
): WorldModelReconciliation['attribution'] {
  if (deltaR === 'unknown' || deltaR === 0) return 'unclear';
  const types = options.selectedAssetTypes || [];
  if (types.includes('rule')) return 'rule_gap';
  if (types.includes('template')) return 'template_gap';
  if (types.includes('skill_method')) return 'skill_gap';
  return 'knowledge_gap';
}

export function reconcileWorldModel(
  forecast: WorldModelForecast,
  episode: KstarEpisodeRecord,
  options: WorldModelReconciliationOptions = {},
): WorldModelReconciliation {
  const action = reconcileActions(forecast, episode);
  const emptyResult: ResultDeltaDetail = {
    acceptanceSignals: forecast.rHat.acceptanceSignals.map((signal) => ({
      signal, status: 'unknown', evidence: 'result delta gated by execution gap',
    })),
    missingPredictedFiles: [],
    unexpectedProducedFiles: [],
    terminalStatus: episode.r.status,
  };
  if (action.deltaA !== 0 && action.deltaA !== 'unknown') {
    return {
      deltaA: action.deltaA,
      deltaR: 'unknown',
      attribution: 'execution_gap',
      actionDelta: action.detail,
      resultDelta: emptyResult,
    };
  }
  const result = reconcileResults(forecast, episode);
  return {
    deltaA: action.deltaA,
    deltaR: result.deltaR,
    attribution: attributionFor(result.deltaR, options),
    actionDelta: action.detail,
    resultDelta: result.detail,
  };
}
