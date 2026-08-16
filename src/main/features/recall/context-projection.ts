import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { genId12, safeId } from '../../storage';
import { createLogger } from '../../logger';
import { listAbilityAssets, readAbilityAsset } from './asset-service';
import { recallJsonRecordPath } from './paths';
import { listWorkspaceAssetReferences } from './workspace-refs';
import { isAssetScopeAllowed, matchesScopeToken, scopeIncludes } from './scope-policy';
import { loadOntologyGroupTitleMap } from './ontology-taxonomy';
import { readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { AgentWakeRequest, WakeApproval } from '../p3394/types';
import { approveWakeRequest, getWakeRequest } from '../p3394/wake-service';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from './source-service';
import { isCognitionSourceEnabled } from './source-control';
import {
  evaluateAssetRuntimeEligibility,
  type AssetRuntimeBlockReason,
} from './formal-assets/runtime';

/** Runtime 阻断原因 → 投影里对用户可见的省略原因。 */
const RUNTIME_OMISSION_REASON: Partial<Record<AssetRuntimeBlockReason, OmittedAssetRef['reason']>> = {
  status_not_active: 'asset_paused',
  maturity_below_default_use: 'maturity_requires_user_selection',
  not_applicable_context: 'not_applicable_context',
  forbidden_context: 'forbidden_context',
  target_agent_not_allowed: 'target_agent_not_allowed',
  sensitivity_above_destination: 'sensitivity_blocked',
  sensitivity_unclassified: 'sensitivity_blocked',
  scope_mismatch: 'scope_mismatch',
  source_unavailable: 'source_unavailable',
};

const log = createLogger('recall.context-projection');
let lastProjectionCreatedAtMs = 0;

export type ProjectionAuthorization = 'user_confirmed' | 'workspace_policy' | 'not_required';
export type ContextProjectionStatus = 'preview' | 'confirmed' | 'deferred' | 'rejected' | 'expired' | 'revoked';

export type ProjectionKnowledgeErrorCode =
  | 'projection_not_committed'
  | 'projection_expired'
  | 'projection_versions_missing'
  | 'projection_asset_missing'
  | 'projection_asset_inactive'
  | 'projection_asset_version_changed'
  | 'projection_asset_ineligible'
  | 'projection_source_unavailable';

const PROJECTION_KNOWLEDGE_ERROR_MESSAGES: Record<ProjectionKnowledgeErrorCode, string> = {
  projection_not_committed: 'projection is not committed',
  projection_expired: 'projection has expired',
  projection_versions_missing: 'projection asset versions are missing',
  projection_asset_missing: 'projection asset is missing',
  projection_asset_inactive: 'projection asset is no longer active',
  projection_asset_version_changed: 'projection asset version changed',
  projection_asset_ineligible: 'projection asset is no longer eligible',
  projection_source_unavailable: 'projection source is unavailable',
};

export function projectionKnowledgeError(code: ProjectionKnowledgeErrorCode): Error & { code: ProjectionKnowledgeErrorCode } {
  return Object.assign(new Error(PROJECTION_KNOWLEDGE_ERROR_MESSAGES[code]), { code });
}

export interface OmittedAssetRef {
  assetId: string;
  reason: 'asset_paused' | 'asset_revoked' | 'workspace_not_referenced' | 'workspace_disabled' | 'scope_mismatch' | 'source_unavailable' | 'low_relevance' | 'maturity_requires_user_selection' | 'not_applicable_context' | 'forbidden_context' | 'target_agent_not_allowed' | 'sensitivity_blocked';
}

export type RecallAssetMatchMethod = 'semantic' | 'recency_fallback' | 'manual';

export interface RecallAssetMatch {
  assetId: string;
  matchScore: number;
  matchMethod: RecallAssetMatchMethod;
}

export interface ContextProjectionRecord extends RecallJsonRecord {
  taskRunId: string;
  workspaceId?: string;
  purpose: string;
  authorization: ProjectionAuthorization;
  assetIds: string[];
  assetVersions?: Record<string, string>;
  assetMatches?: RecallAssetMatch[];
  sourceRefs: CognitionSourceRef[];
  omittedRefs: OmittedAssetRef[];
  expiresAt?: string;
  /** True when the selection fell back to recency order (embedding failure). */
  selectionDegraded?: boolean;
  status: ContextProjectionStatus;
  createdAt: string;
  confirmedAt?: string;
  decidedAt?: string;
  decisionNote?: string;
}

export function isCommittedProjection(projection: ContextProjectionRecord): boolean {
  return projection.status === 'confirmed';
}

export interface ProjectionInput {
  taskRunId: string;
  workspaceId?: string;
  purpose: string;
  taskText?: string;
  authorization?: ProjectionAuthorization;
  expiresAt?: string;
  /** Auto-confirm on creation (workspace_policy line): the projection is
   *  written as confirmed immediately, skipping the user confirmation card. */
  confirm?: boolean;
}


export interface ProjectionSemanticOptions {
  embedTexts?: (texts: string[]) => Promise<number[][]>;
  /** Absolute hard floor (noise gate); default DEFAULT_MIN_MATCH_SCORE. */
  minScore?: number;
  /** Relative gate: fraction of the batch's best score; default
   *  DEFAULT_RELATIVE_SIGNIFICANCE. */
  relativeSignificance?: number;
  limit?: number;
}

export interface AutomaticProjectionInput {
  taskRunId: string;
  taskText: string;
  workspaceId?: string;
}

export interface BuildRecallViewResult {
  assetIds: string[];
  assetVersions?: Record<string, string>;
  assetMatches?: RecallAssetMatch[];
  sourceRefs: CognitionSourceRef[];
  omittedRefs: OmittedAssetRef[];
  /** Semantic embedding was unavailable; selection degraded to recency order. */
  degraded?: boolean;
}

export interface ProjectionRevisionInput {
  purpose?: string;
  addAssetIds?: string[];
  removeAssetIds?: string[];
  decisionNote?: string;
}

export interface AvailableProjectionAssetSummary {
  id: string;
  title: string;
  type: RecallAbilityAssetRecord['type'];
  status: RecallAbilityAssetRecord['status'];
  maturity: RecallAbilityAssetRecord['maturity'];
  scope: string;
  version: string;
}

export interface ListContextProjectionsQuery {
  workspaceId?: string;
  status?: ContextProjectionStatus;
  includeExpired?: boolean;
  limit?: number;
}

export type ConfirmAndApproveWakeResult =
  | { ok: true; status: 'approved'; projection: ContextProjectionRecord; request: AgentWakeRequest; approval: WakeApproval }
  | { ok: false; status: 'wake_unbound'; projection: ContextProjectionRecord; error: string };


function projectionNowIso(): string {
  const now = Date.now();
  lastProjectionCreatedAtMs = Math.max(now, lastProjectionCreatedAtMs + 1);
  return new Date(lastProjectionCreatedAtMs).toISOString();
}

function projectionsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'projections', 'placeholder'));
}

