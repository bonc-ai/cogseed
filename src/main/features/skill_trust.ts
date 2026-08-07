/**
 * Skill trust ledger — security receipts and re-scan triggers.
 *
 * The gap this closes: a skill is scanned once at install time and then never
 * checked again. Nothing detects post-install edits, and a ruleset upgrade does
 * not invalidate verdicts reached under the old rules. So the strongest
 * statement the product could previously make was "this passed, at some point,
 * under some version of the rules".
 *
 * A receipt binds a verdict to the exact thing that was scanned:
 *
 *     payload_hash + validator_version + rule_profile  →  decision
 *
 * Any of those three changing invalidates the receipt. That is what makes
 * "re-check when the content changed" and "re-check when the rules changed"
 * mechanical rather than a matter of remembering to.
 *
 * Deliberately NOT a cache. A receipt answers "is the previous verdict still
 * applicable", never "skip the scan". Callers ask `isReceiptStale` and rescan
 * when it says so; a missing receipt always means rescan.
 *
 * Storage is `<uid>/local/`: this is derived, machine-local state. It must not
 * sync, because a receipt vouches for bytes on *this* disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { userLocalRoot } from '../paths';
import { safeId, writeTextAtomicSync, nowIso, readJsonSync } from '../storage';
import { createLogger } from '../logger';
import { VALIDATOR_VERSION } from '../quality';
import { marketplaceContentTreeHash } from '../util/marketplace-tree-hash';

const log = createLogger('skill-trust');

/** Verdict recorded in a receipt. Mirrors the validator's severity model. */
export type ReceiptDecision = 'pass' | 'risk' | 'blocked';

export interface SecurityReceipt {
  skillId: string;
  /**
   * Digest of the scanned tree. Uses the same cross-language tree hash as
   * marketplace installs so a receipt and an install manifest describe the
   * same bytes, and its skip-list matches the validator's own walk — the hash
   * therefore covers exactly what was scanned.
   */
  payloadHash: string;
  /** Validator build that produced the verdict. */
  validatorVersion: string;
  /**
   * Ruleset identity, separate from `validatorVersion` so a rules-only change
   * can invalidate receipts without a code release.
   */
  ruleProfile: string;
  decision: ReceiptDecision;
  violationCount: number;
  /** Highest-severity rule, for explaining a stale/blocked verdict. */
  topRule?: string;
  /**
   * Severity of `topRule`. Persisted alongside it because `decision: 'risk'`
   * collapses every level into one bucket — a missing `_meta.json` category
   * (MEDIUM) and a shell-injection pattern both land there. Consumers that
   * present the verdict to a user need the level to avoid labelling the whole
   * library "has findings"; recomputing it would mean a second full scan.
   *
   * Optional: receipts written before this field existed simply lack it, and a
   * missing level is treated as "not notable" rather than assumed severe.
   */
  topLevel?: 'EXTREME' | 'MEDIUM' | 'LOW';
  scannedAt: string;
  /**
   * 0-100 score from the deep scanner, when one ran.
   *
   * Optional because receipts predate the scanner and because a scan can be
   * unavailable; absent means "no score to show", not zero.
   */
  securityScore?: number;
  /** Scanner build that produced the verdict, e.g. skill-sentry's version. */
  scannerVersion?: string;
  /** Ruleset the scanner loaded, e.g. `ruleset v1.0.0: text-rules.yaml`. */
  rulesetVersion?: string;
  /**
   * True when the scan ran inside the isolation sandbox.
   *
   * Recorded because the UI must not present a non-isolated scan as isolated
   * verification — the spec forbids overstating a degraded check.
   */
  isolated?: boolean;
  /**
   * True when the scanner fell back to its smaller built-in rules because the
   * versioned ruleset could not load (missing PyYAML).
   *
   * Persisted rather than inferred: a verdict produced by fallback rules has
   * materially weaker coverage — measured, an SSH-key exfiltration sample scores
   * ALLOW/100 on fallback rules and DO_NOT_INSTALL/20 on the real set — and the
   * spec forbids showing a degraded check as a clean pass.
   */
  rulesDegraded?: boolean;
}

/** Why a receipt no longer applies. `null` when it still does. */
export type StaleReason =
  | 'no_receipt'
  | 'payload_changed'
  | 'validator_upgraded'
  | 'ruleset_changed'
  | 'payload_unreadable';

export interface StaleVerdict {
  stale: boolean;
  reason: StaleReason | null;
}

/**
 * Current ruleset identity.
 *
 * Tied to `VALIDATOR_VERSION` today because rules ship with the validator. It
 * exists as its own field so that an independently-versioned rule pack can
 * change this without a validator bump — the receipt contract does not need to
 * change when that happens.
 */
export function currentRuleProfile(): string {
  return `builtin@${VALIDATOR_VERSION}`;
}

