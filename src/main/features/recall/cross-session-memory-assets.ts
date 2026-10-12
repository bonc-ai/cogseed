/**
 * Cross-session memory operations backed by the unified personal-asset pool.
 *
 * USER/MEMORY were merged into cognition assets (spec 003). These helpers make
 * the legacy cross_session_memory tool operate on that same source of truth,
 * while the caller can still fall back to an unmigrated legacy record when no
 * formal personal asset matches the requested text.
 */

import { createLogger } from '../../logger';
import { scanForInjection, type MemoryOpResult } from '../memory';
import { logErrorRef, maskId } from '../../util/log-redact';
import { safeId } from '../../storage';
import {
  deleteAbilityAsset,
  listAbilityAssets,
  updateAbilityAsset,
} from './asset-service';
import type { RecallAbilityAssetRecord } from './candidate-service';
import {
  filterRecallAssetsForAgentRead,
  type RecallAgentReadContext,
} from './prompt-injection';
import { isAssetScopeAllowed, type RecallAbilityAssetScopePolicy } from './scope-policy';
import { recallTitleIssue } from './title-policy';

const log = createLogger('recall.cross-session-memory-assets');
const LIST_MAX = 30;
const LIST_STATEMENT_MAX = 1_000;
const MEMORY_TEXT_MAX = 4_000;
const MEMORY_OWNER_SCOPE_DIMENSIONS: readonly (keyof RecallAbilityAssetScopePolicy)[] = [
  'agentIds',
  'roleIds',
  'projectIds',
  'workspaceIds',
];

export type CrossSessionMemoryAssetAction =
  | { handled: false }
  | { handled: true; result: MemoryOpResult };

export type CrossSessionMemoryAssetContext = RecallAgentReadContext;
export type CrossSessionMemoryTarget =
  | { kind: 'global' }
  | { kind: 'agent'; id: string }
  | { kind: 'space'; id: string };

function result(
  ok: boolean,
  entries: string[] = [],
  error?: string,
): MemoryOpResult {
  return {
    ok,
    ...(error ? { error } : {}),
    entries,
    // This unified asset list is not governed by the legacy memory file's
    // character budget, so 0/0 means "not applicable" like other tool receipts.
    usage: { current: 0, limit: 0 },
  };
}

