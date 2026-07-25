# Orkas Agent Release Preflight Report

**Generated:** 2026-07-26
**Scope:** Read-only release-boundary preflight. No source file was staged, committed, deleted, reset, or cleaned.

## Baseline health

| Check | Result | Evidence |
|---|---|---|
| JavaScript suite | PASS | `npm run test:js`: 379 test files passed; 5075 tests passed; 9 skipped. |
| TypeScript | PASS | `npm run typecheck -- --pretty false` exited 0. |
| Whitespace | PASS | `git diff --check` produced no output. |

## Test inventory

| Test path | Status |
|---|---|
| `test/main/features/group_chat/collaboration.test.ts` | EXISTS |
| `test/main/features/group_chat/bus.test.ts` | EXISTS |
| `test/main/features/group_chat/bus-integration.test.ts` | EXISTS |
| `test/main/features/p3394/protocol.test.ts` | EXISTS |
| `test/main/ipc/p3394-protocol-events.test.ts` | EXISTS |
| `test/renderer/conversation-info.test.ts` | EXISTS |
| `test/renderer/collaboration-overview-drawer.test.ts` | EXISTS |
| `test/renderer/ipc-shim.test.ts` | EXISTS |

## Runtime capability preflight

### Local CLI registry

Product registry probe: `local_agents/registry.ts::detectAll({ force: true })` with the normal data root configured. No Agent run was launched.

| CLI | Available | Version | Notes |
|---|---:|---|---|
| Claude | yes | 2.1.216 | Eligible for a later disposable CLI E2E. |
| Codex | yes | 0.145.0 | Eligible for a later disposable CLI E2E. |
| OpenClaw | no | — | `not_found`; later E2E lane is SKIPPED. |
| OpenCode | yes | 1.15.10 | Eligible for a later disposable CLI E2E. |
| Hermes | yes | 0.18.2 | Eligible only as a specialist CLI Agent, not as Commander. |

### Provider and MCP

| Lane | Status | Reason |
|---|---|---|
| Provider | DEFERRED_NEEDS_APP_SESSION | Safe configured-profile inspection must run through the active Electron app process; an ad-hoc process would need `activateUser()` and can run layout/migration work. |
| MCP | DEFERRED_NEEDS_APP_SESSION | Safe connector inspection requires the active user/app session and must not read encrypted secret fields directly. |

## Hermes compatibility decision

**Approved by user:** migrate legacy `hermes-cli` Commander settings to `orkas-core-agent` in Commit D. Hermes remains available as a specialist local CLI Agent.
