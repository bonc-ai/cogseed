# KSTAR Ability Asset Reuse Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Add a durable, auditable, idempotent `AbilityAsset` entity and connect approved KSTAR `ExperienceCandidate` records to it without breaking existing Knowledge Base promotion or legacy IPC DTOs.

**Pre-flight:** This worktree also contains a separate parity baseline line and a separate KSTAR plan line. Freeze and commit the KSTAR plan line independently before freezing the parity baseline. Do not mix the two lines into one baseline commit.

**Architecture:** Keep Phase 1 local to `<uid>/local/kstar/`, reuse one UID-scoped KSTAR lock for legacy candidates and new assets, and preserve existing `ContextReuseReceipt`/`BehaviorContrast` as future execution/evidence sources rather than creating duplicates. Candidate approval remains human-controlled; promotion is a recoverable orchestration that can be retried without creating duplicate assets or KB records.

**Tech Stack:** TypeScript, Vitest, existing `writeJson`/path helpers, existing KSTAR Mutex/CAS/archive conventions, existing IPC allow-list and `{ ok, ... }` contract.

---

## Scope guard

This plan implements Phase 1 only, and every task completion must also pass a cross-cutting `zero live-import CogSeed business layers` check for the code touched by that task:

- AbilityAsset domain types and pure transitions;
- shared KSTAR locking for candidate/asset consistency;
- versioned local asset store;
- candidate linkage and deferred review state;
- idempotent candidate-to-asset promotion;
- compatibility IPC for list/promote/update/defer;
- focused tests, typecheck, and full verification.

Do not implement Recall View, Projection, confirmation policy, Mate prompt injection, TransferProof, EffectivenessProof, maturity thresholds, Renderer asset tab, or cloud sync in this plan. Those belong to later plans after the existing `ContextReuseReceipt` and `BehaviorContrast` integration points are finalized.

## File map

- Create `src/main/features/p3394/kstar-lock.ts`: one per-user async lock used by legacy KSTAR state and AbilityAsset persistence.
- Create `src/main/features/p3394/ability-assets.ts`: domain types, validation, immutable version/status transitions, and asset construction.
- Create `src/main/features/p3394/ability-asset-store.ts`: atomic read/list/create/update/archive operations under the shared KSTAR lock.
- Create `src/main/features/p3394/ability-asset-promotion.ts`: candidate ownership checks, idempotent promotion orchestration, KB linkage, and stage-aware retry behavior.
- Modify `src/main/features/p3394/kstar-compat.ts`: add optional `review_state`, `asset_promotion_status`, and `ability_asset_id` fields while preserving `status: pending | approved | rejected`.
- Modify `src/main/features/p3394/kstar-legacy-data.ts`: use the shared KSTAR lock and add deferred-state/linkage mutations with unlocked helpers for transactions.
- Modify `src/main/features/p3394/kstar-store.ts`: use the shared KSTAR lock without changing snapshot/archive behavior.
- Modify `src/main/features/p3394/kstar-kb.ts`: make KB promotion idempotent and expose stage-safe result data to the promotion orchestrator.
- Modify `src/main/features/p3394/index.ts`: export the new Phase 1 domain/store/promotion APIs through the existing P3394 feature facade.
- Modify `src/main/ipc/index.ts`: route approved-candidate promotion through the new orchestration and add Phase 1 asset/defer/update handlers.
- Create `test/main/features/p3394/ability-assets.test.ts`: pure asset lifecycle and version tests.
- Create `test/main/features/p3394/ability-asset-store.test.ts`: persistence, lock, archive, and recovery tests.
- Create `test/main/features/p3394/ability-asset-promotion.test.ts`: candidate-to-asset and KB orchestration tests.
- Create `test/main/ipc/p3394-ability-assets.test.ts`: IPC scope, transition, and compatibility tests.
- Modify `test/main/features/p3394/kstar-kb.test.ts`: preserve existing KB idempotency expectations and add repeat-promotion coverage.
- Modify `test/main/ipc/p3394-contract.test.ts`: register the new allow-listed IPC method names.

