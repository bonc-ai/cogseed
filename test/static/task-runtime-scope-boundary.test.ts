/**
 * Static scope-boundary test: task runtime modules stay inside their lane.
 *
 * The workspace x KStar x Wake x Cognition task runtime chain is built by
 * composing existing fact stores (Space, Project, KStar store, Wake state,
 * OrchestrationLedger, ExecutionRecord). It must never reach into Recall,
 * KStar candidate generation, ability-asset governance, or personal-ontology
 * candidate storage, and it must not introduce candidate/asset governance
 * filenames of its own.
 *
 * Baseline: PASS with no runtime files present; the guard stays active while
 * the plan adds files task by task (Task 16 re-runs the same boundary).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const srcDir = path.join(root, 'src/main/features');

/** Source paths introduced by the task-runtime plan (files or directories). */
const runtimePaths = [
  'workspace_runtime',
  'kstar/runtime-lifecycle.ts',
  'kstar/runtime-review.ts',
  'kstar/runtime-history.ts',
  'kstar/runtime-recovery.ts',
  'kstar/execution-provenance.ts',
  'p3394/task-authorization.ts',
  'cognition/runtime-query.ts',
];

const forbiddenImports = [
  '/recall/',
  'candidate-service',
  'asset-service',
  'ability-assets',
  'personal_ontology_candidates',
];

const forbiddenFileTokens = ['candidate', 'ability-asset', 'asset-version'];

function resolveRuntimeFiles(rel: string): string[] {
  const abs = path.join(srcDir, rel);
  if (!fs.existsSync(abs)) return [];
  if (rel.endsWith('.ts')) return [abs];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(abs);
  return out;
}

describe('task runtime scope boundary', () => {
  it('blocks forbidden imports in task runtime modules', () => {
    const offenders: string[] = [];
    for (const rel of runtimePaths) {
      for (const file of resolveRuntimeFiles(rel)) {
        const content = fs.readFileSync(file, 'utf8');
        for (const token of forbiddenImports) {
          if (content.includes(token)) {
            offenders.push(`${path.relative(root, file)} imports ${token}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('forbids candidate / asset-governance filenames in task runtime modules', () => {
    const offenders: string[] = [];
    for (const rel of runtimePaths) {
      for (const file of resolveRuntimeFiles(rel)) {
        const base = path.basename(file).toLowerCase();
        if (forbiddenFileTokens.some((token) => base.includes(token))) {
          offenders.push(path.relative(root, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
