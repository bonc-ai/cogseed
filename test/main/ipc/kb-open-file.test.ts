import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { makeMinimalPdf } from '../../fixtures/make-minimal-pdf';
import { makeMinimalXlsx } from '../../fixtures/make-minimal-office';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
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

vi.mock('../../../src/main/features/search', () => ({
  upsertContext: vi.fn(),
  dropContext: vi.fn(),
}));

vi.mock('../../../src/main/features/kb_vector', () => ({
  findBySha1: vi.fn(() => null),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uKbOpenFile';
const LIB = '笔记库';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kb-open-file-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function contextsRoot(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'contexts');
}

async function invoke(channel: string, payload: any): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'cogseed.invoke');
  expect(call).toBeTruthy();
  const handler = call[1];
  return handler({ sender: trustedIpcSender() }, { channel, payload });
}

/** 建个人库文件：relPath 相对 contexts root（含库名前缀）。 */
function writeLibFile(rel: string, content: string | Buffer): void {
  const abs = path.join(contextsRoot(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** 建共享空间并返回 spaceId。 */
async function makeSpace(name: string): Promise<string> {
  const spaces = await import('../../../src/main/features/spaces');
  const created = await spaces.createSpace(TEST_UID, { name });
  if (!created.ok) throw new Error('create space failed');
  return created.space.space_id;
}

describe('kb.openFile › 个人库文本/文档预览', () => {
  it('md 文件按 markdown 返回', async () => {
    writeLibFile(`${LIB}/a.md`, '# 标题\n\n正文内容');
    const res = await invoke('kb.openFile', { path: `${LIB}/a.md` });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('markdown');
    expect(res.name).toBe('a.md');
    expect(res.content).toContain('# 标题');
  });

  it('txt 文件按 text 返回且剥离 BOM', async () => {
    writeLibFile(`${LIB}/sub/b.txt`, '\uFEFF纯文本');
    const res = await invoke('kb.openFile', { path: `${LIB}/sub/b.txt` });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('text');
    expect(res.content).toBe('纯文本');
  });

  it('docx 转排版化 HTML 预览', async () => {
    const docx = makeMinimalDocx({ heading: 'Doc 标题', paragraphs: ['段落一。'] });
    writeLibFile(`${LIB}/c.docx`, docx);
    const res = await invoke('kb.openFile', { path: `${LIB}/c.docx` });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('office');
    expect(res.officeKind).toBe('word');
    // 返回完整 HTML 文档（含 office 排版包裹样式 + mammoth 转换正文）
    expect(res.html).toContain('office-word');
    expect(res.html).toContain('Doc 标题');
    expect(res.html).toContain('段落一');
  });

  it('xlsx 转表格化 HTML 预览', async () => {
    const xlsx = makeMinimalXlsx({
      sheetName: '成绩表',
      rows: [
        ['姓名', '分数'],
        ['张伟', '99'],
      ],
    });
    writeLibFile(`${LIB}/e.xlsx`, xlsx);
    const res = await invoke('kb.openFile', { path: `${LIB}/e.xlsx` });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('office');
    expect(res.officeKind).toBe('spreadsheet');
    expect(res.html).toContain('office-sheet');
    expect(res.html).toContain('成绩表');
    expect(res.html).toContain('张伟');
  });

  it('pdf 走原生 PDFium（返回路径，不跨 IPC 传输文本）', async () => {
    const pdf = makeMinimalPdf(['第 1 页内容']);
    writeLibFile(`${LIB}/d.pdf`, pdf);
    const res = await invoke('kb.openFile', { path: `${LIB}/d.pdf` });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('pdf');
    expect(res.name).toBe('d.pdf');
    expect(res.path).toBe(`${LIB}/d.pdf`);
    expect(res.content).toBeUndefined();
  });

  // #214 之后 html 曾被当纯文本读，排版丢失；这里锁死"默认渲染 + 按需源码"两条路。
  it('html 默认返回渲染型（不返回正文，交给 kb-file:// iframe 保排版）', async () => {
    writeLibFile(`${LIB}/page.html`, '<!doctype html><html><body><h1>标题</h1></body></html>');
    const res = await invoke('kb.openFile', { path: `${LIB}/page.html` });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('html');
    expect(res.relPath).toBe(`${LIB}/page.html`);
    expect(res.content).toBeUndefined();
  });

  it('html + asText 返回源码（查看源码切换用）', async () => {
    writeLibFile(`${LIB}/page2.html`, '\uFEFF<!doctype html><html><body><p>正文</p></body></html>');
    const res = await invoke('kb.openFile', { path: `${LIB}/page2.html`, asText: true });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('text');
    expect(res.content).toContain('<p>正文</p>');
    // 与文本类一致：剥掉 BOM
    expect(res.content.charCodeAt(0)).not.toBe(0xFEFF);
  });
});

describe('kb.openFile › 空间库文件预览', () => {
  it('spaceId + path 读取空间 contexts 下的 md', async () => {
    const sid = await makeSpace('共享库');
    const paths = await import('../../../src/main/paths');
    const root = paths.spaceContextsDir(TEST_UID, sid);
    const abs = path.join(root, 'doc.md');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '# 空间文档', 'utf8');

    const res = await invoke('kb.openFile', { spaceId: sid, path: 'doc.md' });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('markdown');
    expect(res.content).toContain('# 空间文档');
  });

  it('spaceId + path 的 pdf 返回原生 PDFium 标记', async () => {
    const sid = await makeSpace('共享库2');
    const paths = await import('../../../src/main/paths');
    const root = paths.spaceContextsDir(TEST_UID, sid);
    const abs = path.join(root, 'slide.pdf');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, makeMinimalPdf(['空间 pdf']), 'utf8');

    const res = await invoke('kb.openFile', { spaceId: sid, path: 'slide.pdf' });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('pdf');
    expect(res.spaceId).toBe(sid);
    expect(res.content).toBeUndefined();
  });

  it('拒绝越界路径（../ 逃逸）', async () => {
    const sid = await makeSpace('共享库2');
    const res = await invoke('kb.openFile', { spaceId: sid, path: '../../secret.md' });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  // 回归：office/text/html 分支曾漏回传 spaceId → 渲染层按个人库路由，
  // "在系统中打开"/"查看源码"在空间库里必然找不到文件。
  it('每种 kind 都回传 spaceId（office/text/html）', async () => {
    const sid = await makeSpace('共享库5');
    const paths = await import('../../../src/main/paths');
    const root = paths.spaceContextsDir(TEST_UID, sid);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'doc.docx'), makeMinimalDocx({ heading: '空间标题', paragraphs: ['空间段落'] }));
    fs.writeFileSync(path.join(root, 'note.md'), '# 空间笔记', 'utf8');
    fs.writeFileSync(path.join(root, 'page.html'), '<!doctype html><html><body>空间页面</body></html>', 'utf8');

    for (const name of ['doc.docx', 'note.md', 'page.html']) {
      const res = await invoke('kb.openFile', { spaceId: sid, path: name });
      expect(res.ok, name).toBe(true);
      expect(res.spaceId, name).toBe(sid);
    }
  });

  // Office 预览有进程内 LRU 缓存（第二参数是被缓存的那条路径）——
  // 回传字段必须在"命中缓存"和"现解析"两条路上一致。
  it('office 命中预览缓存时同样回传 spaceId', async () => {
    const sid = await makeSpace('共享库6');
    const paths = await import('../../../src/main/paths');
    const root = paths.spaceContextsDir(TEST_UID, sid);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'cached.docx'), makeMinimalDocx({ heading: 'H', paragraphs: ['P'] }));

    const first = await invoke('kb.openFile', { spaceId: sid, path: 'cached.docx' });
    const second = await invoke('kb.openFile', { spaceId: sid, path: 'cached.docx' });
    expect(first.spaceId).toBe(sid);
    expect(second.ok).toBe(true);
    expect(second.html).toBe(first.html); // 命中缓存（同一份 HTML）
    expect(second.spaceId).toBe(sid);
  });
});

