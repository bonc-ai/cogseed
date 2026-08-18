# KSTAR Runtime Closure Design for Mate Agent

Date: 2026-08-05
Status: approved direction; design draft for review

## Summary

Mate Agent should reproduce the KSTAR operating logic as a runtime learning closure rather than as a separate standalone agent. The first version focuses on **post-task review plus candidate asset promotion**: after a Mate Agent task completes, the app records a structured KSTAR episode, reviews the gap between expected and observed results, extracts candidate knowledge/assets, and lets the user confirm what should enter the formal Recall/AbilityAsset system.

This creates the minimal closed loop:

```text
Task execution
  -> K/S/T/A/R episode
  -> Delta review
  -> Recall candidate
  -> user confirmation
  -> AbilityAsset
  -> later reuse and proof in future phases
```

The design intentionally reuses existing Mate Agent foundations:

- `src/main/features/cogseed_runtime/` for runtime execution events, tool activity, context, memory, and final results.
- `src/main/features/group_chat/` for conversation/group-agent orchestration.
- `src/main/features/recall/` for candidates, ability assets, projections, usage, proofs, and cognition tree records.
- Archived line `src/main/features/evolution/` and `packages/meta-skill-engine/` is preserved on `dev/archive-meta-skill-evolution-console`; active worktree uses lightweight skills version/rollback services only.

## Goals

1. Persist a KSTAR episode for completed Mate Agent tasks.
2. Normalize each episode into K, S, T, A, R fields:
   - K: knowledge/assets/context used.
   - S: situation and conversation/workspace summary.
   - T: task intent and constraints.
   - A: plan, agent actions, and tool calls.
   - R: final result, produced artifacts, verification, and feedback.
3. Produce a review signal (`deltaR`, `deltaA`, and rationale) suitable for learning and governance.
4. Extract Recall candidates from high-value episodes.
5. Require user confirmation before anything becomes a formal AbilityAsset.
6. Preserve evidence links so later reuse, evolution, and rollback remain auditable.

## Non-goals for the first version

1. No fully automatic skill mutation.
2. No automatic background asset promotion without user confirmation.
3. No new HTTP server, local auth layer, or renderer-side business workflow.
4. No bypass of existing Runtime worker/tool choke points.
5. No replacement of existing Memory, Contexts, Recall, Evolution, or Group Chat systems.
6. No multi-agent KSTAR collaboration UI in the first increment.

## Chosen approach

The chosen approach is **Phase 1: KSTAR episode capture plus candidate入库 workflow**.

This wins over a full four-ring implementation because it is smaller, safer, and compatible with current project boundaries. It creates the essential KSTAR fuel — evidence-backed episodes and review signals — before adding more automated reuse or evolution. It also prevents the system from becoming an uncontrolled memory sink by keeping user confirmation in the loop.

## Concept mapping

| KSTAR concept | Mate Agent implementation surface |
| --- | --- |
| PEV tool loop | Runtime tool execution plus verify/commit/rollback metadata where available |
| KSTAR 8-step demand loop | `KstarEpisode` assembled from runtime/group-chat task facts |
| AAR / delta review | `KstarReview` with `deltaR`, `deltaA`, reason, confidence, and source refs |
| Hoop learning loop | Candidate extraction into Recall candidate records |
| Ability asset library | Existing Recall AbilityAsset store |
| Reuse loop | Future integration with ContextProjection and TransferProof |
| Evolution branch | Future integration with existing EvolutionOrchestrator |
| Collaborative KSTAR | Future mapping onto Group Chat actors |

## Proposed module boundaries

Add a small KSTAR orchestration feature rather than spreading logic through IPC or renderer code:

```text
src/main/features/kstar/
  index.ts
  types.ts
  paths.ts
  episode-store.ts
  episode-builder.ts
  review-service.ts
  extraction-service.ts
  recall-bridge.ts
```

Responsibilities:

- `types.ts`: stable DTOs and record interfaces.
- `paths.ts`: storage path helpers under the active user's cloud domain.
- `episode-store.ts`: append/read/update KSTAR records.
- `episode-builder.ts`: converts runtime/group-chat completion facts into a `KstarEpisode`.
- `review-service.ts`: computes or records `deltaR`/`deltaA` review signals.
- `extraction-service.ts`: proposes candidate assets from reviewed episodes.
- `recall-bridge.ts`: maps KSTAR candidates into existing Recall candidate APIs.

