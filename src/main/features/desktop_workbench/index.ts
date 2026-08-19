import * as personalContext from '../personal_context/application';
import { listTouchpointIntents } from '../touchpoints/ledger';
import { buildDesktopWorkbenchProjection } from './dashboard';
import type { DesktopWorkbenchProjection } from './types';

export async function getDesktopWorkbenchProjection(userId: string): Promise<DesktopWorkbenchProjection> {
  const [dashboard, review] = await Promise.all([
    personalContext.getDashboard(userId),
    personalContext.listReviewItems(userId),
  ]);
  const intents = await listTouchpointIntents(userId);
  return buildDesktopWorkbenchProjection(userId, {
    dashboard,
    reviewItems: review.items,
    intents,
    generatedAt: new Date().toISOString(),
  });
}
