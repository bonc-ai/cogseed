# CogSeed Capability Inventory and Golden Fixture Matrix

> Phase 0 deliverable for the Mate Agent CogSeed parity program.
>
> Goal: enumerate the CogSeed surfaces we intend to match, identify the current Mate anchor for each, and define the golden-fixture families that Phase 0 must capture before any Phase 1 parity implementation begins.

## Scope

In scope for this matrix:

- Commander and collaboration lifecycle
- `gconv` / `gmember` session semantics
- visibility and event projection
- Group Chat bus scheduling and retry/abort behavior
- plan executor behavior
- approved Core Agent tool catalog parity
- Connector, KB, Office, and Browser parity
- historical session migration
- Renderer / IPC parity
- recovery / observability / cancellation support
- supporting wake/admission and coordination boundaries

Out of scope for this matrix:

- KSTAR AbilityAsset workstream
- new user-facing feature design unrelated to parity
- implementation changes beyond the already-verified backend baseline

## Baseline note

Phase 0 assumes the independent backend baseline commit exists and remains intact:

- `a43c26c chore: freeze independent backend baseline`

The parity worktree must stay clean except for approved parity docs and fixture artifacts.

## Capability matrix

| Capability | CogSeed surface(s) to inventory | Current Mate anchor(s) | Current status | Golden fixture families |
|---|---|---|---|---|
| Commander orchestration | `src/main/features/group_chat/collaboration.ts`, `src/main/features/group_chat/bus.ts`, `src/main/features/group_chat/plan_executor.ts`, `src/main/features/group_chat/router.ts` | `src/main/features/cogseed_backend/coordinator.ts`, `src/main/features/collaboration_control/engine.ts`, `src/main/features/group_chat/collaboration-store-adapter.ts` | `adapter_ready` | A, C, E |
| `gconv` / `gmember` session semantics | `src/main/features/group_chat/state.ts`, `src/main/features/group_chat/conv_workspace.ts`, `src/main/features/group_chat/router.ts` | `src/main/features/cogseed_backend/session-store.ts`, `src/main/features/cogseed_backend/runtime-controller.ts`, `src/main/features/p3394/session-source.ts` | `contract_only` | B, F |
| Visibility policy and projection | `src/main/features/group_chat/visibility.ts`, `src/main/features/group_chat/bus.ts` | `src/main/features/group_chat/bus.ts`, `src/main/features/collaboration_control/engine.ts`, `src/main/features/cogseed_backend/collaboration-store-adapter.ts` | `adapter_ready` | B, G, H |
| Group Chat bus scheduling / quiescence / retry / abort | `src/main/features/group_chat/bus.ts` | `src/main/features/group_chat/bus.ts`, `src/main/features/group_chat/collaboration.ts`, `src/main/features/collaboration_control/engine.ts` | `adapter_ready` | A, C, E |
| Plan executor behavior | `src/main/features/group_chat/plan_executor.ts` | `src/main/features/group_chat/plan_executor.ts`, `src/main/features/collaboration_control/lifecycle.ts`, `src/main/features/collaboration_control/dependency-reconciler.ts` | `adapter_ready` | A, C, E |
| Core Agent tool catalog parity | `src/main/model/core-agent/tool-catalog.ts`, `src/main/model/core-agent/runner.ts`, `src/main/model/core-agent/file-tools.ts`, `src/main/model/core-agent/connector-meta-tools.ts`, `src/main/model/core-agent/kb-tools.ts`, `src/main/model/core-agent/office-tools.ts`, `src/main/model/core-agent/browser-automation-guard.ts` | `src/main/features/cogseed_runtime/kernel/tools/catalog.ts`, `src/main/features/cogseed_runtime/kernel/tools/runner.ts`, `src/main/features/cogseed_runtime/kernel/tools/host-tools.ts`, `src/main/features/cogseed_backend/host-tool-router.ts` | `adapter_ready` | D |
| Connector / KB / Office / Browser capability parity | `src/main/model/core-agent/connector-meta-tools.ts`, `src/main/model/core-agent/kb-tools.ts`, `src/main/model/core-agent/office-tools.ts`, `src/main/model/core-agent/browser-automation-guard.ts` | `src/main/features/cogseed_backend/connector-manager.ts`, `src/main/features/cogseed_backend/cogseed-kb-store.ts`, `src/main/features/cogseed_backend/office-adapter.ts`, `src/main/features/cogseed_backend/browser-manager.ts` | `adapter_ready` | D, H |
| Historical session migration | `src/main/features/group_chat/state.ts`, `src/main/features/group_chat/router.ts`, `src/main/features/group_chat/collaboration.ts`, session-related IPC | `src/main/features/cogseed_backend/session-store.ts`, `src/main/features/cogseed_backend/recovery.ts`, `src/main/features/cogseed_runtime/store.ts` | `contract_only` | F |
| Renderer / IPC parity | `src/main/ipc/index.ts`, `src/renderer/index.html`, `src/renderer/locales/*.json`, collaboration panels | `src/main/ipc/index.ts`, renderer tests under `test/renderer/*`, backend IPC tests under `test/main/ipc/*` | `contract_only` | G, H |
| Recovery / observability / cancellation | `src/main/features/group_chat/bus.ts`, `src/main/features/group_chat/collaboration.ts`, `src/main/features/group_chat/plan_executor.ts`, selected `p3394` wake/recovery paths | `src/main/features/cogseed_backend/recovery.ts`, `src/main/features/cogseed_backend/lifecycle.ts`, `src/main/features/cogseed_backend/runtime-controller.ts`, `src/main/features/cogseed_backend/event-store.ts` | `adapter_ready` | A, C, E |
| Wake / admission / coordination boundaries | `src/main/features/p3394/wake-controller.ts`, `src/main/features/p3394/wake-service.ts`, `src/main/features/p3394/wake-dispatcher.ts` | `src/main/features/cogseed_backend/p3394-admission.ts`, `src/main/features/cogseed_backend/p3394-wake-dispatcher.ts`, `src/main/features/cogseed_backend/coordinator.ts` | `adapter_ready` | A, E, H |

