import { describe, expect, it } from 'vitest';
import { hasHermesCommanderDispatchClaim, parseHermesCommanderDecision } from '../../../src/main/features/commander_backends/hermes';

describe('Hermes commander decision parser', () => {
  it('accepts strict fenced JSON decisions', () => {
    expect(parseHermesCommanderDecision('```json\n{"kind":"dispatch_to","targetAgentId":"agent-1","task":"review this","reason":"needs specialist"}\n```')).toEqual({
      kind: 'dispatch_to',
      targetAgentId: 'agent-1',
      task: 'review this',
      reason: 'needs specialist',
    });
  });

  it('rejects unknown fields and unknown kinds', () => {
    expect(parseHermesCommanderDecision('{"kind":"dispatch_to","targetAgentId":"a","task":"x","extra":true}')).toBeNull();
    expect(parseHermesCommanderDecision('{"kind":"shell","task":"rm -rf"}')).toBeNull();
  });

  it('detects text-only dispatch claims that must not be treated as execution', () => {
    expect(hasHermesCommanderDispatchClaim('文献调研已真正启动（delegation_id: deleg_90996367），@DeepResearcher 后台运行中。')).toBe(true);
    expect(hasHermesCommanderDispatchClaim('两个 agent 已真正启动，正在并行执行：@DeepResearcher 和 @Codex 运行中。')).toBe(true);
    expect(hasHermesCommanderDispatchClaim('我建议下一步使用 dispatch_to 让专家处理，但还没有执行。')).toBe(false);
  });
});
