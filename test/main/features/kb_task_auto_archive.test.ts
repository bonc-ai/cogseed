import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/** kb_indexer + search: no-op side effects (contexts.test.ts pattern). */
const kbEnqueueCalls: Array<{ userId: string; relPath: string; op: string }> = [];
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: (userId: string, relPath: string, op = 'upsert') => {
    kbEnqueueCalls.push({ userId, relPath, op });
  },
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

const mocks = vi.hoisted(() => ({
  readMessages: vi.fn(),
  subscribeTaskTerminals: vi.fn(() => () => {}),
  getConversation: vi.fn(),
  listAttachments: vi.fn(),
  resolveAttachmentAbsPath: vi.fn(),
}));

vi.mock('../../../src/main/features/group_chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/group_chat')>();
  return { ...actual, readMessages: mocks.readMessages };
});
vi.mock('../../../src/main/features/group_chat/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/group_chat/bus')>();
  return { ...actual, subscribeTaskTerminals: mocks.subscribeTaskTerminals };
});
vi.mock('../../../src/main/features/chats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/chats')>();
  return { ...actual, getConversation: mocks.getConversation };
});
vi.mock('../../../src/main/features/chat_attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/chat_attachments')>();
  return {
    ...actual,
    listAttachments: mocks.listAttachments,
    resolveAttachmentAbsPath: mocks.resolveAttachmentAbsPath,
  };
});

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'auto-archive-u1';

/** 加载被测模块（resetModules 后，保证 mock 生效且用户已激活）。 */
async function loadMod() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  return import('../../../src/main/features/kb_task_auto_archive');
}

function ctxRoot(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'contexts');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kb-auto-archive-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  kbEnqueueCalls.length = 0;
  mocks.readMessages.mockReset();
  mocks.subscribeTaskTerminals.mockReset();
  mocks.getConversation.mockReset();
  mocks.listAttachments.mockReset();
  mocks.resolveAttachmentAbsPath.mockReset();
  vi.resetModules();
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('slugForConversation', () => {
  it('sanitises a conversation title to a safe slug', async () => {
    const mod = await loadMod();
    expect(mod.slugForConversation('我的 调研/方案:C03', 'cid-123')).toBe('我的-调研-方案-C03');
  });

  it('falls back to task-<cid> when title is empty', async () => {
    const mod = await loadMod();
    const slug = mod.slugForConversation('  ', 'cid-9');
    expect(slug.startsWith('task-')).toBe(true);
    expect(slug).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('never yields a dot-leading or traversal segment', async () => {
    const mod = await loadMod();
    const slug = mod.slugForConversation('..hidden', 'c');
    expect(slug.startsWith('.')).toBe(false);
    expect(slug).not.toContain('..');
  });
});

describe('collectProducedSources', () => {
  it('collects only existing, indexable, non-hidden produced files', async () => {
    const mod = await loadMod();
    const keep = path.join(tmpDir, 'ws', 'report.md');
    const img = path.join(tmpDir, 'ws', 'cover.png');
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.writeFileSync(keep, '# hi');
    fs.writeFileSync(img, 'fake');
    const messages = [
      { id: 'm1', ts: 'x', from: 'commander', produced: [keep] },
      // mp4 is not indexable → dropped
      { id: 'm2', ts: 'x', from: 'commander', produced: [path.join(tmpDir, 'ws', 'clip.mp4')] },
      // missing file → dropped
      { id: 'm3', ts: 'x', from: 'commander', produced: [path.join(tmpDir, 'ws', 'nope.md')] },
      // dot file → dropped
      { id: 'm4', ts: 'x', from: 'commander', produced: [path.join(tmpDir, 'ws', '.secret.md')] },
      { id: 'm5', ts: 'x', from: 'commander', produced: [img] },
    ] as any[];
    const out = mod.collectProducedSources(messages);
    expect(out.map((s) => s.name).sort()).toEqual(['cover.png', 'report.md']);
  });

  it('dedupes repeated produced paths', async () => {
    const mod = await loadMod();
    const f = path.join(tmpDir, 'ws', 'a.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    const messages = [
      { id: 'm1', produced: [f] },
      { id: 'm2', produced: [f] },
    ] as any[];
    expect(mod.collectProducedSources(messages)).toHaveLength(1);
  });
});

describe('archiveSourcesToLibrary (personal scope)', () => {
  it('copies sources into contexts/from-tasks/<slug> and skips on rerun', async () => {
    const mod = await loadMod();
    mocks.getConversation.mockResolvedValue({ id: 'cid-1', title: '绘画 demo', space_id: undefined });

    const srcDir = path.join(tmpDir, 'ws');
    const fileA = path.join(srcDir, 'result.md');
    const fileB = path.join(srcDir, 'painting.png');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(fileA, '# 绘画说明');
    fs.writeFileSync(fileB, 'pngbytes');

    const first = await mod.archiveSourcesToLibrary(TEST_UID, 'cid-1', '绘画-demo', [
      { absPath: fileA, name: 'result.md', source: 'produced' },
      { absPath: fileB, name: 'painting.png', source: 'produced' },
    ]);
    expect(first.ok ?? first.failed).toBeTruthy();
    expect(first.dir).toBe('from-tasks/绘画-demo');
    expect(first.archived).toEqual(expect.arrayContaining([
      'from-tasks/绘画-demo/result.md',
      'from-tasks/绘画-demo/painting.png',
    ]));
    expect(fs.existsSync(path.join(ctxRoot(), 'from-tasks/绘画-demo/result.md'))).toBe(true);
    // enqueue fired for copied files
    expect(kbEnqueueCalls.some((c) => c.relPath === 'from-tasks/绘画-demo/result.md')).toBe(true);

    // Second run: same target exists → skipped (idempotent), no second copy.
    const second = await mod.archiveSourcesToLibrary(TEST_UID, 'cid-1', '绘画-demo', [
      { absPath: fileA, name: 'result.md', source: 'produced' },
    ]);
    expect(second.skipped).toEqual(['from-tasks/绘画-demo/result.md']);
  });
});

describe('startTaskAutoArchiveOrchestrator', () => {
  it('archives only completed events and dedupes by uid:runId', async () => {
    const mod = await loadMod();
    let listener: ((e: any) => void) | undefined;
    mocks.subscribeTaskTerminals.mockImplementation((fn: any) => {
      listener = fn;
      return () => {};
    });
    const archive = vi.fn(async () => ({ dir: 'from-tasks/x', archived: ['a.md'], skipped: [], failed: [] }));
    const stop = mod.startTaskAutoArchiveOrchestrator({ archive });

    const event = (status: string) => ({
      run_id: 'run-1',
      user_id: 'user-a',
      conversation_id: 'conv-1',
      status,
    });
    listener?.(event('failed')); // ignored
    listener?.(event('completed'));
    listener?.(event('completed')); // deduped
    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive.mock.calls[0][0]).toMatchObject({ userId: 'user-a', conversationId: 'conv-1', runId: 'run-1', status: 'completed' });

    stop();
    expect(mocks.subscribeTaskTerminals).toHaveBeenCalledTimes(1);
  });
});
