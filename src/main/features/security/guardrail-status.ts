/**
 * Guardrail status snapshot for the "安全与信任" settings page.
 *
 * Composes the three existing integrity/availability sources into one
 * renderer-facing shape. This module owns nothing — it reads sentry-adapter's
 * availability, scanner_trust's pin verification, and skill-declaration-adapter's
 * engine integrity, so a change to any of those layers is reflected here
 * without a second copy of the logic.
 *
 * Every field is coarse status/version data only — never receipts' sensitive
 * content, never file paths, never findings text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { packagedGuardrailDir } from '../../paths';
import { scannerAvailability, type ScannerAvailability } from './sentry-adapter';
import { verifyScannerIntegrity, SCANNER_SKILL_ID } from '../scanner_trust';
import { declarationEngineDir, verifyDeclarationCoreIntegrity, type DeclarationCoreIntegrity } from './skill-declaration-adapter';

const log = createLogger('security/guardrail-status');

export interface GuardrailStatus {
  /** Availability of the packaged deep scanner. */
  scanner: ScannerAvailability;
  /** Integrity of the packaged scanner tree against its release pin. */
  scannerIntegrity: 'verified' | 'tampered' | 'unpinned' | 'unreadable';
  /** skill-sentry engine version, or '' when unreadable. */
  sentryEngineVersion: string;
  /** skill-sentry ruleset version, or '' when unreadable. */
  sentryRulesetVersion: string;
  /** Skill declaration engine version, or '' when absent. */
  declarationEngineVersion: string;
  /** Integrity of the declaration engine tree against its pin. */
  declarationIntegrity: DeclarationCoreIntegrity;
  /** True when this build intentionally ships without the closed scanner. */
  scannerAbsentByBuild: boolean;
}

function _readVersionFile(...segments: string[]): string {
  try {
    const raw = fs.readFileSync(path.join(packagedGuardrailDir(), ...segments), 'utf8').trim();
    return raw.slice(0, 64);
  } catch {
    return '';
  }
}

export function guardrailStatus(): GuardrailStatus {
  const scanner = scannerAvailability();
  const sentryDir = path.join(packagedGuardrailDir(), SCANNER_SKILL_ID);
  const sentryIntegrity = verifyScannerIntegrity(sentryDir).status;
  const declarationDir = declarationEngineDir();
  const declarationIntegrity = declarationDir
    ? verifyDeclarationCoreIntegrity(declarationDir).status
    : 'unreadable' as const;
  if (!declarationDir) {
    log.warn('declaration engine absent when reading guardrail status');
  }
  return {
    scanner,
    scannerIntegrity: sentryIntegrity,
    sentryEngineVersion: _readVersionFile('skill-sentry', 'engine', 'VERSION'),
    sentryRulesetVersion: _readVersionFile('skill-sentry', 'engine', 'rulesets', 'v1.0.0', 'VERSION')
      || 'v1.0.0',
    declarationEngineVersion: declarationDir ? _readVersionFile('skill-declaration-core', 'VERSION') : '',
    declarationIntegrity,
    scannerAbsentByBuild: scanner === 'absent_by_build',
  };
}
