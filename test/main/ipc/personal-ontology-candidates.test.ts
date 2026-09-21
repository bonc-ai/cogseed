import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<any>;
let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uOntologyIpc';

const templateFiles = {
  installTemplateFile: vi.fn(async (uid: string, templateId: string, restoreData: boolean) => ({ ok: true, uid, templateId, restoreData })),
  templateHasArchive: vi.fn(() => true),
  templateHasMemoryArchive: vi.fn(() => false),
  uninstallTemplateFile: vi.fn(async (uid: string, templateId: string, archiveMemory: boolean) => ({ ok: true, uid, templateId, archiveMemory })),
};

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../src/main/features/personal_ontology_template_files', () => templateFiles);

beforeEach(async () => {
  process.env.COGSEED_WORKSPACE_ROOT = os.tmpdir();
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc › personal ontology templates', () => {
  it('re-exposes single-item candidate channels for backflow confirmation while keeping batch channels retired', async () => {
    // 2026-09-20 本体分组迁入：回流候选的确认端需要 list/confirm/reject 三个
    // 单条通道——旧候选审核面板退役时的「全禁」约束随之收窄（防的是面板复活，
    // 不是防回流确认这个窄入口）。批量与 onboarding 通道保持退役。
    const liveChannels = [
      'personalOntology.candidates.list',
      'personalOntology.candidates.confirm',
      'personalOntology.candidates.reject',
    ];
    for (const channel of liveChannels) {
      const res = await call(channel);
      expect(res).not.toEqual({ ok: false, error: `unknown channel: ${channel}` });
    }

    const retiredChannels = [
      'personalOntology.candidates.confirmBatch',
      'personalOntology.candidates.rejectBatch',
      'personalOntology.candidates.addFromOnboarding',
    ];
    for (const channel of retiredChannels) {
      await expect(call(channel)).resolves.toEqual({
        ok: false,
        error: `unknown channel: ${channel}`,
      });
    }
  });

  it('preserves template restore and archive options across IPC', async () => {
    await call('personalOntology.templates.install', { templateId: 'student', restoreData: true, uid: 'attacker' });
    await call('personalOntology.templates.hasArchive', { templateId: 'student', uid: 'attacker' });
    await call('personalOntology.templates.uninstall', { templateId: 'student', archiveMemory: true, uid: 'attacker' });

    expect(templateFiles.installTemplateFile).toHaveBeenCalledWith(TEST_UID, 'student', true);
    expect(templateFiles.templateHasArchive).toHaveBeenCalledWith(TEST_UID, 'student');
    expect(templateFiles.templateHasMemoryArchive).toHaveBeenCalledWith(TEST_UID, 'student');
    expect(templateFiles.uninstallTemplateFile).toHaveBeenCalledWith(TEST_UID, 'student', true);
  });

  it('rejects template actions without a valid template id', async () => {
    expect((await call('personalOntology.templates.install', { restoreData: true })).ok).toBe(false);
    expect((await call('personalOntology.templates.hasArchive', { templateId: 7 })).ok).toBe(false);
    expect((await call('personalOntology.templates.uninstall', {})).ok).toBe(false);
    expect(templateFiles.installTemplateFile).not.toHaveBeenCalled();
    expect(templateFiles.templateHasArchive).not.toHaveBeenCalled();
    expect(templateFiles.uninstallTemplateFile).not.toHaveBeenCalled();
  });
});