describe('kb.openFile › 错误路径', () => {
  it('文件不存在返回 file not found', async () => {
    const res = await invoke('kb.openFile', { path: `${LIB}/missing.md` });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('file not found');
  });

  it('超过 2MB 返回 too_large', async () => {
    writeLibFile(`${LIB}/big.txt`, 'x'.repeat(2 * 1024 * 1024 + 1));
    const res = await invoke('kb.openFile', { path: `${LIB}/big.txt` });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('too_large');
  });

  it('缺 path 返回 missing path', async () => {
    const res = await invoke('kb.openFile', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('missing path');
  });

  it('未知扩展返回 unsupported', async () => {
    writeLibFile(`${LIB}/x.bin`, Buffer.from([1, 2, 3]));
    const res = await invoke('kb.openFile', { path: `${LIB}/x.bin` });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/暂不支持预览/);
  });
});

// 查看器只做只读预览；批注编辑 / 原生 Office 打开走 kb.openExternal。
describe('kb.openExternal › 交给系统默认应用', () => {
  it('个人库文件用绝对路径调 shell.openPath', async () => {
    const electron = await import('electron') as any;
    writeLibFile(`${LIB}/外部.pdf`, makeMinimalPdf(['第 1 页']));
    const res = await invoke('kb.openExternal', { path: `${LIB}/外部.pdf` });
    expect(res.ok).toBe(true);
    const called = electron.shell.openPath.mock.calls.at(-1)?.[0];
    expect(called).toBe(path.join(contextsRoot(), `${LIB}/外部.pdf`));
  });

  it('空间库文件解析到空间 contexts 目录', async () => {
    const electron = await import('electron') as any;
    const sid = await makeSpace('共享库3');
    const paths = await import('../../../src/main/paths');
    const root = paths.spaceContextsDir(TEST_UID, sid);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'slide.pdf'), makeMinimalPdf(['空间 pdf']), 'utf8');

    const res = await invoke('kb.openExternal', { spaceId: sid, path: 'slide.pdf' });
    expect(res.ok).toBe(true);
    expect(electron.shell.openPath.mock.calls.at(-1)?.[0]).toBe(path.join(root, 'slide.pdf'));
  });

  it('越界路径被拒且不触碰 shell.openPath', async () => {
    const electron = await import('electron') as any;
    const sid = await makeSpace('共享库4');
    electron.shell.openPath.mockClear();
    const res = await invoke('kb.openExternal', { spaceId: sid, path: '../../secret.pdf' });
    expect(res.ok).toBe(false);
    expect(electron.shell.openPath).not.toHaveBeenCalled();
  });

  it('文件不存在返回 file not found', async () => {
    const res = await invoke('kb.openExternal', { path: `${LIB}/没有这个.pdf` });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('file not found');
  });

  it('shell.openPath 报错时透出错误信息', async () => {
    const electron = await import('electron') as any;
    writeLibFile(`${LIB}/坏文件.pdf`, makeMinimalPdf(['x']));
    electron.shell.openPath.mockResolvedValueOnce('no application knows how to open');
    const res = await invoke('kb.openExternal', { path: `${LIB}/坏文件.pdf` });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no application');
  });
});
