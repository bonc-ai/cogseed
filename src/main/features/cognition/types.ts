export type CognitionCandidateSource = 'personal_ontology' | 'p3394_experience' | 'p3394_patch';
export type CognitionCandidateType = 'preference' | 'ontology' | 'rule' | 'experience' | 'skill_evolution';
export type CognitionCandidateStatus = 'pending' | 'accepted' | 'deferred' | 'rejected';

export type CognitionCandidateAction = 'source' | 'accept' | 'modify' | 'defer' | 'reject' | 'open_personal_ontology' | 'import_to_recall';

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
  maturity: CognitionAssetMaturity;
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
