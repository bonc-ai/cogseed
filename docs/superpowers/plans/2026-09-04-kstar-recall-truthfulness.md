# KSTAR / Recall Truthfulness Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Complete the existing KSTAR / Recall chain's usage truthfulness, ontology-assisted retrieval, delegated-asset authorization, and evidence-bound secondary attribution without creating an Error Pattern system.

**Architecture:** Extend existing Recall JSON/JSONL records and KSTAR review/trace façades with optional backward-compatible fields. Keep selection and authorization deterministic in Main, keep effectiveness in the existing proof chain, and make every degraded path explicit without blocking an ordinary task that continues without delegated assets.

**Tech Stack:** Electron Main, TypeScript, existing JSON/JSONL stores and locks, Vitest through `npm test`, no new dependencies or database.

---

## File Structure

### New focused modules

- `src/main/features/recall/asset-usage-receipt.ts` — validated, idempotent Applied/Unknown usage facts.
- `src/main/features/recall/task-contract.ts` — deterministic task contract and ontology-anchor extraction.
- `src/main/features/recall/hybrid-retrieval.ts` — merge semantic and ontology match evidence without bypassing eligibility.
- `src/main/features/kstar/secondary-attribution.ts` — deterministic secondary attribution and precipitation exclusions.

### Existing integration points

- `src/main/features/recall/context-projection.ts` — invoke task-contract/hybrid retrieval and persist match provenance.
- `src/main/features/recall/injection-receipt.ts` — exact injected-fact lookup for usage receipts.
- `src/main/features/kstar/task-closure.ts` — reconcile usage receipts from persisted messages and Episode evidence.
- `src/main/features/kstar/trace-types.ts`, `src/main/features/kstar/trace.ts` — expose injection, usage, closure, candidate, completeness nodes.
- `src/main/features/group_chat/bus.ts` — require delegated assets to be a frozen subset of the current confirmed Projection.
- `src/main/features/kstar/types.ts`, `review-service.ts`, `review-inference.ts` — store and validate secondary attribution.
- `src/main/features/kstar/extraction-service.ts`, `task-level-precipitation.ts` — exclude non-reusable secondary causes.

---

### Task 1: Persist conservative asset-usage truth and expose it in Trace

**Files:**
- Create: `src/main/features/recall/asset-usage-receipt.ts`
- Modify: `src/main/features/recall/injection-receipt.ts`
- Modify: `src/main/features/kstar/task-closure.ts`
- Modify: `src/main/features/kstar/trace-types.ts`
- Modify: `src/main/features/kstar/trace.ts`
- Test: `test/main/features/recall/asset-usage-receipt.test.ts`
- Test: `test/main/features/kstar/task-closure.test.ts`
- Test: `test/main/features/kstar/trace.test.ts`

- [ ] **Step 1: Write failing receipt validation and idempotency tests**

Create a real `InjectionReceipt`, then verify an evidence-bound write succeeds:

```ts
await expect(recordAssetUsageReceipt('user-a', {
  taskRunId: 'turn-a', projectionId: 'proj-a', assetId: 'asset-a',
  assetVersion: '1', injectionReceiptId: injection.id,
  status: 'applied', evidenceKind: 'tool_call',
  evidenceRefs: [{ kind: 'execution', id: 'kse-run-a' }], boundary: 'real',
})).resolves.toMatchObject({ status: 'applied' });
```

Reject missing or mismatched injection receipts and `applied` without evidence. Repeating the same logical write returns the same id and one JSONL record.

- [ ] **Step 2: Run the test and verify RED**

