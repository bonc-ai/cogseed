# Contract: Task Status Reconciliation

## Runtime Read

The renderer uses the existing current-user endpoint:

```text
GET /api/conversations/{conversationId}/runtime
```

### Active Response Semantics

A successful response is active if any authoritative activity field indicates work:

```json
{
  "processing": true,
  "processing_since": "2026-09-18T00:00:00.000Z",
  "in_flight": ["commander"],
  "active_turns": [],
  "backend_active": false
}
```

The renderer MUST NOT convert this response to completed, failed, interrupted, or idle based on elapsed client time.

### Idle Response Semantics

Only an authoritative idle snapshot permits recovery cleanup:

```json
{
  "processing": false,
  "processing_since": null,
  "in_flight": [],
  "active_turns": [],
  "backend_active": false
}
```

## Retry Preflight

Before sending a failed-message retry, the renderer reads the runtime snapshot.

- If active: no retry request is sent or queued; the running UI is restored and the user is told the original task is still running.
- If idle: the existing retry request is sent with a unique `retry_request_id`.
- If status cannot be read: no terminal state is inferred. Existing request error handling remains responsible for communicating failure.

## Queue Boundary

Requests carrying either of these fields are historical mutation operations and MUST NOT enter the ordinary message FIFO while a conversation is active:

- `retry_message_id`
- `edit_message_id`

Ordinary new user messages retain existing FIFO behavior.

## Compatibility

- No endpoint, payload, persisted record, or task status enum changes.
- Existing backend retry idempotency remains the final concurrency guard.
- Existing localized task content and result data do not cross new boundaries.
