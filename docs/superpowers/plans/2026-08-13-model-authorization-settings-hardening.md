# Model Authorization Settings Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task in the new conversation. Do not dispatch subagents unless the user explicitly asks for parallel agent work. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复模型授权设置页中自定义 Provider 被误当成内置 Provider、IPC 异常导致向导卡死、空目录丢失自定义端点入口、可见文案/图标不一致等问题，并以专项测试和真实 Electron 运行态完成验收。

**Architecture:** 保留现有两阶段授权流程：Renderer 只维护无持久化的向导草稿，Main 负责模型发现、连接测试和原子落盘。为 Provider DTO 增加明确的 `providerKind` 判别字段，在数据源处区分 builtin/custom，Renderer 仅把 builtin API-key Provider 放进预设区；已保存 custom Provider 继续由现有“自定义端点管理”和授权卡片承载。Renderer 引入统一的异步操作失败归一化与状态恢复逻辑，确保任何 IPC reject、`{ ok: false }`、空目录或过期 CC Switch 草稿都有确定、可重试的 UI 状态。

**Tech Stack:** Electron 单进程应用、Node.js/TypeScript Main、vanilla HTML/CSS/classic JavaScript Renderer、IPC `window.cogseed.invoke`、Vitest（通过项目脚本）、JSON i18n。

---

## 0. Scope, Evidence, And Hard Boundaries

### Confirmed current evidence

- Branch observed during investigation: `dev/niubaokang`, commit `22ae9d78`.
- Existing unrelated worktree changes observed and must be preserved: the current `AGENTS.md` update and untracked `docs/GitLab-MR指南-实习生版.md`. Do not stage either with this implementation unless the user separately requests it.
- Existing focused baseline passed before implementation:
  - `test/main/features/model_authorizations.test.ts`
  - `test/main/features/model_authorization_discovery.test.ts`
  - `test/main/ipc/model-authorizations.test.ts`
  - `test/renderer/model-authorization-flow.test.ts`
  - `test/renderer/model-authorization-ui.test.ts`
  - 5 files, 45 tests passed.
- `npm run typecheck` passed before implementation.
- Runtime logs separately showed a large external-abort storm for one skill session using custom Provider `cp:cp-msmp7xjz-1` and model `deepseek-v4-flash`. That is a separate model execution/concurrency defect, not part of this settings hardening plan.

### In scope

1. Make Provider kind explicit across `auth.listProviders` IPC DTO and Renderer.
2. Prevent existing custom Providers from appearing as builtin authorization presets.
3. Preserve a usable custom-endpoint path even when builtin Provider catalog loading fails or returns empty.
4. Handle all model-authorization IPC rejection paths without unhandled promises or stuck loading/testing UI.
5. Improve error-code localization, retry behavior, button busy states, model-empty states, visible strings, and icon usage.
6. Add/remove individual models from an existing authorization through the already-existing backend operation.
7. Verify no credentials leak into rendered HTML, logs, telemetry, or test output.
8. Restart the app and complete real settings-page verification.

### Out of scope

- Do not fix or refactor the abort storm in `src/main/model/core-agent/client.ts`, `rotating-provider.ts`, group chat, skill execution, or lock management.
- Do not change model runtime retry semantics, idle timeout semantics, global/session lock behavior, or Provider stream adapters.
- Do not decrypt, print, copy, migrate, or hand-edit `auth-profiles.json` or any saved API key.
- Do not edit `resources/builtin`, marketplace installs, account/sync code, connector authorization, or local-agent configuration.
- Do not add npm dependencies, TypeScript/JSX/bundling to Renderer, HTTP endpoints, or new preload aliases.
- Do not change production API domains or Provider catalog contents unless a test proves the current catalog entry itself is wrong.

## 1. Planned File Map

### Main process

- Modify `src/main/features/auth.ts`
  - Extend `ProviderEntry` with `providerKind: 'builtin' | 'custom'`.
  - Populate it at the Provider data source, including custom `cp:*` rows.
  - Keep `listProviders()` backward compatible for all existing fields.
- Modify `src/main/ipc/index.ts` only if the IPC response mapping strips or validates the new field. Do not put business logic here.

