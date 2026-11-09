/** Independent old-content plan records. The plan document is the single
 * editable source; candidates reference it by id and receive a read projection. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RECALL_TEXT_LIMITS } from './content-contract';
import type { FormationOldContentPlan, FormationOldContentPlanItem, FormationOldContentReasonCode } from './formation-old-content';

const text = (limit: number) => z.string().trim().min(1).max(limit);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const version = z.string().regex(/^\d{1,9}$/);
const reasonCode = z.enum([
  'merge_coverage', 'merge_complementary',
  'keep_incompatible', 'keep_independent', 'keep_user_choice',
  'archive_obsolete', 'archive_duplicate', 'archive_referenced',
  'delete_unsuitable',
]);
const mergedSchema = z.object({
  statement: text(RECALL_TEXT_LIMITS.statement),
  applicableWhen: z.array(text(500)).max(32).optional(),
  forbiddenWhen: z.array(text(500)).max(32).optional(),
  evidenceAssetIds: z.array(id).min(1).max(6),
  bodySource: z.enum(['model', 'user']),
}).strict();
const itemSchema = z.object({
  itemId: id,
  modelAction: z.enum(['merge', 'keep', 'archive', 'delete']),
  action: z.enum(['merge', 'keep', 'archive', 'delete']),
  state: z.enum(['included', 'excluded']),
  reasonCode,
  reason: text(2_000),
  assetIds: z.array(id).min(1).max(6),
  targetAssetId: id.optional(),
  expectedVersions: z.record(id, version),
  merged: mergedSchema.optional(),
}).strict();
const unresolvedResolutionSchema = z.union([
  z.literal('keep'),
  z.object({ kind: z.literal('merge'), targetAssetId: id }).strict(),
  z.object({ kind: z.literal('archive') }).strict(),
]);
const unresolvedSchema = z.object({
  itemId: id.optional(),
  reasonCode: z.enum(['needs_user_arbitration', 'evidence_insufficient']),
  reason: text(2_000),
  assetIds: z.array(id).min(1).max(6),
  baselineVersions: z.record(id, version),
  resolution: unresolvedResolutionSchema.optional(),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export const oldContentPlanItemSchema = itemSchema;
export const oldContentUnresolvedSchema = unresolvedSchema;

export type OldContentPlanStatus = 'needs_review' | 'ready' | 'blocked' | 'executing'
  | 'applied' | 'undone' | 'dismissed' | 'superseded' | 'purged';
export type OldContentEffectiveAction = 'merge' | 'keep' | 'archive' | 'delete';
export interface OldContentPlanItem {
  itemId: string;
  modelAction: OldContentEffectiveAction;
  action: OldContentEffectiveAction;
  state: 'included' | 'excluded';
  reasonCode: FormationOldContentReasonCode | 'keep_user_choice';
  reason: string;
  assetIds: string[];
  targetAssetId?: string;
  expectedVersions: Record<string, string>;
  merged?: {
    statement: string;
    applicableWhen?: string[];
    forbiddenWhen?: string[];
    evidenceAssetIds: string[];
    bodySource: 'model' | 'user';
  };
}
export type OldContentUnresolvedResolution =
  | 'keep'
  | { kind: 'merge'; targetAssetId: string }
  | { kind: 'archive' };
export interface OldContentUnresolvedItem {
  /** Stable identity; derived on read for legacy records. */
  itemId?: string;
  reasonCode: 'needs_user_arbitration' | 'evidence_insufficient';
  reason: string;
  assetIds: string[];
  baselineVersions: Record<string, string>;
  resolution?: OldContentUnresolvedResolution;
  resolvedAt?: string;
}
export interface OldContentExecutionItem {
  itemId: string;
  action: OldContentEffectiveAction;
  status: 'applied' | 'kept';
  assetIds: string[];
  targetAssetId?: string;
  targetVersion?: string;
  archivedIds?: string[];
  deletedIds?: string[];
}
export interface OldContentAssetFingerprint {
  version: string;
  activeVersion: string;
  status: string;
  digest: string;
}
export interface OldContentExecutionSnapshot {
  before: Record<string, OldContentAssetFingerprint>;
  after: Record<string, OldContentAssetFingerprint>;
  referencedBy: Record<string, string[]>;
}
export interface OldContentExecution {
  executionId: string;
  candidateId?: string;
  revision: number;
  digest: string;
  decisionId: string;
  committedAt: string;
  items: OldContentExecutionItem[];
  snapshot?: OldContentExecutionSnapshot;
  undoneAt?: string;
  undoDecisionId?: string;
  audit?: { state: 'complete' | 'pending' | 'drifted'; attempts: number };
}
export interface OldContentPreparedExecution {
  executionId: string;
  digest: string;
  decisionId: string;
  candidateId?: string;
  before: Record<string, { version: string; activeVersion: string; status: string; digest: string }>;
  after: Record<string, { version: string; activeVersion: string; status: string; digest: string }>;
  receiptItems: OldContentExecutionItem[];
  anchorId?: string;
  preparedAt: string;
}
export interface OldContentFinalization {
  candidateId: string;
  phase: 'idle' | 'old_committed' | 'new_saved' | 'old_failed' | 'new_failed' | 'abandoned';
  updatedAt: string;
  executionId?: string;
  newDecisionId?: string;
  errorCode?: string;
}
export interface OldContentPlanRecord {
  schemaVersion: 2;
  ownerId: string;
  id: string;
  groupKey: string;
  revision: number;
  assetIds: string[];
  baselineVersions: Record<string, string>;
  status: OldContentPlanStatus;
  origin: 'formation' | 'migration' | 'manual';
  digest: string;
  items: OldContentPlanItem[];
  unresolved: OldContentUnresolvedItem[];
  executions: OldContentExecution[];
  prepared?: OldContentPreparedExecution;
  finalizations: OldContentFinalization[];
  history: Array<{ revision: number; digest: string; status: OldContentPlanStatus; at: string; sourceCandidateId?: string }>;
  candidateIds?: string[];
  createdAt: string;
  updatedAt: string;
  contentPurgedAt?: string;
  contentAssetIds?: string[];
  blockedReason?: string;
}

