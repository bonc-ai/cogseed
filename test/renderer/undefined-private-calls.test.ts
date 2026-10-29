import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * Guards the defect class that shipped twice on 2026-09-15:
 *
 *   - #263 removed `_refreshSidebarBadgesForCid` but kept two call sites
 *     (the throw aborted the group-bus message handler before finalize)
 *   - #259 removed `_renderCognitionPageHeader` but kept its call in the
 *     `i18n-change` handler
 *
 * Neither was caught because `eslint.config.mjs` does not enable `no-undef`,
 * and it cannot cheaply: the renderer is classic scripts, so modules
 * legitimately call functions defined in *other* files (`renderMarkdown`,
 * `uiButton`, ...), which `no-undef` would flag en masse.
 *
 * Underscore-prefixed helpers are NOT file-private here: the renderer is
 * classic scripts, so `state.js` legitimately calls
 * `conversation.js::_bumpConvToTop` and friends. The precise rule that still
 * catches this defect class is therefore: every `_name(...)` call must resolve
 * to a definition **somewhere in `src/renderer`**.
 *
 * Comments are removed with the TypeScript parser rather than a regex: the
 * regex version silently swallowed `function _kbNewFolder` because an
 * unbalanced-looking `/*` inside a string made the non-greedy block matcher
 * span across real code, which produced a dozen false positives.
 */

const RENDERER_ROOT = path.resolve(__dirname, '../../src/renderer');

function withoutComments(src: string): string {
  return ts.transpileModule(src, {
    compilerOptions: {
      removeComments: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
}

function collectJsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function definedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/\b(?:function|class)\s+(_?[A-Za-z][A-Za-z0-9_]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(_?[A-Za-z][A-Za-z0-9_]*)\s*=/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bwindow\.(_?[A-Za-z][A-Za-z0-9_]*)\s*=/g)) names.add(m[1]);
  return names;
}

function calledPrivateNames(src: string): Set<string> {
  const names = new Set<string>();
  // Exclude property access (`obj._x(`) and any name that is a member of an
  // object literal key position.
  for (const m of src.matchAll(/(?<![.\w$])(_[A-Za-z][A-Za-z0-9_]*)\s*\??\s*\(/g)) names.add(m[1]);
  return names;
}

describe('renderer private-call integrity', () => {
  it('resolves every underscore-prefixed call somewhere in the renderer', () => {
    const sources = collectJsFiles(RENDERER_ROOT).map((file) => ({
      file,
      src: withoutComments(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')),
    }));

    const definedAnywhere = new Set<string>();
    for (const { src } of sources) {
      for (const name of definedNames(src)) definedAnywhere.add(name);
    }

    const offences: string[] = [];
    for (const { file, src } of sources) {
      for (const called of calledPrivateNames(src)) {
        if (!definedAnywhere.has(called)) {
          offences.push(`${path.relative(RENDERER_ROOT, file)}: ${called}()`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