function normalizeTerm(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string') throw new Error(`invalid projection ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new Error(`invalid projection ${field}`);
  return text;
}

function normalizeOptionalTerm(value: unknown, field: string, max = 2_000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`invalid projection ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length > max) throw new Error(`invalid projection ${field}`);
  return text;
}

function validateAssetMatches(value: unknown): RecallAssetMatch[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('malformed context projection matches');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('malformed context projection matches');
    const match = raw as Record<string, unknown>;
    if (typeof match.assetId !== 'string' || !safeId(match.assetId)) throw new Error('malformed context projection matches');
    if (typeof match.matchScore !== 'number' || !Number.isFinite(match.matchScore) || match.matchScore < 0 || match.matchScore > 1) throw new Error('malformed context projection matches');
    if (match.matchMethod !== 'semantic' && match.matchMethod !== 'recency_fallback' && match.matchMethod !== 'manual') throw new Error('malformed context projection matches');
    return { assetId: match.assetId, matchScore: match.matchScore, matchMethod: match.matchMethod } as RecallAssetMatch;
  });
}

function validateAssetVersions(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed context projection asset versions');
  const out: Record<string, string> = {};
  for (const [assetId, version] of Object.entries(value as Record<string, unknown>)) {
    if (!safeId(assetId) || typeof version !== 'string' || !version.trim()) throw new Error('malformed context projection asset versions');
    out[assetId] = version;
  }
  return out;
}

function validateProjectionStatus(value: unknown): ContextProjectionStatus {
  if (value === 'preview' || value === 'confirmed' || value === 'deferred' || value === 'rejected' || value === 'expired' || value === 'revoked') {
    return value;
  }
  throw new Error('malformed context projection: invalid status');
}

function assetMatchText(asset: RecallAbilityAssetRecord, groupTitles: Map<string, string>): string {
  // T-Box vocabulary: resolve each referenced ontology group to its CONCEPT
  // title so the match text carries the concept name, not an opaque id.
  // Only the asset's own refs are rendered — a shared full-group vocabulary
  // would inflate baseline similarity for every asset of the same group (M2).
  const ontology = (asset.ontologyRefs || []).map((ref) => [
    groupTitles.get(ref.groupId) || ref.groupId,
    ref.section,
    ref.field,
  ].filter(Boolean).join(' / ')).filter(Boolean).join('\n');
  // type/scope are shared dimension labels, not content: including them
  // inflated baseline similarity for every asset of the same type (M2).
  return [
    asset.title,
    asset.statement.slice(0, 1_200),
    ontology,
  ].filter(Boolean).join('\n');
}

function cosineScore(left: number[], right: number[]): number {
  let dot = 0; let leftMag = 0; let rightMag = 0;
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const a = Number(left[i]) || 0;
    const b = Number(right[i]) || 0;
    dot += a * b;
    leftMag += a * a;
    rightMag += b * b;
  }
  if (!leftMag || !rightMag) return 0;
  const score = dot / (Math.sqrt(leftMag) * Math.sqrt(rightMag));
  return Math.max(0, Math.min(1, Number(score.toFixed(6))));
}

async function defaultEmbedTexts(texts: string[]): Promise<number[][]> {
  const embed = await import('../kb_embed');
  return embed.embedTexts(texts);
}

async function rankAssetsBySemanticMatch(
  userId: string,
  taskText: string,
  assets: RecallAbilityAssetRecord[],
  options: ProjectionSemanticOptions,
): Promise<{ assets: RecallAbilityAssetRecord[]; assetMatches: RecallAssetMatch[] }> {
  const embedTexts = options.embedTexts || defaultEmbedTexts;
  const groupTitles = loadOntologyGroupTitleMap(userId);
  const vectors = await embedTexts([taskText, ...assets.map((asset) => assetMatchText(asset, groupTitles))]);
  if (vectors.length !== assets.length + 1) throw new Error('semantic embedding count mismatch');
  const query = vectors[0];
  const scored = assets.map((asset, index) => ({
    asset,
    index,
    match: {
      assetId: asset.id,
      matchScore: cosineScore(query, vectors[index + 1]),
      matchMethod: 'semantic' as const,
    },
  }));
  scored.sort((left, right) => right.match.matchScore - left.match.matchScore || left.index - right.index);
  return { assets: scored.map((item) => item.asset), assetMatches: scored.map((item) => item.match) };
}

function automaticProjectionId(taskRunId: string, workspaceId?: string): string {
  const digest = createHash('sha256')
    .update(`${taskRunId}\n${workspaceId || ''}\nconversation_reply`)
    .digest('hex')
    .slice(0, 24);
  return `proj-auto-${digest}`;
}

async function hasEnabledAutomaticSources(userId: string, asset: RecallAbilityAssetRecord): Promise<boolean> {
  for (const source of asset.evidenceRefs) {
    if (source.taxonomyVersion !== 2) continue;
    if (!(await isCognitionSourceEnabled(userId, source))) return false;
  }
  return true;
}


function normalizeProjectionAssetIds(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`invalid projection ${field}`);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || !safeId(raw)) throw new Error(`invalid projection asset id in ${field}`);
    if (seen.has(raw)) continue;
    seen.add(raw);
    ids.push(raw);
  }
  return ids;
}

async function isAssetEligibleForProjection(userId: string, asset: RecallAbilityAssetRecord, projection: Pick<ContextProjectionRecord, 'workspaceId' | 'purpose'>): Promise<boolean> {
  if (asset.status !== 'active') throw new Error('context projection asset is not active');
  if (!isAssetScopeAllowed(asset.scopePolicy, {
    purpose: projection.purpose,
    workspaceId: projection.workspaceId,
  })) return false;
  if (projection.workspaceId) {
    const refs = await listWorkspaceAssetReferences(userId);
    const ref = refs.find((item) => item.assetId === asset.id && item.workspaceId === projection.workspaceId);
    if (!ref || !ref.enabled || !scopeIncludes(ref.scope, projection.purpose)) return false;
    return true;
  }
  return scopeIncludes(asset.scope, projection.purpose);
}

async function readEligibleProjectionAsset(userId: string, assetId: string, projection: ContextProjectionRecord): Promise<RecallAbilityAssetRecord> {
  const asset = await readAbilityAsset(userId, assetId);
  if (!(await isAssetEligibleForProjection(userId, asset, projection))) {
    throw new Error('context projection asset is not eligible for this task');
  }
  return asset;
}

function sourceRefsForAssets(assets: RecallAbilityAssetRecord[]): CognitionSourceRef[] {
  const sourceRefs: CognitionSourceRef[] = [];
  const seen = new Set<string>();
  for (const asset of assets) {
    for (const source of asset.evidenceRefs) {
      const key = `${source.kind}:${source.id}`;
      if (!seen.has(key)) { seen.add(key); sourceRefs.push(source); }
    }
  }
  return sourceRefs;
}

function asProjection(value: RecallJsonRecord): ContextProjectionRecord {
  if (!Array.isArray(value.assetIds) || !Array.isArray(value.sourceRefs) || !Array.isArray(value.omittedRefs) || typeof value.taskRunId !== 'string' || typeof value.purpose !== 'string' || typeof value.authorization !== 'string' || typeof value.createdAt !== 'string') throw new Error('malformed context projection');
  if (value.selectionDegraded !== undefined && typeof value.selectionDegraded !== 'boolean') throw new Error('malformed context projection');
  const assetMatches = validateAssetMatches(value.assetMatches);
  const assetVersions = validateAssetVersions(value.assetVersions);
  return { ...value, status: validateProjectionStatus(value.status), sourceRefs: normalizeCognitionSourceRefs(value.sourceRefs), ...(assetMatches ? { assetMatches } : {}), ...(assetVersions ? { assetVersions } : {}) } as ContextProjectionRecord;
}

/** Default semantic HARD FLOOR (dual-signal selection): scores below this
 *  are treated as embedding noise and never injected, even when Top-N slots
 *  remain. It is deliberately low — admission is primarily governed by the
 *  Top-N slots plus a relative-significance gate (see applySemanticSelection),
 *  not by this absolute cutoff. */
export const DEFAULT_MIN_MATCH_SCORE = 0.25;
/** Relative gate: an asset scoring below this fraction of the batch's best
 *  semantic score is dropped even inside Top-N, so a weak pool cannot force
 *  irrelevant assets into the injection just because slots remain. */
export const DEFAULT_RELATIVE_SIGNIFICANCE = 0.5;
/** Default Top-N selection size. */
export const DEFAULT_SELECTION_LIMIT = 8;

interface SemanticSelection {
  assets: RecallAbilityAssetRecord[];
  assetMatches?: RecallAssetMatch[];
  degraded: boolean;
}

/** Shared semantic selection: rank eligible assets against the query text,
 *  drop scores below the relevance threshold, cap to Top-N, and record
 *  low-relevance exclusions. Embedding failure degrades to recency order
 *  with an explicit flag instead of silently injecting everything. */
async function applySemanticSelection(
  userId: string,
  assets: RecallAbilityAssetRecord[],
  queryText: string,
  options: ProjectionSemanticOptions,
  omittedRefs: OmittedAssetRef[],
  skipOnDegrade = false,
): Promise<SemanticSelection> {
  const minScore = Number.isFinite(options.minScore)
    ? Math.max(0, Math.min(1, Number(options.minScore)))
    : DEFAULT_MIN_MATCH_SCORE;
  const relativeSignificance = Number.isFinite(options.relativeSignificance)
    ? Math.max(0, Math.min(1, Number(options.relativeSignificance)))
    : DEFAULT_RELATIVE_SIGNIFICANCE;
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(12, Math.floor(Number(options.limit))))
    : DEFAULT_SELECTION_LIMIT;
  if (!queryText || !queryText.trim() || !assets.length) return { assets: assets.slice(0, limit), degraded: false };

  let ranked: Awaited<ReturnType<typeof rankAssetsBySemanticMatch>>;
  let degraded = false;
  try {
    ranked = await rankAssetsBySemanticMatch(userId, queryText, assets, options);
  } catch (error) {
    log.warn('semantic recall ranking unavailable; using recency fallback', { userId, error: (error as Error).message });
    degraded = true;
    if (skipOnDegrade) return { assets: [], degraded: true };
    ranked = {
      assets,
      assetMatches: assets.map((asset) => ({ assetId: asset.id, matchScore: 0, matchMethod: 'recency_fallback' as const })),
    };
  }

  let orderedAssets = ranked.assets;
  let assetMatches = ranked.assetMatches;
  if (assetMatches) {
    const matchByAssetId = new Map(assetMatches.map((match) => [match.assetId, match]));
    const droppedByRelevance: string[] = [];
    // Dual-signal admission: an asset must clear BOTH the absolute hard floor
    // (noise gate) and the relative-significance gate (score >= best * ratio)
    // when the batch's best score is itself meaningful. A weak pool therefore
    // yields fewer assets instead of force-filling Top-N with irrelevant ones.
    const semanticMatches = assetMatches.filter((match) => match.matchMethod === 'semantic');
    const bestScore = semanticMatches.reduce((best, match) => Math.max(best, match.matchScore), 0);
    const relativeFloor = bestScore * relativeSignificance;
    orderedAssets = orderedAssets.filter((asset) => {
      const match = matchByAssetId.get(asset.id);
      if (!match || match.matchMethod !== 'semantic') return true;
      if (match.matchScore < minScore) {
        droppedByRelevance.push(asset.id);
        return false;
      }
      if (bestScore > minScore && match.matchScore < relativeFloor) {
        droppedByRelevance.push(asset.id);
        return false;
      }
      return true;
    });
    for (const assetId of droppedByRelevance) {
      omittedRefs.push({ assetId, reason: 'low_relevance' });
    }
    assetMatches = assetMatches.filter((match) => (
      match.matchMethod !== 'semantic' || orderedAssets.some((asset) => asset.id === match.assetId)
    ));
  }
  // M5 type diversity: guarantee one highest-scoring asset per type before
  // filling the remaining slots by score, so Top-N is not dominated by a
  // single asset type. Order stays score-descending within the same type.
  const diverse: RecallAbilityAssetRecord[] = [];
  const seenTypes = new Set<string>();
  for (const asset of orderedAssets) {
    if (seenTypes.has(asset.type)) continue;
    seenTypes.add(asset.type);
    diverse.push(asset);
    if (diverse.length >= limit) break;
  }
  if (diverse.length < limit) {
    const picked = new Set(diverse.map((asset) => asset.id));
    for (const asset of orderedAssets) {
      if (picked.has(asset.id)) continue;
      diverse.push(asset);
      if (diverse.length >= limit) break;
    }
  }
  if (diverse.length < orderedAssets.length) {
    const picked = new Set(diverse.map((asset) => asset.id));
    for (const asset of orderedAssets) {
      if (!picked.has(asset.id)) omittedRefs.push({ assetId: asset.id, reason: 'low_relevance' });
    }
  }
  orderedAssets = diverse;
  if (assetMatches) {
    const pickedIds = new Set(orderedAssets.map((asset) => asset.id));
    assetMatches = assetMatches.filter((match) => pickedIds.has(match.assetId));
  }
  return { assets: orderedAssets, ...(assetMatches ? { assetMatches } : {}), degraded };
}

export async function buildRecallView(userId: string, input: ProjectionInput, options: ProjectionSemanticOptions = {}): Promise<BuildRecallViewResult> {
  const purpose = normalizeTerm(input.purpose, 'purpose', 120);
  const taskText = normalizeOptionalTerm(input.taskText, 'task text');
  const assets = await listAbilityAssets(userId);
  const refs = input.workspaceId ? await listWorkspaceAssetReferences(userId) : [];
  const refsByAsset = new Map(refs.filter((ref) => !input.workspaceId || ref.workspaceId === input.workspaceId).map((ref) => [ref.assetId, ref]));
  const includedAssets: RecallAbilityAssetRecord[] = [];
  const omittedRefs: OmittedAssetRef[] = [];
  for (const asset of assets) {
    if (asset.status === 'paused') { omittedRefs.push({ assetId: asset.id, reason: 'asset_paused' }); continue; }
    if (asset.status === 'revoked') { omittedRefs.push({ assetId: asset.id, reason: 'asset_revoked' }); continue; }
    if (!isAssetScopeAllowed(asset.scopePolicy, { purpose, workspaceId: input.workspaceId })) {
      omittedRefs.push({ assetId: asset.id, reason: 'scope_mismatch' });
      continue;
    }
    const ref = input.workspaceId ? refsByAsset.get(asset.id) : undefined;
    if (input.workspaceId && !ref) { omittedRefs.push({ assetId: asset.id, reason: 'workspace_not_referenced' }); continue; }
    if (ref && !ref.enabled) { omittedRefs.push({ assetId: asset.id, reason: 'workspace_disabled' }); continue; }
    if (ref && !scopeIncludes(ref.scope, purpose)) { omittedRefs.push({ assetId: asset.id, reason: 'scope_mismatch' }); continue; }
    // Soft whole-word scope gate: a sentence-shaped purpose (e.g. "Use frozen
    // OAuth review knowledge") still matches a 'review' scope term, unlike the
    // old exact-equality gate which silently emptied the candidate pool.
    if (!ref && !scopeIncludes(asset.scope, purpose)) { omittedRefs.push({ assetId: asset.id, reason: 'scope_mismatch' }); continue; }
    includedAssets.push(asset);
  }

  // Ranking runs only on real task text: a short purpose label (e.g.
  // 'review') is not a meaningful query, and skipping the embed avoids
  // blocking calls when no task text exists.
  const selection = await applySemanticSelection(userId, includedAssets, taskText, options, omittedRefs);
  const orderedAssets = selection.assets;
  const assetMatches = selection.assetMatches;

  const sourceRefs: CognitionSourceRef[] = [];
  const seen = new Set<string>();
  for (const asset of orderedAssets) {
    for (const source of asset.evidenceRefs) {
      const key = `${source.kind}:${source.id}`;
      if (!seen.has(key)) { seen.add(key); sourceRefs.push(source); }
    }
  }
  return {
    assetIds: orderedAssets.map((asset) => asset.id),
    assetVersions: Object.fromEntries(orderedAssets.map((asset) => [asset.id, asset.version])),
    ...(assetMatches ? { assetMatches } : {}),
    sourceRefs,
    omittedRefs,
    ...(selection.degraded ? { degraded: true as const } : {}),
  };
}

export async function previewContextProjection(userId: string, input: ProjectionInput, options: ProjectionSemanticOptions = {}): Promise<ContextProjectionRecord> {
  const taskRunId = normalizeTerm(input.taskRunId, 'task run id', 160);
  const purpose = normalizeTerm(input.purpose, 'purpose', 120);
  const workspaceId = input.workspaceId === undefined ? undefined : normalizeTerm(input.workspaceId, 'workspace id', 160);
  const taskText = normalizeOptionalTerm(input.taskText, 'task text');
  const authorization: ProjectionAuthorization = input.authorization || 'user_confirmed';
  if (authorization !== 'user_confirmed' && authorization !== 'workspace_policy' && authorization !== 'not_required') throw new Error('invalid projection authorization');
  if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) throw new Error('invalid projection expiry');
  const view = await buildRecallView(userId, { taskRunId, purpose, ...(workspaceId ? { workspaceId } : {}), ...(taskText ? { taskText } : {}) }, options);
  const now = projectionNowIso();
  const confirmedAt = input.confirm ? now : undefined;
  const record: ContextProjectionRecord = {
    schemaVersion: 2, ownerId: userId, id: `proj-${genId12()}`,
    taskRunId, ...(workspaceId ? { workspaceId } : {}), purpose, authorization,
    assetIds: view.assetIds, ...(view.assetVersions ? { assetVersions: view.assetVersions } : {}), ...(view.assetMatches ? { assetMatches: view.assetMatches } : {}), sourceRefs: view.sourceRefs, omittedRefs: view.omittedRefs,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(view.degraded ? { selectionDegraded: true } : {}),
    status: confirmedAt ? 'confirmed' : 'preview',
    ...(confirmedAt ? { confirmedAt, decidedAt: confirmedAt } : {}),
    createdAt: now,
  };
  await writeRecallJsonRecord(userId, 'projections', record.id, record);
  return record;
}

export async function createAutomaticContextProjection(
  userId: string,
  input: AutomaticProjectionInput,
  options: ProjectionSemanticOptions = {},
): Promise<ContextProjectionRecord | undefined> {
  const taskRunId = normalizeTerm(input.taskRunId, 'task run id', 160);
  const taskText = normalizeTerm(input.taskText, 'task text', 2_000);
  const workspaceId = input.workspaceId === undefined
    ? undefined
    : normalizeTerm(input.workspaceId, 'workspace id', 160);
  const id = automaticProjectionId(taskRunId, workspaceId);
  const existing = await readRecallJsonRecord(userId, 'projections', id);
  if (existing) {
    const projection = asProjection(existing);
    if (projection.status === 'confirmed') return projection;
  }

  const allAssets = await listAbilityAssets(userId);
  const workspaceRefs = workspaceId ? await listWorkspaceAssetReferences(userId) : [];
  const workspaceRefsByAsset = new Map(
    workspaceRefs
      .filter((ref) => ref.workspaceId === workspaceId)
      .map((ref) => [ref.assetId, ref]),
  );
  const eligibleAssets: RecallAbilityAssetRecord[] = [];
  const omittedRefs: OmittedAssetRef[] = [];
  for (const asset of allAssets) {
    if (asset.status === 'paused') {
      omittedRefs.push({ assetId: asset.id, reason: 'asset_paused' });
      continue;
    }
    if (asset.status === 'revoked') {
      omittedRefs.push({ assetId: asset.id, reason: 'asset_revoked' });
      continue;
    }
    const workspaceRef = workspaceRefsByAsset.get(asset.id);
    if (workspaceRef && !workspaceRef.enabled) {
      omittedRefs.push({ assetId: asset.id, reason: 'workspace_disabled' });
      continue;
    }
    if (!(await hasEnabledAutomaticSources(userId, asset))) {
      omittedRefs.push({ assetId: asset.id, reason: 'source_unavailable' });
      continue;
    }
    // 统一 Runtime 闸门。这条自动投影是"静默默认注入"：它自己把 status 置成
    // confirmed、authorization 置成 not_required，不经用户挑选就进本轮提示词。
    // 所以按 PRD 3.6 只接纳已经证明过能被正确带入的资产——User Confirmed /
    // Unverified 仍然只能由用户主动带入（手动投影那条路不经过这里）。
    const runtime = evaluateAssetRuntimeEligibility({
      status: asset.status,
      maturity: asset.maturity,
      scope: asset.scope,
      ...(asset.crossScopeConfirmedAt ? { crossScopeConfirmedAt: asset.crossScopeConfirmedAt } : {}),
      ...(asset.applicableWhen ? { applicableWhen: asset.applicableWhen } : {}),
      ...(asset.forbiddenWhen ? { forbiddenWhen: asset.forbiddenWhen } : {}),
      ...(asset.sensitivity ? { sensitivity: asset.sensitivity } : {}),
    }, {
      silentDefaultInjection: true,
      ...(taskText ? { taskText } : {}),
    });
    if (!runtime.eligible) {
      omittedRefs.push({ assetId: asset.id, reason: RUNTIME_OMISSION_REASON[runtime.reasons[0]] || 'source_unavailable' });
      continue;
    }
    eligibleAssets.push(asset);
  }
  if (!eligibleAssets.length) return undefined;

  const selection = await applySemanticSelection(userId, eligibleAssets, taskText, options, [], true);
  const selectedAssets = selection.assets;
  if (!selectedAssets.length) return undefined;

  const now = projectionNowIso();
  const selectedIds = new Set(selectedAssets.map((asset) => asset.id));
  const record: ContextProjectionRecord = {
    schemaVersion: 2,
    ownerId: userId,
    id,
    taskRunId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(selection.degraded ? { selectionDegraded: true } : {}),
    purpose: 'conversation_reply',
    authorization: 'not_required',
    assetIds: selectedAssets.map((asset) => asset.id),
    assetVersions: Object.fromEntries(selectedAssets.map((asset) => [asset.id, asset.version])),
    ...(selection.assetMatches ? { assetMatches: selection.assetMatches.filter((match) => selectedIds.has(match.assetId)) } : {}),
    sourceRefs: sourceRefsForAssets(selectedAssets),
    omittedRefs,
    status: 'confirmed',
    createdAt: now,
    confirmedAt: now,
    decidedAt: now,
  };
  await writeRecallJsonRecord(userId, 'projections', record.id, record);
  return record;
}

async function validateFrozenProjectionAssets(
  userId: string,
  projection: ContextProjectionRecord,
  requireCommitted: boolean,
): Promise<Record<string, string>> {
  if (requireCommitted && !isCommittedProjection(projection)) {
    throw projectionKnowledgeError('projection_not_committed');
  }
  if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) {
    throw projectionKnowledgeError('projection_expired');
  }
  const expected = projection.assetVersions;
  if (!expected || Object.keys(expected).length !== projection.assetIds.length) {
    throw projectionKnowledgeError('projection_versions_missing');
  }
  const out: Record<string, string> = {};
  for (const assetId of projection.assetIds) {
    let asset: RecallAbilityAssetRecord;
    try {
      asset = await readAbilityAsset(userId, assetId);
    } catch {
      throw projectionKnowledgeError('projection_asset_missing');
    }
    if (asset.status !== 'active') throw projectionKnowledgeError('projection_asset_inactive');
    if (expected[assetId] !== asset.version) throw projectionKnowledgeError('projection_asset_version_changed');
    if (!(await isAssetEligibleForProjection(userId, asset, projection))) {
      throw projectionKnowledgeError('projection_asset_ineligible');
    }
    for (const source of asset.evidenceRefs) {
      if (source.taxonomyVersion !== 2) continue;
      if (!(await isCognitionSourceEnabled(userId, source))) {
        throw projectionKnowledgeError('projection_source_unavailable');
      }
    }
    out[assetId] = expected[assetId];
  }
  return out;
}

export function validateProjectionAssetVersions(
  userId: string,
  projection: ContextProjectionRecord,
): Promise<Record<string, string>> {
  return validateFrozenProjectionAssets(userId, projection, false);
}

export function validateCommittedProjectionAssetVersions(
  userId: string,
  projection: ContextProjectionRecord,
): Promise<Record<string, string>> {
  return validateFrozenProjectionAssets(userId, projection, true);
}


export async function deferContextProjection(userId: string, projectionId: string, note?: string): Promise<ContextProjectionRecord> {
  const updated = await updateRecallJsonRecord(userId, 'projections', projectionId, (raw) => {
    if (!raw) throw new Error('context projection not found');
    const current = asProjection(raw);
    if (current.status === 'confirmed' || current.status === 'revoked') throw new Error('context projection cannot be deferred');
    return {
      ...current,
      status: 'deferred',
      ...(typeof note === 'string' && note.trim() ? { decidedAt: new Date().toISOString(), decisionNote: note.trim() } : { decidedAt: new Date().toISOString() }),
    };
  });
  return asProjection(updated);
}

export async function rejectContextProjection(userId: string, projectionId: string, note?: string): Promise<ContextProjectionRecord> {
  const updated = await updateRecallJsonRecord(userId, 'projections', projectionId, (raw) => {
    if (!raw) throw new Error('context projection not found');
    const current = asProjection(raw);
    if (current.status === 'confirmed' || current.status === 'revoked') throw new Error('context projection cannot be rejected');
    return {
      ...current,
      status: 'rejected',
      ...(typeof note === 'string' && note.trim() ? { decidedAt: new Date().toISOString(), decisionNote: note.trim() } : { decidedAt: new Date().toISOString() }),
    };
  });
  return asProjection(updated);
}

export async function reviseContextProjection(
  userId: string,
  projectionId: string,
  input: ProjectionRevisionInput,
): Promise<ContextProjectionRecord> {
  const addAssetIds = normalizeProjectionAssetIds(input.addAssetIds, 'addAssetIds');
  const removeAssetIds = normalizeProjectionAssetIds(input.removeAssetIds, 'removeAssetIds');
  const removeSet = new Set(removeAssetIds);
  for (const assetId of addAssetIds) {
    if (removeSet.has(assetId)) throw new Error('context projection asset cannot be both add and remove');
  }

  const updated = await updateRecallJsonRecord(userId, 'projections', projectionId, async (raw) => {
    if (!raw) throw new Error('context projection not found');
    const current = asProjection(raw);
    if (current.status !== 'preview') throw new Error('context projection cannot be revised');
    if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) throw new Error('context projection is expired');

    const addedAssets = new Map<string, RecallAbilityAssetRecord>();
    for (const assetId of addAssetIds) {
      addedAssets.set(assetId, await readEligibleProjectionAsset(userId, assetId, current));
    }

    const nextAssetIds: string[] = [];
    const seen = new Set<string>();
    for (const assetId of current.assetIds) {
      if (removeSet.has(assetId) || seen.has(assetId)) continue;
      seen.add(assetId);
      nextAssetIds.push(assetId);
    }
    for (const assetId of addAssetIds) {
      if (seen.has(assetId)) continue;
      seen.add(assetId);
      nextAssetIds.push(assetId);
    }

    const finalAssets: RecallAbilityAssetRecord[] = [];
    for (const assetId of nextAssetIds) {
      const asset = addedAssets.get(assetId) || await readEligibleProjectionAsset(userId, assetId, current);
      finalAssets.push(asset);
    }
    const finalAssetIdSet = new Set(nextAssetIds);
    const currentMatches = new Map((current.assetMatches || []).map((match) => [match.assetId, match]));
    const assetMatches: RecallAssetMatch[] = [];
    for (const assetId of nextAssetIds) {
      const existing = currentMatches.get(assetId);
      if (existing && !addAssetIds.includes(assetId)) assetMatches.push(existing);
      else if (addAssetIds.includes(assetId)) assetMatches.push({ assetId, matchScore: 1, matchMethod: 'manual' });
    }

    return {
      ...current,
      ...(input.purpose ? { purpose: normalizeTerm(input.purpose, 'purpose', 120) } : {}),
      ...(input.decisionNote ? { decisionNote: normalizeTerm(input.decisionNote, 'decision note', 1000) } : {}),
      assetIds: nextAssetIds,
      assetVersions: Object.fromEntries(finalAssets.map((asset) => [asset.id, asset.version])),
      ...(assetMatches.length ? { assetMatches } : { assetMatches: undefined }),
      sourceRefs: sourceRefsForAssets(finalAssets),
      omittedRefs: current.omittedRefs.filter((ref) => !finalAssetIdSet.has(ref.assetId)),
    };
  });
  return asProjection(updated);
}

export async function readContextProjection(userId: string, projectionId: string): Promise<ContextProjectionRecord> {
  const raw = await readRecallJsonRecord(userId, 'projections', projectionId);
  if (!raw) throw new Error('context projection not found');
  return asProjection(raw);
}

export async function listContextProjections(
  userId: string,
  query: ListContextProjectionsQuery = {},
): Promise<ContextProjectionRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 20)));
  let names: string[];
  try {
    names = await fs.readdir(projectionsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readRecallJsonRecord(userId, 'projections', name.slice(0, -5))));
  const now = Date.now();
  return (await Promise.all(records
    .filter((record): record is RecallJsonRecord => Boolean(record))
    .map(async (record) => {
      try {
        return asProjection(record);
      } catch (error) {
        log.warn('skipping degraded context projection', {
          recordId: record.id,
          error: (error as Error).message,
        });
        return null;
      }
    })))
    .filter((projection): projection is ContextProjectionRecord => Boolean(projection))
    .map((projection) => (
      projection.status === 'preview' && projection.expiresAt && Date.parse(projection.expiresAt) <= now
        ? { ...projection, status: 'expired' as const }
        : projection
    ))
    .filter((projection) => query.workspaceId === undefined || projection.workspaceId === query.workspaceId)
    .filter((projection) => query.status === undefined || projection.status === query.status)
    .filter((projection) => query.includeExpired === true || projection.status !== 'expired')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .slice(0, limit);
}

export async function listAvailableProjectionAssets(userId: string, projectionId: string): Promise<AvailableProjectionAssetSummary[]> {
  const projection = await readContextProjection(userId, projectionId);
  if (projection.status !== 'preview') return [];
  const included = new Set(projection.assetIds);
  const assets = await listAbilityAssets(userId);
  const out: AvailableProjectionAssetSummary[] = [];
  for (const asset of assets) {
    if (included.has(asset.id) || asset.status !== 'active') continue;
    try {
      if (!(await isAssetEligibleForProjection(userId, asset, projection))) continue;
    } catch {
      continue;
    }
    out.push({
      id: asset.id,
      title: asset.title,
      type: asset.type,
      status: asset.status,
      maturity: asset.maturity,
      scope: asset.scope,
      version: asset.version,
    });
  }
  return out;
}

export async function confirmContextProjection(userId: string, projectionId: string): Promise<ContextProjectionRecord> {
  const updated = await updateRecallJsonRecord(userId, 'projections', projectionId, async (raw) => {
    if (!raw) throw new Error('context projection not found');
    const current = asProjection(raw);
    if (current.status === 'confirmed') throw new Error('context projection is already confirmed');
    if (current.status !== 'preview') throw new Error('context projection is not confirmable');
    if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) return { ...current, status: 'expired' };
    await validateProjectionAssetVersions(userId, current);
    return { ...current, status: 'confirmed', confirmedAt: new Date().toISOString(), decidedAt: new Date().toISOString() };
  });
  const projection = asProjection(updated);
  if (projection.status === 'expired') throw new Error('context projection is expired');
  return projection;
}

export async function confirmAndApproveWake(
  userId: string,
  input: { cid: string; projectionId: string; wakeRequestId: string },
): Promise<ConfirmAndApproveWakeResult> {
  if (!safeId(input.cid) || !safeId(input.projectionId) || !safeId(input.wakeRequestId)) {
    throw new Error('invalid confirm and approve wake input');
  }
  let projection: ContextProjectionRecord;
  try {
    projection = await confirmContextProjection(userId, input.projectionId);
  } catch (error) {
    if (!/already confirmed/i.test((error as Error).message || '')) throw error;
    projection = await readContextProjection(userId, input.projectionId);
    if (projection.status !== 'confirmed') throw error;
  }
  const assetVersions = await validateProjectionAssetVersions(userId, projection);
  const request = await getWakeRequest(userId, input.wakeRequestId);
  if (!request || request.conversation_id !== input.cid || request.status !== 'pending') {
    return {
      ok: false,
      status: 'wake_unbound',
      projection,
      error: !request ? 'wake request not found' : `wake request cannot be approved from ${request.status}`,
    };
  }
  const approved = await approveWakeRequest(userId, request.id, {
    assetConfirmationSnapshot: {
      projection_id: projection.id,
      wake_request_id: request.id,
      projection_status: 'confirmed',
      confirmed_at: projection.confirmedAt || projection.decidedAt || new Date().toISOString(),
      asset_ids: [...projection.assetIds],
      asset_versions: assetVersions,
      task_run_id: projection.taskRunId,
      conversation_id: input.cid,
    },
  });
  return { ok: true, status: 'approved', projection, request: approved.request, approval: approved.approval };
}
