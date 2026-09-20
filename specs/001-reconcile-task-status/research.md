# Research: Reconcile Task Status

## Finding 1: The renderer creates terminal UI state from elapsed time

**Evidence**: `src/renderer/modules/state.js` polls conversation history every three seconds. When the latest visible message is from the user and the server still reports `processing: true`, the renderer nevertheless calls `_onPolledResponse(..., chat.reply_timeout, true)` after 2,100 seconds. That call deletes the local pending entry and clears the busy marker.

**Decision**: Remove elapsed-time terminalization. If the server reports processing, polling continues and the task remains non-terminal. Runtime orphan/stale handling belongs to the main-process runtime and watchdog layers.

**Alternatives rejected**:

- Increase the timeout: still creates the same correctness bug for longer jobs.
- Mark the task failed after the timeout: still contradicts the authoritative runtime state.
- Cancel the backend job when the client timer expires: changes product semantics and can destroy valid long-running work.

## Finding 2: Reopening a conversation discards active status after 15 minutes

**Evidence**: `src/renderer/modules/conversation.js` computes `processingFresh` from `processing === true` and a 15-minute age check on `processing_since`. A task can remain active while this timestamp is old or temporarily not refreshed, causing the renderer not to restore pending UI after reload or navigation.

**Decision**: Replace client freshness inference with a shared predicate over authoritative fields: `processing`, `backend_active`, `in_flight`, and `active_turns`. Use `processing_since` only as a display/timing anchor, never as permission to invent a terminal state.

**Alternatives rejected**:

- Depend only on `processing`: backend-native execution may be represented by `backend_active` or active turn collections.
- Depend only on active actor arrays: queued or transition states can be processing before an actor appears.

## Finding 3: Historical retry can race active execution

**Evidence**: `_retryFailedAssistantMessage` sends a retry directly. `sendInConversation` queues sends while a conversation is pending and only protects `edit_message_id`; `retry_message_id` can enter the ordinary FIFO path even though it rewrites/replays historical execution. A stale local pending state can also send retry while the backend remains active.

**Decision**: Before retry, query the existing conversation runtime snapshot. If active, restore the running UI and show an explicit non-terminal message instead of sending. As defense in depth, treat both retry and edit requests as non-queueable historical operations inside `sendInConversation`.

**Alternatives rejected**:

- Let the backend error surface unchanged: leaves the UI stale and presents an implementation conflict instead of the real state.
- Queue retry behind current work: can replay obsolete history after the active turn finishes and violates user intent.

## Finding 4: No backend or storage change is necessary

**Evidence**: `/api/conversations/:cid/runtime` already reports `processing`, `processing_since`, `in_flight`, `active_turns`, and `backend_active`. Existing task/run-center code already treats backend task records as authoritative and has watchdog recovery.

**Decision**: Keep persistence and backend lifecycle unchanged. Implement a renderer reconciliation fix with regression tests.

## Resolved Unknowns

- **Authoritative source**: Main-process conversation runtime snapshot.
- **Long-running behavior**: Remain running while the authoritative snapshot remains active, regardless of elapsed client time.
- **Retry conflict behavior**: Do not send or queue retry; reconcile UI and explain that the original task is still running.
- **Network failure during preflight**: Do not infer completion; preserve current UI and let the existing send path/error handling continue only when no authoritative active result was obtained.
