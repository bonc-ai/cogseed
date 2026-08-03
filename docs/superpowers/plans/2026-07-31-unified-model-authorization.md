# Unified Model Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Replace the split model-provider and add-account Settings flows with one authorization-first wizard that supports OAuth or API Key, secure CC Switch import, post-credential model discovery, multi-model selection, and one explicit default model.

**Architecture:** Keep the encrypted `auth-profiles` store and existing runtime model entries. Add high-level user-scoped authorization operations in `features/auth.ts`, a focused discovery/CC Switch draft module, thin IPC routes, and a new lazy-loaded classic Renderer module that owns an explicit wizard state. Built-in profiles and custom-provider records keep their current storage representations; no eager migration or parallel credential store is introduced.

**Tech Stack:** Electron IPC, Node/TypeScript feature modules, encrypted local-secret storage, vanilla Renderer HTML/CSS/classic JavaScript, Vitest.

---

## File Structure

### New files

- `src/main/features/model_authorization_discovery.ts` — protocol-specific model discovery, error classification, and short-lived CC Switch draft handling. It never persists credentials.
- `src/renderer/modules/model-authorization.js` — pure wizard state helpers plus the unified authorization modal and authorization-card UI.
- `test/main/features/model_authorization_discovery.test.ts` — discovery parsing, failure classification, and secret-safe CC Switch draft tests.
- `test/main/features/model_authorizations.test.ts` — atomic completion, idempotency, summaries, removal, and unbound OAuth tests.
- `test/renderer/model-authorization-flow.test.ts` — pure Renderer state and selection/default tests.
- `test/renderer/model-authorization-ui.test.ts` — Settings markup, IPC flow, stale response, IME, and legacy-card integration tests.

### Modified files

- `src/main/features/auth.ts` — versioned request receipts, serialized single-store mutations, authorization summaries, atomic completion/removal, and draft credential connection testing.
- `src/main/features/custom_providers.ts` — expose a bounded internal CC Switch item resolver without changing the existing masked preview contract.
- `src/main/ipc/index.ts` — validate and forward `modelAuthorizations.*` requests with `ctx.userId`.
- `src/renderer/modules/ipc-shim.js` — add centralized shim routes for the new channels.
- `src/renderer/modules/lazy-features.js` — load `model-authorization.js` before `settings.js`.
- `src/renderer/modules/settings.js` — stop rendering the competing picker, retain advanced custom-authorization editing, and delegate unified refresh to the new module.
- `src/renderer/index.html` — replace the two primary sections with one authorization surface and add one wizard modal.
- `src/renderer/style.css` — wizard, model picker, card, progress, and responsive styles using existing visual tokens.
- `src/renderer/locales/{en,zh,ja,pt}.json` — all new visible strings.
- `test/renderer/settings-add-account.test.ts` — replace old picker assertions with the unified surface contract.
- `test/renderer/settings-custom-providers.test.ts` — move custom providers under Advanced management and remove CC Switch as a separate primary action.
- `test/main/features/auth.test.ts` — store-version parsing and existing auth regression assertions.

---

### Task 1: Atomic authorization store operations

**Files:**
- Modify: `src/main/features/auth.ts`
- Create: `test/main/features/model_authorizations.test.ts`
- Modify: `test/main/features/auth.test.ts`

- [ ] **Step 1: Write failing tests for summaries and atomic completion**

Add fixtures that activate a test user and cover these exported contracts:

```ts
const result = await auth.completeAuthorization(TEST_UID, {
  requestId: 'req-built-in-1',
  authType: 'api_key',
  source: 'manual',
  providerKind: 'builtin',
  providerId: 'anthropic',
  label: 'work',
  apiKey: 'sk-test',
  selectedModels: ['claude-sonnet-4-5', 'claude-haiku-3-5'],
  defaultModel: 'claude-sonnet-4-5',
});

expect(result).toMatchObject({
  ok: true,
  authorization: {
    authType: 'api_key',
    providerId: 'anthropic',
    enabledModels: ['claude-sonnet-4-5', 'claude-haiku-3-5'],
    defaultModel: 'claude-sonnet-4-5',
  },
});
```

Also test:

