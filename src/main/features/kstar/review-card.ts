import { t } from '../../i18n';
import type { KstarReviewRecord } from './types';

export interface KstarReviewCard {
  kind: 'kstar_review_card';
  episodeId: string;
  reviewId: string;
  expectedResult?: string;
  actualResult?: string;
}

export interface KstarReviewCardPort {
  send(input: { userId: string; cid: string; text: string; kstar_review_card: KstarReviewCard }): Promise<{ id: string }>;
}

function bounded(value: string | undefined, max: number): string {
  return String(value || '').replace(/\0/g, '').trim().slice(0, max);
}

export function buildKstarReviewCard(review: KstarReviewRecord): KstarReviewCard {
  return {
    kind: 'kstar_review_card',
    episodeId: review.episodeId,
    reviewId: review.id,
    ...(review.expectedResult ? { expectedResult: bounded(review.expectedResult, 1_000) } : {}),
    ...(review.actualResult ? { actualResult: bounded(review.actualResult, 1_000) } : {}),
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
