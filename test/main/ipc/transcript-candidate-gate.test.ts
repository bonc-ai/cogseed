/**
 * transcript.correct.flagCandidates / transcript.glossary.candidates / adoptCandidate
 * —— 跨层契约：模型候选"只能标待核，不能进转写词表"。
 *
 * 为什么值得单独测一层：这条不变量横跨 IPC（handler 怎么记账）与
 * `transcript_auto_correct.scanText`（扫描读什么）。feature 层各自的测试证明不了
 * "handler 接线之后扫描仍然看不到候选"——那正是本次需求要钉死的行为，
 * 所以这里从 handler 入口走到扫描结果，端到端验一遍。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uCandidateGate';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-candidate-gate-'));
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

const TEXT = '这块是 roadmap 在跟，语速有点快。';

describe('模型候选：标待核 ≠ 进词表', () => {
  it('flagCandidates 只落候选区：紧接着的扫描一条都不命中', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const handler = invokeHandlers['transcript.correct.flagCandidates'] as (p: unknown, c: unknown) => Promise<unknown>;
    const scan = invokeHandlers['transcript.correct.scan'] as (p: unknown, c: unknown) => Promise<unknown>;

    const flagged = await handler({
      docId: 'doc_1',
      candidates: [{
        wrong: 'roadmap', correct: 'SpeakerA', confidence: 0.92,
        reason: '上下文在讲人名', context: '这块是 roadmap 在跟', start: 3, inAllowlist: true,
      }],
    }, ctx());
    expect(flagged).toMatchObject({ ok: true, added: 1, pending: 1 });

    // 候选已落盘……
    const listed = await (invokeHandlers['transcript.glossary.candidates'] as (p: unknown, c: unknown) => Promise<any>)({}, ctx());
    expect(listed.pending).toBe(1);
    expect(listed.candidates).toHaveLength(1);

    // ……但词表（扫描依据）里没有它，扫描也就不会动这段文本
    const glossary = await (invokeHandlers['transcript.glossary.list'] as (p: unknown, c: unknown) => Promise<any>)({}, ctx());
    expect(glossary.entries).toEqual([]);
    const scanned = await scan({ text: TEXT, docId: 'doc_1' }, ctx()) as { candidates?: unknown[] };
    expect(scanned.candidates ?? []).toEqual([]);
  });

  it('人工确认入表之后才命中；未确认前同一段文本始终不被改', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const handler = invokeHandlers['transcript.correct.flagCandidates'] as (p: unknown, c: unknown) => Promise<unknown>;
    const scan = invokeHandlers['transcript.correct.scan'] as (p: unknown, c: unknown) => Promise<any>;
    const adopt = invokeHandlers['transcript.glossary.adoptCandidate'] as (p: unknown, c: unknown) => Promise<any>;

    await handler({
      docId: 'doc_1',
      candidates: [{ wrong: 'roadmap', correct: 'SpeakerA', confidence: 0.9, start: 3, inAllowlist: true }],
    }, ctx());
    expect((await scan({ text: TEXT, docId: 'doc_1' }, ctx())).candidates ?? []).toEqual([]);

    const pending = await (invokeHandlers['transcript.glossary.candidates'] as (p: unknown, c: unknown) => Promise<any>)({ state: 'pending' }, ctx());
    const adopted = await adopt({ id: pending.candidates[0].id }, ctx());
    expect(adopted.entry).toMatchObject({ wrong: 'roadmap', correct: 'SpeakerA', source: 'manual' });

    const after = await scan({ text: TEXT, docId: 'doc_1' }, ctx());
    expect(after.candidates).toHaveLength(1);
    expect(after.candidates[0]).toMatchObject({ wrong: 'roadmap', correct: 'SpeakerA' });
  });

  it('handler 挡住脏候选：空目标 / 自反 / 已在词表中的对', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const handler = invokeHandlers['transcript.correct.flagCandidates'] as (p: unknown, c: unknown) => Promise<any>;
    await (invokeHandlers['transcript.glossary.upsert'] as (p: unknown, c: unknown) => Promise<unknown>)(
      { wrong: 'coxy', correct: 'Cogseed' }, ctx(),
    );
    const result = await handler({
      candidates: [
        { wrong: '', correct: 'X' },
        { wrong: 'same', correct: 'same' },
        { wrong: 'coxy', correct: 'Cogseed' },
        { wrong: 'kstar', correct: 'KSTAR' },
      ],
    }, ctx());
    expect(result.added).toBe(1);
    expect(result.skipped.map((s: { why: string }) => s.why)).toEqual([
      'empty_target', 'identical_pair', 'already_in_glossary',
    ]);
  });

  it('候选接口不接受空 id / 越界 payload，不静默成功', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const adopt = invokeHandlers['transcript.glossary.adoptCandidate'] as (p: unknown, c: unknown) => Promise<any>;
    const discard = invokeHandlers['transcript.glossary.discardCandidate'] as (p: unknown, c: unknown) => Promise<any>;
    await expect(adopt({}, ctx())).rejects.toThrow(/id/);
    await expect(discard({ id: '' }, ctx())).rejects.toThrow(/id/);
    // 不存在的 id：如实回报 not_found，不假装成功
    expect(await adopt({ id: 'c_missing' }, ctx())).toMatchObject({ entry: null, skippedReason: 'not_found' });
    expect(await discard({ id: 'c_missing' }, ctx())).toMatchObject({ candidate: null });
  });

  it('llmCandidates 只读不写：模型读完给出候选，但词表和候选区都没变化', async () => {
    vi.doMock('../../../src/main/features/transcript_llm_candidates', async () => {
      const actual = await vi.importActual<any>('../../../src/main/features/transcript_llm_candidates');
      return {
        ...actual,
        // 新形态：模型读正文，返回带段数/失败数的完整结果
        generateReviewCandidates: async () => ({
          candidates: [{
            wrong: 'roadmap', correct: 'SpeakerA', confidence: 0.9,
            reason: '人名', start: 3, pending: false, inAllowlist: true,
          }],
          rejected: [],
          outsideAllowlist: 0,
          chunksScanned: 1,
          chunksTotal: 1,
          truncated: false,
          failedChunks: 0,
        }),
      };
    });
    vi.resetModules();
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const result = await (invokeHandlers['transcript.correct.llmCandidates'] as (p: unknown, c: unknown) => Promise<any>)(
      { text: TEXT, docId: 'doc_1' }, ctx(),
    );
    expect(result.candidates).toHaveLength(1);
    // 段数与已知写法数量要如实回传（UI 据此说明"读到哪了"）
    expect(result).toMatchObject({ chunksScanned: 1, chunksTotal: 1, truncated: false, failedChunks: 0 });
    expect(typeof result.knownCount).toBe('number');
    // 关键：产出候选不等于记账——候选区仍然是空的，词表也仍然是空的
    const listed = await (invokeHandlers['transcript.glossary.candidates'] as (p: unknown, c: unknown) => Promise<any>)({}, ctx());
    expect(listed.pending).toBe(0);
    const glossary = await (invokeHandlers['transcript.glossary.list'] as (p: unknown, c: unknown) => Promise<any>)({}, ctx());
    expect(glossary.entries).toEqual([]);
  });
});
