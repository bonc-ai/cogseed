# Unified Model Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Replace the visible Model Authorization settings entry with a unified Model Providers experience that preserves existing OAuth/rotation behavior and adds custom providers, CC Switch import, built-in chat routing, and Claude/Codex binding.

**Architecture:** Extend the encrypted auth profiles file with user-scoped custom provider records and expose them through a focused feature module. Surface custom providers as synthetic `cp:<id>` providers in existing auth entry selection, add a dynamic core-agent runtime adapter, inject selected credentials only into Claude/Codex child env, and integrate manual/CC Switch management into the existing settings surface without replacing current files wholesale.

**Tech Stack:** TypeScript, Electron IPC, vanilla renderer JS/CSS, local-secret-store encryption, better-sqlite3, Vitest, renderer static/CommonJS tests.

---

## File Structure

- Create `src/main/features/custom_providers.ts`: validation, CRUD, masking-safe views, entry cleanup, CC Switch sync orchestration.
- Create `src/main/features/ccswitch_import.ts`: read-only probe and parser.
- Modify `src/main/features/auth.ts`: encrypted schema and custom-provider auth integration.
- Create `src/main/model/core-agent/custom_provider_runtime.ts`: dynamic runtime adapter.
- Modify `src/main/model/core-agent/runner.ts`: resolve synthetic providers.
- Create `src/main/features/local_agents/provider_env.ts`: Claude/Codex env mapping.
- Modify `src/main/features/local_agents/{runner.ts,backends/base.ts,backends/claude.ts,backends/codex.ts}`: secure env overlay.
- Modify `src/main/features/agents.ts`: optional CLI provider binding.
- Modify `src/main/ipc/index.ts`: thin custom provider handlers.
- Modify `src/renderer/{index.html,style.css}` and `src/renderer/modules/{settings,agents}.js`: unified UI.
- Modify four renderer locale files.
- Add focused feature, runtime, CLI, CC Switch, IPC/static, and renderer tests.

### Task 1: Encrypted Custom Provider Records

**Files:**
- Modify: `src/main/features/auth.ts`
- Create: `src/main/features/custom_providers.ts`
- Create: `test/main/features/custom_providers.test.ts`
- Modify: `test/main/features/auth.test.ts`

- [ ] **Step 1: Write failing CRUD and migration tests**

Cover old profiles files without `customProviders`, add/update/remove, URL validation, protocol validation, model normalization, key replacement semantics, and preservation of existing profiles/entries/media profiles.

```typescript
const added = customProviders.addCustomProvider(uid, {
  name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
  apiKey: 'secret', models: ['model-a'],
});
expect(added.ok).toBe(true);
expect(customProviders.listCustomProviders(uid)[0].apiKey).toBe('secret');
```

- [ ] **Step 2: Verify RED**

```bash
npm run test:js -- test/main/features/custom_providers.test.ts test/main/features/auth.test.ts
```

Expected: module/schema does not exist.

- [ ] **Step 3: Extend encrypted schema**

Add exported `CustomProvider`, optional `customProviders`, parser, empty-store default, and user-scoped read/write helpers. Existing auth functions continue wrapping `getActiveUserId`; new custom-provider functions take `userId` first.

- [ ] **Step 4: Implement CRUD feature**

Implement list/add/update/remove with `http(s)` URL validation, no URL credentials, bounded strings/models, `manual|ccswitch` source, external-id lookup, and core-agent cache invalidation. Removal also deletes entries whose provider is `cp:<id>`.

- [ ] **Step 5: Verify GREEN**

Run the two focused files and expect all cases to pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/features/auth.ts src/main/features/custom_providers.ts test/main/features/auth.test.ts test/main/features/custom_providers.test.ts
git commit -m "feat(models): store custom providers securely"
```

### Task 2: CC Switch Probe, Preview, and Sync

**Files:**
- Create: `src/main/features/ccswitch_import.ts`
- Modify: `src/main/features/custom_providers.ts`
- Create: `test/main/features/ccswitch_import.test.ts`

- [ ] **Step 1: Write fixture-based failing tests**

Create temporary sqlite databases with a `providers` table. Cover Claude, Codex, Gemini, official-row skip, malformed JSON, missing key, schema mismatch, missing database, selected-only sync, and idempotent `externalId` updates.

- [ ] **Step 2: Verify RED**

```bash
npm run test:js -- test/main/features/ccswitch_import.test.ts
```

- [ ] **Step 3: Implement read-only importer**

Use `better-sqlite3` readonly/fileMustExist. Export platform path candidates, `probeCcSwitch`, and `readCcSwitchImportItems`. Parse only known fields and return structured failure reasons.

- [ ] **Step 4: Add preview/sync orchestration**

Preview returns import items to the feature layer. Sync filters explicit external ids, validates through the same custom-provider add/update path, preserves missing-key rows with `needsKey`, and updates matching external ids instead of duplicating.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run test:js -- test/main/features/ccswitch_import.test.ts test/main/features/custom_providers.test.ts
git add src/main/features/ccswitch_import.ts src/main/features/custom_providers.ts test/main/features/ccswitch_import.test.ts
git commit -m "feat(models): import providers from CC Switch"
```

