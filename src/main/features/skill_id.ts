/**
 * Skill-id contract, shared by the catalog, the security scanner, and the trust
 * receipt store.
 *
 * Leaf module on purpose: it imports nothing, so both `skills.ts` and
 * `skill_trust.ts` can use it. `skills.ts` already imports `skill_trust.ts`, so a
 * direct edge in the other direction would be a cycle.
 *
 * Three id shapes exist, and they are NOT interchangeable:
 *
 *   hex        `9720e1e263fd`            marketplace-installed (server-assigned)
 *   name       `code-review-helper`      user-created custom skill
 *   external   `claude:pdf-tools`        Claude Code / Codex skill on disk
 *
 * `external` is deliberately kept out of `isValidSkillId`: that predicate gates
 * IPC handlers that MUTATE state (`skills.security.accept` writes a baseline file
 * *inside the skill directory* — for an external skill that would be
 * `~/.claude/skills/<name>/`, a directory that is not ours to write). Read-only
 * surfaces use `isScannableSkillId` instead.
 */

import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Roots of external agent-skill installations.
 *
 * Single source of truth on purpose: the catalog lists exactly what the security
 * scanner can resolve. When these were defined separately, the picker listed
 * external skills that the scanner then rejected with "invalid skill id".
 *
 * The part after the colon must match SKILL_NAME_RE — those directories contain
 * one subdirectory per skill, and that shape is what makes the join safe.
 */
export const EXTERNAL_SKILL_ROOTS: ReadonlyArray<{ root: string; prefix: string; label: string }> = [
  { root: path.join(os.homedir(), '.claude', 'skills'), prefix: 'claude', label: 'Claude' },
  { root: path.join(os.homedir(), '.codex', 'skills', '.system'), prefix: 'codex', label: 'Codex' },
];

const HEX_ID_RE = /^[a-f0-9]{12}$/;
/** Letter-led, no spaces. Also used by SKILL.md authoring validation. */
export const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
/**
 * External agent skills. The suffix reuses the same shape as `SKILL_NAME_RE`,
 * which cannot contain `/`, `\` or `.` — so accepting this form does not widen
 * the path-traversal surface that `safeId` guards.
 */
export const SKILL_EXTERNAL_ID_RE = /^(claude|codex):([A-Za-z][A-Za-z0-9_-]*)$/;

/** Internal skill id: marketplace hex or a user-created name. Mutating IPC only. */
export function isValidSkillId(id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  return HEX_ID_RE.test(id) || SKILL_NAME_RE.test(id);
}

export function isExternalSkillId(id: unknown): boolean {
  return typeof id === 'string' && SKILL_EXTERNAL_ID_RE.test(id);
}

/** Internal or external: usable on read-only surfaces (scan, report, receipts). */
export function isScannableSkillId(id: unknown): boolean {
  return isValidSkillId(id) || isExternalSkillId(id);
}

/**
 * Filesystem-safe file stem for a skill id, or null when the id is not valid.
 *
 * `safeId` rejects `:`, so an external id cannot be a filename as-is. Encode it
 * as `prefix.name`. `.` never occurs in a hex or name id — both are drawn from
 * `[A-Za-z0-9_-]` — so the encoded form cannot collide with an internal id, and
 * the mapping stays injective.
 */
export function skillIdToFileStem(id: unknown): string | null {
  if (typeof id !== 'string' || !id) return null;
  const external = SKILL_EXTERNAL_ID_RE.exec(id);
  if (external) return `${external[1]}.${external[2]}`;
  return isValidSkillId(id) ? id : null;
}

/**
 * Resolve `localId` under `base`, or null when it escapes.
 *
 * The `..` guard is the point: ids arrive from the renderer, and
 * `path.join(base, '../../..')` is a perfectly valid string. Because a valid
 * `localId` (hex, name or an external suffix) is drawn from `[A-Za-z0-9_-]`, it
 * can never contain a separator — this check is the belt to that suspenders.
 */
export function resolveIdUnderBase(base: string, localId: string): string | null {
  if (!localId || localId.includes('/') || localId.includes('\\')) return null;
  const resolvedBase = path.resolve(base);
  const dir = path.resolve(path.join(base, localId));
  if (dir === resolvedBase || !dir.startsWith(resolvedBase + path.sep)) return null;
  return dir;
}

/**
 * Inverse of `skillIdToFileStem`.
 *
 * Receipt files are listed by scanning a directory, so the stem has to be turned
 * back into the id that the rest of the app uses — otherwise an external receipt
 * surfaces as `claude.foo` and every later lookup misses.
 */
const EXTERNAL_STEM_RE = /^(claude|codex)\.([A-Za-z][A-Za-z0-9_-]*)$/;

export function fileStemToSkillId(stem: unknown): string | null {
  if (typeof stem !== 'string' || !stem) return null;
  const external = EXTERNAL_STEM_RE.exec(stem);
  if (external) return `${external[1]}:${external[2]}`;
  return isValidSkillId(stem) ? stem : null;
}
