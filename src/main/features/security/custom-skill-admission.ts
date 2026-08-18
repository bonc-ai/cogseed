/**
 * Admission gate for CogSeed-generated custom skills.
 *
 * W1 of the security plan: the four self-generation paths (commander
 * `<skill>` container, onboarding Claude/Codex import, recall draft install)
 * used to land content with `status: 'approved'` and zero security evidence —
 * the load gate would only deep-scan on first use ("先上车后查票"). This
 * module front-loads that check so the admission decision is made and
 * receipted before the skill is reported as done (spec §4.2: the save-as-
 * formal-asset action must be disabled until the check passes).
 *
 * Order is load-bearing, mirroring the import path:
 *  1. Local red lines + deep scan judge ONLY the authored content. The skill
 *     skeleton (8 template files) is generated afterwards precisely because
 *     padding a suspicious skill with clean templates dilutes the verdict —
 *     measured on the import path (`chmod 777` + env-driven POST moved from
 *     `restricted` to `pass` once templates were present).
 *  2. The skeleton fills missing skill artifacts (never overwrites), making
 *     "defaults are compliant" true for generated skills.
 *  3. A post-skeleton re-validation can escalate `shape_*` findings — opt-in
 *     via `opts.escalateSkillShape`, and only the commander authoring path opts in,
 *     because that is the path whose creator contract promises skill
 *     trigger/anti-trigger semantics. Foreign-format imports (Claude/Codex
 *     onboarding, recall-distilled methods) are source-preserving: escalating
 *     there would mark essentially every import `restricted`, and a badge that
 *     fires on everything fires on nothing. Their shape findings stay
 *     advisory MEDIUM in the report. Marketplace installs keep the MEDIUM
 *     reading unconditionally.
 *  4. The receipt is written over the FINAL tree (post-skeleton) so the hash
 *     describes the bytes as they will be found on disk.
 *
 * `blocked` (EXTREME red line or deep-scan refusal) is returned to the caller,
 * which owns rollback — different callers remove or keep the half-created
 * skill. `unknown` (scanner infrastructure failure) is likewise caller-owned:
 * import paths fail closed, the commander path keeps the authored content and
 * reports the gap. No receipt is written for either, so the load gate retries
 * the deep scan on first use instead of trusting a claim that never happened.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { userSkillsDir } from '../../paths';
import { validateSkillDir, type ValidationReport } from '../../quality';
import { ensureSkillSkeleton } from '../skill_skeleton';
import { skillPayloadHash, writeInstallReceipt, writeReceipt, type SecurityReceipt } from '../skill_trust';
import { scanSkillDir, scanVerdictBlocksInstall, type SentryScanResult } from './sentry-adapter';

const log = createLogger('security/custom-admission');

export type CustomAdmissionOutcome = 'pass' | 'restricted' | 'blocked' | 'unknown';

export interface CustomAdmissionResult {
  outcome: CustomAdmissionOutcome;
  skillId: string;
  /** Post-skeleton report, when a validation ran. */
  report: ValidationReport | null;
  /** Deep-scan result, when a scan ran. */
  scan: SentryScanResult | null;
  /** Receipt over the final tree. Absent for `blocked` / `unknown`. */
  receipt: SecurityReceipt | null;
  /** `shape_*` rule ids that escalated the verdict to `restricted`. */
  escalatedSkillShape: string[];
  /** Machine reason for `blocked` / `unknown`, for callers and logs. */
  reason?: string;
}

function _blocked(skillId: string, reason: string, extra: Partial<CustomAdmissionResult>): CustomAdmissionResult {
  return { outcome: 'blocked', skillId, report: null, scan: null, receipt: null, escalatedSkillShape: [], reason, ...extra };
}

function _unknown(skillId: string, reason: string, extra: Partial<CustomAdmissionResult>): CustomAdmissionResult {
  return { outcome: 'unknown', skillId, report: null, scan: null, receipt: null, escalatedSkillShape: [], reason, ...extra };
}

/**
 * Admit one generated custom skill: scan the authored tree, generate the skill
 * skeleton, re-validate with escalated skill-shape rules, and record the receipt.
 *
 * Never throws: every failure surfaces as `unknown`, so an infrastructure
 * problem cannot break a creation flow with an unhandled rejection.
 */
/**
 * Record a refusal so the load gate withholds the tree WITHOUT rescanning.
 *
 * Opt-in (`recordBlockedReceipt`): create flows delete the half-created skill
 * instead; EDIT flows keep the user's content and must receipt the refusal —
 * the same UX-first pattern as the reconcile gate. Returns null on failure or
 * when the tree cannot be hashed.
 */
function _recordBlockedReceipt(
  uid: string,
  skillId: string,
  dir: string,
  report: ValidationReport,
  scan: SentryScanResult | null,
): SecurityReceipt | null {
  const payloadHash = skillPayloadHash(dir);
  if (!payloadHash) return null;
  const rule = scan?.blockingRules?.[0]
    || scan?.localRedLines?.[0]
    || report.violations.find((v) => (v.original_level || v.level) === 'EXTREME')?.rule;
  try {
    return writeReceipt(uid, skillId, {
      payloadHash,
      decision: 'blocked',
      violationCount: report.violations.length,
      scanner: scan ? 'deep' : 'local',
      ...(scan && typeof scan.score === 'number' ? { securityScore: scan.score } : {}),
      ...(scan?.scannerVersion ? { scannerVersion: scan.scannerVersion } : {}),
      ...(scan?.rulesetVersion ? { rulesetVersion: scan.rulesetVersion } : {}),
      ...(scan && typeof scan.isolated === 'boolean' ? { isolated: scan.isolated } : {}),
      ...(scan?.rulesDegraded ? { rulesDegraded: true } : {}),
      ...(scan?.attackSurface ? { attackSurface: { ...scan.attackSurface } } : {}),
      ...(scan?.instructionRisk ? { instructionRisk: scan.instructionRisk } : {}),
      ...(rule ? { topRule: rule, topLevel: 'EXTREME' } : {}),
    });
  } catch (err) {
    log.warn('failed to record blocked admission receipt', { skillId, error: (err as Error).message });
    return null;
  }
}