### Renderer

- Modify `src/renderer/modules/model-authorization.js`
  - Add explicit catalog load state.
  - Filter preset cards by `providerKind === 'builtin'`.
  - Keep the custom endpoint card visible independently of builtin Provider availability.
  - Normalize IPC failures and restore deterministic wizard states.
  - Localize error codes and visible actions.
  - Replace emoji/fallback text icons with centralized icon output.
  - Add individual model removal from authorization cards.
- Modify `src/renderer/style.css`
  - Add only scoped state styles required for error/empty/retry/model removal behavior.
  - Reuse existing button, warning, chip, and icon classes wherever possible.
- Modify all four Renderer locale files together:
  - `src/renderer/locales/en.json`
  - `src/renderer/locales/zh.json`
  - `src/renderer/locales/ja.json`
  - `src/renderer/locales/pt.json`

### Tests

- Modify `test/main/features/auth.test.ts`
  - Assert builtin/custom Provider discrimination.
- Modify `test/main/ipc/model-authorizations.test.ts`
  - Assert IPC DTO retains Provider kind if this contract is mapped in IPC.
- Modify `test/renderer/model-authorization-flow.test.ts`
  - Correct CC Switch semantic kind and cover state recovery helpers if kept pure.
- Modify `test/renderer/model-authorization-ui.test.ts`
  - Cover custom filtering, empty/failed catalog, rejected IPC operations, localization, secret non-disclosure, busy-state recovery, and individual model removal.
- Modify `test/renderer/settings-model-whitelist.test.ts` only if its static whitelist assertions require the new locale keys or Provider DTO field.

No new production source file is required unless `model-authorization.js` becomes materially harder to review. Prefer keeping pure state helpers at the top of that existing module because it already exposes a guarded CommonJS test bridge.

## 2. Execution Preconditions

### Task 1: Re-establish repository and runtime baseline

**Files:** Read-only.

- [ ] **Step 1: Verify repository identity, branch, HEAD, and worktree state**

Run:

```bash
git rev-parse --show-toplevel
git branch --show-current
git rev-parse --short HEAD
git status --short
```

Expected:

- Repository root is `/Users/an/东方国信项目/开源companion agent/cogseed-agent`.
- Work is on a `dev/*` branch, never directly on protected `develop`.
- Record any drift from `22ae9d78` and inspect intervening changes before editing.
- Preserve all unrelated changes, especially the current `AGENTS.md` update and `docs/GitLab-MR指南-实习生版.md` if still present.

- [ ] **Step 2: Read current project instructions and target files before editing**

Run:

```bash
sed -n '1,260p' AGENTS.md 2>/dev/null || true
git log --oneline -12 -- src/main/features/auth.ts src/main/ipc/index.ts src/renderer/modules/model-authorization.js
git diff -- src/main/features/auth.ts src/main/ipc/index.ts src/renderer/modules/model-authorization.js src/renderer/style.css
```

Expected: no unseen user edits are overwritten. If target files have user changes, incorporate them rather than reverting them.

- [ ] **Step 3: Run the focused baseline exactly**

Run:

```bash
npm run test:js -- \
  test/main/features/auth.test.ts \
  test/main/features/model_authorizations.test.ts \
  test/main/features/model_authorization_discovery.test.ts \
  test/main/ipc/model-authorizations.test.ts \
  test/renderer/model-authorization-flow.test.ts \
  test/renderer/model-authorization-ui.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck pass before changes. If not, stop and diagnose the new baseline; do not pile this plan on an unrelated failing tree.

- [ ] **Step 4: Confirm runtime credential file remains opaque**

Run only metadata/prefix inspection, never decrypt or print the body:

```bash
find ~/.cogseed/runtime-variants/cogseed/data -name auth-profiles.json -print
```

Expected: note path existence only. Do not use `cat`, decryptors, or application secret APIs on it.

## 3. Provider Kind Contract

### Task 2: Add a first-class builtin/custom Provider discriminator

**Files:**

- Modify: `src/main/features/auth.ts` around `ProviderEntry` and `listProviders()`.
- Test: `test/main/features/auth.test.ts`.

- [ ] **Step 1: Write the failing Provider-kind test**

Add assertions to the existing custom Provider test and one builtin catalog test:

```ts
expect(listed.providers).toContainEqual(expect.objectContaining({
  id: providerId,
  providerKind: 'custom',
}));

