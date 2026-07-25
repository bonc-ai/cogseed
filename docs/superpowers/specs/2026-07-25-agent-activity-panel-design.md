# Agent Activity Panel Design

## Goal

Add a lightweight `Agent Activity` tab to the existing conversation info drawer so users can see, within the current conversation only, which agents are active, what their latest status is, and a concise history of agent activity.

This feature is explicitly a conversation-scoped activity view. It is not a global monitoring center, a protocol console, or a private-context inspector for external CLI agents. Important protocol/governance signals that directly describe agent status may appear inside expandable technical details, but protocol inspection is not the primary frame of the UI.

It may also surface, for the current conversation only, the dispatch context that Mate Agent deliberately sent to an agent and the observable processing trace that Mate Agent can record. It must not claim to show an external agent's full private reasoning or hidden internal memory.

## Product Position

The current conversation header includes a dedicated agent-status popover triggered by `#chat-agent-status-btn`. That popover is useful for a quick runtime snapshot, but it splits agent activity across two surfaces:

- the popover for current runtime state,
- the conversation info drawer for other conversation details.

This slice consolidates the agent-status experience into the existing conversation info drawer by adding a new `Agent Activity` tab. The header button should become a shortcut to the drawer's `Agent Activity` tab instead of opening a separate popover.

## Scope

In scope for this slice:

- Add a new `Agent Activity` tab inside the existing `Conversation Info` drawer.
- Show current-conversation agent activity only.
- Reuse existing `groupChat.runtimeStatus` and conversation member data for the live/latest state summary.
- Show a compact list of recent agent activity items derived from current-conversation runtime/message data already available to the renderer.
- Allow each activity item to expand for a two-layer detail model:
  - a default human-readable activity summary,
  - a small technical detail section with the most important protocol-related fields.
- Show a compact dispatch-context section for the selected/current activity item when that context can be derived from current-conversation data.
- Show a compact observable processing-trace section for the selected/current activity item when trace signals are available.
- Support loading, empty, and error states.
- Keep the visual structure compact and aligned with the current drawer design.

Out of scope for this slice:

- Cross-conversation or global activity history.
- P3394 protocol inspection as a first-class separate surface.
- External CLI private-memory or private-session inspection.
- Reading `~/.codex`, `~/.claude`, `~/.hermes`, or similar private directories.
- Full prompt inspection.
- Full internal reasoning or chain-of-thought display.
- Replaying agent calls.
- Editing activity records.
- Real-time stream-console behavior.

## User Outcome

When a user opens a conversation and switches to `Agent Activity`, they should be able to answer these questions quickly:

- Which agents are participating in this conversation?
- Which agents are running now, recently active, or just joined?
- Which agent most recently handled work?
- Whether the conversation is currently processing agent work.

The user should not need to understand protocol terminology to use this page.

At the same time, the page should preserve enough technical detail for troubleshooting without forcing every user to read protocol fields by default.

The page should also help the user understand, at a high level, what Mate Agent sent to the agent and how the agent's work progressed in observable system terms.

## UX Structure

The conversation info drawer gains a fourth tab:

```text
Tasks | Files | Attachments | Agent Activity
```

Inside the `Agent Activity` tab, the layout is a compact two-column composition within the drawer width:

1. A narrow summary rail on the left.
2. A primary activity list on the right.

The left rail highlights a small set of counts and current conversation state. The right list is the main scanning surface.

The page uses two information layers:

1. a default simplified layer that any user can understand,
2. a collapsible technical layer for troubleshooting.

Within those layers, the page may also surface two auxiliary sections for the selected/current activity item:

1. `Dispatch Context`: what Mate Agent sent to the agent for this conversation task.
2. `Processing Trace`: what Mate Agent could observe about how the task progressed.

### Left Summary Rail

The summary rail shows only current-conversation state:

- total agents in the conversation,
- currently running agents,
- processing state for the conversation,
- optionally the active recipient or a small "next recipient" label when available.

This rail should be visually distinct but smaller than a dashboard sidebar. It is a support surface, not the main content.

### Right Activity List

Each row represents one agent known to the current conversation, ordered with the most important state first:

1. running agents,
2. active recipient,
3. recently active agents,
4. joined/idle agents.

Each collapsed row shows:

- agent avatar,
- agent display name,
- agent kind (`Commander` or `Agent`),
- concise state pill (`Running`, `Current recipient`, `Joined`),
- a concise secondary line such as current turn id, latest activity note, or "receives next message" when relevant.

Expanded rows should be split into two sections.

### Expanded Human-Readable Detail

The first expanded section stays simple and user-facing. It may show:

- current or latest turn id,
- active-recipient status,
- latest activity note derived from conversation activity,
- whether the agent is currently running or simply present in the conversation.

### Expanded Technical Detail

The second expanded section is optional and clearly secondary. It may show only the most relevant protocol/status fields that help explain the agent state, such as:

- runtime kind,
- relationship,
- speech act,
- session role,
- correlation id,
- message type,
- short error code/detail when a run failed.

This technical detail must remain short. The page is not meant to become a log explorer or protocol console.

### Dispatch Context

When the renderer can derive it from current-conversation data, the panel may show a compact `Dispatch Context` block for the selected/current activity item.

This block should describe only the input package that Mate Agent intentionally handed to the agent, such as:

