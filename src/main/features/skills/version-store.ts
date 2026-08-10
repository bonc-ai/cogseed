import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function workspaceRoot(): string {
  const root = process.env.ORKAS_WORKSPACE_ROOT || '';
  if (!root) throw new Error('ORKAS_WORKSPACE_ROOT not set');
  return root;
}

function versionsDir(uid: string): string {
  return path.join(workspaceRoot(), uid, 'local', 'skills', 'versions');
}

function legacyVersionsDir(uid: string): string {
  return path.join(workspaceRoot(), uid, 'local', 'kstar', 'versions');
}

function versionsPath(uid: string, skillId: string): string {
  return path.join(versionsDir(uid), `${skillId}.json`);
}

function legacyVersionsPath(uid: string, skillId: string): string {
  return path.join(legacyVersionsDir(uid), `${skillId}.json`);
}

export interface SkillVersionRecord {
  version: string;
  at: string;
  note?: string;
  runId?: string;
  content?: string;
  canRollback: boolean;
}

function normalizeVersionRecord(row: unknown): SkillVersionRecord | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const item = row as Partial<SkillVersionRecord>;
  if (typeof item.version !== 'string' || typeof item.at !== 'string') return null;
  const content = typeof item.content === 'string' ? item.content : undefined;
  return {
    version: item.version,
    at: item.at,
    ...(typeof item.note === 'string' ? { note: item.note } : {}),
    ...(typeof item.runId === 'string' ? { runId: item.runId } : {}),
    ...(content !== undefined ? { content } : {}),
    canRollback: content !== undefined,
  };
}

async function readVersionFile(file: string): Promise<SkillVersionRecord[]> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeVersionRecord).filter((item): item is SkillVersionRecord => !!item) : [];
  } catch {
    return [];
  }
}

export async function listSkillVersions(uid: string, skillId: string): Promise<SkillVersionRecord[]> {
  const current = await readVersionFile(versionsPath(uid, skillId));
  if (current.length > 0) return current;
  return readVersionFile(legacyVersionsPath(uid, skillId));
}

export async function appendSkillVersion(
  uid: string,
  skillId: string,
  entry: { version: string; note?: string; runId?: string; content?: string },
): Promise<SkillVersionRecord[]> {
  const list = await listSkillVersions(uid, skillId);
  const content = typeof entry.content === 'string' ? entry.content : undefined;
  list.unshift({
    version: entry.version,
    at: new Date().toISOString(),
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
    ...(content !== undefined ? { content } : {}),
    canRollback: content !== undefined,
  });
  const p = versionsPath(uid, skillId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(list, null, 2), 'utf-8');
  return list;
}