- custom completion stores one `CustomProvider` and entries use `cp:<id>` for provider/profile;
- selected models are deduplicated while retaining order;
- an empty selection is rejected;
- a default outside the selection is rejected;
- repeating the same `requestId` returns the original summary and creates no duplicate profile/provider/entry;
- different completion calls are serialized and do not lose entries;
- a thrown store-save dependency leaves the prior persisted state unchanged;
- `listAuthorizationSummaries(userId)` includes normal profiles, custom providers, enabled models, default model, masked credentials, source, and OAuth profiles with zero models as `unbound: true`;
- no returned object contains API keys, OAuth access tokens, or refresh tokens.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/main/features/model_authorizations.test.ts test/main/features/auth.test.ts
```

Expected: FAIL because the new types and functions do not exist.

- [ ] **Step 3: Add the versioned request receipt field and parsers**

Extend `ProfilesFile` without rewriting valid older data eagerly:

```ts
interface AuthorizationRequestReceipt {
  requestId: string;
  authorizationId: string;
  createdAt: number;
}

interface ProfilesFile {
  // existing fields
  authorizationRequests?: AuthorizationRequestReceipt[];
}
```

Parse only bounded valid receipts and retain the newest 100. Bump the store version to 6. Preserve existing profiles, entries, media profiles, and custom providers.

- [ ] **Step 4: Implement one serialized store mutation primitive**

Add a user-scoped queue without a wait timeout:

```ts
const authorizationMutationTails = new Map<string, Promise<void>>();

async function withAuthorizationMutation<T>(
  userId: string,
  run: (store: ProfilesFile) => Promise<{ store: ProfilesFile; result: T }> | { store: ProfilesFile; result: T },
): Promise<T>;
```

Requirements:

- call `assertActiveUser(userId)` at entry;
- wait for the prior user mutation;
- load once;
- build the next store in memory;
- call `saveProfiles(nextStore)` once;
- invalidate the core-agent runner only after a successful save;
- always release the queue in `finally`;
- do not add a lock wait timeout.

Allow tests to inject a failing save through a guarded test-only dependency seam rather than monkey-patching filesystem globals.

Harden `saveProfiles` itself to write an encrypted sibling temporary file with mode `0600` and rename it over the destination. Clean up the temporary file on failure. This preserves the existing local-secret facade while preventing a partial file write from corrupting the only auth store.

- [ ] **Step 5: Implement completion and summaries**

Export:

```ts
export type CompleteAuthorizationInput =
  | BuiltinApiKeyCompletion
  | BuiltinOAuthCompletion
  | CustomApiKeyCompletion;

export async function completeAuthorization(
  userId: string,
  input: CompleteAuthorizationInput,
): Promise<{ ok: true; authorization: AuthorizationSummary }>;

export function listAuthorizationSummaries(
  userId: string,
): { authorizations: AuthorizationSummary[] };
```

Rules:

- built-in API Key creates/reuses a `StoredProfile` inside the single mutation;
- OAuth requires an existing matching OAuth `profileId` and never rewrites its token;
- custom/manual and CC Switch create/update one `CustomProvider` and use `cp:<id>` as provider/profile;
- selected models are stored on the custom provider and as entries;
- newly selected entries are placed at the front in `[default, ...otherSelected]` order;
- existing unrelated entry order remains stable;
- request receipts are added only with the successful store save;
- summaries use stable authorization IDs `profile:<profileId>` and `custom:<customId>`.

- [ ] **Step 6: Implement atomic model and authorization removal**

Export:

```ts
export async function removeAuthorizationModel(
  userId: string,
  authorizationId: string,
  entryId: string,
): Promise<{ removed: boolean; authorization?: AuthorizationSummary }>;

export async function removeAuthorization(
  userId: string,
  authorizationId: string,
): Promise<{ removed: boolean }>;
```

Rules:

- the entry must belong to the supplied authorization;
- deleting one model preserves its credential record;
- if the default entry is removed, the next remaining entry becomes default through order;
- deleting `profile:<id>` removes its entries and stored profile together;
- deleting `custom:<id>` removes its `cp:<id>` entries and custom-provider record together;
- unknown IDs are safe no-ops.

- [ ] **Step 7: Run GREEN**

```bash
npm run test:js -- test/main/features/model_authorizations.test.ts test/main/features/auth.test.ts
npm run typecheck
```

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/main/features/auth.ts test/main/features/model_authorizations.test.ts test/main/features/auth.test.ts
git commit -m "feat(auth): add atomic multi-model authorizations"
```

