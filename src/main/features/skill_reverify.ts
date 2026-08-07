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
