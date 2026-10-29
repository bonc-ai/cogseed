/**
 * 终态兜底测试（specs/009-meeting-output-archive tasks T031 / T032 / T033；
 * 规格 FR-013 ~ FR-017、FR-033）。
 *
 * 覆盖：
 *   - 补齐阶段过程漏掉的产物，并给出**新增 / 跳过 / 失败**三类计数（FR-017）；
 *   - 重复跑不产生副本（幂等，SC-003）；
 *   - 同一场会分多次处理仍归到**同一目录**（SC-005，不分裂）；
 *   - 已齐备的候选走"不重复触碰磁盘"的快速路径；
 *   - 单份失败不中断其余候选。
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

const TEST_UID = 'sweep-u1';
const DOC_KEY = 'sweepmeeting-0123456789';
let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-sweep-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  return import('../../../src/main/features/meeting_kb_precipitate');
}

function contextsRoot(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'contexts');
}

function ev(over: Partial<import('../../../src/main/features/meeting_stage_events').MeetingStageEvent> = {}) {
  return {
    stage: 'transcript_applied' as const,
    uid: TEST_UID,
    docKey: DOC_KEY,
    artifactKind: 'corrected_transcript' as const,
    sourceText: '内容',
    confirmed: true,
    at: new Date().toISOString(),
    ...over,
  };
}

describe('startMeetingTerminalSweep（失败项在终态重试）', () => {
  it('retries a previously failed artifact when the task reaches a terminal state', async () => {
    const mod = await loadMod();
    const event = {
      stage: 'transcript_applied' as const,
      uid: TEST_UID,
      docKey: DOC_KEY,
      artifactKind: 'corrected_transcript' as const,
      sourceText: '第一次失败、终态补上',
      confirmed: true,
      version: 'run_terminal_1',
      at: 'T-terminal',
    };

    let fireTerminal: ((e: { user_id: string; conversation_id: string; status: string }) => void) | null = null;
    // 不覆盖 precipitate —— 让终态兜底**真的**跑一遍沉淀，走真实落盘与幂等判定。
    const stop = mod.startMeetingTerminalSweep({
      subscribeTerminals: (listener) => { fireTerminal = listener; return () => {}; },
    });

    try {
      // 模拟实时路径彻底失败 → 登记（这一步在真实链路里由 orchestrator 的 onFailure 完成）
      mod.rememberPrecipitationFailure(TEST_UID, event);
      expect(mod.pendingPrecipitationFailures()).toBe(1);

      const rel = `meetings/${DOC_KEY}/转写-纠错_run_terminal_1.md`;
      expect(fs.existsSync(path.join(contextsRoot(), rel))).toBe(false); // 兜底前还没落盘

      fireTerminal!({ user_id: TEST_UID, conversation_id: 'c1', status: 'completed' });
      await new Promise((r) => setTimeout(r, 80));

      // 兜底重试成功 → 真的落盘，且登记表被清空
      expect(fs.existsSync(path.join(contextsRoot(), rel))).toBe(true);
      expect(mod.pendingPrecipitationFailures()).toBe(0);
    } finally {
      stop();
      mod.clearPrecipitationFailures();
    }
  });

  it('also fires on cancelled — cancellation does not drop produced artifacts (FR-033)', async () => {
    const mod = await loadMod();
    let fireTerminal: ((e: { user_id: string; conversation_id: string; status: string }) => void) | null = null;
    const stop = mod.startMeetingTerminalSweep({
      subscribeTerminals: (listener) => { fireTerminal = listener; return () => {}; },
    });
    try {
      mod.rememberPrecipitationFailure(TEST_UID, {
        stage: 'conclusion_confirmed', uid: TEST_UID, docKey: DOC_KEY,
        artifactKind: 'minutes', sourceText: '取消前产出的纪要', confirmed: true,
        version: 'mc_cancel_terminal', at: 'T-cancel',
      });
      fireTerminal!({ user_id: TEST_UID, conversation_id: 'c1', status: 'cancelled' });
      await new Promise((r) => setTimeout(r, 60));
      const rel = `meetings/${DOC_KEY}/会议纪要_mc_cancel_terminal.md`;
      expect(fs.existsSync(path.join(contextsRoot(), rel))).toBe(true);
    } finally {
      stop();
      mod.clearPrecipitationFailures();
    }
  });

  it('ignores non-terminal statuses', async () => {
    const mod = await loadMod();
    let fireTerminal: ((e: { user_id: string; conversation_id: string; status: string }) => void) | null = null;
    const stop = mod.startMeetingTerminalSweep({
      subscribeTerminals: (listener) => { fireTerminal = listener; return () => {}; },
    });
    try {
      mod.rememberPrecipitationFailure(TEST_UID, {
        stage: 'transcript_applied', uid: TEST_UID, docKey: DOC_KEY,
        artifactKind: 'corrected_transcript', sourceText: 'x', confirmed: true, version: 'run_ns', at: 'T-ns',
      });
      fireTerminal!({ user_id: TEST_UID, conversation_id: 'c1', status: 'waiting_input' });
      await new Promise((r) => setTimeout(r, 40));
      // 非终态不消费登记表
      expect(mod.pendingPrecipitationFailures()).toBe(1);
    } finally {
      stop();
      mod.clearPrecipitationFailures();
    }
  });

  it('keeps a still-failing item registered for the next terminal', async () => {
    const mod = await loadMod();
    let fireTerminal: ((e: { user_id: string; conversation_id: string; status: string }) => void) | null = null;
    const stop = mod.startMeetingTerminalSweep({
      subscribeTerminals: (listener) => { fireTerminal = listener; return () => {}; },
      precipitate: async () => { throw new Error('still broken'); },
    });
    try {
      mod.rememberPrecipitationFailure(TEST_UID, {
        stage: 'transcript_applied', uid: TEST_UID, docKey: DOC_KEY,
        artifactKind: 'corrected_transcript', sourceText: 'x', confirmed: true, version: 'run_still', at: 'T-still',
      });
      fireTerminal!({ user_id: TEST_UID, conversation_id: 'c1', status: 'completed' });
      await new Promise((r) => setTimeout(r, 60));
      expect(mod.pendingPrecipitationFailures()).toBe(1); // 放回，等下次终态
    } finally {
      stop();
      mod.clearPrecipitationFailures();
    }
  });

  it('the failure registry is bounded (does not grow without limit)', async () => {
    const mod = await loadMod();
    mod.clearPrecipitationFailures();
    for (let i = 0; i < 520; i++) {
      mod.rememberPrecipitationFailure(TEST_UID, {
        stage: 'transcript_applied', uid: TEST_UID, docKey: DOC_KEY,
        artifactKind: 'corrected_transcript', sourceText: 'x', confirmed: true, version: `run_${i}`, at: `T${i}`,
      });
    }
    expect(mod.pendingPrecipitationFailures()).toBeLessThanOrEqual(500);
    mod.clearPrecipitationFailures();
  });
});

describe('sweepConversationMeetingArtifacts', () => {
  it('fills in the missed artifacts and reports added/skipped/failed counts', async () => {
    const mod = await loadMod();
    const report = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', [
      ev({ artifactKind: 'corrected_transcript', sourceText: '纠错后的转写', version: 'run_1' }),
      ev({ stage: 'conclusion_confirmed', artifactKind: 'minutes', sourceText: '一条纪要', version: 'mc_1' }),
    ]);

    expect(report.considered).toBe(2);
    expect(report.added.length).toBe(2);
    expect(report.failed.length).toBe(0);

    // 两份都真的落进同一会议目录（SC-005：不分裂）
    for (const rel of report.added) {
      expect(rel.startsWith(`meetings/${DOC_KEY}/`)).toBe(true);
      expect(fs.existsSync(path.join(contextsRoot(), rel))).toBe(true);
    }
  });

  it('is idempotent: a second sweep adds nothing and reports no duplicates', async () => {
    const mod = await loadMod();
    const candidates = [
      ev({ artifactKind: 'corrected_transcript', sourceText: '转写一', version: 'run_1' }),
      ev({ stage: 'conclusion_confirmed', artifactKind: 'minutes', sourceText: '纪要一', version: 'mc_1' }),
    ];

    const first = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', candidates);
    expect(first.added.length).toBe(2);

    const second = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', candidates);
    // 幂等：不新增；且因账本显示已齐备，走快速路径整段跳过（sweep 的语义优化）
    expect(second.added.length).toBe(0);
    expect(second.skippedAlreadyComplete).toBe(2);

    // 目录里确实只有那两个文件，没有副本
    const dir = path.join(contextsRoot(), 'meetings', DOC_KEY);
    const files = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
    expect(files.length).toBe(2);
  });

  it('keeps a meeting split across several runs in ONE directory (no split)', async () => {
    const mod = await loadMod();
    // 三次处理：转写 → 纠错 → 纪要，docKey 相同
    await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', [
      ev({ artifactKind: 'transcript', sourceText: '原始转写', version: 'run_a' }),
    ]);
    await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', [
      ev({ artifactKind: 'corrected_transcript', sourceText: '纠错转写', version: 'run_b' }),
    ]);
    const third = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', [
      ev({ stage: 'conclusion_confirmed', artifactKind: 'minutes', sourceText: '纪要', version: 'mc_c' }),
    ]);

    // 三次处理的产物必须在同一目录下
    expect(third.added.length).toBe(1);
    expect(third.added[0].startsWith(`meetings/${DOC_KEY}/`)).toBe(true);
    const dir = path.join(contextsRoot(), 'meetings', DOC_KEY);
    const files = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
    expect(files.length).toBe(3);
    // 顶层只有这一个归集目录 —— 没有因分次处理而分裂
    const roots = fs.readdirSync(path.join(contextsRoot(), 'meetings'));
    expect(roots).toEqual([DOC_KEY]);
  });

  it('does not write placeholders for artifacts the meeting never produced (FR-016)', async () => {
    const mod = await loadMod();
    const report = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', [
      ev({ artifactKind: 'minutes', sourceText: '   ', version: 'mc_empty' }),
    ]);
    expect(report.added.length).toBe(0);
    expect(report.skipped.some((s) => s.reason === 'empty')).toBe(true);
    // 目录不应被建出占位文件
    const dir = path.join(contextsRoot(), 'meetings', DOC_KEY);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.')) : [];
    expect(files.length).toBe(0);
  });

  it('de-duplicates identical candidates within one sweep', async () => {
    const mod = await loadMod();
    const same = ev({ artifactKind: 'transcript', sourceText: '同一份', version: 'run_x' });
    const report = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', [same, { ...same }, { ...same }]);
    expect(report.considered).toBe(1);
    expect(report.added.length).toBe(1);
  });

  it('a discarded action draft is counted as skipped, never added (FR-029)', async () => {
    const mod = await loadMod();
    const report = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', [
      ev({ stage: 'action_discarded', artifactKind: 'actions', sourceText: '被丢弃的待办', confirmed: false, version: 'ma_1' }),
    ]);
    expect(report.added.length).toBe(0);
    expect(report.skipped.some((s) => s.reason === 'discarded')).toBe(true);
  });

  it('one bad candidate does not stop the others', async () => {
    const mod = await loadMod();
    const report = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', [
      ev({ artifactKind: 'transcript', sourceText: '好的第一份', version: 'run_ok' }),
      // 源文件不存在 + 无内容 → 会被计为 no_source/source_missing，但不得中断
      ev({ artifactKind: 'corrected_transcript', sourceAbsPath: path.join(tmpDir, 'nope.txt'), version: 'run_missing' }),
      ev({ stage: 'conclusion_confirmed', artifactKind: 'minutes', sourceText: '好的第三份', version: 'mc_ok' }),
    ]);
    expect(report.considered).toBe(3);
    expect(report.added.length).toBe(2);
    expect(report.skipped.length).toBe(1);
  });

  it('ignores malformed candidates instead of throwing', async () => {
    const mod = await loadMod();
    const report = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', [
      null as never,
      { stage: 'transcript_applied' } as never, // 缺 docKey
      ev({ artifactKind: 'transcript', sourceText: '唯一有效的一份', version: 'run_only' }),
    ]);
    expect(report.considered).toBe(1);
    expect(report.added.length).toBe(1);
  });

  it('sweeps regardless of run status — a cancelled conversation keeps its artifacts (FR-033)', async () => {
    const mod = await loadMod();
    // 兜底**刻意不看 run 状态**：规格 FR-033 要覆盖非正常结束，取消不等于放弃已产出的成果。
    // 这不是"我们忘了过滤"，而是有意的语义 —— 与现有任务归档"非 completed 直接返回空"相反。
    const report = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c-cancelled', [
      ev({ artifactKind: 'transcript', sourceText: '取消前已经产出的转写', version: 'run_cancel_1' }),
      ev({ stage: 'conclusion_confirmed', artifactKind: 'minutes', sourceText: '取消前已经出的纪要', version: 'mc_cancel_1' }),
    ]);
    expect(report.added.length).toBe(2);
    for (const rel of report.added) {
      expect(fs.existsSync(path.join(contextsRoot(), rel))).toBe(true);
    }
  });

  it('handles an empty candidate list without side effects', async () => {
    const mod = await loadMod();
    const report = await mod.sweepConversationMeetingArtifacts(TEST_UID, 'c1', []);
    expect(report.considered).toBe(0);
    expect(report.added.length).toBe(0);
    expect(report.failed.length).toBe(0);
    expect(fs.existsSync(path.join(contextsRoot(), 'meetings'))).toBe(false);
  });
});
