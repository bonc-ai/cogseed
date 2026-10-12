/**
 * Guardrail status snapshot for the "安全与信任" settings page.
 *
 * Composes the existing integrity/availability sources into one
 * renderer-facing shape. This module owns nothing — it reads sentry-adapter's
 * availability, scanner_trust's pin verification, and skill-declaration-adapter's
 * engine integrity, so a change to any of those layers is reflected here
 * without a second copy of the logic.
 *
 * Every field is coarse status/version data only — never receipts' sensitive
 * content, never file paths, never findings text.
 *
 * 2.2.0 added the `capabilities` and `rules` sections. Before them the page
 * could say "the scanner is present" but not "what can it actually see" — so a
 * user reading a 100/100 had no way to learn that, say, gitleaks was missing or
 * that the versioned ruleset had failed to load and a thin built-in set ran
 * instead. Coverage that cannot be stated is coverage that cannot be trusted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { packagedGuardrailDir } from '../../paths';
import {
  resolveRulesetVersion,
  scannerAvailability,
  type ScannerAvailability,
} from './sentry-adapter';
import { verifyScannerIntegrity, SCANNER_SKILL_ID } from '../scanner_trust';
import { declarationEngineDir, verifyDeclarationCoreIntegrity, type DeclarationCoreIntegrity } from './skill-declaration-adapter';

const log = createLogger('security/guardrail-status');

/** One detection capability and whether this build can perform it. */
export interface CapabilityStatus {
  id: string;
  /**
   * `implemented`  — the engine does this natively.
   * `partial`      — a native detector exists but its coverage is a known subset.
   * `needs_tool`   — the whole capability is off until an external tool is installed.
   * `degraded`     — the engine runs it, with less coverage than the full configuration.
   * `absent`       — this build does not ship the scanner at all.
   *
   * `needs_tool` is separate from `degraded` on purpose. "Your protection is
   * reduced" is a fault; "install osv-scanner to unlock CVE lookup" is a scoped,
   * actionable step. Collapsing them made the page open on "3 项降级" and read as
   * a broken install even though two of the three were optional enhancements.
   */
  status: 'implemented' | 'partial' | 'needs_tool' | 'degraded' | 'absent';
  /** Human-readable method, taken from capabilities.yaml. */
  method?: string;
  /** Why it is degraded, when it is. */
  reason?: string;
}

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
  /** Rule inventory, read from the active ruleset. */
  rules: {
    total: number;
    groups: string[];
    hardBlock: number;
    /** True when the versioned ruleset loaded; false means built-in only. */
    versioned: boolean;
  };
  /** Detection capabilities and their availability in this build. */
  capabilities: CapabilityStatus[];
  /** Optional external tools the engine can use when installed. */
  externalTools: Array<{ id: string; available: boolean }>;
  /** Python interpreter the scanner would use, or '' when none was found. */
  interpreter: string;
}

function _readVersionFile(...segments: string[]): string {
  try {
    const raw = fs.readFileSync(path.join(packagedGuardrailDir(), ...segments), 'utf8').trim();
    return raw.slice(0, 64);
  } catch {
    return '';
  }
}

function _countRules(): GuardrailStatus['rules'] {
  const version = resolveRulesetVersion();
  if (!version) return { total: 0, groups: [], hardBlock: 0, versioned: false };
  const file = path.join(packagedGuardrailDir(), SCANNER_SKILL_ID, 'engine', 'rulesets',
    version, 'text-rules.yaml');
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { total: 0, groups: [], hardBlock: 0, versioned: false };
  }
  // Deliberately not parsed with a YAML library: the renderer only needs
  // counts, and pulling a YAML parser into the main process for a status
  // readout would be a new dependency on the critical path of the settings
  // page. Counting `- id:` occurrences under a group key is exact enough for
  // a number that is never used for a decision.
  // 逐块统计：块名以「列 0 的 key:」开头，块内出现 `- id:` 才说明它是一个规则组。
  //
  // 第一版用「块名以 _rules 结尾」判定，实测在 v1.1.0 上得到 `groups: []`：
  // 真实的组名是 dangerous_commands / dynamic_execution / network_egress 这类，
  // 没有一个以 _rules 结尾。按名字猜组名一定会漂移，按结构判定不会。
  const META_KEYS = new Set(['version', 'secret_patterns', 'false_positive_markers',
    'supply_chain_latest', 'lockfiles', 'forbidden_files', 'group_sr',
    'group_remediation', 'changelog', 'metadata']);
  const perKey = new Map<string, number>();
  let current = '';
  for (const line of raw.split('\n')) {
    const topLevel = /^([a-z_]+):\s*$/.exec(line);
    if (topLevel) {
      current = topLevel[1];
      if (!perKey.has(current)) perKey.set(current, 0);
      continue;
    }
    if (current && /^\s*-\s+id:\s*\S/.test(line)) {
      perKey.set(current, (perKey.get(current) || 0) + 1);
    }
  }
  const groups = [...perKey.entries()]
    .filter(([key, count]) => count > 0 && !META_KEYS.has(key) && key !== 'hard_block')
    .map(([key]) => key)
    .sort();
  const hardBlock = perKey.get('hard_block') || 0;
  const groupRules = groups.reduce((sum, key) => sum + (perKey.get(key) || 0), 0);
  // Secret patterns live in a second file; add them so the number the user sees
  // matches what the engine reports in `coverage.rule_count`.
  let secretCount = 0;
  try {
    const secrets = fs.readFileSync(path.join(packagedGuardrailDir(), SCANNER_SKILL_ID,
      'engine', 'rulesets', version, 'secret-patterns.yaml'), 'utf8');
    secretCount = (secrets.match(/^\s*-\s+id:\s*\S/gm) || []).length;
  } catch { /* secrets file missing: the total is then just the text rules */ }
  if (secretCount === 0) {
    const hidden = perKey.get('secret_patterns') || 0;
    secretCount = hidden;
  }
  return {
    total: groupRules + hardBlock + secretCount,
    groups,
    hardBlock,
    versioned: true,
  };
}