export async function admitCustomSkill(
  uid: string,
  skillId: string,
  opts: { escalateSkillShape?: boolean; recordBlockedReceipt?: boolean } = {},
): Promise<CustomAdmissionResult> {
  if (!safeId(skillId)) return _unknown(skillId, 'invalid_skill_id', {});
  const dir = path.join(userSkillsDir(uid), skillId);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    return _unknown(skillId, 'artifact_missing', {});
  }

  // 1. Local red lines on the authored tree, unconditionally.
  const pre = validateSkillDir(dir, { enforceSkillRunner: false });
  if (!pre.ok) {
    log.warn('custom skill admission blocked by local red lines', {
      skillId,
      rules: pre.violations.filter((v) => (v.original_level || v.level) === 'EXTREME').map((v) => v.rule),
    });
    return _blocked(skillId, 'local_red_lines', {
      report: pre,
      ...(opts.recordBlockedReceipt === true
        ? { receipt: _recordBlockedReceipt(uid, skillId, dir, pre, null) }
        : {}),
    });
  }

  // 2. Deep scan on the authored tree. Never throws (maps to `unknown`).
  const scan = await scanSkillDir(dir, 'community');
  if (scanVerdictBlocksInstall(scan.outcome)) {
    if (scan.outcome === 'unknown') {
      return _unknown(skillId, scan.unavailableReason || 'scan_unavailable', { report: pre, scan });
    }
    return _blocked(skillId, 'deep_scan_refused', {
      report: pre,
      scan,
      ...(opts.recordBlockedReceipt === true
        ? { receipt: _recordBlockedReceipt(uid, skillId, dir, pre, scan) }
        : {}),
    });
  }

  // 3. Skill skeleton — fills the missing artifacts only, never overwrites.
  try {
    ensureSkillSkeleton(dir, skillId);
  } catch (err) {
    // A skeleton gap downgrades the skill-shape escalation, it must not fail the
    // admission: the security verdict above already stands.
    log.warn('custom skill admission skeleton generation failed', {
      skillId, error: (err as Error).message,
    });
  }

  // 4. Post-skeleton re-validation: skill-shape findings escalate here,
  //    ONLY when the caller opted in (`escalateSkillShape`).
  //
  //    Why opt-in rather than universal: escalation exists to backstop the
  //    commander authoring contract, which promises skill trigger/anti-trigger
  //    semantics on every new skill. Foreign-format imports (Claude/Codex
  //    onboarding, recall-distilled methods) are source-preserving by the
  //    creator's own contract — forcing skill shape on them would mark
  //    essentially every import `restricted`, and a badge that fires on
  //    everything fires on nothing (the exact MEDIUM-noise failure fixed in
  //    二期第 4 步). Those paths still get the skeleton files filled and the
  //    findings recorded as advisory MEDIUM in the report; they just do not
  //    move the verdict.
  //
  //    Excluded even under escalation:
  //    `shape_staged_ceiling_missing` / `shape_production_lock_missing` — the
  //    TS shape check only reads SKILL.md + `_meta.json`, while the skeleton
  //    declares both hard caps in `references/skill-spec.yaml` (checked by
  //    the registry gate); escalating them would mark every
  //    generated skill restricted for a declaration already made.
  //    `shape_tier` — informational tier label (Level A/B), not a
  //    finding.
  const ESCALATED_SKILL_SHAPE_RULES: ReadonlySet<string> = new Set([
    'shape_frontmatter_incomplete',
    'shape_trigger_missing',
    'shape_antitrigger_missing',
    'shape_input_contract_missing',
    'shape_output_contract_missing',
    'shape_ontology_slice_missing',
    'shape_runtime_contracts_missing',
    'shape_runtime_guard_violation',
  ]);
  const post = validateSkillDir(dir, { enforceSkillRunner: false });
  const escalatedSkillShape = opts.escalateSkillShape === true
    ? post.violations
      .filter((v) => ESCALATED_SKILL_SHAPE_RULES.has(v.rule))
      .map((v) => v.rule)
    : [];
  if (escalatedSkillShape.length) {
    log.warn('custom skill admission escalated skill-shape findings', { skillId, rules: escalatedSkillShape });
  }

  // 5. Receipt over the final tree. The effective scan outcome is `restricted`
  //    when skill-shape escalation fired, so `writeInstallReceipt` records `risk`
  //    rather than `pass` — the panel explains the shape gap instead of
  //    showing a clean badge.
  const payloadHash = skillPayloadHash(dir);
  const topSkillShape = escalatedSkillShape.length
    ? post.violations.find((v) => v.rule.startsWith('shape_'))
    : undefined;
  const effectiveScan: SentryScanResult = escalatedSkillShape.length
    ? { ...scan, outcome: 'restricted' }
    : scan;
  const receipt = writeInstallReceipt(uid, skillId, payloadHash, effectiveScan, {
    violationCount: post.violations.length,
    ...(topSkillShape ? { topRule: topSkillShape.rule, topLevel: topSkillShape.level as 'MEDIUM' | 'LOW' } : {}),
  }, undefined, dir);

  const outcome: CustomAdmissionOutcome =
    (escalatedSkillShape.length || scan.outcome === 'restricted') ? 'restricted' : 'pass';
  return { outcome, skillId, report: post, scan, receipt, escalatedSkillShape };
}