expect(listed.providers.find((provider) => provider.id === 'anthropic')).toMatchObject({
  providerKind: 'builtin',
});
```

Also assert that a custom Provider remains `supportsApiKey: true` for advanced/runtime consumers; the discriminator must not remove it from the general catalog.

- [ ] **Step 2: Run the single failing test**

Run:

```bash
npm run test:js -- test/main/features/auth.test.ts
```

Expected: FAIL because `providerKind` is absent.

- [ ] **Step 3: Extend the Provider type and construction sites**

In `src/main/features/auth.ts`, add:

```ts
export type ProviderKind = 'builtin' | 'custom';

export interface ProviderEntry {
  // existing fields stay unchanged
  providerKind: ProviderKind;
}
```

For rows created from `VISIBLE_PROVIDERS`, set:

```ts
providerKind: 'builtin',
```

For rows created from `store.customProviders`, set:

```ts
providerKind: 'custom',
```

Do not infer custom-ness in Renderer from string prefixes. The source of truth belongs in Main.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm run test:js -- test/main/features/auth.test.ts test/main/ipc/model-authorizations.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the contract change**

Run after reviewing `git diff`:

```bash
git add src/main/features/auth.ts test/main/features/auth.test.ts
git commit -m "fix(models): distinguish builtin and custom providers"
```

Do not include unrelated files.

## 4. Preset Rendering And Catalog Failure State

### Task 3: Keep builtin presets and custom endpoint entry semantically separate

**Files:**

- Modify: `src/renderer/modules/model-authorization.js`.
- Test: `test/renderer/model-authorization-ui.test.ts`.

- [ ] **Step 1: Write failing UI tests for Provider filtering and empty catalog**

Extend the harness with a custom row:

```ts
{
  id: 'cp:custom-relay',
  label: 'Custom Relay',
  providerKind: 'custom',
  supportsApiKey: true,
  supportsOAuth: false,
  manualModel: false,
  profiles: [{ profileId: 'cp:custom-relay' }],
}
```

Assert after entering the manual API-key source step:

```ts
expect(bodyHtml).not.toContain('data-provider-id="cp:custom-relay"');
expect(bodyHtml).not.toContain('Custom Relay');
expect(bodyHtml).toContain('choose-custom-endpoint');
```

Add a second test where `auth.listProviders` returns `{ ok: true, providers: [] }` and assert:

```ts
expect(bodyHtml).toContain('choose-custom-endpoint');
expect(bodyHtml).toContain('settings.model_authorization.providers_empty');
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test:js -- test/renderer/model-authorization-ui.test.ts
```

Expected: custom Provider currently appears as a preset, and the custom endpoint card disappears when no preset exists.

- [ ] **Step 3: Add explicit catalog load state**

Extend `controller` with a finite state, not inferred from array length:

```js
providerCatalog: {
  status: 'idle', // idle | loading | ready | error
  error: '',
},
```

`ensureProviders()` must:

1. Return cached providers when ready.
2. Set `loading` before IPC.
3. Accept only `res.ok === true && Array.isArray(res.providers)` as success.
4. Set `ready` even for an empty array.
5. Catch thrown IPC errors, set `error`, and return `[]`.
6. Never log raw error bodies in Renderer.

Use a safe user-facing fallback:

```js
function errorMessage(error, fallbackKey) {
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  return message ? message.slice(0, 300) : tr(fallbackKey);
}
```

If the project IPC wrapper can expose sensitive Provider messages, prefer the localized fallback rather than showing arbitrary error text.

- [ ] **Step 4: Render preset states without hiding the custom entry**

Compute builtin presets with:

```js
const presets = controller.providers.filter((provider) =>
  provider && provider.providerKind === 'builtin'
  && provider.supportsApiKey
  && !provider.manualModel
);
```

Render behavior:

- `loading`: progress row plus the custom endpoint card.
- `error`: localized warning, retry button, plus the custom endpoint card.
- `ready` with zero presets: localized empty state plus the custom endpoint card.
- `ready` with presets: builtin cards plus the custom endpoint card.

Do not display existing custom Providers in this creation flow. They remain visible in authorization cards and advanced custom endpoint management.

- [ ] **Step 5: Add retry action and deterministic handler**

Add `data-model-auth-action="retry-providers"`. Its handler clears the previous error, calls `ensureProviders({ force: true })`, and re-renders. While loading, prevent repeated retry clicks.

- [ ] **Step 6: Run Renderer tests**

Run:

```bash
npm run test:js -- test/renderer/model-authorization-flow.test.ts test/renderer/model-authorization-ui.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the UI separation**

