# Orkas Tool-Level KSTAR Evidence Design

## Summary

Hermes currently runs KSTAR as an observational `post_tool_call` hook: every tool result becomes a small learning signal before the final agent answer exists. Orkas already has a stronger turn-level P3394 flow with Review Gate and PatchCandidate governance, but it only records coarse agent-run evidence today. This design adds the useful Hermes idea at the Orkas boundary: capture tool-level evidence inside the existing group-chat/model event stream, store it under P3394, and aggregate it into the existing `KStarRun` without widening mutation rights or touching user Hermes directories.

## Scope

In scope:
- Record tool-end events for KSTAR-required Orkas agent turns.
- Compute simple local `r_hat`, `r`, and `delta_r` heuristics from tool name, error status, duration, output preview, and result size.
- Persist the records in P3394 local state as `tool_cycles`.
- Attach matching tool cycles to the finalized `KStarRun.evidence_items`.
- Include a compact tool summary in `actual_action` for engine attribution.

Out of scope:
- No automatic skill, ontology, prompt, or policy edits.
- No reads from or writes to `~/.hermes`.
- No renderer UI changes in this first pass.
- No new npm dependencies.

## Data Flow

1. Commander dispatches an agent turn with `kstar=required`, or the bus guard upgrades it.
2. During the agent turn, `streamChatWithModel` emits existing tool process events.
3. The bus observes `tool` stream `phase=end` events and records a P3394 `KStarToolCycle`.
4. When the agent final message is persisted, `finalizeAgentTurn` adds the tool-cycle evidence for that `conversationId/agentId/turnId` to the run.
5. `runKStarEngineForRun` receives a stronger `actual_action` summary and can route PatchCandidates with better evidence.

## Heuristics

- `r_hat` starts from tool reliability: file/read/search tools are high, shell/bash medium, browser/connector/generic lower.
- `r` is low when `isError` or error-like preview text is present, high for successful file/read/search/tool outputs, and moderate for short generic outputs.
- `delta_r = r - r_hat`.
- Tool result content is clipped; path-like and secret-bearing fields are not expanded beyond existing process event previews.

## Governance

Tool-level evidence is observational only. It may support engine attribution and PatchCandidate creation, but all durable changes still flow through the existing Review Gate and PatchCandidate review center.

## Tests

- Runtime test: recording tool cycles stores bounded scores and finalizing the agent turn attaches `tool_cycle` evidence.
- Bus integration test: a KSTAR-required agent turn with tool start/end events persists tool-cycle evidence and includes it in the KSTAR run.
- Existing KSTAR runtime, engine, bus, and renderer tests remain green.
