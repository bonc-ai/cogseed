import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 契约测试：空间绑定的本地项目目录（Codex 式工作区）。
//
// 规则：
//   - 绑定的是**用户自己的目录**，不复制、不搬家；存的是 realpath 规范化后的路径
//     （软链与真实路径必须是同一个身份，否则沙箱包含判断会出现假阳性）；
//   - 创建时即校验：不存在 / 不是目录 / 相对路径 / 危险根 → 明确报错，不落空壳；
//   - 危险根三类：系统临时根、整个用户主目录、CogSeed 自身数据目录；
//     主目录**下**的正常项目目录（~/code/foo）必须仍然可以绑定；
//   - 字段必须能穿过"读-写"白名单（_normaliseSpace 是显式字段白名单，
//     漏加就会在重命名空间时被静默丢掉）——这是本文件最重要的一条回归护栏；
//   - 删除空间只删空间自己，绝不碰用户的项目目录。

let tmpDir: string;          // 扮演 CogSeed 数据根（COGSEED_WORKSPACE_ROOT）
let projDir: string;         // 扮演用户自己的项目目录（在数据根之外）
let prevWs: string | undefined;
const TEST_UID = 'uProj';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-spaces-'));
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-proj-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});

async function loadSpaces() {
  return import('../../../src/main/features/spaces');
}

