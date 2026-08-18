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
import * as crypto from 'node:crypto';
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
  /**
   * Which rule set produced this verdict.
   *
   * `deep` means the full skill-sentry ruleset ran; `local` means only the
   * built-in regex subset did, because the scanner was unavailable. The two are
   * not equivalent — a payload in `tests/` is blocked by the former and passes
   * the latter — so a `local` receipt is weaker evidence and must be
   * distinguishable rather than presented as an equally trustworthy pass.
   *
   * Optional: receipts written before this field existed lack it, and are
   * treated as `local` (the conservative reading, since deep scanning at
   * re-verification time did not exist when they were written).
   */
  scanner?: 'deep' | 'local';
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
  /**
   * Attack-surface counts from the deep scan.
   *
   * Counts and categories only — never the matched source text, which may itself
   * be the credential that was about to leak (the same rule the import-time
   * reason lines follow).
   *
   * Persisted so the panel can explain a *passing* verdict, not just a rejected
   * one. Before this, a blocked import listed its egress and dynamic-exec points
   * while an installed skill showed nothing: the product explained itself when
   * refusing the user and went silent when protecting them. A clean scan that
   * found one persistence point is still worth showing.
   */
  attackSurface?: {
    egressPoints: number;
    dynamicExecPoints: number;
    persistencePoints: number;
    hasBinaries: boolean;
  };
  /**
   * Instruction-type risk carried over from the scan.
   *
   * Persisted because the panel reads receipts, not live scans: without this a
   * finding would exist only for the moment of install and vanish from the
   * skill's record. Segments are kept so the panel can quote the passage — a
   * bare "suspicious" gives the user nothing to judge, and this verdict is
   * surfaced for judgement rather than enforced.
   */
  instructionRisk?: {
    status: 'clean' | 'suspicious' | 'unavailable';
    segments: Array<{ file: string; line: number; text: string; signal: string }>;
  };
  /**
   * NSEAP security-declaration check, from the security-core engine.
   *
   * ADVISORY ONLY — this never changes `decision`.
   *
   * What the engine actually checks is narrower than its name suggests, and the
   * difference matters: it validates the *declaration's internal consistency* —
   * whether the manifest's own fields contradict each other, and whether required
   * entries are present and non-placeholder. It does NOT read the skill's code.
   *
   * Measured, so it is not mistaken for a stronger guarantee later: a manifest
   * declaring `network.enabled: false` alongside a bundled script that calls
   * `requests.post` returns PASS. `SEC-NETWORK-003` — the rule that sounds like it
   * would catch this — tests `actions.allowed[].external_network`, another
   * declared field. Code behaviour is the deep scanner's job and stays that way;
   * a `pass` here means "the paperwork is coherent", never "the code was checked".
   *
   * So a mismatch is an authoring gap, and a skill can be perfectly safe with no
   * declaration at all — which is why this never touches the verdict.
   *
   * `absent` is the common case and is deliberately distinct from `pass`: no
   * shipped skill carries a security manifest today, and reporting "checked and
   * clean" for a file that does not exist would be a false claim. `unavailable`
   * means the engine itself could not run — infrastructure failure, never
   * evidence about the content.
   *
   * Findings are capped and carry rule ids plus messages so a panel can explain
   * the gap; the engine's own verdict string is kept for diagnosis.
   */
  nseapDeclaration?: {
    status: 'pass' | 'pass_with_warnings' | 'needs_input' | 'mismatch' | 'absent' | 'unavailable';
    /** The engine's own result string, when it produced a parseable report. */
    engineResult?: string;
    findings?: Array<{ ruleId: string; severity: string; message: string }>;
  };
  /**
   * The install happened because the user accepted a risk the gate had refused.
   *
   * Persisted so the skill panel can keep saying so. Without it an override
   * would be invisible a day later: the skill would sit in the list looking like
   * any other, and the one fact worth remembering about it — that nothing
   * verified it and someone chose to proceed — would be gone.
   *
   * `outcome` is the verdict that was waived, kept because "user accepted a
   * risk" is not actionable on its own; which risk is the part worth showing.
   */
  userOverride?: {
    outcome: string;
    at: number;
  };
  /**
   * Hash over the skill's DECLARED dependencies: the "External dependencies"
   * section of SKILL.md plus any dependency-manifest files (requirements.txt,
   * package.json, pyproject.toml, ...). Spec §4.4 binds the verdict to this
   * dimension so a dependency-only republish is distinguishable in audit.
   *
   * Evidence field, not a gate: the payload tree hash already covers these
   * files, so `payload_changed` fires first when they change. Recording the
   * dimension separately costs nothing and keeps receipts exportable against
   * the spec's field list without inventing a second gate.
   */
  dependencyHash?: string;
  /**
   * Hash over the skill's declared permissions: `schemas.json.runtime_contracts`
   * canonicalized. `'none'` is the constant for skills without a schema — a
   * distinct value, never a false "matches".
   */
  permissionHash?: string;
}

