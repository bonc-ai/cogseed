/**
 * local_file_links —— 库内文件 ↔ 本机文件的对应关系台账。
 *
 * 覆盖：
 *   1. 存在哪（机器私有 `local/contexts/.kb/`，绝不进云同步）；
 *   2. key 归一化与拒收（隐藏段/`..`/空）；
 *   3. 两类证据都能用：导入来源、用户手选落点；
 *   4. 取用时的"线索复核"：目录没了就返回 null（调用方才能退回系统保存框）；
 *   5. 条目上限：超出丢最旧，不许无限增长。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_UID = 'uLocalFileLinks';
let tmpDir: string;
let previousRoot: string | undefined;
let links: typeof import('../../../src/main/features/local_file_links');

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-local-links-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  links = await import('../../../src/main/features/local_file_links');
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSourceFile(name = '站会转写.txt', dirName = 'user-folder'): string {
  const dir = path.join(tmpDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, '原文', 'utf8');
  return abs;
}

describe('台账落点（机器私有）', () => {
  it('写在 <uid>/local/contexts/.kb/ 下，不进 cloud（绝对路径换机即失效，不能同步）', () => {
    const file = links.linksFileForUser(TEST_UID);
    expect(file).toBe(path.join(tmpDir, TEST_UID, 'local', 'contexts', '.kb', links.LOCAL_FILE_LINKS_FILENAME));
    expect(file).not.toContain(`${path.sep}cloud${path.sep}`);
  });
});

describe('key 归一化与拒收', () => {
  it('反斜杠与首尾斜杠归一', () => {
    expect(links.normalizeLibraryKey('\\a\\b\\c.txt')).toBe('a/b/c.txt');
    expect(links.normalizeLibraryKey('/a/b.txt/')).toBe('a/b.txt');
  });

  it('空串 / 隐藏段 / .. 段一律拒收（.kb、本体分组不是用户导入的文件）', () => {
    expect(links.normalizeLibraryKey('')).toBe('');
    expect(links.normalizeLibraryKey('.kb/vector.db')).toBe('');
    expect(links.normalizeLibraryKey('1/.hidden.txt')).toBe('');
    expect(links.normalizeLibraryKey('1/../x.txt')).toBe('');
  });

  it('非法 key 或相对目标路径不记账，也不抛', () => {
    links.recordImportLinkForUser(TEST_UID, '.kb/x.json', makeSourceFile());
    links.recordImportLinkForUser(TEST_UID, '1/a.txt', 'relative/path.txt');
    expect(links.localFileLinkForUser(TEST_UID, '1/a.txt')).toBeNull();
    expect(fs.existsSync(links.linksFileForUser(TEST_UID))).toBe(false);
  });
});

describe('两类证据', () => {
  it('导入来源：记下源文件绝对路径，原文目录还在时就能取到目录', () => {
    const source = makeSourceFile();
    links.recordImportLinkForUser(TEST_UID, '1/站会转写.txt', source);

    const link = links.localFileLinkForUser(TEST_UID, '1/站会转写.txt');
    expect(link?.targetAbs).toBe(source);
    expect(link?.from).toBe('import');
    expect(link?.at).toBeGreaterThan(0);
    expect(links.localWriteDirForUser(TEST_UID, '1/站会转写.txt')).toBe(path.dirname(source));
  });

  it('用户手选落点：保存框选过一次之后，同一份文档下次不用再导航', () => {
    const picked = path.join(tmpDir, '我选的文件夹', '站会转写-清理版.txt');
    fs.mkdirSync(path.dirname(picked), { recursive: true });
    links.recordUserPickedTargetForUser(TEST_UID, '1/站会转写.txt', picked);

    expect(links.localFileLinkForUser(TEST_UID, '1/站会转写.txt')?.from).toBe('user_pick');
    expect(links.localWriteDirForUser(TEST_UID, '1/站会转写.txt')).toBe(path.dirname(picked));
  });

  it('用户手选会覆盖导入来源（最后一次明确表态为准）', () => {
    const source = makeSourceFile();
    const picked = path.join(tmpDir, '另一处', 'a.txt');
    fs.mkdirSync(path.dirname(picked), { recursive: true });
    links.recordImportLinkForUser(TEST_UID, '1/a.txt', source);
    links.recordUserPickedTargetForUser(TEST_UID, '1/a.txt', picked);
    expect(links.localWriteDirForUser(TEST_UID, '1/a.txt')).toBe(path.dirname(picked));
  });

  it('目录被删/不存在时返回 null —— 线索失效，调用方必须退回系统保存框', () => {
    const source = makeSourceFile();
    links.recordImportLinkForUser(TEST_UID, '1/站会转写.txt', source);
    fs.rmSync(path.dirname(source), { recursive: true, force: true });
    expect(links.localWriteDirForUser(TEST_UID, '1/站会转写.txt')).toBeNull();
    // 线索本身还在（只是不可用）：便于排查"为什么这次没写回原文件夹"
    expect(links.localFileLinkForUser(TEST_UID, '1/站会转写.txt')?.targetAbs).toBe(source);
  });

  it('未记过的路径返回 null，不编造落点', () => {
    expect(links.localFileLinkForUser(TEST_UID, '1/从没导入过.txt')).toBeNull();
    expect(links.localWriteDirForUser(TEST_UID, '1/从没导入过.txt')).toBeNull();
  });

  it('台账文件损坏时不抛，按空台账处理（它是旁路，不能把导入搞挂）', () => {
    const file = links.linksFileForUser(TEST_UID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');
    expect(links.localFileLinkForUser(TEST_UID, '1/a.txt')).toBeNull();
  });
});

describe('条目上限', () => {
  it('超出上限丢最旧，保住新记录', () => {
    const file = links.linksFileForUser(TEST_UID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entries: Record<string, { targetAbs: string; from: string; at: number }> = {};
    for (let i = 0; i < links.MAX_LOCAL_FILE_LINKS; i += 1) {
      entries[`bulk/${i}.txt`] = { targetAbs: `/tmp/src/${i}.txt`, from: 'import', at: i + 1 };
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries }), 'utf8');

    const fresh = makeSourceFile('新导入.txt');
    links.recordImportLinkForUser(TEST_UID, '1/新导入.txt', fresh);

    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = Object.keys(stored.entries);
    expect(keys).toHaveLength(links.MAX_LOCAL_FILE_LINKS);
    expect(keys).toContain('1/新导入.txt');
    expect(keys).not.toContain('bulk/0.txt'); // at 最小 = 最旧
    expect(keys).toContain(`bulk/${links.MAX_LOCAL_FILE_LINKS - 1}.txt`);
  });
});
