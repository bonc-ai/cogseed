/**
 * S1 / B1 / E08 — 可信接待上下文投影的纯函数与模型视图契约。
 *
 * 这组用例钉住四件事：
 *  1. 归属只认宿主持久化字段：peer 提问行 + `turn_id === turn-<question id>`
 *     的收尾回答；不按“最后一条收尾气泡”猜；
 *  2. 本地助理回答、状态行、未收尾片段、无答案/无归属的提问一律不进入允许历史
 *     ——包括“本地回合先开始、peer 提问插入、本地回答后落盘”的交错顺序；
 *  3. 有界性（最近 N 对 / 单条上限）；
 *  4. 投影重放进内存 Session 后，模型视图与 compaction/辅助 complete 读取的
 *     摘要视图都只包含这些允许问答（当前外部回合追加在其后）。
 *
 * 端到端（真实 client → buildRunner → SDK → provider transport）的隔离断言在
 * `reception-context-isolation.test.ts`；这里不 mock 生产投影逻辑。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/logger', () => {
  const log = () => {};
  return {
    createLogger: () => ({ debug: log, info: log, warn: log, error: log }),
    initLogger: () => {},
    logFromRenderer: () => {},
    redact: (value: unknown) => value,
    sweepLogs: () => ({ removed: 0, remaining: 0, totalBytes: 0 }),
  };
});

import {
  projectReceptionHistory,
  replayReceptionHistory,
  RECEPTION_HISTORY_MAX_ENTRY_CHARS,
  RECEPTION_HISTORY_MAX_TURNS,
} from '../../../../src/main/features/a2a/reception-context';

const PEER = 'a2a_cs_projection_unit';
const LOCAL_QUESTION = 'LOCAL-QUESTION-DO-NOT-PROJECT';
const LOCAL_ANSWER = 'LOCAL-ANSWER-DO-NOT-PROJECT';
/** 生产的接待 runner 用 `turn-${.questionMessageId}` 作为回答的执行 id。 */
const answerTurn = (questionId: string) => `turn-${questionId}`;

interface RowInput {
  id?: string;
  to?: string[];
  turn_end?: boolean;
  turn_id?: string;
  system_kind?: string;
}

