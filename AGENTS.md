# AGENTS.md

Prompt context only: keep hard constraints, short rationale, and traps already hit. Implementation details belong in source headers and tests.

## Repo

CogSeed desktop companion agent (Electron). Main is TypeScript under `src/main`, renderer is vanilla HTML/CSS/JS under `src/renderer`.

- Quick gates: `npm run typecheck` (tsc --noEmit), `npm test` (js + resources), `./run.sh` to start.

## Boundary

Single-process Electron app. Main is a Node backend, renderer is vanilla HTML/CSS/JS, and IPC is the only app communication path.

- No HTTP server, no occupied port, and no local auth layer in main.
- Renderer access goes through the canonical `contextBridge` allow-list API `window.cogseed.{invoke, stream}`.
- No TypeScript/JSX/bundler in the renderer; classic scripts only.
- `src/main/preload.js` must remain `.js`; preload does not run the tsx hook.
- LLM calls use the in-process `core-agent` loaded dynamically through `import('#core-agent')`.
- Local CLI agents are the explicit child-process exception. `features/local_agents/runner.ts` is the only CLI dispatch spawn path.
- The isolated worker process is spawned only through its dedicated `worker-process.ts` entry and speaks the Runtime JSONL protocol; no IPC handler/renderer code may spawn it directly. Inside that isolated worker, Runtime tool execution is limited to the dedicated kernel tool choke points: shell commands through `shell-tools.ts`, skill scripts through `skill-tools.ts` → `bin/run-skill.cjs`.
- MCP stdio connectors spawn only through `features/connectors/mcp-client.ts`.
- User data is mostly JSON/JSONL for readability and sync friendliness; sqlite is reserved for the KB vector store.
- macOS and Windows are primary. Platform branches need platform-specific verification.
- New npm dependencies require prior discussion; renderer third-party JS/CSS goes under `src/renderer/vendor/`, not npm.

## Layering

- `ipc/`: validate args and call features; no business logic.
- `features/`: business workflows; may use storage, paths, prompts, model, util, and sibling features.
- `model/` and `model/core-agent/`: model-call adapters and tool plumbing; do not read/write business data under `data/`.
- `util/`: pure/foundational helpers; never reverse-import features/model.
- `storage.ts`, `paths.ts`, and path sandbox helpers are the storage/path choke points.
- `i18n.ts` may read locales but must not import features/model.

Additional rules:

- Feature functions handling user-private data take `userId` as the first argument.
- Boot-time async work registers through `util/boot_init.ts`, not raw startup timers or async IIFEs.
- `#core-agent` is dynamic-import only. Static import loads dependencies before the SDK timeout patch and can break ESM resolution.
- New core-agent tools must be registered in `tool-catalog.ts::TOOL_CATALOG` and runner wiring. Tool descriptions live in SDK `tools[]`, not in a duplicated prompt tool list.
- File-class tools must check `util/path-sandbox.isPathAllowed` at entry.
- Tool results go through `util/tool-result-cap.ts`.

## Prompt Files

`src/main/prompts/*.md` is LLM-facing source. It must not contain:

- Product/brand names.
- Real OS paths.
- Project source/data directory literals.
- Hard-coded tool catalogs.

Runtime-volatile prompt fields go in one trailing `## Runtime injection` section. Static rules stay first so cache prefixes remain stable.

## Data Domains

All user-scoped data lives under `<container>/data/<uid>/{cloud,local}/`.

- `uid` is an opaque single path segment. Do not parse it or embed it into session ids.
- `cloud/` is syncable user-private state: chats, resumable sessions, attachments, artifacts, saved apps, contexts source files, memory, custom agents/skills, projects, marketplace install manifest, auto tasks, and user config.
- `local/` is machine-private state: account/session cache, marketplace installed content, caches, indexes, vector DB, workspace selection, tool-result spills, local-agent archives, and dev archives.
- Never cache uid-derived paths as module-level constants. Get the active uid at use time.
- Project membership is an index field on a conversation. Do not encode `project_id` into paths, cids, or session ids.
- Project lists are directory scans; do not restore an aggregate `projects/_index.json`.

## Conversations And Group Chat

Session ids are `<kind>-<tail>`; user scoping comes from the path root, not the filename. Add new kinds by updating the session-store allowlist and all session-kind gates.

