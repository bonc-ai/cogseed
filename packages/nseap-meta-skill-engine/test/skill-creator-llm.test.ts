import { describe, it, expect } from 'vitest';
import { SkillCreator } from '../src/modules/skill-creator';
import type { LlmComplete } from '../src/modules/llm-port';

const mockLlm: LlmComplete = async (prompt) => ({
  text: JSON.stringify({ purpose: 'MOCK:' + prompt.includes('总结'), verdicts: [true, false] }),
  degraded: false,
});

describe('SkillCreator + LlmComplete', () => {
  it('extractIntentFromHistory 传入 llm 时调用它，不再截断末条消息', async () => {
    const sc = new SkillCreator();
    const intent = await sc.extractIntentFromHistory(
      [{ role: 'user', content: '帮我做学术论文查重' }],
      mockLlm,
    );
    expect(intent.purpose).toContain('MOCK:');
  });

  it('未传 llm 时回退到旧占位实现（不抛错）', async () => {
    const sc = new SkillCreator();
    const intent = await sc.extractIntentFromHistory([{ role: 'user', content: 'x' }]);
    expect(intent.purpose).toContain('Handle queries');
  });
});
