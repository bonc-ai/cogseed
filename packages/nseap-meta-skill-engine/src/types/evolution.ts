/** KSTAR 7 步固定顺序，与设计文档第 3 段一致。 */
export const KSTAR_STEPS = [
  'Capture', 'Attribution', 'Propose', 'Evaluate', 'Govern', 'Apply', 'Evolve',
] as const;
export type KstarStepName = typeof KSTAR_STEPS[number];

export type StepStatus = 'pending' | 'running' | 'done' | 'degraded' | 'failed';
export type RunStatus = 'running' | 'awaiting_review' | 'done' | 'aborted';

export interface EvolutionStep {
  step: number;               // 1..7
  name: KstarStepName;
  status: StepStatus;
  input?: unknown;
  output?: unknown;
  degraded?: boolean;         // true = 该步为规则降级产物
  error?: string;
  at?: string;
}

export interface EvolutionRun {
  runId: string;
  skillId: string;
  status: RunStatus;
  currentStep: number;
  startedAt: string;
  updatedAt: string;
  steps: EvolutionStep[];
  finalDecision?: 'staged' | 'rejected' | 'applied';
}

export interface EvalRecordCase { id: number; input: string; assertions: string[]; }
export interface EvalRecordRunResult {
  caseId: number; assertionId: number;
  withPass: boolean; withoutPass: boolean; verdict: 'pass' | 'fail'; evidence: string;
}
export interface EvalRecordRun {
  runId: string; at: string; model?: string; degraded: boolean;
  results: EvalRecordRunResult[]; passRate: number; regression: boolean;
}
export interface EvalRecord {
  skillId: string;
  cases: EvalRecordCase[];
  runs: EvalRecordRun[];
}
