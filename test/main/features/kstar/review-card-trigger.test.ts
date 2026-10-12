import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { KstarReviewRecord } from '../../../../src/main/features/kstar/types';

// 语义查重不依赖真实 embedding 模型：按文本哈希生成确定性 512 维向量。
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Array.from({ length: 512 }, (_, i) => Math.sin(h + i * 0.618) * 0.1);
  },
}));

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-card-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const TASK_CLOSURE = '../../../../src/main/features/kstar/task-closure';
const REVIEW_CARD = '../../../../src/main/features/kstar/review-card';

/** needsConfirmation=true 的推理结果：复盘卡触发条件（终态 + 需确认）成立。 */
const needsConfirmationInference = async (_userId: string, episode: any) => ({
  review: {
    expectedResult: 'The report is produced.',
    actualResult: 'The report was produced and verified.',
    deltaR: 0 as const,
    deltaA: 'unknown' as const,
    outcome: 'met_expected' as const,
    attribution: 'unclear' as const,
    reason: 'Provisional R-hat match pending user confirmation.',
    confidence: 0.6,
    evidenceRefs: episode.evidenceRefs,
  },
  reviewState: 'needs_confirmation' as const,
  inferenceMethod: 'deterministic' as const,
  needsConfirmation: true,
});

const inferenceNotNeedingConfirmation = async (_userId: string, episode: any) => ({
  review: {
    expectedResult: episode.t.userGoal,
    actualResult: 'Done.',
    deltaR: 0 as const,
    deltaA: 'unknown' as const,
    outcome: 'met_expected' as const,
    attribution: 'unclear' as const,
    reason: 'No confirmation needed.',
    confidence: 0.9,
    evidenceRefs: episode.evidenceRefs,
  },
  reviewState: 'inferred' as const,
  inferenceMethod: 'model' as const,
  needsConfirmation: false,
});

