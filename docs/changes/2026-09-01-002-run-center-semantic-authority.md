# 2026-09-01-002-run-center-semantic-authority

- status: completed — every implementation task complete (Phase 1, 2.1, 2.2, 3.1–3.5); Phase 4
  closed with checks 1 / 3 / 4a runtime-verified and checks 2 / 4b / 5 / 6 recorded as
  runtime-unstageable with discriminating static coverage. See **Phase 4 closure** for the
  limitation this status carries.
- date: 2026-09-01 (closed 2026-09-02)
- baseline at start: `origin/develop` @ `220b5fe5`
- plan: [plan](../plans/2026-09-01-002-run-center-semantic-authority-plan.md)

## Product decisions received

Both blockers in plan §11 were decided before implementation began.

- **PD-1 → Option A.** For `failed` + `pending-recovery`: primary action is recovering the
  retained result, secondary is retry; the card must show both facts (run failed · result
  retained); `pending-recovery` must stop sorting at the lowest attention priority. Implemented
  by task **2.2**. PRD 12.1 / 24.2 need the follow-up edit option A implies.
- **PD-2 → Option A.** A degraded registry lists Agents labelled "status unknown", drops the
  local pre-submit gate, and lets the backend answer. Implemented by task **3.3**.

## Goal

Establish the authoritative fields, the classifier and the shared eligibility resolver that the
renderer consumes, so that each Run Center semantic has exactly one owner: Main decides, the
renderer derives presentation from Main's answer and never synthesises a second one.

## Verified starting state

Re-read against the working tree before editing, not taken from the plan:

- `taskSummary()` projected `parentTaskId` (`ipc-service.ts:604`) but not `retryOfTaskId`.
- No failure classification existed anywhere; `safeErrorCode` / `runtimeErrorCode` validate
  format only.
- `dispatchable` was computed by two inline expressions for agent rows
  (`agent-registry-projection.ts:249`, `:299`) and never read `interaction_mode`, which
  `AgentSummary` has carried since `agents.ts:1537`.
- The registry projection had no freshness field.

Baseline measured before editing with the same commands listed under *Verification*:
the backend suite was 51 files / 319; Group Chat + agents was 34 files / 801 with 7 skipped;
the renderer Run Center suite was 29 green and 1 red (the pre-existing R13 trend fixture);
`npm run typecheck` exited 0.

## Files changed

Grouped by task. Full per-file diffs are in the commits; this lists what each file gained and why.

**Phase 1 — authoritative facts (no behaviour change).**

- `cogseed_backend/ipc-service.ts` — exported `classifyCogSeedFailure()` with its code map and
  Group Chat kind map; `CogSeedRendererFailureCategory`; `retryOfTaskId` and `failureCategory`
  added to `CogSeedRendererTaskSummary` and emitted by `taskSummary()`. The kind domain is
  imported type-only rather than copied.
- `cogseed_backend/agent-registry-projection.ts` — `resolveAgentEligibility()` and
  `CogSeedAgentEligibilityReason`; both agent rows consume it; `eligibilityReason` on
  `CogSeedRendererAgentSummary`; `registryFreshness: 'fresh'`.
- `cogseed_backend/types.ts`, `task-store.ts`, `lifecycle.ts`, `group-chat-task-bridge.ts`,
  `group_chat/bus.ts` — `CogSeedTaskFailureKind` aliased from `GroupMessageFailureKind`, the
  `COGSEED_TASK_FAILURE_KINDS` value set, an optional persisted `failureKind`, read validation
  against the taxonomy, lifecycle pairing with `errorCode`, and the single plan-executor call
  site forwarding `result.outcome.failureKind`.
- Tests: `failure-classification.test.ts` (**new**, 8 cases), plus added cases in
  `agent-registry-projection`, `renderer-projection`, `group-chat-task-bridge` and `lifecycle`.

**Phase 2 — behaviour alignment.**

- `cogseed_backend/agent-eligibility.ts` — **new leaf module** owning
  `isCogSeedAgentRuntimeSupported`, the eligibility types, `resolveAgentEligibility()`, the
  `findAgentCliEntry` / `findAgentPeer` lookups and `deriveAgentEligibilityFacts()`. Rationale
  in *Why the resolver moved modules*.
- `cogseed_backend/agent-execution-context.ts` — the admission gate consumes the shared
  derivation and resolver; `CogSeedAgentAdmissionError` carries `reasonCode`;
  `missingAgentReason()` classifies the null-agent path; host discovery is read only for
  non-in-process runtimes.
