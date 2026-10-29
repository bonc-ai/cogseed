import { ambiguousRecallAssetIds, assessSemanticApplicability, decisionSchema, type SemanticApplicabilityDecision } from './semantic-applicability';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { genId12, safeId } from '../../storage';
import { createLogger } from '../../logger';
import { abilityAssetActiveVersion, listAbilityAssets, readAbilityAsset, type AbilityAssetVersionRecord } from './asset-service';
import { recallJsonRecordPath } from './paths';
import { listWorkspaceAssetReferences } from './workspace-refs';
import { isAssetScopeAllowed, scopeIncludes, type AssetScopeContext, type RecallAbilityAssetScopePolicy } from './scope-policy';
import { loadOntologyGroupTitleMap } from './ontology-taxonomy';
import { buildRecallTaskContract } from './task-contract';
import {
  rankOntologyMatches,
  mergeHybridMatches,
  type HybridMatchMethod,
  type HybridRouteMatch,
} from './hybrid-retrieval';
import { orchestrateOntologySemanticRecall } from './ontology-semantic-orchestrator';
import {
  queryOntologyAssets,
  type OntologyAssetQueryDirection,
  type OntologyAssetQueryEvidenceEdge,
} from './ontology-asset-query';
import type { OntologyQueryIntentRoute } from './ontology-query-intent';
import type { AbilityAssetRelationKind } from './asset-relations';
import { isSemanticaEnabled } from './semantica-settings';
import type { JevFallbackReason } from '../jev/types';
import { readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { AgentWakeRequest, WakeApproval } from '../p3394/types';
import { approveWakeRequest, getWakeRequest } from '../p3394/wake-service';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from './source-service';
import { createAssetSourceAvailability } from './asset-source-availability';
import {
  assetRuntimeBlockRule,
  type AssetRuntimeBlockReason,
  type AssetRuntimeContext,
} from './formal-assets/runtime';

/** Runtime 阻断原因 → 投影里对用户可见的省略原因。 */
const RUNTIME_OMISSION_REASON: Partial<Record<AssetRuntimeBlockReason, OmittedAssetRef['reason']>> = {
  status_not_active: 'asset_paused',
  maturity_below_default_use: 'maturity_requires_user_selection',
  // not_applicable_context 不在此映射：runtime 闸门已不再产出该原因
  // （适用性条件是自由文本，字面不匹配不能证伪——见 formal-assets/runtime），
  // 语义适用性评估的 not_applicable_context 省略走各自直写路径。
  forbidden_context: 'forbidden_context',
  target_agent_not_allowed: 'target_agent_not_allowed',
  scope_mismatch: 'scope_mismatch',
  source_unavailable: 'source_unavailable',
};

const log = createLogger('recall.context-projection');
let lastProjectionCreatedAtMs = 0;

/** 授权来源：模型自己把资产挂到本任务——
 *  与宿主自动投影（not_required）、工作区策略（workspace_policy）、用户确认
 *  （user_confirmed）并列，区别在于"谁做的决定"，界面据此标"模型自选"并
 *  允许一键撤销。 */
export type ProjectionAuthorization = 'user_confirmed' | 'workspace_policy' | 'not_required' | 'model_selected';
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
  detail?: string;
  reason: 'asset_paused' | 'asset_archived' | 'asset_deleted' | 'asset_purged' | 'asset_revoked' | 'workspace_not_referenced' | 'workspace_disabled' | 'scope_mismatch' | 'source_unavailable' | 'low_relevance' | 'maturity_requires_user_selection' | 'not_applicable_context' | 'forbidden_context' | 'target_agent_not_allowed' | 'prompt_budget';
}

function inactiveAssetOmissionReason(
  status: RecallAbilityAssetRecord['status'],
): OmittedAssetRef['reason'] | undefined {
  if (status === 'active') return undefined;
  return `asset_${status}` as OmittedAssetRef['reason'];
}

export type RecallAssetMatchMethod = HybridMatchMethod | 'standing_preference';

export interface RecallAssetMatch {
  assetId: string;
  matchScore: number;
  semanticAssessment?: SemanticApplicabilityDecision;
  matchMethod: RecallAssetMatchMethod;
  /** Semantica automatic-recall provenance. */
  entryAssetId?: string;
  distance?: number;
  relationKind?: AbilityAssetRelationKind;
  evidencePath?: OntologyAssetQueryEvidenceEdge[];
  degraded?: boolean;
}

export interface ModelSelectionEvent {
  taskRunId: string;
  assetIds: string[];
  addedAssetIds: string[];
  addedAt: string;
}

export type SemanticaGateTraceStatus = 'disabled' | 'selected' | 'fallback' | 'clarify' | 'none';

export interface SemanticaSelectionTrace {
  enabled: true;
  entryAssetIds: string[];
  /** Relation candidates found by the local deterministic traversal. */
  deterministicExpansionCount: number;
  /** Relation candidates left after the optional intent plan is applied. */
  finalExpansionCount: number;
  intentGate: {
    status: SemanticaGateTraceStatus;
    selectedRoute?: OntologyQueryIntentRoute;
    relationKind?: AbilityAssetRelationKind;
    direction?: OntologyAssetQueryDirection;
    maxHops?: number;
    jevStatus?: 'ok' | 'fallback';
    fallbackReason?: JevFallbackReason;
    jevAttempts?: number;
    jevLatencyMs?: number;
  };
  candidateGate: {
    status: SemanticaGateTraceStatus;
    inputCount: number;
    outputCount: number;
    jevStatus?: 'ok' | 'fallback';
    fallbackReason?: JevFallbackReason;
    jevAttempts?: number;
    jevLatencyMs?: number;
  };
}

/** 投影冻结的资产版本内容副本；可选 evidenceRefs 用于保留迁出后的来源引用。
 * 旧冻结副本可能不含该字段，读取方必须按可选字段处理。 */
export type FrozenAssetVersionSnapshot = AbilityAssetVersionRecord['snapshot'] & { evidenceRefs?: CognitionSourceRef[] };

export interface ContextProjectionRecord extends RecallJsonRecord {
  taskRunId: string;
  conversationId?: string;
  /** App project binding for project-scoped ontology values (`@proj:<id>`). */
  projectId?: string;
  workspaceId?: string;
  /** Scope dimensions captured when this task's projection was selected. */
  agentId?: string;
  roleId?: string;
  conversationKind?: string;
  fileKinds?: string[];
  purpose: string;
  authorization: ProjectionAuthorization;
  assetIds: string[];
  assetVersions?: Record<string, string>;
  /** 版本真删前冻结进投影的内容副本：已确认注入引用的版本被
   *  物理删除时，把该版本快照抄进这里；之后注入优先按副本供给，效果与
   *  删除前一致。仅为删除时的兜底缓存，不是投影本体的必填结构。
   *  可选证据引用：存量迁移把经验类资产迁出
   *  资产库时，会在冻结副本里一并写入 `evidenceRefs`——live 记录删除后，
   *  证据引用只能随副本走（否则迁移后来源不可追）。历史删除冻结的旧副本
   *  可能缺该字段，读侧一律按可选处理。 */
  assetVersionSnapshots?: Record<string, { version: string; snapshot: FrozenAssetVersionSnapshot }>;
  assetMatches?: RecallAssetMatch[];
  /** Cumulative assets added because the model explicitly named them. */
  modelSelectedAssetIds?: string[];
  /** Per tool-call ledger for model-selected additions. */
  modelSelectionEvents?: ModelSelectionEvent[];
  sourceRefs: CognitionSourceRef[];
  omittedRefs: OmittedAssetRef[];
  expiresAt?: string;
  /** True when semantic retrieval degraded; reliable ontology matches may remain. */
  selectionDegraded?: boolean;
  /** Bounded, content-free receipt for the automatic Semantica/Jev path. */
  semanticaTrace?: SemanticaSelectionTrace;
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
  projectId?: string;
  workspaceId?: string;
  purpose: string;
  taskText?: string;
  authorization?: ProjectionAuthorization;
  expiresAt?: string;
  /** 来源会话 id：模型自选投影按会话去重（同一会话只维护一条），
   *  使用记录/时间线也靠它把事件关联回会话名。 */
  conversationId?: string;
  /** 显式资产：用户点「用到当前对话」钉住的资产
   *  ——绕过语义选择（用户已经挑好了），但仍过状态硬门（必须 active）并
   *  钉住当前在用版。与 taskText 语义选互斥，显式优先。 */
  explicitAssetIds?: string[];
  /** 接收者 Agent：显式挂载时若已知接收者，目标 Agent
   *  白名单与作用域判定当场生效；未知则留给每轮注入闸门（那里一定知道）。 */
  agentId?: string;
  roleId?: string;
  conversationKind?: string;
  fileKinds?: string[];
  /** Auto-confirm on creation (workspace_policy line): the projection is
   *  written as confirmed immediately, skipping the user confirmation card. */
  confirm?: boolean;
}


export interface ProjectionSemanticOptions {
  embedTexts?: (texts: string[]) => Promise<number[][]>;
  assessApplicability?: (message: string) => Promise<string>;
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
  agentId?: string;
  roleId?: string;
  projectId?: string;
  workspaceId?: string;
  /** 来源会话 id：使用记录页按它把事件关联回会话名（用户需求：不显示裸 id）。 */
  conversationId?: string;
  conversationKind?: string;
  fileKinds?: string[];
}

export interface BuildRecallViewResult {
  assetIds: string[];
  assetVersions?: Record<string, string>;
  assetMatches?: RecallAssetMatch[];
  sourceRefs: CognitionSourceRef[];
  omittedRefs: OmittedAssetRef[];
  /** Semantic embedding was unavailable; selection retained ontology matches only. */
  degraded?: boolean;
  semanticaTrace?: SemanticaSelectionTrace;
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
  taskRunId?: string;
  conversationId?: string;
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

function normalizeOptionalScopeId(value: unknown, field: string): string | undefined {
  const text = normalizeOptionalTerm(value, field, 160);
  if (text && !safeId(text)) throw new Error(`invalid projection ${field}`);
  return text;
}

function normalizeProjectionFileKinds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw new Error('invalid projection file kinds');
  const kinds = value.map((item) => normalizeTerm(item, 'file kind', 120));
  return [...new Set(kinds)];
}

const DEFERRED_PROJECTION_PURPOSE_LABELS = new Set([
  'conversation_reply',
  'conversation_task',
  'model_selected',
  'user_pinned',
]);

type ProjectionConversationContext = Pick<AssetScopeContext, 'projectId' | 'workspaceId' | 'conversationKind'>;

