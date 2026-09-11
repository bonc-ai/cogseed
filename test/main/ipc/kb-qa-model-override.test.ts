import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

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

// kbAskStream 的检索层：让 hasEvidence=true，走到模型调用
vi.mock('../../../src/main/model/core-agent/ask-materials', () => ({
  askMaterials: vi.fn(),
  formatEvidence: (r: any) => `ask_materials (evidence: ${(r?.hits || []).length})`,
}));

// 模型调用：记录收到的 opts（重点断言 modelOverride）
const streamChatMock = vi.fn(async function* () {
  yield { type: 'delta', text: '基于资料的回答。' };
});
vi.mock('../../../src/main/model/client', () => ({
  streamChatWithModel: (...args: unknown[]) => streamChatMock(...args),
  chatWithModel: vi.fn(async () => ({ ok: true, text: '', error: '', aborted: false })),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'uKbQaModel';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kbqa-model-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  streamChatMock.mockClear();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function streamAll(channel: string, payload: any): Promise<any[]> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const onCall = electron.ipcMain.on.mock.calls.find(([name]: [string]) => name === 'cogseed.streamStart');
  expect(onCall).toBeTruthy();
  const streamStart = onCall[1];
  const sent: any[] = [];
  const sender = {
    ...trustedIpcSender(),
    send: (_ch: string, data: unknown) => {
      if (Array.isArray(data)) sent.push(...data);
      else sent.push(data);
    },
    isDestroyed: () => false,
  };
  await streamStart({ sender }, { requestId: 'r-test-1', channel, payload });
  return sent.filter((e: any) => e && e.type !== 'done');
}

describe('kbqa.askStream › modelOverride 透传', () => {
  const HIT = {
    source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 2,
    snippet: 'alpha protocol handles tokens', score: 0.02,
  };

  it('传 model 时把 modelOverride 交给模型调用', async () => {
    const askMaterials = await import('../../../src/main/model/core-agent/ask-materials');
    vi.mocked(askMaterials.askMaterials).mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: '如何部署', summary: ['evidence ready'],
    } as any);

    const events = await streamAll('kbqa.askStream', {
      question: '如何部署',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
    });

    expect(events.some((e) => e.type === 'final')).toBe(true);
    const opts = streamChatMock.mock.calls[0]?.[0] as any;
    expect(opts).toBeTruthy();
    expect(opts.modelOverride).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('不传 model 时无 modelOverride（走默认优先级组）', async () => {
    const askMaterials = await import('../../../src/main/model/core-agent/ask-materials');
    vi.mocked(askMaterials.askMaterials).mockResolvedValue({
      hasEvidence: true, hits: [HIT], query: '如何部署', summary: ['evidence ready'],
    } as any);

    const events = await streamAll('kbqa.askStream', { question: '如何部署' });
    expect(events.some((e) => e.type === 'final')).toBe(true);
    const opts = streamChatMock.mock.calls[0]?.[0] as any;
    expect(opts.modelOverride).toBeUndefined();
  });
});
