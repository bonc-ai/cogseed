import * as fs from 'node:fs/promises';
import { evalsDir, evalRecordPath } from './paths';
import { loadEngine } from './engine-loader';
import { buildLlmComplete } from './llm-bridge';

export interface EvalRecordCase { id: number; input: string; assertions: string[]; }
export interface EvalRecordRun {
  runId: string; at: string; model?: string; degraded: boolean;
  baselineExecutionId?: string; treatmentExecutionId?: string; contrastId?: string; receiptId?: string;
  results: Array<{ caseId: number; assertionId: number; withPass: boolean; withoutPass: boolean; verdict: 'pass' | 'fail'; evidence: string }>;
  passRate: number; regression: boolean;
}
export interface EvalStandardAssertion { type: string; text: string; }
export interface EvalStandardCase { input: string; negative?: boolean; expected_output?: string; }
// 人写评估标准(等价原型 Eval 表的 assertions_json + cases_json)。
export interface EvalStandardRaw { assertions: EvalStandardAssertion[]; cases: EvalStandardCase[]; }

// 文件承载的完整形状:cases/runs(自动)+ standard(人写)共存于同一 JSON。
interface EvalFileShape { skillId: string; cases: EvalRecordCase[]; runs: EvalRecordRun[]; standard?: EvalStandardRaw; }
export interface EvalRecord { skillId: string; cases: EvalRecordCase[]; runs: EvalRecordRun[]; }

// 门槛常量(照搬原型)。
const STD_MIN = { qualitative: 3, invariant: 2, boundary: 4 } as const;
const STD_MIN_CASES = 10;
const STD_MIN_NEGATIVE = 4;
const STD_MIN_ASSERTIONS = 9;

