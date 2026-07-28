import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// 技能↔本体绑定：原型用全局表 + 技能 ontology_refs；此处等价落
// cloud/skills/<id>/ontology/_bindings.json（该技能启用的本体 id 列表），贴合既有数据域。
function workspaceRoot(): string {
  const root = process.env.ORKAS_WORKSPACE_ROOT || '';
  if (!root) throw new Error('ORKAS_WORKSPACE_ROOT not set');
  return root;
}
function bindingsPath(uid: string, skillId: string): string {
  return path.join(workspaceRoot(), uid, 'cloud', 'skills', skillId, 'ontology', '_bindings.json');
}

export async function listOntologyBindings(uid: string, skillId: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(bindingsPath(uid, skillId), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

async function writeBindings(uid: string, skillId: string, refs: string[]): Promise<void> {
  const p = bindingsPath(uid, skillId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(refs, null, 2), 'utf-8');
}

export async function bindOntology(uid: string, skillId: string, ontologyId: string): Promise<string[]> {
  const refs = await listOntologyBindings(uid, skillId);
  if (ontologyId && !refs.includes(ontologyId)) {
    refs.push(ontologyId);
    await writeBindings(uid, skillId, refs);
  }
  return refs;
}

export async function unbindOntology(uid: string, skillId: string, ontologyId: string): Promise<string[]> {
  const refs = await listOntologyBindings(uid, skillId);
  const next = refs.filter(r => r !== ontologyId);
  if (next.length !== refs.length) await writeBindings(uid, skillId, next);
  return next;
}