- `run-center-board.js` / `run-center.js` — `ATTENTION_STATE_PRIORITY` replaced by
  `RUN_STATE_PRIORITY`, plus `EXECUTION_STATE_PRIORITY`; `userStateForTask` rebuilt around a
  `runState()` constructor emitting `execution` / `delivery` / `stateKeys` / `actionCandidates`;
  `recommendedAction()` / `secondaryActions()` intersect candidates with Main's published
  `actions`; dead `needs_review` / `blocked` / `pending` branches removed.
- Tests: `run-center-run-state.test.ts` (**new**, 14 cases), added cases in
  `agent-execution-context` (10) and `p3394-wake-dispatcher` (1).

**Phase 3 — consumer cleanup.**

- `run-center.js` — retry uses `cogseed.task.retry` and selects the task it returns, falling
  back to `retryOfTaskId`; the `updatedAt` / session / conversation heuristic is deleted.
  `errorHelpKey(errorCode)` becomes `failureHelpKey(failureCategory)`; the production-dead
  private `failureCategory()` classifier is deleted. `createFailureMessage()` maps `error.code`
  through `ADMISSION_REASON_KEYS`; both `message.includes(...)` branches are deleted.
  `agentRegistryFreshness()` / `agentEligibilityKnown()` added; `createAgentCandidates()` no
  longer synthesises `dispatchable`; the submit-time local gate is skipped when eligibility is
  unknown.
- `run-center-board.js` — `requiresModelConfiguration()` is a category test over
  `MODEL_CONFIGURATION_CATEGORIES`; the `['model_preflight','provider_error']` allowlist is
  gone. One `baseColumnOf()` alias reader; lifecycle branches read it; `displayColumnForTask` is
  a thin projection of the resolved run state.
- `run-center-overview.js` — every count, group and trend bucket reads the display column; the
  `|| task.column` fallbacks are gone.
- `cogseed_backend/ipc-service.ts` — the board projection publishes `baseColumn` with `column`
  kept as a same-call compatibility alias; `counts` keys off `baseColumn`.
- `cogseed_backend/agent-execution-context.ts` — `CogSeedAgentAdmissionError` sets `code`
  (`E_AGENT_ADMISSION_<REASON>`), plus `cogSeedAgentAdmissionCode()` and two constants.
- `locales/{zh,en}.json` — two added keys: `run_center.user_reason_failed_pending_recovery`
  and `run_center.create_agent_status_unknown`.
- Tests: `run-center-retry-lineage.test.ts` (**new**, 5), `run-center-admission-reason.test.ts`
  (**new**, 19), `run-center-registry-fallback.test.ts` (**new**, 8),
  `run-center-column-semantics.test.ts` (**new**, 10), plus rewrites in
  `run-center-recommended-action`, `run-center-attempts`, `run-center-async-resilience` and
  `run-center.test.ts`.

Runtime rows (`agent-registry-projection.ts:309-344`) were deliberately left untouched, per
plan §9 task 1.4.

## Behaviour delivered

**Management-only Agents are no longer advertised as dispatchable.** The registry projection
never read `interaction_mode`, so the host-owned reimbursement workbench (`c045605cb916`, forced
to `management_only` by `agent-dispatch-policy.ts:86-89`) appeared in Run Center as
`dispatchable: true, health: 'ready'` while the execution admission gate rejected every attempt.
It now reports `dispatchable: false`, `eligibilityReason: 'management_only'`,
`health: 'disabled'`. The gate is unchanged and remains the authority.

**The admission gate now rejects what the registry always knew (task 2.1).** The gate checked
`enabled`, existence and runtime support; it was written around the in-process shape, where
`installed` and `online` are constants. It now consumes the same derivation the projection uses:

- an Agent whose local CLI is not installed is rejected at submit time instead of starting a run
  that fails during execution;
- a gateway-backed Agent whose peer is offline, or whose peer is disabled, is rejected the same
  way;
- a management-only identity is still rejected, now with a machine reason rather than an
  undifferentiated "unavailable".

This applies to all three admission entry points, which share the one resolver:
`interactive-turn.ts:46` (Group Chat follow-up turn), `ipc-service.ts:921` via
`prepareAgentStart` (Run Center **create and reassign**), and `p3394-wake-dispatcher.ts:31`
(remote wake). The wake path is the one most easily missed — a wake for an offline peer now
aborts before any task is created.

