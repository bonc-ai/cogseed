import { describe, expect, it } from 'vitest';
import { parseHermesCommanderDecision } from '../../../src/main/features/commander_backends/hermes';

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
});
