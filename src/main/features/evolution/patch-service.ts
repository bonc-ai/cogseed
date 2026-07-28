import { writeSkillFileForEdit } from '../skills';

type WriteFn = (skillId: string, file: string, content: string) => Promise<boolean>;

/** semver patch 位 +1。空/非法 → 0.1.0。 */
export function bumpSemver(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec((v || '').trim());
  if (!m) return '0.1.0';
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** 替换/插入 frontmatter 的 version 行；不改 status（production 晋升需人工另走）。 */
function withBumpedVersion(content: string): { content: string; newVersion: string } {
  const verLine = /version:\s*([0-9.]+)/.exec(content);
  const current = verLine ? verLine[1] : '';
  const next = bumpSemver(current);
  if (verLine) {
    return { content: content.replace(/version:\s*[0-9.]+/, `version: ${next}`), newVersion: next };
  }
  // 无 version 行：加在开头（若有 frontmatter 分隔则插入其内）。
  return { content: `version: ${next}\n${content}`, newVersion: next };
}

interface ApplyInput { skillId: string; newContent: string; writeFn?: WriteFn; }

/**
 * Apply 步：把改进正文写进 SKILL.md 并 bump semver。
 * 不自动把 status 改成 production——晋升需人工（治理 promotion_ceiling）。
 */
export async function applyPatchToSkill(
  _uid: string, input: ApplyInput,
): Promise<{ ok: boolean; newVersion: string }> {
  const write = input.writeFn ?? ((id, file, content) => writeSkillFileForEdit(id, file, content));
  const { content, newVersion } = withBumpedVersion(input.newContent);
  const ok = await write(input.skillId, 'SKILL.md', content);
  return { ok, newVersion };
}
