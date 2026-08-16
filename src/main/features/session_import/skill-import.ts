/**
 * Claude Code skill import (closed loop C).
 *
 * Claude Code stores user skills as:
 *   `~/.claude/skills/<skill-name>/SKILL.md`
 * with YAML frontmatter (`name`, `description`) + a markdown body, optionally
 * alongside helper files in the same directory.
 *
 * Our skill library has no single "create with body + files" call, so import
 * is a compose of the real public API:
 *   1. `createCustomSkill(name, description, category)` — makes the skill dir
 *      + a skeleton SKILL.md (status 'approved').
 *   2. `writeSkillFileForEdit(skillId, 'SKILL.md', fullMd)` — overwrites with
 *      the imported frontmatter + body (path-checked, normalized on write).
 *   3. `writeSkillFileForEdit(skillId, rel, content)` per helper file.
 *
 * Boundaries:
 *   - READ-ONLY on `~/.claude/skills`. Never writes to Claude's storage.
 *   - Best-effort. A malformed skill dir is skipped, not fatal.
 *   - Preview (`listClaudeSkills`, metadata only) is separate from import.
 *   - Helper files are bounded (count + size) so a huge/hostile skill dir
 *     can't blow memory.
 *   - Idempotent: importing a skill whose target name already exists is
 *     reported as `already_exists` rather than erroring or duplicating.
 *
 * Scheduled tasks: Claude Code has no native on-disk scheduled-task store, so
 * there is deliberately no Claude task reader. The onboarding UI shows an
 * honest "no native source" state for tasks rather than fabricating any.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';

import {
  createCustomSkill,
  writeSkillFileForEdit,
  getCustomSkill,
  parseSkillFrontmatter,
  deleteCustomSkill,
} from '../skills';
import { ensureNseapSkillSkeleton } from '../nseap_skill_skeleton';
import { userSkillsDir } from '../../paths';
import { getActiveUserId } from '../users';
import { createLogger } from '../../logger';

const log = createLogger('session-import:skill-import');

/** Max helper files copied per skill, and max bytes per file. */
const MAX_HELPER_FILES = 40;
const MAX_FILE_BYTES = 512 * 1024; // 512 KiB

export interface ClaudeSkillSummary {
  /** Directory name under ~/.claude/skills (the natural skill id/name). */
  dirName: string;
  /** Frontmatter name, falling back to dirName. */
  name: string;
  /** Frontmatter description, or ''. */
  description: string;
  /** Absolute path to the skill directory. */
  dirPath: string;
}

function claudeSkillsRoot(home = os.homedir()): string {
  return path.join(home, '.claude', 'skills');
}

/** Split a SKILL.md into frontmatter meta + body. Tolerant of a missing
 *  frontmatter block (whole text becomes the body). */
function splitFrontmatter(text: string): { meta: ReturnType<typeof parseSkillFrontmatter>; body: string } {
  // parseSkillFrontmatter expects the FULL text (it locates the `---` fences
  // itself). Body is whatever follows the closing fence.
  const meta = parseSkillFrontmatter(text);
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return { meta, body: m ? m[1] : text };
}

/**
 * List importable Claude Code skills (metadata only, READ-ONLY).
 * Returns [] when `~/.claude/skills` is absent (Claude unused / no skills).
 */