// 读原始文件(保留全部键)。内部用,不丢 standard。
async function readEvalFile(uid: string, skillId: string): Promise<EvalFileShape> {
  try {
    const raw = await fs.readFile(evalRecordPath(uid, skillId), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EvalFileShape>;
    return { skillId, cases: parsed.cases ?? [], runs: parsed.runs ?? [], standard: parsed.standard };
  } catch {
    return { skillId, cases: [], runs: [] };
  }
}

async function writeEvalFile(uid: string, file: EvalFileShape): Promise<void> {
  await fs.mkdir(evalsDir(uid), { recursive: true });
  await fs.writeFile(evalRecordPath(uid, file.skillId), JSON.stringify(file, null, 2), 'utf-8');
}

export async function readEvalRecord(uid: string, skillId: string): Promise<EvalRecord> {
  const f = await readEvalFile(uid, skillId);
  return { skillId, cases: f.cases, runs: f.runs };
}

export async function saveEvalRecord(uid: string, rec: EvalRecord): Promise<void> {
  // 合并:保留已有 standard,不覆盖。
  const existing = await readEvalFile(uid, rec.skillId);
  await writeEvalFile(uid, { skillId: rec.skillId, cases: rec.cases, runs: rec.runs, standard: existing.standard });
}

export interface EvalStandardView {
  skillId: string;
  assertions: {
    qualitative: EvalStandardAssertion[]; invariant: EvalStandardAssertion[]; boundary: EvalStandardAssertion[];
    total: number; min_required: typeof STD_MIN;
  };
  cases: { positive: EvalStandardCase[]; negative: EvalStandardCase[]; total: number; min_positive: number; min_negative: number };
  ready: boolean;
}

export async function readEvalStandard(uid: string, skillId: string): Promise<EvalStandardView> {
  const f = await readEvalFile(uid, skillId);
  const assertions = f.standard?.assertions ?? [];
  const cases = f.standard?.cases ?? [];
  const qualitative = assertions.filter(a => a.type === 'qualitative');
  const invariant = assertions.filter(a => a.type === 'invariant');
  const boundary = assertions.filter(a => a.type === 'boundary');
  const positive = cases.filter(c => !c.negative);
  const negative = cases.filter(c => c.negative);
  const ready = assertions.length >= STD_MIN_ASSERTIONS
    && qualitative.length >= STD_MIN.qualitative
    && invariant.length >= STD_MIN.invariant
    && boundary.length >= STD_MIN.boundary
    && cases.length >= STD_MIN_CASES
    && negative.length >= STD_MIN_NEGATIVE;
  return {
    skillId,
    assertions: { qualitative, invariant, boundary, total: assertions.length, min_required: STD_MIN },
    cases: { positive, negative, total: cases.length, min_positive: STD_MIN_CASES - STD_MIN_NEGATIVE, min_negative: STD_MIN_NEGATIVE },
    ready,
  };
}

export async function saveEvalStandard(uid: string, skillId: string, raw: EvalStandardRaw): Promise<EvalStandardView> {
  const f = await readEvalFile(uid, skillId);
  f.standard = { assertions: raw.assertions ?? [], cases: raw.cases ?? [] };
  await writeEvalFile(uid, f);
  return readEvalStandard(uid, skillId);
}

export async function upsertEvalCase(uid: string, skillId: string, c: EvalRecordCase): Promise<EvalRecord> {
  const rec = await readEvalRecord(uid, skillId);
  rec.cases = rec.cases.filter(x => x.id !== c.id);
  rec.cases.push(c);
  await saveEvalRecord(uid, rec);
  return rec;
}

export async function appendEvalRun(uid: string, skillId: string, run: EvalRecordRun): Promise<EvalRecord> {
  const rec = await readEvalRecord(uid, skillId);
  rec.runs.unshift(run);
  await saveEvalRecord(uid, rec);
  return rec;
}

interface RunEvalInput {
  cases: EvalRecordCase[];
  outputs: Record<number, string>;   // caseId → treatment output
  baselineOutputs?: Record<number, string>;
  baselineExecutionId?: string; treatmentExecutionId?: string; contrastId?: string; receiptId?: string;
  agentId?: string;
}
export type EvalStreamEvent =
  | { type: 'verdict'; caseId: number; assertionId: number; passed: boolean; evidence: string }
  | { type: 'done'; runId: string; passRate: number; degraded: boolean; regression: boolean };

/**
 * 逐断言流式评估：喂输出进引擎 SkillCreator，走 gradeEvalWithLlmAsync（LLM 真裁判，
 * 空/失败降级为规则版并标 degraded），逐条 yield verdict，最终落盘一个 run 并 yield done。
 */
export async function* runEvalStream(
  uid: string, skillId: string, input: RunEvalInput,
): AsyncGenerator<EvalStreamEvent> {
  const engine = await loadEngine();
  const Ctor = engine.SkillCreator as new () => {
    addEvalResult?: (skillId: string, r: unknown) => void;
    gradeEvalWithLlmAsync: (skillId: string, assertions: string[], llm?: unknown) => Promise<Map<number, { expectations: Array<{ text: string; passed: boolean; evidence: string }>; summary: { pass_rate: number } }>>;
  };
  const treatmentSc = new Ctor();
  const baselineSc = new Ctor();
  const llm = buildLlmComplete({ userId: uid, agentId: input.agentId ?? '' });

  const allAssertions = [...new Set(input.cases.flatMap(c => c.assertions))];
  input.cases.forEach((c) => {
    treatmentSc.addEvalResult?.(skillId, { eval_id: c.id, with_skill_output: input.outputs[c.id] ?? '' });
    baselineSc.addEvalResult?.(skillId, { eval_id: c.id, with_skill_output: input.baselineOutputs?.[c.id] ?? '' });
  });

  const [grades, baselineGrades] = await Promise.all([
    treatmentSc.gradeEvalWithLlmAsync(skillId, allAssertions, llm),
    baselineSc.gradeEvalWithLlmAsync(skillId, allAssertions, llm),
  ]);

  const runResults: EvalRecordRun['results'] = [];
  let degraded = false;
  for (const c of input.cases) {
    const g = grades.get(c.id);
    if (!g) continue;
    for (let idx = 0; idx < g.expectations.length; idx++) {
      const e = g.expectations[idx];
      const baseline = baselineGrades.get(c.id)?.expectations[idx];
      if (e.evidence.includes('[规则降级]') || baseline?.evidence.includes('[规则降级]')) degraded = true;
      runResults.push({ caseId: c.id, assertionId: idx, withPass: e.passed, withoutPass: !!baseline?.passed, verdict: e.passed ? 'pass' : 'fail', evidence: e.evidence });
      yield { type: 'verdict', caseId: c.id, assertionId: idx, passed: e.passed, evidence: e.evidence };
    }
  }
  const passCount = runResults.filter(r => r.verdict === 'pass').length;
  const passRate = runResults.length > 0 ? passCount / runResults.length : 0;
  const regression = runResults.some((result) => result.withoutPass && !result.withPass);
  const runId = `evalrun-${Date.now().toString(36)}`;
  await appendEvalRun(uid, skillId, {
    runId, at: new Date().toISOString(), degraded, results: runResults, passRate, regression,
    ...(input.baselineExecutionId ? { baselineExecutionId: input.baselineExecutionId } : {}),
    ...(input.treatmentExecutionId ? { treatmentExecutionId: input.treatmentExecutionId } : {}),
    ...(input.contrastId ? { contrastId: input.contrastId } : {}),
    ...(input.receiptId ? { receiptId: input.receiptId } : {}),
  });
  yield { type: 'done', runId, passRate, degraded, regression };
}
