/**
 * meeting.conclusions.precipitate × transcript.correct.proposeCandidate —— IPC 契约
 * （specs/013 · US-504 沉淀线 T046/T047；contracts/ipc.md §1.3 / §2.4）。
 *
 * 覆盖（以 tasks.md 验收点原文为准）：
 *   T046 验证会议沉淀候选通道保持退役。
 *   T047 ① 入参校验（非法 id / 非法 kind 被拒）；② 二次提出 ⇒ created:false
 *        且不新增候选；③ 候选记录能读出词条身份与 runId；④ 落点是
 *        recall/records/candidates（**不是**个人本体候选池）。
 *
 * 直调 invokeHandlers map（照 transcript-apply-models.test.ts 的先例）：走
 * ipc/index.ts 的 dispatcher 时 err.code 会透传为 { ok:false, code }，这里在
 * 断言侧对齐同一约定（catch 后读 err.code）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uMeetingRefsIpc';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-meeting-refs-ipc-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx() {
  return { userId: TEST_UID, user: { user_id: TEST_UID, created_at: new Date(0).toISOString() }, sender: {} };
}

/** 直调 meeting.* handler；断言按 dispatcher 约定读 err.code。 */
async function callMeeting(channel: string, payload: Record<string, unknown>) {
  const { invokeHandlers } = await import('../../../src/main/ipc/meeting');
  return (invokeHandlers[channel] as (p: unknown, c: unknown) => Promise<any>)(payload, ctx());
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return String((error as { code?: unknown }).code || '');
  }
  return '';
}

const DOC = 'kb/meeting-refs-ipc.md';

/** 造一条结论并确认（走同一组通道，链路即夹具）。 */
async function confirmedConclusion(summary: string, transcriptRefs?: Array<Record<string, unknown>>) {
  const saved = await callMeeting('meeting.conclusions.save', {
    docId: DOC,
    conclusion: { summary, ...(transcriptRefs ? { transcriptRefs } : {}) },
  });
  const id = saved.conclusion.id as string;
  await callMeeting('meeting.conclusions.confirm', { docId: DOC, conclusionId: id });
  return id;
}

/** 造一条有替换台账的词表词条（runId/docId 进 replacedIn，供词条身份断言）。 */
async function seededEntry(wrong: string, correct: string, runId: string) {
  const upsert = await (async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    return (invokeHandlers['transcript.glossary.upsert'] as (p: unknown, c: unknown) => Promise<any>)(
      { wrong, correct, kind: 'term', source: 'manual' }, ctx(),
    );
  })();
  const entryId = upsert.entry.id as string;
  const glossary = await import('../../../src/main/features/transcript_glossary');
  glossary.recordReplacement(TEST_UID, [entryId], { docId: DOC, runId });
  return entryId;
}

describe('T046：meeting.conclusions.precipitate 已退役（2026-09-29 第 5 批）', () => {
  it('通道不再注册：handler 表无此键（渲染层零调用且与「会议内容不进认知主线」红线冲突，防复活守卫）', async () => {
    // 通道与旧沉淀服务均已物理退役；会议结论保存、读取与确认继续保留。
    const { invokeHandlers } = await import('../../../src/main/ipc/meeting');
    expect(Object.keys(invokeHandlers)).not.toContain('meeting.conclusions.precipitate');
  });
});

describe('纠错建议形成通道退休', () => {
  it('词表原始编辑保留，纠错词条不再独立生成Recall建议', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    expect(invokeHandlers).not.toHaveProperty('transcript.correct.proposeCandidate');
    expect(invokeHandlers).toHaveProperty('transcript.glossary.upsert');
    expect(invokeHandlers).toHaveProperty('transcript.correct.apply');
  });
});
