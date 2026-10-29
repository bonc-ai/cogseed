/**
 * 归档目标判定测试（对应 contracts/README.md A2 与规格 FR-008 ~ FR-012 / FR-025）。
 *
 * 必测点：
 *   - 三级优先级：显式指定 > 会话空间归属 > 个人库默认；
 *   - **显式目标不可访问时返回失败，而不是静默回退**（VR-3 / FR-025）——
 *     这是本规格最容易写错、后果最严重的一条：静默回退会让用户以为"存进去了"；
 *   - 归集目录由**稳定标识** docKey 派生，不复用会话标题（FR-034）；
 *   - 库名校验：拒绝多段、隐藏目录、穿越名；
 *   - 改判不迁移：本模块**不导出任何移动/删除能力**（结构性保证 FR-011）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  getConversation: vi.fn(),
  spaceExists: vi.fn(),
  listSpaces: vi.fn(),
  getSpace: vi.fn(),
  listContextsTreeForUser: vi.fn(),
  hasHiddenContextPathSegment: vi.fn(),
}));

vi.mock('../../../src/main/features/chats', () => ({
  getConversation: mocks.getConversation,
}));
vi.mock('../../../src/main/features/spaces', () => ({
  spaceExists: mocks.spaceExists,
  listSpaces: mocks.listSpaces,
  getSpace: mocks.getSpace,
}));
vi.mock('../../../src/main/features/contexts', () => ({
  listContextsTreeForUser: mocks.listContextsTreeForUser,
  hasHiddenContextPathSegment: mocks.hasHiddenContextPathSegment,
}));

const TEST_UID = 'target-u1';

type Target = typeof import('../../../src/main/features/meeting_archive_target');

async function loadMod(): Promise<Target> {
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  return import('../../../src/main/features/meeting_archive_target');
}

const DOC_KEY = 'M-abc123-0123456789';

describe('meeting_archive_target.resolveArchiveTarget', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getConversation.mockReset();
    mocks.spaceExists.mockReset();
    mocks.listSpaces.mockReset();
    mocks.getSpace.mockReset();
    mocks.listContextsTreeForUser.mockReset();
    mocks.hasHiddenContextPathSegment.mockReset();
    mocks.hasHiddenContextPathSegment.mockReturnValue(false);
  });

  it('rejects an empty docKey', async () => {
    const mod = await loadMod();
    const res = await mod.resolveArchiveTarget(TEST_UID, { docKey: '   ' });
    expect(res.ok).toBe(false);
  });

  it('rejects a docKey containing path separators or a leading dot', async () => {
    const mod = await loadMod();
    expect((await mod.resolveArchiveTarget(TEST_UID, { docKey: '../escape' })).ok).toBe(false);
    expect((await mod.resolveArchiveTarget(TEST_UID, { docKey: 'a/b' })).ok).toBe(false);
    expect((await mod.resolveArchiveTarget(TEST_UID, { docKey: '.hidden' })).ok).toBe(false);
  });

  it('falls back to the personal library when the conversation has no space', async () => {
    const mod = await loadMod();
    mocks.getConversation.mockResolvedValue({ conversation_id: 'c1', title: '无关标题' });
    const res = await mod.resolveArchiveTarget(TEST_UID, { docKey: DOC_KEY, conversationId: 'c1' });
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; target: Target['ArchiveTarget'] }).target;
    expect(t.scope).toBe('global');
    expect(t.resolvedBy).toBe('personal');
    expect(t.libraryRelPath).toBe('');
    expect(t.meetingDirRelPath).toBe(`meetings/${DOC_KEY}`);
  });

  it('routes to the space library when the conversation belongs to a space', async () => {
    const mod = await loadMod();
    mocks.getConversation.mockResolvedValue({ conversation_id: 'c2', space_id: 'sp_1' });
    mocks.spaceExists.mockResolvedValue(true);
    const res = await mod.resolveArchiveTarget(TEST_UID, { docKey: DOC_KEY, conversationId: 'c2' });
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; target: Target['ArchiveTarget'] }).target;
    expect(t.scope).toBe('space');
    expect(t.spaceId).toBe('sp_1');
    expect(t.resolvedBy).toBe('space');
  });

  it('fails (does NOT fall back) when the conversation space is unavailable', async () => {
    const mod = await loadMod();
    mocks.getConversation.mockResolvedValue({ conversation_id: 'c3', space_id: 'sp_gone' });
    mocks.spaceExists.mockResolvedValue(false);
    const res = await mod.resolveArchiveTarget(TEST_UID, { docKey: DOC_KEY, conversationId: 'c3' });
    expect(res.ok).toBe(false);
    const e = res as { ok: false; error: string; code?: string };
    expect(e.code).toBe('target_unavailable');
  });

  it('lets an explicit library override the space default', async () => {
    const mod = await loadMod();
    mocks.getConversation.mockResolvedValue({ conversation_id: 'c4', space_id: 'sp_1' });
    mocks.spaceExists.mockResolvedValue(true);
    // 显式指定只对个人库生效（库名是 contexts 的一级目录）；这里验证它压过空间默认。
    const res = await mod.resolveArchiveTarget(TEST_UID, {
      docKey: DOC_KEY, conversationId: 'c4', explicitLibrary: '',
    });
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; target: Target['ArchiveTarget'] }).target;
    expect(t.resolvedBy).toBe('explicit');
    expect(t.scope).toBe('global');
  });

  it('rejects a multi-segment explicit library (must be a single library name)', async () => {
    const mod = await loadMod();
    const res = await mod.resolveArchiveTarget(TEST_UID, { docKey: DOC_KEY, explicitLibrary: 'a/b' });
    expect(res.ok).toBe(false);
  });

  it('rejects a hidden explicit library', async () => {
    const mod = await loadMod();
    const res = await mod.resolveArchiveTarget(TEST_UID, { docKey: DOC_KEY, explicitLibrary: '.secret' });
    expect(res.ok).toBe(false);
  });

  it('explicit library that does not exist fails rather than silently falling back', async () => {
    const mod = await loadMod();
    // 个人库不存在时 personalLibraryExists 为 false → 必须失败。
    const res = await mod.resolveArchiveTarget(TEST_UID, {
      docKey: DOC_KEY, explicitLibrary: `no-such-lib-${Date.now()}`,
    });
    expect(res.ok).toBe(false);
  });

  it('keeps the collection directory keyed by the stable docKey, not the conversation title', async () => {
    const mod = await loadMod();
    mocks.getConversation.mockResolvedValue({ conversation_id: 'c5', title: '今天的会议（会被改名）' });
    const first = await mod.resolveArchiveTarget(TEST_UID, { docKey: DOC_KEY, conversationId: 'c5' });
    // 标题改了，docKey 不变 → 归集目录必须不变（FR-006 / FR-034）。
    mocks.getConversation.mockResolvedValue({ conversation_id: 'c5', title: '改名后的标题' });
    const second = await mod.resolveArchiveTarget(TEST_UID, { docKey: DOC_KEY, conversationId: 'c5' });
    const t1 = (first as { ok: true; target: Target['ArchiveTarget'] }).target;
    const t2 = (second as { ok: true; target: Target['ArchiveTarget'] }).target;
    expect(t1.meetingDirRelPath).toBe(t2.meetingDirRelPath);
    expect(t1.meetingDirRelPath).toContain(DOC_KEY);
    expect(t1.meetingDirRelPath).not.toContain('今天的会议');
  });

  it('uses meets as the archive root and never reuses the task-archive convention', async () => {
    const mod = await loadMod();
    const res = await mod.resolveArchiveTarget(TEST_UID, { docKey: DOC_KEY });
    const t = (res as { ok: true; target: Target['ArchiveTarget'] }).target;
    expect(t.archiveRootRelPath).toBe('meetings');
    expect(t.meetingDirRelPath.startsWith('meetings/')).toBe(true);
    // 不得复用 from-tasks（那是任务产物的既有约定，按会话标题组织，会分裂）。
    expect(t.meetingDirRelPath).not.toContain('from-tasks');
  });

  it('survives a getConversation failure by degrading to the personal library', async () => {
    const mod = await loadMod();
    mocks.getConversation.mockRejectedValue(new Error('index unreadable'));
    const res = await mod.resolveArchiveTarget(TEST_UID, { docKey: DOC_KEY, conversationId: 'c6' });
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; target: Target['ArchiveTarget'] }).target;
    expect(t.resolvedBy).toBe('personal');
  });

  it('exposes no move/rename/delete capability (structural guarantee for FR-011)', async () => {
    const mod = await loadMod();
    const names = Object.keys(mod);
    expect(names.some((n) => /move|rename|delete|migrate/i.test(n))).toBe(false);
  });
});
