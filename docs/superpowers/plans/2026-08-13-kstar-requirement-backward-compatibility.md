# KStar Requirement Backward Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Allow current KStar projection confirmation and wake binding to continue working when older schemaVersion 1 requirement records do not contain `projectionIds`.

**Architecture:** Add a read-time normalization boundary in `requirement-store.ts`. Before validating a persisted requirement, derive a safe `projectionIds` array from an existing array or the legacy singular `projectionId`; never rewrite or delete the persisted JSON in this change. New writes continue through the existing validator and therefore require the current typed shape.

**Tech Stack:** TypeScript, Vitest, filesystem-backed KStar JSON records.

---

### Task 1: Add regression coverage for legacy requirement reads

**Files:**
- Modify: `test/main/features/kstar/requirement-store.test.ts`

- [ ] **Step 1: Add a helper that writes raw requirement JSON without the current validator**

Use `paths.kstarRequirementPath` and `fs.mkdirSync`/`fs.writeFileSync` so the fixture can represent an old record that omits `projectionIds`.

```ts
async function writeRawRequirement(
  userId: string,
  requirementId: string,
  record: Record<string, unknown>,
) {
  const { paths } = await storeModules();
  const file = paths.kstarRequirementPath(userId, requirementId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}
```

- [ ] **Step 2: Add a failing test for single-record read normalization**

Create a valid legacy requirement with `projectionId: 'projection-current'` and no `projectionIds`; read it and assert the returned object contains `projectionIds: ['projection-current']`.

- [ ] **Step 3: Add a failing test for projection lookup across mixed history**

Write two raw records for the same user: an older valid requirement without `projectionIds`, and a current valid requirement with `projectionIds`. Call `findKstarRequirementForProjection(userId, conversationId, currentProjectionId)` and assert it returns the current requirement rather than throwing `malformed kstar requirement`.

- [ ] **Step 4: Add a failing test for wake binding across mixed history**

Use the same mixed records and call `bindKstarRequirementWake` for the current projection. Assert it binds the current requirement and does not fail while reading the old record.

- [ ] **Step 5: Run only the requirement-store tests and confirm RED**

Run:

```bash
npm run test:js -- test/main/features/kstar/requirement-store.test.ts
```

Expected before implementation: the new tests fail with `malformed kstar requirement` because the old raw record lacks `projectionIds`.

### Task 2: Implement read-time normalization

**Files:**
- Modify: `src/main/features/kstar/requirement-store.ts`

- [ ] **Step 1: Add an internal normalizer immediately before requirement validation**

Implement a narrow helper:

```ts
function normalizeRequirementForRead(raw: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(raw.projectionIds)) return raw;
  if (typeof raw.projectionId === 'string' && safeId(raw.projectionId)) {
    return { ...raw, projectionIds: [raw.projectionId] };
  }
  return { ...raw, projectionIds: [] };
}
```

Do not mutate `raw`, do not write the normalized object back to disk, and do not silently repair invalid non-empty legacy `projectionId` values.

- [ ] **Step 2: Route every persisted requirement read through the normalizer**

Update these paths so they call `validateRequirement(userId, normalizeRequirementForRead(raw))`:

- `readKstarRequirement`
- `listKstarRequirementsForTask`
- `findKstarRequirementForProjection`
- `bindKstarRequirementWake`

Keep `replaceKstarRequirement` strict so new writes still require `projectionIds`.

- [ ] **Step 3: Keep lookup semantics unchanged**

Projection lookup continues matching the legacy singular `projectionId` pointer, while normalization only supplies the required array for validation and returned typing. Do not change duplicate detection or wake-request conflict behavior.

- [ ] **Step 4: Run the requirement-store tests and confirm GREEN**

Run:

```bash
npm run test:js -- test/main/features/kstar/requirement-store.test.ts
```

Expected: all tests in the file pass, including the new legacy-record tests.

### Task 3: Verify adjacent KStar behavior and type safety

**Files:**
- No additional source files expected.

- [ ] **Step 1: Run all KStar feature tests**

Run:

```bash
npm run test:js -- test/main/features/kstar
```

Expected: all KStar test files pass.

- [ ] **Step 2: Run the TypeScript compiler**

Run:

```bash
npm run typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Check the diff and verify no persisted user data changed**

Run:

```bash
git diff --check
git status --short
git diff -- src/main/features/kstar/requirement-store.ts test/main/features/kstar/requirement-store.test.ts
```

Expected: only source/test changes for this compatibility fix, plus the pre-existing skill-registry changes from the previous task; no files under a runtime data root are modified.

### Task 4: Run final focused verification

**Files:**
- No additional source files expected.

- [ ] **Step 1: Re-run the requirement-store regression file fresh**

Run:

```bash
npm run test:js -- test/main/features/kstar/requirement-store.test.ts
```

Record the exact pass count.

- [ ] **Step 2: Re-run the KStar confirmation-adjacent tests**

Run:

```bash
npm run test:js -- test/main/features/kstar/pre-execution-service.test.ts test/main/features/kstar/lifecycle-adapter.test.ts test/main/features/kstar/task-closure.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 3: Report the unrelated pre-existing runner failure separately if encountered**

If `test/main/model/runner.test.ts` still expects Recall candidate status `pending` while the current implementation returns `pending_review`, do not alter it in this task. Record it as unrelated because this compatibility patch only touches requirement reads and its tests.