/** Why a receipt no longer applies. `null` when it still does. */
export type StaleReason =
  | 'no_receipt'
  | 'payload_changed'
  | 'validator_upgraded'
  | 'ruleset_changed'
  | 'payload_unreadable'
  // The security scanner is verified by pinned tree hash rather than by content
  // scanning (see features/scanner_trust). These record which of those checks
  // applied, so a scanner admitted without a pin is distinguishable in an audit
  // from one whose hash actually matched.
  | 'scanner_unpinned'
  | 'scanner_tampered'
  | 'scanner_unreadable';

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

function _receiptFile(uid: string, skillId: string, agentId?: string): string {
  if (!safeId(skillId)) throw new Error('invalid skill id');
  // Agent-private skills share a skillId namespace with standalone installs
  // (`userMarketplaceAgentSkillsDir`), so their receipts are namespaced by
  // agent: `${agentId}__${skillId}.json`. Without the prefix a private skill
  // that shadows a standalone id would verify the WRONG bytes — the exact
  // trap documented in skill-registry's private branch.
  const name = agentId ? `${agentId}__${skillId}.json` : `${skillId}.json`;
  return path.join(_receiptsDir(uid), name);
}

const DEP_MANIFEST_NAMES: ReadonlySet<string> = new Set([
  'requirements.txt', 'package.json', 'package-lock.json', 'yarn.lock',
  'pyproject.toml', 'Pipfile', 'Pipfile.lock', 'Gemfile', 'Gemfile.lock',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'composer.json', 'composer.lock',
]);

/** Value recorded when a skill declares no machine-readable permissions. */
export const PERMISSION_HASH_NONE = 'none';

function _hashText(parts: string[]): string {
  return `sha256:${crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex')}`;
}

/** Stable serialization for hashing: keys sorted at every depth, so the same
 *  semantic object hashes identically regardless of key order in the file. */
function _stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(_stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${_stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash over the skill's DECLARED dependencies: the "External dependencies"
 * section of SKILL.md plus any dependency-manifest files. Bounded: a hostile
 * tree cannot grow the scan unboundedly (each manifest is capped at 64KiB and
 * at most 32 manifests are read).
 */
export function currentDependencyHash(skillDir: string): string {
  const parts: string[] = [];
  const manifests: Array<{ rel: string; content: string }> = [];
  const walk = (dir: string, rel: string): void => {
    if (manifests.length >= 32) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (manifests.length >= 32) return;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const full = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, childRel); continue; }
      if (!DEP_MANIFEST_NAMES.has(e.name.toLowerCase())) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > 64 * 1024) continue;
        manifests.push({ rel: childRel, content: fs.readFileSync(full, 'utf8') });
      } catch { /* unreadable manifest is simply not part of the hash */ }
    }
  };
  walk(skillDir, '');
  manifests.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const m of manifests) parts.push(`@@${m.rel}
${m.content}`);
  // The declared-dependencies section of SKILL.md, when present.
  try {
    const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const section = /(?:##|#)\s*External dependencies?[^\n]*\n([\s\S]*?)(?=\n##|\n#|$)/i.exec(md);
    if (section) parts.push(`@@SKILL.md#deps
${section[1].trim()}`);
  } catch { /* no SKILL.md — nothing to add */ }
  return _hashText(parts);
}

