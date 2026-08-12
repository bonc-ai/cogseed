# Personal Context Center Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Replace the fragmented messaging, Feishu personal-data, ontology-review, and briefing flows with one real-connection-first Personal Context Center while preserving existing user data and tested storage/security primitives.

**Architecture:** Keep the existing registry, scope manifest, cursor CAS, encrypted local-secret facade, messaging delivery manager, auto-task scheduler, and ontology persistence as infrastructure. Add a typed application-service layer that owns the dashboard state and workflows; expose only validated aggregate IPC; replace the current renderer controllers with focused classic-script view/controller modules. Feishu OAuth returns through the existing HTTPS bridge plus Electron deep link, never through a personal-context localhost server.

**Tech Stack:** Electron main process, TypeScript main features, vanilla classic-script renderer, `contextBridge` IPC, existing file/storage/path helpers, existing `node:fetch`/Electron `net.fetch`, Vitest through `npm test`, existing document/file extraction utilities, existing local-secret store, existing messaging and auto-task services.

---

## File map

### Create

- `src/main/features/personal_context/application/types.ts` — dashboard, action, error, resource, review, briefing, and demo-mode contracts.
- `src/main/features/personal_context/application/errors.ts` — typed stage/code errors and sanitized renderer error serialization.
- `src/main/features/personal_context/application/service.ts` — the only feature-level orchestration entry point; every public function accepts `userId` first.
- `src/main/features/personal_context/application/dashboard.ts` — dashboard aggregation from authorization, resources, sync, review, and briefing stores.
- `src/main/features/personal_context/application/authorization.ts` — real Feishu authorization workflow and bridge callback completion.
- `src/main/features/personal_context/application/resources.ts` — discovery, selection, sync, retry, capability filtering, and resource summaries.
- `src/main/features/personal_context/application/review.ts` — candidate list, evidence view, edit-and-approve, reject, and demo-session isolation.
- `src/main/features/personal_context/application/briefing.ts` — preview, test delivery, schedule, pause, and delivery status.
- `src/main/features/personal_context/application/migration.ts` — versioned migration from current files into the new dashboard/runtime metadata.
- `src/main/features/personal_context/feishu/callback-relay.ts` — API-base-derived HTTPS bridge URL construction and one-time flow metadata.
- `src/main/features/personal_context/feishu/content/types.ts` — normalized content, evidence, capability, and warning types.
- `src/main/features/personal_context/feishu/content/handler.ts` — handler registry and common content processing contract.
- `src/main/features/personal_context/feishu/content/calendar-handler.ts` — calendar and event normalization.
- `src/main/features/personal_context/feishu/content/drive-handler.ts` — drive file/folder metadata and supported file content.
- `src/main/features/personal_context/feishu/content/wiki-handler.ts` — wiki-node resolution to underlying object handlers.
- `src/main/features/personal_context/feishu/content/docx-handler.ts` — document block to normalized text/evidence.
- `src/main/features/personal_context/feishu/content/sheet-handler.ts` — paginated sheet values and table evidence.
- `src/main/features/personal_context/feishu/content/bitable-handler.ts` — field/record normalization with page limits.
- `src/main/features/personal_context/demo/provider.ts` — isolated example resources and deterministic sync.
- `src/main/features/personal_context/demo/review-store.ts` — in-memory demo candidates keyed by `demoSessionId`.
- `src/main/features/personal_context/demo/delivery.ts` — preview-only delivery result with explicit demo status.
- `src/renderer/modules/messaging-settings-view.js` — pure-ish DOM rendering helpers for platform settings.
- `src/renderer/modules/personal-context-center.js` — dashboard controller and action dispatch.
- `src/renderer/modules/personal-context-center-view.js` — dashboard, connection, resources, sync, and briefing rendering.
- `src/renderer/modules/personal-context-review.js` — candidate review workbench controller and rendering.
- `src/renderer/modules/briefing-center.js` — preview, test delivery, schedule, pause, and delivery history UI.
- `test/main/features/personal-context-application.test.ts` — application service state and action contracts.
- `test/main/features/personal-context-content.test.ts` — all content handlers and capability filtering.
- `test/main/features/personal-context-callback-relay.test.ts` — bridge URL, flow token, and callback validation.
- `test/main/features/personal-context-migration.test.ts` — migration success, malformed input, atomic fallback, and idempotency.
- `test/renderer/personal-context-center.test.ts` — renderer state/view behavior and action wiring.
- `test/renderer/personal-context-review.test.ts` — candidate evidence and review action behavior.
- `test/renderer/briefing-center.test.ts` — preview, test delivery, scheduled, paused, and failure states.

### Modify

