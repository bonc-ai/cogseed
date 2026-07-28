import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import AdmZip from 'adm-zip';

// 技能导出:把 cloud/skills/<id>/ 目录打成 zip 落 local/kstar/exports/<id>-v<ver>.zip。
// 复用仓库既有 adm-zip 依赖,不引新包。
function workspaceRoot(): string {
  const root = process.env.ORKAS_WORKSPACE_ROOT || '';
  if (!root) throw new Error('ORKAS_WORKSPACE_ROOT not set');
  return root;
}
function skillDir(uid: string, skillId: string): string {
  return path.join(workspaceRoot(), uid, 'cloud', 'skills', skillId);
}
function exportsDir(uid: string): string {
  return path.join(workspaceRoot(), uid, 'local', 'kstar', 'exports');
}

export async function exportSkillZip(
  uid: string, skillId: string, version: string,
): Promise<{ ok: boolean; zipPath: string; error?: string }> {
  const src = skillDir(uid, skillId);
  const stat = await fs.stat(src).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return { ok: false, zipPath: '', error: 'skill directory not found' };
  }
  const outDir = exportsDir(uid);
  await fs.mkdir(outDir, { recursive: true });
  const safeVer = (version || '0.0.0').replace(/[^0-9.]/g, '') || '0.0.0';
  const zipPath = path.join(outDir, `${skillId}-v${safeVer}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(src);
  zip.writeZip(zipPath);
  return { ok: true, zipPath };
}