export async function listClaudeSkills(): Promise<ClaudeSkillSummary[]> {
  const root = claudeSkillsRoot();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.info('~/.claude/skills not found — no Claude skills to import');
      return [];
    }
    log.warn('failed to scan ~/.claude/skills', { error: String(err) });
    return [];
  }

  const skills: ClaudeSkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(root, entry.name);
    let text: string;
    try {
      text = await fsp.readFile(path.join(dirPath, 'SKILL.md'), 'utf8');
    } catch {
      continue; // no SKILL.md — not a valid skill dir, skip
    }
    const { meta } = splitFrontmatter(text);
    skills.push({
      dirName: entry.name,
      name: (typeof meta.name === 'string' && meta.name.trim()) || entry.name,
      description: (typeof meta.description === 'string' && meta.description.trim()) || '',
      dirPath,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Collect bounded helper files (everything except SKILL.md) as relative-path
 *  content pairs. Skips oversized files and stops at the file-count cap. */
async function collectHelperFiles(dirPath: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];

  async function walk(rel: string): Promise<void> {
    if (files.length >= MAX_HELPER_FILES) return;
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fsp.readdir(path.join(dirPath, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (files.length >= MAX_HELPER_FILES) return;
      const childRel = rel ? path.join(rel, d.name) : d.name;
      if (d.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (childRel.toUpperCase() === 'SKILL.MD') continue; // body handled separately
      const childAbs = path.join(dirPath, childRel);
      try {
        const stat = await fsp.stat(childAbs);
        if (stat.size > MAX_FILE_BYTES) {
          log.warn('skipping oversized skill helper file', { file: childRel, size: stat.size });
          continue;
        }
        files.push({
          path: childRel.split(path.sep).join('/'),
          content: await fsp.readFile(childAbs, 'utf8'),
        });
      } catch (err) {
        log.warn('failed to read skill helper file', { file: childRel, error: String(err) });
      }
    }
  }

  await walk('');
  return files;
}

export interface ImportSkillResult {
  ok: boolean;
  skillId?: string;
  name: string;
  /** Set on failure or when the skill already existed (still counts as present). */
  reason?: string;
}

/**
 * Import one Claude Code skill (by directory name) into our skill library.
 * `dirName` must be one returned by `listClaudeSkills`; we re-resolve it under
 * the skills root and reject anything that escapes it (path-traversal
 * backstop).
 */
export async function importClaudeSkill(dirName: string): Promise<ImportSkillResult> {
  const root = claudeSkillsRoot();
  const dirPath = path.resolve(root, dirName);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!dirPath.startsWith(rootWithSep)) {
    return { ok: false, name: dirName, reason: 'out_of_bounds' };
  }

  let text: string;
  try {
    text = await fsp.readFile(path.join(dirPath, 'SKILL.md'), 'utf8');
  } catch {
    return { ok: false, name: dirName, reason: 'no_skill_md' };
  }

  const { meta } = splitFrontmatter(text);
  const name = (typeof meta.name === 'string' && meta.name.trim()) || dirName;
  const description = (typeof meta.description === 'string' && meta.description.trim()) || '';

  // Idempotency: a same-named skill already in the library means this was
  // imported before — report it, don't duplicate or throw.
  const existing = await getCustomSkill(name);
  if (existing) {
    return { ok: true, skillId: existing.id, name, reason: 'already_exists' };
  }

  let skillId: string;
  try {
    const created = await createCustomSkill(name, description, '');
    if (!created) return { ok: false, name, reason: 'create_returned_null' };
    skillId = created.id;
  } catch (err) {
    log.warn('failed to create skill skeleton', { name, error: String(err) });
    return { ok: false, name, reason: 'create_failed' };
  }

  // Overwrite the skeleton SKILL.md with the imported frontmatter + body.
  const wroteMd = await writeSkillFileForEdit(skillId, 'SKILL.md', text);
  if (!wroteMd) {
    log.warn('failed to write imported SKILL.md body', { skillId, name });
    return { ok: false, skillId, name, reason: 'write_body_failed' };
  }

  // Copy helper files, best-effort per file.
  const files = await collectHelperFiles(dirPath);
  let helperFails = 0;
  for (const f of files) {
    const ok = await writeSkillFileForEdit(skillId, f.path, f.content);
    if (!ok) helperFails += 1;
  }

  // NSEAP skeleton conversion: auto-generate the missing standard artifacts
  // (same as the skill-library import path — onboarding-imported skills must
  // be NSEAP-compliant too).
  try {
    ensureNseapSkillSkeleton(path.join(userSkillsDir(getActiveUserId()), skillId), name);
  } catch (err) {
    log.warn('session-import nseap skeleton generation failed', { skillId, error: String(err) });
  }

  log.info(`imported claude skill "${name}" as ${skillId} (files=${files.length}, helperFails=${helperFails})`);
  return _admitImportedSkill(skillId, name, 'claude');
}

/**
 * W1 generation gate: admit an onboarding-imported skill before reporting it
 * as done. Rollback on refusal — the imported content is third-party, so the
 * import fails closed exactly like the skill-library import path. `unknown`
 * (scanner unavailable) fails closed too: nothing claims to be checked.
 */
async function _admitImportedSkill(
  skillId: string,
  name: string,
  source: 'claude' | 'codex',
): Promise<ImportSkillResult> {
  try {
    const { admitCustomSkill } = await import('../security/custom-skill-admission');
    const admission = await admitCustomSkill(getActiveUserId(), skillId);
    if (admission.outcome === 'blocked' || admission.outcome === 'unknown') {
      await deleteCustomSkill(skillId);
      log.warn(`${source}-import skill refused by admission gate`, {
        skillId, outcome: admission.outcome, reason: admission.reason,
      });
      return {
        ok: false, skillId, name,
        reason: admission.outcome === 'unknown' ? 'security_unavailable' : 'security_blocked',
      };
    }
  } catch (err) {
    log.warn(`${source}-import skill admission failed`, { skillId, error: String(err) });
    try { await deleteCustomSkill(skillId); } catch { /* best effort */ }
    return { ok: false, skillId, name, reason: 'security_unavailable' };
  }
  return { ok: true, skillId, name };
}

/** Import a batch of Claude skills by dir name. Best-effort per skill. */
export async function importClaudeSkills(
  dirNames: string[],
): Promise<{ imported: ImportSkillResult[]; okCount: number; failCount: number }> {
  const imported: ImportSkillResult[] = [];
  for (const dirName of dirNames) {
    imported.push(await importClaudeSkill(dirName));
  }
  const okCount = imported.filter((r) => r.ok).length;
  return { imported, okCount, failCount: imported.length - okCount };
}

// ──────────────────────────────────────────────────────────────────────────
// Codex skill import
// ──────────────────────────────────────────────────────────────────────────

export interface CodexSkillSummary {
  /** Directory name under ~/.codex/skills/.system */
  dirName: string;
  /** Frontmatter name, falling back to dirName. */
  name: string;
  /** Frontmatter description, or ''. */
  description: string;
  /** Absolute path to the skill directory. */
  dirPath: string;
}

function codexSkillsRoot(home = os.homedir()): string {
  return path.join(home, '.codex', 'skills', '.system');
}

/**
 * List importable Codex skills (metadata only, READ-ONLY).
 * Returns [] when `~/.codex/skills/.system` is absent.
 */
export async function listCodexSkills(): Promise<CodexSkillSummary[]> {
  const root = codexSkillsRoot();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.info('~/.codex/skills/.system not found — no Codex skills to import');
      return [];
    }
    log.warn('failed to scan ~/.codex/skills/.system', { error: String(err) });
    return [];
  }

  const skills: CodexSkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden marker files
    if (entry.name.startsWith('.')) continue;

    const dirPath = path.join(root, entry.name);
    let text: string;
    try {
      text = await fsp.readFile(path.join(dirPath, 'SKILL.md'), 'utf8');
    } catch {
      continue; // no SKILL.md — not a valid skill dir, skip
    }
    const { meta } = splitFrontmatter(text);
    skills.push({
      dirName: entry.name,
      name: (typeof meta.name === 'string' && meta.name.trim()) || entry.name,
      description: (typeof meta.description === 'string' && meta.description.trim()) || '',
      dirPath,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Import one Codex skill (by directory name) into our skill library.
 */
export async function importCodexSkill(dirName: string): Promise<ImportSkillResult> {
  const root = codexSkillsRoot();
  const dirPath = path.resolve(root, dirName);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!dirPath.startsWith(rootWithSep)) {
    return { ok: false, name: dirName, reason: 'out_of_bounds' };
  }

  let text: string;
  try {
    text = await fsp.readFile(path.join(dirPath, 'SKILL.md'), 'utf8');
  } catch {
    return { ok: false, name: dirName, reason: 'no_skill_md' };
  }

  const { meta } = splitFrontmatter(text);
  const name = (typeof meta.name === 'string' && meta.name.trim()) || dirName;
  const description = (typeof meta.description === 'string' && meta.description.trim()) || '';

  // Idempotency check
  const existing = await getCustomSkill(name);
  if (existing) {
    return { ok: true, skillId: existing.id, name, reason: 'already_exists' };
  }

  let skillId: string;
  try {
    const created = await createCustomSkill(name, description, '');
    if (!created) return { ok: false, name, reason: 'create_returned_null' };
    skillId = created.id;
  } catch (err) {
    log.warn('failed to create skill skeleton', { name, error: String(err) });
    return { ok: false, name, reason: 'create_failed' };
  }

  // Overwrite with imported content
  const wroteMd = await writeSkillFileForEdit(skillId, 'SKILL.md', text);
  if (!wroteMd) {
    log.warn('failed to write imported SKILL.md body', { skillId, name });
    return { ok: false, skillId, name, reason: 'write_body_failed' };
  }

  // Copy helper files
  const files = await collectHelperFiles(dirPath);
  let helperFails = 0;
  for (const f of files) {
    const ok = await writeSkillFileForEdit(skillId, f.path, f.content);
    if (!ok) helperFails += 1;
  }

  // NSEAP skeleton conversion: auto-generate the missing standard artifacts
  // (same as the skill-library import path — onboarding-imported skills must
  // be NSEAP-compliant too).
  try {
    ensureNseapSkillSkeleton(path.join(userSkillsDir(getActiveUserId()), skillId), name);
  } catch (err) {
    log.warn('session-import nseap skeleton generation failed', { skillId, error: String(err) });
  }

  log.info(`imported codex skill "${name}" as ${skillId} (files=${files.length}, helperFails=${helperFails})`);
  return _admitImportedSkill(skillId, name, 'codex');
}

/** Import a batch of Codex skills by dir name. Best-effort per skill. */
export async function importCodexSkills(
  dirNames: string[],
): Promise<{ imported: ImportSkillResult[]; okCount: number; failCount: number }> {
  const imported: ImportSkillResult[] = [];
  for (const dirName of dirNames) {
    imported.push(await importCodexSkill(dirName));
  }
  const okCount = imported.filter((r) => r.ok).length;
  return { imported, okCount, failCount: imported.length - okCount };
}