- `src/main/features/personal_context/contract.ts` — add capability/content/review provenance types without importing features.
- `src/main/features/personal_context/registry.ts` — persist resource capability, content status, source validity, and version-safe selection state.
- `src/main/features/personal_context/scope-manifest.ts` — store selected resource IDs and selection version with atomic replacement.
- `src/main/features/personal_context/oauth-manager.ts` — expose a typed callback completion contract and preserve state/nonce/code-verifier validation.
- `src/main/features/personal_context/feishu/oauth.ts` — use the HTTPS bridge redirect URI and retain local code exchange with the messaging app secret.
- `src/main/features/personal_context/feishu/api-client.ts` — add typed paginated reads for calendar events, drive content, wiki resolution, docx blocks, sheet values, and bitable records.
- `src/main/features/personal_context/feishu/discovery.ts` — return capability-aware resources and hide resources that cannot support the requested user action.
- `src/main/features/personal_context/feishu/sync.ts` — dispatch through content handlers, persist snapshots/evidence, and advance cursors only after successful resource writes.
- `src/main/features/personal_context/feishu/provider.ts` — expose capability-aware discovery and handler-backed sync.
- `src/main/features/personal_context/ontology-pipeline.ts` — generate candidate hashes, source versions, evidence, and update candidates.
- `src/main/features/personal_context/briefing.ts` — accept only confirmed facts and return structured preview sections and warnings.
- `src/main/features/personal_context/feishu-dispatch.ts` — return typed delivery receipts and preserve idempotency keys.
- `src/main/features/personal_context/manager.ts` — reduce to compatibility wrappers delegating to the new application service; remove fixed-port flow ownership.
- `src/main/ipc/personal-context.ts` — replace low-level channels with aggregate dashboard/action handlers and strict payload validation.
- `src/main/features/connectors/protocol.ts` — route personal-context callback flow tokens through the existing deep-link owner.
- `src/main/features/connectors/index.ts` — export the personal-context callback adapter without creating a circular dependency.
- `src/main/index.ts` — register boot-time resume/health checks through `util/boot_init.ts` if the new application service needs startup work.
- `src/renderer/index.html` — add the new classic-script modules and the personal-context/briefing mount points.
- `src/renderer/modules/lazy-features.js` — load the new settings, review, and briefing modules in deterministic order.
- `src/renderer/modules/messaging-settings.js` — retain platform registration behavior but delegate DOM composition and personal-context entry rendering.
- `src/renderer/modules/personal-ontology.js` — retain the existing cognition graph and delegate pending-candidate workbench to `personal-ontology-review.js`.
- `src/renderer/style.css` — replace the personal-context guide/card overrides with the new dashboard, resource table, review evidence, and briefing styles using shared classes.
- `src/renderer/locales/zh-CN.json`, `src/renderer/locales/en-US.json`, and all existing renderer locale files — add the new visible strings without reordering existing keys.
- `src/main/locales/*.json` — add main-generated error and command strings where existing main locale conventions require them.
- `test/main/ipc/personal-context-ipc.test.ts` and `test/renderer/lazy-features.test.ts` — update contracts and script expectations.

### Delete after migration tests pass

- `src/main/features/personal_context/callback-server.ts` — replaced by the HTTPS bridge/deep-link flow.
- `src/renderer/modules/personal-context-settings.js` — replaced by the center controller/view.
- Obsolete personal-context CSS selectors and old IPC channels only after compatibility tests prove no remaining caller.

---

## Task 1: Establish the baseline and immutable contracts

**Files:**
- Test: `test/main/features/personal-context-application.test.ts`
- Test: `test/main/features/personal-context-content.test.ts`
- Test: `test/renderer/personal-context-center.test.ts`
- Test: `test/renderer/personal-context-review.test.ts`
- Test: `test/renderer/briefing-center.test.ts`

- [ ] **Step 1: Run the existing focused tests and record failures.**

Run:

```bash
npm test -- --run test/main/features/personal-context-oauth.test.ts test/main/features/personal-context-feishu.test.ts test/main/features/personal-context-ontology.test.ts test/renderer/personal-context-settings.test.ts
```

Expected: the repository test wrapper runs; existing baseline failures, if any, are listed without changing source files.

- [ ] **Step 2: Add test fixtures for real, demo, partial-failure, and reauthorization dashboard states.**

Create fixture builders with these exact shapes:

```ts
export const disconnectedDashboard = (): PersonalContextDashboard => ({
  mode: 'real',
  messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
  authorization: { kind: 'ready_to_authorize', providerId: 'feishu' },
  resources: { selected: 0, discovered: 0, ready: 0, failed: 0 },
  sync: { state: 'idle', lastRunAt: null, nextRunAt: null },
  review: { pending: 0, confirmed: 0, rejected: 0 },
  briefing: { state: 'not_configured', destination: null, lastDelivery: null },
  actions: ['authorize.begin', 'mode.demo.start'],
});
```

Add a second fixture where one resource is `content_failed`, one candidate awaits review, and the briefing is previewable but delivery is unavailable.

- [ ] **Step 3: Run the new fixture tests and confirm they fail only because the new modules do not exist.**

Run:

```bash
npm run test:js -- run test/main/features/personal-context-application.test.ts test/renderer/personal-context-center.test.ts
```

Expected: FAIL with module/import errors, not parser errors in the test files.

- [ ] **Step 4: Commit the baseline fixtures.**

