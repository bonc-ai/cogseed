import { listCognitionAssets } from './assets-adapter';
import { listCognitionCandidates } from './candidates-adapter';
import { listCognitionReuseReceipts } from './receipts-adapter';
import type { CognitionDashboard } from './types';

export async function buildCognitionDashboard(userId: string): Promise<CognitionDashboard> {
  const [assetsSettled, candidatesSettled, receiptsSettled] = await Promise.allSettled([
    listCognitionAssets(userId),
    listCognitionCandidates(userId, { status: 'pending', limit: 10 }),
    listCognitionReuseReceipts(userId, { limit: 10 }),
  ] as const);
  const assets = assetsSettled.status === 'fulfilled' ? assetsSettled.value : [];
  const candidates = candidatesSettled.status === 'fulfilled' ? candidatesSettled.value : [];
  const receipts = receiptsSettled.status === 'fulfilled' ? receiptsSettled.value : [];
  const warnings = [
    { code: 'receipt_degraded', count: receipts.filter((item) => item.status === 'degraded').length },
    { code: 'receipt_rejected', count: receipts.filter((item) => item.status === 'rejected').length },
    { code: 'receipt_prepared', count: receipts.filter((item) => item.status === 'prepared').length },
  ].filter((item) => item.count > 0);
  return {
    counts: {
      skills: assets.filter((item) => item.category === 'skill_method').length,
      pendingCandidates: candidates.length,
      receipts: receipts.length,
      assets: assets.length,
    },
    pendingCandidates: candidates,
    recentReceipts: receipts,
    warnings,
    degraded: assetsSettled.status === 'rejected' || candidatesSettled.status === 'rejected' || receiptsSettled.status === 'rejected',
  };
}
