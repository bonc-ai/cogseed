/**
 * Bottom-up ad-hoc bundle sealing for LOCAL, certificate-free verification
 * runs (Squirrel.Mac update validation). Shared by
 * `scripts/test-update-local.mjs` and `scripts/build-hub-verify-artifacts.mjs`.
 *
 * Why this exists:
 *   - Electron ships helper apps and plain frameworks whose upstream seals
 *     are inconsistent (code has no resources but the seal says they must
 *     exist), and `Electron Framework.framework` itself is unsigned.
 *     Production solves this with a real signing identity via electron-builder;
 *   - Squirrel.Mac validates an update bundle with SecStaticCode and against
 *     the RUNNING app's designated requirement. Ad-hoc default requirements
 *     embed the cdhash, which can never match across two builds — so both the
 *     old (running) and new (downloaded) bundle are signed with an explicit
 *     identifier-based requirement instead.
 *
 * Order matters: nested components first (so their cdhashes are fresh when
 * the outer bundle's seal references them), versioned frameworks signed as
 * Versions/A first then the wrapper (signing only the wrapper leaves the
 * inner binary unsigned and dyld refuses to load it), outer bundle last.
 *
 * Still ad-hoc: no certificate, no notarization, no Apple account.
 */

'use strict';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HELPERS = [
  'CogSeed Helper',
  'CogSeed Helper (GPU)',
  'CogSeed Helper (Plugin)',
  'CogSeed Helper (Renderer)',
];

const FRAMEWORKS = [
  'Mantle.framework',
  'ReactiveObjC.framework',
  'Squirrel.framework',
  'Electron Framework.framework',
];

function shQuiet(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

/**
 * Ad-hoc seal `appPath` (a .app bundle) so Squirrel.Mac accepts it.
 * Returns a list of components that failed to seal (empty = success).
 *
 * `identifier` goes into the outer designated requirement, e.g.
 * 'com.cogseed.desktop' — the old and new bundle must use the SAME value.
 * `namePrefix` defaults to the release product name; the packaged-dev build
 * renames helpers to 'CogSeed Dev Helper…', so it passes 'CogSeed Dev'.
 */
export function adhocSealBundle(appPath, identifier, namePrefix = 'CogSeed') {
  const requirement = `=designated => identifier "${identifier}"`;
  const failed = [];
  const signOne = (componentPath, extraArgs = []) => {
    let r = shQuiet('codesign', ['--force', '--sign', '-', '--timestamp=none', ...extraArgs, componentPath]);
    if (!r.ok) {
      // Re-sealing an already-sealed component can trip over the stale seal;
      // drop it and retry once.
      shQuiet('codesign', ['--remove-signature', componentPath]);
      r = shQuiet('codesign', ['--force', '--sign', '-', '--timestamp=none', ...extraArgs, componentPath]);
    }
    if (!r.ok) failed.push(path.basename(componentPath));
  };
  for (const helper of HELPERS) {
    // 'CogSeed Helper (GPU)' + namePrefix 'CogSeed Dev' → 'CogSeed Dev Helper (GPU)'.
    const suffix = helper.slice('CogSeed'.length);
    signOne(path.join(appPath, 'Contents', 'Frameworks', `${namePrefix}${suffix}.app`));
  }
  for (const framework of FRAMEWORKS) {
    const frameworkPath = path.join(appPath, 'Contents', 'Frameworks', framework);
    // Versioned frameworks: the actual binary lives in Versions/A — sign the
    // version bundle first, then the wrapper.
    const versionA = path.join(frameworkPath, 'Versions', 'A');
    if (fs.existsSync(versionA)) signOne(versionA);
    signOne(frameworkPath);
  }
  signOne(appPath, ['--requirements', requirement]);
  return failed;
}

/**
 * Strict verification: `codesign --verify --deep` must pass for Squirrel's
 * SecStaticCode validation to accept the bundle.
 */
export function verifyBundleDeep(appPath) {
  const result = shQuiet('codesign', ['--verify', '--deep', appPath]);
  return { ok: result.ok, stderr: result.stderr };
}