/**
 * Hash over the skill's declared permissions: `schemas.json.runtime_contracts`
 * canonicalized (sorted keys, stable serialization). `PERMISSION_HASH_NONE`
 * when the skill declares none — a distinct value, never a false match.
 */
export function currentPermissionHash(skillDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(skillDir, 'schemas.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return PERMISSION_HASH_NONE;
    const rc = (parsed as Record<string, unknown>).runtime_contracts;
    if (!rc || typeof rc !== 'object') return PERMISSION_HASH_NONE;
    return _hashText([_stableStringify(rc)]);
  } catch {
    return PERMISSION_HASH_NONE;
  }
}

/** Hash a skill directory. Returns '' when unreadable or empty. */
export function skillPayloadHash(skillDir: string): string {
  try {
    return marketplaceContentTreeHash(skillDir);
  } catch {
    return '';
  }
}

/**
 * Validate a persisted attack surface, or return nothing.
 *
 * All-or-nothing on purpose: a surface with one unreadable count would otherwise
 * render that count as 0, and "0 egress points" claims a clean result where the
 * truth is "we could not read it".
 */
function _readAttackSurface(raw: unknown): { attackSurface?: SecurityReceipt['attackSurface'] } {
  if (!raw || typeof raw !== 'object') return {};
  const s = raw as Record<string, unknown>;
  const count = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e6 ? v : null;
  const egressPoints = count(s.egressPoints);
  const dynamicExecPoints = count(s.dynamicExecPoints);
  const persistencePoints = count(s.persistencePoints);
  if (egressPoints === null || dynamicExecPoints === null || persistencePoints === null) return {};
  if (typeof s.hasBinaries !== 'boolean') return {};
  return {
    attackSurface: { egressPoints, dynamicExecPoints, persistencePoints, hasBinaries: s.hasBinaries },
  };
}

/**
 * Validate a persisted instruction-risk block.
 *
 * Unknown status strings are dropped rather than passed through: the panel keys
 * its wording off this value, and an unrecognised status would render as neither
 * a warning nor a clean result. Segments are rebuilt field by field — they
 * originate in skill text, i.e. untrusted input, and they are echoed to the UI.
 */
function _readInstructionRisk(raw: unknown): { instructionRisk?: SecurityReceipt['instructionRisk'] } {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  if (r.status !== 'clean' && r.status !== 'suspicious' && r.status !== 'unavailable') return {};
  const segments = Array.isArray(r.segments)
    ? r.segments.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      if (typeof e.file !== 'string' || typeof e.text !== 'string') return [];
      const line = typeof e.line === 'number' && Number.isInteger(e.line) && e.line > 0
        ? e.line
        : 1;
      return [{
        file: e.file.slice(0, 256),
        line,
        text: e.text.slice(0, 400),
        signal: typeof e.signal === 'string' ? e.signal.slice(0, 64) : 'unknown',
      }];
    })
    : [];
  return { instructionRisk: { status: r.status, segments } };
}

/**
 * Validate a persisted NSEAP declaration record.
 *
 * Status is whitelisted for the same reason as `instructionRisk`: the panel keys
 * its wording off this value, and an unrecognised status would render as neither
 * a warning nor a clean result. Findings are rebuilt field by field and capped —
 * their messages quote the skill's own manifest, i.e. untrusted input that is
 * echoed to the UI, and an engine run on a pathological tree could otherwise
 * produce an unbounded list.
 */
const _NSEAP_STATUSES = new Set([
  'pass', 'pass_with_warnings', 'needs_input', 'mismatch', 'absent', 'unavailable',
]);
const _NSEAP_FINDING_CAP = 20;