function projectionPurposeIsDeferred(
  authorization: ProjectionAuthorization | undefined,
  purpose: string,
): boolean {
  return authorization === 'not_required'
    || authorization === 'model_selected'
    || DEFERRED_PROJECTION_PURPOSE_LABELS.has(purpose.trim().toLocaleLowerCase());
}

function scopePolicyWithoutPurposeTags(
  policy: RecallAbilityAssetScopePolicy | undefined,
): RecallAbilityAssetScopePolicy | undefined {
  if (!policy) return undefined;
  // An explicit empty allow-list means "never"; keep that hard denial even
  // while deferring non-empty purpose matching to the real task context.
  if (policy.purposeTags?.length === 0) return policy;
  const dimensions = { ...policy };
  delete dimensions.purposeTags;
  return Object.keys(dimensions).length ? dimensions : undefined;
}

async function resolveProjectionConversationContext(
  userId: string,
  conversationId?: string,
): Promise<Partial<ProjectionConversationContext>> {
  if (!conversationId) return {};
  try {
    const { getConversation } = await import('../chats');
    const conversation = await getConversation(userId, conversationId);
    if (!conversation) return {};
    return {
      // `conversation.agent_id` is only the starting-agent suggestion; group
      // membership and the actual recipient are dynamic. Only a caller that
      // knows the current target may bind an Agent scope to this projection.
      ...(conversation.project_id && safeId(conversation.project_id) ? { projectId: conversation.project_id } : {}),
      ...(conversation.space_id && safeId(conversation.space_id) ? { workspaceId: conversation.space_id } : {}),
      ...(conversation.kind && safeId(conversation.kind) ? { conversationKind: conversation.kind } : {}),
    };
  } catch {
    // Missing conversation metadata must not invent a permission context.
    return {};
  }
}

function validateAssetMatches(value: unknown): RecallAssetMatch[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('malformed context projection matches');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('malformed context projection matches');
    const match = raw as Record<string, unknown>;
    if (typeof match.assetId !== 'string' || !safeId(match.assetId)) throw new Error('malformed context projection matches');
    if (typeof match.matchScore !== 'number' || !Number.isFinite(match.matchScore) || match.matchScore < 0 || match.matchScore > 1) throw new Error('malformed context projection matches');
    if (match.matchMethod !== 'semantic' && match.matchMethod !== 'ontology' && match.matchMethod !== 'semantic_ontology' && match.matchMethod !== 'recency_fallback' && match.matchMethod !== 'manual' && match.matchMethod !== 'standing_preference') throw new Error('malformed context projection matches');
    if (match.entryAssetId !== undefined && (typeof match.entryAssetId !== 'string' || !safeId(match.entryAssetId))) throw new Error('malformed context projection match entry');
    if (match.distance !== undefined && (typeof match.distance !== 'number' || !Number.isInteger(match.distance) || match.distance < 0 || match.distance > 32)) throw new Error('malformed context projection match distance');
    const relationKinds = new Set<AbilityAssetRelationKind>(['refines', 'depends_on', 'replaces', 'conflicts_with', 'related_to', 'same_family']);
    if (match.relationKind !== undefined && !relationKinds.has(match.relationKind as AbilityAssetRelationKind)) throw new Error('malformed context projection match relation');
    if (match.degraded !== undefined && typeof match.degraded !== 'boolean') throw new Error('malformed context projection match degraded status');
    let evidencePath: OntologyAssetQueryEvidenceEdge[] | undefined;
    if (match.evidencePath !== undefined) {
      if (!Array.isArray(match.evidencePath) || match.evidencePath.length > 32) throw new Error('malformed context projection match evidence');
      evidencePath = match.evidencePath.map((rawEdge) => {
        if (!rawEdge || typeof rawEdge !== 'object' || Array.isArray(rawEdge)) throw new Error('malformed context projection match evidence');
        const edge = rawEdge as Record<string, unknown>;
        const edgeKinds = new Set<AbilityAssetRelationKind>(['refines', 'depends_on', 'replaces', 'conflicts_with', 'related_to', 'same_family']);
        if (typeof edge.fromAssetId !== 'string' || !safeId(edge.fromAssetId) || typeof edge.toAssetId !== 'string' || !safeId(edge.toAssetId) || typeof edge.fromTitle !== 'string' || typeof edge.toTitle !== 'string' || !edgeKinds.has(edge.kind as AbilityAssetRelationKind)) throw new Error('malformed context projection match evidence');
        return { fromAssetId: edge.fromAssetId, fromTitle: edge.fromTitle, kind: edge.kind as AbilityAssetRelationKind, toAssetId: edge.toAssetId, toTitle: edge.toTitle };
      });
    }
    return {
      assetId: match.assetId,
      matchScore: match.matchScore,
      matchMethod: match.matchMethod,
      ...(match.entryAssetId ? { entryAssetId: match.entryAssetId } : {}),
      ...(match.distance !== undefined ? { distance: match.distance } : {}),
      ...(match.relationKind ? { relationKind: match.relationKind as AbilityAssetRelationKind } : {}),
      ...(evidencePath ? { evidencePath } : {}),
      ...(match.degraded === true ? { degraded: true } : {}),
      ...(match.semanticAssessment ? { semanticAssessment: decisionSchema.parse(match.semanticAssessment) } : {}),
    } as RecallAssetMatch;
  });
}

const SEMANTICA_TRACE_STATUSES = new Set<SemanticaGateTraceStatus>([
  'disabled',
  'selected',
  'fallback',
  'clarify',
  'none',
]);
const SEMANTICA_TRACE_ROUTES = new Set<OntologyQueryIntentRoute>([
  'ontology',
  'semantic',
  'hybrid',
  'clarify',
]);
const SEMANTICA_TRACE_DIRECTIONS = new Set<OntologyAssetQueryDirection>([
  'incoming',
  'outgoing',
  'both',
]);
const SEMANTICA_TRACE_RELATIONS = new Set<AbilityAssetRelationKind>([
  'refines',
  'depends_on',
  'replaces',
  'conflicts_with',
  'related_to',
  'same_family',
]);
const JEV_FALLBACK_REASONS = new Set<JevFallbackReason>([
  'disabled',
  'unconfigured',
  'invalid_request',
  'timeout',
  'aborted',
  'rate_limited',
  'http_error',
  'http_rejected',
  'network_error',
  'invalid_response',
]);

function validateTraceCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error('malformed Semantica trace count');
  }
  return value;
}

function validateSemanticaTrace(value: unknown): SemanticaSelectionTrace | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed Semantica trace');
  const trace = value as Record<string, unknown>;
  if (trace.enabled !== true || !Array.isArray(trace.entryAssetIds) || trace.entryAssetIds.length > SEMANTICA_ENTRY_TOP_K) {
    throw new Error('malformed Semantica trace');
  }
  const entryAssetIds = trace.entryAssetIds.map((id) => {
    if (typeof id !== 'string' || !safeId(id)) throw new Error('malformed Semantica trace entry');
    return id;
  });
  const validateGate = (raw: unknown, candidate: boolean) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('malformed Semantica gate trace');
    const gate = raw as Record<string, unknown>;
    if (!SEMANTICA_TRACE_STATUSES.has(gate.status as SemanticaGateTraceStatus)) throw new Error('malformed Semantica gate trace status');
    if (gate.jevStatus !== undefined && gate.jevStatus !== 'ok' && gate.jevStatus !== 'fallback') throw new Error('malformed Semantica Jev status');
    if (gate.fallbackReason !== undefined && !JEV_FALLBACK_REASONS.has(gate.fallbackReason as JevFallbackReason)) throw new Error('malformed Semantica fallback reason');
    if (gate.jevAttempts !== undefined && (typeof gate.jevAttempts !== 'number' || !Number.isInteger(gate.jevAttempts) || gate.jevAttempts < 0 || gate.jevAttempts > 3)) throw new Error('malformed Semantica Jev attempts');
    if (gate.jevLatencyMs !== undefined && (typeof gate.jevLatencyMs !== 'number' || !Number.isFinite(gate.jevLatencyMs) || gate.jevLatencyMs < 0 || gate.jevLatencyMs > 60_000)) throw new Error('malformed Semantica Jev latency');
    if (candidate) {
      return {
        status: gate.status as SemanticaGateTraceStatus,
        inputCount: validateTraceCount(gate.inputCount),
        outputCount: validateTraceCount(gate.outputCount),
        ...(gate.jevStatus ? { jevStatus: gate.jevStatus as 'ok' | 'fallback' } : {}),
        ...(gate.fallbackReason ? { fallbackReason: gate.fallbackReason as JevFallbackReason } : {}),
        ...(gate.jevAttempts !== undefined ? { jevAttempts: gate.jevAttempts } : {}),
        ...(gate.jevLatencyMs !== undefined ? { jevLatencyMs: gate.jevLatencyMs } : {}),
      };
    }
    if (gate.selectedRoute !== undefined && !SEMANTICA_TRACE_ROUTES.has(gate.selectedRoute as OntologyQueryIntentRoute)) throw new Error('malformed Semantica route');
    if (gate.relationKind !== undefined && !SEMANTICA_TRACE_RELATIONS.has(gate.relationKind as AbilityAssetRelationKind)) throw new Error('malformed Semantica relation');
    if (gate.direction !== undefined && !SEMANTICA_TRACE_DIRECTIONS.has(gate.direction as OntologyAssetQueryDirection)) throw new Error('malformed Semantica direction');
    if (gate.maxHops !== undefined && (typeof gate.maxHops !== 'number' || !Number.isInteger(gate.maxHops) || gate.maxHops < 1 || gate.maxHops > 4)) throw new Error('malformed Semantica max hops');
    return {
      status: gate.status as SemanticaGateTraceStatus,
      ...(gate.selectedRoute ? { selectedRoute: gate.selectedRoute as OntologyQueryIntentRoute } : {}),
      ...(gate.relationKind ? { relationKind: gate.relationKind as AbilityAssetRelationKind } : {}),
      ...(gate.direction ? { direction: gate.direction as OntologyAssetQueryDirection } : {}),
      ...(gate.maxHops !== undefined ? { maxHops: gate.maxHops } : {}),
      ...(gate.jevStatus ? { jevStatus: gate.jevStatus as 'ok' | 'fallback' } : {}),
      ...(gate.fallbackReason ? { fallbackReason: gate.fallbackReason as JevFallbackReason } : {}),
      ...(gate.jevAttempts !== undefined ? { jevAttempts: gate.jevAttempts } : {}),
      ...(gate.jevLatencyMs !== undefined ? { jevLatencyMs: gate.jevLatencyMs } : {}),
    };
  };
  return {
    enabled: true,
    entryAssetIds,
    deterministicExpansionCount: validateTraceCount(trace.deterministicExpansionCount),
    finalExpansionCount: validateTraceCount(trace.finalExpansionCount),
    intentGate: validateGate(trace.intentGate, false) as SemanticaSelectionTrace['intentGate'],
    candidateGate: validateGate(trace.candidateGate, true) as SemanticaSelectionTrace['candidateGate'],
  };
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

