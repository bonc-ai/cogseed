# Quickstart: Verify Task Status Reconciliation

## Targeted Automated Checks

```bash
npm test -- test/renderer/conversation-polling.test.ts
npm test -- test/renderer/conversation-failed-retry.test.ts
npm test -- test/main/features/group_chat/failed-turn-retry.test.ts
```

## Static Validation

```bash
npm run typecheck
npm run lint
```

## Manual Scenario

1. Start CogSeed with `npm start`.
2. Start a conversation task that remains active longer than the previous renderer timeout, or use a controlled development runtime that reports an old `processing_since` while remaining active.
3. Navigate away and reopen the conversation.
4. Confirm the running indicator is restored and remains non-terminal.
5. Click retry on an older failed message while the current task is active.
6. Confirm no retry is queued or created; the UI states that the original task is still running.
7. Let the backend report idle or a real terminal result.
8. Confirm the UI then reconciles to the persisted result and retry becomes available only when valid.

## Expected Evidence

- Targeted tests pass.
- No local timer path calls `_onPolledResponse` while the backend reports active.
- Retry preflight makes one runtime read and sends zero retry requests when active.
- Ordinary messages still queue normally during active execution.
