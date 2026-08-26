import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  setModelUsageSink,
  emitModelUsage,
  type ModelUsageEvent,
} from '../../../src/main/model/core-agent/usage-events';

// Usage 事件通道 —— model 层只负责「每次模型调用结束时报账」，落库由 features 层
// 注册 sink 完成（依赖方向：features → model，model 不 import features）。
// 这里测通道本身的契约：未注册时安全空操作、事件原样送达、sink 抛错不外传、可注销。

const sampleEvent: ModelUsageEvent = {
  at: 1756200000000,
  userId: 'u1',
  sessionId: 's1',
  conversationId: 'c1',
  agentId: 'a1',
  providerId: 'openai',
  modelId: 'gpt-5',
  inputTokens: 1200,
  outputTokens: 800,
  cacheReadTokens: 300,
  cacheWriteTokens: 100,
  totalTokens: 2400,
  durationMs: 5400,
  status: 'completed',
};

afterEach(() => {
  setModelUsageSink(null);
});

describe('model usage event channel', () => {
  it('emitting without a registered sink is a safe no-op', () => {
    expect(() => emitModelUsage(sampleEvent)).not.toThrow();
  });

  it('delivers the event to the registered sink unchanged', () => {
    const received: ModelUsageEvent[] = [];
    setModelUsageSink((ev) => received.push(ev));
    emitModelUsage(sampleEvent);
    expect(received).toEqual([sampleEvent]);
  });

  it('forwards firstTokenMs when provided', () => {
    const seen: any[] = [];
    setModelUsageSink((e) => seen.push(e));
    emitModelUsage({ at: 1, durationMs: 10, status: 'completed', firstTokenMs: 4400 });
    expect(seen[0].firstTokenMs).toBe(4400);
  });

  it('swallows sink errors so usage logging never breaks the model call', () => {
    const boom = vi.fn(() => { throw new Error('disk full'); });
    setModelUsageSink(boom);
    expect(() => emitModelUsage(sampleEvent)).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after the sink is unregistered', () => {
    const received: ModelUsageEvent[] = [];
    setModelUsageSink((ev) => received.push(ev));
    setModelUsageSink(null);
    emitModelUsage(sampleEvent);
    expect(received).toEqual([]);
  });
});
