# KSTAR Ability Asset Reuse Design

## 1. Decision

Complete the missing KSTAR loop from `ExperienceCandidate` to governed, reusable `AbilityAsset` records:

```text
ExperienceCandidate
  -> approved candidate
  -> AbilityAsset
  -> RecallView
  -> Projection
  -> confirmed read-only injection
  -> TransferProof
  -> EffectivenessProof
  -> maturity and human-governed recommendations
```

The implementation will preserve the current KSTAR engine/compatibility boundary, retain Markdown knowledge promotion as a human-readable evidence projection, and add CogSeed-domain integration in addition to the existing Group Chat path.

This feature is governed learning, not autonomous self-modification. The system may discover, record, match, project, and recommend. It must not silently change user assets or agent behavior.

## 2. Current baseline

The current codebase already provides:

- KSTAR episodes with `result_hat`, `delta_r`, `delta_a`, and confidence gate;
- `ExperienceCandidate` with pending/approved/rejected status;
- approval through `p3394.decideExperienceCandidate`;
- Knowledge Base Markdown promotion;
- optional Notion synchronization;
- KSTAR engine, adapter, compatibility DTOs, store, migration, and recovery;
- Group Chat dispatch integration and P3394 Wake routing;
- CogSeed-native Runtime and task lifecycle on the independent backend branch.
- `ContextReuseReceipt`, which is the existing execution-time receipt for governed context reuse, including permission mode, allowed scopes, and redaction.
- `BehaviorContrast`, which is the existing baseline/treatment evidence mechanism for comparing execution outcomes.

The current approval IPC promotes approved candidates to Knowledge Base Markdown. Asset promotion must therefore be idempotent and must not create a second, conflicting approval path. The new asset layer must also evolve the existing reuse/contrast mechanisms rather than create a second receipt or A/B-comparison system.

## 3. Scope and non-goals

### In scope

- Four asset types: `personal`, `rule`, `template`, `skill_method`.
- Candidate-to-asset promotion with auditability and idempotency.
- Asset versioning, pause, revoke, and rework recommendations.
- Scope-aware recall and exclusion reasons.
- Projection preview, confirmation, injection, and expiration.
- Transfer and effectiveness proofs.
- Maturity transitions.
- Group Chat and Mate execution-domain integration.
- IPC and renderer contracts for asset governance and projection review.

### Out of scope for the first implementation

- Automatic candidate approval.
- Automatic asset revocation or content overwrite.
- Unsupervised changes to prompts, skills, tools, or agent behavior.
- Cross-device sync of assets before a separate cloud-sync contract is approved.
- LLM-based autonomous asset mutation.
- Automatic evolution from two templates to a new third template.
- In-flight runtime suspension while waiting for a projection confirmation.

Phase 1 uses the existing local KSTAR store as the canonical asset store. A later sync phase may move the canonical asset definition into cloud user-private state while retaining local recall indexes and projections. Before Phase 1 implementation starts, the existing independent-backend WIP must be frozen in a dedicated baseline commit, with its verification evidence recorded; asset work must then begin from a clean worktree.

## 4. Data model

Create `src/main/features/p3394/ability-assets.ts` for domain types and pure transitions. Store access belongs in `ability-asset-store.ts`.

### 4.1 Structured scope

A free-form scope string is display-only. Matching uses a structured scope:

```ts
export interface AbilityAssetScope {
  purpose_tags: string[];
  agent_ids?: string[];
  role_ids?: string[];
  project_ids?: string[];
  workspace_ids?: string[];
  conversation_kinds?: string[];
  file_kinds?: string[];
}
```

The service always receives `userId` first. User, project, workspace, conversation-kind, and runtime-domain checks happen before recall or injection. Raw OS paths are not included in prompt injections.

### 4.2 Ability asset

```ts
export type AbilityAssetType = 'personal' | 'rule' | 'template' | 'skill_method';
export type AssetStatus = 'active' | 'paused' | 'revoked';
export type AssetMaturity = 'seed' | 'transfer_validated' | 'effectiveness_validated';

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
```

