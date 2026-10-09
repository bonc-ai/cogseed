# Data Model: Reconcile Task Status

No persisted schema changes are required.

## Conversation Runtime Snapshot

Existing read-only state returned for the current user and conversation:

- `processing: boolean` — main-process aggregate says the conversation is active.
- `processing_since: string | null` — timing/display anchor; not a terminal-state authority.
- `in_flight: string[]` — actors currently recorded as in flight.
- `active_turns: Array<{ actor, turn_id, ... }>` — authoritative active turn records.
- `backend_active: boolean` — an execution continues outside the group-chat bus.

### Derived State

`authoritativelyActive` is true when any of the following are true:

1. `processing === true`
2. `backend_active === true`
3. `in_flight` contains at least one actor
4. `active_turns` contains at least one turn

Elapsed time does not change this derived state.

## Renderer Pending State

Existing transient map entry keyed by conversation ID:

- `loadingEl` — current running placeholder.
- `needsIndicator` — whether a placeholder must be mounted.
- `startedAtMs` — display timer anchor.
- `controller` — optional live request controller.
- `aborted` — local user cancellation marker.

The entry may be reconstructed from an authoritative active runtime snapshot. It may be removed only after an authoritative idle/terminal signal, explicit abort, or genuine request failure.

## Historical Retry Intent

Existing request fields:

- `retry_message_id` — stable failed assistant message being retried.
- `retry_request_id` — idempotency key for the retry request.

Historical retry is not an ordinary queued message. If the authoritative runtime is active, the retry intent is rejected locally without entering the FIFO queue.

## State Transitions

```text
local idle + authoritative active
  -> reconstruct renderer pending state

local pending + authoritative active
  -> remain pending regardless of elapsed time

local pending + authoritative idle
  -> reconcile history and clear pending state

retry click + authoritative active
  -> keep/restore pending state; no retry request

retry click + authoritative idle
  -> send one idempotent historical retry request
```
