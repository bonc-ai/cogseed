import { describe, it, expect } from 'vitest';
import { ruleFallbackComplete, type LlmComplete } from '../src/modules/llm-port';

describe('llm-port', () => {
  it('ruleFallbackComplete 返回标记降级的确定性文本，不抛错', async () => {
    const out = await ruleFallbackComplete('任意提示');
    expect(out.degraded).toBe(true);
    expect(typeof out.text).toBe('string');
    expect(out.text.length).toBeGreaterThan(0);
  });

  it('LlmComplete 类型可被普通异步函数满足', async () => {
    const fn: LlmComplete = async (prompt) => ({ text: prompt.toUpperCase(), degraded: false });
    const r = await fn('hi');
    expect(r.text).toBe('HI');
    expect(r.degraded).toBe(false);
  });
});
