// ─── project-upstream 单元测试 ──────────────────────────────────────────────
//
// 验证老协议 StreamEvent → chat.* 投影的关键行为：
// 1. 懒发 turn.started（首个产出事件自动带上，空流不发）；
// 2. 工具 start/progress/end 三相位投影为同一 itemId 的状态流转；
// 3. final 与 done 双到达时 turn.completed 只发一次；aborted → cancelled；
// 4. delta 聚合到同一 text item，final 时置 completed；
// 5. usage / compaction 投影；未知形状返回空数组。

import { describe, expect, it } from 'vitest';

import type { StreamEvent } from '../../../../src/main/model/client';
import {
  createChatEventProjectorState,
  projectUpstreamEvent,
} from '../../../../src/main/features/chat_events/project-upstream';

function newState() {
  return createChatEventProjectorState({ turnId: 't-1', cid: 'c-1', actorId: 'agent-main' });
}

function toolEvent(phase: string, data: Record<string, unknown>): StreamEvent {
  return { type: 'event', event: { stream: 'tool', data: { phase, ...data } } };
}

describe('projectUpstreamEvent', () => {
  it('首个产出事件自动携带 turn.started，且只发一次', () => {
    const state = newState();
    const first = projectUpstreamEvent(state, { type: 'delta', text: '你' });
    expect(first[0].type).toBe('chat.turn.started');
    expect(first[1]).toMatchObject({ type: 'chat.item', kind: 'text', payload: { delta: '你' } });

    const second = projectUpstreamEvent(state, { type: 'delta', text: '好' });
    expect(second.some((e) => e.type === 'chat.turn.started')).toBe(false);
    // 同一 text item 聚合增量。
    const textSecond = second[0] as { itemId?: string };
    const textFirst = first[1] as { itemId?: string };
    expect(textSecond.itemId).toBe(textFirst.itemId);
  });

  it('空流（无产出事件）不发送任何事件', () => {
    const state = newState();
    // 未知形状 → 空数组，不发 started。
    expect(projectUpstreamEvent(state, { type: 'event', event: { stream: 'future' } })).toEqual([]);
    // done 兜底时 started 也未发过 → 不补（无 started 的 completed 是孤儿）。
    const out = projectUpstreamEvent(state, { type: 'done' });
    expect(out).toEqual([]);
  });

  it('工具三相位投影为同一 itemId 的状态流转', () => {
    const state = newState();
    const start = projectUpstreamEvent(state, toolEvent('start', {
      id: 'tool-9', name: 'Bash', arguments: { command: 'npm test' },
    }));
    const progress = projectUpstreamEvent(state, toolEvent('progress', {
      id: 'tool-9', name: 'Bash', message: 'running…',
    }));
    const end = projectUpstreamEvent(state, toolEvent('end', {
      id: 'tool-9', name: 'Bash', isError: false, output: 'ok',
    }));

    const startItem = start.find((e) => e.type === 'chat.item') as { itemId: string; status: string };
    const progressItem = progress[0] as { itemId: string; status: string; payload: { output?: string } };
    const endItem = end[0] as { itemId: string; status: string; payload: { output?: string } };

    expect(startItem.itemId).toContain('tool-9');
    expect(startItem.status).toBe('inProgress');
    expect(progressItem.itemId).toBe(startItem.itemId);
    expect(progressItem.payload.output).toBe('running…');
    expect(endItem.itemId).toBe(startItem.itemId);
    expect(endItem.status).toBe('completed');
    expect(endItem.payload.output).toBe('ok');
  });

  it('工具失败投影为 failed 且携带错误码', () => {
    const state = newState();
    const out = projectUpstreamEvent(state, toolEvent('end', {
      id: 'tool-x', name: 'Write', isError: true, errorCode: 'E_DENIED', result_preview: 'denied',
    }));
    const item = out.find((e) => e.type === 'chat.item') as { status: string; payload: { error?: string } };
    expect(item.status).toBe('failed');
    expect(item.payload.error).toBe('E_DENIED');
  });

  it('final 与 done 双到达时 turn.completed 只发一次；aborted → cancelled', () => {
    const state = newState();
    projectUpstreamEvent(state, { type: 'delta', text: 'hi' });
    const finalOut = projectUpstreamEvent(state, { type: 'final', text: 'hi' });
    expect(finalOut.filter((e) => e.type === 'chat.turn.completed')).toHaveLength(1);

    const doneOut = projectUpstreamEvent(state, { type: 'done' });
    expect(doneOut).toEqual([]);

    // aborted 路径：无 final、直接 done(aborted)。
    const state2 = newState();
    projectUpstreamEvent(state2, { type: 'delta', text: 'x' });
    const abortedOut = projectUpstreamEvent(state2, { type: 'done', aborted: true });
    const completed = abortedOut.find((e) => e.type === 'chat.turn.completed') as { status: string };
    expect(completed.status).toBe('cancelled');
  });

  it('error 投影为 failed 且携带错误文本', () => {
    const state = newState();
    projectUpstreamEvent(state, { type: 'delta', text: 'x' });
    const out = projectUpstreamEvent(state, { type: 'error', text: 'provider 502' });
    const completed = out.find((e) => e.type === 'chat.turn.completed') as { status: string; error?: string };
    expect(completed.status).toBe('failed');
    expect(completed.error).toBe('provider 502');
  });

  it('progress 纯文本投影为 reasoning 卡片', () => {
    const state = newState();
    const out = projectUpstreamEvent(state, { type: 'progress', text: '正在读取文件…' });
    expect(out[1]).toMatchObject({ kind: 'reasoning', status: 'completed', payload: { text: '正在读取文件…' } });
  });

  it('usage 事件宽松取键并投影 usage 卡片', () => {
    const state = newState();
    const snake = projectUpstreamEvent(state, {
      type: 'event', event: { stream: 'usage', data: { input_tokens: 100, output_tokens: 40 } },
    });
    expect(snake[1]).toMatchObject({ kind: 'usage', payload: { inputTokens: 100, outputTokens: 40 } });

    const camel = projectUpstreamEvent(newState(), {
      type: 'event', event: { stream: 'usage', data: { inputTokens: 7, outputTokens: 3 } },
    });
    expect(camel[1]).toMatchObject({ kind: 'usage', payload: { inputTokens: 7, outputTokens: 3 } });
  });

  it('超长工具参数与输出被截断', () => {
    const state = newState();
    const long = 'a'.repeat(300);
    const start = projectUpstreamEvent(state, toolEvent('start', { id: 't', name: 'Bash', arguments: { command: long } }));
    const item = start.find((e) => e.type === 'chat.item') as { payload: { argsSummary?: string } };
    expect(item.payload.argsSummary!.length).toBeLessThanOrEqual(121);

    const end = projectUpstreamEvent(state, toolEvent('end', { id: 't', name: 'Bash', output: 'x'.repeat(5000) }));
    const endItem = end[0] as { payload: { output?: string } };
    expect(endItem.payload.output!.length).toBeLessThanOrEqual(4000);
  });
});
