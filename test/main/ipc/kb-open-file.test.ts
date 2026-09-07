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