const executionSchema = z.object({
  executionId: z.string().regex(/^oce-[a-f0-9]{32}$/),
  candidateId: id.optional(),
  revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decisionId: z.string().regex(/^rd_[A-Za-z0-9_-]{8,64}$/),
  committedAt: z.string().datetime({ offset: true }),
  items: z.array(z.object({
    itemId: id, action: z.enum(['merge', 'keep', 'archive', 'delete']),
    status: z.enum(['applied', 'kept']), assetIds: z.array(id).min(1).max(6),
    targetAssetId: id.optional(), targetVersion: version.optional(),
    archivedIds: z.array(id).max(6).optional(), deletedIds: z.array(id).max(6).optional(),
  }).strict()).min(1).max(16),
  snapshot: z.object({
    before: z.record(id, z.object({ version, activeVersion: version, status: z.string().max(40),
      digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
    after: z.record(id, z.object({ version, activeVersion: version, status: z.string().max(40),
      digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
    referencedBy: z.record(id, z.array(z.string().max(200)).max(200)),
  }).strict().optional(),
  undoneAt: z.string().datetime({ offset: true }).optional(),
  undoDecisionId: z.string().regex(/^rd_[A-Za-z0-9_-]{8,64}$/).optional(),
  audit: z.object({ state: z.enum(['complete', 'pending', 'drifted']), attempts: z.number().int().nonnegative() }).strict().optional(),
}).strict();
const preparedSchema = z.object({
  executionId: z.string().regex(/^oce-[a-f0-9]{32}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decisionId: z.string().regex(/^rd_[A-Za-z0-9_-]{8,64}$/),
  candidateId: id.optional(),
  before: z.record(id, z.object({ version, activeVersion: version, status: z.string().max(40), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  after: z.record(id, z.object({ version, activeVersion: version, status: z.string().max(40), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  receiptItems: z.array(z.object({
    itemId: id, action: z.enum(['merge', 'keep', 'archive', 'delete']),
    status: z.enum(['applied', 'kept']), assetIds: z.array(id).min(1).max(6),
    targetAssetId: id.optional(), targetVersion: version.optional(),
    archivedIds: z.array(id).max(6).optional(), deletedIds: z.array(id).max(6).optional(),
  }).strict()).min(1).max(16),
  anchorId: id.optional(),
  preparedAt: z.string().datetime({ offset: true }),
}).strict();
export const oldContentPlanSchema = z.object({
  schemaVersion: z.literal(2),
  ownerId: id,
  id: z.string().regex(/^ocp-[a-f0-9]{24}$/),
  groupKey: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive(),
  assetIds: z.array(id).min(2).max(6),
  baselineVersions: z.record(id, version),
  status: z.enum(['needs_review', 'ready', 'blocked', 'executing', 'applied', 'undone', 'dismissed', 'superseded', 'purged']),
  origin: z.enum(['formation', 'migration', 'manual']),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(itemSchema).max(16),
  unresolved: z.array(unresolvedSchema).max(16),
  executions: z.array(executionSchema).max(32),
  prepared: preparedSchema.optional(),
  finalizations: z.array(z.object({
    candidateId: id,
    phase: z.enum(['idle', 'old_committed', 'new_saved', 'old_failed', 'new_failed', 'abandoned']),
    updatedAt: z.string().datetime({ offset: true }),
    executionId: z.string().regex(/^oce-[a-f0-9]{32}$/).optional(),
    newDecisionId: z.string().regex(/^rd_[A-Za-z0-9_-]{8,64}$/).optional(),
    errorCode: z.string().max(160).optional(),
  }).strict()).max(32),
  history: z.array(z.object({ revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['needs_review', 'ready', 'blocked', 'executing', 'applied', 'undone', 'dismissed', 'superseded', 'purged']),
    at: z.string().datetime({ offset: true }), sourceCandidateId: id.optional() }).strict()).max(100),
  candidateIds: z.array(id).max(50).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  contentPurgedAt: z.string().datetime({ offset: true }).optional(),
  contentAssetIds: z.array(id).max(6).optional(),
  blockedReason: z.string().max(160).optional(),
}).strict() as z.ZodType<OldContentPlanRecord>;

export type OldContentPlanOp =
  | { op: 'keep_item'; itemId: string }
  | { op: 'include_item'; itemId: string }
  | { op: 'keep_unresolved' }
  | { op: 'resolve_unresolved'; itemId: string; resolution: OldContentUnresolvedResolution }
  | { op: 'edit_merge_body'; itemId: string; statement: string; applicableWhen?: string[]; forbiddenWhen?: string[] }
  | { op: 'set_merge_target'; itemId: string; targetAssetId: string }
  | { op: 'dismiss' };
export const oldContentPlanOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('keep_item'), itemId: id }).strict(),
  z.object({ op: z.literal('include_item'), itemId: id }).strict(),
  z.object({ op: z.literal('keep_unresolved') }).strict(),
  z.object({ op: z.literal('resolve_unresolved'), itemId: id, resolution: unresolvedResolutionSchema }).strict(),
  z.object({ op: z.literal('edit_merge_body'), itemId: id, statement: text(RECALL_TEXT_LIMITS.statement),
    applicableWhen: z.array(text(500)).max(32).optional(), forbiddenWhen: z.array(text(500)).max(32).optional() }).strict(),
  z.object({ op: z.literal('set_merge_target'), itemId: id, targetAssetId: id }).strict(),
  z.object({ op: z.literal('dismiss') }).strict(),
]);

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sortedAssets(assetIds: readonly string[]): string[] {
  return [...new Set(assetIds)].sort();
}
export function oldContentGroupKey(assetIds: readonly string[], baselineVersions: Record<string, string>): string {
  return hash(sortedAssets(assetIds).map(assetId => [assetId, baselineVersions[assetId] || '']));
}
export function oldContentPlanId(assetIds: readonly string[], baselineVersions: Record<string, string>): string {
  return `ocp-${oldContentGroupKey(assetIds, baselineVersions).slice(0, 24)}`;
}
export function oldContentPlanDigest(plan: Pick<OldContentPlanRecord,
  'assetIds' | 'baselineVersions' | 'items' | 'unresolved'>): string {
  return hash({
    assetIds: sortedAssets(plan.assetIds),
    baselineVersions: Object.fromEntries(Object.entries(plan.baselineVersions).sort(([a], [b]) => a.localeCompare(b))),
    items: plan.items.map(item => ({ itemId: item.itemId, modelAction: item.modelAction, action: item.action,
      state: item.state, reasonCode: item.reasonCode, reason: item.reason, assetIds: sortedAssets(item.assetIds),
      targetAssetId: item.targetAssetId, expectedVersions: item.expectedVersions, merged: item.merged })),
    unresolved: plan.unresolved.map(item => ({ reasonCode: item.reasonCode, assetIds: sortedAssets(item.assetIds),
      baselineVersions: item.baselineVersions, resolution: item.resolution })),
  });
}
export function effectiveOldContentAction(item: OldContentPlanItem): OldContentEffectiveAction {
  return item.state === 'excluded' ? 'keep' : item.action;
}
export function oldContentUnresolvedItemId(
  item: Pick<OldContentUnresolvedItem, 'reasonCode' | 'assetIds' | 'baselineVersions'>,
): string {
  return `unresolved-${hash({
    reasonCode: item.reasonCode,
    assetIds: sortedAssets(item.assetIds),
    baselineVersions: Object.fromEntries(Object.entries(item.baselineVersions).sort(([a], [b]) => a.localeCompare(b))),
  }).slice(0, 12)}`;
}
/** Legacy plans predate unresolved item ids; fill them without changing the digest. */
export function normalizeOldContentPlan(plan: OldContentPlanRecord): OldContentPlanRecord {
  if (plan.unresolved.every(item => item.itemId)) return plan;
  return { ...plan, unresolved: plan.unresolved.map(item =>
    item.itemId ? item : { ...item, itemId: oldContentUnresolvedItemId(item) }) };
}
function hasOpenUnresolved(plan: Pick<OldContentPlanRecord, 'unresolved'>): boolean {
  return plan.unresolved.some(item => !item.resolution);
}
function assertCoverage(plan: OldContentPlanRecord): void {
  const claimed = new Set<string>();
  for (const assetId of [...plan.items.flatMap(item => item.assetIds), ...plan.unresolved.flatMap(item => item.assetIds)]) {
    if (claimed.has(assetId)) throw new Error('old-content plan claims an asset twice');
    claimed.add(assetId);
  }
  if (plan.assetIds.some(assetId => !claimed.has(assetId))) throw new Error('old-content plan does not cover every asset');
}
function withHistory(plan: OldContentPlanRecord, now: string, sourceCandidateId?: string): OldContentPlanRecord {
  return { ...plan, digest: oldContentPlanDigest(plan), updatedAt: now,
    history: [...plan.history, { revision: plan.revision, digest: oldContentPlanDigest(plan), status: plan.status, at: now,
      ...(sourceCandidateId ? { sourceCandidateId } : {}) }].slice(-100) };
}

export function planFromFormation(plan: FormationOldContentPlan, input: {
  ownerId: string; candidateId?: string; now?: string;
}): OldContentPlanRecord {
  const now = input.now || new Date().toISOString();
  const items: OldContentPlanItem[] = plan.items.map(item => ({
    itemId: item.itemId,
    modelAction: item.action,
    action: item.action,
    state: 'included',
    reasonCode: item.reasonCode,
    reason: item.reason,
    assetIds: [...item.assetIds],
    ...(item.targetAssetId ? { targetAssetId: item.targetAssetId } : {}),
    expectedVersions: { ...item.expectedVersions },
    ...(item.merged ? { merged: { ...item.merged, bodySource: 'model' as const } } : {}),
  }));
  const unresolved: OldContentUnresolvedItem[] = plan.unresolved.map(item => ({
    itemId: oldContentUnresolvedItemId(item),
    reasonCode: item.reasonCode, reason: item.reason, assetIds: [...item.assetIds],
    baselineVersions: { ...item.baselineVersions },
  }));
  const status: OldContentPlanStatus = plan.status === 'ready' ? 'ready'
    : plan.status === 'needs_review' ? 'needs_review' : 'blocked';
  const base: OldContentPlanRecord = {
    schemaVersion: 2,
    ownerId: input.ownerId,
    id: oldContentPlanId(plan.assetIds, plan.baselineVersions),
    groupKey: oldContentGroupKey(plan.assetIds, plan.baselineVersions),
    revision: 1,
    assetIds: [...plan.assetIds],
    baselineVersions: { ...plan.baselineVersions },
    status,
    origin: 'formation',
    digest: '',
    items,
    unresolved,
    executions: [],
    finalizations: [],
    history: [],
    ...(input.candidateId ? { candidateIds: [input.candidateId] } : {}),
    createdAt: now,
    updatedAt: now,
  };
  assertCoverage(base);
  return withHistory({ ...base, digest: oldContentPlanDigest(base) }, now, input.candidateId);
}

export function applyOldContentPlanOps(plan: OldContentPlanRecord, ops: readonly OldContentPlanOp[]): OldContentPlanRecord {
  if (['executing', 'applied', 'purged', 'superseded'].includes(plan.status) || plan.contentPurgedAt)
    throw new Error('old-content plan is not editable');
  if (!ops.length) return plan;
  const now = new Date().toISOString();
  let next: OldContentPlanRecord = structuredClone(plan);
  for (const op of ops) {
    if (op.op === 'dismiss') {
      next.status = 'dismissed';
      continue;
    }
    if (op.op === 'keep_unresolved') {
      next.unresolved = next.unresolved.map(item => item.resolution ? item : { ...item, resolution: 'keep' as const, resolvedAt: now });
      continue;
    }
    if (op.op === 'resolve_unresolved') {
      const index = next.unresolved.findIndex(item => item.itemId === op.itemId);
      if (index < 0) throw new Error('unknown old-content unresolved item');
      const unresolved = next.unresolved[index];
      if (op.resolution === 'keep') {
        next.unresolved[index] = { ...unresolved, resolution: 'keep', resolvedAt: now };
        continue;
      }
      if (op.resolution.kind === 'archive') {
        if (unresolved.assetIds.length !== 1) throw new Error('archive resolution requires a single asset');
        next.unresolved[index] = { ...unresolved, resolution: op.resolution, resolvedAt: now };
        continue;
      }
      if (!unresolved.assetIds.includes(op.resolution.targetAssetId))
        throw new Error('merge target must belong to the unresolved group');
      next.unresolved[index] = { ...unresolved, resolution: op.resolution, resolvedAt: now };
      continue;
    }
    const index = next.items.findIndex(item => item.itemId === op.itemId);
    if (index < 0) throw new Error('unknown old-content item');
    const item = next.items[index];
    if (op.op === 'keep_item') next.items[index] = { ...item, state: 'excluded' };
    else if (op.op === 'include_item') next.items[index] = { ...item, state: 'included' };
    else if (op.op === 'edit_merge_body') {
      if (item.action !== 'merge' || !item.merged) throw new Error('only merge items have a merged body');
      const semantics = {
        statement: op.statement.trim(),
        ...(op.applicableWhen ? { applicableWhen: op.applicableWhen } : {}),
        ...(op.forbiddenWhen ? { forbiddenWhen: op.forbiddenWhen } : {}),
      };
      if (!semantics.statement || semantics.statement.length > RECALL_TEXT_LIMITS.statement)
        throw new Error('invalid merged body');
      next.items[index] = { ...item, merged: { ...item.merged, ...semantics, bodySource: 'user' } };
    } else if (op.op === 'set_merge_target') {
      if (item.action !== 'merge' || !item.assetIds.includes(op.targetAssetId))
        throw new Error('merge target must belong to its item');
      next.items[index] = { ...item, targetAssetId: op.targetAssetId };
    }
  }
  next.status = next.status === 'dismissed' ? 'dismissed'
    : hasOpenUnresolved(next) ? 'needs_review' : 'ready';
  next.revision = plan.revision + 1;
  assertCoverage(next);
  return withHistory({ ...next, digest: oldContentPlanDigest(next) }, now);
}