describe('spaces › 绑定的本地项目目录', () => {
  it('创建时存入 realpath 规范化后的路径，并可原样读回', async () => {
    const spaces = await loadSpaces();
    const res = await spaces.createSpace(TEST_UID, { name: '项目空间', projectDir: projDir });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const read = await spaces.getSpace(TEST_UID, res.space.space_id);
    expect(read?.project_dir).toBe(fs.realpathSync(projDir));
  });

  it('软链绑定 → 存真实路径（同一目录只有一种身份）', async () => {
    const spaces = await loadSpaces();
    const linkPath = path.join(os.tmpdir(), `cogseed-link-${Date.now()}-${process.pid}`);
    fs.symlinkSync(projDir, linkPath);
    try {
      const res = await spaces.createSpace(TEST_UID, { name: '软链空间', projectDir: linkPath });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // 绑定软链 → 落盘的是它指向的真实目录，不是软链本身
      expect(res.space.project_dir).toBe(fs.realpathSync(projDir));
      expect(res.space.project_dir).not.toBe(linkPath);
    } finally {
      fs.rmSync(linkPath, { force: true });
    }
  });

  it('目录不存在 → project_dir_not_found，且不落盘空壳', async () => {
    const spaces = await loadSpaces();
    const before = (await spaces.listSpaces(TEST_UID)).length;
    const res = await spaces.createSpace(TEST_UID, {
      name: '幽灵空间',
      projectDir: path.join(projDir, 'not-there'),
    });
    expect(res).toEqual({ ok: false, error: 'project_dir_not_found' });
    expect((await spaces.listSpaces(TEST_UID)).length).toBe(before);
  });

  it('路径是文件而不是目录 → project_dir_not_directory', async () => {
    const spaces = await loadSpaces();
    const file = path.join(projDir, 'a.txt');
    fs.writeFileSync(file, 'x');
    const res = await spaces.createSpace(TEST_UID, { name: '文件空间', projectDir: file });
    expect(res).toEqual({ ok: false, error: 'project_dir_not_directory' });
  });

  it('相对路径 / 空串 → invalid_project_dir（空串 = 未绑定，不报错）', async () => {
    const spaces = await loadSpaces();
    const rel = await spaces.createSpace(TEST_UID, { name: '相对空间', projectDir: 'relative/dir' });
    expect(rel).toEqual({ ok: false, error: 'invalid_project_dir' });

    const empty = await spaces.createSpace(TEST_UID, { name: '空串空间', projectDir: '' });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.space.project_dir).toBeUndefined();
  });

  it('拒绝三类危险根：整个用户主目录 / 系统临时根 / CogSeed 自身数据目录', async () => {
    const spaces = await loadSpaces();
    const home = await spaces.createSpace(TEST_UID, { name: '主目录空间', projectDir: os.homedir() });
    expect(home.ok).toBe(false);

    const fsRoot = await spaces.createSpace(TEST_UID, { name: '根空间', projectDir: path.parse(tmpDir).root });
    expect(fsRoot.ok).toBe(false);

    // CogSeed 自己的数据根（WS_ROOT = COGSEED_WORKSPACE_ROOT）
    const dataDir = path.join(tmpDir, 'some', 'inner');
    fs.mkdirSync(dataDir, { recursive: true });
    const inside = await spaces.createSpace(TEST_UID, { name: '数据目录空间', projectDir: dataDir });
    expect(inside.ok).toBe(false);
  });

  it('主目录下的正常项目目录可以绑定（危险根只拦"根"本身）', async () => {
    const spaces = await loadSpaces();
    // projDir 位于 os.tmpdir() 之下——临时根的**子目录**必须仍然可绑定，
    // 否则真实项目（如 ~/code/foo）会被一刀切拒绝。
    expect(projDir.startsWith(os.tmpdir())).toBe(true);
    const res = await spaces.createSpace(TEST_UID, { name: '正常项目', projectDir: projDir });
    expect(res.ok).toBe(true);
  });

  it('未选择目录 → 字段缺省（老空间行为不变）', async () => {
    const spaces = await loadSpaces();
    const res = await spaces.createSpace(TEST_UID, { name: '无绑定空间' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.space.project_dir).toBeUndefined();
    const read = await spaces.getSpace(TEST_UID, res.space.space_id);
    expect(read?.project_dir).toBeUndefined();
  });

  it('更新空间（重命名等）不会丢掉绑定 —— 字段白名单回归护栏', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: '会改名', projectDir: projDir });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const renamed = await spaces.updateSpace(TEST_UID, created.space.space_id, { name: '改过名' });
    expect(renamed.ok).toBe(true);

    const read = await spaces.getSpace(TEST_UID, created.space.space_id);
    expect(read?.name).toBe('改过名');
    expect(read?.project_dir).toBe(fs.realpathSync(projDir));
  });

  it('删除空间不碰用户的项目目录', async () => {
    const spaces = await loadSpaces();
    const marker = path.join(projDir, 'keep-me.txt');
    fs.writeFileSync(marker, 'still here');

    const created = await spaces.createSpace(TEST_UID, { name: '待删除', projectDir: projDir });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await spaces.deleteSpace(TEST_UID, created.space.space_id);
    expect(await spaces.getSpace(TEST_UID, created.space.space_id)).toBeNull();
    expect(fs.existsSync(projDir)).toBe(true);
    expect(fs.readFileSync(marker, 'utf8')).toBe('still here');
  });

  it('isUsableSpaceProjectDir：目录 true；不存在 / 是文件 / 非绝对路径 false', async () => {
    const spaces = await loadSpaces();
    const file = path.join(projDir, 'b.txt');
    fs.writeFileSync(file, 'x');

    expect(spaces.isUsableSpaceProjectDir(projDir)).toBe(true);
    expect(spaces.isUsableSpaceProjectDir(path.join(projDir, 'gone'))).toBe(false);
    expect(spaces.isUsableSpaceProjectDir(file)).toBe(false);
    expect(spaces.isUsableSpaceProjectDir('relative/dir')).toBe(false);
    expect(spaces.isUsableSpaceProjectDir(undefined)).toBe(false);
  });

  it('存量脏数据（相对路径）读取时被丢弃，不会成为工作区', async () => {
    const spaces = await loadSpaces();
    const created = await spaces.createSpace(TEST_UID, { name: '脏数据', projectDir: projDir });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 手工把落盘值改成相对路径（模拟外部写入/历史数据）
    const metaFile = path.join(tmpDir, TEST_UID, 'cloud', 'spaces', `${created.space.space_id}.json`);
    const raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    raw.project_dir = 'relative/nope';
    fs.writeFileSync(metaFile, JSON.stringify(raw));

    const read = await spaces.getSpace(TEST_UID, created.space.space_id);
    expect(read?.project_dir).toBeUndefined();
  });
});