- task summary,
- dispatch source (`user` or `Commander delegation`),
- conversation scope summary,
- workspace scope summary,
- attachment count,
- runtime kind,
- whether Mate-managed skills were enabled.

This block must describe the dispatched input, not the agent's hidden private memory.

### Processing Trace

When the renderer can derive it from current-conversation runtime/process/message data, the panel may show a compact `Processing Trace` block for the selected/current activity item.

This block should show only observable system progress, such as:

- task received,
- execution started,
- currently running,
- produced a result,
- failed with a short reason.

This block is not a chain-of-thought view. It is a system-observable progress summary.

## Data Sources

This slice should prefer existing data paths instead of inventing a new backend model.

Primary sources:

- `groupChat.runtimeStatus` via the existing `/api/conversations/:cid/runtime` route.
- current conversation members via the existing members route.
- conversation history already loaded or fetchable through the conversation info drawer's current loading flow.

The activity list should be built from a merged snapshot:

- runtime-backed state from `in_flight`, `active_turns`, and `active_recipient`,
- known conversation actors from the members list,
- optional recent message-derived hints from the current conversation history,
- optional status-relevant protocol/process metadata that already exists in current-conversation messages.

The dispatch-context section may be derived from existing current-conversation dispatch inputs where they are already persisted or reconstructible from message/process data.

The processing-trace section may be derived from existing runtime/process/tool/protocol evidence already attached to current-conversation messages.

The renderer may compute a lightweight display model from these sources, but should not require a new persistent storage format for this slice.

If protocol-derived fields are used, the renderer should only surface a minimal subset that directly explains status. It should not attempt to render the entire protocol record model.

If dispatch-context or processing-trace content is missing, the UI should omit or gracefully empty those sections rather than synthesizing speculative content.

## Integration With Existing Agent Status UI

The current header control `#chat-agent-status-btn` should stop opening the detached popover once this feature lands.

Instead, it should:

1. ensure the conversation info drawer is open,
2. switch the drawer to the `Agent Activity` tab,
3. focus the user on the unified activity surface.

This keeps one source of truth for conversation-level agent activity.

The old popover rendering code can be removed if no other surface depends on it, or it can remain temporarily as an internal rendering helper during migration if that reduces implementation risk. The final user-facing behavior should be one surface, not two parallel ones.

## Activity Semantics

For this slice, state labels should stay user-oriented and conservative.

Recommended states:

- `Running`: the actor is present in runtime `in_flight` or `active_turns`.
- `Current recipient`: the actor is the current conversation floor/recipient.
- `Joined`: the actor is part of the conversation but not currently running.
- `Failed`: optional row state when a recent activity item clearly indicates a failed agent run.
- `Completed`: optional row state when a recent activity item clearly indicates successful completion.

Do not infer strong activity claims from plain message text alone. Runtime-backed state remains the primary signal.

If recent message-derived or protocol-derived details are shown, they should be framed as secondary context, not as the source of truth for execution state.

Dispatch-context and processing-trace sections should be framed as explanatory support for the activity state, not as independent primary surfaces.

## Error Handling

The panel must handle these states cleanly:

- No conversation selected.
- Loading activity.
- Runtime status request failed.
- Members request failed.
- Empty activity state when no agents have joined yet.
- Dispatch context unavailable for the selected item.
- Processing trace unavailable for the selected item.

Failure behavior should degrade to the best partial snapshot available. For example, if runtime status loads but members fail, show runtime-only actors. If runtime fails but members load, show joined agents without claiming they are running.

If dispatch context or processing trace cannot be reconstructed, the rest of the activity panel should still render normally.

## Testing

Add or update focused tests for:

- tab rendering and switching behavior in the conversation info drawer,
- opening `Agent Activity` from the header status button,
- rendering runtime-backed running/current-recipient/joined states,
- rendering the simplified first-layer activity rows,
- rendering the collapsible technical-detail layer only when expanded,
- rendering the dispatch-context block when relevant source data exists,
- hiding or emptying the dispatch-context block when source data does not exist,
- rendering the processing-trace block from observable message/process data,
- fallback behavior when only runtime or only members data is available,
- empty and error states,
- ordering rules for activity rows.

Existing agent-status renderer tests in `test/renderer/conversation-agent-status.test.ts` can be reused or adapted so the new surface preserves the current runtime-state semantics while changing the UI container.

## Non-Goals And Traps

- Do not turn this into a protocol debug console.
- Do not surface P3394 as the primary frame for this UX.
- Do not add a new top-level page or sidebar destination.
- Do not expose external-agent private memory or file-system state.
- Do not present hidden reasoning as if it were observable process data.
- Do not create a new backend storage domain just for this panel.
- Do not overload the drawer with dense dashboard widgets.
- Do not default the page into a technical field dump.

## Success Criteria

- A user can open a conversation and find all current-conversation agent activity in one place.
- The separate header popover behavior is replaced by navigation into the drawer tab.
- The activity list reflects runtime-backed state reliably.
- Default expanded content is simple enough for non-technical users.
- Technical status/protocol detail is available on demand without becoming the main presentation layer.
- Dispatch context explains what Mate Agent sent without exposing private external-agent memory.
- Processing trace explains observable progress without pretending to show internal reasoning.
- The page remains compact and understandable inside the existing drawer width.
- The feature stays firmly scoped to the current conversation.
