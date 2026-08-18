import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

// The "@ Library" picker attaches a global/project Library file into a
// composer draft pool via `contexts.attachToDraft` / `spaces.files.attachToDraft`.
// Both channels used to be unregistered (renderer called them, main threw
// "unknown channel") — this covers the fix.

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
const TEST_UID = 'uLibraryAttachToDraft';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-library-attach-to-draft-'));
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

async function invoke(channel: string, payload: any): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'cogseed.invoke');
  expect(call).toBeTruthy();
  const handler = call[1];
  return handler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('contexts.attachToDraft', () => {
  it('imports a global Library file into the commander draft pool', async () => {
    const contexts = await import('../../../src/main/features/contexts');
    const chatAttachments = await import('../../../src/main/features/chat_attachments');
    contexts.writeContextFile('notes/attach-me.md', '# Attach me');

    const res = await invoke('contexts.attachToDraft', { relPath: 'notes/attach-me.md', cid: 'main_chat' });

    expect(res.ok).toBe(true);
    expect(res.info).toMatchObject({ name: 'attach-me.md' });
    const items = chatAttachments.listPendingAttachments(TEST_UID, 'main_chat');
    expect(items.map((i) => i.name)).toContain('attach-me.md');
  });

  it('rejects a path that escapes the Library root', async () => {
    const res = await invoke('contexts.attachToDraft', { relPath: '../../etc/passwd', cid: 'main_chat' });
    expect(res.ok).toBe(false);
  });

  it('rejects a draft cid that is not a valid composer pool id', async () => {
    const contexts = await import('../../../src/main/features/contexts');
    contexts.writeContextFile('notes/attach-me.md', '# Attach me');
    const res = await invoke('contexts.attachToDraft', { relPath: 'notes/attach-me.md', cid: '../escape' });
    expect(res.ok).toBe(false);
  });
});

describe('spaces.files.attachToDraft', () => {
  it('imports a project Library file into that project draft pool', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chatAttachments = await import('../../../src/main/features/chat_attachments');
    const { spaceFilesDir } = await import('../../../src/main/paths');

    const space = await spaces.createSpace(TEST_UID, { name: 'Attach Draft Project' });
    if (!space.ok) throw new Error('space precondition failed');
    const spaceId = space.space.space_id;
    const dir = spaceFilesDir(TEST_UID, spaceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'brief.md'), '# Brief', 'utf8');

    const draftCid = `projchat-${spaceId}`;
    const res = await invoke('spaces.files.attachToDraft', { spaceId, name: 'brief.md', cid: draftCid });

    expect(res.ok).toBe(true);
    expect(res.info).toMatchObject({ name: 'brief.md' });
    const items = chatAttachments.listPendingAttachments(TEST_UID, draftCid);
    expect(items.map((i) => i.name)).toContain('brief.md');
  });

  it('rejects a project id that does not exist', async () => {
    const res = await invoke('spaces.files.attachToDraft', {
      spaceId: 'not-a-real-project',
      name: 'brief.md',
      cid: 'projchat-not-a-real-project',
    });
    expect(res.ok).toBe(false);
  });
});
