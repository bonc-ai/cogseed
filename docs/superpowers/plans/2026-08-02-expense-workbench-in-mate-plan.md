# Expense Workbench In Mate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the existing reimbursement workbench into Mate's Agent detail management surface, replace browser HTTP calls with a validated IPC/stdio bridge, and remove the old browser UI after parity verification.

**Architecture:** The Agent spec declares an optional `management_surface` key. Mate's renderer opens the `expense_workbench` surface only for agents that declare it. Renderer requests go through `window.orkas.invoke('expenseWorkbench.*')`; main validates the active user, agent surface, project configuration, material references, and versions before calling a machine-readable stdio bridge owned by the reimbursement project. The reimbursement project's `ApplicationService`, database, T/R/A-BOX, audit log, and security gates remain the only business source of truth.

**Tech Stack:** Electron renderer classic JavaScript, existing Mate CSS/i18n/icon helpers, Electron contextBridge IPC, TypeScript main features, Python 3.12 reimbursement service, JSONL stdio protocol, Vitest/pytest contract tests.

---

## File Map

### Reimbursement project

- Create: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/task_agent/stdio_bridge.py` — one-request-per-line JSONL transport that calls the existing application service and returns safe projections.
- Modify: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/task_agent/contracts.py` — shared request/response validation for the bridge.
- Modify: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/bootstrap.py` — expose the service composition root used by the stdio bridge without importing FastAPI.
- Test: `/Users/an/东方国信项目/报销智能体/tests/test_task_agent_stdio_bridge.py` — protocol, validation, isolation, failure and version-conflict tests.
- Test: existing application/task-agent contract tests — update expected command/result fields for the host bridge.
- Delete after parity: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/api/admin_templates/index.html`, `admin.css`, `admin.js`.
- Modify after parity: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/api/server.py` — remove browser page/static mounts and browser-only quit route while retaining APIs required by non-browser integrations.

### Mate main process

- Modify: `resources/builtin/marketplace/agents/c045605cb916/agent.json` — declare `management_surface: "expense_workbench"` and align the input/bridge description with the versioned application contract.
- Modify: `src/main/features/agents.ts` — parse and validate optional management-surface metadata without coupling platform code to the built-in agent id.
- Create: `src/main/features/expense_workbench/contracts.ts` — typed payload/result schemas and stable error codes.
- Create: `src/main/features/expense_workbench/adapter.ts` — active-user/project resolution, approved stdio process lifecycle, JSONL request correlation, result caps, redaction and domain error mapping.
- Create: `src/main/features/expense_workbench/materials.ts` — project/material reference projection using existing attachment and path-sandbox helpers.
- Create: `src/main/features/expense_workbench/settings.ts` — safe non-secret project and connection configuration operations.
- Modify: `src/main/ipc/index.ts` — register the `expenseWorkbench.*` handler table.
- Modify: `src/main/preload.js` only if a named convenience wrapper is required; generic `window.orkas.invoke` remains the canonical path.

### Mate renderer

- Modify: `src/renderer/index.html` — add the management surface host and load the new classic script.
- Modify: `src/renderer/modules/agents.js` — render the management button only when a valid `management_surface` is present and open/close the surface.
- Create: `src/renderer/modules/expense-workbench.js` — workbench state machine, navigation, IPC calls, forms, progress, error/empty states and cleanup.
- Create: `src/renderer/modules/expense-workbench-markup.js` — escaped HTML templates for the seven workbench sections and shared row/card renderers.
- Modify: `src/renderer/style.css` — scoped workbench layout and responsive rules using existing variables/classes.
- Modify: `src/renderer/modules/icons.js` only when a missing existing icon needs to be registered; do not inline SVG paths in the workbench.
- Modify: `src/renderer/locales/zh.json`, `en.json`, `ja.json`, `pt.json` — all new visible strings.
- Test: `test/main/features/expense_workbench_adapter.test.ts`, `test/main/ipc/expense_workbench_ipc.test.ts` and renderer pure-state tests under the existing test layout.

## Task 1: Freeze the Existing Workbench Contract

**Files:**
- Create: `test/fixtures/expense-workbench/legacy-contract.json`
- Create: `test/main/features/expense_workbench_contract.test.ts`
- Reference: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/api/admin_templates/admin.js`

