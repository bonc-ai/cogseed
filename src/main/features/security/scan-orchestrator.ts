/**
 * Resolve the deep scanner when it is not bundled with the build.
 *
 * WHY THIS EXISTS
 * The scanner carries closed-source rules and scoring weights that must not ship
 * in an open-source checkout. Step 1 made its absence expressible
 * (`scanner_absent`); this step lets a build that omits it still find it, when
 * the operator has installed it separately as a skill package.
 *
 * WHAT IT IS NOT
 * Not a model call. An earlier plan had an agent drive the scan, but the install
 * and import IPC entry points have no model session — they are plain main-process
 * calls — and giving them one would mean a skill import fails offline or without
 * credentials, cost tokens per install, and put an attacker-controlled payload in
 * front of a model that decides whether to admit it. Invoking the scanner as a
 * skill achieves the closed-source goal on its own: the open-source repository
 * sees a skill id and a JSON contract, never the rules.
 *
 * THE VERDICT IS STILL SYMBOLIC
 * This module only locates and runs the scanner and hands back its raw JSON.
 * `pass`/`blocked` is decided by `outcomeFrom` in sentry-adapter, exactly as for
 * a bundled scanner. Nothing here interprets a verdict, and an unparseable
 * response becomes `unknown` — never `pass`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';

const log = createLogger('scan-orchestrator');

/**
 * Skill id the scanner is expected to be installed under.
 *
 * Hardcoded, not configurable. A configurable id would let anything that can
 * write settings redirect security scanning at a package it controls, which
 * inverts the gate: the component being trusted would be chosen by whoever is
 * being checked.
 */
export const SENTRY_SKILL_ID = 'skill-sentry';

/**
 * Where an externally-installed scanner can live, in resolution order.
 *
 * The per-user roots are skipped when no user is active. Scanning runs during
 * install and import, and also from tooling and tests that have no session — and
 * `getActiveUserId()` throws rather than returning empty. Letting that propagate
 * would turn "no user yet" into a scan failure, i.e. into `unknown`, i.e. into a
 * refused install, for a reason that has nothing to do with the skill.
 */
function candidateRoots(uid: string | null): string[] {
  const override = (process.env.ORKAS_SENTRY_SKILL_DIR || '').trim();
  return [
    // Explicit operator override wins: a private deployment points this at
    // wherever it keeps the closed-source component.
    ...(override ? [override] : []),
    ...(uid ? userSkillRoots(uid) : []),
  ];
}

/**
 * Per-user skill roots, resolved lazily.
 *
 * `paths` throws at import time when `ORKAS_WORKSPACE_ROOT` is unset, so a
 * top-level import here would fail whenever this module is loaded before the
 * install container is resolved — and the failure surfaces as "no external
 * scanner found", i.e. a security check silently downgrading itself for an
 * unrelated reason. Requiring inside the call keeps that failure local and
 * recoverable.
 */
function userSkillRoots(uid: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const paths = require('../../paths') as typeof import('../../paths');
    return [
      paths.userMarketplaceSkillDir(uid, SENTRY_SKILL_ID),
      path.join(paths.userSkillsDir(uid), SENTRY_SKILL_ID),
    ];
  } catch {
    // No workspace root yet: the override above is the only usable source.
    return [];
  }
}

/** Active user id, or `null` when there is no session rather than throwing. */
function activeUidOrNull(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const users = require('../users') as typeof import('../users');
    return users.getActiveUserId();
  } catch {
    return null;
  }
}

/**
 * Locate an externally-installed scanner engine.
 *
 * Keyed on `sandbox/agent_gate.py` — the file the adapter actually spawns —
 * rather than on the directory or on `SKILL.md`. A skill package that is present
 * but missing the engine cannot perform a scan, and treating it as available
 * would produce `unknown` on every install with no indication why.
 */
export function findExternalScannerEngine(uid: string | null = activeUidOrNull()): string | null {
  for (const root of candidateRoots(uid)) {
    if (fs.existsSync(path.join(root, 'sandbox', 'agent_gate.py'))) return root;
  }
  return null;
}

/**
 * The gate script to drive an external engine with.
 *
 * Prefers one shipped alongside the engine, so the closed-source package can
 * evolve its own decision script. Otherwise falls back to the repository's own
 * copy — open source, containing no rules, it reads the engine's report and
 * applies the documented thresholds.
 *
 * The fallback is resolved from the source tree rather than from the (possibly
 * emptied) bundled guardrail root: on a build that omits the scanner, that root
 * is exactly where `scan_gate.py` is NOT, so using it would find an engine and
 * then refuse to drive it.
 */
export function resolveExternalGateScript(engineRoot: string, bundledGate: string): string | null {
  for (const candidate of [
    path.join(engineRoot, 'scan_gate.py'),
    // Sibling of the engine: how a package that vendors both lays them out.
    path.join(path.dirname(engineRoot), 'scan_gate.py'),
    bundledGate,
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Description of a resolved external scanner, for logging and diagnostics. */
export interface ExternalScannerLocation {
  engineRoot: string;
  gateScript: string;
}

/**
 * Resolve an external scanner, or `null` when none is installed.
 *
 * Logged at info once per resolution because "which scanner produced this
 * verdict" is an audit question: a receipt saying `deep` is only meaningful if
 * the engine behind it can be identified later.
 */
export function resolveExternalScanner(
  bundledGate: string,
  uid: string | null = activeUidOrNull(),
): ExternalScannerLocation | null {
  const engineRoot = findExternalScannerEngine(uid);
  if (!engineRoot) return null;

  const gateScript = resolveExternalGateScript(engineRoot, bundledGate);
  if (!gateScript) {
    // Engine without any usable driver: report it rather than silently falling
    // back to "no scanner", which would look identical to not having installed
    // one at all.
    log.warn('external scanner engine found but no gate script is available', { engineRoot });
    return null;
  }

  log.info('using externally installed scanner', { engineRoot, gateScript });
  return { engineRoot, gateScript };
}