Main rules:

- Commander, agent-worker, skill-edit, agent-edit, and one-shot sessions are separate session files from UI message lists.
- Group chat dispatch goes through `features/group_chat/bus.ts::enqueue`. Do not create parallel enqueue/scheduling paths.
- Agent workers read only their visibility slice; never the full conversation jsonl.
- LLM dispatch is structured (`dispatch_to`, `plan_set`), not `@name` in prose.
- User abort is never a transient retry. Network retry patterns must stay network-specific.
- Group abort is the single stop path for all actors.
- Infinite-loop protection is turn-count based, paired with idle timeout; do not replace it with total wall-clock timeout.
- Expert signals emit only from the established group-chat chokepoints or model callbacks drained by bus.

Attachments:

- Main conversation attachments are stored under the current cid with zero eager preprocessing.
- Read/edit tools are scoped to active workspace plus current attachment dir.
- `stat_file` precedes `read_file` for pdf/docx.
- Video attachments are display-only, not model input.

## Artifacts And Saved Apps

- `create_artifact` writes only to `<uid>/cloud/chat_artifacts/<cid>/<artifactId>/`.
- `chat-app://` serves only validated artifact files; never expose `window.cogseed` or IPC to the iframe.
- Artifact-to-app communication is the validated `postMessage` contract and routes back as a normal user message.
- Saved apps live only under `<uid>/cloud/saved_apps/<appId>/` and open through the saved-app resolver.
- Editing a saved app is fork-and-modify via a new conversation and attachment bundle; it is not in-place mutation.
- Do not widen artifact served extensions or iframe sandbox privileges without a security review.

## Skills, Agents, And Marketplace

- Skill sources are custom cloud skills plus platform local marketplace installs. Custom overrides platform by id.
- Platform builtin agents/skills are product content, not platform libraries. Runtime-facing platform code must not import/require files from `resources/builtin/...`, hard-code a builtin agent/skill id as a business dependency, or call a builtin skill script directly for shared logic. The only allowed direct reads of `resources/builtin` are seed/reconcile/build/eval flows that materialize or verify marketplace content.
- Agent/skill category belongs in the spec (`agent.json` or SKILL.md frontmatter); install freshness belongs in `_install.json` / install manifests.
- Creator skills (`agent-creator`, `skill-creator`) are the canonical source for authoring semantics, validation details, and category candidates.
- Platform agent/skill primary text is English. Descriptions are bilingual (`description_zh`, `description_en`); other UI languages fall back to English.
- SKILL.md frontmatter allows only the approved spec fields. External dependencies are prose in the body, not runtime-managed metadata.
- Skill id is the directory name; display name is frontmatter `name`. Do not re-couple them.
- `agent.skill_list`: missing means legacy unfiltered, empty means no skills, non-empty means strict subset.
- Skill execution goes through `bin/run-skill.cjs`; do not bypass the runner.

## Connectors

- Provider client credentials live on the server side. The client starts OAuth via the server and receives grants through the deep link callback.
- Connector metadata may remain plaintext, but token-bearing grant/DCR/transport data lives inside per-instance `secrets_enc`.
- `transport` is encrypted because resolved transport can contain access tokens.
- Do not reuse account-login modules/namespaces for connector authorization.
- Tool exposure uses the umbrella pattern: a `## Connectors` block plus `list_connector_tools` and `call_connector_tool` meta-tools.
- Never inject every MCP action as a flat SDK tool list.
- Connector visibility is live connected state, user enable toggle, and session-kind scope.
- Non-connected connectors are invisible to the LLM; do not add disconnected/error status hints to prompt blocks.

## Knowledge Base

- User-managed context source files live in cloud; derived vector DB and model config live in local machine-private `.kb`.
- Embedder/model config is fixed unless a full rebuild/migration is designed.
- Do not use worker_threads for multiple ONNX sessions; use child-process isolation for true parallelism.
- The model may access contexts only through KB tools, not shell/file scans of the contexts dir.
- Chunking/search/vector-store shared logic should reuse the existing utilities instead of new bespoke parsers.

## Renderer

