import { describe, it, expect } from 'vitest';

import {
  agentHealthFromTasks,
  nonTerminalStatuses,
} from '../../../src/main/features/dashboard_health';
import type { CogSeedTaskRecord } from '../../../src/main/features/cogseed_backend/types';

// 健康规则（设计第 2.3 节）——规则透明可解释，不做玄学评分：
//   样本 < 5            → observing（「观察中」，不参与评判，防新 agent 一次失败被误杀）
//   连续失败 ≥ 3         → alert
//   近 10 次成功率 < 50%  → alert
//   其余                → healthy
// 数据源是任务流水（CogSeedTaskRecord 的终态），不引入第二套存储。

let seq = 0;
function task(over: Partial<CogSeedTaskRecord> = {}): CogSeedTaskRecord {
  seq += 1;
  // 递增时间戳（ISO，与 CogSeedTaskRecord 一致）：后造的任务更「新」，健康规则按新→旧读
  const at = new Date(1756000000000 + seq * 1000).toISOString();
  return {
    taskId: `t${seq}`,
    userId: 'u1',
    status: 'completed',
    createdAt: at,
    updatedAt: at,
    ...over,
  } as CogSeedTaskRecord;
}

describe('agent health rules', () => {
  it('treats non-terminal statuses as running', () => {
    expect(nonTerminalStatuses.has('running')).toBe(true);
    expect(nonTerminalStatuses.has('waiting_user')).toBe(true);
    expect(nonTerminalStatuses.has('queued')).toBe(true);
    expect(nonTerminalStatuses.has('completed')).toBe(false);
    expect(nonTerminalStatuses.has('failed')).toBe(false);
    expect(nonTerminalStatuses.has('cancelled')).toBe(false);
  });

  it('marks agents with fewer than 5 samples as observing', () => {
    const tasks = [
      task({ agentId: 'a1', status: 'failed' }),
      task({ agentId: 'a1', status: 'failed' }),
    ];
    const [health] = agentHealthFromTasks(tasks);
    expect(health.state).toBe('observing');
  });

  it('alerts on 3+ consecutive failures', () => {
    const tasks = Array.from({ length: 8 }, (_, i) =>
      task({ agentId: 'a1', status: i < 5 ? 'completed' : 'failed' }));
    const [health] = agentHealthFromTasks(tasks);
    expect(health.state).toBe('alert');
    expect(health.consecutiveFailures).toBe(3);
  });

  it('alerts when the recent-10 success rate drops below 50%', () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ agentId: 'a1', status: i < 4 ? 'completed' : 'failed' }));
    const [health] = agentHealthFromTasks(tasks);
    expect(health.state).toBe('alert');
    expect(health.recent10SuccessRate).toBeCloseTo(0.4, 4);
  });

  it('reports healthy for a normal agent with full context on its last failure', () => {
    const tasks = [
      ...Array.from({ length: 9 }, () => task({ agentId: 'a1', status: 'completed' })),
      task({ agentId: 'a1', status: 'failed', conversationId: 'c9', errorCode: 'provider_timeout' }),
    ];
    const [health] = agentHealthFromTasks(tasks);
    expect(health.state).toBe('healthy');
    expect(health.lastFailure).toMatchObject({ conversationId: 'c9', errorCode: 'provider_timeout' });
  });

  it('groups per agent and orders alert-first for the sidebar/roster consumers', () => {
    const tasks = [
      ...Array.from({ length: 6 }, () => task({ agentId: 'good', status: 'completed' })),
      ...Array.from({ length: 6 }, (_, i) => task({ agentId: 'bad', status: i < 2 ? 'completed' : 'failed' })),
    ];
    const health = agentHealthFromTasks(tasks);
    expect(health.map((h) => h.agentId)).toEqual(['bad', 'good']);
    expect(health[0].state).toBe('alert');
    expect(health[1].state).toBe('healthy');
  });

  it('returns an empty list (not fake zeros) when there are no tasks', () => {
    expect(agentHealthFromTasks([])).toEqual([]);
  });
});