**Retry selection stops guessing (task 3.1).** After any non-archive action the renderer used to
diff run keys across the refresh, keep the candidates sharing a session or conversation with the
source, sort by `updatedAt` and select the newest. With two runs landing in one conversation
moments apart that selects whichever happens to be newer — the user presses retry and lands on
an unrelated run, often without noticing because the runs share a title. Ordinary retry now
invokes `cogseed.task.retry`, which runs the same controller call the generic action channel ran
and returns the resulting task, and the renderer selects that task; if the response carries no
usable id it falls back to the authoritative `retryOfTaskId` link. Group Chat retry stays on
`cogseed.task.action` and simply holds its selection: it has no synchronous child identity, and
holding still is correct where guessing was not.

**The renderer stops reading producer error codes (task 3.2).** Behaviour came from two
renderer-side tables: a two-code allowlist deciding "configure model" vs "retry", and a
three-code table choosing help copy. Both are replaced by lookups on Main's `failureCategory`.
`provider_auth` — the confirmed R1 defect — now routes to model setup without the renderer
knowing that code exists, and so do `provider_not_configured`, `provider_permission` and
`provider_balance`, which were never in the old allowlist at all. `errorCode` keeps every
non-behavioural use: the diagnostics panel's raw code list, timeline event grouping (a different
field, `event.errorCode`), and `attemptIsFailed`'s presence check.

**The admission reason travels as a code, not a sentence (task 3.5).** The renderer decided which
localized message to show by matching two English sentences the backend throws. A custom `Error`
field does not cross Electron IPC on its own, so the reason had to be routed somewhere the
transport already carries. It already carries one: `handleInvoke` copies `Error.code` into the
`{ ok: false, error, code }` envelope (`ipc/index.ts:6041-6046`, preferring a non-numeric string
code over the normalized one), and the Run Center's invoke wrapper copies it back onto the
rejection (`run-center.js:423`). So `CogSeedAgentAdmissionError` also sets `code` to
`E_AGENT_ADMISSION_<REASON>`, following the repository's existing `E_*` convention, and the
renderer maps that closed set to copy. No IPC envelope change, no new error framework, and the
reason is not smuggled inside the message. The English messages are unchanged and still surface
as the fallback for anything that is not an admission rejection, and in logs.

**The degraded registry stops inventing eligibility (task 3.3).** When `cogseed.agent.list` fails
the Run Center falls back to `agents.list`, which carries only a name and an enable flag. The
renderer turned that into `dispatchable: enabled !== false` — a weaker rule than either the
registry projection or the admission gate, so an offline or uninstalled Agent looked selectable
and the run failed later. Per PD-2, the fallback list is now *displayable but not authoritative*:
candidates are still shown, each option and a note mark the status as unknown, and the
submit-time local gate is skipped because there is nothing local to check against. Main's
admission gate gives the real answer, and task 3.5's structured reason reports it. When the
registry *is* fresh nothing changes. `agentEligibilityKnown()` is deliberately presentation state
— "do we currently hold Main's answer" — not a second eligibility taxonomy; anything other than
`registryFreshness: 'fresh'`, including a missing registry or an unrecognised value, counts as
unknown.

**One ranking, and PD-1 option A (task 2.2).** Three tables disagreed about the same states: the
attention queue sorted a retained result last (`ATTENTION_STATE_PRIORITY.pending_recovery` = 4),
the card put it first, and the attempt representative ranked failure first. `RUN_STATE_PRIORITY`
is now the only ranking of user-facing states and `EXECUTION_STATE_PRIORITY` the only ranking of
raw statuses. A run that failed *and* retained its result now keeps both facts — `stateKeys`
lists both labels, `execution` and `delivery` carry the two dimensions separately — recovers
first with retry behind it, and sorts above a plain failure rather than last. It gets its own
reason copy because the existing retained-result line asserts the run completed, which would be
false here. Actions remain Main's: the resolver emits ordered `actionCandidates`, and
`recommendedAction()` / `secondaryActions()` intersect them with the published `actions` set, so
a preference Main did not permit is never rendered.

Three resolvers are deliberately kept, because they answer three different questions —
`aggregateMembers` picks the member representing a Run's lifecycle from base columns,
`attemptStateTask` picks the task representing an attempt, `userStateForTask` decides what a card
says. What changed is that none of them keeps a private ordering any more. Run and Attempt
identity are unchanged, both pinned by regression tests.

