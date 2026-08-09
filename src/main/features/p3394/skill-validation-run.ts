import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { userLocalRoot } from '../../paths';
import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { isPathAllowed } from '../../util/path-sandbox';
import { validateSkillDir, validateSkillFile, type ValidationReport } from '../../quality';

export type ValidationStatus = 'pass' | 'risk' | 'blocked' | 'degraded';
export type ValidationTarget = 'working-tree' | 'installed-skill' | 'patch-candidate';
/**
 * How the verdict was obtained.
 *
 * `static` means the validator read the skill's files without executing it —
 * which is what every path in this module actually does. `real` is reserved for
 * evidence produced by genuinely running the skill; nothing writes it yet, and it
 * must not be claimed until something does.
 *
 * The distinction exists because PRD §8.2 admits a formal Baseline only after
 * "Skill Validator, Security Scanner, and a minimal real run", and callers here
 * previously passed `boundary: 'real'` for a static check — a record that reads
 * as run evidence while no run happened. `degraded` still means the validator
 * itself was unavailable, and `test-double` a stand-in.
 */
export type ValidationBoundary = 'static' | 'real' | 'degraded' | 'test-double';
export interface SkillValidationRun {
  validationId: string;
  skillId: string;
  target: ValidationTarget;
  status: ValidationStatus;
  validatorVersion: string;
  violations: Array<{ level: string; rule: string; path?: string; message: string }>;
  scannedFiles: number;
  boundary: ValidationBoundary;
  createdAt: string;
}

const MAX_ID = 160;
function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > MAX_ID || !safeId(value)) throw new Error(`invalid ${field}`);
  return value;
}
function validationPath(uid: string, id: string): string {
  return path.join(userLocalRoot(uid), 'kstar', 'executions', 'validations', `${requireId(id, 'validation id')}.json`);
}
export function skillValidationPath(uid: string, id: string): string { return validationPath(uid, id); }

export function normalizeValidationReport(
  skillId: string,
  target: ValidationTarget,
  report: ValidationReport,
  scannedFiles: number,
  boundary: ValidationBoundary,
  validationId = `validation-${randomUUID()}`,
): SkillValidationRun {
  requireId(skillId, 'skill id');
  const hasExtreme = report.violations.some((v) => v.level === 'EXTREME');
  const status: ValidationStatus = hasExtreme ? 'blocked' : (report.violations.length ? 'risk' : 'pass');
  return {
    validationId: requireId(validationId, 'validation id'), skillId, target, status,
    validatorVersion: report.validator_version || 'unknown',
    violations: report.violations.slice(0, 500).map((v) => ({
      level: v.level, rule: v.rule,
      ...(v.field ? { path: v.field } : {}),
      message: v.suggested_fix || v.rule,
    })),
    scannedFiles: Math.max(0, Math.floor(scannedFiles)), boundary, createdAt: new Date().toISOString(),
  };
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const walk = async (root: string): Promise<void> => {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path.join(root, entry.name));
      else if (entry.isFile()) count += 1;
    }
  };
  await walk(dir);
  return count;
}

async function persist(uid: string, run: SkillValidationRun): Promise<SkillValidationRun> {
  const target = validationPath(uid, run.validationId);
  await fileEditLock(target).runExclusive(() => writeJson(target, run));
  return run;
}

export async function runSkillValidation(uid: string, input: {
  skillId: string; target: ValidationTarget; skillDir: string; allowedRoots: string[]; boundary: ValidationBoundary;
  validateFn?: typeof validateSkillDir;
}): Promise<SkillValidationRun> {
  requireId(input.skillId, 'skill id');
  if (!isPathAllowed(input.skillDir, input.allowedRoots)) throw new Error('skill directory is outside allowed roots');
  // Refuse to record a run-evidence claim this function cannot substantiate: it
  // calls the static validator and never executes the skill. Rejecting is better
  // than silently downgrading, because a caller asking for `real` believes it is
  // getting run evidence and would carry that belief into an admission decision.
  // Delete this guard only together with an implementation that actually runs the
  // skill and derives the verdict from that run.
  if (input.boundary === 'real') {
    throw new Error('runSkillValidation performs a static scan and cannot produce `real` run evidence');
  }
  try {
    const [report, scannedFiles] = await Promise.all([
      Promise.resolve((input.validateFn || validateSkillDir)(input.skillDir)),
      countFiles(input.skillDir),
    ]);
    return persist(uid, normalizeValidationReport(input.skillId, input.target, report, scannedFiles, input.boundary));
  } catch {
    return persist(uid, {
      validationId: `validation-${randomUUID()}`, skillId: input.skillId, target: input.target,
      status: 'degraded', validatorVersion: 'unavailable',
      violations: [{ level: 'EXTREME', rule: 'scanner_unavailable', message: 'Validator or target content is unavailable.' }],
      scannedFiles: 0, boundary: 'degraded', createdAt: new Date().toISOString(),
    });
  }
}

export async function validatePatchCandidateContent(
  uid: string, skillId: string, content: string, boundary: ValidationBoundary = 'static',
): Promise<SkillValidationRun> {
  const report = validateSkillFile({ relpath: 'SKILL.md', content });
  return persist(uid, normalizeValidationReport(skillId, 'patch-candidate', report, 1, boundary));
}

export async function readSkillValidation(uid: string, validationId: string): Promise<SkillValidationRun> {
  try { return JSON.parse(await fs.readFile(validationPath(uid, validationId), 'utf8')) as SkillValidationRun; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('skill validation not found'); throw err; }
}

export async function listSkillValidations(uid: string): Promise<SkillValidationRun[]> {
  const dir = path.join(userLocalRoot(uid), 'kstar', 'executions', 'validations');
  let names: string[];
  try { names = await fs.readdir(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
  const rows: SkillValidationRun[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try { rows.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as SkillValidationRun); } catch { /* malformed ignored */ }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findLatestSkillValidation(uid: string, skillId: string): Promise<SkillValidationRun | null> {
  requireId(skillId, 'skill id');
  return (await listSkillValidations(uid)).find((run) => run.skillId === skillId) || null;
}
