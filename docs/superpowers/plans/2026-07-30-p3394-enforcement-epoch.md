# P3394 Enforcement and Sender Epoch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Make P3394 rejection stop Group Chat Agent execution and carry persisted sender epochs through the bus so replay detection works before in-process, Codex, or Hermes execution.

**Architecture:** Add a separate sender epoch store, persist per-recipient epochs on `GroupMessage`, propagate them to `QueueItem`, and scope receiver watermarks by sender plus recipient session. Change the P3394 bus adapter to return an admission outcome and early-return from `runTurn` on rejection while preserving process audit events and UI cleanup.

**Tech Stack:** TypeScript, Electron main process, JSON/JSONL storage, async-mutex, Vitest through `npm run test:js`.

---

## File Structure

- Create `src/main/features/p3394/sender-epoch-store.ts`: outbound sender sequence persistence.
- Modify `src/main/features/p3394/epoch-store.ts`: sender-scoped receiver stream keys.
- Modify `src/main/features/p3394/controller.ts`: pass sender-scoped stream id and remove stale comments.
- Modify `src/main/features/group_chat/visibility.ts`: persisted recipient epoch metadata.
- Modify `src/main/features/group_chat/bus.ts`: allocate/propagate epoch and enforce admission.
- Modify `src/main/locales/{en,zh,ja,pt}.json`: localized admission failure.
- Create `test/main/features/p3394/sender-epoch-store.test.ts`.
- Modify `test/main/features/p3394/{controller,epoch-store}.test.ts`.
- Modify `test/main/features/group_chat/bus.test.ts`.

### Task 1: Sender Epoch Store

**Files:**
- Create: `src/main/features/p3394/sender-epoch-store.ts`
- Create: `test/main/features/p3394/sender-epoch-store.test.ts`

- [ ] **Step 1: Write failing storage tests**

Cover initial `1`, monotonic increments, independent `[sender, recipientSession]` streams, concurrent increments, persistence, malformed JSON recovery, and non-`ENOENT` read failure propagation. Use a temporary `ORKAS_WORKSPACE_ROOT` and assert the file path ends in `local/kstar/p3394-sender-epochs.json`.

```typescript
expect(await store.next('u1', 'commander', 'gmember-c1-a1')).toBe(1);
expect(await store.next('u1', 'commander', 'gmember-c1-a1')).toBe(2);
expect(await store.next('u1', 'user', 'gmember-c1-a1')).toBe(1);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run test:js -- test/main/features/p3394/sender-epoch-store.test.ts
```

Expected: FAIL because `sender-epoch-store.ts` does not exist.

- [ ] **Step 3: Implement the store**

Use `JSON.stringify([senderActorId, recipientSessionId])` as the map key. Follow `EpochStore` for uid mutex, `ENOENT` handling, temp-file write, rename, and cleanup.

```typescript
export class SenderEpochStore {
  async next(uid: string, senderActorId: string, recipientSessionId: string): Promise<number>;
}
```

- [ ] **Step 4: Verify GREEN**

Run the focused test and expect all cases to pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/features/p3394/sender-epoch-store.ts test/main/features/p3394/sender-epoch-store.test.ts
git commit -m "feat(p3394): persist sender epoch streams"
```

### Task 2: Sender-Scoped Receiver Watermarks

**Files:**
- Modify: `src/main/features/p3394/epoch-store.ts`
- Modify: `src/main/features/p3394/controller.ts`
- Modify: `test/main/features/p3394/epoch-store.test.ts`
- Modify: `test/main/features/p3394/controller.test.ts`

- [ ] **Step 1: Add failing tests**

Add tests proving two senders may both submit epoch `1` to the same recipient session, while a repeated epoch from the same sender is rejected.

```typescript
const first = await controller.admitMessage(input({ sender: 'agent-a', incomingEpoch: 1 }));
const other = await controller.admitMessage(input({ sender: 'agent-b', incomingEpoch: 1 }));
const replay = await controller.admitMessage(input({ sender: 'agent-a', incomingEpoch: 1 }));
expect(first.ok).toBe(true);
expect(other.ok).toBe(true);
expect(replay.ok).toBe(false);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run test:js -- test/main/features/p3394/controller.test.ts test/main/features/p3394/epoch-store.test.ts
```

Expected: the second sender collides under the old session-only watermark.

- [ ] **Step 3: Implement scoped keys**

Export a pure helper from `epoch-store.ts`:

```typescript
export function p3394EpochStreamKey(senderActorId: string, recipientSessionId: string): string {
  return JSON.stringify([senderActorId, recipientSessionId]);
}
```

Have `P3394Controller` call `epochStore.admit(uid, p3394EpochStreamKey(input.sender, input.sessionId), incomingEpoch)`. Keep canonical session metadata unchanged. Update the class comment so context adjudication is no longer described as a placeholder.

- [ ] **Step 4: Verify GREEN**

Run the two focused files and expect all cases to pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/features/p3394/epoch-store.ts src/main/features/p3394/controller.ts test/main/features/p3394/epoch-store.test.ts test/main/features/p3394/controller.test.ts
git commit -m "fix(p3394): scope replay watermarks by sender"
```