function row(from: string, text: string, input: RowInput = {}) {
  return {
    ...(input.id ? { id: input.id } : {}),
    from,
    text,
    to: input.to ?? ['user'],
    ...(input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(input.turn_end ? { turn_end: true } : {}),
    ...(input.system_kind ? { system_kind: input.system_kind } : {}),
  };
}

function localPair(suffix: string) {
  return [
    row('user', `${LOCAL_QUESTION}-${suffix}`, { id: `local-q-${suffix}`, to: ['a1'] }),
    row('a1', `${LOCAL_ANSWER}-${suffix}`, {
      turn_end: true,
      turn_id: `local-turn-${suffix}`,
    }),
  ];
}

describe('a2a reception context projection', () => {
  it('projects only peer questions and the definitively owned answer the peer received', () => {
    const rows = [
      ...localPair('a'),
      row(PEER, '公开问题一', { id: 'a2a-in-1', to: ['a1'] }),
      row('a1', '公开答复一', { turn_end: true, turn_id: answerTurn('a2a-in-1') }),
      ...localPair('b'),
      // 当前回合的提问已落盘但还没有回答：不能重复注入历史。
      row(PEER, '公开问题二', { id: 'a2a-in-2', to: ['a1'] }),
    ];

    expect(projectReceptionHistory(rows, PEER)).toEqual([
      { question: '公开问题一', answer: '公开答复一' },
    ]);
  });

  it('never borrows a local turn reply as the answer to a peer question', () => {
    const rows = [
      row(PEER, '未获回答的对端提问', { id: 'a2a-in-3', to: ['a1'] }),
      row('user', LOCAL_QUESTION, { id: 'local-q-c', to: ['a1'] }),
      row('a1', LOCAL_ANSWER, { turn_end: true, turn_id: 'local-turn-c' }),
    ];

    // 顺序上本地回答紧跟对端提问，但它没有该提问的宿主执行 id。
    expect(projectReceptionHistory(rows, PEER)).toEqual([]);
  });

  it('keeps a local assistant reply out even when it lands after an interleaved peer question', () => {
    // 交错形态（F2）：本地回合先开始 → peer 提问在运行中入队 →
    // 本地助理的私密回答后落盘 → 下一次外部请求不得把它当成 peer 回答。
    const rows = [
      row('user', `本地回合 ${LOCAL_QUESTION}`, { id: 'local-q-d', to: ['a1'] }),
      row(PEER, '交错的对端提问', { id: 'a2a-in-4', to: ['a1'] }),
      row('a1', LOCAL_ANSWER, { turn_end: true, turn_id: 'local-turn-d' }),
    ];
    expect(projectReceptionHistory(rows, PEER)).toEqual([]);

    // 真正的归属回答稍后才落盘：只投影它，绝不采用中间那条本地回答。
    rows.push(row('a1', '对端应得的回答', { turn_end: true, turn_id: answerTurn('a2a-in-4') }));
    expect(projectReceptionHistory(rows, PEER)).toEqual([
      { question: '交错的对端提问', answer: '对端应得的回答' },
    ]);
  });

  it('treats host status rows, non-terminal segments and foreign turn ids as non-answers', () => {
    const rows = [
      row(PEER, '问题', { id: 'a2a-in-5', to: ['a1'] }),
      row('a1', '中断的系统提示', {
        turn_end: true,
        turn_id: answerTurn('a2a-in-5'),
        system_kind: 'reply_interrupted',
      }),
      row('a1', '未收尾片段', { turn_id: answerTurn('a2a-in-5') }),
      row('a1', '别的回合的收尾气泡', { turn_end: true, turn_id: 'turn-a2a-in-other' }),
      row(PEER, '下一个问题', { id: 'a2a-in-6', to: ['a1'] }),
    ];

    expect(projectReceptionHistory(rows, PEER)).toEqual([]);
  });

  it('drops peer rows without a stable id and answers without the owner field', () => {
    const rows = [
      row(PEER, '旧格式提问（无 id）', { to: ['a1'] }),
      row('a1', '旧格式回答（无 turn_id）', { turn_end: true }),
      row(PEER, '有 id 的提问', { id: 'a2a-in-7', to: ['a1'] }),
      row('a1', '没有执行 id 的回答', { turn_end: true }),
    ];

    expect(projectReceptionHistory(rows, PEER)).toEqual([]);
  });

  it('ignores rows from another peer or foreign authors', () => {
    const rows = [
      row('a2a_cs_someone_else', '别人问的问题', { id: 'a2a-in-8', to: ['a1'] }),
      row('a1', '给别人的回答', { turn_end: true, turn_id: answerTurn('a2a-in-8') }),
    ];

    expect(projectReceptionHistory(rows, PEER)).toEqual([]);
    expect(projectReceptionHistory(rows, '')).toEqual([]);
  });

  it('bounds the projection to the most recent pairs and truncates oversized entries', () => {
    const rows: ReturnType<typeof row>[] = [];
    for (let index = 0; index < RECEPTION_HISTORY_MAX_TURNS + 3; index += 1) {
      const qid = `big-${index}`;
      rows.push(row(PEER, `q${index}`, { id: qid, to: ['a1'] }));
      rows.push(row('a1', `a${index}`, { turn_end: true, turn_id: answerTurn(qid) }));
    }
    const projected = projectReceptionHistory(rows, PEER);
    expect(projected).toHaveLength(RECEPTION_HISTORY_MAX_TURNS);
    expect(projected[0]).toEqual({ question: 'q3', answer: 'a3' });
    expect(projected[projected.length - 1]).toEqual({
      question: `q${RECEPTION_HISTORY_MAX_TURNS + 2}`,
      answer: `a${RECEPTION_HISTORY_MAX_TURNS + 2}`,
    });

    const oversized = 'x'.repeat(RECEPTION_HISTORY_MAX_ENTRY_CHARS + 100);
    const truncated = projectReceptionHistory([
      row(PEER, oversized, { id: 'oversized-q', to: ['a1'] }),
      row('a1', oversized, { turn_end: true, turn_id: answerTurn('oversized-q') }),
    ], PEER);
    expect(truncated).toHaveLength(1);
    expect(truncated[0].question.length).toBeLessThan(oversized.length);
    expect(truncated[0].answer.length).toBeLessThan(oversized.length);
    expect(truncated[0].question).toContain('[truncated]');
  });

  it('replays the projection into the in-memory session so compaction/summary views stay external-only', async () => {
    const { Session } = await import('#core-agent');
    const session = new Session();
    replayReceptionHistory(session, [
      { question: '公开问题一', answer: '公开答复一' },
      { question: '公开问题二', answer: '公开答复二' },
    ]);
    // 当前外部回合由 core-agent 自己 beginUserTurn。
    session.beginUserTurn([{ type: 'text', text: '公开问题三（当前回合）' }]);

    const modelView = JSON.stringify(session.getMessagesForModel());
    // 摘要视图是 compaction / 辅助 complete 的输入口径。
    const summaryView = JSON.stringify(session.getMessagesForSummary());

    for (const token of ['公开问题一', '公开答复一', '公开问题二', '公开答复二', '公开问题三（当前回合）']) {
      expect(modelView).toContain(token);
      expect(summaryView).toContain(token);
    }
    expect(modelView).not.toContain(LOCAL_QUESTION);
    expect(modelView).not.toContain(LOCAL_ANSWER);
    expect(summaryView).not.toContain(LOCAL_QUESTION);
    expect(summaryView).not.toContain(LOCAL_ANSWER);
    // 顺序：允许历史在历史区，当前回合在尾部。
    expect(modelView.indexOf('公开问题一')).toBeLessThan(modelView.indexOf('公开问题三（当前回合）'));
    // 重放不产生额外的回合结果标记（这些是正常完成的问答）。
    expect(modelView).not.toContain('[Turn outcome]');
  });

  it('ignores malformed replay input instead of throwing', async () => {
    const { Session } = await import('#core-agent');
    const session = new Session();
    expect(() => replayReceptionHistory(session, undefined)).not.toThrow();
    expect(() => replayReceptionHistory(session, [
      { question: 1, answer: 2 } as any,
      { question: 'q', answer: 'a' },
    ])).not.toThrow();
    const messages = session.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
    expect(JSON.stringify(messages)).toContain('"q"');
  });
});