/** 快照缓存是删除时的兜底字段：形状不对就整字段剥离（回退版本流读取），
 *  不让它有权力把整条投影判成畸形。快照本体（含迁移冻结写入的可选
 *  `evidenceRefs`）原样透传，不在此处重算——冻结的意义就是"当年什么样
 *  就读回什么样"。 */
function validateAssetVersionSnapshots(
  value: unknown,
): Record<string, { version: string; snapshot: FrozenAssetVersionSnapshot }> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, { version: string; snapshot: FrozenAssetVersionSnapshot }> = {};
  for (const [assetId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!safeId(assetId) || !entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.version !== 'string' || !record.version.trim()
      || !record.snapshot || typeof record.snapshot !== 'object' || Array.isArray(record.snapshot)) return undefined;
    out[assetId] = { version: record.version, snapshot: record.snapshot as FrozenAssetVersionSnapshot };
  }
  return Object.keys(out).length ? out : undefined;
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
  // would inflate baseline similarity for every asset of the same group.
  const ontology = (asset.ontologyRefs || []).map((ref) => [
    groupTitles.get(ref.groupId) || ref.groupId,
    ref.section,
    ref.field,
  ].filter(Boolean).join(' / ')).filter(Boolean).join('\n');
  // type/scope are shared dimension labels, not content: including them
  // inflated baseline similarity for every asset of the same type.
  return [
    asset.title,
    asset.statement,
    ...(asset.applicableWhen || []),
    ...(asset.forbiddenWhen || []),
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

async function defaultEmbedTexts(userId: string, texts: string[]): Promise<number[][]> {
  const { embedForDedup } = await import('./similarity');
  const vectors: number[][] = [];
  for (const text of texts) {
    const vector = await embedForDedup(userId, text);
    if (!vector) throw new Error('complete recall embedding unavailable');
    vectors.push(vector);
  }
  return vectors;
}

async function rankAssetsBySemanticMatch(
  userId: string,
  taskText: string,
  assets: RecallAbilityAssetRecord[],
  options: ProjectionSemanticOptions,
): Promise<{ assets: RecallAbilityAssetRecord[]; assetMatches: RecallAssetMatch[] }> {
  const embedTexts = options.embedTexts || ((texts: string[]) => defaultEmbedTexts(userId, texts));
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

function stableProjectionHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
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

/** 投影/预载的"任务类型词"闸门：'*' / 'general'（通用）/ 'space'（空间适用）
 *  不按 purpose 过滤——否则真实资产（scope 多为 space/general）在
 *  purpose='review' 等任务词下永远被 scope_mismatch 剔除，预载卡片选不出资产。
 *  其余 scope（review/report/自定义词条）走软匹配（scopeIncludes）。 */
function scopeAppliesToPurpose(scope: string, purpose: string): boolean {
  const terms = scope.split(',').map((term) => term.trim().toLowerCase()).filter(Boolean);
  if (terms.includes('*') || terms.includes('general') || terms.includes('global') || terms.includes('space')) return true;
  return scopeIncludes(scope, purpose);
}

async function isAssetEligibleForProjection(
  userId: string,
  asset: RecallAbilityAssetRecord,
  projection: Pick<ContextProjectionRecord, 'projectId' | 'conversationId' | 'workspaceId' | 'agentId' | 'roleId' | 'conversationKind' | 'fileKinds' | 'purpose' | 'authorization'>,
  runtimeScope: AssetScopeContext = {},
): Promise<boolean> {
  if (asset.status !== 'active') throw new Error('context projection asset is not active');
  const needsConversationContext = (runtimeScope.projectId === undefined && projection.projectId === undefined)
    || (runtimeScope.workspaceId === undefined && projection.workspaceId === undefined)
    || (runtimeScope.conversationKind === undefined && projection.conversationKind === undefined);
  const conversationContext = needsConversationContext
    ? await resolveProjectionConversationContext(userId, projection.conversationId)
    : {};
  const projectId = runtimeScope.projectId ?? projection.projectId ?? conversationContext.projectId;
  const workspaceId = runtimeScope.workspaceId ?? projection.workspaceId ?? conversationContext.workspaceId;
  const conversationKind = runtimeScope.conversationKind ?? projection.conversationKind ?? conversationContext.conversationKind;
  const agentId = runtimeScope.agentId ?? projection.agentId;
  const roleId = runtimeScope.roleId ?? projection.roleId;
  const fileKinds = runtimeScope.fileKinds ?? projection.fileKinds;
  const purpose = runtimeScope.purpose ?? projection.purpose;
  const deferPurposeGate = runtimeScope.purpose === undefined
    && projectionPurposeIsDeferred(projection.authorization, projection.purpose);
  // Purpose is task-time context. If durable validation only has a workflow
  // label, defer purposeTags to the live runtime gate. Otherwise use the real
  // task purpose; the other dimensions prefer current runtime values, then the
  // projection snapshot, and fail closed when a declared scope is unknown.
  const scopePolicy = deferPurposeGate
    ? scopePolicyWithoutPurposeTags(asset.scopePolicy)
    : asset.scopePolicy;
  if (!isAssetScopeAllowed(scopePolicy, {
    purpose,
    projectId,
    workspaceId,
    ...(agentId ? { agentId } : {}),
    ...(roleId ? { roleId } : {}),
    ...(conversationKind ? { conversationKind } : {}),
    ...(fileKinds !== undefined ? { fileKinds } : {}),
  })) return false;
  // 自由文本 scope 是自动选择的启发式。模型自选和用户直接挂载都已有明确
  // 选择意图，因此不重复词面否决；硬性 purposeTags 仍按实际任务上下文复核。
  const requireScopeWordMatch = !deferPurposeGate
    && projection.authorization !== 'model_selected'
    && projection.purpose !== 'user_pinned';
  // 资产池全局共享：空间投影可引用整个池子（含其它空间资产与全局资产）。
  // workspace-ref 是可选收紧控制（显式停用 / scope 词），不是前置。
  if (workspaceId) {
    const refs = await listWorkspaceAssetReferences(userId);
    const ref = refs.find((item) => item.assetId === asset.id && item.workspaceId === workspaceId);
    if (ref && !ref.enabled) return false;
    if (ref && requireScopeWordMatch && !scopeAppliesToPurpose(ref.scope, purpose)) return false;
    return true;
  }
  return requireScopeWordMatch ? scopeAppliesToPurpose(asset.scope, purpose) : true;
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

function validateModelSelectedAssetIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('malformed model-selected assets');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = String(item || '');
    if (!id || seen.has(id)) throw new Error('malformed model-selected assets');
    seen.add(id); out.push(id);
  }
  return out;
}

function validateModelSelectionEvents(value: unknown): ModelSelectionEvent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('malformed model selection events');
  return value.map((event) => {
    if (!event || typeof event !== 'object') throw new Error('malformed model selection event');
    const row = event as Record<string, unknown>;
    const taskRunId = String(row.taskRunId || '');
    const addedAt = String(row.addedAt || '');
    if (!taskRunId || !addedAt) throw new Error('malformed model selection event');
    return {
      taskRunId,
      assetIds: validateModelSelectedAssetIds(row.assetIds) || [],
      addedAssetIds: validateModelSelectedAssetIds(row.addedAssetIds) || [],
      addedAt,
    };
  });
}

function asProjection(value: RecallJsonRecord): ContextProjectionRecord {
  if (!Array.isArray(value.assetIds) || !Array.isArray(value.sourceRefs) || !Array.isArray(value.omittedRefs) || typeof value.taskRunId !== 'string' || typeof value.purpose !== 'string' || typeof value.authorization !== 'string' || typeof value.createdAt !== 'string') throw new Error('malformed context projection');
  if (value.projectId !== undefined && !safeId(value.projectId)) throw new Error('malformed context projection project id');
  if (value.workspaceId !== undefined && !safeId(value.workspaceId)) throw new Error('malformed context projection workspace id');
  if (value.selectionDegraded !== undefined && typeof value.selectionDegraded !== 'boolean') throw new Error('malformed context projection');
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt)))) throw new Error('malformed context projection expiry');
  const agentId = normalizeOptionalScopeId(value.agentId, 'agent id');
  const roleId = normalizeOptionalScopeId(value.roleId, 'role id');
  const conversationKind = normalizeOptionalScopeId(value.conversationKind, 'conversation kind');
  const fileKinds = normalizeProjectionFileKinds(value.fileKinds);
  const assetMatches = validateAssetMatches(value.assetMatches);
  const assetVersions = validateAssetVersions(value.assetVersions);
  const assetVersionSnapshots = validateAssetVersionSnapshots(value.assetVersionSnapshots);
  const modelSelectedAssetIds = validateModelSelectedAssetIds(value.modelSelectedAssetIds);
  const modelSelectionEvents = validateModelSelectionEvents(value.modelSelectionEvents);
  const semanticaTrace = validateSemanticaTrace(value.semanticaTrace);
  return { ...value, status: validateProjectionStatus(value.status), sourceRefs: normalizeCognitionSourceRefs(value.sourceRefs), ...(assetMatches ? { assetMatches } : {}), ...(assetVersions ? { assetVersions } : {}), ...(assetVersionSnapshots ? { assetVersionSnapshots } : {}),
    ...(agentId ? { agentId } : {}), ...(roleId ? { roleId } : {}),
    ...(conversationKind ? { conversationKind } : {}), ...(fileKinds !== undefined ? { fileKinds } : {}),
    ...(modelSelectedAssetIds ? { modelSelectedAssetIds } : {}),
    ...(modelSelectionEvents ? { modelSelectionEvents } : {}),
    ...(semanticaTrace ? { semanticaTrace } : {}),
  } as ContextProjectionRecord;
}

/** Default semantic HARD FLOOR (dual-signal selection): scores below this
 *  are treated as embedding noise and never injected, even when Top-N slots
 *  remain. It is deliberately low — admission is primarily governed by the
 *  Top-N slots plus a relative-significance gate (see applySemanticSelection),
 *  not by this absolute cutoff. */
