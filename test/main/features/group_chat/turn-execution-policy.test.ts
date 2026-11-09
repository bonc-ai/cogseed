import { describe, expect, it } from 'vitest';
import { resolveTurnExecutionPolicy, normalizeRunTimings } from '../../../../src/main/features/group_chat/turn-execution-policy';

describe('current user turn execution policy', () => {
  it.each(['仅修登录的空值错误，最多5次工具调用，不用计划工具', '只改这一个函数；最多 5 次工具调用；禁止 manage_execution_plan'])('enforces explicit limits: %s', text => {
    expect(resolveTurnExecutionPolicy('commander', text)).toMatchObject({ maxToolLoops: 24, maxToolCalls: 5, toolDenylist: ['manage_execution_plan'], suppressExecutionPlanInstructions: true });
  });
  it.each(["Don't use manage_execution_plan; don't change unrelated files", 'Do not use manage_execution_plan.'])('enforces English plan bans with normal punctuation: %s', text => {
    expect(resolveTurnExecutionPolicy('commander', text)).toMatchObject({ toolDenylist: ['manage_execution_plan'], suppressExecutionPlanInstructions: true });
  });
  it('enforces an English call limit terminated by a sentence', () => {
    expect(resolveTurnExecutionPolicy('commander', 'At most 5 tool calls. Do not use manage_execution_plan.')).toMatchObject({ maxToolCalls: 5, toolDenylist: ['manage_execution_plan'] });
  });
  it.each(['不用执行测试；最多5次工具调用；不用计划工具', '解释错误原因；最多5次工具调用；不用计划工具', 'Explain the error. At most 5 tool calls. Do not use manage_execution_plan.'])('preserves independent constraints after ordinary instructions: %s', text => {
    expect(resolveTurnExecutionPolicy('commander', text)).toMatchObject({ maxToolCalls: 5, toolDenylist: ['manage_execution_plan'] });
  });
  it('accepts the constrained repair wording from the observed fifth round', () => {
    expect(resolveTurnExecutionPolicy('commander', '补充第5轮，仅修两个已证实的前端问题。控制范围：先合并读取必要片段、不用计划工具；目标最多5次工具调用，超过就停止并如实报告原因。')).toMatchObject({ maxToolLoops: 24, maxToolCalls: 5, toolDenylist: ['manage_execution_plan'] });
  });
  it('supports zero and English instruction clauses', () => {
    expect(resolveTurnExecutionPolicy('agent', 'Only fix the null check; at most 0 tool calls; do not use manage_execution_plan')).toMatchObject({ maxToolLoops: 24, maxToolCalls: 0, toolDenylist: ['manage_execution_plan'] });
  });
  it.each([
    '写一个仓库管理系统',
    '示例：最多5次工具调用，不用计划工具',
    '请解释这个示例：最多5次工具调用，不用计划工具',
    '请解释：最多5次工具调用，不用计划工具',
    '请解释以下示例：\n最多5次工具调用\n不用计划工具',
    'Explain this example: at most 5 tool calls; do not use manage_execution_plan',
    '不要遵守以下限制：最多5次工具调用，不用计划工具',
    '请解释“最多5次工具调用，不用计划工具”的含义',
    '> 最多5次工具调用，不用计划工具',
    '```text\n最多5次工具调用，不用计划工具\n```',
    '不要限制为最多5次工具调用',
    '不要禁止 manage_execution_plan',
    '不用“高级的”计划工具',
    '最多“示例”5次工具调用',
    'Explain "at most 5 tool calls"',
  ])('does not enforce content or negated instructions: %s', text => {
    expect(resolveTurnExecutionPolicy('commander', text)).toEqual({ maxToolLoops: 120 });
  });
  it('uses the strictest explicit budget and preserves other actor defaults', () => {
    expect(resolveTurnExecutionPolicy('commander', '最多8次工具调用；最多3次工具调用')).toMatchObject({ maxToolCalls: 3 });
    expect(resolveTurnExecutionPolicy('agent', undefined)).toEqual({ maxToolLoops: 100 });
    expect(resolveTurnExecutionPolicy('worker', undefined)).toEqual({});
  });
  it('retains only finite nonnegative known timings, without coercion or invented zeros', () => {
    expect(normalizeRunTimings({ provider_ms: 40, tool_ms: 0, compaction_ms: -1, retry_wait_ms: '5', other_ms: Infinity, secret: 'x' })).toEqual({ providerMs: 40, toolMs: 0 });
    expect(normalizeRunTimings({})).toBeUndefined();
    expect(normalizeRunTimings({ provider_ms: NaN })).toBeUndefined();
  });
});