### Task 3: Custom Providers in Auth Entries

**Files:**
- Modify: `src/main/features/auth.ts`
- Modify: `test/main/features/auth.test.ts`
- Modify: `test/main/model/provider_catalog.test.ts`

- [ ] **Step 1: Add failing auth integration tests**

Assert `listProviders` includes `cp:<id>`, `listModels` returns declared models, empty models enable manual entry, `addEntry` validates the provider, list views are masked, and picker/rotation resolves the custom key without a duplicate `profiles` row.

- [ ] **Step 2: Verify RED**

```bash
npm run test:js -- test/main/features/auth.test.ts test/main/model/provider_catalog.test.ts
```

- [ ] **Step 3: Implement synthetic provider integration**

Add `isCustomProviderId`, strict existence checks, custom labels/models, synthetic profile markers, key resolution, and provider-policy allowance only for records present in the active user's encrypted store. Preserve `openai-compatible` behavior and limits.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm run test:js -- test/main/features/auth.test.ts test/main/model/provider_catalog.test.ts
git add src/main/features/auth.ts test/main/features/auth.test.ts test/main/model/provider_catalog.test.ts
git commit -m "feat(models): expose custom providers to model routing"
```

### Task 4: Built-In Chat Runtime Adapter

**Files:**
- Create: `src/main/model/core-agent/custom_provider_runtime.ts`
- Modify: `src/main/model/core-agent/runner.ts`
- Create: `test/main/model/core-agent/custom-provider-runtime.test.ts`
- Modify: `test/main/model/core-agent/runner.test.ts` if present, otherwise the nearest runner construction test.

- [ ] **Step 1: Write failing protocol mapping tests**

Cover Anthropic, OpenAI completions, and Gemini dialects; Base URL; model id; conservative token defaults; missing provider/key; and no static `#core-agent` import.

- [ ] **Step 2: Verify RED**

```bash
npm run test:js -- test/main/model/core-agent/custom-provider-runtime.test.ts
```

- [ ] **Step 3: Implement dynamic adapter**

Build the model object from the encrypted record and create the provider via a dynamic `import('#core-agent')`. Do not log keys or Authorization values.

- [ ] **Step 4: Route synthetic providers**

In core-agent runner construction, branch on `cp:<id>` before curated/external provider lookup, resolve the active user's record, and keep rotating-provider profile/entry identifiers intact.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run test:js -- test/main/model/core-agent/custom-provider-runtime.test.ts test/main/model/core-agent/rotating-provider.test.ts
git add src/main/model/core-agent/custom_provider_runtime.ts src/main/model/core-agent/runner.ts test/main/model/core-agent
git commit -m "feat(models): run chat through custom providers"
```

### Task 5: Thin IPC Contract

**Files:**
- Modify: `src/main/ipc/index.ts`
- Create: `test/main/ipc/custom-providers.test.ts`

- [ ] **Step 1: Write failing IPC contract tests**

Assert handlers pass `ctx.userId` to features, reject invalid ids/arrays, mask keys in list/preview, and never accept a renderer-provided uid.

- [ ] **Step 2: Verify RED**

```bash
npm run test:js -- test/main/ipc/custom-providers.test.ts
```

- [ ] **Step 3: Add handlers**

Register list/add/update/remove and CC Switch probe/preview/sync handlers. Keep all validation and synchronization business logic in feature modules.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm run test:js -- test/main/ipc/custom-providers.test.ts
git add src/main/ipc/index.ts test/main/ipc/custom-providers.test.ts
git commit -m "feat(models): expose custom provider IPC"
```

### Task 6: Claude and Codex Provider Binding

**Files:**
- Modify: `src/main/features/agents.ts`
- Create: `src/main/features/local_agents/provider_env.ts`
- Modify: `src/main/features/local_agents/runner.ts`
- Modify: `src/main/features/local_agents/backends/base.ts`
- Modify: `src/main/features/local_agents/backends/claude.ts`
- Modify: `src/main/features/local_agents/backends/codex.ts`
- Create: `test/main/features/local_agents/provider_env.test.ts`
- Modify: `test/main/features/local_agents/runner.test.ts`

- [ ] **Step 1: Write failing env and secret-boundary tests**

Assert Claude receives only Anthropic vars, Codex only OpenAI vars, mismatches inject nothing, deleted providers fall back, and secrets do not appear in args/process-info/persisted diagnostics.