```bash
git add test/main/features/personal-context-application.test.ts test/main/features/personal-context-content.test.ts test/renderer/personal-context-center.test.ts test/renderer/personal-context-review.test.ts test/renderer/briefing-center.test.ts
git commit -m "test: define personal context center contracts"
```

## Task 2: Add typed application contracts and error handling

**Files:**
- Create: `src/main/features/personal_context/application/types.ts`
- Create: `src/main/features/personal_context/application/errors.ts`
- Modify: `src/main/features/personal_context/contract.ts`
- Test: `test/main/features/personal-context-application.test.ts`

- [ ] **Step 1: Add capability and content provenance types to `contract.ts`.**

The new types must include the resource capability fields from the design and must remain pure types. `ExternalResource` gains `capability`, `contentStatus`, `sourceValidity`, and `sourceVersion` fields with validated finite unions.

- [ ] **Step 2: Add the application types.**

The central action union must be finite and explicit:

```ts
export type DashboardAction =
  | 'mode.demo.start'
  | 'mode.real.select'
  | 'authorize.begin'
  | 'authorize.cancel'
  | 'authorize.revoke'
  | 'resources.discover'
  | 'resources.select'
  | 'sync.start'
  | 'sync.retry'
  | 'review.open'
  | 'briefing.preview'
  | 'briefing.test_delivery'
  | 'briefing.schedule';
```

`PersonalContextError` must carry `stage`, `code`, `recoverable`, `userMessageKey`, and a redacted `causeMessage`; it must preserve `cause` using the native `Error` cause option.

- [ ] **Step 3: Add error serialization tests.**

Assert that:

- app secrets and access tokens are removed from serialized errors;
- provider HTTP status and stage remain available;
- non-Error thrown values become a typed internal error;
- `recoverable` and `retryAction` are preserved.

- [ ] **Step 4: Run and commit.**

```bash
npm run test:js -- run test/main/features/personal-context-application.test.ts
npm run typecheck

git add src/main/features/personal_context/contract.ts src/main/features/personal_context/application/types.ts src/main/features/personal_context/application/errors.ts test/main/features/personal-context-application.test.ts
git commit -m "feat: add personal context application contracts"
```

## Task 3: Replace local callback server with bridge plus deep-link flow

**Files:**
- Create: `src/main/features/personal_context/feishu/callback-relay.ts`
- Modify: `src/main/features/personal_context/oauth-manager.ts`
- Modify: `src/main/features/personal_context/feishu/oauth.ts`
- Modify: `src/main/features/connectors/protocol.ts`
- Modify: `src/main/features/connectors/index.ts`
- Delete: `src/main/features/personal_context/callback-server.ts`
- Test: `test/main/features/personal-context-callback-relay.test.ts`
- Test: existing connector protocol tests

- [ ] **Step 1: Write failing callback relay tests.**

Cover:

```ts
expect(buildPersonalContextBridgeUrl('/personal-context/oauth/feishu/callback')).toBe(
  `${apiBase}/personal-context/oauth/feishu/callback`,
);
expect(buildPersonalContextDeepLink({ flowToken: 'flow_1', state: 'state_1' })).toContain(
  'connectors/oauth/callback',
);
expect(parsePersonalContextCallback('invalid://host/path')).toEqual({
  ok: false,
  code: 'invalid_callback_url',
});
```

Also assert that callback parsing rejects missing flow token, empty state, and expired flow timestamps.

- [ ] **Step 2: Implement the callback relay adapter.**

Use the existing API-base helper. Do not hard-code a production domain. The bridge adapter must only carry a one-time flow token and state; it must never accept or return token fields.

- [ ] **Step 3: Extend the connector deep-link router.**

The router recognizes the existing callback path and dispatches to personal-context flow handling when the validated query contains `flow=personal_context`. Existing generic connector OAuth behavior must remain unchanged.

- [ ] **Step 4: Update OAuth manager wiring.**

The personal-context manager owns a per-user/provider pending flow and completes it only after:

1. flow token matches;
2. state matches;
3. nonce matches;
4. code verifier matches;
5. provider code exchange succeeds;
6. returned identity matches the bound owner identity.

- [ ] **Step 5: Run focused tests, then delete the localhost server.**

```bash
npm run test:js -- run test/main/features/personal-context-callback-relay.test.ts test/main/features/personal-context-oauth.test.ts test/main/features/connectors-protocol.test.ts
npm run typecheck
```

Expected: all focused callback and OAuth tests pass; `rg -n "callback-server|36415|startOAuthCallbackServer" src test` returns no production references.

- [ ] **Step 6: Commit.**

```bash
git add src/main/features/personal_context src/main/features/connectors test/main/features test/main/features/connectors-protocol.test.ts
git commit -m "refactor: move personal context OAuth to connector bridge"
```

## Task 4: Build the application service and dashboard aggregation

