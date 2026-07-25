# Orkas Agent Staging Map

**Generated:** 2026-07-25
**Status:** READY FOR MAP APPROVAL — Commit F is complete; Commit G candidate is independently compileable and targeted-tested.
**Safety:** Classification and detached-worktree verification only. No new source file was staged, committed, reset, cleaned, or deleted in this continuation.

## Commit dependency order

```text
F (mechanical quote normalization — complete)
  → G (integrated Collaboration + P3394/Wake/KSTAR runtime)
  → C (IPC and renderer surfaces)
  → D (Commander/provider compatibility migration)
```

## Commit F

Already created and verified:

```text
7dec9b6 style(group-chat): normalize TypeScript string quote formatting
```

It contains only the four approved quote-normalized files:

- `src/main/features/group_chat/bus.ts`
- `src/main/features/group_chat/collaboration.ts`
- `test/main/features/group_chat/bus-integration.test.ts`
- `test/main/features/group_chat/collaboration.test.ts`

## Commit G — integrated runtime boundary

G contains the mutually dependent collaboration and P3394 runtime changes. The previous B-only split failed because P3394 imports the new agent interface contract and context writer, and Wake imports the collaboration cancellation API. G therefore lands those APIs together.

### Whole-file G paths

The following current diffs are wholly owned by G:

- `src/main/features/agents.ts` — `AgentInterfaceContract` normalization and persistence.
- `src/main/features/contexts.ts` — user-scoped context root/path resolution and `writeContextFileForUser`.
- `src/main/features/group_chat/collaboration.ts` — workflow context, proposal/conflict lifecycle, gates, event/snapshot APIs, nested dispatch settlement, and cancellation facade.
- `src/main/features/group_chat/index.ts` — collaboration runtime integration exports.
- `src/main/features/group_chat/visibility.ts` — collaboration visibility/event projection.
- `src/main/features/p3394/index.ts` — P3394 integration export.
- `src/main/features/p3394/kstar-engine.ts` — KSTAR engine execution and review-gate orchestration.
- `src/main/features/p3394/kstar-kb.ts` — KSTAR knowledge-base evidence integration.
- `src/main/features/p3394/kstar-notion.ts` — KSTAR Notion evidence integration.
- `src/main/features/p3394/protocol.ts` — P3394 protocol normalization and agent contract mapping.
- `src/main/features/p3394/kstar-runtime.ts` — KSTAR runtime governance and review flow.
- `src/main/features/p3394/types.ts` — protocol/runtime type additions.
- `src/main/features/p3394/wake-controller.ts` — approval admission, target validation, enqueue recovery, and hand-off restoration.
- `src/main/features/p3394/wake-service.ts` — wake request workflow/cancellation integration.
- `src/main/prompts/chat_shared_task_context_protocol.md` — new canonical shared context-patch contract.
- `src/main/prompts/chat_agent_in_group.md` — remove duplicated context-patch contract and add chunked-writing protocol.
- `src/main/prompts/chat_cli_agent.md` — remove duplicated context-patch contract.
- `src/main/prompts/chat_commander.md` — remove duplicated contract and add delegation/KSTAR/chunked-writing rules.
- `test/main/features/group_chat/collaboration.test.ts` — collaboration context, conflict, gate, snapshot, and settlement coverage.
- `test/main/features/group_chat/bus-integration.test.ts` — integrated runtime, gate, artifact, CLI, and protocol coverage.
- `test/main/features/p3394/kstar-runtime.test.ts` — KSTAR runtime coverage.
- `test/main/features/p3394/kstar-engine.test.ts` — KSTAR engine coverage.
- `test/main/features/p3394/kstar-kb.test.ts` — KSTAR KB evidence coverage.
- `test/main/features/p3394/kstar-notion.test.ts` — KSTAR Notion evidence coverage.
- `test/main/features/p3394/protocol.test.ts` — P3394 protocol coverage.
- `test/main/features/p3394/wake-controller.test.ts` — Wake admission/controller coverage.
- `test/main/features/p3394/wake-recovery.test.ts` — Wake recovery coverage.
- `test/main/features/p3394/wake-service.test.ts` — Wake/P3394 service coverage.

### Mixed G path requiring hunk review