The feature layer owns business behavior. IPC should only validate input and call these functions if/when UI actions are added.

## Storage design

All user-scoped KSTAR records should live under the user's cloud state, for example:

```text
<uid>/cloud/kstar/
  episodes/<episodeId>.json
  reviews/<episodeId>.json
  extraction-runs/<runId>.json
```

The exact path helper must derive from existing user root/path utilities at use time. It must not cache uid-derived paths as module-level constants.

The first version should avoid duplicating private content. Records should hold excerpts and stable source refs where possible, following the Recall `CognitionSourceRef` pattern.

## Core data structures

### KstarEpisode

```ts
interface KstarEpisodeRecord {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  sessionId: string;
  sessionKind?: string;
  taskRunId?: string;
  requestId?: string;
  runtimeSessionId?: string;

  k: {
    memoryRefs: string[];
    contextRefs: string[];
    abilityAssetRefs: string[];
    promptContextSummary?: string;
  };

  s: {
    conversationSummary?: string;
    workspaceId?: string;
    workingDir?: string;
    modelProfile?: string;
  };

  t: {
    userGoal: string;
    normalizedTask?: string;
    constraints: string[];
  };

  a: {
    plan?: unknown;
    toolCalls: Array<{
      id?: string;
      name: string;
      argumentsSummary?: string;
      status?: 'ok' | 'error' | 'cancelled' | 'unknown';
    }>;
    agentActions: Array<{
      actor?: string;
      action: string;
      summary?: string;
    }>;
  };

  r: {
    finalText?: string;
    producedFiles: string[];
    verification?: unknown;
    userFeedback?: unknown;
    failureKind?: string;
    failureCode?: string;
  };

  evidenceRefs: CognitionSourceRef[];
  createdAt: string;
  updatedAt: string;
}
```

### KstarReview

```ts
interface KstarReviewRecord {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  episodeId: string;
  deltaR: number | 'unknown';
  deltaA: number | 'unknown';
  outcome: 'better_than_expected' | 'met_expected' | 'worse_than_expected' | 'unclear';
  attribution: 'knowledge_gap' | 'rule_gap' | 'template_gap' | 'skill_gap' | 'execution_gap' | 'unclear';
  reason: string;
  confidence: number;
  evidenceRefs: CognitionSourceRef[];
  createdAt: string;
}
```

### KstarExtractionRun

```ts
interface KstarExtractionRunRecord {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  episodeId: string;
  reviewId: string;
  candidateIds: string[];
  status: 'created' | 'partial' | 'failed';
  createdAt: string;
  error?: string;
}
```

## First-version data flow

```text
Runtime/group-chat turn completes
  -> episode-builder assembles KstarEpisode
  -> episode-store persists it
  -> review-service creates KstarReview
  -> extraction-service proposes candidate assets
  -> recall-bridge saves RecallCandidate records
  -> UI shows pending candidates for user confirmation
```

Candidate extraction should be conservative. It should prefer a small number of high-signal candidates over noisy bulk extraction.

## Candidate extraction policy

The first version should extract only when at least one of these is true:

1. The user explicitly says the result is useful or corrects the agent.
2. The task produced a reusable artifact, workflow, or rule.
3. The same pattern appears repeatedly across episodes.
4. The review detects a clear knowledge/rule/template/skill gap.
5. A tool or workflow sequence produced a verifiable successful result.

Candidate asset type mapping:

| Candidate type | Use when |
| --- | --- |
| `personal` | User preference, stable identity/context, decision style |
| `rule` | A general judgment, constraint, or if/then rule |
| `template` | A reusable document/output/prompt/plan shape |
| `skill_method` | A repeatable workflow or tool sequence |

## User confirmation model

The system may create `RecallCandidate` records automatically, but formal asset promotion must stay user-controlled:

```text
pending candidate
  -> edit / confirm / defer / reject
  -> AbilityAsset only after confirmation
```

This prevents bad model inferences from polluting long-term behavior.

## UI surface

The minimal UI should expose a post-task review area, not a complex new dashboard. A task can show:

- What the agent used: K/S/T/A/R summary.
- What changed: delta review and attribution.
- What can be learned: pending candidates.
- User actions: confirm, edit, defer, reject.

A later full dashboard can add cognition-tree visualization, reuse proofs, and evolution history.

## IPC/API shape

IPC handlers, if added, should remain thin and call feature functions. Possible feature-level operations:

```ts
listKstarEpisodes(userId, filters)
readKstarEpisode(userId, episodeId)
readKstarReview(userId, episodeId)
extractRecallCandidatesForEpisode(userId, episodeId)
listPendingKstarCandidates(userId, filters)
```

Renderer access must continue through the `window.cogseed.invoke` allow-list.

## Integration points

### Runtime execution loop

Use runtime events and final result information to capture:

- request/session ids
- task text
- model profile
- working directory summary
- assembled context summary
- tool calls and statuses
- final text
- produced artifacts if available
- errors/cancellation metadata

### Group chat

Use group-chat turn outcomes to capture:

- conversation/session id
- actor metadata
- plan state where available
- final persisted message
- produced files/forms/created agents/created skills where available
- failure metadata

### Recall

Reuse existing Recall APIs for candidate and asset lifecycle rather than adding another asset store.

### Evolution

Do not apply evolution automatically in Phase 1. Only record enough evidence for future evolution triggers.

## Error handling

1. Episode capture failure must not fail the user's task result.
2. Capture failures should log a warning with redacted metadata.
3. Corrupt KSTAR records should be skipped or marked degraded without blocking other records.
4. Candidate extraction failure should leave the episode and review intact.
5. If review cannot confidently classify attribution, use `unclear` rather than hallucinating a cause.

## Privacy and logging

- Use `createLogger('<module>')`; do not use `console.log` for app logging.
- Avoid copying full private files or full conversation transcripts into KSTAR records.
- Prefer source refs, bounded excerpts, counts, ids, and summaries.
- Do not put raw expert-signal excerpts into logs, telemetry, or sync channels.
- Respect existing cloud/local domain rules.

## Testing strategy

Tests should cover business invariants rather than implementation internals:

1. Episode store creates, reads, updates, and isolates by user.
2. Episode builder handles successful, failed, and cancelled runs.
3. Review service returns conservative `unclear` when evidence is insufficient.
4. Extraction service creates bounded candidates with stable source refs.
5. Recall bridge does not promote assets automatically.
6. Corrupt/degraded records do not block healthy records.
7. No path escapes outside the user cloud KSTAR root.

Run tests via the project script:

```bash
npm test
```

For focused JS tests:

```bash
npm run test:js -- <test-file>
```

## Phased roadmap

### Phase 1: Post-task review plus candidate intake

- Add KSTAR feature module and storage.
- Capture KSTAR episode after runtime/group-chat completion.
- Create review records.
- Extract conservative Recall candidates.
- Add minimal list/read surfaces for pending candidates if needed.

### Phase 2: Reuse loop

- Use AbilityAssets in RecallView/ContextProjection before tasks.
- Record TransferProof when an asset is used.
- Record EffectivenessProof after the task.
- Update asset maturity based on evidence.

### Phase 3: Evolution branch

- Trigger EvolutionOrchestrator from high-signal reviews and repeated proof patterns.
- Generate patch candidates for skills/templates.
- Run replay/governance gates.
- Require human approval before applying.
- Preserve version history and rollback.

### Phase 4: Collaborative KSTAR

- Map K_H, K_C, and K_O roles onto Group Chat actors.
- Let the Companion manage KSTAR operation, Oracle verify/reason, and User Proxy preserve user intent.
- Keep all actor dispatch inside existing group-chat bus paths.

## Open risks

1. The exact runtime/group-chat completion hook must be chosen carefully so episode capture is reliable without duplicating messages.
2. Delta scoring can become noisy; Phase 1 should keep scores conservative and explainable.
3. Candidate extraction can overproduce; bounded extraction and user confirmation are mandatory.
4. UI scope can expand quickly; first version should stay focused on pending candidates and task review.
5. Evolution should not be enabled until there is enough episode/proof evidence and review gating.

## Acceptance criteria for Phase 1

1. A completed Mate Agent task can produce a persisted KSTAR episode.
2. The episode contains K/S/T/A/R sections and evidence refs.
3. A review record can be created with delta and attribution fields.
4. Candidate extraction can create Recall candidates from an episode.
5. No candidate becomes an AbilityAsset without explicit user confirmation.
6. Capture/extraction failures do not break normal agent task completion.
7. Tests verify user isolation, degraded data handling, and conservative candidate behavior.

## Next step

After this design is reviewed, create an implementation plan with task-level files, tests, and verification commands.