**Files:**
- Create: `src/main/features/personal_context/application/service.ts`
- Create: `src/main/features/personal_context/application/dashboard.ts`
- Create: `src/main/features/personal_context/application/authorization.ts`
- Create: `src/main/features/personal_context/application/resources.ts`
- Create: `src/main/features/personal_context/application/review.ts`
- Create: `src/main/features/personal_context/application/briefing.ts`
- Modify: `src/main/features/personal_context/manager.ts`
- Test: `test/main/features/personal-context-application.test.ts`

- [ ] **Step 1: Add failing application-service tests.**

Use injected interfaces for OAuth, provider, registry, review store, briefing service, and delivery service. Assert that `getDashboard(userId)` returns one coherent snapshot and that each command returns the refreshed snapshot.

Required behavior:

```ts
const result = await service.authorizeBegin('user-1', { instanceId: 'feishu-1' });
expect(result.dashboard.authorization.kind).toBe('authorizing');
expect(result.dashboard.actions).not.toContain('authorize.begin');
```

A provider failure must produce `partial_failure` for the affected resource while retaining the last successful dashboard data.

- [ ] **Step 2: Implement dependency-injected application services.**

The service must expose:

```ts
getDashboard(userId: string): Promise<PersonalContextDashboard>;
setMode(userId: string, mode: 'real' | 'demo'): Promise<PersonalContextResult>;
authorizeBegin(userId: string, input: AuthorizeBeginInput): Promise<PersonalContextResult>;
authorizeCancel(userId: string): Promise<PersonalContextResult>;
authorizeRevoke(userId: string): Promise<PersonalContextResult>;
discoverResources(userId: string): Promise<PersonalContextResult>;
selectResources(userId: string, input: SelectResourcesInput): Promise<PersonalContextResult>;
startSync(userId: string, input: SyncInput): Promise<PersonalContextResult>;
```

Each method validates bounded IDs, uses `userId` as the first argument, and translates low-level failures into `PersonalContextError`.

- [ ] **Step 3: Make `manager.ts` compatibility-only.**

Existing callers can continue using old exported names during migration, but each wrapper calls the application service. Remove flow state and business composition from `manager.ts`.

- [ ] **Step 4: Run focused main tests and typecheck.**

```bash
npm run test:js -- run test/main/features/personal-context-application.test.ts test/main/features/personal-context-oauth.test.ts test/main/features/personal-context-scheduler.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit.**

```bash
git add src/main/features/personal_context/application src/main/features/personal_context/manager.ts test/main/features/personal-context-application.test.ts
git commit -m "refactor: add personal context application service"
```

## Task 5: Extend Feishu content and capability processing

**Files:**
- Create: `src/main/features/personal_context/feishu/content/types.ts`
- Create: `src/main/features/personal_context/feishu/content/handler.ts`
- Create: `src/main/features/personal_context/feishu/content/calendar-handler.ts`
- Create: `src/main/features/personal_context/feishu/content/drive-handler.ts`
- Create: `src/main/features/personal_context/feishu/content/wiki-handler.ts`
- Create: `src/main/features/personal_context/feishu/content/docx-handler.ts`
- Create: `src/main/features/personal_context/feishu/content/sheet-handler.ts`
- Create: `src/main/features/personal_context/feishu/content/bitable-handler.ts`
- Modify: `src/main/features/personal_context/feishu/api-client.ts`
- Modify: `src/main/features/personal_context/feishu/discovery.ts`
- Modify: `src/main/features/personal_context/feishu/sync.ts`
- Modify: `src/main/features/personal_context/feishu/provider.ts`
- Modify: `src/main/features/personal_context/contract.ts`
- Test: `test/main/features/personal-context-content.test.ts`
- Test: `test/main/features/personal-context-feishu.test.ts`

- [ ] **Step 1: Add failing handler tests for every selectable type.**

Use typed fixtures for:

- calendar and calendar event;
- drive folder and supported document file;
- Wiki node resolving to docx;
- Wiki node resolving to sheet;
- Wiki node resolving to bitable;
- unsupported binary file.

Assert that each normalized result contains `resource`, `version`, `evidence`, and either `text` or `structured`. Assert unsupported content is returned with `canReadContent: false` and an explanatory reason and is not selectable for content understanding.

- [ ] **Step 2: Add typed API client methods with pagination.**

Every method must validate page tokens, cap page size, preserve provider error codes, and return a typed page:

```ts
interface FeishuPage<T> {
  items: T[];
  pageToken: string | null;
  hasMore: boolean;
}
```

Implement the exact provider API calls from the official Feishu documentation during the code task; keep endpoint strings inside `api-client.ts`, not in renderer or prompts.

- [ ] **Step 3: Implement handlers as pure normalization boundaries.**

Handlers do not write storage or call the model. They convert provider payloads into `NormalizedContent` with bounded evidence excerpts and warnings.

- [ ] **Step 4: Integrate handlers into discovery and sync.**

Discovery returns capability-aware resources. Sync writes resource metadata and content snapshot first, then advances the cursor only after the handler and registry write succeed.

- [ ] **Step 5: Run content tests and typecheck.**

```bash
npm run test:js -- run test/main/features/personal-context-content.test.ts test/main/features/personal-context-feishu.test.ts test/main/features/personal-context-registry.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit.**

