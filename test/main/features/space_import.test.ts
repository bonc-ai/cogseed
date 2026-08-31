import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// 避免真实索引器加载 better-sqlite3 原生模块（本机 Node 版本与编译产物不匹配）
vi.mock('../../../src/main/features/project_library_indexer', () => ({
  enqueue: vi.fn(),
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

describe('space_import › 个人知识库导入共享库（importLibIntoSpace）', () => {
  async function makeLib(name: string, files: Record<string, string>): Promise<void> {
    const paths = await import('../../../src/main/paths');
    const libDir = path.join(paths.userContextsDir(UID), name);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(libDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  it('把个人库多级目录镜像导入空间，保留相对结构', async () => {
    await makeLib('源库A', {
      'a.txt': 'a',
      'sub/b.md': 'b',
      'sub/deep/c.pdf': 'c',
    });
    const sid = await makeSpace();
    const { importLibIntoSpace } = await import('../../../src/main/features/space_import');
    const r = await importLibIntoSpace(UID, sid, '源库A');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scanned).toBe(3);
    expect(r.imported).toBe(3);
    // 文件落到空间文件目录（spaces/<空间>/contexts/，走索引队列入口）
    const paths = await import('../../../src/main/paths');
    const target = paths.spaceFilesDir(UID, sid);
    expect(fs.existsSync(path.join(target, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'sub', 'b.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'sub', 'deep', 'c.pdf'))).toBe(true);
  });

  it('源个人库不存在 / 非法库名 → 明确失败', async () => {
    const sid = await makeSpace();
    const { importLibIntoSpace } = await import('../../../src/main/features/space_import');
    const missing = await importLibIntoSpace(UID, sid, '不存在的库');
    expect(missing).toEqual({ ok: false, error: 'source_lib_not_found' });
    const empty = await importLibIntoSpace(UID, sid, '');
    expect(empty).toEqual({ ok: false, error: 'missing_lib_name' });
  });

  it('个人库内无白名单文件 → 导入 0 个但不报错', async () => {
    await makeLib('空库', { 'image.png': 'not-really-png' }); // png 在 contexts 白名单内
    const sid = await makeSpace();
    const { importLibIntoSpace } = await import('../../../src/main/features/space_import');
    const r = await importLibIntoSpace(UID, sid, '空库');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.imported).toBe(1); // png 属白名单（图片类）
  });
});

describe('space_import › 弹窗勾选文件导入（importFilesIntoSpace）', () => {
  it('只导入选中的文件（含子目录路径），未选的不导入', async () => {
    const paths = await import('../../../src/main/paths');
    const libDir = path.join(paths.userContextsDir(UID), '挑选库');
    fs.mkdirSync(path.join(libDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(libDir, '选A.md'), 'a');
    fs.writeFileSync(path.join(libDir, '不选B.txt'), 'b');
    fs.writeFileSync(path.join(libDir, 'sub', '选C.pdf'), 'c');

    const sid = await makeSpace();
    const { importFilesIntoSpace } = await import('../../../src/main/features/space_import');
    const absByRel = new Map([
      ['挑选库/选A.md', path.join(libDir, '选A.md')],
      ['挑选库/sub/选C.pdf', path.join(libDir, 'sub', '选C.pdf')],
    ]);
    const r = await importFilesIntoSpace(UID, sid, absByRel);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scanned).toBe(2);
    expect(r.imported).toBe(2);
    const target = paths.spaceFilesDir(UID, sid);
    expect(fs.existsSync(path.join(target, '挑选库', '选A.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '挑选库', 'sub', '选C.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(target, '挑选库', '不选B.txt'))).toBe(false);
  });

  it('空选中列表 → ok 且 imported 0', async () => {
    const sid = await makeSpace();
    const { importFilesIntoSpace } = await import('../../../src/main/features/space_import');
    const r = await importFilesIntoSpace(UID, sid, new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.imported).toBe(0);
  });
});
