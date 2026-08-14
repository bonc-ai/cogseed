import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

let uid = '';
beforeEach(() => { uid = `validation-${randomUUID()}`; });
afterEach(async () => {
  const { userRoot } = await import('../../../../src/main/paths');
  await fs.rm(userRoot(uid), { recursive: true, force: true });
});

const report = (violations: any[]) => ({ ok: !violations.some(v => v.level === 'EXTREME'), violations, validated_at: '2026-07-31T00:00:00.000Z', validator_version: '0.3.0' });

describe('P3394 skill validation run', () => {
  it('normalizes pass, risk, and blocked reports without persisting snippets', async () => {
    const mod = await import('../../../../src/main/features/p3394/skill-validation-run');
    expect(mod.normalizeValidationReport('sk1', 'working-tree', report([]), 1, 'real').status).toBe('pass');
    const risk = mod.normalizeValidationReport('sk1', 'working-tree', report([
      { level: 'MEDIUM', rule: 'advisory', field: 'SKILL.md', snippet: 'private snippet', suggested_fix: 'add description' },
    ]), 2, 'real');
    expect(risk.status).toBe('risk');
    expect(JSON.stringify(risk)).not.toContain('private snippet');
    const blocked = mod.normalizeValidationReport('sk1', 'patch-candidate', report([
      { level: 'EXTREME', rule: 'bad', field: 'scripts/x.sh:1', snippet: 'secret', suggested_fix: 'remove it' },
    ]), 3, 'real');
    expect(blocked.status).toBe('blocked');
    expect(blocked.violations[0]).toEqual({ level: 'EXTREME', rule: 'bad', path: 'scripts/x.sh:1', message: 'remove it' });
  });

  it('runs the real quality validator, persists provenance, and reads the latest result', async () => {
    const mod = await import('../../../../src/main/features/p3394/skill-validation-run');
    const skillDir = path.join((await import('../../../../src/main/paths')).userLocalRoot(uid), 'candidate-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: clean-skill\ndescription: clean\n---\nSafe body.\n');

    const run = await mod.runSkillValidation(uid, {
      skillId: 'clean-skill', target: 'working-tree', skillDir, allowedRoots: [skillDir], boundary: 'static',
    });
    expect(run).toMatchObject({ skillId: 'clean-skill', status: 'risk', scannedFiles: 1, boundary: 'static' });
    expect(await mod.readSkillValidation(uid, run.validationId)).toEqual(run);
    expect((await mod.findLatestSkillValidation(uid, 'clean-skill'))?.validationId).toBe(run.validationId);
  });

  // PRD §8.2 admits a formal Baseline only after "Skill Validator, Security
  // Scanner, and a minimal real run". This function is the first of those three:
  // it reads files and never executes the skill. Callers used to pass
  // `boundary: 'real'` anyway, producing records that read as run evidence for a
  // run that never happened — and `workbench/gate` is built to trust a `real`
  // boundary. Refusing beats silently downgrading: a caller asking for `real`
  // believes it holds run evidence and would carry that into an admission
  // decision. Remove this only alongside an implementation that truly runs it.
  it('refuses to label a static scan as real run evidence', async () => {
    const mod = await import('../../../../src/main/features/p3394/skill-validation-run');
    const skillDir = path.join((await import('../../../../src/main/paths')).userLocalRoot(uid), 'claims-real');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: claims-real\ndescription: d\n---\nBody.\n');

    await expect(mod.runSkillValidation(uid, {
      skillId: 'claims-real', target: 'working-tree', skillDir, allowedRoots: [skillDir], boundary: 'real',
    })).rejects.toThrow(/cannot produce `real` run evidence/);

    // And nothing was written: a rejected claim must not leave a record behind.
    expect(await mod.findLatestSkillValidation(uid, 'claims-real')).toBeNull();
  });

  it('marks an unavailable scanner as degraded instead of pretending pass', async () => {
    const mod = await import('../../../../src/main/features/p3394/skill-validation-run');
    const run = await mod.runSkillValidation(uid, {
      skillId: 'sk1', target: 'installed-skill', skillDir: '/missing/skill', allowedRoots: ['/missing'], boundary: 'static',
      validateFn: () => { throw new Error('scanner unavailable'); },
    });
    expect(run).toMatchObject({ status: 'degraded', boundary: 'degraded', scannedFiles: 0 });
    expect(run.violations[0].rule).toBe('scanner_unavailable');
  });
});
