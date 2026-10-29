import { z } from 'zod';

import { JEV_GATES } from '../jev/types';

export const ONTOLOGY_EVALUATION_ROUTES = ['semantic', 'ontology', 'ontology_jev'] as const;
export type OntologyEvaluationRoute = (typeof ONTOLOGY_EVALUATION_ROUTES)[number];

export const ONTOLOGY_EVALUATION_SCENARIOS = [
  'direct_relation', 'multi_hop', 'directionality', 'ambiguity', 'ontology_miss',
  'governance_filter', 'jev_none', 'jev_failure', 'directness_error', 'ordinary_non_jev',
] as const;
export type OntologyEvaluationScenario = (typeof ONTOLOGY_EVALUATION_SCENARIOS)[number];

const safeEvaluationId = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u);
const assetId = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u);
const intentSchema = z.object({
  route: z.enum(['ontology', 'semantic', 'hybrid', 'clarify']).optional(),
  targetEntityId: safeEvaluationId.optional(),
  relationKind: z.enum(['refines', 'depends_on', 'replaces', 'conflicts_with', 'related_to', 'same_family']).optional(),
  direction: z.enum(['incoming', 'outgoing', 'both']).optional(),
  relationScope: z.enum(['direct', 'indirect', 'both']).optional(),
  maxHops: z.number().int().min(1).max(4).optional(),
}).strict();

const evaluationCaseSchema = z.object({
  caseId: safeEvaluationId,
  query: z.string().trim().min(1).max(4_000),
  scenarios: z.array(z.enum(ONTOLOGY_EVALUATION_SCENARIOS)).min(1),
  expectedAssetIds: z.array(assetId).max(100),
  blockedAssetIds: z.array(assetId).max(100).optional(),
  expectedIntent: intentSchema.optional(),
}).strict();

const evaluationRunSchema = z.object({
  caseId: safeEvaluationId,
  route: z.enum(ONTOLOGY_EVALUATION_ROUTES),
  status: z.enum(['selected', 'none', 'clarify', 'fallback', 'error']),
  selectedAssetIds: z.array(assetId).max(100),
  intent: intentSchema.optional(),
  evidenceComplete: z.boolean().optional(),
  relationDirectionCorrect: z.boolean().optional(),
  directnessCorrect: z.boolean().optional(),
  hardGateViolations: z.number().int().min(0).default(0),
  fallback: z.boolean().default(false),
  latencyMs: z.number().finite().min(0),
  jevLatencyMs: z.number().finite().min(0).default(0),
  jevCalls: z.number().int().min(0).default(0),
  jevFallbacks: z.number().int().min(0).default(0),
  estimatedCostUsd: z.number().finite().min(0).default(0),
  jevStages: z.array(z.enum(JEV_GATES)).max(3).default([]),
}).strict();

export const ontologyEvaluationDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(evaluationCaseSchema).min(1),
  runs: z.array(evaluationRunSchema).min(1),
}).strict().superRefine((dataset, context) => {
  const caseIds = new Set<string>();
  for (const item of dataset.cases) {
    if (caseIds.has(item.caseId)) context.addIssue({ code: 'custom', message: `duplicate caseId: ${item.caseId}` });
    caseIds.add(item.caseId);
    if (new Set(item.expectedAssetIds).size !== item.expectedAssetIds.length) {
      context.addIssue({ code: 'custom', message: `duplicate expected asset ID: ${item.caseId}` });
    }
  }
  const runKeys = new Set<string>();
  for (const run of dataset.runs) {
    if (!caseIds.has(run.caseId)) context.addIssue({ code: 'custom', message: `run references unknown case: ${run.caseId}` });
    const key = `${run.caseId}\0${run.route}`;
    if (runKeys.has(key)) context.addIssue({ code: 'custom', message: `duplicate route run: ${run.caseId}/${run.route}` });
    runKeys.add(key);
    if (new Set(run.selectedAssetIds).size !== run.selectedAssetIds.length) {
      context.addIssue({ code: 'custom', message: `duplicate selected asset ID: ${run.caseId}/${run.route}` });
    }
    if (run.jevFallbacks > run.jevCalls) {
      context.addIssue({ code: 'custom', message: `jevFallbacks exceeds jevCalls: ${run.caseId}/${run.route}` });
    }
  }
});

