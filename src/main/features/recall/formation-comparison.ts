/** Optional source-bound comparison evidence. It is a review explanation, never
 * a save grant; current sources, target versions and approvals remain authoritative. */
import type { CaptureExistingAsset, CaptureExistingAssetsResult } from './capture-existing-assets';
import { z } from 'zod';
export const formationComparisonSchema = z.object({
  relation: z.enum(['new', 'duplicate', 'evidence', 'exception', 'correction', 'changed', 'ambiguous']),
  reason: z.string().trim().min(1).max(2000),
  targetAssetId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(160).optional(),
  targetVersion: z.string().regex(/^\d{1,9}$/).optional(),
  targetQuote: z.string().min(1).max(1000).optional(),
  /** Model excerpts are validated at formation and removed before persistence. */
  relatedAssets: z.array(z.object({ assetId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(160),
    version: z.string().regex(/^\d{1,9}$/), quote: z.string().min(1).max(1000).optional() }).strict()).min(1).max(100).optional(),
}).strict();
export type FormationComparison = z.infer<typeof formationComparisonSchema> & { coverage?: CaptureExistingAssetsResult['coverage'] };
export function validateFormationComparison(raw: unknown, assets: CaptureExistingAsset[], coverage: CaptureExistingAssetsResult['coverage'],
  options: { allowReferenceOnly?: boolean } = {}): FormationComparison {
  // A JSON null in an optional field is absence, never a version or quote.
  // Required fields and present non-null values remain strict.
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw as Record<string, unknown> } : raw;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const key of ['targetAssetId', 'targetVersion', 'targetQuote', 'relatedAssets']) if (source[key] === null) delete source[key];
  }
  const row = formationComparisonSchema.parse(source);
  if (row.relatedAssets) {
    if (new Set(row.relatedAssets.map(item => item.assetId)).size !== row.relatedAssets.length) throw new Error('duplicate related target');
    for (const item of row.relatedAssets) {
      const asset = assets.find(asset => asset.id === item.assetId && asset.version === item.version);
      if (!asset || (!item.quote && !options.allowReferenceOnly)
        || (item.quote !== undefined && (!item.quote.trim() || !asset.statement.includes(item.quote)))) throw new Error('related target evidence unavailable');
    }
  }
  // A singleton adds no information only when it is the exact same target.
  // A lone related reference is not enough to infer or choose a target.
  if (row.relatedAssets?.length === 1) {
    const item = row.relatedAssets[0];
    if (!row.targetAssetId || item.assetId !== row.targetAssetId || item.version !== row.targetVersion
      || !row.targetQuote || (item.quote !== row.targetQuote && !(options.allowReferenceOnly && item.quote === undefined)))
      throw new Error('single related asset does not match target');
    delete row.relatedAssets;
  }
  if (row.relation === 'new') {
    if (row.targetAssetId || row.targetVersion || row.targetQuote || row.relatedAssets || coverage.truncated || coverage.unavailable) throw new Error('new identity comparison incomplete');
  } else if (row.relation !== 'ambiguous' || row.targetAssetId || row.targetVersion || row.targetQuote) {
    const target = assets.find(asset => asset.id === row.targetAssetId && asset.version === row.targetVersion);
    if (!target || !row.targetQuote?.trim() || !target.statement.includes(row.targetQuote)) throw new Error('comparison target evidence unavailable');
  }
  return { ...row, coverage };
}
