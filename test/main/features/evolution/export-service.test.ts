import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { exportSkillZip } from '../../../../src/main/features/evolution/export-service';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-'));
  process.env.ORKAS_WORKSPACE_ROOT = dir;
  // 造一个技能目录 cloud/skills/sk1/SKILL.md
  const skillDir = path.join(dir, 'u1', 'cloud', 'skills', 'sk1');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'version: 0.2.0\n---\n技能正文', 'utf-8');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); delete process.env.ORKAS_WORKSPACE_ROOT; });

describe('export-service', () => {
  it('把技能目录打成 zip 落 local/kstar/exports 并返回路径', async () => {
    const r = await exportSkillZip('u1', 'sk1', '0.2.0');
    expect(r.ok).toBe(true);
    expect(r.zipPath).toContain(path.join('local', 'kstar', 'exports'));
    // zip 实际存在且含 SKILL.md
    const stat = await fs.stat(r.zipPath);
    expect(stat.size).toBeGreaterThan(0);
    const zip = new AdmZip(r.zipPath);
    const names = zip.getEntries().map(e => e.entryName);
    expect(names).toContain('SKILL.md');
  });

  it('技能目录不存在时 ok:false', async () => {
    const r = await exportSkillZip('u1', 'nonexistent', '0.1.0');
    expect(r.ok).toBe(false);
  });
});