function _externalTools(): Array<{ id: string; available: boolean }> {
  // Resolved via PATH lookup rather than by shelling out: this runs on every
  // settings-tab activation, and spawning two processes to render a status
  // line is not worth it.
  const lookup = (name: string): boolean => {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
      : [''];
    for (const dir of dirs) {
      for (const ext of exts) {
        try {
          if (fs.existsSync(path.join(dir, name + ext))) return true;
        } catch {
          // An unreadable PATH entry must not break the whole lookup.
        }
      }
    }
    return false;
  };
  return [
    { id: 'gitleaks', available: lookup('gitleaks') },
    { id: 'osv-scanner', available: lookup('osv-scanner') },
  ];
}

function _interpreter(): string {
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const name of candidates) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }
  return '';
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
  const rules = scanner === 'present'
    ? _countRules()
    : { total: 0, groups: [] as string[], hardBlock: 0, versioned: false };
  const externalTools = _externalTools();
  const gitleaks = externalTools.find((t) => t.id === 'gitleaks')?.available === true;
  const osv = externalTools.find((t) => t.id === 'osv-scanner')?.available === true;

  // Capabilities this build can actually perform. `degraded` is a distinct
  // state from `absent`: the check still runs, just with less coverage, and
  // saying "absent" would overstate the loss.
  const capabilities: CapabilityStatus[] = [
    { id: 'text_static_analysis', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'context_awareness', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'negative_example_recognition', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'instruction_analysis', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'hidden_content_detection', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'obfuscation_detection', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'supply_chain_analysis', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'structural_analysis', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'scoring_explainability', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'framework_mapping', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'sarif_export', status: scanner === 'present' ? 'implemented' : 'absent' },
    { id: 'risk_acceptance', status: scanner === 'present' ? 'implemented' : 'absent' },
    {
      // The built-in rule set (70 named patterns + entropy detection) IS the
      // capability. gitleaks widens its coverage, but a missing enhancement is
      // not a degraded capability — marking it so understated a detector that
      // runs on every scan. Availability is still visible under externalTools.
      id: 'secret_detection',
      status: scanner === 'present' ? 'implemented' : 'absent',
    },
    {
      // Nothing native here: without osv-scanner there is no vulnerability
      // database to query, so the capability is off rather than degraded.
      id: 'dependency_vulnerability_scan',
      status: scanner !== 'present' ? 'absent' : osv ? 'implemented' : 'needs_tool',
      ...(osv ? {} : { reason: 'no_osv_scanner' }),
    },
    {
      id: 'binary_static_analysis',
      status: scanner === 'present' ? 'implemented' : 'absent',
    },
    {
      id: 'malware_signature_matching',
      status: scanner !== 'present' ? 'absent' : 'partial',
      reason: 'no_yara_engine',
    },
  ];

  return {
    scanner,
    scannerIntegrity: sentryIntegrity,
    sentryEngineVersion: _readVersionFile('skill-sentry', 'engine', 'VERSION'),
    sentryRulesetVersion: _readVersionFile('skill-sentry', 'engine', 'rulesets',
      resolveRulesetVersion() || '', 'VERSION') || resolveRulesetVersion(),
    declarationEngineVersion: declarationDir ? _readVersionFile('skill-declaration-core', 'VERSION') : '',
    declarationIntegrity,
    scannerAbsentByBuild: scanner === 'absent_by_build',
    rules,
    capabilities,
    externalTools,
    interpreter: scanner === 'present' ? _interpreter() : '',
  };
}