```bash
git add src/renderer/modules/model-authorization.js test/renderer/model-authorization-ui.test.ts
git commit -m "fix(settings): separate custom providers from model presets"
```

## 5. Async Failure Recovery

### Task 4: Make every authorization IPC path recoverable

**Files:**

- Modify: `src/renderer/modules/model-authorization.js`.
- Test: `test/renderer/model-authorization-ui.test.ts`.

- [ ] **Step 1: Add rejected-Promise tests for each operation boundary**

Add tests for:

1. `auth.listProviders` rejects.
2. `customProviders.ccswitch.preview` rejects.
3. `modelAuthorizations.prepareCcSwitch` rejects.
4. `modelAuthorizations.discover` rejects.
5. `modelAuthorizations.testDraft` rejects.
6. `modelAuthorizations.complete` rejects.
7. `modelAuthorizations.list` rejects during settings refresh.
8. `modelAuthorizations.remove` rejects.

For each test assert:

- No unhandled rejection escapes the click/init promise.
- A localized error appears.
- The modal remains open when configuration was not saved.
- The complete button becomes enabled again after test/save rejection.
- Discovery returns to a meaningful source step rather than staying on `discovering`.
- Existing authorization cards are not erased on refresh failure.
- Removal failure preserves the card and resets `removingAuthorizationId`.
- Serialized/rendered HTML never contains the entered raw API key.

- [ ] **Step 2: Run tests and verify they fail**

```bash
npm run test:js -- test/renderer/model-authorization-ui.test.ts
```

Expected: one or more operations reject out of the event handler or leave stale loading/testing state.

- [ ] **Step 3: Introduce one IPC result normalizer**

Add a helper with a narrow contract:

```js
async function invokeResult(channel, payload, fallbackKey) {
  try {
    const result = await invoke(channel, payload);
    if (!result || result.ok === false) {
      return {
        ok: false,
        result,
        message: result && typeof result.error === 'string' && result.error.trim()
          ? result.error.trim().slice(0, 300)
          : tr(fallbackKey),
      };
    }
    return { ok: true, result };
  } catch (_error) {
    return { ok: false, result: null, message: tr(fallbackKey) };
  }
}
```

Do not use a global blanket catch that loses operation-specific recovery. Each caller must set its correct state after receiving `{ ok: false }`.

- [ ] **Step 4: Define operation-specific recovery states**

- Provider load failure: `providerCatalog.status = 'error'`; manual custom endpoint remains available.
- CC Switch preview failure: remain on `ccswitch_select`, clear stale rows, show error, allow retry/back.
- CC Switch prepare failure: remain on `ccswitch_select`; do not allocate a local pseudo draft.
- Discovery failure returned by Main: pass through `applyDiscovery`; only `unsupported_discovery` allows manual model entry.
- Discovery IPC reject: synthesize `{ ok: false, errorCode: 'network_error' }`, restore `credentials` for manual flow or `ccswitch_select` for CC Switch flow, and show localized failure.
- Test failure/reject: remain on `models`, keep selected/default models and credentials in memory, reset `busy` in `finally`.
- Completion failure/reject: remain on `models`, do not clear/close draft, reset `busy`.
- List refresh failure: preserve `controller.authorizations`; show page-level status; never replace cards with empty state.
- Remove failure/reject: preserve the authorization card and reset removal state.

- [ ] **Step 5: Prevent stale async completion from overwriting newer navigation**

The existing discovery token protects discovery results. Add equivalent sequence/token protection where a slow Provider load or CC Switch preview can finish after the user backs out or starts a new draft. At minimum:

