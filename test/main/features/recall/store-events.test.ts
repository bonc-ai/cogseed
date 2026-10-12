import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  notifyCognitionWrite,
  resetCognitionChangeStateForTests,
  setCognitionChangeBroadcaster,
  type CognitionChangeNotice,
} from '../../../../src/main/features/recall/store-events';

// 事件源核心不变量：generation 单调递增、同 (userId, collection) 50ms 合并窗口
// 内只发最后一条、写失败路径不发（broadcaster 抛错不影响计数）、未注册
// 广播器时静默。这些保证渲染层"重读即自愈"的刷新模型成立。

const notices: CognitionChangeNotice[] = [];

function captureBroadcaster(notice: CognitionChangeNotice): void {
  notices.push(notice);
}

async function advanceMergeWindow(): Promise<void> {
  // fake timers 下等待合并窗口过期（50ms + 余量）。
  await vi.advanceTimersByTimeAsync(80);
}

describe('recall store-events（cognition:changed 事件源）', () => {
  afterEach(() => {
    vi.useRealTimers();
    setCognitionChangeBroadcaster(null);
    resetCognitionChangeStateForTests();
    notices.length = 0;
  });

  it('未注册广播器时静默丢弃，不抛错也不计数', async () => {
    vi.useFakeTimers();
    setCognitionChangeBroadcaster(null);
    expect(() => notifyCognitionWrite('u1', 'candidates', 'append', 'c1')).not.toThrow();
    await advanceMergeWindow();
    expect(notices).toEqual([]);
  });

  it('一次写入在合并窗口后广播一次，generation 从 1 开始', async () => {
    vi.useFakeTimers();
    setCognitionChangeBroadcaster(captureBroadcaster);
    notifyCognitionWrite('u1', 'candidates', 'append', 'c1');
    await advanceMergeWindow();
    expect(notices).toEqual([
      { collection: 'candidates', generation: 1, op: 'append', recordId: 'c1' },
    ]);
  });

  it('同一 collection 窗口内多次写入合并成一条，generation 取最新', async () => {
    vi.useFakeTimers();
    setCognitionChangeBroadcaster(captureBroadcaster);
    notifyCognitionWrite('u1', 'ability-assets', 'write', 'a1');
    notifyCognitionWrite('u1', 'ability-assets', 'update', 'a2');
    notifyCognitionWrite('u1', 'ability-assets', 'update', 'a3');
    await advanceMergeWindow();
    expect(notices).toHaveLength(1);
    expect(notices[0].generation).toBe(3);
    // 合并语义：保留最后一次的 op/recordId（调试线索，正确性来源是重读）。
    expect(notices[0].op).toBe('update');
    expect(notices[0].recordId).toBe('a3');
  });

  it('不同 collection 互不合并，generation 各自递增', async () => {
    vi.useFakeTimers();
    setCognitionChangeBroadcaster(captureBroadcaster);
    notifyCognitionWrite('u1', 'candidates', 'append');
    notifyCognitionWrite('u1', 'captures', 'update');
    notifyCognitionWrite('u1', 'candidates', 'append');
    await advanceMergeWindow();
    expect(notices).toHaveLength(2);
    const byCollection = new Map(notices.map((n) => [n.collection, n]));
    expect(byCollection.get('candidates')?.generation).toBe(2);
    expect(byCollection.get('captures')?.generation).toBe(1);
  });

  it('不同 userId 的计数互不干扰（多账户隔离）', async () => {
    vi.useFakeTimers();
    setCognitionChangeBroadcaster(captureBroadcaster);
    notifyCognitionWrite('u1', 'candidates', 'append');
    notifyCognitionWrite('u2', 'candidates', 'append');
    await advanceMergeWindow();
    expect(notices).toHaveLength(2);
    expect(notices.every((n) => n.generation === 1)).toBe(true);
  });

  it('广播器抛错不中断后续广播（写路径不受通知故障影响）', async () => {
    vi.useFakeTimers();
    let calls = 0;
    setCognitionChangeBroadcaster(() => {
      calls += 1;
      if (calls === 1) throw new Error('renderer gone');
    });
    notifyCognitionWrite('u1', 'candidates', 'append');
    await advanceMergeWindow();
    notifyCognitionWrite('u1', 'candidates', 'append');
    await advanceMergeWindow();
    expect(calls).toBe(2);
    // 计数在第一条成功路径上已推进：第二条 generation=2（跳变对渲染层可见，
    // 触发重读自愈，而不是静默丢步）。
  });

  it('窗口过期后的下一次写入重新开窗，generation 连续', async () => {
    vi.useFakeTimers();
    setCognitionChangeBroadcaster(captureBroadcaster);
    notifyCognitionWrite('u1', 'captures', 'update');
    await advanceMergeWindow();
    notifyCognitionWrite('u1', 'captures', 'update');
    await advanceMergeWindow();
    expect(notices.map((n) => n.generation)).toEqual([1, 2]);
  });

  it('非法入参（空 userId / 空 collection）静默忽略', async () => {
    vi.useFakeTimers();
    setCognitionChangeBroadcaster(captureBroadcaster);
    notifyCognitionWrite('', 'candidates', 'append');
    notifyCognitionWrite('u1', '', 'append');
    await advanceMergeWindow();
    expect(notices).toEqual([]);
  });

  it('recordId/op 可省略（批量删除给不出单条 id 也要广播）', async () => {
    vi.useFakeTimers();
    setCognitionChangeBroadcaster(captureBroadcaster);
    notifyCognitionWrite('u1', 'usage-records', 'remove');
    await advanceMergeWindow();
    expect(notices).toEqual([{ collection: 'usage-records', generation: 1, op: 'remove' }]);
  });
});