```bash
npm run test:js -- test/main/features/recall/asset-usage-receipt.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal receipt store**

Implement `AssetUsageStatus`, `AssetUsageReceipt`, `recordAssetUsageReceipt`, and `listAssetUsageReceipts`. Use a SHA-256 stable id for `taskRunId + projectionId + assetId + assetVersion`; validate ids, normalize evidence refs, require evidence for every state except `usage_unknown` and `available_no_opportunity`, and validate the referenced InjectionReceipt. Store no prompt body or tool argument values.

- [ ] **Step 4: Write failing closure reconciliation tests**

Add cases where a completed run with real injection plus successful Tool/Action/Artifact evidence records `applied`; injection without such evidence records `usage_unknown`; failed/cancelled runs never infer `applied`.

- [ ] **Step 5: Implement closure reconciliation**

After Episode persistence, load the run/projection InjectionReceipts and reconcile one usage receipt per injected asset. Use only persisted Tool Calls, Agent Actions, produced files/artifacts, or final output tied to this run. Never inspect prose for “I used asset X”. Receipt write failure records KSTAR degradation without changing the terminal result.

- [ ] **Step 6: Write failing Trace tests**

Assert Trace returns `injection`, `usage`, `closure`, `candidate`, and `trace_completeness`; legacy records without facts remain `not_started`/degraded rather than appearing successful.

- [ ] **Step 7: Extend Trace**

Add the stages, load injection/usage facts, map extraction result ids to candidate nodes, add closure nodes, and calculate completeness only from persisted facts.

- [ ] **Step 8: Verify and commit**

```bash
npm run test:js -- test/main/features/recall/asset-usage-receipt.test.ts test/main/features/kstar/task-closure.test.ts test/main/features/kstar/trace.test.ts
npm run typecheck
git add src/main/features/recall/asset-usage-receipt.ts src/main/features/recall/injection-receipt.ts src/main/features/kstar/task-closure.ts src/main/features/kstar/trace-types.ts src/main/features/kstar/trace.ts test/main/features/recall/asset-usage-receipt.test.ts test/main/features/kstar/task-closure.test.ts test/main/features/kstar/trace.test.ts
git commit -m "feat(kstar): persist asset usage truth"
```

---

### Task 2: Add deterministic ontology-assisted hybrid retrieval

**Files:**
- Create: `src/main/features/recall/task-contract.ts`
- Create: `src/main/features/recall/hybrid-retrieval.ts`
- Modify: `src/main/features/recall/context-projection.ts`
- Modify: `src/main/features/recall/projection-card.ts`
- Modify: `src/main/features/recall/prompt-injection.ts`
- Modify: `src/main/features/group_chat/visibility.ts`
- Test: `test/main/features/recall/task-contract.test.ts`
- Test: `test/main/features/recall/context-projection.test.ts`
- Test: `test/main/features/recall/projection-knowledge.test.ts`

- [ ] **Step 1: Write failing TaskContract tests**

Cover Chinese/English action types; T-Box group/field anchors; workspace-filtered R-Box subject/object anchors; bounded objects/constraints/capabilities; no model call or ontology mutation.

- [ ] **Step 2: Run and verify RED**

```bash
npm run test:js -- test/main/features/recall/task-contract.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic TaskContract extraction**

Build `RecallTaskContract` from bounded `taskText + purpose`, `loadOntologyTaxonomy`, and workspace-filtered `loadOntologyRules`. The result is query metadata only and never writes Personal Ontology.

- [ ] **Step 4: Write failing hybrid retrieval tests**

Cover ontology-only selection, `semantic_ontology` dual-route priority, dedupe, embedding failure retaining only reliable ontology matches, both routes unavailable yielding an empty degraded selection, workspace R-Box isolation, and legacy match-method reads.

- [ ] **Step 5: Implement hybrid merge**

Create `mergeHybridMatches` with match methods `semantic | ontology | semantic_ontology | recency_fallback | manual`. Combine scores deterministically, keep one result per asset, favor dual-route evidence, preserve Top-N/type diversity, and never perform eligibility itself.

- [ ] **Step 6: Integrate into Projection**

Run existing eligibility gates first; build TaskContract; derive ontology matches from `asset.ontologyRefs`; run semantic ranking; merge; persist route/score. On embedding failure, allow reliable ontology matches only. If no ontology match exists, return an empty degraded selection—never all assets by recency.

- [ ] **Step 7: Update match-method consumers**

Allow `ontology` and `semantic_ontology` in projection validation, cards, prompt citations, and persisted group-message citations while preserving old values.

- [ ] **Step 8: Verify and commit**

