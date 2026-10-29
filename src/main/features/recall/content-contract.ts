/**
 * Recall persisted-content contract.
 *
 * The 4000-character statement bound is the product contract stated in
 * `src/main/prompts/recall_candidate_contract.md`. It is a storage/transport
 * limit, not the advisory 200-character policy in `statement-policy.ts`:
 * policy issues are read-time warnings; this contract decides what can be
 * persisted and must stay identical at every write boundary.
 *
 * Other 4000-character numbers in recall (capture context excerpts, world-model
 * summaries, experience bodies) are independent input/storage budgets and are
 * intentionally not folded into this persisted cognition-asset contract.
 */
export const RECALL_TEXT_LIMITS = Object.freeze({
  statement: 4_000,
  value: 4_000,
  evidenceSummary: 4_000,
  summary: 1_000,
  uncertainty: 1_000,
  scope: 500,
} as const);

export type RecallContentField = keyof typeof RECALL_TEXT_LIMITS;

export class ContentContractError extends Error {
  readonly code = 'recall_content_contract';
  constructor(
    readonly field: RecallContentField,
    readonly limit: number,
    readonly actual: number,
    message: string,
  ) {
    super(message);
    this.name = 'ContentContractError';
  }
}

/** Body text keeps paragraph layout; only line endings and outer whitespace are normalized. */
export function normalizeStatementText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

/** Future-use text keeps prose layout, matching the existing asset value field. */
export function normalizeValueText(value: string): string {
  return value.trim();
}

/** Metadata fields collapse all whitespace into single spaces. */
export function normalizeSingleLineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeContentText(value: string, field: RecallContentField): string {
  if (field === 'statement') return normalizeStatementText(value);
  if (field === 'value') return normalizeValueText(value);
  return normalizeSingleLineText(value);
}

export function contentTextLength(value: string, field: RecallContentField): number {
  return normalizeContentText(value, field).length;
}

export function contentExceedsContract(value: string, field: RecallContentField): boolean {
  return contentTextLength(value, field) > RECALL_TEXT_LIMITS[field];
}

/** Returns the normalized text or throws with field/limit/actual for the caller to map. */
export function assertContentWithinContract(
  value: unknown,
  field: RecallContentField,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new ContentContractError(field, RECALL_TEXT_LIMITS[field], 0, `${field} is required`);
  }
  const text = normalizeContentText(value, field);
  if (!text && !options.allowEmpty) {
    throw new ContentContractError(field, RECALL_TEXT_LIMITS[field], 0, `${field} is empty`);
  }
  if (text.length > RECALL_TEXT_LIMITS[field]) {
    throw new ContentContractError(field, RECALL_TEXT_LIMITS[field], text.length, `${field} is too long`);
  }
  return text;
}
