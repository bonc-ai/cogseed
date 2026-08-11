import { writeSkillFileForEdit } from '../skills';
import { appendSkillVersion, listSkillVersions } from './versions-store';
import { validateSkillPatchContent, type ValidationBoundary, type ValidationStatus } from '../p3394/skill-validation-run';

type WriteFn = (skillId: string, file: string, content: string) => Promise<boolean>;
type AppendVersionFn = (uid: string, skillId: string, entry: { version: string; note?: string; runId?: string; content?: string }) => Promise<unknown>;

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
  // 无 version 行：若有标准 frontmatter，插入 opening delimiter 后；否则保留旧格式兼容。
  if (content.startsWith('---\n')) return { content: `---\nversion: ${next}\n${content.slice(4)}`, newVersion: next };
  if (content.startsWith('---\r\n')) return { content: `---\r\nversion: ${next}\r\n${content.slice(5)}`, newVersion: next };
  return { content: `version: ${next}\n${content}`, newVersion: next };
}

interface ApplyInput { skillId: string; newContent: string; note?: string; runId?: string; writeFn?: WriteFn; appendVersionFn?: AppendVersionFn; validationBoundary?: ValidationBoundary; }

/**
 * Apply 步：把改进正文写进 SKILL.md 并 bump semver，成功后追加一条版本历史。
 * 不自动把 status 改成 production——晋升需人工（治理 promotion_ceiling）。
 */
export async function applyPatchToSkill(
  uid: string, input: ApplyInput,
): Promise<{ ok: boolean; newVersion: string; validationId: string; validationStatus: ValidationStatus }> {
  const write = input.writeFn ?? ((id, file, content) => writeSkillFileForEdit(id, file, content));
  const appendVersion = input.appendVersionFn ?? appendSkillVersion;
  const { content, newVersion } = withBumpedVersion(input.newContent);
  const validation = await validateSkillPatchContent(uid, input.skillId, content, input.validationBoundary || 'real');
  if (validation.status === 'blocked') {
    return { ok: false, newVersion, validationId: validation.validationId, validationStatus: validation.status };
  }
  const ok = await write(input.skillId, 'SKILL.md', content);
  if (ok) {
    await appendVersion(uid, input.skillId, { version: newVersion, note: input.note, runId: input.runId, content });
  }
  return { ok, newVersion, validationId: validation.validationId, validationStatus: validation.status };
}

export interface RollbackSkillInput {
  skillId: string;
  version: string;
  writeFn?: WriteFn;
  appendVersionFn?: AppendVersionFn;
  listVersionsFn?: (uid: string, skillId: string) => Promise<Array<{ version: string; at: string; note?: string; runId?: string; content?: string; canRollback?: boolean }>>;
}

export async function rollbackSkillToVersion(
  uid: string,
  input: RollbackSkillInput,
): Promise<{ ok: boolean; skillId: string; version: string }> {
  const skillId = input.skillId;
  const version = String(input.version || '').trim();
  if (!skillId || !version) throw new Error('missing skill rollback target');
  const listVersions = input.listVersionsFn ?? listSkillVersions;
  const write = input.writeFn ?? ((id, file, content) => writeSkillFileForEdit(id, file, content));
  const appendVersion = input.appendVersionFn ?? appendSkillVersion;
  const versions = await listVersions(uid, skillId);
  const target = versions.find((item) => item.version === version && typeof item.content === 'string');
  if (!target || typeof target.content !== 'string') throw new Error('skill version is not rollbackable');
  const ok = await write(skillId, 'SKILL.md', target.content);
  if (!ok) return { ok: false, skillId, version };
  await appendVersion(uid, skillId, {
    version,
    note: `Rollback to ${version}`,
    runId: target.runId,
    content: target.content,
  });
  return { ok: true, skillId, version };
}
