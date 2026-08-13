// 敏感级别直接复用正式资产的定义，不在这一层另起一套枚举——展示层重新定义
// 分级会让两处日久漂移，而分级是安全语义。
import type { AbilityAssetSensitivity } from '../recall/asset-semantics';

export type CognitionCandidateSource = 'personal_ontology' | 'p3394_experience' | 'p3394_patch';
export type CognitionCandidateType = 'preference' | 'ontology' | 'rule' | 'experience' | 'skill_evolution';
export type CognitionCandidateStatus = 'pending' | 'accepted' | 'deferred' | 'rejected';

// Union merged across both sides: develop added `modify`/`defer`, this branch
// added `deep_review`. Dropping either would silently disable an action the
// renderer already emits.
export type CognitionCandidateAction = 'source' | 'accept' | 'modify' | 'defer'
  | 'reject' | 'deep_review' | 'open_personal_ontology' | 'import_to_recall';

/**
 * Security / admission status — the axis that answers "is this safe to admit".
 *
 * Deliberately separate from `CognitionAssetMaturity`, which answers "has this
 * proven useful". The security spec requires the two never be collapsed into a
 * single "已通过": a candidate can be safe but useless, or desirable but
 * malicious. UI must render them as distinct fields.
 *
 * `unknown` is a first-class state, not a synonym for `pass`: it means no scan
 * is on record (or the scanner was unavailable). Reporting it as `pass` would
 * tell the user content was checked when it wasn't.
 */
export type CognitionSecurityStatus = 'pass' | 'risk' | 'blocked' | 'unknown';

/** Compact projection of a gate decision, sized for list rendering. */
export interface CognitionSecurityView {
  status: CognitionSecurityStatus;
  /** Total findings across both layers. */
  findingCount: number;
  /** Highest-severity rule id, for a one-line explanation. */
  topRule?: string;
  /** Whether the semantic (agent) layer contributed to this verdict. */
  semanticReviewed: boolean;
  /**
   * Set when the semantic layer was expected but unavailable. The status is
   * still authoritative (the deterministic layer ran), but callers should
   * surface "deep review unavailable" rather than implying a full pass.
   */
  degradedReason?: string;
}

export interface CognitionRelationRef {
  type: 'skill' | 'knowledge' | 'ontology' | 'evaluation' | 'conversation' | 'execution' | 'memory' | 'receipt';
  id: string;
  title?: string;
}

export interface CognitionCandidateView {
  id: string;
  source: CognitionCandidateSource;
  sourceId: string;
  type: CognitionCandidateType;
  status: CognitionCandidateStatus;
  title: string;
  summary: string;
  confidence?: 'low' | 'medium' | 'high';
  scope?: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  targetAssetId?: string;
  targetAssetTitle?: string;
  diffAvailable: boolean;
  actions: CognitionCandidateAction[];
  conversationId?: string;
  skillId?: string;
  createdAt?: string;
  updatedAt?: string;
  /**
   * Deterministic admission status, computed at list time for display.
   *
   * Display only — it is recomputed at accept time. A renderer must never be
   * able to admit a candidate by claiming it already passed.
   */
  security?: CognitionSecurityView;
  raw?: unknown;
}

export type CognitionReceiptStatus = 'prepared' | 'succeeded' | 'degraded' | 'rejected';

export interface CognitionReuseReceiptView {
  receiptId: string;
  executionId: string;
  status: CognitionReceiptStatus;
  sourceSessionId?: string;
  sourceContextId?: string;
  targetSessionId: string;
  targetContextId?: string;
  reusedRefs: string[];
  omittedRefs: string[];
  sourceRefs: string[];
  permissionMode: string;
  allowedScopes: string[];
  boundary: 'real' | 'degraded' | 'test-double';
  executionKind?: string;
  agentId?: string;
  conversationId?: string;
  createdAt: string;
  completedAt?: string;
}

export type CognitionAssetType = 'personal' | 'rule' | 'template' | 'skill_method';
// 与 RecallAbilityAssetRecord 的治理状态保持同步，另加展示层特有的 `candidate`
// ——候选还没 promote 成资产，在资产侧没有对应状态。
export type CognitionAssetMaturity = 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated' | 'stable';
export type CognitionAssetStatus =
  | 'active' | 'paused' | 'archived' | 'deleted' | 'purged' | 'revoked' | 'candidate';

export interface CognitionRecallSkillDraftSummary {
  draftHash: string;
  fileCount: number;
  workflowSteps: string[];
  validationOk: boolean;
  recallContext?: {
    assetCount: number;
    sourceCount: number;
  };
}

export interface CognitionAssetSummary {
  id: string;
  type: CognitionAssetType;
  title: string;
  summary?: string;
  source: string;
  version?: string;
  status?: CognitionAssetStatus | string;
  enabled?: boolean;
  category: CognitionAssetType;
  /** Maturity axis: has this proven useful. Never conflate with `security`. */
  maturity: CognitionAssetMaturity;
  /**
   * Security axis: is this safe to use. Independent of `maturity` — an asset
   * can be `effectiveness_validated` and later become `blocked` when the
   * ruleset is updated, without losing its maturity history.
   */
  security?: CognitionSecurityView;
  owner: string;
  scope: string;
  /**
   * 正式资产的边界契约，原样透传自 `RecallAbilityAssetRecord`，不在这一层加工。
   *
   * 下面四个边界字段此前只存在于数据层与能力包交付端（`capability-pack-delivery`
   * 按 `targetAgentIds` 和 `forbiddenWhen` 真实过滤过），展示层却完全看不到，
   * 于是用户无法判断一条资产为什么被带上或被漏掉。
   *
   * 缺失一律表示「没记录过」，不表示「无限制」——尤其 `forbiddenWhen` 为空
   * 只代表没人写过禁用条件，消费方不得据此推断该资产随处可用。
   */
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  /** L0/L1/L2。缺失=没分过级，不等于 L0。L3 被准入闸挡在候选之前，不会出现。 */
  sensitivity?: AbilityAssetSensitivity;
  /** 限定接收方。缺失=不限定；空数组=谁都不给。 */
  targetAgentIds?: string[];
  /** 识别器给出的置信度 0..1；缺失就是缺失，不补默认值。 */
  confidence?: number;
  workspaceRefs: string[];
  receiptRefs: string[];
  candidateRefs: string[];
  baselineSkillRef?: string;
  generatedSkillId?: string;
  recallSkillDraftStatus?: 'failed' | 'draft';
  recallSkillDraftErrorCode?: string;
  recallSkillDraft?: CognitionRecallSkillDraftSummary;
  relationRefs: CognitionRelationRef[];
  candidateCount: number;
  reuseCount: number;
  lastReusedAt?: string;
}

export interface CognitionSkillVersionSummary {
  version: string;
  at: string;
  note?: string;
  runId?: string;
  canRollback: boolean;
}

export interface SkillCognitionSummary {
  skillId: string;
  version?: string;
  baselineStatus: 'available' | 'unversioned';
  pendingCandidateCount: number;
  recentReceipts: CognitionReuseReceiptView[];
  versions: CognitionSkillVersionSummary[];
}

export interface CognitionDashboard {
  counts: {
    skills: number;
    pendingCandidates: number;
    receipts: number;
    assets: number;
  };
  pendingCandidates: CognitionCandidateView[];
  recentReceipts: CognitionReuseReceiptView[];
  warnings: Array<{ code: string; count: number }>;
  degraded: boolean;
}
