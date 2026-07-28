import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// 技能版本历史:每次 Apply bump semver 后追加一条,落 local/kstar/versions/<id>.json。
// 派生的机器态 → local(与引擎快照并列)。
function workspaceRoot(): string {
  const root = process.env.ORKAS_WORKSPACE_ROOT || '';
  if (!root) throw new Error('ORKAS_WORKSPACE_ROOT not set');
  return root;
}
function versionsDir(uid: string): string {
  return path.join(workspaceRoot(), uid, 'local', 'kstar', 'versions');
}
function versionsPath(uid: string, skillId: string): string {
  return path.join(versionsDir(uid), `${skillId}.json`);
}

export interface SkillVersionRecord {
  version: string;
  at: string;
  note?: string;
  runId?: string;
}

export async function listSkillVersions(uid: string, skillId: string): Promise<SkillVersionRecord[]> {
  try {
    const raw = await fs.readFile(versionsPath(uid, skillId), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export async function appendSkillVersion(
  uid: string, skillId: string, entry: { version: string; note?: string; runId?: string },
): Promise<SkillVersionRecord[]> {
  const list = await listSkillVersions(uid, skillId);
  list.unshift({ version: entry.version, at: new Date().toISOString(), note: entry.note, runId: entry.runId });
  const p = versionsPath(uid, skillId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(list, null, 2), 'utf-8');
  return list;
}