- `src/main/features/group_chat/bus.ts` — stage the complete integrated runtime rewrite as one G boundary. It removes the direct Hermes-as-Commander execution path while adding collaboration/P3394 routing, protocol events, gates, and recovery. The legacy Commander backend settings migration remains in D; this file no longer imports or invokes the legacy Hermes Commander path.
- `test/main/features/group_chat/bus.test.ts` — accept the G-owned protocol-event mock and protocol metadata test, and the removal of the obsolete direct-Hermes Commander repair tests. Reject and leave unstaged the replacement test named `ignores legacy Hermes commander backend config and runs the Orkas commander`; it writes a legacy `hermes-cli` Commander setting and asserts normalization to `orkas-core-agent`, so the entire test is D-owned and must be staged only with the Commander settings migration.

### G detached candidate verification

A detached worktree was created from `HEAD` and populated only with the G source/prompt files plus the G test files. The following passed:

```text
npm run typecheck -- --pretty false
→ exit 0

npm run test:js -- \
  test/main/features/group_chat/collaboration.test.ts \
  test/main/features/group_chat/bus.test.ts \
  test/main/features/group_chat/bus-integration.test.ts \
  test/main/features/p3394/protocol.test.ts \
  test/main/features/p3394/wake-service.test.ts \
  test/main/features/p3394/wake-controller.test.ts \
  test/main/features/p3394/wake-recovery.test.ts \
  test/main/features/p3394/kstar-runtime.test.ts \
  test/main/features/p3394/kstar-engine.test.ts \
  test/main/features/p3394/kstar-kb.test.ts \
  test/main/features/p3394/kstar-notion.test.ts \
  --testNamePattern='^(?!.*ignores legacy Hermes commander backend config).*'
→ 11 test files passed; 200 tests passed; 1 skipped
```

The excluded test is intentionally D-owned: it requires the Commander settings normalization that is not part of G.

## Commit C — IPC and renderer surfaces

C remains pending after G approval. Candidate paths:

- `src/main/ipc/index.ts`
- `src/renderer/index.html`
- `src/renderer/modules/ipc-shim.js`
- `src/renderer/modules/conversation-info.js`
- `src/renderer/modules/conversation.js`
- `src/renderer/style.css`
- collaboration/P3394 renderer locale additions in `src/renderer/locales/{en,ja,pt,zh}.json`
- collaboration/P3394 renderer tests, subject to separating unrelated settings/activity changes:
  - `test/renderer/conversation-info.test.ts`
  - `test/renderer/conversation-agent-status.test.ts`
  - `test/renderer/conversation-produced-chips.test.ts`
  - `test/renderer/conversation-sidebar.test.ts`
  - `test/renderer/ipc-shim.test.ts`
  - `test/renderer/p3394-experience-controls.test.ts`

C needs a separate hunk review because several renderer files also contain unrelated settings/activity work.

## Commit D — Commander/provider compatibility migration

D contains the approved legacy Commander migration and remaining provider/agent compatibility changes:

- `bootstrap.cjs`
- `run.sh`
- `run.cmd`
- `src/main/features/auth.ts`
- `src/main/features/commander_backend.ts`
- `src/main/features/config.ts`
- `src/main/model/core-agent/external-providers.ts`
- `src/main/model/core-agent/runner.ts`
- remaining D-owned hunks in `src/main/features/agents.ts` and `src/main/features/contexts.ts`, if any after G extraction
- `src/main/features/commander_backends/hermes.ts` (delete)
- `test/main/features/commander-backend-hermes-decision.test.ts` (delete)
- `test/main/features/agents.test.ts`
- `test/main/features/auth.test.ts`
- `test/main/features/commander-backend-routing.test.ts`
- `test/main/features/commander-backend-settings.test.ts`
- `test/main/model/core-agent/external-providers.test.ts`
- `test/main/prompts/contract.test.ts`
- `test/renderer/model-guard.test.ts` / settings-related tests where applicable
- remaining prompt/runtime migration hunks not required by G

Hermes remains available at `src/main/features/local_agents/backends/hermes.ts`; only the legacy Commander backend is removed.

## HOLD

Do not stage without a later classification/approval:

- generated DOCX/PDF files and render directories;
- `__pycache__` directories;
- `.superpowers/`;
- unclassified design/spec/plan documents;
- unrelated renderer/settings/activity hunks.

No deletion decision has been made for HOLD paths.