```js
providerLoadSeq: 0,
ccswitchPreviewSeq: 0,
```

Only apply results when the captured sequence is current and the active draft/source still matches.

- [ ] **Step 6: Run focused tests**

```bash
npm run test:js -- \
  test/renderer/model-authorization-flow.test.ts \
  test/renderer/model-authorization-ui.test.ts \
  test/renderer/model-guard.test.ts
```

Expected: PASS with no unhandled rejection warnings.

- [ ] **Step 7: Commit recovery behavior**

```bash
git add src/renderer/modules/model-authorization.js test/renderer/model-authorization-ui.test.ts
git commit -m "fix(settings): recover model authorization IPC failures"
```

## 6. Correct State Semantics And CC Switch Draft Handling

### Task 5: Align CC Switch state with the backend custom-Provider completion path

**Files:**

- Modify: `src/renderer/modules/model-authorization.js`.
- Test: `test/renderer/model-authorization-flow.test.ts`.
- Test: `test/renderer/model-authorization-ui.test.ts`.

- [ ] **Step 1: Correct the failing semantic assertion**

Change the CC Switch flow expectation from:

```ts
providerKind: 'builtin'
```

to:

```ts
providerKind: 'custom'
```

Add a full payload assertion:

```ts
expect(flow.buildCompletionPayload(draft)).toEqual(expect.objectContaining({
  authType: 'api_key',
  source: 'ccswitch',
  providerKind: 'custom',
  draftId: 'draft-1',
  requestId: 'draft-1',
  selectedModels: ['a'],
  defaultModel: 'a',
}));
```

- [ ] **Step 2: Run and verify the test fails**

```bash
npm run test:js -- test/renderer/model-authorization-flow.test.ts
```

Expected: FAIL because `ccswitch_ready` currently sets builtin.

- [ ] **Step 3: Fix the state transition at the source**

In the `ccswitch_ready` transition set:

```js
next.providerKind = 'custom';
```

Do not add fake `customProvider` credentials to the Renderer draft. The opaque Main-process `draftId` remains the only CC Switch authority and raw key boundary.

- [ ] **Step 4: Handle expired/consumed drafts explicitly**

When discover/test/complete returns `draft_not_found` or `draft_expired`:

- Clear `draftId`, `externalId`, declared/selected/default models.
- Return to `ccswitch_select`.
- Show a localized “import session expired; select the entry again” message.
- Do not silently re-read CC Switch or auto-complete with stale data.

Add tests for expiration during discovery and expiration between test and completion.

- [ ] **Step 5: Run CC Switch tests**

```bash
npm run test:js -- \
  test/main/features/model_authorization_discovery.test.ts \
  test/main/ipc/model-authorizations.test.ts \
  test/renderer/model-authorization-flow.test.ts \
  test/renderer/model-authorization-ui.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit state semantics**

```bash
git add src/renderer/modules/model-authorization.js test/renderer/model-authorization-flow.test.ts test/renderer/model-authorization-ui.test.ts
git commit -m "fix(settings): align CC Switch authorization state"
```

## 7. Existing Authorization Model Management

### Task 6: Expose safe removal of individual models

**Files:**

- Modify: `src/renderer/modules/model-authorization.js`.
- Modify: `src/renderer/style.css` only for scoped chip/button layout.
- Test: `test/renderer/model-authorization-ui.test.ts`.

- [ ] **Step 1: Write failing model-removal tests**

Render an authorization with two models and real `entryId` fields. Assert every model displays a remove icon/button with:

```html
data-model-auth-action="remove-model"
data-authorization-id="profile:..."
data-entry-id="entry-..."
```

Test both paths:

- Cancel confirmation: no IPC, both models remain.
- Confirm: invoke `modelAuthorizations.removeModel`; refresh cards and model guard only when `removed === true`.
- Failure/reject: preserve both models, show page-level error.
- Removing the default/first model: refreshed backend summary decides the new default; Renderer must not guess.
- Removing the last model: card remains and renders the existing localized unbound warning.

- [ ] **Step 2: Run and verify failure**

```bash
npm run test:js -- test/renderer/model-authorization-ui.test.ts
```

Expected: FAIL because cards currently render passive chips only.

- [ ] **Step 3: Implement model removal using the existing IPC**

Add `removeAuthorizationModel(authorizationId, entryId)` with:

1. Strict non-empty ID normalization.
2. `uiConfirm(settings.model_authorization.confirm_remove_model)`.
3. Per-model busy identity such as `removingModelEntryId`; prevent double submit.
4. `modelAuthorizations.removeModel` invocation.
5. On success, refresh authorization summaries and model guard.
6. On failure, retain current cards and show localized error.
7. Always clear busy identity in `finally`.

Render the control with centralized icons:

```js
const removeIcon = typeof window.uiIconHtml === 'function'
  ? window.uiIconHtml('x', 'model-authorization-model-remove-icon')
  : '';
