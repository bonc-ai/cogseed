// ─── chat_events schema 单元测试 ────────────────────────────────────────────
//
// 契约见 design/conv-core/spec.md「事件契约」。重点验证：
// 1. 五种事件各自的最小合法形状；
// 2. 判别字段（type）路由正确，未知 type 被 safeParse 拒绝；
// 3. parseChatStreamEvent 对垃圾输入返回 null（SSE 出口宽容跳过）；
// 4. Item 三态/五 kind 常量与 schema 一致（防手改漂移）。

import { describe, expect, it } from 'vitest';

import {
  CHAT_ITEM_KINDS,
  CHAT_ITEM_STATUSES,
  CHAT_TURN_TERMINAL_STATUSES,
  chatStreamEventSchema,
  parseChatStreamEvent,
} from '../../../../src/main/features/chat_events';

describe('chat stream event schema', () => {
  it('接受 turn.started 最小形状', () => {
    const event = parseChatStreamEvent({
      type: 'chat.turn.started',
      turnId: 't-1',
      cid: 'c-1',
      actorId: 'agent-main',
      startedAt: '2026-08-30T12:00:00Z',
    });
    expect(event).toMatchObject({ type: 'chat.turn.started', turnId: 't-1' });
  });

  it('接受 turn.completed 且 durationMs 可选', () => {
    expect(
      parseChatStreamEvent({
        type: 'chat.turn.completed',
        turnId: 't-1',
        status: 'completed',
        endedAt: '2026-08-30T12:00:05Z',
      }),
    ).toMatchObject({ status: 'completed' });

    expect(
      parseChatStreamEvent({
        type: 'chat.turn.completed',
        turnId: 't-1',
        status: 'failed',
        durationMs: 1200,
        error: 'gateway 502',
        endedAt: '2026-08-30T12:00:05Z',
      }),
    ).toMatchObject({ status: 'failed', error: 'gateway 502' });
  });

  it('turn.completed 只接受三种终态', () => {
    for (const status of CHAT_TURN_TERMINAL_STATUSES) {
      expect(
        parseChatStreamEvent({
          type: 'chat.turn.completed',
          turnId: 't-1',
          status,
          endedAt: '2026-08-30T12:00:05Z',
        }),
      ).not.toBeNull();
    }
    expect(
      parseChatStreamEvent({
        type: 'chat.turn.completed',
        turnId: 't-1',
        status: 'inProgress',
        endedAt: '2026-08-30T12:00:05Z',
      }),
    ).toBeNull();
  });

  it('接受五种 item kind 且载荷形状随 kind 变化', () => {
    const cases = [
      {
        kind: 'reasoning',
        payload: { text: '先查入口文件…' },
      },
      {
        kind: 'toolExecution',
        payload: { toolName: 'Bash', argsSummary: 'npm test', output: 'ok' },
      },
      {
        kind: 'fileChange',
        payload: { filePath: '/a/b.ts', diff: '@@ -1 +1 @@', summary: '+1 -1' },
      },
      { kind: 'text', payload: { delta: '你好' } },
      { kind: 'usage', payload: { inputTokens: 10, outputTokens: 5 } },
    ];
    for (const { kind, payload } of cases) {
      expect(
        parseChatStreamEvent({
          type: 'chat.item',
          turnId: 't-1',
          itemId: `i-${kind}`,
          kind,
          status: 'inProgress',
          payload,
        }),
      ).toMatchObject({ kind });
    }
    // kind 与载荷错配（fileChange 缺 diff）必须被拒。
    expect(
      parseChatStreamEvent({
        type: 'chat.item',
        turnId: 't-1',
        itemId: 'i-x',
        kind: 'fileChange',
        status: 'inProgress',
        payload: { filePath: '/a/b.ts' },
      }),
    ).toBeNull();
  });

  it('item 三态常量与 schema 一致', () => {
    expect([...CHAT_ITEM_STATUSES]).toEqual(['inProgress', 'completed', 'failed']);
    expect([...CHAT_ITEM_KINDS]).toHaveLength(5);
  });

  it('interaction.requested 要求超时与提示文本', () => {
    expect(
      parseChatStreamEvent({
        type: 'chat.interaction.requested',
        turnId: 't-1',
        interactionId: 'x-1',
        kind: 'approval',
        prompt: '执行 rm -rf dist？',
        detail: 'rm -rf dist',
        timeoutMs: 30_000,
        approvalCategory: 'bash',
      }),
    ).toMatchObject({ kind: 'approval', approvalCategory: 'bash' });

    // 缺 timeoutMs 拒绝（主进程必须给渲染层倒计时依据）。
    expect(
      parseChatStreamEvent({
        type: 'chat.interaction.requested',
        turnId: 't-1',
        interactionId: 'x-1',
        kind: 'question',
        prompt: '用哪个分支？',
      }),
    ).toBeNull();
  });

  it('interaction.closed 接受三种关闭原因', () => {
    for (const reason of ['answered', 'timeout', 'turnCancelled'] as const) {
      expect(
        parseChatStreamEvent({
          type: 'chat.interaction.closed',
          interactionId: 'x-1',
          reason,
        }),
      ).toMatchObject({ reason });
    }
  });

  it('未知 type 与垃圾输入返回 null（向前兼容跳过）', () => {
    expect(parseChatStreamEvent({ type: 'chat.future.event' })).toBeNull();
    expect(parseChatStreamEvent(null)).toBeNull();
    expect(parseChatStreamEvent('string')).toBeNull();
    expect(parseChatStreamEvent(42)).toBeNull();
  });

  it('判别联合按 type 路由（schema 直用时的错误信息可用）', () => {
    const result = chatStreamEventSchema.safeParse({ type: 'chat.item' });
    expect(result.success).toBe(false);
  });
});
