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
export type CognitionAssetMaturity = 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated';
export type CognitionAssetStatus = 'active' | 'paused' | 'revoked' | 'candidate';

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