- [ ] Extract the existing seven page names, user actions, required fields, success states and error states into a fixture. Include application create/list/get, material add/list, draft, precheck, report, review, audit, connection settings and assistant actions.
- [ ] Add a failing contract test that asserts each migrated action has a named `expenseWorkbench.*` operation and that no migrated action depends on the legacy `new` / `answer` / `status` / `report` session command names.
- [ ] Run `npm test -- --runInBand test/main/features/expense_workbench_contract.test.ts` and confirm it fails because the operation registry does not exist.
- [ ] Define the operation registry as a typed constant in the test fixture module, keeping request/response names stable for the subsequent bridge and IPC tasks.
- [ ] Commit the fixture and failing contract test: `git add test/fixtures/expense-workbench test/main/features/expense_workbench_contract.test.ts && git commit -m "test: freeze expense workbench contract"`.

## Task 2: Add the Reimbursement JSONL Bridge

**Files:**
- Create: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/task_agent/stdio_bridge.py`
- Modify: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/task_agent/contracts.py`
- Modify: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/bootstrap.py`
- Test: `/Users/an/东方国信项目/报销智能体/tests/test_task_agent_stdio_bridge.py`

- [ ] Write tests for one-line request parsing and one-line response writing using an in-memory stdin/stdout harness. The request envelope must be:

```json
{"request_id":"opaque","operation":"applications.get","user_id":"bound-user","payload":{"application_id":"RA-..."}}
```

The response envelope must be either:

```json
{"request_id":"opaque","ok":true,"result":{}}
```

or:

```json
{"request_id":"opaque","ok":false,"error":{"code":"version_conflict","message":"...","retryable":false}}
```

- [ ] Reject blank lines, invalid JSON, duplicate request ids, unknown operations, extra top-level fields, oversized lines and payloads containing shell syntax. Return a structured error and keep the process alive for recoverable request errors.
- [ ] Add typed dispatch functions for `manifest`, `health`, application list/get/create/draft/precheck/report, materials list/add, reviews list/decide, audit list, settings get/update/test, and assistant inspect/propose. Dispatch must call the existing `ApplicationService` or its existing safe projection helpers, not duplicate domain rules.
- [ ] Bind every operation to the `user_id` supplied by the host context and apply the same owner/role checks used by the current API. Never return user identifiers, capability tokens, raw credentials, local absolute paths or internal projections.
- [ ] Add graceful SIGTERM/SIGINT shutdown, flush each response before the next read, write diagnostics only to stderr, and return non-zero only for unrecoverable bootstrap failure.
- [ ] Run `cd '/Users/an/东方国信项目/报销智能体' && PYTHONPATH=src .venv/bin/python3 -m pytest tests/test_task_agent_stdio_bridge.py -q`; expected result is PASS.
- [ ] Commit the bridge and tests in the reimbursement repository: `git -C '/Users/an/东方国信项目/报销智能体' add src/expense_reimbursement/task_agent src/expense_reimbursement/bootstrap.py tests/test_task_agent_stdio_bridge.py && git -C '/Users/an/东方国信项目/报销智能体' commit -m "feat: add reimbursement stdio bridge"`.

## Task 3: Add Mate's Controlled Reimbursement Adapter

**Files:**
- Create: `src/main/features/expense_workbench/contracts.ts`
- Create: `src/main/features/expense_workbench/adapter.ts`
- Create: `src/main/features/expense_workbench/materials.ts`
- Create: `src/main/features/expense_workbench/settings.ts`
- Test: `test/main/features/expense_workbench_adapter.test.ts`

- [ ] Write failing tests for project path resolution: only an absolute directory containing `.venv/bin/python3` (POSIX) or the documented Windows interpreter is accepted; the resolved path must pass `isPathAllowed` and must not be a file, symlink escape, or arbitrary parent directory.
- [ ] Write failing tests for adapter request correlation, one in-flight request per project/user session, process exit, malformed JSON, stderr redaction, response-size caps, timeout/idle recovery and cancellation.
- [ ] Implement typed `ExpenseWorkbenchOperation`, `ExpenseWorkbenchRequest`, `ExpenseWorkbenchResult`, `ExpenseWorkbenchError`, and `ExpenseWorkbenchProjectConfig` types. Do not use `any` or `unknown` for public boundaries.
- [ ] Implement the adapter through the repository's approved local CLI/child-process dispatch entry point; do not call `child_process.spawn` from this feature. Pass the project path and interpreter as validated process configuration, never as shell text.
- [ ] Implement a request queue keyed by active user plus validated project root, preserving response order and preventing concurrent writes to one reimbursement store. Ensure process cleanup on app shutdown and project switch.
- [ ] Implement `materials.ts` to accept only Mate-issued attachment/material references, verify current conversation/application scope, and project metadata without exposing source paths to Python or renderer.
- [ ] Implement `settings.ts` so API keys remain in the existing secret facade; renderer receives only configured/unconfigured state and safe non-secret fields.
- [ ] Run `npm test -- --runInBand test/main/features/expense_workbench_adapter.test.ts`; expected result is PASS.
- [ ] Commit the adapter: `git add src/main/features/expense_workbench test/main/features/expense_workbench_adapter.test.ts && git commit -m "feat: add expense workbench main adapter"`.

## Task 4: Expose the Management Surface in Agent Details

**Files:**
- Modify: `src/main/features/agents.ts`
- Modify: `resources/builtin/marketplace/agents/c045605cb916/agent.json`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/agents.js`
- Modify: `src/renderer/locales/zh.json`, `en.json`, `ja.json`, `pt.json`
- Test: `test/main/quality/builtin-expense-agent.test.ts`, `test/main/features/agents_management_surface.test.ts`

