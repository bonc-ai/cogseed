import * as fs from 'node:fs/promises';
import { evalsDir, evalRecordPath } from './paths';
import { loadEngine } from './engine-loader';
import { buildLlmComplete } from './llm-bridge';

export interface EvalRecordCase { id: number; input: string; assertions: string[]; }
export interface EvalRecordRun {
  runId: string; at: string; model?: string; degraded: boolean;
  results: Array<{ caseId: number; assertionId: number; withPass: boolean; withoutPass: boolean; verdict: 'pass' | 'fail'; evidence: string }>;
  passRate: number; regression: boolean;
}
export interface EvalRecord { skillId: string; cases: EvalRecordCase[]; runs: EvalRecordRun[]; }

export async function readEvalRecord(uid: string, skillId: string): Promise<EvalRecord> {
  try {
    const raw = await fs.readFile(evalRecordPath(uid, skillId), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EvalRecord>;
    return { skillId, cases: parsed.cases ?? [], runs: parsed.runs ?? [] };
  } catch {
    return { skillId, cases: [], runs: [] };
  }
}

export async function saveEvalRecord(uid: string, rec: EvalRecord): Promise<void> {
  await fs.mkdir(evalsDir(uid), { recursive: true });
  await fs.writeFile(evalRecordPath(uid, rec.skillId), JSON.stringify(rec, null, 2), 'utf-8');
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
  outputs: Record<number, string>;   // caseId → with_skill_output
  agentId?: string;
}
export type EvalStreamEvent =
  | { type: 'verdict'; caseId: number; assertionId: number; passed: boolean; evidence: string }
  | { type: 'done'; runId: string; passRate: number; degraded: boolean };

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
  const sc = new Ctor();
  const llm = buildLlmComplete({ userId: uid, agentId: input.agentId ?? '' });

  const allAssertions = [...new Set(input.cases.flatMap(c => c.assertions))];
  input.cases.forEach((c) => sc.addEvalResult?.(skillId, { eval_id: c.id, with_skill_output: input.outputs[c.id] ?? '' }));

  const grades = await sc.gradeEvalWithLlmAsync(skillId, allAssertions, llm);

  const runResults: EvalRecordRun['results'] = [];
  let degraded = false;
  for (const c of input.cases) {
    const g = grades.get(c.id);
    if (!g) continue;
    for (let idx = 0; idx < g.expectations.length; idx++) {
      const e = g.expectations[idx];
      if (e.evidence.includes('[规则降级]')) degraded = true;
      runResults.push({ caseId: c.id, assertionId: idx, withPass: e.passed, withoutPass: false, verdict: e.passed ? 'pass' : 'fail', evidence: e.evidence });
      yield { type: 'verdict', caseId: c.id, assertionId: idx, passed: e.passed, evidence: e.evidence };
    }
  }
  const passCount = runResults.filter(r => r.verdict === 'pass').length;
  const passRate = runResults.length > 0 ? passCount / runResults.length : 0;
  const runId = `evalrun-${Date.now().toString(36)}`;
  await appendEvalRun(uid, skillId, { runId, at: new Date().toISOString(), degraded, results: runResults, passRate, regression: false });
  yield { type: 'done', runId, passRate, degraded };
}