Rules:

- One candidate can create at most one asset; promotion is idempotent. This uniqueness is enforced by the asset store/promotion transaction, not by the pure asset constructor.
- Asset versions are append-only; the current version is a pointer, not an in-place history rewrite.
- `active` is required for recall and injection.
- `paused` and `revoked` remain queryable for audit but are never injected.
- Type classification may be suggested by the engine but is user-confirmable at approval time.

### 4.3 Projection

Projection is the immutable per-task record of a proposed or confirmed reuse:

```ts
export type AssetExclusionReason =
  | 'asset_paused'
  | 'asset_revoked'
  | 'scope_mismatch'
  | 'workspace_not_referenced'
  | 'workspace_disabled'
  | 'projection_expired'
  | 'policy_disabled'
  | 'confirmation_required';

export interface AbilityProjection {
  id: string;
  asset_id: string;
  asset_version: number;
  domain: 'group_chat' | 'cogseed';
  user_id: string;
  conversation_id?: string;
  task_id?: string;
  runtime_session_id?: string;
  workflow_run_id?: string;
  project_id?: string;
  turn_id: string;
  preview: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'expired' | 'injected';
  context_reuse_receipt_id?: string;
  behavior_contrast_id?: string;
  confirmed_at?: string;
  injected_at?: string;
  expires_at: string;
  exclusion_reason?: AssetExclusionReason;
  created_at: string;
}
```

A projection is scoped to one execution turn. It cannot be reused by a different user, task, runtime session, or workflow without creating a new projection.

Injection contains only:

```text
capability statement
asset version
logical evidence references
```

It does not contain raw tool calls, secrets, full transcripts, or machine paths.

### 4.4 Proofs

Use discriminated proof types:

```ts
export type TransferProofOutcome = 'succeeded' | 'degraded' | 'rejected';
export type EffectivenessProofOutcome =
  | 'better'
  | 'no_improvement'
  | 'worse'
  | 'insufficient_evidence'
  | 'invalid';
```

Every proof includes:

- `asset_id`;
- `projection_id`;
- `task_id` or `conversation_id`;
- `runtime_session_id` when applicable;
- `workflow_run_id` when applicable;
- evidence references;
- idempotency key;
- created-at timestamp;
- actor (`user` or `system`).

A proof retry with the same idempotency key returns the original proof and does not double-count maturity evidence.

### 4.5 Existing reuse and contrast mechanisms

`AbilityProjection` is the governance record for whether a particular asset version is eligible for a particular turn. It is not a replacement for the existing `ContextReuseReceipt`.

- `ContextReuseReceipt` remains the execution-time receipt: it records permission mode, allowed scopes, redaction, and whether governed context was actually accepted by the execution boundary.
- A confirmed/injected projection references the receipt through `context_reuse_receipt_id`. `TransferProof` references that receipt and the projection; it must not duplicate receipt fields.
- `BehaviorContrast` remains the baseline/treatment evidence mechanism. An effectiveness proof may reference `behavior_contrast_id`; the new proof layer summarizes and governs the result instead of reimplementing dispatch/executor comparison.
- If no valid contrast exists, an effectiveness proof may be recorded as `insufficient_evidence`, but it cannot advance an asset to `effectiveness_validated`.

This keeps one source of truth for execution receipts and one source of truth for baseline/treatment evidence while allowing AbilityAsset governance to reference both.

## 5. Persistence and transactions

Reuse the existing KSTAR local storage conventions:

```text
<uid>/local/kstar/
├── ability-assets.json
├── ability-projections.jsonl
├── ability-proofs.jsonl
└── archives/...
```

All writes use the existing UID-scoped lock/CAS/archive approach. The initial implementation keeps asset definitions local; cross-device synchronization requires a later explicit sync design.

Candidate approval and asset promotion use a recoverable two-stage transaction:

```text
1. Validate candidate ownership and approved state.
2. Check candidate.ability_asset_id for an existing asset.
3. Create or return the asset under the KSTAR lock.
4. Preserve or retry Knowledge Base Markdown promotion.
5. Record candidate-to-asset linkage and promotion status.
6. Append audit event.
```

