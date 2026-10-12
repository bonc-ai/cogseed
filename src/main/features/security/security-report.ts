/**
 * Security report and risk-acceptance service for the 安全与信任 page.
 *
 * WHAT THIS IS FOR
 * `sentry-adapter` answers one question — may this skill be installed — and
 * deliberately throws the evidence away (the install path asks for the verdict
 * only; the detail payload is ~150× larger). That is the right shape for a
 * gate and the wrong shape for a panel: a user looking at "78/100" needs to be
 * able to ask "why", and a security team needs the findings, not the score.
 *
 * So this module is the on-demand evidence path. It runs the same gate script
 * with `--detail`, maps the result to a renderer-safe shape, and owns the two
 * write operations the panel offers: risk acceptance and its revocation.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It never decides admission. `scanVerdictBlocksInstall` and `scan_gate.py`
 * remain the only places that rule exists; a second copy here would be the
 * weaker one eventually.
 */
import * as fs from 'node:fs';
import {
  SKILL_EXTERNAL_ID_RE, EXTERNAL_SKILL_ROOTS, resolveIdUnderBase,
  isValidSkillId, isExternalSkillId, isScannableSkillId,
} from '../skill_id';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { safeId, writeTextAtomicSync } from '../../storage';
import {
  exportSecurityPayload,
  skillSecurityReport,
  type SecurityEvidence,
} from './evidence';

export { skillSecurityReport };

const log = createLogger('security/report');

export type { SecurityEvidence } from './evidence';

/**
 * Where a skill's files live, for the sources the panel can check.
 *
 * Returned as an absolute path plus a containment-verified check, because the
 * two callers below (`fs` reads and the baseline writer) must not be able to
 * escape the skill directory through a crafted id.
 */
export interface ResolvedSkill {
  skillId: string;
  dir: string;
  source: 'marketplace' | 'builtin' | 'custom';
}

/**
 * Resolve a skill id to its directory across the three catalog sources.
 *
 * `safeId` is applied before any path join. The id arrives from the renderer,
 * and `path.join(base, '../../..')` is a valid string: without this check the
 * "check one skill" box is an arbitrary-directory scanner and the baseline
 * writer is an arbitrary-file writer.
 */
export async function resolveSkillForScan(
  skillId: string,
): Promise<ResolvedSkill | null> {
  const found = _resolveSync(skillId);
  return found ? { skillId, dir: found.dir, source: found.source } : null;
}

/** Run a full-detail scan of one installed skill. Never throws. */
export async function reportForSkill(skillId: string): Promise<{
  ok: boolean;
  reason?: string;
  evidence?: SecurityEvidence;
}> {
  const resolved = await resolveSkillForScan(skillId);
  if (!resolved) return { ok: false, reason: 'skill_not_found' };
  try {
    const evidence = await skillSecurityReport(resolved.dir, skillId);
    return {
      ok: true,
      evidence: { ...evidence, ...(isExternalSkillId(skillId) ? { externalSkill: true } : {}) },
    };
  } catch (err) {
    log.warn('security report failed', { skillId, error: (err as Error).message });
    return { ok: false, reason: 'scan_failed' };
  }
}

/** Serialize a report for download. Returns the text and a suggested filename. */
export function serializeReport(
  evidence: SecurityEvidence,
  format: 'json' | 'sarif' | 'csv' | 'markdown',
): { content: string; filename: string; mime: string } {
  const stamp = new Date().toISOString().slice(0, 10);
  switch (format) {
    case 'sarif':
      return {
        content: exportSecurityPayload(evidence, 'sarif'),
        filename: `cogseed-security-${stamp}.sarif`,
        mime: 'application/json',
      };
    case 'csv':
      return {
        content: exportSecurityPayload(evidence, 'csv'),
        filename: `cogseed-security-findings-${stamp}.csv`,
        mime: 'text/csv',
      };
    case 'markdown':
      return {
        content: exportSecurityPayload(evidence, 'markdown'),
        filename: `cogseed-security-report-${stamp}.md`,
        mime: 'text/markdown',
      };
    default:
      return {
        content: JSON.stringify(evidence, null, 2),
        filename: `cogseed-security-${stamp}.json`,
        mime: 'application/json',
      };
  }
}

/** The baseline file the engine reads, relative to the skill directory. */
const BASELINE_FILE = '.skill-sentry-baseline.json';
const MAX_BASELINE_DAYS = 365;

interface BaselineEntry {
  fingerprint: string;
  ruleId: string;
  file: string;
  reason: string;
  acceptedBy: string;
  acceptedAt: string;
  expiresAt: string;
}

interface BaselineFile {
  version: number;
  accepted: BaselineEntry[];
}

function baselinePathFor(dir: string): string {
  const target = path.join(dir, BASELINE_FILE);
  const resolvedDir = path.resolve(dir);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(resolvedDir + path.sep)) {
    throw new Error('baseline path escapes skill directory');
  }
  return resolved;
}

