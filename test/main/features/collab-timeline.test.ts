import { describe, it, expect } from 'vitest';

import { parseGroupMessages } from '../../../src/main/features/collab_timeline';

// 群聊 jsonl → 协作接力序列解析器。数据是既有事实（GroupMessage 流水），
// 解析只做结构化：参与者、按 ts 排序的接力序列、指挥官派发标记。
// 画结构不编意图——决策理由只在消息原文里，解析器绝不推断。

function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'm1',
    ts: '2026-08-26T10:00:00.000Z',
    from: 'user',
    to: ['commander'],
    text: 'hello',
    ...over,
  });
}

describe('collab timeline parser', () => {
  it('collects participants, orders turns by ts, and counts dispatches', () => {
    const out = parseGroupMessages('c1', [
      line({ id: 'm2', ts: '2026-08-26T10:00:02.000Z', from: 'commander', to: ['user'], text: '分好了' }),
      line({ id: 'm1', ts: '2026-08-26T10:00:00.000Z', from: 'user', to: ['commander'], text: '帮我调研' }),
      line({ id: 'm3', ts: '2026-08-26T10:00:01.000Z', from: 'commander', to: ['researcher'], dispatch: true, turn_id: 't1', text: '去调研 X' }),
    ]);
    expect(out.turns.map((t) => t.messageId)).toEqual(['m1', 'm3', 'm2']);
    expect(out.participants.sort()).toEqual(['commander', 'researcher', 'user']);
    expect(out.agents).toEqual(['researcher']);
    expect(out.dispatchCount).toBe(1);
    expect(out.lastTs).toBe('2026-08-26T10:00:02.000Z');
  });

  it('keeps fan-out dispatches to multiple agents as separate turns', () => {
    const out = parseGroupMessages('c1', [
      line({ from: 'user', to: ['commander'] }),
      line({ id: 'd1', from: 'commander', to: ['researcher', 'writer'], dispatch: true }),
      line({ id: 'd2', ts: '2026-08-26T10:00:01.000Z', from: 'commander', to: ['reviewer'], dispatch: true }),
    ]);
    expect(out.dispatchCount).toBe(2);
    expect(out.turns.find((t) => t.messageId === 'd1')?.to).toEqual(['researcher', 'writer']);
  });

  it('skips malformed lines instead of failing the whole conversation', () => {
    const out = parseGroupMessages('c1', [
      'not json',
      JSON.stringify({ no: 'required fields' }),
      line({ id: 'ok1' }),
    ]);
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0].messageId).toBe('ok1');
  });

  it('reports an empty summary for an empty conversation', () => {
    const out = parseGroupMessages('c1', []);
    expect(out).toMatchObject({ cid: 'c1', turns: [], participants: [], agents: [], dispatchCount: 0 });
    expect(out.lastTs).toBeUndefined();
  });

  it('marks conversations without external agents as plain chats', () => {
    const out = parseGroupMessages('c1', [
      line({ from: 'user', to: ['commander'] }),
      line({ id: 'r1', from: 'commander', to: ['user'] }),
    ]);
    expect(out.agents).toEqual([]);
  });
});