---

### Task 2: Credential draft validation and model discovery

**Files:**
- Create: `src/main/features/model_authorization_discovery.ts`
- Modify: `src/main/features/auth.ts`
- Modify: `src/main/features/custom_providers.ts`
- Modify: `src/main/features/ccswitch_import.ts`
- Create: `test/main/features/model_authorization_discovery.test.ts`
- Modify: `test/main/features/ccswitch_import.test.ts`

- [ ] **Step 1: Write failing protocol and CC Switch draft tests**

Use an injected `fetch` and clock. Cover:

```ts
const result = await discoverModels(TEST_UID, {
  kind: 'custom_api_key',
  protocol: 'openai',
  baseUrl: 'https://relay.example/v1',
  apiKey: 'secret',
});
expect(result).toEqual({
  ok: true,
  source: 'live',
  models: [{ id: 'model-a', name: 'Model A' }],
});
```

Test these exact cases:

- OpenAI-compatible `GET <base>/models`, Bearer header, `data[].id` parsing;
- Anthropic-compatible `GET <base>/models` when Base URL already ends in `/v1`, otherwise `<base>/v1/models`, with `x-api-key` and `anthropic-version` headers;
- Gemini-compatible `GET <base>/models` when Base URL contains an API version, otherwise `<base>/v1beta/models`, with `x-goog-api-key`; strip the `models/` prefix from names;
- 401/403 → `auth_failed`;
- 404/405 → `unsupported_discovery` and manual IDs allowed;
- timeout/network/5xx → retryable errors and manual IDs not automatically enabled;
- built-in provider discovery returns existing curated models with `source: 'catalog'`;
- model IDs are trimmed, deduplicated, bounded to 500, and never include empty values;
- CC Switch preparation returns a random opaque `draftId` and sanitized metadata but no raw key;
- missing-key CC Switch rows are rejected;
- draft expiry and one-time consumption;
- logs and results never contain the raw key.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/main/features/model_authorization_discovery.test.ts
```

Expected: FAIL because the discovery module does not exist.

- [ ] **Step 3: Expose an internal CC Switch resolver**

First extend `CcSwitchImportItem` with `models?: string[]`. Extract bounded model hints from fields CC Switch configurations already carry when present:

- JSON `models` arrays;
- JSON `model` / `defaultModel` / `default_model` strings;
- environment values `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `GEMINI_MODEL`, and `GOOGLE_MODEL`;
- Codex TOML `model = "..."`.

Trim, deduplicate, and cap hints at 100. Absence produces no `models` property. Add importer fixtures proving hints are extracted without changing existing rows.

In `custom_providers.ts`, export a user-scoped function that reads one exact external ID from the existing read-only CC Switch importer:

```ts
export function getCcSwitchAuthorizationSource(
  userId: string,
  externalId: string,
): { ok: true; item: CcSwitchImportItem } | { ok: false; reason: string };
```

It validates active user scope, bounds the ID, returns no list-wide side effects, and does not change the existing masked IPC preview.

- [ ] **Step 4: Implement short-lived secure draft storage**

In the discovery module, keep CC Switch raw credentials in a process-local map:

```ts
interface CcSwitchDraft {
  userId: string;
  item: CcSwitchImportItem;
  expiresAt: number;
}
```

Rules:

- opaque crypto-random draft ID;
- 10-minute expiry;
- maximum 20 drafts per user, evict oldest first;
- sanitized response includes protocol, Base URL, display name, external ID, declared models, and draft ID;
- raw key never crosses IPC during preview/preparation;
- successful completion consumes the draft; validation failure does not consume it so the user can retry;
- expired drafts return `draft_expired`.

- [ ] **Step 5: Implement protocol discovery**

Export:

```ts
export async function discoverAuthorizationModels(
  userId: string,
  input: AuthorizationDiscoveryInput,
  deps?: DiscoveryDeps,
): Promise<AuthorizationDiscoveryResult>;
```

Use `undici`/global fetch already available in the project; add no dependency. Normalize only HTTP(S) Base URLs with no embedded credentials. Use an abort controller with a 20-second discovery timeout and return structured error codes rather than raw provider bodies.

- [ ] **Step 6: Refactor draft connection testing**