function reviewFixture(overrides: Partial<KstarReviewRecord> = {}): KstarReviewRecord {
  return {
    schemaVersion: 1,
    ownerId: 'card-user',
    id: 'ksr-kse-run-fixture',
    episodeId: 'kse-run-fixture',
    expectedResult: '完成用户请求。',
    actualResult: '已经完成并通过验证。',
    deltaR: 0,
    deltaA: 'unknown',
    outcome: 'met_expected',
    attribution: 'unclear',
    reason: 'Needs confirmation.',
    confidence: 0.6,
    needsConfirmation: true,
    evidenceRefs: [],
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('KSTAR review card expectedSource derivation', () => {
  it('derives user for user-supplied expectations, inferred for system inference, none without an expectation', async () => {
    const cards = await import(REVIEW_CARD);

    // 用户确实给过预期 → user。
    expect(cards.deriveExpectedSource(reviewFixture({ inferenceMethod: 'user' }))).toBe('user');
    // 存量 Commander 回合在对话里确立的预期（D6）→ user。
    expect(cards.deriveExpectedSource(reviewFixture({ inferenceMethod: 'commander' }))).toBe('user');

    // 系统按任务目标推断的预期 → inferred（不得与用户自述同形）。
    for (const method of ['deterministic', 'model', 'unknown', undefined] as const) {
      expect(cards.deriveExpectedSource(reviewFixture({ inferenceMethod: method }))).toBe('inferred');
    }

    // 没有可核对的预期 → none（空白等同于缺失）。
    expect(cards.deriveExpectedSource(reviewFixture({ expectedResult: undefined }))).toBe('none');
    expect(cards.deriveExpectedSource(reviewFixture({ expectedResult: '   ' }))).toBe('none');
  });

  it('carries expectedSource in the payload and omits expectedResult instead of faking one', async () => {
    const cards = await import(REVIEW_CARD);
    const inferred = cards.buildKstarReviewCard(reviewFixture({ inferenceMethod: 'deterministic' }));
    expect(inferred).toMatchObject({
      kind: 'kstar_review_card',
      episodeId: 'kse-run-fixture',
      reviewId: 'ksr-kse-run-fixture',
      expectedSource: 'inferred',
    });

    const none = cards.buildKstarReviewCard(reviewFixture({ expectedResult: undefined, inferenceMethod: 'unknown' }));
    expect(none.expectedSource).toBe('none');
    expect('expectedResult' in none).toBe(false);
    // 内部字段不进载荷（deltaR/confidence 留在后台记录里）。
    expect('deltaR' in none).toBe(false);
    expect('confidence' in none).toBe(false);
  });
});

describe('KSTAR review card trigger', () => {
  it('posts exactly one card after a terminal closure that needs confirmation', async () => {
    const closure = await import(TASK_CLOSURE);
    const reviews = await import('../../../../src/main/features/kstar/review-service');
    let listener: ((event: any) => void) | undefined;
    const published: Array<{ userId: string; conversationId: string; review: KstarReviewRecord }> = [];
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-card-ok', ts: '2026-09-25T00:00:01.000Z', from: 'user', text: 'Produce the report.' }],
      capture: (input) => closure.captureGroupKstarClosure({ ...input, inferReview: needsConfirmationInference }),
      publishReviewCard: async (userId, conversationId, review) => { published.push({ userId, conversationId, review }); },
    });

    listener?.({
      run_id: 'run-card-ok', user_id: 'card-user', conversation_id: 'cid-card-ok', status: 'completed',
      started_at_ms: Date.parse('2026-09-25T00:00:00.000Z'), finished_at_ms: Date.parse('2026-09-25T00:01:00.000Z'),
    });
    await waitFor(() => published.length > 0);

    // 一次收口 → 恰好一张卡，且卡片带的是落盘后的 review（reviewId/episodeId 一致）。
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ userId: 'card-user', conversationId: 'cid-card-ok' });
    expect(published[0].review).toMatchObject({ id: 'ksr-kse-run-card-ok', episodeId: 'kse-run-card-ok' });
    const stored = await reviews.readKstarReview('card-user', 'kse-run-card-ok');
    expect(stored).toMatchObject({ id: published[0].review.id, needsConfirmation: true, reviewStatus: 'pending' });
    stop();
  });

  it('does not post a second card for a repeated terminal event or a replayed review', async () => {
    const closure = await import(TASK_CLOSURE);
    let listener: ((event: any) => void) | undefined;
    const history: any[] = [{ id: 'msg-replay', ts: '2026-09-25T00:00:01.000Z', from: 'user', text: 'Produce the report.' }];
    const published: any[] = [];
    const review = {
      id: 'ksr-kse-run-replay', episodeId: 'kse-run-replay', needsConfirmation: true,
      expectedResult: 'Produce the report.', actualResult: 'The report was produced.',
    };
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [...history],
      capture: async () => ({ review } as any),
      publishReviewCard: async (userId, conversationId, next) => {
        published.push({ userId, conversationId, review: next });
        // 卡片落盘后即可在会话历史里读到（供重放时按 reviewId 查重）。
        history.push({
          id: `msg-card-${next.id}`, ts: '2026-09-25T00:00:02.000Z', from: 'commander', text: 'review card',
          kstar_review_card: { kind: 'kstar_review_card', episodeId: next.episodeId, reviewId: next.id },
        });
      },
    });

    const event = {
      run_id: 'run-replay', user_id: 'card-user', conversation_id: 'cid-replay', status: 'completed',
      started_at_ms: 0, finished_at_ms: 1,
    };
    listener?.(event);
    listener?.(event);
    await waitFor(() => published.length > 0);
    expect(published).toHaveLength(1);

    // 重放：同一条 review 换个 run 身份再来一次（历史里已有同 reviewId 的卡）。
    listener?.({ ...event, run_id: 'run-replay-again' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(published).toHaveLength(1);
    stop();
  });

  it('does not post when the conversation history already carries the card (restart replay)', async () => {
    const closure = await import(TASK_CLOSURE);
    let listener: ((event: any) => void) | undefined;
    const published: any[] = [];
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [
        { id: 'msg-before', ts: '2026-09-25T00:00:01.000Z', from: 'user', text: 'Produce the report.' },
        {
          id: 'msg-card-before', ts: '2026-09-25T00:00:02.000Z', from: 'commander', text: 'review card',
          kstar_review_card: { kind: 'kstar_review_card', episodeId: 'kse-run-restart', reviewId: 'ksr-kse-run-restart' },
        },
      ],
      capture: async () => ({
        review: {
          id: 'ksr-kse-run-restart', episodeId: 'kse-run-restart', needsConfirmation: true,
          expectedResult: 'Produce the report.', actualResult: 'The report was produced.',
        },
      } as any),
      publishReviewCard: async (userId, conversationId, review) => { published.push({ userId, conversationId, review }); },
    });
    // 重启后重放：进程内占位已清空，去重只能靠消息里已有的同 reviewId 卡片。
    listener?.({
      run_id: 'run-restart', user_id: 'card-user', conversation_id: 'cid-restart', status: 'completed',
      started_at_ms: 0, finished_at_ms: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(published).toEqual([]);
    stop();
  });

  it('delivers the card through the real bus with forceTo:[user] (default publisher)', async () => {
    const closure = await import(TASK_CLOSURE);
    const groupChat = await import('../../../../src/main/features/group_chat');
    let listener: ((event: any) => void) | undefined;
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-bus', ts: '2026-09-25T00:00:01.000Z', from: 'user', text: 'Produce the report.' }],
      // 不注入 publisher → 走默认实现（bus.enqueue 是唯一派发路径）。
      capture: async () => ({
        review: {
          id: 'ksr-kse-run-bus', episodeId: 'kse-run-bus', needsConfirmation: true,
          expectedResult: 'Produce the report.', actualResult: 'The report was produced.',
          inferenceMethod: 'deterministic',
        },
      } as any),
    });
    listener?.({
      run_id: 'run-bus', user_id: 'card-user', conversation_id: 'cid-bus', status: 'completed',
      started_at_ms: 0, finished_at_ms: 1,
    });
    let cardMessage: any;
    const deadline = Date.now() + 3_000;
    while (!cardMessage && Date.now() < deadline) {
      cardMessage = (await groupChat.readMessages('card-user', 'cid-bus', 50))
        .find((message: any) => message.kstar_review_card?.reviewId === 'ksr-kse-run-bus');
      if (!cardMessage) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(cardMessage).toBeTruthy();
    expect(cardMessage.to).toEqual(['user']);
    expect(cardMessage.from).toBe('commander');
    expect(cardMessage.kstar_review_card).toMatchObject({
      kind: 'kstar_review_card',
      episodeId: 'kse-run-bus',
      reviewId: 'ksr-kse-run-bus',
      expectedSource: 'inferred',
    });
    stop();
  });

  it('does not post for waiting_input (non-terminal closures)', async () => {
    const closure = await import(TASK_CLOSURE);
    let listener: ((event: any) => void) | undefined;
    const published: any[] = [];
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-wait', ts: '2026-09-25T00:00:01.000Z', from: 'user', text: 'Hello.' }],
      capture: async () => ({
        review: {
          id: 'ksr-kse-run-wait', episodeId: 'kse-run-wait', needsConfirmation: true,
          expectedResult: 'Hello.', actualResult: 'Terminal status: waiting_input.',
        },
      } as any),
      publishReviewCard: async (userId, conversationId, review) => { published.push({ userId, conversationId, review }); },
    });
    listener?.({
      run_id: 'run-wait', user_id: 'card-user', conversation_id: 'cid-wait', status: 'waiting_input',
      started_at_ms: 0, finished_at_ms: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(published).toEqual([]);
    stop();
  });

  it('does not post when the review does not need confirmation', async () => {
    const closure = await import(TASK_CLOSURE);
    let listener: ((event: any) => void) | undefined;
    const published: any[] = [];
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-quiet', ts: '2026-09-25T00:00:01.000Z', from: 'user', text: 'Produce the report.' }],
      capture: (input) => closure.captureGroupKstarClosure({ ...input, inferReview: inferenceNotNeedingConfirmation }),
      publishReviewCard: async (userId, conversationId, review) => { published.push({ userId, conversationId, review }); },
    });
    listener?.({
      run_id: 'run-quiet', user_id: 'card-user', conversation_id: 'cid-quiet', status: 'completed',
      started_at_ms: 0, finished_at_ms: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(published).toEqual([]);
    stop();
  });

  it('records a control_receipt failure and leaves closure/review state untouched when publishing fails', async () => {
    const closure = await import(TASK_CLOSURE);
    const failures = await import('../../../../src/main/features/kstar/failure-service');
    const reviews = await import('../../../../src/main/features/kstar/review-service');
    const episodes = await import('../../../../src/main/features/kstar/episode-store');
    let listener: ((event: any) => void) | undefined;
    let publishAttempts = 0;
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-fail', ts: '2026-09-25T00:00:01.000Z', from: 'user', text: 'Produce the report.' }],
      capture: (input) => closure.captureGroupKstarClosure({ ...input, inferReview: needsConfirmationInference }),
      publishReviewCard: async () => { publishAttempts += 1; throw new Error('conversation runtime is terminating'); },
    });

    const event = {
      run_id: 'run-card-fail', user_id: 'card-user', conversation_id: 'cid-card-fail', status: 'completed',
      started_at_ms: 0, finished_at_ms: 1,
    };
    listener?.(event);
    await waitFor(() => publishAttempts > 0);
    const recorded = await waitForFailures(failures, 'card-user');

    // 收口仍然成功：episode + review 都落盘，状态不变（仍是待确认，没有被卡住/改写）。
    await expect(episodes.readKstarEpisode('card-user', 'kse-run-card-fail')).resolves.toMatchObject({
      id: 'kse-run-card-fail', r: { status: 'completed' },
    });
    const review = await reviews.readKstarReview('card-user', 'kse-run-card-fail');
    expect(review).toMatchObject({ needsConfirmation: true, reviewStatus: 'pending', reviewState: 'needs_confirmation' });
    // 发卡路径没有改写 review（落盘时间戳保持首次写入值）。
    expect(review!.updatedAt).toBe(review!.createdAt);
    // 失败面可查：stage='control_receipt'，带会话与 episode 标识（无受限正文）。
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      stage: 'control_receipt',
      errorCode: 'review_card_publish_failed',
      conversationId: 'cid-card-fail',
      episodeId: 'kse-run-card-fail',
    });
    expect(recorded[0].operationKey).toBe('review-card-ksr-kse-run-card-fail');

    // 重复终态不产生重试风暴：再送一次同一事件，发卡只尝试过一次，失败记录仍只有一条。
    listener?.(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(publishAttempts).toBe(1);
    expect(await failures.listKstarFailures('card-user')).toHaveLength(1);
    stop();
  });
});

async function waitForFailures(
  failures: { listKstarFailures: (userId: string) => Promise<any[]> },
  userId: string,
): Promise<any[]> {
  const deadline = Date.now() + 3_000;
  let rows: any[] = [];
  while (Date.now() < deadline) {
    rows = await failures.listKstarFailures(userId);
    if (rows.length) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return rows;
}
