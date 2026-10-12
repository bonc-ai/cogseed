import { t } from '../../i18n';
import type { KstarReviewInferenceMethod, KstarReviewRecord } from './types';

/** 预期来源三档（contracts/renderer-seams.md §一）：`user`=用户确实给过；
 *  `inferred`=系统按任务目标推断；`none`=这次没有可核对的预期。
 *  渲染层据此分档措辞——不给「预期」标来源就等于把系统推断说成用户预测。 */
export type KstarReviewCardExpectedSource = 'user' | 'inferred' | 'none';

export interface KstarReviewCard {
  kind: 'kstar_review_card';
  episodeId: string;
  reviewId: string;
  expectedResult?: string;
  actualResult?: string;
  /** 始终下发（含 `none`），渲染层不需要猜「字段缺失」的含义。 */
  expectedSource: KstarReviewCardExpectedSource;
}

/** 用户确实给过预期的推理来源：'user' 是用户确认/自述；'commander' 是旧
 *  Commander review 回合在对话里确立的预期（存量数据）。其余（deterministic /
 *  model / unknown / 缺失）都是系统按任务目标推断的。 */
const USER_SUPPLIED_EXPECTATION_METHODS: ReadonlySet<KstarReviewInferenceMethod> = new Set(['user', 'commander']);

const MAX_CARD_TEXT = 1_000;

export interface KstarReviewCardPort {
  send(input: { userId: string; cid: string; text: string; kstar_review_card: KstarReviewCard }): Promise<{ id: string }>;
}

function bounded(value: string | undefined, max: number): string {
  return String(value || '').replace(/\0/g, '').trim().slice(0, max);
}

/** 三档推导：没有可下发的预期正文 → `none`；有预期且来源是用户 → `user`；
 *  其余有预期的情形一律 `inferred`（宁可说清是系统推断，也不冒认用户预测）。 */
export function deriveExpectedSource(
  review: Pick<KstarReviewRecord, 'expectedResult'> & { inferenceMethod?: KstarReviewInferenceMethod },
): KstarReviewCardExpectedSource {
  if (!bounded(review.expectedResult, MAX_CARD_TEXT)) return 'none';
  return review.inferenceMethod && USER_SUPPLIED_EXPECTATION_METHODS.has(review.inferenceMethod)
    ? 'user'
    : 'inferred';
}

export function buildKstarReviewCard(review: KstarReviewRecord): KstarReviewCard {
  const expectedResult = bounded(review.expectedResult, MAX_CARD_TEXT);
  return {
    kind: 'kstar_review_card',
    episodeId: review.episodeId,
    reviewId: review.id,
    // `none` 档省 expectedResult 字段（不伪造一个"预期"），expectedSource 照带。
    ...(expectedResult ? { expectedResult } : {}),
    ...(review.actualResult ? { actualResult: bounded(review.actualResult, MAX_CARD_TEXT) } : {}),
    expectedSource: deriveExpectedSource(review),
  };
}

export function reviewCardText(review: KstarReviewRecord): string {
  const expected = bounded(review.expectedResult, 600);
  const actual = bounded(review.actualResult, 600);
  return [
    t('kstar.review.confirm_prompt'),
    expected ? `${t('kstar.review.expected')}: ${expected}` : '',
    actual ? `${t('kstar.review.actual')}: ${actual}` : '',
  ].filter(Boolean).join('\n');
}

export async function postKstarReviewCard(
  userId: string,
  cid: string,
  review: KstarReviewRecord,
  port: KstarReviewCardPort,
): Promise<{ ok: true; msg: { id: string }; card: KstarReviewCard }> {
  const card = buildKstarReviewCard(review);
  const msg = await port.send({ userId, cid, text: reviewCardText(review), kstar_review_card: card });
  return { ok: true, msg, card };
}