### Task 3: Persist and Propagate Recipient Epochs

**Files:**
- Modify: `src/main/features/group_chat/visibility.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `test/main/features/group_chat/bus.test.ts`

- [ ] **Step 1: Add failing bus tests**

Add an integration test with a user message routed to an Agent. Assert the persisted `GroupMessage` has a numeric epoch for that recipient and the claimed `QueueItem` passes the same value into the P3394 controller test hook. Add a compatibility case where a synthetic old queue item has no epoch.

```typescript
expect(message.p3394?.recipient_epochs[agentId]).toBe(1);
expect(observedIncomingEpoch).toBe(message.p3394?.recipient_epochs[agentId]);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run test:js -- test/main/features/group_chat/bus.test.ts
```

Expected: `GroupMessage.p3394` and `QueueItem.incomingEpoch` are missing.

- [ ] **Step 3: Add persisted schema and allocation**

Add to `GroupMessage`:

```typescript
p3394?: { recipient_epochs: Record<string, number> };
```

Add `incomingEpoch?: number` to `QueueItem`. Instantiate one process-wide `SenderEpochStore`. After routing and project-scope filtering, resolve each non-user recipient actor from the already-read membership list, derive `actorSessionId(cid, actor)`, and allocate its epoch. Allocation failure logs `warn` with ids only and omits that recipient from the map.

- [ ] **Step 4: Persist before dispatch and propagate**

Attach non-empty `recipient_epochs` to `msg` before JSONL persistence. When pushing each recipient queue item, set `incomingEpoch` from the persisted map. Pass `item.incomingEpoch` to `P3394Controller.admitMessage`.

- [ ] **Step 5: Verify GREEN**

Run `bus.test.ts` plus P3394 focused tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/features/group_chat/visibility.ts src/main/features/group_chat/bus.ts test/main/features/group_chat/bus.test.ts
git commit -m "feat(p3394): carry sender epochs through group chat"
```

### Task 4: Enforce P3394 Rejection

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/locales/en.json`
- Modify: `src/main/locales/zh.json`
- Modify: `src/main/locales/ja.json`
- Modify: `src/main/locales/pt.json`
- Modify: `test/main/features/group_chat/bus.test.ts`

- [ ] **Step 1: Add failing CLI and in-process gate tests**

Add a test hook that replaces the P3394 controller for a test and returns `replay_detected`. For a CLI Agent, assert the mocked `local_agents/runner.run` is not called. For an in-process Agent, assert the mocked model stream is not called. In both cases assert an end-of-turn failure message with `failure_kind: 'validation'` and `failure_code: 'p3394_replay_detected'`.

- [ ] **Step 2: Verify RED**

Run the focused bus test. Expected: current bus continues to the runner/model path.

- [ ] **Step 3: Return an admission outcome**

Change the adapter to return:

```typescript
interface P3394AdmissionOutcome {
  processItem: ProcessItem;
  admitted: boolean;
  reasonCode?: P3394AgentError['body']['reason_code'];
}
```

Always append the process item. On rejection, enqueue a localized failure bubble from the target actor to the user, mark in-flight false, emit state change, sync state, and return `{ kind: 'early' }` before assigning `cliAgent` or building a model prompt.

- [ ] **Step 4: Add locale strings**

Add `p3394.admission_blocked` to all main locales with a neutral message equivalent to “This Agent turn was blocked by the message protocol policy.” Do not expose internal detail or raw user content.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run test:js -- test/main/features/group_chat/bus.test.ts test/main/features/p3394/controller.test.ts test/main/features/p3394/epoch-store.test.ts test/main/features/p3394/sender-epoch-store.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/main/features/group_chat/bus.ts src/main/locales test/main/features/group_chat/bus.test.ts
git commit -m "fix(p3394): enforce group chat admission decisions"
```

### Task 5: P3394 Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused P3394 and group-chat tests**

```bash
npm run test:js -- test/main/features/p3394 test/main/features/group_chat/bus.test.ts test/main/features/group_chat/bus-integration.test.ts test/static/kstar-single-core.test.ts
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Inspect diff and secret/log boundaries**

```bash
git diff --check
git grep -n 'incomingEpoch\|recipient_epochs\|p3394-sender-epochs' -- src test
```

Confirm no epoch or user content is copied to telemetry and no CLI spawn path was added.

- [ ] **Step 4: Commit any test-only corrections**

Only if verification required corrections; otherwise leave the task commit-free.