Extract the provider-building/probe portion of `auth.testConnection` into a helper that accepts an ephemeral credential:

```ts
export async function testAuthorizationDraft(
  userId: string,
  input: {
    providerId?: string;
    protocol?: 'openai' | 'anthropic' | 'gemini';
    baseUrl?: string;
    apiKey?: string;
    oauthProfileId?: string;
    model: string;
  },
): Promise<TestConnectionResult>;
```

Requirements:

- OAuth delegates to the existing stored-profile path;
- built-in API Key uses the same provider adapter logic without saving first;
- custom API Key builds the existing custom-provider runtime model/provider from an ephemeral record;
- error logs contain no key or credential-bearing URL;
- `testConnection` remains backward compatible and reuses the extracted probe.

- [ ] **Step 7: Run GREEN**

```bash
npm run test:js -- test/main/features/model_authorization_discovery.test.ts test/main/features/auth.test.ts test/main/features/custom_providers.test.ts test/main/features/ccswitch_import.test.ts
npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/main/features/model_authorization_discovery.ts src/main/features/auth.ts src/main/features/custom_providers.ts src/main/features/ccswitch_import.ts test/main/features/model_authorization_discovery.test.ts test/main/features/ccswitch_import.test.ts
git commit -m "feat(auth): discover models from authorization drafts"
```

---

### Task 3: IPC contracts for the unified workflow

**Files:**
- Modify: `src/main/ipc/index.ts`
- Modify: `src/renderer/modules/ipc-shim.js`
- Create: `test/main/ipc/model-authorizations.test.ts`
- Modify: `test/renderer/preload-push-allowlist.test.ts`

- [ ] **Step 1: Write failing IPC validation tests**

Test the following channels:

```text
modelAuthorizations.list
modelAuthorizations.prepareCcSwitch
modelAuthorizations.discover
modelAuthorizations.testDraft
modelAuthorizations.complete
modelAuthorizations.removeModel
modelAuthorizations.remove
```

Assertions:

- every private-data feature call receives `ctx.userId` first;
- request IDs, labels, provider IDs, external IDs, model IDs, Base URLs, and arrays are type/bounds checked;
- `selectedModels` is capped at 100;
- raw keys may enter only `discover`, `testDraft`, and `complete` requests;
- raw keys never appear in IPC responses;
- malformed auth-type/source/provider-kind combinations are rejected before feature calls;
- the Renderer shim resolves each new route through centralized invoke.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/main/ipc/model-authorizations.test.ts test/renderer/preload-push-allowlist.test.ts
```

- [ ] **Step 3: Implement thin handlers**

Add imports for the discovery module and forward only validated payloads. Do not place model normalization, storage mutation, CC Switch reading, or rollback logic in IPC.

Example shape:

```ts
'modelAuthorizations.list': async (_args, ctx) =>
  auth.listAuthorizationSummaries(ctx.userId),

'modelAuthorizations.complete': async (args, ctx) =>
  auth.completeAuthorization(ctx.userId, validateCompleteAuthorizationArgs(args)),
```

- [ ] **Step 4: Add shim routes and verify preload remains allow-list only**

Update the existing centralized shim mapping. Do not add a new `window.orkas.*` surface; the Renderer continues to call `window.orkas.invoke(channel, payload)`.

- [ ] **Step 5: Run GREEN and commit**

```bash
npm run test:js -- test/main/ipc/model-authorizations.test.ts test/renderer/preload-push-allowlist.test.ts
npm run typecheck
git add src/main/ipc/index.ts src/renderer/modules/ipc-shim.js test/main/ipc/model-authorizations.test.ts test/renderer/preload-push-allowlist.test.ts
git commit -m "feat(ipc): expose unified model authorization workflow"
```

---

### Task 4: Pure Renderer wizard state

**Files:**
- Create: `src/renderer/modules/model-authorization.js`
- Create: `test/renderer/model-authorization-flow.test.ts`
- Modify: `src/renderer/modules/lazy-features.js`

- [ ] **Step 1: Write failing pure-helper tests**

Require the guarded CommonJS bridge and test:

```js
const draft = createAuthorizationDraft();
const next = transitionAuthorizationDraft(draft, {
  type: 'choose_auth_type',
  authType: 'api_key',
});
expect(next.step).toBe('api_key_source');
```

Cover:

- allowed state transitions for OAuth, manual key, and CC Switch;
- CC Switch remains `authType: 'api_key'` with `source: 'ccswitch'`;
- secret values are absent from `serializeSafeDraft`;
- discovered models are normalized/deduplicated;
- declared CC Switch models are preselected only when discovered;
- no declarations means no selection;
- toggling model selection repairs an invalid default;
- default must be selected;
- manual model IDs are accepted only for `unsupported_discovery`;
- stale discovery tokens are ignored;
- completion payload includes selected/default models and the active credential source.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/renderer/model-authorization-flow.test.ts
```