// 绝对相似度下限用于排除弱相关噪声；通过后仍受 Top-N 和相对相关性门控。
export const DEFAULT_MIN_MATCH_SCORE = 0.40;
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
  semanticaTrace?: SemanticaSelectionTrace;
}

const SEMANTICA_ENTRY_TOP_K = 1;
const SEMANTICA_RELATION_MAX_HOPS = 2;
const SEMANTICA_RELATION_LIMIT_PER_ENTRY = 8;
const SEMANTICA_RELATION_KINDS: AbilityAssetRelationKind[] = [
  'depends_on',
  'refines',
  'related_to',
  'same_family',
];

function automaticRelationMatch(
  entry: { assetId: string; matchScore: number },
  match: { asset: { id: string }; distance: number; evidencePath: OntologyAssetQueryEvidenceEdge[] },
): HybridRouteMatch & {
  entryAssetId: string;
  distance: number;
  relationKind?: AbilityAssetRelationKind;
  evidencePath: OntologyAssetQueryEvidenceEdge[];
} {
  const relationKinds = [...new Set(match.evidencePath.map((edge) => edge.kind))];
  return {
    assetId: match.asset.id,
    // Relation evidence decays with distance but never pretends to be the
    // semantic score of the entry asset.
    matchScore: Number((entry.matchScore * (0.8 ** Math.max(1, match.distance))).toFixed(6)),
    entryAssetId: entry.assetId,
    distance: match.distance,
    ...(relationKinds.length === 1 ? { relationKind: relationKinds[0] } : {}),
    evidencePath: match.evidencePath,
  };
}

function expandSemanticEntries(
  assets: readonly RecallAbilityAssetRecord[],
  semanticMatches: readonly { assetId: string; matchScore: number }[],
  minScore: number,
  relativeSignificance: number,
  intent?: {
    relationKind?: AbilityAssetRelationKind;
    direction?: OntologyAssetQueryDirection;
    maxHops?: number;
  },
): { entries: HybridRouteMatch[]; expansions: Array<HybridRouteMatch & { entryAssetId: string; distance: number; relationKind?: AbilityAssetRelationKind; evidencePath: OntologyAssetQueryEvidenceEdge[] }>; covered: boolean } {
  const bestScore = semanticMatches.reduce((best, match) => Math.max(best, match.matchScore), 0);
  const relativeFloor = bestScore * relativeSignificance;
  const entries = semanticMatches
    .filter((match) => match.matchScore >= minScore && (bestScore <= minScore || match.matchScore >= relativeFloor))
    .slice(0, SEMANTICA_ENTRY_TOP_K)
    .map((match) => ({ assetId: match.assetId, matchScore: match.matchScore }));
  const expansions: Array<HybridRouteMatch & { entryAssetId: string; distance: number; relationKind?: AbilityAssetRelationKind; evidencePath: OntologyAssetQueryEvidenceEdge[] }> = [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const entry of entries) {
    const result = queryOntologyAssets(assets, {
      target: entry.assetId,
      direction: intent?.direction || 'both',
      maxHops: intent?.maxHops || SEMANTICA_RELATION_MAX_HOPS,
      limit: SEMANTICA_RELATION_LIMIT_PER_ENTRY,
      relationKinds: intent?.relationKind ? [intent.relationKind] : SEMANTICA_RELATION_KINDS,
      query: entry.assetId,
    });
    if (result.status !== 'ok') continue;
    for (const match of result.matches) {
      if (!assetById.has(match.asset.id)) continue;
      expansions.push(automaticRelationMatch(entry, match));
    }
  }
  return { entries, expansions, covered: expansions.length > 0 };
}

/** Shared hybrid selection: rank already-eligible assets against semantic and
 * ontology evidence, drop weak semantic-only matches, cap to Top-N, and record
 * low-relevance exclusions. Embedding failure never turns into a recency
 * injection; reliable ontology matches may still survive the degraded route. */
async function applySemanticSelection(
  userId: string,
  assets: RecallAbilityAssetRecord[],
  queryText: string,
  options: ProjectionSemanticOptions,
  omittedRefs: OmittedAssetRef[],
  purposeText = '',
  workspaceId?: string,
  projectId?: string,
  applicabilityContext?: AssetScopeContext,
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

  const contract = await buildRecallTaskContract(userId, {
    taskText: queryText,
    ...(purposeText ? { purpose: purposeText } : {}),
    ...(projectId ? { projectId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  });
  const ontologyMatches = rankOntologyMatches(assets, contract);
  let semanticMatches: Array<{ assetId: string; matchScore: number }> = [];
  let degraded = false;
  try {
    const ranked = await rankAssetsBySemanticMatch(userId, queryText, assets, options);
    semanticMatches = ranked.assetMatches;
  } catch (error) {
    log.warn('semantic recall ranking unavailable; retaining reliable ontology matches only', { userId, error: (error as Error).message });
    degraded = true;
  }

  const semanticaEnabled = isSemanticaEnabled(userId);
  let mergedAssetMatches: RecallAssetMatch[];
  let semanticaTrace: SemanticaSelectionTrace | undefined;
  if (!semanticaEnabled) {
    // Compatibility path: adding Semantica must not change ordinary recall.
    // In particular, do not invoke relationship traversal or the Jev gate.
    const legacy = mergeHybridMatches(assets, semanticMatches, ontologyMatches);
    mergedAssetMatches = legacy.assetMatches;
  } else {
    const expanded = expandSemanticEntries(assets, semanticMatches, minScore, relativeSignificance);
    const relationMatches = expanded.covered ? expanded.expansions : [];
    const deterministicExpansionCount = relationMatches.length;
    const intentTrace: SemanticaSelectionTrace['intentGate'] = {
      status: 'selected',
      selectedRoute: relationMatches.length ? 'hybrid' : 'semantic',
      direction: 'both',
      maxHops: SEMANTICA_RELATION_MAX_HOPS,
    };
    const merged = orchestrateOntologySemanticRecall({
      assets,
      semanticMatches: relationMatches.length ? expanded.entries : semanticMatches,
      ontologyMatches: [...ontologyMatches, ...relationMatches],
      semanticDegraded: degraded,
    });
    mergedAssetMatches = merged.candidates.map((candidate) => ({
      assetId: candidate.assetId,
      matchScore: candidate.matchScore,
      matchMethod: candidate.source,
      ...(candidate.entryAssetId ? { entryAssetId: candidate.entryAssetId } : {}),
      ...(candidate.distance !== undefined ? { distance: candidate.distance } : {}),
      ...(candidate.relationKind ? { relationKind: candidate.relationKind } : {}),
      ...(candidate.evidencePath?.length ? { evidencePath: candidate.evidencePath } : {}),
      ...(degraded ? { degraded: true } : {}),
    }));
    const candidateTrace: SemanticaSelectionTrace['candidateGate'] = {
      status: merged.candidates.length ? 'selected' : 'none',
      inputCount: merged.candidates.length,
      outputCount: merged.candidates.length,
    };
    semanticaTrace = {
      enabled: true,
      entryAssetIds: expanded.entries.map((entry) => entry.assetId),
      deterministicExpansionCount,
      finalExpansionCount: relationMatches.length,
      intentGate: intentTrace,
      candidateGate: candidateTrace,
    };
  }
  const semanticOnly = mergedAssetMatches.filter((match) => match.matchMethod === 'semantic');
  const bestScore = semanticOnly.reduce((best, match) => Math.max(best, match.matchScore), 0);
  const relativeFloor = bestScore * relativeSignificance;
  const acceptedIds = new Set<string>();
  for (const match of mergedAssetMatches) {
    if (match.matchMethod === 'semantic') {
      const score = match.matchScore;
      if (score < minScore || (bestScore > minScore && score < relativeFloor)) {
        omittedRefs.push({ assetId: match.assetId, reason: 'low_relevance' });
        continue;
      }
    }
    acceptedIds.add(match.assetId);
  }
  for (const asset of assets) {
    if (!acceptedIds.has(asset.id)) {
      const alreadyOmitted = omittedRefs.some((ref) => ref.assetId === asset.id && ref.reason === 'low_relevance');
      if (!alreadyOmitted) omittedRefs.push({ assetId: asset.id, reason: 'low_relevance' });
    }
  }

  if (applicabilityContext) {
    const shortlist = mergedAssetMatches.filter(match => acceptedIds.has(match.assetId))
      .map(match => assets.find(asset => asset.id === match.assetId)!);
    const ambiguousIds = ambiguousRecallAssetIds(shortlist, queryText, assets);
    const ambiguous = shortlist.filter(asset => ambiguousIds.has(asset.id));
    if (ambiguous.length) {
      try {
        const { decisions, unassessed } = await assessSemanticApplicability(userId, queryText, ambiguous, applicabilityContext, options.assessApplicability, assets);
        for (const item of unassessed) {
          acceptedIds.delete(item.assetId);
          omittedRefs.push({ assetId: item.assetId, reason: 'prompt_budget', detail: `semantic_applicability_${item.reason}` });
        }
        for (const decision of decisions) {
          const match = mergedAssetMatches.find(match => match.assetId === decision.assetId)!;
          match.semanticAssessment = decision;
          if (decision.verdict !== 'applicable') {
            acceptedIds.delete(decision.assetId);
            omittedRefs.push({ assetId: decision.assetId, reason: 'not_applicable_context', detail: decision.reason });
          }
        }
        // Preserve deterministic rank outside adjudicated ties; the semantic
        // decision selects and orders only the already admitted ambiguous set.
        const slots = mergedAssetMatches.flatMap((match, index) => ambiguousIds.has(match.assetId) ? [index] : []);
        const ordered = slots.map(index => mergedAssetMatches[index]).sort((a, b) => (a.semanticAssessment?.rank ?? 100) - (b.semanticAssessment?.rank ?? 100));
        slots.forEach((slot, index) => { mergedAssetMatches[slot] = ordered[index]; });
      } catch {
        degraded = true;
        for (const asset of ambiguous) {
          acceptedIds.delete(asset.id);
          omittedRefs.push({ assetId: asset.id, reason: 'not_applicable_context', detail: 'semantic_applicability_unresolved' });
        }
      }
    }
  }
  const acceptedAssets = assets.filter((asset) => acceptedIds.has(asset.id));
  // Type diversity: guarantee one highest-ranked asset per type before
  // filling the remaining slots. The hybrid module already gives dual-route
  // evidence priority, so this pass only applies the existing Top-N policy.
  const acceptedMatches = mergedAssetMatches.filter((match) => acceptedIds.has(match.assetId));
  const acceptedById = new Map(acceptedAssets.map((asset) => [asset.id, asset]));
  const orderedMatches = acceptedMatches.filter((match) => acceptedById.has(match.assetId));
  const selectedMatches: typeof orderedMatches = [];
  const seenTypes = new Set<string>();
  for (const match of orderedMatches) {
    const asset = acceptedById.get(match.assetId)!;
    if (seenTypes.has(asset.type)) continue;
    seenTypes.add(asset.type);
    selectedMatches.push(match);
    if (selectedMatches.length >= limit) break;
  }
  if (selectedMatches.length < limit) {
    const picked = new Set(selectedMatches.map((match) => match.assetId));
    for (const match of orderedMatches) {
      if (picked.has(match.assetId)) continue;
      picked.add(match.assetId);
      selectedMatches.push(match);
      if (selectedMatches.length >= limit) break;
    }
  }
  const selectedIds = new Set(selectedMatches.map((match) => match.assetId));
  for (const asset of acceptedAssets) {
    if (!selectedIds.has(asset.id)) omittedRefs.push({ assetId: asset.id, reason: 'low_relevance' });
  }
  return {
    assets: selectedMatches.map((match) => acceptedById.get(match.assetId)!),
    assetMatches: selectedMatches,
    degraded,
    ...(semanticaTrace ? { semanticaTrace } : {}),
  };
}

export async function buildRecallView(userId: string, input: ProjectionInput, options: ProjectionSemanticOptions = {}): Promise<BuildRecallViewResult> {
  const purpose = normalizeTerm(input.purpose, 'purpose', 120);
  const taskText = normalizeOptionalTerm(input.taskText, 'task text', Number.MAX_SAFE_INTEGER);
  const purposeContext = [purpose, taskText].filter(Boolean).join('\n');
  const assets = await listAbilityAssets(userId);
  const refs = input.workspaceId ? await listWorkspaceAssetReferences(userId) : [];
  const refsByAsset = new Map(refs.filter((ref) => !input.workspaceId || ref.workspaceId === input.workspaceId).map((ref) => [ref.assetId, ref]));
  const includedAssets: RecallAbilityAssetRecord[] = [];
  const omittedRefs: OmittedAssetRef[] = [];
  for (const asset of assets) {
    const inactiveReason = inactiveAssetOmissionReason(asset.status);
    if (inactiveReason) { omittedRefs.push({ assetId: asset.id, reason: inactiveReason }); continue; }
    if (!isAssetScopeAllowed(asset.scopePolicy, {
      purpose: purposeContext,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.roleId ? { roleId: input.roleId } : {}),
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      ...(input.conversationKind ? { conversationKind: input.conversationKind } : {}),
      ...(input.fileKinds !== undefined ? { fileKinds: input.fileKinds } : {}),
    })) {
      omittedRefs.push({ assetId: asset.id, reason: 'scope_mismatch' });
      continue;
    }
    const ref = input.workspaceId ? refsByAsset.get(asset.id) : undefined;
    // 资产池全局共享——空间会话可引用
    // **整个资产池**（含其它空间产生的资产与全局资产）；只有资产 tab
    // 显示按空间过滤（listAbilityAssetsForSpace）。workspace-ref 只是可选
    // 收紧控制（显式停用/scope 词），不是引用前置。
    // 任务类型词闸门只约束"特定任务类型"的 scope（如 review/report）；
    // 'space'（空间适用）/ 'general'（通用）不按 purpose 过滤。
    if (ref && !ref.enabled) { omittedRefs.push({ assetId: asset.id, reason: 'workspace_disabled' }); continue; }
    if (ref && !scopeAppliesToPurpose(ref.scope, purposeContext)) { omittedRefs.push({ assetId: asset.id, reason: 'scope_mismatch' }); continue; }
    if (!ref && !scopeAppliesToPurpose(asset.scope, purposeContext)) { omittedRefs.push({ assetId: asset.id, reason: 'scope_mismatch' }); continue; }
    includedAssets.push(asset);
  }

  // Ranking runs only on real task text: a short purpose label (e.g.
  // 'review') is not a meaningful query, and skipping the embed avoids
  // blocking calls when no task text exists.
  const selection = await applySemanticSelection(userId, includedAssets, taskText, options, omittedRefs, purpose, input.workspaceId, input.projectId);
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
    assetVersions: Object.fromEntries(orderedAssets.map((asset) => [asset.id, abilityAssetActiveVersion(asset)])),
    ...(assetMatches ? { assetMatches } : {}),
    sourceRefs,
    omittedRefs,
    ...(selection.degraded ? { degraded: true as const } : {}),
    ...(selection.semanticaTrace ? { semanticaTrace: selection.semanticaTrace } : {}),
  };
}

