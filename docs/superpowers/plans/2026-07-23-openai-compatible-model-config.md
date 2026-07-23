# OpenAI-Compatible Model Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Add cc-switch-style custom OpenAI-compatible API key configuration to Mate Agent's AI team model settings.

**Architecture:** Reuse the existing auth profile + entry priority chain instead of creating a parallel config system. Store API keys and base URLs in local encrypted auth profiles, keep model ids in entries, and route runtime calls through the external-provider adapter used by Moonshot/DeepSeek/Doubao.

**Tech Stack:** Electron main IPC, `src/main/features/auth.ts`, `src/main/model/provider_catalog.ts`, `src/main/model/core-agent/external-providers.ts`, vanilla renderer settings JS, Vitest.

---

### Task 1: Backend storage and catalog

**Files:**
- Modify: `src/main/model/provider_catalog.ts`
- Modify: `src/main/features/auth.ts`
- Test: `test/main/features/auth.test.ts`
- Test: `test/main/model/provider_catalog.test.ts`

- [ ] Add provider id `openai-compatible` to `CATALOG` and `EXTERNAL_API_PROVIDERS`.
- [ ] Extend API-key profiles with optional `baseUrl`.
- [ ] Validate custom profile base URLs as safe `http:` or `https:` URLs with no username/password.
- [ ] Add `manualModel` metadata for the custom provider.
- [ ] Add tests proving listProviders exposes the provider and addApiKey stores normalized baseUrl.

### Task 2: Runtime provider adapter

**Files:**
- Modify: `src/main/model/core-agent/external-providers.ts`
- Modify: `src/main/model/core-agent/runner.ts`
- Modify: `src/main/features/auth.ts`
- Test: `test/main/model/core-agent/external-providers.test.ts`

- [ ] Add `buildOpenAICompatibleModel(modelId, baseUrl)`.
- [ ] Add `createOpenAICompatibleProvider({ apiKey, baseUrl, modelId })`.
- [ ] Pass `baseUrl` from picked chat entries into runner external-provider construction.
- [ ] Route `auth.testConnection('openai-compatible')` to the new factory.

### Task 3: Settings UI

**Files:**
- Modify: `src/renderer/modules/settings.js`
- Modify: `src/renderer/locales/{en,zh,ja,pt}.json`
- Modify: `src/main/ipc/index.ts`
- Test: `test/renderer/settings-add-account.test.ts`

- [ ] Skip fixed model selection for `manualModel` providers.
- [ ] Show Base URL and Model text inputs in the API-key modal for custom providers.
- [ ] Send `baseUrl` to `auth.addApiKey` and manual model to `auth.addEntry`.
- [ ] Add renderer test for custom provider saving path.

### Verification

Run:

```bash
npm run typecheck
npm run test:js -- test/main/features/auth.test.ts test/main/model/provider_catalog.test.ts test/main/model/core-agent/external-providers.test.ts test/renderer/settings-add-account.test.ts
```