- Classic scripts only. Add new script files to `index.html`.
- New `window.cogseed.*` APIs require a main IPC handler; renderer shim routes are centralized.
- Markdown rendering uses `renderMarkdown`; dashboard directives and schema references change together.
- Do not append cache-busting query strings to renderer resources.
- Renderer icons come from `modules/icons.js` through `uiIconHtml(...)` or `hydrateUiIcons(...)`; add missing icon names there instead of hard-coding SVG paths or using emoji icons.
- Shared Renderer primitives are `uiButton(...)`, `uiIconButton(...)`, `uiField(...)`, `uiForm(...)`, `uiEmptyState(...)`, `uiModal(...)`, `uiModalController(...)`, and `uiPageHeader(...)`; extend these seams instead of adding page-local button, form, empty-state, modal, or page-header variants.
- Any Renderer feature that adds or changes a visible button, form control, empty state, modal, or page header must follow `.agents/skills/cogseed-component-change/SKILL.md` and add real-page integration coverage. `test/renderer/shared-ui-adoption-guard.test.ts` freezes the legacy raw-control baseline; do not raise that baseline to bypass migration or review.
- Renderer layers use `--z-base`, `--z-raised`, `--z-sticky`, `--z-popover`, `--z-tour`, `--z-overlay`, `--z-modal`, `--z-modal-popover`, `--z-command`, and `--z-toast`, in that order; do not add literal `z-index` values outside `tokens.css`.
- Keydown action shortcuts in inputs/textareas must ignore IME composition (`e.isComposing || e.keyCode === 229`).
- Long-running user actions need visible progress; read-heavy network views should use stale-while-revalidate when staleness is acceptable.

## i18n

- Visible UI strings go through `src/{renderer,main}/locales/*.json` and `t(...)`.
- Main-generated text uses main locales; renderer chrome uses renderer locales. Shared surfaces may need both.
- Dynamic renderer text must re-render on `i18n-change`.
- Agent/skill descriptions use `description_zh` for Chinese and `description_en` otherwise.
- Prompts, logs, telemetry event names, and user content are not i18n-ed.

## Logging, Telemetry, Privacy

- Use `createLogger('<module>')`; do not use `console.log` for app logging.
- Recoverable failures log `warn`; broken invariants log `error`.
- Sensitive fields must be redacted before logs/telemetry.
- Telemetry payloads contain only ids, types, counts, lengths, or coarse status.
- Expert-signal files are local-only and may contain raw excerpts. Never copy their content into logs, telemetry, or cross-machine channels.

## Tests And Dev Workflow

- Start the app with `./run.sh`.
- Run tests with `npm test`, not `npx vitest`; the test script manages sqlite ABI swapping and rollback.
- If sqlite ABI is broken, run `npm run rebuild:sqlite:electron`.
- After merging develop into a feature branch, re-verify renderer↔main IPC contracts and run `npm run typecheck` — merges have silently dropped IPC channels before.
- Tests should cover business invariants, recovery paths, concurrency, cross-layer contracts, and text-processing traps.
- Do not test typing-only wrappers, trivial getters, happy-path-only cases, or implementation internals.
- LLM-output parsers/sanitizers need fixture sets for both accepted real shapes and rejected look-alikes.
- Pure renderer functions may expose a guarded CommonJS bridge for tests; DOM/i18n/IPC code should not.
- After completing changes to this worktree, restart the running app for verification instead of asking the user to do it manually: run `scripts/restart-cogseed.sh` (stops only this worktree's runtime and relaunches via `./run.sh` in the background; other variants are untouched). Confirm startup via the runtime data logs and the launcher log `/tmp/cogseed-agent-cogseed-run.log`, then run the real-environment verification.

## Version Control

- Sync baseline is `origin/develop`; keep local branches rebased on it.
- Never push to protected mainlines directly; land changes through merge requests.

## Do Not

- Put business logic in IPC handlers.
- Spawn CLI agents or MCP servers outside the approved choke points.
- Store user data outside `<uid>/{cloud,local}/`.
- Hand-edit local config/marketplace install files outside the owning UI/dev flow.
- Bypass path sandboxing, locks, file indexer, sync transport, or artifact/saved-app resolvers.
- Add eager attachment extraction or automatic pdf/docx fallback in `read_file`.
- Add LLM total wall-clock timeouts or lock wait timeouts; use the existing idle/watchdog semantics.
- Reintroduce aggregate project indexes, uid-bearing session ids, flat connector tool injection, or parallel group-chat dispatch paths.