/** 显式挂载时「与目的地无关」的阻断原因：不依赖 taskText /
 *  接收者 Agent，attach 当场就能定论，必须立刻拦下并给出规则码。
 *  依赖目的地上下文的维度（scope_mismatch / target_agent_not_allowed /
 *  not_applicable_context）在接收者未知时推迟到
 *  每轮注入闸门判定——那里知道真实 agentId 与任务文本，且被拦会留 omitted
 *  回执供界面说明，不会静默。 */
const ATTACH_BLOCKING_REASONS: ReadonlySet<AssetRuntimeBlockReason> = new Set([
  'status_not_active',
  'source_unavailable',
  'maturity_below_default_use',
]);

function explicitAttachError(
  code: ProjectionKnowledgeErrorCode,
  message: string,
  blockRule?: string,
): Error & { code: ProjectionKnowledgeErrorCode; blockRule?: string } {
  return Object.assign(new Error(message), { code, ...(blockRule ? { blockRule } : {}) });
}

/** 具体规则标识：`code` 只够分类（inactive / ineligible / source_unavailable），
 *  用户要的是"到底哪条规则拦的我"。映射收敛在
 *  `formal-assets/runtime.ts::assetRuntimeBlockRule`，与每轮注入的 omitted 留痕
 *  共用同一份——两处说法才不会打架。 */
function explicitBlockError(
  reasons: readonly AssetRuntimeBlockReason[],
  assetId: string,
  assetStatus: string,
) {
  const rule = assetRuntimeBlockRule(assetStatus, reasons);
  if (rule === 'inactive' || ['paused', 'archived', 'revoked', 'deleted', 'purged'].includes(rule)) {
    return explicitAttachError('projection_asset_inactive', `explicit projection asset is not active: ${assetId}`, rule);
  }
  if (rule === 'source_unavailable') {
    return explicitAttachError('projection_source_unavailable', `explicit projection source is unavailable: ${assetId}`, rule);
  }
  return explicitAttachError('projection_asset_ineligible', `explicit projection asset is not eligible: ${assetId}`, rule);
}

/** 显式资产绕过语义选择并固定当前在用版，仍须通过权限、状态、作用域、
 * 目标 Agent、敏感级和来源可用性校验。失败返回稳定规则码，界面按码本地化，
 * 不展示原始错误或正文。 */
async function buildExplicitAssetView(
  userId: string,
  assetIds: string[],
  context: AssetRuntimeContext,
): Promise<BuildRecallViewResult> {
  const ids = [...new Set(assetIds)].slice(0, 12);
  if (!ids.length) throw new Error('explicit projection requires at least one asset');
  const { readAbilityAsset } = await import('./asset-service');
  const assets = [];
  for (const id of ids) {
    let asset: Awaited<ReturnType<typeof readAbilityAsset>>;
    try {
      asset = await readAbilityAsset(userId, id);
    } catch (err) {
      // 保留原消息（既有断言与日志口径），只补码与规则标识：界面据此说「资产
      // 不存在或已彻底删除」，而不是把英文原文甩给用户。
      throw explicitAttachError(
        'projection_asset_missing',
        (err as Error)?.message || `recall ability asset not found: ${id}`,
        'missing',
      );
    }
    if (asset.status !== 'active') {
      throw explicitBlockError(['status_not_active'], id, asset.status);
    }
    const { evaluateRecallAssetRuntimeEligibility } = await import('./prompt-injection');
    const gate = await evaluateRecallAssetRuntimeEligibility(userId, {
      ...asset,
      scopePolicy: projectionPurposeIsDeferred(undefined, context.purpose || '')
        ? scopePolicyWithoutPurposeTags(asset.scopePolicy)
        : asset.scopePolicy,
    }, { ...context, operation: 'explicit_use' });
    const blocking = context.agentId
      ? gate.reasons
      : gate.reasons.filter((reason) => ATTACH_BLOCKING_REASONS.has(reason));
    if (!gate.eligible && blocking.length) throw explicitBlockError(blocking, id, asset.status);
    assets.push(asset);
  }
  return {
    assetIds: assets.map((asset) => asset.id),
    assetVersions: Object.fromEntries(assets.map((asset) => [asset.id, abilityAssetActiveVersion(asset)])),
    sourceRefs: assets.flatMap((asset) => (asset.evidenceRefs || []).slice(0, 3).map((ref) => ({ kind: ref.kind, id: ref.id }))),
    omittedRefs: [] as OmittedAssetRef[],
    assetMatches: assets.map((asset) => ({ assetId: asset.id, matchScore: 1, matchMethod: 'manual' as const })),
    degraded: false,
  };
}

/** preview 态投影的缺省有效期：调用方不传 expiresAt 时按此兜底，
 *  避免未 confirm 的预览投影无过期时间永久滞留。 */