**Two names for two meanings (task 3.4).** Main's lifecycle bucket is now `baseColumn`, with
`column` retained as an alias produced by the same call, so the two can never disagree. The
renderer resolves that alias in exactly one accessor and reads it only where lifecycle meaning is
intended: archival, run aggregation, and the lifecycle branches of the state resolver. Every
presentation consumer — Board filtering and columns, Queue grouping and sorting, Overview counts,
status counts and trend buckets — reads `displayColumn`. The
`displayColumnForTask(task) || task.column` fallbacks in the Overview are deleted rather than
repointed: a second answer to fall back to is what let the Overview count a run as completed
while the Board filed it under attention. Archival remains domain truth and is decided before any
presentation derivation, so a run that is archived *and* failed *and* holding a retained result
still stays out of the default list.

## Why the resolver moved modules (task 2.1)

`agent-registry-projection.ts` imported `isCogSeedAgentRuntimeSupported` **from**
`agent-execution-context.ts`, so having the gate import the resolver from the projection would
have closed an import cycle. The projection also statically imports `task-store` and reaches the
host discovery facade, none of which belongs on every dispatch path.

The minimal fix is a leaf module both sides import: `agent-eligibility.ts` holds no I/O and its
only import is `import type { AgentRuntime }`, which is erased at compile time. The projection no
longer imports `agent-execution-context` at all, and `agent-execution-context` re-exports
`isCogSeedAgentRuntimeSupported` so its public surface is unchanged.

The source-sensitive part moved too, not just the boolean. `deriveAgentEligibilityFacts()` owns
the per-runtime meaning of `installed` and `online` — constants for in-process, binary detection
for a local CLI, peer reachability for a gateway-backed Agent. Had only `resolveAgentEligibility`
been shared, the gate would have needed its own copy of that derivation, which is the duplication
this task exists to remove. `agent-dispatch-policy.ts` was not touched and keeps its documented
import isolation; it remains the authority for per-user enablement and management-only
identities.

## Persistence decision for `failureKind`

`FAILURE_KIND_PERSISTED: YES`, decided from the chain rather than from the plan's mention of
`types.ts`. Three options were traced:

- **Transient only (no persistence)** — a no-op, not a weaker option. All three `finishTask` call
  sites discard the bridge's return value (`bus.ts:1602`, `:3885`, `:3919` are bare `await`
  statements), and every `failureCategory` consumer reaches it through `taskSummary()`, which is
  only ever called from projections built by re-reading the store. A Group Chat failure reaches
  Run Center exclusively via `cogseed.dashboard.watch` → refresh → `cogseed.task.list`. Nothing
  would ever observe a kind that was not persisted.
- **Persist `failureCategory` instead** — rejected on design grounds already settled in plan
  §12/C5: the category is classified at the projection boundary precisely so that a taxonomy
  correction retro-applies to historical records. Persisting it would freeze old records at the
  classification in force when they were written — reproducing the R1 failure mode permanently —
  and would duplicate `classifyCogSeedFailure` into the write path.
- **Persist `failureKind`** — the only option that works. The field is necessary, not convenient:
  it is a domain fact about why the run failed, the same class of fact as the `errorCode` sitting
  beside it, and the projection is always rebuilt from persistence.

Consequences, all implemented:

- **Schema compatibility**: additive optional field, schema version stays `1`. `validateTask` is
  a validating pass-through, so the field round-trips without a serializer change.
- **Migration**: none. A record without the field is valid and classifies from `errorCode` alone.
- **Old record behaviour**: unchanged — verified by a test that strips the field from a written
  record and re-reads it.
- **Read validation**: a value outside the six-member taxonomy throws `malformed CogSeed task`,
  matching how `resultDeliveryState`, `groupChatActorKind` and `skillVersionPinStatus` are
  already guarded. Without it the field would be the only unvalidated enum reaching a classifier.
- **Restart semantics**: the kind is written by the same transition that writes `errorCode` and
  survives a re-read, so classification is stable across refresh and restart.
- **Lifecycle pairing**: `transitionCogSeedTask` deletes `failureKind` on every transition and
  re-sets it only for `failed` / `recoverable`, exactly as it treats `errorCode`. A kind left
  behind would pair with a later code and classify by the wrong reason.
- **Privacy**: the kind is an input to classification, not a projected field. `taskSummary()`
  emits only `failureCategory`; a test asserts `failureKind` never appears in the board
  projection.

## Deviations from the plan, and why

Two, both recorded rather than silently taken.

