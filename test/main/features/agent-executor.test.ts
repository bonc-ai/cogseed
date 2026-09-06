import { beforeEach, describe, expect, it, vi } from 'vitest';

// R2 收口层的模块边界 mock：gatewayExecutor 内部对 bridge 模块的 dynamic
// import 与 vi.mock 按同一模块路径解析命中（静态/动态均可被替换）。
const gatewayTurnMock = vi.hoisted(() => ({
  calls: [] as any[],
  nextResult: null as any,
}));
vi.mock('../../../src/main/features/p3394_bridge/p3394-gateway-turn', () => ({
  runP3394GatewayTurn: vi.fn(async (input: any) => {
    gatewayTurnMock.calls.push(input);
    return gatewayTurnMock.nextResult;
  }),
}));

import {
  gatewayExecutor,
  inProcessExecutor,
  resolveAgentExecutor,
} from '../../../src/main/features/agent-executor';

describe('features › agent-executor (R2 收口层)', () => {
  beforeEach(() => {
    gatewayTurnMock.calls.length = 0;
    gatewayTurnMock.nextResult = null;
  });

  it('resolveAgentExecutor 按 runtime kind 分发：网关型 → gatewayExecutor', () => {
    expect(resolveAgentExecutor({ runtime: { kind: 'p3394-gateway', cli: 'codex' } }).kind)
      .toBe('p3394-gateway');
  });

  it('resolveAgentExecutor：in_process / 无 runtime / null 均落到 inProcessExecutor', () => {
    expect(resolveAgentExecutor({ runtime: { kind: 'in_process' } }).kind).toBe('in_process');
    expect(resolveAgentExecutor({}).kind).toBe('in_process');
    expect(resolveAgentExecutor(null).kind).toBe('in_process');
    expect(resolveAgentExecutor(undefined).kind).toBe('in_process');
  });

  it('gatewayExecutor.run 原样透传轮次输入并归一 produced（缺省 → 空数组）', async () => {
    gatewayTurnMock.nextResult = { text: 'done', error: undefined, aborted: false };
    const onProcess = vi.fn();
    const outcome = await gatewayExecutor.run({
      uid: 'u1',
      cid: 'c1',
      agent: { agent_id: 'a1', name: 'Ext' },
      cli: 'codex',
      prompt: 'do it',
      workingDir: '/tmp/ws',
      signal: new AbortController().signal,
      onProcess,
    });
    // 输入透传：mock 捕获到的正是 executor 收到的轮次对象
    expect(gatewayTurnMock.calls).toHaveLength(1);
    expect(gatewayTurnMock.calls[0]).toMatchObject({
      uid: 'u1',
      cid: 'c1',
      agent: { agent_id: 'a1', name: 'Ext' },
      cli: 'codex',
      prompt: 'do it',
      workingDir: '/tmp/ws',
    });
    expect(gatewayTurnMock.calls[0].onProcess).toBe(onProcess);
    // 产出归一：produced 缺省补 []，其余字段照传
    expect(outcome).toEqual({ text: 'done', error: undefined, aborted: false, produced: [] });
    expect(outcome.produced).toEqual([]);
  });

  it('gatewayExecutor.run 透传错误三元组与 metrics', async () => {
    gatewayTurnMock.nextResult = {
      text: '',
      produced: ['/tmp/ws/out.md'],
      error: 'boom',
      failureKind: 'runtime',
      failureCode: 'p3394_gateway_unreachable',
      infrastructureFailure: true,
      aborted: true,
      metrics: { startedAt: 1, firstTokenAt: 2, completedAt: 3, model: 'gpt-x' },
    };
    const outcome = await gatewayExecutor.run({
      uid: 'u1', cid: 'c1', agent: { agent_id: 'a1' }, cli: 'claude', prompt: 'p',
    });
    expect(outcome.produced).toEqual(['/tmp/ws/out.md']);
    expect(outcome.failureCode).toBe('p3394_gateway_unreachable');
    expect(outcome.infrastructureFailure).toBe(true);
    expect(outcome.aborted).toBe(true);
    expect(outcome.metrics).toMatchObject({ model: 'gpt-x' });
  });

  it('inProcessExecutor.run 为第一轮直通标记：返回结构化 unwired 错误（G-19 错误语义由返回值承载）', async () => {
    const outcome = await inProcessExecutor.run({
      uid: 'u1', cid: 'c1', agent: { agent_id: 'a1' }, cli: '', prompt: 'p',
    });
    expect(outcome.text).toBe('');
    expect(outcome.produced).toEqual([]);
    expect(outcome.failureKind).toBe('runtime');
    expect(outcome.failureCode).toBe('agent_executor_in_process_unwired');
    expect(outcome.infrastructureFailure).toBe(true);
    expect(outcome.error).toMatch(/in-process loop still runs inside group_chat\/bus/);
    // 内置循环未搬入前，in_process 路径不应触碰网关模块
    expect(gatewayTurnMock.calls).toHaveLength(0);
  });
});
