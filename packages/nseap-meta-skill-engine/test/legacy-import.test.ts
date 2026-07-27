/**
 * Test: Legacy PC skill import
 */
import { describe, it, expect } from 'vitest';
import { importLegacySkill, shouldImportWithHighConfidence } from '../src/migration/legacy-pc-import';

describe('Legacy PC skill import', () => {
  const validLegacySkillMd = `---
name: legacy-skill
description: A legacy skill from PC
---

# Legacy Skill

This is the legacy skill content.

## Usage

Use this skill when...
`;

  const minimalLegacySkillMd = `---
name: minimal-skill
---

Minimal content.
`;

  it('should import valid legacy SKILL.md to draft snapshot', () => {
    const result = importLegacySkill(validLegacySkillMd, 'legacy-skill-id');

    expect(result.skill_id).toBe('legacy-skill-id');
    expect(result.generation).toBe(1);
    expect(result.name).toBe('legacy-skill');
    expect(result.description).toBe('A legacy skill from PC');
    expect(result.episodes).toEqual([]);
  });

  it('should extract name from frontmatter', () => {
    const result = importLegacySkill(validLegacySkillMd, 'test-id');
    expect(result.name).toBe('legacy-skill');
  });

  it('should extract description from frontmatter', () => {
    const result = importLegacySkill(validLegacySkillMd, 'test-id');
    expect(result.description).toBe('A legacy skill from PC');
  });

  it('should handle minimal legacy skill', () => {
    const result = importLegacySkill(minimalLegacySkillMd, 'minimal-id');
    expect(result.skill_id).toBe('minimal-id');
    expect(result.name).toBe('minimal-skill');
    expect(result.description).toBeUndefined();
  });

  it('should return high confidence for well-formed legacy skills', () => {
    const confidence = shouldImportWithHighConfidence(validLegacySkillMd);
    expect(confidence).toBe(true);
  });

  it('should return low confidence for malformed content', () => {
    const malformedContent = 'Just some text without frontmatter';
    const confidence = shouldImportWithHighConfidence(malformedContent);
    expect(confidence).toBe(false);
  });

  it('should return low confidence for empty frontmatter', () => {
    const emptyFrontmatter = `---
---

Content without name.
`;
    const confidence = shouldImportWithHighConfidence(emptyFrontmatter);
    expect(confidence).toBe(false);
  });

  it('should create snapshot with stable hash', () => {
    const result = importLegacySkill(validLegacySkillMd, 'hash-test');
    expect(result.snapshot_hash).toBeTruthy();
    expect(typeof result.snapshot_hash).toBe('string');
  });

  it('should set timestamps on import', () => {
    const result = importLegacySkill(validLegacySkillMd, 'timestamp-test');
    expect(result.created_at).toBeTruthy();
    expect(result.updated_at).toBeTruthy();
  });
});
