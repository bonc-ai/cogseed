import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'uImp';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-import-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function makeSpace(): Promise<string> {
  const spaces = await import('../../../src/main/features/spaces');
  const created = await spaces.createSpace(UID, { name: '导入空间' });
  if (!created.ok) throw new Error('create space failed');
  return created.space.space_id;
}

async function spaceContent(sid: string): Promise<string> {
  const paths = await import('../../../src/main/paths');
  return paths.spaceContentDir(UID, sid);
}

describe('space_import › 本地文件夹整体导入（COGSEED-18）', () => {
  it('多级目录整体复制进空间 imports/，保留相对结构', async () => {
    const src = path.join(tmpDir, 'src-folder');
    fs.mkdirSync(path.join(src, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'a');
    fs.writeFileSync(path.join(src, 'sub', 'b.md'), 'b');
    fs.writeFileSync(path.join(src, 'sub', 'deep', 'c.pdf'), 'c');

    const sid = await makeSpace();
    const { importFolderIntoSpace } = await import('../../../src/main/features/space_import');
    const r = await importFolderIntoSpace(UID, sid, src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copied).toBe(3);
    expect(r.skipped).toHaveLength(0);

    const target = path.join(await spaceContent(sid), 'imports', 'src-folder');
    expect(fs.existsSync(path.join(target, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'sub', 'b.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'sub', 'deep', 'c.pdf'))).toBe(true);
  });

  it('工程垃圾目录（.git/node_modules）不复制、不计入文件数', async () => {
    const src = path.join(tmpDir, 'proj');
    fs.mkdirSync(path.join(src, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(src, '.git'), { recursive: true });
    fs.writeFileSync(path.join(src, 'node_modules', 'x', 'big.js'), 'x');
    fs.writeFileSync(path.join(src, '.git', 'config'), 'x');
    fs.writeFileSync(path.join(src, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(src, 'keep.txt'), 'keep');

    const sid = await makeSpace();
    const { importFolderIntoSpace } = await import('../../../src/main/features/space_import');
    const r = await importFolderIntoSpace(UID, sid, src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copied).toBe(1); // 只有 keep.txt
    const target = path.join(await spaceContent(sid), 'imports', 'proj');
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
  });

  it('单文件超限跳过（file_too_large），其余文件成功（部分失败不阻断）', async () => {
    const src = path.join(tmpDir, 'mixed');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'ok.txt'), 'ok');
    fs.writeFileSync(path.join(src, 'huge.bin'), '');
    fs.truncateSync(path.join(src, 'huge.bin'), 101 * 1024 * 1024); // 稀疏文件 > 100MB

    const sid = await makeSpace();
    const { importFolderIntoSpace, IMPORT_LIMITS } = await import('../../../src/main/features/space_import');
    const r = await importFolderIntoSpace(UID, sid, src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copied).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].path).toBe('huge.bin');
    expect(r.skipped[0].reason).toBe('file_too_large');
    expect(IMPORT_LIMITS.MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
  });

  it('无读权限文件跳过并记录 permission_denied', async () => {
    const src = path.join(tmpDir, 'deny');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'locked.txt'), 'secret');
    fs.chmodSync(path.join(src, 'locked.txt'), 0o000);
    fs.writeFileSync(path.join(src, 'free.txt'), 'free');

    const sid = await makeSpace();
    const { importFolderIntoSpace } = await import('../../../src/main/features/space_import');
    const r = await importFolderIntoSpace(UID, sid, src);
    fs.chmodSync(path.join(src, 'locked.txt'), 0o644); // 清理
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copied).toBe(1);
    expect(r.skipped.some((s) => s.path === 'locked.txt' && s.reason === 'permission_denied')).toBe(true);
  });

  it('源目录校验：不存在 / 非目录 / 位于空间内 → 明确失败', async () => {
    const { importFolderIntoSpace } = await import('../../../src/main/features/space_import');
    const sid = await makeSpace();

    const missing = await importFolderIntoSpace(UID, sid, path.join(tmpDir, 'nope'));
    expect(missing).toEqual({ ok: false, error: 'source_not_found' });

    const fileSrc = path.join(tmpDir, 'plain.txt');
    fs.writeFileSync(fileSrc, 'x');
    const notDir = await importFolderIntoSpace(UID, sid, fileSrc);
    expect(notDir).toEqual({ ok: false, error: 'source_not_directory' });

    const inside = await importFolderIntoSpace(UID, sid, await spaceContent(sid));
    expect(inside).toEqual({ ok: false, error: 'source_inside_space' });
  });

  it('进度回调：done 递增至 total', async () => {
    const src = path.join(tmpDir, 'many');
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 45; i++) fs.writeFileSync(path.join(src, `f${i}.txt`), 'x');

    const sid = await makeSpace();
    const { importFolderIntoSpace } = await import('../../../src/main/features/space_import');
    const progress: Array<{ done: number; total: number }> = [];
    const r = await importFolderIntoSpace(UID, sid, src, (p) => progress.push({ done: p.done, total: p.total }));
    expect(r.ok).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1];
    expect(last.done).toBe(45);
    expect(last.total).toBe(45);
    // done 单调递增
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].done).toBeGreaterThan(progress[i - 1].done);
    }
  });
});