If one stage fails, the record remains retryable and records the exact stage. No operation silently reports full success when only KB or only asset promotion succeeded.

## 6. Candidate lifecycle

Extend the compatibility DTO without breaking legacy readers:

```text
status=pending, review_state=unreviewed -> status=approved, review_state=approved
status=pending, review_state=unreviewed -> status=pending, review_state=deferred
status=pending, review_state=unreviewed -> status=rejected
status=approved, asset_promotion_status=failed -> retry -> asset_promotion_status=ready
asset_ready -> rejected is forbidden; asset status is governed separately
```

The existing `status` union remains `pending | approved | rejected`; `review_state` and `asset_promotion_status` carry the new states so legacy readers do not receive an unexpected status value. Candidate approval remains human-controlled.

The existing `decideExperienceCandidate` remains the approval entry point. Its approved path becomes an idempotent orchestration that preserves the existing KB Markdown result and adds the asset linkage.

## 7. Recall, projection, and policy

### 7.1 Recall View

Add a pure/domain service:

```text
src/main/features/p3394/ability-recall.ts
```

`buildRecallView(userId, input)`:

1. Load active assets.
2. Filter by user scope, structured purpose, project, workspace, role, agent, conversation kind, and domain.
3. Rank deterministically: exact purpose match (4), project match (3), workspace match (3), role match (2), agent match (2), file-kind match (1), maturity (0-2), then newest `updated_at`, then lexical asset id.
4. Select at most three assets.
5. Record exclusion reasons for candidates rejected by status, scope, workspace, or policy.
6. Return an immutable Recall View without prompt mutation.

### 7.2 Projection policy

Workspace policy is explicit:

```text
ability_reuse_policy:
  disabled
  always_confirm
  auto_confirm_safe
```

- `disabled`: record policy exclusion and do not inject.
- `always_confirm`: create pending previews. In the current runtime there is no suspend/resume Human-in-the-Loop protocol, so the current turn does not wait and does not inject the pending projection; confirmation applies to the next eligible turn through a new projection.
- `auto_confirm_safe`: only fully active, scope-matching, low-risk assets may be confirmed automatically.

A task that has already started is not retroactively considered to have used a pending projection. If confirmation arrives after execution, it applies to a subsequent turn and creates a new projection. In-flight suspension is a separate future capability requiring an explicit runtime protocol and is not part of Phase 2.

Projection expiry is deterministic: `expires_at` defaults to 24 hours after creation, and reads/confirmation mark an overdue pending projection as `expired` with `projection_expired`.

### 7.3 Injection domains

The shared recall/projection service is used by both domains:

```text
Group Chat bus
  -> buildRecallView
  -> projection policy
  -> prompt runtime injection

Mate task dispatch/runtime prompt assembly
  -> buildRecallView
  -> projection policy
  -> prompt runtime injection
```

Mate must not depend on `group_chat/bus.ts` for asset reuse.

## 8. Proof and maturity

### 8.1 Transfer proof

Recorded when a confirmed projection is actually used by an execution:

- `succeeded`: asset was applied within scope and execution completed the transfer;
- `degraded`: asset was applied but required correction or partial fallback;
- `rejected`: asset was not accepted or violated an execution gate.

Transfer proof is not an effectiveness claim.

### 8.2 Effectiveness proof

Recorded by explicit UI/IPC review or a governed post-run evaluator:

- `better`;
- `no_improvement`;
- `worse`;
- `insufficient_evidence`;
- `invalid`.

### 8.3 Maturity state machine

```text
seed
  -> transfer_validated after at least one idempotent succeeded transfer proof
  -> effectiveness_validated after configured minimum evidence and a deterministic confidence calculation
```

A single `better` result is not sufficient by default. The initial default is:

