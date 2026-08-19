import { afterEach, describe, expect, it } from 'vitest';

import { getCurrentLang, setCurrentLang } from '../../../../src/main/i18n';
import { reviewCardText } from '../../../../src/main/features/kstar/review-card';
import type { KstarReviewRecord } from '../../../../src/main/features/kstar/types';

const previousLang = getCurrentLang();

afterEach(() => {
  setCurrentLang(previousLang);
});

function review(overrides: Partial<KstarReviewRecord> = {}): KstarReviewRecord {
  return {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: 'ksr-a',
    episodeId: 'kse-a',
    expectedResult: '完成用户请求。',
    actualResult: '已经完成并通过验证。',
    deltaR: 'unknown',
    deltaA: 'unknown',
    outcome: 'unclear',
    attribution: 'unclear',
    reason: 'Needs confirmation.',
    confidence: 0,
    needsConfirmation: true,
    evidenceRefs: [],
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('KSTAR review card text', () => {
  it('renders user-facing localized labels instead of raw i18n keys', () => {
    setCurrentLang('zh');

    const text = reviewCardText(review());

    expect(text).toContain('请确认');
    expect(text).toContain('预期结果: 完成用户请求。');
    expect(text).toContain('实际结果: 已经完成并通过验证。');
    expect(text).not.toContain('kstar.review.');
  });
});