```

Use an accessible localized `title` and `aria-label`; do not render emoji.

- [ ] **Step 4: Keep card DTO handling strict**

Do not infer `entryId` from model IDs. If a legacy summary has no `entryId`, render a passive chip without a remove button.

- [ ] **Step 5: Run tests**

```bash
npm run test:js -- test/renderer/model-authorization-ui.test.ts test/main/features/model_authorizations.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit model management**

```bash
git add src/renderer/modules/model-authorization.js src/renderer/style.css test/renderer/model-authorization-ui.test.ts
git commit -m "feat(settings): manage models within authorizations"
```

## 8. Localization, Icons, And Visible State Polish

### Task 7: Remove visible hard-coded strings and emoji fallbacks

**Files:**

- Modify: `src/renderer/modules/model-authorization.js`.
- Modify: `src/renderer/modules/icons.js` only if a required familiar icon name is absent.
- Modify: all four Renderer locale JSON files.
- Modify: `src/renderer/style.css`.
- Test: `test/renderer/model-authorization-ui.test.ts`.
- Test: `test/renderer/settings-model-whitelist.test.ts` if applicable.

- [ ] **Step 1: Write failing static/UI assertions**

Assert the rendered model authorization UI does not contain these production literals:

```text
Make default
Custom endpoint
👁
```

Assert all four locale files contain identical `settings.model_authorization.*` key sets.

- [ ] **Step 2: Add exact locale keys to all four languages**

Add at least:

```json
"settings.model_authorization.make_default": "Make default",
"settings.model_authorization.providers_empty": "No built-in providers are available. You can still configure a custom endpoint.",
"settings.model_authorization.providers_load_failed": "Could not load providers.",
"settings.model_authorization.retry_providers": "Retry provider loading",
"settings.model_authorization.ccswitch_load_failed": "Could not read CC Switch entries.",
"settings.model_authorization.ccswitch_draft_expired": "The import session expired. Select the CC Switch entry again.",
"settings.model_authorization.remove_model_failed": "Could not remove the model.",
"settings.model_authorization.authorization_list_failed": "Could not refresh model authorizations.",
"settings.model_authorization.model_list_empty": "No models were returned.",
"settings.model_authorization.custom_endpoint_default_name": "Custom endpoint"
```

Provide natural Chinese, Japanese, and Portuguese translations; do not leave English fallback strings in non-English locale files.

- [ ] **Step 3: Replace hard-coded visible strings**

- Replace `Make default` with `tr('settings.model_authorization.make_default')`.
- Replace `endpointLabel()` fallback text with the localized default-name key.
- Replace eye emoji fallback with centralized icon markup or an empty icon span; `icons.js` is loaded before this module in `index.html`, so normal runtime should use `uiIconHtml('eye', ...)`.
- Ensure buttons have localized `title`/`aria-label`.
- Translate known backend error codes (`draft_not_found`, `draft_expired`, `auth_failed`, `unsupported_discovery`, `network_error`, `provider_error`, `invalid_request`, `missing_key`) through a local mapping. Do not expose raw code strings as the primary visible message.

- [ ] **Step 4: Add professional empty and busy states**

- If discovery succeeds with `models: []`, show `model_list_empty`, keep Back available, and do not enable Save.
- Disable the action that launched an in-flight operation; preserve stable button dimensions.
- Ensure long Provider/model names wrap or truncate without overlapping controls.
- Do not introduce nested cards or new decorative palette elements.