- [ ] Add an optional `management_surface?: string` field to the normalized Agent type and validate against a small registered surface set. Unknown values are ignored with a warning; absence preserves existing Agent behavior.
- [ ] Add `"management_surface": "expense_workbench"` to the reimbursement agent spec and update its description to identify the Mate-managed workbench without mentioning a browser URL.
- [ ] Add a management button beside Use/Edit/Disable only when the loaded Agent has a valid surface. The button must be keyboard accessible, localized and absent for CodeX, Hermes and ordinary marketplace agents.
- [ ] Add a hidden management panel host in `index.html`; opening it records the selected agent surface and hides only the Agent detail content. Closing it restores the previous detail view and scroll position.
- [ ] Add tests proving surface metadata survives builtin seed/load normalization, invalid values do not create a button, and the reimbursement surface does create one.
- [ ] Run `npm test -- --runInBand test/main/quality/builtin-expense-agent.test.ts test/main/features/agents_management_surface.test.ts`; expected result is PASS.
- [ ] Commit the entry point: `git add src/main/features/agents.ts resources/builtin/marketplace/agents/c045605cb916/agent.json src/renderer/index.html src/renderer/modules/agents.js src/renderer/locales test/main/quality/builtin-expense-agent.test.ts test/main/features/agents_management_surface.test.ts && git commit -m "feat: add agent management surface entry"`.

## Task 5: Register IPC Contracts and Handlers

**Files:**
- Modify: `src/main/ipc/index.ts`
- Test: `test/main/ipc/expense_workbench_ipc.test.ts`

- [ ] Add failing IPC tests for every operation in the Task 1 registry. Test invalid surface, invalid application id, wrong user scope, missing version, unauthorized material, unknown settings key and forbidden approval/submit requests.
- [ ] Register handlers under `expenseWorkbench.*` that validate payloads before calling the adapter. Handler payloads must carry the active context from `ctx.userId`; renderer-provided user ids are rejected.
- [ ] Return stable `{ ok: true, ...result }` shapes through the existing router and normalize adapter errors with `normalizeAppError`/existing redaction utilities.
- [ ] Add progress events for precheck, report, settings test and assistant operations through the existing stream handler family; cancellation must terminate the adapter request without mutating the application.
- [ ] Run `npm test -- --runInBand test/main/ipc/expense_workbench_ipc.test.ts`; expected result is PASS.
- [ ] Commit the IPC layer: `git add src/main/ipc/index.ts test/main/ipc/expense_workbench_ipc.test.ts && git commit -m "feat: expose expense workbench IPC"`.

## Task 6: Port the Workbench Shell and Styles

**Files:**
- Create: `src/renderer/modules/expense-workbench-markup.js`
- Create: `src/renderer/modules/expense-workbench.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/locales/zh.json`, `en.json`, `ja.json`, `pt.json`

