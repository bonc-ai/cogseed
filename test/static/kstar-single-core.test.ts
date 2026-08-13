/**
 * Static deletion-proof test: KSTAR has one semantic core
 *
 * Proves that the retired P3394 KSTAR fact model has been deleted and that
 * generic P3394/group-chat code no longer computes or mutates its semantic
 * state. Current KSTAR behavior belongs to the canonical features/kstar line.
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

  it('does not mutate retired P3394 KSTAR run or experience state', () => {
    const p3394Files = readProductionFiles(p3394Dir);
    const busFiles = readProductionFiles(groupChatDir);

    for (const file of [...p3394Files, ...busFiles]) {
      expect(file.content, `${path.basename(file.path)} must not append legacy KSTAR runs`).not.toMatch(
        /state\.runs\.push/,
      );
      expect(file.content, `${path.basename(file.path)} must not append legacy experience candidates`).not.toMatch(
        /state\.experience_candidates\.push/,
      );
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
      expect(content, `${path.relative(root, file)} must not expose retired P3394 KSTAR entrypoints`).not.toMatch(
        /\b(?:listKStarRuns|getKStarRun|reviewKStarRun)\b/,
      );
    }
  });
});
