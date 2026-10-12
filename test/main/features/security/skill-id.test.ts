import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  EXTERNAL_SKILL_ROOTS, SKILL_EXTERNAL_ID_RE,
  fileStemToSkillId, isExternalSkillId, isScannableSkillId, isValidSkillId,
  resolveIdUnderBase, skillIdToFileStem,
} from '../../../../src/main/features/skill_id';

/**
 * The skill-id contract is a security boundary, so these tests pin the parts
 * that are easy to widen by accident.
 *
 * The bug this file exists for: the picker listed external Claude Code / Codex
 * skills (44 of them on the reporter's machine) and every 详情 / 检查 click failed
 * with a thrown "invalid skill id" — the id form `claude:<name>` never passed
 * `isValidSkillId`, so the scanner could not resolve it.
 *
 * The fix must NOT be "accept the colon everywhere": `skills.security.accept`
 * writes `.skill-sentry-baseline.json` INSIDE the skill directory, which for an
 * external skill is the user's own `~/.claude/skills/<name>/`.
 */

const HEX = '9720e1e263fd';
const NAME = 'code-review-helper';
const EXTERNAL = ['claude:pdf-tools', 'codex:meeting-actions'];

describe('skill id contract', () => {
  it('accepts the two internal id shapes as valid', () => {
    expect(isValidSkillId(HEX)).toBe(true);
    expect(isValidSkillId(NAME)).toBe(true);
  });

  it('keeps external ids OUT of isValidSkillId so mutating handlers reject them', () => {
    // `isValidSkillId` gates skills.security.accept / revoke, which write into the
    // skill directory. Widening it would make an external skill writable.
    for (const id of EXTERNAL) {
      expect(isValidSkillId(id)).toBe(false);
      expect(isExternalSkillId(id)).toBe(true);
      expect(isScannableSkillId(id)).toBe(true);
    }
  });

  it('accepts internal ids on the read-only predicate too', () => {
    expect(isScannableSkillId(HEX)).toBe(true);
    expect(isScannableSkillId(NAME)).toBe(true);
  });

  it('rejects traversal and malformed ids', () => {
    const bad = [
      '', '   ', null, undefined, 42, {},
      '../../../etc/passwd',
      '..',
      'claude:',
      ':pdf-tools',
      'claude:../evil',
      'claude:a/b',
      'claude:a\\b',
      'claude:a.b',
      'claude:..',
      'claude: pdf',
      'Claude:pdf-tools',      // prefix is lower-case only
      'claude:1abc',           // suffix must be letter-led
      'shell:pdf-tools',       // unknown prefix
      'claude:pdf-tools:extra',
      `${HEX}0`,               // 13 hex chars
      '9720E1E263FD',          // upper-case hex is not the server shape
      '1abc',                  // name must be letter-led
    ];
    for (const id of bad) {
      expect(isValidSkillId(id), `isValidSkillId(${String(id)})`).toBe(false);
      expect(isScannableSkillId(id), `isScannableSkillId(${String(id)})`).toBe(false);
      expect(skillIdToFileStem(id), `skillIdToFileStem(${String(id)})`).toBeNull();
    }
  });

  it('exposes the same roots the catalog scans, with safe prefixes', () => {
    expect(EXTERNAL_SKILL_ROOTS.length).toBeGreaterThan(0);
    for (const { root, prefix, label } of EXTERNAL_SKILL_ROOTS) {
      expect(root).toContain(prefix === 'claude' ? '.claude' : '.codex');
      expect(label).toBeTruthy();
      // The prefix must round-trip through the id regex, otherwise the catalog
      // would list ids the scanner cannot resolve — the original bug.
      expect(SKILL_EXTERNAL_ID_RE.test(`${prefix}:probe`)).toBe(true);
    }
  });
});

describe('skill id → receipt file stem', () => {
  it('encodes external ids by replacing the separator with a dot', () => {
    expect(skillIdToFileStem('claude:pdf-tools')).toBe('claude.pdf-tools');
    expect(skillIdToFileStem('codex:meeting-actions')).toBe('codex.meeting-actions');
  });

  it('passes internal ids through unchanged', () => {
    expect(skillIdToFileStem(HEX)).toBe(HEX);
    expect(skillIdToFileStem(NAME)).toBe(NAME);
  });

  it('is injective: no internal id can look like an encoded external one', () => {
    // Internal ids are drawn from [A-Za-z0-9_-] and can never contain a dot, so
    // `claude.pdf-tools` has exactly one origin.
    expect(isValidSkillId('claude.pdf-tools')).toBe(false);
    expect(skillIdToFileStem('claude.pdf-tools')).toBeNull();
    expect(fileStemToSkillId('claude.pdf-tools')).toBe('claude:pdf-tools');
  });

  it('round-trips every valid id (the receipt directory is listed by filename)', () => {
    for (const id of [HEX, NAME, ...EXTERNAL]) {
      const stem = skillIdToFileStem(id);
      expect(stem, `stem for ${id}`).not.toBeNull();
      expect(fileStemToSkillId(stem), `round-trip for ${id}`).toBe(id);
    }
  });

  it('rejects stems that are neither a valid id nor a known encoding', () => {
    for (const stem of ['', 'a.b.c', 'claude.', '.foo', 'claude:pdf-tools', 'other.foo', '1abc']) {
      expect(fileStemToSkillId(stem), `fileStemToSkillId(${stem})`).toBeNull();
    }
  });
});

describe('resolveIdUnderBase', () => {
  const base = path.resolve('/tmp/skills');

  it('resolves a plain child', () => {
    expect(resolveIdUnderBase(base, 'pdf-tools')).toBe(path.join(base, 'pdf-tools'));
  });

  it('refuses anything that escapes the base', () => {
    for (const localId of ['..', '../evil', '../../etc/passwd', 'a/b', 'a\\b', '/etc/passwd', '']) {
      expect(resolveIdUnderBase(base, localId), `resolveIdUnderBase(${localId})`).toBeNull();
    }
  });

  it('refuses the base itself', () => {
    expect(resolveIdUnderBase(base, '.')).toBeNull();
  });
});
