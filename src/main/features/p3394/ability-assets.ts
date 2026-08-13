import { safeId } from '../../storage';

export type AbilityAssetType = 'personal' | 'rule' | 'template' | 'skill_method';
export type AssetStatus = 'active' | 'paused' | 'revoked';
export type AssetMaturity = 'seed' | 'transfer_validated' | 'effectiveness_validated';

export interface AbilityAssetScope {
  purpose_tags: string[];
  agent_ids?: string[];
  role_ids?: string[];
  project_ids?: string[];
  workspace_ids?: string[];
  conversation_kinds?: string[];
  file_kinds?: string[];
}

export interface AbilityAsset {
  id: string;
  source_candidate_id: string;
  source_run_id: string;
  type: AbilityAssetType;
  capability_statement: string;
  scope: AbilityAssetScope;
  evidence_refs: Array<{ kind: 'episode' | 'kb_md' | 'candidate'; id: string }>;
  workspace_refs: Array<{ workspace_id: string; enabled: boolean }>;
  status: AssetStatus;
  maturity: AssetMaturity;
  version: number;
  versions: Array<{
    version: number;
    statement: string;
    scope: AbilityAssetScope;
    changed_at: string;
    reason: string;
  }>;
  recommended_action?: 'pause' | 'rework';
  audit: Array<{ action: string; at: string; by: 'user' | 'system' }>;
  created_at: string;
  updated_at: string;
}

export interface AssetActor {
  by: 'user' | 'system';
  id?: string;
}

export interface CreateAbilityAssetInput {
  id: string;
  sourceCandidateId: string;
  sourceRunId: string;
  type: AbilityAssetType;
  capabilityStatement: string;
  scope: AbilityAssetScope;
  evidenceRefs: AbilityAsset['evidence_refs'];
  workspaceRefs: AbilityAsset['workspace_refs'];
  actor: AssetActor;
  createdAt: string;
}

export interface UpdateAbilityAssetInput {
  capabilityStatement?: string;
  scope?: AbilityAssetScope;
  reason: string;
  actor: AssetActor;
  at: string;
}