- [ ] Copy the existing workbench's page hierarchy into escaped renderer templates, preserving the seven navigation sections and content relationships. Replace raw emoji/inline SVG with `uiIconHtml` and existing icon ids.
- [ ] Add a scoped root class (`.expense-workbench`) and port the existing layout, tables, forms, badges, status cards, dialogs, responsive rules and loading states into `style.css` without global selectors that alter chat, Agents, Skills or Settings.
- [ ] Add a module lifecycle API: `openExpenseWorkbench(surface, context)`, `closeExpenseWorkbench()`, `refreshExpenseWorkbench()`, and `disposeExpenseWorkbench()`. Reopening must not duplicate event listeners or timers.
- [ ] Add a page-state enum and renderer-only state model for `assistant`, `applications`, `precheck`, `overview`, `reviews`, `connections`, and `audit`; each page starts in loading state and renders explicit empty/error states.
- [ ] Add locale keys for every visible string, including status/error labels and action tooltips. Re-render dynamic labels on `i18n-change`.
- [ ] Add pure CommonJS-guarded tests for page transitions, loading/error transitions, stale response rejection and cleanup; do not test DOM wiring through implementation internals.
- [ ] Run the renderer test command used by the repository plus `npm test -- --runInBand test/renderer/expense-workbench.test.js`; expected result is PASS.
- [ ] Commit the shell: `git add src/renderer/modules/expense-workbench* src/renderer/index.html src/renderer/style.css src/renderer/locales test/renderer/expense-workbench.test.js && git commit -m "feat: add Mate expense workbench shell"`.

## Task 7: Port Data Operations and Forms

**Files:**
- Modify: `src/renderer/modules/expense-workbench.js`
- Modify: `src/renderer/modules/expense-workbench-markup.js`
- Modify: `src/main/features/expense_workbench/contracts.ts`
- Modify: `test/main/ipc/expense_workbench_ipc.test.ts`
- Modify: `/Users/an/东方国信项目/报销智能体/tests/test_task_agent_stdio_bridge.py`

- [ ] Port application list/create/open flows to `expenseWorkbench.applications.*`, including filters, pagination and stale-while-revalidate for read-heavy lists.
- [ ] Port material add/list using Mate's existing file picker and attachment authorization. Show upload progress, reject unsupported files before dispatch, and render only safe metadata.
- [ ] Port draft editing with current version read, explicit `expected_version`, diff preview and conflict recovery. Never retry a failed write automatically.
- [ ] Port precheck, evidence and draft report actions. Ensure the UI calls evidence before displaying OCR/rule/verification detail and labels every generated report as draft unless the domain result explicitly permits another state.
- [ ] Port the assistant page as a bounded application-scoped conversation. Parse only the structured operation proposal returned by the adapter; display a diff before applying a proposal.
- [ ] Port reviews, audit records and settings with role/error states. Approval and submission actions remain behind their existing human confirmation and role gates.
- [ ] Add tests for missing materials, `needs_review`, `version_conflict`, unavailable model/configuration, duplicate click, and adapter process restart recovery.
- [ ] Run both `npm test -- --runInBand test/main/ipc/expense_workbench_ipc.test.ts` and `cd '/Users/an/东方国信项目/报销智能体' && PYTHONPATH=src .venv/bin/python3 -m pytest tests/test_task_agent_stdio_bridge.py tests/test_application_lifecycle.py -q`; expected result is PASS.
- [ ] Commit the Mate operations: `git add src/renderer/modules/expense-workbench* src/main/features/expense_workbench test/main/ipc/expense_workbench_ipc.test.ts && git commit -m "feat: port expense workbench operations"`.
- [ ] Commit the reimbursement-side contract changes separately: `git -C '/Users/an/东方国信项目/报销智能体' add tests/test_task_agent_stdio_bridge.py && git -C '/Users/an/东方国信项目/报销智能体' commit -m "test: align reimbursement bridge contract"`.

## Task 8: Complete Platform and Visual Verification

**Files:**
- Modify: `test/main/features/expense_workbench_adapter.test.ts`
- Modify: `test/main/ipc/expense_workbench_ipc.test.ts`
- Modify: renderer tests and existing Agent UI tests as failures identify affected contracts.
- Reference: `src/main/util/path-sandbox.ts`, `src/main/features/attachments*`, existing renderer test harness.

- [ ] Run the full Mate test script with sqlite ABI management: `npm test`.
- [ ] Run the reimbursement project's focused suite: `cd '/Users/an/东方国信项目/报销智能体' && PYTHONPATH=src .venv/bin/python3 -m pytest tests/test_task_agent_stdio_bridge.py tests/test_ontology_backend.py tests/test_ontology_sync.py tests/test_application_lifecycle.py -q`.
- [ ] Start Mate with `cd PC && ./run.sh`, verify no report-project port is listening, open Agents, open the reimbursement Agent, and exercise all seven workbench sections.
- [ ] Verify macOS paths containing Chinese characters and spaces, directory selection, Python interpreter detection, process recovery and app quit.
- [ ] Verify Windows path normalization, process termination, renderer layout and a clear unsupported-platform state if the bridge cannot run there.
- [ ] Verify cross-user access rejection, material scope rejection, redacted logs, no user_id in visible UI, and no local absolute path in artifacts or assistant output.
- [ ] Capture a parity checklist against `legacy-contract.json`; every legacy workbench action must have a passing Mate action before deletion.
- [ ] Commit verification-only changes: `git add test src/main src/renderer && git commit -m "test: verify expense workbench migration"`.