function readBaselineFile(dir: string): BaselineFile {
  try {
    const raw = JSON.parse(fs.readFileSync(baselinePathFor(dir), 'utf8')) as BaselineFile;
    if (!raw || !Array.isArray(raw.accepted)) return { version: 1, accepted: [] };
    return { version: 1, accepted: raw.accepted.filter((e) => e && e.fingerprint) };
  } catch {
    // Unreadable/corrupt means "nothing accepted" — the safe direction. A
    // corrupt file that made the scan fail would teach users to bypass it.
    return { version: 1, accepted: [] };
  }
}

function writeBaselineFile(dir: string, data: BaselineFile): void {
  writeTextAtomicSync(baselinePathFor(dir), `${JSON.stringify(data, null, 2)}\n`);
}

export interface AcceptInput {
  skillId: string;
  fingerprint: string;
  ruleId: string;
  file: string;
  reason: string;
  /** Days until the acceptance expires. Required, positive, bounded. */
  days: number;
  /**
   * Severity as the renderer saw it.
   *
   * A hint, not the gate: the engine refuses to suppress high/critical
   * regardless of what arrives here. This only lets main return a precise error
   * instead of writing a baseline entry the engine will ignore.
   */
  severity?: string;
}

/**
 * Record a risk acceptance for one finding.
 *
 * `days` is mandatory and bounded. "Accept forever" is the single mechanism by
 * which a temporary exception becomes permanent, so it is not expressible: the
 * caller must choose a horizon, and the engine stops honouring the entry when
 * it passes.
 */
export function acceptFinding(uid: string, input: AcceptInput): { ok: boolean; error?: string } {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  // Strict: `accept` writes `.skill-sentry-baseline.json` INSIDE the skill
  // directory. For an external skill that is `~/.claude/skills/<name>/` — the
  // user's own tooling directory, which we scan read-only and must not write.
  if (!input || !isValidSkillId(input.skillId)) {
    return { ok: false, error: isExternalSkillId(input?.skillId) ? 'external_skill_readonly' : 'invalid skill id' };
  }
  const fingerprint = String(input.fingerprint || '').trim();
  if (!/^[0-9a-f]{8,64}$/i.test(fingerprint)) return { ok: false, error: 'invalid fingerprint' };
  const reason = String(input.reason || '').trim();
  if (reason.length < 4) return { ok: false, error: 'reason_required' };
  const days = Math.floor(Number(input.days));
  if (!Number.isFinite(days) || days < 1 || days > MAX_BASELINE_DAYS) {
    return { ok: false, error: 'invalid_days' };
  }
  // Mirrors the engine's `UNSUPPRESSIBLE_SEVERITIES`. The engine remains the
  // gate (it re-checks when applying the baseline), so a renderer that lies
  // about severity gets a written entry that does nothing — not a suppressed
  // high finding.
  const severity = String(input.severity || '').toLowerCase();
  if (severity === 'high' || severity === 'critical') {
    return { ok: false, error: 'severity_not_suppressible' };
  }
  return _withSkillDir(input.skillId, (dir) => {
    const data = readBaselineFile(dir);
    const now = new Date();
    const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const entry: BaselineEntry = {
      fingerprint,
      ruleId: String(input.ruleId || ''),
      file: String(input.file || ''),
      reason,
      acceptedBy: uid,
      acceptedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    };
    data.accepted = data.accepted.filter((e) => e.fingerprint !== fingerprint);
    data.accepted.push(entry);
    writeBaselineFile(dir, data);
    log.info('risk accepted', {
      skillId: input.skillId, ruleId: entry.ruleId, days,
    });
    return { ok: true };
  });
}

/** Remove a risk acceptance. */
export function revokeFinding(uid: string, skillId: string, fingerprint: string): { ok: boolean; error?: string } {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  if (!isValidSkillId(skillId)) {
    return { ok: false, error: isExternalSkillId(skillId) ? 'external_skill_readonly' : 'invalid skill id' };
  }
  return _withSkillDir(skillId, (dir) => {
    const data = readBaselineFile(dir);
    const before = data.accepted.length;
    data.accepted = data.accepted.filter((e) => e.fingerprint !== fingerprint);
    if (data.accepted.length === before) return { ok: false, error: 'not_found' };
    writeBaselineFile(dir, data);
    return { ok: true };
  });
}

/** Acceptances on record for one skill, for the panel to render. */
export function listAcceptances(skillId: string): Array<{
  fingerprint: string; ruleId: string; file: string; reason: string;
  expiresAt: string; expired: boolean;
}> {
  const resolved = _resolveSync(skillId);
  if (!resolved) return [];
  const now = Date.now();
  return readBaselineFile(resolved.dir).accepted.map((e) => ({
    fingerprint: e.fingerprint,
    ruleId: e.ruleId,
    file: e.file,
    reason: e.reason,
    expiresAt: e.expiresAt,
    expired: !e.expiresAt || Date.parse(e.expiresAt) <= now,
  }));
}