const ASSET_TYPES = new Set<AbilityAssetType>(['personal', 'rule', 'template', 'skill_method']);
const ASSET_STATUSES = new Set<AssetStatus>(['active', 'paused', 'revoked']);
const EVIDENCE_KINDS = new Set<AbilityAsset['evidence_refs'][number]['kind']>([
  'episode',
  'kb_md',
  'candidate',
]);
const SCOPE_ID_FIELDS = [
  'agent_ids',
  'role_ids',
  'project_ids',
  'workspace_ids',
] as const;

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid ${label}`);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (!safeId(value)) throw new Error(`invalid ${label}`);
}

function assertActor(actor: AssetActor): void {
  if (!actor || (actor.by !== 'user' && actor.by !== 'system')) throw new Error('invalid asset actor');
  if (actor.id !== undefined) assertSafeId(actor.id, 'asset actor id');
}

function assertUserActor(actor: AssetActor): void {
  assertActor(actor);
  if (actor.by !== 'user') throw new Error('ability asset action requires a user actor');
}

function assertTimestamp(value: string): void {
  assertNonEmptyString(value, 'asset timestamp');
}

function assertScope(scope: AbilityAssetScope): void {
  if (!scope || !Array.isArray(scope.purpose_tags)) throw new Error('invalid ability asset scope');
  for (const tag of scope.purpose_tags) assertNonEmptyString(tag, 'scope purpose tag');

  for (const field of SCOPE_ID_FIELDS) {
    const values = scope[field];
    if (values === undefined) continue;
    if (!Array.isArray(values)) throw new Error(`invalid scope ${field.replace(/_ids$/, '')} ids`);
    for (const id of values) {
      assertSafeId(id, `scope ${field.replace(/_ids$/, '')} id`);
    }
  }

  for (const [field, values] of [
    ['conversation kind', scope.conversation_kinds],
    ['file kind', scope.file_kinds],
  ] as const) {
    if (values === undefined) continue;
    if (!Array.isArray(values)) throw new Error(`invalid scope ${field}s`);
    for (const value of values) assertSafeId(value, `scope ${field}`);
  }
}

function cloneScope(scope: AbilityAssetScope): AbilityAssetScope {
  return {
    purpose_tags: [...scope.purpose_tags],
    ...(scope.agent_ids ? { agent_ids: [...scope.agent_ids] } : {}),
    ...(scope.role_ids ? { role_ids: [...scope.role_ids] } : {}),
    ...(scope.project_ids ? { project_ids: [...scope.project_ids] } : {}),
    ...(scope.workspace_ids ? { workspace_ids: [...scope.workspace_ids] } : {}),
    ...(scope.conversation_kinds ? { conversation_kinds: [...scope.conversation_kinds] } : {}),
    ...(scope.file_kinds ? { file_kinds: [...scope.file_kinds] } : {}),
  };
}

function cloneVersions(asset: AbilityAsset): AbilityAsset['versions'] {
  return asset.versions.map((entry) => ({ ...entry, scope: cloneScope(entry.scope) }));
}

function cloneAudit(asset: AbilityAsset): AbilityAsset['audit'] {
  return asset.audit.map((entry) => ({ ...entry }));
}

function auditEntry(
  action: string,
  actor: AssetActor,
  at: string,
): AbilityAsset['audit'][number] {
  assertActor(actor);
  assertTimestamp(at);
  return { action, at, by: actor.by };
}

function cloneEvidenceRefs(refs: AbilityAsset['evidence_refs']): AbilityAsset['evidence_refs'] {
  if (!Array.isArray(refs)) throw new Error('invalid ability asset evidence refs');
  return refs.map((ref) => {
    if (!ref || !EVIDENCE_KINDS.has(ref.kind)) throw new Error('invalid ability asset evidence kind');
    assertSafeId(ref.id, 'ability asset evidence id');
    return { ...ref };
  });
}

function cloneWorkspaceRefs(refs: AbilityAsset['workspace_refs']): AbilityAsset['workspace_refs'] {
  if (!Array.isArray(refs)) throw new Error('invalid ability asset workspace refs');
  return refs.map((ref) => {
    if (!ref || typeof ref.enabled !== 'boolean') throw new Error('invalid ability asset workspace ref');
    assertSafeId(ref.workspace_id, 'ability asset workspace id');
    return { ...ref };
  });
}

export function assertAbilityAssetId(id: string): void {
  assertSafeId(id, 'ability asset id');
}

export function createAbilityAsset(input: CreateAbilityAssetInput): AbilityAsset {
  assertAbilityAssetId(input.id);
  assertSafeId(input.sourceCandidateId, 'source candidate id');
  assertSafeId(input.sourceRunId, 'source run id');
  if (!ASSET_TYPES.has(input.type)) throw new Error('invalid ability asset type');
  assertNonEmptyString(input.capabilityStatement, 'capability statement');
  assertScope(input.scope);
  assertUserActor(input.actor);
  assertTimestamp(input.createdAt);

  const scope = cloneScope(input.scope);
  const versionScope = cloneScope(input.scope);

  return {
    id: input.id,
    source_candidate_id: input.sourceCandidateId,
    source_run_id: input.sourceRunId,
    type: input.type,
    capability_statement: input.capabilityStatement,
    scope,
    evidence_refs: cloneEvidenceRefs(input.evidenceRefs),
    workspace_refs: cloneWorkspaceRefs(input.workspaceRefs),
    status: 'active',
    maturity: 'seed',
    version: 1,
    versions: [{
      version: 1,
      statement: input.capabilityStatement,
      scope: versionScope,
      changed_at: input.createdAt,
      reason: 'candidate_approved',
    }],
    audit: [auditEntry('candidate_approved', input.actor, input.createdAt)],
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
}

export function updateAbilityAsset(
  asset: AbilityAsset,
  input: UpdateAbilityAssetInput,
): AbilityAsset {
  assertAbilityAssetId(asset.id);
  assertNonEmptyString(input.reason, 'ability asset update reason');
  assertActor(input.actor);
  assertTimestamp(input.at);
  if (input.capabilityStatement === undefined && input.scope === undefined) {
    throw new Error('ability asset update requires a statement or scope');
  }
  if (input.capabilityStatement !== undefined) {
    assertNonEmptyString(input.capabilityStatement, 'capability statement');
  }
  if (input.scope !== undefined) assertScope(input.scope);

  const statement = input.capabilityStatement ?? asset.capability_statement;
  const scope = cloneScope(input.scope ?? asset.scope);
  const nextVersion = asset.version + 1;

  return {
    ...asset,
    capability_statement: statement,
    scope,
    evidence_refs: cloneEvidenceRefs(asset.evidence_refs),
    workspace_refs: cloneWorkspaceRefs(asset.workspace_refs),
    version: nextVersion,
    versions: [
      ...cloneVersions(asset),
      {
        version: nextVersion,
        statement,
        scope: cloneScope(scope),
        changed_at: input.at,
        reason: input.reason,
      },
    ],
    audit: [
      ...cloneAudit(asset),
      auditEntry('asset_updated', input.actor, input.at),
    ],
    updated_at: input.at,
  };
}

export function setAbilityAssetStatus(
  asset: AbilityAsset,
  status: AssetStatus,
  actor: AssetActor,
  at: string,
): AbilityAsset {
  assertAbilityAssetId(asset.id);
  if (!ASSET_STATUSES.has(status)) throw new Error('invalid ability asset status');
  if (asset.status === 'revoked') throw new Error('revoked ability asset cannot change status');

  const action = asset.status === 'active' && status === 'paused'
    ? 'asset_paused'
    : asset.status === 'paused' && status === 'active'
      ? 'asset_activated'
      : (asset.status === 'active' || asset.status === 'paused') && status === 'revoked'
        ? 'asset_revoked'
        : null;
  if (!action) throw new Error(`invalid ability asset status transition: ${asset.status} to ${status}`);
  assertUserActor(actor);

  return {
    ...asset,
    status,
    evidence_refs: cloneEvidenceRefs(asset.evidence_refs),
    workspace_refs: cloneWorkspaceRefs(asset.workspace_refs),
    scope: cloneScope(asset.scope),
    versions: cloneVersions(asset),
    audit: [...cloneAudit(asset), auditEntry(action, actor, at)],
    updated_at: at,
  };
}

export function recommendAbilityAssetAction(
  asset: AbilityAsset,
  action: 'pause' | 'rework',
  actor: AssetActor,
  at: string,
): AbilityAsset {
  assertAbilityAssetId(asset.id);
  if (asset.status === 'revoked') throw new Error('cannot recommend changes to a revoked ability asset');
  if (action !== 'pause' && action !== 'rework') throw new Error('invalid ability asset recommendation');
  if (action === 'rework') assertUserActor(actor);

  return {
    ...asset,
    recommended_action: action,
    evidence_refs: cloneEvidenceRefs(asset.evidence_refs),
    workspace_refs: cloneWorkspaceRefs(asset.workspace_refs),
    scope: cloneScope(asset.scope),
    versions: cloneVersions(asset),
    audit: [...cloneAudit(asset), auditEntry(`${action}_recommended`, actor, at)],
    updated_at: at,
  };
}