export type OntologyEvaluationCase = z.infer<typeof evaluationCaseSchema>;
export type OntologyEvaluationRun = z.infer<typeof evaluationRunSchema>;
export type OntologyEvaluationDataset = z.infer<typeof ontologyEvaluationDatasetSchema>;

export type OntologyEvaluationRunObservation = Omit<
  OntologyEvaluationRun,
  'caseId' | 'route' | 'latencyMs' | 'hardGateViolations' | 'fallback' | 'jevLatencyMs' | 'jevCalls' | 'jevFallbacks' | 'estimatedCostUsd' | 'jevStages'
> & Partial<Pick<
  OntologyEvaluationRun,
  'latencyMs' | 'hardGateViolations' | 'fallback' | 'jevLatencyMs' | 'jevCalls' | 'jevFallbacks' | 'estimatedCostUsd' | 'jevStages'
>>;

export type OntologyEvaluationExecutor = (
  item: OntologyEvaluationCase,
  route: OntologyEvaluationRoute,
) => Promise<OntologyEvaluationRunObservation>;

export interface OntologyEvaluationRouteMetrics {
  caseCount: number;
  precision: number;
  recall: number;
  f1: number;
  mrr: number;
  exactMatchRate: number;
  noneAccuracy: number;
  intentAccuracy: number;
  evidenceCompleteRate: number;
  relationDirectionAccuracy: number;
  directnessAccuracy: number;
  errorRate: number;
  errorInjectionRate: number;
  hardGateViolations: number;
  fallbackRate: number;
  jevSuccessRate: number;
  averageJevCalls: number;
  averageEstimatedCostUsd: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  jevLatencyP95Ms: number;
}

export interface OntologyEvaluationReport {
  schemaVersion: 1;
  caseCount: number;
  completeCaseCount: number;
  missingRuns: Array<{ caseId: string; route: OntologyEvaluationRoute }>;
  coverage: { covered: OntologyEvaluationScenario[]; missing: OntologyEvaluationScenario[] };
  routes: Record<OntologyEvaluationRoute, OntologyEvaluationRouteMetrics>;
  comparisons: {
    cVsA: { f1Delta: number; precisionDelta: number; recallDelta: number };
    cVsB: { f1Delta: number; precisionDelta: number; recallDelta: number };
    fallbackParityRate: number;
  };
}

export interface OntologyRolloutThresholds {
  minimumCases: number;
  minimumF1GainOverSemantic: number;
  minimumNoneAccuracy: number;
  minimumIntentAccuracy: number;
  minimumEvidenceCompleteRate: number;
  minimumRelationDirectionAccuracy: number;
  minimumDirectnessAccuracy: number;
  minimumJevSuccessRate: number;
  minimumAverageJevCalls: number;
  minimumFallbackParity: number;
  maximumFallbackRate: number;
  maximumErrorRate: number;
  maximumP95LatencyMs: number;
  maximumAverageCostUsd: number;
  requiredScenarios: OntologyEvaluationScenario[];
}

export interface OntologyRolloutAssessment {
  status: 'ready' | 'not_ready';
  reasons: string[];
  thresholds: OntologyRolloutThresholds;
}

export const DEFAULT_ONTOLOGY_ROLLOUT_THRESHOLDS: OntologyRolloutThresholds = {
  minimumCases: 30,
  minimumF1GainOverSemantic: 0.05,
  minimumNoneAccuracy: 0.8,
  minimumIntentAccuracy: 0.9,
  minimumEvidenceCompleteRate: 0.95,
  minimumRelationDirectionAccuracy: 0.95,
  minimumDirectnessAccuracy: 0.95,
  minimumJevSuccessRate: 0.9,
  minimumAverageJevCalls: 0.1,
  minimumFallbackParity: 1,
  maximumFallbackRate: 0.2,
  maximumErrorRate: 0.05,
  maximumP95LatencyMs: 3_000,
  maximumAverageCostUsd: 0.01,
  requiredScenarios: [...ONTOLOGY_EVALUATION_SCENARIOS],
};

