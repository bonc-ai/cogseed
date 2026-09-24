/**
 * library.writeTextToLocal —— 清理版「另存到本地文件夹…」的主进程半边。
 *
 * 真机问题（2026-09-23）：库里原文是从用户磁盘复制进来的，产物只写回库内目录，
 * 用户去自己放原稿的文件夹里找不到。这里钉住三条行为：
 *   1. 记过导入来源 → **直接写回原文所在文件夹**，一个对话框都不弹；
 *   2. 没来源 / 来源目录已失效（换机器、文件夹被删）→ 走系统保存框，默认名带 -清理版；
 *   3. 用户取消保存框 → 明确 `canceled`（不是 error），且不写任何文件。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => path.join(os.tmpdir(), 'cogseed-downloads')) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showSaveDialog, showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(),
  kbEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../../../src/main/features/search', () => ({ upsertContext: vi.fn(), dropContext: vi.fn() }));
vi.mock('../../../src/main/features/kb_vector', () => ({ findBySha1: vi.fn(() => null) }));

const TEST_UID = 'uLocalExport';
let tmpDir: string;
let sourceDir: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-write-text-local-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  sourceDir = path.join(tmpDir, '用户自己的文件夹');
  fs.mkdirSync(sourceDir, { recursive: true });
  vi.resetModules();
  vi.clearAllMocks();
  showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeTextToLocal(payload: Record<string, unknown>): Promise<any> {
  const ipc = await import('../../../src/main/ipc/index');
  return ipc._libraryWriteTextToLocalForTest(payload, { userId: TEST_UID } as any);
}

async function seedLink(relPath: string, fileName = '站会转写.txt'): Promise<string> {
  const sourceAbs = path.join(sourceDir, fileName);
  fs.writeFileSync(sourceAbs, '原文', 'utf8');
  const links = await import('../../../src/main/features/local_file_links');
  links.recordImportLinkForUser(TEST_UID, relPath, sourceAbs);
  return sourceAbs;
}

describe('已有落点线索：直接写回原文所在文件夹', () => {
  it('不弹系统保存框，产物就落在原文旁边', async () => {
    await seedLink('1/站会转写.txt');
    const res = await writeTextToLocal({
      content: '清理后的正文',
      fileName: '站会转写-清理版.txt',
      sourcePath: '1/站会转写.txt',
    });

    expect(res.ok).toBe(true);
    expect(res.scope).toBe('known_dir');
    expect(res.path).toBe(path.join(sourceDir, '站会转写-清理版.txt'));
    expect(fs.readFileSync(res.path, 'utf8')).toBe('清理后的正文');
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('原文所在文件夹里已有同名产物时落 -2，不覆盖用户文件', async () => {
    await seedLink('1/站会转写.txt');
    await writeTextToLocal({ content: '第一份', fileName: '站会转写-清理版.txt', sourcePath: '1/站会转写.txt' });
    const second = await writeTextToLocal({ content: '第二份', fileName: '站会转写-清理版.txt', sourcePath: '1/站会转写.txt' });

    expect(second.path).toBe(path.join(sourceDir, '站会转写-清理版-2.txt'));
    expect(fs.readFileSync(path.join(sourceDir, '站会转写-清理版.txt'), 'utf8')).toBe('第一份');
  });

  it('渲染层传的是库内相对路径也能反查到来源（不会当成本地路径去写）', async () => {
    await seedLink('纪要/纪要/文字转写_x.txt', '文字转写_x.txt');
    const res = await writeTextToLocal({
      content: 'x',
      fileName: '文字转写_x-清理版.txt',
      sourcePath: '/纪要/纪要/文字转写_x.txt/',
    });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(path.join(sourceDir, '文字转写_x-清理版.txt'));
  });
});

describe('没有可用来源：走系统保存框', () => {
  it('从没记过来源的文档（新建/同步/剪藏）→ 弹框，用户选的路径为准', async () => {
    const chosen = path.join(tmpDir, 'custom', '我的清理版.txt');
    fs.mkdirSync(path.dirname(chosen), { recursive: true });
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: chosen });

    const res = await writeTextToLocal({
      content: '正文',
      fileName: '网页-标题-清理版.txt',
      sourcePath: '网页-标题.md',
    });

    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.scope).toBe('dialog');
    expect(res.path).toBe(chosen);
    expect(fs.readFileSync(chosen, 'utf8')).toBe('正文');
  });

  it('来源目录已失效（换机器/文件夹被删）→ 退回保存框，不静默失败', async () => {
    await seedLink('1/站会转写.txt');
    fs.rmSync(sourceDir, { recursive: true, force: true });
    const chosen = path.join(tmpDir, 'recover.txt');
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: chosen });

    const res = await writeTextToLocal({ content: '正文', fileName: 'a.txt', sourcePath: '1/站会转写.txt' });
    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.path).toBe(chosen);
  });

  it('保存框默认名带 -清理版（别让默认名和原文同名，用户会覆盖原稿）', async () => {
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: path.join(tmpDir, 'a-清理版.txt') });
    await writeTextToLocal({ content: 'x', fileName: 'a-清理版.txt', sourcePath: '' });

    const options = showSaveDialog.mock.calls[0]?.[0] as { defaultPath?: string; filters?: Array<{ extensions: string[] }> };
    expect(options.defaultPath?.endsWith('a-清理版.txt')).toBe(true);
    expect(options.filters?.[0]?.extensions).toEqual(['txt']);
  });

  it('用户手选落点被记住：同一份文档第二次不用再导航', async () => {
    const pickedDir = path.join(tmpDir, '我选的文件夹');
    fs.mkdirSync(pickedDir, { recursive: true });
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: path.join(pickedDir, 'a-清理版.txt') });
    const first = await writeTextToLocal({ content: '第一份', fileName: 'a-清理版.txt', sourcePath: '1/a.txt' });
    expect(first.scope).toBe('dialog');

    // 第二次：不再弹框，直接落到同一目录（并沿用"绝不覆盖"的 -2 规则）
    const second = await writeTextToLocal({ content: '第二份', fileName: 'a-清理版.txt', sourcePath: '1/a.txt' });
    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(second.scope).toBe('known_dir');
    expect(second.path).toBe(path.join(pickedDir, 'a-清理版-2.txt'));
  });

  it('用户取消 → canceled 而非 error，且不写文件', async () => {
    const res = await writeTextToLocal({ content: 'x', fileName: 'a-清理版.txt', sourcePath: '' });
    expect(res.ok).toBe(false);
    expect(res.canceled).toBe(true);
    expect(res.code).toBe('E_EXPORT_CANCELED');
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.txt'))).toEqual([]);
  });
});

describe('入参防护', () => {
  it('空内容拒绝', async () => {
    const res = await writeTextToLocal({ content: '', fileName: 'a.txt', sourcePath: '' });
    expect(res.code).toBe('E_EXPORT_EMPTY');
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('渲染层给带目录的文件名也只取 basename（不许越出目标目录）', async () => {
    await seedLink('1/站会转写.txt');
    const res = await writeTextToLocal({
      content: 'x',
      fileName: '../../恶意.txt',
      sourcePath: '1/站会转写.txt',
    });
    expect(res.ok).toBe(true);
    expect(path.dirname(res.path)).toBe(sourceDir);
  });
});