- [ ] **Step 5: Run localization and UI tests**

```bash
npm run test:js -- \
  test/renderer/model-authorization-ui.test.ts \
  test/renderer/settings-model-whitelist.test.ts
```

Expected: PASS; four locale key sets remain aligned.

- [ ] **Step 6: Commit polish**

```bash
git add \
  src/renderer/modules/model-authorization.js \
  src/renderer/modules/icons.js \
  src/renderer/style.css \
  src/renderer/locales/en.json \
  src/renderer/locales/zh.json \
  src/renderer/locales/ja.json \
  src/renderer/locales/pt.json \
  test/renderer/model-authorization-ui.test.ts \
  test/renderer/settings-model-whitelist.test.ts
git commit -m "fix(settings): polish model authorization states"
```

Only stage files actually changed.

## 9. Cross-Layer Contract Verification

### Task 8: Prove persistence and runtime selection invariants remain intact

**Files:** Tests only unless a genuine defect is found.

- Test: `test/main/features/model_authorizations.test.ts`.
- Test: `test/main/model/runner.test.ts`.
- Test: `test/renderer/model-guard.test.ts`.

- [ ] **Step 1: Add or strengthen invariants only where coverage is missing**

Required assertions:

- A builtin authorization creates a normal Profile and entries bound to its `profileId`.
- A manual custom authorization creates one `customProviders` row and entries using the same synthetic `cp:<id>` for Provider/profile.
- Re-completing the same request ID is idempotent.
- CC Switch completion reuses an existing custom authorization by `externalId` only after explicit completion.
- A failed connection test never persists a credential or entry.
- Renderer refreshes `model-guard` only after successful complete/remove/removeModel.
- Removing one model does not remove the credential or unrelated entries.

- [ ] **Step 2: Run the cross-layer suite**

```bash
npm run test:js -- \
  test/main/features/auth.test.ts \
  test/main/features/model_authorizations.test.ts \
  test/main/features/model_authorization_discovery.test.ts \
  test/main/ipc/model-authorizations.test.ts \
  test/main/model/runner.test.ts \
  test/renderer/model-authorization-flow.test.ts \
  test/renderer/model-authorization-ui.test.ts \
  test/renderer/model-guard.test.ts \
  test/renderer/settings-model-whitelist.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS without `any`/`unknown` escape additions in production code.

- [ ] **Step 4: Inspect the complete diff for boundary violations**

Run:

```bash
git diff --check
git diff --stat
git diff -- src/main/features/auth.ts src/main/ipc/index.ts src/renderer/modules/model-authorization.js src/renderer/style.css src/renderer/locales test
```

Verify:

- No raw key appears in tests, logs, HTML snapshots, or comments.
- IPC handlers contain validation/delegation only.
- No `window.cogseed` additions.
- No Renderer npm import, TypeScript, JSX, or cache-busting query string.
- No product/brand/path literals were added to prompt files.
- No unrelated formatting churn.

## 10. Full Verification And Real App Acceptance

### Task 9: Complete project-required verification

**Files:** No new edits unless verification finds a defect.

- [ ] **Step 1: Run the complete project test command**

Run:

```bash
npm test
```

Expected: PASS. If a failure is unrelated and pre-existing, capture exact evidence and verify it against the pre-change baseline before classifying it; do not silently ignore failures.

- [ ] **Step 2: Restart this worktree runtime**

Run:

```bash
scripts/restart-cogseed.sh
```

Expected: only the `cogseed`/messaging runtime for this worktree is stopped and relaunched; other variants remain untouched.

- [ ] **Step 3: Confirm startup from both required logs**

Run:

```bash
tail -n 160 ~/.cogseed/runtime-variants/cogseed/data/logs/$(date +%F).log
tail -n 160 /tmp/cogseed-agent-cogseed-run.log
```

Expected:

- App starts without preload/Renderer syntax errors.
- No new model-authorization initialization error.
- No credential values in logs.
- Do not claim the separate abort storm is fixed; only note whether it reappears during this bounded settings verification.

- [ ] **Step 4: Perform real settings-page verification**

Use the real Electron UI, not only static HTML inspection. Verify:

1. Open Settings -> Model authorizations.
2. Existing authorization cards render without exposing API keys.
3. Add authorization -> manual source.
4. Builtin presets render; existing custom Providers do not appear as builtin cards.
5. Custom endpoint card is always available.
6. Back/cancel preserve or discard state exactly as designed.
7. Provider load failure can be retried. If failure cannot be induced safely in the real environment, rely on automated rejection tests and verify the rendered error state in the test harness.
8. CC Switch empty/unsupported/ready rows remain distinguishable without raw keys.
9. Model list can select/deselect and change default with localized labels.
10. Failed test/save leaves the modal open and actionable.
11. Removing one model asks for confirmation and refreshes the card.
12. Removing the last model leaves an unbound authorization warning.
13. Chinese locale has no stray `Make default`, `Custom endpoint`, raw error code, or emoji icon.
14. Switch locale and confirm dynamic UI re-renders through `i18n-change`.
15. Resize the settings window to a narrow layout and confirm long model/provider names do not overlap buttons.

Do not create a paid Provider request merely for UI verification unless an already-configured safe test credential is intentionally selected by the user. Never reveal the credential.

- [ ] **Step 5: Review runtime logs after interaction**

Run a bounded search:

```bash
rg -n -i "model.authorization|modelAuthorizations|auth.listProviders|unhandled|renderer.*error|preload.*error" \
  ~/.cogseed/runtime-variants/cogseed/data/logs/$(date +%F).log \
  /tmp/cogseed-agent-cogseed-run.log | tail -160
