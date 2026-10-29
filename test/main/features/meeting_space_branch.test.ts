/**
 * 空间库分支测试（specs/009-meeting-output-archive tasks T036；research R3 残留风险）。
 *
 * 为什么单独测这个分支：空间库走 `project_files.uploadSpaceFile`，它**不同名覆盖** ——
 * 重名时会加 `-YYYYMMDD-HHmmss` 时间戳后缀，也就是**重跑会产生副本**。
 * 因此幂等必须靠「上传前先查目标是否存在」，不能靠上传原语本身。
 * 现有 `kb_task_auto_archive.test.ts` 对空间分支零覆盖，本文件补上这个缺口。
 *
 * 用 mock 隔离空间库原语：不需要真实空间目录，就能钉住"查重 → 上传 / 跳过"的分支选择。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

const mocks = vi.hoisted(() => ({
  listSpaceFiles: vi.fn(),
  uploadSpaceFile: vi.fn(),
  resolveArchiveTarget: vi.fn(),
}));

vi.mock('../../../src/main/features/project_files', () => ({
  listSpaceFiles: mocks.listSpaceFiles,
  uploadSpaceFile: mocks.uploadSpaceFile,
}));
vi.mock('../../../src/main/features/meeting_archive_target', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/meeting_archive_target')>();
  return { ...actual, resolveArchiveTarget: mocks.resolveArchiveTarget };
});

const TEST_UID = 'space-branch-u1';
const DOC_KEY = 'spacemeeting-0123456789';
const SPACE_ID = 'sp_test_1';

type Precipitate = typeof import('../../../src/main/features/meeting_kb_precipitate');

async function loadMod(): Promise<Precipitate> {
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  return import('../../../src/main/features/meeting_kb_precipitate');
}

const SPACE_TARGET = {
  scope: 'space' as const,
  spaceId: SPACE_ID,
  libraryRelPath: '',
  archiveRootRelPath: 'meetings',
  meetingDirRelPath: `meetings/${DOC_KEY}`,
  resolvedBy: 'space' as const,
  explanationKey: 'meeting.precipitation.target.space',
};

function ev() {
  return {
    stage: 'transcript_applied' as const,
    uid: TEST_UID,
    docKey: DOC_KEY,
    artifactKind: 'corrected_transcript' as const,
    sourceText: '空间库里的纠错转写',
    confirmed: true,
    version: 'run_space_1',
    at: 'T-space',
  };
}

describe('空间库分支：上传前查重（幂等不能靠上传原语）', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.listSpaceFiles.mockReset();
    mocks.uploadSpaceFile.mockReset();
    mocks.resolveArchiveTarget.mockReset();
    mocks.resolveArchiveTarget.mockResolvedValue({ ok: true, target: SPACE_TARGET });
  });

  it('uploads when the target does not exist yet, and records it as added', async () => {
    const mod = await loadMod();
    mocks.listSpaceFiles.mockResolvedValue([]); // 空间库为空
    mocks.uploadSpaceFile.mockResolvedValue({ ok: true, info: { relPath: `meetings/${DOC_KEY}/x.md` } });

    const outcome = await mod.precipitateMeetingArtifact(TEST_UID, ev(), 'stage_event');

    expect(outcome.target.scope).toBe('space');
    expect(outcome.added.length).toBe(1);
    expect(outcome.skipped.length).toBe(0);
    expect(mocks.uploadSpaceFile).toHaveBeenCalledTimes(1);
    // 上传的路径必须在会议归集目录下（FR-034 / SC-005）
    const call = mocks.uploadSpaceFile.mock.calls[0];
    expect(call[0]).toBe(TEST_UID);
    expect(call[1]).toBe(SPACE_ID);
    expect(String(call[2]).startsWith(`meetings/${DOC_KEY}/`)).toBe(true);
  });

  it('skips WITHOUT uploading when the same target already exists (idempotency)', async () => {
    const mod = await loadMod();
    const rel = `meetings/${DOC_KEY}/转写-纠错_run_space_1.md`;
    // 关键：目标已存在 → 必须**不调用**上传，否则 uploadSpaceFile 会加时间戳产副本
    mocks.listSpaceFiles.mockResolvedValue([{ relPath: rel, name: 'x.md' }]);

    const outcome = await mod.precipitateMeetingArtifact(TEST_UID, ev(), 'stage_event');

    expect(outcome.added.length).toBe(0);
    expect(outcome.skipped.some((s) => s.rel === rel && s.reason === 'exists')).toBe(true);
    expect(mocks.uploadSpaceFile).not.toHaveBeenCalled();
  });

  it('treats an upload rejection as a failure with the reason preserved', async () => {
    const mod = await loadMod();
    mocks.listSpaceFiles.mockResolvedValue([]);
    mocks.uploadSpaceFile.mockResolvedValue({ ok: false, error: 'space full' });

    const outcome = await mod.precipitateMeetingArtifact(TEST_UID, ev(), 'stage_event');

    expect(outcome.added.length).toBe(0);
    expect(outcome.failed.length).toBe(1);
    expect(outcome.failed[0].error).toBe('space full');
  });

  it('still attempts the upload when the pre-check itself fails (fail-open, not fail-closed)', async () => {
    const mod = await loadMod();
    // 查重失败时**不放弃沉淀** —— 由上传结果决定。宁可多一次上传尝试（上传原语自身
    // 有扩展名与路径校验），也不要因为一次列举失败就丢掉用户的成果。
    mocks.listSpaceFiles.mockRejectedValue(new Error('index unreadable'));
    mocks.uploadSpaceFile.mockResolvedValue({ ok: true, info: { relPath: `meetings/${DOC_KEY}/x.md` } });

    const outcome = await mod.precipitateMeetingArtifact(TEST_UID, ev(), 'stage_event');

    expect(mocks.uploadSpaceFile).toHaveBeenCalledTimes(1);
    expect(outcome.added.length).toBe(1);
  });

  it('never touches the personal library when the target is a space', async () => {
    const mod = await loadMod();
    mocks.listSpaceFiles.mockResolvedValue([]);
    mocks.uploadSpaceFile.mockResolvedValue({ ok: true, info: { relPath: 'x' } });

    const outcome = await mod.precipitateMeetingArtifact(TEST_UID, ev(), 'stage_event');

    // 空间库分支不得落到 global（否则同一次沉淀会写两个地方）
    expect(outcome.target.scope).toBe('space');
    expect(outcome.added.every((r) => !r.includes('unknown'))).toBe(true);
  });
});