1. **Field name `eligibilityReason`, not `eligibility.reasonCode`.** Plan §8 names the field
   `eligibility.reasonCode`, implying a nested object. `dispatchable` must stay flat for
   backwards compatibility (the renderer and six existing tests read `item.dispatchable`), and a
   nested object holding a single sibling key would reintroduce exactly the
   two-shapes-for-one-concept problem the task exists to remove. The field is flat and additive;
   nothing consumed the plan's name yet.
2. **`health` also reflects `management_only`.** Plan §9 task 1.4 names `dispatchable` as the
   single intended behaviour change and does not mention `health`. Shipping `dispatchable: false`
   with `health: 'ready'` would have left the projection internally inconsistent and
   user-visible: `run-center-agents.js:59,62` filters on `dispatchable` while the badge renders
   `health`, so the workbench would have appeared under "offline" wearing a "ready" badge.
   `health` is derived from the same eligibility answer, so the existing branch order is
   preserved exactly for every other case.

Neither item is a conflict between the plan and the code, and neither required a new product or
architecture decision.

## Not done in this round

- No `failureKind` was synthesised for the two call sites that have none. `bus.ts:1602`
  (`group_chat_run_failed`) and `bus.ts:3919` (`group_chat_turn_failed` /
  `group_chat_turn_cancelled`) construct their codes locally and were left alone. The `early`
  turn result carries `failureCode` but no kind — the compiler rejected the first attempt to read
  one — confirming that only the plan-executor `persist` outcome has a trustworthy kind. That
  branch classifies from its code alone.
- Two deliberate follow-ups, neither blocking: removing the `column` alias one release from now,
  and optional `eligibilityReason` filtering on the Agents page.

## Verification

Every command below is reproducible from this repository.

| check | command | result |
| --- | --- | --- |
| types | `npm run typecheck` | `passed` — exit 0 |
| backend | `npm run test:js -- test/main/features/cogseed_backend/` | `passed` — 52 files, 352 (baseline 51 files, 319) |
| Group Chat + agents | `npm run test:js -- test/main/features/group_chat/ test/main/features/agents.test.ts` | `passed` — 34 files, 801 passed / 7 skipped (unchanged) |
| Run Center renderer suites | `npm run test:js -- test/renderer/run-center-run-state.test.ts test/renderer/run-center-retry-lineage.test.ts test/renderer/run-center-registry-fallback.test.ts test/renderer/run-center-attempts.test.ts test/renderer/run-center-column-semantics.test.ts test/renderer/run-center-admission-reason.test.ts test/renderer/run-center-async-resilience.test.ts` | `passed` — 7 files, 68 |
| main Run Center suite | `npm run test:js -- test/renderer/run-center.test.ts` | `failed` — 12 passed / 1 failed; the single failure is the pre-existing calendar-drifting overview-trend fixture, unrelated to this work and unchanged by it |
| full JS suite | `npm run test:js` | `failed` — **10040 passed / 33 failed / 97 skipped across 13 failing files**. Baseline at `220b5fe5` was 33 failed over the same file set; failure count and failing-file set are identical |
| Python resources | `npm run test:resources` | `passed` — 308 passed. Run because tasks 3.3 and 2.2 each added a `zh`/`en` locale key |

**Full-suite figure.** The 10040 pass count is the repository-reproducible one. A development
workspace that also carries untracked local test files will observe a higher count; the failure
count and the failing-file set are unaffected either way, so every A/B comparison against
`220b5fe5` holds under both.

**Each new regression test was verified to be discriminating**, by temporarily restoring the code
it replaces and confirming it fails:

- `run-center-retry-lineage.test.ts` — with the pre-3.1 heuristic restored, 4 of 5 fail,
  including the race case, which selects the decoy run.
- `run-center-admission-reason.test.ts` — with the deleted string matcher restored, 5 fail,
  including the contradictory-message case.
- `run-center-registry-fallback.test.ts` — with the `enabled !== false` synthesis restored, 4
  fail, including "does not upgrade an offline Agent".
- `run-center-run-state.test.ts` — with the pre-2.2 ordering and single-fact combined state
  restored, 5 fail, including all three PD-1 cases.
- `run-center-column-semantics.test.ts` — with the Overview's `|| task.column` fallbacks
  restored, only the structural invariant fails; the behavioural cases pass either way, because
  the alias and the field always hold the same value. The removed fallback was a latent second
  path, not an active divergence.

Every restored file was put back before the sweep.

