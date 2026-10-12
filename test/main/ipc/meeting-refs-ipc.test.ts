/**
 * meeting.conclusions.precipitate × transcript.correct.proposeCandidate —— IPC 契约
 * （specs/013 · US-504 沉淀线 T046/T047；contracts/ipc.md §1.3 / §2.4）。
 *
 * 覆盖（以 tasks.md 验收点原文为准）：
 *   T046 ① draft 态沉淀被拒（not_confirmed）；② 确认后沉淀成功且候选落盘；
 *        ③ 给不出段落锚点 ⇒ 候选落 weak_observation（**如实行为，不是缺陷**）；
 *        ④ 二次沉淀幂等（captureKey 命中不重复建账）；⑤ T048 两键各自被拒；
 *        ⑥ 入参校验（docId/conclusionId/suggestedType）。
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

/** 直调 transcript.correct.proposeCandidate。 */
async function callPropose(payload: Record<string, unknown>) {
  const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
  return (invokeHandlers['transcript.correct.proposeCandidate'] as (p: unknown, c: unknown) => Promise<any>)(payload, ctx());
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
    // 原服务级行为闸（确认闸/幂等/锚点/T048 打标边界）随通道一并退役；
    // precipitateMeetingConclusion 保留在 features 层待「通道退役大批」统一处置。
    const { invokeHandlers } = await import('../../../src/main/ipc/meeting');
    expect(Object.keys(invokeHandlers)).not.toContain('meeting.conclusions.precipitate');
  });
});

describe('T047：transcript.correct.proposeCandidate（从纠错面板提出为候选）', () => {
  it('① 入参校验：非法 entryId 被拒（invalid_item_id）；非法 entryKind 被拒（invalid_input）', async () => {
    expect(await codeOf(() => callPropose({ entryId: 'g_1', entryKind: 'term' }))).toBe('item_missing'); // 词表还没有 g_1
    expect(await codeOf(() => callPropose({ entryId: '', entryKind: 'term' }))).toBe('invalid_item_id');
    expect(await codeOf(() => callPropose({ entryId: 'bad id!', entryKind: 'term' }))).toBe('invalid_item_id');
    expect(await codeOf(() => callPropose({ entryId: 'g_1', entryKind: 'nope' }))).toBe('invalid_input');
    expect(await codeOf(() => callPropose({ entryId: 'g_1' }))).toBe('invalid_input');
  });

  it('② 二次提出 ⇒ created:false 且不新增候选（captureKey = glossary-<entryId> 幂等）', async () => {
    const entryId = await seededEntry('coxy', 'Cogseed', 'run_42');
    const first = await callPropose({ entryId, entryKind: 'term', docId: DOC });
    expect(first.created).toBe(true);
    const second = await callPropose({ entryId, entryKind: 'term', docId: DOC });
    expect(second.created).toBe(false);
    expect(second.candidateId).toBe(first.candidateId);
    const { listRecallCandidates } = await import('../../../src/main/features/recall/candidate-service');
    const pool = await listRecallCandidates(TEST_UID);
    expect(pool).toHaveLength(1);
    expect(pool[0].captureKey).toBe(`glossary-${entryId}`);
  });

  it('③ 候选记录能读出词条身份（wrong→correct）与 runId（title 后缀承载）', async () => {
    const entryId = await seededEntry('付平', '傅平', 'run_77');
    const result = await callPropose({ entryId, entryKind: 'people', docId: DOC });
    const { readRecallCandidate } = await import('../../../src/main/features/recall/candidate-service');
    const candidate = await readRecallCandidate(TEST_UID, result.candidateId);
    expect(candidate.judgment).toContain('付平');
    expect(candidate.judgment).toContain('傅平');
    // 词条身份 + 哪次 run：既有写口（normalizeCognitionSourceRefsForWrite）会剥
    // excerpt（写侧只存元数据的既有纪律），所以 runId 并入 title 后缀作为落盘
    // 可读载体——title 前缀仍是契约钉死的 '<wrong>→<correct>'。
    const identity = candidate.evidenceRefs.find((r) => (r.title || '').includes('→'));
    expect(identity?.title).toBe('付平→傅平 · run_77');
    expect(identity?.title).toContain('付平→傅平');
    expect(identity?.title).toContain('run_77');
  });

  it('④ 落点是 recall/records/candidates——不是个人本体候选池（contrast transcript_ontology_bridge:399-418）', async () => {
    const entryId = await seededEntry('k 星', 'KSTAR', 'run_9');
    await callPropose({ entryId, entryKind: 'term', docId: DOC });
    const { userCloudRoot, userLocalRoot } = await import('../../../src/main/paths');
    const recallCandidates = path.join(userCloudRoot(TEST_UID), 'recall', 'records', 'candidates');
    expect(fs.existsSync(recallCandidates)).toBe(true);
    expect(fs.readdirSync(recallCandidates).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    // 个人本体池（contributeCandidates 的 addCandidate 落点）保持零写入
    const ontologyPool = path.join(userLocalRoot(TEST_UID), 'ontology_candidates');
    expect(fs.existsSync(ontologyPool)).toBe(false);
  });

  it('⑤ tags / category 同口径被拒（field_not_available，012 边界）', async () => {
    const entryId = await seededEntry('白名单词', '正确词', 'run_5');
    expect(await codeOf(() => callPropose({ entryId, entryKind: 'term', tags: ['术语'] } as never)))
      .toBe('field_not_available');
    expect(await codeOf(() => callPropose({ entryId, entryKind: 'term', category: '术语' } as never)))
      .toBe('field_not_available');
    const { listRecallCandidates } = await import('../../../src/main/features/recall/candidate-service');
    expect(await listRecallCandidates(TEST_UID)).toHaveLength(0);
  });

  it('⑥ 无文档上下文且无台账 ⇒ sourceRefs 空、候选落 weak_observation（如实，不造来源）', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const upsert = await (invokeHandlers['transcript.glossary.upsert'] as (p: unknown, c: unknown) => Promise<any>)(
      { wrong: '无台账词', correct: '目标词', kind: 'term', source: 'manual' }, ctx(),
    );
    const result = await callPropose({ entryId: upsert.entry.id, entryKind: 'term' });   // 不带 docId
    const { readRecallCandidate } = await import('../../../src/main/features/recall/candidate-service');
    const candidate = await readRecallCandidate(TEST_UID, result.candidateId);
    expect(candidate.sourceRefs).toHaveLength(0);
    expect(candidate.status).toBe('weak_observation');
  });
});
