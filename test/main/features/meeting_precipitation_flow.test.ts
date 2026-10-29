/**
 * 链路贯通测试：纠错 run 落盘 → 环节事件 → 沉淀 → 知识库落文件 → 入队索引。
 *
 * 这是 US1 的核心证据（specs/009-meeting-output-archive quickstart S1 / tasks T017 + T015）。
 * 它刻意**不打桩被测链路本身** —— 只打桩副作用边界（索引入队、搜索索引、日志），
 * 让「事件发出 → 目标判定 → 文件真的出现在 contexts 下」这条链真实跑一遍。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const enqueued: Array<{ userId: string; relPath: string; op: string }> = [];
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: (userId: string, relPath: string, op = 'upsert') => { enqueued.push({ userId, relPath, op }); },
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

const TEST_UID = 'meeting-flow-u1';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-meeting-flow-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  enqueued.length = 0;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function contextsRoot(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'contexts');
}

/** 构造一份最小的 ApplyResult（createRun 只用到这些字段）。 */
function applyResult(text: string) {
  return {
    text,
    applied: [{ action: 'replace' as const, count: 1, from: '那个', to: '哪个' }],
    deletedFillers: [],
    charsIn: text.length,
    charsOut: text.length,
    offsetMap: [],
    retention: {},
    overRewriteSuspected: false,
    pendingTotal: 0,
    status: 'applied' as const,
  };
}

async function loadAll() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  // 用**被测模块自己解析出的**根目录来定位 run 文件。
  // 为什么不用另导入一份 paths：本仓库有测试用 `vi.resetModules()` + 动态 import 的模式，
  // 各处 import 到的 paths 实例可能闭包着不同的 WS_ROOT，手工拼路径就会拼到别处
  // —— 那会让测试以 source_missing 假失败（我踩过）。
  const runsProbe = await import('../../../src/main/features/transcript_correction_runs');
  const runs = await import('../../../src/main/features/transcript_correction_runs');
  const events = await import('../../../src/main/features/meeting_stage_events');
  const precipitate = await import('../../../src/main/features/meeting_kb_precipitate');
  const target = await import('../../../src/main/features/meeting_archive_target');
  void runsProbe;
  return { runs, events, precipitate, target };
}