**Flaky files observed, not regressions.** `boot-recovery.test.ts` failed once on a recovery
count and passed in isolation and on both following full runs; `search/indexer.test.ts` appeared
once as a 14th failing file and is green in isolation at 23/23, importing only node builtins and
vitest. The five less obvious files in the failing set were inspected individually and are
unrelated: `kb-notes`, `top-drag-regions`, `auto_tasks`, `contexts-folder-import`,
`personal_context-forget`. The rest are the recorded PDF-stack, skill-trust and upstream
`220b5fe5` failures.

## Compatibility

- **IPC**: schema stays v1. Additive optional/constant fields on two existing projections. No
  channel added, removed or renamed.
- **Preload**: unchanged — `src/main/preload.js:47` forwards `{ channel, payload }` generically.
- **Renderer typings**: none exist; the renderer is classic JS.
- **Persisted records**: `retryOfTaskId` and `parentTaskId` already existed on
  `CogSeedTaskRecord`. `failureKind` is additive and optional. No schema change, no migration, no
  back-fill.
- **Old task records**: historical `errorCode` values run through the same map; unmapped codes
  become `unknown`, which keeps today's retry default. Tasks with no `errorCode` get no
  `failureCategory` key at all.
- **Strict projection assertions**: the five `toEqual({...})` sites named in plan §12
  (`renderer-projection.test.ts:115,504,543,556`, `ipc-service.test.ts:500`) pass. The privacy
  assertions in `agent-registry-projection.test.ts` (serialized projection must not contain
  `path` / `auth` / `endpoint`) also still pass with the new fields.
- **Localization**: task 3.2 maps the four existing `run_center.error_help_*` keys onto
  categories instead of adding new ones — reuse was preferred, and every code that previously
  reached a given key still reaches it. Tasks 2.2 and 3.3 add one `zh`/`en` key each. Task 3.5
  adds none: it reuses `run_center.selected_agent_unavailable` and
  `run_center.selected_agent_runtime_unavailable`, so the copy a user sees is unchanged — it is a
  protocol change, not a copy change. Per-reason wording (for example distinguishing "offline"
  from "not installed") would need new keys and is left as a product decision.
  **`ja` and `pt` contain zero `run_center.*` keys** (475 in each of `zh` and `en`): the Run
  Center namespace is absent from them repo-wide and predates this work, which corrects plan
  §12's note that they "need a manual pass".
- **Privacy**: `retryOfTaskId` passes `rendererSafeIdentifier` like `parentTaskId`;
  `failureCategory`, `eligibilityReason` and `registryFreshness` are closed enums carrying no
  path or identifier.

## Phase 4 — runtime verification

Six checks were specified in plan §9 task 4.2. Three were verified against a real build in a
clean, separately-provisioned profile; three, plus one half of a fourth, proved structurally
unreachable at runtime in this build. Nothing was reclassified as an implementation defect.

### Runtime-verified

| check | evidence |
| --- | --- |
| **1** — invalid credentials recommend model setup, not retry | A real run failed with `errorCode: provider_auth`; Main classified `failureCategory: model_unavailable`; the card's primary action was 配置模型. `provider_auth` was **absent from the pre-3.2 allowlist**, so the old renderer would have recommended retry for this exact task — the discriminating evidence for the R1 defect. `failureCategory` appears only in `taskSummary()` output and never in the persisted record, confirming it comes from Main. |
| **3** — an offline Agent is refused by the gate with a localised reason | With the gateway stopped and the peer past its online window, a submission produced `invoke cogseed.task.start failed { error: 'CogSeed Agent is unavailable', code: 'E_AGENT_ADMISSION_OFFLINE' }`. Attribution does not rest on the screen: the renderer's local guard returns *before* the `try` block and emits no IPC at all, so the presence of a `cogseed.task.start` entry proves the rejection came from Main and not from the renderer. No task record was written. |
| **4a** — retry lineage and selection | A real retry produced a child whose `retryOfTaskId` points at the source, which inherits the source's `sessionId` and carries a distinct `executionId`; the store held exactly one lineage edge and no competing claimant. `parentTaskId` is absent on the child, so the board projection assigns no shared `groupId` and the pair is two Runs rather than two attempts. The child's `requestId` carries the `req-run-center-` shape the renderer mints, proving the task-3.1 channel. The UI selection followed the authoritative link to the child. |

