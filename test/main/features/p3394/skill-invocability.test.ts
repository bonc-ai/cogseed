/**
 * Invocability verification — PRD §8.2's third admission requirement.
 *
 * The load-bearing test here is the one asserting a side-effecting script is NOT
 * executed. That is the whole design constraint: this check exists so a Baseline
 * candidate has evidence beyond a static read, and the moment it starts executing
 * third-party code to get that evidence it becomes a worse risk than the gap it
 * closes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let TMP = '';

vi.mock('../../../../src/main/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/paths')>();
  return {
    ...actual,
    userLocalRoot: (uid: string) => path.join(TMP, uid, 'local'),
    userMarketplaceSkillDir: (uid: string, id: string) =>
      path.join(TMP, uid, 'local', 'marketplace', 'skills', id),
    userSkillsDir: (uid: string) => path.join(TMP, uid, 'cloud', 'skills'),
  };
});

const {
  verifySkillInvocability, readSkillInvocability, findLatestSkillInvocability,
} = await import('../../../../src/main/features/p3394/skill-invocability');
const { userMarketplaceSkillDir, userSkillsDir } = await import('../../../../src/main/paths');

const UID = 'u-inv';

function write(dir: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}
const mkSkill = (id: string, files: Record<string, string>) =>
  write(userMarketplaceSkillDir(UID, id), files);
const mkCustom = (id: string, files: Record<string, string>) =>
  write(path.join(userSkillsDir(UID), id), files);

const OK_MD = '---\nname: demo\ndescription: A demo skill.\n---\n\nBody.\n';

beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'invoc-')); });
afterEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('skill invocability › PRD §8.2 third admission check', () => {
  // THE constraint. A skill's scripts are third-party code; running them to
  // produce admission evidence would mean a `fetch.py` makes live network calls
  // and a cleanup script deletes files, purely to satisfy a checkbox.
  it('parse-checks a script without executing it', async () => {
    const sentinel = path.join(TMP, 'MUST_NOT_EXIST');
    mkSkill('side-effect', {
      'SKILL.md': OK_MD,
      // Syntactically valid, so the parse check passes — the only reason the
      // sentinel would appear is actual execution.
      'scripts/go.py': `open(${JSON.stringify(sentinel)}, "w").write("ran")\nprint("ran")\n`,
    });

    const run = await verifySkillInvocability(UID, 'side-effect');

    expect(run.status).toBe('invocable');
    expect(fs.existsSync(sentinel)).toBe(false);
  }, 60_000);

  // The record must be self-describing: read back out of context it still says
  // `invocable`, so it cannot be mistaken for the `real` run evidence that
  // nothing in the codebase produces yet.
  it('never claims a real boundary', async () => {
    mkSkill('plain', { 'SKILL.md': OK_MD });

    const run = await verifySkillInvocability(UID, 'plain');

    expect(run.boundary).toBe('invocable');
    expect(await readSkillInvocability(UID, run.invocabilityId)).toEqual(run);
  }, 60_000);

  // Most skills are instructional text with no `scripts/` dir at all. That is
  // normal and must read as invocable, not as an incomplete check.
  it('treats a script-free skill as invocable', async () => {
    mkSkill('text-only', { 'SKILL.md': OK_MD });

    const run = await verifySkillInvocability(UID, 'text-only');

    expect(run).toMatchObject({ status: 'invocable', scriptCount: 0 });
  }, 60_000);

  it('fails a skill whose script cannot be parsed', async () => {
    mkSkill('broken', { 'SKILL.md': OK_MD, 'scripts/bad.py': 'def f(\n' });

    const run = await verifySkillInvocability(UID, 'broken');

    expect(run.status).toBe('not_invocable');
    expect(run.checks.some((c) => c.id === 'script_parses' && c.status === 'fail')).toBe(true);
  }, 60_000);

  // A parse failure's message can quote the offending source line, and that line
  // may be the credential the security scanner refuses to echo.
  it('does not leak script contents into the failure detail', async () => {
    mkSkill('secret', {
      'SKILL.md': OK_MD,
      'scripts/bad.py': 'TOKEN = "ghp_ATTACKERSECRETVALUE"\ndef f(\n',
    });

    const run = await verifySkillInvocability(UID, 'secret');

    expect(run.status).toBe('not_invocable');
    expect(JSON.stringify(run)).not.toContain('ATTACKERSECRETVALUE');
  }, 60_000);

  // The loader routes on frontmatter `name`; without one the skill cannot be
  // invoked even though every file is present.
  it('fails a skill with no frontmatter name', async () => {
    mkSkill('nameless', { 'SKILL.md': '---\ndescription: no name here\n---\n\nBody.\n' });

    const run = await verifySkillInvocability(UID, 'nameless');

    expect(run.status).toBe('not_invocable');
    expect(run.checks.some((c) => c.id === 'frontmatter_parses' && c.status === 'fail')).toBe(true);
  }, 60_000);

  it('fails when the skill resolves in no skill root', async () => {
    const run = await verifySkillInvocability(UID, 'ghost');

    expect(run.status).toBe('not_invocable');
    expect(run.checks[0]).toMatchObject({ id: 'skill_resolves', status: 'fail' });
  }, 60_000);

  // Custom skills are covered too: that tree is the write target of
  // `skills.writeFile` and of the self-evolution patch path.
  it('resolves a custom skill, not only marketplace installs', async () => {
    mkCustom('mine', { 'SKILL.md': OK_MD, 'scripts/ok.py': 'print("hi")\n' });

    const run = await verifySkillInvocability(UID, 'mine');

    expect(run).toMatchObject({ status: 'invocable', scriptCount: 1 });
  }, 60_000);

  // An uncheckable script is not a broken one: "we could not tell" and "it is
  // broken" are different claims, and conflating them would either block working
  // skills or hide real breakage.
  it('reports indeterminate rather than failing when a check cannot run', async () => {
    mkSkill('exotic', { 'SKILL.md': OK_MD, 'scripts/thing.ts': 'export const a: number = 1;\n' });

    const run = await verifySkillInvocability(UID, 'exotic');

    expect(run.status).toBe('indeterminate');
    expect(run.checks.some((c) => c.status === 'skipped')).toBe(true);
    expect(run.checks.some((c) => c.status === 'fail')).toBe(false);
  }, 60_000);

  it('returns the most recent record for a skill', async () => {
    mkSkill('twice', { 'SKILL.md': OK_MD });

    await verifySkillInvocability(UID, 'twice');
    const second = await verifySkillInvocability(UID, 'twice');

    expect((await findLatestSkillInvocability(UID, 'twice'))?.invocabilityId)
      .toBe(second.invocabilityId);
  }, 60_000);
});