/**
 * Everywhere a skill id can resolve to, in priority order.
 *
 * One list, used by both the report path and the baseline writer. There were
 * briefly two: the async resolver walked the catalog's `skillBaseDir` sources
 * (custom + marketplace) while the sync one also walked the packaged builtin
 * tree. Measured consequence — the panel's 详情 button worked for a marketplace
 * skill and returned `skill_not_found` for `skill-creator`, which is exactly the
 * skill a user is most likely to want to inspect. `skillBaseDir('builtin')`
 * maps onto the marketplace directory, so the packaged `builtin/system/skills`
 * tree must be added explicitly.
 */
/**
 * Whether an id may be used as a path segment under a skill root.
 *
 * Delegates to the skills feature's own validator rather than to `storage.safeId`.
 * `safeId` allows only `[A-Za-z0-9_-]+`, which rejects real catalog ids —
 * measured: 31 of 89 installed skills are named `claude:comet`, `claude:comet-build`
 * and similar, and every one of them resolved to `skill_not_found`, so neither
 * the panel's 详情 button nor the composition pass could see them.
 *
 * The security property is not the character set: it is that the joined path
 * stays inside the base directory, which `_resolveSync` checks on every
 * candidate. An id of `../../etc` fails containment whatever characters it uses.
 *
 * Falls back to a conservative pattern when the skills module is unavailable
 * (isolated test contexts), where a false negative only means "not resolvable".
 */


/**
 * Directories a skill id may resolve to.
 *
 * `prefix` marks an external root: the id form is `prefix:name`, so only the part
 * after the colon is joined — and it is validated by the same SKILL_NAME_RE shape
 * as an internal name, which is what keeps the containment check meaningful.
 */
function skillDirCandidates(): Array<{ base: string; source: ResolvedSkill['source']; prefix?: string }> {
  const out: Array<{ base: string; source: ResolvedSkill['source']; prefix?: string }> = [];
  let skills: { skillBaseDir?: (s: string) => string } = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    skills = require('../skills') as typeof skills;
  } catch { /* module unavailable in some test contexts */ }
  // Custom first: a user's own skill overrides a platform skill with the same id.
  try {
    const custom = skills.skillBaseDir?.('custom');
    if (custom) out.push({ base: custom, source: 'custom' });
  } catch { /* no active user */ }
  try {
    const marketplace = skills.skillBaseDir?.('marketplace');
    if (marketplace) out.push({ base: marketplace, source: 'marketplace' });
  } catch { /* no active user */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const paths = require('../../paths') as { packagedBuiltinDir?: () => string };
    const root = paths.packagedBuiltinDir?.();
    if (root) {
      out.push({ base: path.join(root, 'marketplace', 'skills'), source: 'builtin' });
      out.push({ base: path.join(root, 'system', 'skills'), source: 'builtin' });
    }
  } catch { /* packaged resources unavailable */ }
  // External agent skills (Claude Code, Codex). Same roots the catalog scans, so
  // an id the picker shows is an id the scanner can resolve.
  for (const { root, prefix } of EXTERNAL_SKILL_ROOTS) {
    out.push({ base: root, source: 'custom', prefix });
  }
  return out;
}

/**
 * Resolve a skill id to a directory plus its source. Synchronous because the
 * baseline helpers are called from sync contexts.
 *
 * `safeId` is applied before any join: the id arrives from the renderer, and
 * `path.join(base, '../../..')` is a perfectly valid string.
 */
function _resolveSync(skillId: string): { dir: string; source: ResolvedSkill['source'] } | null {
  if (!isScannableSkillId(skillId)) return null;
  for (const { base, source, prefix } of skillDirCandidates()) {
    let localId = skillId;
    if (prefix) {
      // An external id may only resolve under its own prefix's root.
      const m = SKILL_EXTERNAL_ID_RE.exec(skillId);
      if (!m || m[1] !== prefix) continue;
      localId = m[2];
    } else if (isExternalSkillId(skillId)) {
      continue;   // `prefix:name` never resolves under an internal root
    }
    const dir = resolveIdUnderBase(base, localId);
    if (!dir) continue;
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return { dir, source };
  }
  return null;
}

function _withSkillDir<T extends { ok: boolean; error?: string }>(
  skillId: string,
  fn: (dir: string) => T,
): T | { ok: false; error: string } {
  const resolved = _resolveSync(skillId);
  if (!resolved) return { ok: false, error: 'skill_not_found' };
  try {
    return fn(resolved.dir);
  } catch (err) {
    log.warn('baseline write failed', { skillId, error: (err as Error).message });
    return { ok: false, error: 'write_failed' };
  }
}
