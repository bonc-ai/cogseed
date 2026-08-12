import { writeSkillFileForEdit } from '../skills';
import { appendSkillVersion, listSkillVersions } from './version-store';

type WriteFn = (skillId: string, file: string, content: string) => Promise<boolean>;
type AppendVersionFn = (uid: string, skillId: string, entry: { version: string; note?: string; runId?: string; content?: string }) => Promise<unknown>;

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