## Golden fixture families

Phase 0 captures synthetic, non-secret fixtures from existing public entry points and stores them immutably. Each fixture family should include:

- a source revision or commit hash;
- the capture command used;
- normalized input payloads;
- deterministic expected outputs;
- canonicalizer rules for ids, timestamps, and non-semantic ordering.

| Family | Purpose | Suggested surfaces | Expected assertions |
|---|---|---|---|
| A. Commander lifecycle | creation, delegation, child completion, abort, retry, skip, resume | collaboration / plan-executor / coordinator surfaces | stable parent/child lineage, terminal states, no duplicate dispatch, abort cascade behavior |
| B. Session and visibility | session kind mapping, visible slice, member scope | `state.ts`, `visibility.ts`, IPC/session routes | no unauthorized actor leakage, correct `gconv`/`gmember` mapping, role-based slice differences |
| C. Bus scheduling | enqueue ordering, quiescence, process lifecycle, retry paths | `group_chat/bus.ts` | deterministic event sequence, dispatch routing, retry/abort semantics, quiescence detection |
| D. Tool execution | file, shell, skill, connector, KB, Office, Browser tool behavior | Core Agent tool catalog and Mate host-tool router | schema validation, bounded results, redaction, tool-specific error paths |
| E. Recovery and restart | restart, resume, reconciliation, orphan handling | runtime controller, recovery, event store, task store | no duplicate execution, persisted state restored, completed work not resent |
| F. Historical migration | legacy session/state projection into the new model | session/state migration surfaces | id mapping preserved, conversion warnings recorded, unsupported records isolated |
| G. Renderer / IPC projection | collaboration panels, agent/session views, wake, recovery | `src/main/ipc/index.ts`, renderer tests | snapshot shape stability, no unauthorized fields, locale-safe output |
| H. Negative security / leakage | forbidden data exposure under every actor role | visibility, bus, IPC, host-tool boundaries | zero raw secrets, zero raw paths, zero unauthorized tool data, zero hidden fallback imports |

## Phase 0 completion gate

Phase 0 is complete only when all of the following are true:

1. Each capability row has a clear status and owner anchor.
2. Each golden fixture family has at least one capture candidate and a deterministic canonicalizer rule.
3. The matrix has been reviewed and approved before any Phase 1 implementation begins.
4. The parity worktree remains clean except for approved parity docs and fixture artifacts.
5. No ordinary parity code path directly imports forbidden CogSeed Group Chat/Core Agent business modules.

## Next action after approval

After this matrix is approved, Phase 1 can begin with:

- Mate Commander
- Mate session / actor model
- `gconv` / `gmember` compatibility facade

