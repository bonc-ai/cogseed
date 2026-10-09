import type { AssetUsageReceipt } from '../recall/asset-usage-receipt';
import type { InjectionReceipt } from '../recall/injection-receipt';

export function usageMatchesInjection(
  usage: AssetUsageReceipt,
  injection: InjectionReceipt,
): boolean {
  return usage.injectionReceiptId === injection.id
    && usage.taskRunId === injection.taskRunId
    && usage.projectionId === injection.projectionId
    && usage.assetId === injection.assetId
    && usage.assetVersion === injection.assetVersion
    && usage.boundary === injection.boundary;
}