---

### Task 0: Separate the KSTAR line, then freeze the independent-backend baseline

**Files:**
- No production files; this task freezes the current worktree before Phase 1 changes.

- [ ] **Step 0: Split the two working lines before freezing anything.**

The worktree currently contains two independent lines: parity baseline work and this KSTAR ability-asset reuse plan. Commit or move the KSTAR plan line separately first, so the parity baseline can be frozen without cross-contaminating the two streams. The KSTAR plan file at `docs/superpowers/plans/2026-08-05-kstar-ability-asset-reuse-phase1.md` must not be bundled into the parity baseline commit; it is its own line and must be committed or moved out first.

- [ ] **Step 1: Verify the current baseline before committing it.**

Run:

```bash
git diff --check
npm run typecheck
npm run test:js -- test/main/features/p3394 test/main/features/cogseed_backend test/main/features/cogseed_runtime test/main/ipc
npm test
node scripts/smoke-cogseed-agent-native.mjs
node scripts/smoke-cogseed-agent-host-capabilities.mjs
```

Expected: all commands exit 0; the baseline includes the previously verified independent-backend WIP but no AbilityAsset production files. Current uncommitted count, using `git status --porcelain` and counting untracked entries, is 44 (23 M + 20 ?? + 1 D).

- [ ] **Step 2: Confirm no Phase 1 files are already present.**

Run:

```bash
for f in \
  src/main/features/p3394/kstar-lock.ts \
  src/main/features/p3394/ability-assets.ts \
  src/main/features/p3394/ability-asset-store.ts \
  src/main/features/p3394/ability-asset-promotion.ts \
  test/main/features/p3394/ability-assets.test.ts \
  test/main/features/p3394/ability-asset-store.test.ts \
  test/main/features/p3394/ability-asset-promotion.test.ts \
  test/main/ipc/p3394-ability-assets.test.ts; do
  test ! -e "$f" || { echo "unexpected pre-existing Phase 1 file: $f"; exit 1; }
done
```

Expected: no output and exit 0.

- [ ] **Step 3: Commit the verified baseline before editing production code.**

Run:

```bash
git add -A
git commit -m "chore: freeze independent backend baseline"
```

Expected: a new baseline commit containing only the already-verified independent-backend work and the committed design/plan documents. If the working tree contains unrelated user work, stop and separate it before staging; do not silently include unrelated files.

---

### Task 1: Define the AbilityAsset domain and pure transitions

**Completion gate:** the task is not done until the touched code passes its targeted tests and a zero live-import CogSeed business layers check for the affected paths.

**Files:**
- Create: `src/main/features/p3394/ability-assets.ts`
- Create: `test/main/features/p3394/ability-assets.test.ts`

- [ ] **Step 1: Write failing tests for the domain contract.**

Add tests with these exact behaviors:

```ts
it('creates one seed active asset from an approved candidate input')
it('rejects empty capability statements and invalid scope ids')
it('updates an asset by appending version history instead of mutating prior versions')
it('allows active to paused and paused to active transitions')
it('allows active/paused to revoked but never revokes by recommendation alone')
it('records pause/rework recommendations without changing asset status')
```

Use fixed timestamps and injected ids in tests so snapshots are deterministic. Assert that the first version is `version: 1`, maturity is `seed`, status is `active`, and the initial audit includes the user approval action.

- [ ] **Step 2: Run the new test file and verify the intended red state.**

Run:

```bash
npm run test:js -- test/main/features/p3394/ability-assets.test.ts
```

Expected: FAIL because `ability-assets.ts` and its exported constructors/transitions do not exist. Fix only test harness/import errors until the failure is about the missing implementation.

- [ ] **Step 3: Implement the minimal pure domain API.**

Define these input types and export these concrete functions:

```ts
export interface AssetActor { by: 'user' | 'system'; id?: string }
export interface CreateAbilityAssetInput {
  id: string; sourceCandidateId: string; sourceRunId: string;
  type: AbilityAssetType; capabilityStatement: string; scope: AbilityAssetScope;
  evidenceRefs: AbilityAsset['evidence_refs'];
  workspaceRefs: AbilityAsset['workspace_refs'];
  actor: AssetActor; createdAt: string;
}
export interface UpdateAbilityAssetInput {
  capabilityStatement?: string;
  scope?: AbilityAssetScope;
  reason: string;
  actor: AssetActor;
  at: string;
}
export function createAbilityAsset(input: CreateAbilityAssetInput): AbilityAsset;
export function updateAbilityAsset(asset: AbilityAsset, input: UpdateAbilityAssetInput): AbilityAsset;
export function setAbilityAssetStatus(asset: AbilityAsset, status: AssetStatus, actor: AssetActor, at: string): AbilityAsset;
export function recommendAbilityAssetAction(asset: AbilityAsset, action: 'pause' | 'rework', actor: AssetActor, at: string): AbilityAsset;
export function assertAbilityAssetId(id: string): void;
```

Keep all transitions pure. Use only `createdAt`/`at` values supplied by callers; do not read the system clock. Candidate uniqueness is enforced later by the store/promotion transaction, not by this constructor. Do not read files, call IPC, call KSTAR engine services, or inspect `ContextReuseReceipt`/`BehaviorContrast` here.

- [ ] **Step 4: Run the domain tests and typecheck.**

Run:

```bash
npm run test:js -- test/main/features/p3394/ability-assets.test.ts
npm run typecheck
```

Expected: all new domain tests pass and typecheck exits 0.

- [ ] **Step 5: Commit the domain slice.**

```bash
git add src/main/features/p3394/ability-assets.ts test/main/features/p3394/ability-assets.test.ts
git commit -m "feat: add KSTAR ability asset domain"
```

- [ ] **Step 6: Record the Phase 0 approver.**

The Phase 0 approval checkpoint must name the approver in the plan before Phase 1 begins. Write the actual approver name explicitly (for example: 张照航 or Richard, or the real signer who approves the matrix and fixtures).

---

### Task 2: Share the KSTAR lock and add the versioned asset store

**Completion gate:** the task is not done until the touched code passes its targeted tests and a zero live-import CogSeed business layers check for the affected paths.

**Files:**
- Create: `src/main/features/p3394/kstar-lock.ts`
- Create: `src/main/features/p3394/ability-asset-store.ts`
- Modify: `src/main/features/p3394/kstar-store.ts`
- Modify: `src/main/features/p3394/kstar-legacy-data.ts`
- Create: `test/main/features/p3394/ability-asset-store.test.ts`
- Modify: `test/main/features/p3394/kstar-store.test.ts`

- [ ] **Step 1: Write failing persistence and concurrency tests.**

Cover these behaviors:

```ts
it('lists an empty asset store when the file is absent')
it('writes and reads assets under <uid>/local/kstar/ability-assets.json')
it('creates the directory and writes atomically')
it('serializes concurrent updates for one user through the shared KSTAR lock')
it('keeps users isolated when two uid operations run concurrently')
it('archives the previous asset snapshot before replacing it')
it('returns a recoverable error instead of losing the last valid snapshot')
it('rejects path traversal and malformed asset ids')
```

Add a regression test that runs a legacy candidate mutation and an asset-store mutation concurrently for the same uid and asserts both changes survive. This test must fail with the current separate lock maps before the shared lock is introduced.

- [ ] **Step 2: Run the persistence tests to verify red.**

Run:

```bash
npm run test:js -- test/main/features/p3394/ability-asset-store.test.ts test/main/features/p3394/kstar-store.test.ts
```

Expected: the new asset store imports fail and the shared-lock regression fails before implementation.

- [ ] **Step 3: Extract one shared per-user lock helper.**

Implement in `kstar-lock.ts`:

```ts
export async function withKstarUserLock<T>(uid: string, fn: () => Promise<T>): Promise<T>;
```

Move the existing per-user `Mutex` map behind this helper. Update `kstar-store.ts` and `kstar-legacy-data.ts` to use it. Preserve their public APIs and current snapshot/legacy file paths.

- [ ] **Step 4: Implement atomic AbilityAsset storage.**

Define the persisted envelope and implement:

```ts
export interface AbilityAssetStoreState {
  version: 1;
  assets: AbilityAsset[];
  updated_at: string;
}
export function abilityAssetsPath(uid: string): string;
export async function listAbilityAssets(uid: string): Promise<AbilityAsset[]>;
export async function getAbilityAsset(uid: string, assetId: string): Promise<AbilityAsset | null>;
export async function createAbilityAssetRecord(uid: string, asset: AbilityAsset): Promise<AbilityAsset>;
export async function updateAbilityAssetRecord(uid: string, asset: AbilityAsset): Promise<AbilityAsset>;
```

Use a versioned JSON envelope, atomic temp-file rename, a `.previous` backup, and the shared KSTAR lock. The store must preserve the last valid file on a failed write. Do not introduce a second independent mutex map.

- [ ] **Step 5: Add unlocked transaction helpers for promotion.**

Expose internal-only helpers used by the promotion orchestrator. Make the legacy state type a type-only export so the transaction has one explicit shape:

```ts
export type KStarLegacyState = {
  version: 1;
  runs: KStarCompatRun[];
  experience_candidates: CompatExperienceCandidate[];
  patch_candidates: CompatPatchCandidate[];
  updated_at: string;
  [passthroughKey: string]: unknown;
};
export async function readAbilityAssetStateUnlocked(uid: string): Promise<AbilityAssetStoreState>;
export async function writeAbilityAssetStateUnlocked(uid: string, state: AbilityAssetStoreState): Promise<void>;
export async function readKstarLegacyStateUnlocked(uid: string): Promise<KStarLegacyState>;
export async function writeKstarLegacyStateUnlocked(uid: string, state: KStarLegacyState): Promise<void>;
```

Do not export these through the public `p3394` feature index. Public functions must continue to acquire the shared lock themselves.

- [ ] **Step 6: Run persistence, existing KSTAR, and type tests.**

Run:

```bash
npm run test:js -- test/main/features/p3394/ability-asset-store.test.ts test/main/features/p3394/kstar-store.test.ts test/main/features/p3394/kstar-migration.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the storage slice.**

```bash
git add src/main/features/p3394/kstar-lock.ts src/main/features/p3394/ability-asset-store.ts src/main/features/p3394/kstar-store.ts src/main/features/p3394/kstar-legacy-data.ts test/main/features/p3394/ability-asset-store.test.ts test/main/features/p3394/kstar-store.test.ts
git commit -m "feat: add locked KSTAR ability asset store"
```

---

### Task 3: Link candidates and implement idempotent promotion

**Completion gate:** the task is not done until the touched code passes its targeted tests and a zero live-import CogSeed business layers check for the affected paths.

**Files:**
- Create: `src/main/features/p3394/ability-asset-promotion.ts`
- Modify: `src/main/features/p3394/kstar-compat.ts`
- Modify: `src/main/features/p3394/kstar-legacy-data.ts`
- Modify: `src/main/features/p3394/kstar-kb.ts`
- Modify: `src/main/features/p3394/index.ts`
- Create: `test/main/features/p3394/ability-asset-promotion.test.ts`
- Modify: `test/main/features/p3394/kstar-kb.test.ts`

- [ ] **Step 1: Write failing promotion tests.**

Cover these cases:

```ts
it('rejects promotion unless the candidate is approved')
it('creates exactly one asset for an approved candidate')
it('retries the same request by returning the existing linked asset')
it('writes the asset link to the candidate after asset creation')
it('preserves KB Markdown promotion as a separate auditable stage')
it('recovers when asset creation succeeds but KB promotion fails')
it('recovers when KB promotion succeeds but candidate linkage has not been written')
it('does not allow a rejected or deferred candidate to create an asset')
it('keeps candidate status union backward compatible while storing review_state=deferred')
it('allows user-selected asset type and scope to override the engine suggestion')
```

Use injected store/KB dependencies so the tests can force each stage to fail and assert the persisted stage marker.

- [ ] **Step 2: Run promotion tests and verify red.**

Run:

```bash
npm run test:js -- test/main/features/p3394/ability-asset-promotion.test.ts test/main/features/p3394/kstar-kb.test.ts
```

Expected: FAIL because the promotion service, candidate linkage fields, and stage-aware KB result do not exist.

- [ ] **Step 3: Extend the compatibility DTO without changing legacy status values.**

Add optional fields to `CompatExperienceCandidate`:

```ts
review_state?: 'unreviewed' | 'deferred' | 'approved' | 'rejected';
asset_promotion_status?: 'none' | 'pending' | 'ready' | 'failed';
ability_asset_id?: string;
asset_promotion_error?: string;
```

Keep `status` exactly `pending | approved | rejected`. Add pure validation/projection tests for old records that lack the new fields.

- [ ] **Step 4: Implement the stage-aware promotion service.**

Define the existing KB result alias and export:

```ts
type KbPromotionResult = Awaited<ReturnType<typeof promoteExperienceCandidateToKnowledgeBase>>;
export async function promoteExperienceCandidateToAbilityAsset(
  uid: string,
  candidateId: string,
  input: {
    type: AbilityAssetType;
    capabilityStatement: string;
    scope: AbilityAssetScope;
    workspaceRefs: Array<{ workspace_id: string; enabled: boolean }>;
  },
): Promise<{ candidate: CompatExperienceCandidate; asset: AbilityAsset; kbPromotion: KbPromotionResult }>;
```

Under one shared UID lock:

1. Load and validate candidate ownership/status.
2. Return the linked asset if `ability_asset_id` already exists and is valid.
3. Create the asset record with `seed/active/version=1`.
4. Record `asset_promotion_status=pending` and the asset id.
5. Run idempotent KB Markdown promotion.
6. Mark the candidate `asset_promotion_status=ready` only after the asset and KB stage are durably represented.
7. On failure, persist `asset_promotion_status=failed` and an error stage; never report full success.

The service must not call Notion, create a second approval record, or modify the asset status automatically based on a proof/recommendation.

- [ ] **Step 5: Implement deferred review and asset editing transitions.**

Add internal functions:

```ts
export async function deferExperienceCandidate(uid: string, candidateId: string): Promise<CompatExperienceCandidate>;
export async function updateAbilityAssetFromUser(uid: string, assetId: string, input: UpdateAbilityAssetInput): Promise<AbilityAsset>;
```

`deferExperienceCandidate` is valid only for a pending, unapproved candidate. `updateAbilityAssetFromUser` appends a new asset version and records the user audit action; it does not alter maturity or silently clear a recommended action unless the input explicitly acknowledges it.

- [ ] **Step 6: Run promotion, KB, compatibility, and type tests.**

Run:

```bash
npm run test:js -- test/main/features/p3394/ability-asset-promotion.test.ts test/main/features/p3394/kstar-kb.test.ts test/main/features/p3394/kstar-compat.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the promotion slice.**

```bash
git add src/main/features/p3394/ability-asset-promotion.ts src/main/features/p3394/kstar-compat.ts src/main/features/p3394/kstar-legacy-data.ts src/main/features/p3394/kstar-kb.ts src/main/features/p3394/index.ts test/main/features/p3394/ability-asset-promotion.test.ts test/main/features/p3394/kstar-kb.test.ts test/main/features/p3394/kstar-compat.test.ts
git commit -m "feat: promote KSTAR candidates to ability assets"
```

---

### Task 4: Add Phase 1 IPC compatibility surface