function _readNseapDeclaration(raw: unknown): { nseapDeclaration?: SecurityReceipt['nseapDeclaration'] } {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== 'string' || !_NSEAP_STATUSES.has(r.status)) return {};
  const status = r.status as NonNullable<SecurityReceipt['nseapDeclaration']>['status'];
  const findings = Array.isArray(r.findings)
    ? r.findings.slice(0, _NSEAP_FINDING_CAP).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      if (typeof e.ruleId !== 'string' || !e.ruleId) return [];
      return [{
        ruleId: e.ruleId.slice(0, 64),
        severity: typeof e.severity === 'string' ? e.severity.slice(0, 32) : 'unknown',
        message: typeof e.message === 'string' ? e.message.slice(0, 400) : '',
      }];
    })
    : [];
  return {
    nseapDeclaration: {
      status,
      ...(typeof r.engineResult === 'string' && r.engineResult
        ? { engineResult: r.engineResult.slice(0, 64) }
        : {}),
      ...(findings.length ? { findings } : {}),
    },
  };
}

/**
 * Validate a persisted override record.
 *
 * Dropped entirely when malformed rather than partially reconstructed: a record
 * claiming an override with no readable verdict would render as a warning with
 * nothing behind it, which is worse than no warning at all.
 */
function _readUserOverride(raw: unknown): { userOverride?: SecurityReceipt['userOverride'] } {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  if (typeof o.outcome !== 'string' || !o.outcome) return {};
  const at = typeof o.at === 'number' && Number.isFinite(o.at) && o.at > 0 ? o.at : 0;
  if (!at) return {};
  return { userOverride: { outcome: o.outcome.slice(0, 64), at } };
}

export function readReceipt(uid: string, skillId: string, agentId?: string): SecurityReceipt | null {
  if (!safeId(uid) || !safeId(skillId)) return null;
  if (agentId !== undefined && !safeId(agentId)) return null;
  const raw = readJsonSync<Partial<SecurityReceipt>>(_receiptFile(uid, skillId, agentId));
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
    // Must be read back, not just written: the deep re-verification path decides
    // whether to reuse a receipt by checking this field, so dropping it here
    // would make every receipt look local-only and force a full rescan on every
    // single check. Anything other than the literal 'deep' is treated as local —
    // receipts predating this field then read as the weaker, conservative value.
    ...(raw.scanner === 'deep' || raw.scanner === 'local' ? { scanner: raw.scanner } : {}),
    // Deep-scan disclosures. Same reason: this function rebuilds the object from
    // an allowlist, so a field absent here is invisible to every caller no matter
    // what was written. The skills panel reads all five to state how strong the
    // check was — a score, which ruleset ran, and whether the run was isolated —
    // and omitting them silently downgraded every badge to a bare verdict.
    ...(typeof raw.securityScore === 'number' && Number.isFinite(raw.securityScore)
      ? { securityScore: raw.securityScore } : {}),
    ...(typeof raw.scannerVersion === 'string' && raw.scannerVersion
      ? { scannerVersion: raw.scannerVersion } : {}),
    ...(typeof raw.rulesetVersion === 'string' && raw.rulesetVersion
      ? { rulesetVersion: raw.rulesetVersion } : {}),
    ...(typeof raw.isolated === 'boolean' ? { isolated: raw.isolated } : {}),
    // Only `true` is carried: absent and false both mean "rules were fine", and
    // a malformed value must not read as a degradation that did not happen.
    ...(raw.rulesDegraded === true ? { rulesDegraded: true } : {}),
    // Every count is validated individually and the whole object dropped if any
    // is unusable: a partially-read surface would render as "0 egress points",
    // which reads as a stronger result than "unknown".
    ...(_readAttackSurface(raw.attackSurface)),
    ...(_readInstructionRisk(raw.instructionRisk)),
    ...(_readNseapDeclaration(raw.nseapDeclaration)),
    ...(_readUserOverride(raw.userOverride)),
    ...(typeof raw.dependencyHash === 'string' && raw.dependencyHash
      ? { dependencyHash: raw.dependencyHash } : {}),
    ...(typeof raw.permissionHash === 'string' && raw.permissionHash
      ? { permissionHash: raw.permissionHash } : {}),
    scannedAt: String(raw.scannedAt || ''),
  };
}