## Task 9: Remove the Browser Workbench After Parity

**Files:**
- Delete: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/api/admin_templates/index.html`
- Delete: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/api/admin_templates/admin.css`
- Delete: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/api/admin_templates/admin.js`
- Modify: `/Users/an/东方国信项目/报销智能体/src/expense_reimbursement/api/server.py`
- Modify: `/Users/an/东方国信项目/报销智能体/README.md`
- Modify: `docs/expense-task-agent-integration.md`

- [ ] Before deletion, run the parity checklist and confirm the Mate workbench operates without starting the Python HTTP server.
- [ ] Remove `StaticFiles`, `/admin`, `/` and `/api/local-app/quit` browser-only handling from the Python server. Keep domain APIs only when a repository-wide search proves they are used by a non-browser integration; otherwise remove the dead endpoint with its tests.
- [ ] Remove browser-only documentation and replace it with the Mate entry path, bridge prerequisite, and recovery instructions. Do not describe a localhost URL as the user workflow.
- [ ] Run `rg -n 'admin_templates|/admin|local-app/quit|127\.0\.0\.1:8000' '/Users/an/东方国信项目/报销智能体' --glob '!**/.git/**' --glob '!**/dist/**'` and review every remaining match for a legitimate API/test reference.
- [ ] Run the complete Mate and reimbursement suites again; expected result is PASS with no browser workbench files present.
- [ ] Commit the deletion in the reimbursement repository: `git -C '/Users/an/东方国信项目/报销智能体' add -A src/expense_reimbursement/api README.md && git -C '/Users/an/东方国信项目/报销智能体' commit -m "remove: retire standalone reimbursement web workbench"`.
- [ ] Commit the Mate integration documentation separately: `git add docs/expense-task-agent-integration.md && git commit -m "docs: remove standalone reimbursement web workflow"`.

## Task 10: Update Builtin Manifests and Final Regression

**Files:**
- Modify: `resources/builtin/_manifest.json`
- Modify: `test/main/quality/builtin-expense-agent.test.ts`
- Modify: `test/main/features/builtin_expense_agent_seed.test.ts`
- Modify: `docs/expense-task-agent-integration.md`
- Modify: `/Users/an/东方国信项目/报销智能体/docs/companion-task-agent-architecture.md`

- [ ] Regenerate the builtin resource manifest with the repository's `npm run builtin:manifest` command and verify only intended resource hashes changed.
- [ ] Add a quality assertion that the builtin expense Agent declares `management_surface: "expense_workbench"`, uses the current application bridge contract, and has no legacy CLI command instructions.
- [ ] Add seed verification that the management surface survives first-run copy into the user's local marketplace installation.
- [ ] Update both integration documents to describe Mate as the only user-facing workbench and the stdio/IPC path as the only embedded transport.
- [ ] Run `npm test` and the focused Python suite one final time; expected result is PASS.
- [ ] Run `git status --short` in both repositories and verify unrelated `.reasonix/` remains untouched; commit Mate manifest/docs changes with `git add resources/builtin/_manifest.json test/main/quality/builtin-expense-agent.test.ts test/main/features/builtin_expense_agent_seed.test.ts && git commit -m "docs: finalize Mate reimbursement workbench integration"`.
- [ ] Commit the reimbursement architecture documentation separately with `git -C '/Users/an/东方国信项目/报销智能体' add docs/companion-task-agent-architecture.md && git -C '/Users/an/东方国信项目/报销智能体' commit -m "docs: finalize Mate workbench integration"`.

## Completion Checklist

- [ ] Mate's Agent detail shows “管理” only for an Agent with a valid management surface.
- [ ] The migrated workbench renders all seven sections with loading, empty, success, error and permission states.
- [ ] No renderer code calls the reimbursement HTTP API or starts a local report-project server.
- [ ] The stdio bridge uses the existing domain service, database, T/R/A-BOX and audit gates.
- [ ] User scope, path sandbox, material authorization, version conflict and confirmation gates are tested.
- [ ] The standalone browser templates and browser-only routes are removed only after parity passes.
- [ ] Mate and reimbursement test suites pass on supported platforms, with an explicit unsupported state where the bridge cannot run.