```bash
git add src/main/features/personal_context/contract.ts src/main/features/personal_context/feishu test/main/features/personal-context-content.test.ts test/main/features/personal-context-feishu.test.ts
git commit -m "feat: add capability-aware Feishu content sync"
```

## Task 6: Add provenance-aware candidate generation and review application service

**Files:**
- Modify: `src/main/features/personal_context/ontology-pipeline.ts`
- Modify: `src/main/features/personal_ontology_candidates.ts`
- Create: `src/main/features/personal_context/application/review.ts`
- Test: `test/main/features/personal-context-ontology.test.ts`
- Test: `test/main/features/personal-context-application.test.ts`

- [ ] **Step 1: Add failing provenance and update-candidate tests.**

Assert:

- identical source version and content hash produce zero duplicate candidates;
- a changed source version with changed normalized text produces one update candidate;
- a deleted source becomes an invalid-source review item, not a silent deletion;
- demo candidates never call the real ontology store;
- unconfirmed candidates are excluded from briefing inputs.

- [ ] **Step 2: Extend candidate persistence with source metadata.**

Add validated fields for `sourceResourceId`, `sourceVersion`, `candidateHash`, `evidence`, `generatedAt`, and `changedFromCandidateId`. Preserve old candidate files through a versioned read path.

- [ ] **Step 3: Implement review actions.**

The application service must expose:

```ts
listReviewItems(userId: string, input: ReviewListInput): Promise<ReviewListResult>;
approveReviewItem(userId: string, input: ApproveReviewInput): Promise<PersonalContextResult>;
rejectReviewItem(userId: string, input: RejectReviewInput): Promise<PersonalContextResult>;
editAndApproveReviewItem(userId: string, input: EditApproveReviewInput): Promise<PersonalContextResult>;
```

Every action is idempotent and returns the refreshed dashboard.

- [ ] **Step 4: Run focused tests and commit.**

```bash
npm run test:js -- run test/main/features/personal-context-ontology.test.ts test/main/features/personal-context-application.test.ts
npm run typecheck

git add src/main/features/personal_context/ontology-pipeline.ts src/main/features/personal_ontology_candidates.ts src/main/features/personal_context/application/review.ts test/main/features/personal-context-ontology.test.ts test/main/features/personal-context-application.test.ts
git commit -m "feat: add provenance-aware personal context review"
```

## Task 7: Implement structured briefing preview, delivery, and schedule actions

**Files:**
- Modify: `src/main/features/personal_context/briefing.ts`
- Modify: `src/main/features/personal_context/feishu-dispatch.ts`
- Create or modify the existing auto-task adapter used by personal context
- Create: `test/main/features/personal-context-briefing-application.test.ts`
- Modify: `test/main/features/personal_context_briefing.test.ts`

- [ ] **Step 1: Add failing briefing tests.**

Cover:

- confirmed facts are included;
- unconfirmed candidate text is excluded and only count is shown;
- source-invalid items are excluded with a warning;
- preview can succeed when delivery is unavailable;
- test delivery returns a typed receipt;
- same task/date/destination idempotency key prevents duplicate delivery;
- schedule and pause return updated state;
- failed delivery remains retryable.

- [ ] **Step 2: Implement structured briefing sections.**

Use `BriefingPreview` with sections, source summary, warnings, and `canDeliver`. Keep text rendering separate from data selection so the renderer can show a preview without sending.

- [ ] **Step 3: Implement a single delivery service.**

`dispatchToFeishuHome` and auto-task execution call the same delivery adapter. The adapter returns `sent`, `deduplicated`, `owner_missing`, `not_connected`, or `failed` without exposing tokens.

- [ ] **Step 4: Run tests and commit.**

```bash
npm run test:js -- run test/main/features/personal-context-briefing-application.test.ts test/main/features/personal_context_briefing.test.ts test/main/features/personal_context_forget.test.ts
npm run typecheck

git add src/main/features/personal_context/briefing.ts src/main/features/personal_context/feishu-dispatch.ts src/main/features/auto_tasks.ts test/main/features/personal-context-briefing-application.test.ts test/main/features/personal_context_briefing.test.ts
git commit -m "feat: add structured briefing preview and delivery"
```

## Task 8: Add demo provider without contaminating real data

**Files:**
- Create: `src/main/features/personal_context/demo/provider.ts`
- Create: `src/main/features/personal_context/demo/review-store.ts`
- Create: `src/main/features/personal_context/demo/delivery.ts`
- Modify: `src/main/features/personal_context/application/service.ts`
- Modify: `src/main/features/personal_context/application/dashboard.ts`
- Test: `test/main/features/personal-context-application.test.ts`

- [ ] **Step 1: Add failing demo isolation tests.**

Assert that:

- demo resources have `mode: demo` and deterministic IDs;
- demo review actions do not call `personal_ontology_candidates` storage;
- demo delivery never calls messaging manager;
- switching back to real mode reloads real state rather than retaining demo counts.

