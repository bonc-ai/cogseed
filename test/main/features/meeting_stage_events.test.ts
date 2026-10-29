/**
 * 会议环节完成事件的契约测试（对应 contracts/README.md A1 与 specs FR-004）。
 *
 * 必测点：
 *   - 事件冻结不可变（监听者改不动）；
 *   - 单个监听者抛错**不影响**其他监听者，也**不影响**调用方；
 *   - 无监听者时不抛错；
 *   - `emitMeetingStage` 不是 async（同步派发，不等待沉淀）；
 *   - 退订幂等。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type Events = typeof import('../../../src/main/features/meeting_stage_events');

async function loadMod(): Promise<Events> {
  return import('../../../src/main/features/meeting_stage_events');
}

function makeEvent(over: Partial<import('../../../src/main/features/meeting_stage_events').MeetingStageEvent> = {}) {
  return {
    stage: 'transcript_applied' as const,
    uid: 'evt-u1',
    docKey: 'doc-abc-0123456789',
    artifactKind: 'corrected_transcript' as const,
    sourceText: 'hello',
    confirmed: true,
    at: new Date().toISOString(),
    ...over,
  };
}

describe('meeting_stage_events', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('delivers a frozen event that listeners cannot mutate', async () => {
    const mod = await loadMod();
    let seen: unknown = null;
    const unsub = mod.subscribeMeetingStages((ev) => { seen = ev; });
    try {
      mod.emitMeetingStage(makeEvent());
      expect(seen).not.toBeNull();
      expect(Object.isFrozen(seen)).toBe(true);
      // 严格模式下写入冻结对象会抛；宽松模式下静默失败。两种都要求值不变。
      try { (seen as Record<string, unknown>).stage = 'tampered'; } catch { /* expected */ }
      expect((seen as { stage: string }).stage).toBe('transcript_applied');
    } finally {
      unsub();
    }
  });

  it('isolates a throwing listener: others still run and the caller does not see the error', async () => {
    const mod = await loadMod();
    const after = vi.fn();
    const unsubBad = mod.subscribeMeetingStages(() => { throw new Error('boom from listener'); });
    const unsubGood = mod.subscribeMeetingStages(after);
    try {
      // 关键断言：不抛 —— 沉淀失败绝不能让会议环节失败（FR-004）。
      expect(() => mod.emitMeetingStage(makeEvent())).not.toThrow();
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      unsubBad();
      unsubGood();
    }
  });

  it('does not throw when there are no listeners', async () => {
    const mod = await loadMod();
    expect(() => mod.emitMeetingStage(makeEvent())).not.toThrow();
  });

  it('emits synchronously (not async) so callers never await precipitation', async () => {
    const mod = await loadMod();
    const seen: string[] = [];
    const unsub = mod.subscribeMeetingStages(() => { seen.push('called'); });
    try {
      const ret = mod.emitMeetingStage(makeEvent());
      // 同步派发：函数返回时监听者已经跑完，且返回值不是 Promise。
      expect(ret).toBeUndefined();
      expect(seen).toEqual(['called']);
    } finally {
      unsub();
    }
  });

  it('unsubscribe is idempotent and stops delivery', async () => {
    const mod = await loadMod();
    const spy = vi.fn();
    const unsub = mod.subscribeMeetingStages(spy);
    unsub();
    unsub(); // 重复退订不得抛
    mod.emitMeetingStage(makeEvent());
    expect(spy).not.toHaveBeenCalled();
    expect(mod.meetingStageListenerCount()).toBe(0);
  });

  it('keeps listener count consistent across subscribe/unsubscribe', async () => {
    const mod = await loadMod();
    const before = mod.meetingStageListenerCount();
    const a = mod.subscribeMeetingStages(() => {});
    const b = mod.subscribeMeetingStages(() => {});
    expect(mod.meetingStageListenerCount()).toBe(before + 2);
    a();
    b();
    expect(mod.meetingStageListenerCount()).toBe(before);
  });
});