- [ ] **Step 3: Implement focused pure helpers**

The module exposes browser globals for Settings integration and a guarded test bridge:

```js
window.ModelAuthorizationFlow = {
  createDraft,
  transition,
  applyDiscovery,
  toggleModel,
  setDefaultModel,
  buildCompletionPayload,
  serializeSafeDraft,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
```

Assign `api` to `window.ModelAuthorizationFlow` only when `window` exists. Do not reference DOM, i18n, or IPC from the pure helper block.

- [ ] **Step 4: Load the module before Settings**

Change the lazy feature order to:

```js
settings: [
  { src: './modules/model-authorization.js' },
  { src: './modules/settings.js' },
  { src: './modules/memory.js' },
],
```

- [ ] **Step 5: Run GREEN and commit**

```bash
npm run test:js -- test/renderer/model-authorization-flow.test.ts test/renderer/conversation-lazy-chat-use.test.ts

git add src/renderer/modules/model-authorization.js src/renderer/modules/lazy-features.js test/renderer/model-authorization-flow.test.ts
git commit -m "feat(renderer): add model authorization wizard state"
```

---

### Task 5: Unified Settings markup, styles, and localization

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Modify: `test/renderer/settings-add-account.test.ts`
- Modify: `test/renderer/settings-custom-providers.test.ts`
- Create: `test/renderer/model-authorization-ui.test.ts`

- [ ] **Step 1: Write failing static UI contract tests**

Assert that Settings contains one primary surface:

```html
<div id="settings-model-authorizations">
  <button id="settings-model-authorization-add-btn"></button>
  <button id="settings-model-authorization-advanced-btn"></button>
  <div id="settings-model-authorization-list"></div>
</div>
```

And one modal:

```html
<div id="model-authorization-modal">
  <div id="model-authorization-steps"></div>
  <div id="model-authorization-body"></div>
  <div id="model-authorization-status"></div>
  <div id="model-authorization-actions"></div>
</div>
```

Assert the primary Credentials pane no longer contains:

- `settings-picker-provider`;
- `settings-picker-model`;
- `settings-ccswitch-preview-btn`;
- a primary `settings-custom-provider-add-btn`.

The existing custom-provider list and edit modal remain under an initially collapsed Advanced management container.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/renderer/settings-add-account.test.ts test/renderer/settings-custom-providers.test.ts test/renderer/model-authorization-ui.test.ts
```

- [ ] **Step 3: Replace credentials markup**

Use existing `settings-group`, `btn`, `entry-row`, modal, and status classes wherever possible. Add only specific modifiers for:

- authorization cards;
- step indicator;
- auth-type/source choice cards;
- searchable model list;
- selected/default model controls;
- unbound authorization warning;
- progress state.

Check existing z-index tiers before adding modal styling. Reuse centralized icons through `data-ui-icon`; do not add inline SVG or emoji.

- [ ] **Step 4: Add complete four-language strings**

Add matching keys under `settings.model_authorization.*` for:

- page title/subtitle;
- add and advanced actions;
- OAuth/API Key/source labels;
- CC Switch preview states;
- progress and retry messages;
- model search, selected count, default label, manual model fallback;
- unbound OAuth state/resume/remove;
- deletion confirmations;
- structured error-code messages.

Verify all four locale files have the same key set.

- [ ] **Step 5: Run GREEN and commit**

```bash
npm run test:js -- test/renderer/settings-add-account.test.ts test/renderer/settings-custom-providers.test.ts test/renderer/model-authorization-ui.test.ts test/renderer/evolution-i18n.test.ts
git diff --check