- [ ] **Step 2: Implement deterministic demo adapters.**

Use a fixed sample calendar, one document, one Wiki-backed table, two review candidates, and one briefing preview. Keep all demo state in memory under a generated `demoSessionId`.

- [ ] **Step 3: Run tests and commit.**

```bash
npm run test:js -- run test/main/features/personal-context-application.test.ts
npm run typecheck

git add src/main/features/personal_context/demo src/main/features/personal_context/application test/main/features/personal-context-application.test.ts
git commit -m "feat: add isolated personal context demo mode"
```

## Task 9: Add migration and boot recovery

**Files:**
- Create: `src/main/features/personal_context/application/migration.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/features/personal_context/manager.ts`
- Test: `test/main/features/personal-context-migration.test.ts`

- [ ] **Step 1: Add failing migration tests.**

Cover:

- current OAuth/registry/scope/cursor files migrate once;
- malformed new metadata leaves old files intact;
- interrupted write leaves the previous valid snapshot readable;
- migration is idempotent;
- local backup is outside cloud sync paths;
- demo state is never migrated.

- [ ] **Step 2: Implement versioned migration.**

Use existing storage/path choke points and atomic write helpers. The migration result must report `migrated`, `already_current`, or `failed` with a recoverable error.

- [ ] **Step 3: Register boot-time recovery.**

Use `util/boot_init.ts` for post-boot health check and scheduler resume. Do not add timers or async IIFEs to `src/main/index.ts`.

- [ ] **Step 4: Run tests and commit.**

```bash
npm run test:js -- run test/main/features/personal-context-migration.test.ts test/main/features/personal-context-scheduler.test.ts
npm run typecheck

git add src/main/features/personal_context/application/migration.ts src/main/features/personal_context/manager.ts src/main/index.ts test/main/features/personal-context-migration.test.ts
git commit -m "feat: migrate and recover personal context state"
```

## Task 10: Replace personal-context IPC with aggregate handlers

**Files:**
- Modify: `src/main/ipc/personal-context.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/main/preload.js` only if the allow-list requires explicit channel registration
- Modify: `test/main/ipc/personal-context-ipc.test.ts`
- Modify: `test/main/features/personal-context-ipc.test.ts`

- [ ] **Step 1: Add failing IPC contract tests.**

Assert that every new channel rejects missing or malformed IDs, enforces bounded arrays, and injects the active user ID as the first application-service argument. Assert that raw tokens and secrets never appear in responses.

- [ ] **Step 2: Implement the thin handler table.**

Handlers call only application service methods and return serialized dashboard/action results. No registry, provider, storage, or business branching remains in the IPC file.

- [ ] **Step 3: Keep compatibility channels temporarily.**

Compatibility handlers delegate to the application service and are covered by existing tests. Remove them only after renderer migration in Task 13.

- [ ] **Step 4: Run focused IPC tests and commit.**

```bash
npm run test:js -- run test/main/ipc/personal-context-ipc.test.ts test/main/features/personal-context-ipc.test.ts
npm run typecheck

git add src/main/ipc/personal-context.ts src/main/ipc/index.ts src/main/preload.js test/main/ipc/personal-context-ipc.test.ts test/main/features/personal-context-ipc.test.ts
git commit -m "refactor: expose personal context dashboard IPC"
```

## Task 11: Refactor message platform settings

**Files:**
- Modify: `src/renderer/modules/messaging-settings.js`
- Create: `src/renderer/modules/messaging-settings-view.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/lazy-features.js`
- Modify: `src/renderer/style.css`
- Modify: renderer locale JSON files
- Test: existing messaging settings tests

- [ ] **Step 1: Add view-model tests for platform and Feishu states.**

Cover independent display of `botConnected` and `authorization.kind`, owner missing, administrator diagnostic required, and a connected data-center entry point.

- [ ] **Step 2: Extract rendering helpers.**

`messaging-settings-view.js` owns DOM creation only. It receives normalized model data and callbacks; it does not call IPC or read global feature state.

- [ ] **Step 3: Reduce `messaging-settings.js` to state/controller code.**

Keep existing QR and platform registration flows intact. Replace the inline personal-context card with a clear “个人伴侣数据” entry that opens the new dashboard mount.

- [ ] **Step 4: Add administrator diagnostic panel.**

Show app configuration requirements only when local credential or bridge diagnostics fail. Ordinary connected users see only the personal authorization flow.

- [ ] **Step 5: Run renderer tests and commit.**

```bash
npm run test:js -- run test/renderer/settings-open.test.ts test/renderer/settings-tabs.test.ts test/renderer/settings-commander-backend.test.ts test/renderer/personal-context-settings.test.ts

git add src/renderer/modules/messaging-settings.js src/renderer/modules/messaging-settings-view.js src/renderer/index.html src/renderer/modules/lazy-features.js src/renderer/style.css src/renderer/locales test/renderer
git commit -m "refactor: separate messaging settings from personal data"
```

