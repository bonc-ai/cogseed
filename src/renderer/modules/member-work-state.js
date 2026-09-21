// 成员工作状态词表（设计 §5.1 / PRD FR-018）。
//
// 纯函数：把既有事件与快照映射成七态，供"等待/执行中/等待前序/等待用户/等待审批/
// 完成/失败/停止"的展示与最终交付核对使用。不新增持久状态，源数据全部来自已有事件：
//   state_changed.active_turns / agent_run_result / wake_request / aborted / plan 快照。

(function initMemberWorkState(root) {
  'use strict';

  const STATES = [
    'waiting',            // 已派发，尚未开始
    'running',            // 执行中
    'waiting_dependency', // 等待前序
    'waiting_user',       // 等待用户回复
    'waiting_approval',   // 等待审批（Wake Gate / 协作 gate）
    'done',
    'failed',
    'stopped',
  ];

  /** 等待中的状态不允许被误标完成（FR-018 的最后一条）。 */
  const TERMINAL = new Set(['done', 'failed', 'stopped']);

  function isTerminal(state) {
    return TERMINAL.has(state);
  }

  /**
   * @param {object} input
   * @param {string[]} input.members            本 run 的成员/派发对象
   * @param {object}   [input.byAgent]          agent_id → { dispatched?, started?, terminal?, reason? }
   * @param {string[]} [input.activeTurns]      正在执行的 actor id
   * @param {object}   [input.gates]            agent_id → 'pending' | 'approved' | 'rejected'
   * @param {string[]} [input.wakeRequests]     待审批的 actor id
   * @param {string[]} [input.blockedByDependency] 依赖未满足的 actor id
   * @param {string[]} [input.waitingUser]     等待用户输入的 actor id
   * @param {string[]} [input.stopped]         被停止/移除的 actor id
   * @returns {Array<{agent_id: string, state: string, reason?: string}>}
   */
  function deriveMemberWorkState(input) {
    const members = Array.isArray(input && input.members) ? input.members : [];
    const byAgent = (input && input.byAgent) || {};
    const activeTurns = new Set((input && input.activeTurns) || []);
    const gates = (input && input.gates) || {};
    const wakeRequests = new Set((input && input.wakeRequests) || []);
    const blockedByDependency = new Set((input && input.blockedByDependency) || []);
    const waitingUser = new Set((input && input.waitingUser) || []);
    const stopped = new Set((input && input.stopped) || []);

    return members.map((agentId) => {
      const entry = byAgent[agentId] || {};
      const terminal = entry.terminal && TERMINAL.has(entry.terminal) ? entry.terminal : '';
      // 终态优先：完成/失败/停止一旦成立，不再被"进行中"覆盖。
      if (entry.terminal === 'removed' || stopped.has(agentId)) {
        return { agent_id: agentId, state: 'stopped', ...(entry.reason ? { reason: entry.reason } : {}) };
      }
      if (terminal === 'failed') {
        return { agent_id: agentId, state: 'failed', ...(entry.reason ? { reason: entry.reason } : {}) };
      }
      if (terminal === 'done') return { agent_id: agentId, state: 'done' };
      if (terminal === 'stopped') {
        return { agent_id: agentId, state: 'stopped', ...(entry.reason ? { reason: entry.reason } : {}) };
      }
      // 审批在前：被拒绝的成员停在等待审批，不会被算成"没贡献"之外的其它状态。
      if (gates[agentId] === 'pending' || wakeRequests.has(agentId)) {
        return { agent_id: agentId, state: 'waiting_approval' };
      }
      if (blockedByDependency.has(agentId)) return { agent_id: agentId, state: 'waiting_dependency' };
      if (waitingUser.has(agentId)) return { agent_id: agentId, state: 'waiting_user' };
      if (activeTurns.has(agentId) || entry.started) return { agent_id: agentId, state: 'running' };
      return { agent_id: agentId, state: 'waiting' };
    });
  }

  /**
   * 最终交付核对（FR-018）：只有每个被点名成员都有贡献或明确原因时才允许完成。
   * `done` 才算贡献；`failed/stopped/waiting_*` 一律进 missing 并附原因。
   */
  function summarizeRun(members, states) {
    const list = Array.isArray(states) ? states : [];
    const contributed = [];
    const missing = [];
    for (const entry of list) {
      if (entry.state === 'done') {
        contributed.push({ agent_id: entry.agent_id, state: entry.state });
        continue;
      }
      missing.push({
        agent_id: entry.agent_id,
        state: entry.state,
        reason: entry.reason || entry.state,
      });
    }
    return {
      contributed,
      missing,
      // 有未完成成员时不允许宣告完成（调用成功 ≠ 任务完成）。
      complete: missing.length === 0 && members > 0,
    };
  }

  /**
   * 从耐久化 run summary 中取出可重跑成员。pending/no_terminal 可能仍有
   * 迟到执行，不在 UI 里盲目重发；已贡献成员永不进入结果。
   */
  function retryableAgentIds(summary) {
    const retryable = new Set(['failed', 'blocked', 'stopped', 'removed']);
    const contributed = new Set(
      (summary && Array.isArray(summary.contributed) ? summary.contributed : [])
        .map((entry) => entry && entry.agent_id)
        .filter(Boolean),
    );
    const out = [];
    for (const entry of summary && Array.isArray(summary.missing) ? summary.missing : []) {
      const id = entry && typeof entry.agent_id === 'string' ? entry.agent_id : '';
      if (!id || contributed.has(id) || !retryable.has(String(entry.terminal || '')) || out.includes(id)) continue;
      out.push(id);
    }
    return out;
  }

  const api = { STATES, isTerminal, deriveMemberWorkState, summarizeRun, retryableAgentIds };
  root.memberWorkState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