git add src/renderer/index.html src/renderer/style.css src/renderer/locales test/renderer/settings-add-account.test.ts test/renderer/settings-custom-providers.test.ts test/renderer/model-authorization-ui.test.ts
git commit -m "feat(settings): unify model authorization surface"
```

---

### Task 6: Interactive wizard and OAuth/API Key/CC Switch flow

**Files:**
- Modify: `src/renderer/modules/model-authorization.js`
- Modify: `src/renderer/modules/settings.js`
- Modify: `test/renderer/model-authorization-ui.test.ts`
- Modify: `test/renderer/settings-custom-providers.test.ts`

- [ ] **Step 1: Write failing interactive tests**

Build a VM/fake-DOM harness and cover:

1. Add authorization opens at auth-type selection.
2. OAuth shows only OAuth-capable providers and starts the existing OAuth flow.
3. OAuth `done` profile proceeds to discovery rather than immediately creating one entry.
4. Manual API Key requires interface type and key; custom requires Base URL.
5. CC Switch preview shows masked metadata; selecting a valid row calls `prepareCcSwitch` and never receives a raw key.
6. Discovery shows progress and disables duplicate actions.
7. A late discovery response is discarded after the user changes source/provider.
8. Model rows support multi-select and one default.
9. CC Switch declared models are preselected according to the pure helper.
10. Completion calls one `modelAuthorizations.complete` request, closes on success, and refreshes cards.
11. Completion failure preserves the draft and permits retry.
12. Enter handlers ignore `e.isComposing || e.keyCode === 229`.
13. Advanced management expands existing custom authorization rows and edit/remove actions, but has no competing add/import primary flow.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/renderer/model-authorization-ui.test.ts test/renderer/settings-custom-providers.test.ts
```

- [ ] **Step 3: Implement modal rendering and event wiring**

Inside `model-authorization.js`, add a UI controller that:

- owns one in-memory draft;
- renders each step into the existing modal body;
- uses `window.orkas.invoke` only through the centralized channels;
- stores a discovery generation token before each async call;
- rerenders on `i18n-change` without discarding the draft;
- never writes the key into a DOM attribute, dataset, local storage, or log;
- exposes `window.initModelAuthorizationSettings()` and `window.refreshModelAuthorizationSettings()`.

- [ ] **Step 4: Integrate Settings refresh**

In `settings.js`:

- remove calls that render the old provider/model picker;
- keep provider/profile refreshes required by media and legacy controls;
- initialize the unified controller after Settings loads;
- delegate authorization-card refresh after add/edit/remove;
- retain existing custom-provider edit UI only inside Advanced management;
- remove the old standalone CC Switch preview/sync entry path from visible controls.

- [ ] **Step 5: Implement OAuth continuation**

Reuse existing OAuth polling semantics, but on `{ kind: 'done', profileId }`:

```js
transition({ type: 'credential_ready', profileId });
await discoverModels();
```

Do not call `auth.addEntry` directly. Cancelling after OAuth completion leaves the backend profile visible as unbound on the next refresh.

- [ ] **Step 6: Implement API Key and CC Switch continuation**

- Manual built-in/custom drafts call discovery with the current key.
- CC Switch calls `prepareCcSwitch`, receives only `draftId` and sanitized metadata, then discovers with `draftId`.
- After model selection, call `testDraft` using the default model.
- Only a successful test advances to confirmation, except manual model fallback where the UI explicitly marks the model unverified and asks for confirmation.

- [ ] **Step 7: Implement card actions**

Cards show auth type, source, masked credential, model count, default, and unbound status. Actions:

- resume an unbound authorization;
- manage models by reopening at discovery/selection;
- remove one model with confirmation;
- remove the full authorization with confirmation;
- edit custom endpoint metadata through Advanced management.

- [ ] **Step 8: Run GREEN and commit**

```bash
npm run test:js -- test/renderer/model-authorization-flow.test.ts test/renderer/model-authorization-ui.test.ts test/renderer/settings-add-account.test.ts test/renderer/settings-custom-providers.test.ts
npm run typecheck

git add src/renderer/modules/model-authorization.js src/renderer/modules/settings.js test/renderer/model-authorization-ui.test.ts test/renderer/settings-custom-providers.test.ts
git commit -m "feat(settings): add unified authorization wizard"
```

---

### Task 7: Cross-layer deletion, compatibility, and recovery