## Task 12: Build the Personal Context Center renderer

**Files:**
- Create: `src/renderer/modules/personal-context-center.js`
- Create: `src/renderer/modules/personal-context-center-view.js`
- Delete after callers migrate: `src/renderer/modules/personal-context-settings.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/lazy-features.js`
- Modify: `src/renderer/style.css`
- Modify: renderer locale JSON files
- Test: `test/renderer/personal-context-center.test.ts`

- [ ] **Step 1: Add failing renderer state tests.**

Use the existing VM/mock DOM pattern, but test pure transitions instead of internal DOM implementation. Cover:

```ts
expect(viewModel({ authorization: { kind: 'ready_to_authorize' } }).primaryAction).toBe('authorize.begin');
expect(viewModel({ authorization: { kind: 'authorizing' } }).primaryAction).toBe('authorize.cancel');
expect(viewModel({ mode: 'demo', authorization: { kind: 'connected' } }).badge).toContain('演示');
```

- [ ] **Step 2: Implement the dashboard controller.**

The controller calls `personal_context.dashboard.get` and command channels, stores one dashboard snapshot, renders loading/progress/error states, and serializes action clicks. It must guard duplicate clicks and ignore IME-composition key events in any text input.

- [ ] **Step 3: Implement the view.**

Render sections in this order:

1. connection header;
2. progress summary;
3. resources and sync;
4. pending review callout;
5. briefing preview callout;
6. delivery destination;
7. administrator diagnostics;
8. demo-mode entry.

All visible text goes through `t(...)`; all icons use the centralized icon system.

- [ ] **Step 4: Add real/demo mode controls.**

Switching to demo mode requires an explicit user action and visually marks every demo result. Switching back to real mode discards the demo session from renderer state and reloads the real dashboard.

- [ ] **Step 5: Run renderer tests and commit.**

```bash
npm run test:js -- run test/renderer/personal-context-center.test.ts test/renderer/lazy-features.test.ts

git add src/renderer/modules/personal-context-center.js src/renderer/modules/personal-context-center-view.js src/renderer/index.html src/renderer/modules/lazy-features.js src/renderer/style.css src/renderer/locales test/renderer/personal-context-center.test.ts
 git commit -m "feat: add personal context center UI"
```

## Task 13: Replace the ontology candidate page with the review workbench

**Files:**
- Create: `src/renderer/modules/personal-context-review.js`
- Modify: `src/renderer/modules/personal-ontology.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/lazy-features.js`
- Modify: `src/renderer/style.css`
- Modify: renderer locale JSON files
- Test: `test/renderer/personal-context-review.test.ts`

- [ ] **Step 1: Add failing review-workbench tests.**

Cover candidate list, source evidence expansion, filters, edit-and-approve, reject, batch actions, source-invalid warning, and demo-session isolation.

- [ ] **Step 2: Extract candidate review rendering and actions.**

The review module receives `ReviewListResult` and sends only validated candidate IDs and bounded edited text to IPC. It must never read the candidate storage file directly.

- [ ] **Step 3: Preserve the existing cognition graph.**

`personal-ontology.js` keeps graph/confirmed-memory views and mounts the review workbench for pending candidates. Existing memory destination behavior remains available after a candidate is approved.

- [ ] **Step 4: Run renderer tests and commit.**

```bash
npm run test:js -- run test/renderer/personal-context-review.test.ts test/renderer/memory-settings-entry.test.ts

git add src/renderer/modules/personal-context-review.js src/renderer/modules/personal-ontology.js src/renderer/index.html src/renderer/modules/lazy-features.js src/renderer/style.css src/renderer/locales test/renderer/personal-context-review.test.ts
git commit -m "feat: add source-aware ontology review workbench"
```

## Task 14: Build the briefing center and delivery controls

**Files:**
- Create: `src/renderer/modules/briefing-center.js`
- Modify: `src/renderer/modules/personal-context-center.js`
- Modify: `src/renderer/modules/personal-context-center-view.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/lazy-features.js`
- Modify: `src/renderer/style.css`
- Modify: renderer locale JSON files
- Test: `test/renderer/briefing-center.test.ts`

- [ ] **Step 1: Add failing briefing UI tests.**

Cover preview loading, sections with source counts, no-data fallback, test-delivery receipt, owner-missing state, paused schedule, retryable failure, and idempotent repeated click behavior.

- [ ] **Step 2: Implement preview UI.**

Render the structured preview without sending. Show which facts and resources were used, the number of pending candidates excluded, and warnings for unavailable sources.

- [ ] **Step 3: Implement destination and schedule controls.**

Use existing messaging instance and owner APIs. Require an explicit destination before enabling test delivery or scheduling. Show last delivery and next run status.

- [ ] **Step 4: Run renderer tests and commit.**

```bash
npm run test:js -- run test/renderer/briefing-center.test.ts test/renderer/settings-open.test.ts

git add src/renderer/modules/briefing-center.js src/renderer/modules/personal-context-center.js src/renderer/modules/personal-context-center-view.js src/renderer/index.html src/renderer/modules/lazy-features.js src/renderer/style.css src/renderer/locales test/renderer/briefing-center.test.ts
git commit -m "feat: add briefing preview and delivery center"
```

