/**
 * 环节事件钩子 + orchestrator 的测试（specs/009-meeting-output-archive tasks T018 / T019 / T021）。
 *
 * 覆盖三件事：
 *   1. 纪要条目**首次**确认时发 `conclusion_confirmed`，重复确认**不发**；
 *   2. 待办草稿 `confirmed` / `discarded` 各自发对应事件；
 *   3. orchestrator 订阅后**异步**沉淀（不阻塞事件发出方）、按事件幂等防重放、失败重试一次。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

const TEST_UID = 'meeting-hooks-u1';
let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-meeting-hooks-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadWorld() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const events = await import('../../../src/main/features/meeting_stage_events');
  const conclusions = await import('../../../src/main/features/meeting_conclusions');
  const drafts = await import('../../../src/main/features/meeting_action_drafts');
  const precipitate = await import('../../../src/main/features/meeting_kb_precipitate');
  return { events, conclusions, drafts, precipitate };
}

const DOC_ID = '会议/走查.md';

describe('纪要确认 → conclusion_confirmed 事件', () => {
  it('emits once on the first draft→confirmed transition, with a KB-ready body', async () => {
    const { events, conclusions } = await world(loadWorld);

    const saved = conclusions.saveMeetingConclusion(TEST_UID, DOC_ID, {
      summary: '决定先完成验证再发布',
      transcriptRefs: [{ utteranceId: 'U0003', blockIndex: 2, from: 0, to: 8 }],
    });
    expect(saved.status).toBe('draft');

    const seen: Array<{ stage: string; kind: string; body: string; version?: string }> = [];
    const unsub = events.subscribeMeetingStages((ev) => {
      seen.push({
        stage: ev.stage,
        kind: ev.artifactKind,
        body: typeof ev.sourceText === 'string' ? ev.sourceText : '',
        ...(ev.version ? { version: ev.version } : {}),
      });
    });
    try {
      conclusions.confirmMeetingConclusion(TEST_UID, DOC_ID, saved.id);
      expect(seen.length).toBe(1);
      expect(seen[0].stage).toBe('conclusion_confirmed');
      expect(seen[0].kind).toBe('minutes');
      // 版本段是条目标 id → 各条目独立成文件，不互相覆盖（FR-005）
      expect(seen[0].version).toBe(saved.id);
      // 产出文本必须自带回查锚点，且**显式说明不是转写原文**（本模块只持有锚点）
      expect(seen[0].body).toContain('决定先完成验证再发布');
      expect(seen[0].body).toContain('U0003');
      expect(seen[0].body).toContain('非转写原文');
    } finally {
      unsub();
    }
  });

  it('does NOT emit on a repeat confirm (idempotent path)', async () => {
    const { events, conclusions } = await world(loadWorld);
    const saved = conclusions.saveMeetingConclusion(TEST_UID, DOC_ID, {
      summary: '重复确认不应重复发事件',
      transcriptRefs: [{ utteranceId: 'U0001', blockIndex: 0, from: 0, to: 4 }],
    });
    conclusions.confirmMeetingConclusion(TEST_UID, DOC_ID, saved.id);

    const spy = vi.fn();
    const unsub = events.subscribeMeetingStages(spy);
    try {
      conclusions.confirmMeetingConclusion(TEST_UID, DOC_ID, saved.id); // 已 confirmed
      expect(spy).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });
});

describe('待办草稿跃迁 → action_confirmed / action_discarded 事件', () => {
  it('emits action_confirmed with confirmed=true on draft→confirmed', async () => {
    const { events, drafts } = await world(loadWorld);
    const draft = drafts.saveActionDraft(TEST_UID, {
      docId: DOC_ID,
      summary: '张三出交付清单',
      owner: { speaker: '张三' },
      transcriptRefs: [{ utteranceId: 'U0005', blockIndex: 4, from: 0, to: 6 }],
    });

    const seen: Array<{ stage: string; confirmed: boolean; body: string }> = [];
    const unsub = events.subscribeMeetingStages((ev) => {
      seen.push({ stage: ev.stage, confirmed: ev.confirmed, body: typeof ev.sourceText === 'string' ? ev.sourceText : '' });
    });
    try {
      drafts.confirmActionDraft(TEST_UID, DOC_ID, draft.id);
      expect(seen.length).toBe(1);
      expect(seen[0].stage).toBe('action_confirmed');
      expect(seen[0].confirmed).toBe(true);
      expect(seen[0].body).toContain('张三出交付清单');
      expect(seen[0].body).toContain('已确认');
    } finally {
      unsub();
    }
  });

  it('emits action_discarded with confirmed=false on draft→discarded', async () => {
    const { events, drafts } = await world(loadWorld);
    const draft = drafts.saveActionDraft(TEST_UID, {
      docId: DOC_ID,
      summary: '这条被丢弃了',
      transcriptRefs: [{ utteranceId: 'U0006', blockIndex: 5, from: 0, to: 3 }],
    });

    const seen: Array<{ stage: string; confirmed: boolean }> = [];
    const unsub = events.subscribeMeetingStages((ev) => {
      seen.push({ stage: ev.stage, confirmed: ev.confirmed });
    });
    try {
      drafts.discardActionDraft(TEST_UID, DOC_ID, draft.id);
      expect(seen).toEqual([{ stage: 'action_discarded', confirmed: false }]);
    } finally {
      unsub();
    }
  });

  it('does not guess an owner when none was given', async () => {
    const { events, drafts } = await world(loadWorld);
    const draft = drafts.saveActionDraft(TEST_UID, {
      docId: DOC_ID,
      summary: '没写负责人的待办',
      transcriptRefs: [{ utteranceId: 'U0007', blockIndex: 6, from: 0, to: 3 }],
    });
    let body = '';
    const unsub = events.subscribeMeetingStages((ev) => { body = typeof ev.sourceText === 'string' ? ev.sourceText : ''; });
    try {
      drafts.confirmActionDraft(TEST_UID, DOC_ID, draft.id);
      // 与 meeting-actions 技能口径一致：不得按职位或语气推人
      expect(body).toContain('未指定');
    } finally {
      unsub();
    }
  });
});

describe('startMeetingPrecipitationOrchestrator', () => {
  it('precipitates asynchronously — the event emitter is never blocked by precipitation', async () => {
    const { events, precipitate } = await world(loadWorld);
    const calls: string[] = [];
    const stop = precipitate.startMeetingPrecipitationOrchestrator({
      subscribe: (l) => events.subscribeMeetingStages(l),
      precipitate: async (_uid, ev) => {
        calls.push(`${ev.stage}:${ev.artifactKind}`);
        return {
          docKey: ev.docKey, trigger: 'stage_event', added: [], skipped: [], failed: [], durationMs: 0,
          target: {
            scope: 'global', libraryRelPath: '', archiveRootRelPath: 'meetings',
            meetingDirRelPath: `meetings/${ev.docKey}`, resolvedBy: 'personal', explanationKey: 'x',
          },
        };
      },
    });
    try {
      // emit 是同步的；沉淀必须推迟到之后的 tick，否则会议主流程会被拖住（FR-004 / SC-006）。
      events.emitMeetingStage({
        stage: 'transcript_applied', uid: TEST_UID, docKey: 'k1',
        artifactKind: 'corrected_transcript', sourceText: 'x', confirmed: true, at: 'T1',
      });
      expect(calls).toEqual([]); // 同步阶段不得已经跑过
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toEqual(['transcript_applied:corrected_transcript']);
    } finally {
      stop();
    }
  });

  it('reports the outcome to the supplied reporter (UI feedback seam, FR-003)', async () => {
    const { events, precipitate } = await world(loadWorld);
    const reported: Array<{ uid: string; added: number; scope: string }> = [];
    const stop = precipitate.startMeetingPrecipitationOrchestrator({
      subscribe: (l) => events.subscribeMeetingStages(l),
      precipitate: async (_uid, ev) => ({
        docKey: ev.docKey, trigger: 'stage_event',
        added: [`meetings/${ev.docKey}/转写-纠错_x.md`],
        skipped: [], failed: [], durationMs: 0,
        target: {
          scope: 'global', libraryRelPath: '', archiveRootRelPath: 'meetings',
          meetingDirRelPath: `meetings/${ev.docKey}`, resolvedBy: 'personal', explanationKey: 'x',
        },
      }),
      report: (uid, outcome) => { reported.push({ uid, added: outcome.added.length, scope: outcome.target.scope }); },
    });
    try {
      events.emitMeetingStage({
        stage: 'transcript_applied', uid: TEST_UID, docKey: 'k9',
        artifactKind: 'corrected_transcript', sourceText: 'x', confirmed: true, at: 'T9',
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(reported).toEqual([{ uid: TEST_UID, added: 1, scope: 'global' }]);
    } finally {
      stop();
    }
  });

  it('de-duplicates replayed identical events (process-level anti-replay)', async () => {
    const { events, precipitate } = await world(loadWorld);
    let n = 0;
    const stop = precipitate.startMeetingPrecipitationOrchestrator({
      subscribe: (l) => events.subscribeMeetingStages(l),
      precipitate: async (_uid, ev) => {
        n += 1;
        return {
          docKey: ev.docKey, trigger: 'stage_event', added: [], skipped: [], failed: [], durationMs: 0,
          target: {
            scope: 'global', libraryRelPath: '', archiveRootRelPath: 'meetings',
            meetingDirRelPath: `meetings/${ev.docKey}`, resolvedBy: 'personal', explanationKey: 'x',
          },
        };
      },
    });
    const same = {
      stage: 'conclusion_confirmed' as const, uid: TEST_UID, docKey: 'k2',
      artifactKind: 'minutes' as const, sourceText: 'x', confirmed: true, version: 'v1', at: 'T2',
    };
    try {
      events.emitMeetingStage(same);
      events.emitMeetingStage(same); // 同一事件重放
      await new Promise((r) => setTimeout(r, 40));
      expect(n).toBe(1);
    } finally {
      stop();
    }
  });

  it('retries once on failure, then gives up without throwing', async () => {
    const { events, precipitate } = await world(loadWorld);
    let attempts = 0;
    const stop = precipitate.startMeetingPrecipitationOrchestrator({
      subscribe: (l) => events.subscribeMeetingStages(l),
      precipitate: async () => {
        attempts += 1;
        throw new Error('boom');
      },
    });
    try {
      events.emitMeetingStage({
        stage: 'transcript_applied', uid: TEST_UID, docKey: 'k3',
        artifactKind: 'corrected_transcript', sourceText: 'x', confirmed: true, at: 'T3',
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(attempts).toBe(2); // 首次 + 重试一次
    } finally {
      stop();
    }
  });

  it('a throwing reporter cannot break precipitation', async () => {
    const { events, precipitate } = await world(loadWorld);
    let precipitated = false;
    const stop = precipitate.startMeetingPrecipitationOrchestrator({
      subscribe: (l) => events.subscribeMeetingStages(l),
      precipitate: async (_uid, ev) => {
        precipitated = true;
        return {
          docKey: ev.docKey, trigger: 'stage_event', added: [], skipped: [], failed: [], durationMs: 0,
          target: {
            scope: 'global', libraryRelPath: '', archiveRootRelPath: 'meetings',
            meetingDirRelPath: `meetings/${ev.docKey}`, resolvedBy: 'personal', explanationKey: 'x',
          },
        };
      },
      report: () => { throw new Error('ui blew up'); },
    });
    try {
      events.emitMeetingStage({
        stage: 'transcript_applied', uid: TEST_UID, docKey: 'k4',
        artifactKind: 'corrected_transcript', sourceText: 'x', confirmed: true, at: 'T4',
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(precipitated).toBe(true);
    } finally {
      stop();
    }
  });
});

/** 小工具：调用 loadWorld 并返回其结果（保持各用例内联可读）。 */
function world(loader: () => Promise<unknown>) {
  return loader() as ReturnType<typeof loadWorld>;
}