function rounded(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

function ratio(numerator: number, denominator: number, empty = 0): number {
  return denominator > 0 ? rounded(numerator / denominator) : empty;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return rounded(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
}

function intentMatches(expected: OntologyEvaluationCase['expectedIntent'], actual: OntologyEvaluationRun['intent']): boolean {
  if (!expected) return true;
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) => actual[key as keyof typeof actual] === value);
}

function reciprocalRank(expected: Set<string>, selected: readonly string[]): number {
  if (!expected.size) return selected.length ? 0 : 1;
  const index = selected.findIndex((id) => expected.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function routeMetrics(cases: readonly OntologyEvaluationCase[], runs: readonly OntologyEvaluationRun[]): OntologyEvaluationRouteMetrics {
  const caseById = new Map(cases.map((item) => [item.caseId, item]));
  let truePositive = 0; let falsePositive = 0; let falseNegative = 0;
  let reciprocalRankTotal = 0; let exactMatches = 0; let noneCorrect = 0;
  let intentTotal = 0; let intentCorrect = 0; let evidenceTotal = 0; let evidenceCorrect = 0;
  let directionTotal = 0; let directionCorrect = 0; let directnessTotal = 0; let directnessCorrect = 0;
  let blockedSelections = 0; let totalSelections = 0; let hardGateViolations = 0; let errors = 0;
  let fallbacks = 0; let jevCalls = 0; let jevFallbacks = 0; let totalCost = 0;
  const latencies: number[] = []; const jevLatencies: number[] = [];

  for (const run of runs) {
    const item = caseById.get(run.caseId);
    if (!item) continue;
    const expected = new Set(item.expectedAssetIds);
    const selected = new Set(run.selectedAssetIds);
    for (const id of selected) expected.has(id) ? truePositive += 1 : falsePositive += 1;
    for (const id of expected) if (!selected.has(id)) falseNegative += 1;
    reciprocalRankTotal += reciprocalRank(expected, run.selectedAssetIds);
    if (sameOrderedIds(item.expectedAssetIds, run.selectedAssetIds)) exactMatches += 1;
    if ((item.expectedAssetIds.length === 0) === (run.selectedAssetIds.length === 0)) noneCorrect += 1;
    if (item.expectedIntent) { intentTotal += 1; if (intentMatches(item.expectedIntent, run.intent)) intentCorrect += 1; }
    if (run.evidenceComplete !== undefined) { evidenceTotal += 1; if (run.evidenceComplete) evidenceCorrect += 1; }
    if (run.relationDirectionCorrect !== undefined) { directionTotal += 1; if (run.relationDirectionCorrect) directionCorrect += 1; }
    if (run.directnessCorrect !== undefined) { directnessTotal += 1; if (run.directnessCorrect) directnessCorrect += 1; }
    const blocked = new Set(item.blockedAssetIds || []);
    blockedSelections += run.selectedAssetIds.filter((id) => blocked.has(id)).length;
    totalSelections += run.selectedAssetIds.length;
    hardGateViolations += run.hardGateViolations + run.selectedAssetIds.filter((id) => blocked.has(id)).length;
    if (run.fallback) fallbacks += 1;
    if (run.status === 'error') errors += 1;
    jevCalls += run.jevCalls; jevFallbacks += run.jevFallbacks; totalCost += run.estimatedCostUsd;
    latencies.push(run.latencyMs); jevLatencies.push(run.jevLatencyMs);
  }

  const precision = ratio(truePositive, truePositive + falsePositive, falseNegative ? 0 : 1);
  const recall = ratio(truePositive, truePositive + falseNegative, 1);
  return {
    caseCount: runs.length,
    precision,
    recall,
    f1: precision + recall > 0 ? rounded((2 * precision * recall) / (precision + recall)) : 0,
    mrr: ratio(reciprocalRankTotal, runs.length),
    exactMatchRate: ratio(exactMatches, runs.length),
    noneAccuracy: ratio(noneCorrect, runs.length),
    intentAccuracy: ratio(intentCorrect, intentTotal),
    evidenceCompleteRate: ratio(evidenceCorrect, evidenceTotal),
    relationDirectionAccuracy: ratio(directionCorrect, directionTotal),
    directnessAccuracy: ratio(directnessCorrect, directnessTotal),
    errorRate: ratio(errors, runs.length),
    errorInjectionRate: ratio(blockedSelections, totalSelections),
    hardGateViolations,
    fallbackRate: ratio(fallbacks, runs.length),
    jevSuccessRate: ratio(jevCalls - jevFallbacks, jevCalls, 1),
    averageJevCalls: ratio(jevCalls, runs.length),
    averageEstimatedCostUsd: ratio(totalCost, runs.length),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    jevLatencyP95Ms: percentile(jevLatencies, 0.95),
  };
}

/** Execute every case through A/B/C with one caller-supplied runtime adapter.
 * The evaluator owns timing and converts executor failures into explicit error
 * runs, so missing routes cannot make a comparison look better than it is. */
export async function collectOntologyEvaluationDataset(
  casesValue: unknown,
  executor: OntologyEvaluationExecutor,
): Promise<OntologyEvaluationDataset> {
  const cases = z.array(evaluationCaseSchema).min(1).parse(casesValue);
  const runs: OntologyEvaluationRun[] = [];
  for (const item of cases) {
    for (const route of ONTOLOGY_EVALUATION_ROUTES) {
      const startedAt = Date.now();
      try {
        const observation = await executor(item, route);
        runs.push(evaluationRunSchema.parse({
          ...observation,
          caseId: item.caseId,
          route,
          latencyMs: observation.latencyMs ?? Math.max(0, Date.now() - startedAt),
        }));
      } catch {
        runs.push(evaluationRunSchema.parse({
          caseId: item.caseId,
          route,
          status: 'error',
          selectedAssetIds: [],
          latencyMs: Math.max(0, Date.now() - startedAt),
          fallback: route === 'ontology_jev',
        }));
      }
    }
  }
  return ontologyEvaluationDatasetSchema.parse({ schemaVersion: 1, cases, runs });
}

export function evaluateOntologyQueryDataset(value: unknown): OntologyEvaluationReport {
  const dataset = ontologyEvaluationDatasetSchema.parse(value);
  const runByKey = new Map(dataset.runs.map((run) => [`${run.caseId}\0${run.route}`, run]));
  const missingRuns: OntologyEvaluationReport['missingRuns'] = [];
  for (const item of dataset.cases) {
    for (const route of ONTOLOGY_EVALUATION_ROUTES) {
      if (!runByKey.has(`${item.caseId}\0${route}`)) missingRuns.push({ caseId: item.caseId, route });
    }
  }
  const coveredSet = new Set(dataset.cases.flatMap((item) => item.scenarios));
  const covered = ONTOLOGY_EVALUATION_SCENARIOS.filter((scenario) => coveredSet.has(scenario));
  const missing = ONTOLOGY_EVALUATION_SCENARIOS.filter((scenario) => !coveredSet.has(scenario));
  const routes = Object.fromEntries(ONTOLOGY_EVALUATION_ROUTES.map((route) => [
    route, routeMetrics(dataset.cases, dataset.runs.filter((run) => run.route === route)),
  ])) as Record<OntologyEvaluationRoute, OntologyEvaluationRouteMetrics>;

  let fallbackParityMatches = 0; let fallbackParityTotal = 0;
  for (const item of dataset.cases) {
    const c = runByKey.get(`${item.caseId}\0ontology_jev`);
    const b = runByKey.get(`${item.caseId}\0ontology`);
    if (!c?.fallback || !b) continue;
    fallbackParityTotal += 1;
    if (sameOrderedIds(c.selectedAssetIds, b.selectedAssetIds)) fallbackParityMatches += 1;
  }
  const delta = (left: number, right: number) => rounded(left - right);
  return {
    schemaVersion: 1,
    caseCount: dataset.cases.length,
    completeCaseCount: dataset.cases.length - new Set(missingRuns.map((item) => item.caseId)).size,
    missingRuns,
    coverage: { covered, missing },
    routes,
    comparisons: {
      cVsA: {
        f1Delta: delta(routes.ontology_jev.f1, routes.semantic.f1),
        precisionDelta: delta(routes.ontology_jev.precision, routes.semantic.precision),
        recallDelta: delta(routes.ontology_jev.recall, routes.semantic.recall),
      },
      cVsB: {
        f1Delta: delta(routes.ontology_jev.f1, routes.ontology.f1),
        precisionDelta: delta(routes.ontology_jev.precision, routes.ontology.precision),
        recallDelta: delta(routes.ontology_jev.recall, routes.ontology.recall),
      },
      fallbackParityRate: ratio(fallbackParityMatches, fallbackParityTotal, 1),
    },
  };
}

export function assessOntologyJevRollout(
  report: OntologyEvaluationReport,
  overrides: Partial<OntologyRolloutThresholds> = {},
): OntologyRolloutAssessment {
  const thresholds: OntologyRolloutThresholds = {
    ...DEFAULT_ONTOLOGY_ROLLOUT_THRESHOLDS,
    ...overrides,
    requiredScenarios: overrides.requiredScenarios || DEFAULT_ONTOLOGY_ROLLOUT_THRESHOLDS.requiredScenarios,
  };
  const reasons: string[] = [];
  const a = report.routes.semantic; const b = report.routes.ontology; const c = report.routes.ontology_jev;
  if (report.caseCount < thresholds.minimumCases) reasons.push(`评估样本不足：${report.caseCount} < ${thresholds.minimumCases}`);
  if (report.missingRuns.length) reasons.push(`存在 ${report.missingRuns.length} 条缺失的 A/B/C 运行结果`);
  const covered = new Set(report.coverage.covered);
  const missingRequired = thresholds.requiredScenarios.filter((scenario) => !covered.has(scenario));
  if (missingRequired.length) reasons.push(`场景覆盖不足：${missingRequired.join(', ')}`);
  if (c.f1 < b.f1) reasons.push(`C 的 F1 ${c.f1} 低于 B 的 ${b.f1}`);
  if (c.f1 - a.f1 < thresholds.minimumF1GainOverSemantic) reasons.push(`C 相对 A 的 F1 增益 ${rounded(c.f1 - a.f1)} 低于 ${thresholds.minimumF1GainOverSemantic}`);
  if (c.errorInjectionRate > b.errorInjectionRate) reasons.push('C 的错误注入率高于 B');
  if (c.hardGateViolations > 0) reasons.push(`C 出现 ${c.hardGateViolations} 次硬治理绕过`);
  if (c.noneAccuracy < thresholds.minimumNoneAccuracy) reasons.push(`C 的 none 准确率 ${c.noneAccuracy} 未达标`);
  if (c.intentAccuracy < thresholds.minimumIntentAccuracy) reasons.push(`C 的意图准确率 ${c.intentAccuracy} 未达标`);
  if (c.evidenceCompleteRate < thresholds.minimumEvidenceCompleteRate) reasons.push(`C 的证据完整率 ${c.evidenceCompleteRate} 未达标`);
  if (c.relationDirectionAccuracy < thresholds.minimumRelationDirectionAccuracy) reasons.push(`C 的关系方向准确率 ${c.relationDirectionAccuracy} 未达标`);
  if (c.directnessAccuracy < thresholds.minimumDirectnessAccuracy) reasons.push(`C 的直接/间接准确率 ${c.directnessAccuracy} 未达标`);
  if (c.jevSuccessRate < thresholds.minimumJevSuccessRate) reasons.push(`C 的 Jev 调用成功率 ${c.jevSuccessRate} 未达标`);
  if (c.averageJevCalls < thresholds.minimumAverageJevCalls) reasons.push('C 没有足够的真实 Jev 调用样本');
  if (report.comparisons.fallbackParityRate < thresholds.minimumFallbackParity) reasons.push('Jev 降级后未稳定保持 B 的结果');
  if (c.fallbackRate > thresholds.maximumFallbackRate) reasons.push(`C 的降级率 ${c.fallbackRate} 超过上限`);
  if (c.errorRate > thresholds.maximumErrorRate) reasons.push(`C 的错误率 ${c.errorRate} 超过上限`);
  if (c.latencyP95Ms > thresholds.maximumP95LatencyMs) reasons.push(`C 的 P95 延迟 ${c.latencyP95Ms}ms 超预算`);
  if (c.averageEstimatedCostUsd > thresholds.maximumAverageCostUsd) reasons.push('C 的单任务平均成本超预算');
  return { status: reasons.length ? 'not_ready' : 'ready', reasons, thresholds };
}