describe('会议产物沉淀链路贯通', () => {
  it('a subscribed precipitation handler receives the applied-run event with an existing source file', async () => {
    const { runs, events, precipitate } = await loadAll();

    // 订阅方：完全按生产 orchestrator 的方式消费事件（异步派发，不阻塞 emit）。
    const seen: string[] = [];
    const unsub = events.subscribeMeetingStages((ev) => {
      seen.push(`${ev.stage}:${ev.artifactKind}`);
      void precipitate.precipitateMeetingArtifact(TEST_UID, ev, 'stage_event');
    });

    try {
      const run = runs.createRun(TEST_UID, {
        docId: '会议/2026-10-14 走查.md',
        sourceText: '原始转写那个词被改了',
        result: applyResult('原始转写哪个词被改了'),
      });

      expect(run.status).toBe('applied');
      expect(seen).toEqual(['transcript_applied:corrected_transcript']);

      // 关键：事件携带的源文件**必须真实存在**，否则沉淀只会记 source_missing。
      const after = runs.readRunText(TEST_UID, run.runId, 'after');
      expect(after).toBe('原始转写哪个词被改了');
    } finally {
      unsub();
    }
  });

  it('precipitation writes the corrected transcript into the knowledge base and enqueues indexing', async () => {
    const { runs, events, precipitate } = await loadAll();

    const outcomes: Array<import('../../../src/main/features/meeting_kb_precipitate').PrecipitationOutcome> = [];
    const unsub = events.subscribeMeetingStages((ev) => {
      void precipitate.precipitateMeetingArtifact(TEST_UID, ev, 'stage_event').then((o) => outcomes.push(o));
    });

    try {
      const run = runs.createRun(TEST_UID, {
        docId: '会议/周会.md',
        sourceText: 'aaa 那个 bbb',
        result: applyResult('aaa 哪个 bbb'),
      });

      // 等异步沉淀完成（emit 是同步的，沉淀由订阅方自行调度）。
      const deadline = Date.now() + 5000;
      while (outcomes.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(outcomes.length).toBe(1);
      const o = outcomes[0];
      expect(o.added.length).toBe(1);
      expect(o.trigger).toBe('stage_event');

      // 1) 文件真的落在知识库里，内容正确
      const rel = o.added[0];
      expect(rel.startsWith('meetings/')).toBe(true);
      expect(rel).toContain('转写-纠错');
      const abs = path.join(contextsRoot(), rel);
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.readFileSync(abs, 'utf8')).toBe('aaa 哪个 bbb');

      // 2) 归集目录由 docKey 派生且不含会话标题（FR-034）
      expect(rel).not.toContain('周会.md');

      // 3) 已入队索引 → 「实时可检索」的前提成立
      expect(enqueued.some((e) => e.relPath === rel && e.op === 'upsert')).toBe(true);

      // 4) 版本段来自 runId，保证 v001/v002 共存不互相覆盖（FR-005）
      expect(rel).toContain(run.runId);

      void events; void runs;
    } finally {
      unsub();
    }
  });

  it('re-running precipitation for the same run is idempotent (no duplicate entries)', async () => {
    const { runs, events, precipitate, target } = await loadAll();
    void target;

    const run = runs.createRun(TEST_UID, {
      docId: '会议/幂等.md',
      sourceText: 'x 那个 y',
      result: applyResult('x 哪个 y'),
    });

    const ev = {
      stage: 'transcript_applied' as const,
      uid: TEST_UID,
      docKey: (await import('../../../src/main/features/meeting_doc')).docKeyForDocId(run.docId),
      docId: run.docId,
      artifactKind: 'corrected_transcript' as const,
      sourceAbsPath: runs.runArtifactPathsForTest(TEST_UID, run.runId).after,
      confirmed: true,
      version: run.runId,
      at: new Date().toISOString(),
    };


    const first = await precipitate.precipitateMeetingArtifact(TEST_UID, ev, 'stage_event');
    expect(first.added.length).toBe(1);
    const rel = first.added[0];

    const second = await precipitate.precipitateMeetingArtifact(TEST_UID, ev, 'stage_event');
    expect(second.added.length).toBe(0);
    expect(second.skipped.some((s) => s.rel === rel && s.reason === 'exists')).toBe(true);

    // 库里只有一份
    const dir = path.join(contextsRoot(), path.dirname(rel));
    const files = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
    expect(files.filter((n) => n === path.basename(rel)).length).toBe(1);

    void events;
  });

  it('a discarded action draft is never precipitated', async () => {
    const { precipitate } = await loadAll();
    const outcome = await precipitate.precipitateMeetingArtifact(TEST_UID, {
      stage: 'action_discarded',
      uid: TEST_UID,
      docKey: 'doc-discard-1234567890',
      artifactKind: 'actions',
      sourceText: '不该被沉淀的待办',
      confirmed: false,
      at: new Date().toISOString(),
    }, 'stage_event');

    expect(outcome.added.length).toBe(0);
    expect(outcome.skipped.some((s) => s.reason === 'discarded')).toBe(true);
  });

  it('empty content is never written as a placeholder', async () => {
    const { precipitate } = await loadAll();
    const outcome = await precipitate.precipitateMeetingArtifact(TEST_UID, {
      stage: 'conclusion_confirmed',
      uid: TEST_UID,
      docKey: 'doc-empty-1234567890',
      artifactKind: 'minutes',
      sourceText: '   \n  ',
      confirmed: false,
      at: new Date().toISOString(),
    }, 'stage_event');

    expect(outcome.added.length).toBe(0);
    expect(outcome.skipped.some((s) => s.reason === 'empty')).toBe(true);
  });

  it('lands a changed confirmed minutes as the next version instead of skipping the stale target', async () => {
    const { precipitate } = await loadAll();
    const contexts = await import('../../../src/main/features/contexts');
    const meetingDoc = await import('../../../src/main/features/meeting_doc');

    const docKey = meetingDoc.docKeyForDocId('会议/确认版本.md');
    const dirRel = `meetings/${docKey}`;
    const mk = contexts.createContextDir(dirRel);
    expect(mk.ok).toBe(true);
    const existing = contexts.writeContextFileForUser(TEST_UID, `${dirRel}/会议纪要.md`, 'OLD DRAFT');
    expect(existing.ok).toBe(true);

    const src = path.join(tmpDir, '会议纪要.md');
    fs.writeFileSync(src, 'CONFIRMED FINAL');
    const outcome = await precipitate.precipitateMeetingArtifact(TEST_UID, {
      stage: 'cleaned_copy_saved',
      uid: TEST_UID,
      docKey,
      artifactKind: 'minutes',
      sourceAbsPath: src,
      confirmed: true,
      at: new Date().toISOString(),
    }, 'ipc_action');

    expect(outcome.added).toHaveLength(1);
    const rel = outcome.added[0];
    expect(rel).toContain('会议纪要_v002.md');
    expect(fs.readFileSync(path.join(contextsRoot(), rel), 'utf8')).toBe('CONFIRMED FINAL');
    // The pre-confirmation copy is preserved, never overwritten.
    expect(fs.readFileSync(path.join(contextsRoot(), dirRel, '会议纪要.md'), 'utf8')).toBe('OLD DRAFT');
  });

});