function memoryAssets(assets: RecallAbilityAssetRecord[]): RecallAbilityAssetRecord[] {
  return assets
    .filter((asset) => asset.type === 'personal' && asset.status !== 'purged')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Keep the compatibility memory tiers isolated from assets with a different
 * owner boundary. A shared record must not be edited through one Agent or one
 * Space because the change would affect its other permitted destinations. */
function belongsToMemoryTarget(asset: RecallAbilityAssetRecord, target: CrossSessionMemoryTarget): boolean {
  const policy = asset.scopePolicy || {};
  if (target.kind === 'global') {
    return MEMORY_OWNER_SCOPE_DIMENSIONS.every((dimension) => policy[dimension] === undefined);
  }
  if (target.kind === 'agent') {
    return policy.agentIds?.length === 1
      && policy.agentIds[0] === target.id
      && policy.workspaceIds === undefined;
  }
  return policy.workspaceIds?.length === 1
    && policy.workspaceIds[0] === target.id
    && policy.agentIds === undefined;
}

function belongsToAuthorizedMemoryTarget(
  asset: RecallAbilityAssetRecord,
  context: CrossSessionMemoryAssetContext,
  target: CrossSessionMemoryTarget,
): boolean {
  // First require the legacy tier's owner boundary, then honor every additional
  // asset scope dimension against the live context. This permits correction of
  // a project/purpose-limited memory from inside that scope while failing closed
  // when the same text belongs to a different or currently unauthorized scope.
  if (!belongsToMemoryTarget(asset, target)) return false;
  const scopeContext = {
    ...context,
    purpose: context.purpose || context.taskText,
  };
  return isAssetScopeAllowed(asset.scopePolicy, scopeContext);
}

function memoryTargetForContext(
  context: CrossSessionMemoryAssetContext,
  target?: CrossSessionMemoryTarget,
): CrossSessionMemoryTarget {
  if (target) return target;
  // The compatibility entry point historically accepted only the caller's
  // runtime context. Preserve that API shape while binding scoped records to
  // the one unambiguous owner boundary; mixed context stays global/fail-closed.
  if (context.agentId && !context.workspaceId) return { kind: 'agent', id: context.agentId };
  if (context.workspaceId && !context.agentId) return { kind: 'space', id: context.workspaceId };
  return { kind: 'global' };
}

function matchLine(asset: RecallAbilityAssetRecord): string {
  const prefix = `[asset:${asset.id}] status=${asset.status}; title=${asset.title || '(untitled)'}`;
  if (asset.status !== 'active') return `${prefix}; body omitted because this asset is not active.`;
  const statement = String(asset.statement || '');
  return `${prefix}; statement=${statement.slice(0, LIST_STATEMENT_MAX)}${statement.length > LIST_STATEMENT_MAX ? '…' : ''}`;
}

/** List formal personal memories. Legacy file entries are added by the runner. */
export async function listCrossSessionMemoryAssets(
  userId: string,
  context: CrossSessionMemoryAssetContext = {},
  target?: CrossSessionMemoryTarget,
): Promise<MemoryOpResult> {
  if (!safeId(userId)) return result(false, [], 'Invalid user.');
  try {
    const effectiveTarget = memoryTargetForContext(context, target);
    const candidates = memoryAssets(await listAbilityAssets(userId)).filter((asset) => belongsToMemoryTarget(asset, effectiveTarget));
    const assets = await filterRecallAssetsForAgentRead(userId, candidates, context);
    const entries = assets.slice(0, LIST_MAX).map(matchLine);
    if (assets.length > LIST_MAX) {
      entries.push(`${assets.length - LIST_MAX} more personal assets are available through list_ability_assets.`);
    }
    return result(true, entries);
  } catch (error) {
    log.warn('personal memory asset list failed', { userId: maskId(userId), error: logErrorRef(error as Error) });
    return result(false, [], 'The cognition asset store could not be read. This inventory may be incomplete.');
  }
}

async function matchingPersonalAssets(
  userId: string,
  oldText: string,
  context: CrossSessionMemoryAssetContext = {},
  target?: CrossSessionMemoryTarget,
): Promise<
  | { ok: true; assets: RecallAbilityAssetRecord[]; unavailableMatch: boolean }
  | { ok: false; error: string }
> {
  try {
    const effectiveTarget = memoryTargetForContext(context, target);
    const candidates = memoryAssets(await listAbilityAssets(userId));
    const textMatches = candidates.filter((asset) => String(asset.statement || '').includes(oldText));
    const assets = textMatches.filter((asset) => belongsToAuthorizedMemoryTarget(asset, context, effectiveTarget));
    // This is a correction/removal lookup after the runner has required an
    // explicit current user command. Runtime-use eligibility (active status,
    // maturity, and source availability) must not make an
    // owner's paused asset impossible to correct or remove. Keep the declared
    // memory-tier boundary: if the same text also exists outside this target,
    // block instead of falling through to a legacy write against the wrong item.
    const unavailableMatch = textMatches.some((asset) => !belongsToAuthorizedMemoryTarget(asset, context, effectiveTarget));
    return { ok: true, assets, unavailableMatch };
  } catch (error) {
    log.warn('personal memory asset lookup failed', { userId: maskId(userId), error: logErrorRef(error as Error) });
    return { ok: false, error: 'The cognition asset store could not be read. No legacy data was changed.' };
  }
}

function actionForTextLookup(
  lookup: Awaited<ReturnType<typeof matchingPersonalAssets>>,
): CrossSessionMemoryAssetAction | { asset: RecallAbilityAssetRecord } {
  if (lookup.ok === false) return { handled: true, result: result(false, [], lookup.error) };
  if (lookup.unavailableMatch) {
    return {
      handled: true,
      result: result(false, [], 'A matching personal cognition asset belongs to a different memory scope. Review the item in My Cognition before changing it.'),
    };
  }
  if (!lookup.assets.length) return { handled: false };
  if (lookup.assets.length === 1) return { asset: lookup.assets[0] };
  return {
    handled: true,
    result: result(false, lookup.assets.map((asset) => `[asset:${asset.id}] ${asset.title || '(untitled)'}`),
      'This text matches multiple personal assets. Use list_ability_assets and choose one asset by id before changing it.'),
  };
}

/** Replace one uniquely matched personal asset, preserving its source and version history. */
export async function replaceCrossSessionMemoryAsset(
  userId: string,
  oldText: string,
  content: string,
  context: CrossSessionMemoryAssetContext = {},
  target?: CrossSessionMemoryTarget,
): Promise<CrossSessionMemoryAssetAction> {
  if (!safeId(userId)) return { handled: true, result: result(false, [], 'Invalid user.') };
  const needle = String(oldText || '').trim();
  if (!needle) return { handled: true, result: result(false, [], 'old_text is required.') };
  const lookup = await matchingPersonalAssets(userId, needle, context, target);
  const match = actionForTextLookup(lookup);
  if ('handled' in match) return match;

  const text = String(content || '').trim();
  if (!text) return { handled: true, result: result(false, [], 'Replacement content is empty.') };
  if (text.length > MEMORY_TEXT_MAX) {
    return { handled: true, result: result(false, [], `Replacement content exceeds ${MEMORY_TEXT_MAX} characters.`) };
  }
  const threat = scanForInjection(text);
  if (threat) return { handled: true, result: result(false, [], `Replacement blocked by the memory safety check (${threat}).`) };
  if (match.asset.status === 'deleted' || match.asset.status === 'revoked') {
    return { handled: true, result: result(false, [], `[asset:${match.asset.id}] is ${match.asset.status} and cannot be edited.`) };
  }

  try {
    // 标题一等化（设计 3.2 六路径配套 / 深探 F1）：禁止 makeDisplayTitle 直写
    // title（那正是「标题＝正文首句」的病源）。改为沿用旧标题——旧标题对新
    // 正文仍合规就不动 title（update 不传即保留）；旧标题缺失或不合规时走
    // LLM 起标题链，起不出来按明示失败口径落入 catch，本次修正不落盘。
    const legacyTitle = String(match.asset.title || '');
    const titleInput = recallTitleIssue(legacyTitle, text)
      ? { title: (await (await import('./asset-title-suggestion')).suggestAbilityAssetTitle(userId, { statement: text, type: match.asset.type })).title }
      : {};
    const updated = await updateAbilityAsset(userId, match.asset.id, {
      ...titleInput,
      statement: text,
      expectedVersion: match.asset.version,
      reason: 'User-requested cross-session memory correction.',
      actor: 'user',
    });
    return {
      handled: true,
      result: result(true, [`Updated [asset:${updated.id}] to version ${updated.version}. Exact wording: ${JSON.stringify(text)}. Source evidence was retained; status remains ${updated.status}.`]),
    };
  } catch (error) {
    log.warn('personal memory asset replacement failed', { userId: maskId(userId), assetId: match.asset.id, error: logErrorRef(error as Error) });
    const message = error instanceof Error && error.message.includes('version conflict')
      ? 'This asset changed after it was read. Read it again and confirm the requested edit before retrying.'
      : 'The personal cognition asset could not be updated. The legacy record was not changed.';
    return { handled: true, result: result(false, [], message) };
  }
}

/** Delete one uniquely matched personal asset through its reversible retention state. */
export async function removeCrossSessionMemoryAsset(
  userId: string,
  oldText: string,
  context: CrossSessionMemoryAssetContext = {},
  target?: CrossSessionMemoryTarget,
): Promise<CrossSessionMemoryAssetAction> {
  if (!safeId(userId)) return { handled: true, result: result(false, [], 'Invalid user.') };
  const needle = String(oldText || '').trim();
  if (!needle) return { handled: true, result: result(false, [], 'old_text is required.') };
  const lookup = await matchingPersonalAssets(userId, needle, context, target);
  const match = actionForTextLookup(lookup);
  if ('handled' in match) return match;
  if (match.asset.status === 'revoked') {
    return { handled: true, result: result(false, [], `[asset:${match.asset.id}] is revoked and cannot be deleted through this action.`) };
  }

  try {
    const deleted = await deleteAbilityAsset(userId, match.asset.id, {
      reason: 'User-requested cross-session memory removal.',
      actor: 'user',
      expectedVersion: match.asset.version,
    });
    return {
      handled: true,
      result: result(true, [`Deleted [asset:${deleted.id}]. Its content is unavailable for use and can be restored during the 30-day retention period.`]),
    };
  } catch (error) {
    log.warn('personal memory asset removal failed', { userId: maskId(userId), assetId: match.asset.id, error: logErrorRef(error as Error) });
    const message = error instanceof Error && error.message.includes('version conflict')
      ? 'This asset changed after it was read. Read it again and confirm the requested removal before retrying.'
      : 'The personal cognition asset could not be deleted. The legacy record was not changed.';
    return { handled: true, result: result(false, [], message) };
  }
}
