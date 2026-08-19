import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'uDir';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-space-dir-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadPaths() {
  return import('../../../src/main/paths');
}
async function loadSpaces() {
  return import('../../../src/main/features/spaces');
}
/** 激活用户（跑全部迁移，含空间目录命名迁移）。 */
async function activate() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
}

describe('sanitizeSpaceDirName（纯函数）', () => {
  it('非法字符 → _，去首尾空白/结尾点号，空回退 sid，Windows 保留名前缀 _，超长截断', async () => {
    const paths = await loadPaths();
    const f = paths.sanitizeSpaceDirName;
    expect(f('A/B:C*D?"E<F>G|H', 'sp_x')).toBe('A_B_C_D__E_F_G_H');
    expect(f('  ', 'sp_x')).toBe('sp_x');
    expect(f('名字...', 'sp_x')).toBe('名字');
    expect(f('con', 'sp_x')).toBe('_con');
    expect(f('NUL', 'sp_x')).toBe('_NUL');
    expect(f('x'.repeat(80), 'sp_x')).toBe('x'.repeat(60));
    expect(f('正常名字', 'sp_x')).toBe('正常名字');
  });
});

describe('空间内容目录命名（目录名 = 空间名）', () => {
  it('createSpace → 建「空间名」目录 + .space-id 标记绑定 sid', async () => {
    await activate();
    const spaces = await loadSpaces();
    const paths = await loadPaths();
    const created = await spaces.createSpace(UID, { name: '论文空间' });
    if (!created.ok) throw new Error('create failed');
    const sid = created.space.space_id;

    const dir = paths.spaceContentDir(UID, sid);
    expect(path.basename(dir)).toBe('论文空间');
    expect(fs.readFileSync(path.join(dir, paths.SPACE_DIR_MARKER), 'utf8').trim()).toBe(sid);
    // 旧 <sid> 目录不应存在
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'spaces', sid))).toBe(false);
  });

  it('净化后重名的两个空间 → 后建者目录加「 (2)」后缀，标记各自绑定', async () => {
    await activate();
    const spaces = await loadSpaces();
    const paths = await loadPaths();
    const a = await spaces.createSpace(UID, { name: 'A/B' });   // 净化 → A_B
    const b = await spaces.createSpace(UID, { name: 'A:B' });   // 净化 → A_B
    if (!a.ok || !b.ok) throw new Error('create failed');

    const dirA = paths.spaceContentDir(UID, a.space.space_id);
    const dirB = paths.spaceContentDir(UID, b.space.space_id);
    expect(path.basename(dirA)).toBe('A_B');
    expect(path.basename(dirB)).toBe('A_B (2)');
    expect(fs.readFileSync(path.join(dirA, paths.SPACE_DIR_MARKER), 'utf8').trim()).toBe(a.space.space_id);
    expect(fs.readFileSync(path.join(dirB, paths.SPACE_DIR_MARKER), 'utf8').trim()).toBe(b.space.space_id);
  });

  it('改名 → 目录名跟随；文件保留；旧名目录消失', async () => {
    await activate();
    const spaces = await loadSpaces();
    const paths = await loadPaths();
    const created = await spaces.createSpace(UID, { name: '旧名字' });
    if (!created.ok) throw new Error('create failed');
    const sid = created.space.space_id;
    const dirBefore = paths.spaceContentDir(UID, sid);
    fs.mkdirSync(path.join(dirBefore, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(dirBefore, 'workspace', '成果.docx'), 'x');

    const renamed = await spaces.updateSpace(UID, sid, { name: '新名字' });
    expect(renamed.ok).toBe(true);

    const dirAfter = paths.spaceContentDir(UID, sid);
    expect(path.basename(dirAfter)).toBe('新名字');
    expect(fs.existsSync(path.join(dirAfter, 'workspace', '成果.docx'))).toBe(true);
    expect(fs.existsSync(dirBefore)).toBe(false);
    expect(fs.readFileSync(path.join(dirAfter, paths.SPACE_DIR_MARKER), 'utf8').trim()).toBe(sid);
  });

  it('存量 <sid> 目录（无标记）可读可用；激活时迁移为「空间名」目录并写标记（幂等）', async () => {
    // 模拟旧数据：先建 <sid> 目录 + meta（在 activateUser 之前）
    const sid = 'sp_legacy001';
    const spacesRoot = path.join(tmpDir, UID, 'cloud', 'spaces');
    const legacyDir = path.join(spacesRoot, sid);
    fs.mkdirSync(path.join(legacyDir, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'workspace', '成果.docx'), 'x');
    fs.mkdirSync(spacesRoot, { recursive: true });
    fs.writeFileSync(path.join(spacesRoot, `${sid}.json`), JSON.stringify({
      space_id: sid, name: '旧空间', extra_skills: [], extra_agents: [],
      secondary_template_ids: [], created_at: '2026-08-01T00:00:00', updated_at: '2026-08-01T00:00:00',
    }));

    // 激活触发迁移
    await activate();
    const paths = await loadPaths();
    const dir = paths.spaceContentDir(UID, sid);
    expect(path.basename(dir)).toBe('旧空间');
    expect(fs.existsSync(path.join(dir, 'workspace', '成果.docx'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, paths.SPACE_DIR_MARKER), 'utf8').trim()).toBe(sid);
    expect(fs.existsSync(legacyDir)).toBe(false);

    // 幂等：再跑一次不报错、目录不变
    const mig = await import('../../../src/main/util/migrate-space-dir');
    expect(() => mig.migrateSpaceDirNames(UID)).not.toThrow();
    expect(path.basename(paths.spaceContentDir(UID, sid))).toBe('旧空间');
  });

  it('同名目录冲突 → 迁移时自动加「 (2)」后缀，不覆盖既有目录', async () => {
    const sid = 'sp_legacy002';
    const spacesRoot = path.join(tmpDir, UID, 'cloud', 'spaces');
    // 另一个空间已占用「撞名」目录名（带标记、不同 sid）
    fs.mkdirSync(path.join(spacesRoot, '撞名'), { recursive: true });
    fs.writeFileSync(path.join(spacesRoot, '撞名', '.space-id'), 'sp_other\n');
    const legacyDir = path.join(spacesRoot, sid);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(spacesRoot, `${sid}.json`), JSON.stringify({
      space_id: sid, name: '撞名', extra_skills: [], extra_agents: [],
      secondary_template_ids: [], created_at: '2026-08-01T00:00:00', updated_at: '2026-08-01T00:00:00',
    }));

    await activate();
    const paths = await loadPaths();
    expect(path.basename(paths.spaceContentDir(UID, sid))).toBe('撞名 (2)');
    expect(fs.readFileSync(path.join(paths.spaceContentDir(UID, sid), paths.SPACE_DIR_MARKER), 'utf8').trim()).toBe(sid);
  });

  it('迁移失败（目录被占用）→ 保持旧 <sid> 目录，解析回退仍可用', async () => {
    await activate();
    const paths = await loadPaths();
    const spacesRoot = path.join(tmpDir, UID, 'cloud', 'spaces');
    const sid = 'sp_legacy003';
    const legacyDir = path.join(spacesRoot, sid);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'data.txt'), 'x');
    fs.writeFileSync(path.join(spacesRoot, `${sid}.json`), JSON.stringify({
      space_id: sid, name: '占位空间', extra_skills: [], extra_agents: [],
      secondary_template_ids: [], created_at: '2026-08-01T00:00:00', updated_at: '2026-08-01T00:00:00',
    }));

    const mig = await import('../../../src/main/util/migrate-space-dir');
    // spaces 根只读 → renameSync 真实失败（EACCES），迁移只告警不抛出
    fs.chmodSync(spacesRoot, 0o555);
    try {
      expect(() => mig.migrateSpaceDirNames(UID)).not.toThrow();
    } finally {
      fs.chmodSync(spacesRoot, 0o755);
    }
    // 无标记 → 回退 <sid> 目录，数据仍可读
    expect(paths.spaceContentDir(UID, sid)).toBe(path.join(spacesRoot, sid));
    expect(fs.existsSync(path.join(legacyDir, 'data.txt'))).toBe(true);
  });

  it('deleteSpace → 命名目录被删除', async () => {
    await activate();
    const spaces = await loadSpaces();
    const paths = await loadPaths();
    const created = await spaces.createSpace(UID, { name: '待删目录空间' });
    if (!created.ok) throw new Error('create failed');
    const sid = created.space.space_id;
    const dirBefore = paths.spaceContentDir(UID, sid);
    expect(fs.existsSync(dirBefore)).toBe(true);

    const del = await spaces.deleteSpace(UID, sid);
    expect(del.ok).toBe(true);
    expect(fs.existsSync(dirBefore)).toBe(false);
  });
});