const PREVIEW_PROJECTION_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export async function previewContextProjection(userId: string, input: ProjectionInput, options: ProjectionSemanticOptions = {}): Promise<ContextProjectionRecord> {
  const taskRunId = normalizeTerm(input.taskRunId, 'task run id', 160);
  const conversationId = input.conversationId === undefined ? undefined : normalizeTerm(input.conversationId, 'conversation id', 160);
  const conversationContext = await resolveProjectionConversationContext(userId, conversationId);
  const projectId = input.projectId === undefined
    ? conversationContext.projectId
    : normalizeTerm(input.projectId, 'project id', 160);
  if (projectId && !safeId(projectId)) throw new Error('invalid projection project id');
  const purpose = normalizeTerm(input.purpose, 'purpose', 120);
  const workspaceId = input.workspaceId === undefined
    ? conversationContext.workspaceId
    : normalizeTerm(input.workspaceId, 'workspace id', 160);
  if (workspaceId && !safeId(workspaceId)) throw new Error('invalid projection workspace id');
  const agentId = input.agentId === undefined
    ? undefined
    : normalizeOptionalScopeId(input.agentId, 'agent id');
  const roleId = normalizeOptionalScopeId(input.roleId, 'role id');
  const conversationKind = input.conversationKind === undefined
    ? conversationContext.conversationKind
    : normalizeOptionalScopeId(input.conversationKind, 'conversation kind');
  const fileKinds = normalizeProjectionFileKinds(input.fileKinds);
  const taskText = normalizeOptionalTerm(input.taskText, 'task text', Number.MAX_SAFE_INTEGER);
  const authorization: ProjectionAuthorization = input.authorization || 'user_confirmed';
  if (authorization !== 'user_confirmed' && authorization !== 'workspace_policy' && authorization !== 'not_required' && authorization !== 'model_selected') throw new Error('invalid projection authorization');
  if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) throw new Error('invalid projection expiry');
  const view = input.explicitAssetIds?.length
    ? await buildExplicitAssetView(userId, input.explicitAssetIds, {
      purpose: [purpose, taskText].filter(Boolean).join('\n'),
      ...(projectId ? { projectId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(roleId ? { roleId } : {}),
      ...(conversationKind ? { conversationKind } : {}),
      ...(fileKinds !== undefined ? { fileKinds } : {}),
      ...(taskText ? { taskText } : {}),
    })
    : await buildRecallView(userId, {
      taskRunId, purpose,
      ...(projectId ? { projectId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(roleId ? { roleId } : {}),
      ...(conversationKind ? { conversationKind } : {}),
      ...(fileKinds !== undefined ? { fileKinds } : {}),
      ...(taskText ? { taskText } : {}),
    }, options);
  const now = projectionNowIso();
  const confirmedAt = input.confirm ? now : undefined;
  const expiresAt = input.expiresAt
    ?? (confirmedAt ? undefined : new Date(Date.parse(now) + PREVIEW_PROJECTION_DEFAULT_EXPIRY_MS).toISOString());
  const record: ContextProjectionRecord = {
    schemaVersion: 2, ownerId: userId, id: `proj-${genId12()}`,
    taskRunId, ...(projectId ? { projectId } : {}), ...(workspaceId ? { workspaceId } : {}),
    ...(agentId ? { agentId } : {}), ...(roleId ? { roleId } : {}),
    ...(conversationKind ? { conversationKind } : {}), ...(fileKinds !== undefined ? { fileKinds } : {}),
    ...(conversationId ? { conversationId } : {}), purpose, authorization,
    assetIds: view.assetIds, ...(view.assetVersions ? { assetVersions: view.assetVersions } : {}), ...(view.assetMatches ? { assetMatches: view.assetMatches } : {}), sourceRefs: view.sourceRefs, omittedRefs: view.omittedRefs,
    ...(expiresAt ? { expiresAt } : {}),
    ...(view.degraded ? { selectionDegraded: true } : {}),
    ...(view.semanticaTrace ? { semanticaTrace: view.semanticaTrace } : {}),
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
  standingOnly = false,
): Promise<ContextProjectionRecord | undefined> {
  const taskRunId = normalizeTerm(input.taskRunId, 'task run id', 160);
  const taskText = normalizeTerm(input.taskText, 'task text', Number.MAX_SAFE_INTEGER);
  const conversationId = input.conversationId === undefined
    ? undefined
    : normalizeTerm(input.conversationId, 'conversation id', 160);
  const conversationContext = await resolveProjectionConversationContext(userId, conversationId);
  const projectId = input.projectId === undefined
    ? conversationContext.projectId
    : normalizeTerm(input.projectId, 'project id', 160);
  if (projectId && !safeId(projectId)) throw new Error('invalid projection project id');
  const workspaceId = input.workspaceId === undefined
    ? conversationContext.workspaceId
    : normalizeTerm(input.workspaceId, 'workspace id', 160);
  if (workspaceId && !safeId(workspaceId)) throw new Error('invalid projection workspace id');
  const agentId = input.agentId === undefined
    ? undefined
    : normalizeOptionalScopeId(input.agentId, 'agent id');
  const roleId = normalizeOptionalScopeId(input.roleId, 'role id');
  const conversationKind = input.conversationKind === undefined
    ? conversationContext.conversationKind
    : normalizeOptionalScopeId(input.conversationKind, 'conversation kind');
  const fileKinds = normalizeProjectionFileKinds(input.fileKinds);
  const id = automaticProjectionId(standingOnly ? `${taskRunId}-standing-preferences` : taskRunId, workspaceId);
  const existing = await readRecallJsonRecord(userId, 'projections', id);
  if (existing) {
    const projection = asProjection(existing);
    if (projection.status === 'confirmed') return projection;
  }

  // 正文自动注入默认关闭，知识发现由常驻目录及模型主动读取承担。
  // COGSEED_RECALL_BASELINE_TOP=N>0 可显式启用自动选择 N 条正文。
  // 普通资产仍受自动选择开关约束；本人保存决定核对过的长期回答偏好
  // 按独立边界带入，不因此升级成熟度或取得工具执行授权。
  const baselineTopEnv = process.env.COGSEED_RECALL_BASELINE_TOP;
  const baselineTop = baselineTopEnv === undefined || baselineTopEnv.trim() === '' ? Number.NaN : Number(baselineTopEnv);
  const baselineEnabled = Number.isFinite(baselineTop) && baselineTop > 0;
  // Semantica is a separate explicit opt-in; skip qualification IO only when
  // both automatic reuse paths are disabled.
  const generalSelectionEnabled = !standingOnly && (baselineEnabled || isSemanticaEnabled(userId));
  const { isStandingPreferenceAsset, hasUserAuthorizedStandingPreference } = await import('./standing-preference');

  const sourcesAvailable = createAssetSourceAvailability(userId);
  const allAssets = await listAbilityAssets(userId);
  const workspaceRefs = workspaceId ? await listWorkspaceAssetReferences(userId) : [];
  const workspaceRefsByAsset = new Map(
    workspaceRefs
      .filter((ref) => ref.workspaceId === workspaceId)
      .map((ref) => [ref.assetId, ref]),
  );
  const eligibleAssets: RecallAbilityAssetRecord[] = [];
  const standingPreferences: RecallAbilityAssetRecord[] = [];
  const omittedRefs: OmittedAssetRef[] = [];
  for (const asset of allAssets) {
    if (!generalSelectionEnabled && !isStandingPreferenceAsset(asset)) continue;
    const inactiveReason = inactiveAssetOmissionReason(asset.status);
    if (inactiveReason) {
      omittedRefs.push({ assetId: asset.id, reason: inactiveReason });
      continue;
    }
    const workspaceRef = workspaceRefsByAsset.get(asset.id);
    if (workspaceRef && !workspaceRef.enabled) {
      omittedRefs.push({ assetId: asset.id, reason: 'workspace_disabled' });
      continue;
    }
    // 资产池全局共享：空间会话的自动注入可引用整个
    // 池子（含其它空间资产与全局资产）；tab 显示才按空间过滤。
    if (!(await sourcesAvailable(asset))) {
      omittedRefs.push({ assetId: asset.id, reason: 'source_unavailable' });
      continue;
    }
    // 普通资产的默认准入规则照旧。唯一窄例外是与完整来源和本人保存决定
    // 绑定的长期回答偏好：携带完整条件作为待适用性判断的 guidance，
    // 不冒称效果验证或本轮新点击，来源、权限与禁止范围仍走同一闸门。
    const { evaluateRecallAssetRuntimeEligibility } = await import('./prompt-injection');
    const runtime = await evaluateRecallAssetRuntimeEligibility(userId, asset, {
      operation: 'default_injection',
      purpose: taskText,
      ...(taskText ? { taskText } : {}),
      ...(agentId ? { agentId } : {}),
      ...(roleId ? { roleId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(conversationKind ? { conversationKind } : {}),
      ...(fileKinds !== undefined ? { fileKinds } : {}),
    }, sourcesAvailable);
    if (!runtime.eligible) {
      omittedRefs.push({ assetId: asset.id, reason: RUNTIME_OMISSION_REASON[runtime.reasons[0]] || 'source_unavailable' });
      continue;
    }
    if (await hasUserAuthorizedStandingPreference(userId, asset)) standingPreferences.push(asset);
    else if (generalSelectionEnabled) eligibleAssets.push(asset);
  }
  if (!eligibleAssets.length && !standingPreferences.length) return undefined;

  const selection: SemanticSelection = eligibleAssets.length
    ? await applySemanticSelection(userId, eligibleAssets, taskText, options, omittedRefs, input.taskText, workspaceId, projectId,
      { projectId, workspaceId, agentId, roleId, conversationKind, fileKinds })
    : { assets: [], degraded: false };
  standingPreferences.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  const combined = [...standingPreferences, ...selection.assets];
  const selectedAssets = combined.slice(0, 12);
  const overflow = combined.slice(12);
  for (const asset of overflow) omittedRefs.push({ assetId: asset.id, reason: 'prompt_budget' });
  // An all-unassessed result has no projection to carry omittedRefs. Keep the
  // existing omission receipt so budget overflow is still observable without
  // creating an empty confirmed projection or changing the return contract.
  const semanticOmissions = omittedRefs.filter(ref => ref.reason === 'prompt_budget'
    && ref.detail?.startsWith('semantic_applicability_'));
  if (semanticOmissions.length) {
    const { recordInjectionReceipt } = await import('./injection-receipt');
    for (const ref of semanticOmissions) {
      const asset = eligibleAssets.find(asset => asset.id === ref.assetId)!;
      await recordInjectionReceipt(userId, { taskRunId, ...(selectedAssets.length ? { projectionId: id } : {}),
        assetId: asset.id, assetVersion: abilityAssetActiveVersion(asset),
        status: 'omitted', boundary: 'real', channel: 'projection', reason: 'prompt_budget' });
    }
  }
  if (!selectedAssets.length) return undefined;

  const now = projectionNowIso();
  const selectedIds = new Set(selectedAssets.map((asset) => asset.id));
  const record: ContextProjectionRecord = {
    schemaVersion: 2,
    ownerId: userId,
    id,
    taskRunId,
    ...(projectId ? { projectId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(roleId ? { roleId } : {}),
    ...(conversationKind ? { conversationKind } : {}),
    ...(fileKinds !== undefined ? { fileKinds } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(selection.degraded ? { selectionDegraded: true } : {}),
    ...(selection.semanticaTrace ? { semanticaTrace: selection.semanticaTrace } : {}),
    purpose: 'conversation_reply',
    authorization: 'not_required',
    assetIds: selectedAssets.map((asset) => asset.id),
    assetVersions: Object.fromEntries(selectedAssets.map((asset) => [asset.id, abilityAssetActiveVersion(asset)])),
    assetMatches: [...standingPreferences.filter(asset => selectedIds.has(asset.id)).map(asset => ({ assetId: asset.id, matchScore: 1, matchMethod: 'standing_preference' as const })),
      ...(selection.assetMatches || []).filter(match => selectedIds.has(match.assetId))],
    sourceRefs: sourceRefsForAssets(selectedAssets),
    omittedRefs,
    status: 'confirmed',
    createdAt: now,
    confirmedAt: now,
    decidedAt: now,
  };
  await writeRecallJsonRecord(userId, 'projections', record.id, record);
  if (overflow.length) {
    const { recordInjectionReceipt } = await import('./injection-receipt');
    for (const asset of overflow) await recordInjectionReceipt(userId, { taskRunId, projectionId: record.id,
      assetId: asset.id, assetVersion: abilityAssetActiveVersion(asset), status: 'omitted', boundary: 'real', channel: 'projection', reason: 'prompt_budget' });
  }
  return record;
}

/** Standing intent comes from the earlier human save, not a fresh click or a
 * maturity/effectiveness grant; the ordinary renderer retains exact citations. */
export async function createStandingPreferenceContextProjection(userId: string, input: AutomaticProjectionInput): Promise<ContextProjectionRecord | undefined> {
  return createAutomaticContextProjection(userId, input, {}, true);
}

async function validateFrozenProjectionAssets(
  userId: string,
  projection: ContextProjectionRecord,
  requireCommitted: boolean,
  runtimeScope: AssetScopeContext = {},
  assetsById?: ReadonlyMap<string, RecallAbilityAssetRecord>,
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
  const sourcesAvailable = createAssetSourceAvailability(userId);
  const out: Record<string, string> = {};
  for (const assetId of projection.assetIds) {
    let asset: RecallAbilityAssetRecord;
    try {
      // 快照预载：调用链上游本轮已读过的记录直接复用，miss 才回退直读
      // （预读瞬时失败而资产实际存在时，这里仍按原语义读到并继续判定）。
      asset = assetsById?.get(assetId) ?? await readAbilityAsset(userId, assetId);
    } catch {
      throw projectionKnowledgeError('projection_asset_missing');
    }
    if (asset.status !== 'active') {
      // 已确认投影可能长期保留多条资产。用户暂停/归档其中一条时，只从后续
      // 读取集合里排除这条；不让一个停用条目拖垮同一投影里的其他有效资产。
      // 预览确认阶段仍拒绝非 active 条目，只有 committed 读取采用逐条收敛。
      if (requireCommitted) continue;
      throw projectionKnowledgeError('projection_asset_inactive');
    }
    // 版本口径与写入侧一致取在用版（abilityAssetActiveVersion）：select 切过
    // 旧版后 head 计数不动、在用版变了，此时必须报 version_changed，否则
    // 投影会拿着旧口径继续注入。
    if (expected[assetId] !== abilityAssetActiveVersion(asset)) {
      let frozen = projection.purpose === 'user_pinned';
      if (frozen) {
        const cached = projection.assetVersionSnapshots?.[assetId];
        frozen = cached?.version === expected[assetId];
        if (!frozen) {
          const { readAbilityAssetVersionSnapshot } = await import('./asset-service');
          frozen = Boolean(await readAbilityAssetVersionSnapshot(userId, assetId, expected[assetId]));
        }
      }
      if (!frozen) throw projectionKnowledgeError('projection_asset_version_changed');
    }
    if (!(await isAssetEligibleForProjection(userId, asset, projection, runtimeScope))) {
      // A committed projection can be presented again from a different live
      // project/space/task. Scope policy is evaluated against that runtime
      // context, so omit the out-of-scope item while keeping other frozen
      // assets usable. Preview/confirmation still reject an ineligible asset.
      if (requireCommitted) continue;
      // 已确认投影按当前作用域逐项收敛，保留其他可用冻结资产；
      // 预览和未确认投影仍严格拒绝，缺失、停用及版本漂移使用各自错误码。
      if (isCommittedProjection(projection)) continue;
      throw projectionKnowledgeError('projection_asset_ineligible');
    }
    if (!await sourcesAvailable(asset)) throw projectionKnowledgeError('projection_source_unavailable');
    out[assetId] = expected[assetId];
  }
  return out;
}

/** 确认或预览时按调用方传入的 project/space/task 作用域复核资产资格。
 * 作用域可选，省略时保留旧调用方的空作用域语义。 */
export function validateProjectionAssetVersions(
  userId: string,
  projection: ContextProjectionRecord,
  runtimeScope: AssetScopeContext = {},
  assetsById?: ReadonlyMap<string, RecallAbilityAssetRecord>,
): Promise<Record<string, string>> {
  return validateFrozenProjectionAssets(userId, projection, false, runtimeScope, assetsById);
}

export function validateCommittedProjectionAssetVersions(
  userId: string,
  projection: ContextProjectionRecord,
  runtimeScope: AssetScopeContext = {},
  assetsById?: ReadonlyMap<string, RecallAbilityAssetRecord>,
): Promise<Record<string, string>> {
  // 返回当前仍可读取的版本子集；非 active 是逐条停用，正文版本或权限漂移仍整组拒绝。
  return validateFrozenProjectionAssets(userId, projection, true, runtimeScope, assetsById);
}

/** 系统级版本递增后同步刷新存活 committed 投影的 assetVersions。
 * 仅更新版本号快照，注入正文仍使用确认时冻结的内容；返回刷新数量。 */
/** 全量列举 confirmed 投影（不过 listContextProjections——它 clamp 条数，
 *  存量超过时最老的投影漏掉。版本删除冻结副本（asset-service）等"必须
 *  一个不漏"的消费方用这个；条数敏感的常规列表仍走 listContextProjections）。 */
export async function listAllConfirmedProjections(userId: string): Promise<ContextProjectionRecord[]> {
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
  const confirmed: ContextProjectionRecord[] = [];
  for (const raw of records) {
    if (!raw) continue;
    try {
      const projection = asProjection(raw);
      if (isCommittedProjection(projection)) confirmed.push(projection);
    } catch {
      continue;
    }
  }
  return confirmed;
}

/** 彻底清除的级联段：把一条资产从**全部**投影里摘掉。
 *
 *  为什么必须做：`assetVersionSnapshots` 是「版本真删」时为已确认注入冻结的
 *  **内容副本**（`deleteAbilityAssetVersion` 写入），正文就在里面。只清主记录
 *  和版本流，副本仍留在投影文件里——那不算「内容与记录一并清除」。
 *  `assetVersions`（版本指针）与 `assetMatches`（匹配元信息）一并摘除：
 *  留着只会继续产出指向空墓的引用。
 *
 *  读时 gate（prompt-injection 的 `evaluateRecallAssetRuntimeEligibility`）是
 *  第二道防线：它保证"不给模型"，但盘上有没有，得靠这里。
 *
 *  幂等：不引用该资产的投影原样不动、不写回；返回清理过的投影数。
 */
export async function clearAssetFromAllProjections(userId: string, assetId: string): Promise<number> {
  if (!safeId(assetId)) throw new Error('invalid ability asset id');
  let names: string[];
  try {
    names = await fs.readdir(projectionsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let cleared = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const recordId = name.slice(0, -5);
    const raw = await readRecallJsonRecord(userId, 'projections', recordId);
    if (!raw) continue;
    let projection: ContextProjectionRecord;
    try {
      projection = asProjection(raw);
    } catch {
      // 读不回来的投影本来就不会参与注入；不在清理链里改它。
      continue;
    }
    const referenced = projection.assetIds.includes(assetId)
      || projection.assetVersions?.[assetId] !== undefined
      || projection.assetVersionSnapshots?.[assetId] !== undefined
      || projection.modelSelectedAssetIds?.includes(assetId) === true
      || (projection.assetMatches || []).some((match) => match.assetId === assetId);
    if (!referenced) continue;
    await updateRecallJsonRecord(userId, 'projections', recordId, (current) => {
      if (!current) throw new Error('context projection not found');
      const live = asProjection(current);
      const { [assetId]: _droppedSnapshot, ...snapshots } = live.assetVersionSnapshots || {};
      const { [assetId]: _droppedVersion, ...versions } = live.assetVersions || {};
      return {
        ...live,
        assetIds: live.assetIds.filter((id) => id !== assetId),
        assetVersions: Object.keys(versions).length ? versions : undefined,
        assetVersionSnapshots: Object.keys(snapshots).length ? snapshots : undefined,
        assetMatches: (live.assetMatches || []).filter((match) => match.assetId !== assetId),
        ...(live.modelSelectedAssetIds
          ? { modelSelectedAssetIds: live.modelSelectedAssetIds.filter((id) => id !== assetId) }
          : {}),
      };
    });
    cleared += 1;
  }
  return cleared;
}

export async function refreshCommittedProjectionAssetVersion(
  userId: string,
  assetId: string,
  newVersion: string,
): Promise<number> {
  let refreshed = 0;
  // 全量列举投影文件（不走 listContextProjections——它内部 clamp 到 100 条，
  // 存量超过 100 时最老的 committed 投影会漏刷新，版本强校验继续失败）。
  let names: string[];
  try {
    names = await fs.readdir(projectionsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readRecallJsonRecord(userId, 'projections', name.slice(0, -5))));
  for (const raw of records) {
    if (!raw) continue;
    let projection: ContextProjectionRecord;
    try {
      projection = asProjection(raw);
    } catch {
      continue;
    }
    if (!isCommittedProjection(projection)) continue;
    // A user-pinned projection freezes the content the user chose; a later
    // title edit must not advance it to an unconfirmed body.
    if (projection.purpose === 'user_pinned') continue;
    if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) continue;
    if (!Array.isArray(projection.assetIds) || !projection.assetIds.includes(assetId)) continue;
    if (projection.assetVersions && projection.assetVersions[assetId] === newVersion) continue;
    let overwritten = false;
    await updateRecallJsonRecord(userId, 'projections', projection.id, (inner) => {
      const current = asProjection(inner);
      if (!current.assetVersions || current.assetVersions[assetId] === newVersion) return current;
      // 单调版本守卫：refresh 遍历+读盘期间资产可能又前进了一版，
      // 后到的旧 refresh 不得把投影版本回退——仅当新版本号大于锁内当前值
      // 才覆写；相等、更小、或任一侧 NaN/非数字（比较为 false）一律跳过。
      // 守卫必须在锁内 updater：外层预读通过后锁前仍可能变化。
      const nextVersion = Number(newVersion);
      const currentVersion = Number(current.assetVersions[assetId] ?? 0);
      if (!(nextVersion > currentVersion)) return current;
      current.assetVersions = { ...current.assetVersions, [assetId]: newVersion };
      overwritten = true;
      return current;
    });
    if (overwritten) refreshed += 1;
  }
  return refreshed;
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
  options: { allowedStatuses?: ContextProjectionStatus[]; modelSelection?: { taskRunId: string } } = {},
): Promise<ContextProjectionRecord> {
  const allowedStatuses = options.allowedStatuses || ['preview'];
  const addAssetIds = normalizeProjectionAssetIds(input.addAssetIds, 'addAssetIds');
  const removeAssetIds = normalizeProjectionAssetIds(input.removeAssetIds, 'removeAssetIds');
  const removeSet = new Set(removeAssetIds);
  for (const assetId of addAssetIds) {
    if (removeSet.has(assetId)) throw new Error('context projection asset cannot be both add and remove');
  }

  const updated = await updateRecallJsonRecord(userId, 'projections', projectionId, async (raw) => {
    if (!raw) throw new Error('context projection not found');
    const current = asProjection(raw);
    if (!allowedStatuses.includes(current.status)) throw new Error('context projection cannot be revised');
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

    const priorModelIds = current.modelSelectedAssetIds || [];
    const newlyAddedModelIds = options.modelSelection
      ? addAssetIds.filter((assetId) => !current.assetIds.includes(assetId))
      : [];
    const nextModelIds = [...new Set([...priorModelIds, ...newlyAddedModelIds])]
      .filter((assetId) => finalAssetIdSet.has(assetId));
    const modelSelectionEvents = [
      ...(current.modelSelectionEvents || []),
      ...(options.modelSelection ? [{
        taskRunId: options.modelSelection.taskRunId,
        assetIds: addAssetIds,
        addedAssetIds: newlyAddedModelIds,
        addedAt: new Date().toISOString(),
      }] : []),
    ];

    return {
      ...current,
      ...(input.purpose ? { purpose: normalizeTerm(input.purpose, 'purpose', 120) } : {}),
      ...(input.decisionNote ? { decisionNote: normalizeTerm(input.decisionNote, 'decision note', 1000) } : {}),
      ...(nextModelIds.length ? { modelSelectedAssetIds: nextModelIds } : { modelSelectedAssetIds: undefined }),
      ...(modelSelectionEvents.length ? { modelSelectionEvents } : { modelSelectionEvents: undefined }),
      assetIds: nextAssetIds,
      assetVersions: Object.fromEntries(finalAssets.map((asset) => [asset.id, abilityAssetActiveVersion(asset)])),
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

async function readContextProjections(userId: string): Promise<ContextProjectionRecord[]> {
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
    .map((projection) => projection.status === 'preview' && projection.expiresAt && Date.parse(projection.expiresAt) <= now
      ? { ...projection, status: 'expired' as const }
      : projection)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

export async function listAllContextProjections(userId: string): Promise<ContextProjectionRecord[]> {
  return readContextProjections(userId);
}

export async function listContextProjections(
  userId: string,
  query: ListContextProjectionsQuery = {},
): Promise<ContextProjectionRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 20)));
  return (await readContextProjections(userId))
    .filter((projection) => query.workspaceId === undefined || projection.workspaceId === query.workspaceId)
    .filter((projection) => query.taskRunId === undefined || projection.taskRunId === query.taskRunId)
    .filter((projection) => query.conversationId === undefined
      || projection.conversationId === query.conversationId
      || projection.sourceRefs.some((source) => source.kind === 'conversation' && source.id === query.conversationId))
    .filter((projection) => query.status === undefined || projection.status === query.status)
    .filter((projection) => query.includeExpired === true || projection.status !== 'expired')
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

/** 模型自选投影的追加：同一条投影在任务内可反复追加资产
 *  （"基线 + 模型追加"里的追加）。只对 authorization='model_selected' 开放，
 *  且允许在 confirmed 态追加——这是模型自选线独有的编辑面，用户确认的投影
 *  仍只能在 preview 态改。 */
export async function appendAssetsToModelSelectedProjection(
  userId: string,
  projectionId: string,
  assetIds: string[],
  options: { taskRunId?: string } = {},
): Promise<ContextProjectionRecord> {
  const projection = await readContextProjection(userId, projectionId);
  if (projection.authorization !== 'model_selected') {
    throw new Error('context projection is not model-selected');
  }
  const taskRunId = String(options.taskRunId || projection.taskRunId || '');
  if (!taskRunId) throw new Error('model selection task run is required');
  return reviseContextProjection(userId, projectionId, { addAssetIds: assetIds }, {
    allowedStatuses: ['preview', 'confirmed'],
    modelSelection: { taskRunId },
  });
}

/** 某会话里用户引用被拦的留痕：发送前重检
 *  不再静默丢弃——界面据此在回执卡上说明"最近一轮为什么没带上、是哪条规则"。
 *  只认该会话 `user_confirmed` + `user_pinned` 投影的 omitted 回执，按时间倒序；
 *  只返回标题 + 规则标识 + 轮次，**不含正文**。 */
export async function listConversationOmissions(
  userId: string,
  conversationId: string,
  limit = 20,
): Promise<Array<{ assetId: string; title: string; reason: string; taskRunId: string; createdAt: string }>> {
  if (!safeId(userId) || !safeId(conversationId)) throw new Error('invalid conversation omission query');
  const pinnedIds = new Set((await listContextProjections(userId, { conversationId }))
    .filter((projection) => projection.authorization === 'user_confirmed' && projection.purpose === 'user_pinned')
    .map((projection) => projection.id));
  if (!pinnedIds.size) return [];
  const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 20;
  const { listInjectionReceipts } = await import('./injection-receipt');
  const omissions = (await listInjectionReceipts(userId))
    .map((receipt, index) => ({ receipt, index }))
    .filter(({ receipt }) => receipt.status === 'omitted'
      && (receipt.channel === undefined || receipt.channel === 'projection')
      && receipt.projectionId !== undefined
      && pinnedIds.has(receipt.projectionId))
    // 时间倒序；同一毫秒写入的按 JSONL 追加顺序倒序（写入序才是真正的"更晚"）。
    .sort((left, right) => {
      const byTime = String(right.receipt.createdAt || '').localeCompare(String(left.receipt.createdAt || ''));
      return byTime !== 0 ? byTime : right.index - left.index;
    })
    .slice(0, bounded)
    .map(({ receipt }) => receipt);
  const out: Array<{ assetId: string; title: string; reason: string; taskRunId: string; createdAt: string }> = [];
  for (const omission of omissions) {
    let title = '';
    try {
      title = String((await readAbilityAsset(userId, omission.assetId)).title || '');
    } catch {
      // 资产已删/读不到：标题留空，由界面给泛称——绝不回落内部 id。
      title = '';
    }
    out.push({
      assetId: omission.assetId,
      title,
      reason: String(omission.reason || ''),
      taskRunId: String(omission.taskRunId || ''),
      createdAt: String(omission.createdAt || ''),
    });
  }
  return out;
}

/** 会话里用户 @ 钉住的资产：composer 引用条要显示
 *  「名称 · vN」并支持撤销，但 `listContextProjections` 只给 id 与版本号——渲染层
 *  不得上屏内部 id，所以标题必须在主进程解析好再给。
 *  只认 `user_confirmed` + purpose `user_pinned` 的 confirmed 投影；只返回
 *  `{projectionId, assetId, title, version}`，**不含正文**。 */
export async function listUserPinnedAssets(
  userId: string,
  conversationId: string,
): Promise<Array<{ projectionId: string; assetId: string; title: string; version: string }>> {
  if (!safeId(userId) || !safeId(conversationId)) throw new Error('invalid user pinned asset query');
  const projections = await listContextProjections(userId, { conversationId, status: 'confirmed' });
  const out: Array<{ projectionId: string; assetId: string; title: string; version: string }> = [];
  for (const projection of projections) {
    if (projection.authorization !== 'user_confirmed' || projection.purpose !== 'user_pinned') continue;
    for (const assetId of projection.assetIds) {
      let title = '';
      try {
        title = String((await readAbilityAsset(userId, assetId)).title || '');
      } catch {
        // 资产已删/读不到：标题留空，由界面给泛称——绝不回落内部 id。
        title = '';
      }
      out.push({
        projectionId: projection.id,
        assetId,
        title,
        version: String(projection.assetVersions?.[assetId] || ''),
      });
    }
  }
  return out;
}

/** 撤销一条投影的共用实现：
 *  把 confirmed 置为 revoked——注入查找只认 confirmed，所以撤销后本会话后续
 *  回合不再带入这批资产；已发生的注入/使用记录保留（历史不可改写），重复撤销
 *  幂等。哪一类授权可走撤销线由 `isRevocable` 决定，拒绝消息由调用方给出。 */
async function revokeConfirmedProjection(
  userId: string,
  projectionId: string,
  isRevocable: (projection: ContextProjectionRecord) => boolean,
  rejectionMessage: string,
): Promise<ContextProjectionRecord> {
  if (!safeId(userId) || !safeId(projectionId)) throw new Error('invalid projection revoke input');
  const updated = await updateRecallJsonRecord(userId, 'projections', projectionId, (raw) => {
    if (!raw) throw new Error('context projection not found');
    const current = asProjection(raw);
    if (!isRevocable(current)) throw new Error(rejectionMessage);
    if (current.status === 'revoked') return current;
    if (current.status !== 'confirmed') throw new Error('context projection is not revocable');
    return { ...current, status: 'revoked' as const, decidedAt: new Date().toISOString() };
  });
  return asProjection(updated);
}

/** 撤销"模型自选"的投影：用户自己确认过的语义投影走既有人工流程（避免一键
 *  撤销掉用户明确的决定）。 */
export async function revokeModelSelectedProjection(
  userId: string,
  projectionId: string,
): Promise<ContextProjectionRecord> {
  return revokeConfirmedProjection(
    userId,
    projectionId,
    (projection) => projection.authorization === 'model_selected',
    'context projection is not model-selected',
  );
}

/** 撤销用户自己 @ 钉住的资产：引用回执必须
 *  可撤销，否则"我挂上去的就下不来"。只认 `user_confirmed` + purpose
 *  `user_pinned`（@ 引用与「用到当前对话」写的就是这一类）；用户确认过的语义
 *  投影（`conversation_reply` 等）仍不在这条一键撤销线上，边界与模型自选线一致。 */
export async function revokeUserPinnedProjection(
  userId: string,
  projectionId: string,
): Promise<ContextProjectionRecord> {
  return revokeConfirmedProjection(
    userId,
    projectionId,
    (projection) => projection.authorization === 'user_confirmed' && projection.purpose === 'user_pinned',
    'context projection is not user-pinned',
  );
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
