import type { RecallAbilityAssetScopePolicy } from '../recall/scope-policy';

export type CognitionCandidateSource = 'personal_ontology';
export type CognitionCandidateType = 'preference' | 'ontology' | 'rule' | 'experience' | 'skill_evolution';
// P-r1-17：八值联合里六个动作值（source/accept/modify/defer/reject/deep_review）
// 只由 actionsForCandidate 的非本体分支生产，而唯一调用方恒传 'personal_ontology'
// ——六值零生产零消费，分支已删。候选确认的活出口是
// recall.candidates.importPersonalOntology（「待我处理」确认闸），不经这里。
export type CognitionCandidateAction = 'open_personal_ontology' | 'import_to_recall';

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
  // P-r1-1：个人本体候选池是追加式 md 文件，没有状态机——唯一映射口恒置
  // 'pending'，原四态联合里 accepted/deferred/rejected 零生产，类型已收窄。
  status: 'pending';
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

export type CognitionAssetType = 'cognition' | 'personal' | 'rule' | 'template' | 'skill_method' | 'fact';
// 与 RecallAbilityAssetRecord 的治理状态保持同步，另加展示层特有的 `candidate`
// ——候选还没 promote 成资产，在资产侧没有对应状态。
// PRD 3.6 的成熟度阶梯顶到 effectiveness_validated。曾经多出的 'stable' 档
// 从未被任何代码写入（setAbilityAssetMaturity 只写 transfer_validated 与
// effectiveness_validated），是个到不了的状态，已移除。
export type CognitionAssetMaturity = 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated';
export type CognitionAssetStatus =
  | 'active' | 'paused' | 'archived' | 'deleted' | 'purged' | 'revoked' | 'candidate';

// P-r3-1（2026-10-01 死代码真删批）：以下字段已整删，登记备查——
// lifecycleStatus（正式资产侧已退役仍在此透传）、candidateCount/reuseCount/
// lastReusedAt（每列表做候选池+回执读盘只为算三个零消费计数，enrichAssetCounts
// 已删）、workspaceRefs/receiptRefs（恒空数组）、baselineSkillRef（恒 undefined）、
// generatedSkillId/recallSkillDraft*（每个 skill 资产 3-7 次读盘、零渲染消费，
// skill 草稿详情有自己的活读口 recall.skillDraft.*）。渲染层唯一消费方
// （conversation-info.js 认知资产段）只用 id/title/summary/type/category/
// relationRefs/candidateRefs。

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
  scopePolicy?: RecallAbilityAssetScopePolicy;
  recommendedAction?: 'pause' | 'rework';
  recommendationReason?: string;
  recommendationAt?: string;
  candidateRefs: string[];
  relationRefs: CognitionRelationRef[];
}

export interface CognitionSkillVersionSummary {
  version: string;
  revisionId?: string;
  parentRevisionId?: string;
  at: string;
  note?: string;
  runId?: string;
  operation?: 'install' | 'upgrade' | 'manual_edit' | 'rollback' | 'migration';
  manifestHash?: string;
  rollbackScope?: 'full_tree' | 'skill_md_only';
  restoredFromVersion?: string;
  sourceAssetId?: string;
  sourceAssetVersion?: string;
  securityOutcome?: 'pass' | 'restricted' | 'unknown';
  canRollback: boolean;
}

export interface CognitionSkillRollbackPreview {
  skillId: string;
  currentVersion?: string;
  currentRevisionId?: string;
  currentManifestHash?: string;
  targetVersion: string;
  targetRevisionId?: string;
  targetManifestHash?: string;
  nextVersion?: string;
  rollbackScope: 'full_tree' | 'skill_md_only';
  diff?: import('../skills/version-diff').SkillTreeDiff;
}

export interface SkillCognitionSummary {
  skillId: string;
  version?: string;
  currentRevisionId?: string;
  currentManifestHash?: string;
  installedAssetVersion?: string;
  sourceAssetId?: string;
  baselineStatus: 'available' | 'unversioned';
  recentReceipts: CognitionReuseReceiptView[];
  versions: CognitionSkillVersionSummary[];
}