```

Expected: no unhandled promise rejection or new settings error.

- [ ] **Step 6: Final repository hygiene**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: only intentional changes/commits plus preserved unrelated user files. Do not push or create an MR unless the user explicitly requests it.

## 11. Completion Criteria

The work is complete only when all statements are true:

- Main explicitly labels every Provider row as builtin or custom.
- Existing custom Providers never appear in the builtin preset creation list.
- Custom endpoint configuration remains reachable when Provider loading is empty or failed.
- Every authorization IPC rejection is caught and produces a recoverable, localized state.
- Slow/stale async results cannot overwrite a newer draft/navigation state.
- CC Switch stays opaque-key based and uses custom-Provider semantics.
- Expired CC Switch drafts require explicit reselection.
- Users can remove individual models without deleting the authorization credential.
- All visible model-authorization strings use i18n; no emoji icon fallback remains.
- Focused suites, typecheck, and full `npm test` pass.
- The app is restarted with `scripts/restart-cogseed.sh` and verified through required logs and real UI.
- No secrets are printed, logged, rendered, or added to Git.
- No claim is made that the unrelated runtime abort storm was fixed.

## 12. Abort-Storm Follow-Up Boundary

Create a separate plan/conversation only after this settings work is complete or if the user reprioritizes it. The separate investigation should start from the observed sequence:

1. A skill session waits about 112 seconds for locks.
2. External abort fires and releases locks.
3. Many queued calls immediately acquire locks with the already-aborted signal.
4. Each starts a Provider turn and emits `Request was aborted` within milliseconds.

That follow-up must use `superpowers:systematic-debugging`, reproduce with a bounded concurrency test, and establish which caller enqueues duplicate turns before changing lock or retry behavior.

## 13. New-Conversation Start Prompt

Use this exact prompt in the new conversation:

```text
请执行这个计划文件：
/Users/an/东方国信项目/开源companion agent/cogseed-agent/docs/superpowers/plans/2026-08-13-model-authorization-settings-hardening.md

严格按任务顺序执行，先读取完整计划和当前 AGENTS.md，然后核对仓库根目录、分支、HEAD、工作树和基线测试。使用 superpowers:executing-plans 与 superpowers:test-driven-development；完成前使用 superpowers:verification-before-completion。不要处理计划外的模型 abort 风暴，不要读取或打印任何明文密钥，不要覆盖现有未提交文件，不要推送或创建 MR。实现完成后按项目要求运行专项测试、npm run typecheck、npm test、scripts/restart-cogseed.sh，并检查两处启动日志和真实模型设置界面。
```
