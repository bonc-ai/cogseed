import { describe, it, expect } from 'vitest';

import { createConfig } from '../../../../src/core-agent/src/config';
import {
  maxToolLoopsForActorTurn,
  maxToolLoopsForActorKind,
  LIGHT_TASK_MAX_TOOL_LOOPS,
  COMMANDER_MAX_TOOL_LOOPS,
  AGENT_MAX_TOOL_LOOPS,
} from '../../../../src/main/features/group_chat/actor-budgets';

// These values pin the per-turn tool-round budgets and deliberately cross-check
// the core-agent schema default so the two policies cannot silently diverge.
describe('actor-budgets › maxToolLoopsForActorKind', () => {
  it('gives the commander a raised orchestration budget (120)', () => {
    expect(maxToolLoopsForActorKind('commander')).toBe(COMMANDER_MAX_TOOL_LOOPS);
    expect(COMMANDER_MAX_TOOL_LOOPS).toBe(120);
  });

  it('pins named agent workers to the current 100-round production budget', () => {
    expect(maxToolLoopsForActorKind('agent')).toBe(AGENT_MAX_TOOL_LOOPS);
    expect(AGENT_MAX_TOOL_LOOPS).toBe(100);
    expect(AGENT_MAX_TOOL_LOOPS).toBe(createConfig().agent.maxToolLoops);
  });

  it('leaves ephemeral workers and users on the 100-round core-agent schema default', () => {
    expect(createConfig().agent.maxToolLoops).toBe(100);
    expect(maxToolLoopsForActorKind('worker')).toBeUndefined();
    expect(maxToolLoopsForActorKind('user')).toBeUndefined();
  });

  it('uses a small budget only when a turn is explicitly classified lightweight', () => {
    expect(LIGHT_TASK_MAX_TOOL_LOOPS).toBe(24);
    expect(maxToolLoopsForActorTurn('commander', { taskClass: 'light' })).toBe(LIGHT_TASK_MAX_TOOL_LOOPS);
    expect(maxToolLoopsForActorTurn('agent', { taskClass: 'light' })).toBe(LIGHT_TASK_MAX_TOOL_LOOPS);
  });

  it('keeps existing budgets when a turn class is unknown or standard', () => {
    expect(maxToolLoopsForActorTurn('commander')).toBe(COMMANDER_MAX_TOOL_LOOPS);
    expect(maxToolLoopsForActorTurn('agent', { taskClass: 'unknown' })).toBe(AGENT_MAX_TOOL_LOOPS);
    expect(maxToolLoopsForActorTurn('worker', { taskClass: 'standard' })).toBeUndefined();
  });
});