**Files:**
- Modify: `src/main/features/auth.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/renderer/modules/model-authorization.js`
- Modify: `test/main/features/model_authorizations.test.ts`
- Modify: `test/main/ipc/model-authorizations.test.ts`
- Modify: `test/renderer/model-authorization-ui.test.ts`

- [ ] **Step 1: Add failing recovery and compatibility fixtures**

Cover:

- existing built-in profiles with multiple/zero entries;
- existing custom providers with and without model lists;
- existing CC Switch provider source/external ID;
- malformed entry references shown as a recoverable warning and not rewritten by list;
- removing one model from a multi-model authorization;
- removing the default selects the next existing entry;
- removing an OAuth authorization clears entries then profile in one mutation;
- removing a custom authorization clears `cp:<id>` entries then provider in one mutation;
- retry after a simulated save failure;
- reimport does not overwrite an existing CC Switch authorization without explicit completion.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/main/features/model_authorizations.test.ts test/main/ipc/model-authorizations.test.ts test/renderer/model-authorization-ui.test.ts
```

- [ ] **Step 3: Implement missing recovery behavior only**

List operations remain read-only. Produce bounded warning codes such as:

```text
orphan_entry
missing_custom_provider
unbound_authorization
```

Do not repair or delete legacy state during list. Removal and explicit completion are the only mutating recovery actions in this feature.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm run test:js -- test/main/features/model_authorizations.test.ts test/main/ipc/model-authorizations.test.ts test/renderer/model-authorization-ui.test.ts
npm run typecheck

git add src/main/features/auth.ts src/main/ipc/index.ts src/renderer/modules/model-authorization.js test/main/features/model_authorizations.test.ts test/main/ipc/model-authorizations.test.ts test/renderer/model-authorization-ui.test.ts
git commit -m "fix(auth): preserve legacy authorization recovery"
```

---

### Task 8: Full verification and closeout

**Files:**
- No production files unless verification exposes a defect.

- [ ] **Step 1: Run all focused tests**

```bash
npm run test:js -- \
  test/main/features/model_authorizations.test.ts \
  test/main/features/model_authorization_discovery.test.ts \
  test/main/features/auth.test.ts \
  test/main/features/custom_providers.test.ts \
  test/main/features/ccswitch_import.test.ts \
  test/main/ipc/model-authorizations.test.ts \
  test/renderer/model-authorization-flow.test.ts \
  test/renderer/model-authorization-ui.test.ts \
  test/renderer/settings-add-account.test.ts \
  test/renderer/settings-custom-providers.test.ts \
  test/renderer/preload-push-allowlist.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run repository verification**

```bash
npm test
npm run typecheck
npm run builtin:manifest:check
git diff --check
```

Expected: all repository tests and checks pass.

- [ ] **Step 3: Inspect privacy and architecture contracts**

```bash
rg -n "console\.log|apiKey.*log|access.*log|refresh.*log" \
  src/main/features/model_authorization_discovery.ts \
  src/main/features/auth.ts \
  src/renderer/modules/model-authorization.js

git status --short --branch
git log --oneline --decorate 04774aa..HEAD
```

Expected:

- no app logging through `console.log`;
- no secret-bearing log payload;
- IPC contains validation/forwarding only;
- tracked worktree is clean;
- commits are task-scoped and reviewable.

- [ ] **Step 4: Perform manual source-app smoke**

Run the normal source app from this worktree and verify:

1. Credentials shows one Model authorization surface.
2. Existing authorizations render without migration.
3. OAuth reaches model selection after login.
4. Manual API Key reaches model discovery.
5. CC Switch import remains under API Key and never shows the raw key.
6. Multiple models can be selected and one default is required.
7. Restart preserves cards, enabled models, and default ordering.

Document any provider-network checks that could not be exercised without real credentials; do not insert secrets into tests or logs.

---

## Verification Summary

The implementation is accepted only when:

- focused tests pass;
- full `npm test` passes;
- TypeScript and builtin manifest checks pass;
- no raw credential crosses CC Switch preview/preparation IPC;
- one authorization can bind multiple entries and one default;
- existing profiles/custom providers remain usable without migration;
- Settings exposes only one primary model-authorization flow.

## Next Skill

Use `$superpower-executing-plans` for inline execution in the isolated worktree.