The screen copy alone could not attribute check 3: `E_AGENT_ADMISSION_OFFLINE` and the renderer's
local guard map to the same locale key. Whether the IPC was emitted is the discriminator, and the
same discriminator is asserted statically in `run-center-registry-fallback.test.ts` via
`startedAgentIds`.

### Runtime-unstageable, with discriminating static coverage

| check | why unreachable | static evidence |
| --- | --- | --- |
| **2** — `failed` + `pending-recovery` | The state is a sub-second intermediate: `finalizeCogSeedTaskFromRetainedResult` writes it, and a successful delivery projection immediately rewrites it to `delivered`. A crash does not bypass that — boot recovery re-projects with a 5s budget and self-heals. It persists only if the projection fails *after* finalize, for which no sanctioned trigger exists. A probe refuted the one remaining hypothesis: a Run Center task creates a real conversation with group-chat members, so `conversationExists` holds and the projection succeeds. | `run-center-run-state.test.ts` — both facts kept with their own reason copy; candidate order `['recover-result','retry']`; sort above a plain failure but below `waiting_user`; three cases pinning that the renderer never invents an action Main did not permit. |
| **4b** — the decoy race on retry selection | Every route to a second same-refresh Run is closed: two creates get separate conversations *and* sessions; a follow-up turn carries `parentTaskId` and collapses into one Run; reassign consumes the source's replacement slot, so a later retry throws. | `run-center-retry-lineage.test.ts`, whose race case fails against the restored pre-3.1 heuristic. |
| **5** — degraded registry | Main is typed to emit `'fresh'` only, so "degraded" is the renderer's own statement that it holds no answer. Of the projection's seven dependencies only `listCogSeedTasks` can throw, and it is shared with the board projection, whose failure renders a load error instead. A non-first failure is additionally masked as `fresh` by the retained snapshot. | `run-center-registry-fallback.test.ts` — fallback candidates marked unknown, not dispatchable; an Agent the fresh registry called offline is not upgraded; an unknown candidate reaches Main and is refused (`startedAgentIds == [AGENT_ID]`); the local gate still blocks when fresh (`startedAgentIds == []`). |
| **6** — a stale response must not cross-apply | The repository has no delay or fault injection surface; `COGSEED_RUNTIME_SLOW_THRESHOLD_MS` is a watchdog classification threshold, not a delay. UI automation can click faster but cannot make request A resolve after request B. | `run-center.test.ts` holds a `session.read` while a second selection completes, then releases it late (and separately, rejects it late); `run-center-attempts.test.ts` resolves a deferred stale attempt read with a payload that must never enter the DOM. All force ordering with a controlled deferred rather than timing luck. |

### Repository-level findings worth keeping

Established while investigating the checks above; each is a property of this repository, not of
one investigation:

- **`failed` + `pending-recovery` is a transient state on the normal path**, not a stable one.
  Anything reasoning about it must account for the immediate `delivered` rewrite.
- **`registryFreshness` is Main-authoritative but single-valued.** Main can only say `fresh`;
  `unknown` is a renderer-side statement about its own knowledge. Widening the Main-side type
  would let a consumer believe Main can report staleness it cannot observe.
- **P3394 peer semantics**: `online` means `last_seen_at` within a **90 second** window; the
  heartbeat interval is 30s; an offline peer is **auto-revoked after 30 minutes**, which also
  removes its team projection. Any test fixture built on a peer expires on that schedule.
- **Managed gateways run under a crash watchdog** that respawns them ~5s after an unexpected
  exit (up to 3 consecutive failures). Killing a gateway process therefore does *not* take it
  offline; the sanctioned stop is `p3394.external.stop`, which detaches the watch before
  SIGTERM.
- **Native modules are built for the Electron ABI only.** Loading them from system Node fails by
  design, not by corruption. Note that `require('better-sqlite3')` succeeds and binds its addon
  lazily, which makes a naive load check look like a pass.
- **`HOME=<temp> ./run.sh` isolates data but not the worktree.** `run.sh` invokes
  `scripts/ensure-deps.cjs`, which runs a **shared** `npm install` when the dependency stamp does
  not match `package.json` / the lockfile. Any isolated launch must pass a fingerprint preflight
  first, or it will mutate the shared `node_modules`.
- **The repository has no fault, delay or race injection surface** — no environment switch, no
  debug channel, no test-only hook. This is the single reason four acceptance checks cannot be
  staged.

### Shared testability gap