## Task 15: Finish compatibility migration and remove dead paths

**Files:**
- Modify: `src/main/features/personal_context/manager.ts`
- Modify: `src/main/ipc/personal-context.ts`
- Modify: `src/renderer/modules/messaging-settings.js`
- Modify: `src/renderer/modules/personal-ontology.js`
- Delete: `src/renderer/modules/personal-context-settings.js`
- Delete: `src/main/features/personal_context/callback-server.ts`
- Modify: affected tests and lazy-feature expectations

- [ ] **Step 1: Search for old callers.**

Run:

```bash
rg -n "personal_context\.(get_status|begin_authorize|cancel_authorize|get_setup_guide|revoke)|personal-context-settings|callback-server|startOAuthCallbackServer|FEISHU_OAUTH_CALLBACK_PORT|36415" src test
```

Expected: only explicit compatibility tests remain before deletion.

- [ ] **Step 2: Migrate remaining callers to aggregate dashboard actions.**

No renderer file may call old low-level channels after this step.

- [ ] **Step 3: Delete obsolete modules and tests.**

Remove only files with zero production callers and replace their behavioral coverage with application-service or center tests.

- [ ] **Step 4: Run typecheck and focused tests.**

```bash
npm run typecheck
npm run test:js -- run test/main/features test/main/ipc/personal-context-ipc.test.ts test/renderer/personal-context-center.test.ts test/renderer/personal-context-review.test.ts test/renderer/briefing-center.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add src/main src/renderer test
 git commit -m "refactor: remove legacy personal context flows"
```

## Task 16: Full verification and real-environment run

**Files:**
- No source changes unless verification finds a concrete failure.
- Review: `docs/research/2026-08-10-feishu-mvp-acceptance-checklist.md`
- Review: `docs/superpowers/specs/2026-08-10-personal-context-center-refactor-design.md`

- [ ] **Step 1: Run the repository test command.**

```bash
npm test
```

Expected: the managed JS and resource test commands complete. Record pre-existing environment failures separately from regressions introduced by this refactor.

- [ ] **Step 2: Run the type checker.**

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Restart the messaging runtime.**

```bash
scripts/restart-mate.sh
```

Then inspect:

```bash
ls -t ~/.orkas/runtime-variants/messaging/data/logs/*.log | head -1
sed -n '1,240p' /tmp/mate-agent-messaging-run.log
```

Expected: the messaging runtime starts without new personal-context, IPC, or renderer bootstrap errors.

- [ ] **Step 4: Run the real connection checklist.**

Verify:

1. message platform bot connection is visible separately from personal data authorization;
2. real Feishu OAuth opens in the system browser;
3. callback returns through the configured HTTPS bridge and current Electron instance;
4. resource discovery lists all capability-supported resources;
5. full content sync creates source-aware candidates;
6. review actions update the real ontology;
7. briefing preview only uses confirmed facts;
8. test delivery reaches the selected Feishu home conversation;
9. scheduled delivery is idempotent;
10. revoke and reauthorization converge correctly.

- [ ] **Step 5: Reconcile the acceptance checklist.**

Update `docs/research/2026-08-10-feishu-mvp-acceptance-checklist.md` so its scope names, callback assumptions, administrator prerequisites, and expected UI match the implementation. Run `git diff --check` and commit the documentation reconciliation.

- [ ] **Step 6: Final status review.**

Run:

```bash
git status --short --branch
git diff --check HEAD~1..HEAD
```

Report exact test counts, exact known baseline failures, real-environment results, and any external HTTPS bridge prerequisite without claiming product completion unless the evidence supports it.

## Self-review checklist

- **Spec coverage:** Tasks 2–4 cover the application contracts, state machine, OAuth, deep-link bridge, and aggregate IPC. Task 5 covers every capability-aware resource/content handler. Task 6 covers provenance and review. Task 7 covers structured briefings and delivery. Tasks 8–9 cover demo isolation, migration, and boot recovery. Tasks 11–14 cover all requested renderer surfaces. Tasks 15–16 cover deletion, regression tests, restart, and real validation.
- **Constraint coverage:** Task 3 removes the local HTTP server. Task 9 uses boot initialization and local-only migration backup. Tasks 10–14 preserve classic scripts, IPC allow-lists, i18n, icon centralization, and IME handling.
- **Type consistency:** `PersonalContextDashboard`, `DashboardAction`, `PersonalContextError`, `NormalizedContent`, `BriefingPreview`, and review input types are defined in application/contract modules before their consumers.
- **No unbounded content:** Task 5 requires page-size caps, body limits, evidence excerpts, and structured pagination.
- **No silent recovery:** Every failure path returns a stage/code/retry action and remains visible in dashboard state.
- **No dual long-term architecture:** Task 15 removes the obsolete renderer, localhost callback, and low-level caller paths after migration coverage passes.
