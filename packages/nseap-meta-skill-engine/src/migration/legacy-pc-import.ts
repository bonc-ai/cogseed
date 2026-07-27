/**
 * Legacy PC skill import
 * Import SKILL.md from PC to draft snapshot with high confidence detection
 */
import type { SkillSnapshot } from '../types/snapshot.js';
import { stableHash } from '../persistence/canonical-json.js';

interface LegacyFrontmatter {
  name?: string;
  description?: string;
  category?: string;
  [key: string]: any;
}

/**
 * Import legacy PC SKILL.md to draft snapshot
 */
export function importLegacySkill(skillMdContent: string, skillId: string): SkillSnapshot {
  const frontmatter = parseFrontmatter(skillMdContent);
  const now = new Date().toISOString();

  const snapshot: SkillSnapshot = {
    skill_id: skillId,
    generation: 1,
    snapshot_hash: '',
    episodes: [],
    created_at: now,
    updated_at: now
  };

  // Extract metadata from frontmatter
  if (frontmatter.name) snapshot.name = frontmatter.name;
  if (frontmatter.description) snapshot.description = frontmatter.description;
  if (frontmatter.category) snapshot.category = frontmatter.category;

  // Compute hash
  snapshot.snapshot_hash = computeHash(snapshot);

  return snapshot;
}

/**
 * Determine if legacy skill should be imported with high confidence
 */
export function shouldImportWithHighConfidence(skillMdContent: string): boolean {
  const frontmatter = parseFrontmatter(skillMdContent);

  // High confidence requires:
  // 1. Valid frontmatter exists
  // 2. Has a name field
  // 3. Content has substance (more than just frontmatter)

  if (!frontmatter) return false;
  if (!frontmatter.name || frontmatter.name.trim() === '') return false;

  const contentWithoutFrontmatter = skillMdContent.replace(/^---\n[\s\S]*?\n---\n/, '');
  if (contentWithoutFrontmatter.trim().length < 10) return false;

  return true;
}

/**
 * Parse YAML frontmatter from SKILL.md
 */
function parseFrontmatter(content: string): LegacyFrontmatter {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return {};

  const yamlContent = frontmatterMatch[1];
  const frontmatter: LegacyFrontmatter = {};

  // Simple YAML parser for key: value pairs
  const lines = yamlContent.split('\n');
  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      frontmatter[key] = value.trim();
    }
  }

  return frontmatter;
}

/**
 * Compute hash for snapshot
 */
function computeHash(snapshot: SkillSnapshot): string {
  const { snapshot_hash, ...hashable } = snapshot;
  return stableHash(hashable);
}