```bash
npm run test:js -- test/main/features/recall/task-contract.test.ts test/main/features/recall/context-projection.test.ts test/main/features/recall/projection-knowledge.test.ts test/renderer/ontology-picker-opaque-ref.test.ts
npm run typecheck
git add src/main/features/recall/task-contract.ts src/main/features/recall/hybrid-retrieval.ts src/main/features/recall/context-projection.ts src/main/features/recall/projection-card.ts src/main/features/recall/prompt-injection.ts src/main/features/group_chat/visibility.ts test/main/features/recall/task-contract.test.ts test/main/features/recall/context-projection.test.ts test/main/features/recall/projection-knowledge.test.ts
git commit -m "feat(recall): add ontology-assisted retrieval"
```

---

### Task 3: Enforce Confirmed Projection subsets for delegated assets

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/kstar/lifecycle-adapter.ts` only if the current DTO cannot expose the Projection id
- Test: `test/main/features/group_chat/bus-integration.test.ts`
- Test: `test/main/features/group_chat/kstar-commander-centric.test.ts`

- [ ] **Step 1: Write failing authorization tests**

For `dispatch_to`, `hand_off_to`, anonymous worker, and named worker cover: Projection member allowed; active Projection-external asset rejected; non-confirmed Projection rejected; frozen-version drift rejected; missing Requirement rejected only for explicit grants; omitted/empty assets still permit dispatch; target runtime scope remains enforced.

- [ ] **Step 2: Run and verify RED**

```bash
npm run test:js -- test/main/features/group_chat/bus-integration.test.ts test/main/features/group_chat/kstar-commander-centric.test.ts
```

Expected: Projection-external/version-drift cases FAIL with the current resolver.

- [ ] **Step 3: Enforce the authoritative Projection**

Pass conversation id into `resolveDispatchedAbilityAssets`. Only for non-empty grants, read the current lifecycle, resolve its confirmed Projection, require each id in `projection.assetIds`, and call frozen-version validation before existing target runtime eligibility. Return stable generic errors and never enumerate allowed assets or widen/rebuild a Projection.

- [ ] **Step 4: Wire every dispatch surface**

Update all resolver call sites. Keep no-assets dispatch independent of KSTAR lifecycle state.

- [ ] **Step 5: Verify and commit**

```bash
npm run test:js -- test/main/features/group_chat/bus-integration.test.ts test/main/features/group_chat/kstar-commander-centric.test.ts test/main/features/recall/context-projection.test.ts
npm run typecheck
git add src/main/features/group_chat/bus.ts src/main/features/kstar/lifecycle-adapter.ts test/main/features/group_chat/bus-integration.test.ts test/main/features/group_chat/kstar-commander-centric.test.ts
git commit -m "fix(kstar): constrain delegated assets to projection"
```

---

### Task 4: Add evidence-bound secondary attribution and precipitation gates

**Files:**
- Create: `src/main/features/kstar/secondary-attribution.ts`
- Modify: `src/main/features/kstar/types.ts`
- Modify: `src/main/features/kstar/review-service.ts`
- Modify: `src/main/features/kstar/review-inference.ts`
- Modify: `src/main/features/kstar/extraction-service.ts`
- Modify: `src/main/features/kstar/task-level-precipitation.ts`
- Test: `test/main/features/kstar/secondary-attribution.test.ts`
- Test: `test/main/features/kstar/review-inference.test.ts`
- Test: `test/main/features/kstar/review-extraction.test.ts`
- Test: `test/main/features/kstar/task-level-precipitation.test.ts`

- [ ] **Step 1: Write failing validation tests**

Accept valid optional details; reject unsupported categories, confidence outside `[0,1]`, empty evidence, model evidence not in the Episode evidence set, and malformed synced arrays. Legacy Reviews without details remain readable.

- [ ] **Step 2: Run and verify RED**

```bash
npm run test:js -- test/main/features/kstar/secondary-attribution.test.ts test/main/features/kstar/review-inference.test.ts
```

Expected: FAIL because the types/classifier do not exist.

- [ ] **Step 3: Implement the deterministic classifier**

Define the 14 approved categories and `KstarAttributionDetail`. Implement `deriveDeterministicAttributionDetails` using stable failure metadata, InjectionReceipts, UsageReceipts, forecast status and Episode evidence. Do not classify by arbitrary localized prose.

- [ ] **Step 4: Extend model parsing safely**

Allow optional `attributionDetails` with `evidenceRefIds`. Resolve ids only against Episode evidence; drop/reject unknown ids. Deterministic details override conflicts. With no valid detail, persist `insufficient_evidence`.

- [ ] **Step 5: Persist and validate**

Add optional details to Review input/record, normalize evidence at write, and validate every stored field at read without changing schemaVersion or rewriting legacy files.

- [ ] **Step 6: Write failing precipitation tests**

Assert `environment_failure`, `permission_blocked`, `user_goal_changed`, and `insufficient_evidence` do not create a proposal. Reusable categories still pass only through existing confidence, lesson, language, boundary and dedup gates.

- [ ] **Step 7: Implement the precipitation gate**

Add `attributionAllowsReusableLearning(review)`. Call it from both `proposeKstarCandidates` and `aggregateRequirementProposals`. Empty legacy details preserve current behavior; explicit excluded-only details block learning.

- [ ] **Step 8: Verify and commit**

```bash
npm run test:js -- test/main/features/kstar/secondary-attribution.test.ts test/main/features/kstar/review-inference.test.ts test/main/features/kstar/review-extraction.test.ts test/main/features/kstar/task-level-precipitation.test.ts
npm run typecheck
git add src/main/features/kstar/secondary-attribution.ts src/main/features/kstar/types.ts src/main/features/kstar/review-service.ts src/main/features/kstar/review-inference.ts src/main/features/kstar/extraction-service.ts src/main/features/kstar/task-level-precipitation.ts test/main/features/kstar/secondary-attribution.test.ts test/main/features/kstar/review-inference.test.ts test/main/features/kstar/review-extraction.test.ts test/main/features/kstar/task-level-precipitation.test.ts
git commit -m "feat(kstar): add evidence-bound attribution"
```

---

### Task 5: Integrated verification and branch publication

- [ ] **Step 1: Run focused suites**

```bash
npm run test:js -- test/main/features/kstar test/main/features/recall test/main/features/group_chat/bus-integration.test.ts test/main/features/group_chat/kstar-commander-centric.test.ts test/main/features/group_chat/post-merge-chain.test.ts
```

- [ ] **Step 2: Run static and complete gates**

```bash
npm run typecheck
git diff --check
git status --short --untracked-files=all
npm test
```

Record exact pass/skip counts. Do not weaken assertions or raise baselines.

- [ ] **Step 3: Restart and inspect the worktree runtime**

```bash
scripts/restart-cogseed.sh
tail -120 /tmp/cogseed-cogseed-run.log
tail -160 "$HOME/.cogseed/runtime-variants/cogseed/data/logs/$(date +%F).log"
```

If another checkout owns the shared `cogseed` single-instance identity, report it and do not kill unrelated worktrees.

- [ ] **Step 4: Final scope review**

```bash
git diff origin/develop...HEAD --stat
git log --oneline origin/develop..HEAD
git status --short --branch --untracked-files=all
```

Confirm no A2A document, Error Pattern system, runtime binary/model/log, or protected-mainline change exists.

- [ ] **Step 5: Push the tested feature branch**

```bash
git push -u origin codex/kstar-develop-closure-20260903
```

Do not push `develop`.

---

## Verification Matrix

| Requirement | Evidence |
|---|---|
| Injection is not Applied | asset-usage and closure tests |
| Applied requires Host evidence | asset-usage test |
| Effective remains separate | existing proof-service tests |
| Ontology-only and dual-route recall | TaskContract/projection tests |
| Embedding failure does not inject all | projection tests |
| Delegated assets are Projection subset | group-chat tests |
| Projection version drift rejected | group-chat tests |
| Secondary attribution is evidence-bound | attribution/review tests |
| Non-reusable causes do not precipitate | extraction/aggregation tests |
| Legacy records remain readable | projection/review/receipt tests |
| No Error Pattern system | final diff review |