function _receiptsDir(uid: string): string {
  return path.join(userLocalRoot(uid), 'skill_trust');
}

function _receiptFile(uid: string, skillId: string): string {
  if (!safeId(skillId)) throw new Error('invalid skill id');
  return path.join(_receiptsDir(uid), `${skillId}.json`);
}

/** Hash a skill directory. Returns '' when unreadable or empty. */
export function skillPayloadHash(skillDir: string): string {
  try {
    return marketplaceContentTreeHash(skillDir);
  } catch {
    return '';
  }
}

export function readReceipt(uid: string, skillId: string): SecurityReceipt | null {
  if (!safeId(uid) || !safeId(skillId)) return null;
  const raw = readJsonSync<Partial<SecurityReceipt>>(_receiptFile(uid, skillId));
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.payloadHash !== 'string' || !raw.payloadHash) return null;
  if (raw.decision !== 'pass' && raw.decision !== 'risk' && raw.decision !== 'blocked') return null;
  return {
    skillId,
    payloadHash: raw.payloadHash,
    validatorVersion: String(raw.validatorVersion || ''),
    ruleProfile: String(raw.ruleProfile || ''),
    decision: raw.decision,
    violationCount: Number(raw.violationCount || 0),
    ...(typeof raw.topRule === 'string' ? { topRule: raw.topRule } : {}),
    ...(raw.topLevel === 'EXTREME' || raw.topLevel === 'MEDIUM' || raw.topLevel === 'LOW'
      ? { topLevel: raw.topLevel }
      : {}),
    scannedAt: String(raw.scannedAt || ''),
  };
}

export function writeReceipt(
  uid: string,
  skillId: string,
  input: {
    payloadHash: string;
    decision: ReceiptDecision;
    violationCount: number;
    topRule?: string;
    topLevel?: 'EXTREME' | 'MEDIUM' | 'LOW';
    securityScore?: number;
    scannerVersion?: string;
    rulesetVersion?: string;
    isolated?: boolean;
    rulesDegraded?: boolean;
  },
): SecurityReceipt {
  if (!safeId(uid)) throw new Error('invalid uid');
  const receipt: SecurityReceipt = {
    skillId,
    payloadHash: input.payloadHash,
    validatorVersion: VALIDATOR_VERSION,
    ruleProfile: currentRuleProfile(),
    decision: input.decision,
    violationCount: input.violationCount,
    ...(input.topRule ? { topRule: input.topRule } : {}),
    ...(input.topLevel ? { topLevel: input.topLevel } : {}),
    ...(typeof input.securityScore === 'number' ? { securityScore: input.securityScore } : {}),
    ...(input.scannerVersion ? { scannerVersion: input.scannerVersion } : {}),
    ...(input.rulesetVersion ? { rulesetVersion: input.rulesetVersion } : {}),
    ...(typeof input.isolated === 'boolean' ? { isolated: input.isolated } : {}),
    ...(input.rulesDegraded ? { rulesDegraded: true } : {}),
    scannedAt: nowIso(),
  };
  const file = _receiptFile(uid, skillId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeTextAtomicSync(file, JSON.stringify(receipt, null, 2));
  return receipt;
}

/**
 * Decide whether a stored verdict still applies to what is on disk now.
 *
 * Fails toward rescanning: an unreadable payload or a missing receipt is
 * always stale. A cheap wrong answer here costs one extra scan (measured in
 * milliseconds); the opposite error silently trusts content nobody checked.
 */
export function isReceiptStale(uid: string, skillId: string, skillDir: string): StaleVerdict {
  const receipt = readReceipt(uid, skillId);
  if (!receipt) return { stale: true, reason: 'no_receipt' };

  const diskHash = skillPayloadHash(skillDir);
  if (!diskHash) return { stale: true, reason: 'payload_unreadable' };
  if (diskHash !== receipt.payloadHash) return { stale: true, reason: 'payload_changed' };
  if (receipt.validatorVersion !== VALIDATOR_VERSION) {
    return { stale: true, reason: 'validator_upgraded' };
  }
  if (receipt.ruleProfile !== currentRuleProfile()) {
    return { stale: true, reason: 'ruleset_changed' };
  }
  return { stale: false, reason: null };
}

export function deleteReceipt(uid: string, skillId: string): void {
  try {
    fs.rmSync(_receiptFile(uid, skillId), { force: true });
  } catch (err) {
    log.warn('failed to delete receipt', { skillId, error: (err as Error).message });
  }
}

/** All receipts on record, for a trust/audit surface. */
export function listReceipts(uid: string): SecurityReceipt[] {
  if (!safeId(uid)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(_receiptsDir(uid)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: SecurityReceipt[] = [];
  for (const name of names) {
    const receipt = readReceipt(uid, name.slice(0, -'.json'.length));
    if (receipt) out.push(receipt);
  }
  return out.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}