```text
valid = better + no_improvement
total = better + no_improvement + worse + insufficient_evidence + invalid
sample_factor = min(1, valid / 3)
confidence = total == 0 ? 0 : (valid / total) * sample_factor

requirements:
  valid >= 3
  better >= 2
  unresolved_worse == 0
  confidence >= 0.8
```

The calculation uses only persisted proof outcomes, so it is deterministic and testable; it does not depend on an unpersisted model confidence field. A `worse` result writes `recommended_action = 'pause'`. Only a user/reviewer action may choose `rework`, and only a user action changes the asset status.

## 9. IPC and renderer

New IPC methods follow existing `validateScope`, `safeId`, and `{ ok, ... }` conventions:

```text
p3394.listAbilityAssets
p3394.promoteToAbilityAsset
p3394.updateAbilityAsset
p3394.deferExperienceCandidate
p3394.previewProjection
p3394.confirmProjection
p3394.rejectProjection
p3394.listProjections
p3394.recordEffectivenessProof
p3394.listAbilityProofs
```

Every IPC handler validates:

- user scope;
- candidate/asset/projection ownership;
- conversation/task/workflow association;
- decision enum;
- safe ids;
- policy and status transitions.

Renderer surfaces reuse existing KSTAR/collaboration patterns and locales:

- candidate review with defer/edit/type selection;
- asset list with status, maturity, version, evidence chain;
- asset history and audit;
- projection preview/confirmation;
- transfer/effectiveness proof history;
- recommended pause/rework actions.

## 10. Testing

Before each production change, write a failing test and verify the intended red state.

Required tests include:

- candidate approval creates at most one asset;
- duplicate promotion returns the existing asset;
- KB success and asset failure are recoverable independently;
- asset version updates are append-only;
- paused/revoked assets never inject;
- scope mismatch records an exclusion reason;
- pending projection never injects;
- policy controls auto-confirm versus human confirmation;
- Group Chat and Mate both create correctly scoped projections;
- proof writes are idempotent;
- transfer and effectiveness maturity transitions obey thresholds;
- worse evidence recommends pause but does not mutate status;
- restart/recovery does not duplicate projections or proofs;
- IPC rejects cross-user and cross-task references;
- prompt injection contains no raw paths or tool-call transcripts;
- full KSTAR and Mate backend suites remain green.

## 11. Implementation phases

### Phase 1: Asset entity and promotion

- Add domain types and pure transitions.
- Add versioned asset store using existing KSTAR lock/CAS/archive.
- Extend candidate linkage and deferred state.
- Implement idempotent candidate-to-asset orchestration.
- Preserve KB Markdown promotion and existing IPC compatibility.
- Add focused tests and typecheck.

### Phase 2: Recall and projection

- Add structured scope matching.
- Add Recall View and exclusion reasons.
- Add Projection store and policy.
- Add Group Chat and Mate integration points.
- Add preview/confirm/reject IPC and renderer projection.
- Add focused tests for pending/auto-confirm/disabled paths.

### Phase 3: Proof and maturity

- Add transfer proof at both Group Chat and Mate terminal hooks.
- Add explicit effectiveness proof IPC and UI.
- Add maturity thresholds and recommended actions.
- Reuse `ContextReuseReceipt` for execution receipt linkage and `BehaviorContrast` for effectiveness evidence; do not add parallel receipt or A/B state.
- Add recovery and idempotency tests.

### Phase 4: Later sync and evolution

- Define cloud synchronization for asset definitions and audits.
- Add local recall index rebuild.
- Add multi-template evolution only after sufficient governed evidence.

## 12. Definition of done

This feature is complete when:

- approved candidates can produce exactly one auditable AbilityAsset;
- active assets are recalled only within valid scope;
- pending/paused/revoked assets never silently inject;
- both Group Chat and Mate can use the same governed recall/projection service;
- confirmed reuse produces transfer proof;
- effectiveness proof and maturity thresholds are explicit;
- worse results recommend action without autonomous mutation;
- restart/retry cannot duplicate asset, projection, or proof records;
- existing KSTAR KB/Notion behavior remains compatible;
- focused tests, typecheck, full JS tests, and resource tests pass.
