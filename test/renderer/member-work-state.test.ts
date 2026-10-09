// 成员工作状态词表与交付核对（设计 §5.1/§5.2、PRD FR-018）。
//
// 用例覆盖状态优先级（终态 > 审批 > 依赖 > 用户 > 执行中 > 等待）与"未完成不允许
// 宣告完成"的交付口径——这是 PRD 里最容易做错的一条（调用成功 ≠ 任务完成）。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const modulePath = resolve(__dirname, '../../src/renderer/modules/member-work-state.js');
const source = readFileSync(modulePath, 'utf8');

let api: any;

beforeEach(() => {
  const sandbox: Record<string, any> = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'member-work-state.js' });
  api = sandbox.window.memberWorkState;
});

const derive = (input: any) => api.deriveMemberWorkState(input);
const stateOf = (rows: any[], id: string) => rows.find((r) => r.agent_id === id)?.state;

describe('成员工作状态词表（FR-018）', () => {
  it('已派发未开始＝等待；有在途回合＝执行中', () => {
    const rows = derive({ members: ['a', 'b'], byAgent: { a: { dispatched: ['t1'] } }, activeTurns: ['b'] });
    expect(stateOf(rows, 'a')).toBe('waiting');
    expect(stateOf(rows, 'b')).toBe('running');
  });

  it('依赖未满足＝等待前序，优先于执行中', () => {
    const rows = derive({
      members: ['a'],
      byAgent: { a: { started: true } },
      activeTurns: ['a'],
      blockedByDependency: ['a'],
    });
    expect(stateOf(rows, 'a')).toBe('waiting_dependency');
  });

  it('待审批（Wake Gate / 协作 gate）＝等待审批', () => {
    expect(stateOf(derive({ members: ['a'], gates: { a: 'pending' } }), 'a')).toBe('waiting_approval');
    expect(stateOf(derive({ members: ['a'], wakeRequests: ['a'] }), 'a')).toBe('waiting_approval');
  });

  it('等待用户输入＝等待用户', () => {
    expect(stateOf(derive({ members: ['a'], waitingUser: ['a'] }), 'a')).toBe('waiting_user');
  });

  it('终态优先：完成/失败/停止不被"进行中"或"待审批"覆盖', () => {
    const rows = derive({
      members: ['a', 'b', 'c'],
      byAgent: { a: { terminal: 'done' }, b: { terminal: 'failed', reason: 'runtime' }, c: {} },
      activeTurns: ['a', 'b'],
      gates: { a: 'pending' },
      stopped: ['c'],
    });
    expect(stateOf(rows, 'a')).toBe('done');
    expect(stateOf(rows, 'b')).toBe('failed');
    expect(stateOf(rows, 'c')).toBe('stopped');
  });

  it('运行中被移除的成员＝停止（原因保留）', () => {
    const rows = derive({ members: ['a'], byAgent: { a: { terminal: 'removed', reason: 'member_removed' } } });
    expect(rows[0]).toMatchObject({ state: 'stopped', reason: 'member_removed' });
  });
});

describe('最终交付核对（FR-018：调用成功 ≠ 任务完成）', () => {
  it('有未完成成员时不允许 complete', () => {
    const states = derive({
      members: ['a', 'b'],
      byAgent: { a: { terminal: 'done' }, b: { terminal: 'failed', reason: 'runtime' } },
    });
    const summary = api.summarizeRun(2, states);
    expect(summary.contributed.map((c: any) => c.agent_id)).toEqual(['a']);
    expect(summary.missing).toEqual([{ agent_id: 'b', state: 'failed', reason: 'runtime' }]);
    expect(summary.complete).toBe(false);
  });

  it('等待类状态同样计入未完成（不能当成功）', () => {
    const states = derive({
      members: ['a', 'b'],
      byAgent: { a: { terminal: 'done' } },
      blockedByDependency: ['b'],
    });
    const summary = api.summarizeRun(2, states);
    expect(summary.complete).toBe(false);
    expect(summary.missing[0]).toMatchObject({ agent_id: 'b', reason: 'waiting_dependency' });
  });

  it('全员完成才 complete；空名单不算完成', () => {
    const states = derive({ members: ['a'], byAgent: { a: { terminal: 'done' } } });
    expect(api.summarizeRun(1, states).complete).toBe(true);
    expect(api.summarizeRun(0, []).complete).toBe(false);
  });
});

describe('状态集合约定', () => {
  it('七态齐备且终态判定一致', () => {
    expect(api.STATES).toEqual([
      'waiting', 'running', 'waiting_dependency', 'waiting_user',
      'waiting_approval', 'done', 'failed', 'stopped',
    ]);
    expect(api.isTerminal('done')).toBe(true);
    expect(api.isTerminal('failed')).toBe(true);
    expect(api.isTerminal('stopped')).toBe(true);
    expect(api.isTerminal('waiting_approval')).toBe(false);
    expect(api.isTerminal('running')).toBe(false);
  });

  it('重跑范围只包含 failed / blocked / stopped / removed，绝不重跑 done', () => {
    expect(api.retryableAgentIds({
      missing: [
        { agent_id: 'a', terminal: 'failed' },
        { agent_id: 'b', terminal: 'blocked' },
        { agent_id: 'c', terminal: 'stopped' },
        { agent_id: 'd', terminal: 'removed' },
        { agent_id: 'e', terminal: 'pending' },
      ],
      contributed: [{ agent_id: 'done-agent' }],
    })).toEqual(['a', 'b', 'c', 'd']);
    expect(api.retryableAgentIds({ missing: [], contributed: [{ agent_id: 'a' }] })).toEqual([]);
  });
});
