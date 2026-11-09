/** Host-owned proofs for user-chosen old-content actions. No model call:
 * a merge is only offered when the chosen target provably contains every
 * source statement and shares the same boundary and conditions. */
export interface OldContentBoundaryAsset {
  type: string;
  scope?: unknown;
  scopePolicy?: unknown;
}

export interface OldContentCoverageAsset extends OldContentBoundaryAsset {
  statement: string;
  applicableWhen?: string[];
  forbiddenWhen?: string[];
}

const sortValues = (values: readonly string[] | undefined) => [...(values || [])].sort();

export function oldContentBoundaryKey(asset: OldContentBoundaryAsset): string {
  const raw = asset.scopePolicy && typeof asset.scopePolicy === 'object'
    ? asset.scopePolicy as Record<string, unknown> : {};
  const policy = Object.fromEntries(Object.entries(raw).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, Array.isArray(values) ? sortValues(values.map(String)) : []]));
  return JSON.stringify({ type: asset.type, scope: asset.scope, policy });
}

export function sameOldContentBoundary(left: OldContentBoundaryAsset, right: OldContentBoundaryAsset): boolean {
  return oldContentBoundaryKey(left) === oldContentBoundaryKey(right);
}

/** Case/width/whitespace/punctuation do not carry meaning for coverage checks. */
export function normalizeOldContentText(value: string): string {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？；、,.;!?"'“”‘’（）()【】\[\]《》<>—\-…:：]/g, '');
}

function conditionKey(values: readonly string[] | undefined): string {
  return [...new Set((values || []).map(normalizeOldContentText).filter(Boolean))].sort().join('|');
}

function statementsCoveredBy(target: string, source: string): boolean {
  const targetText = normalizeOldContentText(target);
  const sentences = String(source || '').normalize('NFKC').toLowerCase()
    .split(/[。！？；!?;\n]+/).map(normalizeOldContentText).filter(Boolean);
  return sentences.length > 0 && sentences.every(sentence => targetText.includes(sentence));
}

export type OldContentCoverageFailure = 'merge_body_not_contained' | 'merge_condition_mismatch';
export interface OldContentCoverageResult {
  ok: boolean;
  code?: OldContentCoverageFailure;
}

/** `merge_coverage` with an unchanged target body is the only merge the host
 * can prove without asking a model to synthesize new text. */
export function oldContentCoverageProof(
  target: OldContentCoverageAsset,
  sources: readonly OldContentCoverageAsset[],
): OldContentCoverageResult {
  if (!normalizeOldContentText(target.statement) || !sources.length
    || sources.some(source => !statementsCoveredBy(target.statement, source.statement)))
    return { ok: false, code: 'merge_body_not_contained' };
  const applicable = conditionKey(target.applicableWhen);
  const forbidden = conditionKey(target.forbiddenWhen);
  if (sources.some(source => conditionKey(source.applicableWhen) !== applicable
    || conditionKey(source.forbiddenWhen) !== forbidden))
    return { ok: false, code: 'merge_condition_mismatch' };
  return { ok: true };
}
