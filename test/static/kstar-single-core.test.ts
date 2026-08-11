/**
 * Static deletion-proof test: KSTAR has one semantic core
 *
 * Proves that the old PC-based KSTAR fact model has been deleted and no
 * production code computes delta_a/delta_r or route_recommendation locally.
 * All KSTAR semantic computation must go through the Engine package.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const p3394Dir = path.join(root, 'src/main/features/p3394');
const groupChatDir = path.join(root, 'src/main/features/group_chat');

function readProductionFiles(dir: string): Array<{ path: string; content: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({
      path: path.join(dir, name),
      content: fs.readFileSync(path.join(dir, name), 'utf8'),
    }));
}

describe('KSTAR has one semantic core', () => {
  it('does not retain the old PC fact model files', () => {
    const runtimePath = path.join(p3394Dir, 'kstar-runtime.ts');
    const enginePath = path.join(p3394Dir, 'kstar-engine.ts');

    expect(fs.existsSync(runtimePath), 'kstar-runtime.ts must be deleted').toBe(false);
    expect(fs.existsSync(enginePath), 'kstar-engine.ts must be deleted').toBe(false);
  });

  it('does not compute delta_a or delta_r in production code', () => {
    const p3394Files = readProductionFiles(p3394Dir);
    const busFiles = readProductionFiles(groupChatDir);
    const allFiles = [...p3394Files, ...busFiles];

    for (const file of allFiles) {
      // Allow test fixtures and type definitions, but no active computation
      const hasDeltaAssignment = /delta_[ar]\s*[:=]\s*[^;{]+/.test(file.content);
      if (hasDeltaAssignment) {
        // Allow delta_r in kstar-adapter as a pass-through field from Engine
        if (file.path.includes('kstar-adapter.ts') && /delta_r\?:/.test(file.content)) {
          continue;
        }
        // Allow in kstar-compat projection as Engine-to-legacy mapping
        if (file.path.includes('kstar-compat.ts')) {
          continue;
        }
        expect(
          hasDeltaAssignment,
          `${path.basename(file.path)} must not compute delta_a or delta_r locally`,
        ).toBe(false);
      }
    }
  });

  it('does not compute route_recommendation in production code', () => {
    const p3394Files = readProductionFiles(p3394Dir);
    const busFiles = readProductionFiles(groupChatDir);
    const allFiles = [...p3394Files, ...busFiles];

    for (const file of allFiles) {
      // Allow type definitions and reading the field, but no local computation
      const hasRouteComputation =
        /route_recommendation\s*[:=]\s*\{/.test(file.content) ||
        /route_recommendation\s*=\s*await/.test(file.content);

      if (hasRouteComputation) {
        // Allow in kstar-compat as projection from Engine
        if (file.path.includes('kstar-compat.ts')) {
          continue;
        }
        expect(
          hasRouteComputation,
          `${path.basename(file.path)} must not compute route_recommendation locally`,
        ).toBe(false);
      }
    }
  });

  it('does not reference userWorkSpace/meta-skill-engine-package in production', () => {
    const p3394Files = readProductionFiles(p3394Dir);
    const busFiles = readProductionFiles(groupChatDir);
    const allFiles = [...p3394Files, ...busFiles];

    for (const file of allFiles) {
      expect(
        file.content,
        `${path.basename(file.path)} must not reference userWorkSpace/meta-skill-engine-package`,
      ).not.toContain('userWorkSpace/meta-skill-engine-package');
    }
  });

  it('all KSTAR mutation calls go through adapter or Engine package', () => {
    const p3394Files = readProductionFiles(p3394Dir);
    const busFiles = readProductionFiles(groupChatDir);
    const allFiles = [...p3394Files, ...busFiles];

    // Approved mutation paths:
    // - kstar-adapter.ts (recordEvidence, runCasTransaction)
    // - kstar-bus-integration.ts (calls adapter)
    // - kstar-store.ts (writes snapshot, appends pending evidence)
    // - kstar-migration.ts (writes snapshot during migration)

    const approvedMutators = [
      'kstar-adapter.ts',
      'kstar-bus-integration.ts',
      'kstar-store.ts',
      'kstar-migration.ts',
      'kstar-recovery.ts',
      'kstar-legacy-data.ts',
    ];

    for (const file of allFiles) {
      const basename = path.basename(file.path);
      if (approvedMutators.includes(basename)) continue;

      // Check for direct state mutation patterns
      const hasDirectMutation =
        /state\.runs\.push/.test(file.content) ||
        /state\.experience_candidates\.push/.test(file.content);

      if (hasDirectMutation) {
        expect(
          hasDirectMutation,
          `${basename} must not mutate KSTAR state directly; use adapter`,
        ).toBe(false);
      }
    }
  });

  it('no production file imports resources/builtin for runtime logic', () => {
    const p3394Files = readProductionFiles(p3394Dir);
    const busFiles = readProductionFiles(groupChatDir);
    const allFiles = [...p3394Files, ...busFiles];

    for (const file of allFiles) {
      const hasBuiltinImport = /from ['"].*resources\/builtin/.test(file.content);
      expect(
        hasBuiltinImport,
        `${path.basename(file.path)} must not import resources/builtin for runtime logic`,
      ).toBe(false);
    }
  });

  it('does not expose legacy KStarRun production entrypoint names', () => {
    const files = [
      path.join(root, 'src/main/ipc/index.ts'),
      path.join(root, 'src/renderer/modules/ipc-shim.js'),
      ...readProductionFiles(p3394Dir).map((file) => file.path),
    ];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content, `${path.relative(root, file)} must use Engine compatibility naming`).not.toMatch(
        /\b(?:listKStarRuns|getKStarRun|reviewKStarRun)\b/,
      );
    }
  });
});
