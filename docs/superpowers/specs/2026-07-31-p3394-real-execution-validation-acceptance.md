# P3394 Real Execution Validation Acceptance

## Scope

This acceptance loop verifies that a Task Agent/Core Agent/OpenClaw/Codex run has an authoritative session, a scoped context-reuse receipt, separate Baseline/Treatment execution records, validator provenance, and a visible KSTAR execution boundary.

## Exact verification commands

Run from `PC`:

```bash
npm run typecheck
npm run test:js -- test/main/features/p3394 test/main/features/evolution test/main/features/local_agents
npm run builtin:manifest:check
npm run smoke:p3394
```

The final gate also runs:

```bash
npm test
npm run typecheck
git diff --check
```

`smoke:p3394` reads the current user under `ORKAS_WORKSPACE_ROOT` (or `ORKAS_P3394_SMOKE_UID`) and exits nonzero with named missing prerequisites. A nonzero result is an explicit environment prerequisite failure, never a successful fake run.

## Real opt-in runs

OpenClaw and Codex tests are intentionally opt-in because they invoke local binaries and may incur model/network cost:

```bash
ORKAS_RUN_REAL_OPENCLAW=1 npm run test:js -- test/main/features/local_agents/openclaw-execution-e2e.test.ts
ORKAS_RUN_REAL_CODEX=1 npm run test:js -- test/main/features/local_agents/codex-execution-e2e.test.ts
```

The deterministic fixture tests are labeled `test-double`; they verify lifecycle, scope, recovery, and permission contracts but do not claim that a real binary executed.

## Boundary labels

- **real** — the actual provider/Engine protocol completed its initialization boundary.
- **degraded** — the real boundary was unavailable; pending evidence or a bounded fallback may exist.
- **test-double** — an injected fixture or fake executor. It cannot approve a production patch.

KSTAR is `real` only after the stdio MCP adapter completes `get_engine_info` and passes the minimum protocol version. Missing Engine output is `degraded`. Validator results use `pass`, `risk`, `blocked`, or `degraded`.

## Storage and inspection

Execution records are under:

```text
<uid>/local/kstar/executions/<executionId>/record.json
<uid>/local/kstar/executions/<executionId>/events.jsonl
<uid>/local/kstar/executions/contrasts/<contrastId>.json
<uid>/local/kstar/executions/validations/<validationId>.json
```

Context-reuse receipts are stored beside their execution record as `context-reuse-receipt.json`. Large output is referenced by a bounded `resultRef`; raw prompts, credentials, OAuth tokens, and arbitrary absolute paths are not part of records or events.

## Reproducing denied and blocked cases

### Denied context

Use `prepareExecutionContext` with a target context different from the prepared receipt, a writable root outside the approved root set, or `permissionMode: workspace-write` against a read-only receipt. The result is `{ ok: false, status: 'blocked', event: { type: 'context-denied', ... } }`, and the receipt remains `prepared`.

### Blocked validator

Run a patch candidate containing a credential path read or direct unsafe script invocation. The final validation is persisted as `blocked`; `applyPatchToSkill` does not write the file. A `test-double` boundary or blocked validation cannot approve a production patch.

## Required acceptance evidence

A passing real smoke run must show:

1. A resolvable non-pending session ID.
2. A valid target context ID.
3. A prepared receipt.
4. A Baseline execution.
5. A Treatment execution.
6. A completed receipt containing both execution IDs.
7. A persisted validator result.
8. A KSTAR boundary result.
9. At least one result or validated artifact reference.

If a local CLI or Engine is unavailable, preserve the named failure and boundary label in the report; do not substitute a test-double result for real evidence.
