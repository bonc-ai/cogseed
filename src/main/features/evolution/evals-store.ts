import * as fs from 'node:fs/promises';
import { evalsDir, evalRecordPath } from './paths';

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