- [ ] **Step 2: Verify RED**

```bash
npm run test:js -- test/main/features/local_agents/provider_env.test.ts test/main/features/local_agents/runner.test.ts
```

- [ ] **Step 3: Add runtime binding**

Add optional `cli_provider_id` to CLI runtime normalization. Resolve the env overlay in `runner.ts` with `uid`, pass it through `BackendRunOptions.env`, and merge it only in `spawnCli` child env. Keep argv unchanged.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm run test:js -- test/main/features/local_agents/provider_env.test.ts test/main/features/local_agents/runner.test.ts test/main/features/local_agents/claude_e2e.test.ts
git add src/main/features/agents.ts src/main/features/local_agents test/main/features/local_agents
git commit -m "feat(models): bind custom providers to Claude and Codex"
```

### Task 7: Unified Model Providers Settings UI

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/settings.js`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Create: `test/renderer/settings-custom-providers.test.ts`
- Modify: `test/renderer/settings-tabs.test.ts`

- [ ] **Step 1: Add failing renderer contract tests**

Assert the visible navigation/title is Model Providers, no duplicate Model Authorization entry remains, required custom-provider controls exist, CC Switch dialog uses the expected IPC channels, and locale keys exist in all four files.

- [ ] **Step 2: Verify RED**

```bash
npm run test:js -- test/renderer/settings-custom-providers.test.ts test/renderer/settings-tabs.test.ts
```

- [ ] **Step 3: Build the unified page**

Keep the existing accounts/priority UI in place under the new heading. Add an un-nested custom-provider list, add/edit dialog, protocol select, Base URL, masked key replacement, models input, delete confirmation, and visible progress for mutations.

- [ ] **Step 4: Add CC Switch preview dialog**

Probe on page refresh, open an explicit preview dialog, render checkbox rows, display missing-key state, and sync selected external ids. Re-render after completion and on `i18n-change`.

- [ ] **Step 5: Add styles/locales and verify GREEN**

Reuse current buttons/dialog/list classes; add only modifiers needed for provider metadata and responsive layout. Run renderer tests.

- [ ] **Step 6: Commit**

```bash
git add src/renderer test/renderer/settings-custom-providers.test.ts test/renderer/settings-tabs.test.ts
git commit -m "feat(settings): unify model provider management"
```

### Task 8: Agent Editor Provider Selection

**Files:**
- Modify: `src/renderer/modules/agents.js`
- Create: `test/renderer/agent-cli-provider.test.ts`

- [ ] **Step 1: Write failing UI behavior tests**

Assert Claude filters Anthropic providers, Codex filters OpenAI providers, changing CLI clears an incompatible binding, and saving preserves `cli_provider_id` only when selected.

- [ ] **Step 2: Verify RED**

```bash
npm run test:js -- test/renderer/agent-cli-provider.test.ts
```

- [ ] **Step 3: Implement selector**

Load masked provider views through IPC, render a native/select control in CLI create/edit forms, and keep no-selection as the default CLI-owned configuration.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm run test:js -- test/renderer/agent-cli-provider.test.ts
git add src/renderer/modules/agents.js test/renderer/agent-cli-provider.test.ts
git commit -m "feat(agents): select providers for CLI runtimes"
```

### Task 9: Provider Feature Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused tests**

```bash
npm run test:js -- test/main/features/auth.test.ts test/main/features/custom_providers.test.ts test/main/features/ccswitch_import.test.ts test/main/model/core-agent/custom-provider-runtime.test.ts test/main/model/core-agent/rotating-provider.test.ts test/main/features/local_agents/provider_env.test.ts test/main/features/local_agents/runner.test.ts test/main/ipc/custom-providers.test.ts test/renderer/settings-custom-providers.test.ts test/renderer/agent-cli-provider.test.ts test/renderer/settings-tabs.test.ts
```

- [ ] **Step 2: Run typecheck and static secret audit**

```bash
npm run typecheck
git diff --check
git grep -n 'apiKey.*log\|console\.log.*apiKey\|process-info.*apiKey' -- src test
```

- [ ] **Step 3: Run full project tests**

```bash
npm test
```

Use `ORKAS_TEST_PYTHON` pointing at a Python with pytest/requests if the system interpreter lacks resource-test dependencies.

- [ ] **Step 4: Start Electron and perform UI smoke**

```bash
./run.sh
```

Verify existing OAuth accounts remain, create/edit/delete a manual provider, preview CC Switch, import a selected provider, bind compatible providers to Claude/Codex, and confirm no UI overlap at desktop and narrow widths.

- [ ] **Step 5: Commit verification corrections**

Only if verification required code/test corrections; otherwise leave this task commit-free.
