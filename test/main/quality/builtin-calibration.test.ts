/**
 * Calibration guard for the builtin skill corpus.
 *
 * Every rule added to the validator is a potential hard block on content we
 * ship. This test is the gate that made the port safe: it scans all builtin
 * skills and fails if any of them would be blocked.
 *
 * It exists because that failure already happened once. Before the context
 * layer, `no_eval_with_override_input` matched `ut.exec(t)` inside the minified
 * GSAP bundle in `stage-compose`, so a skill in our own release was one EXTREME
 * away from being uninstallable.
 *
 * Run this whenever rules change. A rule that cannot pass here is not ready:
 * a gate that fires on legitimate content gets clicked through, and then it
 * protects nothing.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateSkillDir } from '../../../src/main/quality';

const CORPUS_ROOT = 'resources/builtin';

/** Directories containing a SKILL.md, i.e. one scannable skill each. */
function findSkillDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      out.push(dir);
      return;   // do not descend into a skill's own subtree
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules') walk(path.join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

describe('quality › builtin corpus calibration', () => {
  const dirs = findSkillDirs(CORPUS_ROOT);

  it('finds the corpus (guards against a silently empty scan)', () => {
    // Without this, a bad path would make every assertion below vacuous.
    expect(dirs.length).toBeGreaterThan(20);
  });

  it('blocks no builtin skill', () => {
    const blocked: Array<{ dir: string; rules: string[] }> = [];
    for (const dir of dirs) {
      // `enforceSkillRunner: false` matches the install-time call: published
      // bytes are restored verbatim and runner compatibility is an authoring
      // concern.
      const report = validateSkillDir(dir, { enforceSkillRunner: false });
      if (!report.ok) {
        blocked.push({
          dir,
          rules: report.violations.filter((v) => v.level === 'EXTREME').map((v) => v.rule),
        });
      }
    }
    expect(blocked).toEqual([]);
  });

  it('produces no EXTREME finding anywhere in the corpus', () => {
    const hits: string[] = [];
    for (const dir of dirs) {
      for (const v of validateSkillDir(dir, { enforceSkillRunner: false }).violations) {
        if (v.level === 'EXTREME') hits.push(`${path.basename(dir)} ${v.rule} ${v.field}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('reports demotions with their original level intact', () => {
    // Demotion has to stay visible: a downgraded finding an auditor cannot see
    // is a false negative wearing a false positive's clothes.
    let demoted = 0;
    for (const dir of dirs) {
      for (const v of validateSkillDir(dir, { enforceSkillRunner: false }).violations) {
        if (v.original_level) {
          demoted++;
          expect(v.context).toBeDefined();
          expect(v.context).not.toBe('source');
        }
      }
    }
    // Informational: the GSAP bundle is the known case that must be demoted
    // rather than dropped, so this should not fall to zero silently.
    expect(demoted).toBeGreaterThan(0);
  });
});