**Completion gate:** the task is not done until the touched code passes its targeted tests and a zero live-import CogSeed business layers check for the affected paths.

**Files:**
- Modify: `src/main/ipc/index.ts`
- Modify: `test/main/ipc/p3394-contract.test.ts`
- Create: `test/main/ipc/p3394-ability-assets.test.ts`

- [ ] **Step 1: Write failing IPC contract tests.**

Test these handlers:

```ts
it('lists only assets owned by the authenticated user')
it('promotes only an approved candidate in the requested conversation scope')
it('rejects cross-user, cross-conversation, malformed-id, and invalid-transition requests')
it('defers only a pending candidate')
it('updates an asset with an append-only version and user audit record')
it('returns { ok, ... } on success and preserves thrown validation errors')
```

Add the following names to the contract allow-list test:

```text
p3394.listAbilityAssets
p3394.promoteToAbilityAsset
p3394.updateAbilityAsset
p3394.deferExperienceCandidate
```

- [ ] **Step 2: Run IPC tests to verify red.**

Run:

```bash
npm run test:js -- test/main/ipc/p3394-ability-assets.test.ts test/main/ipc/p3394-contract.test.ts
```

Expected: FAIL because the handlers and contract entries are absent.

- [ ] **Step 3: Implement the handlers.**

Follow the existing P3394 handler style:

- validate `cid`, candidate ids, and asset ids with `safeId`;
- load the record and verify `conversation_id`/`source_run_id` ownership before mutation;
- route approved promotion through `promoteExperienceCandidateToAbilityAsset`;
- return `{ ok: true, ... }` on success;
- do not swallow errors or return another user's record;
- keep the existing `p3394.decideExperienceCandidate` result shape compatible while exposing the new asset linkage when available.

- [ ] **Step 4: Run IPC tests and typecheck.**

Run:

```bash
npm run test:js -- test/main/ipc/p3394-ability-assets.test.ts test/main/ipc/p3394-contract.test.ts test/main/features/p3394/ability-asset-promotion.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 5: Commit the IPC slice.**

```bash
git add src/main/ipc/index.ts test/main/ipc/p3394-ability-assets.test.ts test/main/ipc/p3394-contract.test.ts
git commit -m "feat: expose KSTAR ability asset IPC"
```

---

### Task 5: Phase 1 verification and handoff

**Completion gate:** the task is not done until the touched code passes its targeted tests and a zero live-import CogSeed business layers check for the affected paths.

**Files:**
- No production files; verification and audit only.

- [ ] **Step 1: Run the complete Phase 1 focused suite.**

```bash
npm run test:js -- \
  test/main/features/p3394/ability-assets.test.ts \
  test/main/features/p3394/ability-asset-store.test.ts \
  test/main/features/p3394/ability-asset-promotion.test.ts \
  test/main/features/p3394/kstar-kb.test.ts \
  test/main/features/p3394/kstar-compat.test.ts \
  test/main/ipc/p3394-ability-assets.test.ts \
  test/main/ipc/p3394-contract.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run boundary and full verification.**

```bash
git diff --check
npm run typecheck
npm test
```

Expected: exit code 0; no new direct imports from `group_chat` into the Phase 1 domain/store/promotion modules; existing KSTAR, Mate backend, and resource tests remain green.

- [ ] **Step 3: Verify the Phase 1 definition of done.**

Check each item:

```text
[ ] approved candidate -> exactly one AbilityAsset
[ ] duplicate promotion is idempotent
[ ] KB and asset stages are recoverable independently
[ ] legacy candidate status values remain compatible
[ ] deferred review is explicit and user-controlled
[ ] asset versions are append-only
[ ] paused/revoked/recommended actions do not silently mutate behavior
[ ] all IPC handlers enforce scope
[ ] no Phase 2 recall/projection/proof code was added
```

- [ ] **Step 4: Commit verification notes only if needed.**

Do not create a “done” commit containing generated data or test artifacts. Report the exact test counts and leave the worktree clean except for intentionally uncommitted user changes.
