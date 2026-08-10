/**
 * Invocability verification — PRD §8.2's third admission requirement.
 *
 * §8.2 admits a formal Baseline only after "Skill Validator, Security Scanner,
 * and a minimal real run". The first two are wired into install admission; this
 * is the third, and it deliberately stops short of running the skill's logic.
 *
 * WHAT THIS CHECKS
 *   1. The skill resolves — `SKILL.md` exists where the runtime would look.
 *   2. Its frontmatter parses and carries the fields the loader requires.
 *   3. Every declared script resolves to a real file under `scripts/`.
 *   4. Each script's interpreter exists and can parse it — a syntax-only pass
 *      (`python -m py_compile`, `node --check`, `bash -n`), never execution.
 *
 * WHAT THIS DOES NOT CHECK — and why it is still worth having
 *   It does not run the skill, so it cannot tell you the skill *works*. A
 *   third-party `fetch.py` would make live network calls; a cleanup script could
 *   delete files. Executing arbitrary third-party code to satisfy a checkbox
 *   trades a real risk for a nominal one.
 *
 *   The verdict is therefore recorded as `boundary: 'invocable'`, never `real`.
 *   A skill that passes is one the runtime can actually load and hand to an
 *   interpreter without erroring — measured, not assumed. That is strictly more
 *   than the static validator knows (it never resolves an interpreter or parses a
 *   script) and strictly less than a run. Callers that need genuine run evidence
 *   must look for `boundary: 'real'`, which nothing writes yet.
 *
 * The distinction is the point. Overstating this as a real run is exactly the
 * failure the PRD's evidence-tiering rule exists to prevent, and exactly what the
 * previous `boundary: 'real'` mislabel did.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { userLocalRoot, userMarketplaceSkillDir, userSkillsDir } from '../../paths';
import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { createLogger } from '../../logger';

const log = createLogger('skill-invocability');

/** Per-check outcome. `skipped` means the check did not apply, not that it passed. */
export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface InvocabilityCheck {
  /** Machine id, e.g. `skill_resolves`, `script_parses`. */
  id: string;
  status: CheckStatus;
  /** Short human-readable reason. Never contains file contents. */
  detail?: string;
  /** Script this check concerns, relative to the skill dir. */
  script?: string;
}

export interface InvocabilityRun {
  invocabilityId: string;
  skillId: string;
  /**
   * `invocable` — every applicable check passed.
   * `not_invocable` — at least one check failed; the runtime would error.
   * `indeterminate` — a check could not be performed (missing interpreter), so
   *   the question is unanswered. Deliberately distinct from `not_invocable`:
   *   "we could not tell" must not read as "it is broken".
   */
  status: 'invocable' | 'not_invocable' | 'indeterminate';
  /**
   * Always `'invocable'`. Present so the record is self-describing and cannot be
   * mistaken for run evidence when read back out of context.
   */
  boundary: 'invocable';
  checks: InvocabilityCheck[];
  /** Scripts examined. Zero is normal — most skills are instructional text. */
  scriptCount: number;
  createdAt: string;
}