`SHARED_TESTABILITY_GAP=YES`. The four unstageable checks are one gap seen from four angles, not
four problems: check 2 needs a projection failure/delay after finalize, check 4b needs
deterministic race ordering, check 5 needs a registry read failure isolated to
`cogseed.agent.list` on a cold first load, and check 6 needs per-request delay.

Minimal design direction for a **separate future task** — not implemented, not designed in detail
here: request-keyed and one-shot (matching a channel plus a request predicate, expiring after one
hit, which is what makes ordering deterministic rather than probable); scoped to a named channel
rather than a global slowdown (check 5 specifically needs one channel to fail while another
succeeds); covering both delay and failure through one entry point; able to express "B completes
before A" rather than only "A is N ms slower"; and dev/test-only, off by default behind a
build-time plus explicit switch, unreachable from the production path. Per `AGENTS.md` this is an
infrastructure change that needs discussion first, so it belongs in its own spec.

## Risks and recovery entry point

- The management-only change is user-visible. If an install turns out to depend on dispatching a
  management identity from Run Center, the single revert point is the `managementOnly` argument
  at `agent-registry-projection.ts` in the definitions row.
- Task 2.1 is the one change here that can refuse work the system previously accepted. The
  refusal is correct — those runs failed during execution instead — but it is the change to
  watch after release. `detectAll()` is cached for 5 minutes (`local_agents/registry.ts:352`) and
  is only consulted for non-in-process runtimes, so the gate adds no probing to the common path.
- After a Group Chat retry the Run Center no longer moves the selection at all. This is
  deliberate — there is no link to follow — but it is a visible change from the old behaviour of
  jumping to whichever run looked newest.
- `failureKind` is written only by the Group Chat plan-executor path. Native Runtime failures
  still classify from `errorCode` alone, which the §7 taxonomy covers; adding kinds to those
  producers was not part of this plan.
- Task 2.2 keeps `userState.kind` as the machine label driving CSS, grouping and priority, while
  `stateKeys` carries the human labels. For the combined state those differ — kind is
  `pending_recovery` while the first label is the failure — which is intentional: styling and
  ranking follow the recovery decision, the copy shows both facts.
- Task 3.4 keeps `board.counts` in the projection although no renderer reads it. Whether a dead
  projection field should be removed is an IPC compatibility decision of its own, so it is left
  in place and now keyed off `baseColumn`: **unused but intentionally preserved.** The attention
  count in `diagnostics` is likewise untouched — it is computed from `status` for the diagnostics
  panel and never reaches the board, queue or overview, so it is not a presentation consumer of
  the column contract. If it ever starts driving user-visible Run Center state it would need to
  join the shared derivation.
- Task 3.3 leaves the Agents page (`run-center-agents.js`) alone. Its filters and health badge
  already read Main-projected `dispatchable`, `health` and `installed` — presentation derivation
  over authoritative inputs, not synthesis. Switching them to `eligibilityReason` would buy finer
  filter groups, not correctness. `run-center-overview.js:78` likewise filters a *roster* for its
  agent-name map and load count; it gates nothing a user can submit.
- Task 3.5 keeps the two English admission sentences in Main as human-readable text; nothing
  reads them for meaning any more, so they can be reworded freely. The renderer shows a raw
  backend message only for failures that are *not* admission rejections, which is deliberate:
  those have no structured reason and the text is the most specific thing available.
- Task 3.2 changes behaviour only where the classification differs from the old two-code
  allowlist. A projection with no `failureCategory` falls to "retry" plus generic help, matching
  plan §12's rule that an absent category is treated as `unknown`; no legacy error-code table is
  retained.

Recovery entry point: plan §9. Every implementation task is complete — Phase 1 (1.1–1.5), 2.1,
2.2, 3.1, 3.2, 3.3, 3.4 and 3.5.

## Phase 4 closure

**Closing does not mean six runtime passes.** It means every runtime-constructible critical path
was verified against the real build, every unconstructible one carries a discriminating
regression test, and no implementation defect remains open.

- **A. Runtime-verified:** checks 1, 3, 4a.
- **B. Statically verified, runtime-unstageable:** checks 2, 4b, 5, 6 — each with a
  *discriminating* regression test, not merely "some coverage".
- **C. Open implementation bugs:** `OPEN_IMPLEMENTATION_BUGS=0`. Every unstageable check resolved
  to a runtime-stageability gap; none was reclassified as a code defect.
- **D. Shared testability infrastructure gap:** one, described above, tracked as a separate
  non-blocking follow-up rather than as unfinished work in this task.