/**
 * Persist a verdict.
 *
 * NOTE for anyone adding a field: a receipt field has to be declared in FOUR
 * independent allowlists before a user can see it, and skipping any one of them
 * fails silently — no type error, the value simply vanishes.
 *
 *   1. `SecurityReceipt` (the shape)
 *   2. this function's `input` type and its spread below (write)
 *   3. `readReceipt`'s rebuild (read — it reconstructs from an allowlist and
 *      drops anything unlisted)
 *   4. the `security` view in `features/skills.ts` (forward to the renderer)
 *
 * Every field added during this work — `scanner`, then the four disclosure
 * fields, then `attackSurface` — was initially lost at one of these layers and
 * only found by asserting the value in the UI rather than at the write site. Add
 * a round-trip test with each new field; a write-side assertion alone will pass
 * while the panel still shows nothing.
 */
export function writeReceipt(
  uid: string,
  skillId: string,
  input: {
    payloadHash: string;
    decision: ReceiptDecision;
    violationCount: number;
    topRule?: string;
    topLevel?: 'EXTREME' | 'MEDIUM' | 'LOW';
    scanner?: 'deep' | 'local';
    securityScore?: number;
    scannerVersion?: string;
    rulesetVersion?: string;
    isolated?: boolean;
    rulesDegraded?: boolean;
    attackSurface?: SecurityReceipt['attackSurface'];
    instructionRisk?: SecurityReceipt['instructionRisk'];
    nseapDeclaration?: SecurityReceipt['nseapDeclaration'];
    userOverride?: SecurityReceipt['userOverride'];
    dependencyHash?: string;
    permissionHash?: string;
  },
  agentId?: string,
): SecurityReceipt {
  if (!safeId(uid)) throw new Error('invalid uid');
  if (agentId !== undefined && !safeId(agentId)) throw new Error('invalid agent id');
  const receipt: SecurityReceipt = {
    skillId,
    payloadHash: input.payloadHash,
    validatorVersion: VALIDATOR_VERSION,
    ruleProfile: currentRuleProfile(),
    decision: input.decision,
    violationCount: input.violationCount,
    ...(input.topRule ? { topRule: input.topRule } : {}),
    ...(input.topLevel ? { topLevel: input.topLevel } : {}),
    ...(input.scanner ? { scanner: input.scanner } : {}),
    ...(typeof input.securityScore === 'number' ? { securityScore: input.securityScore } : {}),
    ...(input.scannerVersion ? { scannerVersion: input.scannerVersion } : {}),
    ...(input.rulesetVersion ? { rulesetVersion: input.rulesetVersion } : {}),
    ...(typeof input.isolated === 'boolean' ? { isolated: input.isolated } : {}),
    ...(input.rulesDegraded ? { rulesDegraded: true } : {}),
    ...(input.attackSurface ? { attackSurface: { ...input.attackSurface } } : {}),
    ...(input.instructionRisk ? { instructionRisk: input.instructionRisk } : {}),
    ...(input.nseapDeclaration ? { nseapDeclaration: input.nseapDeclaration } : {}),
    ...(input.userOverride ? { userOverride: input.userOverride } : {}),
    ...(input.dependencyHash ? { dependencyHash: input.dependencyHash } : {}),
    ...(input.permissionHash ? { permissionHash: input.permissionHash } : {}),
    scannedAt: nowIso(),
  };
  const file = _receiptFile(uid, skillId, agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeTextAtomicSync(file, JSON.stringify(receipt, null, 2));
  return receipt;
}

/**
 * Persist an install-time scan verdict as a receipt.
 *
 * Shared by both install paths so they cannot drift. Marketplace installs wrote
 * this inline and custom-skill imports wrote nothing at all: the import DID deep
 * scan (and rolls the whole batch back on `blocked`), but discarded the result,
 * so an imported skill had no baseline hash. Without one, tamper detection has
 * nothing to compare against and post-import edits go unnoticed — the scan was
 * a one-time toast rather than a durable fact.
 *
 * Returns `null` on failure instead of throwing: a receipt is an audit and
 * staleness aid, not part of the gate. The scan already ran and passed by the
 * time this is called, so a bookkeeping error must not fail a real install.
 */
export function writeInstallReceipt(
  uid: string,
  skillId: string,
  payloadHash: string,
  scan: {
    outcome: string;
    score?: number;
    scannerVersion?: string;
    rulesetVersion?: string;
    isolated?: boolean;
    rulesDegraded?: boolean;
    attackSurface?: SecurityReceipt['attackSurface'];
    instructionRisk?: SecurityReceipt['instructionRisk'];
    userOverride?: SecurityReceipt['userOverride'];
  },
  violations: { violationCount: number; topRule?: string; topLevel?: 'EXTREME' | 'MEDIUM' | 'LOW' },
  agentId?: string,
  skillDir?: string,
): SecurityReceipt | null {
  try {
    return writeReceipt(uid, skillId, {
      payloadHash,
      // The SCAN's verdict, not the structural report's. Callers only reach here
      // on `pass` or `restricted` — `blocked` and `unknown` are refused upstream.
      // `restricted` is the spec's Medium state: installed, but shown as a risk
      // card rather than a clean badge.
      decision: scan.outcome === 'restricted' ? 'risk' : 'pass',
      violationCount: violations.violationCount,
      ...(violations.topRule ? { topRule: violations.topRule } : {}),
      ...(violations.topLevel ? { topLevel: violations.topLevel } : {}),
      // `deep` only when a deep scan actually ran. `scanner_absent` means the
      // build ships without the deep scanner and only local red lines were
      // applied, so recording `deep` there would put a "full scan" badge on a
      // skill that never had one — the receipt is what the badge and the audit
      // trail read, so this is the one place that claim must be true.
      scanner: scan.outcome === 'scanner_absent' ? 'local' : 'deep',
      ...(typeof scan.score === 'number' ? { securityScore: scan.score } : {}),
      ...(scan.scannerVersion ? { scannerVersion: scan.scannerVersion } : {}),
      ...(scan.rulesetVersion ? { rulesetVersion: scan.rulesetVersion } : {}),
      ...(typeof scan.isolated === 'boolean' ? { isolated: scan.isolated } : {}),
      ...(scan.rulesDegraded ? { rulesDegraded: true } : {}),
      ...(scan.attackSurface ? { attackSurface: { ...scan.attackSurface } } : {}),
      ...(scan.instructionRisk ? { instructionRisk: scan.instructionRisk } : {}),
      ...(scan.userOverride ? { userOverride: scan.userOverride } : {}),
      ...(skillDir ? { dependencyHash: currentDependencyHash(skillDir) } : {}),
      ...(skillDir ? { permissionHash: currentPermissionHash(skillDir) } : {}),
    }, agentId);
  } catch (err) {
    log.warn('failed to write install security receipt', {
      skillId, error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Decide whether a stored verdict still applies to what is on disk now.
 *
 * Fails toward rescanning: an unreadable payload or a missing receipt is
 * always stale. A cheap wrong answer here costs one extra scan (measured in
 * milliseconds); the opposite error silently trusts content nobody checked.
 */
export function isReceiptStale(uid: string, skillId: string, skillDir: string, agentId?: string): StaleVerdict {
  const receipt = readReceipt(uid, skillId, agentId);
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

export function deleteReceipt(uid: string, skillId: string, agentId?: string): void {
  try {
    fs.rmSync(_receiptFile(uid, skillId, agentId), { force: true });
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
    // Private receipts (`agentId__skillId.json`) are not part of the public
    // trust list — they describe agent-bundled skills and would read as
    // unrelated skill ids here.
    if (name.includes('__')) continue;
    const receipt = readReceipt(uid, name.slice(0, -'.json'.length));
    if (receipt) out.push(receipt);
  }
  return out.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}