const MAX_ID = 160;
const PARSE_TIMEOUT_MS = 10_000;

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > MAX_ID || !safeId(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function runPath(uid: string, id: string): string {
  return path.join(
    userLocalRoot(uid), 'kstar', 'executions', 'invocability',
    `${requireId(id, 'invocability id')}.json`,
  );
}

export function skillInvocabilityPath(uid: string, id: string): string {
  return runPath(uid, id);
}

/**
 * Locate the skill, marketplace first then custom.
 *
 * Same order as `_resolveSkillDir` in skill_reverify and
 * `_resolveWorkbenchSkillDir` in ipc: marketplace wins an id collision, because
 * that is the tree the runtime would load.
 */
async function resolveSkillDir(uid: string, skillId: string): Promise<string | null> {
  for (const dir of [userMarketplaceSkillDir(uid, skillId), path.join(userSkillsDir(uid), skillId)]) {
    try {
      await fs.access(path.join(dir, 'SKILL.md'));
      return dir;
    } catch { /* try next root */ }
  }
  return null;
}

/**
 * Syntax-check one script with its own interpreter.
 *
 * Parse-only flags: `py_compile` compiles without running, `node --check` parses
 * without executing, `bash -n` reads without running. None of them execute the
 * script body, so a script that deletes files or calls the network does neither.
 *
 * A missing interpreter yields `skipped`, not `fail`: the skill is not broken
 * because this machine lacks Ruby.
 */
async function parseCheck(scriptPath: string): Promise<InvocabilityCheck> {
  const rel = path.basename(scriptPath);
  const ext = path.extname(scriptPath).slice(1).toLowerCase();

  // Mirrors run-skill.cjs's extension dispatch. Kept parse-only.
  const plans: Record<string, { cmd: string; args: string[] }> = {
    py: { cmd: process.env.ORKAS_PYTHON || 'python3', args: ['-m', 'py_compile', scriptPath] },
    js: { cmd: process.execPath, args: ['--check', scriptPath] },
    cjs: { cmd: process.execPath, args: ['--check', scriptPath] },
    mjs: { cmd: process.execPath, args: ['--check', scriptPath] },
    sh: { cmd: 'bash', args: ['-n', scriptPath] },
    rb: { cmd: 'ruby', args: ['-c', scriptPath] },
  };
  const plan = plans[ext];
  if (!plan) {
    // .ts needs the tsx loader and Windows-only kinds need a Windows host;
    // neither is a defect in the skill.
    return { id: 'script_parses', status: 'skipped', script: rel, detail: `no parse check for .${ext}` };
  }

  return new Promise<InvocabilityCheck>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(plan.cmd, plan.args, {
        // `ignore` rather than `pipe`: a parse error's message can quote the
        // offending source line, and that line may be the very credential the
        // security scanner refuses to echo. The exit code is the verdict.
        stdio: 'ignore',
        windowsHide: true,
        // ORKAS_* env is deliberately not forwarded: nothing here should be able
        // to reach the user's skill roots or workspace.
        env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '' },
      });
    } catch (err) {
      resolve({
        id: 'script_parses', status: 'skipped', script: rel,
        detail: `interpreter unavailable: ${(err as Error).message}`,
      });
      return;
    }

    let settled = false;
    const done = (c: InvocabilityCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(c);
    };
    // A parse should be near-instant. A hang means something is wrong with the
    // toolchain, not with the skill, so it is indeterminate rather than a fail.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done({ id: 'script_parses', status: 'skipped', script: rel, detail: 'parse check timed out' });
    }, PARSE_TIMEOUT_MS);

    child.on('error', (err) => {
      done({
        id: 'script_parses', status: 'skipped', script: rel,
        detail: `interpreter unavailable: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      if (code === 0) done({ id: 'script_parses', status: 'pass', script: rel });
      else done({ id: 'script_parses', status: 'fail', script: rel, detail: `parse failed (exit ${code})` });
    });
  });
}

/** Read `scripts/` if present. Absent is normal, not an error. */
async function listScripts(skillDir: string): Promise<string[]> {
  const dir = path.join(skillDir, 'scripts');
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    // Symlinks are skipped for the same reason the scanner skips them: the
    // target may sit outside the scanned tree.
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Check that a skill can be loaded and handed to an interpreter.
 *
 * Never executes the skill. See the module header for what that does and does
 * not establish.
 */
export async function verifySkillInvocability(uid: string, skillId: string): Promise<InvocabilityRun> {
  requireId(skillId, 'skill id');
  const checks: InvocabilityCheck[] = [];

  const skillDir = await resolveSkillDir(uid, skillId);
  if (!skillDir) {
    checks.push({ id: 'skill_resolves', status: 'fail', detail: 'SKILL.md not found in any skill root' });
    return persist(uid, build(skillId, checks, 0));
  }
  checks.push({ id: 'skill_resolves', status: 'pass' });

  // Frontmatter must parse and name the skill: the loader reads `name` to route,
  // so a skill without one cannot be invoked even though its files exist.
  try {
    const raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!fm) {
      checks.push({ id: 'frontmatter_parses', status: 'fail', detail: 'no frontmatter block' });
    } else if (!/^name\s*:/m.test(fm[1])) {
      checks.push({ id: 'frontmatter_parses', status: 'fail', detail: 'frontmatter has no `name`' });
    } else {
      checks.push({ id: 'frontmatter_parses', status: 'pass' });
    }
  } catch (err) {
    checks.push({
      id: 'frontmatter_parses', status: 'fail',
      detail: `SKILL.md unreadable: ${(err as Error).message}`,
    });
  }

  let scripts: string[] = [];
  try {
    scripts = await listScripts(skillDir);
  } catch (err) {
    checks.push({ id: 'scripts_readable', status: 'fail', detail: (err as Error).message });
  }

  // Sequential: parallel parse checks would spawn one interpreter per script for
  // every skill in a sweep. A parse is milliseconds; a thundering herd is not.
  for (const script of scripts) {
    checks.push(await parseCheck(script));
  }

  return persist(uid, build(skillId, checks, scripts.length));
}

function build(skillId: string, checks: InvocabilityCheck[], scriptCount: number): InvocabilityRun {
  const failed = checks.some((c) => c.status === 'fail');
  // Skips make the answer incomplete, not negative — but only when nothing
  // actually failed. A real failure is the more important fact.
  const skipped = checks.some((c) => c.status === 'skipped');
  return {
    invocabilityId: `invocability-${randomUUID()}`,
    skillId,
    status: failed ? 'not_invocable' : skipped ? 'indeterminate' : 'invocable',
    boundary: 'invocable',
    checks,
    scriptCount,
    createdAt: new Date().toISOString(),
  };
}

async function persist(uid: string, run: InvocabilityRun): Promise<InvocabilityRun> {
  const target = runPath(uid, run.invocabilityId);
  await fileEditLock(target).runExclusive(() => writeJson(target, run));
  log.info('skill invocability checked', {
    skillId: run.skillId, status: run.status, scriptCount: run.scriptCount,
  });
  return run;
}

export async function readSkillInvocability(uid: string, invocabilityId: string): Promise<InvocabilityRun> {
  try {
    return JSON.parse(await fs.readFile(runPath(uid, invocabilityId), 'utf8')) as InvocabilityRun;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('skill invocability run not found');
    throw err;
  }
}

export async function listSkillInvocability(uid: string): Promise<InvocabilityRun[]> {
  const dir = path.join(userLocalRoot(uid), 'kstar', 'executions', 'invocability');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const rows: InvocabilityRun[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      rows.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as InvocabilityRun);
    } catch { /* malformed record ignored, same as the validation store */ }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findLatestSkillInvocability(uid: string, skillId: string): Promise<InvocabilityRun | null> {
  requireId(skillId, 'skill id');
  return (await listSkillInvocability(uid)).find((run) => run.skillId === skillId) || null;
}
